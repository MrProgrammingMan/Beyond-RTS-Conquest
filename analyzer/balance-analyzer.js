/**
 * balance-analyzer.js
 * Sends balance + mechanics data to Claude for analysis.
 */

const Anthropic = require('@anthropic-ai/sdk');

async function analyzeBalance(balanceData, aggStats, mechanicsData, cfg) {
  const client = new Anthropic({ apiKey: cfg.anthropicApiKey });
  const { results, factions } = balanceData;

  // Win rate matrix text
  const matrixLines = [
    'WIN RATE MATRIX (row=P1 faction, col=P2 faction, value=P1 win%)',
    '             ' + factions.map(f => f.padEnd(13)).join(''),
  ];
  for (const f1 of factions) {
    const row = [f1.padEnd(13)];
    for (const f2 of factions) {
      if (f1 === f2) { row.push('—            '); continue; }
      const r = results[f1]?.[f2];
      if (!r) { row.push('N/A          '); continue; }
      const games = r.p1Wins + r.p2Wins + r.draws + r.timeouts;
      const rate  = games > 0 ? Math.round(r.p1Wins / games * 100) : 0;
      row.push(`${rate}%`.padEnd(13));
    }
    matrixLines.push(row.join(''));
  }

  const factionSummary = factions.map(f => {
    const s = aggStats[f];
    if (!s) return '';
    return `${f}: ${s.overallWinRate}% overall, best vs ${s.bestMatchup.faction} (${Math.round(s.bestMatchup.rate*100)}%), worst vs ${s.worstMatchup.faction} (${Math.round(s.worstMatchup.rate*100)}%), avg game ${Math.floor(s.avgGameDuration/60)}m${s.avgGameDuration%60}s`;
  }).join('\n');

  // Mechanics summary
  const totalGames = cfg.balance.gamesPerMatchup * factions.length * (factions.length - 1);
  const mechLines = Object.entries(mechanicsData || {}).map(([key, count]) => {
    const pct = totalGames > 0 ? Math.round(count / totalGames * 100) : 0;
    const flag = pct < cfg.mechanics.unusedThresholdPct ? ' ⚠️ RARELY USED' : '';
    return `  ${key.padEnd(28)}: ${count} times across ${totalGames} games (${pct}%)${flag}`;
  }).join('\n');

  const prompt = `You are a senior game balance designer for "Beyond RTS Conquest", a 2-player browser RTS.

GAME: Each player controls a base. Spend Souls + Bodies to spawn units, capture mid for bonus income, use spies, buy upgrades, activate buffs. Base reaches 0 HP → lose.

FACTIONS: ${factions.join(', ')}

══ BALANCE DATA (${cfg.balance.gamesPerMatchup} games/matchup, AI: ${cfg.balance.aiDifficulty}) ══

${matrixLines.join('\n')}

PER-FACTION:
${factionSummary}

══ MECHANIC USAGE ══
${mechLines}

Write a complete balance report:

## EXECUTIVE SUMMARY
3-5 sentences: overall balance health, biggest concerns.

## TIER LIST
S/A/B/C/D tier for each faction with reasoning.

## OVERTUNED FACTIONS (>55% win rate)
Per faction: what's causing it, specific numerical nerfs, reasoning.

## UNDERTUNED FACTIONS (<45% win rate)
Per faction: why underperforming, conservative buffs, reasoning.

## HARD COUNTERS (one faction wins >70% vs another)
List each, explain if intentional or accidental, suggest fix if accidental.

## MECHANICS ANALYSIS
Comment on any underused mechanics (flagged with ⚠️ above). Is each mechanic discoverable? Too expensive? Broken?

## P1/P2 POSITION BIAS
Is there a structural first-player advantage? Evidence from the matrix.

## GAME LENGTH
Are games too short/long? Any matchups that consistently produce unusually long games?

## PRIORITY PATCH LIST
[HIGH/MED/LOW] Faction — Specific change — Reasoning

## DEVELOPER PROMPT FOR CLAUDE
Write a ready-to-paste implementation request.
Start: ===BALANCE PROMPT START===
End:   ===BALANCE PROMPT END===`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
}

module.exports = { analyzeBalance };
