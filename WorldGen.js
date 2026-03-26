// WorldGen.js — Phase 3C: Enhanced with NPC persistence, settlement metadata, and quest integration
const crypto = require('crypto');

// --- Constants / Defaults (must match Engine/ActionProcessor) ---
const WORLD_WRAP = false;
const DEFAULTS = {
  L0_SIZE: { w: 8, h: 8 },
  L1_SIZE: { w: 12, h: 12 },
  STREAM: { R: 2, P: 1 },
  DENSITY: { target_min: 7, target_max: 11,
    spacing: { outpost: 1, hamlet: 2, town: 3, city: 4, metropolis: 6 } },
  FOOTPRINT: { outpost: 1, hamlet: 1, town: 1, city: 3, metropolis: 7 },
  CAPS_PER_MACRO: { metropolis: 0, city: 1 }
};


const TERRAIN_TYPES = {
  geography: ["plains_grassland", "plains_wildflower", "forest_deciduous", "forest_coniferous", "forest_mixed", "meadow", "hills_rolling", "hills_rocky", "desert_sand", "desert_dunes", "desert_rocky", "scrubland", "badlands", "canyon", "mesa", "tundra", "snowfield", "ice_sheet", "permafrost", "alpine", "swamp", "marsh", "wetland", "bog", "beach_sand", "beach_pebble", "cliffs_coastal", "tidepools", "dunes_coastal", "mountain_slopes", "mountain_peak", "mountain_pass", "rocky_terrain", "scree", "river_crossing", "stream", "lake_shore", "waterfall", "spring", "street", "plaza", "alley", "park_urban", "district_commercial", "district_residential", "building_complex", "market_square", "garden_urban"],
  settlement: [
    "campsite", "outpost", "hamlet", "village", "town", "city", "metropolis",
    "fort", "stronghold", "port", "harbor", "trading_post", "mining_camp",
    "logging_camp", "monastery", "temple_complex", "ruins_settlement"
  ],
  poi: [
    "cave_natural", "cavern_crystal", "grotto", "sinkhole", "hot_spring",
    "geyser_field", "ancient_tree", "fairy_ring", "tar_pit", "quicksand",
    "mesa_flat", "rock_formation", "natural_arch", "ruins_temple", "ruins_tower",
    "ruins_castle", "burial_mound", "crypt", "tomb", "standing_stones",
    "stone_circle", "obelisk", "abandoned_mine", "abandoned_mill", "abandoned_bridge",
    "battlefield_old", "shipwreck", "monster_lair", "dragon_cave", "giant_nest",
    "bandit_camp", "cultist_shrine", "witch_hut", "necromancer_tower", "haunted_grove",
    "cursed_ground", "execution_site", "quarry_active", "quarry_abandoned",
    "mine_entrance", "ore_vein", "herb_garden_wild", "berry_grove", "mushroom_circle",
    "fishing_spot", "salt_flat", "clay_pit", "meteor_crater", "portal_remnant",
    "ley_line_nexus", "time_distortion", "crystallized_magic", "petrified_forest",
    "floating_rocks", "gravity_anomaly"
  ]
};

// Keyword matching for world descriptions (9 simple biomes)
const BIOME_KEYWORDS = {
  urban: ["city", "town", "urban", "street", "building", "taco bell", "store", "shop", "modern", "2025", "2024", "mall", "apartment"],
  rural: ["farm", "village", "countryside", "pastoral", "field", "barn", "cottage", "hamlet", "ranch"],
  forest: ["forest", "woods", "trees", "grove", "woodland", "timber"],
  desert: ["desert", "sand", "dunes", "dry", "arid", "scorching", "wasteland", "barren", "sahara"],
  tundra: ["snow", "ice", "arctic", "frozen", "tundra", "glacier", "winter", "cold"],
  jungle: ["jungle", "rainforest", "tropical", "humid", "vines", "exotic", "canopy"],
  coast: ["beach", "ocean", "coast", "port", "harbor", "shore", "sea", "waves", "surf"],
  mountain: ["mountain", "peak", "alpine", "cliff", "summit", "highland", "elevation"],
  wetland: ["swamp", "marsh", "bog", "wetland", "murky", "mire"]
};

// Terrain palettes for each biome
const BIOME_PALETTES = {
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

// =============================================================================
// PHASE 3C: SETTLEMENT NAME GENERATION
// =============================================================================

// Name component libraries for procedural generation
const NAME_PREFIXES = [
  "Silver", "Gold", "Iron", "Stone", "White", "Black", "Red", "Green", "Blue",
  "North", "South", "East", "West", "High", "Low", "New", "Old", "Fair",
  "Dark", "Bright", "Shadow", "Sun", "Moon", "Star", "Wind", "Storm", "River",
  "Forest", "Mountain", "Valley", "Hill", "Oak", "Pine", "Ash", "Willow"
];

const NAME_SUFFIXES = [
  "haven", "ford", "bridge", "port", "gate", "hold", "burg", "ton", "ville",
  "wood", "field", "brook", "creek", "dale", "glen", "vale", "mere", "point",
  "rest", "watch", "keep", "fall", "ridge", "peak", "shore", "coast", "bay"
];

/**
 * Generate deterministic settlement name from settlement ID and world seed
 * @param {string} settlementId - Unique settlement identifier
 * @param {string} worldSeed - World seed for consistency
 * @returns {string} Generated settlement name
 */
function generateSettlementName(settlementId, worldSeed) {
  const combinedSeed = `${worldSeed}|${settlementId}|name`;
  const hash = h32(combinedSeed);
  const rng = mulberry32(hash);
  
  const prefix = NAME_PREFIXES[Math.floor(rng() * NAME_PREFIXES.length)];
  const suffix = NAME_SUFFIXES[Math.floor(rng() * NAME_SUFFIXES.length)];
  
  return `${prefix}${suffix}`;
}

// =============================================================================
// PHASE 3C: NPC COUNT BY SETTLEMENT TYPE
// =============================================================================

/**
 * Get NPC count for settlement type
 * @param {string} settlementType - Type of settlement
 * @returns {number} Number of NPCs to generate
 */
function getNPCCountForSettlement(settlementType) {
  const counts = {
    outpost: 3,
    hamlet: 8,
    village: 15,
    town: 30,
    city: 60,
    metropolis: 120
  };
  return counts[settlementType] || 10;
}

// =============================================================================
// PHASE 3C: NPC TRAIT GENERATION
// =============================================================================

/**
 * Generate 1-2 random traits for an NPC using seeded RNG
 * @param {function} rng - Seeded RNG function
 * @param {Array<string>} traitCatalog - Trait catalog (passed from NPCs.js)
 * @returns {Array<string>} Array of traits
 */
function generateNPCTraits(rng, traitCatalog) {
  const traitCount = rng() < 0.5 ? 1 : 2;
  const traits = [];
  
  while (traits.length < traitCount) {
    const idx = Math.floor(rng() * traitCatalog.length);
    const trait = traitCatalog[idx];
    if (!traits.includes(trait)) {
      traits.push(trait);
    }
  }
  
  return traits;
}

// =============================================================================
// PHASE 3C: NPC INVENTORY GENERATION
// =============================================================================

/**
 * Generate profession-appropriate inventory for an NPC
 * @param {string} profession - NPC's job category
 * @param {function} rng - Seeded RNG function
 * @returns {Array<object>} Inventory items
 */
function generateNPCInventory(profession, rng) {
  // Profession-based inventory templates
  const inventoryTemplates = {
    merchant: [
      { name: "coin_purse", qty: 1 },
      { name: "trade_goods", qty: Math.floor(rng() * 3) + 1 }
    ],
    blacksmith: [
      { name: "hammer", qty: 1 },
      { name: "iron_ingot", qty: Math.floor(rng() * 5) + 1 }
    ],
    guard: [
      { name: "sword", qty: 1 },
      { name: "rations", qty: Math.floor(rng() * 3) + 1 }
    ],
    farmer: [
      { name: "hoe", qty: 1 },
      { name: "seeds", qty: Math.floor(rng() * 10) + 5 }
    ],
    healer: [
      { name: "bandages", qty: Math.floor(rng() * 5) + 2 },
      { name: "herbs", qty: Math.floor(rng() * 3) + 1 }
    ],
    thief: [
      { name: "lockpicks", qty: 1 },
      { name: "stolen_goods", qty: Math.floor(rng() * 2) }
    ]
  };
  
  // Default inventory for unmatched professions
  const defaultInventory = [
    { name: "personal_belongings", qty: 1 }
  ];
  
  return inventoryTemplates[profession] || defaultInventory;
}

// =============================================================================
// PHASE 3C: ENHANCED NPC GENERATION WITH PERSISTENCE
// =============================================================================

/**
 * Generate NPCs for a settlement with persistent IDs and quest-giver flags
 * @param {string} settlementId - Unique settlement identifier
 * @param {string} settlementType - Type of settlement
 * @param {string} worldSeed - World seed for determinism
 * @param {object} npcModule - NPCs.js module (for generateNPC, TRAITS_CATALOG)
 * @returns {Array<object>} Array of generated NPCs with metadata
 */
function generateL2NPCs(settlementId, settlementType, worldSeed, npcModule) {
  const npcCount = getNPCCountForSettlement(settlementType);
  const baseSeed = h32(`${worldSeed}|${settlementId}|npcs`);
  const rng = mulberry32(baseSeed);
  
  // Generate NPCs using NPCs.js
  const npcs = npcModule.generateNPCPool(settlementId, npcCount, baseSeed);
  
  // Calculate quest-giver probability
  const questGiverProbability = Math.min(0.30, Math.max(0.10, 150 / npcCount));
  
  // Enhance NPCs with persistent IDs, inventory, and quest-giver flags
  return npcs.map((npc, index) => {
    const persistentId = `npc_${settlementId}_${index}`;
    const isQuestGiver = rng() < questGiverProbability;
    const inventory = generateNPCInventory(npc.job_category, rng);
    
    return {
      ...npc,
      id: persistentId,
      is_quest_giver: isQuestGiver,
      inventory: inventory,
      settlement_id: settlementId
    };
  });
}


// --- RNG / Helpers (identical behavior) ---
function h32(key) {
  const hex = crypto.createHash('sha256').update(key, 'utf8').digest('hex');
  return (parseInt(hex.slice(0, 8), 16) >>> 0);
}
function mulberry32(a) {
  let t = a >>> 0;
  return function() {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ t >>> 15, 1 | t);
    r ^= r + Math.imul(r ^ r >>> 7, 61 | r);
    return ((r ^ r >>> 14) >>> 0) / 4294967296;
  };
}
function rnd01(seed, parts) {
  const k = [String(seed), ...parts.map(String)].join('|');
  return mulberry32(h32(k))();
}
function rndInt(seed, parts, min, max) {
  if (max < min) [min, max] = [max, min];
  const r = rnd01(seed, parts);
  const span = (max - min + 1);
  let out = min + Math.floor(r * span);
  if (out < min) out = min;
  if (out > max) out = max;
  return out;
}
function clamp(v, lo, hi){
  if (Number.isNaN(lo) || Number.isNaN(hi)) return v;
  if (lo > hi) { const tmp = lo; lo = hi; hi = tmp; }
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}
function wrap(v, lo, hi){
  if (lo > hi){ const t = lo; lo = hi; hi = t; }
  const range = (hi - lo + 1);
  let val = v;
  while(val < lo) val += range;
  while(val > hi) val -= range;
  return val;
}
function hashSeedFromLocationID(locationID) {
  return h32(String(locationID));
}

// --- LCG (must match Engine + ActionProcessor) ---
function makeLCG(seed0){
  let s = (seed0|0) & 0x7fffffff;
  return { nextInt: (max) => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const r = s / 0x7fffffff;
    return Math.floor(r*max);
  }};
}

// --- BIOME DETECTION (moved up) ---
function detectBiome(desc) {
  const lower = String(desc||"").toLowerCase();
  for (const [biome, kws] of Object.entries(BIOME_KEYWORDS)) {
    if (kws.some(kw => lower.includes(kw))) return biome;
  }
  return "rural";
}

// --- Settlement footprint + population data ---
const SETTLEMENT_SIZES = {
  outpost:    { tier: 0, footprint: 1, width: 3, height: 3, buildings: 2, population_min: 5, population_max: 15 },
  hamlet:     { tier: 1, footprint: 1, width: 5, height: 5, buildings: 4, population_min: 15, population_max: 50 },
  village:    { tier: 2, footprint: 1, width: 7, height: 7, buildings: 8, population_min: 50, population_max: 200 },
  town:       { tier: 3, footprint: 1, width: 9, height: 9, buildings: 12, population_min: 200, population_max: 1000 },
  city:       { tier: 4, footprint: 3, width: 11, height: 11, buildings: 20, population_min: 1000, population_max: 5000 },
  metropolis: { tier: 5, footprint: 7, width: 13, height: 13, buildings: 30, population_min: 5000, population_max: 20000 }
};

// --- L0: macro region logic (same) ---
function generateWorldFromDescription(desc, worldSeed) {
  const biome = detectBiome(desc);
  const palette = BIOME_PALETTES[biome] || BIOME_PALETTES["rural"];
  const l0s = DEFAULTS.L0_SIZE;
  const macroCells = {};
  for (let my = 0; my < l0s.h; my++) {
    for (let mx = 0; mx < l0s.w; mx++) {
      const k = `L0:${mx},${my}`;
      macroCells[k] = { desc: "", biome, palette };
    }
  }
  return {
    seed: worldSeed,
    biome,
    palette,
    l0_size: l0s,
    cells: macroCells,
    sites: {}
  };
}

// --- L1: site placement (same) ---
function worldGenStep(world) {
  if (!world || !world.cells) return world;
  const l0s = world.l0_size || DEFAULTS.L0_SIZE;
  const macroCells = world.cells || {};
  const sites = world.sites || {};

  const mx = Math.floor(Math.random() * l0s.w);
  const my = Math.floor(Math.random() * l0s.h);
  const macroKey = `L0:${mx},${my}`;
  const macro = macroCells[macroKey];
  if (!macro) return world;

  const seed = h32(world.seed + `|${mx},${my}`);
  const rng = makeLCG(seed);

  const targetMin = DEFAULTS.DENSITY.target_min;
  const targetMax = DEFAULTS.DENSITY.target_max;
  const targetCount = targetMin + rng.nextInt(targetMax - targetMin + 1);

  const existing = Object.keys(sites).filter(sid => {
    const site = sites[sid];
    return (site.mx === mx && site.my === my);
  }).length;
  if (existing >= targetCount) return world;

  const settTypes = ["outpost", "hamlet", "village", "town", "city"];
  const chosenType = settTypes[rng.nextInt(settTypes.length)];
  const fp = DEFAULTS.FOOTPRINT[chosenType] || 1;
  const siteId = `${macroKey}:site_${existing}`;
  const center_lx = 6, center_ly = 6;
  sites[siteId] = {
    id: siteId,
    site_type: "settlement",
    subtype: chosenType,
    mx, my,
    center_lx, center_ly,
    footprint: fp,
    biome: macro.biome
  };

  return { ...world, sites };
}

// --- exposeSitesInWindow (same) ---
function exposeSitesInWindow(state, worldData, posLx, posLy, posMx, posMy) {
  const sites = worldData?.sites || {};
  const R = DEFAULTS.STREAM.R;
  const P = DEFAULTS.STREAM.P;
  const totalRadius = R + P;
  const known = new Set();

  for (let dy = -totalRadius; dy <= totalRadius; dy++){
    for (let dx = -totalRadius; dx <= totalRadius; dx++){
      const dist = Math.abs(dx) + Math.abs(dy);
      if (dist > totalRadius) continue;
      const lx2 = posLx + dx;
      const ly2 = posLy + dy;
      const lx = clamp(lx2, 0, 11);
      const ly = clamp(ly2, 0, 11);
      known.add(`${posMx},${posMy}:${lx},${ly}`);
    }
  }

  const out = {};
  for (const sid of Object.keys(sites)){
    const site = sites[sid];
    const k = `${site.mx},${site.my}:${site.center_lx},${site.center_ly}`;
    if (known.has(k)) out[sid] = site;
  }
  return out;
}

// --- L1: feature description (same) ---
function generateL1FeatureDescription(site) {
  if (!site) return "An empty space";
  const st = site.subtype || "settlement";
  return `A ${st} called ${generateSettlementName(site.id, "default")}`;
}

// =============================================================================
// PHASE 3C: ENHANCED L2 SETTLEMENT GENERATION
// =============================================================================

/**
 * Generate L2 settlement with NPC persistence and metadata
 * @param {string} settlement_id - Settlement identifier
 * @param {string} settlement_type - Type of settlement
 * @param {Array<object>} npc_array - Pre-generated NPC array (optional, for backward compatibility)
 * @param {string} worldSeed - World seed for determinism
 * @param {object} npcModule - NPCs.js module
 * @returns {object} Settlement layout with persistent NPCs and metadata
 */
function generateL2Settlement(settlement_id, settlement_type, npc_array, worldSeed, npcModule) {
  const st = SETTLEMENT_SIZES[settlement_type] || SETTLEMENT_SIZES["village"];
  const seed = hashSeedFromLocationID(settlement_id);
  const rng = makeLCG(seed);
  const w = st.width, h = st.height;
  const grid = [];
  for (let y = 0; y < h; y++) {
    const row = [];
    for (let x = 0; x < w; x++) {
      row.push(null);
    }
    grid.push(row);
  }

  // streets: plus sign
  const midY = Math.floor(h / 2);
  const midX = Math.floor(w / 2);
  const streets = [];
  for (let x = 0; x < w; x++) {
    grid[midY][x] = { type: "street", npc_ids: [] };
    streets.push({ x, y: midY });
  }
  for (let y = 0; y < h; y++) {
    if (!grid[y][midX]) grid[y][midX] = { type: "street", npc_ids: [] };
    streets.push({ x: midX, y });
  }

  // buildings
  const buildings = {};
  const buildingCount = st.buildings;
  const buildingNamesByPurpose = {
    tavern: ["The Wanderer's Rest", "The Drunk Griffin", "The Ale House"],
    house: ["Homestead", "Cottage", "Dwelling", "Residence"],
    shop: ["General Store", "Trading Post", "Stall"],
    guildhall: ["Guild Hall", "Council House"],
    temple: ["Temple of Light", "Sacred Shrine"],
    palace: ["The Grand Palace", "Royal Keep"]
  };
  const possiblePurposes = ["house", "house", "shop", "tavern", "house", "temple", "guildhall"];
  for (let i = 0; i < buildingCount; i++) {
    let bx = 0, by = 0, tries = 0;
    do {
      bx = rng.nextInt(w);
      by = rng.nextInt(h);
      tries++;
      if (tries > 200) break;
    } while (grid[by][bx] && grid[by][bx].type === "street");
    const purpose = possiblePurposes[rng.nextInt(possiblePurposes.length)];
    const namePool = buildingNamesByPurpose[purpose] || ["Building"];
    const name = namePool[rng.nextInt(namePool.length)];
    const bld_id = `bld_${i}`;
    grid[by][bx] = { type: "building", building_id: bld_id, npc_ids: [] };
    buildings[bld_id] = {
      name,
      purpose,
      tier: st.tier,
      x: bx,
      y: by,
      width: 1,
      height: 1,
      npc_ids: []
    };
  }

  // PHASE 3C: Generate or use existing NPCs with persistence
  let npcs = [];
  if (Array.isArray(npc_array) && npc_array.length > 0) {
    // Use provided NPCs (backward compatibility)
    npcs = npc_array;
  } else if (npcModule) {
    // Generate new NPCs with persistence
    npcs = generateL2NPCs(settlement_id, settlement_type, worldSeed || "default", npcModule);
  }

  // distribute NPCs
  const streetSlots = streets.length || 1;
  const total = npcs.length;
  const streetTarget = Math.floor(total * 0.7);
  let streetAssigned = 0;
  
  // 70% to streets
  for (let i = 0; i < npcs.length && streetAssigned < streetTarget; i++) {
    const npc = npcs[i];
    const slot = streets[streetAssigned % streetSlots];
    const cell = grid[slot.y][slot.x];
    if (cell && cell.type === "street") {
      cell.npc_ids.push(npc.id || npc);
    }
    streetAssigned++;
  }
  
  // remaining to buildings round-robin
  const bldKeys = Object.keys(buildings);
  if (bldKeys.length > 0) {
    for (let i = streetAssigned; i < npcs.length; i++) {
      const npc = npcs[i];
      const bld = buildings[bldKeys[i % bldKeys.length]];
      bld.npc_ids.push(npc.id || npc);
    }
  }

  // PHASE 3C: Add settlement metadata
  const settlementName = generateSettlementName(settlement_id, worldSeed || "default");
  const populationCount = npcs.length;
  
  return {
    id: settlement_id,
    name: settlementName,
    type: settlement_type,
    population: populationCount,
    width: w,
    height: h,
    grid,
    buildings,
    npcs: npcs, // PHASE 3C: Store NPC array for persistence
    tier: st.tier,
    created_at: new Date().toISOString()
  };
}

// --- L2: POI generation (same) ---
function generateL2POI(poi_id, poi_type) {
  return {
    id: poi_id,
    poi_type,
    desc: `A mysterious ${poi_type}`,
    explored: false
  };
}

// --- L3: building interior (same) ---
function generateL3Building(building_id, buildingData) {
  const w = buildingData?.width || 5;
  const h = buildingData?.height || 5;
  const grid = [];
  for (let y = 0; y < h; y++) {
    const row = [];
    for (let x = 0; x < w; x++) {
      row.push({ type: "room_floor", objects: [] });
    }
    grid.push(row);
  }
  return {
    id: building_id,
    width: w,
    height: h,
    grid
  };
}

module.exports = { 
  generateWorldFromDescription,  
  worldGenStep, 
  exposeSitesInWindow, 
  generateL1FeatureDescription, 
  generateL2Settlement, 
  generateL2POI, 
  generateL3Building, 
  hashSeedFromLocationID, 
  makeLCG,
  // PHASE 3C: New exports
  generateSettlementName,
  getNPCCountForSettlement,
  generateNPCTraits,
  generateNPCInventory,
  generateL2NPCs
};
