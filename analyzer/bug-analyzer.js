/**
 * bug-analyzer.js
 * Diagnoses all bugs in a SINGLE batched Claude API call.
 *
 * Old approach: 1 Claude call per unique bug → 10 bugs = 10 sequential API calls (~30s)
 * New approach: 1 Claude call with ALL bugs → always ~3-5s regardless of bug count
 */

const Anthropic = require('@anthropic-ai/sdk');

async function analyzeBugs(allErrors, allNaNs, allTimedOut, cfg) {
  const client = new Anthropic({ apiKey: cfg.anthropicApiKey });

  const uniqueErrors = deduplicateErrors(allErrors);
  const uniqueNaNs   = deduplicateNaNs(allNaNs);

  const bugs = [
    ...uniqueErrors,
    ...uniqueNaNs,
  ];

  // Add softlock entry if any games timed out
  if (allTimedOut.length > 0) {
    bugs.push({
      type:     'softlock',
      message:  `${allTimedOut.length} game(s) never ended (timed out)`,
      matchups: [...new Set(allTimedOut.map(t => t.matchup))],
      occurrences: allTimedOut.length,
      examples: allTimedOut.slice(0, 3),
      isSoftlock: true,
    });
  }

  if (bugs.length === 0) return [];

  // ── Single batched Claude call ────────────────────────────────────────────
  try {
    return await diagnoseBatch(client, bugs);
  } catch (err) {
    console.error('  ⚠️  Bug diagnosis API call failed:', err.message);
    // Return undetermined bugs so report still shows them
    return bugs.map(b => ({ ...b, diagnosis: { severity: 'MEDIUM', likelyCause: 'Diagnosis failed: ' + err.message, rawText: '' } }));
  }
}

async function diagnoseBatch(client, bugs) {
  // Format each bug into a numbered entry
  const bugEntries = bugs.map((bug, i) => {
    const matchupStr = (bug.matchups || [bug.matchup]).filter(Boolean).join(', ') || 'unknown';
    const stateStr   = JSON.stringify(bug.gameState || bug.examples?.[0] || {}, null, 2).slice(0, 400);
    const extras = bug.isSoftlock
      ? `Examples:\n${(bug.examples || []).slice(0,3).map(t => `  - ${t.matchup}: elapsed=${t.elapsed}s P1=${t.p1BaseHp}hp P2=${t.p2BaseHp}hp`).join('\n')}`
      : `Stack: ${(bug.stack || 'none').slice(0, 300)}
Game state: ${stateStr}${bug.nanPath ? `\nNaN path: ${bug.nanPath}` : ''}`;

    return `--- BUG ${i + 1} ---
Type: ${bug.type}
Message: ${(bug.message || '').slice(0, 200)}
Matchups: ${matchupStr} (×${bug.occurrences || 1})
${extras}`;
  }).join('\n\n');

  const prompt = `You are a game bug analyst for "Beyond RTS Conquest" — a ~15,000-line single-file browser RTS (vanilla JS + Canvas).

GAME SUMMARY: 2-player base defense. Players spend Souls + Bodies on units, capture mid for income, use spies/upgrades/buffs. Base hits 0 HP = lose.

Below are ${bugs.length} unique bug(s) found during automated playtesting. Diagnose ALL of them.

${bugEntries}

For EACH bug, output a JSON object on a single line (no markdown, no extra text — output ONLY a JSON array):

[
  {
    "index": 1,
    "severity": "CRITICAL|HIGH|MEDIUM|LOW",
    "likelyCause": "2-3 sentence explanation",
    "reproSteps": "numbered steps as a single string with \\n separators",
    "whereToLook": "function names / variable names / patterns to search in index.html",
    "suggestedFix": "concrete fix suggestion or pseudo-code",
    "pasteToClaudePrompt": "Ready-to-paste message starting with the game context, describing this bug precisely, including game state, and asking for a fix. Make this detailed and self-contained."
  },
  ...
]

Rules:
- Output ONLY the JSON array, no other text
- Every bug must have an entry (index 1 through ${bugs.length})
- pasteToClaudePrompt must be a single string (escape newlines as \\n)
- Keep pasteToClaudePrompt under 800 chars`;

  const response = await client.messages.create({
    model:      'claude-sonnet-4-20250514',
    max_tokens: Math.min(4000, bugs.length * 600 + 200),
    messages:   [{ role: 'user', content: prompt }],
  });

  const rawText = response.content.filter(b => b.type === 'text').map(b => b.text).join('');

  // Parse JSON response
  let parsed;
  try {
    // Strip any accidental markdown fences
    const clean = rawText.replace(/```json|```/g, '').trim();
    parsed = JSON.parse(clean);
  } catch (_) {
    // Fallback: try to extract JSON array from text
    const match = rawText.match(/\[[\s\S]+\]/);
    if (match) {
      try { parsed = JSON.parse(match[0]); } catch (_) { parsed = []; }
    } else {
      parsed = [];
    }
  }

  // Merge diagnoses back into bug objects
  return bugs.map((bug, i) => {
    const diag = parsed.find(d => d.index === i + 1) || parsed[i];
    if (!diag) return { ...bug, diagnosis: { severity: 'MEDIUM', likelyCause: 'Diagnosis unavailable', rawText } };
    return {
      ...bug,
      diagnosis: {
        severity:            (diag.severity || 'MEDIUM').toUpperCase(),
        likelyCause:         diag.likelyCause || '',
        reproSteps:          diag.reproSteps  || '',
        whereToLook:         diag.whereToLook || '',
        suggestedFix:        diag.suggestedFix || '',
        pasteToClaudePrompt: diag.pasteToClaudePrompt
          ? diag.pasteToClaudePrompt.replace(/\\n/g, '\n')
          : null,
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
