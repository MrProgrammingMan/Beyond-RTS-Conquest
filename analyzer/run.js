#!/usr/bin/env node
/**
 * run.js — Beyond RTS Conquest QA System
 *
 * Usage:
 *   node run.js                          full run (games + UI + analysis + report)
 *   node run.js --analyze-only           re-analyze saved qa-data.json (no games)
 *   node run.js --skip-balance           skip matchup games (UI + bugs only)
 *   node run.js --skip-ui                skip UI audit (games only)
 *   node run.js --factions=a,b,c         only test these factions
 *   node run.js --games=N                override gamesPerMatchup
 *   node run.js --quick                  5 factions × 2 games (fast sanity check)
 */

require('dotenv').config();

const cfg = require('./config');
const { runAllMatchups, aggregateStats } = require('./matchup-runner');
const { runUiAudit } = require('./ui-auditor');
const { analyzeBugs } = require('./bug-analyzer');
const { analyzeBalance } = require('./balance-analyzer');
const { buildReport } = require('./reporter');
const { pingCriticalBug, sendFullReport } = require('./discord');

const { chromium, executablePath } = require('playwright');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const analyzeOnly = args.includes('--analyze-only');
const skipBalance = args.includes('--skip-balance');
const skipUi = args.includes('--skip-ui');
const quickMode = args.includes('--quick');
const factionsArg = args.find(a => a.startsWith('--factions='));
const gamesArg = args.find(a => a.startsWith('--games='));

if (quickMode) {
  cfg.balance.factionFilter = ['warriors', 'summoners', 'brutes', 'spirits', 'infernal'];
  cfg.balance.gamesPerMatchup = 2;
  cfg.balance.parallelGames = 3;
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
  if (!analyzeOnly && !fs.existsSync(gamePath)) {
    log(`  ❌  Game file not found: ${gamePath}`);
    log(`      Set gamePath in config.js`);
    process.exit(1);
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
  if (!analyzeOnly && !skipBalance && cfg.run.balance) {
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

  } else if (analyzeOnly) {
    const p = path.resolve(cfg.output.rawDataPath || './qa-data.json');
    if (!fs.existsSync(p)) { log(`  ❌  No data at ${p} — run without --analyze-only first`); process.exit(1); }
    rawData = JSON.parse(fs.readFileSync(p, 'utf8'));
    log(`  📂 Loaded saved data (${rawData.qa?.totalGamesRun} games)`);
  } else {
    rawData = { results: {}, factions: [], qa: { allErrors: [], allNaNs: [], allTimedOut: [], mechanicUsage: {}, performance: {}, totalGamesRun: 0 } };
  }

  // ════════════════════════════════════════════════════════════════════════════
  // PHASE 3: UI AUDIT
  // ════════════════════════════════════════════════════════════════════════════
  if (!analyzeOnly && !skipUi && cfg.run.ui) {
    log('  ── Phase 2: UI audit ──────────────────────────────────────────');
    const browser = await chromium.launch({ headless: true });
    try {
      uiAuditResult = await runUiAudit(gamePath, cfg, browser);
      log(`  ✅ UI audit: ${uiAuditResult.screenshots.length} screenshots · ${uiAuditResult.issues.length} issues`);
    } catch (err) {
      log(`  ⚠️  UI audit failed: ${err.message}`);
    } finally {
      await browser.close();
    }
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
      diagnosedBugs = await analyzeBugs(allErrors || [], allNaNs || [], allTimedOut || [], cfg);
      log(`  ✅ ${diagnosedBugs.length} unique bugs diagnosed in ${((Date.now() - t1) / 1000).toFixed(1)}s`);

      // Discord pings for critical bugs
      const critical = diagnosedBugs.filter(b => b.diagnosis?.severity === 'CRITICAL');
      if (critical.length > 0 && cfg.discord.webhookUrl && cfg.discord.pingOn?.jsErrors) {
        log(`  🔔 Discord: pinging for ${critical.length} critical bug(s)...`);
        for (const bug of critical) await pingCriticalBug(bug, cfg);
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // PHASE 5: BALANCE ANALYSIS
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
        balanceAnalysis = await analyzeBalance(rawData, aggStats, rawData.qa?.mechanicUsage, cfg);
        log('  ✅ Balance analysis done');
      } catch (err) {
        log(`  ⚠️  Balance analysis failed: ${err.message}`);
      }
    }
  } else {
    log('  ℹ️  No balance data');
  }

  // ════════════════════════════════════════════════════════════════════════════
  // PHASE 6: BUILD REPORT
  // ════════════════════════════════════════════════════════════════════════════
  log('  ── Phase 5: Building report ───────────────────────────────────');

  const html = buildReport({ balanceData: rawData, aggStats, balanceAnalysis, diagnosedBugs, uiAuditResult, cfg, runMeta: { startTime, endTime: Date.now() } });
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
  log(`  ✨ Done in ${Math.floor(totalSecs / 60)}m${totalSecs % 60}s  →  open ${path.basename(reportPath)} in browser`);
  log('');

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
}

main().catch(err => {
  console.error('\n❌ Fatal error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
