/**
 * feature-advisor.js — Beyond RTS Conquest Feature Advisor
 *
 * Generates genuinely exciting new feature ideas — not bug fixes or minor
 * tweaks, but the kind of additions that make you go "oh shit, that's good".
 *
 * Uses game-context.js so Claude knows exactly what already exists, avoiding
 * duplicate suggestions. Provides each feature as an individual Claude prompt
 * AND a combined mega-prompt so the user can pick and choose.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { injectContext } = require('./game-context');

async function generateFeatureAdvice(rawData, aggStats, anomalyReport, onlineReport, uiAuditResult, diagnosedBugs, cfg, gameContext) {
  const client = new Anthropic({ apiKey: cfg.anthropicApiKey });
  const { factions, qa } = rawData;
  const totalGames = qa.totalGamesRun || 0;

  // ── Data summaries (for context, NOT the focus) ─────────────────────────────
  const factionSummary = factions.map(f => {
    const s = aggStats[f]; if (!s) return '';
    const tier = s.overallWinRate >= 60 ? 'S' : s.overallWinRate >= 55 ? 'A'
               : s.overallWinRate >= 48 ? 'B' : s.overallWinRate >= 43 ? 'C' : 'D';
    return `  ${f.padEnd(14)} ${s.overallWinRate}% win (tier-${tier})  best vs ${s.bestMatchup?.faction}  worst vs ${s.worstMatchup?.faction}`;
  }).filter(Boolean).join('\n');

  const mechSummary = Object.entries(qa.mechanicUsage || {}).map(([k, v]) => {
    const pct = totalGames > 0 ? Math.round(v / totalGames * 100) : 0;
    return `  ${k.padEnd(28)} ${pct}%`;
  }).join('\n');

  const bugCount = diagnosedBugs.length;
  const anomalyCount = (anomalyReport?.anomalies || []).length;

  // ── Core prompt ─────────────────────────────────────────────────────────────
  const corePrompt = `You are a visionary game designer brainstorming NEW FEATURES for "Beyond RTS Conquest" — a browser-based 2D side-scroller RTS with 24 factions.

You have complete knowledge of the game above — every faction, unit, passive, upgrade, mechanic, and code logic. Use this to suggest features that SYNERGIZE with what exists, not duplicate it.

══ CURRENT STATE (${totalGames} AI vs AI games run) ══

FACTIONS & BALANCE:
${factionSummary || '  No balance data yet'}

MECHANICS IN USE:
${mechSummary || '  No mechanic data'}

GAME HEALTH: ${bugCount} bugs found, ${anomalyCount} anomalies detected

══ YOUR MISSION ══

Generate as many genuinely EXCITING new feature ideas as you can think of — quality over quantity, but don't hold back if you have more good ideas. These should be the kind of features that make the developer go "oh shit, I need to build this". Think big, think creative, think about what would make this game UNFORGETTABLE.

WHAT I WANT:
- Brand new game mechanics that don't exist yet
- New game modes that leverage the 24-faction system
- Innovative UI features that feel premium
- Social/competitive features that create emergent gameplay
- Clever systems that create "one more game" addiction
- Features that make the 24 factions feel even more distinct

WHAT I DON'T WANT:
- Bug fixes or patches to existing issues
- Minor balance tweaks (nerfs/buffs)
- Small QoL improvements that are obvious
- Features that already exist (check the game context carefully)
- Generic RTS suggestions — be specific to THIS game and its unique identity

For each feature, think about:
- How COOL would this feel to discover as a player?
- Does it create interesting decisions or just more complexity?
- Does it leverage the game's unique strengths (24 factions, side-scroller format, soul economy)?
- Would watching this in an AI vs AI match be entertaining?

EXCITEMENT RATINGS:
- 🔥🔥🔥 GAME-CHANGER — "This alone would make me tell friends about the game"
- 🔥🔥 AWESOME — "This would significantly elevate the experience"
- 🔥 COOL — "Nice addition that adds real depth"

Output ONLY a valid JSON array — no markdown fences, no preamble:

[
  {
    "priority": 1,
    "category": "mechanic|mode|ui|social|meta|economy|visual",
    "title": "Short punchy feature name",
    "pitch": "2-3 sentence elevator pitch. Sell me on WHY this is exciting. Be specific to the game — reference faction names, existing mechanics, the soul economy, etc.",
    "excitement": "game-changer|awesome|cool",
    "howItWorks": "3-5 sentences explaining the mechanic in detail. How does it interact with existing systems? What decisions does it create?",
    "factionSynergies": "Which of the 24 factions benefit most or interact interestingly with this feature? Be specific.",
    "effort": "quick|medium|large",
    "implementation": "Concrete steps referencing actual function names and variable names from the game context. Which files/functions to modify, what new state to add to G, etc.",
    "pasteToClaudePrompt": "Self-contained implementation request. Include: game is a single HTML file, vanilla JS + Canvas, ~20k lines. State the exact feature to add, which functions to modify (by name), what new state/logic is needed, and how it integrates with existing mechanics. End with 'Please implement this in index.html.' Max 1200 chars."
  }
]

Rules:
- Output ONLY the JSON array
- Include a mix of game-changers, awesome features, and quick wins — but only if each one genuinely deserves to be on the list
- Don't pad the list with filler — every suggestion should make the developer excited
- Reference specific faction names, mechanic names, and function names from the game context
- Do NOT suggest anything that already exists — check the mechanic list and faction context
- Each pasteToClaudePrompt must be fully self-contained (someone with no context should understand it)
- Think like a player who loves this game and wants it to be INCREDIBLE`;

  try {
    const fullPrompt = injectContext(corePrompt, gameContext, 'factions');
    const response = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 6000,
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

    if (!Array.isArray(suggestions) || suggestions.length === 0) {
      console.error('  ⚠️  Feature advisor: Claude returned no parseable suggestions, falling back to heuristics');
      console.error('  ⚠️  Raw response (first 300 chars):', rawText.slice(0, 300));
      const fallback = _heuristicFallback(rawData, aggStats, qa);
      return { suggestions: fallback, megaPrompt: _buildMegaPrompt(fallback), summary: `${fallback.length} heuristic features (API response was not parseable)` };
    }

    suggestions = suggestions.map((s, i) => ({
      priority:            s.priority || i + 1,
      category:            s.category || 'mechanic',
      title:               s.title || 'Unnamed feature',
      pitch:               s.pitch || s.rationale || '',
      excitement:          (s.excitement || 'cool').toLowerCase(),
      howItWorks:          s.howItWorks || '',
      factionSynergies:    s.factionSynergies || '',
      effort:              (s.effort || 'medium').toLowerCase(),
      implementation:      s.implementation || '',
      pasteToClaudePrompt: s.pasteToClaudePrompt
        ? s.pasteToClaudePrompt.replace(/\\n/g, '\n') : null,
    }));

    // Build combined mega-prompt
    const megaPrompt = _buildMegaPrompt(suggestions);

    return {
      suggestions,
      megaPrompt,
      summary: `${suggestions.length} features — ${suggestions.filter(s => s.excitement === 'game-changer').length} game-changers, ${suggestions.filter(s => s.effort === 'quick').length} quick wins`,
    };

  } catch (err) {
    console.error('  ⚠️  Feature advisor API failed:', err.message);
    const fallback = _heuristicFallback(rawData, aggStats, qa);
    return {
      suggestions: fallback,
      megaPrompt: _buildMegaPrompt(fallback),
      summary: `${fallback.length} heuristic features (API error: ${err.message.slice(0, 60)})`,
    };
  }
}

function _buildMegaPrompt(suggestions) {
  if (suggestions.length === 0) return null;
  const featureList = suggestions.map((s, i) =>
    `${i + 1}. **${s.title}** (${s.excitement})\n   ${s.howItWorks || s.pitch}`
  ).join('\n\n');

  return `I'm building "Beyond RTS Conquest" — a browser-based 2D side-scroller RTS game with 24 factions, built as a single HTML file (~20k lines, vanilla JS + Canvas).

I want to implement the following new features. Please implement them one at a time, starting with #1. For each feature, modify the existing code in index.html. The game uses a global G object for state, requestAnimationFrame game loop, and has functions like spawnUnit(), handleDeath(), doAttack(), updateUnits(), updateHUD(), drawGame().

FEATURES TO IMPLEMENT:

${featureList}

Please start with feature #1. After implementing each one, I'll confirm before moving to the next. For each feature:
- Add any new state to the initGame() function where G is initialised
- Add update logic to the game loop or a new update function wired into the loop
- Add any UI elements needed
- Make sure it integrates cleanly with existing mechanics

Let's begin with #1.`;
}

function _heuristicFallback(rawData, aggStats, qa) {
  // Even without API, suggest creative ideas based on game state
  const suggestions = [];
  const factionCount = rawData.factions?.length || 0;

  if (factionCount >= 10) {
    suggestions.push({
      priority: 1, category: 'mode', title: 'Faction Draft Mode with Bans',
      pitch: `With ${factionCount} factions, a draft system where each player bans 2-3 factions then picks from the remaining pool would add incredible strategic depth before the game even starts.`,
      excitement: 'game-changer', effort: 'medium',
      howItWorks: 'Pre-game phase: P1 bans, P2 bans, P1 picks, P2 picks. Banned factions greyed out with X overlay. Could have ranked draft and casual draft variants.',
      factionSynergies: 'Creates meta around "must-ban" factions and pocket picks. Factions with hard counters become more valuable.',
      implementation: 'Add draft state to G, new screen sc-draft, ban/pick phase logic, timer per pick.',
      pasteToClaudePrompt: null,
    });
  }

  suggestions.push({
    priority: 2, category: 'mechanic', title: 'Dynamic Weather System',
    pitch: 'Random weather events (sandstorm, rain, fog of war) that affect gameplay differently per faction — Glacial thrives in storms, Infernal weakened by rain.',
    excitement: 'awesome', effort: 'medium',
    howItWorks: 'Every 60-90s a weather event rolls. Each weather type applies global modifiers. Some factions get bonuses, others penalties. Visual overlay on canvas.',
    factionSynergies: 'Glacial: ice storm bonus. Infernal: weakened in rain. Umbral: fog of war amplified. Tideborn: rain gives regen boost.',
    implementation: 'Add G.weather state, updateWeather(dt) function, per-faction weather modifiers, canvas overlay rendering.',
    pasteToClaudePrompt: null,
  });

  suggestions.push({
    priority: 3, category: 'visual', title: 'Kill Replay Highlights',
    pitch: 'After game-over, show a "Top Plays" replay of the 3 most impactful moments — biggest multi-kill, closest base save, most souls earned in one fight.',
    excitement: 'awesome', effort: 'large',
    howItWorks: 'Record key events with timestamps during gameplay. Post-game, reconstruct and replay the top moments with slow-mo and zoom effects.',
    factionSynergies: 'Pandemonium chaos multi-kills, Tideborn split plays, Chrysalis metamorphosis moments would all look incredible.',
    implementation: 'Add event recording to G.replayLog, post-game replay renderer, highlight selection algorithm.',
    pasteToClaudePrompt: null,
  });

  suggestions.push({
    priority: 4, category: 'meta', title: 'Faction Mastery Prestige System',
    pitch: 'After maxing mastery on a faction, prestige it for a unique visual effect (golden units, special death animations) that carries across all modes.',
    excitement: 'cool', effort: 'medium',
    howItWorks: 'Track total wins per faction in localStorage. At milestones (10, 25, 50, 100 wins), unlock cosmetic tiers. Prestige resets mastery but grants permanent visual flair.',
    factionSynergies: 'All 24 factions get unique prestige visuals. Creates long-term progression and faction loyalty.',
    implementation: 'Add localStorage mastery tracking, prestige state, golden unit rendering variants, mastery UI screen.',
    pasteToClaudePrompt: null,
  });

  return suggestions;
}

module.exports = { generateFeatureAdvice };
