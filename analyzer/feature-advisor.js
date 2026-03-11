/**
 * feature-advisor.js — Beyond RTS Conquest Feature Advisor
 *
 * Uses game-context.js so Claude knows exactly what mechanics exist,
 * how they're implemented, and what each faction's identity is — enabling
 * suggestions that reference actual code rather than vague RTS generalities.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { injectContext } = require('./game-context');

async function generateFeatureAdvice(rawData, aggStats, anomalyReport, onlineReport, uiAuditResult, diagnosedBugs, cfg, gameContext) {
  const client = new Anthropic({ apiKey: cfg.anthropicApiKey });
  const { factions, qa } = rawData;
  const totalGames = qa.totalGamesRun || 0;

  // ── Data summaries ────────────────────────────────────────────────────────
  const factionSummary = factions.map(f => {
    const s = aggStats[f]; if (!s) return '';
    const tier = s.overallWinRate >= 60 ? 'S' : s.overallWinRate >= 55 ? 'A'
               : s.overallWinRate >= 48 ? 'B' : s.overallWinRate >= 43 ? 'C' : 'D';
    return `  ${f.padEnd(12)} ${s.overallWinRate}% win  tier-${tier}  avg ${Math.floor(s.avgGameDuration/60)}m${s.avgGameDuration%60}s  best:${s.bestMatchup?.faction}(${Math.round((s.bestMatchup?.rate||0)*100)}%)  worst:${s.worstMatchup?.faction}(${Math.round((s.worstMatchup?.rate||0)*100)}%)`;
  }).filter(Boolean).join('\n');

  const mechSummary = Object.entries(qa.mechanicUsage || {}).map(([k, v]) => {
    const pct  = totalGames > 0 ? Math.round(v / totalGames * 100) : 0;
    const flag = pct === 0 ? '❌ NEVER USED' : pct < 15 ? '⚠ underused' : '';
    return `  ${k.padEnd(28)} ${pct}%  (${v}×) ${flag}`;
  }).join('\n');

  const bugSummary = diagnosedBugs.length === 0 ? '  None detected' :
    diagnosedBugs.slice(0, 8).map(b =>
      `  [${(b.diagnosis?.severity || '?')}] ${b.type}: ${(b.message || '').slice(0, 90)}`
    ).join('\n');

  const anomalySummary = !(anomalyReport?.anomalies?.length) ? '  None' :
    anomalyReport.anomalies.slice(0, 6).map(a =>
      `  [${a.severity}] ${a.title}: ${a.detail.slice(0, 100)}`
    ).join('\n');

  const uiSummary = !(uiAuditResult?.issues?.length) ? '  No UI issues' :
    `  ${uiAuditResult.issues.filter(i => i.severity === 'error').length} errors, ` +
    `${uiAuditResult.issues.filter(i => i.severity === 'warning').length} warnings`;

  const onlineSummary = onlineReport
    ? `  Grade: ${onlineReport.overallGrade}  ${onlineReport.summary}\n` +
      (onlineReport.issues || []).slice(0, 3).map(i => `  [${i.severity}] ${i.message.slice(0, 80)}`).join('\n')
    : '  Not run';

  // ── Core prompt ───────────────────────────────────────────────────────────
  // The game context block is injected above this by injectContext().
  // Claude can reference actual faction mechanics, unit flags, function names
  // from that context without us re-summarising the game here.
  const corePrompt = `You are a senior game designer reviewing a complete automated QA report for "Beyond RTS Conquest".

You have complete knowledge of the game above — every faction's units, passives, upgrades, mechanic implementations, and exact code logic. Use this knowledge when making suggestions. Reference specific mechanic names, unit names, upgrade names, and function names from the game context. Do not suggest mechanics that already exist.

══ QA RUN RESULTS (${totalGames} AI vs AI games) ══

FACTION BALANCE:
${factionSummary || '  No data'}

MECHANIC USAGE (% of games where mechanic activated at least once):
${mechSummary || '  No data'}

BUGS FOUND:
${bugSummary}

BEHAVIORAL ANOMALIES:
${anomalySummary}

UI ISSUES:
${uiSummary}

ONLINE SYNC:
${onlineSummary}

══ TASK ══

Generate 8–12 prioritized feature suggestions and improvements. Ground each suggestion in the QA data above AND the game mechanics in the context. For every suggestion:

- Reference the specific QA metric that motivated it (mechanic usage %, win rate, specific bug)
- Reference the specific game mechanic, faction, unit, or function it improves
- For implementation: name the actual function(s) to modify, not just a description
- Do NOT suggest things that already exist in the game (check the mechanic list and faction context)
- Distinguish clearly between quick wins (< 4 hours), medium (1–2 days), large (3–7 days)

Output ONLY a JSON array:

[
  {
    "priority": 1,
    "category": "gameplay|ux|balance|online|performance|polish",
    "title": "Short feature title",
    "rationale": "1-2 sentences citing specific QA data (e.g. 'spy_deployed used in only 8% of games') and the game mechanic it relates to",
    "effort": "quick|medium|large",
    "impact": "high|medium|low",
    "implementation": "Concrete steps referencing actual function names and variable names from the game context. 3-5 sentences.",
    "pasteToClaudePrompt": "Self-contained implementation request. Include: game is a single HTML file ~15k lines vanilla JS + Canvas. State exact mechanic to add/change, which functions to modify (by name), and what the change should do. End with 'Please implement this in index.html.' Max 1000 chars. Escape newlines as \\n."
  }
]`;

  try {
    const fullPrompt = injectContext(corePrompt, gameContext, 'factions');
    const response = await client.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 5000,
      messages:   [{ role: 'user', content: fullPrompt }],
    });

    const rawText   = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
    let suggestions = [];
    try {
      suggestions = JSON.parse(rawText.replace(/```json|```/g, '').trim());
    } catch (_) {
      const m = rawText.match(/\[[\s\S]+\]/);
      if (m) try { suggestions = JSON.parse(m[0]); } catch (_) {}
    }

    suggestions = (Array.isArray(suggestions) ? suggestions : []).map((s, i) => ({
      priority:            s.priority || i + 1,
      category:            s.category || 'gameplay',
      title:               s.title || 'Unnamed suggestion',
      rationale:           s.rationale || '',
      effort:              (s.effort || 'medium').toLowerCase(),
      impact:              (s.impact || 'medium').toLowerCase(),
      implementation:      s.implementation || '',
      pasteToClaudePrompt: s.pasteToClaudePrompt
        ? s.pasteToClaudePrompt.replace(/\\n/g, '\n') : null,
    }));

    return {
      suggestions,
      summary: `${suggestions.length} suggestions — ${suggestions.filter(s => s.impact === 'high').length} high impact, ${suggestions.filter(s => s.effort === 'quick').length} quick wins`,
    };

  } catch (err) {
    console.error('  ⚠️  Feature advisor API failed:', err.message);
    return { suggestions: _heuristicFallback(rawData, aggStats, anomalyReport, qa), summary: 'Heuristic suggestions (API unavailable)' };
  }
}

function _heuristicFallback(rawData, aggStats, anomalyReport, qa) {
  const suggestions = [];
  const totalGames  = qa.totalGamesRun || 1;

  for (const [key, count] of Object.entries(qa.mechanicUsage || {})) {
    const pct = count / totalGames * 100;
    if (pct < 10) suggestions.push({
      priority: suggestions.length + 1, category: 'ux',
      title: `Improve discoverability: ${key.replace(/_/g, ' ')}`,
      rationale: `Used in only ${pct.toFixed(1)}% of games.`,
      effort: 'quick', impact: 'medium',
      implementation: 'Add tooltip or visual indicator. Ensure AI logic considers this mechanic.',
      pasteToClaudePrompt: null,
    });
  }

  for (const [f, s] of Object.entries(aggStats)) {
    if (s.overallWinRate >= 60) suggestions.push({
      priority: suggestions.length + 1, category: 'balance',
      title: `Nerf ${f} (${s.overallWinRate}% win rate)`,
      rationale: `Win rate exceeds 55% threshold.`,
      effort: 'quick', impact: 'high',
      implementation: `Reduce ${f}'s primary economic or unit power advantage by 5–10%.`,
      pasteToClaudePrompt: null,
    });
    if (s.overallWinRate <= 42) suggestions.push({
      priority: suggestions.length + 1, category: 'balance',
      title: `Buff ${f} (${s.overallWinRate}% win rate)`,
      rationale: `Win rate below 45% concern threshold.`,
      effort: 'quick', impact: 'high',
      implementation: `Increase ${f}'s primary strength by 5–8%.`,
      pasteToClaudePrompt: null,
    });
  }

  return suggestions.slice(0, 10);
}

module.exports = { generateFeatureAdvice };