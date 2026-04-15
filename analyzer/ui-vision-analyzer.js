/**
 * ui-vision-analyzer.js
 * Sends UI screenshots to Claude's vision API for intelligent UX/UI analysis.
 * Finds layout problems, readability issues, usability concerns, and design
 * suggestions that programmatic DOM checks can't catch.
 *
 * COST OPTIMISATION: batches all screenshots from the same viewport into a
 * single multi-image API call. For 3 viewports × 18 screens this cuts the
 * number of API calls from ~54 down to ~3.
 */

const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');

// ── Screen descriptions (shared across prompts) ─────────────────────────────

const SCREEN_DESC = {
  'sc-game': `Main in-game screen during an AI vs AI match.
- Top: front line / momentum bar
- Center: canvas battlefield with units, bases, mid capture point
- Bottom: HUD with both players' panels (resources, unit cards, upgrades, buffs tabs)
- Utility buttons (mute, fullscreen, menu) in corners`,

  'sc-game-hud': `Close-up of the bottom HUD panel during gameplay.
- Player 1 (left) and Player 2 (right) panels
- Each has: health bar, souls/bodies resources, income rate, army count
- Tab system: UNITS / UPGRADES / BUFFS with card grids
- Unit stat panel on the far sides showing selected unit details`,

  'sc-game-upgrades': `Close-up of HUD with UPGRADES tab selected for Player 1. Shows upgrade cards with descriptions, costs, and effects.`,

  'sc-game-buffs': `Close-up of HUD with BUFFS tab selected for Player 1. Shows 3×3 grid of buff abilities (War Cry, Iron Wall, Body Boon, Soul Tide, Battle Trance, Mending Wave, Wrath Toll, Soul Spike, Last Rites) with cooldowns and costs.`,

  'sc-gameover': `Game-over / victory screen.
- Winner announcement with crown icon
- Match duration
- Detailed stats for both players (K/D, units spawned, damage, resources, unit breakdown)
- Action buttons (Rematch, Change Faction, Menu, View Mastery)`,

  'sc-gameover-stats': `Focused close-up of just the game-over stats panel, showing detailed per-player statistics.`,

  'sc-menu': `Main menu screen with all game mode buttons (Multiplayer, Online, Sudden Death, Conquest, Draft, Campaign, Singleplayer, Tournament, AI vs AI, Tutorial, Faction Mastery, Changelog).`,

  'sc-faction': `Faction selection screen where both players choose their faction. Shows 24 faction cards with icons, names, taglines, difficulty ratings, and pros/cons.`,

  'sc-draft': `Draft mode screen — ban/pick phase. Players alternate banning and picking factions. Banned factions are greyed out. Shows remaining picks and turn indicator.`,

  'sc-online': `Online multiplayer lobby screen. Shows create/join room interface with room codes, player names, and connection status via WebRTC.`,

  'sc-tournament-setup': `Tournament setup screen — configure single-elimination bracket. Select number of entrants, assign factions, and start the tournament.`,

  'sc-tournament-bracket': `Tournament bracket display — visual bracket UI showing matchups, completed results, and advancing winners with connecting lines.`,

  'sc-campaign': `Campaign map screen — vertical list of 24 faction nodes to battle through. Each node shows faction icon, name, and completion status. Has a back button, title, and preview panel for selected node.`,

  'sc-mastery': `Faction mastery book — 3D page-turn book UI. Each page shows a faction's mastery progress: XP bar, skill tree, perks unlocked. Navigation dots and prev/next buttons at bottom.`,

  'sc-tutorial': `Tutorial mode screen — guided introduction walkthrough for new players. Step-by-step panels explaining game mechanics, unit spawning, economy, buffs, upgrades, etc.`,

  'sc-controls': `Controls/keybind reference screen — shows keyboard shortcuts and control scheme for the game.`,

  'sc-game-horde': `Horde mode gameplay — defend-your-base mode with wave counter. P2 HUD is hidden. Shows current wave number, phase indicator, and incoming enemy wave.`,

  'sc-game-sudden': `Sudden Death mode gameplay — faster match variant with accelerated damage escalation and tighter economy.`,
};

// ── Build batched prompt for multiple screenshots in one viewport ─────────────

function buildBatchPrompt(screensInBatch, viewport) {
  const isMobile = viewport.width <= 768;
  const isTablet = viewport.width > 768 && viewport.width <= 1024;
  const sizeContext = isMobile ? 'MOBILE' : isTablet ? 'TABLET' : 'DESKTOP';

  const screenList = screensInBatch.map((ss, i) =>
    `IMAGE ${i + 1}: "${ss.screen}" (${ss.width}×${ss.height})\n${SCREEN_DESC[ss.screen] || 'Game UI screen.'}`
  ).join('\n\n');

  return `You are a senior UI/UX designer reviewing ${screensInBatch.length} screenshots from "Beyond RTS Conquest", a browser-based 2D side-scroller RTS game.

VIEWPORT: ${viewport.width}×${viewport.height} (${sizeContext}${isMobile ? ' — mobile viewport' : ''})

The images are provided in order:
${screenList}

━━ STRICT RULES FOR WHAT TO REPORT ━━

ONLY report issues that you can CLEARLY AND DIRECTLY SEE in the provided screenshots. Do NOT:
- Invent hypothetical problems that "might" exist on other screen sizes
- Flag things that look intentional or styled (dark theme, small fonts in information-dense UIs are intentional)
- Report more than 1-2 issues per screen — only the most impactful real problems
- Make up issues to fill a quota — it's BETTER to report 0 issues than to invent ones
- Flag low-contrast as an issue if the text is clearly legible in the screenshot
- Report "too much information" if the game UI is intentionally data-dense

DO report (only if clearly visible):
- Text that is genuinely cut off or overflows its container
- UI elements that visibly overlap and obscure each other
- Buttons/cards that are clearly broken or misaligned
- ${isMobile ? 'Touch targets that are visibly too small to tap reliably on mobile' : 'Layout breakage that makes the game unplayable'}
- Missing or clearly incorrect UI state

For each REAL issue found:
- Which screen it belongs to
- Where exactly in the screenshot (reference a quadrant: top-left, bottom-center, etc.)
- What is visibly wrong (describe exactly what you see)
- A concrete, specific fix

Rate: CRITICAL (broken/unusable right now), HIGH (significantly hurts gameplay), MEDIUM (noticeable annoyance), LOW (minor polish).

Output ONLY a valid JSON array — no markdown, no preamble:
[
  {
    "screen": "sc-game|sc-game-hud|sc-game-upgrades|sc-game-buffs|sc-gameover|sc-gameover-stats|sc-menu|sc-faction|sc-draft|sc-online|sc-tournament-setup|sc-tournament-bracket|sc-campaign|sc-mastery|sc-tutorial|sc-controls|sc-game-horde|sc-game-sudden",
    "severity": "CRITICAL|HIGH|MEDIUM|LOW",
    "category": "layout|readability|usability|overflow|design${isMobile ? '|mobile' : ''}",
    "location": "where in the screenshot",
    "issue": "what you can clearly see is wrong",
    "why": "why this breaks the experience",
    "suggestion": "specific fix with concrete values where possible",
    "element_hint": "CSS selector or element name if identifiable"
  }
]

If everything looks fine in the screenshots, return an empty array: []
Aim for ${isMobile ? '3-8' : '2-5'} total real issues across all ${screensInBatch.length} screenshots.
Quality over quantity — only report what you can actually see is broken.`;
}

// ── Main export ────────────────────────────────────────────────────────────────

async function analyzeScreenshotsWithVision(screenshots, cfg) {
  if (!cfg.anthropicApiKey) {
    return { analyses: [], error: 'No API key — vision analysis skipped' };
  }

  const client = new Anthropic({ apiKey: cfg.anthropicApiKey });

  // Group screenshots by viewport for batched API calls
  const byViewport = {};
  for (const ss of screenshots) {
    if (!ss.path || !fs.existsSync(ss.path)) continue;
    const key = ss.viewport;
    (byViewport[key] = byViewport[key] || []).push(ss);
  }

  // Sort viewports: mobile first, then tablet, then desktop
  const vpEntries = Object.entries(byViewport).sort(([, a], [, b]) => {
    const aW = a[0]?.width || 9999;
    const bW = b[0]?.width || 9999;
    return aW - bW;
  });

  const analyses = [];

  for (const [, vpScreenshots] of vpEntries) {
    const vp = { width: vpScreenshots[0].width, height: vpScreenshots[0].height };

    // Build multi-image content blocks
    const contentBlocks = [];
    for (const ss of vpScreenshots) {
      try {
        const imageData = fs.readFileSync(ss.path).toString('base64');
        contentBlocks.push({
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: imageData },
        });
      } catch (_) {
        // Skip unreadable files
      }
    }

    if (contentBlocks.length === 0) continue;

    // Add the text prompt after all images
    const prompt = buildBatchPrompt(vpScreenshots, vp);
    contentBlocks.push({ type: 'text', text: prompt });

    try {
      const response = await client.messages.create({
        model: 'claude-sonnet-4-6', // Sonnet has far better vision accuracy — fewer false positives
        max_tokens: 2000,
        messages: [{ role: 'user', content: contentBlocks }],
      });

      const rawText = response.content.filter(b => b.type === 'text').map(b => b.text).join('');

      let issues = [];
      try {
        issues = JSON.parse(rawText.replace(/```json|```/g, '').trim());
      } catch (_) {
        const match = rawText.match(/\[[\s\S]+\]/);
        try { issues = match ? JSON.parse(match[0]) : []; } catch (_) { issues = []; }
      }

      if (!Array.isArray(issues)) issues = [];

      // Distribute issues to per-screen analysis entries
      const issuesByScreen = {};
      for (const issue of issues) {
        const screen = issue.screen || vpScreenshots[0].screen;
        (issuesByScreen[screen] = issuesByScreen[screen] || []).push(issue);
      }

      for (const ss of vpScreenshots) {
        analyses.push({
          screen: ss.screen,
          viewport: ss.viewport,
          width: ss.width,
          height: ss.height,
          issues: issuesByScreen[ss.screen] || [],
          screenshotPath: ss.path,
        });
      }

    } catch (err) {
      // On error, still record entries for each screen
      for (const ss of vpScreenshots) {
        analyses.push({
          screen: ss.screen,
          viewport: ss.viewport,
          width: ss.width,
          height: ss.height,
          issues: [],
          error: err.message,
          screenshotPath: ss.path,
        });
      }
    }
  }

  // Summary stats
  const totalIssues = analyses.reduce((sum, a) => sum + a.issues.length, 0);

  return {
    analyses,
    summary: {
      screensAnalyzed: analyses.length,
      totalIssues,
      critical: analyses.reduce((sum, a) => sum + a.issues.filter(i => i.severity === 'CRITICAL').length, 0),
      high: analyses.reduce((sum, a) => sum + a.issues.filter(i => i.severity === 'HIGH').length, 0),
      medium: analyses.reduce((sum, a) => sum + a.issues.filter(i => i.severity === 'MEDIUM').length, 0),
      low: analyses.reduce((sum, a) => sum + a.issues.filter(i => i.severity === 'LOW').length, 0),
    },
  };
}

module.exports = { analyzeScreenshotsWithVision };
