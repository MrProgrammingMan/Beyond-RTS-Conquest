/**
 * bug-analyzer.js
 * Deduplicates bugs, then sends each unique bug to the Claude API.
 * Returns: diagnosed bugs with reproduction steps + suggested fixes + paste-to-Claude prompts.
 */

const Anthropic = require('@anthropic-ai/sdk');

async function analyzeBugs(allErrors, allNaNs, allTimedOut, cfg) {
  const client = new Anthropic({ apiKey: cfg.anthropicApiKey });

  // ── Deduplicate errors ────────────────────────────────────────────────────
  // Group by message signature — same error in 3 matchups = 1 bug report
  const uniqueErrors = deduplicateErrors(allErrors);
  const uniqueNaNs   = deduplicateNaNs(allNaNs);
  const diagnosedBugs = [];

  // ── Diagnose each unique bug via Claude ───────────────────────────────────
  for (const bug of [...uniqueErrors, ...uniqueNaNs]) {
    try {
      const diagnosis = await diagnoseOneBug(client, bug);
      diagnosedBugs.push({ ...bug, diagnosis });
    } catch (err) {
      diagnosedBugs.push({ ...bug, diagnosis: { error: err.message } });
    }
  }

  // ── Diagnose softlocks ────────────────────────────────────────────────────
  if (allTimedOut.length > 0) {
    try {
      const softlockDiag = await diagnoseSoftlocks(client, allTimedOut);
      diagnosedBugs.push({
        type: 'softlock',
        severity: 'critical',
        occurrences: allTimedOut.length,
        affectedMatchups: [...new Set(allTimedOut.map(t => t.matchup))],
        examples: allTimedOut.slice(0, 3),
        diagnosis: softlockDiag,
      });
    } catch (err) {
      diagnosedBugs.push({
        type: 'softlock', severity: 'critical',
        occurrences: allTimedOut.length,
        diagnosis: { error: err.message },
      });
    }
  }

  return diagnosedBugs;
}

async function diagnoseOneBug(client, bug) {
  const prompt = `You are a game bug analyst reviewing an automated playtest report for "Beyond RTS Conquest" — a single-file browser RTS game (index.html ~15,000 lines, vanilla JS + Canvas).

BUG REPORT:
Type: ${bug.type}
Message: ${bug.message}
Stack trace: ${bug.stack || 'none'}
Occurred in matchup(s): ${(bug.matchups || [bug.matchup]).join(', ')}
Occurrences: ${bug.occurrences || 1}
Game state at time of error: ${JSON.stringify(bug.gameState || {}, null, 2)}
${bug.nanPath ? `NaN detected at: ${bug.nanPath}` : ''}

Write a structured bug report in this exact format:

SEVERITY: [CRITICAL / HIGH / MEDIUM / LOW]

LIKELY CAUSE:
[2-3 sentences explaining what probably caused this, based on the message + stack + game state]

REPRODUCTION STEPS:
1. [step]
2. [step]
3. [step]
(be specific — mention factions involved if relevant)

WHERE TO LOOK IN CODE:
[Function names, variable names, or code patterns to search for in index.html]

SUGGESTED FIX:
[Concrete suggestion — if you can infer the fix from the error, give exact code or logic to change]

PASTE TO CLAUDE:
[Write a ready-to-send message for the developer to paste to their coding assistant Claude.
 It should: explain the game context, describe the bug precisely, include the game state, and ask for a fix.
 Start with >>>PROMPT START<<< and end with >>>PROMPT END<<<]`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  return parseDiagnosis(text);
}

async function diagnoseSoftlocks(client, timedOutGames) {
  const examples = timedOutGames.slice(0, 5).map(t =>
    `- ${t.matchup} (game ${t.gameNum}): elapsed ${t.elapsed}s, P1 base ${t.p1BaseHp}hp, P2 base ${t.p2BaseHp}hp, errors: ${t.errors?.length || 0}`
  ).join('\n');

  const prompt = `You are a game bug analyst. "Beyond RTS Conquest" is a single-file browser RTS.

${timedOutGames.length} games timed out (never ended) during automated playtesting.

AFFECTED MATCHUPS:
${[...new Set(timedOutGames.map(t => t.matchup))].join(', ')}

EXAMPLES:
${examples}

This could be: units stuck pathing, base HP stuck above 0 but no units attacking it, an infinite loop in a game system, or a faction passive that creates units indefinitely preventing either base from dying.

Write a bug report using the same format:

SEVERITY: CRITICAL

LIKELY CAUSE:
...

REPRODUCTION STEPS:
...

WHERE TO LOOK IN CODE:
...

SUGGESTED FIX:
...

PASTE TO CLAUDE:
[>>>PROMPT START<<< ... >>>PROMPT END<<<]`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 800,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  return parseDiagnosis(text);
}

function parseDiagnosis(text) {
  const extract = (label, nextLabel) => {
    const re = new RegExp(`${label}[:\\s]*\\n([\\s\\S]+?)(?=\\n${nextLabel}|$)`, 'i');
    const m = text.match(re);
    return m ? m[1].trim() : '';
  };

  const severityMatch = text.match(/SEVERITY:\s*(CRITICAL|HIGH|MEDIUM|LOW)/i);
  const promptMatch   = text.match(/>>>PROMPT START<<<([\s\S]+?)>>>PROMPT END<<</);

  return {
    severity:          severityMatch ? severityMatch[1].toUpperCase() : 'MEDIUM',
    likelyCause:       extract('LIKELY CAUSE', 'REPRODUCTION'),
    reproSteps:        extract('REPRODUCTION STEPS', 'WHERE TO LOOK'),
    whereToLook:       extract('WHERE TO LOOK IN CODE', 'SUGGESTED FIX'),
    suggestedFix:      extract('SUGGESTED FIX', 'PASTE TO CLAUDE'),
    pasteToClaudePrompt: promptMatch ? promptMatch[1].trim() : null,
    rawText:           text,
  };
}

function deduplicateErrors(errors) {
  const bySignature = new Map();
  for (const e of errors) {
    // Signature: first 120 chars of message + file + line
    const sig = `${(e.message || '').slice(0, 120)}|${e.filename || ''}|${e.line || 0}`;
    if (!bySignature.has(sig)) {
      bySignature.set(sig, { ...e, occurrences: 1, matchups: [e.matchup].filter(Boolean) });
    } else {
      const existing = bySignature.get(sig);
      existing.occurrences++;
      if (e.matchup && !existing.matchups.includes(e.matchup)) {
        existing.matchups.push(e.matchup);
      }
      // Keep the game state from the first occurrence
    }
  }
  return Array.from(bySignature.values());
}

function deduplicateNaNs(nanEvents) {
  const byPath = new Map();
  for (const n of nanEvents) {
    const sig = n.path || 'unknown';
    if (!byPath.has(sig)) {
      byPath.set(sig, { ...n, type: 'nan_detected', severity: 'high',
        message: `NaN/Infinity detected at ${n.path} = ${n.value}`,
        occurrences: 1, matchups: [n.matchup].filter(Boolean) });
    } else {
      const existing = byPath.get(sig);
      existing.occurrences++;
      if (n.matchup && !existing.matchups.includes(n.matchup)) existing.matchups.push(n.matchup);
    }
  }
  return Array.from(byPath.values());
}

module.exports = { analyzeBugs };
