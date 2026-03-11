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
  const SPEED = 15;
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
      return { ok: !!window.G };
    }, { f1, f2, SPEED });

    if (startRes.error) throw new Error(startRes.error);
    if (!startRes.ok) throw new Error('G not created after start');

    // P2: initialize as passive online receiver
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

      // Fake socket stub — P2 won't emit anything real
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

      const fl = window.FACTIONS || [];
      const i1 = fl.findIndex(f => f.id === f1), i2 = fl.findIndex(f => f.id === f2);
      if (i1 === -1 || i2 === -1) return { error: `Faction not found: ${f1}/${f2}`, hasNet: false, hasG: false };

      // Use the dedicated P2 online hook which:
      // - inits the game in 'vs' mode (no AI loop)
      // - exposes __qaReceiveSnapshot → _receiveStateSnapshot
      // - sets up __qaInjectSnap for the relay loop
      if (typeof window.__qaStartP2Online === 'function') {
        window.__qaStartP2Online(i1, i2, 'hard');
      } else {
        // Fallback: plain AI game boot — snapshots delivered via socket dispatch
        if (typeof window.__qaStartAiVsAi === 'function') {
          window.__qaSpeedMultiplier = SPEED;
          window.__qaStartAiVsAi(i1, i2, 'hard');
        }
        window.__qaInjectSnap = function (type, data) {
          if (window.__qaSocket) window.__qaSocket.dispatch(type, data);
        };
      }

      return { hasNet: typeof window.NET !== 'undefined', hasG: !!window.G };
    }, { f1, f2, SPEED });

    if (p2Init?.error) throw new Error(p2Init.error);

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
        const numTol = { midCapTimer: 0.5, p1BaseHp: 5, p2BaseHp: 5, p1Souls: 10, p2Souls: 10, unitCount: 3 };
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

    const p2Errors = await p2.evaluate(() => window.__qa?.errors || []).catch(() => []);
    return _compileResult(profileName, profile, f1, f2, relayMetrics, gameResult, p2Errors, p2Init);

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
    zoneOwners: (G.zones || []).map(z => z.owner || null),
  };
}

function _compileResult(profileName, profile, f1, f2, metrics, gameResult, p2Errors, p2Init) {
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
    passed: midDivs.length === 0,
    details: midDivs.length === 0 ? 'midCapPlayer synced correctly in all frames ✓' : `midCapPlayer diverged in ${midDivs.length} frames`,
    critical: midDivs.length > 0,
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

  // NET module presence check — informational only in QA context
  if (!p2Init?.hasNet) {
    checks.push({ name: 'NET module on P2', passed: false, details: 'window.NET not found — snapshot injection may not work', critical: false });
  }

  const grade = _grade(latStats.avg, metrics.divergenceFrames.length, allErrors.length, timedOut);
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
  };
}

function _grade(avgMs, divergences, errors, timedOut) {
  if (timedOut || errors > 3) return 'F';
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
  }

  return {
    overallGrade, results, issues, passedChecks,
    totalChecks: allChecks.length,
    summary: `Online grade: ${overallGrade} | ${passedChecks}/${allChecks.length} checks | ${issues.length} issue(s)`,
  };
}

function _stats(arr) {
  if (!arr || arr.length === 0) return { avg: 0, min: 0, max: 0, p95: 0, count: 0 };
  const s = [...arr].sort((a, b) => a - b);
  return { avg: Math.round(s.reduce((a, b) => a + b, 0) / s.length), min: Math.round(s[0]), max: Math.round(s[s.length - 1]), p95: Math.round(s[Math.floor(s.length * 0.95)]), count: s.length };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { runOnlineTests };