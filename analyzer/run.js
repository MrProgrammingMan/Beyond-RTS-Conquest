#!/usr/bin/env node
/**
 * run.js — Beyond RTS Conquest QA System
 *
 * Usage:
 *   node run.js                          full run (games + UI + online + analysis + report)
 *   node run.js --analyze-only           re-analyze saved qa-data.json (no games)
 *   node run.js --skip-balance           skip matchup games (UI + bugs only)
 *   node run.js --skip-ui                skip UI audit (games only)
 *   node run.js --skip-online            skip online sync test
 *   node run.js --factions=a,b,c         only test these factions
 *   node run.js --games=N                override gamesPerMatchup
 *   node run.js --quick                  all factions × 1 game (fast sanity check)
 *   node run.js --resume                 skip phases that already have saved data
 *   node run.js --focus=TYPE             only show/diagnose bugs matching TYPE substring
 *   node run.js --auto-fix               apply all HIGH/CRITICAL fixes non-interactively after run
 *   node run.js --no-server              skip starting the local fix server (for CI)
 *   node run.js --report-only            rebuild report from cached analysis (no API calls)
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const cfg = require('./config');
const { runAllMatchups, aggregateStats } = require('./matchup-runner');
const { runUiAudit } = require('./ui-auditor');
const { analyzeBugs } = require('./bug-analyzer');
const { analyzeBalance } = require('./balance-analyzer');
const { buildReport } = require('./reporter');
const { pingCriticalBug, sendFullReport } = require('./discord');
const { runOnlineTests } = require('./online-tester');
const { detectAnomalies } = require('./anomaly-detector');
const { generateFeatureAdvice } = require('./feature-advisor');
const { analyzeScreenshotsWithVision } = require('./ui-vision-analyzer');

const { chromium, executablePath } = require('playwright');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { buildSnapshot, saveToHistory, computeDiff, formatDiffSummary } = require('./run-history');
const { buildGameContext } = require('./game-context');
const { generateFix, generateGenericFix, applyDiff } = require('./auto-fixer');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const analyzeOnly = args.includes('--analyze-only');
const skipBalance = args.includes('--skip-balance');
const skipUi = args.includes('--skip-ui');
const skipOnline = args.includes('--skip-online');
const quickMode = args.includes('--quick');
const resumeMode = args.includes('--resume');
const autoFix = args.includes('--auto-fix');   // #11: batch-apply HIGH/CRITICAL fixes
const noServer = args.includes('--no-server');  // #11: skip local fix server (CI)
const reportOnly = args.includes('--report-only'); // rebuild report from cached analysis data
const FIX_PORT = 3742;                          // port for the local fix server
const factionsArg = args.find(a => a.startsWith('--factions='));
const gamesArg = args.find(a => a.startsWith('--games='));
const focusArg = args.find(a => a.startsWith('--focus='));

if (quickMode) {
  // Quick mode: ALL 24 factions but fewer games per matchup for a fast sanity check
  cfg.balance.factionFilter = null; // all factions
  cfg.balance.gamesPerMatchup = 1;
  cfg.balance.parallelGames = 4;
  cfg.balance.mirrorMatchups = false; // halve matchup count (A-vs-B only, no B-vs-A)
  cfg.online = { ...(cfg.online || {}), latencyProfiles: ['ideal'], factionPairs: [['warriors', 'brutes'], ['psionics', 'umbral']] };
}
if (factionsArg) cfg.balance.factionFilter = factionsArg.replace('--factions=', '').split(',').map(s => s.trim());
if (gamesArg) cfg.balance.gamesPerMatchup = parseInt(gamesArg.replace('--games=', '')) || cfg.balance.gamesPerMatchup;

const hasApiKey = !!(cfg.anthropicApiKey && cfg.anthropicApiKey !== 'YOUR_API_KEY_HERE');

// ── Utils ─────────────────────────────────────────────────────────────────────
const log = (...a) => console.log(...a);
function bar(done, total, w = 30) {
  const p = done / total, f = Math.round(p * w);
  return `[${'█'.repeat(f)}${'░'.repeat(w - f)}] ${String(done).padStart(3)}/${total} (${Math.round(p * 100)}%)`;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Browser install — only if not already present ─────────────────────────────
async function ensureBrowser() {
  const lockFile = path.join(__dirname, '.browser-installed');
  if (fs.existsSync(lockFile)) return;
  log('  📦 Installing Chromium (first run only)...');
  try {
    execSync('npx playwright install chromium --with-deps', { stdio: 'inherit' });
    fs.writeFileSync(lockFile, '1');
  } catch (err) {
    log(`  ⚠️  Browser install warning: ${err.message.slice(0, 100)}`);
  }
}

async function main() {
  console.clear();
  log('');
  log('  ⚔  BEYOND RTS CONQUEST — QA SYSTEM  ⚔');
  log('  ─────────────────────────────────────');
  log('');

  const gamePath = path.resolve(cfg.gamePath);
  const analysisCachePath = path.resolve('./qa-analysis-cache.json');

  // ── --report-only: rebuild report from cached data (no API calls) ─────────
  if (reportOnly) {
    if (!fs.existsSync(analysisCachePath)) {
      log('  ❌  No analysis cache found — run a full analysis first');
      process.exit(1);
    }
    log('  ♻️  Report-only mode: rebuilding from cached analysis data...');
    const cached = JSON.parse(fs.readFileSync(analysisCachePath, 'utf8'));
    const html = buildReport(cached);
    const reportPath = path.resolve(cfg.output.reportPath || './qa-report.html');
    fs.writeFileSync(reportPath, html);
    log(`  ✅ Report rebuilt → ${reportPath}`);
    return;
  }

  if (!analyzeOnly && !fs.existsSync(gamePath)) {
    log(`  ❌  Game file not found: ${gamePath}`);
    log(`      Set gamePath in config.js`);
    process.exit(1);
  }

  // ── Dependency check ──────────────────────────────────────────────────────
  // Warn early so you don't wait 20 min for games then hit a crash on report.
  {
    const REQUIRED_FILES = [
      'config.js', 'matchup-runner.js', 'ui-auditor.js', 'bug-analyzer.js',
      'balance-analyzer.js', 'reporter.js', 'anomaly-detector.js', 'feature-advisor.js',
    ];
    const missing = REQUIRED_FILES.filter(f => !fs.existsSync(path.join(__dirname, f)));
    if (missing.length > 0) {
      log(`  ⚠️  Missing required files: ${missing.join(', ')}`);
      log('     Some phases may be skipped or fail.');
      log('');
    }
    const REQUIRED_PKGS = ['playwright', 'dotenv'];
    const missingPkgs = REQUIRED_PKGS.filter(pkg => {
      try { require.resolve(pkg); return false; } catch { return true; }
    });
    if (missingPkgs.length > 0) {
      log(`  ❌  Missing npm packages: ${missingPkgs.join(', ')}`);
      log(`      Run: npm install ${missingPkgs.join(' ')}`);
      process.exit(1);
    }
  }

  // ── Resume: detect what's already done ───────────────────────────────────
  const rawDataPath = path.resolve(cfg.output?.rawDataPath || './qa-data.json');
  const hasRawData = fs.existsSync(rawDataPath);
  const uiCachePath = path.resolve('./qa-ui-cache.json');
  const hasUiCache = fs.existsSync(uiCachePath);

  if (resumeMode) {
    log(`  ♻️  Resume mode:`);
    log(`     Games data: ${hasRawData ? '✅ found — will skip' : '❌ not found — will run'}`);
    log(`     UI cache:   ${hasUiCache ? '✅ found — will skip' : '❌ not found — will run'}`);
    log('');
  }

  const factions = cfg.balance.factionFilter || require('./matchup-runner').ALL_FACTIONS;
  const numMatchups = factions.length * (factions.length - 1) * (cfg.balance.mirrorMatchups ? 1 : 0.5);
  const numGames = Math.round(numMatchups * cfg.balance.gamesPerMatchup);
  const estMin = Math.ceil(numGames / cfg.balance.parallelGames * 3 / 60);  // ~3s/game estimate

  log(`  Game:     ${gamePath}`);
  log(`  Mode:     ${quickMode ? '⚡ Quick' : 'Full'} · ${factions.length} factions · ${cfg.balance.gamesPerMatchup}g/matchup · ${cfg.balance.parallelGames} parallel`);
  log(`  Est:      ~${numGames} games · ~${estMin}–${estMin * 2} min (varies by softlock rate)`);
  log(`  Discord:  ${cfg.discord.webhookUrl ? '✅' : '❌ not configured'}`);
  log(`  Claude:   ${hasApiKey ? '✅ API key set' : '❌ no API key (analysis skipped)'}`);
  log('');

  // ── Phase 0: Game context — extracted ONCE, injected into all Claude calls ─
  // Reads live FACTIONS array + key mechanic code from index.html so every
  // analyzer has complete knowledge of the game, not just summary statistics.
  let gameContext = null;
  if (hasApiKey) {
    log('  ── Phase 0: Building game context ─────────────────────────────');
    try {
      gameContext = await buildGameContext(cfg);
    } catch (err) {
      log(`  ⚠️  Game context build failed (analysis will use reduced context): ${err.message}`);
    }
    log('');
  }

  if (cfg.output.saveScreenshots) {
    fs.mkdirSync(path.resolve(cfg.output.screenshotsDir || './screenshots'), { recursive: true });
  }

  let rawData = null;
  let uiAuditResult = { issues: [], screenshots: [] };
  const startTime = Date.now();

  // ════════════════════════════════════════════════════════════════════════════
  // PHASE 1: BROWSER
  // ════════════════════════════════════════════════════════════════════════════
  if (!analyzeOnly) await ensureBrowser();

  // ════════════════════════════════════════════════════════════════════════════
  // PHASE 2: BALANCE + BUG GAMES
  // ════════════════════════════════════════════════════════════════════════════
  const skipGamesResume = resumeMode && hasRawData;
  if (!analyzeOnly && !skipBalance && cfg.run.balance && !skipGamesResume) {
    log('  ── Phase 1: Running AI vs AI games ────────────────────────────');
    log('');

    const liveLines = [];
    const t0 = Date.now();
    const etaWindow = [];

    rawData = await runAllMatchups(cfg, ({ done, total, latest }) => {
      const elapsedMs = Date.now() - t0;
      etaWindow.push(elapsedMs / done);
      if (etaWindow.length > 15) etaWindow.shift();
      const avgMs = etaWindow.reduce((a, b) => a + b, 0) / etaWindow.length;
      const etaSec = Math.round(avgMs * (total - done) / 1000);
      const etaStr = done < 2 ? '…' : etaSec > 3600 ? `${Math.floor(etaSec / 3600)}h${Math.floor((etaSec % 3600) / 60)}m`
        : etaSec > 60 ? `${Math.floor(etaSec / 60)}m${etaSec % 60}s`
          : `${etaSec}s`;

      const icon = latest.timedOut ? '⏱' : latest.hasErrors ? '🐛' : latest.hasNaN ? '⚡' : '✅';
      const errNote = latest.hasErrors && latest.firstError
        ? ` ↳ ${latest.firstError.slice(0, 55)}`
        : latest.hasErrors ? ' [errors]' : '';

      liveLines.unshift(`  ${icon} ${latest.p1} vs ${latest.p2} → ${latest.result}${errNote}`);
      if (liveLines.length > 4) liveLines.pop();

      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      process.stdout.write(
        `\r\x1b[K  ${bar(done, total)}  ETA:${etaStr}  ${elapsed}s\n` +
        liveLines.join('\n') +
        `\x1b[${liveLines.length + 1}A`
      );
    });

    process.stdout.write(`\x1b[6B\n`);
    log('');
    log(`  ✅ Games complete: ${rawData.qa.totalGamesRun} run · ${rawData.qa.allErrors.length} errors · ${rawData.qa.allTimedOut.length} timeouts`);

    // Print top unique errors immediately
    if (rawData.qa.allErrors.length > 0) {
      const seen = new Set();
      const topErrors = [];
      for (const e of rawData.qa.allErrors) {
        const key = (e.message || '').slice(0, 100);
        if (!seen.has(key)) { seen.add(key); topErrors.push(e); if (topErrors.length >= 6) break; }
      }
      log('');
      log(`  🔍 Top unique errors (${seen.size} of ${rawData.qa.allErrors.length}):`);
      for (const e of topErrors) {
        log(`     [${e.matchup || '?'}]  ${(e.message || '').replace(/\n/g, ' ').slice(0, 90)}`);
        const stackLine = (e.stack || '').split('\n').find(l => l.includes('.html') || l.includes('at '));
        if (stackLine) log(`       → ${stackLine.trim().slice(0, 80)}`);
      }
      log('');
    }

    if (cfg.output.saveRawData) {
      fs.writeFileSync(path.resolve(cfg.output.rawDataPath || './qa-data.json'), JSON.stringify(rawData, null, 2));
      log(`  💾 Raw data saved`);
    }

  } else if (skipGamesResume) {
    rawData = JSON.parse(fs.readFileSync(rawDataPath, 'utf8'));
    log(`  ♻️  Loaded saved games data (${rawData.qa?.totalGamesRun} games) — skipping re-run`);
  } else if (analyzeOnly) {
    const p = path.resolve(cfg.output?.rawDataPath || './qa-data.json');
    if (!fs.existsSync(p)) { log(`  ❌  No data at ${p} — run without --analyze-only first`); process.exit(1); }
    rawData = JSON.parse(fs.readFileSync(p, 'utf8'));
    log(`  📂 Loaded saved data (${rawData.qa?.totalGamesRun} games)`);
  } else {
    rawData = { results: {}, factions: [], qa: { allErrors: [], allNaNs: [], allTimedOut: [], mechanicUsage: {}, performance: {}, totalGamesRun: 0 } };
  }

  // ════════════════════════════════════════════════════════════════════════════
  // PHASE 3: UI AUDIT
  // ════════════════════════════════════════════════════════════════════════════
  const skipUiResume = resumeMode && hasUiCache;
  if (!analyzeOnly && !skipUi && cfg.run.ui && !skipUiResume) {
    log('  ── Phase 2: UI audit ──────────────────────────────────────────');
    const browser = await chromium.launch({ headless: true });
    try {
      uiAuditResult = await runUiAudit(gamePath, cfg, browser);
      log(`  ✅ UI audit: ${uiAuditResult.screenshots.length} screenshots · ${uiAuditResult.issues.length} issues`);
      // Cache for --resume
      if (cfg.output?.saveRawData !== false) {
        fs.writeFileSync(uiCachePath, JSON.stringify(uiAuditResult, null, 2));
      }
    } catch (err) {
      log(`  ⚠️  UI audit failed: ${err.message}`);
    } finally {
      await browser.close();
    }
  } else if (skipUiResume) {
    uiAuditResult = JSON.parse(fs.readFileSync(uiCachePath, 'utf8'));
    log(`  ♻️  Loaded UI cache (${uiAuditResult.issues.length} issues) — skipping re-audit`);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // PHASE 4: BUG DIAGNOSIS (single batched Claude call)
  // ════════════════════════════════════════════════════════════════════════════
  log('  ── Phase 3: Bug analysis ──────────────────────────────────────');
  let diagnosedBugs = [];

  if (cfg.run.bugs) {
    const { allErrors, allNaNs, allTimedOut } = rawData.qa || {};
    const totalRaw = (allErrors?.length || 0) + (allNaNs?.length || 0) + (allTimedOut?.length || 0);

    if (totalRaw === 0) {
      log('  ✅ No bugs detected!');
    } else if (!hasApiKey) {
      log(`  ⚠️  ${totalRaw} issues found but no API key — skipping diagnosis`);
      diagnosedBugs = (allErrors || []).map(e => ({ ...e, diagnosis: null }));
    } else {
      log(`  🤖 Diagnosing bugs with Claude (single batch call)...`);
      const t1 = Date.now();
      diagnosedBugs = await analyzeBugs(allErrors || [], allNaNs || [], allTimedOut || [], cfg, gameContext);
      log(`  ✅ ${diagnosedBugs.length} unique bugs diagnosed in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
      // #run-focus: narrow to matching bug types so you can iterate on one class at a time
      if (focusArg) {
        const focusStr = focusArg.replace('--focus=', '').toLowerCase();
        const before = diagnosedBugs.length;
        diagnosedBugs = diagnosedBugs.filter(b =>
          (b.type || '').toLowerCase().includes(focusStr) ||
          (b.message || '').toLowerCase().includes(focusStr)
        );
        log(`  🔎 --focus=${focusStr} → ${diagnosedBugs.length} of ${before} bugs kept`);
      }

      // Discord pings for critical bugs
      const critical = diagnosedBugs.filter(b => b.diagnosis?.severity === 'CRITICAL');
      if (critical.length > 0 && cfg.discord.webhookUrl && cfg.discord.pingOn?.jsErrors) {
        log(`  🔔 Discord: pinging for ${critical.length} critical bug(s)...`);
        for (const bug of critical) await pingCriticalBug(bug, cfg);
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // PHASE 4: BALANCE ANALYSIS  (must run before anomaly/feature — they need aggStats)
  // ════════════════════════════════════════════════════════════════════════════
  log('  ── Phase 4: Balance analysis ──────────────────────────────────');
  let balanceAnalysis = '';
  let aggStats = {};

  if (rawData.factions?.length > 0) {
    aggStats = aggregateStats(rawData);

    // Quick terminal table
    log('\n  FACTION WIN RATES:');
    const sorted = [...rawData.factions].sort((a, b) => (aggStats[b]?.overallWinRate || 50) - (aggStats[a]?.overallWinRate || 50));
    for (const f of sorted) {
      const s = aggStats[f]; if (!s) continue;
      const flag = s.overallWinRate >= 55 ? '🔴' : s.overallWinRate <= 45 ? '🔵' : '⚪';
      const bar2 = '█'.repeat(Math.round(s.overallWinRate / 5)) + '░'.repeat(20 - Math.round(s.overallWinRate / 5));
      log(`  ${flag} ${f.padEnd(12)} ${String(s.overallWinRate).padStart(5)}%  ${bar2}`);
    }
    log('');

    if (hasApiKey && cfg.run.balance) {
      log('  🤖 Generating balance analysis...');
      try {
        balanceAnalysis = await analyzeBalance(rawData, aggStats, rawData.qa?.mechanicUsage, cfg, gameContext);
        log('  ✅ Balance analysis done');
      } catch (err) {
        log(`  ⚠️  Balance analysis failed: ${err.message}`);
      }
    }
  } else {
    log('  ℹ️  No balance data');
  }

  // ════════════════════════════════════════════════════════════════════════════
  // PHASE 5.5: ONLINE SYNC TEST
  // ════════════════════════════════════════════════════════════════════════════
  let onlineReport = null;
  if (!analyzeOnly && !skipOnline && cfg.run?.online !== false) {
    log('  ── Phase 4.5: Online sync test ────────────────────────────────');
    try {
      onlineReport = await runOnlineTests(gamePath, cfg);
      const g = onlineReport.overallGrade;
      const gradeIcon = g === 'A' ? '✅' : g === 'B' ? '🟡' : g === 'C' ? '🟠' : '🔴';
      log(`  ${gradeIcon} Online: grade ${g} · ${onlineReport.passedChecks}/${onlineReport.totalChecks} checks · ${onlineReport.issues.length} issue(s)`);
      if (onlineReport.issues.length > 0) {
        for (const issue of onlineReport.issues.slice(0, 3)) {
          log(`     [${issue.severity}] ${issue.message.slice(0, 70)}`);
        }
      }
    } catch (err) {
      log(`  ⚠️  Online test failed: ${err.message}`);
    }
    log('');
  } else if (analyzeOnly) {
    log('  ℹ️  Online test skipped (--analyze-only)');
  } else if (skipOnline) {
    log('  ℹ️  Online test skipped (--skip-online)');
  }

  // ════════════════════════════════════════════════════════════════════════════
  // PHASE 5.6: ANOMALY DETECTION
  // ════════════════════════════════════════════════════════════════════════════
  log('  ── Phase 4.6: Anomaly detection ───────────────────────────────');
  let anomalyReport = null;
  if (rawData.factions?.length > 0) {
    anomalyReport = detectAnomalies(rawData, aggStats, cfg);
    const icon = anomalyReport.hasCritical ? '🔴' : anomalyReport.anomalies.length > 0 ? '🟡' : '✅';
    log(`  ${icon} ${anomalyReport.summary}`);
    if (anomalyReport.hasCritical) {
      for (const a of anomalyReport.anomalies.filter(x => x.severity === 'HIGH').slice(0, 3)) {
        log(`     🔴 ${a.title}`);
      }
    }
  } else {
    log('  ℹ️  No game data — anomaly detection skipped');
  }
  log('');

  // ════════════════════════════════════════════════════════════════════════════
  // PHASE 4.7: FEATURE ADVISOR
  // ════════════════════════════════════════════════════════════════════════════
  log('  ── Phase 4.7: Feature advisor ─────────────────────────────────');
  let featureAdvice = null;
  if (cfg.run?.features !== false) {
    if (!hasApiKey) {
      log('  ⚠️  No API key — using heuristic feature suggestions');
    } else {
      log('  🤖 Generating feature suggestions with Claude...');
    }
    try {
      featureAdvice = await generateFeatureAdvice(rawData, aggStats, anomalyReport, onlineReport, uiAuditResult, diagnosedBugs, cfg, gameContext);
      log(`  ✅ ${featureAdvice.summary}`);
    } catch (err) {
      log(`  ⚠️  Feature advisor failed: ${err.message}`);
    }
  } else {
    log('  ℹ️  Feature advisor disabled in config');
  }
  log('');

  // ════════════════════════════════════════════════════════════════════════════
  // PHASE 4.8: VISION UI ANALYSIS (Claude analyses each screenshot)
  // ════════════════════════════════════════════════════════════════════════════
  let visionAnalysis = null;
  const ssCount = (uiAuditResult.screenshots || []).length;
  if (ssCount > 0 && hasApiKey && cfg.run?.vision !== false) {
    log('  ── Phase 4.8: Vision UI analysis ──────────────────────────────');
    log(`  👁️  Sending ${ssCount} screenshots to Claude for visual UX review...`);
    try {
      visionAnalysis = await analyzeScreenshotsWithVision(uiAuditResult.screenshots, cfg);
      const s = visionAnalysis.summary;
      log(`  ✅ Vision analysis: ${s.screensAnalyzed} screens · ${s.totalIssues} issues (${s.critical} critical, ${s.high} high)`);
    } catch (err) {
      log(`  ⚠️  Vision analysis failed: ${err.message}`);
    }
  } else if (ssCount === 0) {
    log('  ℹ️  No screenshots — vision analysis skipped');
  }
  log('');

  // ════════════════════════════════════════════════════════════════════════════
  // PHASE 6: BUILD REPORT
  // ════════════════════════════════════════════════════════════════════════════
  log('  ── Phase 5: Building report ───────────────────────────────────');

  // ── Save this run to history and compute diff vs previous run ────────────
  let runDiff = null;
  try {
    const snapshot = buildSnapshot(rawData, aggStats, diagnosedBugs, cfg);
    const history = saveToHistory(snapshot);
    const previous = history[1]; // history[0] = this run, history[1] = last run
    runDiff = computeDiff(snapshot, previous);
    if (history.length > 1) {
      log(`  📚 Run history: ${history.length} run(s) saved → qa-history.json`);
    } else {
      log(`  📚 First run saved to history — future runs will show a diff`);
    }
  } catch (err) {
    log(`  ⚠️  History save failed: ${err.message}`);
  }

  const reportData = { balanceData: rawData, aggStats, balanceAnalysis, diagnosedBugs, uiAuditResult, visionAnalysis, onlineReport, anomalyReport, featureAdvice, runDiff, cfg, runMeta: { startTime, endTime: Date.now() } };

  // Cache analysis data so --report-only can rebuild without API calls
  try {
    fs.writeFileSync(analysisCachePath, JSON.stringify(reportData, null, 2));
    log('  💾 Analysis cache saved → qa-analysis-cache.json');
  } catch (err) {
    log(`  ⚠️  Cache save failed: ${err.message}`);
  }

  const html = buildReport(reportData);
  const reportPath = path.resolve(cfg.output.reportPath || './qa-report.html');
  fs.writeFileSync(reportPath, html);
  log(`  ✅ Report saved → ${reportPath}`);

  // ════════════════════════════════════════════════════════════════════════════
  // PHASE 7: DISCORD
  // ════════════════════════════════════════════════════════════════════════════
  if (cfg.discord.webhookUrl) {
    log('  ── Phase 6: Discord ───────────────────────────────────────────');
    const totalSecs = Math.round((Date.now() - startTime) / 1000);
    const sortedFacs = Object.entries(aggStats).sort((a, b) => b[1].overallWinRate - a[1].overallWinRate);
    const top = sortedFacs.slice(0, 3).map(([f, s]) => `${f} (${s.overallWinRate}%)`).join(', ');
    const bot = sortedFacs.slice(-3).map(([f, s]) => `${f} (${s.overallWinRate}%)`).join(', ');
    const summary = [
      `**Done** in ${Math.floor(totalSecs / 60)}m${totalSecs % 60}s`,
      `📊 ${rawData.qa?.totalGamesRun || 0} games · ${diagnosedBugs.length} bugs · ${uiAuditResult.issues.length} UI issues`,
      '',
      top ? `**Top:** ${top}` : '',
      bot ? `**Weakest:** ${bot}` : '',
      '',
      diagnosedBugs.filter(b => b.diagnosis?.severity === 'CRITICAL').length > 0
        ? `🔴 **CRITICAL BUGS** — see report`
        : diagnosedBugs.length > 0 ? `⚠️ ${diagnosedBugs.length} bugs` : '✅ No bugs',
    ].filter(Boolean).join('\n');
    await sendFullReport(summary, reportPath, diagnosedBugs.length, cfg);
  } else {
    log('  ℹ️  Discord not configured');
  }

  // ════════════════════════════════════════════════════════════════════════════
  // DONE
  // ════════════════════════════════════════════════════════════════════════════
  const totalSecs = Math.round((Date.now() - startTime) / 1000);
  log('');
  // ── Terminal summary table ──────────────────────────────────────────────
  {
    const critCount = diagnosedBugs.filter(b => (b.diagnosis?.severity || '').toUpperCase() === 'CRITICAL').length;
    const highCount = diagnosedBugs.filter(b => (b.diagnosis?.severity || '').toUpperCase() === 'HIGH').length;
    const medCount = diagnosedBugs.filter(b => (b.diagnosis?.severity || '').toUpperCase() === 'MEDIUM').length;
    const lowCount = diagnosedBugs.filter(b => (b.diagnosis?.severity || '').toUpperCase() === 'LOW').length;
    const uiErrCount = (uiAuditResult.issues || []).filter(i => i.severity === 'error').length;
    const uiWrnCount = (uiAuditResult.issues || []).filter(i => i.severity === 'warning').length;

    // Top and bottom faction by overall win rate
    const sortedFacStats = Object.entries(aggStats).sort((a, b) => b[1].overallWinRate - a[1].overallWinRate);
    const topFac = sortedFacStats[0];
    const botFac = sortedFacStats[sortedFacStats.length - 1];

    // Most error-prone matchup
    const matchupErrorMap = {};
    for (const e of rawData.qa?.allErrors || []) {
      const k = e.matchup || 'unknown';
      matchupErrorMap[k] = (matchupErrorMap[k] || 0) + 1;
    }
    const topMatchup = Object.entries(matchupErrorMap).sort((a, b) => b[1] - a[1])[0];

    const T = totalSecs;
    log('');
    log('  ╔══════════════════════════════════════════════════════╗');
    log(`  ║  ✨ QA COMPLETE  ${String(Math.floor(T / 60) + 'm' + T % 60 + 's').padEnd(8)}                        ║`);
    log('  ╠══════════════════════════════════════════════════════╣');
    log(`  ║  🎮 Games       ${String(rawData.qa?.totalGamesRun || 0).padEnd(6)}  🐛 Bugs total  ${String(diagnosedBugs.length).padEnd(6)}║`);
    log(`  ║  🔴 Critical    ${String(critCount).padEnd(6)}  🟠 High        ${String(highCount).padEnd(6)}║`);
    log(`  ║  🟡 Medium      ${String(medCount).padEnd(6)}  🔵 Low         ${String(lowCount).padEnd(6)}║`);
    log(`  ║  🖼  UI errors   ${String(uiErrCount).padEnd(6)}  ⚠️  UI warnings ${String(uiWrnCount).padEnd(5)} ║`);
    if (topFac && botFac) {
      log('  ╠══════════════════════════════════════════════════════╣');
      log(`  ║  👑 Strongest   ${topFac[0].padEnd(12)} ${String(topFac[1].overallWinRate) + '%'.padEnd(8)}           ║`);
      log(`  ║  💀 Weakest     ${botFac[0].padEnd(12)} ${String(botFac[1].overallWinRate) + '%'.padEnd(8)}           ║`);
    }
    if (topMatchup) {
      log('  ╠══════════════════════════════════════════════════════╣');
      log(`  ║  🔥 Most errors ${topMatchup[0].slice(0, 20).padEnd(20)} ×${topMatchup[1]}  ║`);
    }
    log('  ╠══════════════════════════════════════════════════════╣');
    log(`  ║  📄 Report → ${path.basename(reportPath).padEnd(41)}║`);
    if (!noServer && process.stdout.isTTY && hasApiKey && diagnosedBugs.length > 0) {
      log(`  ║  🔧 Fix server → http://localhost:${FIX_PORT}${''.padEnd(17)}║`);
    }
    log('  ╚══════════════════════════════════════════════════════╝');
    log('');
  }

  // Print delta/diff vs last run
  const diffSummary = formatDiffSummary(runDiff);
  if (diffSummary) {
    log(diffSummary);
  }

  // Print critical prompts to terminal
  const critBugs = diagnosedBugs.filter(b => b.diagnosis?.pasteToClaudePrompt && b.diagnosis?.severity === 'CRITICAL');
  if (critBugs.length > 0) {
    log('  ══════════════════════════════════════════════════');
    log('  📋 CRITICAL BUGS — PASTE TO CLAUDE:');
    log('  ══════════════════════════════════════════════════');
    for (const bug of critBugs) {
      log(`\n  [${bug.type}]\n`);
      log(bug.diagnosis.pasteToClaudePrompt);
      log('');
    }
  }

  // Print balance prompt
  if (balanceAnalysis) {
    const bm = balanceAnalysis.match(/===BALANCE PROMPT START===([\s\S]+?)===BALANCE PROMPT END===/);
    if (bm) {
      log('  ══════════════════════════════════════════════════');
      log('  📋 BALANCE PATCH PROMPT:');
      log('  ══════════════════════════════════════════════════');
      log('');
      log(bm[1].trim());
      log('');
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // PHASE 8 (optional): AUTO-FIX  —  --auto-fix flag
  // Applies all HIGH + CRITICAL bug fixes non-interactively, with a backup first.
  // ════════════════════════════════════════════════════════════════════════════
  if (autoFix && hasApiKey && diagnosedBugs.length > 0) {
    const fixTargets = diagnosedBugs.filter(b => {
      const sev = (b.diagnosis?.severity || '').toUpperCase();
      return (sev === 'CRITICAL' || sev === 'HIGH') && b.diagnosis?.pasteToClaudePrompt;
    });

    if (fixTargets.length === 0) {
      log('  ℹ️  --auto-fix: no HIGH/CRITICAL bugs with prompts to fix');
    } else {
      log('');
      log(`  ── Auto-fix: applying ${fixTargets.length} HIGH/CRITICAL fix(es) ───────────`);
      log('');
      let applied = 0, skipped = 0, failed = 0;

      for (let i = 0; i < fixTargets.length; i++) {
        const bug = fixTargets[i];
        const sev = (bug.diagnosis?.severity || '').toUpperCase();
        process.stdout.write(`  [${i + 1}/${fixTargets.length}] ${sev} ${bug.type} — generating fix...`);

        const fixResult = await generateFix(bug, cfg.gamePath, cfg).catch(e => ({ ok: false, summary: e.message }));

        if (!fixResult.ok) {
          process.stdout.write(` ❌ skipped (${fixResult.summary})\n`);
          skipped++;
          continue;
        }

        process.stdout.write(` ${fixResult.confidence} confidence (${fixResult.linesChanged} lines) — applying...`);

        const applyResult = await applyDiff(fixResult.diff, cfg.gamePath).catch(e => ({ success: false, error: e.message }));

        if (!applyResult.success) {
          process.stdout.write(` ❌ failed: ${applyResult.error}\n`);
          failed++;
          continue;
        }

        process.stdout.write(` ✅ done\n`);
        log(`     Summary : ${fixResult.summary}`);
        log(`     Backup  : ${path.basename(applyResult.backupPath)}`);
        applied++;
      }

      log('');
      log(`  Auto-fix complete: ${applied} applied · ${skipped} skipped (low confidence) · ${failed} failed`);
      if (applied > 0) {
        log(`  ⚠️  Backups created alongside index.html — run QA again to verify fixes`);
      }
      log('');
    }
  } else if (autoFix && !hasApiKey) {
    log('  ⚠️  --auto-fix requires ANTHROPIC_API_KEY — skipped');
  }

  // ════════════════════════════════════════════════════════════════════════════
  // PHASE 9 (optional): LOCAL FIX SERVER
  // Keeps process alive on port 3742 so the HTML report's "Apply Fix" buttons
  // can call back to Node to generate and apply diffs without a separate step.
  // Skip with --no-server or when running in CI (no TTY).
  // ════════════════════════════════════════════════════════════════════════════
  const isTTY = process.stdout.isTTY;
  if (!noServer && isTTY && hasApiKey && diagnosedBugs.length > 0) {
    log(`  🔧 Fix server starting on http://localhost:${FIX_PORT}`);
    log(`     Open the report, click "Apply Fix" on any bug card.`);
    log(`     Press Ctrl+C to exit.\n`);

    _startFixServer(diagnosedBugs, cfg, FIX_PORT);
  } else if (!noServer && !isTTY) {
    // Non-interactive (CI/pipe) — silently skip the server
  } else if (noServer) {
    log('  ℹ️  Fix server skipped (--no-server)');
  }
}

// ── Local fix server ──────────────────────────────────────────────────────────

function _startFixServer(diagnosedBugs, cfg, port) {
  const server = http.createServer(async (req, res) => {
    // CORS so the local file:// report page can POST to localhost
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // ── GET /ping ──────────────────────────────────────────────────────────
    if (req.method === 'GET' && req.url === '/ping') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ alive: true, bugs: diagnosedBugs.length }));
      return;
    }

    // ── POST /fix  { bugIndex: number } ───────────────────────────────────
    if (req.method === 'POST' && req.url === '/fix') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        let bugIndex;
        try { bugIndex = JSON.parse(body).bugIndex; } catch (_) { bugIndex = -1; }

        const bug = diagnosedBugs[bugIndex];
        if (!bug) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, summary: `Bug index ${bugIndex} not found` }));
          return;
        }

        console.log(`  🔧 Generating fix for bug ${bugIndex}: ${bug.type}`);
        try {
          const fixResult = await generateFix(bug, cfg.gamePath, cfg);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(fixResult));
          if (fixResult.ok) {
            console.log(`     ✅ Fix ready (${fixResult.confidence}, ${fixResult.linesChanged} lines)`);
          } else {
            console.log(`     ⚠️  No fix: ${fixResult.summary}`);
          }
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, summary: err.message }));
        }
      });
      return;
    }

    // ── POST /fix-generic  { type, severity, message, suggestion, elementHint, searchHints } ──
    if (req.method === 'POST' && req.url === '/fix-generic') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        let issue;
        try { issue = JSON.parse(body); } catch (_) { issue = null; }
        if (!issue || !issue.message) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, summary: 'Invalid issue data' }));
          return;
        }

        console.log(`  🔧 Generating generic fix: ${(issue.type || 'issue').slice(0, 40)} — ${(issue.message || '').slice(0, 60)}`);
        try {
          const fixResult = await generateGenericFix(issue, cfg.gamePath, cfg);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(fixResult));
          if (fixResult.ok) {
            console.log(`     ✅ Fix ready (${fixResult.confidence}, ${fixResult.linesChanged} lines)`);
          } else {
            console.log(`     ⚠️  No fix: ${fixResult.summary}`);
          }
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, summary: err.message }));
        }
      });
      return;
    }

    // ── POST /apply  { diff: string } ─────────────────────────────────────
    if (req.method === 'POST' && req.url === '/apply') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        let diff = '';
        try { diff = JSON.parse(body).diff || ''; } catch (_) { }

        if (!diff) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'No diff provided' }));
          return;
        }

        console.log(`  🔧 Applying fix to ${cfg.gamePath}...`);
        try {
          const applyResult = await applyDiff(diff, cfg.gamePath);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(applyResult));
          if (applyResult.success) {
            console.log(`     ✅ Applied (backup: ${path.basename(applyResult.backupPath)})`);
          } else {
            console.log(`     ❌ Apply failed: ${applyResult.error}`);
          }
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      });
      return;
    }

    res.writeHead(404); res.end();
  });

  server.listen(port, '127.0.0.1', () => { });
  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.log(`  ⚠️  Port ${port} already in use — fix server not started`);
      console.log(`     Another run.js instance may already be serving fixes.`);
    } else {
      console.log(`  ⚠️  Fix server error: ${err.message}`);
    }
  });
}

main().catch(err => {
  console.error('\n❌ Fatal error:', err.message);
  console.error(err.stack);
  process.exit(1);
});