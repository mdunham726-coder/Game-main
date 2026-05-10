// WorldGen.js — Phase 3C: Enhanced with NPC persistence, site metadata, and quest integration
const crypto = require('crypto');
const { createLogger } = require('./logger');

let axios = null;
try {
  axios = require('axios');
} catch (e) {
  // axios will be validated at call-time
}

// --- Constants / Defaults (must match Engine/ActionProcessor) ---
const WORLD_WRAP = false;
const DEFAULTS = {
  L0_SIZE: { w: 8, h: 8 },
  L1_SIZE: { w: 128, h: 128 },
  STREAM: { R: 2, P: 1 },
  CAPS_PER_MACRO: { metropolis: 0, city: 1 }
};


// Layer-scoped terrain vocabulary — authoritative boundary definition.
// L0_GEOGRAPHY: valid cell.type values for overworld terrain cells (the coordinate grid, not architectural depth).
// SITE_TRAVERSAL: valid traversal grid values inside a site (L1 layout, not cell.type).
// BUILDING_INTERIOR: reserved vocabulary for L2 room contents (not yet routed).
const LAYER_TERRAIN_VOCAB = {
  L0_GEOGRAPHY: [
    "plains_grassland", "plains_wildflower", "meadow",
    "forest_deciduous", "forest_coniferous", "forest_mixed",
    "hills_rolling", "hills_rocky",
    "desert_sand", "desert_dunes", "desert_rocky", "scrubland", "badlands", "canyon", "mesa",
    "tundra", "snowfield", "ice_sheet", "permafrost", "alpine",
    "swamp", "marsh", "wetland", "bog",
    "beach_sand", "beach_pebble", "cliffs_coastal", "tidepools", "dunes_coastal",
    "mountain_slopes", "mountain_peak", "mountain_pass", "rocky_terrain", "scree",
    "river_crossing", "river", "stream", "lake_shore", "waterfall", "spring"
  ],
  // These strings are valid inside a site's traversal grid — never as L0 cell.type
  SITE_TRAVERSAL: [
    "street", "plaza", "alley", "park_urban",
    "district_commercial", "district_residential", "building_complex",
    "market_square", "garden_urban"
  ],
  // Reserved for L2 building interiors — not yet used for routing
  BUILDING_INTERIOR: ["room", "corridor", "chamber", "stairwell"]
};

// Keyword matching for world descriptions (9 simple biomes)
const BIOME_KEYWORDS = {
  urban: ["city", "town", "urban", "street", "building", "taco bell", "store", "shop", "modern", "2025", "2024", "mall", "apartment", "paperboy", "newspaper", "19", "20", "downtown", "office", "industrial"],
  rural: ["farm", "village", "countryside", "pastoral", "field", "barn", "cottage", "hamlet", "ranch"],
  forest: ["forest", "woods", "trees", "grove", "woodland", "timber"],
  desert: ["desert", "sand", "dunes", "dry", "arid", "scorching", "wasteland", "barren", "sahara"],
  tundra: ["snow", "ice", "arctic", "frozen", "tundra", "glacier", "winter", "cold"],
  jungle: ["jungle", "rainforest", "tropical", "humid", "vines", "exotic", "canopy"],
  coast: ["beach", "ocean", "coast", "port", "harbor", "shore", "sea", "waves", "surf"],
  mountain: ["mountain", "peak", "alpine", "cliff", "summit", "highland", "elevation"],
  wetland: ["swamp", "marsh", "bog", "wetland", "murky", "mire"]
};

// Terrain palettes for each biome — L0 geography strings only (see LAYER_TERRAIN_VOCAB.L0_GEOGRAPHY)
const BIOME_PALETTES = {
  rural: ["plains_grassland", "plains_wildflower", "meadow", "forest_deciduous", "hills_rolling", "rocky_terrain"],
  forest: ["forest_deciduous", "forest_mixed", "forest_coniferous", "meadow", "meadow", "hills_rolling"],
  desert: ["desert_sand", "desert_dunes", "desert_rocky", "scrubland", "badlands", "canyon", "mesa"],
  tundra: ["tundra", "snowfield", "ice_sheet", "permafrost", "alpine"],
  jungle: ["forest_coniferous", "meadow", "swamp", "marsh", "forest_mixed", "meadow", "wetland"],
  coast: ["beach_sand", "beach_pebble", "cliffs_coastal", "tidepools", "dunes_coastal", "scrubland", "plains_grassland"],
  mountain: ["mountain_slopes", "mountain_peak", "mountain_pass", "rocky_terrain", "scree", "alpine", "hills_rocky"],
  wetland: ["swamp", "marsh", "wetland", "bog", "bog", "bog"]
};

// =============================================================================
// PASS 2 — BIOME SOFT-BIAS REGISTRY
// Terrain strings considered strongly consistent with each biome.
// Used by classifyTerrainFromNoise to decide whether to apply a soft bias
// re-roll when the noise-derived classification conflicts with biome identity.
// =============================================================================
const BIOME_CONSISTENT_TERRAIN = {
  rural:    ['plains_grassland', 'plains_wildflower', 'meadow', 'hills_rolling', 'forest_deciduous'],
  forest:   ['forest_deciduous', 'forest_mixed', 'forest_coniferous', 'meadow'],
  desert:   ['desert_sand', 'desert_dunes', 'desert_rocky', 'scrubland', 'badlands', 'canyon', 'mesa'],
  tundra:   ['tundra', 'snowfield', 'ice_sheet', 'permafrost', 'alpine'],
  jungle:   ['forest_coniferous', 'forest_mixed', 'swamp', 'marsh', 'wetland'],
  coast:    ['beach_sand', 'beach_pebble', 'cliffs_coastal', 'tidepools', 'dunes_coastal'],
  mountain: ['mountain_slopes', 'mountain_peak', 'mountain_pass', 'rocky_terrain', 'scree', 'alpine'],
  wetland:  ['swamp', 'marsh', 'wetland', 'bog'],
};

// =============================================================================
// PHASE 3C: NPC COUNT BY SITE TYPE
// =============================================================================

/**
 * Get NPC count for site size (1–10, engine-assigned).
 * @param {number} site_size - Engine-assigned size integer
 * @returns {number} Number of NPCs to generate
 */
function getNPCCountFromSize(site_size) {
  // Linear scale: size 1→2, size 5→12, size 10→60
  const counts = [0, 2, 4, 6, 8, 12, 16, 20, 30, 45, 60];
  return counts[Math.max(1, Math.min(10, site_size ?? 3))] ?? 10;
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
  // Null guard: job_category is null at NPC birth (filled later by [NPC-FILL])
  if (!profession) return [{ name: "personal_belongings", qty: 1 }];

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
 * Generate NPCs for a site with persistent IDs and quest-giver flags
 * @param {string} siteId - Unique site identifier
 * @param {number} site_size - Engine-assigned site size (1–10)
 * @param {string} worldSeed - World seed for determinism
 * @param {object} npcModule - NPCs.js module (for generateNPC, TRAITS_CATALOG)
 * @returns {Array<object>} Array of generated NPCs with metadata
 */
function generateL2NPCs(siteId, site_size, worldSeed, npcModule) {
  const npcCount = getNPCCountFromSize(site_size);
  const baseSeed = h32(`${worldSeed}|${siteId}|npcs`);
  const rng = mulberry32(baseSeed);
  
  // Generate NPCs using NPCs.js
  const npcs = npcModule.generateNPCPool(siteId, npcCount, baseSeed);
  
  // Calculate quest-giver probability
  const questGiverProbability = Math.min(0.30, Math.max(0.10, 150 / npcCount));
  
  // Enhance NPCs with persistent IDs, inventory, and quest-giver flags
  return npcs.map((npc, index) => {
    const persistentId = `npc_${siteId}_${index}`;
    const isQuestGiver = rng() < questGiverProbability;
    const inventory = generateNPCInventory(npc.job_category, rng);
    
    return {
      ...npc,
      id: persistentId,
      is_quest_giver: isQuestGiver,
      inventory: inventory,
      site_id: siteId
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

// --- BIOME DETECTION: Use DeepSeek for semantic understanding, fallback to keywords ---

/**
 * Call DeepSeek to classify the world biome from player's world prompt
 * Returns one of: urban, rural, forest, desert, tundra, jungle, coast, mountain, wetland
 */
async function detectBiomeWithDeepSeek(worldPrompt) {
  if (!process.env.DEEPSEEK_API_KEY || !axios) {
    // Silently fall back to keyword matching if API unavailable
    console.log('[WORLD] DeepSeek unavailable, using keyword fallback');
    return detectBiomeKeyword(worldPrompt);
  }

  try {
    const messages = [
      {
        role: "system",
        content: "You are a world-building assistant. Classify the world biome from a player's description. Respond with ONLY one biome name: rural, forest, desert, tundra, jungle, coast, mountain, or wetland. Urban/city settings should be classified as rural."
      },
      {
        role: "user",
        content: `Player wants: "${worldPrompt}"\n\nWhat biome should this world be? Respond with only the biome name.`
      }
    ];

    const resp = await axios.post(
      "https://api.deepseek.com/v1/chat/completions",
      {
        model: "deepseek-chat",
        messages,
        temperature: 0,
        max_tokens: 20
      },
      {
        headers: {
          "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 8000
      }
    );

    const biomeResponse = resp?.data?.choices?.[0]?.message?.content?.toLowerCase().trim();
    const validBiomes = ['rural', 'forest', 'desert', 'tundra', 'jungle', 'coast', 'mountain', 'wetland'];
    
    if (validBiomes.includes(biomeResponse)) {
      console.log(`[WORLD] DeepSeek detected biome: ${biomeResponse} from "${worldPrompt}"`);
      return biomeResponse;
    }

    // If DeepSeek returned "urban", remap to rural and note bias should carry the signal
    if (biomeResponse === 'urban') {
      console.log(`[WORLD] DeepSeek returned "urban" — remapped to rural (use world_bias for civilization density)`);
      return 'rural';
    }

    // If response is invalid, fall back to keyword matching
    console.log(`[WORLD] DeepSeek returned invalid biome "${biomeResponse}", using keyword fallback`);
    return detectBiomeKeyword(worldPrompt);
  } catch (err) {
    console.log(`[WORLD] DeepSeek call failed (${err?.message}), using keyword fallback`);
    return detectBiomeKeyword(worldPrompt);
  }
}

/**
 * Fallback: Quick keyword matching for biome detection (used when DeepSeek unavailable)
 */
function detectBiomeKeyword(desc) {
  const lower = String(desc||"").toLowerCase();
  for (const [biome, kws] of Object.entries(BIOME_KEYWORDS)) {
    if (kws.some(kw => lower.includes(kw))) {
      // Urban keywords are a civilization density signal, not a biome.
      // Return rural so the terrain palette stays geographic.
      // world_bias will carry the urban density signal via generateWorldFromDescription.
      if (biome === 'urban') return 'rural';
      return biome;
    }
  }
  return "rural";
}

/**
 * Detect world tone/setting from player's world prompt
 * Uses semantic understanding to infer mood, atmosphere, tech level, condition of world
 * @param {string} worldPrompt - Player's world description
 * @returns {Promise<string>} Descriptive tone/setting for narrative guidance
 */
async function detectWorldToneWithDeepSeek(worldPrompt) {
  if (!process.env.DEEPSEEK_API_KEY || !axios) {
    console.log('[WORLD] DeepSeek unavailable for tone detection');
    return "A functional, atmospheric world";
  }

  try {
    const messages = [
      {
        role: "system",
        content: "You are a creative writing assistant. Based on a player's world description, infer the mood, atmosphere, and setting tone. Respond with 1-2 sentences describing the world's character, technology level, condition (maintained/abandoned/thriving), and emotional tone."
      },
      {
        role: "user",
        content: `Player wants to play in: "${worldPrompt}"\n\nDescribe in 1-2 sentences the tone and character this world should have. Focus on: atmosphere, era/tech level, whether places are maintained or decaying, dominant emotions/mood.`
      }
    ];

    const resp = await axios.post(
      "https://api.deepseek.com/v1/chat/completions",
      {
        model: "deepseek-chat",
        messages,
        temperature: 0.5,  // Some variation to get natural tone descriptions
        max_tokens: 100
      },
      {
        headers: {
          "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 8000
      }
    );

    const toneResponse = resp?.data?.choices?.[0]?.message?.content?.trim();
    
    if (toneResponse && toneResponse.length > 0) {
      console.log(`[WORLD] Detected world tone: "${toneResponse}"`);
      return toneResponse;
    }

    return "A functional, atmospheric world";
  } catch (err) {
    console.log(`[WORLD] Tone detection failed (${err?.message}), using default`);
    return "A functional, atmospheric world";
  }
}

/**
 * Detect starting location type from player's world prompt
 * Uses semantic understanding to infer what kind of place the character should start in
 * @param {string} worldPrompt - Player's world description
 * @returns {Promise<string>} Site type (e.g. "village", "shop", "tavern", "temple")
 */
async function detectStartingLocationWithDeepSeek(worldPrompt) {
  if (!process.env.DEEPSEEK_API_KEY || !axios) {
    console.log('[LOCATION] DeepSeek unavailable for starting location detection');
    return "village";  // Default fallback
  }

  try {
    const messages = [
      {
        role: "system",
        content: "You are a game scenario interpreter. Given a player's world description or character role, determine what type of location they should START in. Respond with ONLY a single location type from this list: village, town, city, outpost, fort, castle, cave, ruins, forest, port, mine, farm, wilderness. No explanation, just the word."
      },
      {
        role: "user",
        content: `Player wants: "${worldPrompt}"

What location type should they START in? Choose one: village, town, city, outpost, fort, castle, cave, ruins, forest, port, mine, farm, wilderness`
      }
    ];

    const resp = await axios.post(
      "https://api.deepseek.com/v1/chat/completions",
      {
        model: "deepseek-chat",
        messages,
        temperature: 0,  // Deterministic for location choice
        max_tokens: 20
      },
      {
        headers: {
          "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 8000
      }
    );

    let locationType = resp?.data?.choices?.[0]?.message?.content?.trim().toLowerCase();
    
    // Sanitize to valid site-scale types only (no building-scale vocabulary)
    const validTypes = ["village", "town", "city", "outpost", "fort", "castle", "cave", "ruins", "forest", "port", "mine", "farm", "wilderness"];
    if (!validTypes.includes(locationType)) {
      console.log(`[LOCATION] Invalid type "${locationType}", mapping to nearest site type`);
      locationType = "village";
    }

    console.log(`[LOCATION] Detected starting location type: "${locationType}"`);
    return locationType;
  } catch (err) {
    console.log(`[LOCATION] Starting location detection failed (${err?.message}), using default`);
    return "village";
  }
}

/**
 * Detect start container context from the player's opening prompt.
 * Determines where the player begins: inside a room (L2), inside a place (L1), or open world (L0).
 * Also infers implied site scale (1–10) and local space purpose (L2 only).
 *
 * Returns { container, scale, local_space_purpose } — consumed during Turn-1 worldgen.
 * Result is NOT stored to world state; it is a local interpretation used to drive
 * site_size and generateL2Site options, then discarded.
 */
async function detectStartContextWithDeepSeek(desc) {
  const _descLower = String(desc || '').toLowerCase();

  // Keyword fallback — used when AI is unavailable or returns unparseable output.
  // These arrays are the fallback path only; AI result takes precedence when available.
  const L2_KEYWORDS = ['work at', 'working at', 'wake up in', 'inside the', 'inside a',
    'in the kitchen', 'in the shop', 'in the forge', 'in the tavern', 'in a cell',
    'imprisoned in', 'living in a', 'sleeping in a'];
  const L1_KEYWORDS = ['in the city', 'in town', 'in the market', 'in the square',
    'walk through', 'in the plaza', 'in the district', 'in the village', 'in new york'];
  const _fallbackContainer = L2_KEYWORDS.some(kw => _descLower.includes(kw)) ? 'L2'
    : L1_KEYWORDS.some(kw => _descLower.includes(kw)) ? 'L1' : 'L0';

  if (!process.env.DEEPSEEK_API_KEY || !axios) {
    console.log('[START-CTX] DeepSeek unavailable — using keyword fallback');
    return { container: _fallbackContainer, scale: null, local_space_purpose: null, local_space_name: null };
  }

  try {
    const messages = [
      {
        role: 'system',
        content: `You are a game world interpreter. Given a player's opening description, determine where they are starting.\nRespond with ONLY a valid JSON object with exactly these four fields:\n- "container": one of "L0", "L1", "L2". L0 = open world (forest, road, wilderness, travelling). L1 = inside a named place or site but not a specific room (village square, market, city street, camp perimeter, plaza). L2 = inside a specific room or enclosed space (forge interior, tavern common room, prison cell, shack interior, kitchen).\n- "scale": integer 1–10 representing size of the implied site. 1=tiny single room, 3=small inn or camp, 5=village, 7=town, 9=large city district, 10=major city. null if container is "L0".\n- "local_space_purpose": a short lowercase string describing the room type if L2 (e.g. "forge", "tavern", "house", "cell", "kitchen", "shop"). null if container is "L0" or "L1".\n- "local_space_name": the specific named location if explicitly stated in the player's prompt (e.g. "Taco Bell", "McDonald's", "Jungle Java"). Keep original casing. null if no specific named location is stated or if container is not "L2".\nRespond with JSON only. No explanation, no markdown fences.`
      },
      {
        role: 'user',
        content: `Player's opening description: "${desc}"`
      }
    ];

    const resp = await axios.post(
      'https://api.deepseek.com/v1/chat/completions',
      { model: 'deepseek-chat', messages, temperature: 0, max_tokens: 80 },
      {
        headers: {
          'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 8000
      }
    );

    const raw = resp?.data?.choices?.[0]?.message?.content?.trim() || '';
    // Strip markdown code fences if model includes them despite instructions
    const jsonStr = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    const parsed = JSON.parse(jsonStr);

    // Validate container
    let container = parsed.container;
    if (!['L0', 'L1', 'L2'].includes(container)) {
      console.log(`[START-CTX] Invalid container "${container}" — using keyword fallback`);
      container = _fallbackContainer;
    }

    // Validate and clamp scale; force null for L0
    let scale = null;
    if (container !== 'L0') {
      const rawScale = parsed.scale;
      if (typeof rawScale === 'number' && isFinite(rawScale)) {
        scale = Math.max(1, Math.min(10, Math.round(rawScale)));
      } else if (rawScale != null) {
        console.log(`[START-CTX] Invalid scale "${rawScale}" — defaulting to null`);
      }
    }

    // Validate local_space_purpose; only meaningful for L2; force null otherwise
    let local_space_purpose = null;
    if (container === 'L2') {
      const rawPurpose = parsed.local_space_purpose;
      if (typeof rawPurpose === 'string' && rawPurpose.trim().length > 0) {
        local_space_purpose = rawPurpose.trim().toLowerCase();
      }
    }

    // Validate local_space_name; only meaningful for L2; preserve original casing
    let local_space_name = null;
    if (container === 'L2') {
      const rawName = parsed.local_space_name;
      if (typeof rawName === 'string' && rawName.trim().length > 0) {
        local_space_name = rawName.trim();
      }
    }

    console.log(`[START-CTX] Detected: container=${container}, scale=${scale}, local_space_purpose=${local_space_purpose}, local_space_name=${local_space_name}`);
    return { container, scale, local_space_purpose, local_space_name };

  } catch (err) {
    console.log(`[START-CTX] Detection failed (${err?.message}) — using keyword fallback`);
    return { container: _fallbackContainer, scale: null, local_space_purpose: null, local_space_name: null };
  }
}

// --- Localspace interior size — independent per-localspace roll ---
// v1.85.46: each localspace descriptor receives its own independently rolled size.
// Uses the caller's seeded LCG rng — no Math.random().
// Integer breakpoints over rng.nextInt(10000) (yields 0–9999).
function rollGlobalLocalspaceSize(rng) {
  const roll = rng.nextInt(10000);
  if (roll < 2400) return 1;
  if (roll < 4400) return 2;
  if (roll < 6000) return 3;
  if (roll < 7200) return 4;
  if (roll < 8100) return 5;
  if (roll < 8800) return 6;
  if (roll < 9300) return 7;
  if (roll < 9650) return 8;
  if (roll < 9850) return 9;
  return 10;
}

// --- Site grid dimensions from engine-assigned size (1–10) ---
// v1.85.40: compressed grid ladder — reduces traversal footprint, fill pressure,
// context bloat, and startup latency while preserving meaningful scale progression.
// NPC count scaling is intentionally unchanged (see getNPCCountFromSize).
function siteGridFromSize(site_size) {
  const s = Math.max(1, Math.min(10, site_size ?? 3));
  if (s === 1)  return { width:  5, height:  5, local_space_count:  4 };
  if (s <= 4)   return { width:  7, height:  7, local_space_count:  6 };
  if (s <= 7)   return { width:  9, height:  9, local_space_count:  9 };
  if (s <= 9)   return { width: 11, height: 11, local_space_count: 12 };
  /* s === 10 */ return { width: 13, height: 13, local_space_count: 16 };
}

// ─── World Bias Extraction ────────────────────────────────────────────────────
// world_bias drives procedural generation (density, category weights, danger).
// world_context carries expressive fields for narration/naming (era).
// Both are frozen at world init and never re-derived.

const DEFAULT_WORLD_BIAS = {
  site_density:          'medium',
  landmark_density:      'medium',
  danger_level:          'medium',
  civilization_presence: 'medium',
  environment_tone:      'neutral'
};

const DEFAULT_WORLD_CONTEXT = {
  era: 'medieval'
};

const VALID_DENSITY_VALUES  = ['low', 'medium', 'high'];
const VALID_ENV_TONE_VALUES = ['harsh', 'neutral', 'benign'];
const VALID_ERA_VALUES      = ['ancient', 'medieval', 'early_modern', 'modern', 'future'];

/**
 * Validate a raw world_bias object against the schema.
 * Returns { validated, corrections[] }.
 */
function validateWorldBias(raw) {
  const corrections = [];
  const validated = {};

  const densityFields = ['site_density', 'landmark_density', 'danger_level', 'civilization_presence'];
  for (const field of densityFields) {
    const val = typeof raw?.[field] === 'string' ? raw[field].toLowerCase().trim() : null;
    if (VALID_DENSITY_VALUES.includes(val)) {
      validated[field] = val;
    } else {
      validated[field] = DEFAULT_WORLD_BIAS[field];
      corrections.push(`${field}: "${raw?.[field]}" → default "${DEFAULT_WORLD_BIAS[field]}"`);
    }
  }

  const envTone = typeof raw?.environment_tone === 'string' ? raw.environment_tone.toLowerCase().trim() : null;
  if (VALID_ENV_TONE_VALUES.includes(envTone)) {
    validated.environment_tone = envTone;
  } else {
    validated.environment_tone = DEFAULT_WORLD_BIAS.environment_tone;
    corrections.push(`environment_tone: "${raw?.environment_tone}" → default "${DEFAULT_WORLD_BIAS.environment_tone}"`);
  }

  return { validated, corrections };
}

/**
 * Validate an era string.
 * Returns { era, corrected, original }.
 */
function validateEra(raw) {
  const val = typeof raw === 'string' ? raw.toLowerCase().trim().replace(/\s+/g, '_') : null;
  if (VALID_ERA_VALUES.includes(val)) return { era: val, corrected: false };
  return { era: DEFAULT_WORLD_CONTEXT.era, corrected: true, original: raw };
}

/**
 * Extract structured world bias profile and context from a world prompt.
 * Uses a single DeepSeek call constrained to return JSON matching the schema.
 * Falls back to defaults on any failure — never blocks initialization.
 * @param {string} worldPrompt
 * @returns {Promise<{ world_bias: object, world_context: object }>}
 */
async function extractWorldBiasWithDeepSeek(worldPrompt) {
  if (!process.env.DEEPSEEK_API_KEY || !axios) {
    console.log('[WORLD_BIAS] DeepSeek unavailable — using defaults');
    return { world_bias: { ...DEFAULT_WORLD_BIAS }, world_context: { ...DEFAULT_WORLD_CONTEXT } };
  }

  try {
    const resp = await axios.post(
      'https://api.deepseek.com/v1/chat/completions',
      {
        model: 'deepseek-chat',
        messages: [
          {
            role: 'system',
            content: `You are a world-properties extractor for a game engine. Given a player's world description, output a JSON object with EXACTLY these fields and no others:
{
  "site_density": "low" | "medium" | "high",
  "landmark_density": "low" | "medium" | "high",
  "danger_level": "low" | "medium" | "high",
  "civilization_presence": "low" | "medium" | "high",
  "environment_tone": "harsh" | "neutral" | "benign",
  "era": "ancient" | "medieval" | "early_modern" | "modern" | "future"
}
Output ONLY valid JSON. No explanation, no markdown fences, no extra fields.`
          },
          {
            role: 'user',
            content: `Player world description: "${worldPrompt}"\n\nExtract the world properties. Output only the JSON object.`
          }
        ],
        temperature: 0,
        max_tokens: 150
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 8000
      }
    );

    const raw = resp?.data?.choices?.[0]?.message?.content?.trim();
    // Strip markdown code fences if the model wraps output in them
    const jsonStr = raw?.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (parseErr) {
      console.log(`[WORLD_BIAS] JSON parse failed ("${jsonStr?.slice(0, 80)}...") — using defaults`);
      return { world_bias: { ...DEFAULT_WORLD_BIAS }, world_context: { ...DEFAULT_WORLD_CONTEXT } };
    }

    const { validated: world_bias, corrections: biasCorrections } = validateWorldBias(parsed);
    const { era, corrected: eraFixed, original: eraOrig } = validateEra(parsed.era);

    if (biasCorrections.length > 0) {
      console.log(`[WORLD_BIAS] Field corrections applied: ${biasCorrections.join(' | ')}`);
    }
    if (eraFixed) {
      console.log(`[WORLD_BIAS] era: "${eraOrig}" → default "${era}"`);
    }

    console.log(`[WORLD_BIAS] Extracted: ${JSON.stringify(world_bias)} | era: ${era}`);
    return { world_bias, world_context: { era } };

  } catch (err) {
    console.log(`[WORLD_BIAS] Extraction failed (${err?.message}) — using defaults`);
    return { world_bias: { ...DEFAULT_WORLD_BIAS }, world_context: { ...DEFAULT_WORLD_CONTEXT } };
  }
}

// ─── Phase 2: Site Slot Generation ───────────────────────────────────────────
//
// evaluateCellForSites — pure, deterministic function. No side effects.
// Returns zero or more site slot records per cell, with no identity assigned.
// Engine owns: existence, count, enterable. DeepSeek owns: identity, name, description.
// ─────────────────────────────────────────────────────────────────────────────

// Site count distribution weights — pick one entry at random (uniform).
// [0,0,0,0,0,0] → 40 % chance of 0 sites; [1,1,1,1] → ~27 % of 1;
// [2,2] → ~13 % of 2;  3/4/5 each ~7 %.
const SITE_COUNT_WEIGHTS = [0,0,0,0,0,0,1,1,1,1,2,2,3,4,5];

function evaluateCellForSites(cellKey, terrainType, worldBias, worldSeed, options = {}) {
  // ── 1. Sample site count deterministically ───────────────────────────────
  const countRng = mulberry32(h32(`${worldSeed}|${cellKey}|count`));
  const count = SITE_COUNT_WEIGHTS[Math.floor(countRng() * SITE_COUNT_WEIGHTS.length)];
  if (count === 0) return [];

  // ── 2. Parse position from cellKey ───────────────────────────────────────
  const match = String(cellKey).match(/^LOC:(-?\d+),(-?\d+):(-?\d+),(-?\d+)$/);
  const mx = match ? parseInt(match[1], 10) : 0;
  const my = match ? parseInt(match[2], 10) : 0;
  const lx = match ? parseInt(match[3], 10) : 0;
  const ly = match ? parseInt(match[4], 10) : 0;

  // ── 3. Generate site slots ────────────────────────────────────────────────
  const sites = [];
  for (let i = 0; i < count; i++) {
    const site_id = `site_${h32(`${worldSeed}|${cellKey}|${i}`).toString(16).padStart(8, '0')}`;
    // Enterable weights: 1-site cell → 70 %; first slot of multi → 60 %; additional → 40 %
    const enterRoll = mulberry32(h32(`${worldSeed}|${cellKey}|${i}|enter`))();
    let enterable;
    if (count === 1)  enterable = enterRoll < 0.70;
    else if (i === 0) enterable = enterRoll < 0.60;
    else              enterable = enterRoll < 0.40;

    // Community signal — engine-owned, deterministic. Engine decides if a community
    // exists and how large it is. Model decides what kind of community it is.
    const civPresence = (worldBias?.civilization_presence) || 'medium';
    const commRoll = mulberry32(h32(`${worldSeed}|${cellKey}|${i}|community`))();
    const commProb = civPresence === 'high' ? 0.40 : civPresence === 'medium' ? 0.20 : 0.08;
    const is_community = enterable && (commRoll < commProb);
    // site_size: engine-assigned 1–3 for non-community, 2–10 for community (deterministic)
    let site_size;
    if (is_community) {
      const szMax = civPresence === 'high' ? 10 : civPresence === 'medium' ? 7 : 4;
      const szMin = civPresence === 'high' ? 3 : 2;
      const szRoll = mulberry32(h32(`${worldSeed}|${cellKey}|${i}|site_size`))();
      site_size = Math.max(szMin, Math.min(szMax, szMin + Math.floor(szRoll * (szMax - szMin + 1))));
    } else {
      const szRoll = mulberry32(h32(`${worldSeed}|${cellKey}|${i}|site_size`))();
      site_size = Math.max(1, Math.min(3, 1 + Math.floor(szRoll * 3)));
    }

    sites.push({
      site_id,
      parent_cell:   cellKey,
      l0_ref:        { mx, my, lx, ly },
      enterable,
      is_community,
      site_size,
      is_filled:     false,
      name:          null,
      description:   null,
      identity:      null,
      entered:       false,
      interior_key:  null,
    });
  }

  return sites;
}

// =============================================================================
// PHASE 3: TERRAIN-FIRST START & SEED-DERIVED ANCHOR
// =============================================================================

/**
 * Terrain scoring table: how well each terrain group suits a given
 * civilization_presence level as a starting position.
 * Higher score = more likely to be selected as start cell.
 */

// Maps terrain type keywords to a terrain group used by selectStartPosition scoring.
const TERRAIN_GROUP_MAP = {
  plains_grassland: 'open',  plains_wildflower: 'open',  meadow:          'open',
  hills_rolling:    'open',  hills_rocky:       'rugged', scrubland:       'open',
  forest_deciduous: 'forest', forest_coniferous: 'forest', forest_mixed:  'forest',
  desert_sand:      'arid',  desert_dunes:      'arid',   desert_rocky:   'arid',
  badlands:         'arid',  canyon:            'arid',   mesa:           'arid',
  mountain_slopes:  'rugged', mountain_peak:    'rugged', mountain_pass:  'rugged',
  rocky_terrain:    'rugged', scree:            'rugged', alpine:         'rugged',
  tundra:           'cold',  snowfield:         'cold',   ice_sheet:      'cold',
  permafrost:       'cold',
  swamp:            'wetland', marsh:            'wetland', wetland:       'wetland', bog: 'wetland',
  river_crossing:   'water',  river:            'water',  stream:        'water',  lake_shore:    'water',
  beach_sand:       'coast',  beach_pebble:     'coast',  cliffs_coastal: 'coast',
  tidepools:        'coast',  dunes_coastal:    'coast',
};

function terrainGroup(terrainType) {
  return TERRAIN_GROUP_MAP[terrainType] || 'wilderness';
}

const CIV_TERRAIN_SCORE = {
  open:       { high: 1.0, medium: 0.8, low: 0.5 },
  forest:     { high: 0.6, medium: 0.8, low: 0.9 },
  rugged:     { high: 0.4, medium: 0.6, low: 0.8 },
  arid:       { high: 0.3, medium: 0.5, low: 0.7 },
  cold:       { high: 0.1, medium: 0.3, low: 0.5 },
  wetland:    { high: 0.5, medium: 0.7, low: 0.8 },
  water:      { high: 0.1, medium: 0.1, low: 0.2 },
  coast:      { high: 0.7, medium: 0.7, low: 0.6 },
  wilderness: { high: 0.3, medium: 0.5, low: 0.9 },
};

// =============================================================================
// PASS 1 — fBm NOISE FIELDS
// Three deterministic continuous fields: elevation, moisture, temperature.
// All use the same 4-octave fBm pattern — independent RNG instances per octave.
// Biome bias nudges the raw sum before clamping to preserve biome identity.
// These fields are ADDITIVE — terrain classification is NOT changed in Pass 1.
// =============================================================================

// Bias applied to the raw fBm sum (before clamp) per biome per field.
// Zero means no bias for that biome/field combination.
const BIOME_NOISE_BIAS = {
  mountain: { elevation: +0.35, moisture: -0.15, temperature: -0.20 },
  desert:   { elevation: -0.10, moisture: -0.40, temperature: +0.40 },
  wetland:  { elevation: -0.20, moisture: +0.40, temperature:  0    },
  tundra:   { elevation: +0.10, moisture: -0.10, temperature: -0.50 },
  coast:    { elevation: -0.15, moisture: +0.20, temperature: +0.10 },
  jungle:   { elevation: -0.10, moisture: +0.35, temperature: +0.30 },
  forest:   { elevation:  0,    moisture: +0.15, temperature:  0    },
  rural:    { elevation:  0,    moisture:  0,    temperature:  0    },
};

/**
 * 4-octave fBm noise for a single field, deterministic via h32 + mulberry32.
 *
 * Each octave samples one RNG value from an independently seeded mulberry32.
 * Hash key encodes: fieldName, worldSeed, octave index, scaled grid coords,
 * and macro cell coords — ensuring independence across fields, seeds, and cells.
 *
 * @param {string} fieldName  — "elevation" | "moisture" | "temperature"
 * @param {number} mx         — macro x (0–7)
 * @param {number} my         — macro y (0–7)
 * @param {number} lx         — local x (0–127)
 * @param {number} ly         — local y (0–127)
 * @param {number|string} worldSeed
 * @param {string} biome      — key into BIOME_NOISE_BIAS
 * @returns {number} float clamped to [0, 1]
 */
function _evalNoiseField(fieldName, mx, my, lx, ly, worldSeed, biome) {
  // Octave frequencies (doubling) and amplitudes (halving); sum of amplitudes = ~1.0
  const OCTAVES = [
    { freq: 1,  amp: 0.5    },
    { freq: 2,  amp: 0.25   },
    { freq: 4,  amp: 0.125  },
    { freq: 8,  amp: 0.0625 },
  ];

  let sum = 0;
  for (const { freq, amp } of OCTAVES) {
    // Grid coordinates scaled to current octave frequency.
    // Math.round keeps coords integer so hash is deterministic at all scales.
    const gx = Math.round(lx * freq);
    const gy = Math.round(ly * freq);
    const key = `${fieldName}|${worldSeed}|f${freq}|${gx},${gy}|${mx},${my}`;
    // Independent RNG per octave — first call only, closed over state
    sum += mulberry32(h32(key))() * amp;
  }

  // Apply biome bias and clamp to [0, 1]
  const bias = (BIOME_NOISE_BIAS[biome] || {})[fieldName] || 0;
  return Math.max(0, Math.min(1, sum + bias));
}

/**
 * Elevation field — higher values mean higher terrain.
 * @returns {number} float [0, 1]
 */
function evalElevation(mx, my, lx, ly, worldSeed, biome) {
  return _evalNoiseField('elevation', mx, my, lx, ly, worldSeed, biome || 'rural');
}

/**
 * Moisture field — higher values mean wetter terrain.
 * @returns {number} float [0, 1]
 */
function evalMoisture(mx, my, lx, ly, worldSeed, biome) {
  return _evalNoiseField('moisture', mx, my, lx, ly, worldSeed, biome || 'rural');
}

/**
 * Temperature field — higher values mean warmer terrain.
 * @returns {number} float [0, 1]
 */
function evalTemperature(mx, my, lx, ly, worldSeed, biome) {
  return _evalNoiseField('temperature', mx, my, lx, ly, worldSeed, biome || 'rural');
}

// =============================================================================
// END PASS 1
// =============================================================================

// =============================================================================
// PASS 2 — TERRAIN CLASSIFICATION FROM NOISE
// Replaces random palette sampling. Terrain type is now derived from the
// Pass 1 noise fields (elevation, moisture, temperature) via 10-priority
// ordered rules, then corrected with a soft biome bias re-roll.
// Fully deterministic — no Math.random().
// =============================================================================

/**
 * Classify a cell's terrain type from its Pass 1 noise fields.
 *
 * Priority order (first matching rule wins):
 *  1. elevation > 0.80 → high mountain terrain
 *  2. elevation > 0.65 → rocky high-ground / mountain access
 *  3. elevation > 0.50 → rolling/rocky hills
 *  4. moisture > 0.75 && elevation < 0.30 → wetland / bog terrain
 *  5. moisture > 0.55 && temperature > 0.55 → forest / jungle
 *  6. moisture > 0.55 && temperature < 0.30 → tundra / frozen terrain
 *  7. temperature > 0.75 && moisture < 0.20 → hot desert
 *  8. temperature > 0.60 && moisture < 0.35 → scrubland / badlands
 *  9. elevation < 0.15 && moisture > 0.30 → shore / coastal low terrain
 * 10. default → plains
 *
 * Pool selection and biome soft bias both use seeded mulberry32 RNGs so the
 * result is deterministic for a given (cellKey, worldSeed) pair.
 *
 * @param {number} elevation  — float [0,1] from evalElevation
 * @param {number} moisture   — float [0,1] from evalMoisture
 * @param {number} temperature — float [0,1] from evalTemperature
 * @param {string} biome      — biome key (e.g. 'mountain', 'forest')
 * @param {string} cellKey    — canonical cell key e.g. "LOC:2,3:45,67"
 * @param {number|string} worldSeed — phase3_seed or promptSeed
 * @returns {string} valid L0_GEOGRAPHY terrain string
 */
function classifyTerrainFromNoise(elevation, moisture, temperature, biome, cellKey, worldSeed) {
  // --- Priority-ordered terrain pool selection ---
  let pool;
  if (elevation > 0.80) {
    pool = ['mountain_peak', 'mountain_slopes', 'mountain_pass', 'scree'];
  } else if (elevation > 0.65) {
    pool = ['hills_rocky', 'mountain_pass', 'scree', 'rocky_terrain'];
  } else if (elevation > 0.50) {
    pool = ['hills_rolling', 'hills_rocky', 'rocky_terrain'];
  } else if (moisture > 0.75 && elevation < 0.30) {
    pool = ['swamp', 'marsh', 'bog', 'wetland'];
  } else if (moisture > 0.55 && temperature > 0.55) {
    pool = ['forest_deciduous', 'forest_mixed', 'forest_coniferous'];
  } else if (moisture > 0.55 && temperature < 0.30) {
    pool = ['tundra', 'snowfield', 'permafrost', 'ice_sheet'];
  } else if (temperature > 0.75 && moisture < 0.20) {
    pool = ['desert_dunes', 'desert_sand', 'desert_rocky'];
  } else if (temperature > 0.60 && moisture < 0.35) {
    pool = ['scrubland', 'badlands', 'mesa'];
  } else if (elevation < 0.15 && moisture > 0.30) {
    pool = ['lake_shore', 'beach_sand', 'tidepools'];
  } else {
    pool = ['plains_grassland', 'plains_wildflower', 'meadow'];
  }

  // --- Deterministic pool roll ---
  const rollRng = mulberry32(h32(`${worldSeed}|p2_roll|${cellKey}`));
  let result = pool[Math.floor(rollRng() * pool.length)];

  // --- Biome soft bias re-roll ---
  // If the noise-derived result conflicts with the macro biome, apply a 60%
  // chance to substitute with a biome-palette string instead.
  const consistent = BIOME_CONSISTENT_TERRAIN[biome] || [];
  if (!consistent.includes(result)) {
    const biasRng = mulberry32(h32(`${worldSeed}|p2_bias|${cellKey}`));
    if (biasRng() < 0.80) {
      const palette = BIOME_PALETTES[biome] || BIOME_PALETTES['rural'];
      result = palette[Math.floor(biasRng() * palette.length)];
    }
  }

  return result;
}

// =============================================================================
// END PASS 2
// =============================================================================

/**
 * Derive a deterministic L0 + L1 anchor position from the world prompt hash.
 *
 * L0 range : mx 0–7, my 0–7   (DEFAULTS.L0_SIZE)
 * L1 range : lx 2–9, ly 2–9   (inner zone — leaves edge margin for patch clamping)
 *
 * @param {number} promptSeed — h32(inputObj.WORLD_PROMPT), a u32
 * @returns {{ mx, my, lx, ly }}
 */
function selectStartAnchor(promptSeed) {
  const rng = mulberry32(promptSeed);
  const l0w = DEFAULTS.L0_SIZE.w;   // 8
  const l0h = DEFAULTS.L0_SIZE.h;   // 8
  const innerMin = 2;
  const innerRange = DEFAULTS.L1_SIZE.w - 4;  // 2-cell margin on each side; scales with L1 grid
  const mx = Math.floor(rng() * l0w);
  const my = Math.floor(rng() * l0h);
  const lx = innerMin + Math.floor(rng() * innerRange);
  const ly = innerMin + Math.floor(rng() * innerRange);
  return { mx, my, lx, ly };
}

/**
 * Pre-generate a deterministic 7×7 terrain patch centred on anchor.
 *
 * - Clamps to L1 bounds 0–127; cells outside bounds are silently skipped.
 * - Skips cells already present in existingCells.
 * - Uses seeded RNG per cell — NOT Math.random().
 * - Cell structure is identical to cells produced by Engine.js streamL1Cells.
 *
 * @param {{ mx, my, lx, ly }} anchor
 * @param {string} biome
 * @param {number} promptSeed — h32(inputObj.WORLD_PROMPT)
 * @param {object} existingCells — current gameState.world.cells (read-only)
 * @returns {object} { [cellKey]: cellObj }
 */
function generateTerrainPatch(anchor, biome, promptSeed, existingCells) {
  const l1w = DEFAULTS.L1_SIZE.w;   // 128
  const l1h = DEFAULTS.L1_SIZE.h;   // 128
  const palette = BIOME_PALETTES[biome] || BIOME_PALETTES['rural'];
  const patch = {};

  for (let dx = -3; dx <= 3; dx++) {
    for (let dy = -3; dy <= 3; dy++) {
      const lx = anchor.lx + dx;
      const ly = anchor.ly + dy;

      // Clamp to L1 bounds — no cross-macro wrapping in bootstrap patch
      if (lx < 0 || lx >= l1w || ly < 0 || ly >= l1h) continue;

      const cellKey = `LOC:${anchor.mx},${anchor.my}:${lx},${ly}`;

      // Skip cells that already exist (e.g. MAC macro cells)
      if (existingCells && existingCells[cellKey]) continue;

      // Pass 1: compute physical noise fields
      const _elev = evalElevation(anchor.mx, anchor.my, lx, ly, promptSeed, biome);
      const _mois = evalMoisture(anchor.mx, anchor.my, lx, ly, promptSeed, biome);
      const _temp = evalTemperature(anchor.mx, anchor.my, lx, ly, promptSeed, biome);

      // Pass 2: classify terrain deterministically from noise fields
      const terrainType = classifyTerrainFromNoise(_elev, _mois, _temp, biome, cellKey, promptSeed);

      patch[cellKey] = {
        type:        terrainType,
        subtype:     '',
        biome:       biome,
        mx:          anchor.mx,
        my:          anchor.my,
        lx:          lx,
        ly:          ly,
        description: '',
        elevation:   _elev,
        moisture:    _mois,
        temperature: _temp,
      };
    }
  }

  return patch;
}

// =============================================================================
// ELEVATION STRUCTURE — biome-specific Gaussian massifs + basins
// =============================================================================

const BIOME_ELEV_CONFIG = {
  mountain: { massifRange: [4, 6], baseElev: 0.45, radiusRange: [20, 38], peakRange: [0.65, 0.90], basinRange: [1, 2] },
  tundra:   { massifRange: [2, 4], baseElev: 0.38, radiusRange: [18, 32], peakRange: [0.55, 0.85], basinRange: [1, 2] },
  forest:   { massifRange: [1, 3], baseElev: 0.33, radiusRange: [15, 28], peakRange: [0.50, 0.80], basinRange: [1, 3] },
  rural:    { massifRange: [1, 2], baseElev: 0.30, radiusRange: [14, 24], peakRange: [0.45, 0.75], basinRange: [2, 3] },
  jungle:   { massifRange: [0, 2], baseElev: 0.28, radiusRange: [12, 22], peakRange: [0.50, 0.80], basinRange: [2, 4] },
  desert:   { massifRange: [1, 1], baseElev: 0.25, radiusRange: [12, 20], peakRange: [0.55, 0.85], basinRange: [0, 1] },
  coast:    { massifRange: [0, 0], baseElev: 0.22, radiusRange: [0,   0], peakRange: [0,    0   ], basinRange: [2, 4] },
  wetland:  { massifRange: [0, 0], baseElev: 0.18, radiusRange: [0,   0], peakRange: [0,    0   ], basinRange: [3, 5] },
};

// Configurable blend weights — higher = more structured, lower = more noise
const STRUCTURE_BLEND = { elevation: 0.70, moisture: 0.70, temperature: 0.70 };

// Biome moisture zone configuration (wet zones add, dry zones subtract)
const BIOME_MOISTURE_CONFIG = {
  wetland:  { baseVal: 0.55, wetZoneRange: [2, 4], dryZoneRange: [0, 0], wetRadii: [20, 40], dryRadii: [],       wetStrength: [0.12, 0.22], dryStrength: [] },
  jungle:   { baseVal: 0.60, wetZoneRange: [2, 3], dryZoneRange: [0, 1], wetRadii: [18, 35], dryRadii: [10, 18], wetStrength: [0.10, 0.18], dryStrength: [0.05, 0.10] },
  forest:   { baseVal: 0.55, wetZoneRange: [1, 3], dryZoneRange: [1, 2], wetRadii: [16, 30], dryRadii: [12, 22], wetStrength: [0.12, 0.20], dryStrength: [0.08, 0.14] },
  coast:    { baseVal: 0.52, wetZoneRange: [1, 2], dryZoneRange: [0, 1], wetRadii: [15, 28], dryRadii: [10, 20], wetStrength: [0.10, 0.18], dryStrength: [0.06, 0.10] },
  rural:    { baseVal: 0.45, wetZoneRange: [1, 2], dryZoneRange: [1, 2], wetRadii: [15, 28], dryRadii: [12, 24], wetStrength: [0.14, 0.22], dryStrength: [0.10, 0.16] },
  mountain: { baseVal: 0.35, wetZoneRange: [0, 2], dryZoneRange: [1, 2], wetRadii: [14, 26], dryRadii: [12, 22], wetStrength: [0.10, 0.16], dryStrength: [0.08, 0.14] },
  tundra:   { baseVal: 0.28, wetZoneRange: [0, 1], dryZoneRange: [1, 2], wetRadii: [14, 24], dryRadii: [12, 20], wetStrength: [0.08, 0.14], dryStrength: [0.06, 0.12] },
  desert:   { baseVal: 0.12, wetZoneRange: [0, 1], dryZoneRange: [1, 2], wetRadii: [12, 22], dryRadii: [12, 24], wetStrength: [0.05, 0.10], dryStrength: [0.06, 0.12] },
};

// Base temperature per biome (before elevation cooling)
const BIOME_BASE_TEMP = {
  desert: 0.85, jungle: 0.75, coast: 0.60, wetland: 0.55,
  rural: 0.55, forest: 0.50, mountain: 0.45, tundra: 0.20,
};

/**
 * Build a structured elevation field for a 128×128 L1 macro cell.
 * Places biome-specific Gaussian massifs and basins to produce coherent
 * highland/lowland regions. Adds a small noise perturbation to break
 * circular symmetry (naturalization pass).
 *
 * @param {number}        mx             — macro x (0–7)
 * @param {number}        my             — macro y (0–7)
 * @param {string}        biome          — biome key
 * @param {number}        worldSeed      — h32 seed
 * @param {Function|null} reportProgress — optional callback(step, pct, detail)
 * @returns {{ elevMap: Float32Array, massifCount: number, basinCount: number }}
 */
function generateElevationStructure(mx, my, biome, worldSeed, reportProgress = null, hydroStrength = 0) {
  const l1w = DEFAULTS.L1_SIZE.w;  // 128
  const l1h = DEFAULTS.L1_SIZE.h;  // 128
  // Start with a mutable copy so hydroStrength overrides don't affect the shared config.
  const cfg  = Object.assign({}, BIOME_ELEV_CONFIG[biome] || BIOME_ELEV_CONFIG.rural);
  if (hydroStrength > 0) {
    // More massifs → more high terrain → more source candidates
    cfg.massifRange = [cfg.massifRange[0], cfg.massifRange[1] + hydroStrength];
    // Raise the minimum peak floor to clear the source-candidate threshold (0.65)
    const PEAK_FLOORS = { 1: 0.70, 2: 0.75 };
    const peakFloor = PEAK_FLOORS[hydroStrength] ?? 0.70;
    cfg.peakRange = [
      Math.max(cfg.peakRange[0], peakFloor),
      Math.min(cfg.peakRange[1] + 0.05 * hydroStrength, 0.95)
    ];
  }

  // Determine feature counts (deterministic per macro cell)
  const mRng = mulberry32(h32(`${worldSeed}|m_count|${mx},${my}`));
  const [mMin, mMax] = cfg.massifRange;
  const massifCount  = mMin + Math.floor(mRng() * (mMax - mMin + 1));

  const bRng = mulberry32(h32(`${worldSeed}|b_count|${mx},${my}`));
  const [bMin, bMax] = cfg.basinRange;
  const basinCount   = bMin + Math.floor(bRng() * (bMax - bMin + 1));

  // Build feature parameter arrays
  const massifs = [];
  for (let i = 0; i < massifCount; i++) {
    const rng    = mulberry32(h32(`${worldSeed}|massif|${i}|${mx},${my}`));
    const cx     = Math.floor(rng() * l1w);
    const cy     = Math.floor(rng() * l1h);
    const [rMin2, rMax2] = cfg.radiusRange;
    const radius = rMin2 + rng() * (rMax2 - rMin2);
    const [pMin, pMax]   = cfg.peakRange;
    const peak   = pMin  + rng() * (pMax  - pMin);
    massifs.push({ cx, cy, radius, peak });
  }

  const basins = [];
  for (let j = 0; j < basinCount; j++) {
    const rng    = mulberry32(h32(`${worldSeed}|basin|${j}|${mx},${my}`));
    const cx     = Math.floor(rng() * l1w);
    const cy     = Math.floor(rng() * l1h);
    const radius = 14 + rng() * 16;   // [14, 30]
    const depth  = 0.15 + rng() * 0.15; // [0.15, 0.30]
    basins.push({ cx, cy, radius, depth });
  }

  // Build elevMap — ly outer, lx inner (index = ly*128 + lx)
  const elevMap  = new Float32Array(l1w * l1h);
  const total    = l1w * l1h;
  let   cellIdx  = 0;

  for (let ly = 0; ly < l1h; ly++) {
    for (let lx = 0; lx < l1w; lx++) {
      let v = cfg.baseElev;
      for (const m of massifs) {
        const d2 = (lx - m.cx) ** 2 + (ly - m.cy) ** 2;
        v += m.peak * Math.exp(-d2 / (m.radius * m.radius));
      }
      for (const b of basins) {
        const d2 = (lx - b.cx) ** 2 + (ly - b.cy) ** 2;
        v -= b.depth * Math.exp(-d2 / (b.radius * b.radius));
      }
      elevMap[ly * l1w + lx] = Math.max(0, Math.min(1, v));
      cellIdx++;
      // Progress ticks at 25/50/75/100% of elev_map build (~12/14/16/18%)
      if (cellIdx % 4096 === 0) {
        reportProgress?.('elev_map', 10 + Math.round(cellIdx / total * 8), { cellIdx });
      }
    }
  }

  // Naturalization: tiny per-cell perturbation breaks Gaussian circularity so
  // every cell has a uniquely defined lowest neighbor (required for acyclic flow).
  // Magnitude 0.004 keeps noise-to-gradient ratio < 0.2 on the flattest massif
  // slope, so flow direction decisions are dominated by terrain, not noise.
  for (let ly = 0; ly < l1h; ly++) {
    for (let lx = 0; lx < l1w; lx++) {
      const idx     = ly * l1w + lx;
      const perturb = 0.004 * (rnd01(worldSeed, ['elev_nat', lx, ly, mx, my]) - 0.5);
      elevMap[idx]  = Math.max(0, Math.min(1, elevMap[idx] + perturb));
    }
  }

  return {
    elevMap, massifCount, basinCount,
    elevStructureFeatures: [
      ...massifs.map(m => ({
        type: 'massif', cx: m.cx, cy: m.cy,
        radius: Math.round(m.radius), peak: +m.peak.toFixed(2),
        quadrant: quadrantLabel(m.cx, m.cy),
      })),
      ...basins.map(b => ({
        type: 'basin', cx: b.cx, cy: b.cy,
        radius: Math.round(b.radius), depth: +b.depth.toFixed(2),
        quadrant: quadrantLabel(b.cx, b.cy),
      })),
    ],
  };
}

// ── Private spatial helpers ───────────────────────────────────────────────────
function quadrantLabel(cx, cy) {
  return cx < 64 && cy < 64 ? 'NW' : cx >= 64 && cy < 64 ? 'NE' : cx < 64 ? 'SW' : 'SE';
}

function compassFromVector(dx, dy) {
  const adx = Math.abs(dx), ady = Math.abs(dy);
  if (adx === 0 && ady === 0) return 'NONE';
  if (adx > ady * 2) return dx > 0 ? 'E' : 'W';
  if (ady > adx * 2) return dy > 0 ? 'S' : 'N';
  if (dx >= 0 && dy < 0) return 'NE';
  if (dx >= 0 && dy >= 0) return 'SE';
  if (dx < 0  && dy < 0)  return 'NW';
  return 'SW';
}

/**
 * Build a structured moisture field for a 128×128 L1 macro cell.
 * Places biome-specific wet and dry Gaussian zones to produce coherent
 * high/low moisture regions.
 *
 * @returns {{ moistMap: Float32Array, wetZoneCount: number, dryZoneCount: number, zones: Array }}
 */
function generateMoistureStructure(mx, my, biome, worldSeed) {
  const l1w = DEFAULTS.L1_SIZE.w;  // 128
  const l1h = DEFAULTS.L1_SIZE.h;  // 128
  const cfg  = BIOME_MOISTURE_CONFIG[biome] || BIOME_MOISTURE_CONFIG.rural;

  // Determine zone counts (deterministic per macro cell)
  const wRng = mulberry32(h32(`${worldSeed}|mw_count|${mx},${my}`));
  const [wMin, wMax] = cfg.wetZoneRange;
  const wetZoneCount = wMin + Math.floor(wRng() * (wMax - wMin + 1));

  const dRng = mulberry32(h32(`${worldSeed}|md_count|${mx},${my}`));
  const [dMin, dMax] = cfg.dryZoneRange;
  const dryZoneCount = dMin + Math.floor(dRng() * (dMax - dMin + 1));

  const zones = [];

  // Build wet zone parameters
  for (let i = 0; i < wetZoneCount; i++) {
    const rng    = mulberry32(h32(`${worldSeed}|mwet|${i}|${mx},${my}`));
    const cx     = Math.floor(rng() * l1w);
    const cy     = Math.floor(rng() * l1h);
    const [r0, r1] = cfg.wetRadii.length >= 2 ? cfg.wetRadii : [16, 30];
    const radius = r0 + rng() * (r1 - r0);
    const [s0, s1] = cfg.wetStrength.length >= 2 ? cfg.wetStrength : [0.10, 0.18];
    const strength = s0 + rng() * (s1 - s0);
    zones.push({ type: 'wet', cx, cy, radius, strength, quadrant: quadrantLabel(cx, cy) });
  }

  // Build dry zone parameters
  for (let j = 0; j < dryZoneCount; j++) {
    const rng    = mulberry32(h32(`${worldSeed}|mdry|${j}|${mx},${my}`));
    const cx     = Math.floor(rng() * l1w);
    const cy     = Math.floor(rng() * l1h);
    const [r0, r1] = cfg.dryRadii.length >= 2 ? cfg.dryRadii : [12, 22];
    const radius = r0 + rng() * (r1 - r0);
    const [s0, s1] = cfg.dryStrength.length >= 2 ? cfg.dryStrength : [0.08, 0.14];
    const strength = s0 + rng() * (s1 - s0);
    zones.push({ type: 'dry', cx, cy, radius, strength, quadrant: quadrantLabel(cx, cy) });
  }

  // Build moistMap
  const moistMap = new Float32Array(l1w * l1h);
  for (let ly = 0; ly < l1h; ly++) {
    for (let lx = 0; lx < l1w; lx++) {
      let v = cfg.baseVal;
      for (const z of zones) {
        const d2 = (lx - z.cx) ** 2 + (ly - z.cy) ** 2;
        const contribution = z.strength * Math.exp(-d2 / (z.radius * z.radius));
        if (z.type === 'wet') v += contribution;
        else                  v -= contribution;
      }
      moistMap[ly * l1w + lx] = Math.max(0, Math.min(1, v));
    }
  }

  return { moistMap, wetZoneCount, dryZoneCount, zones };
}

// =============================================================================
// FLOW FIELD — precomputed downslope direction + upstream accumulation
// =============================================================================

/**
 * Compute a D4 flow direction field and upstream accumulation map from an
 * elevation grid in two linear passes.
 *
 * Algorithm:
 *   1. Sort all 16 384 cell indices by elevation descending (high → low).
 *   2. Assign each cell the cardinal direction (0=N 1=E 2=S 3=W) to its
 *      lowest neighbor, or -1 when already a local minimum (natural sink).
 *   3. Propagate accumulation: traverse high→low; each cell donates its
 *      accumulated upstream count to the cell its pointer targets.
 *      Because we process cells strictly high-to-low, a cell's accumulation
 *      is final before it donates — the pass is acyclic by construction.
 *
 * The naturalization perturbation (±0.04) applied inside generateElevationStructure
 * ensures no two adjacent cells share the exact same elevation, so every cell
 * has a uniquely defined lowest neighbor.  No special flat-resolution handling
 * is required.
 *
 * Cost: O(n log n) for the sort + two O(n) passes — ~200 000 operations total.
 *
 * @param {Float32Array} elevMap — ly*l1w+lx indexed elevation values [0,1]
 * @param {number}       l1w    — grid width  (128)
 * @param {number}       l1h    — grid height (128)
 * @returns {{ flowDir: Int8Array, flowAccum: Uint16Array }}
 *   flowDir[i]   — D4 direction index (0–3) or -1 for sink cells
 *   flowAccum[i] — number of upstream cells draining through cell i (≥ 1)
 */
function generateFlowField(elevMap, l1w, l1h) {
  const n = l1w * l1h; // 16 384

  // D4 cardinal direction offsets indexed 0=N, 1=E, 2=S, 3=W
  const DX = [0, 1, 0, -1];
  const DY = [-1, 0, 1, 0];

  // ── Pass 1: Sort cell indices high → low ─────────────────────────────────
  // Uint16Array is sufficient because n = 16 384 ≤ 65 535.
  const order = new Uint16Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => elevMap[b] - elevMap[a]);

  // ── Pass 2: Assign D4 flow direction per cell ────────────────────────────
  const flowDir   = new Int8Array(n).fill(-1); // -1 = sink (no lower cardinal neighbor)
  const flowAccum = new Uint16Array(n).fill(1); // every cell contributes itself

  for (let k = 0; k < n; k++) {
    const i    = order[k];
    const lx   = i % l1w;
    const ly   = (i - lx) / l1w;
    const elev = elevMap[i];

    let lowestElev = elev; // neighbor must be STRICTLY lower to qualify
    let lowestDir  = -1;

    for (let d = 0; d < 4; d++) {
      const nx = lx + DX[d];
      const ny = ly + DY[d];
      if (nx < 0 || nx >= l1w || ny < 0 || ny >= l1h) continue;
      const nElev = elevMap[ny * l1w + nx];
      if (nElev < lowestElev) {
        lowestElev = nElev;
        lowestDir  = d;
      }
    }

    flowDir[i] = lowestDir; // -1 if cell is a local minimum
  }

  // ── Pass 3: Propagate accumulation high → low ────────────────────────────
  // Processing high→low guarantees that each cell's flowAccum value is fully
  // accumulated before it donates to its downstream neighbor.
  for (let k = 0; k < n; k++) {
    const i = order[k];
    const d = flowDir[i];
    if (d === -1) continue; // sink — nothing to donate downstream

    const lx = i % l1w;
    const ly = (i - lx) / l1w;
    const ni = (ly + DY[d]) * l1w + (lx + DX[d]);
    // Cap at Uint16 max to prevent silent wrap-around on very long channels
    flowAccum[ni] = Math.min(65535, flowAccum[ni] + flowAccum[i]);
  }

  return { flowDir, flowAccum };
}

// =============================================================================
// FULL MACRO PRE-GENERATION — Pass 1+2 baseline + Pass 3 hydrology
// =============================================================================

/**
 * Pre-generate all 128×128 L1 cells for a single macro cell at init time.
 *
 * Pass 0: generateElevationStructure builds coherent highland/lowland regions.
 * Pass 1+2: blended elevation (structured × 0.70 + noise × 0.30) drives terrain
 *           classification. Cells with finalElev >= 0.65 are river source candidates.
 * Pass 3a: spacing-constrained source selection (min 24 cells apart).
 * Pass 3b: gradient-descent river tracing with directional continuity bias.
 * Pass 3c: lake basin flood-fill at sinks (strict radius 4 envelope).
 * Pass 3d: multi-source BFS for water_distance (cap 64).
 *
 * Returns { cells, hydrologyStats }.
 *
 * @param {number}        mx             — macro x (0–7)
 * @param {number}        my             — macro y (0–7)
 * @param {string}        biome          — biome key
 * @param {number}        worldSeed      — phase3_seed / promptSeed
 * @param {object}        existingCells  — current gameState.world.cells (read-only)
 * @param {Function|null} reportProgress — optional callback(step, pct, detail)
 * @returns {{ cells: object, hydrologyStats: object }}
 */
function generateFullMacroCell(mx, my, biome, worldSeed, existingCells, reportProgress = null, hydroStrength = 0) {
  const l1w = DEFAULTS.L1_SIZE.w;   // 128
  const l1h = DEFAULTS.L1_SIZE.h;   // 128
  const cells = {};
  const WATER_GROUPS = new Set(['water', 'coast', 'wetland']);
  const TGMAP = TERRAIN_GROUP_MAP;
  const BFS_CAP = 64;

  // ── Pre-step: Build structured elevation field ────────────────────────────
  const { elevMap, massifCount, basinCount, elevStructureFeatures } =
    generateElevationStructure(mx, my, biome, worldSeed, reportProgress, hydroStrength);
  reportProgress?.('elevation_structure', 20, { massifCount, basinCount });

  // ── Pre-step: Build global flow field from elevation ──────────────────────
  // flowDir[i]   — D4 direction index (0=N 1=E 2=S 3=W) or -1 for local sinks
  // flowAccum[i] — upstream cell count; large values identify main drainage paths
  const { flowDir, flowAccum } = generateFlowField(elevMap, l1w, l1h);

  // ── Pre-step: Build structured moisture field ─────────────────────────────
  const { moistMap, wetZoneCount, dryZoneCount, zones: moistZones } =
    generateMoistureStructure(mx, my, biome, worldSeed);

  const mountainCandidates = [];
  let cellsProcessed = 0;
  const l1total = l1w * l1h; // 16384

  // Accumulators for terrain breakdown, averages, and spatial log
  const terrainCounts = {};
  let elevSum = 0, moistSum = 0;
  const coarseGrid = Array.from({ length: 16 }, () => Array.from({ length: 16 }, () => new Map()));

  // ── Pass 1 + 2: Blended elevation + terrain classification ────────────────
  for (let lx = 0; lx < l1w; lx++) {
    for (let ly = 0; ly < l1h; ly++) {
      const cellKey = `LOC:${mx},${my}:${lx},${ly}`;

      // Skip any cell already written (patch + Phase 6B start cell are protected)
      if (existingCells && existingCells[cellKey]) continue;

      // Blend structured elevation with raw noise
      const rawElev   = evalElevation(mx, my, lx, ly, worldSeed, biome);
      const sElev     = elevMap[ly * l1w + lx];
      const finalElev = Math.max(0, Math.min(1, sElev * STRUCTURE_BLEND.elevation + rawElev * (1 - STRUCTURE_BLEND.elevation)));

      // Blend structured moisture with raw noise
      const rawMois   = evalMoisture(mx, my, lx, ly, worldSeed, biome);
      const finalMois = Math.max(0, Math.min(1, moistMap[ly * l1w + lx] * STRUCTURE_BLEND.moisture + rawMois * (1 - STRUCTURE_BLEND.moisture)));

      // Derive structured temperature from elevation + biome base, blend with noise
      const rawTemp       = evalTemperature(mx, my, lx, ly, worldSeed, biome);
      const biomeBaseTemp = BIOME_BASE_TEMP[biome] ?? 0.55;
      const sTemp         = Math.max(0, Math.min(1, biomeBaseTemp - finalElev * 0.40));
      const finalTemp     = Math.max(0, Math.min(1, sTemp * STRUCTURE_BLEND.temperature + rawTemp * (1 - STRUCTURE_BLEND.temperature)));

      const terrainType = classifyTerrainFromNoise(finalElev, finalMois, finalTemp, biome, cellKey, worldSeed);

      cells[cellKey] = {
        type:        terrainType,
        subtype:     '',
        biome:       biome,
        mx:          mx,
        my:          my,
        lx:          lx,
        ly:          ly,
        description: '',
        elevation:   finalElev,
        moisture:    finalMois,
        temperature: finalTemp,
        attributes:  {},      // ContinuityBrain: L0 persistent feature storage
      };

      // Accumulate stats
      terrainCounts[terrainType] = (terrainCounts[terrainType] || 0) + 1;
      elevSum  += finalElev;
      moistSum += finalMois;
      const gx = Math.floor(lx / 8);
      const gy = Math.floor(ly / 8);
      const cgCell = coarseGrid[gy][gx];
      cgCell.set(terrainType, (cgCell.get(terrainType) || 0) + 1);

      // Accumulate high-elevation cells as river source candidates
      if (finalElev >= 0.65) mountainCandidates.push({ key: cellKey, elev: finalElev, lx, ly });

      // Progress: 4 checkpoints at 31 / 41 / 51 / 60 %
      cellsProcessed++;
      if (cellsProcessed % 4096 === 0) {
        reportProgress?.('pass1_2',
          Math.round(22 + (cellsProcessed / l1total) * 38),
          { cellsProcessed, total: l1total });
      }
    }
  }

  // Build coarse grid log (16×16 dominant terrain blocks, 4-char codes)
  const TERRAIN_ABBREV = {
    mountain_peak: 'MNTN', mountain_slopes: 'MNTN', mountain_pass: 'MNTN', scree: 'MNTN',
    hills_rocky: 'HILL', hills_rolling: 'HILL', rocky_terrain: 'HILL',
    plains_grassland: 'GRSS', plains_wildflower: 'GRSS', meadow: 'GRSS',
    forest_deciduous: 'FRST', forest_mixed: 'FRST', forest_coniferous: 'FRST',
    desert_dunes: 'DSRT', desert_sand: 'DSRT', desert_rocky: 'DSRT', scrubland: 'DSRT', badlands: 'DSRT', mesa: 'DSRT',
    swamp: 'SWMP', marsh: 'SWMP', bog: 'SWMP', wetland: 'SWMP',
    stream: 'STRM', river_crossing: 'STRM',
    lake_shore: 'LAKE',
    beach_sand: 'CSTL', tidepools: 'CSTL',
    tundra: 'TNDR', snowfield: 'TNDR', permafrost: 'TNDR', ice_sheet: 'TNDR',
  };
  const coarseGridLog = coarseGrid.map(row =>
    row.map(blockMap => {
      if (blockMap.size === 0) return '....';
      let bestTerrain = '', bestCount = 0;
      for (const [t, c] of blockMap) { if (c > bestCount) { bestCount = c; bestTerrain = t; } }
      return TERRAIN_ABBREV[bestTerrain] || '????';
    }).join(' ')
  );

  const avgElev  = cellsProcessed > 0 ? +(elevSum  / cellsProcessed).toFixed(3) : 0;
  const avgMois  = cellsProcessed > 0 ? +(moistSum / cellsProcessed).toFixed(3) : 0;
  const terrainBreakdown = Object.fromEntries(
    Object.entries(terrainCounts).sort((a, b) => b[1] - a[1])
  );

  // ── Pass 3 rivers + lakes — flow-driven extraction ───────────────────────
  // Rivers are extracted directly from the flowAccum field rather than traced
  // from elevation-based sources.  Any cell whose upstream catchment area meets
  // the threshold is part of a river; chains are walked downstream via flowDir.

  let riverCount = 0, totalRiverCells = 0;
  const hydroCells = new Set(); let poolCells = 0; let streamHaloCells = 0;
  let channelCells = 0, channelPairsCount = 0;
  let lakeBasins = 0, lakeCells = 0;
  let riverThreshold = 0;
  const sinks = [];
  const riverPaths = [];

  const getCell = key => cells[key] || (existingCells && existingCells[key]) || null;

  // Compute flow diagnostics first — needed for threshold.
  // maxFlowAccum is also surfaced in hydrologyStats for verification.
  let maxFlowAccum = 0;
  for (let _i = 0; _i < flowAccum.length; _i++) {
    if (flowAccum[_i] > maxFlowAccum) maxFlowAccum = flowAccum[_i];
  }
  const _faSorted    = flowAccum.slice().sort();
  const medianFlowAccum = _faSorted[_faSorted.length >> 1] ?? 0;

  // River extraction operates when the flow field has coherent accumulation.
  // ACCUM_FLOOR guards against still-incoherent runs (should not occur after
  // the naturalization magnitude fix, but prevents silent bad output).
  const RIVER_FRACTION   = 0.08;  // top 8% of maxFlowAccum → main channels
  const ACCUM_FLOOR      = 16;    // absolute minimum threshold
  const MIN_RIVER_LENGTH = 8;     // discard short fragments
  const DIR_OFFSETS      = [[0, -1], [1, 0], [0, 1], [-1, 0]]; // N E S W (D4)

  riverThreshold = Math.max(ACCUM_FLOOR, Math.round(maxFlowAccum * RIVER_FRACTION));

  if (maxFlowAccum >= ACCUM_FLOOR) {
    // ── Pass 3b_flow: Identify chain heads and walk downstream ───────────────
    // A chain head is a cell that meets the threshold but whose single upstream
    // cardinal neighbor (the cell pointing INTO this one) does not.  Walking
    // from each head follows the flow pointer until the chain drops below
    // threshold, hits a map sink, or exits the boundary.

    // Build a reverse-pointer map: for each cell, which cell flows into it?
    // (Only needed for chain-head detection — not stored beyond this block.)
    const inflow = new Int32Array(l1w * l1h).fill(-1); // -1 = no single inflow
    for (let i = 0; i < l1w * l1h; i++) {
      const d = flowDir[i];
      if (d === -1) continue;
      const lx = i % l1w;
      const ly = (i - lx) / l1w;
      const ni = (ly + DIR_OFFSETS[d][1]) * l1w + (lx + DIR_OFFSETS[d][0]);
      // Mark ni as having an inflow from i.  If multiple cells flow into ni,
      // mark it as -2 (confluence — still a valid chain interior, not a head).
      inflow[ni] = inflow[ni] === -1 ? i : -2;
    }

    const visited = new Uint8Array(l1w * l1h); // 0 = unvisited
    let riverCells = 0, streamCells = 0; // totals across all rivers
    const RIVER_PROTECTED_GROUPS = new Set(['water', 'coast']);
    const RIVER_CELL_MULTIPLIER  = 2;        // tune if too few/many cells become 'river'
    const RIVER_CELL_THRESHOLD   = riverThreshold * RIVER_CELL_MULTIPLIER;

    for (let i = 0; i < l1w * l1h; i++) {
      if (flowAccum[i] < riverThreshold) continue; // below threshold
      if (visited[i]) continue;

      // Determine if this is a chain head.
      // A head has no qualifying inflow — i.e. the cell draining into it
      // (inflow[i]) either doesn't exist or is itself below threshold.
      const inf = inflow[i];
      const isHead = inf === -1 || inf === -2
        ? true // map-edge inflow or multi-source confluence → treat as head
        : flowAccum[inf] < riverThreshold; // single upstream is below threshold

      if (!isHead) continue;

      // Walk downstream from this head
      const path = [];
      let curIdx = i;

      while (true) {
        if (visited[curIdx]) break; // joined an already-extracted river
        // NOTE: threshold is only used to select heads (above). Once a walk
        // starts it follows flowDir all the way to a natural sink or map edge.
        visited[curIdx] = 1;

        const lx = curIdx % l1w;
        const ly = (curIdx - lx) / l1w;
        const key = `LOC:${mx},${my}:${lx},${ly}`;
        path.push({ key, lx, ly, idx: curIdx });

        const d = flowDir[curIdx];
        if (d === -1) {
          // Natural sink — feed Pass 3c lake fill
          const c = getCell(key);
          sinks.push({ lx, ly, elev: c ? c.elevation : 0 });
          break;
        }
        const [ddx, ddy] = DIR_OFFSETS[d];
        const nLx = lx + ddx, nLy = ly + ddy;
        if (nLx < 0 || nLx >= l1w || nLy < 0 || nLy >= l1h) {
          // Exits boundary — treat as edge sink for lake eligibility
          const c = getCell(key);
          sinks.push({ lx, ly, elev: c ? c.elevation : 0 });
          break;
        }
        curIdx = nLy * l1w + nLx;
      }

      if (path.length < MIN_RIVER_LENGTH) continue;

      riverCount++;
      totalRiverCells += path.length;

      // Reclassify by accumulated flow strength:
      //   accum >= RIVER_CELL_THRESHOLD → 'river'  (main channel trunk)
      //   accum <  RIVER_CELL_THRESHOLD → 'stream' (upper reaches / tributaries)
      for (let pi = 0; pi < path.length; pi++) {
        const { key, idx } = path[pi];
        const cell = getCell(key);
        if (!cell) continue;
        if (RIVER_PROTECTED_GROUPS.has(TGMAP[cell.type] || 'wilderness')) continue;
        const newType = flowAccum[idx] >= RIVER_CELL_THRESHOLD ? 'river' : 'stream';
        if (newType === 'river') riverCells++; else streamCells++;
        if (cells[key])                               cells[key].type = newType;
        else if (existingCells && existingCells[key]) existingCells[key].type = newType;
        hydroCells.add(key);
      }

      // Record path summary
      const sdx = path[path.length - 1].lx - path[0].lx;
      const sdy = path[path.length - 1].ly - path[0].ly;
      riverPaths.push({
        sourceLx: path[0].lx, sourceLy: path[0].ly,
        sourceElev: (() => { const c = getCell(path[0].key); return c ? c.elevation : 0; })(),
        sinkLx: path[path.length - 1].lx, sinkLy: path[path.length - 1].ly,
        length: path.length,
        compassDir: compassFromVector(sdx, sdy),
      });
    }
    reportProgress?.('pass3_rivers', 65, { riversCut: riverCount, totalRiverCells, riverCells, streamCells, riverThreshold, RIVER_CELL_MULTIPLIER: 2 });

    // ── Pass 3c: Lake basin flood-fill at sinks ─────────────────────────────
    const BASIN_RADIUS = 4;
    const sinkSeen = new Set();
    for (const sink of sinks) {
      const sk = `${sink.lx},${sink.ly}`;
      if (sinkSeen.has(sk)) continue;
      sinkSeen.add(sk);
      lakeBasins++;
      const queue    = [{ lx: sink.lx, ly: sink.ly }];
      const bVisited = new Set([sk]);

      while (queue.length > 0) {
        const cur    = queue.shift();
        const curKey = `LOC:${mx},${my}:${cur.lx},${cur.ly}`;
        const cell   = getCell(curKey);
        if (cell && !WATER_GROUPS.has(TGMAP[cell.type] || 'wilderness')) {
          if (cells[curKey])                              cells[curKey].type = 'lake_shore';
          else if (existingCells && existingCells[curKey]) existingCells[curKey].type = 'lake_shore';
          hydroCells.add(curKey);
          lakeCells++;
        }
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nlx = cur.lx + dx, nly = cur.ly + dy;
          if (Math.abs(nlx - sink.lx) + Math.abs(nly - sink.ly) > BASIN_RADIUS) continue;
          if (nlx < 0 || nlx >= l1w || nly < 0 || nly >= l1h) continue;
          const nk = `${nlx},${nly}`;
          if (bVisited.has(nk)) continue;
          const nKey  = `LOC:${mx},${my}:${nlx},${nly}`;
          const nCell = getCell(nKey);
          if (nCell && nCell.elevation < sink.elev + 0.10) {
            bVisited.add(nk);
            queue.push({ lx: nlx, ly: nly });
          }
        }
      }
    }
    reportProgress?.('pass3_lakes', 70, { lakeBasins, lakeCells });

  } else {
    // Flow field incoherent or biome has no meaningful accumulation (coast/wetland) —
    // emit progress stubs so the client progress bar fills smoothly.
    reportProgress?.('pass3_rivers', 65, { riversCut: 0, totalRiverCells: 0, riverThreshold });
    reportProgress?.('pass3_lakes',  70, { lakeBasins: 0, lakeCells: 0 });

    // ── Pass 3b_wet: Wetland diffuse pool placement ────────────────────────
    if (biome === 'wetland') {
      const POOL_EXCLUDED_GROUPS = new Set(['water', 'coast']);
      const MIN_POOL_SPACING = 12;
      const cellsByElev = Object.entries(cells)
        .filter(([, c]) => !POOL_EXCLUDED_GROUPS.has(TGMAP[c.type] || 'wilderness'))
        .sort(([, a], [, b]) => a.elevation - b.elevation);
      const poolTarget = Math.floor(cellsByElev.length * 0.03);
      const poolSeeds = [];
      for (const [key, cell] of cellsByElev) {
        if (poolSeeds.length >= poolTarget) break;
        if (poolSeeds.every(s =>
          Math.abs(cell.lx - s.lx) + Math.abs(cell.ly - s.ly) >= MIN_POOL_SPACING
        )) {
          cells[key].type = 'lake_shore';
          hydroCells.add(key);
          poolSeeds.push({ lx: cell.lx, ly: cell.ly });
          poolCells++;
        }
      }

      // ── Pass 3b_chan: Meander channel walks between nearby pools ─────────────
      const MAX_CHANNEL_DIST      = 45;
      const MAX_CONNECTIONS_PER_POOL = 1;
      const PAIR_CAP              = Math.floor(poolSeeds.length * 0.6);
      const JITTER_MAX            = 4;
      const connectionCount       = new Array(poolSeeds.length).fill(0);
      channelPairsCount     = 0;
      channelCells          = 0;

      // Enumerate pairs sorted by Manhattan distance (closest first)
      const poolPairs = [];
      for (let i = 0; i < poolSeeds.length; i++) {
        for (let j = i + 1; j < poolSeeds.length; j++) {
          const dist = Math.abs(poolSeeds[i].lx - poolSeeds[j].lx)
                     + Math.abs(poolSeeds[i].ly - poolSeeds[j].ly);
          if (dist <= MAX_CHANNEL_DIST) poolPairs.push({ i, j, dist });
        }
      }
      poolPairs.sort((a, b) => a.dist - b.dist);

      for (const { i, j, dist } of poolPairs) {
        if (channelPairsCount >= PAIR_CAP) break;
        if (connectionCount[i] >= MAX_CONNECTIONS_PER_POOL) continue;
        if (connectionCount[j] >= MAX_CONNECTIONS_PER_POOL) continue;
        connectionCount[i]++;
        connectionCount[j]++;
        channelPairsCount++;

        // Jittered greedy meander walk from poolSeeds[i] → poolSeeds[j]
        const target        = poolSeeds[j];
        const MAX_STEPS     = Math.floor(dist * 2.0) + 10;
        const chanVisited   = new Set();
        let   curLx         = poolSeeds[i].lx;
        let   curLy         = poolSeeds[i].ly;

        for (let step = 0; step < MAX_STEPS; step++) {
          if (Math.abs(curLx - target.lx) + Math.abs(curLy - target.ly) <= 2) break;
          const stepRng = mulberry32(h32(`${worldSeed}|chan|${i},${j}|${step}`));
          let bestKey = null, bestLx = -1, bestLy = -1, bestScore = Infinity;
          for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
            const nlx = curLx + dx, nly = curLy + dy;
            if (nlx < 0 || nlx >= l1w || nly < 0 || nly >= l1h) continue;
            const nKey = `LOC:${mx},${my}:${nlx},${nly}`;
            if (chanVisited.has(nKey)) continue;
            const score = Math.abs(nlx - target.lx) + Math.abs(nly - target.ly)
                        + stepRng() * JITTER_MAX;
            if (score < bestScore) { bestScore = score; bestKey = nKey; bestLx = nlx; bestLy = nly; }
          }
          if (!bestKey) break;
          chanVisited.add(bestKey);
          curLx = bestLx; curLy = bestLy;
          if (!cells[bestKey]) continue;
          if (hydroCells.has(bestKey)) continue;
          if (WATER_GROUPS.has(TGMAP[cells[bestKey].type] || 'wilderness')) continue;
          cells[bestKey].type = 'stream';
          hydroCells.add(bestKey);
          channelCells++;
        }
      }
      reportProgress?.('pass3_pools', 64, { poolCells, channelCells, channelPairsCount });
    }
  }

  // ── Pass 3c_str: Terrain-stream halo around hydrology seeds ────────────────
  const STREAM_HALO_BIOMES = new Set(['wetland', 'jungle', 'rural', 'forest']);
  if (STREAM_HALO_BIOMES.has(biome) && hydroCells.size > 0) {
    const HALO_RADIUS = 2;
    const HALO_DENSITY = 0.18;
    const haloVisited = new Set();
    for (const seedKey of hydroCells) {
      const sm = seedKey.match(/^LOC:\d+,\d+:(\d+),(\d+)$/);
      if (!sm) continue;
      const slx = parseInt(sm[1], 10), sly = parseInt(sm[2], 10);
      for (let hdx = -HALO_RADIUS; hdx <= HALO_RADIUS; hdx++) {
        for (let hdy = -HALO_RADIUS; hdy <= HALO_RADIUS; hdy++) {
          if (Math.abs(hdx) + Math.abs(hdy) > HALO_RADIUS) continue;
          const nlx = slx + hdx, nly = sly + hdy;
          if (nlx < 0 || nlx >= l1w || nly < 0 || nly >= l1h) continue;
          const nKey = `LOC:${mx},${my}:${nlx},${nly}`;
          if (haloVisited.has(nKey)) continue;
          haloVisited.add(nKey);
          if (hydroCells.has(nKey)) continue;
          if (!cells[nKey]) continue;
          if (WATER_GROUPS.has(TGMAP[cells[nKey].type] || 'wilderness')) continue;
          const haloRng = mulberry32(h32(`${worldSeed}|p3str|${nKey}`));
          if (haloRng() < HALO_DENSITY) {
            cells[nKey].type = 'stream';
            streamHaloCells++;
          }
        }
      }
    }
    reportProgress?.('pass3_stream_halo', 71, { streamHaloCells });
  }

  // ── Pass 3d: Multi-source BFS for water_distance (always runs) ───────────
  const allKeys = new Set(Object.keys(cells));
  if (existingCells) for (const k of Object.keys(existingCells)) allKeys.add(k);

  const bfsQueue = [];
  const bfsDist  = new Map();
  for (const key of allKeys) {
    const cell = cells[key] || (existingCells && existingCells[key]);
    if (!cell) continue;
    if (hydroCells.has(key)) {
      bfsDist.set(key, 0);
      bfsQueue.push(key);
    }
  }

  const bfsTotal = allKeys.size || 1;
  let bfsVisited = 0;
  let bfsHead    = 0;
  while (bfsHead < bfsQueue.length) {
    const curKey  = bfsQueue[bfsHead++];
    const curDist = bfsDist.get(curKey);
    bfsVisited++;
    if (bfsVisited % 1638 === 0) {
      reportProgress?.('pass3_bfs',
        72 + Math.floor(bfsVisited / bfsTotal * 10),
        { bfsVisited });
    }
    if (curDist >= BFS_CAP) continue;
    const m = curKey.match(/^LOC:\d+,\d+:(\d+),(\d+)$/);
    if (!m) continue;
    const clx = parseInt(m[1], 10), cly = parseInt(m[2], 10);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nlx = clx + dx, nly = cly + dy;
      if (nlx < 0 || nlx >= l1w || nly < 0 || nly >= l1h) continue;
      const nKey = `LOC:${mx},${my}:${nlx},${nly}`;
      if (bfsDist.has(nKey)) continue;
      if (!allKeys.has(nKey)) continue;
      bfsDist.set(nKey, curDist + 1);
      bfsQueue.push(nKey);
    }
  }

  // Write water_distance + compute stats
  let distSum = 0, distCount = 0;
  const distH = { d0_4: 0, d5_15: 0, d16_32: 0, d33_64: 0, dOver64: 0 };
  for (const key of allKeys) {
    const d    = bfsDist.has(key) ? bfsDist.get(key) : BFS_CAP;
    if (cells[key])                              cells[key].water_distance = d;
    else if (existingCells && existingCells[key]) existingCells[key].water_distance = d;
    const cell = cells[key] || (existingCells && existingCells[key]);
    if (cell && !WATER_GROUPS.has(TGMAP[cell.type] || 'wilderness')) { distSum += d; distCount++; }
    if      (d <= 4)  distH.d0_4++;
    else if (d <= 15) distH.d5_15++;
    else if (d <= 32) distH.d16_32++;
    else if (d <= 64) distH.d33_64++;
    else               distH.dOver64++;
  }

  const noiseWaterCells = bfsQueue.length; // BFS seeds = all water cells after Pass 3
  let waterAfterPass3 = 0;
  const cellCount = Object.keys(cells).length;
  for (const cell of Object.values(cells)) {
    if (WATER_GROUPS.has(TGMAP[cell.type] || 'wilderness')) waterAfterPass3++;
  }
  const waterCoveragePct = cellCount > 0
    ? +((waterAfterPass3 / cellCount) * 100).toFixed(2)
    : 0;

  // ── Pass 3e: Post-hydrology fringe — wet biomes only ─────────────────────
  // After BFS has written water_distance, push wet terrain outward from rivers/
  // lakes so ecosystems form around flow paths, not as a pre-saturation blanket.
  let fringeCells = 0;
  if (biome === 'wetland' || biome === 'jungle') {
    for (const key of allKeys) {
      const cell = cells[key] || (existingCells && existingCells[key]);
      if (!cell) continue;
      // Skip already-water terrain (streams, rivers, lakes, swamp already placed)
      if (WATER_GROUPS.has(TGMAP[cell.type] || 'wilderness')) continue;
      const d = cell.water_distance ?? BFS_CAP;
      const frngRng = mulberry32(h32(`${worldSeed}|p3e|${key}`));

      let newType = null;
      if (biome === 'wetland') {
        if (d <= 4) {
          const pool = ['swamp', 'marsh', 'bog', 'wetland'];
          newType = pool[Math.floor(frngRng() * pool.length)];
        } else if (d <= 10 && frngRng() < 0.40) {
          newType = frngRng() < 0.5 ? 'bog' : 'wetland';
        }
      } else { // jungle
        if (d <= 4) {
          const pool = ['marsh', 'forest_mixed', 'forest_deciduous'];
          newType = pool[Math.floor(frngRng() * pool.length)];
        } else if (d <= 10 && frngRng() < 0.30) {
          newType = 'forest_mixed';
        }
      }

      if (newType) {
        if (cells[key])                               cells[key].type = newType;
        else if (existingCells && existingCells[key]) existingCells[key].type = newType;
        fringeCells++;
      }
    }
  }
  reportProgress?.('pass3_fringe', 84, { fringeCells });

  // maxFlowAccum, medianFlowAccum, and riverThreshold were computed earlier in
  // Pass 3b_flow and are already bound as locals — no recomputation needed here.

  const hydrologyStats = {
    riverCount,
    totalRiverCells,
    lakeBasins,
    lakeCells,
    poolCells,
    channelCells,
    channelPairsCount,
    streamHaloCells,
    mountainCells:    mountainCandidates.length,
    riverThreshold,
    noiseWaterCells,
    waterCoveragePct,
    avgWaterDistance: distCount > 0 ? +(distSum / distCount).toFixed(2) : 0,
    distribution:     distH,
    maxFlowAccum,
    medianFlowAccum,
    // Spatial observability
    massifCount,
    basinCount,
    elevStructureFeatures,
    wetZoneCount,
    dryZoneCount,
    moistZones,
    riverPaths,
    terrainBreakdown,
    avgElev,
    avgMois,
    coarseGridLog,
    fringeCells,
  };

  reportProgress?.('complete', 100, { waterCoveragePct });

  return { cells, hydrologyStats };
}

/**
 * Select the best starting cell from a terrain patch based on world_bias.
 *
 * Scoring: CIV_TERRAIN_SCORE[terrainGroup][civilization_presence]
 * Tie-break: deterministic hash per cell — total ordering is stable.
 * Fallback 1: anchor centre (if patch is empty).
 * Fallback 2: hardcoded (0,0,6,6) safety net — should never fire.
 *
 * @param {number} promptSeed — h32(inputObj.WORLD_PROMPT)
 * @param {object} worldBias  — validated world_bias
 * @param {object} patchCells — return value of generateTerrainPatch
 * @param {{ mx, my, lx, ly }} anchor
 * @returns {{ mx, my, lx, ly }}
 */
function selectStartPosition(promptSeed, worldBias, patchCells, anchor) {
  const civLevel = worldBias?.civilization_presence || 'medium';
  const entries = Object.entries(patchCells);

  if (entries.length === 0) {
    // Fallback 1 — patch was empty (all cells pre-existing)
    return { mx: anchor.mx, my: anchor.my, lx: anchor.lx, ly: anchor.ly };
  }

  // Score + deterministic tiebreak sort
  const scored = entries.map(([cellKey, cell]) => {
    const group = terrainGroup(cell.type);
    const score = (CIV_TERRAIN_SCORE[group] && CIV_TERRAIN_SCORE[group][civLevel] !== undefined)
      ? CIV_TERRAIN_SCORE[group][civLevel]
      : 0.5;
    const tiebreak = h32(`${promptSeed}|tiebreak|${cellKey}`);
    return { cellKey, cell, score, tiebreak };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;  // higher score first
    return a.tiebreak - b.tiebreak;                     // lower hash first (deterministic)
  });

  const winner = scored[0].cell;

  if (winner === undefined) {
    // Fallback 2 — belt-and-suspenders, should never fire
    console.warn('[PHASE3] selectStartPosition used safety fallback — check patch generation');
    return { mx: 0, my: 0, lx: 6, ly: 6 };
  }

  return { mx: winner.mx, my: winner.my, lx: winner.lx, ly: winner.ly };
}

// --- MAC: macro region logic (same) ---
async function generateWorldFromDescription(desc, worldSeed) {
  // Detect biome, tone, starting location, world bias/context, AND start container in parallel
  const [biome, worldTone, startingLocationType, biasResult, startContext] = await Promise.all([
    detectBiomeWithDeepSeek(desc),
    detectWorldToneWithDeepSeek(desc),
    detectStartingLocationWithDeepSeek(desc),
    extractWorldBiasWithDeepSeek(desc),
    detectStartContextWithDeepSeek(desc)
  ]);

  const { world_bias, world_context } = biasResult;

  // If the prompt contains urban-signal keywords, elevate civilization density in world_bias.
  // This carries the signal that biome detection no longer carries (urban is not a biome).
  const _urbanSignals = BIOME_KEYWORDS.urban;
  const _descLower = String(desc || '').toLowerCase();
  if (_urbanSignals.some(kw => _descLower.includes(kw))) {
    console.log('[WORLD] Urban signals detected in prompt — boosting world_bias civilization density');
    if (!world_bias.civilization_presence || world_bias.civilization_presence !== 'high') {
      world_bias.civilization_presence = 'high';
    }
    if (!world_bias.site_density || world_bias.site_density !== 'high') {
      world_bias.site_density = 'high';
    }
  }

  // Derive hydroStrength from prompt keywords — controls river-terrain amplification.
  // strength 1: one or more hydro signals  (rivers get modest terrain boost)
  // strength 2: three or more hydro signals (explicit river/water world → stronger boost)
  const HYDRO_SIGNALS = ['river','rivers','stream','streams','waterway','flowing','lake','lakes','flooded','delta','marsh','canal','tributary','flood'];
  const hydroMatches  = HYDRO_SIGNALS.filter(kw => _descLower.includes(kw)).length;
  const hydroStrength = hydroMatches >= 3 ? 2 : hydroMatches >= 1 ? 1 : 0;
  if (hydroStrength > 0) {
    console.log(`[WORLD] Hydrology signals detected (strength ${hydroStrength}) — boosting river-support terrain`);
  }

  // start_container is resolved by detectStartContextWithDeepSeek (AI-primary, keyword fallback).
  // Keyword arrays live inside that function as the fallback path — not duplicated here.
  const start_container = startContext.container;
  console.log(`[WORLD] Start container: ${start_container} (scale=${startContext.scale}, local_space_purpose=${startContext.local_space_purpose})`);

  const palette = BIOME_PALETTES[biome] || BIOME_PALETTES["rural"];
  const l0s = DEFAULTS.L0_SIZE;
  const macroCells = {};
  for (let my = 0; my < l0s.h; my++) {
    for (let mx = 0; mx < l0s.w; mx++) {
      const k = `MAC:${mx},${my}`;
      macroCells[k] = { desc: "", biome, palette };
    }
  }
  return {
    seed: worldSeed,
    biome,
    worldTone,
    startingLocationType,
    world_bias,      // Generation pipeline inputs — frozen after init
    world_context,   // Expressive context (era) — for narration/naming only
    palette,
    l0_size: l0s,
    cells: macroCells,
    sites: {},
    hydro_strength: hydroStrength,
    start_container,
    start_context: startContext  // transient interpretation result — consumed during Turn-1, not stored to world
  };
}

// --- LOC: site placement (same) ---
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
      const lx = clamp(lx2, 0, DEFAULTS.L1_SIZE.w - 1);
      const ly = clamp(ly2, 0, DEFAULTS.L1_SIZE.h - 1);
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

// --- LOC: feature description (same) ---
function generateL1FeatureDescription(site, worldSeed = "default") {
  if (!site) return "An empty space";
  const st = site.subtype || "terrain feature";
  return `A ${st}`;
}

// =============================================================================
// PHASE 3C: ENHANCED L2 SITE GENERATION
// =============================================================================

/**
 * Generate L2 site with NPC persistence and metadata
 * @param {string} siteId - Site identifier
 * @param {number} site_size - Engine-assigned site size (1–10)
 * @param {Array<object>} npc_array - Pre-generated NPC array (optional, for backward compatibility)
 * @param {string} worldSeed - World seed for determinism
 * @param {object} npcModule - NPCs.js module
 * @returns {object} Site layout with persistent NPCs and metadata
 */
function generateL2Site(siteId, site_size, npc_array, worldSeed, npcModule, options = {}) {
  const st = siteGridFromSize(typeof site_size === 'number' ? site_size : 3);
  const seed = hashSeedFromLocationID(siteId);
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

  // local spaces
  const local_spaces = {};
  const localSpaceCount = st.local_space_count;
  let start_local_space_id = null;
  for (let i = 0; i < localSpaceCount; i++) {
    let bx = 0, by = 0, tries = 0;
    do {
      bx = rng.nextInt(w);
      by = rng.nextInt(h);
      tries++;
      if (tries > 200) break;
    } while (grid[by][bx]);
    const local_space_id = `ls_${i}`;
    grid[by][bx] = { type: "local_space", local_space_id: local_space_id, npc_ids: [] };
    // v1.85.47: roll size, compute dimensions, derive enterable via deterministic hash (zero RNG consumption)
    const _lsSize = rollGlobalLocalspaceSize(rng);
    const { width: _lsW, height: _lsH } = siteGridFromSize(_lsSize);
    let _lsHash = 0;
    const _lsHashStr = `${siteId}|${local_space_id}`;
    for (let _ci = 0; _ci < _lsHashStr.length; _ci++) { _lsHash = Math.imul(31, _lsHash) + _lsHashStr.charCodeAt(_ci) | 0; }
    const _lsEnterable = ((_lsHash >>> 0) % 100) >= 15;
    local_spaces[local_space_id] = {
      local_space_id,
      parent_site_id: siteId,
      enterable: _lsEnterable,
      is_filled: false,
      name: null,
      description: null,
      x: bx,
      y: by,
      npc_ids: [],
      localspace_size: _lsSize,
      width: _lsW,
      height: _lsH
    };
    if (start_local_space_id === null) start_local_space_id = local_space_id;
  }

  // PHASE 3C: Generate or use existing NPCs with persistence
  let npcs = [];
  if (Array.isArray(npc_array) && npc_array.length > 0) {
    // Use provided NPCs (backward compatibility)
    npcs = npc_array;
  } else if (npcModule) {
    // Generate new NPCs with persistence
    npcs = generateL2NPCs(siteId, site_size, worldSeed || "default", npcModule);
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
      // v1.84.38: record site-local placement coords — additive, npc.position (mx/my/lx/ly) unchanged
      if (npc && typeof npc === 'object') npc.site_position = { x: slot.x, y: slot.y };
    }
    streetAssigned++;
  }
  
  // remaining to local spaces round-robin — v1.85.47: only enterable spaces receive NPCs
  const lsKeys = Object.keys(local_spaces).filter(k => local_spaces[k].enterable !== false);
  if (lsKeys.length > 0) {
    for (let i = streetAssigned; i < npcs.length; i++) {
      const npc = npcs[i];
      const ls = local_spaces[lsKeys[i % lsKeys.length]];
      ls.npc_ids.push(npc.id || npc);
      // v1.84.38: record site-local placement coords — additive, npc.position (mx/my/lx/ly) unchanged
      if (npc && typeof npc === 'object') npc.site_position = { x: ls.x, y: ls.y };
    }
  }

  // PHASE 3C: Add site metadata
  // Site name is filled by DeepSeek ([SITE-FILL] or [L2-START-SITE-FILL]) — never generated here.
  const populationCount = npcs.length;

  return {
    id: siteId,
    site_id: siteId.replace(/\/l2$/, ''),
    name: null,
    site_size: typeof site_size === 'number' ? site_size : 3,
    start_local_space_id,
    population: populationCount,
    width: w,
    height: h,
    grid,
    local_spaces,
    npcs: npcs, // PHASE 3C: Store NPC array for persistence
    created_at: new Date().toISOString()
  };
}

// --- L2: local space interior ---
function generateLocalSpace(local_space_id, localSpaceData, siteSize = 1) {
  // Interior dimensions scale with localspace_size via siteGridFromSize.
  // localSpaceData.width/height is the L1 tile footprint (1×1), not the interior size.
  const { width: w, height: h } = siteGridFromSize(siteSize);
  const grid = [];
  for (let y = 0; y < h; y++) {
    const row = [];
    for (let x = 0; x < w; x++) {
      row.push({ type: "room_floor", objects: [], npc_ids: [] });
    }
    grid.push(row);
  }
  // Place any assigned NPCs at the center tile.
  const cx = Math.floor(w / 2);
  const cy = Math.floor(h / 2);
  const npc_ids = Array.isArray(localSpaceData?.npc_ids) ? [...localSpaceData.npc_ids] : [];
  if (npc_ids.length > 0) {
    grid[cy][cx].npc_ids = npc_ids;
  }
  return {
    local_space_id,
    parent_site_id: localSpaceData?.parent_site_id ?? null,
    enterable: localSpaceData?.enterable ?? true,
    is_filled: localSpaceData?.is_filled ?? false,
    name: localSpaceData?.name ?? null,
    description: localSpaceData?.description ?? null,
    width: w,
    height: h,
    grid,
    npc_ids,
    object_ids: [] // v1.84.85: localspace floor container for ORS
    // npcs field intentionally absent: local spaces never own NPC records.
    // All NPC resolution uses parent active_site.npcs as registry. (v1.81.3)
  };
}

module.exports = { 
  generateWorldFromDescription,  
  exposeSitesInWindow, 
  generateL1FeatureDescription, 
  generateL2Site, 
  generateLocalSpace, 
  hashSeedFromLocationID, 
  makeLCG,
  detectWorldToneWithDeepSeek,
  detectStartingLocationWithDeepSeek,
  // PHASE 3C: New exports
  getNPCCountFromSize,
  siteGridFromSize,
  generateNPCTraits,
  generateNPCInventory,
  generateL2NPCs,
  // Phase 1
  extractWorldBiasWithDeepSeek,
  // Phase 2
  evaluateCellForSites,
  // Phase 3
  h32,
  selectStartAnchor,
  generateTerrainPatch,
  selectStartPosition,
  LAYER_TERRAIN_VOCAB,
  // Pass 1 — noise fields
  evalElevation,
  evalMoisture,
  evalTemperature,
  // Pass 2 — terrain classification
  classifyTerrainFromNoise,
  // Observability slice — full macro pre-generation + group map
  generateFullMacroCell,
  TERRAIN_GROUP_MAP,
};
