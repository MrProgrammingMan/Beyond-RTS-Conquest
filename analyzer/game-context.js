/**
 * game-context.js — Beyond RTS Conquest: Game Knowledge Extractor
 *
 * Runs ONCE per QA session. Produces a rich, structured context object
 * that gets injected into every Claude API call — bugs, balance, features.
 *
 * What it extracts:
 *   1. Full FACTIONS array from the live game (via Playwright) — every unit,
 *      cost, stat, passive, upgrade, and ALL flags (auto-serialised generically
 *      so new flags are picked up without any code changes here).
 *   2. Key mechanic implementations pulled directly from index.html source —
 *      auto-discovered by scanning for function-name patterns (update*, handle*,
 *      _apply*, check*, spawn*) so new systems are captured automatically.
 *   3. Game rules derived from the source (base HP, unit cap, mid timing, etc.)
 *   4. Feature inventory — a compact manifest of every implemented system,
 *      so Claude never suggests building something that already exists.
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

// ── Mechanic auto-discovery patterns ─────────────────────────────────────────
// Functions whose full source should be included in context.
// Patterns are matched against every `function name(` line in the source.
// Auto-discovered functions are capped at MECHANIC_CAP total to avoid token bloat.
const MECHANIC_PATTERNS = [
  // Core systems — always include these (exact match)
  { exact: 'handleDeath',          lines: 100 },
  { exact: 'doAttack',             lines: 80  },
  { exact: 'updateSiege',          lines: 55  },
  { exact: 'checkLastStand',       lines: 50  },
  { exact: 'canAttackBase',        lines: 25  },
  { exact: 'spawnUnit',            lines: 40  },
  { exact: 'updateEconomy',        lines: 40  },
  { exact: 'updateMid',            lines: 40  },
  { exact: 'checkWin',             lines: 30  },
  { exact: 'fireRandomEvent',      lines: 40  },
  // Auto-discovered by prefix — catches any new updateX / handleX / _applyX etc.
  { prefix: 'update',              lines: 50  },
  { prefix: 'handle',              lines: 50  },
  { prefix: '_apply',              lines: 35  },
  { prefix: 'check',               lines: 35  },
  { prefix: 'spawn',               lines: 35  },
];
const MECHANIC_CAP = 40; // max total mechanic extracts to keep tokens sane

// Functions to exclude from auto-discovery (UI / render / unrelated)
const MECHANIC_EXCLUDE = new Set([
  'updateHUD', 'updateCanvas', 'updateUI', 'updateTooltip', 'updateSidebar',
  'updateWarfront', 'updateCamera', 'updateMenu', 'updateOnline',
  'handleClick', 'handleKeydown', 'handleKeyup', 'handleMousemove',
  'handleMousedown', 'handleMouseup', 'handleResize', 'handleTouch',
  'handleTouchstart', 'handleTouchend', 'handleTouchmove',
  'checkAdmin', 'checkLogin', 'checkPing', 'checkConnection',
  'spawnConfetti', 'spawnParticle', 'spawnPopup', 'spawnEffect',
]);

// ── Cache ─────────────────────────────────────────────────────────────────────
let _cachedContext = null;

async function buildGameContext(cfg) {
  if (_cachedContext) return _cachedContext;

  const gamePath = path.resolve(cfg.gamePath || '../public/index.html');
  const source   = fs.existsSync(gamePath) ? fs.readFileSync(gamePath, 'utf8') : null;

  console.log('  🧠 Building game context from index.html...');

  const [factions, gameRules] = await Promise.all([
    _extractFactions(gamePath),
    Promise.resolve(_extractGameRules(source)),
  ]);

  const mechanics        = source ? _extractMechanics(source) : {};
  const featureInventory = source ? _extractFeatureInventory(source, factions) : {};

  _cachedContext = {
    factions,
    gameRules,
    mechanics,
    featureInventory,
    promptBlocks: {
      full:      _buildFullPromptBlock(factions, gameRules, mechanics, featureInventory),
      factions:  _buildFactionBlock(factions),
      rules:     _buildRulesBlock(gameRules),
      mechanics: _buildMechanicsBlock(mechanics),
      compact:   _buildCompactBlock(factions, gameRules, featureInventory),
    },
  };

  const mechCount = Object.keys(mechanics).length;
  const sysCount  = featureInventory.gameSystems?.length || 0;
  console.log(`  ✅ Game context ready: ${factions?.length || 0} factions, ${mechCount} mechanic extracts, ${sysCount} systems in inventory`);
  return _cachedContext;
}

// ── 1. Extract FACTIONS array via Playwright ──────────────────────────────────
// Unit flags are serialised generically — no hardcoded allowlist, so any new
// flag added to a unit def is automatically captured without touching this file.

async function _extractFactions(gamePath) {
  const fileUrl = `file://${gamePath}`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const ctx  = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    await page.goto(fileUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await page.waitForFunction(() => Array.isArray(window.FACTIONS) && window.FACTIONS.length > 0, { timeout: 10_000 });

    const factions = await page.evaluate(() => {
      // Properties that are standard stats shown separately — excluded from the
      // "flags" section to keep output readable.
      const CORE = new Set([
        'id', 'name', 'souls', 'bodies', 'hp', 'speed', 'dmg', 'range',
        'attackRate', 'aerial', 'isWorker', 'type', 'desc',
      ]);
      // Properties that are never useful to Claude (internal refs, functions, etc.)
      const SKIP = new Set([
        'upgrades', 'def', '_def', 'sprite', 'img', 'canvas', 'ctx',
        'animation', 'frame', 'frames',
      ]);

      function serializeUnit(u) {
        const core  = {};
        const flags = {};
        for (const [k, v] of Object.entries(u)) {
          if (typeof v === 'function') continue;
          if (SKIP.has(k)) continue;
          if (v === null || v === undefined || v === false) continue; // omit falsy — reduces noise
          if (CORE.has(k)) core[k] = v;
          else flags[k] = v;
        }
        return { ...core, _flags: flags };
      }

      return window.FACTIONS.map(f => ({
        id:          f.id,
        name:        f.name,
        tagline:     f.tagline,
        passive:     f.passive,
        ironResolve: f.ironResolve || false,
        startSouls:  f.startSouls,
        startBodies: f.startBodies,
        matchupNote: f.matchup,
        units: (f.units || []).map(serializeUnit),
        upgrades: (f.upgrades || []).map(u => ({
          id: u.id, name: u.name,
          cost: u.cost,
          desc: u.desc,
          effect: u.effect,
          value: u.value,
        })),
        guardUnit: f.guardUnit,
        extraUnits: (f.extraUnits || []).map(u => ({
          id: u.id, name: u.name, hp: u.hp, speed: u.speed,
          dmg: u.dmg, range: u.range, aerial: u.aerial || false, desc: u.desc,
        })),
      }));
    });

    await page.close();
    await ctx.close();
    return factions;

  } catch (err) {
    console.error('  ⚠️  Could not extract FACTIONS via Playwright:', err.message);
    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ── 2. Extract game rules from source ─────────────────────────────────────────

function _extractGameRules(source) {
  if (!source) return {};
  const get = (re, fallback) => { const m = source.match(re); return m ? m[1] : fallback; };

  return {
    baseHp:              parseInt(get(/baseHp:\s*(\d+)/, '100')),
    baseMaxHp:           parseInt(get(/baseMaxHp:\s*(\d+)/, '100')),
    unitCap:             parseInt(get(/unitCap:\s*(\d+)/, '12')),
    workerCap:           parseInt(get(/workerCap:\s*(\d+)/, '3')),
    maxShades:           parseInt(get(/maxShades:\s*(\d+)/, '8')),
    siegeDecayStart:     parseInt(get(/_decayStart\s*=.*?(\d+)\s*:.*?(\d+)/, '240')),
    siegeForceDecayAt:   parseInt(get(/forceDecay\s*=\s*sec\s*>\s*(\d+)/, '300')),
    spawnProtectionSecs: parseFloat(get(/spawnProtectionTimer\s*[><=]+\s*([\d.]+)/, '1.8')),
    lastStandThreshold:  parseInt(get(/const threshold\s*=\s*(\d+)/, '30')),
    lastStandGrace:      parseFloat(get(/lastStandGrace\s*=\s*([\d.]+)/, '2.5')),
    midCapTime:          parseFloat(get(/capTimer\s*>=\s*([\d.]+)/, '2.5')),
    chainLightningBase:  parseInt(get(/chainRate\s*=\s*(\d+)/, '10')),
    chainDmgMult:        parseFloat(get(/chainDmgMult:\s*([\d.]+)/, '0.55')),
    rangedVsAerialMult:  1.3,
    aerialVsAerialMult:  1.3,
    rangedVsHighHpThresh: parseInt(get(/target\.def\.hp\s*>=\s*(\d+)/, '120')),
    rangedVsHighHpMult:  1.3,
    meleeSlow:           { duration: 1.5, speedMult: 0.7 },
    veteranKillThresh:   5,
    veteranDmgBonus:     0.15,
    wildcardKillStreak:  10,
    bodyReturnBase:      2,
    bodyReturnMid:       12,
    soulCapMax:          900,
  };
}

// ── 3. Auto-discover and extract mechanic implementations ─────────────────────

function _extractMechanics(source) {
  const lines  = source.split('\n');
  const result = {};
  const seen   = new Set();

  // Pass 1 — exact-name priority extracts (always included first)
  for (const spec of MECHANIC_PATTERNS.filter(s => s.exact)) {
    if (seen.size >= MECHANIC_CAP) break;
    const searchStr = `function ${spec.exact}(`;
    const idx = lines.findIndex(l => l.includes(searchStr));
    if (idx === -1) continue;
    seen.add(spec.exact);
    const end = Math.min(idx + spec.lines, lines.length);
    result[spec.exact] = {
      startLine: idx + 1,
      code: lines.slice(idx, end).map((l, i) => `${String(idx + i + 1).padStart(5)}: ${l}`).join('\n'),
    };
  }

  // Pass 2 — prefix-based auto-discovery
  const fnRe = /^\s*(?:async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/;
  for (let i = 0; i < lines.length; i++) {
    if (seen.size >= MECHANIC_CAP) break;
    const m = lines[i].match(fnRe);
    if (!m) continue;
    const name = m[1];
    if (seen.has(name)) continue;
    if (MECHANIC_EXCLUDE.has(name)) continue;

    const matchedSpec = MECHANIC_PATTERNS.find(s => s.prefix && name.startsWith(s.prefix));
    if (!matchedSpec) continue;

    seen.add(name);
    const end = Math.min(i + matchedSpec.lines, lines.length);
    result[name] = {
      startLine: i + 1,
      code: lines.slice(i, end).map((l, j) => `${String(i + j + 1).padStart(5)}: ${l}`).join('\n'),
    };
  }

  return result;
}

// ── 4. Feature inventory ──────────────────────────────────────────────────────
// Scans the source for implemented systems so Claude knows what already exists
// and won't suggest duplicates.

function _extractFeatureInventory(source, factions) {
  const lines = source.split('\n');

  // All faction IDs and names
  const factionList = (factions || []).map(f => `${f.id} (${f.name})`);

  // All game modes found in source
  const gameModes = [...new Set(
    [...source.matchAll(/GAME_MODE\s*===?\s*['"]([^'"]+)['"]/g)].map(m => m[1])
  )];

  // All screen IDs (id="sc-*")
  const screenIds = [...new Set(
    [...source.matchAll(/id="(sc-[a-z][a-z0-9-]*)"/g)].map(m => m[1])
  )];

  // All global G-state array/object fields (from G = { ... } initialisation block)
  // Finds lines that look like `fieldName: [],` or `fieldName: {},` or `fieldName: 0,`
  const gStateFields = [];
  let inGInit = false;
  for (const line of lines) {
    if (/\bG\s*=\s*\{/.test(line)) inGInit = true;
    if (inGInit) {
      const m = line.match(/^\s{4,8}([a-zA-Z_][a-zA-Z0-9_]*):\s*[\[{0-9'"]|null|false|true/);
      if (m) gStateFields.push(m[1]);
      if (/^\s{0,4}\}/.test(line) && gStateFields.length > 3) inGInit = false;
    }
  }

  // All update* functions present (these represent active game systems)
  const gameSystems = [...new Set(
    [...source.matchAll(/function\s+(update[A-Z][a-zA-Z]+)\s*\(/g)].map(m => m[1])
  )].filter(n => !MECHANIC_EXCLUDE.has(n));

  // All unit flags that appear anywhere in faction unit defs (from actual FACTIONS data)
  const allUnitFlags = new Set();
  for (const f of (factions || [])) {
    for (const u of (f.units || [])) {
      for (const k of Object.keys(u._flags || {})) allUnitFlags.add(k);
    }
  }

  // Upgrade IDs across all factions
  const upgradeIds = [...new Set(
    (factions || []).flatMap(f => (f.upgrades || []).map(u => u.id))
  )];

  // All buff names (from activeBuffs references)
  const buffNames = [...new Set(
    [...source.matchAll(/activeBuffs\.([a-zA-Z_][a-zA-Z0-9_]+)/g)].map(m => m[1])
  )];

  // Wildcard/rogue event names
  const rogueEvents = [...new Set(
    [...source.matchAll(/type:\s*['"]([a-z_]+)['"]\s*,\s*(?:name|label):/g)].map(m => m[1])
  )];

  return {
    factionList,
    gameModes,
    screenIds,
    gStateFields,
    gameSystems,
    allUnitFlags: [...allUnitFlags].sort(),
    upgradeIds,
    buffNames,
    rogueEvents,
  };
}

// ── Prompt block builders ─────────────────────────────────────────────────────

function _buildFactionBlock(factions) {
  if (!factions) return '(faction data unavailable)';
  return factions.map(f => {
    const unitLines = f.units.map(u => {
      const flagStr = Object.entries(u._flags || {})
        .map(([k, v]) => v === true ? k : `${k}=${JSON.stringify(v)}`)
        .join(' ');
      return `    ${u.name} [${u.type}${u.aerial ? '/air' : ''}]: ${u.souls}💀${u.bodies ?? 0}🦴 | HP:${u.hp} SPD:${u.speed} DMG:${u.dmg} RNG:${u.range} ATK:${u.attackRate}/s${flagStr ? ` | ${flagStr}` : ''}`;
    }).join('\n');

    const upgLines = f.upgrades.map(u =>
      `    [${u.id}] ${u.name} (${u.cost?.souls ?? '?'}💀${u.cost?.bodies ?? 0}🦴): ${u.desc}`
    ).join('\n');

    const guard = f.extraUnits?.find(u => u.id === f.guardUnit);
    const guardLine = guard ? `  Guard: ${guard.name} — HP:${guard.hp} DMG:${guard.dmg} | ${guard.desc}` : '';

    return [
      `── ${f.name.toUpperCase()} (${f.id}) ──`,
      `  Start: ${f.startSouls}💀 ${f.startBodies ?? 0}🦴`,
      `  Passive: ${f.passive}`,
      f.ironResolve ? '  Iron Resolve: units <30% HP take 15% less dmg' : '',
      `  Matchup note: ${f.matchupNote}`,
      '  Units:',
      unitLines,
      '  Upgrades:',
      upgLines,
      guardLine,
    ].filter(Boolean).join('\n');
  }).join('\n\n');
}

function _buildRulesBlock(rules) {
  return [
    'GAME RULES (extracted from source):',
    `  Base HP: ${rules.baseHp} | Unit cap: ${rules.unitCap} | Worker cap: ${rules.workerCap}`,
    `  Last Stand: triggers at base HP ≤ ${rules.lastStandThreshold}, grants ${rules.lastStandGrace}s grace + 3 guards + 40💀`,
    `  Siege decay: starts at ${rules.siegeDecayStart}s game-time, forced at ${rules.siegeForceDecayAt}s (uses G.elapsed, not wall clock)`,
    `  Spawn protection: ${rules.spawnProtectionSecs}s — unit cannot die (HP floor 1)`,
    `  Mid capture: ${rules.midCapTime}s uncontested hold required`,
    `  Chain Lightning: fires every ${rules.chainLightningBase} attacks by default, deals ${rules.chainDmgMult * 100}% base DMG to nearest other enemy`,
    `  Ranged vs aerial: ${rules.rangedVsAerialMult}× DMG + 33% faster attacks`,
    `  Ranged vs HP≥${rules.rangedVsHighHpThresh}: ${rules.rangedVsHighHpMult}× DMG`,
    `  Melee slow on hit: ${rules.meleeSlow.duration}s at ${rules.meleeSlow.speedMult}× speed`,
    `  Veteran bonus: ${rules.veteranKillThresh} kills → +${rules.veteranDmgBonus * 100}% DMG permanently`,
    `  Max shades (Summoners): ${rules.maxShades}`,
    `  Soul cap: ${rules.soulCapMax}`,
  ].join('\n');
}

function _buildFeatureInventoryBlock(inv) {
  if (!inv || !inv.factionList) return '';
  return [
    '══ FEATURE INVENTORY (auto-extracted — what is already implemented) ══',
    '',
    `FACTIONS (${inv.factionList.length}): ${inv.factionList.join(', ')}`,
    '',
    `GAME MODES: ${inv.gameModes.join(', ')}`,
    '',
    `ACTIVE GAME SYSTEMS (update* functions in game loop):`,
    '  ' + (inv.gameSystems.join(', ') || 'none found'),
    '',
    `G STATE FIELDS: ${inv.gStateFields.join(', ')}`,
    '',
    `ALL UNIT FLAGS IN USE: ${inv.allUnitFlags.join(', ')}`,
    '',
    `UPGRADE IDs: ${inv.upgradeIds.join(', ')}`,
    '',
    `BUFF NAMES: ${inv.buffNames.join(', ')}`,
    '',
    `SCREENS: ${inv.screenIds.join(', ')}`,
    '',
    'IMPORTANT: Do NOT suggest implementing any feature, mechanic, system, or screen',
    'that appears in the lists above — it already exists in the codebase.',
  ].join('\n');
}

function _buildMechanicsBlock(mechanics) {
  if (!Object.keys(mechanics).length) return '(mechanic code unavailable)';
  return Object.entries(mechanics).map(([name, { startLine, code }]) =>
    `── ${name} (line ${startLine}) ──\n${code}`
  ).join('\n\n');
}

function _buildCompactBlock(factions, rules, featureInventory) {
  if (!factions) return _buildRulesBlock(rules);
  const rows = factions.map(f => {
    const nonWorkerUnits = f.units.filter(u => !u.isWorker);
    const avgDmg = nonWorkerUnits.length
      ? Math.round(nonWorkerUnits.reduce((s, u) => s + u.dmg, 0) / nonWorkerUnits.length) : 0;
    const avgHp = nonWorkerUnits.length
      ? Math.round(nonWorkerUnits.reduce((s, u) => s + u.hp, 0) / nonWorkerUnits.length) : 0;
    const hasAerial = f.units.some(u => u.aerial && !u.isWorker) ? '✓aerial' : '✗aerial';
    const hasRanged = f.units.some(u => u.range > 60 && !u.isWorker) ? '✓ranged' : '✗ranged';
    return `  ${f.id.padEnd(14)}: start ${f.startSouls}💀${f.startBodies ?? 0}🦴 | avgDMG:${avgDmg} avgHP:${avgHp} | ${hasAerial} ${hasRanged} | ${f.passive.slice(0, 80)}`;
  });
  return [
    'FACTION QUICK REF:',
    ...rows,
    '',
    _buildRulesBlock(rules),
    '',
    featureInventory ? _buildFeatureInventoryBlock(featureInventory) : '',
  ].join('\n');
}

function _buildFullPromptBlock(factions, rules, mechanics, featureInventory) {
  return [
    '╔══════════════════════════════════════════════════════════════════════╗',
    '║          BEYOND RTS CONQUEST — FULL GAME CONTEXT                    ║',
    '╚══════════════════════════════════════════════════════════════════════╝',
    '',
    'ARCHITECTURE: Single-file browser RTS (~32,000 lines, vanilla JS + Canvas).',
    'Players spend Souls💀 + Bodies🦴 to spawn units. Mid capture gives income bonus.',
    'Base HP reaches 0 → lose. Last Stand triggers at ≤30 HP (3 guards + 40💀 + grace).',
    '',
    _buildFeatureInventoryBlock(featureInventory),
    '',
    _buildRulesBlock(rules),
    '',
    '══ FACTIONS ══',
    '',
    _buildFactionBlock(factions),
    '',
    '══ KEY MECHANIC IMPLEMENTATIONS (auto-extracted from source) ══',
    '(Actual JS functions — reference line numbers when diagnosing bugs)',
    '',
    _buildMechanicsBlock(mechanics),
  ].join('\n');
}

// ── Inject context into a prompt string ──────────────────────────────────────

function injectContext(prompt, gameContext, level = 'full') {
  if (!gameContext) return prompt;
  const block = gameContext.promptBlocks[level] || gameContext.promptBlocks.compact;
  return `${block}\n\n${'═'.repeat(72)}\n\n${prompt}`;
}

module.exports = { buildGameContext, injectContext };
