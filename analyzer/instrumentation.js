/**
 * instrumentation.js
 * JavaScript injected into the game page to instrument everything.
 * Collected data is available via window.__qa
 * 
 * This file is read as a string and injected via page.addInitScript()
 */

const INSTRUMENTATION_SCRIPT = `
(function() {
  'use strict';

  window.__qa = {
    errors:       [],    // JS errors
    warnings:     [],    // console.warn calls
    nanEvents:    [],    // NaN/Infinity detections
    mechanics:    {      // mechanic usage counters
      spy_deployed:         0,
      mid_captured:         0,
      upgrade_purchased:    0,
      buff_activated:       0,
      last_stand_triggered: 0,
      aerial_unit_spawned:  0,
      worker_sent_to_mid:   0,
    },
    performance: {
      frameTimes:  [],   // ms per frame
      memSamples:  [],   // JS heap snapshots
      longTasks:   [],   // tasks >50ms
    },
    gameStartTime: null,
    gameEndTime:   null,
    screenHistory: [],   // which screens were shown
    uiIssues:      [],   // any UI anomalies noticed by JS
  };

  // ── ERROR CAPTURE ────────────────────────────────────────────────────────
  window.addEventListener('error', (e) => {
    window.__qa.errors.push({
      type: 'uncaught_error',
      message: e.message || String(e),
      filename: e.filename || '',
      line: e.lineno || 0,
      col: e.colno || 0,
      stack: e.error ? (e.error.stack || '') : '',
      time: Date.now(),
      gameState: _safeSnapshotState(),
    });
  });

  window.addEventListener('unhandledrejection', (e) => {
    window.__qa.errors.push({
      type: 'unhandled_promise',
      message: e.reason ? String(e.reason) : 'Unhandled promise rejection',
      stack: e.reason && e.reason.stack ? e.reason.stack : '',
      time: Date.now(),
      gameState: _safeSnapshotState(),
    });
  });

  // ── CONSOLE INTERCEPT ─────────────────────────────────────────────────────
  const _origError = console.error.bind(console);
  const _origWarn  = console.warn.bind(console);

  console.error = function(...args) {
    window.__qa.errors.push({
      type: 'console_error',
      message: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '),
      time: Date.now(),
      gameState: _safeSnapshotState(),
    });
    _origError(...args);
  };

  console.warn = function(...args) {
    window.__qa.warnings.push({
      message: args.map(a => String(a)).join(' '),
      time: Date.now(),
    });
    _origWarn(...args);
  };

  // ── NaN / INFINITY SCANNER ────────────────────────────────────────────────
  function _scanForNaN(obj, path, depth) {
    if (depth > 4) return [];
    const found = [];
    if (!obj || typeof obj !== 'object') return found;
    for (const key of Object.keys(obj)) {
      try {
        const val = obj[key];
        const fullPath = path + '.' + key;
        if (typeof val === 'number') {
          if (isNaN(val))       found.push({ path: fullPath, value: 'NaN' });
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
      // Scan player resources and unit positions
      const checks = [
        { obj: G.players?.[0], path: 'G.players[0]' },
        { obj: G.players?.[1], path: 'G.players[1]' },
      ];
      // Sample 5 random units
      const units = G.units || [];
      for (let i = 0; i < Math.min(5, units.length); i++) {
        const u = units[Math.floor(Math.random() * units.length)];
        if (u) checks.push({ obj: u, path: 'G.units[sample]' });
      }
      for (const { obj, path } of checks) {
        const found = _scanForNaN(obj, path, 0);
        for (const f of found) {
          window.__qa.nanEvents.push({ ...f, time: Date.now(), gameState: _safeSnapshotState() });
        }
      }
    }, 5000);
  }

  // ── RAF FRAME TIMING ──────────────────────────────────────────────────────
  let _lastTs = null;
  let _origRAF = window.requestAnimationFrame.bind(window);
  let _frameCount = 0;

  window.requestAnimationFrame = function(cb) {
    return _origRAF(function(ts) {
      if (_lastTs !== null) {
        const dt = ts - _lastTs;
        // Only track if game is running and dt is reasonable
        if (window.G && window.G.running && dt > 0 && dt < 500) {
          window.__qa.performance.frameTimes.push(Math.round(dt * 10) / 10);
          // Keep last 300 samples only
          if (window.__qa.performance.frameTimes.length > 300) {
            window.__qa.performance.frameTimes.shift();
          }
          if (dt > 100) { // long task: >100ms frame
            window.__qa.performance.longTasks.push({ dt: Math.round(dt), time: Date.now() });
          }
        }
      }
      _lastTs = ts;
      _frameCount++;
      cb(ts);
    });
  };

  // ── MECHANIC TRACKING ─────────────────────────────────────────────────────
  // We intercept key game functions after they're defined.
  // Use a MutationObserver + poll approach since functions are defined during init.

  function _hookMechanics() {
    const G = window.G;
    if (!G) return;

    // Track spy deployment: look for spy unit spawns
    // Track mid capture: monitor midOwner changes
    // Track upgrades: look for upgrade cost deductions
    // Track last stand: monitor baseHp threshold crossings

    let _prevMidOwner = G.midOwner;
    let _prevP1Souls = G.players?.[0]?.souls;
    let _prevP2Souls = G.players?.[1]?.souls;
    let _lastStandFired = [false, false];
    let _upgradesBought = [0, 0];

    const _mechTimer = setInterval(() => {
      if (!window.G || !window.G.running) {
        clearInterval(_mechTimer);
        return;
      }
      const G = window.G;

      // Mid capture
      if (G.midOwner !== _prevMidOwner && G.midOwner !== null) {
        window.__qa.mechanics.mid_captured++;
        _prevMidOwner = G.midOwner;
      }

      // Spy detection: spies live in G.spies[], not G.units[]
      const spies = (G.spies || []).filter(s => s.phase !== 'done');
      if (spies.length > 0) window.__qa.mechanics.spy_deployed = Math.max(window.__qa.mechanics.spy_deployed, spies.length);

      // Aerial spawned: count distinct aerial units ever seen
      const aerials = (G.units || []).filter(u => !u.dead && u.def && u.def.aerial);
      if (aerials.length > 0) window.__qa.mechanics.aerial_unit_spawned = Math.max(window.__qa.mechanics.aerial_unit_spawned, aerials.length);

      // Last Stand
      for (let i = 0; i < 2; i++) {
        const p = G.players?.[i];
        if (p && p.baseHp <= 30 && p.baseHp > 0 && !_lastStandFired[i]) {
          window.__qa.mechanics.last_stand_triggered++;
          _lastStandFired[i] = true;
        }
      }

      // Upgrades: game uses p.ownedUpgrades (a Set), not u.purchased
      for (let i = 0; i < 2; i++) {
        const p = G.players?.[i];
        if (!p || !p.ownedUpgrades) continue;
        const bought = p.ownedUpgrades.size;
        if (bought > _upgradesBought[i]) {
          window.__qa.mechanics.upgrade_purchased += (bought - _upgradesBought[i]);
          _upgradesBought[i] = bought;
        }
      }

      // Buff activation: game uses p.activeBuffs.warcry / .ironwall / .blitz / .soul_tide (countdown timers)
      for (let i = 0; i < 2; i++) {
        const p = G.players?.[i];
        if (!p || !p.activeBuffs) continue;
        const anyActive = p.activeBuffs.warcry > 0 || p.activeBuffs.ironwall > 0
          || (p.activeBuffs.blitz || 0) > 0 || (p.activeBuffs.soul_tide || 0) > 0;
        if (anyActive) window.__qa.mechanics.buff_activated++;
      }

      // Worker to mid: game uses G.workerMidMode[pid-1] boolean
      const midModeOn = (G.workerMidMode || []).some(v => v === true);
      if (midModeOn) window.__qa.mechanics.worker_sent_to_mid++;

    }, 2000); // check every 2s
  }

  // ── SCREEN TRACKING ───────────────────────────────────────────────────────
  function _trackScreens() {
    const observer = new MutationObserver(() => {
      const active = document.querySelector('.screen.active');
      if (active && active.id) {
        const last = window.__qa.screenHistory[window.__qa.screenHistory.length - 1];
        if (last !== active.id) {
          window.__qa.screenHistory.push(active.id);
        }
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
        elapsed: Math.round(G.elapsed || 0),
        p1BaseHp: G.players?.[0]?.baseHp,
        p2BaseHp: G.players?.[1]?.baseHp,
        p1Souls:  G.players?.[0]?.souls,
        p2Souls:  G.players?.[1]?.souls,
        unitCount: G.units?.length || 0,
        midOwner: G.midOwner,
        p1Faction: G.factions?.[0]?.id,
        p2Faction: G.factions?.[1]?.id,
        screen: document.querySelector('.screen.active')?.id || 'unknown',
      };
    } catch (_) { return { snapshotError: true }; }
  }

  // ── GAME LIFECYCLE HOOKS ──────────────────────────────────────────────────
  // Poll for game start/end to trigger hook installation
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

  // Start screen tracking immediately
  document.addEventListener('DOMContentLoaded', _trackScreens, { once: true });
  if (document.readyState !== 'loading') _trackScreens();

})();
`;

module.exports = { INSTRUMENTATION_SCRIPT };