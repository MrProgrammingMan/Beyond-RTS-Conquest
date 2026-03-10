/**
 * bug-analyzer.js
 * Diagnoses all bugs in a SINGLE batched Claude API call.
 * Now extracts relevant code snippets from index.html and embeds them
 * directly into each pasteToClaudePrompt — so the coding Claude can fix
 * bugs immediately without any exploration step.
 */

const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

// ── Code extraction ───────────────────────────────────────────────────────────

let _gameLines = null; // cached lines of index.html

function loadGameFile(cfg) {
  if (_gameLines) return _gameLines;
  try {
    const p = path.resolve(cfg.gamePath || './index.html');
    _gameLines = fs.readFileSync(p, 'utf8').split('\n');
    return _gameLines;
  } catch (_) {
    return null;
  }
}

/**
 * Given a stack trace string + a "whereToLook" hint string,
 * extract up to MAX_SNIPPETS relevant code windows from index.html.
 * Returns an array of { label, lineNum, code } objects.
 */
function extractCodeSnippets(bug, cfg, CONTEXT = 18, MAX_SNIPPETS = 3) {
  const lines = loadGameFile(cfg);
  if (!lines) return [];

  const snippets = [];
  const seenLines = new Set(); // avoid duplicate windows

  // ── 1. Extract line numbers directly from the stack trace ─────────────────
  // Stack frames look like:  at functionName (file.html:1234:56)  or  file.html:1234:56
  const lineNumRe = /:(\d{3,5}):\d+/g;
  const stack = bug.stack || '';
  let m;
  while ((m = lineNumRe.exec(stack)) !== null) {
    const ln = parseInt(m[1], 10) - 1; // 0-indexed
    if (ln > 0 && ln < lines.length && !seenLines.has(ln)) {
      seenLines.add(ln);
      snippets.push({ label: `Stack line ${ln + 1}`, lineNum: ln + 1, code: window_around(lines, ln, CONTEXT) });
      if (snippets.length >= MAX_SNIPPETS) return snippets;
    }
  }

  // ── 2. Search for function names from whereToLook ─────────────────────────
  // e.g. "canAttackBase, updateSiege, checkLastStand"
  const whereToLook = bug.whereToLook || bug.diagnosis?.whereToLook || '';
  const fnNames = [
    // pull identifiers: camelCase words, snake_case words
    ...whereToLook.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]{3,})\b/g),
  ].map(m => m[1]).filter(n => !COMMON_WORDS.has(n));

  for (const fn of fnNames) {
    if (snippets.length >= MAX_SNIPPETS) break;
    // Search for "function fnName" or "fnName(" or "fnName =" definitions
    const defRe = new RegExp(`(?:function\\s+${fn}\\b|\\b${fn}\\s*[=(]|\\b${fn}\\s*:\\s*function)`);
    for (let i = 0; i < lines.length; i++) {
      if (defRe.test(lines[i]) && !seenLines.has(i)) {
        seenLines.add(i);
        snippets.push({ label: `${fn} (line ${i + 1})`, lineNum: i + 1, code: window_around(lines, i, CONTEXT) });
        break; // first definition only
      }
    }
  }

  // ── 3. Search for the error message text itself ────────────────────────────
  if (snippets.length < MAX_SNIPPETS) {
    const msg = (bug.message || '').slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (msg.length > 8) {
      const msgRe = new RegExp(msg, 'i');
      for (let i = 0; i < lines.length; i++) {
        if (msgRe.test(lines[i]) && !seenLines.has(i)) {
          seenLines.add(i);
          snippets.push({ label: `Error message at line ${i + 1}`, lineNum: i + 1, code: window_around(lines, i, CONTEXT) });
          break;
        }
      }
    }
  }

  // ── 4. Search for NaN path ─────────────────────────────────────────────────
  if (snippets.length < MAX_SNIPPETS && bug.nanPath) {
    // e.g. "G.players[0].souls" → look for "\.souls" assignments
    const parts = bug.nanPath.split('.').filter(p => !/^\d+$/.test(p) && p !== 'G' && p.length > 2);
    for (const part of parts.slice(-2)) {
      const nanRe = new RegExp(`\\.${part}\\s*[+\\-*]?=|${part}\\s*\\+=|${part}\\s*-=`);
      for (let i = 0; i < lines.length; i++) {
        if (nanRe.test(lines[i]) && !seenLines.has(i)) {
          seenLines.add(i);
          snippets.push({ label: `${part} assignment (line ${i + 1})`, lineNum: i + 1, code: window_around(lines, i, CONTEXT) });
          if (snippets.length >= MAX_SNIPPETS) break;
        }
      }
      if (snippets.length >= MAX_SNIPPETS) break;
    }
  }

  return snippets;
}

function window_around(lines, centerIdx, context) {
  const start = Math.max(0, centerIdx - context);
  const end = Math.min(lines.length - 1, centerIdx + context);
  return lines.slice(start, end + 1)
    .map((l, i) => {
      const lineNum = start + i + 1;
      const marker = (start + i) === centerIdx ? '>>>' : '   ';
      return `${marker} ${String(lineNum).padStart(5)} | ${l}`;
    })
    .join('\n');
}

// Words to skip when scanning "whereToLook" for function names
const COMMON_WORDS = new Set([
  'function', 'return', 'const', 'let', 'var', 'this', 'that', 'null', 'true', 'false',
  'undefined', 'if', 'else', 'for', 'while', 'switch', 'case', 'break', 'continue',
  'new', 'delete', 'typeof', 'instanceof', 'class', 'extends', 'import', 'export',
  'from', 'default', 'async', 'await', 'try', 'catch', 'finally', 'throw', 'void',
  'with', 'yield', 'static', 'super', 'in', 'of', 'the', 'and', 'or', 'not', 'is',
  'are', 'has', 'have', 'can', 'will', 'should', 'would', 'could', 'must', 'been',
  'look', 'search', 'find', 'check', 'index', 'html', 'line', 'code', 'game', 'unit',
  'player', 'base', 'function', 'variable', 'pattern', 'name', 'file',
]);

// ── Main export ───────────────────────────────────────────────────────────────

async function analyzeBugs(allErrors, allNaNs, allTimedOut, cfg) {
  const client = new Anthropic({ apiKey: cfg.anthropicApiKey });

  const uniqueErrors = deduplicateErrors(allErrors);
  const uniqueNaNs = deduplicateNaNs(allNaNs);

  const bugs = [...uniqueErrors, ...uniqueNaNs];

  if (allTimedOut.length > 0) {
    bugs.push({
      type: 'softlock',
      message: `${allTimedOut.length} game(s) never ended (timed out)`,
      matchups: [...new Set(allTimedOut.map(t => t.matchup))],
      occurrences: allTimedOut.length,
      examples: allTimedOut.slice(0, 3),
      isSoftlock: true,
      // Softlocks: common suspects for whereToLook
      whereToLook: 'canAttackBase checkWin updateSiege checkLastStand G.running gameLoop',
    });
  }

  if (bugs.length === 0) return [];

  // ── Pre-extract code snippets for every bug (local, fast, no API) ──────────
  for (const bug of bugs) {
    bug._codeSnippets = extractCodeSnippets(bug, cfg);
  }

  try {
    return await diagnoseBatch(client, bugs);
  } catch (err) {
    console.error('  ⚠️  Bug diagnosis API call failed:', err.message);
    return bugs.map(b => ({
      ...b,
      diagnosis: {
        severity: 'MEDIUM',
        likelyCause: 'Diagnosis failed: ' + err.message,
        rawText: '',
      },
    }));
  }
}

// ── Batched Claude call ───────────────────────────────────────────────────────

async function diagnoseBatch(client, bugs) {
  const bugEntries = bugs.map((bug, i) => {
    const matchupStr = (bug.matchups || [bug.matchup]).filter(Boolean).join(', ') || 'unknown';
    const stateStr = JSON.stringify(bug.gameState || bug.examples?.[0] || {}, null, 2).slice(0, 400);

    const extras = bug.isSoftlock
      ? `Examples:\n${(bug.examples || []).slice(0, 3).map(t =>
        `  - ${t.matchup}: elapsed=${t.elapsed}s P1=${t.p1BaseHp}hp P2=${t.p2BaseHp}hp`).join('\n')}`
      : `Stack: ${(bug.stack || 'none').slice(0, 300)}
Game state: ${stateStr}${bug.nanPath ? `\nNaN path: ${bug.nanPath}` : ''}`;

    // Format extracted code snippets
    const snippetBlock = (bug._codeSnippets || []).length > 0
      ? `\nRELEVANT CODE FROM INDEX.HTML:\n${bug._codeSnippets.map(s =>
        `[${s.label}]\n\`\`\`js\n${s.code}\n\`\`\``
      ).join('\n\n')
      }`
      : '';

    return `--- BUG ${i + 1} ---
Type: ${bug.type}
Message: ${(bug.message || '').slice(0, 200)}
Matchups: ${matchupStr} (×${bug.occurrences || 1})
${extras}${snippetBlock}`;
  }).join('\n\n');

  const prompt = `You are a game bug analyst for "Beyond RTS Conquest" — a ~15,000-line single-file browser RTS (vanilla JS + Canvas).

GAME: 2-player base defense. Players spend Souls + Bodies on units, capture mid for income, use spies/upgrades/buffs. Base hits 0 HP = lose.

Below are ${bugs.length} unique bug(s) found during automated playtesting. Each bug includes extracted code snippets from the actual source file at the relevant lines.

${bugEntries}

Diagnose ALL bugs. Output ONLY a JSON array (no markdown, no extra text):

[
  {
    "index": 1,
    "severity": "CRITICAL|HIGH|MEDIUM|LOW",
    "likelyCause": "2-3 sentence explanation referencing the actual code shown",
    "reproSteps": "numbered steps as single string with \\n separators",
    "whereToLook": "specific function names and line numbers from the snippets above",
    "suggestedFix": "concrete fix — reference actual variable/function names from the code shown, include corrected code if possible",
    "pasteToClaudePrompt": "Self-contained implementation request. Include: game context (single-file HTML RTS, index.html ~15k lines), exact bug description, the specific lines/functions involved (from the code snippets), the suggested fix with code. End with: 'Please implement this fix in index.html.' Escape newlines as \\n. Max 1200 chars."
  }
]

Rules:
- Output ONLY the JSON array
- Every bug gets an entry (index 1 through ${bugs.length})
- Reference actual line numbers and function names from the code snippets when available
- suggestedFix should include corrected code where possible, not just vague advice
- pasteToClaudePrompt must be self-contained — someone should be able to paste it cold and get a working fix`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: Math.min(6000, bugs.length * 800 + 400),
    messages: [{ role: 'user', content: prompt }],
  });

  const rawText = response.content.filter(b => b.type === 'text').map(b => b.text).join('');

  let parsed;
  try {
    const clean = rawText.replace(/```json|```/g, '').trim();
    parsed = JSON.parse(clean);
  } catch (_) {
    const match = rawText.match(/\[[\s\S]+\]/);
    if (match) {
      try { parsed = JSON.parse(match[0]); } catch (_) { parsed = []; }
    } else {
      parsed = [];
    }
  }

  return bugs.map((bug, i) => {
    const diag = parsed.find(d => d.index === i + 1) || parsed[i];
    if (!diag) return {
      ...bug,
      diagnosis: { severity: 'MEDIUM', likelyCause: 'Diagnosis unavailable', rawText },
    };
    return {
      ...bug,
      diagnosis: {
        severity: (diag.severity || 'MEDIUM').toUpperCase(),
        likelyCause: diag.likelyCause || '',
        reproSteps: diag.reproSteps || '',
        whereToLook: diag.whereToLook || '',
        suggestedFix: diag.suggestedFix || '',
        pasteToClaudePrompt: diag.pasteToClaudePrompt
          ? diag.pasteToClaudePrompt.replace(/\\n/g, '\n')
          : null,
        codeSnippets: bug._codeSnippets || [],
        rawText: JSON.stringify(diag),
      },
    };
  });
}

// ── Deduplication ─────────────────────────────────────────────────────────────

function deduplicateErrors(errors) {
  const bySignature = new Map();
  for (const e of errors) {
    const sig = `${(e.message || '').slice(0, 120)}|${e.filename || ''}|${e.line || 0}`;
    if (!bySignature.has(sig)) {
      bySignature.set(sig, { ...e, occurrences: 1, matchups: [e.matchup].filter(Boolean) });
    } else {
      const ex = bySignature.get(sig);
      ex.occurrences++;
      if (e.matchup && !ex.matchups.includes(e.matchup)) ex.matchups.push(e.matchup);
    }
  }
  return Array.from(bySignature.values());
}

function deduplicateNaNs(nanEvents) {
  const byPath = new Map();
  for (const n of nanEvents) {
    const sig = n.path || 'unknown';
    if (!byPath.has(sig)) {
      byPath.set(sig, {
        ...n, type: 'nan_detected',
        message: `NaN/Infinity at ${n.path} = ${n.value}`,
        occurrences: 1, matchups: [n.matchup].filter(Boolean),
      });
    } else {
      const ex = byPath.get(sig);
      ex.occurrences++;
      if (n.matchup && !ex.matchups.includes(n.matchup)) ex.matchups.push(n.matchup);
    }
  }
  return Array.from(byPath.values());
}

module.exports = { analyzeBugs };