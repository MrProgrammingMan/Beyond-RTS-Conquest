/**
 * auto-fixer.js — Beyond RTS QA Auto-Fix Engine
 *
 * Two exports:
 *   generateFix(bug, gamePath, cfg)  → { ok, summary, diff, confidence, linesChanged }
 *   applyDiff(diff, gamePath)        → { success, backupPath, linesChanged }
 *
 * Flow:
 *   1. Read index.html and extract the relevant code window around the bug
 *   2. Call Claude with the bug diagnosis + code snippets, asking for a unified diff
 *   3. Validate the diff is structurally sound before returning it
 *   4. applyDiff() creates a timestamped backup then patches the file in-place
 *
 * The diff Claude produces is a standard unified diff (--- / +++ / @@ hunks).
 * We apply it ourselves with a pure-JS patch engine so there's no dependency
 * on the system `patch` binary.
 */

'use strict';

const fs      = require('fs');
const path    = require('path');
const Anthropic = require('@anthropic-ai/sdk');

// ── Main exports ──────────────────────────────────────────────────────────────

/**
 * Ask Claude to produce a unified diff that fixes the given bug.
 *
 * @param {object} bug      - diagnosed bug object (from bug-analyzer.js)
 * @param {string} gamePath - path to index.html
 * @param {object} cfg      - QA config (needs cfg.anthropicApiKey)
 * @returns {Promise<{ok, summary, diff, confidence, linesChanged}>}
 */
async function generateFix(bug, gamePath, cfg) {
  const apiKey = cfg.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, summary: 'No Anthropic API key configured' };

  const gameSource = _readGame(gamePath);
  if (!gameSource) return { ok: false, summary: `Could not read game file: ${gamePath}` };

  const lines = gameSource.split('\n');
  const totalLines = lines.length;

  // ── Build code context: use stored snippets or re-extract around stack lines ──
  const snippets = _buildSnippets(bug, lines);
  if (snippets.length === 0) {
    return { ok: false, summary: 'Could not locate relevant code in index.html' };
  }

  const snippetBlock = snippets.map(s => {
    const loc = (s.startLine !== '?' && s.endLine !== '?')
      ? `lines ${s.startLine}–${s.endLine} of ${totalLines}`
      : `of ${totalLines} total lines`;
    return `[${s.label}  —  ${loc}]\n${s.code}`;
  }).join('\n\n');

  // ── Prompt ────────────────────────────────────────────────────────────────
  const diagnosis = bug.diagnosis || {};
  const prompt = `You are patching "Beyond RTS Conquest" — a single-file browser RTS game (index.html, ${totalLines} lines, vanilla JS + Canvas).

BUG REPORT
Type       : ${bug.type}
Severity   : ${diagnosis.severity || 'UNKNOWN'}
Message    : ${(bug.message || '').slice(0, 300)}
Matchups   : ${(bug.matchups || [bug.matchup]).filter(Boolean).join(', ')}
Cause      : ${(diagnosis.likelyCause || '').slice(0, 400)}
Suggested  : ${(diagnosis.suggestedFix || '').slice(0, 500)}

RELEVANT CODE FROM THE FILE
${snippetBlock}

TASK
Produce a minimal unified diff that fixes this bug. Requirements:
- Output ONLY the unified diff, nothing else — no explanation, no markdown fences
- Use standard unified diff format (--- a/index.html, +++ b/index.html, @@ hunks)
- Each hunk must include 3 lines of unchanged context before and after the change
- Make the smallest possible change — do not refactor surrounding code
- If you cannot produce a confident fix, output exactly: CANNOT_FIX: <reason>

CONFIDENCE HINT (include as a comment on the very first line of your diff):
# CONFIDENCE: HIGH   ← you are certain this fixes the root cause
# CONFIDENCE: MEDIUM ← likely correct but edge cases possible
# CONFIDENCE: LOW    ← uncertain, manual review strongly recommended`;

  const client = new Anthropic({ apiKey });

  let rawText;
  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });
    rawText = response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
  } catch (err) {
    return { ok: false, summary: `Claude API error: ${err.message}` };
  }

  // ── CANNOT_FIX response ───────────────────────────────────────────────────
  if (rawText.startsWith('CANNOT_FIX:')) {
    const reason = rawText.slice('CANNOT_FIX:'.length).trim().slice(0, 200);
    return { ok: false, summary: reason };
  }

  // ── Parse confidence hint ─────────────────────────────────────────────────
  let confidence = 'MEDIUM';
  const confMatch = rawText.match(/^#\s*CONFIDENCE:\s*(HIGH|MEDIUM|LOW)/im);
  if (confMatch) confidence = confMatch[1].toUpperCase();

  // Strip the confidence comment line from the diff
  const diff = rawText.replace(/^#\s*CONFIDENCE:.*\n?/im, '').trim();

  // ── Validate diff structure ───────────────────────────────────────────────
  const validation = _validateDiff(diff);
  if (!validation.ok) {
    return { ok: false, summary: `Claude produced an invalid diff: ${validation.reason}` };
  }

  // ── Count changed lines ───────────────────────────────────────────────────
  const linesChanged = diff.split('\n').filter(l => l.startsWith('+') || l.startsWith('-'))
    .filter(l => !l.startsWith('+++') && !l.startsWith('---')).length;

  // ── Build human summary ───────────────────────────────────────────────────
  const summary = _buildSummary(bug, diff);

  return { ok: true, summary, diff, confidence, linesChanged };
}

/**
 * Apply a unified diff string to gamePath in-place.
 * Creates a timestamped backup first.
 *
 * @param {string} diff     - unified diff string
 * @param {string} gamePath - path to index.html
 * @returns {{ success, backupPath?, linesChanged?, error? }}
 */
async function applyDiff(diff, gamePath) {
  const resolvedPath = path.resolve(gamePath);

  // ── Read original ─────────────────────────────────────────────────────────
  let original;
  try {
    original = fs.readFileSync(resolvedPath, 'utf8');
  } catch (err) {
    return { success: false, error: `Cannot read ${resolvedPath}: ${err.message}` };
  }

  // ── Create timestamped backup ─────────────────────────────────────────────
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupPath = resolvedPath.replace(/\.html$/, '') + `.backup-${ts}.html`;
  try {
    fs.writeFileSync(backupPath, original);
  } catch (err) {
    return { success: false, error: `Cannot create backup at ${backupPath}: ${err.message}` };
  }

  // ── Apply the patch ───────────────────────────────────────────────────────
  const patchResult = _applyPatch(original, diff);
  if (!patchResult.ok) {
    // Restore original (backup already written so nothing lost)
    return { success: false, error: patchResult.error, backupPath };
  }

  // ── Write patched file ────────────────────────────────────────────────────
  try {
    fs.writeFileSync(resolvedPath, patchResult.patched);
  } catch (err) {
    return { success: false, error: `Cannot write patched file: ${err.message}`, backupPath };
  }

  const linesChanged = diff.split('\n')
    .filter(l => (l.startsWith('+') || l.startsWith('-')) && !l.startsWith('+++') && !l.startsWith('---'))
    .length;

  return { success: true, backupPath, linesChanged };
}

// ── Diff validator ────────────────────────────────────────────────────────────

function _validateDiff(diff) {
  if (!diff || diff.trim().length < 10) return { ok: false, reason: 'empty diff' };
  const lines = diff.split('\n');
  const hasHunk = lines.some(l => l.startsWith('@@'));
  if (!hasHunk) return { ok: false, reason: 'no @@ hunk headers found' };
  const hasChange = lines.some(l => (l.startsWith('+') || l.startsWith('-')) && !l.startsWith('+++') && !l.startsWith('---'));
  if (!hasChange) return { ok: false, reason: 'diff has no + or - lines' };
  return { ok: true };
}

// ── Pure-JS unified diff applier ─────────────────────────────────────────────
// Handles standard unified diff format produced by Claude / git diff.

function _applyPatch(original, diff) {
  const srcLines = original.split('\n');
  const result   = [...srcLines];
  let offset = 0; // line number adjustment as we apply hunks

  // Parse hunks
  const hunks = _parseHunks(diff);
  if (hunks.length === 0) return { ok: false, error: 'No valid hunks parsed from diff' };

  for (const hunk of hunks) {
    const startIdx = hunk.oldStart - 1 + offset; // 0-indexed

    // Verify context lines match (first 3 context lines as a sanity check)
    const contextLines = hunk.lines.filter(l => l.type === 'ctx').slice(0, 3);
    for (const ctxLine of contextLines) {
      const srcIdx = startIdx + ctxLine.hunkOffset;
      if (srcIdx >= 0 && srcIdx < result.length) {
        if (result[srcIdx] !== ctxLine.text) {
          // Try to find the correct position (file may have shifted)
          const found = _findHunkPosition(result, hunk, startIdx);
          if (found === -1) {
            return { ok: false, error: `Hunk @@ -${hunk.oldStart} context mismatch — file may have changed since diff was generated` };
          }
          offset += found - startIdx;
          break;
        }
      }
    }

    const adjustedStart = hunk.oldStart - 1 + offset;

    // Build replacement: take existing lines, splice in changes
    let readIdx = adjustedStart;
    const newLines = [];

    for (const line of hunk.lines) {
      if (line.type === 'ctx') {
        newLines.push(result[readIdx]);
        readIdx++;
      } else if (line.type === 'add') {
        newLines.push(line.text);
      } else if (line.type === 'del') {
        readIdx++; // skip deleted line
      }
    }

    // Splice: replace [adjustedStart .. readIdx) with newLines
    const deleteCount = readIdx - adjustedStart;
    result.splice(adjustedStart, deleteCount, ...newLines);
    offset += newLines.length - deleteCount;
  }

  return { ok: true, patched: result.join('\n') };
}

function _parseHunks(diff) {
  const lines = diff.split('\n');
  const hunks = [];
  let current = null;
  let hunkOffset = 0;

  for (const line of lines) {
    const hunkHeader = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkHeader) {
      if (current) hunks.push(current);
      current = {
        oldStart: parseInt(hunkHeader[1], 10),
        newStart: parseInt(hunkHeader[2], 10),
        lines: [],
      };
      hunkOffset = 0;
      continue;
    }
    if (!current) continue;

    if (line.startsWith('+') && !line.startsWith('+++')) {
      current.lines.push({ type: 'add', text: line.slice(1), hunkOffset });
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      current.lines.push({ type: 'del', text: line.slice(1), hunkOffset });
      hunkOffset++;
    } else if (line.startsWith(' ') || line === '') {
      current.lines.push({ type: 'ctx', text: line.startsWith(' ') ? line.slice(1) : '', hunkOffset });
      hunkOffset++;
    }
  }
  if (current) hunks.push(current);
  return hunks;
}

/**
 * If the exact hunk position doesn't match (file shifted), search ±100 lines.
 * Returns the corrected 0-indexed start position, or -1 if not found.
 */
function _findHunkPosition(lines, hunk, nominalStart) {
  const ctxTexts = hunk.lines.filter(l => l.type === 'ctx' || l.type === 'del').slice(0, 4).map(l => l.text);
  if (ctxTexts.length === 0) return nominalStart;

  const search = Math.max(0, nominalStart - 100);
  const end    = Math.min(lines.length, nominalStart + 100);

  for (let i = search; i < end; i++) {
    let match = true;
    for (let j = 0; j < ctxTexts.length; j++) {
      if (lines[i + j] !== ctxTexts[j]) { match = false; break; }
    }
    if (match) return i;
  }
  return -1;
}

// ── Code extraction helpers ───────────────────────────────────────────────────

function _readGame(gamePath) {
  try { return fs.readFileSync(path.resolve(gamePath), 'utf8'); } catch (_) { return null; }
}

/**
 * Build code snippets for the prompt.
 *
 * Priority order:
 *   1. Pre-extracted snippets stored by bug-analyzer (already formatted, use as-is)
 *   2. Stack trace line numbers → re-extract with wider context (±25 lines)
 *   3. Function names from whereToLook → search index.html for definition
 *
 * bug-analyzer stores snippets as { label, lineNum, code } where `code` is
 * already a pre-formatted block with line numbers and >>> markers. We use
 * those directly rather than re-extracting from lineNum, which would produce
 * a narrower ±18-line window without the existing formatting.
 */
function _buildSnippets(bug, lines, CONTEXT = 25) {
  const snippets = [];
  const seenLines = new Set();

  // ── 1. Stored snippets from bug-analyzer (preferred — widest + pre-verified) ──
  // diagnosis.codeSnippets is set by diagnoseBatch(); _codeSnippets is set by
  // extractCodeSnippets() before the API call. Both use the same shape.
  const stored = bug.diagnosis?.codeSnippets || bug._codeSnippets || [];
  for (const s of stored.slice(0, 3)) {
    if (snippets.length >= 3) break;
    if (!s.code) continue;
    // Re-extract a wider window centred on lineNum so the patcher has more
    // context to match against. Fall back to stored code if lineNum absent.
    if (s.lineNum && s.lineNum > 0 && s.lineNum <= lines.length) {
      const ln0 = s.lineNum - 1; // 0-indexed
      if (!seenLines.has(ln0)) {
        seenLines.add(ln0);
        snippets.push(_makeWindow(lines, ln0, CONTEXT, s.label || `Line ${s.lineNum}`));
      }
    } else {
      // No lineNum: use stored code verbatim (pre-formatted)
      snippets.push({
        label: s.label || 'Code snippet',
        startLine: '?', endLine: '?',
        code: s.code,
      });
    }
  }

  if (snippets.length >= 2) return snippets;

  // ── 2. Extract from stack trace ──────────────────────────────────────────
  const stack = bug.stack || '';
  const lineRe = /:(\d{3,5}):\d+/g;
  let m;
  while ((m = lineRe.exec(stack)) !== null && snippets.length < 3) {
    const ln0 = parseInt(m[1], 10) - 1;
    if (ln0 >= 0 && ln0 < lines.length && !seenLines.has(ln0)) {
      seenLines.add(ln0);
      snippets.push(_makeWindow(lines, ln0, CONTEXT, `Stack line ${ln0 + 1}`));
    }
  }

  // ── 3. Function names from whereToLook ────────────────────────────────────
  if (snippets.length < 3) {
    const where = bug.diagnosis?.whereToLook || bug.whereToLook || '';
    const fns = [...where.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]{3,})\b/g)]
      .map(x => x[1])
      .filter(n => !_SKIP.has(n));

    for (const fn of fns) {
      if (snippets.length >= 3) break;
      const defRe = new RegExp(
        `(?:function\\s+${fn}\\b|\\b${fn}\\s*[=(]|\\b${fn}\\s*:\\s*function)`
      );
      for (let i = 0; i < lines.length; i++) {
        if (defRe.test(lines[i]) && !seenLines.has(i)) {
          seenLines.add(i);
          snippets.push(_makeWindow(lines, i, CONTEXT, `${fn} (line ${i + 1})`));
          break;
        }
      }
    }
  }

  return snippets;
}

function _makeWindow(lines, centerLine0, context, label) {
  const start = Math.max(0, centerLine0 - context);
  const end   = Math.min(lines.length - 1, centerLine0 + context);
  const code  = lines.slice(start, end + 1).map((l, i) => {
    const ln     = start + i + 1;
    const marker = (start + i) === centerLine0 ? '>>>' : '   ';
    return `${marker} ${String(ln).padStart(5)} | ${l}`;
  }).join('\n');
  return { label, startLine: start + 1, endLine: end + 1, code };
}

const _SKIP = new Set([
  'function','return','const','let','var','this','null','true','false','undefined',
  'if','else','for','while','switch','case','break','continue','new','delete',
  'typeof','instanceof','class','extends','import','export','from','default',
  'async','await','try','catch','finally','throw','with','static','super',
  'the','and','or','not','is','are','has','have','can','will','should','would',
  'look','search','find','check','index','html','line','code','game','unit',
  'player','base','name','file','path','type','text','data',
]);

// ── Summary builder ───────────────────────────────────────────────────────────

function _buildSummary(bug, diff) {
  const adds = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).length;
  const dels = diff.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---')).length;
  const type = bug.type || 'bug';
  const sev  = (bug.diagnosis?.severity || 'MEDIUM').toUpperCase();
  return `Fix ${sev} ${type}: +${adds} / -${dels} lines`;
}

// ── Generic fix (UI issues, vision issues, anomalies) ────────────────────────

/**
 * Generate a fix for any report item — not just diagnosed bugs.
 * Accepts a free-form issue description + optional CSS selectors / function
 * hints and searches the game source for relevant code.
 *
 * @param {object} issue - { type, severity, message, suggestion, elementHint, searchHints[] }
 * @param {string} gamePath
 * @param {object} cfg
 * @returns {Promise<{ok, summary, diff, confidence, linesChanged}>}
 */
async function generateGenericFix(issue, gamePath, cfg) {
  const apiKey = cfg.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, summary: 'No Anthropic API key configured' };

  const gameSource = _readGame(gamePath);
  if (!gameSource) return { ok: false, summary: `Could not read game file: ${gamePath}` };

  const lines = gameSource.split('\n');
  const totalLines = lines.length;

  // ── Find relevant code using search hints ──────────────────────────────────
  const snippets = [];
  const seenLines = new Set();
  const hints = issue.searchHints || [];

  // Add element_hint as a search term (CSS selectors → ID/class names)
  if (issue.elementHint) {
    // Extract IDs and class names from CSS selectors
    const ids = [...issue.elementHint.matchAll(/#([\w-]+)/g)].map(m => m[1]);
    const classes = [...issue.elementHint.matchAll(/\.([\w-]+)/g)].map(m => m[1]);
    hints.push(...ids, ...classes);
  }

  // Search for each hint in the source
  for (const hint of hints) {
    if (snippets.length >= 3) break;
    if (!hint || hint.length < 3) continue;
    const escaped = hint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped, 'i');
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i]) && !seenLines.has(i)) {
        seenLines.add(i);
        snippets.push(_makeWindow(lines, i, 25, `"${hint}" (line ${i + 1})`));
        break;
      }
    }
  }

  // Fallback: search for keywords from the message/suggestion
  if (snippets.length === 0) {
    const text = `${issue.message || ''} ${issue.suggestion || ''}`;
    const keywords = [...text.matchAll(/\b([a-zA-Z_][\w-]{4,})\b/g)]
      .map(m => m[1])
      .filter(w => !_SKIP.has(w.toLowerCase()))
      .slice(0, 5);
    for (const kw of keywords) {
      if (snippets.length >= 2) break;
      const re = new RegExp(kw, 'i');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i]) && !seenLines.has(i)) {
          seenLines.add(i);
          snippets.push(_makeWindow(lines, i, 20, `"${kw}" (line ${i + 1})`));
          break;
        }
      }
    }
  }

  if (snippets.length === 0) {
    return { ok: false, summary: 'Could not locate relevant code for this issue' };
  }

  const snippetBlock = snippets.map(s => {
    const loc = (s.startLine !== '?' && s.endLine !== '?')
      ? `lines ${s.startLine}–${s.endLine} of ${totalLines}`
      : `of ${totalLines} total lines`;
    return `[${s.label}  —  ${loc}]\n${s.code}`;
  }).join('\n\n');

  // ── Prompt ──────────────────────────────────────────────────────────────────
  const prompt = `You are patching "Beyond RTS Conquest" — a single-file browser RTS game (index.html, ${totalLines} lines, vanilla JS + Canvas + inline CSS).

ISSUE REPORT
Type       : ${issue.type || 'ui_issue'}
Severity   : ${issue.severity || 'MEDIUM'}
Message    : ${(issue.message || '').slice(0, 400)}
Suggestion : ${(issue.suggestion || '').slice(0, 400)}
Element    : ${issue.elementHint || 'unknown'}

RELEVANT CODE FROM THE FILE
${snippetBlock}

TASK
Produce a minimal unified diff that fixes this issue. Requirements:
- Output ONLY the unified diff, nothing else — no explanation, no markdown fences
- Use standard unified diff format (--- a/index.html, +++ b/index.html, @@ hunks)
- Each hunk must include 3 lines of unchanged context before and after the change
- Make the smallest possible change — do not refactor surrounding code
- For CSS issues, modify the inline <style> section
- For layout/responsive issues, use media queries or clamp() where appropriate
- If you cannot produce a confident fix, output exactly: CANNOT_FIX: <reason>

CONFIDENCE HINT (include as a comment on the very first line of your diff):
# CONFIDENCE: HIGH   ← you are certain this fixes the issue
# CONFIDENCE: MEDIUM ← likely correct but edge cases possible
# CONFIDENCE: LOW    ← uncertain, manual review strongly recommended`;

  const client = new Anthropic({ apiKey });

  let rawText;
  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });
    rawText = response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
  } catch (err) {
    return { ok: false, summary: `Claude API error: ${err.message}` };
  }

  if (rawText.startsWith('CANNOT_FIX:')) {
    return { ok: false, summary: rawText.slice('CANNOT_FIX:'.length).trim().slice(0, 200) };
  }

  let confidence = 'MEDIUM';
  const confMatch = rawText.match(/^#\s*CONFIDENCE:\s*(HIGH|MEDIUM|LOW)/im);
  if (confMatch) confidence = confMatch[1].toUpperCase();

  const diff = rawText.replace(/^#\s*CONFIDENCE:.*\n?/im, '').trim();
  const validation = _validateDiff(diff);
  if (!validation.ok) {
    return { ok: false, summary: `Claude produced an invalid diff: ${validation.reason}` };
  }

  const linesChanged = diff.split('\n').filter(l => l.startsWith('+') || l.startsWith('-'))
    .filter(l => !l.startsWith('+++') && !l.startsWith('---')).length;

  const adds = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).length;
  const dels = diff.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---')).length;
  const summary = `Fix ${(issue.severity || 'MEDIUM').toUpperCase()} ${issue.type || 'issue'}: +${adds} / -${dels} lines`;

  return { ok: true, summary, diff, confidence, linesChanged };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = { generateFix, generateGenericFix, applyDiff };