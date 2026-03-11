/**
 * run-history.js — Beyond RTS QA Run History & Diff Engine
 *
 * Saves a compact record of each QA run to qa-history.json and computes
 * structured diffs between the current and previous run so you can see:
 *   - Which bugs are NEW (appeared this run, not last)
 *   - Which bugs are RESOLVED (were in last run, gone now)
 *   - Which bugs PERSIST (in both runs)
 *   - Win rate deltas per faction (↑↓ with exact numbers)
 *
 * Used by run.js after report generation. The diff is also passed to
 * reporter.js so the HTML report gets a dedicated Delta tab.
 */

const fs   = require('fs');
const path = require('path');

const HISTORY_PATH = path.resolve('./qa-history.json');
const MAX_RUNS = 25; // keep last 25 runs (compact — each entry ~5–10 KB)

// ── Snapshot builder ──────────────────────────────────────────────────────────

/**
 * Build a compact, serialisable snapshot of this run for history storage.
 *
 * @param {object} rawData       - full matchup-runner output (results, factions, qa)
 * @param {object} aggStats      - aggregated faction stats from aggregateStats()
 * @param {Array}  diagnosedBugs - diagnosed bugs from analyzeBugs()
 * @param {object} cfg           - config
 * @returns {object} snapshot
 */
function buildSnapshot(rawData, aggStats, diagnosedBugs, cfg) {
  const timestamp = Date.now();

  // Compact win-rate map { faction: overallWinRate }
  const winRates = {};
  for (const [f, s] of Object.entries(aggStats || {})) {
    winRates[f] = s.overallWinRate;
  }

  // Positional win rates { faction: { asP1: %, asP2: % } }
  const positionalRates = {};
  for (const [f, s] of Object.entries(aggStats || {})) {
    if (s.asP1Games || s.asP2Games) {
      positionalRates[f] = { asP1: s.asP1WinRate, asP2: s.asP2WinRate };
    }
  }

  // Bug signatures — stable enough for cross-run matching
  // Signature = type|first-120-chars-of-message|line-number
  // Mirrors the dedup key used in bug-analyzer.js so the same bug always
  // produces the same sig regardless of which matchup it appeared in.
  const bugs = (diagnosedBugs || []).map(b => ({
    sig:      _bugSig(b),
    type:     b.type || 'unknown',
    message:  (b.message || '').slice(0, 120),
    severity: ((b.diagnosis?.severity || b.severity || 'MEDIUM')).toUpperCase(),
    matchups: b.matchups || (b.matchup ? [b.matchup] : []),
  }));

  return {
    timestamp,
    date:           new Date(timestamp).toISOString(),
    totalGames:     rawData?.qa?.totalGamesRun || 0,
    factions:       rawData?.factions || [],
    winRates,
    positionalRates,
    bugCount:       bugs.length,
    bugs,
    softlockCount:  rawData?.qa?.allTimedOut?.length || 0,
    nanCount:       rawData?.qa?.allNaNs?.length || 0,
    gamesPerMatchup: cfg?.balance?.gamesPerMatchup || 0,
    aiDifficulty:    cfg?.balance?.aiDifficulty || 'unknown',
  };
}

// ── History I/O ───────────────────────────────────────────────────────────────

/** Load existing history array (newest-first). Returns [] if file doesn't exist. */
function loadHistory() {
  if (!fs.existsSync(HISTORY_PATH)) return [];
  try {
    const raw = fs.readFileSync(HISTORY_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

/**
 * Prepend snapshot to history, trim to MAX_RUNS, and write to disk.
 * Returns the full updated history array (newest-first, element 0 = this run).
 */
function saveToHistory(snapshot) {
  const history = loadHistory();
  history.unshift(snapshot);
  if (history.length > MAX_RUNS) history.length = MAX_RUNS;
  try {
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
  } catch (err) {
    console.warn('  ⚠️  Could not save run history:', err.message);
  }
  return history;
}

// ── Diff engine ───────────────────────────────────────────────────────────────

/**
 * Compare current snapshot against a previous one and produce a structured diff.
 * Returns null if previous is falsy (first ever run).
 *
 * @param {object} current  - snapshot just built this run
 * @param {object} previous - snapshot from the last completed run
 * @returns {object|null}   diff object
 */
function computeDiff(current, previous) {
  if (!previous) return null;

  // ── Win rate deltas ──────────────────────────────────────────────────────
  const winRateDeltas = [];
  const allFactions = new Set([
    ...Object.keys(current.winRates || {}),
    ...Object.keys(previous.winRates || {}),
  ]);

  for (const faction of allFactions) {
    const curr = current.winRates?.[faction];
    const prev = previous.winRates?.[faction];
    if (curr !== undefined && prev !== undefined) {
      const delta = Math.round((curr - prev) * 10) / 10;
      winRateDeltas.push({ faction, curr, prev, delta });
    } else if (curr !== undefined) {
      winRateDeltas.push({ faction, curr, prev: null, delta: null, isNew: true });
    } else {
      winRateDeltas.push({ faction, curr: null, prev, delta: null, wasRemoved: true });
    }
  }
  // Sort by absolute delta size, biggest changes first
  winRateDeltas.sort((a, b) => Math.abs(b.delta || 0) - Math.abs(a.delta || 0));

  // ── Bug diff ─────────────────────────────────────────────────────────────
  const prevSigMap = new Map((previous.bugs || []).map(b => [b.sig, b]));
  const currSigSet = new Set((current.bugs  || []).map(b => b.sig));

  const newBugs       = (current.bugs  || []).filter(b => !prevSigMap.has(b.sig));
  const resolvedBugs  = (previous.bugs || []).filter(b => !currSigSet.has(b.sig));
  const persistingBugs = (current.bugs || []).filter(b => prevSigMap.has(b.sig));

  // Sort new bugs by severity so CRITICAL shows first
  const SEV_ORDER = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  newBugs.sort((a, b) => (SEV_ORDER[a.severity] ?? 4) - (SEV_ORDER[b.severity] ?? 4));

  // ── Positional diff ──────────────────────────────────────────────────────
  const positionalDeltas = [];
  for (const faction of allFactions) {
    const curr = current.positionalRates?.[faction];
    const prev = previous.positionalRates?.[faction];
    if (curr && prev) {
      const p1Delta = Math.round((curr.asP1 - prev.asP1) * 10) / 10;
      const p2Delta = Math.round((curr.asP2 - prev.asP2) * 10) / 10;
      if (Math.abs(p1Delta) >= 3 || Math.abs(p2Delta) >= 3) {
        positionalDeltas.push({ faction, curr, prev, p1Delta, p2Delta });
      }
    }
  }

  return {
    previousDate:      previous.date,
    previousTimestamp: previous.timestamp,

    // Bug counts
    bugCountDelta:  (current.bugCount  || 0) - (previous.bugCount  || 0),
    newBugs,
    resolvedBugs,
    persistingBugs,

    // Balance
    winRateDeltas,
    positionalDeltas,

    // Other metrics
    gameCountDelta:     (current.totalGames   || 0) - (previous.totalGames   || 0),
    softlockDelta:      (current.softlockCount || 0) - (previous.softlockCount || 0),
    nanDelta:           (current.nanCount      || 0) - (previous.nanCount      || 0),
  };
}

// ── Terminal formatter ────────────────────────────────────────────────────────

/**
 * Format a diff as a human-readable terminal block.
 * Returns null if diff is null (first run).
 */
function formatDiffSummary(diff) {
  if (!diff) return null;
  const lines = [];
  const prevDate = new Date(diff.previousTimestamp).toLocaleString();

  lines.push('');
  lines.push('  ╔══════════════════════════════════════════════════════╗');
  lines.push(`  ║  📊 DELTA vs ${prevDate.slice(0, 19).padEnd(39)}║`);
  lines.push('  ╠══════════════════════════════════════════════════════╣');

  // Bug changes
  const { newBugs, resolvedBugs, persistingBugs } = diff;
  const nNew  = newBugs.length;
  const nRes  = resolvedBugs.length;
  const nPers = persistingBugs.length;

  if (nNew === 0 && nRes === 0) {
    lines.push(`  ║  ↔️  Bugs unchanged  (${String(nPers).padEnd(2)} persisting)                    ║`);
  } else {
    if (nNew > 0) {
      lines.push(`  ║  🆕 New bugs:        +${String(nNew).padEnd(31)}║`);
      for (const b of newBugs.slice(0, 3)) {
        lines.push(`  ║     [${b.severity.padEnd(8)}] ${b.message.slice(0, 37).padEnd(37)}║`);
      }
      if (nNew > 3) lines.push(`  ║     … and ${nNew - 3} more (see Delta tab in report)          ║`.slice(0, 58) + '║');
    }
    if (nRes > 0) {
      lines.push(`  ║  ✅ Resolved:        -${String(nRes).padEnd(31)}║`);
      for (const b of resolvedBugs.slice(0, 2)) {
        lines.push(`  ║     ${b.message.slice(0, 48).padEnd(48)}║`);
      }
    }
  }

  // Win rate moves (only show changes ≥ 2%)
  const bigMoves = diff.winRateDeltas.filter(d => d.delta !== null && Math.abs(d.delta) >= 2);
  if (bigMoves.length > 0) {
    lines.push('  ╠══════════════════════════════════════════════════════╣');
    lines.push('  ║  📊 Notable win rate changes (≥2%):                  ║');
    for (const d of bigMoves.slice(0, 5)) {
      const arrow = d.delta > 0 ? '↑' : '↓';
      const sign  = d.delta > 0 ? '+' : '';
      const label = `${arrow} ${d.faction.padEnd(11)} ${String(d.prev) + '%'} → ${String(d.curr) + '%'}  (${sign}${d.delta}%)`;
      lines.push(`  ║     ${label.padEnd(49)}║`);
    }
    if (bigMoves.length > 5) {
      lines.push(`  ║     … ${bigMoves.length - 5} more (see Delta tab in report)               ║`);
    }
  }

  lines.push('  ╚══════════════════════════════════════════════════════╝');
  return lines.join('\n');
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Stable bug signature — mirrors the key used by bug-analyzer.js deduplication. */
function _bugSig(bug) {
  const msg  = (bug.message || '').slice(0, 120);
  const file = bug.filename || '';
  const line = bug.line || 0;
  return `${msg}|${file}|${line}`;
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = { buildSnapshot, loadHistory, saveToHistory, computeDiff, formatDiffSummary };
