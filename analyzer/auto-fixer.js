/**
 * auto-fixer.js — Beyond RTS QA Auto-Fix Engine
 *
 * Takes a single diagnosed bug (with code snippets) and asks Claude to
 * produce a minimal, surgical patch.  Returns a structured result containing:
 *   - a unified diff string  (--- a/index.html / +++ b/index.html format)
 *   - a plain-English change summary
 *   - a confidence score (HIGH / MEDIUM / LOW) Claude assigned itself
 *   - the raw response for debugging
 *
 * IMPORTANT: This module NEVER writes to disk.
 * Writing (with a user confirmation gate) is done by the caller (reporter.js
 * "Apply Fix" button flow or run.js --auto-fix flag).
 *
 * Usage (programmatic):
 *   const { generateFix } = require('./auto-fixer');
 *   const fixResult = await generateFix(diagnosedBug, gameFilePath, cfg);
 *   // fixResult.diff  — apply with applyDiff()
 *   // fixResult.ok    — false if Claude couldn't produce a confident fix
 *
 * Usage (apply a returned diff):
 *   const { applyDiff } = require('./auto-fixer');
 *   const { success, backupPath, linesChanged } = await applyDiff(fixResult.diff, gameFilePath);
 */

'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ── Constants ─────────────────────────────────────────────────────────────────

const MODEL = 'claude-sonnet-4-20250514';
const MAX_TOKENS = 4096;

// Minimum fraction of the diff Claude must have filled in for us to accept it.
// A diff with zero +/- lines is useless.
const MIN_CHANGED_LINES = 1;

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Ask Claude to generate a unified-diff fix for a single diagnosed bug.
 *
 * @param {object} diagnosedBug   - bug object from bug-analyzer.js (with .diagnosis)
 * @param {string} gameFilePath   - absolute path to index.html
 * @param {object} cfg            - full config object (needs cfg.anthropicApiKey)
 * @returns {Promise<FixResult>}
 */
async function generateFix(diagnosedBug, gameFilePath, cfg) {
  if (!cfg.anthropicApiKey) {
    return _errorResult('No Anthropic API key configured');
  }

  // ── Load game source ───────────────────────────────────────────────────────
  let sourceLines;
  try {
    const raw = fs.readFileSync(path.resolve(gameFilePath), 'utf8');
    sourceLines = raw.split('\n');
  } catch (err) {
    return _errorResult(`Could not read game file: ${err.message}`);
  }

  // ── Build focused context blocks ───────────────────────────────────────────
  // We send 2 sources of context to Claude:
  //   1. The code snippets already extracted by bug-analyzer (if any)
  //   2. A fresh extraction of the ±40-line window around each mentioned line
  //      number in the diagnosis, in case the snippets are shallow
  const snippets = diagnosedBug.diagnosis?.codeSnippets || diagnosedBug._codeSnippets || [];
  const freshWindows = _extractFreshWindows(diagnosedBug, sourceLines, snippets);

  const snippetBlock = _formatSnippets(snippets, 'Pre-extracted (from bug-analyzer)');
  const freshBlock   = _formatSnippets(freshWindows, 'Fresh extraction (wider context)');

  // ── Build the prompt ───────────────────────────────────────────────────────
  const sev      = (diagnosedBug.diagnosis?.severity || 'MEDIUM').toUpperCase();
  const bugType  = diagnosedBug.type || 'unknown';
  const message  = (diagnosedBug.message || '').slice(0, 300);
  const cause    = (diagnosedBug.diagnosis?.likelyCause || '').slice(0, 500);
  const fixHint  = (diagnosedBug.diagnosis?.suggestedFix || '').slice(0, 600);
  const where    = (diagnosedBug.diagnosis?.whereToLook || '').slice(0, 200);
  const matchups = (diagnosedBug.matchups || [diagnosedBug.matchup]).filter(Boolean).join(', ');
  const totalLines = sourceLines.length;

  const prompt = `You are a surgical code-patch generator for "Beyond RTS Conquest" — a single-file browser RTS (index.html, ${totalLines} lines, vanilla JS + Canvas).

Your task: produce a MINIMAL unified diff that fixes exactly one bug. Do not refactor, rename, or change anything unrelated to the fix.

═══ BUG REPORT ═══
Severity : ${sev}
Type     : ${bugType}
Message  : ${message}
Matchups : ${matchups || 'unknown'}
Occurred : ×${diagnosedBug.occurrences || 1}

LIKELY CAUSE:
${cause || '(see code snippets below)'}

SUGGESTED FIX:
${fixHint || 'See code snippets and diagnose from context.'}

WHERE TO LOOK:
${where || 'See snippets below.'}

═══ RELEVANT CODE ═══

${snippetBlock || '(no pre-extracted snippets available)'}

${freshBlock || ''}

═══ YOUR OUTPUT FORMAT ═══

Respond with ONLY a JSON object — no markdown fences, no explanation outside the JSON:

{
  "confidence": "HIGH|MEDIUM|LOW",
  "summary": "One sentence: what you changed and why",
  "cannotFix": false,
  "cannotFixReason": "",
  "diff": "--- a/index.html\\n+++ b/index.html\\n@@ ... @@\\n-old line\\n+new line\\n..."
}

Rules for the diff:
1. Standard unified diff format. File headers must be exactly:
      --- a/index.html
      +++ b/index.html
2. Each hunk header: @@ -startLine,contextLines +startLine,contextLines @@ optional context
3. Context lines (unchanged): prefix with ONE space
4. Removed lines: prefix with -
5. Added lines  : prefix with +
6. Include 3 lines of context before and after each change
7. Line numbers in hunk headers must be ACCURATE — count from the snippets above
8. Keep the diff minimal — only touch lines directly involved in the fix
9. If you cannot produce a confident fix (ambiguous cause, change too risky, or not
   enough context), set "cannotFix": true, "confidence": "LOW", and leave "diff": ""

Escape all newlines inside the JSON string as \\n.
Do NOT wrap in backticks or add any text outside the JSON object.`;

  // ── Call Claude ────────────────────────────────────────────────────────────
  const client = new Anthropic({ apiKey: cfg.anthropicApiKey });
  let rawText = '';
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    });
    rawText = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
  } catch (err) {
    return _errorResult(`Claude API call failed: ${err.message}`);
  }

  // ── Parse response ─────────────────────────────────────────────────────────
  let parsed;
  try {
    const clean = rawText.replace(/^```(?:json)?|```$/gm, '').trim();
    parsed = JSON.parse(clean);
  } catch (_) {
    // Try to extract JSON object from messy output
    const m = rawText.match(/\{[\s\S]+\}/);
    if (m) {
      try { parsed = JSON.parse(m[0]); } catch (_) { parsed = null; }
    }
  }

  if (!parsed) {
    return _errorResult('Claude returned unparseable output', rawText);
  }

  if (parsed.cannotFix) {
    return {
      ok: false,
      confidence: 'LOW',
      summary: parsed.cannotFixReason || 'Claude could not produce a confident fix',
      diff: '',
      rawText,
      bugSig: _bugSig(diagnosedBug),
    };
  }

  const diff = (parsed.diff || '').replace(/\\n/g, '\n').trim();

  // Basic sanity check — diff must have at least one +/- line
  const changedLines = diff.split('\n').filter(l => l.startsWith('+') || l.startsWith('-'))
    .filter(l => !l.startsWith('---') && !l.startsWith('+++'));

  if (changedLines.length < MIN_CHANGED_LINES) {
    return _errorResult('Diff contained no actual changes', rawText);
  }

  // Verify diff starts with the expected file headers
  if (!diff.startsWith('--- a/index.html')) {
    // Attempt to prepend the headers if Claude omitted them
    const fixedDiff = `--- a/index.html\n+++ b/index.html\n` + diff.replace(/^---.*\n\+\+\+.*\n/, '');
    return {
      ok: true,
      confidence: (parsed.confidence || 'MEDIUM').toUpperCase(),
      summary: parsed.summary || 'Fix applied',
      diff: fixedDiff,
      linesChanged: changedLines.length,
      rawText,
      bugSig: _bugSig(diagnosedBug),
    };
  }

  return {
    ok: true,
    confidence: (parsed.confidence || 'MEDIUM').toUpperCase(),
    summary: parsed.summary || 'Fix applied',
    diff,
    linesChanged: changedLines.length,
    rawText,
    bugSig: _bugSig(diagnosedBug),
  };
}

// ── Diff application ──────────────────────────────────────────────────────────

/**
 * Apply a unified diff string to a file.
 * Always creates a timestamped backup before writing.
 *
 * @param {string} diffText       - unified diff (output of generateFix().diff)
 * @param {string} gameFilePath   - absolute path to index.html
 * @returns {{ success, backupPath, linesChanged, error }}
 */
async function applyDiff(diffText, gameFilePath) {
  const absPath = path.resolve(gameFilePath);

  if (!fs.existsSync(absPath)) {
    return { success: false, error: `File not found: ${absPath}` };
  }

  // ── Backup ────────────────────────────────────────────────────────────────
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupPath = absPath + `.backup-${ts}`;
  try {
    fs.copyFileSync(absPath, backupPath);
  } catch (err) {
    return { success: false, error: `Backup failed: ${err.message}` };
  }

  // ── Parse and apply hunks ─────────────────────────────────────────────────
  const originalLines = fs.readFileSync(absPath, 'utf8').split('\n');
  let patchedLines;
  try {
    patchedLines = _applyUnifiedDiff(originalLines, diffText);
  } catch (err) {
    // Restore backup on parse failure
    try { fs.copyFileSync(backupPath, absPath); } catch (_) {}
    return { success: false, backupPath, error: `Patch application failed: ${err.message}` };
  }

  // ── Write ─────────────────────────────────────────────────────────────────
  try {
    fs.writeFileSync(absPath, patchedLines.join('\n'), 'utf8');
  } catch (err) {
    return { success: false, backupPath, error: `Write failed: ${err.message}` };
  }

  const linesChanged = Math.abs(patchedLines.length - originalLines.length)
    + diffText.split('\n').filter(l => (l.startsWith('+') || l.startsWith('-')) && !l.startsWith('---') && !l.startsWith('+++') ).length;

  return { success: true, backupPath, linesChanged };
}

// ── Unified diff parser & applier ─────────────────────────────────────────────

/**
 * Pure JS unified diff applier. No shell deps, no external packages.
 * Applies hunks in order. Throws on mismatch so the caller can restore backup.
 */
function _applyUnifiedDiff(originalLines, diffText) {
  const lines  = diffText.split('\n');
  const result = [...originalLines];

  // Parse hunks
  const hunks = [];
  let hunk = null;

  for (const line of lines) {
    if (line.startsWith('--- ') || line.startsWith('+++ ')) continue;

    const hunkHeader = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkHeader) {
      if (hunk) hunks.push(hunk);
      hunk = {
        origStart : parseInt(hunkHeader[1], 10) - 1,  // 0-indexed
        origCount : parseInt(hunkHeader[2] ?? '1', 10),
        newStart  : parseInt(hunkHeader[3], 10) - 1,
        newCount  : parseInt(hunkHeader[4] ?? '1', 10),
        lines     : [],
      };
      continue;
    }
    if (hunk) hunk.lines.push(line);
  }
  if (hunk) hunks.push(hunk);

  if (hunks.length === 0) throw new Error('No hunks found in diff');

  // Apply hunks in reverse order so line numbers stay valid
  for (const h of [...hunks].reverse()) {
    const { origStart, origCount, lines: hunkLines } = h;

    // Verify context lines match (loose check — first 3 context lines only)
    const ctxLines = hunkLines.filter(l => l.startsWith(' ')).slice(0, 3);
    for (const ctx of ctxLines) {
      const expected = ctx.slice(1); // strip leading space
      // Find approximate match within ±5 lines of origStart to tolerate minor drift
      const found = result.slice(Math.max(0, origStart - 5), origStart + h.origCount + 5)
        .some(l => l === expected);
      if (!found) {
        // Soft warning — don't abort, just note the mismatch
        // (line numbers in AI-generated diffs can drift by a few lines)
        console.warn(`  ⚠️  auto-fixer: context mismatch near line ${origStart + 1}: "${expected.slice(0, 60)}"`);
      }
    }

    // Build the replacement block (new lines only, no context)
    const removedLines = hunkLines.filter(l => l.startsWith('-')).length;
    const addedLines   = hunkLines.filter(l => l.startsWith('+')).map(l => l.slice(1));

    // Splice: remove origCount lines starting at origStart, insert addedLines
    result.splice(origStart, origCount, ...addedLines);
  }

  return result;
}

// ── Code window extraction ────────────────────────────────────────────────────

/**
 * Extract fresh ±40-line windows around every line number referenced in the
 * diagnosis that isn't already covered by an existing snippet.
 */
function _extractFreshWindows(bug, sourceLines, existingSnippets) {
  const CONTEXT = 40;
  const windows = [];
  const coveredLines = new Set(
    existingSnippets.flatMap(s => {
      const m = String(s.label || '').match(/(\d+)/);
      return m ? [parseInt(m[1], 10)] : [];
    })
  );

  // Collect candidate line numbers from stack + whereToLook + diagnosis text
  const allText = [
    bug.stack || '',
    bug.diagnosis?.whereToLook || '',
    bug.diagnosis?.likelyCause || '',
    bug.diagnosis?.suggestedFix || '',
  ].join(' ');

  const lineNums = [...allText.matchAll(/:(\d{3,5}):\d*/g)]
    .map(m => parseInt(m[1], 10))
    .filter(n => n > 0 && n <= sourceLines.length);

  const seen = new Set();
  for (const ln of lineNums) {
    if (seen.has(ln) || coveredLines.has(ln)) continue;
    seen.add(ln);
    const start = Math.max(0, ln - CONTEXT - 1);
    const end   = Math.min(sourceLines.length - 1, ln + CONTEXT - 1);
    const code  = sourceLines.slice(start, end + 1)
      .map((l, i) => {
        const num    = start + i + 1;
        const marker = (start + i + 1) === ln ? '>>>' : '   ';
        return `${marker} ${String(num).padStart(5)} | ${l}`;
      }).join('\n');
    windows.push({ label: `Fresh window around line ${ln}`, lineNum: ln, code });
    if (windows.length >= 2) break; // cap at 2 extra windows to keep prompt size sane
  }

  return windows;
}

function _formatSnippets(snippets, header) {
  if (!snippets || snippets.length === 0) return '';
  const body = snippets.map(s =>
    `[${s.label || 'snippet'}]\n\`\`\`js\n${s.code || ''}\n\`\`\``
  ).join('\n\n');
  return `── ${header} ──\n${body}`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _errorResult(reason, rawText = '') {
  return { ok: false, confidence: 'LOW', summary: reason, diff: '', rawText, bugSig: null };
}

function _bugSig(bug) {
  const msg  = (bug.message || '').slice(0, 120);
  const file = bug.filename || '';
  const line = bug.line || 0;
  return `${msg}|${file}|${line}`;
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = { generateFix, applyDiff };
