// WorldGen.js — Phase 3C: Enhanced with NPC persistence, settlement metadata, and quest integration
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
    "river_crossing", "stream", "lake_shore", "waterfall", "spring"
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
function generateSiteName(siteId, worldSeed) {
  const combinedSeed = `${worldSeed}|${siteId}|name`;
  const hash = h32(combinedSeed);
  const rng = mulberry32(hash);
  
  const prefix = NAME_PREFIXES[Math.floor(rng() * NAME_PREFIXES.length)];
  const suffix = NAME_SUFFIXES[Math.floor(rng() * NAME_SUFFIXES.length)];
  
  const generatedName = `${prefix}${suffix}`;
  
  // B3: Site naming debug logging
  console.log(`[B3-NAME] Generated site name: id=${siteId}, worldSeed=${worldSeed}, combinedSeed=${combinedSeed}, hash=${hash}, name=${generatedName}`);
  
  return generatedName;
}

// =============================================================================
// PHASE 3C: NPC COUNT BY SETTLEMENT TYPE
// =============================================================================

/**
 * Get NPC count for settlement type
 * @param {string} settlementType - Type of settlement
 * @returns {number} Number of NPCs to generate
 */
function getNPCCountForSite(siteType) {
  const counts = {
    outpost: 3,
    hamlet: 8,
    village: 15,
    town: 30,
    city: 60,
    metropolis: 120
  };
  return counts[siteType] || 10;
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
function generateL2NPCs(siteId, siteType, worldSeed, npcModule) {
  const npcCount = getNPCCountForSite(siteType);
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
 * @returns {Promise<string>} Settlement type (e.g. "village", "shop", "tavern", "temple")
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
      console.log(`[LOCATION] Invalid type "${locationType}", mapping to nearest settlement type`);
      locationType = "village";
    }

    console.log(`[LOCATION] Detected starting location type: "${locationType}"`);
    return locationType;
  } catch (err) {
    console.log(`[LOCATION] Starting location detection failed (${err?.message}), using default`);
    return "village";
  }
}

// --- Site size data (tier, grid dimensions, local space count) ---
const SITE_SIZES = {
  outpost:    { tier: 0, width: 3,  height: 3,  local_space_count: 2  },
  hamlet:     { tier: 1, width: 5,  height: 5,  local_space_count: 4  },
  village:    { tier: 2, width: 7,  height: 7,  local_space_count: 8  },
  town:       { tier: 3, width: 9,  height: 9,  local_space_count: 12 },
  city:       { tier: 4, width: 11, height: 11, local_space_count: 20 },
  metropolis: { tier: 5, width: 13, height: 13, local_space_count: 30 }
};

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

    sites.push({
      site_id,
      parent_cell:  cellKey,
      l0_ref:       { mx, my, lx, ly },
      enterable,
      is_filled:    false,
      name:         null,
      identity:     null,
      description:  null,
      entered:      false,
      interior_key: null,
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
  river_crossing:   'water',  stream:           'water',  lake_shore:    'water',
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

      // Per-cell deterministic RNG — independent of other cells
      const cellRng = mulberry32(h32(`${promptSeed}|patch|${cellKey}`));
      const terrainType = palette[Math.floor(cellRng() * palette.length)];

      patch[cellKey] = {
        type:        terrainType,
        subtype:     '',
        biome:       biome,
        mx:          anchor.mx,
        my:          anchor.my,
        lx:          lx,
        ly:          ly,
        description: '',
      };
    }
  }

  return patch;
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
  // Detect biome, tone, starting location, AND world bias/context in parallel
  const [biome, worldTone, startingLocationType, biasResult] = await Promise.all([
    detectBiomeWithDeepSeek(desc),
    detectWorldToneWithDeepSeek(desc),
    detectStartingLocationWithDeepSeek(desc),
    extractWorldBiasWithDeepSeek(desc)
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
    sites: {}
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
// PHASE 3C: ENHANCED L2 SETTLEMENT GENERATION
// =============================================================================

/**
 * Generate L2 site with NPC persistence and metadata
 * @param {string} siteId - Site identifier
 * @param {string} siteType - Type of site
 * @param {Array<object>} npc_array - Pre-generated NPC array (optional, for backward compatibility)
 * @param {string} worldSeed - World seed for determinism
 * @param {object} npcModule - NPCs.js module
 * @returns {object} Site layout with persistent NPCs and metadata
 */
function generateL2Site(siteId, siteType, npc_array, worldSeed, npcModule) {
  const st = SITE_SIZES[siteType] || SITE_SIZES["village"];
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
  const localSpaceNamesByPurpose = {
    tavern: ["The Wanderer's Rest", "The Drunk Griffin", "The Ale House"],
    house: ["Homestead", "Cottage", "Dwelling", "Residence"],
    shop: ["General Store", "Trading Post", "Stall"],
    guildhall: ["Guild Hall", "Council House"],
    temple: ["Temple of Light", "Sacred Shrine"],
    palace: ["The Grand Palace", "Royal Keep"]
  };
  const possiblePurposes = ["house", "house", "shop", "tavern", "house", "temple", "guildhall"];
  for (let i = 0; i < localSpaceCount; i++) {
    let bx = 0, by = 0, tries = 0;
    do {
      bx = rng.nextInt(w);
      by = rng.nextInt(h);
      tries++;
      if (tries > 200) break;
    } while (grid[by][bx]);
    const purpose = possiblePurposes[rng.nextInt(possiblePurposes.length)];
    const namePool = localSpaceNamesByPurpose[purpose] || ["Local Space"];
    const name = namePool[rng.nextInt(namePool.length)];
    const local_space_id = `ls_${i}`;
    grid[by][bx] = { type: "local_space", local_space_id: local_space_id, npc_ids: [] };
    local_spaces[local_space_id] = {
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
    npcs = generateL2NPCs(siteId, siteType, worldSeed || "default", npcModule);
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
  
  // remaining to local spaces round-robin
  const lsKeys = Object.keys(local_spaces);
  if (lsKeys.length > 0) {
    for (let i = streetAssigned; i < npcs.length; i++) {
      const npc = npcs[i];
      const ls = local_spaces[lsKeys[i % lsKeys.length]];
      ls.npc_ids.push(npc.id || npc);
    }
  }

  // PHASE 3C: Add site metadata
  const siteName = generateSiteName(siteId, worldSeed || "default");
  const populationCount = npcs.length;
  
  // B3: Debug logging at call site
  console.log(`[B3-CALLER] Site name generation called: siteId=${siteId}, worldSeed=${worldSeed}, result=${siteName}`);
  
  return {
    id: siteId,
    name: siteName,
    type: siteType,
    population: populationCount,
    width: w,
    height: h,
    grid,
    local_spaces,
    npcs: npcs, // PHASE 3C: Store NPC array for persistence
    tier: st.tier,
    created_at: new Date().toISOString()
  };
}

// --- L2: local space interior ---
function generateLocalSpace(local_space_id, localSpaceData) {
  // Interior is always 5×5 — localSpaceData.width/height is the L1 tile footprint (1×1), not the interior size.
  const w = 5;
  const h = 5;
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
    id: local_space_id,
    name: localSpaceData?.name || local_space_id,
    purpose: localSpaceData?.purpose || 'unknown',
    width: w,
    height: h,
    grid,
    npc_ids,
    npcs: []
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
  generateSiteName,
  getNPCCountForSite,
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
};
