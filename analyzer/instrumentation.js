/**
 * instrumentation.js
 * JavaScript injected into the game page before any game code runs.
 * Reduced scan frequencies vs old version to lower CPU overhead during game runs.
 *
 * NaN scan:     every 10s (was 5s)
 * Mechanic poll: every 4s (was 2s)
 * Frame buffer: last 200 samples (was 300)
 */

const INSTRUMENTATION_SCRIPT = `
(function() {
  'use strict';

  window.__qa = {
    errors:    [],
    warnings:  [],
    nanEvents: [],
    mechanics: {
      spy_deployed:          0,
      mid_captured:          0,
      upgrade_purchased:     0,
      buff_activated:        0,
      last_stand_triggered:  0,
      aerial_unit_spawned:   0,
      worker_sent_to_mid:    0,
    },
    performance: {
      frameTimes: [],
      memSamples: [],
      longTasks:  [],
    },
    gameStartTime: null,
    gameEndTime:   null,
    screenHistory: [],
    uiIssues:      [],
  };

  // ── ERROR CAPTURE ─────────────────────────────────────────────────────────
  window.addEventListener('error', (e) => {
    window.__qa.errors.push({
      type:      'uncaught_error',
      message:   e.message || String(e),
      filename:  e.filename || '',
      line:      e.lineno  || 0,
      col:       e.colno   || 0,
      stack:     e.error ? (e.error.stack || '') : '',
      time:      Date.now(),
      gameState: _safeSnapshotState(),
    });
  });

  window.addEventListener('unhandledrejection', (e) => {
    window.__qa.errors.push({
      type:      'unhandled_promise',
      message:   e.reason ? String(e.reason) : 'Unhandled promise rejection',
      stack:     e.reason?.stack || '',
      time:      Date.now(),
      gameState: _safeSnapshotState(),
    });
  });

  // ── CONSOLE INTERCEPT ─────────────────────────────────────────────────────
  const _origError = console.error.bind(console);
  const _origWarn  = console.warn.bind(console);

  console.error = function(...args) {
    window.__qa.errors.push({
      type:      'console_error',
      message:   args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '),
      time:      Date.now(),
      gameState: _safeSnapshotState(),
    });
    _origError(...args);
  };

  console.warn = function(...args) {
    window.__qa.warnings.push({ message: args.map(a => String(a)).join(' '), time: Date.now() });
    _origWarn(...args);
  };

  // ── NaN / INFINITY SCANNER ────────────────────────────────────────────────
  function _scanForNaN(obj, path, depth) {
    if (depth > 3) return [];
    const found = [];
    if (!obj || typeof obj !== 'object') return found;
    for (const key of Object.keys(obj)) {
      try {
        const val = obj[key];
        const fullPath = path + '.' + key;
        if (typeof val === 'number') {
          if (isNaN(val))        found.push({ path: fullPath, value: 'NaN' });
          else if (!isFinite(val)) found.push({ path: fullPath, value: val > 0 ? 'Infinity' : '-Infinity' });
        } else if (val && typeof val === 'object' && !Array.isArray(val)) {
          found.push(..._scanForNaN(val, fullPath, depth + 1));
        }
      } catch (_) {}
    }
    return found;
  }

  let _nanScanTimer = null;
  function _startNaNScan() {
    if (_nanScanTimer) return;
    _nanScanTimer = setInterval(() => {
      const G = window.G;
      if (!G || !G.running) return;
      const checks = [
        { obj: G.players?.[0], path: 'G.players[0]' },
        { obj: G.players?.[1], path: 'G.players[1]' },
      ];
      // Sample 3 random units (reduced from 5)
      const units = G.units || [];
      for (let i = 0; i < Math.min(3, units.length); i++) {
        const u = units[Math.floor(Math.random() * units.length)];
        if (u) checks.push({ obj: u, path: 'G.units[sample]' });
      }
      for (const { obj, path } of checks) {
        const found = _scanForNaN(obj, path, 0);
        for (const f of found) {
          window.__qa.nanEvents.push({ ...f, time: Date.now(), gameState: _safeSnapshotState() });
        }
      }
    }, 10_000);  // every 10s (was 5s)
  }

  // ── RAF FRAME TIMING ──────────────────────────────────────────────────────
  let _lastTs  = null;
  let _origRAF = window.requestAnimationFrame.bind(window);

  window.requestAnimationFrame = function(cb) {
    return _origRAF(function(ts) {
      if (_lastTs !== null) {
        const dt = ts - _lastTs;
        if (window.G && window.G.running && dt > 0 && dt < 500) {
          window.__qa.performance.frameTimes.push(Math.round(dt * 10) / 10);
          // Keep last 200 samples (was 300)
          if (window.__qa.performance.frameTimes.length > 200) {
            window.__qa.performance.frameTimes.shift();
          }
          if (dt > 100) {
            window.__qa.performance.longTasks.push({ dt: Math.round(dt), time: Date.now() });
          }
        }
      }
      _lastTs = ts;
      cb(ts);
    });
  };

  // ── MECHANIC TRACKING ─────────────────────────────────────────────────────
  function _hookMechanics() {
    const G = window.G;
    if (!G) return;

    let _prevMidOwner    = G.midOwner;
    let _lastStandFired  = [false, false];
    let _upgradesBought  = [0, 0];

    const _mechTimer = setInterval(() => {
      if (!window.G || !window.G.running) { clearInterval(_mechTimer); return; }
      const G = window.G;

      // Mid capture
      if (G.midOwner !== _prevMidOwner && G.midOwner !== null) {
        window.__qa.mechanics.mid_captured++;
        _prevMidOwner = G.midOwner;
      }

      // Spy detection
      const spies = (G.units || []).filter(u => !u.dead && (u.defId === 'spy' || u.isSpy));
      if (spies.length > 0) window.__qa.mechanics.spy_deployed = Math.max(window.__qa.mechanics.spy_deployed, spies.length);

      // Aerial
      const aerials = (G.units || []).filter(u => !u.dead && u.aerial);
      if (aerials.length > 0) window.__qa.mechanics.aerial_unit_spawned++;

      // Last Stand
      for (let i = 0; i < 2; i++) {
        const p = G.players?.[i];
        if (p && p.baseHp <= 30 && p.baseHp > 0 && !_lastStandFired[i]) {
          window.__qa.mechanics.last_stand_triggered++;
          _lastStandFired[i] = true;
        }
      }

      // Upgrades
      for (let pid = 0; pid < 2; pid++) {
        const faction = G.factions?.[pid];
        if (!faction) continue;
        const bought = (faction.upgrades || []).filter(u => u.purchased).length;
        if (bought > _upgradesBought[pid]) {
          window.__qa.mechanics.upgrade_purchased += (bought - _upgradesBought[pid]);
          _upgradesBought[pid] = bought;
        }
      }

      // Buff activation
      for (let i = 0; i < 2; i++) {
        const p = G.players?.[i];
        if (p?.activeBuff?.active) window.__qa.mechanics.buff_activated++;
      }

      // Worker to mid
      const workersAtMid = (G.units || []).filter(u => !u.dead && u.isWorker && u.targetMid);
      if (workersAtMid.length > 0) window.__qa.mechanics.worker_sent_to_mid++;

    }, 4_000);  // every 4s (was 2s)
  }

  // ── SCREEN TRACKING ───────────────────────────────────────────────────────
  function _trackScreens() {
    const observer = new MutationObserver(() => {
      const active = document.querySelector('.screen.active');
      if (active?.id) {
        const last = window.__qa.screenHistory[window.__qa.screenHistory.length - 1];
        if (last !== active.id) window.__qa.screenHistory.push(active.id);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  }

  // ── SAFE STATE SNAPSHOT ───────────────────────────────────────────────────
  function _safeSnapshotState() {
    try {
      const G = window.G;
      if (!G) return { gameRunning: false };
      return {
        gameRunning: G.running,
        elapsed:    Math.round(G.elapsed || 0),
        p1BaseHp:   G.players?.[0]?.baseHp,
        p2BaseHp:   G.players?.[1]?.baseHp,
        p1Souls:    G.players?.[0]?.souls,
        p2Souls:    G.players?.[1]?.souls,
        unitCount:  G.units?.length || 0,
        midOwner:   G.midOwner,
        p1Faction:  G.factions?.[0]?.id,
        p2Faction:  G.factions?.[1]?.id,
        screen:     document.querySelector('.screen.active')?.id || 'unknown',
      };
    } catch (_) { return { snapshotError: true }; }
  }

  // ── GAME LIFECYCLE HOOKS ──────────────────────────────────────────────────
  let _hookInstalled = false;
  const _gameWatcher = setInterval(() => {
    const G = window.G;
    if (G && G.running && !_hookInstalled) {
      window.__qa.gameStartTime = Date.now();
      _hookMechanics();
      _startNaNScan();
      _hookInstalled = true;
    }
    if (G && G.running === false && _hookInstalled) {
      window.__qa.gameEndTime = Date.now();
      clearInterval(_gameWatcher);
      if (_nanScanTimer) clearInterval(_nanScanTimer);
    }
  }, 500);

  document.addEventListener('DOMContentLoaded', _trackScreens, { once: true });
  if (document.readyState !== 'loading') _trackScreens();

})();
`;

module.exports = { INSTRUMENTATION_SCRIPT };
