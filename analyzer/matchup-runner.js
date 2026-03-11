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
    // #17: mechanic usage broken down by faction — reveals whether underuse
    // is universal or faction-specific (e.g. Warriors never buys upgrades).
    // Structure: { faction: { mechanic_key: totalCount } }
    mechanicByFaction: {},
    // #20: closest games — matchups where combined final HP was lowest,
    // indicating the most competitive outcomes.
    // Each entry: { matchup, p1Faction, p2Faction, combinedHp, p1Hp, p2Hp, elapsed }
    closestGames: [],
    performance: {
      avgFrameMsAll: [],
      maxFrameMsAll: [],
      longTasksAll: [],
    },
    totalGamesRun: 0,
  };

  // Initialise mechanicByFaction for all known factions
  for (const f of factions) qa.mechanicByFaction[f] = {
    spy_deployed: 0, mid_captured: 0, upgrade_purchased: 0,
    buff_activated: 0, last_stand_triggered: 0,
    aerial_unit_spawned: 0, worker_sent_to_mid: 0,
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

          // #17: accumulate into per-faction buckets.
          // Because instrumentation runs inside a single shared game page (both
          // factions playing), we can't attribute each mechanic activation to a
          // specific faction. Instead we split totals evenly between the two
          // factions playing — a reasonable approximation that still reveals
          // when a faction consistently appears in low-mechanic games.
          for (const f of [job.p1, job.p2]) {
            if (!qa.mechanicByFaction[f]) qa.mechanicByFaction[f] = {};
            for (const [key, val] of Object.entries(game.mechanics)) {
              if (typeof val === 'number') {
                qa.mechanicByFaction[f][key] = (qa.mechanicByFaction[f][key] || 0) + val;
              }
            }
          }
        }

        // #20: track closest games (lowest combined final HP = most competitive).
        // Only record finished (non-timeout) games with valid HP readings.
        if (!game.timedOut && game.winnerPid !== -1 &&
          game.p1BaseHp !== undefined && game.p2BaseHp !== undefined) {
          const combinedHp = game.p1BaseHp + game.p2BaseHp;
          qa.closestGames.push({
            matchup: `${job.p1} vs ${job.p2}`,
            p1Faction: job.p1,
            p2Faction: job.p2,
            combinedHp,
            p1Hp: game.p1BaseHp,
            p2Hp: game.p2BaseHp,
            elapsed: game.elapsed,
            winner: game.winnerPid === 1 ? job.p1 : job.p2,
          });
          // Keep only top 20 closest to avoid unbounded growth
          if (qa.closestGames.length > 20) {
            qa.closestGames.sort((a, b) => a.combinedHp - b.combinedHp);
            qa.closestGames.length = 20;
          }
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
  const { results, factions, qa } = data;
  const stats = {};

  for (const f of factions) {
    let totalWins = 0, totalLosses = 0, totalGames = 0, totalDur = 0, durCount = 0;
    const best = { faction: null, rate: 0 };
    const worst = { faction: null, rate: 1 };

    // #21: track wins/games split by position
    let asP1Wins = 0, asP1Games = 0, asP2Wins = 0, asP2Games = 0;

    for (const opp of factions) {
      if (opp === f) continue;

      // f as P1 vs opp
      const rAsP1 = results[f]?.[opp];
      if (rAsP1) {
        const games = rAsP1.p1Wins + rAsP1.p2Wins + rAsP1.draws + rAsP1.timeouts;
        if (games) {
          totalGames += games;
          totalWins += rAsP1.p1Wins;
          totalLosses += rAsP1.p2Wins;
          asP1Wins += rAsP1.p1Wins;
          asP1Games += games;
          rAsP1.durations.forEach(d => { totalDur += d; durCount++; });
          const wr = rAsP1.p1Wins / games;
          if (wr > best.rate) { best.rate = wr; best.faction = opp; }
          if (wr < worst.rate) { worst.rate = wr; worst.faction = opp; }
        }
      }

      // f as P2 vs opp (opp is P1 here, so results[opp][f].p2Wins = f's wins as P2)
      const rAsP2 = results[opp]?.[f];
      if (rAsP2) {
        const games = rAsP2.p1Wins + rAsP2.p2Wins + rAsP2.draws + rAsP2.timeouts;
        if (games) {
          asP2Wins += rAsP2.p2Wins;
          asP2Games += games;
        }
      }
    }

    // #17: per-faction mechanic rates (uses divided totals collected during run)
    const fMech = qa?.mechanicByFaction?.[f] || {};
    // gamesInvolved = all games where f appeared (as P1 or P2)
    const gamesInvolved = asP1Games + asP2Games;
    const mechanicRates = {};
    for (const [key, count] of Object.entries(fMech)) {
      mechanicRates[key] = gamesInvolved > 0
        ? Math.round(count / gamesInvolved * 100) / 100  // rate per game
        : 0;
    }

    stats[f] = {
      totalWins, totalLosses, totalGames,
      overallWinRate: totalGames > 0 ? Math.round(totalWins / totalGames * 1000) / 10 : 50,
      avgGameDuration: durCount > 0 ? Math.round(totalDur / durCount) : 0,
      bestMatchup: best, worstMatchup: worst,
      // #21: positional win rates
      asP1WinRate: asP1Games > 0 ? Math.round(asP1Wins / asP1Games * 1000) / 10 : 50,
      asP2WinRate: asP2Games > 0 ? Math.round(asP2Wins / asP2Games * 1000) / 10 : 50,
      asP1Games, asP2Games,
      positionGap: asP1Games > 0 && asP2Games > 0
        ? Math.round(Math.abs(asP1Wins / asP1Games - asP2Wins / asP2Games) * 1000) / 10
        : 0,
      // #17: mechanic usage rates per game this faction appeared in
      mechanicRates,
    };
  }
  return stats;
}

module.exports = { runAllMatchups, aggregateStats, ALL_FACTIONS };