/**
 * reporter.js — Beyond RTS QA Report Builder
 *
 * Improvements over old version:
 *  - Screenshots embedded as base64 (self-contained HTML, no broken paths)
 *  - Lightbox modal for full-size screenshot viewing
 *  - New "Prompts" tab with ALL paste-to-Claude prompts in one place
 *  - Bug search/filter by severity
 *  - Collapsible bug details
 *  - Unified "Copy All Bugs" mega-prompt button
 *  - Better balance matrix with hover tooltips
 *  - mdToHtml improvements (handles lists, blockquotes)
 */

const fs = require('fs');
const path = require('path');

const FACTION_ICONS = {
  warriors: '⚔️', summoners: '💀', brutes: '🪨', spirits: '✨',
  verdant: '🌿', infernal: '🔥', glacial: '❄️', voltborn: '⚡',
  bloodpact: '🩸', menders: '💚',
};

function buildReport({ balanceData, aggStats, balanceAnalysis, diagnosedBugs, uiAuditResult, onlineReport, anomalyReport, featureAdvice, cfg, runMeta }) {
  const { results, factions, qa } = balanceData;
  const uiIssues = uiAuditResult?.issues || [];
  const screenshots = uiAuditResult?.screenshots || [];
  const totalBugs = diagnosedBugs.length;
  const criticalBugs = diagnosedBugs.filter(b => ['CRITICAL'].includes((b.diagnosis?.severity || b.severity || '').toUpperCase()));
  const timestamp = new Date().toLocaleString();
  const runDurSec = Math.round(((runMeta?.endTime || Date.now()) - (runMeta?.startTime || Date.now())) / 1000);
  const runDurStr = runDurSec > 60 ? `${Math.floor(runDurSec / 60)}m ${runDurSec % 60}s` : `${runDurSec}s`;
  const inlineScreenshots = cfg.output?.inlineScreenshots !== false;

  // ── Balance matrix ─────────────────────────────────────────────────────────
  let matrixHtml = `<div class="matrix-scroll"><table class="matrix"><thead><tr><th class="corner"></th>`;
  for (const f of factions) matrixHtml += `<th title="${f}">${FACTION_ICONS[f] || '?'}<br><span class="mat-lbl">${f}</span></th>`;
  matrixHtml += `</tr></thead><tbody>`;
  for (const f1 of factions) {
    matrixHtml += `<tr><td class="row-label">${FACTION_ICONS[f1] || ''} ${f1}</td>`;
    for (const f2 of factions) {
      if (f1 === f2) { matrixHtml += `<td class="self">—</td>`; continue; }
      const r = results[f1]?.[f2];
      if (!r) { matrixHtml += `<td class="na">—</td>`; continue; }
      const games = r.p1Wins + r.p2Wins + r.draws + r.timeouts;
      const rate = games > 0 ? Math.round(r.p1Wins / games * 100) : 50;
      const cls = rate >= 65 ? 'hot' : rate >= 55 ? 'warm' : rate <= 35 ? 'cold' : rate <= 45 ? 'cool' : 'neutral';
      matrixHtml += `<td class="${cls}" title="${f1} vs ${f2}: ${rate}% win rate (${games} games)\n${r.p1Wins}W ${r.p2Wins}L ${r.draws}D ${r.timeouts}T">${rate}%</td>`;
    }
    matrixHtml += `</tr>`;
  }
  matrixHtml += `</tbody></table></div>`;

  // ── Win rate bars ──────────────────────────────────────────────────────────
  const sortedF = [...factions].sort((a, b) => (aggStats[b]?.overallWinRate || 50) - (aggStats[a]?.overallWinRate || 50));
  let barsHtml = '';
  for (const f of sortedF) {
    const s = aggStats[f]; if (!s) continue;
    const wr = s.overallWinRate;
    const cls = wr >= 55 ? 'hot' : wr <= 45 ? 'cold' : 'ok';
    const dur = `${Math.floor(s.avgGameDuration / 60)}m${String(s.avgGameDuration % 60).padStart(2, '0')}s`;
    const tier = wr >= 60 ? 'S' : wr >= 55 ? 'A' : wr >= 48 ? 'B' : wr >= 43 ? 'C' : 'D';
    const tierCls = { S: 'tier-s', A: 'tier-a', B: 'tier-b', C: 'tier-c', D: 'tier-d' }[tier];
    barsHtml += `<div class="bar-row">
      <span class="tier-badge ${tierCls}">${tier}</span>
      <div class="bar-name">${FACTION_ICONS[f] || ''} <strong>${f}</strong></div>
      <div class="bar-track"><div class="bar bar-${cls}" style="width:${Math.min(wr * 1.8, 100)}%"></div></div>
      <span class="bar-pct ${cls}">${wr}%</span>
      <span class="bar-detail">avg ${dur} · best vs ${s.bestMatchup.faction || '?'} (${Math.round((s.bestMatchup.rate || 0) * 100)}%) · worst vs ${s.worstMatchup.faction || '?'} (${Math.round((s.worstMatchup.rate || 0) * 100)}%)</span>
    </div>`;
  }

  // ── Bug cards ──────────────────────────────────────────────────────────────
  let bugsHtml = '';
  if (diagnosedBugs.length === 0) {
    bugsHtml = `<div class="empty-state">✅ No bugs detected across ${qa.totalGamesRun} games</div>`;
  } else {
    // Filter bar
    bugsHtml += `<div class="filter-bar">
      <input type="text" id="bug-search" placeholder="🔍 Search bugs..." oninput="filterBugs()" class="search-input">
      <div class="sev-filters">
        <button class="sev-filter active" data-sev="ALL"  onclick="setSevFilter('ALL',this)">All (${diagnosedBugs.length})</button>
        ${['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map(s => {
      const c = diagnosedBugs.filter(b => (b.diagnosis?.severity || b.severity || '').toUpperCase() === s).length;
      return c > 0 ? `<button class="sev-filter sev-filter-${s.toLowerCase()}" data-sev="${s}" onclick="setSevFilter('${s}',this)">${s} (${c})</button>` : '';
    }).join('')}
      </div>
    </div>`;

    bugsHtml += `<div id="bug-list">`;
    for (let bi = 0; bi < diagnosedBugs.length; bi++) {
      const bug = diagnosedBugs[bi];
      const sev = (bug.diagnosis?.severity || bug.severity || 'medium').toUpperCase();
      const sevCls = sev === 'CRITICAL' ? 'sev-critical' : sev === 'HIGH' ? 'sev-high' : sev === 'MEDIUM' ? 'sev-medium' : 'sev-low';
      const matchupStr = (bug.matchups || [bug.matchup]).filter(Boolean).join(', ');
      const hasPrompt = bug.diagnosis?.pasteToClaudePrompt;

      bugsHtml += `
      <div class="bug-card ${sevCls}" data-sev="${sev}" data-text="${escAttr((bug.message || '') + (bug.type || '') + (matchupStr || ''))}">
        <div class="bug-header" onclick="toggleBug(${bi})">
          <span class="bug-sev-badge ${sevCls}">${sev}</span>
          <span class="bug-type-label">${escHtml(bug.type || 'error')}</span>
          <span class="bug-occ">×${bug.occurrences || 1}</span>
          <span class="bug-matchup-label">${escHtml(matchupStr)}</span>
          <span class="bug-chevron" id="chev-${bi}">▼</span>
        </div>
        <div class="bug-message"><code>${escHtml((bug.message || '').slice(0, 300))}</code></div>
        <div class="bug-body" id="bugbody-${bi}" style="display:none">
          ${bug.stack ? `<details class="stack-details"><summary>Stack trace</summary><pre class="stack">${escHtml(bug.stack)}</pre></details>` : ''}
          ${bug.diagnosis?.likelyCause ? `<div class="diag-row"><span class="diag-lbl">🔍 Cause</span><span class="diag-val">${escHtml(bug.diagnosis.likelyCause)}</span></div>` : ''}
          ${bug.diagnosis?.reproSteps ? `<div class="diag-row"><span class="diag-lbl">🔁 Repro</span><span class="diag-val">${escHtml(bug.diagnosis.reproSteps).replace(/\\n/g, '<br>')}</span></div>` : ''}
          ${bug.diagnosis?.whereToLook ? `<div class="diag-row"><span class="diag-lbl">📂 Where</span><span class="diag-val"><code>${escHtml(bug.diagnosis.whereToLook)}</code></span></div>` : ''}
          ${bug.diagnosis?.suggestedFix ? `<div class="diag-row"><span class="diag-lbl">🔧 Fix</span><span class="diag-val">${escHtml(bug.diagnosis.suggestedFix)}</span></div>` : ''}
          ${hasPrompt ? `<div class="prompt-box">
            <div class="prompt-label">📋 Paste to Claude</div>
            <pre class="prompt-text" id="bugprompt-${bi}">${escHtml(bug.diagnosis.pasteToClaudePrompt)}</pre>
            <button class="copy-btn" onclick="copyById('bugprompt-${bi}',this)">Copy</button>
          </div>` : ''}
          ${bug.screenshotPath ? `<div class="diag-row"><span class="diag-lbl">📸 Screenshot</span><span class="diag-val"><code>${escHtml(bug.screenshotPath)}</code></span></div>` : ''}
        </div>
      </div>`;
    }
    bugsHtml += `</div>`;
  }

  // ── Prompts tab ────────────────────────────────────────────────────────────
  const allPrompts = diagnosedBugs.filter(b => b.diagnosis?.pasteToClaudePrompt);
  let promptsHtml = '';
  if (allPrompts.length === 0) {
    promptsHtml = `<div class="empty-state">No paste-to-Claude prompts generated (no bugs diagnosed, or no API key).</div>`;
  } else {
    const megaPrompt = allPrompts.map((b, i) =>
      `=== BUG ${i + 1}: ${b.type} [${(b.diagnosis?.severity || '').toUpperCase()}] ===\n${b.diagnosis.pasteToClaudePrompt}`
    ).join('\n\n');

    promptsHtml += `<div class="prompt-mega-box">
      <div class="prompt-mega-header">
        <div>
          <strong>All ${allPrompts.length} prompt(s) combined</strong>
          <span style="color:var(--dim);font-size:12px;margin-left:8px;">Paste everything at once, or copy individual prompts below</span>
        </div>
        <button class="copy-btn copy-big" onclick="copyById('mega-prompt',this)">📋 Copy All (${allPrompts.length})</button>
      </div>
      <pre class="prompt-text" id="mega-prompt" style="max-height:200px">${escHtml(megaPrompt)}</pre>
    </div>`;

    for (let i = 0; i < allPrompts.length; i++) {
      const bug = allPrompts[i];
      const sev = (bug.diagnosis?.severity || '').toUpperCase();
      const sevCls = sev === 'CRITICAL' ? 'sev-critical' : sev === 'HIGH' ? 'sev-high' : sev === 'MEDIUM' ? 'sev-medium' : 'sev-low';
      promptsHtml += `<div class="prompt-card ${sevCls}">
        <div class="prompt-card-header">
          <span class="bug-sev-badge ${sevCls}">${sev}</span>
          <span class="prompt-bug-type">${escHtml(bug.type || 'error')}</span>
          <span style="color:var(--dim);font-size:12px">${escHtml((bug.matchups || [bug.matchup]).filter(Boolean).join(', '))}</span>
        </div>
        <pre class="prompt-text" id="prompt-${i}">${escHtml(bug.diagnosis.pasteToClaudePrompt)}</pre>
        <button class="copy-btn" onclick="copyById('prompt-${i}',this)">Copy</button>
      </div>`;
    }

    // Balance prompt
    if (balanceAnalysis) {
      const bm = balanceAnalysis.match(/===BALANCE PROMPT START===([\s\S]+?)===BALANCE PROMPT END===/);
      if (bm) {
        promptsHtml += `<div class="prompt-card" style="border-color:var(--gold)">
          <div class="prompt-card-header">
            <span class="bug-sev-badge" style="background:rgba(240,165,0,.2);color:var(--gold)">BALANCE</span>
            <span class="prompt-bug-type">Balance Patch Prompt</span>
          </div>
          <pre class="prompt-text" id="balance-prompt">${escHtml(bm[1].trim())}</pre>
          <button class="copy-btn" onclick="copyById('balance-prompt',this)">Copy</button>
        </div>`;
      }
    }
  }

  // ── Screenshots ────────────────────────────────────────────────────────────
  let ssHtml = '';
  if (screenshots.length === 0) {
    ssHtml = `<div class="empty-state">No screenshots (enable saveScreenshots in config.js)</div>`;
  } else {
    const byScreen = {};
    for (const ss of screenshots) {
      (byScreen[ss.screen] = byScreen[ss.screen] || []).push(ss);
    }
    for (const [screen, ssList] of Object.entries(byScreen)) {
      ssHtml += `<h3 class="ss-screen-title">${screen}</h3><div class="ss-grid">`;
      for (const ss of ssList) {
        let imgSrc;
        if (inlineScreenshots && ss.path && fs.existsSync(ss.path)) {
          const b64 = fs.readFileSync(ss.path).toString('base64');
          imgSrc = `data:image/png;base64,${b64}`;
        } else {
          // Fallback to relative path
          imgSrc = path.relative(path.dirname(cfg.output.reportPath || './qa-report.html'), ss.path || '').replace(/\\/g, '/');
        }
        ssHtml += `<div class="ss-card" onclick="openLightbox('${imgSrc}','${escAttr(ss.viewport)} (${ss.width}×${ss.height})')">
          <img src="${imgSrc}" alt="${escAttr(ss.viewport)}" loading="lazy">
          <div class="ss-label">📱 ${escHtml(ss.viewport)} <span class="ss-dims">${ss.width}×${ss.height}</span></div>
          <div class="ss-zoom-hint">Click to enlarge</div>
        </div>`;
      }
      ssHtml += `</div>`;
    }
  }

  // ── Online report ──────────────────────────────────────────────────────────
  let onlineHtml = '';
  if (!onlineReport) {
    onlineHtml = `<div class="empty-state">Online sync tests not run. Add <code>run.online = true</code> in config and re-run without <code>--skip-online</code>.</div>`;
  } else {
    const gradeColor = { A: 'var(--green)', B: '#f1c40f', C: 'var(--orange)', D: 'var(--red)', F: 'var(--red)' }[onlineReport.overallGrade] || 'var(--dim)';
    onlineHtml += `<div class="stats-grid" style="margin-bottom:16px">
      <div class="stat-card" style="border-color:${gradeColor}"><div class="stat-num" style="color:${gradeColor}">${onlineReport.overallGrade}</div><div class="stat-lbl">Overall Grade</div></div>
      <div class="stat-card"><div class="stat-num">${onlineReport.passedChecks}</div><div class="stat-lbl">Checks passed<small>of ${onlineReport.totalChecks}</small></div></div>
      <div class="stat-card ${onlineReport.issues.length > 0 ? 'stat-warn' : 'stat-ok'}"><div class="stat-num">${onlineReport.issues.length}</div><div class="stat-lbl">Issues found</div></div>
    </div>`;

    if (onlineReport.issues.length > 0) {
      onlineHtml += `<h3>Issues</h3>`;
      for (const issue of onlineReport.issues) {
        const sev = issue.severity === 'HIGH' ? 'sev-high' : issue.severity === 'MEDIUM' ? 'sev-medium' : 'sev-low';
        onlineHtml += `<div class="bug-card ${sev}" style="margin-bottom:8px">
          <div class="bug-header" style="cursor:default">
            <span class="bug-sev-badge ${sev}">${escHtml(issue.severity)}</span>
            <span class="bug-type-label">${escHtml(issue.type.replace(/_/g, ' '))}</span>
            ${issue.profile ? `<span class="bug-occ">${escHtml(issue.profile)}</span>` : ''}
            ${issue.matchup ? `<span class="bug-matchup-label">${escHtml(issue.matchup)}</span>` : ''}
          </div>
          <div class="bug-message"><code>${escHtml(issue.message)}</code></div>
          ${issue.prompt ? `<div class="bug-body" style="display:block;padding:12px">
            <div class="prompt-box"><div class="prompt-label">📋 Paste to Claude</div>
            <pre class="prompt-text" id="op-${Math.random().toString(36).slice(2)}">${escHtml(issue.prompt)}</pre></div>
          </div>` : ''}
        </div>`;
      }
    }

    onlineHtml += `<h3 style="margin-top:20px">Scenario Results</h3>`;
    for (const r of onlineReport.results) {
      const gc = { A: 'var(--green)', B: '#f1c40f', C: 'var(--orange)', D: 'var(--red)', F: 'var(--red)' }[r.grade] || 'var(--dim)';
      onlineHtml += `<div class="section" style="margin-bottom:12px;padding:14px">
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:10px">
          <span style="font-size:1.4rem;font-weight:800;color:${gc}">${r.grade || '?'}</span>
          <strong>${escHtml(r.profileName)}</strong>
          <span style="color:var(--dim)">${escHtml(r.f1)} vs ${escHtml(r.f2)}</span>
          <span style="color:var(--dim);font-size:12px;margin-left:auto">${r.snapshotCount} snaps · avg ${r.latencyMs?.avg || 0}ms · p95 ${r.latencyMs?.p95 || 0}ms</span>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${(r.checks || []).map(c => `<span style="font-size:12px;padding:2px 8px;border-radius:10px;background:${c.passed ? 'rgba(46,204,113,.15)' : 'rgba(231,76,60,.15)'};color:${c.passed ? 'var(--green)' : 'var(--red)'}${c.critical && !c.passed ? ';font-weight:700' : ''}">${c.passed ? '✓' : '✗'} ${escHtml(c.name)}</span>`).join('')}
        </div>
        ${r.totalDivergences > 0 ? `<div style="margin-top:8px;font-size:12px;color:var(--orange)">⚠️ ${r.totalDivergences} divergence events</div>` : ''}
        ${r.error ? `<div style="margin-top:8px;font-size:12px;color:var(--red)">${escHtml(r.error)}</div>` : ''}
      </div>`;
    }
  }

  // ── Anomaly report HTML ────────────────────────────────────────────────────
  let anomalyHtml = '';
  const anomalies = anomalyReport?.anomalies || [];
  if (anomalies.length === 0) {
    anomalyHtml = `<div class="empty-state">✅ No behavioral anomalies detected${anomalyReport ? '' : ' (run with balance data to enable)'}</div>`;
  } else {
    for (const a of anomalies) {
      const sevCls = a.severity === 'HIGH' ? 'sev-high' : a.severity === 'MEDIUM' ? 'sev-medium' : 'sev-low';
      const promptId = `anom-${Math.random().toString(36).slice(2)}`;
      anomalyHtml += `<div class="bug-card ${sevCls}" style="margin-bottom:10px">
        <div class="bug-header" style="cursor:default">
          <span class="bug-sev-badge ${sevCls}">${escHtml(a.severity)}</span>
          <span class="bug-type-label">${escHtml(a.title)}</span>
        </div>
        <div class="bug-message" style="padding:10px 14px">${escHtml(a.detail)}</div>
        <div class="bug-body" style="display:block;padding:12px">
          ${a.suggestion ? `<div class="diag-row"><span class="diag-lbl">💡 Suggestion</span><span class="diag-val">${escHtml(a.suggestion)}</span></div>` : ''}
          ${a.prompt ? `<div class="prompt-box" style="margin-top:8px">
            <div class="prompt-label">📋 Paste to Claude</div>
            <pre class="prompt-text" id="${promptId}">${escHtml(a.prompt)}</pre>
            <button class="copy-btn" onclick="copyById('${promptId}',this)">Copy</button>
          </div>` : ''}
        </div>
      </div>`;
    }
  }

  // ── Feature advisor HTML ───────────────────────────────────────────────────
  let featureHtml = '';
  const suggestions = featureAdvice?.suggestions || [];
  if (suggestions.length === 0) {
    featureHtml = `<div class="empty-state">Feature suggestions unavailable${featureAdvice ? '' : ' (run with balance data to enable)'}</div>`;
  } else {
    const effortColors = { quick: 'var(--green)', medium: 'var(--gold)', large: 'var(--orange)' };
    const impactColors = { high: '#ff8080', medium: 'var(--gold)', low: 'var(--dim)' };
    const catIcons = { gameplay: '🎮', ux: '✨', balance: '⚖️', online: '🌐', performance: '📈', polish: '💎' };

    // Summary bar
    const byImpact = { high: suggestions.filter(s => s.impact === 'high').length, medium: suggestions.filter(s => s.impact === 'medium').length, low: suggestions.filter(s => s.impact === 'low').length };
    const byEffort = { quick: suggestions.filter(s => s.effort === 'quick').length, medium: suggestions.filter(s => s.effort === 'medium').length, large: suggestions.filter(s => s.effort === 'large').length };
    featureHtml += `<div class="stats-grid" style="margin-bottom:20px">
      <div class="stat-card"><div class="stat-num" style="color:var(--gold)">${suggestions.length}</div><div class="stat-lbl">Total suggestions</div></div>
      <div class="stat-card stat-bad"><div class="stat-num" style="color:#ff8080">${byImpact.high}</div><div class="stat-lbl">High impact</div></div>
      <div class="stat-card stat-ok"><div class="stat-num" style="color:var(--green)">${byEffort.quick}</div><div class="stat-lbl">Quick wins</div></div>
    </div>`;

    for (const s of suggestions) {
      const promptId = `feat-${Math.random().toString(36).slice(2)}`;
      featureHtml += `<div class="section" style="margin-bottom:12px;padding:16px;border-left:3px solid ${impactColors[s.impact] || 'var(--border)'}">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px">
          <span style="font-size:18px">${catIcons[s.category] || '🔧'}</span>
          <strong style="font-size:14px">#${s.priority} ${escHtml(s.title)}</strong>
          <span style="font-size:11px;padding:2px 8px;border-radius:10px;background:rgba(255,255,255,.06);color:${effortColors[s.effort] || 'var(--dim)'}">effort: ${s.effort}</span>
          <span style="font-size:11px;padding:2px 8px;border-radius:10px;background:rgba(255,255,255,.06);color:${impactColors[s.impact] || 'var(--dim)'}">impact: ${s.impact}</span>
          <span style="font-size:11px;color:var(--dim);margin-left:auto">${escHtml(s.category)}</span>
        </div>
        <div style="font-size:13px;color:var(--dim);margin-bottom:8px;line-height:1.6">${escHtml(s.rationale)}</div>
        ${s.implementation ? `<div style="font-size:13px;line-height:1.6;margin-bottom:8px">${escHtml(s.implementation)}</div>` : ''}
        ${s.pasteToClaudePrompt ? `<div class="prompt-box">
          <div class="prompt-label">📋 Paste to Claude</div>
          <pre class="prompt-text" id="${promptId}">${escHtml(s.pasteToClaudePrompt)}</pre>
          <button class="copy-btn" onclick="copyById('${promptId}',this)">Copy</button>
        </div>` : ''}
      </div>`;
    }
  }
  let uiHtml = '';
  const uiErrors = uiIssues.filter(i => i.severity === 'error');
  const uiWarnings = uiIssues.filter(i => i.severity === 'warning');
  const uiInfos = uiIssues.filter(i => i.severity === 'info');
  if (uiIssues.length === 0) {
    uiHtml = `<div class="empty-state">✅ No UI issues detected</div>`;
  } else {
    const renderGroup = (issues, label, cls) => {
      if (issues.length === 0) return '';
      return `<h3 class="ui-group-title ${cls}">${label} <span class="badge">${issues.length}</span></h3>` +
        issues.map(i => `<div class="ui-issue-row ${cls}">
          <div class="ui-issue-meta">
            <span class="ui-type-badge">${escHtml(i.type)}</span>
            ${i.screen ? `<span class="ui-screen-badge">${escHtml(i.screen)}</span>` : ''}
            ${i.viewportSize ? `<span class="ui-vp-badge">${escHtml(i.viewportSize)}</span>` : ''}
          </div>
          <div class="ui-issue-msg">${escHtml(i.message || '')}</div>
          ${i.element ? `<code class="ui-el-code">${escHtml(i.element)}</code>` : ''}
          ${i.size ? `<code class="ui-el-code">${i.size.width}×${i.size.height}px</code>` : ''}
        </div>`).join('');
    };
    uiHtml = renderGroup(uiErrors, '🔴 Errors', 'ui-error')
      + renderGroup(uiWarnings, '🟡 Warnings', 'ui-warning')
      + renderGroup(uiInfos, 'ℹ️ Info', 'ui-info');
  }

  // ── Mechanics ──────────────────────────────────────────────────────────────
  const totalGames = qa.totalGamesRun || 1;
  const threshold = cfg.mechanics?.unusedThresholdPct || 15;
  let mechHtml = '';
  for (const [key, count] of Object.entries(qa.mechanicUsage || {})) {
    const pct = Math.round(count / totalGames * 100);
    const flagged = pct < threshold;
    const barW = Math.min(pct * 2, 100);
    const barClr = flagged ? 'var(--orange)' : pct > 60 ? 'var(--green)' : 'var(--blue)';
    mechHtml += `<div class="mech-row ${flagged ? 'mech-flagged' : ''}">
      <span class="mech-name">${key.replace(/_/g, ' ')}</span>
      <div class="mech-track"><div class="mech-fill" style="width:${barW}%;background:${barClr}"></div></div>
      <span class="mech-pct">${pct}%</span>
      <span class="mech-count">${count}×</span>
      ${flagged ? `<span class="mech-flag">⚠️ rarely used</span>` : ''}
    </div>`;
  }

  // ── Performance ────────────────────────────────────────────────────────────
  const avgFtAll = qa.performance?.avgFrameMsAll || [];
  const avgAvgFt = avgFtAll.length > 0 ? Math.round(avgFtAll.reduce((a, b) => a + b, 0) / avgFtAll.length * 10) / 10 : 0;
  const maxFtAll = qa.performance?.maxFrameMsAll || [];
  const overallMaxFt = maxFtAll.length > 0 ? Math.max(...maxFtAll) : 0;
  const longTasks = qa.performance?.longTasksAll || [];
  const ftGrade = avgAvgFt > 33 ? 'stat-bad' : avgAvgFt > 20 ? 'stat-warn' : 'stat-ok';
  const maxGrade = overallMaxFt > 200 ? 'stat-bad' : overallMaxFt > 100 ? 'stat-warn' : 'stat-ok';
  const ltGrade = longTasks.length > 10 ? 'stat-bad' : longTasks.length > 3 ? 'stat-warn' : 'stat-ok';

  const perfHtml = `<div class="stats-grid">
    <div class="stat-card ${ftGrade}"><div class="stat-num">${avgAvgFt}ms</div><div class="stat-lbl">Avg frame time<br><small>target: &lt;16ms</small></div></div>
    <div class="stat-card ${maxGrade}"><div class="stat-num">${overallMaxFt}ms</div><div class="stat-lbl">Worst frame spike<br><small>target: &lt;100ms</small></div></div>
    <div class="stat-card ${ltGrade}"><div class="stat-num">${longTasks.length}</div><div class="stat-lbl">Long tasks (&gt;100ms)<br><small>target: 0</small></div></div>
    <div class="stat-card"><div class="stat-num">${qa.totalGamesRun}</div><div class="stat-lbl">Games simulated<br><small>${runDurStr} total</small></div></div>
  </div>
  ${longTasks.length > 0 ? `<details><summary style="cursor:pointer;color:var(--gold)">Long task breakdown (${longTasks.length})</summary>
    <pre style="margin-top:8px">${longTasks.slice(0, 30).map(t => `${String(t.dt).padStart(5)}ms  ${t.matchup || 'unknown'}`).join('\n')}</pre>
  </details>` : ''}`;

  // ── Balance analysis ───────────────────────────────────────────────────────
  let balHtml = '';
  if (balanceAnalysis) {
    const cleaned = balanceAnalysis
      .replace(/===BALANCE PROMPT START===([\s\S]+?)===BALANCE PROMPT END===/g,
        (_, p) => `<div class="prompt-box"><div class="prompt-label">📋 Balance Patch Prompt</div><pre class="prompt-text" id="bal-main-prompt">${escHtml(p.trim())}</pre><button class="copy-btn" onclick="copyById('bal-main-prompt',this)">Copy</button></div>`);
    balHtml = mdToHtml(cleaned);
  } else {
    balHtml = `<div class="empty-state">Balance analysis unavailable (no Anthropic API key set)</div>`;
  }

  // ── Overview critical section ──────────────────────────────────────────────
  let criticalSection = '';
  if (criticalBugs.length > 0) {
    criticalSection = `<div class="critical-banner">
      <h2>🔴 ${criticalBugs.length} Critical Issue${criticalBugs.length > 1 ? 's' : ''} Need Immediate Attention</h2>
      ${criticalBugs.map((b, i) => `<div class="critical-item">
        <div class="critical-item-header">
          <code>${escHtml(b.type)}</code>
          <span style="color:var(--dim)">${escHtml((b.matchups || [b.matchup]).filter(Boolean).join(', '))}</span>
        </div>
        <div class="critical-msg">${escHtml((b.message || '').slice(0, 200))}</div>
        ${b.diagnosis?.pasteToClaudePrompt ? `<div class="prompt-box" style="margin-top:10px">
          <div class="prompt-label">📋 Fix Prompt</div>
          <pre class="prompt-text" id="crit-prompt-${i}">${escHtml(b.diagnosis.pasteToClaudePrompt)}</pre>
          <button class="copy-btn" onclick="copyById('crit-prompt-${i}',this)">Copy</button>
        </div>` : ''}
      </div>`).join('')}
    </div>`;
  }

  // ── Softlocks on overview ──────────────────────────────────────────────────
  const softlockCount = qa.allTimedOut?.length || 0;
  const softlockSection = softlockCount > 0 ? `<div class="warning-banner">
    <strong>⏱ ${softlockCount} game(s) timed out (possible softlock)</strong>
    <div style="margin-top:8px;font-size:13px;color:var(--dim)">
      ${[...new Set((qa.allTimedOut || []).map(t => t.matchup))].slice(0, 8).join(', ')}
    </div>
  </div>` : '';

  // ── Nav badge helper ───────────────────────────────────────────────────────
  const bugBadge = totalBugs > 0 ? ` <span class="nav-badge ${criticalBugs.length ? 'badge-red' : 'badge-orange'}">${totalBugs}</span>` : ' <span class="nav-badge badge-green">✓</span>';
  const uiBadge = uiErrors.length > 0 ? ` <span class="nav-badge badge-red">${uiIssues.length}</span>` : uiIssues.length > 0 ? ` <span class="nav-badge badge-orange">${uiIssues.length}</span>` : ' <span class="nav-badge badge-green">✓</span>';
  const promptBadge = allPrompts.length > 0 ? ` <span class="nav-badge badge-gold">${allPrompts.length}</span>` : '';
  const onlineGrade = onlineReport?.overallGrade;
  const onlineBadge = onlineGrade ? ` <span class="nav-badge ${onlineGrade === 'A' ? 'badge-green' : onlineGrade === 'B' ? 'badge-gold' : 'badge-red'}">${onlineGrade}</span>` : '';
  const anomalyCount = (anomalyReport?.anomalies || []).length;
  const anomalyBadge = anomalyCount > 0 ? ` <span class="nav-badge ${anomalyReport.hasCritical ? 'badge-red' : 'badge-orange'}">${anomalyCount}</span>` : ' <span class="nav-badge badge-green">✓</span>';
  const featureCount = (featureAdvice?.suggestions || []).length;
  const featureBadge = featureCount > 0 ? ` <span class="nav-badge badge-gold">${featureCount}</span>` : '';

  // ── Full HTML ──────────────────────────────────────────────────────────────
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Beyond RTS — QA Report</title>
<style>
/* ── Reset & base ── */
:root{
  --bg:#0b0c0f;--surface:#13151a;--surface2:#1a1d24;--border:#23262f;
  --gold:#f0a500;--gold2:#ffcc44;--text:#cdd3e0;--dim:#6b7280;--dimmer:#3d4250;
  --red:#e74c3c;--orange:#e67e22;--green:#2ecc71;--blue:#3498db;--purple:#9b59b6;
}
*{box-sizing:border-box;margin:0;padding:0;}
html{scroll-behavior:smooth;}
body{background:var(--bg);color:var(--text);font:14px/1.6 'Segoe UI',system-ui,sans-serif;min-height:100vh;}
a{color:var(--gold);}
code{background:#1c1f27;padding:1px 6px;border-radius:3px;font:12px/1.4 'JetBrains Mono','Consolas',monospace;color:#81ecec;}
pre{background:#0d0f14;border:1px solid var(--border);border-radius:6px;padding:14px;overflow-x:auto;font:12px/1.5 'JetBrains Mono','Consolas',monospace;color:#b2f5ea;white-space:pre-wrap;word-break:break-word;}
strong{color:#fff;}
details>summary{cursor:pointer;color:var(--gold);font-size:13px;padding:4px 0;}
h2{font-size:.85rem;text-transform:uppercase;letter-spacing:1.5px;color:var(--gold);border-bottom:1px solid var(--border);padding-bottom:8px;margin-bottom:16px;}
h3{font-size:.9rem;color:var(--text);margin:16px 0 8px;}
p{margin-bottom:8px;color:var(--text);}
/* ── Header ── */
.header{background:linear-gradient(160deg,#170a00 0%,#0b0c0f 60%);border-bottom:2px solid var(--gold);padding:24px 32px;display:flex;align-items:center;gap:20px;}
.header-icon{font-size:2.5rem;line-height:1;}
.header-title{font-size:1.7rem;font-weight:800;color:var(--gold);letter-spacing:2px;text-transform:uppercase;}
.header-meta{font-size:12px;color:var(--dim);margin-top:4px;display:flex;flex-wrap:wrap;gap:10px;}
.header-meta span{display:flex;align-items:center;gap:4px;}
/* ── Nav ── */
.nav{background:var(--surface);border-bottom:1px solid var(--border);display:flex;overflow-x:auto;position:sticky;top:0;z-index:100;}
.nav a{padding:13px 18px;color:var(--dim);text-decoration:none;white-space:nowrap;border-bottom:2px solid transparent;font-size:13px;font-weight:600;letter-spacing:.4px;display:flex;align-items:center;gap:4px;transition:color .15s;}
.nav a:hover{color:var(--text);}
.nav a.active{color:var(--gold);border-bottom-color:var(--gold);}
.nav-badge{font-size:10px;font-weight:700;padding:1px 5px;border-radius:8px;line-height:1.4;}
.badge-red{background:rgba(231,76,60,.25);color:#ff8080;}
.badge-orange{background:rgba(230,126,34,.25);color:#ffb347;}
.badge-green{background:rgba(46,204,113,.2);color:#55ee88;}
.badge-gold{background:rgba(240,165,0,.2);color:var(--gold);}
/* ── Layout ── */
.tab{display:none;}.tab.active{display:block;}
.container{max-width:1500px;margin:0 auto;padding:24px 20px;}
.section{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:22px;margin-bottom:20px;}
/* ── Stat cards ── */
.stats-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px;margin-bottom:16px;}
.stat-card{background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:16px;text-align:center;}
.stat-card.stat-ok{border-color:rgba(46,204,113,.3);}
.stat-card.stat-warn{border-color:rgba(230,126,34,.35);}
.stat-card.stat-bad{border-color:rgba(231,76,60,.4);}
.stat-num{font-size:1.7rem;font-weight:800;color:var(--gold);line-height:1.2;}
.stat-lbl{font-size:11px;color:var(--dim);margin-top:3px;}
.stat-lbl small{display:block;font-size:10px;margin-top:2px;color:var(--dimmer);}
/* ── Balance bars ── */
.bar-row{display:grid;grid-template-columns:24px 130px 1fr 50px 1fr;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--border);}
.bar-row:last-child{border-bottom:none;}
.bar-name{font-size:13px;}
.bar-track{height:14px;background:var(--surface2);border-radius:4px;overflow:hidden;}
.bar{height:100%;border-radius:4px;transition:width .3s;}
.bar-hot{background:linear-gradient(90deg,var(--red),#ff6b6b);}
.bar-ok{background:linear-gradient(90deg,var(--green),#00d68f);}
.bar-cold{background:linear-gradient(90deg,var(--purple),#8e44ad);}
.bar-pct{font-size:13px;font-weight:700;text-align:right;}
.hot{color:#ff8080;}.ok{color:var(--green);}.cold{color:#bf94e4;}
.bar-detail{font-size:11px;color:var(--dim);}
.tier-badge{width:22px;height:22px;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;}
.tier-s{background:rgba(231,76,60,.3);color:#ff8080;}
.tier-a{background:rgba(230,126,34,.3);color:#ffb347;}
.tier-b{background:rgba(46,204,113,.2);color:var(--green);}
.tier-c{background:rgba(52,152,219,.2);color:#74b9ff;}
.tier-d{background:rgba(142,68,173,.25);color:#bf94e4;}
/* ── Matrix ── */
.matrix-scroll{overflow-x:auto;}
.matrix{border-collapse:collapse;font-size:12px;width:100%;}
.matrix th,.matrix td{padding:6px 8px;border:1px solid var(--border);text-align:center;white-space:nowrap;}
.matrix thead th{background:var(--surface2);font-size:13px;line-height:1.3;}
.mat-lbl{font-size:10px;color:var(--dim);display:block;}
.corner{background:var(--surface2);}
.row-label{background:var(--surface2);text-align:left;font-weight:600;min-width:130px;font-size:12px;}
.self{color:var(--dimmer);background:var(--surface2);}
.na{color:var(--dimmer);}
.matrix .hot{background:rgba(231,76,60,.35);color:#ff8080;font-weight:700;}
.matrix .warm{background:rgba(230,126,34,.25);color:#ffb347;font-weight:600;}
.matrix .neutral{color:var(--dim);}
.matrix .cool{background:rgba(52,152,219,.18);color:#74b9ff;}
.matrix .cold{background:rgba(142,68,173,.3);color:#bf94e4;font-weight:700;}
.legend{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:12px;font-size:12px;}
.legend span{display:flex;align-items:center;gap:5px;}
.ld{width:10px;height:10px;border-radius:2px;display:inline-block;}
/* ── Bug cards ── */
.filter-bar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:16px;padding:12px;background:var(--surface2);border-radius:8px;}
.search-input{background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:7px 12px;color:var(--text);font:13px/1 inherit;flex:1;min-width:200px;outline:none;}
.search-input:focus{border-color:var(--gold);}
.sev-filters{display:flex;gap:6px;flex-wrap:wrap;}
.sev-filter{background:var(--surface);border:1px solid var(--border);color:var(--dim);padding:5px 12px;border-radius:20px;cursor:pointer;font:12px/1 inherit;font-weight:600;}
.sev-filter.active,.sev-filter:hover{border-color:var(--gold);color:var(--gold);}
.sev-filter-critical.active{border-color:var(--red);color:var(--red);background:rgba(231,76,60,.1);}
.sev-filter-high.active{border-color:var(--orange);color:var(--orange);background:rgba(230,126,34,.1);}
.sev-filter-medium.active{border-color:#f1c40f;color:#f1c40f;background:rgba(241,196,15,.08);}
.sev-filter-low.active{border-color:var(--blue);color:var(--blue);background:rgba(52,152,219,.1);}
.bug-card{border:1px solid var(--border);border-radius:8px;margin-bottom:10px;overflow:hidden;transition:border-color .15s;}
.bug-card.sev-critical{border-left:4px solid var(--red);}
.bug-card.sev-high{border-left:4px solid var(--orange);}
.bug-card.sev-medium{border-left:4px solid #f1c40f;}
.bug-card.sev-low{border-left:4px solid var(--blue);}
.bug-header{display:flex;align-items:center;gap:10px;padding:12px 14px;cursor:pointer;background:var(--surface2);flex-wrap:wrap;}
.bug-header:hover{background:#1e2130;}
.bug-sev-badge{font-size:10px;font-weight:700;padding:2px 8px;border-radius:12px;letter-spacing:.5px;white-space:nowrap;}
.sev-critical .bug-sev-badge{background:rgba(231,76,60,.2);color:#ff8080;}
.sev-high .bug-sev-badge{background:rgba(230,126,34,.2);color:#ffb347;}
.sev-medium .bug-sev-badge{background:rgba(241,196,15,.15);color:#f1c40f;}
.sev-low .bug-sev-badge{background:rgba(52,152,219,.15);color:#74b9ff;}
.bug-type-label{font-weight:600;font-size:13px;}
.bug-occ{color:var(--dim);font-size:12px;background:var(--bg);padding:1px 6px;border-radius:3px;}
.bug-matchup-label{color:var(--dim);font-size:12px;margin-left:auto;}
.bug-chevron{color:var(--dim);font-size:11px;transition:transform .2s;margin-left:4px;}
.bug-message{padding:8px 14px 8px;font-size:12px;border-bottom:1px solid var(--border);}
.bug-body{padding:14px;background:var(--bg);border-top:1px solid var(--border);}
.diag-row{display:grid;grid-template-columns:90px 1fr;gap:10px;margin-bottom:10px;font-size:13px;}
.diag-lbl{color:var(--dim);font-weight:600;font-size:12px;padding-top:1px;}
.diag-val{line-height:1.6;}
.stack-details{margin-bottom:12px;}
.stack{max-height:200px;overflow-y:auto;font-size:11px;}
/* ── Prompt boxes ── */
.prompt-box{background:#0a1628;border:2px solid rgba(240,165,0,.4);border-radius:8px;padding:14px;margin:12px 0;}
.prompt-label{color:var(--gold);font-weight:700;font-size:12px;margin-bottom:8px;letter-spacing:.5px;}
.prompt-text{font-size:12px;color:#b2f5ea;max-height:240px;overflow-y:auto;}
.copy-btn{margin-top:8px;background:rgba(240,165,0,.08);border:1px solid rgba(240,165,0,.4);color:var(--gold);padding:6px 14px;border-radius:5px;cursor:pointer;font:12px/1 inherit;font-weight:600;transition:all .15s;}
.copy-btn:hover{background:var(--gold);color:#000;}
.copy-big{padding:8px 18px;font-size:13px;}
/* ── Prompts tab ── */
.prompt-mega-box{background:#0a1628;border:2px solid var(--gold);border-radius:10px;padding:16px;margin-bottom:20px;}
.prompt-mega-header{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:12px;}
.prompt-card{border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:12px;}
.prompt-card.sev-critical{border-left:4px solid var(--red);}
.prompt-card.sev-high{border-left:4px solid var(--orange);}
.prompt-card.sev-medium{border-left:4px solid #f1c40f;}
.prompt-card.sev-low{border-left:4px solid var(--blue);}
.prompt-card-header{display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap;}
.prompt-bug-type{font-weight:600;font-size:13px;}
/* ── Banners ── */
.critical-banner{background:rgba(231,76,60,.06);border:2px solid rgba(231,76,60,.4);border-radius:10px;padding:20px;margin-bottom:20px;}
.critical-banner h2{color:var(--red);border-color:rgba(231,76,60,.3);}
.critical-item{background:rgba(231,76,60,.04);border:1px solid rgba(231,76,60,.2);border-radius:8px;padding:14px;margin-top:12px;}
.critical-item-header{display:flex;align-items:center;gap:12px;margin-bottom:8px;flex-wrap:wrap;}
.critical-msg{font-size:13px;color:var(--dim);}
.warning-banner{background:rgba(230,126,34,.06);border:1px solid rgba(230,126,34,.3);border-radius:8px;padding:14px;margin-bottom:16px;color:var(--orange);}
/* ── Screenshots ── */
.ss-screen-title{margin:16px 0 10px;color:var(--gold);}
.ss-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;margin-bottom:20px;}
.ss-card{border:1px solid var(--border);border-radius:8px;overflow:hidden;cursor:zoom-in;transition:border-color .15s;position:relative;}
.ss-card:hover{border-color:var(--gold);}
.ss-card img{width:100%;height:170px;object-fit:cover;display:block;background:#111;}
.ss-label{padding:7px 10px;font-size:12px;color:var(--text);background:var(--surface2);display:flex;align-items:center;justify-content:space-between;}
.ss-dims{color:var(--dim);font-size:11px;}
.ss-zoom-hint{position:absolute;top:6px;right:6px;background:rgba(0,0,0,.7);color:#fff;font-size:10px;padding:3px 6px;border-radius:4px;opacity:0;transition:opacity .2s;}
.ss-card:hover .ss-zoom-hint{opacity:1;}
/* ── Lightbox ── */
#lightbox{display:none;position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:9999;flex-direction:column;align-items:center;justify-content:center;cursor:zoom-out;}
#lightbox.open{display:flex;}
#lb-img{max-width:94vw;max-height:86vh;border:2px solid var(--gold);border-radius:4px;box-shadow:0 0 60px rgba(0,0,0,.8);}
#lb-label{color:var(--dim);font-size:13px;margin-top:10px;}
#lb-close{position:absolute;top:16px;right:20px;color:var(--dim);font-size:24px;cursor:pointer;background:none;border:none;line-height:1;}
#lb-close:hover{color:#fff;}
/* ── UI issues ── */
.ui-group-title{margin:16px 0 8px;font-size:.85rem;display:flex;align-items:center;gap:8px;}
.ui-group-title.ui-error{color:var(--red);}
.ui-group-title.ui-warning{color:var(--orange);}
.ui-group-title.ui-info{color:var(--blue);}
.badge{background:var(--surface2);border-radius:10px;padding:1px 7px;font-size:11px;font-weight:700;}
.ui-issue-row{border:1px solid var(--border);border-radius:6px;padding:10px;margin-bottom:6px;}
.ui-issue-row.ui-error{border-left:3px solid var(--red);}
.ui-issue-row.ui-warning{border-left:3px solid var(--orange);}
.ui-issue-row.ui-info{border-left:3px solid var(--blue);}
.ui-issue-meta{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px;}
.ui-type-badge{background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:1px 7px;font-size:11px;font-weight:600;}
.ui-screen-badge,.ui-vp-badge{background:var(--surface2);border-radius:4px;padding:1px 6px;font-size:11px;color:var(--dim);}
.ui-issue-msg{font-size:13px;line-height:1.5;}
.ui-el-code{display:inline-block;margin-top:4px;}
/* ── Mechanics ── */
.mech-row{display:grid;grid-template-columns:200px 1fr 50px 40px auto;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--border);}
.mech-row.mech-flagged .mech-name{color:var(--orange);}
.mech-name{font-size:13px;text-transform:capitalize;}
.mech-track{height:10px;background:var(--surface2);border-radius:3px;overflow:hidden;}
.mech-fill{height:100%;border-radius:3px;transition:width .3s;}
.mech-pct{font-size:13px;font-weight:700;text-align:right;}
.mech-count{font-size:11px;color:var(--dim);}
.mech-flag{color:var(--orange);font-size:12px;}
/* ── Analysis ── */
.analysis h2{color:var(--gold);font-size:.95rem;}
.analysis h3{color:var(--text);font-size:.9rem;margin:14px 0 6px;}
/* ── Empty state ── */
.empty-state{padding:24px;text-align:center;color:var(--green);font-weight:600;font-size:14px;}
/* ── Responsive ── */
@media(max-width:700px){
  .bar-row{grid-template-columns:24px 1fr 60px;}.bar-detail,.bar-track{display:none;}
  .mech-row{grid-template-columns:1fr 50px auto;}
  .diag-row{grid-template-columns:1fr;}
}
</style>
</head>
<body>

<!-- LIGHTBOX -->
<div id="lightbox" onclick="closeLightbox()">
  <button id="lb-close" onclick="closeLightbox()">✕</button>
  <img id="lb-img" src="" alt="">
  <div id="lb-label"></div>
</div>

<!-- HEADER -->
<div class="header">
  <div class="header-icon">⚔️</div>
  <div>
    <div class="header-title">Beyond RTS — QA Report</div>
    <div class="header-meta">
      <span>🕐 ${escHtml(timestamp)}</span>
      <span>🎮 ${qa.totalGamesRun} games</span>
      <span>🤖 ${escHtml(cfg.balance.aiDifficulty)} AI</span>
      <span>🏴 ${factions.length} factions</span>
      <span>⏱ ${escHtml(runDurStr)}</span>
      <span>${totalBugs > 0 ? `<span style="color:var(--red)">⚠️ ${totalBugs} bug${totalBugs > 1 ? 's' : ''}</span>` : '<span style="color:var(--green)">✅ 0 bugs</span>'}</span>
      ${softlockCount > 0 ? `<span style="color:var(--orange)">⏱ ${softlockCount} softlock${softlockCount > 1 ? 's' : ''}</span>` : ''}
    </div>
  </div>
</div>

<!-- NAV -->
<nav class="nav">
  <a href="#" class="active" onclick="return showTab('overview',this)">📊 Overview</a>
  <a href="#" onclick="return showTab('bugs',this)">🐛 Bugs${bugBadge}</a>
  <a href="#" onclick="return showTab('prompts',this)">📋 Prompts${promptBadge}</a>
  <a href="#" onclick="return showTab('online',this)">🌐 Online${onlineBadge}</a>
  <a href="#" onclick="return showTab('anomalies',this)">🔍 Anomalies${anomalyBadge}</a>
  <a href="#" onclick="return showTab('features',this)">💡 Features${featureBadge}</a>
  <a href="#" onclick="return showTab('ui',this)">🖼 UI${uiBadge}</a>
  <a href="#" onclick="return showTab('mechanics',this)">⚙️ Mechanics</a>
  <a href="#" onclick="return showTab('performance',this)">📈 Performance</a>
  <a href="#" onclick="return showTab('balance',this)">⚔️ Balance</a>
</nav>

<div class="container">

<!-- ═══ OVERVIEW ═══ -->
<div id="tab-overview" class="tab active">
  ${criticalSection}
  ${softlockSection}
  <div class="section">
    <h2>Run Summary</h2>
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-num">${qa.totalGamesRun}</div><div class="stat-lbl">Games Played</div></div>
      <div class="stat-card ${criticalBugs.length > 0 ? 'stat-bad' : totalBugs > 0 ? 'stat-warn' : 'stat-ok'}">
        <div class="stat-num">${totalBugs}</div><div class="stat-lbl">Bugs Found<small>${criticalBugs.length} critical</small></div>
      </div>
      <div class="stat-card ${softlockCount > 0 ? 'stat-bad' : 'stat-ok'}">
        <div class="stat-num">${softlockCount}</div><div class="stat-lbl">Softlocks</div>
      </div>
      <div class="stat-card ${uiErrors.length > 0 ? 'stat-bad' : uiIssues.length > 0 ? 'stat-warn' : 'stat-ok'}">
        <div class="stat-num">${uiIssues.length}</div><div class="stat-lbl">UI Issues<small>${uiErrors.length} errors</small></div>
      </div>
      <div class="stat-card ${(qa.allNaNs?.length || 0) > 0 ? 'stat-bad' : 'stat-ok'}">
        <div class="stat-num">${qa.allNaNs?.length || 0}</div><div class="stat-lbl">NaN Events</div>
      </div>
      <div class="stat-card"><div class="stat-num">${allPrompts.length}</div><div class="stat-lbl">Claude Prompts<small>ready to paste</small></div></div>
      <div class="stat-card ${onlineGrade && onlineGrade !== 'A' ? 'stat-warn' : 'stat-ok'}"><div class="stat-num" style="color:${onlineGrade ? ({ A: 'var(--green)', B: '#f1c40f', C: 'var(--orange)', D: 'var(--red)', F: 'var(--red)' }[onlineGrade] || 'var(--dim)') : 'var(--dim)'}">${onlineGrade || '—'}</div><div class="stat-lbl">Online Grade</div></div>
      <div class="stat-card ${anomalyCount > 0 ? (anomalyReport?.hasCritical ? 'stat-bad' : 'stat-warn') : 'stat-ok'}"><div class="stat-num">${anomalyCount}</div><div class="stat-lbl">Anomalies<small>behavioral</small></div></div>
      <div class="stat-card"><div class="stat-num">${featureCount}</div><div class="stat-lbl">Feature Ideas<small>AI-suggested</small></div></div>
    </div>
  </div>
  ${factions.length > 0 ? `<div class="section"><h2>Quick Faction Standings</h2>${barsHtml}</div>` : ''}
</div>

<!-- ═══ BUGS ═══ -->
<div id="tab-bugs" class="tab">
  <div class="section">
    <h2>Bug Reports (${diagnosedBugs.length})</h2>
    ${bugsHtml}
  </div>
</div>

<!-- ═══ PROMPTS ═══ -->
<div id="tab-prompts" class="tab">
  <div class="section">
    <h2>📋 Paste-to-Claude Prompts</h2>
    <p style="color:var(--dim);font-size:13px;margin-bottom:16px">Copy individual prompts or use "Copy All" to paste everything at once. Each prompt is self-contained and tells Claude exactly what's broken.</p>
    ${promptsHtml}
  </div>
</div>

<!-- ═══ ONLINE ═══ -->
<div id="tab-online" class="tab">
  <div class="section">
    <h2>🌐 Online Sync Test Results</h2>
    <p style="color:var(--dim);font-size:13px;margin-bottom:16px">Simulates P1→P2 snapshot relay with configurable network latency. Checks state divergence, mid capture arc visibility, and conquest zone sync.</p>
    ${onlineHtml}
  </div>
</div>

<!-- ═══ ANOMALIES ═══ -->
<div id="tab-anomalies" class="tab">
  <div class="section">
    <h2>🔍 Behavioral Anomalies</h2>
    <p style="color:var(--dim);font-size:13px;margin-bottom:16px">Suspicious patterns detected in game data beyond plain JS errors — extreme win rates, mechanics that never fire, position bias, draw rate anomalies, and timeout clustering.</p>
    ${anomalyHtml}
  </div>
</div>

<!-- ═══ FEATURES ═══ -->
<div id="tab-features" class="tab">
  <div class="section">
    <h2>💡 Feature Suggestions</h2>
    <p style="color:var(--dim);font-size:13px;margin-bottom:16px">AI-generated suggestions based on QA findings — underused mechanics, balance patterns, UX gaps, and online issues.</p>
    ${featureHtml}
  </div>
</div>

<!-- ═══ UI ═══ -->
<div id="tab-ui" class="tab">
  <div class="section">
    <h2>📸 Screenshots — click to enlarge</h2>
    ${ssHtml}
  </div>
  <div class="section">
    <h2>UI Issues (${uiIssues.length})</h2>
    ${uiHtml}
  </div>
</div>

<!-- ═══ MECHANICS ═══ -->
<div id="tab-mechanics" class="tab">
  <div class="section">
    <h2>⚙️ Mechanic Usage</h2>
    <p style="color:var(--dim);font-size:13px;margin-bottom:16px">Percentage of games where each mechanic was used. Under ${threshold}% is flagged — likely broken, too expensive, or players don't discover it.</p>
    ${mechHtml || `<div class="empty-state">No mechanic data (balance run required)</div>`}
  </div>
</div>

<!-- ═══ PERFORMANCE ═══ -->
<div id="tab-performance" class="tab">
  <div class="section"><h2>📈 Performance</h2>${perfHtml}</div>
</div>

<!-- ═══ BALANCE ═══ -->
<div id="tab-balance" class="tab">
  <div class="section">
    <h2>Win Rate Overview</h2>
    ${barsHtml || `<div class="empty-state">No balance data</div>`}
  </div>
  <div class="section">
    <h2>Matchup Matrix — hover cells for details</h2>
    <div class="legend">
      <span><span class="ld" style="background:rgba(231,76,60,.5)"></span>≥65% win</span>
      <span><span class="ld" style="background:rgba(230,126,34,.3)"></span>55–64%</span>
      <span><span class="ld" style="background:var(--border)"></span>45–54% balanced</span>
      <span><span class="ld" style="background:rgba(52,152,219,.3)"></span>35–44%</span>
      <span><span class="ld" style="background:rgba(142,68,173,.4)"></span>≤34% losing</span>
    </div>
    ${matrixHtml}
  </div>
  <div class="section analysis">
    <h2>🤖 AI Balance Analysis</h2>
    <div class="analysis">${balHtml}</div>
  </div>
</div>

</div><!-- /container -->

<script>
// ── Tab switching ──────────────────────────────────────────────────────────
function showTab(id, el) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.nav a').forEach(a => a.classList.remove('active'));
  document.getElementById('tab-' + id).classList.add('active');
  el.classList.add('active');
  return false;
}

// ── Bug toggle ─────────────────────────────────────────────────────────────
function toggleBug(i) {
  const body = document.getElementById('bugbody-' + i);
  const chev = document.getElementById('chev-' + i);
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : 'block';
  chev.style.transform = open ? '' : 'rotate(180deg)';
}

// ── Bug filter ─────────────────────────────────────────────────────────────
let _activeSev = 'ALL';
function setSevFilter(sev, btn) {
  _activeSev = sev;
  document.querySelectorAll('.sev-filter').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  filterBugs();
}
function filterBugs() {
  const q = (document.getElementById('bug-search')?.value || '').toLowerCase();
  document.querySelectorAll('#bug-list .bug-card').forEach(card => {
    const matchSev  = _activeSev === 'ALL' || card.dataset.sev === _activeSev;
    const matchText = !q || (card.dataset.text || '').toLowerCase().includes(q);
    card.style.display = (matchSev && matchText) ? '' : 'none';
  });
}

// ── Copy ───────────────────────────────────────────────────────────────────
function copyById(id, btn) {
  const el = document.getElementById(id);
  if (!el) return;
  navigator.clipboard.writeText(el.textContent).then(() => {
    const orig = btn.textContent;
    btn.textContent = '✅ Copied!';
    btn.style.background = 'rgba(46,204,113,.15)';
    setTimeout(() => { btn.textContent = orig; btn.style.background = ''; }, 2000);
  }).catch(() => {
    // Fallback for older browsers
    const ta = document.createElement('textarea');
    ta.value = el.textContent;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    btn.textContent = '✅ Copied!';
    setTimeout(() => btn.textContent = 'Copy', 2000);
  });
}

// ── Lightbox ───────────────────────────────────────────────────────────────
function openLightbox(src, label) {
  document.getElementById('lb-img').src = src;
  document.getElementById('lb-label').textContent = label;
  document.getElementById('lightbox').classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeLightbox() {
  document.getElementById('lightbox').classList.remove('open');
  document.body.style.overflow = '';
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLightbox(); });
</script>
</body>
</html>`;
}

// ── Markdown → HTML ────────────────────────────────────────────────────────
function mdToHtml(text) {
  return text
    .replace(/===BALANCE PROMPT START===([\s\S]+?)===BALANCE PROMPT END===/g, '$1') // already handled
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^\- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/gs, m => `<ul>${m}</ul>`)
    .replace(/\[HIGH\]/g, '<span style="color:var(--red);font-weight:700;">[HIGH]</span>')
    .replace(/\[MED\]/g, '<span style="color:var(--orange);font-weight:700;">[MED]</span>')
    .replace(/\[LOW\]/g, '<span style="color:var(--blue);font-weight:700;">[LOW]</span>')
    .replace(/\[CRITICAL\]/g, '<span style="color:var(--red);font-weight:700;">[CRITICAL]</span>')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/^(?!<[hup])/gm, '');
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escAttr(s) {
  return String(s).replace(/'/g, '&#39;').replace(/"/g, '&quot;');
}

module.exports = { buildReport };