/**
 * reporter.js
 * Builds the master HTML report covering:
 *  - Bug reports (with paste-to-Claude prompts)
 *  - UI audit (with screenshots)
 *  - Mechanic usage
 *  - Performance
 *  - Balance matrix + analysis
 */

const fs   = require('fs');
const path = require('path');

const FACTION_ICONS = {
  warriors:'⚔️', summoners:'💀', brutes:'🪨', spirits:'✨',
  verdant:'🌿', infernal:'🔥', glacial:'❄️', voltborn:'⚡',
  bloodpact:'🩸', menders:'💚',
};

function buildReport({
  balanceData, aggStats, balanceAnalysis,
  diagnosedBugs, uiAuditResult,
  cfg, runMeta,
}) {
  const { results, factions, qa } = balanceData;
  const uiIssues   = uiAuditResult?.issues || [];
  const screenshots = uiAuditResult?.screenshots || [];

  const totalBugs = diagnosedBugs.length;
  const criticalBugs = diagnosedBugs.filter(b => b.diagnosis?.severity === 'CRITICAL' || b.severity === 'critical');
  const timestamp = new Date().toLocaleString();

  // ── Balance matrix ─────────────────────────────────────────────────────────
  let matrixHtml = `<table class="matrix"><thead><tr><th></th>`;
  for (const f of factions) matrixHtml += `<th title="${f}">${FACTION_ICONS[f]||'?'}</th>`;
  matrixHtml += `</tr></thead><tbody>`;
  for (const f1 of factions) {
    matrixHtml += `<tr><th class="row-label">${FACTION_ICONS[f1]||''} ${f1}</th>`;
    for (const f2 of factions) {
      if (f1 === f2) { matrixHtml += `<td class="self">—</td>`; continue; }
      const r = results[f1]?.[f2];
      if (!r) { matrixHtml += `<td>—</td>`; continue; }
      const games = r.p1Wins + r.p2Wins + r.draws + r.timeouts;
      const rate  = games > 0 ? Math.round(r.p1Wins / games * 100) : 50;
      const cls   = rate>=65?'hot':rate>=55?'warm':rate<=35?'cold':rate<=45?'cool':'neutral';
      matrixHtml += `<td class="${cls}" title="${f1} vs ${f2}: ${rate}% (${games}g)">${rate}%</td>`;
    }
    matrixHtml += `</tr>`;
  }
  matrixHtml += `</tbody></table>`;

  // ── Win rate bars ──────────────────────────────────────────────────────────
  const sortedF = [...factions].sort((a,b) => (aggStats[b]?.overallWinRate||50)-(aggStats[a]?.overallWinRate||50));
  let barsHtml = '';
  for (const f of sortedF) {
    const s = aggStats[f]; if (!s) continue;
    const wr = s.overallWinRate;
    const cls = wr>=55?'hot':wr<=45?'cold':'ok';
    const dur = `${Math.floor(s.avgGameDuration/60)}m${String(s.avgGameDuration%60).padStart(2,'0')}s`;
    barsHtml += `<div class="bar-row">
      <div class="bar-label-name">${FACTION_ICONS[f]||''} <strong>${f}</strong></div>
      <div class="bar-wrap"><div class="bar bar-${cls}" style="width:${Math.min(wr*1.8,100)}%"></div><span class="bar-pct">${wr}%</span></div>
      <div class="bar-meta">avg ${dur} · best: ${s.bestMatchup.faction||'?'} (${Math.round(s.bestMatchup.rate*100)}%) · worst: ${s.worstMatchup.faction||'?'} (${Math.round(s.worstMatchup.rate*100)}%)</div>
    </div>`;
  }

  // ── Bug cards ──────────────────────────────────────────────────────────────
  let bugsHtml = '';
  if (diagnosedBugs.length === 0) {
    bugsHtml = `<div class="no-issues">✅ No bugs detected across ${qa.totalGamesRun} games</div>`;
  } else {
    for (const bug of diagnosedBugs) {
      const sev = (bug.diagnosis?.severity || bug.severity || 'medium').toUpperCase();
      const sevCls = sev === 'CRITICAL' ? 'sev-critical' : sev === 'HIGH' ? 'sev-high' : sev === 'MEDIUM' ? 'sev-medium' : 'sev-low';
      const hasPrompt = bug.diagnosis?.pasteToClaudePrompt;
      bugsHtml += `
      <div class="bug-card ${sevCls}">
        <div class="bug-header">
          <span class="bug-sev ${sevCls}">${sev}</span>
          <span class="bug-type">${bug.type || 'error'}</span>
          <span class="bug-occ">×${bug.occurrences || 1}</span>
          <span class="bug-matchup">${(bug.matchups || [bug.matchup]).filter(Boolean).join(', ')}</span>
        </div>
        <div class="bug-message"><code>${escHtml(bug.message || '')}</code></div>
        ${bug.stack ? `<details><summary>Stack trace</summary><pre class="stack">${escHtml(bug.stack)}</pre></details>` : ''}
        ${bug.diagnosis?.likelyCause ? `<div class="bug-section"><strong>Likely Cause:</strong> ${escHtml(bug.diagnosis.likelyCause)}</div>` : ''}
        ${bug.diagnosis?.reproSteps  ? `<div class="bug-section"><strong>Repro Steps:</strong><br>${escHtml(bug.diagnosis.reproSteps).replace(/\n/g,'<br>')}</div>` : ''}
        ${bug.diagnosis?.suggestedFix? `<div class="bug-section"><strong>Suggested Fix:</strong> ${escHtml(bug.diagnosis.suggestedFix)}</div>` : ''}
        ${bug.diagnosis?.whereToLook ? `<div class="bug-section"><strong>Where to Look:</strong> ${escHtml(bug.diagnosis.whereToLook)}</div>` : ''}
        ${hasPrompt ? `<div class="paste-prompt"><div class="paste-label">📋 Paste this to Claude →</div><pre class="paste-text">${escHtml(bug.diagnosis.pasteToClaudePrompt)}</pre><button class="copy-btn" onclick="copyText(this)">Copy</button></div>` : ''}
        ${bug.screenshotPath ? `<div class="bug-section"><strong>Screenshot:</strong> <code>${bug.screenshotPath}</code></div>` : ''}
      </div>`;
    }
  }

  // ── UI issues ──────────────────────────────────────────────────────────────
  let uiHtml = '';
  const uiErrors   = uiIssues.filter(i => i.severity === 'error');
  const uiWarnings = uiIssues.filter(i => i.severity === 'warning');
  const uiInfos    = uiIssues.filter(i => i.severity === 'info');
  if (uiIssues.length === 0) {
    uiHtml = `<div class="no-issues">✅ No UI issues detected</div>`;
  } else {
    const renderIssueGroup = (issues, label, cls) => issues.length === 0 ? '' :
      `<h3 class="${cls}">${label} (${issues.length})</h3>` +
      issues.map(i => `<div class="ui-issue ${cls}">
        <span class="ui-type">${i.type}</span>
        <span class="ui-screen">${i.screen||''}</span>
        <span class="ui-vp">${i.viewportSize||i.viewport||''}</span>
        <div class="ui-msg">${escHtml(i.message||'')}</div>
        ${i.element ? `<code class="ui-el">${escHtml(i.element)}</code>` : ''}
      </div>`).join('');

    uiHtml = renderIssueGroup(uiErrors,'🔴 Errors','ui-error')
           + renderIssueGroup(uiWarnings,'🟡 Warnings','ui-warning')
           + renderIssueGroup(uiInfos,'ℹ️ Info','ui-info');
  }

  // ── Screenshots grid ───────────────────────────────────────────────────────
  let ssHtml = '';
  if (screenshots.length === 0) {
    ssHtml = `<p style="color:var(--dim)">No screenshots captured (enable saveScreenshots in config.js)</p>`;
  } else {
    // Group by screen
    const byScreen = {};
    for (const ss of screenshots) {
      if (!byScreen[ss.screen]) byScreen[ss.screen] = [];
      byScreen[ss.screen].push(ss);
    }
    for (const [screen, ssList] of Object.entries(byScreen)) {
      ssHtml += `<h3>${screen}</h3><div class="ss-grid">`;
      for (const ss of ssList) {
        const rel = path.relative(path.dirname(cfg.output.reportPath || './qa-report.html'), ss.path);
        ssHtml += `<div class="ss-card"><img src="${rel}" alt="${ss.viewport}" loading="lazy"><div class="ss-label">${ss.viewport} (${ss.width}×${ss.height})</div></div>`;
      }
      ssHtml += `</div>`;
    }
  }

  // ── Mechanics ──────────────────────────────────────────────────────────────
  let mechHtml = '';
  const totalGames = qa.totalGamesRun || 1;
  const threshold  = cfg.mechanics?.unusedThresholdPct || 15;
  for (const [key, count] of Object.entries(qa.mechanicUsage || {})) {
    const pct     = Math.round(count / totalGames * 100);
    const flagged = pct < threshold;
    const cls     = flagged ? 'mech-low' : 'mech-ok';
    mechHtml += `<div class="mech-row ${cls}">
      <span class="mech-key">${key.replace(/_/g,' ')}</span>
      <div class="mech-bar-wrap"><div class="mech-bar" style="width:${Math.min(pct*2,100)}%"></div></div>
      <span class="mech-pct">${pct}%</span>
      ${flagged ? `<span class="mech-flag">⚠️ rarely used</span>` : ''}
    </div>`;
  }

  // ── Performance ───────────────────────────────────────────────────────────
  const avgFtAll = qa.performance?.avgFrameMsAll || [];
  const avgAvgFt = avgFtAll.length > 0 ? Math.round(avgFtAll.reduce((a,b)=>a+b,0)/avgFtAll.length*10)/10 : 0;
  const maxFtAll = qa.performance?.maxFrameMsAll || [];
  const overallMaxFt = maxFtAll.length > 0 ? Math.max(...maxFtAll) : 0;
  const longTasks = qa.performance?.longTasksAll || [];
  const perfHtml = `
    <div class="stats-grid">
      <div class="stat-card ${avgAvgFt>33?'stat-bad':avgAvgFt>20?'stat-warn':'stat-ok'}">
        <div class="stat-num">${avgAvgFt}ms</div><div class="stat-lbl">Avg frame time</div>
      </div>
      <div class="stat-card ${overallMaxFt>200?'stat-bad':overallMaxFt>100?'stat-warn':'stat-ok'}">
        <div class="stat-num">${overallMaxFt}ms</div><div class="stat-lbl">Worst frame spike</div>
      </div>
      <div class="stat-card ${longTasks.length>10?'stat-bad':longTasks.length>3?'stat-warn':'stat-ok'}">
        <div class="stat-num">${longTasks.length}</div><div class="stat-lbl">Long tasks (>100ms)</div>
      </div>
    </div>
    ${longTasks.length > 0 ? `<details><summary>Long task details (${longTasks.length})</summary><pre>${longTasks.slice(0,20).map(t=>`${t.dt}ms in ${t.matchup||'unknown'}`).join('\n')}</pre></details>` : ''}`;

  // ── Balance analysis ───────────────────────────────────────────────────────
  const balHtml = balanceAnalysis
    ? mdToHtml(balanceAnalysis
        .replace(/===BALANCE PROMPT START===/g, '<div class="paste-prompt"><div class="paste-label">📋 Balance Patch Prompt → Paste to Claude</div><pre class="paste-text">')
        .replace(/===BALANCE PROMPT END===/g,   '</pre><button class="copy-btn" onclick="copyText(this)">Copy</button></div>'))
    : '<p style="color:var(--dim)">Balance analysis unavailable (no Anthropic API key)</p>';

  // ── Summary numbers ────────────────────────────────────────────────────────
  const softlockCount = qa.allTimedOut?.length || 0;
  const totalErrors   = qa.allErrors?.length   || 0;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Beyond RTS — QA Report</title>
<style>
:root{--bg:#0c0c0e;--surface:#14161a;--border:#252830;--gold:#f0a500;--text:#cdd3e0;--dim:#6b7280;--red:#e74c3c;--orange:#e67e22;--green:#27ae60;--blue:#3498db;--purple:#8e44ad;}
*{box-sizing:border-box;margin:0;padding:0;}
body{background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,sans-serif;font-size:14px;line-height:1.6;}
a{color:var(--gold);}
.header{background:linear-gradient(135deg,#1a0800,#0c0c0e);border-bottom:2px solid var(--gold);padding:28px 36px;display:flex;align-items:center;gap:20px;}
.header h1{font-size:1.8rem;color:var(--gold);letter-spacing:2px;text-transform:uppercase;}
.header .meta{color:var(--dim);font-size:12px;margin-top:4px;}
.nav{display:flex;gap:0;background:var(--surface);border-bottom:1px solid var(--border);overflow-x:auto;}
.nav a{padding:12px 20px;color:var(--dim);text-decoration:none;white-space:nowrap;border-bottom:2px solid transparent;font-size:13px;font-weight:600;letter-spacing:.5px;}
.nav a:hover,.nav a.active{color:var(--gold);border-bottom-color:var(--gold);}
.tab-content{display:none;} .tab-content.active{display:block;}
.container{max-width:1400px;margin:0 auto;padding:24px 20px;}
section{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:22px;margin-bottom:20px;}
h2{font-size:.95rem;text-transform:uppercase;letter-spacing:1px;color:var(--gold);border-bottom:1px solid var(--border);padding-bottom:8px;margin-bottom:16px;}
h3{color:var(--text);font-size:.95rem;margin:14px 0 8px;}
p,li{margin-bottom:8px;color:var(--text);}
code{background:#1e2028;padding:1px 6px;border-radius:3px;font-family:monospace;font-size:12px;color:#81ecec;}
pre{background:#0d0f14;border:1px solid var(--border);border-radius:6px;padding:14px;overflow-x:auto;font-size:12px;font-family:monospace;line-height:1.5;color:#b2f5ea;white-space:pre-wrap;}
strong{color:#fff;}
details>summary{cursor:pointer;color:var(--gold);margin:8px 0;}
.stats-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin-bottom:16px;}
.stat-card{background:#1a1c22;border:1px solid var(--border);border-radius:6px;padding:14px;text-align:center;}
.stat-card.stat-ok{border-color:#27ae6055;}.stat-card.stat-warn{border-color:#e67e2255;}.stat-card.stat-bad{border-color:#e74c3c55;}
.stat-num{font-size:1.6rem;font-weight:700;color:var(--gold);}
.stat-lbl{font-size:11px;color:var(--dim);margin-top:2px;}
/* matrix */
.matrix-scroll{overflow-x:auto;}
.matrix{border-collapse:collapse;font-size:12px;width:100%;}
.matrix th,.matrix td{padding:5px 7px;border:1px solid var(--border);text-align:center;white-space:nowrap;}
.matrix thead th{background:#1a1c22;color:var(--gold);font-size:15px;}
.matrix .row-label{background:#1a1c22;text-align:left;font-weight:600;min-width:120px;}
.matrix .self{color:var(--border);}
.hot{background:rgba(231,76,60,.3);color:#ff8080;font-weight:700;}
.warm{background:rgba(230,126,34,.2);color:#ffb347;}
.neutral{color:var(--dim);}
.cool{background:rgba(52,152,219,.15);color:#74b9ff;}
.cold{background:rgba(142,68,173,.3);color:#bf94e4;font-weight:700;}
/* bars */
.bar-row{display:flex;align-items:center;gap:12px;margin-bottom:10px;flex-wrap:wrap;}
.bar-label-name{min-width:120px;font-size:13px;}
.bar-wrap{display:flex;align-items:center;gap:8px;flex:1;min-width:160px;}
.bar{height:16px;border-radius:3px;min-width:2px;}
.bar-hot{background:var(--red);}.bar-ok{background:var(--green);}.bar-cold{background:var(--purple);}
.bar-pct{font-size:13px;font-weight:700;min-width:40px;}
.bar-meta{color:var(--dim);font-size:12px;width:100%;padding-left:132px;}
/* bugs */
.bug-card{border:1px solid var(--border);border-radius:8px;padding:16px;margin-bottom:14px;}
.bug-card.sev-critical{border-left:4px solid var(--red);background:rgba(231,76,60,.05);}
.bug-card.sev-high{border-left:4px solid var(--orange);}
.bug-card.sev-medium{border-left:4px solid #f1c40f;}
.bug-card.sev-low{border-left:4px solid var(--blue);}
.bug-header{display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap;}
.bug-sev{font-size:11px;font-weight:700;padding:2px 8px;border-radius:12px;letter-spacing:.5px;}
.sev-critical .bug-sev{background:rgba(231,76,60,.3);color:#ff8080;}
.sev-high .bug-sev{background:rgba(230,126,34,.3);color:#ffb347;}
.sev-medium .bug-sev{background:rgba(241,196,15,.2);color:#f1c40f;}
.sev-low .bug-sev{background:rgba(52,152,219,.2);color:#74b9ff;}
.bug-type{font-weight:600;}.bug-occ{color:var(--dim);font-size:12px;}
.bug-matchup{color:var(--dim);font-size:12px;margin-left:auto;}
.bug-message{margin-bottom:10px;font-size:13px;}
.bug-section{margin:8px 0;font-size:13px;}
.stack{font-size:11px;max-height:200px;overflow-y:auto;margin-top:6px;}
.no-issues{padding:20px;text-align:center;color:var(--green);font-weight:600;}
/* paste prompt */
.paste-prompt{background:#0a1628;border:2px solid var(--gold);border-radius:8px;padding:16px;margin:14px 0;}
.paste-label{color:var(--gold);font-weight:700;font-size:13px;margin-bottom:10px;letter-spacing:.5px;}
.paste-text{font-size:12px;color:#b2f5ea;white-space:pre-wrap;max-height:300px;overflow-y:auto;}
.copy-btn{margin-top:8px;background:#1a2d4a;border:1px solid var(--gold);color:var(--gold);padding:6px 14px;border-radius:4px;cursor:pointer;font-size:12px;font-family:inherit;}
.copy-btn:hover{background:var(--gold);color:#000;}
/* ui issues */
.ui-issue{border:1px solid var(--border);border-radius:6px;padding:12px;margin-bottom:8px;display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start;}
.ui-issue.ui-error{border-left:3px solid var(--red);}
.ui-issue.ui-warning{border-left:3px solid var(--orange);}
.ui-issue.ui-info{border-left:3px solid var(--blue);}
.ui-type{font-weight:600;font-size:12px;}.ui-screen,.ui-vp{color:var(--dim);font-size:12px;}
.ui-msg{width:100%;font-size:13px;}.ui-el{display:block;margin-top:4px;}
.ui-error h3{color:var(--red);}.ui-warning h3{color:var(--orange);}.ui-info h3{color:var(--blue);}
/* screenshots */
.ss-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;margin-bottom:16px;}
.ss-card{border:1px solid var(--border);border-radius:6px;overflow:hidden;}
.ss-card img{width:100%;height:180px;object-fit:cover;display:block;background:#111;}
.ss-label{padding:6px 10px;font-size:12px;color:var(--dim);background:var(--surface);}
/* mechanics */
.mech-row{display:flex;align-items:center;gap:12px;margin-bottom:8px;flex-wrap:wrap;}
.mech-key{min-width:180px;font-size:13px;text-transform:capitalize;}
.mech-bar-wrap{flex:1;min-width:100px;background:#1a1c22;border-radius:3px;height:12px;}
.mech-bar{height:12px;border-radius:3px;background:var(--green);}
.mech-low .mech-bar{background:var(--orange);}
.mech-pct{min-width:40px;font-size:13px;font-weight:600;}
.mech-flag{color:var(--orange);font-size:12px;}
.legend{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:12px;font-size:12px;}
.legend span{display:flex;align-items:center;gap:5px;}
.ld{width:10px;height:10px;border-radius:2px;}
</style>
</head>
<body>
<div class="header">
  <div>
    <h1>⚔ Beyond RTS — QA Report</h1>
    <div class="meta">
      ${timestamp} · ${qa.totalGamesRun} games · ${cfg.balance.aiDifficulty} AI · ${factions.length} factions ·
      ${totalBugs > 0 ? `<span style="color:var(--red)">⚠ ${totalBugs} bugs</span>` : '<span style="color:var(--green)">✅ 0 bugs</span>'} ·
      ${uiIssues.length} UI issues · ${softlockCount} softlocks
    </div>
  </div>
</div>

<nav class="nav">
  <a href="#" class="active" onclick="showTab('overview',this)">Overview</a>
  <a href="#" onclick="showTab('bugs',this)">🐛 Bugs${totalBugs?` (${totalBugs})`:''}${criticalBugs.length?` 🔴`:'✅'}</a>
  <a href="#" onclick="showTab('ui',this)">🖼 UI${uiIssues.length?` (${uiIssues.length})`:'✅'}</a>
  <a href="#" onclick="showTab('mechanics',this)">⚙️ Mechanics</a>
  <a href="#" onclick="showTab('performance',this)">📊 Performance</a>
  <a href="#" onclick="showTab('balance',this)">⚔️ Balance</a>
</nav>

<div class="container">

<!-- OVERVIEW -->
<div id="tab-overview" class="tab-content active">
  <section>
    <h2>Summary</h2>
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-num">${qa.totalGamesRun}</div><div class="stat-lbl">Games Played</div></div>
      <div class="stat-card ${criticalBugs.length>0?'stat-bad':totalBugs>0?'stat-warn':'stat-ok'}"><div class="stat-num">${totalBugs}</div><div class="stat-lbl">Bugs Found</div></div>
      <div class="stat-card ${softlockCount>0?'stat-bad':'stat-ok'}"><div class="stat-num">${softlockCount}</div><div class="stat-lbl">Softlocks</div></div>
      <div class="stat-card ${uiErrors.length>0?'stat-bad':'stat-ok'}"><div class="stat-num">${uiIssues.length}</div><div class="stat-lbl">UI Issues</div></div>
      <div class="stat-card"><div class="stat-num">${screenshots.length}</div><div class="stat-lbl">Screenshots</div></div>
      <div class="stat-card ${qa.allNaNs?.length>0?'stat-bad':'stat-ok'}"><div class="stat-num">${qa.allNaNs?.length||0}</div><div class="stat-lbl">NaN Events</div></div>
    </div>
  </section>
  ${criticalBugs.length > 0 ? `<section style="border-color:var(--red)"><h2 style="color:var(--red)">🔴 Critical Issues Requiring Immediate Attention</h2>${criticalBugs.map(b=>`<div class="bug-card sev-critical"><div class="bug-header"><span class="bug-sev sev-critical">CRITICAL</span><span class="bug-type">${b.type}</span><span class="bug-matchup">${(b.matchups||[]).join(', ')}</span></div><div class="bug-message"><code>${escHtml(b.message||'')}</code></div>${b.diagnosis?.pasteToClaudePrompt?`<div class="paste-prompt"><div class="paste-label">📋 Paste to Claude →</div><pre class="paste-text">${escHtml(b.diagnosis.pasteToClaudePrompt)}</pre><button class="copy-btn" onclick="copyText(this)">Copy</button></div>`:''}</div>`).join('')}</section>` : ''}
</div>

<!-- BUGS -->
<div id="tab-bugs" class="tab-content">
  <section><h2>🐛 Bug Reports (${diagnosedBugs.length})</h2>${bugsHtml}</section>
</div>

<!-- UI -->
<div id="tab-ui" class="tab-content">
  <section><h2>📸 Screenshots</h2>${ssHtml}</section>
  <section><h2>🔍 UI Issues (${uiIssues.length})</h2>${uiHtml}</section>
</div>

<!-- MECHANICS -->
<div id="tab-mechanics" class="tab-content">
  <section>
    <h2>⚙️ Mechanic Usage</h2>
    <p style="color:var(--dim);margin-bottom:14px;font-size:13px;">Percentage of games where this mechanic was used at least once. Under ${cfg.mechanics?.unusedThresholdPct||15}% is flagged as potentially broken or undiscoverable.</p>
    ${mechHtml}
  </section>
</div>

<!-- PERFORMANCE -->
<div id="tab-performance" class="tab-content">
  <section><h2>📊 Performance</h2>${perfHtml}</section>
</div>

<!-- BALANCE -->
<div id="tab-balance" class="tab-content">
  <section><h2>📈 Win Rates</h2>${barsHtml}</section>
  <section>
    <h2>🗺 Matchup Matrix</h2>
    <div class="legend">
      <span><span class="ld" style="background:rgba(231,76,60,.5)"></span>≥65% favored</span>
      <span><span class="ld" style="background:rgba(230,126,34,.3)"></span>55-64%</span>
      <span><span class="ld" style="background:#252830"></span>45-54% balanced</span>
      <span><span class="ld" style="background:rgba(52,152,219,.25)"></span>35-44%</span>
      <span><span class="ld" style="background:rgba(142,68,173,.35)"></span>≤34% unfavored</span>
    </div>
    <div class="matrix-scroll">${matrixHtml}</div>
  </section>
  <section><h2>🤖 AI Balance Analysis</h2><div class="analysis">${balHtml}</div></section>
</div>

</div><!-- /container -->

<script>
function showTab(id, el) {
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.nav a').forEach(a => a.classList.remove('active'));
  document.getElementById('tab-'+id).classList.add('active');
  el.classList.add('active');
  return false;
}
function copyText(btn) {
  const pre = btn.previousElementSibling;
  navigator.clipboard.writeText(pre.textContent).then(() => {
    btn.textContent = '✅ Copied!';
    setTimeout(() => btn.textContent = 'Copy', 2000);
  });
}
</script>
</body>
</html>`;

  return html;
}

function mdToHtml(text) {
  return text
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[HIGH\]/g,'<span style="color:var(--red);font-weight:700;">[HIGH]</span>')
    .replace(/\[MED\]/g, '<span style="color:var(--orange);font-weight:700;">[MED]</span>')
    .replace(/\[LOW\]/g, '<span style="color:var(--blue);font-weight:700;">[LOW]</span>')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/^(?!<[hp])/gm, '');
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

module.exports = { buildReport };
