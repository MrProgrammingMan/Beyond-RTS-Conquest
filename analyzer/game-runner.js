/**
 * game-runner.js
 * Runs a single AI vs AI game with full QA instrumentation.
 *
 * KEY FIX vs old version: The speed hack now ALSO mocks setTimeout + setInterval.
 * If the game loop uses setInterval(gameLoop, 16) instead of rAF, old code ran
 * at real speed → 120s per game → 270 games = 1.5 hours. Now every timer in the
 * page runs at SPEED×, so games finish in 1–3 real seconds regardless of loop type.
 */

const path = require('path');
const { INSTRUMENTATION_SCRIPT } = require('./instrumentation');

const SPEED = 30;   // Game-time multiplier. 30x = 1 real second = 30 game seconds.
// Reliable range: 20–50. Higher = faster but may skip frames.

async function runGame(gameHtmlPath, p1FactionId, p2FactionId, opts = {}) {
  const {
    difficulty = 'hard',
    timeoutMs = 45_000,
    browser,
    captureErrors = true,
  } = opts;

  const fileUrl = `file://${path.resolve(gameHtmlPath)}`;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });

  // Inject QA instrumentation before any page script runs
  await ctx.addInitScript(INSTRUMENTATION_SCRIPT);

  const page = await ctx.newPage();

  const playwrightErrors = [];
  page.on('pageerror', err => {
    playwrightErrors.push({
      type: 'pageerror',
      message: err.message,
      stack: err.stack || '',
      time: Date.now(),
    });
  });

  try {
    await page.goto(fileUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });

    // Probe for FACTIONS global
    let FACTIONS_VAR = null;
    const CANDIDATES = ['FACTIONS', 'factions', 'FACTION_LIST', 'ALL_FACTIONS', 'GameFactions'];

    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await sleep(3000);
      const probe = await page.evaluate((candidates) => {
        for (const name of candidates) {
          const v = window[name];
          if (Array.isArray(v) && v.length > 0) return { found: name };
        }
        const sample = Object.keys(window)
          .filter(k => k === k.toUpperCase() && k.length > 2 && !['NaN', 'CSS'].includes(k))
          .slice(0, 30);
        return { found: null, sample };
      }, CANDIDATES).catch(() => ({ found: null, sample: [] }));

      if (probe.found) { FACTIONS_VAR = probe.found; break; }
      if (attempt === 1) {
        const hint = probe.sample?.length
          ? `  Uppercase globals: ${probe.sample.join(', ')}`
          : '  No uppercase globals found — page may not be executing JS.';
        throw new Error(`FACTIONS not found on window.\n${hint}\n  Check gamePath in config.js and that window.FACTIONS is exposed.`);
      }
    }

    // ── Inject speed hack + start game ─────────────────────────────────────
    // The speed hack accelerates ALL timers in the page — rAF, setTimeout, AND
    // setInterval. This is the critical fix: games that use setInterval for their
    // loop (instead of rAF) previously ran at real speed.
    const injected = await page.evaluate(({ p1Id, p2Id, diff, factionsVar, speed }) => {
      const factionList = window[factionsVar];
      const p1Idx = factionList.findIndex(f => f.id === p1Id);
      const p2Idx = factionList.findIndex(f => f.id === p2Id);
      if (p1Idx === -1) return { error: `P1 faction not found: ${p1Id}` };
      if (p2Idx === -1) return { error: `P2 faction not found: ${p2Id}` };

      // ── Time mocking ──────────────────────────────────────────────────────
      // We advance a shared fake-time offset so all time sources agree.
      // This prevents issues where G.elapsed uses Date.now() and disagrees
      // with rAF timestamps, causing games to never detect their own end.
      let _fakeOffset = 0;  // accumulated fake milliseconds ahead of real time

      // rAF: advance fake time then call cb with fake timestamp
      const _origRAF = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (cb) => {
        _fakeOffset += 16.667 * speed;
        const fakeTs = performance.now() + _fakeOffset;
        return setTimeout(() => cb(fakeTs), 0);
      };

      // setTimeout: divide delay by speed so timers fire faster
      const _origST = window.setTimeout.bind(window);
      window.setTimeout = (fn, delay = 0, ...args) => {
        return _origST(fn, Math.max(0, delay / speed), ...args);
      };

      // setInterval: divide interval by speed
      const _origSI = window.setInterval.bind(window);
      window.setInterval = (fn, delay = 16, ...args) => {
        return _origSI(fn, Math.max(1, delay / speed), ...args);
      };

      // performance.now: add fake offset so game-internal timing also advances fast
      const _origPerfNow = performance.now.bind(performance);
      performance.now = () => _origPerfNow() + _fakeOffset;

      // Date.now: same treatment
      const _origDateNow = Date.now;
      Date.now = () => _origDateNow() + _fakeOffset;

      // ── Start the game ────────────────────────────────────────────────────
      window.__qaSpeedMultiplier = 30;

      if (typeof window.__qaStartAiVsAi === 'function') {
        window.__qaStartAiVsAi(p1Idx, p2Idx, diff);
        if (window.__qaInitError) return { error: 'initGame threw: ' + window.__qaInitError };
        if (!window.G) return { error: `G is null after initGame. trace=${window.__qaInitTrace}` };
        return { ok: true };
      }
      return { error: 'window.__qaStartAiVsAi not found — add the QA helper to index.html' };
    }, { p1Id: p1FactionId, p2Id: p2FactionId, diff: difficulty, factionsVar: FACTIONS_VAR, speed: SPEED });

    if (injected.error) throw new Error(injected.error);

    // ── Poll for game end ──────────────────────────────────────────────────
    const pollStart = Date.now();
    let result = null;
    let errorScreenshot = null;
    let lastErrCount = 0;

    while (Date.now() - pollStart < timeoutMs) {
      // Error screenshot check
      if (opts.screenshotsDir) {
        const errCount = await page.evaluate(() => window.__qa?.errors?.length || 0).catch(() => 0);
        if (errCount > lastErrCount) {
          lastErrCount = errCount;
          try {
            const ssPath = path.join(opts.screenshotsDir, `error-${Date.now()}-${p1FactionId}-vs-${p2FactionId}.png`);
            await page.screenshot({ path: ssPath, fullPage: false });
            errorScreenshot = ssPath;
          } catch (_) { }
        }
      }

      result = await page.evaluate(() => {
        const G = window.G;
        if (!G || G.running !== false) return null;

        const alive = G.players.filter(p => p.baseHp > 0);
        const winnerPid = alive.length === 1 ? alive[0].id : 0;

        const ft = window.__qa.performance.frameTimes;
        const avgFt = ft.length > 0 ? ft.reduce((a, b) => a + b, 0) / ft.length : 0;
        const maxFt = ft.length > 0 ? Math.max(...ft) : 0;

        return {
          winnerPid,
          elapsed: Math.round(G.elapsed || 0),
          p1BaseHp: Math.max(0, Math.round(G.players[0]?.baseHp || 0)),
          p2BaseHp: Math.max(0, Math.round(G.players[1]?.baseHp || 0)),
          p1Faction: G.factions?.[0]?.id || '',
          p2Faction: G.factions?.[1]?.id || '',
          errors: window.__qa.errors,
          warnings: window.__qa.warnings,
          nanEvents: window.__qa.nanEvents,
          mechanics: { ...window.__qa.mechanics },
          performance: {
            avgFrameMs: Math.round(avgFt * 10) / 10,
            maxFrameMs: Math.round(maxFt),
            longTasks: window.__qa.performance.longTasks,
            frameSamples: ft.length,
          },
          screenHistory: window.__qa.screenHistory,
          lastStandFired: [window.__qa.mechanics.last_stand_triggered > 0, false],
        };
      }).catch(() => null);

      if (result) break;
      await sleep(25);  // Poll at 40Hz instead of 20Hz
    }

    // Timeout fallback
    if (!result) {
      result = await page.evaluate(() => {
        const G = window.G;
        return {
          winnerPid: -1, timedOut: true,
          elapsed: Math.round(G?.elapsed || 0),
          p1BaseHp: G?.players?.[0]?.baseHp || 0,
          p2BaseHp: G?.players?.[1]?.baseHp || 0,
          p1Faction: G?.factions?.[0]?.id || '',
          p2Faction: G?.factions?.[1]?.id || '',
          errors: window.__qa?.errors || [],
          nanEvents: window.__qa?.nanEvents || [],
          mechanics: window.__qa?.mechanics || {},
          performance: { avgFrameMs: 0, maxFrameMs: 0, longTasks: [], frameSamples: 0 },
          screenHistory: window.__qa?.screenHistory || [],
        };
      }).catch(() => ({
        winnerPid: -1, timedOut: true, elapsed: 0,
        p1Faction: p1FactionId, p2Faction: p2FactionId,
        errors: [], nanEvents: [], mechanics: {}, performance: {},
      }));
    }

    if (playwrightErrors.length > 0) result.errors = [...(result.errors || []), ...playwrightErrors];
    if (errorScreenshot) result.errorScreenshot = errorScreenshot;

    return result;

  } finally {
    await page.close().catch(() => { });
    await ctx.close().catch(() => { });
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { runGame };
