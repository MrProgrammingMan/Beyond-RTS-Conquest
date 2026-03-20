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

// #26: render code snippets inline in bug cards.
// Standalone to avoid nested template-literal issues inside the big HTML builder.
function renderSnippets(snippets, bugIdx) {
  if (!snippets || snippets.length === 0) return '';
  const blocks = snippets.map(function (s, si) {
    const lbl = escHtml(s.label || ('Snippet ' + (si + 1)));
    const code = escHtml(s.code || '');
    return '<div class="snip-block">'
      + '<div class="snip-label">&#x1F4C4; ' + lbl + '</div>'
      + '<pre class="snip-code">' + code + '</pre>'
      + '</div>';
  }).join('');
  return '<details class="snip-details" id="snip-' + bugIdx + '">'
    + '<summary class="snip-summary">&#x1F50E; Code Snippets (' + snippets.length + ')</summary>'
    + blocks
    + '</details>';
}

const FACTION_ICONS = {
  warriors: '⚔️', summoners: '💀', brutes: '🪨', spirits: '✨',
  verdant: '🌿', infernal: '🔥', glacial: '❄️', voltborn: '⚡',
  bloodpact: '🩸', menders: '💚', weavers: '🕸️', merchants: '💰',
  reavers: '🦴', fortune: '🎲', plagued: '🧫', chrysalis: '🐛',
  tideborn: '🌊', echoes: '👁️', veilborn: '👻', chronomancers: '⏳',
  illusionists: '🪄', pandemonium: '🌀', psionics: '🧠', umbral: '🌑',
};

function buildReport({ balanceData, aggStats, balanceAnalysis, diagnosedBugs, uiAuditResult, onlineReport, anomalyReport, featureAdvice, runDiff, cfg, runMeta }) {
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
      // #27: confidence indicator — opacity scales with sample size so low-data
      // cells are visually dimmer. n= superscript shown when games < 10.
      const confidence = Math.min(1, 0.35 + (games / 10) * 0.65);
      const confCls = games < 5 ? ' conf-low' : games < 10 ? ' conf-med' : '';
      const nTag = games < 10 ? '<sup class="mat-n">n=' + games + '</sup>' : '';
      const confTip = games < 5 ? '\nLOW CONFIDENCE — only ' + games + ' games'
        : games < 10 ? '\nMEDIUM CONFIDENCE (' + games + ' games)'
          : '';
      matrixHtml += `<td class="${cls}${confCls}" style="opacity:${confidence.toFixed(2)}" title="${f1} vs ${f2}: ${rate}% win rate (${games} games)\n${r.p1Wins}W ${r.p2Wins}L ${r.draws}D ${r.timeouts}T${confTip}">${rate}%${nTag}</td>`;
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
          ${renderSnippets(bug.diagnosis?.codeSnippets || bug._codeSnippets, bi)}
          ${hasPrompt ? `<div class="prompt-box">
            <div class="prompt-label">📋 Paste to Claude</div>
            <pre class="prompt-text" id="bugprompt-${bi}">${escHtml(bug.diagnosis.pasteToClaudePrompt)}</pre>
            <button class="copy-btn" onclick="copyById('bugprompt-${bi}',this)">Copy</button>
            <button class="fix-btn" id="fixbtn-${bi}" onclick="applyFixForBug(${bi},this)" title="Generate a diff and apply it directly to index.html">🔧 Apply Fix</button>
          </div>` : ''}
          ${bug.screenshotPath ? `<div class="diag-row"><span class="diag-lbl">📸 Screenshot</span><span class="diag-val"><code>${escHtml(bug.screenshotPath)}</code></span></div>` : ''}
        </div>
      </div>`;
    }
    bugsHtml += `</div>`;
  }

  // ── Prompts tab ────────────────────────────────────────────────────────────
  const allPrompts = diagnosedBugs.filter(b => b.diagnosis?.pasteToClaudePrompt);

  // #9: structured mega-prompt — separate each bug with severity + matchup context
  // so Claude can keep track of which fix is which.
  const megaPrompt = allPrompts.length > 0
    ? allPrompts.map((b, i) => {
      const sev = (b.diagnosis?.severity || 'MEDIUM').toUpperCase();
      const type = b.type || 'error';
      const occ = b.occurrences > 1 ? ` (×${b.occurrences})` : '';
      const mu = (b.matchups || [b.matchup]).filter(Boolean).join(', ') || 'unknown';
      return [
        `${'─'.repeat(60)}`,
        `BUG ${i + 1} of ${allPrompts.length} | ${sev} | ${type}${occ}`,
        `Matchups: ${mu}`,
        `${'─'.repeat(60)}`,
        b.diagnosis.pasteToClaudePrompt,
      ].join('\n');
    }).join('\n\n')
    : '';

  // #6: UI Copy All prompt — bundles all UI issues into a single Claude-ready prompt
  const uiPromptText = uiIssues.length > 0
    ? [
      'You are fixing UI issues in index.html, a single-file browser RTS (~15k lines, vanilla JS + Canvas).',
      `${uiIssues.length} UI issue(s) were detected across ${(cfg.ui?.screens || []).join(', ')} screens.`,
      '',
      ...uiIssues.map((iss, i) => [
        `--- UI ISSUE ${i + 1} ---`,
        `Type: ${iss.type}`,
        `Severity: ${iss.severity}`,
        `Screen: ${iss.screen || 'unknown'}  Viewport: ${iss.viewportSize || 'unknown'}`,
        `Message: ${iss.message || ''}`,
        iss.element ? `Element: ${iss.element}` : '',
        iss.size ? `Size: ${iss.size.width}×${iss.size.height}px` : '',
      ].filter(Boolean).join('\n')),
      '',
      'Please fix each issue in index.html. Preserve all existing functionality.',
    ].join('\n')
    : null;

  // #8: combined feature suggestions prompt
  const allFeatureSuggestions = featureAdvice?.suggestions || [];
  const featuresWithPrompts = allFeatureSuggestions.filter(s => s.pasteToClaudePrompt);
  const featureMegaPrompt = featuresWithPrompts.length > 0
    ? featuresWithPrompts.map((s, i) => [
      `${'─'.repeat(60)}`,
      `FEATURE ${i + 1} of ${featuresWithPrompts.length} | ${(s.impact || '').toUpperCase()} IMPACT | effort: ${s.effort}`,
      `Category: ${s.category} | ${s.title}`,
      `${'─'.repeat(60)}`,
      s.pasteToClaudePrompt,
    ].join('\n')).join('\n\n')
    : null;

  // Anomaly prompts for inclusion in the Prompts tab (#7)
  const anomalyPrompts = (anomalyReport?.anomalies || []).filter(a => a.prompt);

  let promptsHtml = '';
  const totalPromptCount = allPrompts.length + anomalyPrompts.length + (uiPromptText ? 1 : 0) + (featureMegaPrompt ? 1 : 0);

  if (totalPromptCount === 0) {
    promptsHtml = `<div class="empty-state">No paste-to-Claude prompts generated (no bugs diagnosed, or no API key).</div>`;
  } else {

    // ── Section: Bug prompts ──────────────────────────────────────────────────
    if (allPrompts.length > 0) {
      promptsHtml += `<h3 class="prompts-section-title">🐛 Bug Fixes (${allPrompts.length})</h3>`;
      promptsHtml += `<div class="prompt-mega-box">
        <div class="prompt-mega-header">
          <div>
            <strong>All ${allPrompts.length} bug prompt(s) combined</strong>
            <span style="color:var(--dim);font-size:12px;margin-left:8px">Includes severity, matchup context, and separators so Claude can track each fix</span>
          </div>
          <button class="copy-btn copy-big" onclick="copyById('mega-prompt',this)">📋 Copy All Bugs (${allPrompts.length})</button>
        </div>
        <pre class="prompt-text" id="mega-prompt" style="max-height:200px">${escHtml(megaPrompt)}</pre>
      </div>`;

      for (let i = 0; i < allPrompts.length; i++) {
        const bug = allPrompts[i];
        const sev = (bug.diagnosis?.severity || '').toUpperCase();
        const sevCls = sev === 'CRITICAL' ? 'sev-critical' : sev === 'HIGH' ? 'sev-high' : sev === 'MEDIUM' ? 'sev-medium' : 'sev-low';
        const mu = escHtml((bug.matchups || [bug.matchup]).filter(Boolean).join(', '));
        const pid = `prompt-bug-${i}`;
        // #10: done/fixed checkbox — state persisted in localStorage
        promptsHtml += `<div class="prompt-card ${sevCls}" id="pcard-bug-${i}">
          <div class="prompt-card-header">
            <label class="done-label" title="Mark as fixed">
              <input type="checkbox" class="done-cb" data-done-type="bug" data-done-idx="${i}" onchange="markDone('bug',${i},this.checked)">
              <span class="done-txt">Done</span>
            </label>
            <span class="bug-sev-badge ${sevCls}">${sev}</span>
            <span class="prompt-bug-type">${escHtml(bug.type || 'error')}</span>
            <span style="color:var(--dim);font-size:12px">${mu}</span>
          </div>
          <pre class="prompt-text" id="${pid}">${escHtml(bug.diagnosis.pasteToClaudePrompt)}</pre>
          <button class="copy-btn" onclick="copyById('${pid}',this)">Copy</button>
        </div>`;
      }
    }

    // ── Section: Balance prompt ───────────────────────────────────────────────
    if (balanceAnalysis) {
      const bm = balanceAnalysis.match(/===BALANCE PROMPT START===([\s\S]+?)===BALANCE PROMPT END===/);
      if (bm) {
        promptsHtml += `<h3 class="prompts-section-title">⚖️ Balance Patch</h3>`;
        promptsHtml += `<div class="prompt-card" style="border-color:var(--gold)">
          <div class="prompt-card-header">
            <label class="done-label"><input type="checkbox" class="done-cb" data-done-type="balance" data-done-idx="0" onchange="markDone('balance',0,this.checked)"><span class="done-txt">Done</span></label>
            <span class="bug-sev-badge" style="background:rgba(240,165,0,.2);color:var(--gold)">BALANCE</span>
            <span class="prompt-bug-type">Balance Patch Prompt</span>
          </div>
          <pre class="prompt-text" id="balance-prompt">${escHtml(bm[1].trim())}</pre>
          <button class="copy-btn" onclick="copyById('balance-prompt',this)">Copy</button>
        </div>`;
      }
    }

    // ── Section: Anomaly prompts (#7) ─────────────────────────────────────────
    if (anomalyPrompts.length > 0) {
      promptsHtml += `<h3 class="prompts-section-title">🔍 Anomaly Fixes (${anomalyPrompts.length})</h3>`;
      for (let i = 0; i < anomalyPrompts.length; i++) {
        const a = anomalyPrompts[i];
        const sevCls = a.severity === 'HIGH' ? 'sev-high' : a.severity === 'MEDIUM' ? 'sev-medium' : 'sev-low';
        const pid = `prompt-anom-${i}`;
        promptsHtml += `<div class="prompt-card ${sevCls}" id="pcard-anom-${i}">
          <div class="prompt-card-header">
            <label class="done-label"><input type="checkbox" class="done-cb" data-done-type="anom" data-done-idx="${i}" onchange="markDone('anom',${i},this.checked)"><span class="done-txt">Done</span></label>
            <span class="bug-sev-badge ${sevCls}">${escHtml(a.severity)}</span>
            <span class="prompt-bug-type">${escHtml(a.title)}</span>
          </div>
          <pre class="prompt-text" id="${pid}">${escHtml(a.prompt)}</pre>
          <button class="copy-btn" onclick="copyById('${pid}',this)">Copy</button>
        </div>`;
      }
    }

    // ── Section: UI issues prompt (#6) ────────────────────────────────────────
    if (uiPromptText) {
      promptsHtml += `<h3 class="prompts-section-title">🖼 UI Issues (${uiIssues.length} issues, 1 combined prompt)</h3>`;
      promptsHtml += `<div class="prompt-card" style="border-color:var(--blue)" id="pcard-ui-0">
        <div class="prompt-card-header">
          <label class="done-label"><input type="checkbox" class="done-cb" data-done-type="ui" data-done-idx="0" onchange="markDone('ui',0,this.checked)"><span class="done-txt">Done</span></label>
          <span class="bug-sev-badge" style="background:rgba(52,152,219,.2);color:var(--blue)">UI</span>
          <span class="prompt-bug-type">All ${uiIssues.length} UI issues bundled</span>
        </div>
        <pre class="prompt-text" id="prompt-ui-all">${escHtml(uiPromptText)}</pre>
        <button class="copy-btn" onclick="copyById('prompt-ui-all',this)">📋 Copy All UI Issues</button>
      </div>`;
    }

    // ── Section: Feature suggestions prompt (#8) ──────────────────────────────
    if (featureMegaPrompt) {
      promptsHtml += `<h3 class="prompts-section-title">💡 Feature Implementations (${featuresWithPrompts.length})</h3>`;
      promptsHtml += `<div class="prompt-mega-box">
        <div class="prompt-mega-header">
          <div>
            <strong>${featuresWithPrompts.length} feature prompt(s) combined</strong>
          </div>
          <button class="copy-btn copy-big" onclick="copyById('mega-features',this)">📋 Copy All Features (${featuresWithPrompts.length})</button>
        </div>
        <pre class="prompt-text" id="mega-features" style="max-height:200px">${escHtml(featureMegaPrompt)}</pre>
      </div>`;
      for (let i = 0; i < featuresWithPrompts.length; i++) {
        const s = featuresWithPrompts[i];
        const pid = `prompt-feat-${i}`;
        const impactCls = s.impact === 'high' ? 'sev-high' : s.impact === 'medium' ? 'sev-medium' : 'sev-low';
        promptsHtml += `<div class="prompt-card ${impactCls}" id="pcard-feat-${i}">
          <div class="prompt-card-header">
            <label class="done-label"><input type="checkbox" class="done-cb" data-done-type="feat" data-done-idx="${i}" onchange="markDone('feat',${i},this.checked)"><span class="done-txt">Done</span></label>
            <span class="bug-sev-badge ${impactCls}">${(s.impact || 'med').toUpperCase()}</span>
            <span class="prompt-bug-type">${escHtml(s.title)}</span>
            <span style="color:var(--dim);font-size:12px">effort: ${escHtml(s.effort)}</span>
          </div>
          <pre class="prompt-text" id="${pid}">${escHtml(s.pasteToClaudePrompt)}</pre>
          <button class="copy-btn" onclick="copyById('${pid}',this)">Copy</button>
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
    balHtml = sanitiseForInlineHtml(mdToHtml(cleaned));
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

  // ── Delta / diff tab ───────────────────────────────────────────────────────
  let deltaTabHtml = '';
  let deltaBadge = '';
  if (runDiff) {
    const prevDate = new Date(runDiff.previousTimestamp).toLocaleString();
    const { newBugs, resolvedBugs, persistingBugs, winRateDeltas, bugCountDelta,
      softlockDelta, nanDelta, gameCountDelta } = runDiff;

    // ── Bug diff cards ───────────────────────────────────────────────────────
    const SEV_COLOR = { CRITICAL: 'var(--red)', HIGH: 'var(--orange)', MEDIUM: '#f1c40f', LOW: 'var(--blue)' };

    const bugDiffRows = (bugs, icon, emptyMsg) => {
      if (!bugs.length) return `<div style="color:var(--dim);font-size:13px;padding:8px 0">${emptyMsg}</div>`;
      return bugs.map(b => {
        const col = SEV_COLOR[b.severity] || 'var(--dim)';
        const matchupStr = b.matchups?.length ? `<span style="color:var(--dim);font-size:11px;margin-left:8px">${escHtml(b.matchups.slice(0, 3).join(', '))}</span>` : '';
        return `<div style="display:flex;align-items:baseline;gap:8px;padding:7px 10px;border-bottom:1px solid var(--border);font-size:13px;">
          <span style="font-size:16px">${icon}</span>
          <span style="color:${col};font-weight:700;font-size:11px;padding:1px 6px;border-radius:10px;background:${col}22;white-space:nowrap">${escHtml(b.severity)}</span>
          <span style="flex:1"><code style="font-size:11px">${escHtml(b.type)}</code> ${escHtml(b.message)}</span>
          ${matchupStr}
        </div>`;
      }).join('');
    };

    // ── Win rate delta table ─────────────────────────────────────────────────
    const significantMoves = winRateDeltas.filter(d => d.delta !== null && Math.abs(d.delta) >= 1);
    const stableFactions = winRateDeltas.filter(d => d.delta !== null && Math.abs(d.delta) < 1);

    const deltaRows = significantMoves.map(d => {
      const arrow = d.delta > 0 ? '↑' : '↓';
      const arrowColor = d.delta > 0 ? 'var(--orange)' : '#74b9ff';
      const absDelta = Math.abs(d.delta);
      const barW = Math.min(absDelta * 8, 100);
      const barColor = d.delta > 0 ? 'rgba(231,76,60,.5)' : 'rgba(52,152,219,.5)';
      return `<tr>
        <td style="padding:6px 10px;font-weight:600">${FACTION_ICONS[d.faction] || ''} ${escHtml(d.faction)}</td>
        <td style="padding:6px 10px;text-align:right;color:var(--dim)">${d.prev}%</td>
        <td style="padding:6px 10px;text-align:center">→</td>
        <td style="padding:6px 10px;font-weight:700">${d.curr}%</td>
        <td style="padding:6px 10px;text-align:right">
          <span style="color:${arrowColor};font-weight:700">${arrow} ${Math.abs(d.delta)}%</span>
          <div style="width:${barW}px;height:4px;background:${barColor};border-radius:2px;margin-top:3px;margin-left:auto"></div>
        </td>
      </tr>`;
    }).join('');

    const stableRow = stableFactions.length
      ? `<tr><td colspan="5" style="padding:8px 10px;color:var(--dimmer);font-size:12px">
          ${stableFactions.map(d => `${escHtml(d.faction)} (±${Math.abs(d.delta || 0)}%)`).join(' · ')} — no significant change
        </td></tr>` : '';

    // ── Metric delta cards ───────────────────────────────────────────────────
    const metricCard = (label, val, prev, delta, unit = '') => {
      const sign = delta > 0 ? '+' : '';
      const col = delta === 0 ? 'var(--dim)' : label.includes('bug') || label.includes('softlock') || label.includes('NaN')
        ? (delta > 0 ? 'var(--red)' : 'var(--green)')
        : (delta > 0 ? 'var(--green)' : 'var(--dim)');
      return `<div class="stat-card">
        <div class="stat-num" style="font-size:1.3rem">${val}${unit}</div>
        <div class="stat-lbl">${label}<small style="color:${col}">${sign}${delta}${unit} vs last run</small></div>
      </div>`;
    };

    deltaBadge = newBugs.length > 0
      ? ` <span class="nav-badge badge-red">+${newBugs.length}</span>`
      : resolvedBugs.length > 0
        ? ` <span class="nav-badge badge-green">-${resolvedBugs.length}</span>`
        : ` <span class="nav-badge badge-gold">↔</span>`;

    deltaTabHtml = `
<div id="tab-delta" class="tab">
  <div class="section">
    <h2>📊 Delta vs Previous Run</h2>
    <div style="color:var(--dim);font-size:13px;margin-bottom:16px">
      Comparing this run against: <strong style="color:var(--text)">${escHtml(prevDate)}</strong>
    </div>
    <div class="stats-grid">
      ${metricCard('Bugs', runDiff.bugCountDelta >= 0 ? '+' + runDiff.bugCountDelta : runDiff.bugCountDelta, null, runDiff.bugCountDelta)}
      ${metricCard('New bugs', newBugs.length, null, newBugs.length)}
      ${metricCard('Resolved bugs', resolvedBugs.length, null, -resolvedBugs.length)}
      ${metricCard('Softlocks', softlockDelta >= 0 ? '+' + softlockDelta : softlockDelta, null, softlockDelta)}
      ${metricCard('NaN events', nanDelta >= 0 ? '+' + nanDelta : nanDelta, null, nanDelta)}
      ${metricCard('Games run', gameCountDelta >= 0 ? '+' + gameCountDelta : gameCountDelta, null, gameCountDelta)}
    </div>
  </div>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:20px" class="delta-grid">
    <!-- New bugs -->
    <div class="section" style="margin:0">
      <h2>🆕 New Bugs (${newBugs.length})</h2>
      ${bugDiffRows(newBugs, '🆕', '✅ No new bugs — nothing appeared this run that wasn\'t in the last run')}
    </div>
    <!-- Resolved bugs -->
    <div class="section" style="margin:0">
      <h2>✅ Resolved Bugs (${resolvedBugs.length})</h2>
      ${bugDiffRows(resolvedBugs, '✅', resolvedBugs.length === 0 && persistingBugs.length > 0 ? '⚠️ No bugs resolved — all previous bugs still present' : 'No previous bugs to compare against')}
    </div>
  </div>

  ${persistingBugs.length > 0 ? `<div class="section">
    <h2>🔁 Persisting Bugs (${persistingBugs.length})</h2>
    <p style="color:var(--dim);font-size:13px;margin-bottom:12px">These bugs were present in the last run and are still present now.</p>
    ${bugDiffRows(persistingBugs, '🔁', '')}
  </div>` : ''}

  ${winRateDeltas.length > 0 ? `<div class="section">
    <h2>⚖️ Win Rate Changes</h2>
    ${significantMoves.length === 0 ? '<p style="color:var(--dim)">No faction moved by ≥1% — balance is stable.</p>' : ''}
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead>
        <tr>
          <th style="text-align:left;padding:6px 10px;color:var(--dim);font-size:12px">Faction</th>
          <th style="text-align:right;padding:6px 10px;color:var(--dim);font-size:12px">Previous</th>
          <th style="text-align:center;padding:6px 10px;color:var(--dim);font-size:12px"></th>
          <th style="text-align:left;padding:6px 10px;color:var(--dim);font-size:12px">Current</th>
          <th style="text-align:right;padding:6px 10px;color:var(--dim);font-size:12px">Change</th>
        </tr>
      </thead>
      <tbody>
        ${deltaRows}
        ${stableRow}
      </tbody>
    </table>
  </div>` : ''}
</div>`;
  } else {
    // No previous run
    deltaBadge = '';
    deltaTabHtml = `
<div id="tab-delta" class="tab">
  <div class="section" style="text-align:center;padding:60px 20px">
    <div style="font-size:3rem;margin-bottom:16px">📊</div>
    <h2 style="border:none;text-align:center;margin-bottom:12px">No Previous Run to Compare</h2>
    <p style="color:var(--dim);max-width:500px;margin:0 auto">
      This is the first run saved to history. After your next QA run, this tab will show
      which bugs are new, which were resolved, and how win rates changed.
    </p>
    <p style="color:var(--dimmer);font-size:12px;margin-top:16px">
      History is saved to <code>qa-history.json</code> — keep this file between runs.
    </p>
  </div>
</div>`;
  }

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
  // NOTE: sanitiseForInlineHtml is applied to individual dynamic variables
  // (e.g. balHtml) before interpolation — NOT to the whole output, because
  // that would replace the legitimate </script> closing tag and break all JS.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Beyond RTS Conquest — QA Report</title>
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
.nav-kb-hint{margin-left:auto;padding:0 16px;color:var(--dimmer);font-size:11px;align-self:center;white-space:nowrap;cursor:pointer;}
.nav-kb-hint:hover{color:var(--dim);}
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
/* ── Code snippets in bug cards (#26) ── */
.snip-details{margin:10px 0 4px;}
.snip-summary{cursor:pointer;color:var(--blue);font-size:12px;font-weight:600;padding:4px 0;list-style:none;display:flex;align-items:center;gap:6px;}
.snip-summary::-webkit-details-marker{display:none;}
.snip-summary::before{content:'▶';font-size:10px;transition:transform .15s;}
details[open] .snip-summary::before{transform:rotate(90deg);}
.snip-block{margin:8px 0;}
.snip-label{font-size:11px;color:var(--dim);font-weight:600;margin-bottom:4px;font-family:monospace;}
.snip-code{font-size:11px;line-height:1.5;max-height:300px;overflow-y:auto;background:#060810;border:1px solid var(--border);border-radius:4px;padding:10px;color:#a8d8ea;white-space:pre;}
/* ── Matrix confidence indicator (#27) ── */
.mat-n{font-size:9px;color:var(--dimmer);margin-left:2px;font-weight:400;vertical-align:super;}
.matrix td.conf-low{font-style:italic;}
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
.bug-card.kb-focus{outline:2px solid var(--gold);outline-offset:1px;}
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
/* ── Prompts tab enhancements ── */
.prompts-section-title{font-size:.8rem;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);margin:24px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--border);}
.done-label{display:inline-flex;align-items:center;gap:5px;cursor:pointer;user-select:none;margin-right:4px;}
.done-cb{accent-color:var(--green);cursor:pointer;width:14px;height:14px;}
.done-txt{font-size:11px;color:var(--dim);}
.prompt-card.is-done{opacity:.4;transition:opacity .2s;}
.prompt-card.is-done .prompt-card-header::after{content:' ✅ Fixed';color:var(--green);font-size:11px;margin-left:auto;}
/* ── Empty state ── */
.empty-state{padding:24px;text-align:center;color:var(--green);font-weight:600;font-size:14px;}
/* ── Apply Fix button + diff modal (#11) ── */
.fix-btn{margin-top:8px;background:rgba(46,204,113,.08);border:1px solid rgba(46,204,113,.4);color:var(--green);padding:6px 14px;border-radius:5px;cursor:pointer;font:12px/1 inherit;font-weight:600;transition:all .15s;margin-left:8px;}
.fix-btn:hover{background:var(--green);color:#000;}
.fix-btn:disabled{opacity:.4;cursor:not-allowed;}
.fix-btn.loading{opacity:.6;}
#diff-modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,.88);z-index:9998;align-items:center;justify-content:center;}
#diff-modal.open{display:flex;}
.diff-modal-box{background:var(--surface);border:2px solid var(--green);border-radius:12px;width:min(860px,96vw);max-height:88vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 0 60px rgba(0,0,0,.8);}
.diff-modal-header{padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;flex-wrap:wrap;}
.diff-modal-title{font-size:1rem;font-weight:700;color:var(--green);}
.diff-confidence{font-size:11px;font-weight:700;padding:2px 8px;border-radius:10px;}
.conf-HIGH{background:rgba(46,204,113,.2);color:var(--green);}
.conf-MEDIUM{background:rgba(241,196,15,.15);color:#f1c40f;}
.conf-LOW{background:rgba(231,76,60,.15);color:var(--red);}
.diff-modal-summary{font-size:13px;color:var(--text);flex:1;min-width:200px;}
.diff-modal-close{margin-left:auto;background:none;border:none;color:var(--dim);font-size:20px;cursor:pointer;line-height:1;padding:4px;}
.diff-modal-close:hover{color:#fff;}
.diff-modal-body{flex:1;overflow-y:auto;padding:16px 20px;}
.diff-viewer{font:12px/1.6 'JetBrains Mono','Consolas',monospace;background:#060810;border:1px solid var(--border);border-radius:6px;padding:12px;overflow-x:auto;white-space:pre;}
.diff-line-add{color:#5af78e;background:rgba(46,204,113,.07);}
.diff-line-del{color:#ff5c57;background:rgba(231,76,60,.07);}
.diff-line-hunk{color:#57c7ff;font-weight:600;}
.diff-line-ctx{color:#636d83;}
.diff-modal-footer{padding:14px 20px;border-top:1px solid var(--border);display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.diff-modal-footer p{font-size:12px;color:var(--dim);flex:1;}
.diff-apply-btn{background:var(--green);border:none;color:#000;padding:9px 22px;border-radius:6px;cursor:pointer;font:13px/1 inherit;font-weight:700;transition:all .15s;}
.diff-apply-btn:hover{background:#00d68f;}
.diff-apply-btn:disabled{opacity:.5;cursor:not-allowed;}
.diff-cancel-btn{background:none;border:1px solid var(--border);color:var(--dim);padding:8px 18px;border-radius:6px;cursor:pointer;font:13px/1 inherit;}
.diff-cancel-btn:hover{border-color:var(--text);color:var(--text);}
.diff-server-offline{padding:40px;text-align:center;color:var(--dim);}
.diff-server-offline h3{color:var(--orange);margin-bottom:12px;}
/* ── Delta tab ── */
.delta-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:20px;}
/* ── Responsive ── */
@media(max-width:900px){.delta-grid{grid-template-columns:1fr;}}
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

<!-- DIFF MODAL (#11) -->
<div id="diff-modal" onclick="if(event.target===this)closeDiffModal()">
  <div class="diff-modal-box">
    <div class="diff-modal-header">
      <span class="diff-modal-title">🔧 Proposed Fix</span>
      <span class="diff-confidence" id="diff-conf-badge"></span>
      <span class="diff-modal-summary" id="diff-summary-text"></span>
      <button class="diff-modal-close" onclick="closeDiffModal()">✕</button>
    </div>
    <div class="diff-modal-body">
      <div id="diff-modal-content"></div>
    </div>
    <div class="diff-modal-footer">
      <p id="diff-footer-note">Review the diff above carefully before applying. A timestamped backup of index.html will be created automatically.</p>
      <button class="diff-cancel-btn" onclick="closeDiffModal()">Cancel</button>
      <button class="diff-apply-btn" id="diff-apply-btn" onclick="confirmFix()">✅ Apply Fix</button>
    </div>
  </div>
</div>

<!-- HEADER -->
<div class="header">
  <div class="header-icon">⚔️</div>
  <div>
    <div class="header-title">Beyond RTS Conquest — QA Report</div>
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
  <a href="#" onclick="return showTab('delta',this)">📊 Delta${deltaBadge}</a>
  <a href="#" onclick="return showTab('ui',this)">🖼 UI${uiBadge}</a>
  <a href="#" onclick="return showTab('mechanics',this)">⚙️ Mechanics</a>
  <a href="#" onclick="return showTab('performance',this)">📈 Performance</a>
  <a href="#" onclick="return showTab('balance',this)">⚔️ Balance</a>
  <span class="nav-kb-hint" onclick="_toggleKbHelp()" title="Keyboard shortcuts">&#x2328; ?</span>
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

<!-- ═══ DELTA ═══ -->
${deltaTabHtml}

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

// ── Done / fixed checkboxes (#10) ─────────────────────────────────────────
// Persists "done" state in localStorage so checked items survive page reload.
function _doneKey(type, idx) { return 'qa_done_' + type + '_' + idx; }

function markDone(type, idx, done) {
  try { localStorage.setItem(_doneKey(type, idx), done ? '1' : '0'); } catch(_) {}
  const card = document.getElementById('pcard-' + type + '-' + idx);
  if (card) card.classList.toggle('is-done', done);
}

// Restore checkbox state on load
(function restoreDoneState() {
  document.querySelectorAll('.done-cb[data-done-type]').forEach(cb => {
    const type = cb.getAttribute('data-done-type');
    const idx  = cb.getAttribute('data-done-idx');
    if (!type || idx == null) return;
    try {
      const saved = localStorage.getItem(_doneKey(type, idx));
      if (saved === '1') {
        cb.checked = true;
        const card = document.getElementById('pcard-' + type + '-' + idx);
        if (card) card.classList.add('is-done');
      }
    } catch(_) {}
  });
})();

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
// ── Keyboard navigation (#25) ────────────────────────────────────────────
// 1–9, 0 : switch tabs (order matches the nav bar left-to-right)
// j / k   : move to next / prev visible bug card (on the Bugs tab)
// c       : copy the paste-to-Claude prompt of the focused bug card
// Escape  : close lightbox or dismiss focus ring
// ?       : show/hide keyboard shortcut help
const _TAB_ORDER = ['overview','bugs','prompts','online','anomalies','features','delta','ui','mechanics','performance','balance'];

function _switchTabByIndex(n) {
  const id = _TAB_ORDER[n];
  if (!id) return;
  const link = document.querySelector('.nav a[onclick*="showTab(\\'' + id + '\\')"]');
  if (link) { link.click(); link.focus(); }
}

// Bug card keyboard focus
let _focusedBugIdx = -1;

function _visibleBugCards() {
  return Array.from(document.querySelectorAll('#bug-list .bug-card'))
    .filter(c => c.style.display !== 'none');
}

function _focusBugCard(idx) {
  const cards = _visibleBugCards();
  if (!cards.length) return;
  idx = ((idx % cards.length) + cards.length) % cards.length;
  _focusedBugIdx = idx;
  // Remove old focus ring
  document.querySelectorAll('.bug-card.kb-focus').forEach(c => c.classList.remove('kb-focus'));
  const card = cards[idx];
  card.classList.add('kb-focus');
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function _copyFocusedBugPrompt() {
  const cards = _visibleBugCards();
  if (_focusedBugIdx < 0 || _focusedBugIdx >= cards.length) return;
  const card  = cards[_focusedBugIdx];
  // Find the prompt pre inside the focused card
  const pre = card.querySelector('.prompt-text');
  if (!pre) { _showKbToast('No prompt in this bug card'); return; }
  const btn = card.querySelector('.copy-btn');
  if (btn) copyById(pre.id, btn);
  else {
    navigator.clipboard.writeText(pre.textContent)
      .then(() => _showKbToast('Copied!'))
      .catch(() => _showKbToast('Copy failed'));
  }
}

function _showKbToast(msg) {
  let t = document.getElementById('kb-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'kb-toast';
    t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1a1d24;border:1px solid var(--gold);color:var(--gold);padding:8px 18px;border-radius:20px;font-size:13px;font-weight:600;z-index:9998;pointer-events:none;transition:opacity .3s;';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.style.opacity = '0'; }, 1800);
}

// Help overlay
function _toggleKbHelp() {
  let h = document.getElementById('kb-help');
  if (h) { h.remove(); return; }
  h = document.createElement('div');
  h.id = 'kb-help';
  h.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#13151a;border:2px solid var(--gold);border-radius:12px;padding:28px 36px;z-index:9999;min-width:320px;box-shadow:0 0 60px rgba(0,0,0,.8);';
  h.innerHTML = '<h3 style="color:var(--gold);margin-bottom:16px;font-size:.9rem;letter-spacing:1px;text-transform:uppercase;">⌨️ Keyboard Shortcuts</h3>'
    + '<table style="border-collapse:collapse;font-size:13px;width:100%">'
    + ['1–9, 0|Switch tabs (Overview → Balance)',
       'j|Next visible bug card',
       'k|Previous visible bug card',
       'c|Copy prompt of focused bug',
       'Escape|Close overlay / clear focus',
       '?|Toggle this help'].map(row => {
         const [key, desc] = row.split('|');
         return '<tr><td style="padding:5px 16px 5px 0;color:var(--gold);font-family:monospace;font-weight:700;white-space:nowrap">' + key + '</td>'
              + '<td style="padding:5px 0;color:var(--text)">' + desc + '</td></tr>';
       }).join('')
    + '</table>'
    + '<p style="color:var(--dim);font-size:11px;margin-top:14px;text-align:center">Press ? or Escape to close</p>';
  h.onclick = e => { if (e.target === h) h.remove(); };
  document.body.appendChild(h);
}

document.addEventListener('keydown', e => {
  // Never fire when typing in an input/textarea
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;

  // Escape — close lightbox or help overlay or clear bug focus
  if (e.key === 'Escape') {
    if (document.getElementById('kb-help')) { document.getElementById('kb-help').remove(); return; }
    if (document.getElementById('lightbox')?.classList.contains('open')) { closeLightbox(); return; }
    document.querySelectorAll('.bug-card.kb-focus').forEach(c => c.classList.remove('kb-focus'));
    _focusedBugIdx = -1;
    return;
  }

  // ? — help overlay
  if (e.key === '?') { e.preventDefault(); _toggleKbHelp(); return; }

  // 1–9 → tabs 0–8, 0 → tab 9 (balance)
  if (/^[0-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const n = e.key === '0' ? 9 : parseInt(e.key) - 1;
    _switchTabByIndex(n);
    return;
  }

  // j / k — bug navigation (only meaningful on the bugs tab)
  if (e.key === 'j' || e.key === 'k') {
    const activeBugTab = document.getElementById('tab-bugs')?.classList.contains('active');
    if (!activeBugTab) {
      // Switch to bugs tab first
      _switchTabByIndex(1);
    }
    const delta = e.key === 'j' ? 1 : -1;
    const cards = _visibleBugCards();
    if (!cards.length) { _showKbToast('No bugs to navigate'); return; }
    _focusBugCard(_focusedBugIdx < 0 ? (delta > 0 ? 0 : cards.length - 1) : _focusedBugIdx + delta);
    return;
  }

  // c — copy focused bug prompt
  if (e.key === 'c' && !e.ctrlKey && !e.metaKey) {
    if (_focusedBugIdx >= 0) { _copyFocusedBugPrompt(); return; }
  }
});
// ── Auto-fix (#11) ────────────────────────────────────────────────────────────
const FIX_SERVER = 'http://localhost:3742';
let _pendingDiff = null;   // diff string waiting for user confirmation

async function _serverAlive() {
  try {
    const r = await fetch(FIX_SERVER + '/ping', { signal: AbortSignal.timeout(1200) });
    return r.ok;
  } catch (_) { return false; }
}

async function applyFixForBug(bugIdx, btn) {
  btn.disabled = true;
  btn.classList.add('loading');
  btn.textContent = '⏳ Generating…';

  // Check server first
  const alive = await _serverAlive();
  if (!alive) {
    btn.disabled = false;
    btn.classList.remove('loading');
    btn.textContent = '🔧 Apply Fix';
    _showDiffOffline();
    return;
  }

  try {
    const resp = await fetch(FIX_SERVER + '/fix', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bugIndex: bugIdx }),
    });
    const fixResult = await resp.json();

    btn.disabled = false;
    btn.classList.remove('loading');
    btn.textContent = '🔧 Apply Fix';

    if (!fixResult.ok) {
      _showDiffModal({ ok: false, summary: fixResult.summary || 'No fix available', diff: '', confidence: 'LOW' });
    } else {
      _showDiffModal(fixResult);
    }
  } catch (err) {
    btn.disabled = false;
    btn.classList.remove('loading');
    btn.textContent = '🔧 Apply Fix';
    _showDiffModal({ ok: false, summary: 'Request failed: ' + err.message, diff: '', confidence: 'LOW' });
  }
}

function _showDiffOffline() {
  document.getElementById('diff-conf-badge').textContent = '';
  document.getElementById('diff-conf-badge').className = 'diff-confidence';
  document.getElementById('diff-summary-text').textContent = '';
  document.getElementById('diff-modal-content').innerHTML = \`
    <div class="diff-server-offline">
      <h3>🔌 Fix server not running</h3>
      <p>The local fix server wasn't detected at <code>http://localhost:3742</code>.</p>
      <p style="margin-top:10px">To enable Apply Fix buttons, run QA with the server active:</p>
      <pre style="margin:12px auto;max-width:340px;text-align:left">node run.js --analyze-only</pre>
      <p style="font-size:12px;color:var(--dimmer);margin-top:10px">The server starts automatically after any run.js execution<br>unless <code>--no-server</code> is passed.</p>
    </div>\`;
  document.getElementById('diff-apply-btn').style.display = 'none';
  document.getElementById('diff-modal').classList.add('open');
}

function _showDiffModal(fixResult) {
  _pendingDiff = fixResult.ok ? fixResult.diff : null;

  const confBadge = document.getElementById('diff-conf-badge');
  const conf = (fixResult.confidence || 'LOW').toUpperCase();
  confBadge.textContent = conf;
  confBadge.className = 'diff-confidence conf-' + conf;

  document.getElementById('diff-summary-text').textContent = fixResult.summary || '';

  const applyBtn = document.getElementById('diff-apply-btn');
  applyBtn.style.display = '';

  if (!fixResult.ok || !fixResult.diff) {
    document.getElementById('diff-modal-content').innerHTML =
      \`<div style="padding:24px;color:var(--orange);font-size:13px">
        ⚠️ \${escHtmlJs(fixResult.summary || 'Claude could not produce a confident fix for this bug.')}
        <p style="margin-top:12px;color:var(--dim)">You can still copy the prompt above and apply the fix manually in Claude.</p>
       </div>\`;
    applyBtn.disabled = true;
  } else {
    document.getElementById('diff-modal-content').innerHTML =
      \`<div class="diff-viewer">\${_renderDiff(fixResult.diff)}</div>\`;
    applyBtn.disabled = conf === 'LOW';
    if (conf === 'LOW') {
      document.getElementById('diff-footer-note').textContent =
        '⚠️ Low confidence — Claude is unsure about this fix. Review carefully before applying.';
    }
  }

  document.getElementById('diff-modal').classList.add('open');
}

async function confirmFix() {
  if (!_pendingDiff) return;
  const btn = document.getElementById('diff-apply-btn');
  btn.disabled = true;
  btn.textContent = '⏳ Applying…';

  try {
    const resp = await fetch(FIX_SERVER + '/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ diff: _pendingDiff }),
    });
    const result = await resp.json();
    closeDiffModal();
    if (result.success) {
      _showKbToast(\`✅ Fix applied! Backup: \${result.backupPath?.split(/[\\/\\\\]/).pop() || 'created'}\`);
    } else {
      _showKbToast('❌ Apply failed: ' + (result.error || 'unknown error'));
    }
  } catch (err) {
    closeDiffModal();
    _showKbToast('❌ Apply failed: ' + err.message);
  }
}

function closeDiffModal() {
  document.getElementById('diff-modal').classList.remove('open');
  _pendingDiff = null;
  const applyBtn = document.getElementById('diff-apply-btn');
  applyBtn.disabled = false;
  applyBtn.textContent = '✅ Apply Fix';
  document.getElementById('diff-footer-note').textContent =
    'Review the diff above carefully before applying. A timestamped backup of index.html will be created automatically.';
}

function _renderDiff(diff) {
  return diff.split('\\n').map(line => {
    const e = escHtmlJs(line);
    if (line.startsWith('+++') || line.startsWith('---')) return \`<span class="diff-line-hunk">\${e}</span>\\n\`;
    if (line.startsWith('+'))  return \`<span class="diff-line-add">\${e}</span>\\n\`;
    if (line.startsWith('-'))  return \`<span class="diff-line-del">\${e}</span>\\n\`;
    if (line.startsWith('@@')) return \`<span class="diff-line-hunk">\${e}</span>\\n\`;
    return \`<span class="diff-line-ctx">\${e}</span>\\n\`;
  }).join('');
}

// Minimal in-JS HTML escaper (can't call Node's escHtml from browser)
function escHtmlJs(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
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

// Prevent Claude-generated HTML content from breaking the page's <script> block.
// Any </script> tag inside rendered HTML would prematurely close the script
// and make every JS function (showTab, toggleBug, etc.) undefined.
// We replace the closing tag with a visually identical but inert version.
function sanitiseForInlineHtml(s) {
  return String(s).replace(/<\/script>/gi, '<\\/script>');
}

function escAttr(s) {
  return String(s).replace(/'/g, '&#39;').replace(/"/g, '&quot;');
}

module.exports = { buildReport };