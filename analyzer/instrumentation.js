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
      // New faction mechanics
      tar_patches_active:   0,
      corpses_collected:    0,
      echo_spawned:         0,
      dark_zone_created:    0,
      mutation_applied:     0,
      metamorphosis_complete: 0,
      decoy_spawned:        0,
      phase_activated:      0,
      corruption_applied:   0,
      fortune_double:       0,
      fortune_streak_activated: 0,
      random_event_fired:   0,
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
  function _scanForNaN(obj, path, depth, maxDepth) {
    if (depth > maxDepth) return [];
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
          found.push(..._scanForNaN(val, fullPath, depth + 1, maxDepth));
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
        { obj: G.players?.[0], path: 'G.players[0]', maxDepth: 4 },
        { obj: G.players?.[1], path: 'G.players[1]', maxDepth: 4 },
      ];
      // Scan ALL units at shallow depth (2) to catch NaNs without perf hit
      const units = G.units || [];
      for (let i = 0; i < units.length; i++) {
        if (units[i]) checks.push({ obj: units[i], path: \`G.units[\${i}]\`, maxDepth: 2 });
      }
      for (const { obj, path, maxDepth } of checks) {
        const found = _scanForNaN(obj, path, 0, maxDepth);
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

    let _prevMidOwner    = G.midOwner;
    let _upgradesBought  = [0, 0];
    let _lastStandFired  = [false, false];

    // FIX #12: track per-buff previous state so we count activations (0→>0),
    // not presence (which was incrementing every 2s while the buff ran).
    const BUFF_NAMES = ['warcry', 'ironwall', 'blitz', 'soul_tide'];
    let _prevBuffState = [
      { warcry: 0, ironwall: 0, blitz: 0, soul_tide: 0 },
      { warcry: 0, ironwall: 0, blitz: 0, soul_tide: 0 },
    ];

    // FIX #13: track spy identity so we count cumulative deployments, not peak
    // concurrent. Assign a __qaId to each spy object on first sight.
    let _spyQaCounter = 0;
    const _seenSpyIds = new Set();

    // FIX #14: same approach for aerial units.
    let _aerialQaCounter = 0;
    const _seenAerialIds = new Set();

    // FIX (worker_sent_to_mid): same presence-vs-transition issue as buffs.
    let _prevWorkerMidMode = [false, false];

    // New faction delta tracking
    let _prevCorpseCount = 0;
    let _prevDarkZoneCount = 0;

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

      // FIX #13 — Spy: count each unique spy object ever seen as active.
      for (const s of (G.spies || [])) {
        if (s.phase === 'done') continue;     // already resolved, skip
        if (s.__qaId === undefined) s.__qaId = ++_spyQaCounter;
        if (!_seenSpyIds.has(s.__qaId)) {
          _seenSpyIds.add(s.__qaId);
          window.__qa.mechanics.spy_deployed++;
        }
      }

      // FIX #14 — Aerial: count each unique aerial unit ever seen (dead or alive).
      for (const u of (G.units || [])) {
        if (!u.def?.aerial) continue;
        if (u.__qaId === undefined) u.__qaId = ++_aerialQaCounter;
        if (!_seenAerialIds.has(u.__qaId)) {
          _seenAerialIds.add(u.__qaId);
          window.__qa.mechanics.aerial_unit_spawned++;
        }
      }

      // Last Stand — unchanged (already transition-based via _lastStandFired)
      for (let i = 0; i < 2; i++) {
        const p = G.players?.[i];
        if (p && p.baseHp <= 30 && p.baseHp > 0 && !_lastStandFired[i]) {
          window.__qa.mechanics.last_stand_triggered++;
          _lastStandFired[i] = true;
        }
      }

      // Upgrades
      for (let i = 0; i < 2; i++) {
        const p = G.players?.[i];
        if (!p || !p.ownedUpgrades) continue;
        const bought = p.ownedUpgrades.size;
        if (bought > _upgradesBought[i]) {
          window.__qa.mechanics.upgrade_purchased += (bought - _upgradesBought[i]);
          _upgradesBought[i] = bought;
        }
      }

      // FIX #12 — Buff activation: count per-buff transitions from 0 → >0.
      for (let i = 0; i < 2; i++) {
        const p = G.players?.[i];
        if (!p || !p.activeBuffs) continue;
        for (const bn of BUFF_NAMES) {
          const prev = _prevBuffState[i][bn];
          const curr = p.activeBuffs[bn] || 0;
          if (prev === 0 && curr > 0) {
            window.__qa.mechanics.buff_activated++;
          }
          _prevBuffState[i][bn] = curr;
        }
      }

      // FIX (worker_sent_to_mid): count transitions into mid-mode, not presence.
      for (let i = 0; i < 2; i++) {
        const curr = (G.workerMidMode || [])[i] === true;
        if (curr && !_prevWorkerMidMode[i]) {
          window.__qa.mechanics.worker_sent_to_mid++;
        }
        _prevWorkerMidMode[i] = curr;
      }

      // ── New faction mechanic tracking ──────────────────────────────────

      // Tar patches (Weavers)
      window.__qa.mechanics.tar_patches_active = (G.tarPatches || []).length;

      // Corpses (Reavers) — count new corpses collected via shrinking list
      const corpseCount = (G.corpses || []).length;
      if (corpseCount < (_prevCorpseCount || 0)) {
        window.__qa.mechanics.corpses_collected += (_prevCorpseCount - corpseCount);
      }
      _prevCorpseCount = corpseCount;

      // Dark zones (Umbral)
      const dzCount = (G.darkZones || []).length;
      if (dzCount > (_prevDarkZoneCount || 0)) {
        window.__qa.mechanics.dark_zone_created += (dzCount - _prevDarkZoneCount);
      }
      _prevDarkZoneCount = dzCount;

      // Fortune streak activations (Fortune Seekers)
      const streaks = G._fortuneStreaks || [0, 0];
      for (let i = 0; i < streaks.length; i++) {
        if (streaks[i] >= 2 && !window.__qa['_fortuneStreakActive' + i]) {
          window.__qa['_fortuneStreakActive' + i] = true;
          window.__qa.mechanics.fortune_streak_activated++;
        } else if (streaks[i] < 2) {
          window.__qa['_fortuneStreakActive' + i] = false;
        }
      }

      // Echo spawns, decoys, phase, mutations, corruption, fortune
      // These are tracked by scanning units for flags (one-shot on first sight)
      for (const u of (G.units || [])) {
        if (u.__qaNewFacTracked) continue;
        u.__qaNewFacTracked = true;

        if (u._isEcho) window.__qa.mechanics.echo_spawned++;
        if (u._isDecoy) window.__qa.mechanics.decoy_spawned++;
        if (u._phased) window.__qa.mechanics.phase_activated++;
        if (u._corrupted) window.__qa.mechanics.corruption_applied++;
        if (u._mutations && u._mutations > 0) window.__qa.mechanics.mutation_applied += u._mutations;
        if (u._fortuneDoubled) window.__qa.mechanics.fortune_double++;
      }

      // Chrysalis metamorphosis: track larva→adult TRANSITION, not one-shot.
      // The one-shot pattern above always sees 'larva' at spawn, so it never
      // catches the transition to 'adult'. Use a separate per-unit flag.
      for (const u of (G.units || [])) {
        if (u._chrysPhase === 'adult' && !u.__qaMetaTracked) {
          u.__qaMetaTracked = true;
          window.__qa.mechanics.metamorphosis_complete++;
        }
      }

      // Random events
      if (G.activeEvent && G.activeEvent._qaTracked !== true) {
        G.activeEvent._qaTracked = true;
        window.__qa.mechanics.random_event_fired++;
      }

    }, 2000);
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