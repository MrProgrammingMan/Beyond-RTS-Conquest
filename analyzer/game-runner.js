/**
 * game-runner.js
 * Runs a single AI vs AI game with full QA instrumentation.
 * Returns: game result + all bugs/mechanics/performance data from that session.
 */

const path = require('path');
const { INSTRUMENTATION_SCRIPT } = require('./instrumentation');

async function runGame(gameHtmlPath, p1FactionId, p2FactionId, opts = {}) {
  const {
    difficulty = 'hard',
    timeoutMs = 60_000,
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

  let screenshotOnError = null;

  try {
    await page.goto(fileUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });

    // ── Probe window for FACTIONS (or common alternative names) ──────────────
    // Does NOT use waitForFunction — probes immediately, waits 5s max, fails fast.
    // If the variable was renamed in index.html, the error message will say what
    // uppercase globals ARE visible so you know what to look for.
    let FACTIONS_VAR = null;
    const CANDIDATES = ['FACTIONS', 'factions', 'FACTION_LIST', 'ALL_FACTIONS', 'GameFactions'];

    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 3000));
      const probe = await page.evaluate((candidates) => {
        for (const name of candidates) {
          const v = window[name];
          if (Array.isArray(v) && v.length > 0) return { found: name };
        }
        // Sample uppercase globals to help diagnose renames
        const sample = Object.keys(window)
          .filter(k => k === k.toUpperCase() && k.length > 2 && !['NaN', 'CSS'].includes(k))
          .slice(0, 30);
        return { found: null, sample };
      }, CANDIDATES).catch(() => ({ found: null, sample: [] }));

      if (probe.found) { FACTIONS_VAR = probe.found; break; }

      if (attempt === 1) {
        const hint = probe.sample?.length
          ? `  Uppercase globals on window: ${probe.sample.join(', ')}`
          : '  No uppercase globals found — page may not be executing JS at all.';
        throw new Error(`FACTIONS not found on window after waiting.\n${hint}\n  Check: (1) gamePath in config.js points to index.html, (2) the variable is exposed as window.FACTIONS`);
      }
    }

    if (opts.screenshotOnError) screenshotOnError = { lastCount: 0 };

    // Speed hack + game start
    const injected = await page.evaluate(({ p1Id, p2Id, diff, factionsVar }) => {
      const factionList = window[factionsVar];
      const p1Idx = factionList.findIndex(f => f.id === p1Id);
      const p2Idx = factionList.findIndex(f => f.id === p2Id);
      if (p1Idx === -1) return { error: `P1 faction not found: ${p1Id}` };
      if (p2Idx === -1) return { error: `P2 faction not found: ${p2Id}` };

      // ── Speed hack: advance fake timestamp 20x per real frame ─────────────
      // setTimeout(..., 0) floods the event loop — cap at real 16ms intervals
      // so CPU stays low while game time still runs at 20x wall-clock speed.
      const SPEED = 20;
      let _fakeTs = performance.now();
      window.requestAnimationFrame = (cb) => {
        _fakeTs += 16.667 * SPEED;
        return setTimeout(() => cb(_fakeTs), 0);
      };

      // ── Start the game ────────────────────────────────────────────────────
      // window.__qaStartAiVsAi is a helper injected into index.html that sets
      // the closed-over let vars (AI1_FACTION_IDX, AI_FACTION_IDX, GAME_MODE,
      // AI_DIFFICULTY) and calls initGame(). This is necessary because those
      // vars are declared as `let` inside the script block and are not on window.
      if (typeof window.__qaStartAiVsAi === 'function') {
        window.__qaStartAiVsAi(p1Idx, p2Idx, diff);
        if (window.__qaInitError) return { error: 'initGame threw: ' + window.__qaInitError };
        if (!window.G) {
          return { error: `G is null after initGame. trace=${window.__qaInitTrace} initError=${window.__qaInitError || 'none'}` };
        }
        return { ok: true };
      }

      // Fallback if helper not yet added to index.html
      return { error: 'window.__qaStartAiVsAi not found — add the QA helper to index.html (see game-runner.js comments)' };
    }, { p1Id: p1FactionId, p2Id: p2FactionId, diff: difficulty, factionsVar: FACTIONS_VAR });

    if (injected.error) throw new Error(injected.error);

    // ── Poll for game end ──────────────────────────────────────────────────
    const pollStart = Date.now();
    let result = null;
    let errorScreenshot = null;



    while (Date.now() - pollStart < timeoutMs) {
      // Check if we need to screenshot a new error
      if (opts.screenshotsDir && screenshotOnError) {
        const errCount = await page.evaluate(() => window.__qa?.errors?.length || 0).catch(() => 0);
        if (errCount > screenshotOnError.lastCount) {
          screenshotOnError.lastCount = errCount;
          try {
            const ts = Date.now();
            const ssPath = path.join(opts.screenshotsDir, `error-${ts}-${p1FactionId}-vs-${p2FactionId}.png`);
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

        // Final performance stats
        const ft = window.__qa.performance.frameTimes;
        const avgFt = ft.length > 0 ? ft.reduce((a, b) => a + b, 0) / ft.length : 0;
        const maxFt = ft.length > 0 ? Math.max(...ft) : 0;

        return {
          winnerPid,
          elapsed: Math.round(G.elapsed || 0),
          p1BaseHp: Math.max(0, Math.round(G.players[0].baseHp)),
          p2BaseHp: Math.max(0, Math.round(G.players[1].baseHp)),
          p1Faction: G.factions[0].id,
          p2Faction: G.factions[1].id,
          // QA data
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
          lastStandFired: [
            window.__qa.mechanics.last_stand_triggered > 0,
            false,
          ],
        };
      }).catch(() => null);

      if (result) break;
      await sleep(50);
    }

    // Timeout fallback
    if (!result) {
      const partial = await page.evaluate(() => {
        const G = window.G;
        return {
          winnerPid: -1,
          timedOut: true,
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
      result = partial;
    }

    // Merge Playwright-level errors in
    if (playwrightErrors.length > 0) {
      result.errors = [...(result.errors || []), ...playwrightErrors];
    }
    if (errorScreenshot) result.errorScreenshot = errorScreenshot;

    return result;

  } finally {
    await page.close().catch(() => { });
    await ctx.close().catch(() => { });
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { runGame };