/**
 * game-runner.js
 * Runs a single AI vs AI game with full QA instrumentation.
 * Returns: game result + all bugs/mechanics/performance data from that session.
 */

const path = require('path');
const { INSTRUMENTATION_SCRIPT } = require('./instrumentation');

async function runGame(gameHtmlPath, p1FactionId, p2FactionId, opts = {}) {
  const {
    difficulty    = 'hard',
    timeoutMs     = 60_000,
    browser,
    captureErrors = true,
  } = opts;

  const fileUrl = `file://${path.resolve(gameHtmlPath)}`;
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });

  // Inject QA instrumentation before any page script runs
  await ctx.addInitScript(INSTRUMENTATION_SCRIPT);

  const page = await ctx.newPage();

  // Capture uncaught page errors directly from Playwright too (belt-and-suspenders)
  const playwrightErrors = [];
  page.on('pageerror', err => {
    playwrightErrors.push({
      type: 'pageerror',
      message: err.message,
      stack: err.stack || '',
      time: Date.now(),
    });
  });

  let screenshotOnError = null; // will be set after page loads

  try {
    await page.goto(fileUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });

    // Wait for FACTIONS to be defined
    await page.waitForFunction(
      () => typeof window.FACTIONS !== 'undefined' && window.FACTIONS.length > 0,
      { timeout: 15_000 }
    );

    // Hook screenshot-on-error: take a screenshot whenever __qa.errors grows
    if (opts.screenshotOnError) {
      screenshotOnError = { lastCount: 0 };
    }

    // Speed hack + game start
    const injected = await page.evaluate(({ p1Id, p2Id, diff }) => {
      const f1 = window.FACTIONS.find(f => f.id === p1Id);
      const f2 = window.FACTIONS.find(f => f.id === p2Id);
      if (!f1) return { error: `P1 faction not found: ${p1Id}` };
      if (!f2) return { error: `P2 faction not found: ${p2Id}` };

      // ── Speed hack ───────────────────────────────────────────────────────
      let _fakeTs = performance.now();
      window.requestAnimationFrame = (cb) => {
        _fakeTs += 16.667;
        return setTimeout(() => cb(_fakeTs), 0);
      };

      window.P1_FACTION = f1;
      window.P2_FACTION = f2;
      window.GAME_MODE = 'aivsai';
      window.AI_DIFFICULTY = diff;
      window.AI1_DIFFICULTY = diff;
      window._pendingPlayerSetup = 'aivsai';

      window.initGame();
      return { ok: true };
    }, { p1Id: p1FactionId, p2Id: p2FactionId, diff: difficulty });

    if (injected.error) throw new Error(injected.error);

    // ── Poll for game end ──────────────────────────────────────────────────
    const pollStart = Date.now();
    let result = null;
    let errorScreenshot = null;

    while (Date.now() - pollStart < timeoutMs) {
      // Check if we need to screenshot a new error
      if (opts.screenshotDir && screenshotOnError) {
        const errCount = await page.evaluate(() => window.__qa?.errors?.length || 0).catch(() => 0);
        if (errCount > screenshotOnError.lastCount) {
          screenshotOnError.lastCount = errCount;
          try {
            const ts = Date.now();
            const ssPath = path.join(opts.screenshotsDir, `error-${ts}-${p1FactionId}-vs-${p2FactionId}.png`);
            await page.screenshot({ path: ssPath, fullPage: false });
            errorScreenshot = ssPath;
          } catch (_) {}
        }
      }

      result = await page.evaluate(() => {
        const G = window.G;
        if (!G || G.running !== false) return null;

        const alive = G.players.filter(p => p.baseHp > 0);
        const winnerPid = alive.length === 1 ? alive[0].id : 0;

        // Final performance stats
        const ft = window.__qa.performance.frameTimes;
        const avgFt = ft.length > 0 ? ft.reduce((a,b)=>a+b,0)/ft.length : 0;
        const maxFt = ft.length > 0 ? Math.max(...ft) : 0;

        return {
          winnerPid,
          elapsed:   Math.round(G.elapsed || 0),
          p1BaseHp:  Math.max(0, Math.round(G.players[0].baseHp)),
          p2BaseHp:  Math.max(0, Math.round(G.players[1].baseHp)),
          p1Faction: G.factions[0].id,
          p2Faction: G.factions[1].id,
          // QA data
          errors:    window.__qa.errors,
          warnings:  window.__qa.warnings,
          nanEvents: window.__qa.nanEvents,
          mechanics: { ...window.__qa.mechanics },
          performance: {
            avgFrameMs:  Math.round(avgFt * 10) / 10,
            maxFrameMs:  Math.round(maxFt),
            longTasks:   window.__qa.performance.longTasks,
            frameSamples: ft.length,
          },
          screenHistory: window.__qa.screenHistory,
          lastStandFired: [
            window.__qa.mechanics.last_stand_triggered > 0,
            false,
          ],
        };
      }).catch(() => null);

      if (result) break;
      await sleep(150);
    }

    // Timeout fallback
    if (!result) {
      const partial = await page.evaluate(() => {
        const G = window.G;
        return {
          winnerPid:  -1,
          timedOut:   true,
          elapsed:    Math.round(G?.elapsed || 0),
          p1BaseHp:   G?.players?.[0]?.baseHp || 0,
          p2BaseHp:   G?.players?.[1]?.baseHp || 0,
          p1Faction:  G?.factions?.[0]?.id || '',
          p2Faction:  G?.factions?.[1]?.id || '',
          errors:     window.__qa?.errors || [],
          nanEvents:  window.__qa?.nanEvents || [],
          mechanics:  window.__qa?.mechanics || {},
          performance:{ avgFrameMs: 0, maxFrameMs: 0, longTasks: [], frameSamples: 0 },
          screenHistory: window.__qa?.screenHistory || [],
        };
      }).catch(() => ({
        winnerPid: -1, timedOut: true, elapsed: 0,
        p1Faction: p1FactionId, p2Faction: p2FactionId,
        errors: [], nanEvents: [], mechanics: {}, performance: {},
      }));
      result = partial;
    }

    // Merge Playwright-level errors in
    if (playwrightErrors.length > 0) {
      result.errors = [...(result.errors || []), ...playwrightErrors];
    }
    if (errorScreenshot) result.errorScreenshot = errorScreenshot;

    return result;

  } finally {
    await page.close().catch(() => {});
    await ctx.close().catch(() => {});
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { runGame };
