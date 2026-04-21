// ─── BEYOND RTS QA SYSTEM — CONFIGURATION ─────────────────────────────────────
//
// QUICK GUIDE:
//   Full 24-faction run (~4000 games): ~25–40 min → gamesPerMatchup:3, parallelGames:4
//   Quick sanity check (~276 games):   ~4–6 min   → run: node run.js --quick
//   UI only (no games):                ~1 min     → run: node run.js --skip-balance
//   Cheapest run (haiku everywhere):   any        → add --cheap
//   Skip expensive extras:             any        → add --skip-features --skip-vision

module.exports = {

  // ── GAME FILE ──────────────────────────────────────────────────────────────
  gamePath: '../public/index.html',

  // ── WHAT TO RUN ────────────────────────────────────────────────────────────
  run: {
    balance: true,   // faction matchup win rate testing
    bugs: true,   // JS error capture, NaN detection, softlock detection
    ui: true,   // screenshot audit, element overlap, off-screen checks
    mechanics: true,   // spy/mid/upgrade/buff/laststand usage tracking
    performance: true,   // frame timing, memory, long tasks
    mobile: true,   // repeat ui audit at mobile viewport sizes
    online: true,   // P2 sync quality test (intercept-and-replay)
    features: true,   // AI feature suggestion engine
  },

  // ── ONLINE SYNC TEST ──────────────────────────────────────────────────────
  online: {
    // Latency profiles to test (ideal/good/average/bad/awful)
    latencyProfiles: ['ideal', 'good', 'average'],
    // Faction pairs to test sync with (pick representative matchups)
    factionPairs: [['warriors', 'brutes'], ['summoners', 'spirits'], ['glacial', 'infernal'], ['weavers', 'merchants'], ['plagued', 'chronomancers'], ['psionics', 'umbral'], ['pandemonium', 'illusionists'], ['reavers', 'fortune'], ['chrysalis', 'tideborn'], ['echoes', 'veilborn']],
    // Real seconds before giving up on a test scenario
    testTimeoutSecs: 40,
  },

  // ── BALANCE SETTINGS ──────────────────────────────────────────────────────
  balance: {
    gamesPerMatchup: 3,       // 3=quick, 5=reliable, 10=high confidence
    aiDifficulty: 'hard',   // 'easy'|'medium'|'hard'|'expert'
    parallelGames: 4,       // Recommended: 3-4. Each tab ~300MB RAM. 6 = lag city.
    mirrorMatchups: true,    // run A-vs-B AND B-vs-A (doubles accuracy, doubles time)
    factionFilter: null,    // null=all factions, or ['warriors','brutes',...]
    gameTimeoutSecs: 45,      // Real seconds before giving up. With 50x speed hack
    // this represents ~37 in-game minutes — more than enough.
  },

  // ── BUG DETECTION ─────────────────────────────────────────────────────────
  bugs: {
    captureConsoleErrors: true,
    captureConsoleWarnings: false,  // flip to true if you want warnings (noisy)
    detectNaN: true,   // scan G state for NaN/Infinity every 10s
    detectSoftlocks: true,   // flag if game doesn't end within timeout
    detectMemoryLeaks: true,   // flag if JS heap grows > threshold
    memoryLeakThresholdMB: 400,
    screenshotOnError: true,   // screenshot when a JS error fires
  },

  // ── UI AUDIT ──────────────────────────────────────────────────────────────
  ui: {
    screens: [
      'sc-menu',              // main menu
      'sc-faction',           // faction select
      'sc-draft',             // draft ban/pick screen
      'sc-online',            // online multiplayer lobby
      'sc-tournament-setup',  // tournament config
      'sc-campaign',          // campaign map
      'sc-mastery',           // faction mastery book
      'sc-tutorial',          // tutorial screen
      'sc-controls',          // keybind reference
      'sc-game',              // in-game (conquest, after 3s AI play)
      'sc-game-horde',        // horde mode gameplay
      'sc-gameover',          // game over screen
    ],
    desktopViewports: [
      { width: 1920, height: 1080, label: '1080p' },
      { width: 1366, height: 768, label: 'laptop' },
      { width: 1024, height: 768, label: 'tablet-landscape' },
    ],
    mobileViewports: [
      { width: 390, height: 844, label: 'iphone-14' },
      { width: 412, height: 915, label: 'android-xl' },
      { width: 375, height: 667, label: 'iphone-se' },
      { width: 768, height: 1024, label: 'ipad-portrait' },
    ],
    checkOverlaps: true,   // detect elements overlapping each other
    checkOffscreen: true,   // detect elements clipped outside viewport
    checkContrast: true,   // basic text contrast check
    checkTouchTargets: true,   // flag buttons smaller than 44×44px on mobile

    // Contrast threshold — WCAG AA is 4.5 but game UIs are intentionally
    // dark-on-dark. 2.5 is a more realistic floor for game UI. Raise to 4.5
    // to restore strict WCAG AA checking.
    contrastThreshold: 2.5,

    // Selectors to skip across ALL checks (offscreen, overlap, contrast, touch).
    // Add intentionally layered, hidden, or aesthetic-only elements here.
    ignoreSelectors: [
      '#hud',           // HUD overlay is intentionally layered over canvas
      '#hud *',
      '.tooltip',       // off-screen until triggered
      '.popup',
      '.modal',
      'canvas',         // not a DOM interactive element
      '[data-qa-ignore]', // explicit opt-out marker
      '#menu-footer *', // sticky footer intentionally overlays menu scroll area
      '[aria-hidden="true"]', // hidden ghost buttons (mode triggers, etc.)
    ],
  },

  // ── MECHANICS TRACKING ────────────────────────────────────────────────────
  mechanics: {
    unusedThresholdPct: 15,   // flag if used in <15% of games
    track: [
      'spy_deployed',
      'mid_captured',
      'upgrade_purchased',
      'buff_activated',
      'last_stand_triggered',
      'aerial_unit_spawned',
      'worker_sent_to_mid',
      'tar_patches_active',
      'corpses_collected',
      'echo_spawned',
      'dark_zone_created',
      'mutation_applied',
      'metamorphosis_complete',
      'decoy_spawned',
      'phase_activated',
      'corruption_applied',
      'fortune_double',
      'random_event_fired',
    ],
  },

  // ── ANTHROPIC API ─────────────────────────────────────────────────────────
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || null,

  // ── DISCORD ────────────────────────────────────────────────────────────────
  discord: {
    // Set DISCORD_WEBHOOK_URL in your environment or a .env file.
    // Never commit a real webhook URL — rotate it immediately if exposed.
    webhookUrl: process.env.DISCORD_WEBHOOK_URL || null,
    pingUserId: process.env.DISCORD_PING_USER_ID || null,
    pingOn: {
      jsErrors: true,
      softlocks: true,
      nanDetected: true,
    },
  },

  // ── OUTPUT ────────────────────────────────────────────────────────────────
  output: {
    reportPath: './qa-report.html',
    rawDataPath: './qa-data.json',
    screenshotsDir: './screenshots',
    saveScreenshots: true,
    saveRawData: true,
    // Embed screenshots as base64 in the HTML report (self-contained, no broken links)
    // Set false only if report file size becomes a problem (>20MB)
    inlineScreenshots: false,
  },

};