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
const fs = require('fs');
const { INSTRUMENTATION_SCRIPT } = require('./instrumentation');

// UI-audit speed: lower than game-runner (50x) so games don't end before
// we take the in-game screenshot. 10x → ~20-40 game-seconds per real second.
const UI_SPEED = 10;

async function runUiAudit(gameHtmlPath, cfg, browser) {
  const fileUrl = `file://${path.resolve(gameHtmlPath)}`;
  const issues = [];
  const screenshots = [];

  const viewports = [
    ...(cfg.ui.desktopViewports || []),
    ...(cfg.run.mobile ? (cfg.ui.mobileViewports || []) : []),
  ];

  for (const vp of viewports) {
    const isMobile = vp.width <= 768;
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: isMobile ? 2 : 1,
      isMobile,
      hasTouch: isMobile,
    });
    await ctx.addInitScript(INSTRUMENTATION_SCRIPT);
    const page = await ctx.newPage();

    try {
      await page.goto(fileUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      await page.waitForFunction(
        () => typeof window.FACTIONS !== 'undefined',
        { timeout: 10_000 }
      ).catch(() => { });

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

        // For sc-game: wait for the AI to play so screenshot shows actual combat
        if (screenId === 'sc-game') {
          // The speed hack is set inside _navigateToScreen before initGame().
          // Wait ~2s real time ≈ 60-120 game-seconds at 10x (enough for combat)
          await sleep(2000);
          // Pause game and force full visual refresh (canvas + HUD DOM elements)
          await page.evaluate(() => {
            if (window.G) window.G.paused = true;
            try { window.resizeGameCanvas(); } catch (_) {}
            try { window.drawGame(); } catch (_) {}
            try { window.updateHUD(); } catch (_) {}
          });
          await sleep(200);
        } else {
          await sleep(screenId === 'sc-gameover' ? 800 : 600);
        }

        // Screenshot
        if (cfg.output.saveScreenshots) {
          const ssDir = path.resolve(cfg.output.screenshotsDir || './screenshots');
          fs.mkdirSync(ssDir, { recursive: true });
          const ssFile = path.join(ssDir, `${screenId}-${vp.label}.png`);
          await page.screenshot({ path: ssFile, fullPage: false });
          screenshots.push({ screen: screenId, viewport: vp.label, path: ssFile, width: vp.width, height: vp.height });

          // ── Additional focused screenshots for game screen ──────────────
          if (screenId === 'sc-game') {
            // HUD panel close-up (bottom ~42% of viewport)
            const hudFile = path.join(ssDir, `sc-game-hud-${vp.label}.png`);
            const hudY = Math.round(vp.height * 0.58);
            await page.screenshot({
              path: hudFile,
              clip: { x: 0, y: hudY, width: vp.width, height: vp.height - hudY },
            });
            screenshots.push({ screen: 'sc-game-hud', viewport: vp.label, path: hudFile, width: vp.width, height: vp.height - hudY });

            // Upgrades tab (P1 side) — only if game is still alive
            const canSwitchTabs = await page.evaluate(() => !!(window.G && window.G.factions));
            if (canSwitchTabs) {
              await page.evaluate(() => { try { switchMode(1, 1); } catch(_){} });
              await sleep(200);
              const upgFile = path.join(ssDir, `sc-game-upgrades-${vp.label}.png`);
              await page.screenshot({
                path: upgFile,
                clip: { x: 0, y: hudY, width: vp.width, height: vp.height - hudY },
              });
              screenshots.push({ screen: 'sc-game-upgrades', viewport: vp.label, path: upgFile, width: vp.width, height: vp.height - hudY });

              // Buffs tab (P1 side)
              await page.evaluate(() => { try { switchMode(1, 2); } catch(_){} });
              await sleep(200);
              const bufFile = path.join(ssDir, `sc-game-buffs-${vp.label}.png`);
              await page.screenshot({
                path: bufFile,
                clip: { x: 0, y: hudY, width: vp.width, height: vp.height - hudY },
              });
              screenshots.push({ screen: 'sc-game-buffs', viewport: vp.label, path: bufFile, width: vp.width, height: vp.height - hudY });

              // Restore units tab
              await page.evaluate(() => { try { switchMode(1, 0); } catch(_){} });
            }

            // Unpause so the game can continue (needed for sc-gameover later)
            await page.evaluate(() => { if (window.G) window.G.paused = false; });
          }

          // ── Game-over: focused screenshot of just the stats panel ──────
          if (screenId === 'sc-gameover') {
            const goFile = path.join(ssDir, `sc-gameover-stats-${vp.label}.png`);
            const goWrap = await page.$('.go-wrap');
            if (goWrap) {
              await goWrap.screenshot({ path: goFile });
              const box = await goWrap.boundingBox();
              screenshots.push({ screen: 'sc-gameover-stats', viewport: vp.label, path: goFile, width: Math.round(box?.width || vp.width), height: Math.round(box?.height || vp.height) });
            }
          }
        }

        // ── Programmatic checks ─────────────────────────────────────────────
        const pageIssues = await page.evaluate(({ screenId, vpW, vpH, isMobile, cfg }) => {
          const found = [];

          // Helper: get all visible interactive elements on this screen
          const screen = document.getElementById(screenId);
          if (!screen) return [{ type: 'missing_screen_element', severity: 'error', message: `#${screenId} not found in DOM` }];

          const interactives = Array.from(screen.querySelectorAll('button, a, input, select, [onclick], [tabindex]'));
          const allText = Array.from(screen.querySelectorAll('p, span, div, h1, h2, h3, h4, label, .btn'));

          // Build a Set of elements to ignore across all checks.
          // We test each candidate element against every ignoreSelector and
          // skip it if it matches any of them.
          const ignoreSelectors = cfg.ui.ignoreSelectors || [];
          function _isIgnored(el) {
            for (const sel of ignoreSelectors) {
              try { if (el.matches(sel)) return true; } catch (_) { }
            }
            return false;
          }
          const filteredInteractives = interactives.filter(el => !_isIgnored(el));
          const filteredText = allText.filter(el => !_isIgnored(el));

          const contrastThreshold = cfg.ui.contrastThreshold ?? 2.5;

          // ── Off-screen check ──────────────────────────────────────────────
          if (cfg.ui.checkOffscreen) {
            for (const el of filteredInteractives) {
              const r = el.getBoundingClientRect();
              if (r.width === 0 && r.height === 0) continue; // hidden element, skip
              // Also skip elements with display:none or visibility:hidden
              const st = window.getComputedStyle(el);
              if (st.display === 'none' || st.visibility === 'hidden') continue;
              if (r.right < 0 || r.bottom < 0 || r.left > vpW || r.top > vpH) {
                found.push({
                  type: 'element_offscreen',
                  severity: 'error',
                  screen: screenId,
                  element: el.tagName + (el.id ? '#' + el.id : '') + (el.className ? '.' + el.className.split(' ')[0] : ''),
                  bounds: { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) },
                  viewport: { width: vpW, height: vpH },
                  message: `Interactive element is outside viewport`,
                });
              }
            }
          }

          // ── Touch target size check ───────────────────────────────────────
          if (isMobile && cfg.ui.checkTouchTargets) {
            for (const el of filteredInteractives) {
              const r = el.getBoundingClientRect();
              if (r.width === 0 && r.height === 0) continue;
              if (r.width < 44 || r.height < 44) {
                found.push({
                  type: 'small_touch_target',
                  severity: 'warning',
                  screen: screenId,
                  element: el.tagName + (el.id ? '#' + el.id : '') + (el.textContent?.trim().slice(0, 30) || ''),
                  size: { width: Math.round(r.width), height: Math.round(r.height) },
                  message: `Touch target is ${Math.round(r.width)}×${Math.round(r.height)}px — minimum recommended is 44×44px`,
                });
              }
            }
          }

          // ── Overlap check ─────────────────────────────────────────────────
          if (cfg.ui.checkOverlaps) {
            for (let i = 0; i < filteredInteractives.length; i++) {
              for (let j = i + 1; j < filteredInteractives.length; j++) {
                const a = filteredInteractives[i].getBoundingClientRect();
                const b = filteredInteractives[j].getBoundingClientRect();
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
                      elementA: filteredInteractives[i].tagName + (filteredInteractives[i].id ? '#' + filteredInteractives[i].id : ''),
                      elementB: filteredInteractives[j].tagName + (filteredInteractives[j].id ? '#' + filteredInteractives[j].id : ''),
                      overlapPx: Math.round(overlapArea),
                      message: `Two interactive elements overlap by ${Math.round(overlapArea)}px²`,
                    });
                  }
                }
              }
            }
          }

          // ── Empty/missing text check ──────────────────────────────────────
          for (const el of filteredInteractives) {
            const text = el.textContent?.trim();
            const aria = el.getAttribute('aria-label');
            const title = el.getAttribute('title');
            if (!text && !aria && !title && el.tagName === 'BUTTON') {
              found.push({
                type: 'empty_button',
                severity: 'warning',
                screen: screenId,
                element: el.tagName + (el.id ? '#' + el.id : ''),
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
            for (const el of filteredText.slice(0, 40)) { // check first 40 (was 20, safe now that we pre-filter)
              const style = window.getComputedStyle(el);
              const color = style.color;
              const bg = style.backgroundColor;
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
                const [r, g, bl] = rgb.map(v => {
                  v = v / 255;
                  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
                });
                return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
              };
              const l1 = lum(c), l2 = lum(b);
              const contrast = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
              const text = el.textContent?.trim();
              if (contrast < contrastThreshold && text && text.length > 2) {
                found.push({
                  type: 'low_contrast',
                  severity: 'info',
                  screen: screenId,
                  element: el.tagName + (el.id ? '#' + el.id : ''),
                  contrast: Math.round(contrast * 10) / 10,
                  color, bg,
                  message: `Text contrast ratio ${Math.round(contrast * 10) / 10}:1 is below threshold of ${contrastThreshold}:1`,
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
      await page.close().catch(() => { });
      await ctx.close().catch(() => { });
    }
  }

  return { issues, screenshots };
}

// Navigate to a specific screen by manipulating the game's screen system
async function _navigateToScreen(page, screenId) {
  return await page.evaluate(({ id, speed }) => {
    const target = document.getElementById(id);
    if (!target) return false;

    // For game screen: use __qaStartAiVsAi to properly start a game with speed hack
    if (id === 'sc-game') {
      if (!window.G || !window.G.running) {
        window.__qaSpeedMultiplier = speed;
        if (typeof window.__qaStartAiVsAi === 'function') {
          try { window.__qaStartAiVsAi(0, 1, 'easy'); } catch (_) { }
        }
        try { window.resizeGameCanvas(); } catch (_) { }
        try { window.drawGame(); } catch (_) { }
      }
      return true;
    }

    // For game-over: force a game end — the speed hack is already active from sc-game
    if (id === 'sc-gameover') {
      if (window.G && window.G.running) {
        window.G.players[1].baseHp = 0;
        try { window.checkWin(); } catch (_) { }
      }
      return true;
    }

    // For other screens: use showScreen if available, else direct DOM manipulation
    if (typeof window.showScreen === 'function') {
      try { window.showScreen(id); return true; } catch (_) { }
    }
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    target.classList.add('active');
    return true;
  }, { id: screenId, speed: UI_SPEED });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { runUiAudit };
