# ⚔ Beyond RTS Conquest — QA System

Fully automated game QA. Runs headlessly, finds everything, delivers to Discord.

---

## WHAT IT TESTS

| Category | What it detects |
|---|---|
| **Bugs** | Uncaught JS errors, console.error calls, unhandled Promise rejections, NaN/Infinity in game state, softlocked games that never end, memory leaks |
| **UI** | Screenshots of every screen at every viewport (desktop + mobile) · Elements overlapping · Buttons off-screen · Touch targets too small (<44px on mobile) · Low contrast text · Unexpected scrollbars |
| **Mechanics** | Whether spy/mid/upgrades/buffs/Last Stand/faction abilities are actually being used — flags anything under 15% usage as potentially broken or undiscoverable |
| **Performance** | Average & worst frame times · Frame spikes >100ms · Long JS tasks · Memory usage |
| **Balance** | Full N×N faction win-rate matrix (all 24 factions) · Overtuned/undertuned factions with specific number changes · Hard counters · P1/P2 position bias · Game length analysis |
| **Online** | P2 sync quality testing across latency profiles (ideal/good/average) with intercept-and-replay |
| **Features** | AI-powered suggestions for next features based on balance & mechanics data |

---

## HOW BUGS GET DELIVERED

When a **critical bug** is detected:

1. Claude API immediately diagnoses it (likely cause, repro steps, suggested fix, where to look in code)
2. A Discord ping fires **right away** — before the rest of the run finishes
3. The ping contains a ready-to-paste Claude prompt so you can send it directly here

When the full run completes:
- Discord gets a summary embed + the full HTML report as a file attachment
- HTML report has tabbed navigation, all screenshots, and **one-click copy buttons** for every Claude prompt

---

## SETUP

### 1. Install Node.js 18+
https://nodejs.org/

### 2. Put your game file here
Copy `index.html` into this folder.

### 3. Install dependencies
```bash
npm install
npm run install-browsers
```

### 4. Set environment variables (optional but recommended)
```bash
# For Discord integration (get these from your Discord server settings)
export DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..."
export DISCORD_PING_USER_ID="123456789..."

# For Claude API (get from anthropic.com/console)
export ANTHROPIC_API_KEY="sk-ant-..."
```

Or create a `.env` file in this folder with the same variables.

### 5. Edit `config.js` (optional)
Default settings are good for most runs. Adjust if needed:
- `balance.gamesPerMatchup` — 3=quick, 5=reliable, 10=high confidence
- `balance.parallelGames` — 3-4 recommended (each tab ~300MB RAM)
- `balance.factionFilter` — test only specific factions, or `null` for all 24

### 6. Run
```bash
node run.js
```

---

## COMMANDS

```bash
# Full runs
node run.js                          # Full run (everything: balance, bugs, ui, mechanics, perf, online)
node run.js --quick                  # Smoke test (3 games, 5 factions, ~4-6 min)
npm run quick                        # Same as --quick

# Skip sections to go faster
node run.js --skip-ui                # Balance + bugs only (no screenshots)
node run.js --skip-balance           # UI + bugs only (no game testing)
node run.js --skip-features          # Skip AI feature suggestions
node run.js --skip-vision            # Skip vision analysis
node run.js --cheap                  # Use Haiku for analysis (cheaper, less detailed)

# Fine-tune individual runs
node run.js --games=5                # Override gamesPerMatchup (3=quick, 5=reliable, 10=confident)
node run.js --factions=warriors,brutes,summoners  # Only test specific factions
node run.js --analyze-only           # Re-analyze saved data (no new games)
```

---

## TIME ESTIMATES

| Config | Time |
|---|---|
| Full run (3 games, 4 parallel, 24 factions) | ~25-40 min |
| Full run (5 games, 4 parallel, 24 factions) | ~40-60 min |
| `node run.js --quick` (3 games, 5 factions) | ~4-6 min |
| UI audit only (`--skip-balance`) | ~1 min |
| Balance only (`--skip-ui`) | ~20-30 min |
| With online sync testing | +5-10 min |

---

## OUTPUT FILES

| File | What it is |
|---|---|
| `qa-report.html` | Full interactive report (open in browser) |
| `qa-data.json` | Raw data for re-analysis |
| `screenshots/` | Every screen at every viewport size |

---

## THE REPORT TABS

- **Overview** — summary stats, test duration, any critical bugs front and center
- **Bugs** — every bug with diagnosis, repro steps, call stack, and one-click copy button for Claude
- **UI** — full screenshot grid across all viewports (desktop + mobile) + all detected UI issues by severity
- **Mechanics** — bar chart of mechanic usage rates across all factions, flags anything under 15% as potentially broken
- **Performance** — frame timing distribution, spike log, memory usage trends
- **Balance** — faction win-rate bars + full N×N matchup matrix, hard counters highlighted, AI-generated patch notes
- **Online** — sync quality results across latency profiles with specific failure logs

## SPECIAL TEST MODES

### Horde Mode
All 10 waves automatically tested for balance and softlocks (wave 1: warriors → wave 10: pandemonium).

### Online Sync Testing
Tests P2 sync quality under realistic network conditions (ideal/good/average latency).

### AI Features
Claude analyzes balance data and suggests next features (with specific implementation notes).
