/**
 * matchup-runner.js
 * Runs all faction matchups and aggregates both balance + QA data.
 */

const { chromium } = require('playwright');
const { runGame } = require('./game-runner');
const path = require('path');
const fs = require('fs');

const ALL_FACTIONS = [
  'warriors', 'summoners', 'brutes', 'spirits', 'verdant',
  'infernal', 'glacial', 'voltborn', 'bloodpact', 'menders',
];

async function runAllMatchups(cfg, onProgress = () => { }) {
  const factions = cfg.balance.factionFilter || ALL_FACTIONS;
  const mirror = cfg.balance.mirrorMatchups !== false;
  const bcfg = cfg.balance;

  // Build matchup queue
  const queue = [];
  for (let i = 0; i < factions.length; i++) {
    for (let j = 0; j < factions.length; j++) {
      if (i === j) continue;
      if (!mirror && j < i) continue;
      for (let g = 0; g < bcfg.gamesPerMatchup; g++) {
        queue.push({ p1: factions[i], p2: factions[j], gameNum: g + 1 });
      }
    }
  }

  const total = queue.length;
  let done = 0;

  // Balance results
  const results = {};
  for (const f1 of factions) {
    results[f1] = {};
    for (const f2 of factions) {
      if (f1 === f2) continue;
      results[f1][f2] = {
        p1Wins: 0, p2Wins: 0, draws: 0, timeouts: 0,
        durations: [], p1FinalHps: [], p2FinalHps: [],
        lastStands: { p1: 0, p2: 0 },
      };
    }
  }

  // QA aggregates across all games
  const qa = {
    allErrors: [],    // every JS error seen across all games
    allNaNs: [],    // every NaN event
    allTimedOut: [],    // games that timed out (softlocks)
    mechanicUsage: {    // totals across all games
      spy_deployed: 0,
      mid_captured: 0,
      upgrade_purchased: 0,
      buff_activated: 0,
      last_stand_triggered: 0,
      aerial_unit_spawned: 0,
      worker_sent_to_mid: 0,
    },
    mechanicByMatchup: {},  // mechanic usage per p1-vs-p2 matchup
    performance: {
      avgFrameMsAll: [],
      maxFrameMsAll: [],
      longTasksAll: [],
    },
    totalGamesRun: 0,
  };

  const ssDir = path.resolve(cfg.output.screenshotsDir || './screenshots');
  if (cfg.output.saveScreenshots) fs.mkdirSync(ssDir, { recursive: true });

  const parallel = Math.max(1, Math.min(bcfg.parallelGames || 3, 6));
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ],
  });

  try {
    let idx = 0;

    async function worker() {
      while (idx < queue.length) {
        const job = queue[idx++];
        if (!job) break;

        let game;
        try {
          game = await runGame(
            path.resolve(cfg.gamePath),
            job.p1, job.p2,
            {
              difficulty: bcfg.aiDifficulty || 'hard',
              timeoutMs: (bcfg.gameTimeoutSecs || 60) * 1000,
              browser,
              screenshotOnError: cfg.bugs.screenshotOnError,
              screenshotsDir: ssDir,
            }
          );
        } catch (err) {
          game = {
            winnerPid: -1, timedOut: true, elapsed: 0,
            p1Faction: job.p1, p2Faction: job.p2,
            errors: [{ type: 'runner_error', message: err.message }],
            nanEvents: [], mechanics: {}, performance: {},
          };
        }

        qa.totalGamesRun++;

        // ── Balance ──────────────────────────────────────────────────────────
        const r = results[job.p1]?.[job.p2];
        if (r) {
          if (game.winnerPid === 1) r.p1Wins++;
          else if (game.winnerPid === 2) r.p2Wins++;
          else if (game.timedOut) r.timeouts++;
          else r.draws++;
          if (game.elapsed) r.durations.push(game.elapsed);
          if (game.p1BaseHp !== undefined) r.p1FinalHps.push(game.p1BaseHp);
          if (game.p2BaseHp !== undefined) r.p2FinalHps.push(game.p2BaseHp);
          if (game.lastStandFired?.[0]) r.lastStands.p1++;
          if (game.lastStandFired?.[1]) r.lastStands.p2++;
        }

        // ── QA: errors ────────────────────────────────────────────────────────
        if (game.errors?.length > 0) {
          for (const err of game.errors) {
            qa.allErrors.push({
              ...err,
              matchup: `${job.p1} vs ${job.p2}`,
              gameNum: job.gameNum,
              gameElapsed: game.elapsed,
              screenshotPath: game.errorScreenshot || null,
            });
          }
        }

        // ── QA: NaN events ────────────────────────────────────────────────────
        if (game.nanEvents?.length > 0) {
          for (const n of game.nanEvents) {
            qa.allNaNs.push({ ...n, matchup: `${job.p1} vs ${job.p2}`, gameNum: job.gameNum });
          }
        }

        // ── QA: softlocks ─────────────────────────────────────────────────────
        if (game.timedOut || game.winnerPid === -1) {
          qa.allTimedOut.push({
            matchup: `${job.p1} vs ${job.p2}`,
            gameNum: job.gameNum,
            elapsed: game.elapsed,
            p1BaseHp: game.p1BaseHp,
            p2BaseHp: game.p2BaseHp,
            errors: game.errors || [],
          });
        }

        // ── QA: mechanics ─────────────────────────────────────────────────────
        if (game.mechanics) {
          for (const [key, val] of Object.entries(game.mechanics)) {
            if (typeof val === 'number') qa.mechanicUsage[key] = (qa.mechanicUsage[key] || 0) + val;
          }
          const mk = `${job.p1}_vs_${job.p2}`;
          if (!qa.mechanicByMatchup[mk]) qa.mechanicByMatchup[mk] = { ...game.mechanics };
        }

        // ── QA: performance ───────────────────────────────────────────────────
        if (game.performance?.avgFrameMs) {
          qa.performance.avgFrameMsAll.push(game.performance.avgFrameMs);
          qa.performance.maxFrameMsAll.push(game.performance.maxFrameMs || 0);
          if (game.performance.longTasks?.length > 0) {
            qa.performance.longTasksAll.push(...game.performance.longTasks.map(t => ({
              ...t, matchup: `${job.p1} vs ${job.p2}`
            })));
          }
        }

        done++;
        onProgress({
          done, total,
          latest: {
            p1: job.p1, p2: job.p2, gameNum: job.gameNum,
            result: winLabel(game.winnerPid, job.p1, job.p2),
            elapsed: game.elapsed,
            timedOut: !!game.timedOut,
            hasErrors: (game.errors?.length || 0) > 0,
            hasNaN: (game.nanEvents?.length || 0) > 0,
            firstError: game.errors?.[0]?.message?.replace(/\n/g, ' ')?.slice(0, 70) || null,
          },
        });
      }
    }

    const workers = Array.from({ length: parallel }, () => worker());
    await Promise.all(workers);

  } finally {
    await browser.close();
  }

  return { results, factions, qa };
}

function winLabel(winnerPid, p1, p2) {
  if (winnerPid === 1) return `${p1} wins`;
  if (winnerPid === 2) return `${p2} wins`;
  if (winnerPid === 0) return 'draw';
  return 'timeout';
}

function aggregateStats(data) {
  const { results, factions } = data;
  const stats = {};
  for (const f of factions) {
    let totalWins = 0, totalLosses = 0, totalGames = 0, totalDur = 0, durCount = 0;
    const best = { faction: null, rate: 0 };
    const worst = { faction: null, rate: 1 };
    for (const opp of factions) {
      if (opp === f) continue;
      const r = results[f]?.[opp];
      if (!r) continue;
      const games = r.p1Wins + r.p2Wins + r.draws + r.timeouts;
      if (!games) continue;
      totalGames += games;
      totalWins += r.p1Wins;
      totalLosses += r.p2Wins;
      r.durations.forEach(d => { totalDur += d; durCount++; });
      const wr = r.p1Wins / games;
      if (wr > best.rate) { best.rate = wr; best.faction = opp; }
      if (wr < worst.rate) { worst.rate = wr; worst.faction = opp; }
    }
    stats[f] = {
      totalWins, totalLosses, totalGames,
      overallWinRate: totalGames > 0 ? Math.round(totalWins / totalGames * 1000) / 10 : 50,
      avgGameDuration: durCount > 0 ? Math.round(totalDur / durCount) : 0,
      bestMatchup: best, worstMatchup: worst,
    };
  }
  return stats;
}

module.exports = { runAllMatchups, aggregateStats, ALL_FACTIONS };