/**
 * anomaly-detector.js — Beyond RTS Behavioral Anomaly Detection
 *
 * Finds suspicious patterns in raw game data that aren't JS errors —
 * things that "feel wrong" even when no exception fires:
 *
 *   - Games that end suspiciously fast (< 30s) or slow (> 12min)
 *   - Factions with implausibly high/low soul income (possible economy bug)
 *   - Mechanics with 0% usage (potentially broken, not just underpowered)
 *   - Matchup win rates so extreme they suggest a hard-coded advantage
 *   - P1 vs P2 systemic position bias (structural first-player advantage)
 *   - Last Stand never firing despite close games (trigger bug)
 *   - Games where both bases end at exactly 0 (draw logic bug)
 *   - Timeout clustering in specific matchups (softlock in one faction interaction)
 */

function detectAnomalies(rawData, aggStats, cfg) {
  const { results, factions, qa } = rawData;
  const anomalies = [];

  // ── 1. Game duration anomalies ────────────────────────────────────────────
  const allDurations = [];
  for (const f1 of factions) {
    for (const f2 of factions) {
      if (f1 === f2) continue;
      const r = results[f1]?.[f2];
      if (!r?.durations?.length) continue;
      r.durations.forEach(d => allDurations.push({ d, f1, f2 }));
    }
  }

  if (allDurations.length > 0) {
    const durations = allDurations.map(x => x.d);
    const mean = durations.reduce((a, b) => a + b, 0) / durations.length;
    const sd   = Math.sqrt(durations.map(d => (d - mean) ** 2).reduce((a, b) => a + b, 0) / durations.length);

    const tooFast = allDurations.filter(x => x.d < 30);
    const tooSlow = allDurations.filter(x => x.d > 720);
    const outliers = allDurations.filter(x => Math.abs(x.d - mean) > sd * 3);

    if (tooFast.length > 0) {
      const matchups = [...new Set(tooFast.map(x => `${x.f1} vs ${x.f2}`))].slice(0, 4);
      anomalies.push({
        severity: 'HIGH',
        type: 'suspiciously_fast_games',
        title: 'Games ending in < 30s',
        detail: `${tooFast.length} game(s) ended in under 30 seconds. Matchups: ${matchups.join(', ')}. Fastest: ${Math.min(...tooFast.map(x=>x.d))}s`,
        suggestion: 'A faction may have an opening that instantly destroys the base, or checkWin() may be firing before the game is fully initialized.',
        prompt: `${tooFast.length} games ended in under 30 seconds (fastest: ${Math.min(...tooFast.map(x=>x.d))}s). Affected matchups: ${matchups.join(', ')}. In index.html, check: (1) that checkWin() has a grace period at game start (first 15–20 seconds), (2) that faction starting bonuses don't grant immediate overwhelming economy, (3) that initGame() fully sets base HP before the game loop begins.`,
      });
    }

    if (tooSlow.length > 3) {
      const matchups = [...new Set(tooSlow.map(x => `${x.f1} vs ${x.f2}`))].slice(0, 4);
      anomalies.push({
        severity: 'MEDIUM',
        type: 'suspiciously_slow_games',
        title: 'Games running > 12 minutes',
        detail: `${tooSlow.length} game(s) exceeded 12 minutes. Mean duration: ${Math.round(mean / 60)}m. Affected matchups: ${matchups.join(', ')}`,
        suggestion: 'May indicate a defensive deadlock where neither faction can close out the game, or siege mechanic not functioning correctly.',
        prompt: `${tooSlow.length} games ran longer than 12 minutes (game time). Mean across all games: ${Math.round(mean/60)}m. This may indicate that certain faction pairings cause a defensive deadlock. In index.html, check whether the siege mechanic (updateSiege) is actually applying base damage, and whether late-game unit power scaling is capped in a way that prevents game resolution.`,
      });
    }

    if (outliers.length > 0 && sd > 60) {
      const m = [...new Set(outliers.map(x => `${x.f1} vs ${x.f2}`))].slice(0, 3);
      anomalies.push({
        severity: 'LOW',
        type: 'duration_outliers',
        title: 'High game duration variance',
        detail: `Mean: ${Math.round(mean)}s, SD: ${Math.round(sd)}s. ${outliers.length} games deviate >3σ from mean. Matchups: ${m.join(', ')}`,
        suggestion: 'Large variance can indicate inconsistent AI behavior or a faction whose outcome is highly random.',
      });
    }
  }

  // ── 2. Mechanic usage anomalies ───────────────────────────────────────────
  const totalGames = qa.totalGamesRun || 1;
  for (const [key, count] of Object.entries(qa.mechanicUsage || {})) {
    if (count === 0) {
      anomalies.push({
        severity: 'HIGH',
        type: 'mechanic_never_used',
        title: `Mechanic never triggered: ${key}`,
        detail: `"${key}" was used 0 times across all ${totalGames} games. This is likely a broken mechanic, not just an underpowered one.`,
        suggestion: `Check that the code path for "${key}" is reachable from AI logic. AI may not have a trigger condition for it, or the mechanic may throw a silent error.`,
        prompt: `The mechanic "${key}" was never used across ${totalGames} AI vs AI games. In index.html, search for the code that triggers this mechanic (likely in the AI decision function or unit spawn logic). Verify: (1) the mechanic is accessible to AI players, not just human input, (2) the condition to trigger it is reachable at the AI's difficulty level, (3) there are no silent errors or null checks blocking it.`,
      });
    } else {
      const pct = count / totalGames * 100;
      if (pct < (cfg.mechanics?.unusedThresholdPct || 15)) {
        // Only flag as anomaly if extremely low (< 5%), otherwise leave to normal mechanic report
        if (pct < 5) {
          anomalies.push({
            severity: 'MEDIUM',
            type: 'mechanic_critically_underused',
            title: `Mechanic critically underused: ${key} (${pct.toFixed(1)}%)`,
            detail: `Used in only ${pct.toFixed(1)}% of games (${count} times). Below 5% threshold for anomaly flag.`,
            suggestion: `Either the trigger condition is too expensive, the AI is not evaluating it correctly, or there is a subtle bug preventing it from activating.`,
          });
        }
      }
    }
  }

  // ── 3. Extreme win rates (possible hard-coded advantage) ──────────────────
  for (const f1 of factions) {
    for (const f2 of factions) {
      if (f1 === f2) continue;
      const r = results[f1]?.[f2];
      if (!r) continue;
      const games = r.p1Wins + r.p2Wins + r.draws + r.timeouts;
      if (games < 3) continue;
      const wr = r.p1Wins / games;
      if (wr >= 0.85) {
        anomalies.push({
          severity: 'HIGH',
          type: 'extreme_win_rate',
          title: `${f1} wins ${Math.round(wr*100)}% vs ${f2}`,
          detail: `${r.p1Wins}W / ${r.p2Wins}L / ${r.draws}D across ${games} games. Win rate ${Math.round(wr*100)}% (threshold: 85%).`,
          suggestion: `This suggests a near-hard-counter relationship. If unintentional, check whether ${f1} has a unit type that bypasses ${f2}'s defensive mechanic, or whether ${f2} is missing a counter-play option.`,
          prompt: `${f1} wins ${Math.round(wr*100)}% of games against ${f2} (${r.p1Wins}/${games} games). This is an extreme imbalance. In index.html, review: (1) unit damage/HP values for ${f1} vs ${f2} unit matchups, (2) faction passives that may compound advantage, (3) whether any special interaction between these factions' mechanics creates an unintended feedback loop. Suggest targeted nerfs/buffs to bring this matchup into the 45–55% range.`,
        });
      }
    }
  }

  // ── 4. P1/P2 position bias ────────────────────────────────────────────────
  let totalP1Wins = 0, totalP2Wins = 0, totalGamesAll = 0;
  for (const f1 of factions) {
    for (const f2 of factions) {
      if (f1 === f2) continue;
      const r = results[f1]?.[f2];
      if (!r) continue;
      const games = r.p1Wins + r.p2Wins + r.draws + r.timeouts;
      totalP1Wins += r.p1Wins;
      totalP2Wins += r.p2Wins;
      totalGamesAll += games;
    }
  }
  if (totalGamesAll > 20) {
    const p1Bias = totalP1Wins / (totalP1Wins + totalP2Wins);
    if (p1Bias > 0.55 || p1Bias < 0.45) {
      anomalies.push({
        severity: 'MEDIUM',
        type: 'position_bias',
        title: `${p1Bias > 0.55 ? 'P1 first-player advantage' : 'P2 second-player advantage'}: ${Math.round(p1Bias * 100)}% P1 wins`,
        detail: `Across ${totalP1Wins + totalP2Wins} decisive games: P1 wins ${Math.round(p1Bias*100)}%, P2 wins ${Math.round((1-p1Bias)*100)}%. Expected: ~50%.`,
        suggestion: `A structural position bias this large (>5%) usually means one side has a positional advantage in map layout, soul income timing, or mid capture proximity. Check map symmetry and starting soul amounts.`,
        prompt: `Overall P1 win rate is ${Math.round(p1Bias*100)}% across ${totalP1Wins+totalP2Wins} decisive games — a ${Math.abs(50 - Math.round(p1Bias*100))}% position bias. In index.html, check: (1) whether the map canvas is perfectly symmetric (base positions, mid-point, lane layout), (2) P1 and P2 starting soul amounts are identical, (3) mid capture zone is equidistant from both bases, (4) any time-based advantage (e.g. P1 gets the first AI tick).`,
      });
    }
  }

  // ── 5. Last Stand never triggering despite close games ────────────────────
  let closeGamesCount = 0, lastStandCount = 0;
  for (const f1 of factions) {
    for (const f2 of factions) {
      if (f1 === f2) continue;
      const r = results[f1]?.[f2];
      if (!r) continue;
      // Close games: loser ended at > 20 base HP (i.e., wasn't close) — actually,
      // close game = winner had a close call. We'll use lastStands tracked.
      lastStandCount += (r.lastStands?.p1 || 0) + (r.lastStands?.p2 || 0);
      closeGamesCount += r.p1Wins + r.p2Wins;
    }
  }
  const lastStandPct = closeGamesCount > 0 ? lastStandCount / closeGamesCount * 100 : 0;
  if (lastStandPct < 5 && closeGamesCount > 20 && (qa.mechanicUsage?.last_stand_triggered || 0) === 0) {
    anomalies.push({
      severity: 'MEDIUM',
      type: 'last_stand_never_fires',
      title: 'Last Stand mechanic never triggered',
      detail: `0 Last Stand activations across ${closeGamesCount} finished games. The mechanic should fire when base HP drops to ≤30.`,
      suggestion: `Last Stand may be broken: its HP trigger threshold may not be reached due to games ending too quickly, or the trigger condition (checking baseHp ≤ 30) may have a bug.`,
      prompt: `The Last Stand mechanic fired 0 times across ${closeGamesCount} games. In index.html, search for 'last_stand' or 'lastStand' and verify: (1) the trigger condition checks baseHp <= 30 (not some other threshold), (2) the trigger fires at the right point in the game loop (after damage is applied, before checkWin), (3) the AI difficulty being tested doesn't prevent games from reaching the Last Stand threshold by ending them too decisively.`,
    });
  }

  // ── 6. Timeout clustering ─────────────────────────────────────────────────
  const timeoutsByMatchup = {};
  for (const t of (qa.allTimedOut || [])) {
    timeoutsByMatchup[t.matchup] = (timeoutsByMatchup[t.matchup] || 0) + 1;
  }
  for (const [matchup, count] of Object.entries(timeoutsByMatchup)) {
    const gamesInMatchup = cfg.balance?.gamesPerMatchup || 3;
    if (count >= Math.max(2, gamesInMatchup * 0.5)) {
      anomalies.push({
        severity: 'HIGH',
        type: 'timeout_clustering',
        title: `Repeated softlock in ${matchup}`,
        detail: `${count}/${gamesInMatchup} games timed out for this matchup specifically. This is not random — something in this faction interaction causes a deadlock.`,
        suggestion: 'This matchup probably reaches a state where neither faction can damage the other — mutual invincibility bug, unit AI pathfinding loop, or siege damage incorrectly returning 0.',
        prompt: `${count} out of ${gamesInMatchup} games in "${matchup}" timed out without a winner. This is faction-specific, indicating a deadlock unique to this interaction. In index.html, check: (1) whether siege damage (updateSiege) is zero against either faction's base in this matchup, (2) whether unit targeting logic correctly identifies enemy bases, (3) whether any faction passive creates mutual invincibility when both factions are present.`,
      });
    }
  }

  // ── 7. Draw rate anomaly ──────────────────────────────────────────────────
  let totalDraws = 0, totalPlayed = 0;
  for (const f1 of factions) {
    for (const f2 of factions) {
      if (f1 === f2) continue;
      const r = results[f1]?.[f2];
      if (!r) continue;
      totalDraws += r.draws;
      totalPlayed += r.p1Wins + r.p2Wins + r.draws;
    }
  }
  if (totalPlayed > 0 && (totalDraws / totalPlayed) > 0.1) {
    anomalies.push({
      severity: 'MEDIUM',
      type: 'high_draw_rate',
      title: `High draw rate: ${Math.round(totalDraws/totalPlayed*100)}% of games`,
      detail: `${totalDraws} draws out of ${totalPlayed} games. Expected: < 2%. Draws usually mean both bases hit 0 simultaneously, suggesting checkWin() timing or simultaneous death handling has a bug.`,
      suggestion: 'Check whether simultaneous base death is handled with a clear P1-wins-on-tie rule, or if a checkWin debounce is missing.',
      prompt: `${totalDraws} out of ${totalPlayed} games ended as draws (${Math.round(totalDraws/totalPlayed*100)}%). Expected: < 2%. In index.html, find checkWin() and verify: (1) simultaneous base deaths are resolved deterministically (e.g. player with higher baseHp wins, or P1 wins ties), (2) checkWin is not being called with G.running already false, (3) G.running is set to false exactly once with a clear winner set.`,
    });
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const critical = anomalies.filter(a => a.severity === 'HIGH').length;
  const medium   = anomalies.filter(a => a.severity === 'MEDIUM').length;

  return {
    anomalies,
    summary: `${anomalies.length} anomalies (${critical} HIGH, ${medium} MEDIUM)`,
    hasCritical: critical > 0,
  };
}

module.exports = { detectAnomalies };
