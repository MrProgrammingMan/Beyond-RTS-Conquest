/**
 * ui-vision-analyzer.js
 * Sends UI screenshots to Claude's vision API for intelligent UX/UI analysis.
 * Finds layout problems, readability issues, usability concerns, and design
 * suggestions that programmatic DOM checks can't catch.
 *
 * COST OPTIMISATION: batches all screenshots from the same viewport into a
 * single multi-image API call. For 3 viewports × 8 screens this cuts the
 * number of API calls from ~24 down to ~3.
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

  'sc-game-buffs': `Close-up of HUD with BUFFS tab selected for Player 1. Shows buff abilities with cooldowns and descriptions.`,

  'sc-gameover': `Game-over / victory screen.
- Winner announcement with crown icon
- Match duration
- Detailed stats for both players (K/D, units spawned, damage, resources, unit breakdown)
- Action buttons (Rematch, Change Faction, Menu, View Mastery)`,

  'sc-gameover-stats': `Focused close-up of just the game-over stats panel, showing detailed per-player statistics.`,

  'sc-menu': `Main menu screen with all game mode buttons (Multiplayer, Online, Sudden Death, Conquest, Draft, Campaign, Singleplayer, Tournament, AI vs AI, Tutorial, Faction Mastery, Changelog).`,

  'sc-faction': `Faction selection screen where both players choose their faction. Shows faction cards with descriptions, pros/cons, and unit previews.`,
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

VIEWPORT: ${viewport.width}×${viewport.height} (${sizeContext}${isMobile ? ' — this is the most critical viewport to get right' : ''})

The images are provided in order. Here is what each shows:

${screenList}

Analyse ALL screenshots and find SPECIFIC, ACTIONABLE issues. Focus on:

1. **LAYOUT PROBLEMS** — Elements overlapping, cut off, or pushed offscreen. Text truncated. Cards too cramped.
2. **READABILITY** — Text too small to read, poor contrast, information density too high for this viewport size.
3. **USABILITY** — Controls too small to tap (mobile), important info hidden or hard to find, confusing layout.
4. **WASTED SPACE** — Areas with too much empty space while other areas are cramped. Unbalanced layout.
5. **DESIGN ISSUES** — Elements that don't belong on this screen, UI that could confuse players, visual clutter.
${isMobile ? `6. **MOBILE-SPECIFIC** — Touch targets too small, text unreadable at phone distance, horizontal overflow, elements that should stack vertically but don't.` : ''}

For EACH issue found, provide:
- Which image/screen it belongs to
- A clear description of what's wrong and WHERE (reference position: top-left, bottom-right, center, etc.)
- WHY it's a problem (especially for ${sizeContext} users)
- A specific suggestion to fix it (with concrete values: "reduce font from 14px to 11px", "hide P2 panel on mobile", etc.)

Rate each issue: CRITICAL (broken/unusable), HIGH (significantly hurts UX), MEDIUM (noticeable but workable), LOW (polish/nice-to-have).

Output ONLY a valid JSON array — no markdown fences, no preamble:
[
  {
    "screen": "sc-game|sc-game-hud|sc-game-upgrades|sc-game-buffs|sc-gameover|sc-gameover-stats|sc-menu|sc-faction",
    "severity": "CRITICAL|HIGH|MEDIUM|LOW",
    "category": "layout|readability|usability|wasted_space|design|mobile",
    "location": "where in the screenshot (e.g. 'bottom-left HUD panel', 'top center mid indicator')",
    "issue": "clear description of the problem",
    "why": "why this matters for the user",
    "suggestion": "specific actionable fix with concrete values",
    "element_hint": "CSS selector or element name if identifiable (e.g. '#p1-hud .res-row', '.go-stats')"
  }
]

Rules:
- Output ONLY the JSON array
- Be specific — don't say "some text is small", say which text and where
- Give concrete fix values — don't say "make it bigger", say "increase to 16px" or "use clamp(12px, 2vw, 16px)"
- If a screen looks good, just don't include issues for it
- Aim for ${isMobile ? '8-15' : '5-10'} total issues across all ${screensInBatch.length} screenshots — focus on the most impactful
- ${isMobile ? 'Mobile is the HIGHEST priority — be thorough and strict' : 'Desktop has more room, so focus on major issues only'}`;
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
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
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
