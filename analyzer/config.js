// ─── BEYOND RTS QA SYSTEM — CONFIGURATION ─────────────────────────────────────

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
  },

  // ── BALANCE SETTINGS ──────────────────────────────────────────────────────
  balance: {
    gamesPerMatchup: 3,       // 5=quick, 10=reliable, 20=high confidence
    aiDifficulty: 'hard',   // 'easy'|'medium'|'hard'|'expert'
    parallelGames: 6,       // concurrent browser tabs (RAM: ~300MB each)
    mirrorMatchups: true,    // run A-vs-B AND B-vs-A
    factionFilter: null,    // null = all factions, or ['warriors','brutes',...]
    gameTimeoutSecs: 120,
  },

  // ── BUG DETECTION ─────────────────────────────────────────────────────────
  bugs: {
    captureConsoleErrors: true,
    captureConsoleWarnings: false,  // too noisy; flip to true if you want warnings
    detectNaN: true,    // scan G state for NaN/Infinity every 5s
    detectSoftlocks: true,    // flag if game doesn't end within timeout
    detectMemoryLeaks: true,    // flag if JS heap grows > threshold
    memoryLeakThresholdMB: 400,
    screenshotOnError: true,    // take a screenshot when a JS error fires
  },

  // ── UI AUDIT ──────────────────────────────────────────────────────────────
  ui: {
    // Screens to screenshot and audit
    screens: [
      'sc-menu',        // main menu
      'sc-faction',     // faction select
      'sc-game',        // in-game (after 3s)
      'sc-gameover',    // game over screen
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
    checkOverlaps: true,   // detect elements that overlap each other
    checkOffscreen: true,   // detect elements clipped outside viewport
    checkContrast: true,   // very basic text contrast check
    checkTouchTargets: true,   // flag buttons smaller than 44×44px on mobile
  },

  // ── MECHANICS TRACKING ────────────────────────────────────────────────────
  mechanics: {
    // Flag if a mechanic is used in fewer than X% of games
    // (potential sign it's broken, too expensive, or players don't know about it)
    unusedThresholdPct: 15,
    track: [
      'spy_deployed',
      'mid_captured',
      'upgrade_purchased',
      'buff_activated',
      'last_stand_triggered',
      'aerial_unit_spawned',
      'worker_sent_to_mid',
    ],
  },

  // ── ANTHROPIC API ─────────────────────────────────────────────────────────
  // Used for: balance analysis, auto bug-diagnosis, fix suggestions
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || null,

  // ── DISCORD ────────────────────────────────────────────────────────────────
  discord: {
    // Your Discord webhook URL
    // Server Settings → Integrations → Webhooks → New Webhook → Copy URL
    webhookUrl: 'https://discord.com/api/webhooks/1480926658474016871/93fkVlEzGSf7xCSkloCvztmJg-K4XlnX2BXn0-5F12Tq2-iETwUl3_hvz2q9ILF7U3ft' || null,

    // Your Discord user ID (right-click your name → Copy User ID)
    // Used to @mention you on critical bugs
    pingUserId: '739519255946461396' || null,   // e.g. '123456789012345678'

    // What triggers an immediate ping (doesn't wait for full report)
    pingOn: {
      jsErrors: true,   // any uncaught JS exception
      softlocks: true,   // game gets stuck
      nanDetected: true,   // NaN/Infinity in game state
    },
  },

  // ── OUTPUT ────────────────────────────────────────────────────────────────
  output: {
    reportPath: './qa-report.html',
    rawDataPath: './qa-data.json',
    screenshotsDir: './screenshots',
    saveScreenshots: true,
    saveRawData: true,
  },

};
