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

  // ── Existing features list (prevents duplicate suggestions) ────────────────
  const existingFeatures = `ALREADY EXISTS — DO NOT SUGGEST OR REFRAME:
Draft mode, random events (Blood Moon/Arcane Surge/Time Warp/Dark Eclipse), faction mastery skill tree, upgrade tree (7 nodes/faction), 9 rally buffs (War Cry/Iron Wall/Body Boon/Soul Tide/Battle Trance/Mending Wave/Wrath Toll/Soul Spike/Last Rites), spy system, rogue events (Treasure Courier/Arena Champion), mid-zone control, desperation income, kill streaks + wild card, kill feed, veteran system + unit naming/promotion, worker scaling, chat/taunts, online multiplayer (WebRTC), 16 AI personalities, post-game stats, tutorial mode, faction lore + matchup tips, sound/music system (calm/battle/intense/victory), base castle themes, damage escalation, tournament bracket mode, horde mode (10 waves).`;

  // ── Core prompt ─────────────────────────────────────────────────────────────
  const corePrompt = `You are a visionary game designer brainstorming NEW FEATURES for "Beyond RTS Conquest" — a browser-based 2D side-scroller RTS with 24 factions.

You have complete knowledge of the game above — every faction, unit, passive, upgrade, mechanic, and code logic. Use this to suggest features that SYNERGIZE with what exists, not duplicate it.

══ CURRENT STATE (${totalGames} AI vs AI games run) ══

FACTIONS & BALANCE:
${factionSummary || '  No balance data yet'}

MECHANICS IN USE:
${mechSummary || '  No mechanic data'}

GAME HEALTH: ${bugCount} bugs found, ${anomalyCount} anomalies detected
${existingFeatures}

══ YOUR MISSION ══

Generate the 5–7 best new feature ideas — the ones that make the developer go "I need to build this." Quality over quantity; don't pad.

WANT: genuinely new mechanics, modes, social/competitive features, "one more game" hooks. Must leverage the game's strengths: 24 factions, side-scroller format, soul+body economy.
DON'T WANT: bug fixes, balance tweaks, minor QoL, anything already listed above, generic RTS suggestions not specific to this game.

EXCITEMENT RATINGS:
- game-changer: "This alone would make me tell friends about the game"
- awesome: "This significantly elevates the experience"
- cool: "Nice addition that adds real depth"

Output ONLY a valid JSON array — no markdown fences, no preamble:

[
  {
    "priority": 1,
    "category": "mechanic|mode|ui|social|meta|economy|visual",
    "title": "Short punchy feature name",
    "pitch": "2–3 sentences. Sell the WHY — be specific to this game, reference factions/mechanics by name.",
    "excitement": "game-changer|awesome|cool",
    "howItWorks": "4–5 sentences. Explain the mechanic in full detail. How does it interact with existing systems (upgrade tree, soul economy, faction passives)? What decisions does it create?",
    "factionSynergies": "2–3 sentences. Which factions benefit most or create the most interesting interactions? Be specific — name them.",
    "effort": "quick|medium|large",
    "implementation": "3–4 sentences. Reference actual function names (spawnUnit, handleDeath, doAttack, updateUnits, applyUpgrade, etc.), what new state to add to G, and which screens/loops to modify.",
    "pasteToClaudePrompt": "Self-contained implementation prompt ≤700 chars. Must include: game is a single HTML file, vanilla JS + Canvas, ~20k lines. State the exact feature, which functions to modify by name, what new G state is needed, and how it integrates with existing mechanics. End with 'Please implement this in index.html.'"
  }
]

Rules:
- Output ONLY the JSON array — 5 to 7 entries
- Every suggestion must be something genuinely new — check the existing list above
- Reference specific faction names, mechanic names, and function names
- Think like a player who loves this game and wants it to be INCREDIBLE`;

  try {
    const fullPrompt = injectContext(corePrompt, gameContext, 'compact');
    const response = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 6000,
      messages:   [{ role: 'user', content: fullPrompt }],
    });

    const rawText = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
    let suggestions = [];

    // Try 1: clean parse
    try {
      suggestions = JSON.parse(rawText.replace(/```json|```/g, '').trim());
    } catch (_) {}

    // Try 2: extract [...] block
    if (!Array.isArray(suggestions) || suggestions.length === 0) {
      const m = rawText.match(/\[[\s\S]+\]/);
      if (m) try { suggestions = JSON.parse(m[0]); } catch (_) {}
    }

    // Try 3: truncated JSON salvage — close off the last complete object and the array
    if (!Array.isArray(suggestions) || suggestions.length === 0) {
      const start = rawText.indexOf('[');
      if (start !== -1) {
        let partial = rawText.slice(start);
        // Find the last complete object (ends with `}`) before truncation
        const lastClose = partial.lastIndexOf('}');
        if (lastClose !== -1) {
          partial = partial.slice(0, lastClose + 1) + ']';
          try { suggestions = JSON.parse(partial); } catch (_) {}
        }
      }
    }

    if (!Array.isArray(suggestions) || suggestions.length === 0) {
      console.error('  ⚠️  Feature advisor: Claude returned no parseable suggestions, falling back to heuristics');
      console.error('  ⚠️  Raw response (first 500 chars):', rawText.slice(0, 500));
      console.error('  ⚠️  stop_reason:', response.stop_reason);
      const fallback = _heuristicFallback(rawData, aggStats, qa);
      return { suggestions: fallback, megaPrompt: _buildMegaPrompt(fallback), summary: `${fallback.length} heuristic features (API response was not parseable)` };
    }

    if (response.stop_reason === 'max_tokens') {
      console.warn(`  ⚠️  Feature advisor: response was truncated — only ${suggestions.length} suggestions recovered. Partial results used.`);
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
  // Fallback ideas when API fails.
  // ╔══════════════════════════════════════════════════════════════════════╗
  // ║ ALREADY EXISTS — DO NOT SUGGEST:                                    ║
  // ║  Draft mode, random events/weather, mastery/prestige system,        ║
  // ║  buffs (9 rally buffs: warcry/ironwall/bodyboon/soul tide/          ║
  // ║  battle trance/mending wave/wrath toll/soul spike/last rites),     ║
  // ║  spies, rogue events, kill streaks, wild card, veteran system,      ║
  // ║  chat/taunts, online multiplayer, AI personalities, post-game       ║
  // ║  stats, tutorial, kill feed, desperation income, mid control,       ║
  // ║  upgrade tree, worker scaling, damage escalation, sound/music,      ║
  // ║  base castle themes, faction lore/matchup tips, horde mode,         ║
  // ║  unit promotion & naming, file-based adaptive music                 ║
  // ╚══════════════════════════════════════════════════════════════════════╝
  const suggestions = [];

  suggestions.push({
    priority: 1, category: 'mechanic', title: 'Faction Fusion — Dual Faction Hybrid',
    pitch: 'Pick two factions and get a merged roster — 3 units from each plus a unique fusion passive. Creates hundreds of possible combinations from 24 factions.',
    excitement: 'game-changer', effort: 'large',
    howItWorks: 'In faction select, pick a primary and secondary faction. Primary contributes 3 units + its passive, secondary contributes 3 units. A fusion bonus is generated based on the pair (e.g., Infernal+Glacial = units leave fire/ice zones on death). Faction select UI adds a second pick step; initGame() merges the rosters.',
    factionSynergies: 'Every faction pair creates a unique playstyle. Infernal+Reavers: corpses burn. Merchants+Fortune: double economy RNG. Umbral+Illusionists: invisible decoys in darkness.',
    implementation: 'Add fusion select UI after faction pick, roster merge logic in initGame(), fusion passive lookup table, adjusted balance for hybrid rosters.',
    pasteToClaudePrompt: null,
  });

  suggestions.push({
    priority: 2, category: 'social', title: 'Replay System — Watch & Share Matches',
    pitch: 'Record match inputs and replay them deterministically. Share replays via a URL code. Players can scrub through the timeline and see exactly what decisions won or lost the game.',
    excitement: 'game-changer', effort: 'large',
    howItWorks: 'Each frame: log player spend events (unit bought, upgrade purchased) keyed to G.elapsed. On replay, feed these events back into the normal game loop with a fixed RNG seed. Export as a compact JSON, encode to base64 URL param.',
    factionSynergies: 'Replays make learning faction matchups educational. Chronomancers replays show rewinds. Pandemonium replays show chaos routing.',
    implementation: 'Add G._replayLog array, record events in spawnUnit/applyUpgrade/useBuff, add replay playback mode that feeds stored events back to the game loop at matching elapsed times.',
    pasteToClaudePrompt: null,
  });

  suggestions.push({
    priority: 3, category: 'mode', title: 'Daily Challenge — Fixed Seed Leaderboard',
    pitch: 'Same matchup, same RNG seed, same event roll for everyone each day. One attempt per player. Global leaderboard tracks fastest win. Creates shared conversation ("did you beat today\'s challenge?").',
    excitement: 'awesome', effort: 'medium',
    howItWorks: 'Date-based seed determines: faction matchup, which random events fire, rogue unit timing. localStorage stores today\'s result and best time. A lightweight server endpoint (or even a static JSON) publishes the daily seed.',
    factionSynergies: 'Daily matchups rotate through all 24 factions, forcing players to learn unfamiliar factions.',
    implementation: 'Add daily seed derivation from Date, seeded PRNG replacing Math.random() for event rolls, localStorage result storage, leaderboard fetch from server endpoint.',
    pasteToClaudePrompt: null,
  });

  return suggestions;
}

module.exports = { generateFeatureAdvice };
