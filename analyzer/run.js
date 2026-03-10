#!/usr/bin/env node
/**
 * run.js — Beyond RTS Conquest QA System
 *
 * Usage:
 *   node run.js                          full run (games + UI + analysis + report)
 *   node run.js --analyze-only           re-analyze saved qa-data.json
 *   node run.js --skip-balance           skip matchup games (UI + bugs only)
 *   node run.js --skip-ui                skip UI audit
 *   node run.js --factions=a,b,c         only test these factions
 *   node run.js --games=3                override gamesPerMatchup
 */

const cfg = require('./config');
const { runAllMatchups, aggregateStats } = require('./matchup-runner');
const { runUiAudit } = require('./ui-auditor');
const { analyzeBugs } = require('./bug-analyzer');
const { analyzeBalance } = require('./balance-analyzer');
const { buildReport } = require('./reporter');
const { pingCriticalBug, sendFullReport } = require('./discord');

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const analyzeOnly = args.includes('--analyze-only');
const skipBalance = args.includes('--skip-balance');
const skipUi = args.includes('--skip-ui');
const factionsArg = args.find(a => a.startsWith('--factions='));
const gamesArg = args.find(a => a.startsWith('--games='));

if (factionsArg) cfg.balance.factionFilter = factionsArg.replace('--factions=', '').split(',').map(s => s.trim());
if (gamesArg) cfg.balance.gamesPerMatchup = parseInt(gamesArg.replace('--games=', '')) || cfg.balance.gamesPerMatchup;

const hasApiKey = cfg.anthropicApiKey && cfg.anthropicApiKey !== 'YOUR_API_KEY_HERE';

// ── Utils ─────────────────────────────────────────────────────────────────────
const log = (...a) => console.log(...a);
function bar(done, total, w = 28) {
  const p = done / total, f = Math.round(p * w);
  return `[${'█'.repeat(f)}${'░'.repeat(w - f)}] ${done}/${total} (${Math.round(p * 100)}%)`;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.clear();
  log('');
  log('  ⚔  BEYOND RTS CONQUEST — QA SYSTEM  ⚔');
  log('  ───────────────────────────────────────');
  log('');

  const gamePath = path.resolve(cfg.gamePath);
  if (!analyzeOnly && !fs.existsSync(gamePath)) {
    log(`  ❌  Game file not found: ${gamePath}`);
    log(`      Set gamePath in config.js`);
    process.exit(1);
  }

  log(`  Game:    ${gamePath}`);
  log(`  Modules: ${Object.entries(cfg.run).filter(([, v]) => v).map(([k]) => k).join(' · ')}`);
  log(`  Discord: ${cfg.discord.webhookUrl ? '✅ configured' : '❌ not configured'}`);
  log(`  Claude:  ${hasApiKey ? '✅ API key set' : '❌ no API key (analysis skipped)'}`);
  log('');

  const ssDir = path.resolve(cfg.output.screenshotsDir || './screenshots');
  if (cfg.output.saveScreenshots) fs.mkdirSync(ssDir, { recursive: true });

  let rawData = null;
  let uiAuditResult = { issues: [], screenshots: [] };
  const startTime = Date.now();

  // ════════════════════════════════════════════════════════════════════════════
  // PHASE 1: INSTALL BROWSER
  // ════════════════════════════════════════════════════════════════════════════
  if (!analyzeOnly) {
    try {
      const { execSync } = require('child_process');
      execSync('npx playwright install chromium --with-deps 2>/dev/null', { stdio: 'ignore' });
    } catch (_) { }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // PHASE 2: BALANCE + BUG GAMES
  // ════════════════════════════════════════════════════════════════════════════
  if (!analyzeOnly && !skipBalance && cfg.run.balance) {
    log('  ── Phase 1: Running AI vs AI games ────────────────────────────────');
    log('');

    const live = [];
    const t0 = Date.now();

    rawData = await runAllMatchups(cfg, ({ done, total, latest }) => {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      const eta = done > 0 ? Math.round((Date.now() - t0) / done * (total - done) / 1000) : '?';
      const etaStr = isNaN(eta) || eta > 3600 ? '?s' : eta > 60 ? `${Math.floor(eta / 60)}m${eta % 60}s` : `${eta}s`;
      const icon = latest.timedOut ? '⏱' : latest.hasErrors ? '🐛' : latest.hasNaN ? '⚡' : latest.result.includes('wins') ? '✅' : '🤝';
      const errStr = latest.hasErrors && latest.firstError
        ? ` ↳ ${latest.firstError}`
        : latest.hasErrors ? ' [ERRORS]' : '';
      live.unshift(`  ${icon} ${latest.p1} vs ${latest.p2} → ${latest.result}${errStr}`);
      if (live.length > 4) live.pop();
      process.stdout.write(`\r\x1b[K  ${bar(done, total)}  ETA:${etaStr}  ${elapsed}s elapsed\n${live.join('\n')}\x1b[${live.length + 1}A`);

      // Immediate Discord ping for critical bugs
      if (cfg.run.bugs && cfg.discord.webhookUrl) {
        // Check for new errors in latest game — handled in matchup-runner via QA aggregation
        // Real-time pings happen in a post-game hook (see below)
      }
    });

    process.stdout.write(`\x1b[${6}B\n`);
    log('');
    log(`  ✅ Games complete (${rawData.qa.totalGamesRun} total, ${rawData.qa.allErrors.length} errors found, ${rawData.qa.allTimedOut.length} softlocks)`);

    // ── Print top unique errors immediately so you don't have to wait for the report ──
    if (rawData.qa.allErrors.length > 0) {
      // Deduplicate by first 100 chars of message
      const seen = new Set();
      const topErrors = [];
      for (const e of rawData.qa.allErrors) {
        const key = (e.message || '').slice(0, 100);
        if (!seen.has(key)) {
          seen.add(key);
          topErrors.push(e);
          if (topErrors.length >= 8) break;
        }
      }
      log('');
      log(`  🔍 TOP UNIQUE ERRORS (${seen.size} of ${rawData.qa.allErrors.length} total):`);
      for (const e of topErrors) {
        const matchup = e.matchup || '?';
        const msg = (e.message || 'no message').replace(/\n/g, ' ').slice(0, 100);
        log(`     [${matchup}]  ${msg}`);
        if (e.stack) {
          const firstLine = e.stack.split('\n').find(l => l.includes('.html') || l.includes('at ')) || '';
          if (firstLine) log(`       at ${firstLine.trim().slice(0, 90)}`);
        }
      }
      log('');
    }

    if (cfg.output.saveRawData) {
      fs.writeFileSync(path.resolve(cfg.output.rawDataPath || './qa-data.json'), JSON.stringify(rawData, null, 2));
      log(`  💾 Raw data saved`);
    }
  } else if (analyzeOnly) {
    const p = path.resolve(cfg.output.rawDataPath || './qa-data.json');
    if (!fs.existsSync(p)) { log(`  ❌  No saved data at ${p}`); process.exit(1); }
    rawData = JSON.parse(fs.readFileSync(p, 'utf8'));
    log(`  📂 Loaded saved data (${rawData.qa?.totalGamesRun} games)`);
  } else {
    // Minimal stub for UI-only run
    rawData = { results: {}, factions: [], qa: { allErrors: [], allNaNs: [], allTimedOut: [], mechanicUsage: {}, performance: {}, totalGamesRun: 0 } };
  }

  // ════════════════════════════════════════════════════════════════════════════
  // PHASE 3: UI AUDIT
  // ════════════════════════════════════════════════════════════════════════════
  if (!analyzeOnly && !skipUi && cfg.run.ui) {
    log('  ── Phase 2: UI audit ──────────────────────────────────────────────');
    const browser = await chromium.launch({ headless: true });
    try {
      uiAuditResult = await runUiAudit(gamePath, cfg, browser);
      log(`  ✅ UI audit done (${uiAuditResult.screenshots.length} screenshots, ${uiAuditResult.issues.length} issues)`);
    } catch (err) {
      log(`  ⚠️  UI audit failed: ${err.message}`);
    } finally {
      await browser.close();
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // PHASE 4: BUG DIAGNOSIS
  // ════════════════════════════════════════════════════════════════════════════
  log('  ── Phase 3: Bug analysis ──────────────────────────────────────────');
  let diagnosedBugs = [];

  if (cfg.run.bugs) {
    const allErrors = rawData.qa?.allErrors || [];
    const allNaNs = rawData.qa?.allNaNs || [];
    const allTimedOut = rawData.qa?.allTimedOut || [];
    const totalBugsRaw = allErrors.length + allNaNs.length + allTimedOut.length;

    if (totalBugsRaw === 0) {
      log('  ✅ No bugs detected!');
    } else if (!hasApiKey) {
      log(`  ⚠️  ${totalBugsRaw} issues found but no API key — skipping diagnosis`);
      diagnosedBugs = allErrors.map(e => ({ ...e, diagnosis: null }));
    } else {
      log(`  🤖 Diagnosing ${totalBugsRaw} issues with Claude...`);
      diagnosedBugs = await analyzeBugs(allErrors, allNaNs, allTimedOut, cfg);
      log(`  ✅ ${diagnosedBugs.length} unique bugs diagnosed`);

      // Send immediate Discord pings for critical bugs
      const critical = diagnosedBugs.filter(b => b.diagnosis?.severity === 'CRITICAL');
      if (critical.length > 0 && cfg.discord.webhookUrl && cfg.discord.pingOn?.jsErrors) {
        log(`  🔔 Pinging Discord for ${critical.length} critical bug(s)...`);
        for (const bug of critical) {
          await pingCriticalBug(bug, cfg);
        }
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // PHASE 5: BALANCE ANALYSIS
  // ════════════════════════════════════════════════════════════════════════════
  log('  ── Phase 4: Balance analysis ──────────────────────────────────────');
  let balanceAnalysis = '';
  let aggStats = {};

  if (rawData.factions?.length > 0) {
    aggStats = aggregateStats(rawData);

    // Print quick terminal table
    log('\n  FACTION WIN RATES:');
    const sorted = [...rawData.factions].sort((a, b) => (aggStats[b]?.overallWinRate || 50) - (aggStats[a]?.overallWinRate || 50));
    for (const f of sorted) {
      const s = aggStats[f]; if (!s) continue;
      const flag = s.overallWinRate >= 55 ? '🔴' : s.overallWinRate <= 45 ? '🔵' : '⚪';
      log(`  ${flag} ${f.padEnd(12)} ${String(s.overallWinRate).padStart(5)}%`);
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
    log('  ℹ️  No balance data to analyze');
  }

  // ════════════════════════════════════════════════════════════════════════════
  // PHASE 6: BUILD REPORT
  // ════════════════════════════════════════════════════════════════════════════
  log('  ── Phase 5: Building report ───────────────────────────────────────');

  const html = buildReport({
    balanceData: rawData,
    aggStats,
    balanceAnalysis,
    diagnosedBugs,
    uiAuditResult,
    cfg,
    runMeta: { startTime, endTime: Date.now() },
  });

  const reportPath = path.resolve(cfg.output.reportPath || './qa-report.html');
  fs.writeFileSync(reportPath, html);
  log(`  ✅ Report saved → ${reportPath}`);
  log(`     Open in browser to view (has tabs, screenshots, copy buttons)`);

  // ════════════════════════════════════════════════════════════════════════════
  // PHASE 7: DISCORD DELIVERY
  // ════════════════════════════════════════════════════════════════════════════
  if (cfg.discord.webhookUrl) {
    log('  ── Phase 6: Sending to Discord ────────────────────────────────────');
    const totalSecs = Math.round((Date.now() - startTime) / 1000);
    const sortedFacs = Object.entries(aggStats).sort((a, b) => b[1].overallWinRate - a[1].overallWinRate);
    const top = sortedFacs.slice(0, 3).map(([f, s]) => `${f} (${s.overallWinRate}%)`).join(', ');
    const bot = sortedFacs.slice(-3).map(([f, s]) => `${f} (${s.overallWinRate}%)`).join(', ');

    const summary = [
      `**Run complete** in ${Math.floor(totalSecs / 60)}m${totalSecs % 60}s`,
      `📊 ${rawData.qa?.totalGamesRun || 0} games · ${diagnosedBugs.length} bugs · ${uiAuditResult.issues.length} UI issues`,
      '',
      top ? `**Top factions:** ${top}` : '',
      bot ? `**Weakest:** ${bot}` : '',
      '',
      diagnosedBugs.filter(b => b.diagnosis?.severity === 'CRITICAL').length > 0
        ? `🔴 **CRITICAL BUGS FOUND** — see report`
        : diagnosedBugs.length > 0 ? `⚠️ ${diagnosedBugs.length} non-critical bugs found` : '✅ No bugs',
    ].filter(Boolean).join('\n');

    await sendFullReport(summary, reportPath, diagnosedBugs.length, cfg);
  } else {
    log('  ℹ️  Discord not configured — set discord.webhookUrl in config.js');
  }

  // ════════════════════════════════════════════════════════════════════════════
  // DONE
  // ════════════════════════════════════════════════════════════════════════════
  const totalSecs = Math.round((Date.now() - startTime) / 1000);
  log('');
  log(`  ✨ Done in ${Math.floor(totalSecs / 60)}m${totalSecs % 60}s`);
  log('');

  // Print any critical paste-to-Claude prompts
  const critBugs = diagnosedBugs.filter(b => b.diagnosis?.pasteToClaudePrompt && b.diagnosis?.severity === 'CRITICAL');
  if (critBugs.length > 0) {
    log('  ═══════════════════════════════════════════════════');
    log('  📋 CRITICAL BUGS — PASTE THESE TO CLAUDE:');
    log('  ═══════════════════════════════════════════════════');
    for (const bug of critBugs) {
      log('');
      log(`  [${bug.type}]`);
      log(bug.diagnosis.pasteToClaudePrompt);
      log('');
    }
  }

  // Print balance prompt if available
  if (balanceAnalysis) {
    const bm = balanceAnalysis.match(/===BALANCE PROMPT START===([\s\S]+?)===BALANCE PROMPT END===/);
    if (bm) {
      log('  ═══════════════════════════════════════════════════');
      log('  📋 BALANCE PATCH PROMPT — PASTE TO CLAUDE:');
      log('  ═══════════════════════════════════════════════════');
      log('');
      log(bm[1].trim());
      log('');
    }
  }
}

main().catch(err => {
  console.error('\n❌ Fatal:', err);
  process.exit(1);
});