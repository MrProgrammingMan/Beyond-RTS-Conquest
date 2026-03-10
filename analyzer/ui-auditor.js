/**
 * ui-auditor.js
 * Takes screenshots of every game screen at every configured viewport.
 * Programmatically checks for:
 *   - Elements overlapping each other (interactive elements)
 *   - Elements clipped outside the viewport
 *   - Touch targets smaller than 44×44px (WCAG minimum)
 *   - Text with low contrast (basic check)
 *   - Scrollbars appearing where they shouldn't
 *   - Missing/empty text labels
 */

const path = require('path');
const fs   = require('fs');
const { INSTRUMENTATION_SCRIPT } = require('./instrumentation');

async function runUiAudit(gameHtmlPath, cfg, browser) {
  const fileUrl = `file://${path.resolve(gameHtmlPath)}`;
  const issues  = [];
  const screenshots = [];

  const viewports = [
    ...(cfg.ui.desktopViewports || []),
    ...(cfg.run.mobile ? (cfg.ui.mobileViewports || []) : []),
  ];

  for (const vp of viewports) {
    const isMobile = vp.width <= 768;
    const ctx = await browser.newContext({
      viewport:  { width: vp.width, height: vp.height },
      deviceScaleFactor: isMobile ? 2 : 1,
      isMobile,
      hasTouch:  isMobile,
    });
    await ctx.addInitScript(INSTRUMENTATION_SCRIPT);
    const page = await ctx.newPage();

    try {
      await page.goto(fileUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      await page.waitForFunction(
        () => typeof window.FACTIONS !== 'undefined',
        { timeout: 10_000 }
      ).catch(() => {});

      // ── Screenshot + audit each screen ────────────────────────────────────
      for (const screenId of (cfg.ui.screens || [])) {
        // Navigate to the screen
        const reached = await _navigateToScreen(page, screenId);
        if (!reached) {
          issues.push({
            type: 'ui_nav_failure',
            severity: 'warning',
            screen: screenId,
            viewport: vp.label,
            message: `Could not navigate to screen "${screenId}" — it may not exist or navigation logic failed`,
          });
          continue;
        }

        await sleep(600); // let animations settle

        // Screenshot
        if (cfg.output.saveScreenshots) {
          const ssDir = path.resolve(cfg.output.screenshotsDir || './screenshots');
          fs.mkdirSync(ssDir, { recursive: true });
          const ssFile = path.join(ssDir, `${screenId}-${vp.label}.png`);
          await page.screenshot({ path: ssFile, fullPage: false });
          screenshots.push({ screen: screenId, viewport: vp.label, path: ssFile, width: vp.width, height: vp.height });
        }

        // ── Programmatic checks ─────────────────────────────────────────────
        const pageIssues = await page.evaluate(({ screenId, vpW, vpH, isMobile, cfg }) => {
          const found = [];

          // Helper: get all visible interactive elements on this screen
          const screen = document.getElementById(screenId);
          if (!screen) return [{ type: 'missing_screen_element', severity: 'error', message: `#${screenId} not found in DOM` }];

          const interactives = Array.from(screen.querySelectorAll('button, a, input, select, [onclick], [tabindex]'));
          const allText      = Array.from(screen.querySelectorAll('p, span, div, h1, h2, h3, h4, label, .btn'));

          // ── Off-screen check ──────────────────────────────────────────────
          if (cfg.ui.checkOffscreen) {
            for (const el of interactives) {
              const r = el.getBoundingClientRect();
              if (r.width === 0 && r.height === 0) continue; // hidden element, skip
              if (r.right < 0 || r.bottom < 0 || r.left > vpW || r.top > vpH) {
                found.push({
                  type: 'element_offscreen',
                  severity: 'error',
                  screen: screenId,
                  element: el.tagName + (el.id ? '#'+el.id : '') + (el.className ? '.'+el.className.split(' ')[0] : ''),
                  bounds: { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) },
                  viewport: { width: vpW, height: vpH },
                  message: `Interactive element is outside viewport`,
                });
              }
            }
          }

          // ── Touch target size check ───────────────────────────────────────
          if (isMobile && cfg.ui.checkTouchTargets) {
            for (const el of interactives) {
              const r = el.getBoundingClientRect();
              if (r.width === 0 && r.height === 0) continue;
              if (r.width < 44 || r.height < 44) {
                found.push({
                  type: 'small_touch_target',
                  severity: 'warning',
                  screen: screenId,
                  element: el.tagName + (el.id ? '#'+el.id : '') + (el.textContent?.trim().slice(0,30) || ''),
                  size: { width: Math.round(r.width), height: Math.round(r.height) },
                  message: `Touch target is ${Math.round(r.width)}×${Math.round(r.height)}px — minimum recommended is 44×44px`,
                });
              }
            }
          }

          // ── Overlap check ─────────────────────────────────────────────────
          if (cfg.ui.checkOverlaps) {
            // Check interactive elements against each other
            for (let i = 0; i < interactives.length; i++) {
              for (let j = i + 1; j < interactives.length; j++) {
                const a = interactives[i].getBoundingClientRect();
                const b = interactives[j].getBoundingClientRect();
                if (a.width === 0 || b.width === 0) continue;
                // Check overlap
                if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) {
                  // Calculate overlap area
                  const overlapW = Math.min(a.right, b.right) - Math.max(a.left, b.left);
                  const overlapH = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
                  const overlapArea = overlapW * overlapH;
                  const smallerArea = Math.min(a.width * a.height, b.width * b.height);
                  // Only flag significant overlaps (>10% of smaller element)
                  if (overlapArea > smallerArea * 0.1) {
                    found.push({
                      type: 'element_overlap',
                      severity: 'warning',
                      screen: screenId,
                      elementA: interactives[i].tagName + (interactives[i].id ? '#'+interactives[i].id : ''),
                      elementB: interactives[j].tagName + (interactives[j].id ? '#'+interactives[j].id : ''),
                      overlapPx: Math.round(overlapArea),
                      message: `Two interactive elements overlap by ${Math.round(overlapArea)}px²`,
                    });
                  }
                }
              }
            }
          }

          // ── Empty/missing text check ──────────────────────────────────────
          for (const el of interactives) {
            const text = el.textContent?.trim();
            const aria = el.getAttribute('aria-label');
            const title = el.getAttribute('title');
            if (!text && !aria && !title && el.tagName === 'BUTTON') {
              found.push({
                type: 'empty_button',
                severity: 'warning',
                screen: screenId,
                element: el.tagName + (el.id ? '#'+el.id : ''),
                message: `Button has no visible text, aria-label, or title`,
              });
            }
          }

          // ── Scrollbar check ───────────────────────────────────────────────
          const docScrollable = document.documentElement.scrollHeight > vpH + 10;
          if (docScrollable) {
            found.push({
              type: 'unexpected_scroll',
              severity: 'info',
              screen: screenId,
              message: `Page is scrollable (content height ${document.documentElement.scrollHeight}px > viewport ${vpH}px) — check if this is intentional`,
            });
          }

          // ── Basic contrast check (text vs background) ─────────────────────
          if (cfg.ui.checkContrast) {
            for (const el of allText.slice(0, 20)) { // check first 20 to avoid perf issues
              const style = window.getComputedStyle(el);
              const color = style.color;
              const bg    = style.backgroundColor;
              // Parse rgb values
              const parseRgb = s => {
                const m = s.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
                return m ? [+m[1], +m[2], +m[3]] : null;
              };
              const c = parseRgb(color);
              const b = parseRgb(bg);
              if (!c || !b) continue;
              if (b[3] === 0) continue; // transparent bg
              // Relative luminance
              const lum = rgb => {
                const [r,g,bl] = rgb.map(v => {
                  v = v / 255;
                  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
                });
                return 0.2126*r + 0.7152*g + 0.0722*bl;
              };
              const l1 = lum(c), l2 = lum(b);
              const contrast = (Math.max(l1,l2) + 0.05) / (Math.min(l1,l2) + 0.05);
              const text = el.textContent?.trim();
              if (contrast < 3.0 && text && text.length > 2) { // WCAG AA minimum ~4.5
                found.push({
                  type: 'low_contrast',
                  severity: 'info',
                  screen: screenId,
                  element: el.tagName + (el.id ? '#'+el.id : ''),
                  contrast: Math.round(contrast * 10) / 10,
                  color, bg,
                  message: `Text contrast ratio ${Math.round(contrast*10)/10}:1 may be too low (WCAG AA: 4.5:1)`,
                });
              }
            }
          }

          return found;
        }, { screenId, vpW: vp.width, vpH: vp.height, isMobile, cfg });

        // Add viewport context to each issue
        for (const issue of (pageIssues || [])) {
          issues.push({ ...issue, viewport: vp.label, viewportSize: `${vp.width}×${vp.height}` });
        }
      }

    } catch (err) {
      issues.push({
        type: 'ui_audit_error',
        severity: 'error',
        viewport: vp.label,
        message: `UI audit failed for viewport ${vp.label}: ${err.message}`,
      });
    } finally {
      await page.close().catch(() => {});
      await ctx.close().catch(() => {});
    }
  }

  return { issues, screenshots };
}

// Navigate to a specific screen by manipulating the game's screen system
async function _navigateToScreen(page, screenId) {
  return await page.evaluate((id) => {
    // Method 1: use showScreen if it exists
    if (typeof window.showScreen === 'function') {
      try { window.showScreen(id); return true; } catch (_) {}
    }
    // Method 2: direct DOM manipulation
    const target = document.getElementById(id);
    if (!target) return false;
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    target.classList.add('active');
    // For game screen: need G to be initialized
    if (id === 'sc-game') {
      if (!window.G || !window.G.running) {
        // Start a quick aivsai game to get to game screen
        const f1 = window.FACTIONS?.[0];
        const f2 = window.FACTIONS?.[1];
        if (f1 && f2) {
          window.P1_FACTION = f1;
          window.P2_FACTION = f2;
          window.GAME_MODE = 'aivsai';
          window.AI_DIFFICULTY = 'easy';
          window._pendingPlayerSetup = 'aivsai';
          try { window.initGame(); } catch (_) {}
        }
      }
    }
    if (id === 'sc-gameover') {
      // Force a quick game end
      if (window.G && window.G.running) {
        try {
          window.G.players[1].baseHp = 0;
          if (typeof window.checkWin === 'function') window.checkWin();
        } catch (_) {}
      }
    }
    return !!document.getElementById(id);
  }, screenId);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { runUiAudit };
