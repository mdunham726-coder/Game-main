// Engine.js — orchestrator; preserves v118 behavior byte-for-byte on state
// PHASE 3C: Quest System Integration + L1 Cell Streaming
const readline = require('readline');
const crypto = require('crypto');
const WorldGen = require('./WorldGen');
const Actions = require('./ActionProcessor');
const { QuestSystem } = require('./QuestSystem');

// Shared defaults must match modules
const DEFAULTS = {
  L0_SIZE: { w: 8, h: 8 },
  L1_SIZE: { w: 12, h: 12 },
  STREAM: { R: 2, P: 1 },
};

// L1 Cell Streaming: Biome-to-terrain mapping (inline implementation)
const BIOME_TERRAIN_TYPES = {
  urban: ["street", "plaza", "alley", "park_urban", "district_commercial", "district_residential", "building_complex", "market_square", "garden_urban", "meadow"],
  rural: ["plains_grassland", "plains_wildflower", "meadow", "forest_deciduous", "hills_rolling", "river_crossing", "stream"],
  forest: ["forest_deciduous", "forest_mixed", "forest_coniferous", "meadow", "stream", "hills_rolling"],
  desert: ["desert_sand", "desert_dunes", "desert_rocky", "scrubland", "badlands", "canyon", "mesa"],
  tundra: ["tundra", "snowfield", "ice_sheet", "permafrost", "alpine"],
  jungle: ["forest_coniferous", "meadow", "swamp", "marsh", "river_crossing", "stream", "wetland"],
  coast: ["beach_sand", "beach_pebble", "cliffs_coastal", "tidepools", "dunes_coastal", "scrubland", "plains_grassland"],
  mountain: ["mountain_slopes", "mountain_peak", "mountain_pass", "rocky_terrain", "scree", "alpine", "hills_rocky"],
  wetland: ["swamp", "marsh", "wetland", "bog", "stream", "river_crossing"]
};

function toISO8601(value) {
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}
function deepClone(input, seen = new WeakMap()) {
  if (input === null || typeof input !== 'object') return input;
  if (seen.has(input)) return seen.get(input);
  if (Array.isArray(input)) {
    const arr = [];
    seen.set(input, arr);
    for (const v of input) arr.push(deepClone(v, seen));
    return arr;
  }
  if (input instanceof Date) return new Date(input.getTime());
  if (input instanceof RegExp) return new RegExp(input.source, input.flags);
  const out = {};
  seen.set(input, out);
  for (const k of Object.keys(input)) out[k] = deepClone(input[k], seen);
  return out;
}
let TURN_SEQ = 0;
function genTurnId(userProvided) {
  if (userProvided && typeof userProvided === 'string' && userProvided.trim().length > 0) return userProvided;
  const ts = Date.now();
  const pid = (typeof process !== 'undefined' && process && process.pid) ? process.pid : Math.floor(Math.random()*1e5);
  const rnd = Math.floor(Math.random()*1e9);
  const seq = (TURN_SEQ++ & 0xFFFFFFFF);
  return `t${ts}_${pid}_${seq}_${rnd}`;
}
function l0Id(mx, my) {
  const row = String.fromCharCode('A'.charCodeAt(0) + mx);
  const col = (my + 1);
  return row + col;
}
function stateFingerprintStableHex(state) {
  const sf = state.fingerprint.stable_fields || {};
  const schema_version = String(sf.schema_version ?? '1.1.0');
  const world_seed = String(sf.world_seed ?? 0);
  const ruleset_rev = String(sf.ruleset_rev ?? 1);
  const concat = `${schema_version}|${world_seed}|${ruleset_rev}`;
  return crypto.createHash('sha256').update(concat,'utf8').digest('hex');
}
function stateFingerprintFullHex(state) {
  const proj = {
    schema_version: state.schema_version,
    rng_seed: state.rng_seed,
    turn_counter: state.turn_counter,
    player: state.player,
    world: state.world,
    counters: state.counters,
    digests: state.digests,
    history_len: Array.isArray(state.history) ? state.history.length : 0,
    ledger_len: (state.ledger && Array.isArray(state.ledger.promotions)) ? state.ledger.promotions.length : 0
  };
  const s = JSON.stringify(proj);
  return crypto.createHash('sha256').update(s,'utf8').digest('hex');
}

// PHASE 3C: Quest System Initialization
function initState(timestampUTC) {
  const l1w = DEFAULTS.L1_SIZE.w, l1h = DEFAULTS.L1_SIZE.h;
  return {
    schema_version: "1.1.0",
    rng_seed: 0,
    turn_counter: 0,
    player: { id: "player-1", aliases: ["you"], stats: { stamina: 100, clarity: 100 }, inventory: [] },
    world: {
      time_utc: timestampUTC,
      l0: { w: DEFAULTS.L0_SIZE.w, h: DEFAULTS.L0_SIZE.h },
      l1_default: { w: l1w, h: l1h },
      stream: { R: DEFAULTS.STREAM.R, P: DEFAULTS.STREAM.P },
      macro: {}, cells: {}, sites: {},
      merchants: [], factions: [], npcs: [],
      settlements: {}, // PHASE 3C: Persistent settlement storage
      position: { mx: 0, my: 0, lx: Math.floor(l1w/2), ly: Math.floor(l1h/2) }
    },
    ledger: { promotions: [] },
    counters: { state_rev: 0, site_rev: 0, cell_rev: 0, inventory_rev: 0, merchant_state_rev: 0, faction_rev: 0 },
    fingerprint: {
      stable_fields: { schema_version: "1.1.0", world_seed: 0, ruleset_rev: 1 },
      hash_alg: "SHA-256",
      hex_digest: "",
      hex_digest_stable: "",
      hex_digest_state: ""
    },
    digests: { inventory_digest: "" },
    // PHASE 3C: Quest System State Schema
    quests: {
      active: [],           // MAX 10 ENFORCED
      completed: [],
      allQuestsSeeded: {},  // settlementId → [quests]
      config: {
        maxActiveQuests: 10,
        maxQuestsPerSettlement: 5
      }
    },
    reputation: {},
    history: []
  };
}

// L1 CELL STREAMING IMPLEMENTATION
/**
 * Generates L1 terrain cells around the player position using biome data from L0 macro cells
 * @param {object} state - The game state object
 */
function streamL1Cells(state) {
  if (!state || !state.world || !state.world.position) {
    console.log('[STREAM] No valid state or position found');
    return;
  }

  const pos = state.world.position;
  const streamR = state.world.stream?.R || 2;
  const l1w = state.world.l1_default?.w || 12;
  const l1h = state.world.l1_default?.h || 12;
  const l0w = state.world.l0_size?.w || 8;
  const l0h = state.world.l0_size?.h || 8;
  
  console.log(`[STREAM] Generating L1 cells around position: M${pos.mx},${pos.my} L${pos.lx},${pos.ly} (radius: ${streamR})`);

  let cellsGenerated = 0;

  // Generate cells in streaming radius around player (including adjacent macro cells)
  for (let dx = -streamR; dx <= streamR; dx++) {
    for (let dy = -streamR; dy <= streamR; dy++) {
      let lx = pos.lx + dx;
      let ly = pos.ly + dy;
      let mx = pos.mx;
      let my = pos.my;
      
      // Handle L1 grid boundaries by wrapping to adjacent macro cells
      if (lx < 0) { mx -= 1; lx = l1w - 1; }
      if (lx >= l1w) { mx += 1; lx = 0; }
      if (ly < 0) { my -= 1; ly = l1h - 1; }
      if (ly >= l1h) { my += 1; ly = 0; }
      
      // Wrap macro coordinates around L0 grid
      mx = ((mx % l0w) + l0w) % l0w;
      my = ((my % l0h) + l0h) % l0h;

      const cellKey = `L1:${mx},${my}:${lx},${ly}`;
      
      // Skip if cell already exists
      if (state.world.cells[cellKey]) {
        continue;
      }

      // Find biome for this macro cell
      const l0Key = `L0:${mx},${my}`;
      const l0Cell = state.world.cells[l0Key];
      let biome = "rural"; // Default fallback
      
      if (l0Cell && l0Cell.biome) {
        biome = l0Cell.biome;
      } else if (state.world.macro_biome && mx === pos.mx && my === pos.my) {
        // Only use world macro_biome for the player's current macro cell
        biome = state.world.macro_biome;
      }

      // Get terrain types for this biome
      const terrainArray = BIOME_TERRAIN_TYPES[biome] || BIOME_TERRAIN_TYPES["rural"];

      // Randomly select terrain type from biome palette
      const randomIndex = Math.floor(Math.random() * terrainArray.length);
      const terrainType = terrainArray[randomIndex];

      // Create new L1 cell
      state.world.cells[cellKey] = {
        type: terrainType,
        subtype: "",
        biome: biome,
        mx: mx,
        my: my,
        lx: lx,
        ly: ly,
        description: "" // Will be filled by L1 description pass
      };

      // Phase 4: Deterministic site generation at cell creation time
      const _worldSeed = state.world.phase3_seed || 0;
      const _worldBias = state.world.world_bias;
      const _sites = WorldGen.evaluateCellForSites(cellKey, terrainType, _worldBias, _worldSeed);
      for (const _site of _sites) recordSiteToCell(state, cellKey, _site);

      cellsGenerated++;
      console.log(`[STREAM] Generated cell ${cellKey}: ${terrainType} (biome: ${biome}) sites: ${_sites.length}`);
    }
  }

  console.log(`[STREAM] Generated ${cellsGenerated} new L1 cells`);
}

/**
 * Phase 4: Authoritative single write path for site records.
 * Writes site to cell.sites and mirrors settlement-category sites to
 * world.settlements for backward compatibility (temporary — removed in Phase 6).
 *
 * @param {object} state   — game state
 * @param {string} cellKey — L1 cell key
 * @param {object} site    — site record from evaluateCellForSites
 */
function recordSiteToCell(state, cellKey, site) {
  const cell = state.world.cells[cellKey];
  if (!cell) return;

  // Phase 7: Reserve canonical l2_id on settlement sites at registration time.
  // This is identity reservation only — no L2 content is generated here.
  if (site.category === 'settlement' && !site.l2_id) {
    site.l2_id = `${site.site_id}/l2`;
  }

  cell.sites = cell.sites || {};
  cell.sites[site.site_id] = site;

  // Mirror settlement-category sites into world.settlements as stubs (keyed by canonical l2_id).
  // Actual L2 content is generated lazily on first entry via enterL2FromL1.
  if (site.category === 'settlement') {
    state.world.settlements = state.world.settlements || {};
    state.world.settlements[site.l2_id] = {
      name:    site.name ?? null,
      type:    site.identity || site.subtype || site.category,
      npcs:    [],
      is_stub: true,
      mx:      cell.mx,
      my:      cell.my,
      lx:      cell.lx,
      ly:      cell.ly,
    };
  }
}

// PHASE 3C: Seeded RNG for deterministic NPC assignments
function createSeededRNG(seed) {
  let state = crypto.createHash('sha256').update(String(seed)).digest('hex');
  let callCount = 0;
  
  return function() {
    callCount++;
    state = crypto.createHash('sha256')
      .update(state + callCount)
      .digest('hex');
    return parseInt(state.substring(0, 8), 16) / 0xFFFFFFFF;
  };
}

// PHASE 3C: Quest-Giver NPC Assignment
function assignQuestGiverFlags(npcArray, worldSeed, settlementId) {
  const rng = createSeededRNG(worldSeed + settlementId);
  const population = npcArray.length;
  const baseProbability = Math.max(0.10, 150 / population);
  const maxQuestGivers = Math.ceil(population * 0.30);
  
  let questGiverCount = 0;
  npcArray.forEach(npc => {
    if (questGiverCount < maxQuestGivers && rng() < baseProbability) {
      npc.can_give_quests = true;
      questGiverCount++;
    } else {
      npc.can_give_quests = false;
    }
  });
}

// PHASE 3C: Settlement Quest Generation
function generateSettlementQuests(state, settlementId, settlementData, npcArray) {
  if (!state.questSystem) {
    state.questSystem = new QuestSystem(state.rng_seed);
  }
  
  const questSeed = state.rng_seed + settlementId + "quests";
  const constraints = {
    settlementType: settlementData.type,
    playerLevel: state.player.level || 1,
    availableNPCs: npcArray,
    currentThreats: settlementData.threats || [],
    seed: questSeed
  };

  try {
    const quests = state.questSystem.generateSettlementQuests(constraints);
    
    // Assign quests to quest-giver NPCs
    const questGivers = npcArray.filter(npc => npc.can_give_quests);
    quests.forEach(quest => {
      if (questGivers.length > 0) {
        const rng = createSeededRNG(questSeed + quest.id);
        const giverNpc = questGivers[Math.floor(rng() * questGivers.length)];
        quest.giver_npc_id = giverNpc.id;
        quest.giver_name = giverNpc.name;
      } else {
        quest.giver_npc_id = null;
        quest.giver_name = "Local Resident";
      }
      
      // Add settlement metadata
      quest.settlementId = settlementId;
      quest.settlementName = settlementData.name;
      quest.status = "available";
      quest.current_step = 0;
    });
    
    return quests.slice(0, state.quests.config.maxQuestsPerSettlement);
  } catch (error) {
    console.error('[ENGINE] Quest generation failed:', error);
    return [];
  }
}
// PHASE 3C: Quest Validation Functions
function validateQuestAcceptance(state, questId) {
  // Cap check
  if (state.quests.active.length >= state.quests.config.maxActiveQuests) {
    return { valid: false, error: "ACTIVE_QUEST_LIMIT" };
  }
  
  // Quest existence check (search all settlements)
  const quest = Object.values(state.quests.allQuestsSeeded)
    .flat()
    .find(q => q.id === questId);
  
  if (!quest) {
    return { valid: false, error: "QUEST_NOT_FOUND", status: 404 };
  }
  
  // Already active?
  if (state.quests.active.find(q => q.id === questId)) {
    return { valid: false, error: "QUEST_ALREADY_ACTIVE", status: 409 };
  }
  
  return { valid: true, quest };
}

function validateQuestCompletion(state, questId) {
  const quest = state.quests.active.find(q => q.id === questId);
  if (!quest) {
    return { valid: false, error: "QUEST_NOT_FOUND", status: 404 };
  }
  
  if (quest.current_step !== quest.total_steps) {
    return { valid: false, error: "INCOMPLETE_QUEST", status: 400 };
  }
  
  return { valid: true, quest };
}

function applyQuestReward(state, quest) {
  // Add gold to player inventory
  if (!state.player.inventory) state.player.inventory = [];
  
  const goldItem = state.player.inventory.find(item => item.type === 'gold');
  if (goldItem) {
    goldItem.quantity = (goldItem.quantity || 0) + quest.reward_gold;
  } else {
    state.player.inventory.push({
      id: 'gold_' + Date.now(),
      type: 'gold',
      name: 'Gold Coins',
      quantity: quest.reward_gold
    });
  }
  
  return state;
}

function buildOutput(prevState, inputObj, logger) {
  const nowUTC = toISO8601(inputObj && inputObj["timestamp_utc"]);
  const turnId = genTurnId(inputObj && inputObj["turn_id"]);
  let state = prevState ? deepClone(prevState) : initState(nowUTC);

  const changes1 = [];
  const changes2 = [];
  const phaseFlags = { inventory_rev:false, merchant_state_rev:false, faction_rev:false };

  // Time delta
  state.world.time_utc = nowUTC;
  changes1.push({ op:"set", path:"/world/time_utc", value: nowUTC });

  // Phase C pre: expiry tick
  // Actions.tickMerchantsAndFactions(state, nowUTC, changes1, phaseFlags);

  // Parse & apply player actions (non-movement)
  // Check if player_intent is already a structured object with action field (from semantic parser)
  // If so, use it directly. Otherwise fall back to legacy parseIntent for backward compatibility
  const actions = (typeof inputObj?.player_intent === 'object' && inputObj?.player_intent?.action)
    ? inputObj.player_intent
    : (Actions.parseIntent(inputObj?.player_intent?.raw ?? inputObj?.player_intent ?? "") || { action:'noop' });
  
  // Save old position for location change detection
  const oldPosition = state.world.position ? {...state.world.position} : null;
  const oldCellKey = oldPosition ? `L1:${oldPosition.mx},${oldPosition.my}:${oldPosition.lx},${oldPosition.ly}` : null;
  const oldCell = oldCellKey ? state.world.cells?.[oldCellKey] : null;
  const oldCellType = oldCell?.type || oldCell?.tags?.type || 'unknown';
  
  Actions.applyPlayerActions(state, actions, changes1, phaseFlags, logger);

  // Phase 7: Handle 'enter' action — site-driven L2 entry.
  // Lives in buildOutput (not ActionProcessor) to avoid circular dependency.
  if (actions.action === 'enter') {
    const enterPos = state.world.position;
    const enterCellKey = `L1:${enterPos.mx},${enterPos.my}:${enterPos.lx},${enterPos.ly}`;
    const enterCell = state.world.cells && state.world.cells[enterCellKey];
    const enterSites = enterCell ? Object.values(enterCell.sites || {}) : [];

    // Phase 7 temporary scaffolding: minimal site resolution.
    // Priority: explicit name match → first settlement site → first poi site.
    // Multi-site disambiguation and clarification prompts are deferred to a later phase.
    let targetSite = null;
    const targetName = (actions.target || '').toLowerCase().trim();
    if (targetName) {
      targetSite = enterSites.find(s => s.name && s.name.toLowerCase().includes(targetName));
    }
    if (!targetSite) targetSite = enterSites.find(s => s.category === 'settlement');
    if (!targetSite) targetSite = enterSites.find(s => s.category === 'poi');

    if (targetSite) {
      enterL2FromL1(state, { cell_key: enterCellKey, site_id: targetSite.site_id });
    } else {
      console.log('[Phase7-ENTER] No enterable site found at', enterCellKey);
    }
  }

  // WorldGen step (movement + streaming + site reveal)
  // Biome should already be set by index.js before this is called
  console.log('[ENGINE] Biome check - has biome?', !!state?.world?.macro_biome);
const wg = WorldGen.worldGenStep(state.world, { actions });
if (wg && Array.isArray(wg.deltas)) {
  for (const d of wg.deltas) changes1.push(d);
}
if (wg) {
  state.world = { ...state.world, ...wg };
}

  // Track location change
  const newPosition = state.world.position;
  const positionChanged = oldPosition && (oldPosition.mx !== newPosition.mx || oldPosition.my !== newPosition.my || oldPosition.lx !== newPosition.lx || oldPosition.ly !== newPosition.ly);
  
  // L1 CELL STREAMING: Generate terrain cells around player
  streamL1Cells(state);
  
  // Log location change if position actually changed
  if (positionChanged && logger) {
    const newCellKey = `L1:${newPosition.mx},${newPosition.my}:${newPosition.lx},${newPosition.ly}`;
    const newCell = state.world.cells?.[newCellKey];
    const newCellType = newCell?.type || newCell?.tags?.type || 'unknown';
    logger.location_changed(
      oldCellType,
      null,  // old sub-location (not currently tracked)
      newCellType,
      null   // new sub-location (not currently tracked)
    );
  }
  
  // L1 description pass: ensure each visible cell has a narrative description
  if (state && state.world && state.world.cells) {
    const worldSeed = state.world.seed || state.rng_seed || "default";
    for (const id in state.world.cells) {
      const cell = state.world.cells[id];
      if (!cell) continue;
      if (!cell.description && !cell.is_custom) {
        const desc = WorldGen.generateL1FeatureDescription({
          type: (cell.category || cell.tags?.category || "geography"),
          subtype: (cell.type || cell.tags?.type || "default"),
          mx: cell.mx ?? state.world.position.mx,
          my: cell.my ?? state.world.position.my,
          lx: cell.lx,
          ly: cell.ly,
          id: id  // Use cell key as unique identifier
        }, worldSeed);
        cell.description = desc;
        changes1.push({ op: "set", path: `/world/cells/${id}/description`, value: desc });
      }
    }
  }

  // Digest inventory
  const invHex = Actions.computeInventoryDigestHex(state);
  state.digests.inventory_digest = invHex;

  // Turn counter + periodic regen
  state.turn_counter = (state.turn_counter|0) + 1;
  if (state.turn_counter % 10 === 0) Actions.merchantRegenOnTurn(state, nowUTC, changes1, phaseFlags);

  // Counters
  if (phaseFlags.inventory_rev) { state.counters.inventory_rev = (state.counters.inventory_rev|0) + 1; changes1.push({ op:'inc', path:'/counters/inventory_rev', value:1 }); }
  if (phaseFlags.merchant_state_rev) { state.counters.merchant_state_rev = (state.counters.merchant_state_rev|0) + 1; changes1.push({ op:'inc', path:'/counters/merchant_state_rev', value:1 }); }

  if (changes1.length > 0) {
    state.counters.state_rev = (state.counters.state_rev|0) + 1;
    changes1.push({ op:"inc", path:"/counters/state_rev", value:1 });
  }

  const pos = state.world.position;
  const planMeta = (function(){
    const macroKey = `${pos.mx},${pos.my}`;
    const macro = state.world.macro && state.world.macro[macroKey];
    const sp = macro && macro.site_plan;
    return sp ? sp.meta : null;
  })();

  const known = new Set();
  for (const id in state.world.cells) {
    const c = state.world.cells[id];
    if (c.mx !== pos.mx || c.my !== pos.my) continue;
    if (c.hydrated) known.add(`M${c.mx}x${c.my}/L${c.lx}x${c.ly}`);
  }
  const macro = state.world.macro[`${pos.mx},${pos.my}`];
  const plan = macro && macro.site_plan || { clusters: [] };
  const cluster_meta = plan.clusters.map(cl => {
    const visible_cells = [];
    for (const seg of cl.cells) {
      const k = `M${pos.mx}x${pos.my}/L${seg.lx}x${seg.ly}`;
      if (known.has(k)) visible_cells.push({ lx: seg.lx, ly: seg.ly });
    }
    return { cluster_id: cl.cluster_id, tier: cl.tier, total_segments: cl.cells.length, visible_segments: visible_cells.length, visible_cells };
  });

  const delta1 = {
    turn_id: turnId,
    labels: ["PLAYER","INVENTORY","QUESTS","WORLD","CELLS","SITES","MERCHANTS","FACTIONS","COUNTERS"],
    changes: changes1,
    post_state_facts: {
      position: { ...state.world.position },
      l0_id: l0Id(pos.mx,pos.my),
      l1_dims: { ...state.world.l1_default },
      stream: { ...state.world.stream },
      cluster_meta,
      site_plan_meta: planMeta,
      inventory_digest: state.digests.inventory_digest
    }
  };

  const history_entry = {
    turn_id: turnId,
    timestamp_utc: nowUTC,
    intent: (inputObj && inputObj["player_intent"]) || "",
    summary: (actions.action === 'move' ? `You move ${actions.dir?.toUpperCase()}.` :
             (actions.action==='look' ? "You look around." :
             (actions.action==='take' ? `You try to take ${actions.target||''}.` :
             (actions.action==='drop' ? `You drop ${actions.target||''}.` : "Time passes."))))
  };
  if (!Array.isArray(state.history)) state.history = [];
  state.history.push(history_entry);

  const fpStable = stateFingerprintStableHex(state);
  const fpState  = stateFingerprintFullHex(state);
  state.fingerprint.hex_digest_stable = fpStable;
  state.fingerprint.hex_digest_state  = fpState;
  state.fingerprint.hex_digest        = fpState;

  const delta2 = {
    turn_id: turnId,
    labels: ["HISTORY","FINGERPRINT"],
    changes: [
      { op:"add", path:"/history/-", value: history_entry },
      { op:"set", path:"/fingerprint/hex_digest_stable", value: fpStable },
      { op:"set", path:"/fingerprint/hex_digest_state",  value: fpState },
      { op:"set", path:"/fingerprint/hex_digest",        value: fpState }
    ],
    post_state_facts: {
      summary: {
        cells_total: Object.keys(state.world.cells).length,
        sites_total: Object.keys(state.world.sites).length
      },
      fingerprint: fpState
    }
  };

  const blocks = [];
  blocks.push("[STATE-DELTA 1/2]\n" + JSON.stringify(delta1, null, 2));
  blocks.push("[STATE-DELTA 2/2]\n" + JSON.stringify(delta2, null, 2));
  return { blocks, state };
}
// CLI harness (compatible with v118 workflow)
function main() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let buf = '';
  rl.on('line', line => { buf += line + '\n'; });
  rl.on('close', () => {
    buf = buf.trim();
    try {
      const inputObj = JSON.parse(buf || "{}");
      const prev = inputObj.previous_state || null;
      const { blocks } = buildOutput(prev, inputObj);
      for (let i = 0; i < blocks.length; i++) {
        process.stdout.write(blocks[i]);
        if (i < blocks.length - 1) process.stdout.write('\n\n');
      }
    } catch (e) {
      process.stdout.write(JSON.stringify({ error:"INVALID_INPUT_JSON", detail:String(e && e.message || e) }));
      process.exit(1);
    }
  });
}
if (require.main === module) main();

/**
 * Enter an L2 location (settlement or POI) from an L1 cell.
 * Phase 7: Site-driven entry — l2_id derived from site.site_id, not cell subtype.
 * Input: { cell_key, site_id } — caller resolves target site before calling.
 */
function enterL2FromL1(state, { cell_key, site_id }) {
  if (!state || !state.world) return null;

  // Resolve site from cell.sites
  const cell = state.world.cells && state.world.cells[cell_key];
  if (!cell) return null;
  const site = cell.sites && cell.sites[site_id];
  if (!site) return null;

  // Defensive: accept both site.identity (Phase 7) and site.subtype (WorldGen legacy format)
  const identity = site.identity || site.subtype || 'village';
  const sid = site.site_id || site.id || site_id;

  // Ensure l2_id is set — should already be set by recordSiteToCell, but assign lazily
  // for sites that were created before Phase 7 (old sessions).
  if (!site.l2_id) {
    site.l2_id = `${sid}/l2`;
  }
  const l2_id = site.l2_id;

  // Phase 7 migration guard: if canonical l2_id key is missing, check legacy key formats
  // and re-key to canonical before use. Prevents duplicate generation for old sessions.
  state.world.settlements = state.world.settlements || {};
  if (!state.world.settlements[l2_id]) {
    // Legacy format 1: Phase-6 recordSiteToCell keyed by site_id directly
    const legacyKey6 = sid;
    // Legacy format 2: old subtype-based key M{mx}x{my}/L1_{lx}_{ly}_{identity}
    const parts = cell_key.match(/^L1:(\d+),(\d+):(\d+),(\d+)$/);
    const legacyKeySubtype = parts
      ? `M${parts[1]}x${parts[2]}/L1_${parts[3]}_${parts[4]}_${identity}`
      : null;

    const found = state.world.settlements[legacyKey6]
      || (legacyKeySubtype && state.world.settlements[legacyKeySubtype])
      || null;

    if (found) {
      // Re-key to canonical format; remove old key to avoid duplication
      state.world.settlements[l2_id] = found;
      if (state.world.settlements[legacyKey6] && legacyKey6 !== l2_id) delete state.world.settlements[legacyKey6];
      if (legacyKeySubtype && state.world.settlements[legacyKeySubtype]) delete state.world.settlements[legacyKeySubtype];
      console.log(`[Phase7-MIGRATE] Re-keyed settlement to canonical l2_id=${l2_id}`);
    }
  }

  let settlement = state.world.settlements[l2_id];
  const NPCs = require('./NPCs');

  if (settlement && !settlement.is_stub) {
    // Reuse: full settlement already exists — no generation needed
    console.log(`[ENGINE] Reusing persistent settlement: ${settlement.name} with ${(settlement.npcs || []).length} NPCs`);

  } else if (settlement && settlement.is_stub) {
    // Complete stub: generate NPCs and upgrade the existing stub object in-place.
    // world.settlements[l2_id] is mutated directly so stored object == active object.
    console.log(`[ENGINE] Completing stub settlement for l2_id=${l2_id}, identity=${identity}`);

    const expectedNpcCount = WorldGen.getNPCCountForSettlement(identity);
    if (logger) logger.npc_spawn_attempted(l2_id, expectedNpcCount);

    const npcs_here = WorldGen.generateL2NPCs(l2_id, identity, state.rng_seed, NPCs);

    if (logger) {
      if (npcs_here && npcs_here.length > 0) logger.npc_spawn_succeeded(l2_id, npcs_here.length);
      else logger.npc_spawn_failed(l2_id, 'no_npcs_generated');
    }

    assignQuestGiverFlags(npcs_here, state.rng_seed, l2_id);

    // Upgrade stub in-place — same reference stays in world.settlements[l2_id]
    settlement.npcs = npcs_here;
    settlement.is_stub = false;
    settlement.type = settlement.type || identity;

    if (logger) {
      const pos = state.world.position || { mx: 0, my: 0 };
      logger.settlement_registered(l2_id, settlement.name, settlement.type, { mx: pos.mx, my: pos.my });
    }

    console.log(`[ENGINE] Completed stub: ${settlement.name}, ${npcs_here.length} NPCs`);

    if (!state.quests.allQuestsSeeded[l2_id]) {
      const quests = generateSettlementQuests(state, l2_id, settlement, npcs_here);
      state.quests.allQuestsSeeded[l2_id] = quests;
      console.log(`[ENGINE] Generated ${quests.length} quests for ${settlement.name}`);
    }

    site.entered = true;

  } else {
    // Fresh: no settlement record — generate and store. Exactly one generateL2Settlement call.
    const expectedNpcCount = WorldGen.getNPCCountForSettlement(identity);
    if (logger) logger.npc_spawn_attempted(l2_id, expectedNpcCount);

    const npcs_here = WorldGen.generateL2NPCs(l2_id, identity, state.rng_seed, NPCs);

    if (logger) {
      if (npcs_here && npcs_here.length > 0) logger.npc_spawn_succeeded(l2_id, npcs_here.length);
      else logger.npc_spawn_failed(l2_id, 'no_npcs_generated');
    }

    assignQuestGiverFlags(npcs_here, state.rng_seed, l2_id);

    settlement = WorldGen.generateL2Settlement(l2_id, identity, npcs_here);
    state.world.settlements[l2_id] = settlement;

    const totalSettlements = Object.keys(state.world.settlements).length;
    console.log(`[Phase7-STORE] Settlement stored: l2_id=${l2_id}, name=${settlement.name}, type=${settlement.type}, totalCount=${totalSettlements}`);

    if (logger) {
      const pos = state.world.position || { mx: 0, my: 0 };
      logger.settlement_registered(l2_id, settlement.name, settlement.type, { mx: pos.mx, my: pos.my });
    }

    console.log(`[ENGINE] Created new settlement: ${settlement.name} with ${npcs_here.length} NPCs`);

    if (!state.quests.allQuestsSeeded[l2_id]) {
      const quests = generateSettlementQuests(state, l2_id, settlement, npcs_here);
      state.quests.allQuestsSeeded[l2_id] = quests;
      console.log(`[ENGINE] Generated ${quests.length} quests for ${settlement.name}`);
    }

    site.entered = true;
  }

  // Stored object IS the active object — no secondary generation, no split references.
  state.world.l2_active = state.world.settlements[l2_id];
  state.world.l3_active = null;
  state.world.current_layer = 2;
  if (!state.player) state.player = {};
  state.player.layer = 2;
  state.player.position = { x: 0, y: 0 };
  return state.world.l2_active;
}

/**
 * Enter an L3 building from currently active L2.
 */
function enterL3FromL2(state, building_id_short) {
  if (!state || !state.world || !state.world.l2_active) return null;
  const l2 = state.world.l2_active;
  const bld = l2.buildings[building_id_short];
  if (!bld) return null;
  const full_id = `${l2.settlement_id}_${building_id_short}`;
  const l3 = WorldGen.generateL3Building(full_id, bld);
  state.world.l3_active = l3;
  state.world.current_layer = 3;
  if (!state.player) state.player = {};
  state.player.layer = 3;
  return l3;
}

/**
 * Exit back to L1 from L2.
 */
function exitL2ToL1(state) {
  if (!state || !state.world) return;
  state.world.l2_active = null;
  state.world.current_layer = 1;
  if (!state.player) state.player = {};
  state.player.layer = 1;
}

/**
 * Exit back to L2 from L3.
 */
function exitL3ToL2(state) {
  if (!state || !state.world) return;
  state.world.l3_active = null;
  state.world.current_layer = 2;
  if (!state.player) state.player = {};
  state.player.layer = 2;
}

// PHASE 3C: Export quest functions for use in index.js
module.exports = { 
  buildOutput, 
  initState, 
  enterL2FromL1, 
  enterL3FromL2, 
  exitL2ToL1, 
  exitL3ToL2,
  // Quest system exports
  validateQuestAcceptance,
  validateQuestCompletion,
  applyQuestReward,
  generateSettlementQuests,
  // Phase 4
  recordSiteToCell,
};