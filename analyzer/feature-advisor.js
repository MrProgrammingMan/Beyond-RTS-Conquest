/**
 * feature-advisor.js — Beyond RTS Conquest Feature Advisor
 *
 * Sends the full QA run summary to Claude and asks it to produce
 * prioritized, concrete feature suggestions based on:
 *   - Which mechanics are underused (potential discoverability fixes)
 *   - Which factions are imbalanced (new mechanics to differentiate them)
 *   - What bugs indicate missing guard rails (UX improvements)
 *   - What anomalies reveal (missing game feel polish)
 *   - General RTS design best practices
 *
 * Output: Structured suggestions with effort estimates, impact scores,
 * and paste-to-Claude implementation prompts for each suggestion.
 */

const Anthropic = require('@anthropic-ai/sdk');

async function generateFeatureAdvice(rawData, aggStats, anomalyReport, onlineReport, uiAuditResult, diagnosedBugs, cfg) {
  const client = new Anthropic({ apiKey: cfg.anthropicApiKey });

  const { factions, qa } = rawData;
  const totalGames = qa.totalGamesRun || 0;

  // ── Build context summary ─────────────────────────────────────────────────
  const factionSummary = factions.map(f => {
    const s = aggStats[f];
    if (!s) return '';
    const tier = s.overallWinRate >= 60 ? 'S' : s.overallWinRate >= 55 ? 'A' : s.overallWinRate >= 48 ? 'B' : s.overallWinRate >= 43 ? 'C' : 'D';
    return `  ${f.padEnd(12)} ${s.overallWinRate}% win  tier-${tier}  avg ${Math.floor(s.avgGameDuration/60)}m${s.avgGameDuration%60}s`;
  }).filter(Boolean).join('\n');

  const mechSummary = Object.entries(qa.mechanicUsage || {}).map(([k, v]) => {
    const pct = totalGames > 0 ? Math.round(v / totalGames * 100) : 0;
    const flag = pct < 15 ? '⚠️ underused' : pct === 0 ? '❌ BROKEN?' : '';
    return `  ${k.padEnd(28)} ${pct}%  (${v}×) ${flag}`;
  }).join('\n');

  const bugSummary = diagnosedBugs.length === 0 ? '  None' :
    diagnosedBugs.slice(0, 6).map(b =>
      `  [${(b.diagnosis?.severity || 'MEDIUM').toUpperCase()}] ${b.type}: ${(b.message || '').slice(0, 80)}`
    ).join('\n');

  const anomalySummary = (anomalyReport?.anomalies || []).length === 0 ? '  None' :
    anomalyReport.anomalies.slice(0, 6).map(a =>
      `  [${a.severity}] ${a.title}: ${a.detail.slice(0, 100)}`
    ).join('\n');

  const uiSummary = (uiAuditResult?.issues || []).length === 0 ? '  No UI issues' :
    `  ${uiAuditResult.issues.filter(i => i.severity === 'error').length} errors, ` +
    `${uiAuditResult.issues.filter(i => i.severity === 'warning').length} warnings`;

  const onlineSummary = onlineReport
    ? `  Overall grade: ${onlineReport.overallGrade}\n  ${onlineReport.summary}\n` +
      (onlineReport.issues || []).slice(0, 3).map(i => `  [${i.severity}] ${i.message.slice(0, 80)}`).join('\n')
    : '  Not run';

  const prompt = `You are a senior game designer reviewing a complete automated QA report for "Beyond RTS Conquest" — a two-player browser RTS (single-file HTML, ~15,000 lines of vanilla JS/Canvas).

## GAME SUMMARY
- 2-player base defense RTS, played online or local
- 10 factions: warriors, summoners, brutes, spirits, verdant, infernal, glacial, voltborn, bloodpact, menders
- Mechanics: soul/body economy, mid capture, spies, upgrades, unit buffs, last stand, siege damage, worker to mid, aerial units
- Modes: vs (local), aivsai, online, draft, conquest, sudden_death, tournament
- ${totalGames} AI vs AI games were run in this QA cycle

## FACTION BALANCE (${totalGames} games)
${factionSummary || '  No data'}

## MECHANIC USAGE
${mechSummary || '  No data'}

## BUGS FOUND
${bugSummary}

## BEHAVIORAL ANOMALIES
${anomalySummary}

## UI ISSUES
${uiSummary}

## ONLINE SYNC
${onlineSummary}

---

Based on this QA data, generate a prioritized list of feature suggestions and improvements. Focus on:

1. **Quick wins** — small changes (< 1 day) with high impact
2. **Core improvements** — medium features (1–3 days) that address real QA findings
3. **Stretch goals** — larger features (3–7 days) that would meaningfully improve retention/depth

For each suggestion:
- Be concrete and specific to THIS game's codebase and mechanics
- Reference the QA data that motivated the suggestion
- Prioritize issues that affect player experience, not just aesthetics

Output ONLY a JSON array (no markdown, no preamble):

[
  {
    "priority": 1,
    "category": "gameplay|ux|balance|online|performance|polish",
    "title": "Short feature title",
    "rationale": "1-2 sentences explaining why QA data motivated this (cite specific metrics)",
    "effort": "quick|medium|large",
    "impact": "high|medium|low",
    "implementation": "Concrete steps to implement. Reference specific functions/variables from the game context. 2-4 sentences.",
    "pasteToClaudePrompt": "Self-contained implementation request for a coding Claude. Include: the game is a single-file HTML RTS (index.html ~15k lines, vanilla JS + Canvas). Describe exactly what to build and where. End with 'Please implement this in index.html.' Max 900 chars. Escape newlines as \\n."
  }
]

Generate 8–12 suggestions. Start with the most impactful.`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
    });

    const rawText = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
    let suggestions = [];
    try {
      const clean = rawText.replace(/```json|```/g, '').trim();
      suggestions = JSON.parse(clean);
    } catch (_) {
      const m = rawText.match(/\[[\s\S]+\]/);
      if (m) try { suggestions = JSON.parse(m[0]); } catch (_) {}
    }

    // Normalize
    suggestions = (Array.isArray(suggestions) ? suggestions : []).map((s, i) => ({
      priority: s.priority || i + 1,
      category: s.category || 'gameplay',
      title: s.title || 'Unnamed suggestion',
      rationale: s.rationale || '',
      effort: (s.effort || 'medium').toLowerCase(),
      impact: (s.impact || 'medium').toLowerCase(),
      implementation: s.implementation || '',
      pasteToClaudePrompt: s.pasteToClaudePrompt ? s.pasteToClaudePrompt.replace(/\\n/g, '\n') : null,
    }));

    return {
      suggestions,
      summary: `${suggestions.length} suggestions — ${suggestions.filter(s=>s.impact==='high').length} high impact, ${suggestions.filter(s=>s.effort==='quick').length} quick wins`,
    };
  } catch (err) {
    console.error('  ⚠️  Feature advisor API failed:', err.message);
    // Return heuristic fallback suggestions based on raw data
    return {
      suggestions: _heuristicFallback(rawData, aggStats, anomalyReport, qa),
      summary: 'Heuristic suggestions (no API key)',
    };
  }
}

// Fallback when no API key: pure heuristic suggestions ────────────────────────
function _heuristicFallback(rawData, aggStats, anomalyReport, qa) {
  const suggestions = [];
  const totalGames = qa.totalGamesRun || 1;

  // Underused mechanics
  for (const [key, count] of Object.entries(qa.mechanicUsage || {})) {
    const pct = count / totalGames * 100;
    if (pct < 10) {
      suggestions.push({
        priority: suggestions.length + 1,
        category: 'ux',
        title: `Improve discoverability of: ${key.replace(/_/g, ' ')}`,
        rationale: `Used in only ${pct.toFixed(1)}% of games — players/AI may not be discovering it.`,
        effort: 'quick',
        impact: 'medium',
        implementation: `Add a brief tutorial tooltip or visual indicator when this mechanic becomes available. Ensure AI decision logic includes a cost-benefit evaluation for this mechanic.`,
        pasteToClaudePrompt: null,
      });
    }
  }

  // Imbalanced factions
  for (const [f, s] of Object.entries(aggStats)) {
    if (s.overallWinRate >= 60) {
      suggestions.push({
        priority: suggestions.length + 1,
        category: 'balance',
        title: `Nerf ${f} (${s.overallWinRate}% win rate)`,
        rationale: `Win rate of ${s.overallWinRate}% exceeds the 55% threshold for concern.`,
        effort: 'quick',
        impact: 'high',
        implementation: `Reduce ${f}'s primary economic advantage or unit power by 5–10%. Test against its worst matchup (${s.worstMatchup.faction}) first.`,
        pasteToClaudePrompt: null,
      });
    }
    if (s.overallWinRate <= 42) {
      suggestions.push({
        priority: suggestions.length + 1,
        category: 'balance',
        title: `Buff ${f} (${s.overallWinRate}% win rate)`,
        rationale: `Win rate of ${s.overallWinRate}% is below the 45% concern threshold.`,
        effort: 'quick',
        impact: 'high',
        implementation: `Increase ${f}'s primary strength by 5–8%. Focus on its worst matchup (${s.worstMatchup.faction}) specifically.`,
        pasteToClaudePrompt: null,
      });
    }
  }

  // Anomalies → suggestions
  for (const a of (anomalyReport?.anomalies || []).slice(0, 3)) {
    if (a.severity === 'HIGH') {
      suggestions.push({
        priority: suggestions.length + 1,
        category: 'gameplay',
        title: `Fix: ${a.title}`,
        rationale: a.detail,
        effort: 'medium',
        impact: 'high',
        implementation: a.suggestion || '',
        pasteToClaudePrompt: a.prompt || null,
      });
    }
  }

  return suggestions.slice(0, 10);
}

module.exports = { generateFeatureAdvice };
