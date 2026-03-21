/**
 * game-context.js — Beyond RTS Conquest: Game Knowledge Extractor
 *
 * Runs ONCE per QA session. Produces a rich, structured context object
 * that gets injected into every Claude API call — bugs, balance, features.
 *
 * What it extracts:
 *   1. Full FACTIONS array from the live game (via Playwright) — every unit,
 *      cost, stat, passive, upgrade, and interaction flag.
 *   2. Key mechanic implementations pulled directly from index.html source —
 *      the actual JS that runs, not a description of it.
 *   3. Game rules derived from the source (base HP, unit cap, mid timing, etc.)
 *   4. Known interaction map: which unit flags interact with which mechanics.
 *
 * The output is pre-formatted as a prompt block so it can be dropped directly
 * into any Claude call. Every prompt that uses this context will have the same
 * understanding of the game that you do when reading the code.
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

// ── Mechanic functions to extract from source ─────────────────────────────────
// These are the core game logic functions Claude needs to reason about bugs
// and balance. Each entry: { name, searchFor, contextLines }
const MECHANIC_EXTRACTS = [
  // ── Core systems ──
  { name: 'handleDeath',       searchFor: 'function handleDeath(',          lines: 100 },
  { name: 'doAttack',          searchFor: 'function doAttack(',              lines: 80  },
  { name: 'updateSiege',       searchFor: 'function updateSiege(',           lines: 55  },
  { name: 'checkLastStand',    searchFor: 'function checkLastStand(',        lines: 50  },
  { name: 'canAttackBase',     searchFor: 'function canAttackBase(',         lines: 25  },
  { name: 'spawnUnit',         searchFor: 'function spawnUnit(',             lines: 40  },
  { name: 'updateEconomy',     searchFor: 'function updateEconomy(',         lines: 40  },
  { name: 'updateMid',         searchFor: 'function updateMid(',             lines: 40  },
  { name: 'checkWin',          searchFor: 'function checkWin(',              lines: 30  },
  { name: 'siegeDecayRates',   searchFor: 'rate = elapsed',                  lines: 12  },
  // ── Original 10 faction mechanics ──
  { name: 'pitAura',           searchFor: 'if (u.def.pitAura)',              lines: 4   },
  { name: 'chainLightning',    searchFor: '// Chain lightning (melee)',      lines: 12  },
  { name: 'deathSplash',       searchFor: '// Infernal death explosion',     lines: 16  },
  { name: 'permafrost',        searchFor: '// Glacial Permafrost',           lines: 8   },
  { name: 'deathFrenzy',       searchFor: '// Summoner Death Frenzy',        lines: 8   },
  { name: 'bloodTithe',        searchFor: '// Blood Tithe refund',           lines: 8   },
  { name: 'menderRetreat',     searchFor: 'menderRetreat',                   lines: 20  },
  { name: 'ironResolve',       searchFor: '// Warriors Iron Resolve',        lines: 6   },
  { name: 'growOnKill',        searchFor: 'killer.def.growOnKill',           lines: 10  },
  { name: 'passiveSummon',     searchFor: 'passiveSummon',                   lines: 15  },
  // ── New 14 faction systems ──
  { name: 'updateTarPatches',       searchFor: 'function updateTarPatches(',      lines: 40  },
  { name: 'updateCorpses',          searchFor: 'function updateCorpses(',         lines: 35  },
  { name: 'updateEchoSchedule',     searchFor: 'function updateEchoSchedule(',    lines: 30  },
  { name: 'updateDarkZones',        searchFor: 'function updateDarkZones(',       lines: 35  },
  { name: 'updateNewFactionSystems',searchFor: 'function updateNewFactionSystems(', lines: 50 },
  { name: 'plagueMutation',         searchFor: '_applyPlagueMutation',            lines: 25  },
  { name: 'chrysalisMetamorphosis', searchFor: '_chrysPhase',                     lines: 20  },
  { name: 'tidebornSplit',          searchFor: 'tideHighHP',                      lines: 15  },
  { name: 'veilbornPhase',          searchFor: '_phased',                         lines: 15  },
  { name: 'chronoRewind',           searchFor: 'chronoElite',                     lines: 15  },
  { name: 'illusionistDecoy',       searchFor: '_isDecoy',                        lines: 15  },
  { name: 'pandemoniumChaos',       searchFor: '_panWildfire',                    lines: 15  },
  { name: 'psionicsCorruption',     searchFor: 'corruptOnHit',                   lines: 15  },
  { name: 'fortuneLuckRolls',       searchFor: 'fortuneDouble',                  lines: 15  },
  { name: 'reaverCorpseFeed',       searchFor: 'corpseFeed',                     lines: 15  },
  { name: 'merchantAuraIncome',     searchFor: 'merchantAura',                   lines: 15  },
  // ── Random events ──
  { name: 'fireRandomEvent',        searchFor: 'function fireRandomEvent(',      lines: 40  },
];

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

  const mechanics = source ? _extractMechanics(source) : {};

  _cachedContext = {
    factions,
    gameRules,
    mechanics,
    // Pre-formatted prompt blocks for direct injection
    promptBlocks: {
      full:     _buildFullPromptBlock(factions, gameRules, mechanics),
      factions: _buildFactionBlock(factions),
      rules:    _buildRulesBlock(gameRules),
      mechanics: _buildMechanicsBlock(mechanics),
      compact:  _buildCompactBlock(factions, gameRules),
    },
  };

  console.log(`  ✅ Game context ready: ${factions?.length || 0} factions, ${Object.keys(mechanics).length} mechanic extracts`);
  return _cachedContext;
}

// ── 1. Extract FACTIONS array via Playwright ──────────────────────────────────

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
      // Deep-clone the FACTIONS array stripping non-serialisable values
      return window.FACTIONS.map(f => ({
        id:          f.id,
        name:        f.name,
        tagline:     f.tagline,
        passive:     f.passive,
        ironResolve: f.ironResolve || false,
        startSouls:  f.startSouls,
        startBodies: f.startBodies,
        matchupNote: f.matchup,
        units: (f.units || []).map(u => ({
          id: u.id, name: u.name, souls: u.souls, bodies: u.bodies,
          hp: u.hp, speed: u.speed, dmg: u.dmg, range: u.range,
          attackRate: u.attackRate, aerial: u.aerial || false,
          isWorker: u.isWorker || false, type: u.type,
          // Include every non-standard flag so Claude knows about special mechanics
          ...(u.deathSplash     ? { deathSplash: true, deathSplashDmg: u.deathSplashDmg, deathSplashRange: u.deathSplashRange } : {}),
          ...(u.pitAura         ? { pitAura: true, pitAuraRange: u.pitAuraRange, pitAuraDmg: u.pitAuraDmg } : {}),
          ...(u.alwaysChain     ? { alwaysChain: true } : {}),
          ...(u.chainRate       ? { chainRate: u.chainRate } : {}),
          ...(u.aerialBonus     ? { aerialBonus: u.aerialBonus } : {}),
          ...(u.growOnKill      ? { growOnKill: u.growOnKill, growMaxStacks: u.growMaxStacks } : {}),
          ...(u.lifeSteal       ? { lifeSteal: u.lifeSteal } : {}),
          ...(u.berserkThreshold ? { berserkThreshold: u.berserkThreshold } : {}),
          ...(u.berserkHPThresh ? { berserkHPThresh: u.berserkHPThresh } : {}),
          ...(u.chillOnHit      ? { chillOnHit: true, chillDur: u.chillDur } : {}),
          ...(u.firstHitStun    ? { firstHitStun: true, stunDur: u.stunDur } : {}),
          ...(u.stunChance      ? { stunChance: u.stunChance, stunDur: u.stunDur } : {}),
          ...(u.aoeShot         ? { aoeShot: true, aoeSplashRange: u.aoeSplashRange, aoeSplashMult: u.aoeSplashMult } : {}),
          ...(u.burnOnHit       ? { burnOnHit: true, burnDmg: u.burnDmg, burnDur: u.burnDur } : {}),
          ...(u.poisonOnHit     ? { poisonOnHit: true, poisonDmg: u.poisonDmg, poisonDur: u.poisonDur } : {}),
          ...(u.summons         ? { summons: u.summons, summonCount: u.summonCount, passiveSummon: u.passiveSummon } : {}),
          ...(u.deathSpawn      ? { deathSpawn: u.deathSpawn } : {}),
          ...(u.sylphHeal       ? { sylphHeal: u.sylphHeal, sylphHealRange: u.sylphHealRange } : {}),
          ...(u.seraphHeal      ? { seraphHeal: u.seraphHeal, seraphHealRange: u.seraphHealRange } : {}),
          ...(u.isHealer        ? { isHealer: true, healAmt: u.healAmt } : {}),
          ...(u.menderRetreat   ? { menderRetreat: true, healDuration: u.healDuration, returnDmgBonus: u.returnDmgBonus } : {}),
          ...(u.bearAura        ? { bearAura: true } : {}),
          ...(u.groundSlam      ? { groundSlam: true } : {}),
          ...(u.immuneKnockback ? { immuneKnockback: true } : {}),
          ...(u.immuneDebuff    ? { immuneDebuff: true } : {}),
          ...(u.immuneStun      ? { immuneStun: true } : {}),
          ...(u.pollenDeath     ? { pollenDeath: true } : {}),
          ...(u.armor           ? { armor: u.armor } : {}),
          ...(u.chargeStrike    ? { chargeStrike: true } : {}),
          ...(u.soulsOnKill     ? { soulsOnKill: u.soulsOnKill } : {}),
          ...(u.thornslow       ? { thornslow: true } : {}),
          ...(u.frostMidBonus   ? { frostMidBonus: true } : {}),
          ...(u.groveMidBonus   ? { groveMidBonus: true } : {}),
          // ── New faction flags (14 new factions) ──
          ...(u.webTrail        ? { webTrail: true } : {}),
          ...(u.tarShot         ? { tarShot: true } : {}),
          ...(u.cocoonsOnDeath  ? { cocoonsOnDeath: true } : {}),
          ...(u.merchantAura    ? { merchantAura: true } : {}),
          ...(u.merchantMidBonus ? { merchantMidBonus: true } : {}),
          ...(u.corpseFeed      ? { corpseFeed: true } : {}),
          ...(u.bodyOnKill      ? { bodyOnKill: u.bodyOnKill } : {}),
          ...(u.reaverWorker    ? { reaverWorker: true } : {}),
          ...(u.reaverKillBonus ? { reaverKillBonus: u.reaverKillBonus } : {}),
          ...(u.fortuneDouble   ? { fortuneDouble: u.fortuneDouble } : {}),
          ...(u.fortuneRefund   ? { fortuneRefund: u.fortuneRefund } : {}),
          ...(u.fortuneStreak   ? { fortuneStreak: true } : {}),
          ...(u.plagued         ? { plagued: true } : {}),
          ...(u.plagueMaxMutations ? { plagueMaxMutations: u.plagueMaxMutations } : {}),
          ...(u.chrysalis       ? { chrysalis: true } : {}),
          ...(u.tideborn        ? { tideborn: true } : {}),
          ...(u.tideHighHP      ? { tideHighHP: u.tideHighHP } : {}),
          ...(u.chronoElite     ? { chronoElite: true } : {}),
          ...(u.chronoBonus     ? { chronoBonus: u.chronoBonus } : {}),
          ...(u.veilborn        ? { veilborn: true } : {}),
          ...(u.umbral          ? { umbral: true } : {}),
          ...(u.umbralAura      ? { umbralAura: true } : {}),
          ...(u.darkOnDeath     ? { darkOnDeath: true } : {}),
          ...(u.pandemonium     ? { pandemonium: true } : {}),
          ...(u.corruptOnHit    ? { corruptOnHit: true } : {}),
          ...(u.psionicAura     ? { psionicAura: true } : {}),
        })),
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

// ── 3. Extract mechanic implementations from source ───────────────────────────

function _extractMechanics(source) {
  const lines  = source.split('\n');
  const result = {};

  for (const spec of MECHANIC_EXTRACTS) {
    const idx = lines.findIndex(l => l.includes(spec.searchFor));
    if (idx === -1) continue;
    const end = Math.min(idx + spec.lines, lines.length);
    result[spec.name] = {
      startLine: idx + 1,
      code: lines.slice(idx, end)
        .map((l, i) => `${String(idx + i + 1).padStart(5)}: ${l}`)
        .join('\n'),
    };
  }
  return result;
}

// ── Prompt block builders ─────────────────────────────────────────────────────

function _buildFactionBlock(factions) {
  if (!factions) return '(faction data unavailable)';
  return factions.map(f => {
    const unitLines = f.units.map(u => {
      const flags = Object.entries(u)
        .filter(([k]) => !['id','name','souls','bodies','hp','speed','dmg','range','attackRate','aerial','isWorker','type'].includes(k))
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(' ');
      return `    ${u.name} [${u.type}${u.aerial ? '/air' : ''}]: ${u.souls}💀${u.bodies}🦴 | HP:${u.hp} SPD:${u.speed} DMG:${u.dmg} RNG:${u.range} ATK:${u.attackRate}/s${flags ? ` | ${flags}` : ''}`;
    }).join('\n');

    const upgLines = f.upgrades.map(u =>
      `    ${u.name} [${u.cost.souls}💀${u.cost.bodies}🦴]: ${u.desc}`
    ).join('\n');

    const guard = f.extraUnits?.find(u => u.id === f.guardUnit);
    const guardLine = guard ? `  Guard: ${guard.name} — HP:${guard.hp} DMG:${guard.dmg} | ${guard.desc}` : '';

    return [
      `── ${f.name.toUpperCase()} (${f.id}) ──`,
      `  Start: ${f.startSouls}💀 ${f.startBodies}🦴`,
      `  Passive: ${f.passive}`,
      f.ironResolve ? '  Iron Resolve: units <30% HP take 15% less dmg from all sources' : '',
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
    `  Aerial vs aerial (baseline): ${rules.aerialVsAerialMult}× DMG (aerialBonus units replace this, not stack)`,
    `  Ranged vs HP≥${rules.rangedVsHighHpThresh}: ${rules.rangedVsHighHpMult}× DMG`,
    `  Melee slow on hit: ${rules.meleeSlow.duration}s at ${rules.meleeSlow.speedMult}× speed (glacial overrides with longer dur)`,
    `  Veteran bonus: ${rules.veteranKillThresh} kills → +${rules.veteranDmgBonus * 100}% DMG permanently`,
    `  Max shades (Summoners): ${rules.maxShades} default, raised by Dark Covenant upgrade`,
    `  Soul cap: ${rules.soulCapMax}`,
  ].join('\n');
}

function _buildMechanicsBlock(mechanics) {
  if (!Object.keys(mechanics).length) return '(mechanic code unavailable)';
  return Object.entries(mechanics).map(([name, { startLine, code }]) =>
    `── ${name} (line ${startLine}) ──\n${code}`
  ).join('\n\n');
}

function _buildCompactBlock(factions, rules) {
  if (!factions) return _buildRulesBlock(rules);
  // One line per faction: just the key stats for quick reference
  const rows = factions.map(f => {
    const nonWorkerUnits = f.units.filter(u => !u.isWorker);
    const avgDmg = nonWorkerUnits.length
      ? Math.round(nonWorkerUnits.reduce((s, u) => s + u.dmg, 0) / nonWorkerUnits.length)
      : 0;
    const avgHp  = nonWorkerUnits.length
      ? Math.round(nonWorkerUnits.reduce((s, u) => s + u.hp, 0) / nonWorkerUnits.length)
      : 0;
    const hasAerial  = f.units.some(u => u.aerial && !u.isWorker) ? '✓aerial' : '✗aerial';
    const hasRanged  = f.units.some(u => u.range > 60 && !u.isWorker) ? '✓ranged' : '✗ranged';
    return `  ${f.id.padEnd(12)}: start ${f.startSouls}💀${f.startBodies}🦴 | avgDMG:${avgDmg} avgHP:${avgHp} | ${hasAerial} ${hasRanged} | ${f.passive.slice(0, 80)}`;
  });
  return ['FACTION QUICK REF:', ...rows, '', _buildRulesBlock(rules)].join('\n');
}

function _buildFullPromptBlock(factions, rules, mechanics) {
  const sections = [
    '╔══════════════════════════════════════════════════════════════════════╗',
    '║          BEYOND RTS CONQUEST — FULL GAME CONTEXT                    ║',
    '╚══════════════════════════════════════════════════════════════════════╝',
    '',
    'ARCHITECTURE: Single-file browser RTS (~25,000 lines, vanilla JS + Canvas, 24 factions).',
    'Players spend Souls💀 + Bodies🦴 to spawn units. Mid capture gives income bonus.',
    'Base HP reaches 0 → lose. Last Stand triggers at ≤30 HP (3 guards + 40💀 + grace).',
    '',
    _buildRulesBlock(rules),
    '',
    '══ FACTIONS ══',
    '',
    _buildFactionBlock(factions),
    '',
    '══ KEY MECHANIC IMPLEMENTATIONS (from source) ══',
    '(These are the actual JS functions that run — reference line numbers when diagnosing)',
    '',
    _buildMechanicsBlock(mechanics),
  ];
  return sections.join('\n');
}

// ── Inject context into a prompt string ──────────────────────────────────────

/**
 * Prepend the appropriate context block to a prompt.
 * level: 'full' | 'factions' | 'rules' | 'mechanics' | 'compact'
 */
function injectContext(prompt, gameContext, level = 'full') {
  if (!gameContext) return prompt;
  const block = gameContext.promptBlocks[level] || gameContext.promptBlocks.compact;
  return `${block}\n\n${'═'.repeat(72)}\n\n${prompt}`;
}

module.exports = { buildGameContext, injectContext };
