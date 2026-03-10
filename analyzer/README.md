# ⚔ Beyond RTS Conquest — QA System

Fully automated game QA. Runs headlessly, finds everything, delivers to Discord.

---

## WHAT IT TESTS

| Category | What it detects |
|---|---|
| **Bugs** | Uncaught JS errors, console.error calls, unhandled Promise rejections, NaN/Infinity in game state, softlocked games that never end |
| **UI** | Screenshots of every screen at every viewport · Elements overlapping · Buttons off-screen · Touch targets too small (<44px) · Low contrast text · Unexpected scrollbars · Empty buttons |
| **Mechanics** | Whether spy/mid/upgrades/buffs/Last Stand are actually being used — flags anything under 15% usage as potentially broken or undiscoverable |
| **Performance** | Average & worst frame times · Frame spikes >100ms · Long JS tasks |
| **Balance** | Full N×N faction win-rate matrix · Overtuned/undertuned factions with specific number changes · Hard counters · P1/P2 position bias · Game length analysis |

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

### 4. Edit `config.js`
```js
gamePath: './index.html',

balance: {
  gamesPerMatchup: 5,      // 5=quick, 10=reliable, 20=high confidence
  aiDifficulty: 'hard',
  parallelGames: 3,
},

anthropicApiKey: 'sk-ant-...',   // anthropic.com/console

discord: {
  webhookUrl: 'https://discord.com/api/webhooks/1480926658474016871/93fkVlEzGSf7xCSkloCvztmJg-K4XlnX2BXn0-5F12Tq2-iETwUl3_hvz2q9ILF7U3ft',
  pingUserId: '739519255946461396',   // right-click your name → Copy User ID
},
```

### 5. Run
```bash
node run.js
```

---

## COMMANDS

```bash
node run.js                          # Full run (everything)
node run.js --skip-ui                # Balance + bugs only (faster)
node run.js --skip-balance           # UI audit only
node run.js --analyze-only           # Re-analyze saved data (no games)
node run.js --games=3                # Override gamesPerMatchup
node run.js --factions=a,b,c         # Only test these factions

npm run quick                        # 3 games, 5 factions, fast smoke test
```

---

## TIME ESTIMATES

| Config | Time |
|---|---|
| 5 games, 3 parallel, 10 factions | ~20-30 min |
| 10 games, 3 parallel, 10 factions | ~40-60 min |
| `npm run quick` (3 games, 5 factions) | ~5-10 min |
| UI audit only | ~3-5 min |

---

## OUTPUT FILES

| File | What it is |
|---|---|
| `qa-report.html` | Full interactive report (open in browser) |
| `qa-data.json` | Raw data for re-analysis |
| `screenshots/` | Every screen at every viewport size |

---

## THE REPORT TABS

- **Overview** — summary stats, any critical bugs front and center
- **Bugs** — every bug with diagnosis, repro steps, and a copy-to-Claude button
- **UI** — screenshots grid + all detected UI issues by severity
- **Mechanics** — bar chart of mechanic usage rates, flags underused ones
- **Performance** — frame timing charts, long task log
- **Balance** — win rate bars, matchup matrix, full AI analysis + patch prompt
