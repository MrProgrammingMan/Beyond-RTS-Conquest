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
  const existingFeatures = `
FEATURES THAT ALREADY EXIST (DO NOT SUGGEST THESE OR VARIATIONS OF THESE):
- Draft Mode: full ban/pick phase with P1 bans → P2 bans → P1 picks → P2 picks, greyed-out banned factions
- Random Events system: Blood Moon (halved body costs), Arcane Surge (40% soul discount), Time Warp (+80% speed), Dark Eclipse (doubled desperation income) — rolls every 40-70s with visual overlays
- Faction Mastery system: full skill tree per faction with XP, mastery perks, mastery flags that modify gameplay (fortifyDmgReduce, skyBountyAmt, chainRate, etc.)
- Upgrade Tree: 7-node skill tree per faction purchased during gameplay with souls/bodies
- Buff system: War Cry, Iron Wall, Blitz, Soul Tide, Conquest Shield — unlocked at 60s, cooldown-based
- Spy system: deploy spies to reveal enemy info
- Rogue Events: Treasure Courier and Arena Champion that spawn mid-map
- Mid-zone control: capture the center for income bonuses
- Desperation income: losing player gets accelerating passive income
- Kill streaks: every 10 kills triggers a Wild Card (free surprise unit from another faction)
- Kill feed: scrolling combat log with faction icons
- Veteran system: units with 5+ kills or 3 retreats become veterans with visual star
- Worker scaling: worker body cost increases with count
- Chat/taunt system: faction-specific voice lines and taunts
- Online multiplayer: WebRTC-based P2P with lobby system
- AI personalities: 16 different AI playstyles (aggressive, defensive, swarm, economist, etc.)
- Post-game stats: detailed breakdown with damage dealt, souls earned, unit efficiency
- Tutorial mode: guided introduction for new players
- Faction select with lore, pros/cons, matchup tips, and difficulty ratings
- Sound effects and music system
- Base castle themes per faction with unique visual styles
- Damage escalation: global damage multiplier that increases over time to prevent stalemates`;

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
- Features that already exist — CHECK THE LIST ABOVE. Draft mode, random events/weather, mastery/prestige, buffs, spies, rogue events, kill streaks, veteran system, etc. ALL EXIST ALREADY
- Generic RTS suggestions — be specific to THIS game and its unique identity
- Variations of existing features disguised as new ones (e.g. "weather system" = random events, "progression system" = mastery tree)

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
    const fullPrompt = injectContext(corePrompt, gameContext, 'compact');
    const response = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 4000,
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
  // Fallback ideas when API fails.
  // ╔═══════════════════════════════════════════════════════════════════╗
  // ║ ALREADY EXISTS — DO NOT SUGGEST:                                 ║
  // ║  Draft mode, random events/weather, mastery/prestige system,     ║
  // ║  buffs (warcry/ironwall/blitz/soul tide/conquest shield),        ║
  // ║  spies, rogue events, kill streaks, wild card, veteran system,   ║
  // ║  chat/taunts, online multiplayer, AI personalities, post-game    ║
  // ║  stats, tutorial, kill feed, desperation income, mid control,    ║
  // ║  upgrade tree, worker scaling, damage escalation, sound/music,   ║
  // ║  base castle themes, faction lore/matchup tips                   ║
  // ╚═══════════════════════════════════════════════════════════════════╝
  const suggestions = [];
  const factionCount = rawData.factions?.length || 0;

  suggestions.push({
    priority: 1, category: 'mode', title: 'Tournament Bracket Mode',
    pitch: `With ${factionCount} factions, run an automated single-elimination tournament — 8 or 16 AI factions fight bracket-style with a live bracket UI showing results as they unfold.`,
    excitement: 'game-changer', effort: 'large',
    howItWorks: 'Player selects 8 or 16 factions for a bracket. Games auto-run in sequence with a visual bracket that fills in winners. Optional: player controls one faction throughout. Final shows winner with fanfare.',
    factionSynergies: 'All factions participate. Reveals true tier lists through elimination. Creates narratives — underdog runs, dominant sweeps.',
    implementation: 'Add tournament state to G, bracket generation, auto-advance between rounds, bracket UI screen with match results.',
    pasteToClaudePrompt: null,
  });

  suggestions.push({
    priority: 2, category: 'mechanic', title: 'Faction Fusion — Dual Faction Hybrid',
    pitch: 'Pick two factions and get a merged roster — 3 units from each plus a unique fusion passive. Creates hundreds of possible combinations from 24 factions.',
    excitement: 'game-changer', effort: 'large',
    howItWorks: 'In faction select, pick a primary and secondary faction. Primary contributes 3 units + its passive, secondary contributes 3 units. A fusion bonus is generated based on the pair (e.g., Infernal+Glacial = units leave fire/ice zones on death).',
    factionSynergies: 'Every faction pair creates a unique playstyle. Infernal+Reavers: corpses burn. Merchants+Fortune: double economy RNG. Umbral+Illusionists: invisible decoys.',
    implementation: 'Add fusion select UI after faction pick, roster merge logic in initGame(), fusion passive lookup table, adjusted balance for hybrid rosters.',
    pasteToClaudePrompt: null,
  });

  suggestions.push({
    priority: 3, category: 'mode', title: 'Survival / Horde Mode',
    pitch: `Defend your base against infinite AI waves that escalate in difficulty. See how long you can last with your chosen faction — leaderboard tracks best survival times per faction.`,
    excitement: 'awesome', effort: 'medium',
    howItWorks: 'Player picks a faction and faces auto-spawning enemy waves from random factions. Each wave is stronger (more units, higher tier). Between waves, earn bonus souls to upgrade. Tracks best time in localStorage.',
    factionSynergies: 'Menders excel with retreat-heal sustain. Summoners snowball with shades. Glacial slows entire waves. Brutes fortify and tank. Each faction creates a different survival strategy.',
    implementation: 'Add survival mode state to G, wave spawner with escalating difficulty, between-wave upgrade shop, localStorage leaderboard.',
    pasteToClaudePrompt: null,
  });

  suggestions.push({
    priority: 4, category: 'mechanic', title: 'Unit Promotion & Naming',
    pitch: 'Units that survive long enough or get 5+ kills earn a unique name and stat boost. Named units show a mini-portrait in the HUD and are tracked across the match.',
    excitement: 'cool', effort: 'medium',
    howItWorks: 'When a unit hits kill thresholds (5, 10, 15), it earns a randomly generated name (e.g. "Grimjaw the Relentless"), visual crown/glow, and cumulative stat bonuses. A sidebar tracks your named heroes. Losing a named unit triggers a dramatic death animation and kill feed entry.',
    factionSynergies: 'Wolfborn Dire Wolf with growOnKill stacks becomes legendary. Mender Veterans with multiple retreats earn names fastest. Chrysalis adults that survive metamorphosis feel heroic.',
    implementation: 'Add name generation table, promotion check in updateUnits, named unit HUD panel, enhanced death handling for promoted units.',
    pasteToClaudePrompt: null,
  });

  return suggestions;
}

module.exports = { generateFeatureAdvice };
