// Engine.js — orchestrator; preserves v118 behavior byte-for-byte on state
// PHASE 3C: Quest System Integration + L1 Cell Streaming
const readline = require('readline');
const crypto = require('crypto');
const WorldGen = require('./WorldGen');
const { LAYER_TERRAIN_VOCAB } = require('./WorldGen');
const Actions = require('./ActionProcessor');
const { QuestSystem } = require('./QuestSystem');

// Shared defaults must match modules
const DEFAULTS = {
  L0_SIZE: { w: 8, h: 8 },
  L1_SIZE: { w: 128, h: 128 },
  STREAM: { R: 2, P: 1 },
};

// L1 Cell Streaming: Biome-to-terrain mapping (inline implementation)
// Values must only contain strings present in LAYER_TERRAIN_VOCAB.L0_GEOGRAPHY
const BIOME_TERRAIN_TYPES = {
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
    player: {
      id: 'player',
      type: 'player',
      is_player: true,
      aliases: ['you', 'yourself', 'player'],
      stats: { stamina: 100, clarity: 100 },
      inventory: [],
      attributes: {},
      position: {
        mx: 0, my: 0,
        lx: Math.floor(l1w/2), ly: Math.floor(l1h/2),
        x: null, y: null
      },
      conditions: [],
      conditions_archive: [],
      quests: [],
      reputation: {},
      birth_record: {
        raw_input: null,
        created_turn: 1,
        form: null,
        location_premise: null,
        possessions: [],
        status_claims: [],
        scenario_notes: []
      }
    },
    world: {
      time_utc: timestampUTC,
      l0: { w: DEFAULTS.L0_SIZE.w, h: DEFAULTS.L0_SIZE.h },
      l1_default: { w: l1w, h: l1h },
      stream: { R: DEFAULTS.STREAM.R, P: DEFAULTS.STREAM.P },
      macro: {}, cells: {}, sites: {},
      merchants: [], factions: [], npcs: [],
      position: { mx: 0, my: 0, lx: Math.floor(l1w/2), ly: Math.floor(l1h/2) },
      promotion_log:  [],  // ContinuityBrain: PromotionLogEntry[] — how facts became true
      mood_history:   [],  // ContinuityBrain: mood_snapshot[] — rolling 20-turn cap
      _fillLog:       []   // Fill pipeline: short failure entries only, max 10, session-scoped
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
      allQuestsSeeded: {},  // siteId → [quests]
      config: {
        maxActiveQuests: 10,
        maxQuestsPerSite: 5
      }
    },
    reputation: {},
    history: [],
    payload_archive: {}   // v1.84.21: per-turn raw DeepSeek payload archive (written once at turn-close)
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
  const l1w = state.world.l1_default?.w || 128;
  const l1h = state.world.l1_default?.h || 128;
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

      const cellKey = `LOC:${mx},${my}:${lx},${ly}`;
      
      // Skip if cell already exists
      if (state.world.cells[cellKey]) {
        continue;
      }

      // Find biome for this macro cell
      const l0Key = `MAC:${mx},${my}`;
      const l0Cell = state.world.cells[l0Key];
      let biome = "rural"; // Default fallback
      
      if (l0Cell && l0Cell.biome) {
        biome = l0Cell.biome;
      } else if (state.world.macro_biome && mx === pos.mx && my === pos.my) {
        // Only use world macro_biome for the player's current macro cell
        biome = state.world.macro_biome;
      }

      // Pass 1: compute physical noise fields
      const _worldSeed = state.world.phase3_seed || 0;
      const _elev = WorldGen.evalElevation(mx, my, lx, ly, _worldSeed, biome);
      const _mois = WorldGen.evalMoisture(mx, my, lx, ly, _worldSeed, biome);
      const _temp = WorldGen.evalTemperature(mx, my, lx, ly, _worldSeed, biome);

      // Pass 2: classify terrain deterministically from noise fields
      let terrainType = WorldGen.classifyTerrainFromNoise(_elev, _mois, _temp, biome, cellKey, _worldSeed);

      // Validation guard: reject any terrain string that is not in the L0 geography vocabulary.
      // This catches future palette mistakes or seed edge cases.
      if (!LAYER_TERRAIN_VOCAB.L0_GEOGRAPHY.includes(terrainType)) {
        console.error(`[STREAM] TERRAIN VIOLATION: cell ${cellKey} received invalid L0 type "${terrainType}" (biome: ${biome}) — substituting "plains_grassland"`);
        terrainType = 'plains_grassland';
      }

      // Create new L1 cell
      state.world.cells[cellKey] = {
        type: terrainType,
        subtype: "",
        biome: biome,
        mx: mx,
        my: my,
        lx: lx,
        ly: ly,
        description: "", // Will be filled by L1 description pass
        elevation:   _elev,
        moisture:    _mois,
        temperature: _temp,
        water_distance: null, // Streamed cells lack hydrology data (computed at world init only)
        attributes: {},       // ContinuityBrain: L0 persistent feature storage
      };

      // Phase 4: Deterministic site generation at cell creation time
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
 * Writes site to cell.sites and mirrors enterable sites to
 * world.sites (keyed by interior_key).
 *
 * @param {object} state   — game state
 * @param {string} cellKey — LOC: coordinate key
 * @param {object} site    — site record from evaluateCellForSites
 */
function recordSiteToCell(state, cellKey, site) {
  const cell = state.world.cells[cellKey];
  if (!cell) return;

  // Phase 10: Reserve canonical interior_key on enterable sites at registration time.
  // This is identity reservation only — no L2 content is generated here.
  if (site.enterable === true && !site.interior_key) {
    site.interior_key = `${site.site_id}/l2`;
  }

  site.created_at_turn = site.created_at_turn ?? (state.turn_counter ?? 0);
  cell.sites = cell.sites || {};
  cell.sites[site.site_id] = site;

  // Mirror enterable sites into world.sites as stubs (keyed by canonical interior_key).
  // Actual site interior is generated lazily on first entry via enterSite().
  if (site.enterable === true) {
    state.world.sites = state.world.sites || {};
    // Dedup guard: never overwrite a fully generated (non-stub) site record.
    // streamL1Cells already skips existing cells, but this defensive check prevents
    // any future call path from clobbering an entered site with a fresh stub.
    if (state.world.sites[site.interior_key] && !state.world.sites[site.interior_key].is_stub) {
      return;
    }
    state.world.sites[site.interior_key] = {
      id:             site.interior_key,
      name:           site.name ?? null,
      type:           site.identity || null,
      npcs:           [],
      is_stub:        true,
      is_community:   site.is_community ?? false,
      site_size:      site.site_size ?? 3,
      mx:             cell.mx,
      my:             cell.my,
      lx:             cell.lx,
      ly:             cell.ly,
      attributes:     {}  // ContinuityBrain: promoted facts for this location
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
function assignQuestGiverFlags(npcArray, worldSeed, siteId) {
  const rng = createSeededRNG(worldSeed + siteId);
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

// PHASE 3C: Site Quest Generation
function generateSiteQuests(state, siteId, siteData, npcArray) {
  if (!state.questSystem) {
    state.questSystem = new QuestSystem(state.rng_seed);
  }
  
  const questSeed = state.rng_seed + siteId + "quests";
  const constraints = {
    siteType: siteData.type,
    playerLevel: state.player.level || 1,
    availableNPCs: npcArray,
    currentThreats: siteData.threats || [],
    seed: questSeed
  };

  try {
    const quests = state.questSystem.generateSiteQuests(constraints);
    
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
      
      // Add site metadata
      quest.siteId = siteId;
      quest.siteName = siteData.name;
      quest.status = "available";
      quest.current_step = 0;
    });
    
    return quests.slice(0, state.quests.config.maxQuestsPerSite);
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
  
  // Quest existence check (search all site quests)
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

/**
 * Phase 1 entry resolver — deterministic three-pass matching (pure function).
 * Does not mutate state. Called both inline by the enter handler and externally
 * by the index.js orchestration layer before buildOutput.
 *
 * @param {Array}  candidates  — enterable site objects (with name, identity, site_id)
 * @param {string} targetName  — lowercased, article-stripped player phrase
 * @returns {{ result: 'resolved'|'ambiguous'|'no_match', site_id: string|null, ambiguous_ids: string[], pass: 'exact'|'substring'|'fuzzy'|null }}
 */
function resolveEntryPhase1(candidates, targetName) {
  if (!targetName) return { result: 'no_match', site_id: null, ambiguous_ids: [], pass: null };

  function _lev(a, b) {
    const m = a.length, n = b.length;
    const d = Array.from({ length: m + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
      d[i][j] = a[i-1] === b[j-1] ? d[i-1][j-1] : 1 + Math.min(d[i-1][j], d[i][j-1], d[i-1][j-1]);
    return d[m][n];
  }

  // Fields for exact/substring/fuzzy matching: name and identity only.
  const _allFields = s => [s.name, s.identity].filter(Boolean).map(v => v.toLowerCase());
  const _fuzzyFields = s => [s.name, s.identity].filter(Boolean).map(v => v.toLowerCase());

  // Pass 1 — exact match
  const exactMatches = candidates.filter(s => _allFields(s).some(f => f === targetName));
  if (exactMatches.length === 1) return { result: 'resolved', site_id: exactMatches[0].site_id, ambiguous_ids: [], pass: 'exact' };
  if (exactMatches.length > 1)   return { result: 'ambiguous', site_id: null, ambiguous_ids: exactMatches.map(s => s.site_id), pass: 'exact' };

  // Pass 2 — substring match
  const subMatches = candidates.filter(s => _allFields(s).some(f => f.includes(targetName)));
  if (subMatches.length === 1) return { result: 'resolved', site_id: subMatches[0].site_id, ambiguous_ids: [], pass: 'substring' };
  if (subMatches.length > 1)   return { result: 'ambiguous', site_id: null, ambiguous_ids: subMatches.map(s => s.site_id), pass: 'substring' };

  // Pass 3 — fuzzy match (levenshtein ≤ 2) on name and tier only
  const fuzzyMatches = candidates.filter(s =>
    _fuzzyFields(s).some(f => _lev(targetName, f) <= 2 || _lev(targetName, f.replace(/^(the|a|an)\s+/, '')) <= 2)
  );
  if (fuzzyMatches.length === 1) return { result: 'resolved', site_id: fuzzyMatches[0].site_id, ambiguous_ids: [], pass: 'fuzzy' };
  if (fuzzyMatches.length > 1)   return { result: 'ambiguous', site_id: null, ambiguous_ids: fuzzyMatches.map(s => s.site_id), pass: 'fuzzy' };

  // Pass 4 — identity match: case-insensitive substring against name and identity.
  const identityMatches = candidates.filter(s => {
    const fields = [s.name, s.identity].filter(Boolean).map(v => v.toLowerCase());
    return fields.some(f => f.includes(targetName) || targetName.includes(f));
  });
  if (identityMatches.length === 1) return { result: 'resolved', site_id: identityMatches[0].site_id, ambiguous_ids: [], pass: 'identity' };
  if (identityMatches.length > 1)   return { result: 'ambiguous', site_id: null, ambiguous_ids: identityMatches.map(s => s.site_id), pass: 'identity' };

  return { result: 'no_match', site_id: null, ambiguous_ids: [], pass: null };
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
  const oldCellKey = oldPosition ? `LOC:${oldPosition.mx},${oldPosition.my}:${oldPosition.lx},${oldPosition.ly}` : null;
  const oldCell = oldCellKey ? state.world.cells?.[oldCellKey] : null;
  const oldCellType = oldCell?.type || oldCell?.tags?.type || 'unknown';
  
  Actions.applyPlayerActions(state, actions, changes1, phaseFlags, logger);

  // Phase 7: Handle 'enter' action — site entry.
  // Lives in buildOutput (not ActionProcessor) to avoid circular dependency.
  if (actions.action === 'enter') {
    state.world._engineMessage = null; // clear any prior message

    // ── L2 entry: player is inside a site and standing on a local-space tile ──
    let _entryHandled = false;
    if (state.world.current_depth === 2 && state.world.active_site) {
      _entryHandled = true;
      const _siteGrid = state.world.active_site.grid;
      const _pp = state.player?.position;
      const _tile = (_siteGrid && _pp) ? _siteGrid[_pp.y]?.[_pp.x] : null;
      if (_tile?.type === 'local_space' && _tile?.local_space_id) {
        enterLocalSpace(state, _tile.local_space_id);
        console.log(`[ENGINE] [L2-ENTER] Routed enter → local space ${_tile.local_space_id}`);
      } else {
        state.world._engineMessage = 'There is nothing to enter here.';
        console.log('[ENGINE] [L2-ENTER] No local space on current tile');
      }
    }

    if (!_entryHandled) {
    const enterPos = state.world.position;
    const enterCellKey = `LOC:${enterPos.mx},${enterPos.my}:${enterPos.lx},${enterPos.ly}`;
    const enterCell = state.world.cells && state.world.cells[enterCellKey];
    const enterSites = enterCell ? Object.values(enterCell.sites || {}) : [];

    // Candidate pool: prefer non-bootstrap enterable sites; fall back to bootstrap only when
    // no real (non-is_starting_location) enterable sites exist in this cell.
    const _realCandidates = enterSites.filter(s => s.enterable === true && !s.is_starting_location);
    const candidates = _realCandidates.length > 0
      ? _realCandidates
      : enterSites.filter(s => s.enterable === true);

    // Strip leading articles from player input for cleaner matching.
    const targetName = (actions.target || '').toLowerCase().trim().replace(/^(the|a|an)\s+/, '');
    let targetSite = null;

    // Branch 1 — pre-resolved: index.js orchestration already pinned a site_id via Phase 1/2.
    if (actions.resolved_site_id) {
      const _pre = candidates.find(s => s.site_id === actions.resolved_site_id);
      if (_pre) {
        targetSite = _pre;
        console.log('[RESOLVER] Engine pre-resolved:', actions.resolved_site_id);
      }
      // Safety net: if id not found in current candidates, fall through to Phase 1 below.
    }

    // Branch 2 — pre-annotated ambiguity: resolver found multiple matches, prompt player.
    if (!targetSite && Array.isArray(actions.ambiguous_ids) && actions.ambiguous_ids.length > 0) {
      const names = actions.ambiguous_ids
        .map(id => candidates.find(s => s.site_id === id))
        .filter(Boolean)
        .map(s => `"${s.name || s.identity || '(site)'}"`)
        .join(', ');
      state.world._engineMessage = `Multiple sites match: ${names}. Which would you like to enter?`;
      console.log('[RESOLVER] Engine ambiguous:', actions.ambiguous_ids);
    }

    // Branch 3 — Phase 1 deterministic resolver (exact → substring → fuzzy).
    // Only runs when not already handled by pre-resolved/ambiguous branches.
    if (!targetSite && !state.world._engineMessage) {
      if (targetName) {
        const _p1 = resolveEntryPhase1(candidates, targetName);
        if (_p1.result === 'resolved') {
          targetSite = candidates.find(s => s.site_id === _p1.site_id);
          console.log(`[Phase10-ENTER] Phase1 ${_p1.pass} match: "${targetName}" → ${_p1.site_id}`);
        } else if (_p1.result === 'ambiguous') {
          const names = _p1.ambiguous_ids
            .map(id => candidates.find(s => s.site_id === id))
            .filter(Boolean)
            .map(s => `"${s.name || s.identity || '(site)'}"`)
            .join(', ');
          state.world._engineMessage = `Multiple sites here match "${targetName}": ${names}. Which would you like to enter?`;
          console.log(`[Phase10-ENTER] Phase1 ${_p1.pass} ambiguous (${_p1.ambiguous_ids.length}) for "${targetName}"`);
        } else {
          state.world._engineMessage = `No enterable site matching "${targetName}" found here.`;
          console.log(`[Phase10-ENTER] Phase1 no_match for "${targetName}"`);
        }
      } else {
        // No target — unambiguous only if exactly one enterable site exists.
        if (candidates.length === 1) {
          targetSite = candidates[0];
          console.log(`[Phase10-ENTER] No target: single candidate → ${targetSite.site_id}`);
        } else if (candidates.length > 1) {
          const names = candidates.map(s => `"${s.name || s.identity || '(site)'}"`).join(', ');
          state.world._engineMessage = `Multiple sites here: ${names}. Which would you like to enter?`;
          console.log(`[Phase10-ENTER] No target ambiguous (${candidates.length} candidates)`);
        } else {
          state.world._engineMessage = 'There is nothing to enter here.';
          console.log('[Phase10-ENTER] No target: no candidates');
        }
      }
    }

    if (targetSite) {
      enterSite(state, { cell_key: enterCellKey, site_id: targetSite.site_id, entry_dir: actions.dir || null }, logger);
    }
    } // end if (!_entryHandled)
  }

  // Phase 10: Handle 'exit' action — site exit.
  // Guard: ActionProcessor handles exit first via containment state; skip if already handled.
  if (actions.action === 'exit') {
    if (state.world._exitHandledByAP) {
      delete state.world._exitHandledByAP;
    } else {
      state.world._engineMessage = null;
      if (state.world.current_depth === 3) {
        exitLocalSpace(state);
      } else if (state.world.current_depth >= 2) {
        exitSite(state);
      } else {
        state.world._engineMessage = 'You are not inside anything.';
      }
    }
  }

  // Track location change
  const newPosition = state.world.position;
  const positionChanged = oldPosition && (oldPosition.mx !== newPosition.mx || oldPosition.my !== newPosition.my || oldPosition.lx !== newPosition.lx || oldPosition.ly !== newPosition.ly);

  // Auto-exit: if player moved away from the cell that contains the active site, reset depth.
  // Only applies at depth=2 (L1); at depth=3 the world position never changes (player is inside a local space).
  if (positionChanged && state.world.current_depth === 2 && state.world.active_site?._source_cell_key) {
    const _newCellKey = `LOC:${newPosition.mx},${newPosition.my}:${newPosition.lx},${newPosition.ly}`;
    if (_newCellKey !== state.world.active_site._source_cell_key) {
      exitSite(state);
      console.log('[ENGINE] Auto-exit: player moved away from active site cell');
    }
  }
  
  // L1 CELL STREAMING: Generate terrain cells around player
  streamL1Cells(state);
  
  // Log location change if position actually changed
  if (positionChanged && logger) {
    const newCellKey = `LOC:${newPosition.mx},${newPosition.my}:${newPosition.lx},${newPosition.ly}`;
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
      // Heal legacy non-geography cell types (e.g. old site-typed cells written by previous sessions)
      if (cell.type && !WorldGen.LAYER_TERRAIN_VOCAB.L0_GEOGRAPHY.includes(cell.type) && !cell.is_custom) {
        const _healBiome = cell.biome || state.world.macro_biome || 'rural';
        const _healPalette = BIOME_TERRAIN_TYPES[_healBiome] || BIOME_TERRAIN_TYPES['rural'];
        cell.type = _healPalette[0];
        cell.description = '';
        console.log(`[TERRAIN_HEAL] cell ${id}: type corrected to "${cell.type}"`);
        changes1.push({ op: 'set', path: `/world/cells/${id}/type`, value: cell.type });
      }
      // Clear shadow-named descriptions (pattern: "A <type> called <name>") so they regenerate clean
      if (cell.description && !cell.is_custom && /^A .+? called /i.test(cell.description)) {
        cell.description = '';
        changes1.push({ op: 'set', path: `/world/cells/${id}/description`, value: '' });
      }
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
 * Enter an L2 location (site or POI) from an L1 cell.
 * Phase 7: Site-driven entry — l2_id derived from site.site_id, not cell subtype.
 * Input: { cell_key, site_id } — caller resolves target site before calling.
 */
function enterSite(state, { cell_key, site_id, entry_dir = null }, logger) {
  if (!state || !state.world) return null;

  // Startup-only transient scratch: local_space_purpose/name for first local space anchoring.
  // Read and delete unconditionally here — guarantees no stale value persists between turns
  // or leaks to any call path outside the Turn-1 startup block. Safe to call on every entry.
  const _startLsPurpose = state.world._startLocalSpacePurpose || null;
  delete state.world._startLocalSpacePurpose;
  const _startLsName = state.world._startLocalSpaceName || null;
  delete state.world._startLocalSpaceName;
  // Resolve site from cell.sites
  const cell = state.world.cells && state.world.cells[cell_key];
  if (!cell) return null;
  const site = cell.sites && cell.sites[site_id];
  if (!site) return null;

  // Defensive: accept site.site_tier (Phase 10), site.identity (Phase 7), or generic fallback.
  const identity = site.site_tier || site.identity || 'generic_site';
  const sid = site.site_id || site.id || site_id;

  // Ensure interior_key is set — should already be set by recordSiteToCell, but assign lazily
  // for sites that were created before Phase 10 (old sessions).
  if (!site.interior_key) {
    site.interior_key = site.l2_id || `${sid}/l2`;
  }
  const interior_key = site.interior_key;

  // Phase 7 migration guard: if canonical interior_key is missing from world.sites, check legacy
  // key formats and re-key to canonical before use. Prevents duplicate generation for old sessions.
  state.world.sites = state.world.sites || {};
  if (!state.world.sites[interior_key]) {
    // Legacy format 1: Phase-6 recordSiteToCell keyed by site_id directly
    const legacyKey6 = sid;
    // Legacy format 2: old subtype-based key M{mx}x{my}/L1_{lx}_{ly}_{identity}
    const parts = cell_key.match(/^LOC:(\d+),(\d+):(\d+),(\d+)$/);
    const legacyKeySubtype = parts
      ? `M${parts[1]}x${parts[2]}/L1_${parts[3]}_${parts[4]}_${identity}`
      : null;

    const found = state.world.sites[interior_key]
      || state.world.sites[legacyKey6]
      || (legacyKeySubtype && state.world.sites[legacyKeySubtype])
      || null;

    if (found) {
      // Re-key to canonical format; remove old keys to avoid duplication
      state.world.sites[interior_key] = found;
      if (state.world.sites[legacyKey6] && legacyKey6 !== interior_key) delete state.world.sites[legacyKey6];
      if (legacyKeySubtype && state.world.sites[legacyKeySubtype]) delete state.world.sites[legacyKeySubtype];
      console.log(`[Phase10-MIGRATE] Re-keyed site to canonical interior_key=${interior_key}`);
    }
  }

  let siteRecord = state.world.sites[interior_key];
  let NPCs = null;
  try {
    NPCs = require('./NPCs');
  } catch (npcLoadErr) {
    console.warn(`[ENGINE] NPCs module failed to load: ${npcLoadErr.message} — site will load without NPCs`);
  }

  if (siteRecord && !siteRecord.is_stub) {
    // Reuse: full site already exists — no generation needed
    console.log(`[ENGINE] Reusing persistent site: ${siteRecord.name} with ${(siteRecord.npcs || []).length} NPCs`);
    site.entered = true;

  } else if (siteRecord && siteRecord.is_stub) {
    // Complete stub: generate NPCs and upgrade the existing stub object in-place.
    // world.sites[interior_key] is mutated directly so stored object == active object.
    console.log(`[ENGINE] Completing stub for interior_key=${interior_key}, site_size=${site.site_size ?? 3}`);

    const expectedNpcCount = WorldGen.getNPCCountFromSize(site.site_size ?? 3);
    if (logger) logger.npc_spawn_attempted(interior_key, expectedNpcCount);

    let npcs_here = [];
    if (NPCs) {
      try {
        npcs_here = WorldGen.generateL2NPCs(interior_key, site.site_size ?? 3, state.rng_seed, NPCs);
      } catch (npcGenErr) {
        console.warn(`[ENGINE] NPC generation failed for stub ${interior_key}: ${npcGenErr.message} — site loads empty`);
      }
    }

    if (logger) {
      if (npcs_here && npcs_here.length > 0) logger.npc_spawn_succeeded(interior_key, npcs_here.length);
      else logger.npc_spawn_failed(interior_key, 'no_npcs_generated');
    }

    assignQuestGiverFlags(npcs_here, state.rng_seed, interior_key);

    // Replace stub with a fully generated site object.
    // Identity chain: site_id → site.name → container → mirror → UI.
    // Priority: Phase-5E LLM name (written by site_updates on a prior turn) > generated fallback.
    // Spatial metadata (mx/my/lx/ly) preserved from stub since WorldGen doesn't set those.
    const _stubName = siteRecord.name || null;  // Phase-5E name if already written
    const _stubMx = siteRecord.mx, _stubMy = siteRecord.my;
    const _stubLx = siteRecord.lx, _stubLy = siteRecord.ly;
    siteRecord = WorldGen.generateL2Site(interior_key, site.site_size ?? 3, npcs_here, state.rng_seed, undefined, { local_space_purpose: _startLsPurpose || undefined, local_space_name: _startLsName || undefined });
    // Restore authoritative name: Phase-5E value takes precedence over generated fallback.
    if (_stubName) siteRecord.name = _stubName;
    siteRecord.mx = _stubMx; siteRecord.my = _stubMy;
    siteRecord.lx = _stubLx; siteRecord.ly = _stubLy;
    siteRecord.category = site.category || null;  // carry category from cell.sites for count filtering
    siteRecord.is_stub = false;  // v1.81.1: mark fully generated — generateL2Site() does not set this field
    state.world.sites[interior_key] = siteRecord;

    if (logger) {
      const pos = state.world.position || { mx: 0, my: 0 };
      logger.site_registered(interior_key, siteRecord.name, siteRecord.type, { mx: pos.mx, my: pos.my });
    }

    console.log(`[ENGINE] Completed stub (name=${siteRecord.name}, source=${_stubName ? 'phase5e' : 'none'}): ${npcs_here.length} NPCs`);

    if (!state.quests) state.quests = { active: [], completed: [], allQuestsSeeded: {}, config: { maxActiveQuests: 10, maxQuestsPerSite: 5 } };
    if (!state.quests.allQuestsSeeded) state.quests.allQuestsSeeded = {};
    if (!state.quests.allQuestsSeeded[interior_key]) {
      const quests = generateSiteQuests(state, interior_key, siteRecord, npcs_here);
      state.quests.allQuestsSeeded[interior_key] = quests;
      console.log(`[ENGINE] Generated ${quests.length} quests for ${siteRecord.name}`);
    }

    site.entered = true;

  } else {
    // Fresh: no site record — generate and store. Exactly one generateL2Site call.
    const expectedNpcCount = WorldGen.getNPCCountFromSize(site.site_size ?? 3);
    if (logger) logger.npc_spawn_attempted(interior_key, expectedNpcCount);

    let npcs_here = [];
    if (NPCs) {
      try {
        npcs_here = WorldGen.generateL2NPCs(interior_key, site.site_size ?? 3, state.rng_seed, NPCs);
      } catch (npcGenErr) {
        console.warn(`[ENGINE] NPC generation failed for fresh ${interior_key}: ${npcGenErr.message} — site loads empty`);
      }
    }

    if (logger) {
      if (npcs_here && npcs_here.length > 0) logger.npc_spawn_succeeded(interior_key, npcs_here.length);
      else logger.npc_spawn_failed(interior_key, 'no_npcs_generated');
    }

    assignQuestGiverFlags(npcs_here, state.rng_seed, interior_key);

    const _freshStubName = site.name || null;  // Phase-5E name captured before entry
    siteRecord = WorldGen.generateL2Site(interior_key, site.site_size ?? 3, npcs_here, state.rng_seed, undefined, { local_space_purpose: _startLsPurpose || undefined, local_space_name: _startLsName || undefined });
    if (_freshStubName) siteRecord.name = _freshStubName;
    siteRecord.category = site.category || null;  // carry category from cell.sites for count filtering
    siteRecord.is_stub = false;  // v1.81.1: mark fully generated — generateL2Site() does not set this field
    state.world.sites[interior_key] = siteRecord;

    const totalSites = Object.keys(state.world.sites).length;
    console.log(`[Phase10-STORE] Site stored: interior_key=${interior_key}, name=${siteRecord.name}, type=${siteRecord.type}, totalCount=${totalSites}`);

    if (logger) {
      const pos = state.world.position || { mx: 0, my: 0 };
      logger.site_registered(interior_key, siteRecord.name, siteRecord.type, { mx: pos.mx, my: pos.my });
    }

    console.log(`[ENGINE] Created new site: ${siteRecord.name} with ${npcs_here.length} NPCs`);

    if (!state.quests) state.quests = { active: [], completed: [], allQuestsSeeded: {}, config: { maxActiveQuests: 10, maxQuestsPerSite: 5 } };
    if (!state.quests.allQuestsSeeded) state.quests.allQuestsSeeded = {};
    if (!state.quests.allQuestsSeeded[interior_key]) {
      const quests = generateSiteQuests(state, interior_key, siteRecord, npcs_here);
      state.quests.allQuestsSeeded[interior_key] = quests;
      console.log(`[ENGINE] Generated ${quests.length} quests for ${siteRecord.name}`);
    }

    site.entered = true;
  }

  // Ensure attributes object present on all three paths (reuse / stub-complete / fresh).
  // ContinuityBrain writes promoted environmental_features here.
  if (!state.world.sites[interior_key].attributes) state.world.sites[interior_key].attributes = {};

  // Stored object IS the active object — no secondary generation, no split references.
  state.world.active_site = state.world.sites[interior_key];
  state.world.active_site._source_cell_key = cell_key;  // used by auto-exit guard
  state.world.active_local_space = null;
  state.world.current_depth = 2;
  if (!state.player) state.player = {};
  state.player.depth = 2;
  const _aw = state.world.active_site.width || 7;
  const _ah = state.world.active_site.height || 7;
  const _cx = Math.floor(_aw / 2);
  const _cy = Math.floor(_ah / 2);
  const _edgeMap = { north: { x: _cx, y: 0 }, south: { x: _cx, y: _ah - 1 }, east: { x: 0, y: _cy }, west: { x: _aw - 1, y: _cy } };
  const _entry = _edgeMap[entry_dir] || { x: _cx, y: _ah - 1 };
  state.player.position = { ...(state.world.position || {}), x: _entry.x, y: _entry.y };
  // Compute visible NPCs at entry position (derived runtime field — recomputed on move, not persisted)
  state.world.active_site._visible_npcs = Actions.computeVisibleNpcs(state.world.active_site, state.player.position);
  return state.world.active_site;
}

/**
 * Enter a local space from the currently active site.
 */
function enterLocalSpace(state, local_space_id_short) {
  if (!state || !state.world || !state.world.active_site) return null;
  const site = state.world.active_site;
  const bld = site.local_spaces && site.local_spaces[local_space_id_short];
  if (!bld) return null;
  // Generate once and cache on the site record — no drift on re-entry.
  if (!bld._generated_interior) {
    // site.id is canonical on interior records; site.site_id is the cell-slot field.
    // Use site.id with fallback to site.site_id for compatibility with old saves.
    const _lsSiteId = site.id || site.site_id;
    if (!site.id && site.site_id) {
      console.warn(`[ENGINE] enterLocalSpace: site.id missing, using site.site_id fallback for ${site.site_id}`);
    }
    const full_id = `${_lsSiteId}_${local_space_id_short}`;
    bld._generated_interior = WorldGen.generateLocalSpace(full_id, bld, site.site_size || 1);
    console.log(`[ENGINE] [L2-ENTER] Generated interior: ${full_id}`);
  }
  // Store the exact L1 tile position for restoration when the player exits.
  if (!state.player) state.player = {};
  state.world._ls_entry_pos = { x: state.player.position?.x ?? 0, y: state.player.position?.y ?? 0 };
  const interior = bld._generated_interior;
  state.world.active_local_space = interior;
  state.world.current_depth = 3;
  state.player.depth = 3;
  // Place player at south-center of the local space (bottom-center entry tile).
  const _lw = interior.width || 5;
  const _lh = interior.height || 5;
  state.player.position = { ...(state.world.position || {}), x: Math.floor(_lw / 2), y: _lh - 1 };
  // Compute visible NPCs at entry position (derived runtime field).
  interior._visible_npcs = Actions.computeVisibleNpcs(interior, state.player.position, site.npcs);
  // ContinuityBrain: promoted environmental_features for this local space.
  if (!interior.attributes) interior.attributes = {};
  console.log(`[ENGINE] [L2-ENTER] Entered ${interior.name || local_space_id_short} at (${state.player.position.x},${state.player.position.y})`);
  return interior;
}

/**
 * Exit a site back to the overworld.
 */
function exitSite(state) {
  if (!state || !state.world) return;
  state.world.active_site = null;
  state.world.current_depth = 1;
  if (!state.player) state.player = {};
  state.player.depth = 1;
  if (state.player.position) { state.player.position.x = null; state.player.position.y = null; }
}

/**
 * Exit a local space back to the site.
 */
function exitLocalSpace(state) {
  if (!state || !state.world) return;
  state.world.active_local_space = null;
  state.world.current_depth = 2;
  if (!state.player) state.player = {};
  state.player.depth = 2;
  // Restore the exact L1 tile the player entered from.
  if (state.world._ls_entry_pos) {
    state.player.position = { ...(state.world.position || {}), ...state.world._ls_entry_pos };
    delete state.world._ls_entry_pos;
  }
}

// PHASE 3C: Export quest functions for use in index.js
module.exports = { 
  buildOutput, 
  initState, 
  enterSite, 
  enterLocalSpace, 
  exitSite, 
  exitLocalSpace,
  resolveEntryPhase1,
  // Quest system exports
  validateQuestAcceptance,
  validateQuestCompletion,
  applyQuestReward,
  generateSiteQuests,
  // Phase 4
  recordSiteToCell,
};