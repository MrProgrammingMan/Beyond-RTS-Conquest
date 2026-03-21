/**
 * bug-analyzer.js
 * Diagnoses all bugs in a SINGLE batched Claude API call.
 *
 * Now uses game-context.js to inject full faction/mechanic knowledge so
 * Claude can reason about bugs with the same understanding as reading the code.
 * Code snippets from index.html are still extracted for precise line references.
 */

const Anthropic = require('@anthropic-ai/sdk');
const fs        = require('fs');
const path      = require('path');
const { injectContext } = require('./game-context');

// ── Code extraction ───────────────────────────────────────────────────────────

let _gameLines = null;

function loadGameFile(cfg) {
  if (_gameLines) return _gameLines;
  try {
    const p = path.resolve(cfg.gamePath || './index.html');
    _gameLines = fs.readFileSync(p, 'utf8').split('\n');
    return _gameLines;
  } catch (_) { return null; }
}

function window_around(lines, idx, ctx) {
  const start = Math.max(0, idx - 2);
  const end   = Math.min(lines.length - 1, idx + ctx);
  return lines.slice(start, end + 1)
    .map((l, i) => `${String(start + i + 1).padStart(5)}: ${l}`)
    .join('\n');
}

function extractCodeSnippets(bug, cfg, CONTEXT = 18, MAX_SNIPPETS = 3) {
  const lines = loadGameFile(cfg);
  if (!lines) return [];

  const snippets   = [];
  const seenLines  = new Set();

  // 1. Extract line numbers from stack trace
  const lineNumRe = /:(\\d{3,6}):\\d+/g;
  const stack     = bug.stack || '';
  let m;
  while ((m = lineNumRe.exec(stack)) !== null) {
    const ln = parseInt(m[1], 10) - 1;
    if (ln > 0 && ln < lines.length && !seenLines.has(ln)) {
      seenLines.add(ln);
      snippets.push({ label: `Stack line ${ln + 1}`, lineNum: ln + 1, code: window_around(lines, ln, CONTEXT) });
      if (snippets.length >= MAX_SNIPPETS) return snippets;
    }
  }

  // 2. Search for function names from whereToLook
  const whereToLook = bug.whereToLook || bug.diagnosis?.whereToLook || '';
  const fnNames = [...whereToLook.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]{3,})\b/g)]
    .map(m => m[1]).filter(n => !COMMON_WORDS.has(n));

  for (const fn of fnNames) {
    if (snippets.length >= MAX_SNIPPETS) break;
    const defRe = new RegExp(`(?:function\\s+${fn}\\b|\\b${fn}\\s*[=(]|\\b${fn}\\s*:\\s*function)`);
    for (let i = 0; i < lines.length; i++) {
      if (defRe.test(lines[i]) && !seenLines.has(i)) {
        seenLines.add(i);
        snippets.push({ label: `${fn} (line ${i + 1})`, lineNum: i + 1, code: window_around(lines, i, CONTEXT) });
        break;
      }
    }
  }

  // 3. Search for the error message text itself
  if (snippets.length < MAX_SNIPPETS) {
    const msg = (bug.message || '').slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (msg.length > 8) {
      const msgRe = new RegExp(msg, 'i');
      for (let i = 0; i < lines.length; i++) {
        if (msgRe.test(lines[i]) && !seenLines.has(i)) {
          seenLines.add(i);
          snippets.push({ label: `Message match (line ${i + 1})`, lineNum: i + 1, code: window_around(lines, i, CONTEXT) });
          if (snippets.length >= MAX_SNIPPETS) break;
        }
      }
    }
  }

  return snippets;
}

const COMMON_WORDS = new Set([
  'function','return','const','let','var','this','that','null','true','false',
  'undefined','if','else','for','while','switch','case','break','continue',
  'new','delete','typeof','instanceof','class','extends','import','export',
  'from','default','async','await','try','catch','finally','throw','void',
  'with','yield','static','super','in','of','the','and','or','not','is',
  'are','has','have','can','will','should','would','could','must','been',
  'look','search','find','check','index','html','line','code','game','unit',
  'player','base','function','variable','pattern','name','file',
]);

// ── Main export ───────────────────────────────────────────────────────────────

async function analyzeBugs(allErrors, allNaNs, allTimedOut, cfg, gameContext) {
  const client = new Anthropic({ apiKey: cfg.anthropicApiKey });

  const uniqueErrors = deduplicateErrors(allErrors);
  const uniqueNaNs   = deduplicateNaNs(allNaNs);
  const bugs         = [...uniqueErrors, ...uniqueNaNs];

  if (allTimedOut.length > 0) {
    bugs.push({
      type:       'softlock',
      message:    `${allTimedOut.length} game(s) never ended within the timeout`,
      matchups:   [...new Set(allTimedOut.map(t => t.matchup))],
      occurrences: allTimedOut.length,
      examples:   allTimedOut.slice(0, 3),
      isSoftlock: true,
      whereToLook: 'canAttackBase checkWin updateSiege checkLastStand G.running gameLoop updateTarPatches updateCorpses updateEchoSchedule updateDarkZones updateNewFactionSystems updateBloodPools',
    });
  }

  if (bugs.length === 0) return [];

  for (const bug of bugs) bug._codeSnippets = extractCodeSnippets(bug, cfg);

  try {
    return await diagnoseBatch(client, bugs, gameContext);
  } catch (err) {
    console.error('  ⚠️  Bug diagnosis API call failed:', err.message);
    return bugs.map(b => ({
      ...b,
      diagnosis: { severity: 'MEDIUM', likelyCause: 'Diagnosis failed: ' + err.message, rawText: '' },
    }));
  }
}

// ── Batched Claude call ───────────────────────────────────────────────────────

async function diagnoseBatch(client, bugs, gameContext) {
  const bugEntries = bugs.map((bug, i) => {
    const matchupStr = (bug.matchups || [bug.matchup]).filter(Boolean).join(', ') || 'unknown';
    const stateStr   = JSON.stringify(bug.gameState || bug.examples?.[0] || {}, null, 2).slice(0, 400);

    const extras = bug.isSoftlock
      ? `Timed-out games:\n${(bug.examples || []).slice(0, 3).map(t =>
          `  - ${t.matchup}: elapsed=${t.elapsed}s P1=${t.p1BaseHp}hp P2=${t.p2BaseHp}hp errors=${(t.errors||[]).map(e=>e.message).join('; ')}`
        ).join('\n')}`
      : `Stack: ${(bug.stack || 'none').slice(0, 300)}\nGame state: ${stateStr}${bug.nanPath ? `\nNaN path: ${bug.nanPath}` : ''}`;

    const snippetBlock = (bug._codeSnippets || []).length > 0
      ? `\nEXTRACTED SOURCE CODE:\n${bug._codeSnippets.map(s =>
          `[${s.label}]\n\`\`\`js\n${s.code}\n\`\`\``
        ).join('\n\n')}`
      : '';

    return `--- BUG ${i + 1} ---
Type: ${bug.type}
Message: ${(bug.message || '').slice(0, 200)}
Matchups affected: ${matchupStr} (×${bug.occurrences || 1})
${extras}${snippetBlock}`;
  }).join('\n\n');

  // The game context (full faction data + mechanic code) is prepended by injectContext.
  // The prompt itself only needs to describe the task — no need to re-explain the game.
  const corePrompt = `You are a game bug analyst for "Beyond RTS Conquest".

You have complete knowledge of the game above — every faction, unit stat, mechanic implementation, and line of code. Use this knowledge directly when diagnosing bugs. Do not say "I don't have access to the source" — the key mechanic implementations are shown in the GAME CONTEXT above.

Below are ${bugs.length} unique bug(s) found during automated AI vs AI playtesting. Each includes extracted source code from the relevant lines in index.html.

${bugEntries}

Diagnose ALL ${bugs.length} bugs. Output ONLY a valid JSON array — no markdown fences, no preamble:

[
  {
    "index": 1,
    "severity": "CRITICAL|HIGH|MEDIUM|LOW",
    "likelyCause": "2-3 sentences referencing the specific function names, line numbers, and variable names from the code shown. Explain the exact failure path.",
    "reproSteps": "numbered steps as single string with \\n separators — specific faction pairs, actions, and conditions",
    "whereToLook": "specific function names and line numbers from the code above",
    "suggestedFix": "Concrete fix with corrected code. Reference actual variable/function names. Include the before/after diff where possible.",
    "codeSnippets": [],
    "pasteToClaudePrompt": "Self-contained implementation request that includes: (1) game architecture reminder — single HTML file ~15k lines vanilla JS, (2) exact bug description with the specific functions/lines involved, (3) the fix with actual corrected code. Must be paste-and-go with no further context needed. Escape newlines as \\n. Max 1400 chars."
  }
]

Rules:
- Output ONLY the JSON array
- Every bug gets an entry indexed 1 through ${bugs.length}
- likelyCause must reference actual code from the snippets or from the mechanic implementations in the game context
- suggestedFix must include corrected code, not vague advice
- If a bug is clearly caused by a mechanic you can see in the game context (e.g. handleDeath recursion, siege decay using wall clock), say so explicitly with the line number`;

  const fullPrompt = injectContext(corePrompt, gameContext, 'full');

  const response = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: Math.min(8000, bugs.length * 1200 + 800),
    messages:   [{ role: 'user', content: fullPrompt }],
  });

  const rawText = response.content.filter(b => b.type === 'text').map(b => b.text).join('');

  let parsed;
  try {
    parsed = JSON.parse(rawText.replace(/```json|```/g, '').trim());
  } catch (_) {
    const match = rawText.match(/\[[\s\S]+\]/);
    try { parsed = match ? JSON.parse(match[0]) : []; } catch (_) { parsed = []; }
  }

  return bugs.map((bug, i) => {
    const diag = parsed.find(d => d.index === i + 1) || parsed[i];
    if (!diag) return { ...bug, diagnosis: { severity: 'MEDIUM', likelyCause: 'Diagnosis unavailable', rawText } };
    return {
      ...bug,
      diagnosis: {
        severity:           (diag.severity || 'MEDIUM').toUpperCase(),
        likelyCause:        diag.likelyCause || '',
        reproSteps:         diag.reproSteps || '',
        whereToLook:        diag.whereToLook || '',
        suggestedFix:       diag.suggestedFix || '',
        pasteToClaudePrompt: diag.pasteToClaudePrompt
          ? diag.pasteToClaudePrompt.replace(/\\n/g, '\n') : null,
        codeSnippets:       bug._codeSnippets || [],
        rawText:            JSON.stringify(diag),
      },
    };
  });
}

// ── Deduplication ─────────────────────────────────────────────────────────────

function deduplicateErrors(errors) {
  const map = new Map();
  for (const e of errors) {
    const sig = `${(e.message || '').slice(0, 120)}|${e.filename || ''}|${e.line || 0}`;
    if (!map.has(sig)) {
      map.set(sig, { ...e, occurrences: 1, matchups: [e.matchup].filter(Boolean) });
    } else {
      const ex = map.get(sig); ex.occurrences++;
      if (e.matchup && !ex.matchups.includes(e.matchup)) ex.matchups.push(e.matchup);
    }
  }
  return Array.from(map.values());
}

function deduplicateNaNs(nanEvents) {
  const map = new Map();
  for (const n of nanEvents) {
    const sig = n.path || 'unknown';
    if (!map.has(sig)) {
      map.set(sig, { ...n, type: 'nan_detected',
        message: `NaN/Infinity at ${n.path} = ${n.value}`,
        occurrences: 1, matchups: [n.matchup].filter(Boolean) });
    } else {
      const ex = map.get(sig); ex.occurrences++;
      if (n.matchup && !ex.matchups.includes(n.matchup)) ex.matchups.push(n.matchup);
    }
  }
  return Array.from(map.values());
}

module.exports = { analyzeBugs };