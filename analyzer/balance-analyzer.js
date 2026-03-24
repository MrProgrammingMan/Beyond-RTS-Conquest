/**
 * balance-analyzer.js
 * Sends balance + mechanics data to Claude for analysis.
 * Now uses game-context.js to inject full faction/mechanic knowledge
 * into the prompt — Claude reasons from actual game data, not summaries.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { injectContext } = require('./game-context');

async function analyzeBalance(balanceData, aggStats, mechanicsData, cfg, gameContext) {
  const client = new Anthropic({ apiKey: cfg.anthropicApiKey });
  const { results, factions } = balanceData;

  // ── Win rate matrix ────────────────────────────────────────────────────────
  const header = '             ' + factions.map(f => f.slice(0,6).padEnd(8)).join('');
  const matrixLines = [
    'WIN RATE MATRIX (row=P1 faction, col=P2 faction, value=P1 win%)',
    `Games per matchup: ${cfg.balance.gamesPerMatchup} | AI difficulty: ${cfg.balance.aiDifficulty}`,
    header,
  ];
  for (const f1 of factions) {
    const row = [f1.slice(0,12).padEnd(13)];
    for (const f2 of factions) {
      if (f1 === f2) { row.push('—       '); continue; }
      const r = results[f1]?.[f2];
      if (!r) { row.push('N/A     '); continue; }
      const games = r.p1Wins + r.p2Wins + r.draws + r.timeouts;
      const rate  = games > 0 ? Math.round(r.p1Wins / games * 100) : 0;
      const conf  = games >= 5 ? '' : '?'; // low confidence marker
      row.push(`${rate}%${conf}`.padEnd(8));
    }
    matrixLines.push(row.join(''));
  }

  // ── Per-faction summary ────────────────────────────────────────────────────
  const factionSummary = factions.map(f => {
    const s = aggStats[f];
    if (!s) return '';
    const dur = s.avgGameDuration;
    const durStr = dur ? `${Math.floor(dur/60)}m${dur%60}s avg` : 'n/a';
    const hpDelta = s.avgHpDelta != null ? ` avgHPdelta:${s.avgHpDelta}` : '';
    return [
      `${f}: ${s.overallWinRate}% overall (${s.totalWins}W/${s.totalLosses}L)`,
      `  best vs ${s.bestMatchup?.faction}(${Math.round((s.bestMatchup?.rate||0)*100)}%) `,
      `worst vs ${s.worstMatchup?.faction}(${Math.round((s.worstMatchup?.rate||0)*100)}%) `,
      `${durStr}${hpDelta}`,
    ].join('');
  }).filter(Boolean).join('\n');

  // ── Extreme matchups (flag 0% and 100% explicitly) ─────────────────────────
  const extremes = [];
  for (const f1 of factions) {
    for (const f2 of factions) {
      if (f1 === f2) continue;
      const r = results[f1]?.[f2];
      if (!r) continue;
      const games = r.p1Wins + r.p2Wins + r.draws + r.timeouts;
      if (games < 2) continue;
      const wr = r.p1Wins / games * 100;
      if (wr >= 85 || wr <= 15) {
        extremes.push(`  ${f1} vs ${f2}: ${Math.round(wr)}% (${r.p1Wins}W/${r.p2Wins}L/${r.timeouts}TO)`);
      }
    }
  }

  // ── Mechanic usage ─────────────────────────────────────────────────────────
  const totalGames = cfg.balance.gamesPerMatchup * factions.length * (factions.length - 1);
  const mechLines  = Object.entries(mechanicsData?.global || mechanicsData || {}).map(([key, count]) => {
    const pct  = totalGames > 0 ? Math.round(count / totalGames * 100) : 0;
    const flag = pct < cfg.mechanics.unusedThresholdPct ? ' ⚠ RARELY USED' : '';
    return `  ${key.padEnd(28)}: ${count}× across ${totalGames} games (${pct}%)${flag}`;
  }).join('\n');

  // ── Per-faction mechanic usage ─────────────────────────────────────────────
  let factionMechLines = '';
  if (mechanicsData?.byFaction) {
    factionMechLines = '\nPER-FACTION MECHANIC USAGE (counts across all games as that faction):\n';
    factionMechLines += Object.entries(mechanicsData.byFaction).map(([fid, mechs]) => {
      const fGames = aggStats[fid]?.totalGames || 1;
      const vals = Object.entries(mechs).map(([k, v]) =>
        `${k}:${v}(${Math.round(v/fGames*100)}%)`
      ).join(' ');
      return `  ${fid.padEnd(12)}: ${vals}`;
    }).join('\n');
  }

  // ── Timing events (economy data) ──────────────────────────────────────────
  let timingBlock = '';
  if (mechanicsData?.timingEvents?.length > 0) {
    const events = mechanicsData.timingEvents;
    const byType = {};
    for (const ev of events) {
      if (!byType[ev.event]) byType[ev.event] = [];
      byType[ev.event].push(ev.elapsed);
    }
    timingBlock = '\nECONOMY TIMING (avg elapsed seconds when event first occurs):\n';
    for (const [evName, times] of Object.entries(byType)) {
      const avg = Math.round(times.reduce((a,b)=>a+b,0)/times.length);
      const min = Math.min(...times);
      const max = Math.max(...times);
      timingBlock += `  ${evName.padEnd(22)}: avg=${avg}s min=${min}s max=${max}s (n=${times.length})\n`;
    }
  }

  // ── Position bias ─────────────────────────────────────────────────────────
  let p1Wins = 0, p2Wins = 0, totalDecisive = 0;
  for (const f1 of factions) {
    for (const f2 of factions) {
      if (f1 === f2) continue;
      const r = results[f1]?.[f2];
      if (!r) continue;
      p1Wins += r.p1Wins; p2Wins += r.p2Wins;
      totalDecisive += r.p1Wins + r.p2Wins;
    }
  }
  const p1Rate = totalDecisive > 0 ? Math.round(p1Wins / totalDecisive * 100) : 50;
  const expectedMatchups = factions.length * (factions.length - 1);
  const completionPct = expectedMatchups > 0 ? Math.round(totalDecisive / expectedMatchups * 100) : 0;
  const biasLine = `P1 wins ${p1Rate}% of decisive games (P2: ${100-p1Rate}%) across ${totalDecisive} of ${expectedMatchups} matchups (${completionPct}% completion)`;

  // ── The core analysis prompt ───────────────────────────────────────────────
  const analyticsPrompt = `You are a senior game balance designer analysing "Beyond RTS Conquest" after an automated AI vs AI test run.

You have complete knowledge of the game: every faction's units, costs, passives, upgrades, and the actual mechanic implementations are in the GAME CONTEXT section above. Use this knowledge directly — do not speculate about what mechanics do, you can see exactly how they work in the code.

══ TEST RUN DATA ══

${matrixLines.join('\n')}

PER-FACTION RESULTS:
${factionSummary}

EXTREME MATCHUPS (≥85% or ≤15%):
${extremes.join('\n') || '  None at this threshold'}

GLOBAL MECHANIC USAGE:
${mechLines}
${factionMechLines}
${timingBlock}
POSITION BIAS: ${biasLine}

══ INSTRUCTIONS ══

Write a complete balance report grounded in the actual game data above. For every claim, reference either:
  (a) a specific win rate from the matrix, OR
  (b) a specific mechanic from the game context (unit stat, upgrade, passive, code logic)

Never make vague suggestions like "consider nerfing X" — always give a specific number and explain exactly which mechanic it changes and why that will move the win rate in the right direction.

## EXECUTIVE SUMMARY
3-5 sentences. Overall health, biggest single problem, one positive observation.

## TIER LIST
Rank all ${factions.length} factions S/A/B/C/D. One line each: tier, win rate, one-sentence reason grounded in a specific mechanic.

## OVERTUNED FACTIONS (>55% overall win rate)
For each:
- What mechanic is causing the overperformance (cite unit name + stat or passive name)
- Specific numerical change (e.g. "reduce Pit Lord pitAuraDmg from 5 to 3")
- Expected win rate impact

## UNDERTUNED FACTIONS (<45% overall win rate)
For each:
- Root cause: is it missing economy? missing a niche? unit stats too weak?
- Specific buff: unit name, stat, new value
- Whether this creates a genuine identity for the faction or just adds numbers

## HARD COUNTER ANALYSIS
For each matchup at ≥80%:
- Is this counter intentional (design) or accidental (bug/overlap)?
- If accidental: specific mechanic creating it and fix
- If intentional: does the losing faction have any counterplay?

## MECHANIC HEALTH
For each mechanic flagged ⚠ RARELY USED:
- Is it broken, too expensive, not in AI logic, or just situational?
- Specific recommendation

## ECONOMY & TIMING OBSERVATIONS
Based on timing event data: are upgrades bought at a reasonable time? Is mid captured consistently? Any faction with notably different economic patterns?

## P1/P2 POSITION BIAS
Is ${p1Rate}% P1 win rate significant? If yes, which factions drive it (look for asymmetric matchup data in the matrix).

## PRIORITY PATCH LIST
Format: [HIGH/MED/LOW] faction — exact change — one-line reasoning
Order by impact. Maximum 12 items.

## IMPLEMENTATION PROMPT FOR CLAUDE
A ready-to-paste request that includes:
- The game architecture context (single-file HTML RTS, index.html ~15k lines, vanilla JS)
- Every specific change from the patch list above with exact values
- Which functions/lines to look in for each change
- Instruction to implement all changes in index.html

Wrap in: ===BALANCE PROMPT START=== and ===BALANCE PROMPT END===`;

  const model = cfg._cheapMode ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-4-6';
  const contextLevel = cfg._cheapMode ? 'compact' : 'factions';
  const fullPrompt = injectContext(analyticsPrompt, gameContext, contextLevel);

  const response = await client.messages.create({
    model,
    max_tokens: cfg._cheapMode ? 3000 : 4000,
    messages:   [{ role: 'user', content: fullPrompt }],
  });

  return response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
}

module.exports = { analyzeBalance };