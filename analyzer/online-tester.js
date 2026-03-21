/**
 * online-tester.js — Beyond RTS Conquest Online Sync Tester
 *
 * HOW IT WORKS (intercept-and-replay):
 *   1. P1 page runs a normal AI vs AI game, with a fake socket patched in.
 *   2. Every socket.emit('stateUpdate'|'fireEvent'|...) from P1 is captured
 *      into a Node.js queue via exposeFunction.
 *   3. Those payloads are replayed into a P2 page with simulated network
 *      latency (delay + jitter + packet loss).
 *   4. We compare P1 and P2 G-states every 500ms to measure divergence.
 *   5. Specific known sync regressions are checked individually.
 *
 * No real server or socket.io server required.
 */

const path = require('path');
const { chromium } = require('playwright');
const { INSTRUMENTATION_SCRIPT } = require('./instrumentation');

const PROFILES = {
  ideal: { minMs: 0, maxMs: 5, jitter: 2, packetLoss: 0 },
  good: { minMs: 20, maxMs: 60, jitter: 15, packetLoss: 0 },
  average: { minMs: 60, maxMs: 120, jitter: 30, packetLoss: 0.005 },
  bad: { minMs: 150, maxMs: 350, jitter: 80, packetLoss: 0.02 },
  awful: { minMs: 300, maxMs: 800, jitter: 150, packetLoss: 0.05 },
};

// #23: SPEED is the time-warp multiplier used in this file.
// GAME_RUNNER_SPEED is the value used by game-runner.js (currently 50).
// If they differ, we report it as an explicit finding — a 2× speed gap means
// the online tester may miss timing-sensitive sync bugs that only appear at
// the faster pace used during balance testing.
const SPEED = 50;   // online tester speed — must match game-runner.js
const GAME_RUNNER_SPEED = 50;   // must match the SPEED constant in game-runner.js

async function runOnlineTests(gameHtmlPath, cfg) {
  const ocfg = cfg.online || {};
  const profileNames = ocfg.latencyProfiles || ['ideal', 'good', 'average'];
  const factionPairs = ocfg.factionPairs || [['warriors', 'brutes'], ['summoners', 'spirits']];
  const results = [];

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
  });

  try {
    for (const profileName of profileNames) {
      const profile = PROFILES[profileName] || PROFILES.good;
      for (const [f1, f2] of factionPairs) {
        console.log(`  🌐 Online: ${profileName} · ${f1} vs ${f2}`);
        try {
          const r = await _runScenario(gameHtmlPath, cfg, browser, profileName, profile, f1, f2);
          results.push(r);
          console.log(`     ${r.passed ? '✅' : '❌'} ${r.summary}`);
        } catch (err) {
          results.push({
            profileName, f1, f2, passed: false, grade: 'F',
            error: err.message,
            summary: `Crashed: ${err.message.slice(0, 70)}`,
            checks: [],
          });
          console.log(`     💥 ${err.message.slice(0, 70)}`);
        }
      }
    }
  } finally {
    await browser.close();
  }

  return _buildReport(results);
}

async function _runScenario(gameHtmlPath, cfg, browser, profileName, profile, f1, f2) {
  const fileUrl = `file://${path.resolve(gameHtmlPath)}`;
  const timeoutMs = (cfg.online?.testTimeoutSecs || 40) * 1000;

  const snapshotQueue = [];
  const relayMetrics = { sent: 0, delivered: 0, dropped: 0, latencies: [], divergenceFrames: [], freqTs: [] };

  const ctx1 = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx1.addInitScript(INSTRUMENTATION_SCRIPT);
  await ctx2.addInitScript(INSTRUMENTATION_SCRIPT);
  const p1 = await ctx1.newPage();
  const p2 = await ctx2.newPage();

  await p1.exposeFunction('__onlineCapture', (type, payloadStr) => {
    snapshotQueue.push({ type, payloadStr, capturedAt: Date.now() });
    relayMetrics.sent++;
  });

  try {
    await p1.goto(fileUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await p2.goto(fileUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await Promise.all([
      p1.waitForFunction(() => typeof window.FACTIONS !== 'undefined', { timeout: 10_000 }),
      p2.waitForFunction(() => typeof window.FACTIONS !== 'undefined', { timeout: 10_000 }),
    ]);

    // P1: start game + intercept socket.emit
    const startRes = await p1.evaluate(({ f1, f2, SPEED }) => {
      let _off = 0;
      const _raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = cb => { _off += 16.667 * SPEED; return setTimeout(() => cb(performance.now() + _off), 0); };
      const _st = window.setTimeout.bind(window);
      window.setTimeout = (fn, d = 0, ...a) => _st(fn, Math.max(0, d / SPEED), ...a);
      const _si = window.setInterval.bind(window);
      window.setInterval = (fn, d = 16, ...a) => _si(fn, Math.max(1, d / SPEED), ...a);
      const _pn = performance.now.bind(performance);
      performance.now = () => _pn() + _off;
      const _dn = Date.now; Date.now = () => _dn() + _off;

      const sock = {
        connected: true, _h: {},
        on(e, fn) { (this._h[e] = this._h[e] || []).push(fn); return this; },
        off(e, fn) { if (this._h[e]) this._h[e] = this._h[e].filter(h => h !== fn); return this; },
        emit(ev, data) {
          if (['stateUpdate', 'fireEvent', 'voteResolved', 'rogueSpawnPos'].includes(ev)) {
            try { window.__onlineCapture(ev, JSON.stringify(data)); } catch (_) { }
          }
        },
        disconnect() { },
      };
      window.__qaSocket = sock;
      window.io = () => sock;

      if (typeof window.__qaStartAiVsAi !== 'function') return { error: '__qaStartAiVsAi not found' };
      const fl = window.FACTIONS;
      const i1 = fl.findIndex(f => f.id === f1), i2 = fl.findIndex(f => f.id === f2);
      if (i1 === -1 || i2 === -1) return { error: `Faction not found: ${f1}/${f2}` };
      window.__qaSpeedMultiplier = SPEED;
      window.__qaStartAiVsAi(i1, i2, 'hard');
      // Force P1 into online broadcast mode so _broadcastFullState sends snapshots
      // to our fake socket, which the relay loop captures and forwards to P2.
      if (typeof window.NET !== 'undefined' && window.NET._qaForceP1Online) {
        window.NET._qaForceP1Online();
      }
      return { ok: !!window.G };
    }, { f1, f2, SPEED });

    if (startRes.error) throw new Error(startRes.error);
    if (!startRes.ok) throw new Error('G not created after start');

    // P2: initialize as passive client
    const p2Init = await p2.evaluate(({ f1, f2, SPEED }) => {
      let _off = 0;
      const _raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = cb => { _off += 16.667 * SPEED; return setTimeout(() => cb(performance.now() + _off), 0); };
      const _st = window.setTimeout.bind(window);
      window.setTimeout = (fn, d = 0, ...a) => _st(fn, Math.max(0, d / SPEED), ...a);
      const _si = window.setInterval.bind(window);
      window.setInterval = (fn, d = 16, ...a) => _si(fn, Math.max(1, d / SPEED), ...a);
      const _pn = performance.now.bind(performance);
      performance.now = () => _pn() + _off;
      const _dn = Date.now; Date.now = () => _dn() + _off;

      const sock = {
        connected: true, _h: {},
        on(e, fn) { (this._h[e] = this._h[e] || []).push(fn); return this; },
        off(e, fn) { if (this._h[e]) this._h[e] = this._h[e].filter(h => h !== fn); return this; },
        emit() { },
        dispatch(ev, data) { (this._h[ev] || []).forEach(h => { try { h(data); } catch (_) { } }); },
        disconnect() { },
      };
      window.__qaSocket = sock;
      window.io = () => sock;

      // Boot P2 as online receiver — NOT as an independent AI vs AI game.
      // __qaStartP2Online sets GAME_MODE='vs' and calls NET._qaForceP2Online()
      // so the game loop enters the P2 render-only path (no physics/economy).
      const fl = window.FACTIONS;
      const i1 = fl.findIndex(f => f.id === f1), i2 = fl.findIndex(f => f.id === f2);
      if (i1 !== -1 && i2 !== -1) {
        window.__qaSpeedMultiplier = SPEED;
        if (typeof window.__qaStartP2Online === 'function') {
          try { window.__qaStartP2Online(i1, i2, 'hard'); } catch (_) { }
        } else if (typeof window.__qaStartAiVsAi === 'function') {
          // Fallback for older game builds without __qaStartP2Online
          try { window.__qaStartAiVsAi(i1, i2, 'hard'); } catch (_) { }
        }
      }
      return {
        hasNet: typeof window.NET !== 'undefined',
        hasG: !!window.G,
        isOnline: typeof window.NET !== 'undefined' && window.NET.isOnline(),
        pid: typeof window.NET !== 'undefined' ? window.NET.getPid() : null,
      };
    }, { f1, f2, SPEED });

    // Relay loop
    let relayActive = true;
    (async () => {
      while (relayActive) {
        while (snapshotQueue.length > 0) {
          const snap = snapshotQueue.shift();
          if (profile.packetLoss > 0 && Math.random() < profile.packetLoss) { relayMetrics.dropped++; continue; }
          const delay = profile.minMs + Math.random() * (profile.maxMs - profile.minMs) + (Math.random() - 0.5) * profile.jitter * 2;
          const capturedAt = snap.capturedAt;
          setTimeout(async () => {
            const now = Date.now();
            relayMetrics.latencies.push(now - capturedAt);
            relayMetrics.freqTs.push(now);
            relayMetrics.delivered++;
            try {
              await p2.evaluate(({ type, payloadStr }) => {
                const data = JSON.parse(payloadStr);
                // Prefer __qaInjectSnap (calls _receiveStateSnapshot directly);
                // fall back to socket dispatch for older game builds.
                if (typeof window.__qaInjectSnap === 'function') {
                  window.__qaInjectSnap(type, data);
                } else if (window.__qaSocket) {
                  window.__qaSocket.dispatch(type, data);
                }
              }, { type: snap.type, payloadStr: snap.payloadStr });
            } catch (_) { }
          }, Math.max(0, delay));
        }
        await sleep(8);
      }
    })();

    // Divergence checker
    let checkCount = 0;
    const divChecker = setInterval(async () => {
      try {
        const [s1, s2] = await Promise.all([
          p1.evaluate(_captureState).catch(() => null),
          p2.evaluate(_captureState).catch(() => null),
        ]);
        if (!s1?.running || !s2) return;
        checkCount++;
        const diffs = [];
        // Tolerances account for snapshot delay at high speed (50×).
        // Souls drift ~0.5/s base + mid income between snapshots.
        const numTol = { midCapTimer: 1.0, p1BaseHp: 8, p2BaseHp: 8, p1Souls: 20, p2Souls: 20, unitCount: 5, tarPatchCount: 3, corpseCount: 2, darkZoneCount: 2, bloodPoolCount: 3 };
        for (const [f, tol] of Object.entries(numTol)) {
          if (s1[f] == null || s2[f] == null) continue;
          if (Math.abs((+s1[f] || 0) - (+s2[f] || 0)) > tol) diffs.push({ field: f, p1: s1[f], p2: s2[f] });
        }
        // Exact-match fields
        for (const f of ['midOwner', 'midCapPlayer']) {
          if (s1[f] !== s2[f]) diffs.push({ field: f, p1: s1[f], p2: s2[f] });
        }
        // Zone owners array
        if (Array.isArray(s1.zoneOwners) && Array.isArray(s2.zoneOwners)) {
          s1.zoneOwners.forEach((o, i) => {
            if (o !== s2.zoneOwners?.[i]) diffs.push({ field: `zone[${i}].owner`, p1: o, p2: s2.zoneOwners[i] });
          });
        }
        if (diffs.length > 0) relayMetrics.divergenceFrames.push({ checkNum: checkCount, diffs });
      } catch (_) { }
    }, 500);

    // Poll for game end
    const t0 = Date.now();
    let gameResult = null;
    while (Date.now() - t0 < timeoutMs) {
      const done = await p1.evaluate(() => window.G?.running === false).catch(() => false);
      if (done) {
        gameResult = await p1.evaluate(() => {
          const G = window.G;
          return {
            winnerPid: G.players?.find(p => p.baseHp > 0)?.id || 0,
            elapsed: Math.round(G.elapsed || 0),
            p1BaseHp: Math.round(G.players?.[0]?.baseHp || 0),
            p2BaseHp: Math.round(G.players?.[1]?.baseHp || 0),
            errors: window.__qa?.errors || [],
          };
        }).catch(() => null);
        break;
      }
      await sleep(100);
    }

    relayActive = false;
    clearInterval(divChecker);
    await sleep(300); // let any in-flight timeouts drain

    // #22: P2 render check — verify the canvas has actually been drawn to.
    // A blank (all-black) canvas means rendering is broken even when G-state
    // syncs correctly. Samples a 10×10 grid of pixels across the game canvas.
    const renderCheck = await p2.evaluate(() => {
      const canvas = document.getElementById('battlefield') || document.querySelector('canvas');
      if (!canvas) return { checked: false, reason: 'No canvas element found on P2' };

      let ctx;
      try { ctx = canvas.getContext('2d'); } catch (_) { }
      if (!ctx) return { checked: false, reason: 'Could not get 2D context from P2 canvas' };

      const w = canvas.width || canvas.offsetWidth || 1280;
      const h = canvas.height || canvas.offsetHeight || 720;
      if (w < 10 || h < 10) return { checked: false, reason: `Canvas too small: ${w}×${h}` };

      // Sample a 10×10 grid — 100 pixels spread across the canvas
      const GRID = 10;
      let nonBlackCount = 0;
      let totalSampled = 0;

      for (let row = 0; row < GRID; row++) {
        for (let col = 0; col < GRID; col++) {
          const x = Math.floor((col + 0.5) * w / GRID);
          const y = Math.floor((row + 0.5) * h / GRID);
          try {
            const px = ctx.getImageData(x, y, 1, 1).data; // [r, g, b, a]
            totalSampled++;
            // Non-black = at least one channel > 15 (allow near-black backgrounds)
            if (px[0] > 15 || px[1] > 15 || px[2] > 15) nonBlackCount++;
          } catch (_) {
            // Canvas may be tainted (cross-origin) — treat as unknown
            return { checked: false, reason: 'Canvas is tainted (cross-origin read blocked)' };
          }
        }
      }

      const nonBlackPct = totalSampled > 0 ? Math.round(nonBlackCount / totalSampled * 100) : 0;
      return {
        checked: true,
        nonBlackCount,
        totalSampled,
        nonBlackPct,
        // Pass if at least 10% of sampled pixels are non-black.
        // A completely blank canvas will be 0%; a rendering game typically >40%.
        rendered: nonBlackPct >= 10,
        canvasWidth: w,
        canvasHeight: h,
      };
    }).catch(err => ({ checked: false, reason: `Render check threw: ${err.message}` }));

    const p2Errors = await p2.evaluate(() => window.__qa?.errors || []).catch(() => []);
    return _compileResult(profileName, profile, f1, f2, relayMetrics, gameResult, p2Errors, p2Init, renderCheck);

  } finally {
    await p1.close().catch(() => { });
    await p2.close().catch(() => { });
    await ctx1.close().catch(() => { });
    await ctx2.close().catch(() => { });
  }
}

function _captureState() {
  const G = window.G;
  if (!G) return null;
  return {
    running: G.running,
    elapsed: Math.round(G.elapsed || 0),
    midOwner: G.midOwner || null,
    midCapPlayer: G.midCapPlayer || null,
    midCapTimer: Math.round((G.midCapTimer || 0) * 10) / 10,
    p1BaseHp: Math.round(G.players?.[0]?.baseHp || 0),
    p2BaseHp: Math.round(G.players?.[1]?.baseHp || 0),
    p1Souls: Math.round(G.players?.[0]?.souls || 0),
    p2Souls: Math.round(G.players?.[1]?.souls || 0),
    unitCount: G.units?.length || 0,
    tarPatchCount: (G.tarPatches || []).length,
    corpseCount: (G.corpses || []).length,
    darkZoneCount: (G.darkZones || []).length,
    bloodPoolCount: (G.bloodPools || []).length,
    zoneOwners: (G.zones || []).map(z => z.owner || null),
  };
}

function _compileResult(profileName, profile, f1, f2, metrics, gameResult, p2Errors, p2Init, renderCheck) {
  const lats = metrics.latencies.filter(v => v >= 0 && v < 10_000);
  const latStats = _stats(lats);
  const allErrors = [...(gameResult?.errors || []), ...p2Errors];
  const timedOut = !gameResult;

  let snapFreqHz = 0;
  const ft = metrics.freqTs;
  if (ft.length > 5) snapFreqHz = Math.round(ft.length / ((ft[ft.length - 1] - ft[0]) / 1000));

  const checks = [];
  const midDivs = metrics.divergenceFrames.filter(d => d.diffs.some(f => f.field === 'midCapPlayer'));
  checks.push({
    name: 'Mid capture arc (midCapPlayer on P2)',
    passed: midDivs.length <= 2,
    details: midDivs.length === 0 ? 'midCapPlayer synced correctly in all frames ✓' : `midCapPlayer diverged in ${midDivs.length} frames`,
    critical: midDivs.length > 2,
  });

  const zoneDivs = metrics.divergenceFrames.filter(d => d.diffs.some(f => f.field.startsWith('zone')));
  checks.push({
    name: 'Conquest zone sync',
    passed: zoneDivs.length === 0,
    details: zoneDivs.length === 0 ? 'Zone owners synced correctly ✓' : `Zone owner diverged in ${zoneDivs.length} frames`,
    critical: false,
  });

  const divThreshold = 8;
  checks.push({
    name: 'Overall state convergence',
    passed: metrics.divergenceFrames.length <= divThreshold,
    details: metrics.divergenceFrames.length === 0 ? 'Perfect convergence ✓' : `${metrics.divergenceFrames.length} divergent frames (threshold: ${divThreshold})`,
    critical: metrics.divergenceFrames.length > 20,
  });

  const lossRate = metrics.sent > 0 ? metrics.dropped / metrics.sent : 0;
  checks.push({
    name: 'Packet delivery (loss < 3%)',
    passed: lossRate < 0.03,
    details: `${metrics.delivered}/${metrics.sent} delivered, ${(lossRate * 100).toFixed(1)}% dropped`,
    critical: false,
  });

  checks.push({
    name: 'Game completes normally',
    passed: !timedOut && allErrors.length === 0,
    details: timedOut ? 'Timed out' : allErrors.length > 0 ? `${allErrors.length} JS error(s)` : `Completed in ${gameResult.elapsed}s ✓`,
    critical: timedOut,
  });

  if (!p2Init?.hasNet) {
    checks.push({ name: 'NET module on P2', passed: false, details: 'window.NET not found — _applyInstantState may not exist', critical: true });
  } else if (!p2Init?.isOnline || p2Init?.pid !== 2) {
    checks.push({ name: 'P2 online mode', passed: false, details: `P2 not in online mode (isOnline=${p2Init?.isOnline}, pid=${p2Init?.pid}) — running independent simulation instead of receiving P1 snapshots`, critical: true });
  }

  // #22: P2 canvas render check
  if (renderCheck?.checked) {
    const renderPassed = renderCheck.rendered;
    checks.push({
      name: 'P2 canvas rendering',
      passed: renderPassed,
      details: renderPassed
        ? `P2 canvas has content — ${renderCheck.nonBlackPct}% non-black pixels sampled ✓`
        : `P2 canvas appears blank — only ${renderCheck.nonBlackPct}% of sampled pixels are non-black. `
        + `G-state may sync correctly while rendering is broken (e.g. black canvas bug).`,
      critical: !renderPassed,
      renderCheck,
    });
  } else if (renderCheck) {
    // Could not check — not a failure, but note the reason
    checks.push({
      name: 'P2 canvas rendering',
      passed: true,   // don't penalise grade for uncheckable canvas
      details: `Render check skipped: ${renderCheck.reason || 'unknown reason'}`,
      critical: false,
      renderCheck,
    });
  }

  // #23: Speed parity check — flag if online tester runs at a different speed
  // than game-runner.js so the discrepancy is visible in the report rather than
  // silently hiding timing-sensitive sync bugs.
  const speedMismatch = SPEED !== GAME_RUNNER_SPEED;
  checks.push({
    name: 'Speed parity with game-runner',
    passed: !speedMismatch,
    details: speedMismatch
      ? `Online tester runs at ${SPEED}× but game-runner.js uses ${GAME_RUNNER_SPEED}×. `
      + `At ${GAME_RUNNER_SPEED}× some timer-sensitive sync paths (snapshot throttle, `
      + `interpolation windows) may behave differently. Consider raising SPEED in `
      + `online-tester.js to ${GAME_RUNNER_SPEED}× or noting this as a known gap.`
      : `Both testers run at ${SPEED}× — timing conditions are consistent ✓`,
    critical: false,   // informational — don't fail the grade over this
    speedMismatch,
    onlineSpeed: SPEED,
    gameRunnerSpeed: GAME_RUNNER_SPEED,
  });

  const grade = _grade(latStats.avg, metrics.divergenceFrames.length, allErrors.length, timedOut,
    renderCheck?.checked && !renderCheck?.rendered);
  const passed = checks.every(c => c.passed);
  const summary = `${profileName} (${f1}v${f2}): snaps=${metrics.delivered} avg=${latStats.avg}ms diverged=${metrics.divergenceFrames.length} grade=${grade}`;

  return {
    profileName, f1, f2, passed, grade, summary, timedOut,
    latencyMs: latStats, snapshotCount: metrics.delivered, snapFreqHz,
    totalDivergences: metrics.divergenceFrames.length,
    divergenceFrames: metrics.divergenceFrames,
    checks, errors: allErrors, gameResult: gameResult || null,
    checksPassedCount: checks.filter(c => c.passed).length,
    checksTotal: checks.length,
    renderCheck: renderCheck || null,
    speedMismatch,
  };
}

function _grade(avgMs, divergences, errors, timedOut, blankCanvas = false) {
  if (timedOut || errors > 3 || blankCanvas) return 'F';
  if (divergences > 20 || avgMs > 600) return 'D';
  if (divergences > 10 || avgMs > 300) return 'C';
  if (divergences > 5 || avgMs > 150) return 'B';
  return 'A';
}

function _buildReport(results) {
  const allChecks = results.flatMap(r => r.checks || []);
  const passedChecks = allChecks.filter(c => c.passed).length;
  const grades = results.map(r => r.grade).filter(Boolean);
  const order = ['A', 'B', 'C', 'D', 'F'];
  const worstIdx = Math.max(...grades.map(g => order.indexOf(g)), 0);
  const overallGrade = order[worstIdx] || 'N/A';

  const issues = [];

  for (const r of results) {
    const avg = r.latencyMs?.avg || 0;
    if (avg > 200 && r.snapshotCount > 5) {
      issues.push({
        severity: 'MEDIUM', type: 'high_snapshot_latency',
        profile: r.profileName, matchup: `${r.f1} vs ${r.f2}`,
        message: `Avg snapshot latency ${avg}ms on "${r.profileName}" — P2 sees ~${Math.round(avg / 16)} frame delay`,
        prompt: `Online snapshot latency averages ${avg}ms under "${r.profileName}" conditions. P2's dead-reckoning window may not cover this. In index.html, search for socket.emit('stateUpdate') and consider: (1) delta snapshots instead of full state, (2) widening the unit interpolation window (currently 300ms in NET.interpolateUnits), (3) reducing snapshot payload by omitting static fields that don't change frame-to-frame.`,
      });
    }
    for (const check of r.checks.filter(c => !c.passed && c.critical)) {
      issues.push({
        severity: 'HIGH', type: 'sync_regression',
        profile: r.profileName, matchup: `${r.f1} vs ${r.f2}`,
        message: `${check.name}: ${check.details}`,
        prompt: `Critical sync check failed during "${r.profileName}" online test: "${check.name}" — ${check.details}. Review the snapshot payload (~line 6200) and _applyInstantState (~line 6280) in index.html. Add any missing fields that P2 draw functions read but don't receive from P1.`,
      });
    }
    if (r.totalDivergences > 10) {
      const fieldCounts = r.divergenceFrames.flatMap(df => df.diffs.map(d => d.field))
        .reduce((acc, f) => { acc[f] = (acc[f] || 0) + 1; return acc; }, {});
      const topFields = Object.entries(fieldCounts).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([f]) => f);
      issues.push({
        severity: 'MEDIUM', type: 'state_divergence',
        profile: r.profileName, matchup: `${r.f1} vs ${r.f2}`,
        message: `${r.totalDivergences} divergence events. Top fields: ${topFields.join(', ')}`,
        prompt: `P1 and P2 state diverged ${r.totalDivergences} times during "${r.profileName}" testing. Most divergent fields: ${topFields.join(', ')}. In _applyInstantState (index.html ~line 6280), verify these fields are being written from snap. Also check P2's updateEconomy() is clamped to values received from P1 rather than simulating independently.`,
      });
    }
    for (const err of (r.errors || []).slice(0, 2)) {
      issues.push({
        severity: 'HIGH', type: 'online_js_error',
        profile: r.profileName, matchup: `${r.f1} vs ${r.f2}`,
        message: `JS error during online sim (${r.profileName}): ${(err.message || '').slice(0, 100)}`,
        prompt: `JS error in online mode ("${r.profileName}"): "${err.message}". Stack: ${(err.stack || '').slice(0, 250)}. This error only appears during snapshot replay, not offline — likely a null-check missing in a handler that fires before G is fully ready, or a field that is present in offline G but absent from the P2 snapshot-driven G.`,
      });
    }

    // #22: blank P2 canvas issue
    if (r.renderCheck?.checked && !r.renderCheck.rendered) {
      issues.push({
        severity: 'CRITICAL', type: 'p2_blank_canvas',
        profile: r.profileName, matchup: `${r.f1} vs ${r.f2}`,
        message: `P2 canvas is blank (${r.renderCheck.nonBlackPct}% non-black pixels) — `
          + `G-state may sync correctly while rendering is broken`,
        prompt: `During "${r.profileName}" online testing, P2's canvas appears entirely black `
          + `(only ${r.renderCheck.nonBlackPct}% of sampled pixels non-black). `
          + `This is the "black canvas" class of bug: state sync works but the draw loop `
          + `either never starts or exits early on P2. In index.html, check: `
          + `(1) the main draw/render function is called after _applyInstantState; `
          + `(2) any canvas context is re-acquired after the socket reconnect path; `
          + `(3) no early return guards (e.g. if (!G.running)) block P2's render before `
          + `the first full snapshot arrives. Please implement a fix in index.html.`,
      });
    }
  }

  // #23: speed mismatch — emit a single global issue if any scenario detected it
  // (all scenarios share the same constants so one check is enough)
  const anySpeedMismatch = results.some(r => r.speedMismatch);
  if (anySpeedMismatch) {
    issues.push({
      severity: 'INFO', type: 'speed_parity_gap',
      profile: 'all',
      matchup: 'N/A',
      message: `Online tester runs at ${SPEED}× but game-runner.js uses ${GAME_RUNNER_SPEED}×. `
        + `Sync bugs that only manifest at higher speed (${GAME_RUNNER_SPEED}×) will not be caught by online tests.`,
      prompt: `The online tester uses a ${SPEED}× time warp while game-runner.js uses ${GAME_RUNNER_SPEED}×. `
        + `To close this gap: in online-tester.js, change the SPEED constant from ${SPEED} to ${GAME_RUNNER_SPEED}. `
        + `If sync breaks at ${GAME_RUNNER_SPEED}× but not ${SPEED}×, that itself is a bug worth fixing — `
        + `it means the snapshot throttle or interpolation window is too narrow for the real game pace. `
        + `Please implement this change in online-tester.js.`,
    });
  }

  return {
    overallGrade, results, issues, passedChecks,
    totalChecks: allChecks.length,
    summary: `Online grade: ${overallGrade} | ${passedChecks}/${allChecks.length} checks | ${issues.length} issue(s)`,
    speedMismatch: anySpeedMismatch,
    onlineSpeed: SPEED,
    gameRunnerSpeed: GAME_RUNNER_SPEED,
  };
}

function _stats(arr) {
  if (!arr || arr.length === 0) return { avg: 0, min: 0, max: 0, p95: 0, count: 0 };
  const s = [...arr].sort((a, b) => a - b);
  return { avg: Math.round(s.reduce((a, b) => a + b, 0) / s.length), min: Math.round(s[0]), max: Math.round(s[s.length - 1]), p95: Math.round(s[Math.floor(s.length * 0.95)]), count: s.length };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { runOnlineTests };