// NPCs.v4.patched.js — extends NPCs.v3 with deterministic NPC generation, trait & job catalogs.
// Existing v3 functions are preserved verbatim; new exports appended.
const crypto = require('crypto');

// --- Preserved helpers from v3 ---
function parseISO(ts) { const d=new Date(ts); if (Number.isNaN(d.getTime())) throw new Error("INVALID_ISO_TIMESTAMP"); return d; }
function toISO(d) { return new Date(d).toISOString(); }

// Levenshtein + alias score (matching v118)
function levenshtein(a,b){
  a = String(a||'').toLowerCase(); b = String(b||'').toLowerCase();
  const n = a.length, m = b.length;
  const dp = new Array(m+1);
  for (let j=0;j<=m;j++) dp[j] = j;
  for (let i=1;i<=n;i++){
    let prev = dp[0];
    dp[0] = i;
    for (let j=1;j<=m;j++){
      const tmp = dp[j];
      const cost = (a[i-1]===b[j-1]) ? 0 : 1;
      dp[j] = Math.min(dp[j]+1, dp[j-1]+1, prev+cost);
      prev = tmp;
    }
  }
  return dp[m];
}

// Levenshtein + alias score (matching v118)
function levenshtein(a,b){
  a = String(a||'').toLowerCase(); b = String(b||'').toLowerCase();
  const n = a.length, m = b.length;
  const dp = new Array(m+1);
  for (let j=0;j<=m;j++) dp[j] = j;
  for (let i=1;i<=n;i++){
    let prev = dp[0];
    dp[0] = i;
    for (let j=1;j<=m;j++){
      const tmp = dp[j];
      const cost = (a[i-1]===b[j-1]) ? 0 : 1;
      dp[j] = Math.min(dp[j]+1, dp[j-1]+1, prev+cost);
      prev = tmp;
    }
  }
  return dp[m];
}

// --- Preserved merchant/NPC functions from v3 ---
function tickNPCs(state, nowISO, deltas, flags){
  const merchants = (((state||{}).world||{}).merchants)||[];
  const now = parseISO(nowISO);
  const keep = [];
  let changed = false;
  for (const m of merchants){
    try{
      const exp = parseISO(m?.expires_at_utc);
      if (now >= exp){ changed = true; continue; }
    }catch(_){ changed = true; continue; }
    keep.push(m);
  }
  if (changed){
    state.world.merchants = keep;
    deltas.push({ op:'set', path:'/world/merchants', value: keep });
    flags.merchant_state_rev = true;
  }
}
function regenNPCsOnTurn(state, nowISO, deltas, flags){
  const merchants = (((state||{}).world||{}).merchants)||[];
  if (!merchants.length) return;
  const now = parseISO(nowISO);
  const newExp = toISO(new Date(now.getTime() + 24*3600*1000));
  let touched = false;
  for (const m of merchants){
    if (Array.isArray(m?.stock)){
      for (const s of m.stock){
        if (s && typeof s === 'object' && 'item_id' in s) s.qty = 3;
      }
      m.expires_at_utc = newExp;
      touched = true;
    }
  }
  if (touched){
    deltas.push({ op:'set', path:'/world/merchants', value: merchants });
    flags.merchant_state_rev = true;
  }
}

// Global NPC tick — runs every turn for all NPCs, independent of visibility.
/**
 * Tick all NPCs across the world unconditionally (visibility-agnostic).
 * Preserves existing merchant semantics (per-NPC), and provides scheduling stub.
 * @param {object} state
 * @param {string} nowISO ISO timestamp
 * @param {Array<object>} deltas
 * @param {number} turnNumber pre-increment turn counter
 */
function tickAllNPCsGlobally(state, nowISO, deltas, turnNumber){
  const npcs = (((state||{}).world||{}).npcs) || [];
  const now = parseISO(nowISO);

  for (let i = 0; i < npcs.length; i++){
    const npc = npcs[i];
    if (!npc || typeof npc !== 'object') continue;

    // --- Merchant lifecycle (existing semantics adapted per-NPC) ---
    if (npc.role === 'trader'){
      try{
        const exp = parseISO(npc.expires_at_utc);
        const isExpired = (now >= exp);
        // Under persistence rules, we do not delete the NPC here.
        // Future steps may mark for temporary inactivity instead.
      }catch(_e){
        // Invalid expiry -> treat as expired in future handling (no-op here)
      }
      // Regen cadence example (every 10 turns) mirroring merchant policy
      if ((turnNumber|0) % 10 === 0 && Array.isArray(npc.stock)){
        const newExp = toISO(new Date(now.getTime() + 24*3600*1000));
        for (const s of npc.stock){
          if (s && typeof s === 'object' && 'item_id' in s) s.qty = 3;
        }
        npc.expires_at_utc = newExp;
      }
    }

    // [SCHEDULING STUB]
    // TODO: Compute desired NPC position based on npc.schedule (when implemented)
    //   For now: ensure NPC position defaults to settlement center if schedule undefined
    //   Future: Implement day/night cycles, work schedules, patrol routes, etc.

    // Mark last tick turn (diagnostics; included in delta via parent set)
    npc._last_tick_turn = (turnNumber|0);

    // Emit a single parent-array set to capture nested mutations
    deltas.push({ op:'set', path:'/world/npcs', value: npcs });
  }
}

// --- New catalogs & generators (v4 additions) ---

/** Traits catalog: exactly 104 items (40 positive, 40 negative, 24 neutral) */
const TRAITS_CATALOG = [].concat(
  ["honest", "brave", "kind", "generous", "loyal", "just", "patient", "humble", "wise", "compassionate", "industrious", "disciplined", "principled", "merciful", "noble", "honorable", "selfless", "fair", "trustworthy", "dependable", "sincere", "virtuous", "heroic", "benevolent", "steadfast", "truthful", "righteous", "magnanimous", "altruistic", "incorruptible", "upright", "courageous", "conscientious", "faithful", "forthright", "gracious", "prudent", "serene", "resolute", "charitable"],
  ["selfish", "cowardly", "cruel", "deceptive", "greedy", "lustful", "envious", "wrathful", "slothful", "prideful", "vain", "vengeful", "treacherous", "dishonest", "corrupt", "manipulative", "cynical", "bitter", "petty", "malicious", "spiteful", "vindictive", "cunning", "devious", "deceitful", "untrustworthy", "unreliable", "two-faced", "backstabbing", "wicked", "sinister", "arrogant", "contemptuous", "callous", "merciless", "heartless", "ruthless", "domineering", "bullying", "exploitative"],
  ["ambitious", "cautious", "pragmatic", "curious", "methodical", "calculating", "shrewd", "reserved", "outgoing", "introspective", "daring", "suspicious", "trusting", "witty", "serious", "observant", "absent-minded", "volatile", "steady", "eccentric", "conventional", "skeptical", "naive", "adaptive"]
);

// Load-time assertions for traits
(function(){
  if (TRAITS_CATALOG.length !== 104) throw new Error("TRAITS_CATALOG length must be 104");
  const set = new Set();
  for (const t of TRAITS_CATALOG){ 
    const k = String(t).toLowerCase();
    if (set.has(k)) throw new Error("Duplicate trait: "+t);
    set.add(k);
  }
})();


/** Job categories by tier: exactly 72 jobs */
const JOB_CATEGORIES_BY_TIER = {
  1: [{"name": "governor", "criminal_weight": 0.1, "min_age": 30}, {"name": "commander", "criminal_weight": 0.15, "min_age": 28}, {"name": "judge", "criminal_weight": 0.05, "min_age": 40}, {"name": "high_priest", "criminal_weight": 0.05, "min_age": 35}, {"name": "merchant_prince", "criminal_weight": 0.2, "min_age": 35}, {"name": "bureaucrat", "criminal_weight": 0.15, "min_age": 30}, {"name": "diplomat", "criminal_weight": 0.1, "min_age": 35}, {"name": "spymaster", "criminal_weight": 0.5, "min_age": 35}, {"name": "warlord", "criminal_weight": 0.3, "min_age": 30}, {"name": "nobleman", "criminal_weight": 0.2, "min_age": 25}, {"name": "council_member", "criminal_weight": 0.15, "min_age": 40}],
  2: [{"name": "merchant", "criminal_weight": 0.3, "min_age": 20}, {"name": "scholar", "criminal_weight": 0.05, "min_age": 20}, {"name": "healer", "criminal_weight": 0.05, "min_age": 22}, {"name": "engineer", "criminal_weight": 0.05, "min_age": 20}, {"name": "craftmaster", "criminal_weight": 0.1, "min_age": 25}, {"name": "captain", "criminal_weight": 0.2, "min_age": 25}, {"name": "navigator", "criminal_weight": 0.1, "min_age": 20}, {"name": "architect", "criminal_weight": 0.05, "min_age": 25}, {"name": "cartographer", "criminal_weight": 0.05, "min_age": 25}, {"name": "researcher", "criminal_weight": 0.05, "min_age": 22}, {"name": "alchemist", "criminal_weight": 0.15, "min_age": 25}, {"name": "scribe", "criminal_weight": 0.05, "min_age": 18}, {"name": "philosopher", "criminal_weight": 0.05, "min_age": 28}, {"name": "performer", "criminal_weight": 0.1, "min_age": 16}, {"name": "poet", "criminal_weight": 0.1, "min_age": 18}, {"name": "artist", "criminal_weight": 0.05, "min_age": 16}, {"name": "blacksmith", "criminal_weight": 0.1, "min_age": 18}, {"name": "mason", "criminal_weight": 0.08, "min_age": 18}, {"name": "naturalist", "criminal_weight": 0.05, "min_age": 20}, {"name": "astronomer", "criminal_weight": 0.05, "min_age": 22}, {"name": "librarian", "criminal_weight": 0.05, "min_age": 20}, {"name": "weaponsmith", "criminal_weight": 0.15, "min_age": 20}],
  3: [{"name": "soldier", "criminal_weight": 0.2, "min_age": 16}, {"name": "laborer", "criminal_weight": 0.1, "min_age": 14}, {"name": "servant", "criminal_weight": 0.1, "min_age": 12}, {"name": "guard", "criminal_weight": 0.25, "min_age": 16}, {"name": "farmer", "criminal_weight": 0.05, "min_age": 14}, {"name": "carpenter", "criminal_weight": 0.1, "min_age": 14}, {"name": "cook", "criminal_weight": 0.05, "min_age": 14}, {"name": "herder", "criminal_weight": 0.05, "min_age": 12}, {"name": "miller", "criminal_weight": 0.08, "min_age": 14}, {"name": "miner", "criminal_weight": 0.1, "min_age": 16}, {"name": "hunter", "criminal_weight": 0.1, "min_age": 14}, {"name": "fisher", "criminal_weight": 0.08, "min_age": 13}, {"name": "messenger", "criminal_weight": 0.1, "min_age": 12}, {"name": "courier", "criminal_weight": 0.15, "min_age": 14}, {"name": "apprentice", "criminal_weight": 0.1, "min_age": 11}, {"name": "tinker", "criminal_weight": 0.15, "min_age": 14}, {"name": "weaver", "criminal_weight": 0.08, "min_age": 14}, {"name": "tanner", "criminal_weight": 0.12, "min_age": 14}, {"name": "butcher", "criminal_weight": 0.15, "min_age": 14}, {"name": "gardener", "criminal_weight": 0.05, "min_age": 14}, {"name": "medic", "criminal_weight": 0.1, "min_age": 16}, {"name": "muscle", "criminal_weight": 0.6, "min_age": 16}, {"name": "fence", "criminal_weight": 0.8, "min_age": 18}, {"name": "smuggler", "criminal_weight": 0.7, "min_age": 16}, {"name": "paper_boy", "criminal_weight": 0.05, "min_age": 8}, {"name": "stable_hand", "criminal_weight": 0.1, "min_age": 12}, {"name": "shop_assistant", "criminal_weight": 0.08, "min_age": 11}],
  4: [{"name": "beggar", "criminal_weight": 0.15, "min_age": 5}, {"name": "vagrant", "criminal_weight": 0.2, "min_age": 12}, {"name": "thief", "criminal_weight": 1.0, "min_age": 12}, {"name": "extortionist", "criminal_weight": 1.0, "min_age": 16}, {"name": "refugee", "criminal_weight": 0.1, "min_age": 5}, {"name": "outcast", "criminal_weight": 0.2, "min_age": 10}, {"name": "gambler", "criminal_weight": 0.3, "min_age": 16}, {"name": "informant", "criminal_weight": 0.7, "min_age": 14}, {"name": "charlatan", "criminal_weight": 0.9, "min_age": 18}, {"name": "hermit", "criminal_weight": 0.05, "min_age": 30}, {"name": "lookout", "criminal_weight": 0.9, "min_age": 12}, {"name": "street_urchin", "criminal_weight": 0.3, "min_age": 5}]
};

// Load-time assertions for jobs
(function(){
  const counts = [JOB_CATEGORIES_BY_TIER[1].length, JOB_CATEGORIES_BY_TIER[2].length, JOB_CATEGORIES_BY_TIER[3].length, JOB_CATEGORIES_BY_TIER[4].length];
  const total = counts.reduce((a,b)=>a+b,0);
  if (counts[0] !== 11 || counts[1] !== 22 || counts[2] !== 27 || counts[3] !== 12) throw new Error("JOB_CATEGORIES_BY_TIER per-tier counts must be 11/22/27/12");
  if (total !== 72) throw new Error("JOB_CATEGORIES_BY_TIER total must be 72");
  for (const t of [1,2,3,4]){
    for (const j of JOB_CATEGORIES_BY_TIER[t]){
      if (!j || typeof j !== 'object') throw new Error("Invalid job object in tier "+t);
      if (typeof j.name !== 'string') throw new Error("Job.name must be string");
      if (typeof j.criminal_weight !== 'number') throw new Error("Job.criminal_weight must be number");
      if (typeof j.min_age !== 'number') throw new Error("Job.min_age must be number");
    }
  }
})();


/** @typedef {{name:string, criminal_weight:number, min_age:number}} Job */

/**
 * Create a deterministic LCG RNG
 * @param {number} seed0
 * @returns {()=>number} rng in [0,1]
 */
function makeLCG(seed0){
  let s = (seed0|0) & 0x7fffffff;
  return function rng(){
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff; // follows spec
  };
}

/**
 * Deterministic NPC generation
 * @param {number} seed integer seed
 * @param {string} site_id
 * @returns {object} NPC
 */
function generateNPC(seed, site_id){
  const rng = makeLCG(seed|0);
  const sid = String(site_id||"");

  // Tier selection
  const r_tier = rng();
  let tier = 4;
  if (r_tier < 0.05) tier = 1;
  else if (r_tier < 0.25) tier = 2;
  else if (r_tier < 0.90) tier = 3;

  // Age 5..85
  const age = Math.floor(5 + rng()*80);

  // Gender
  const gender = (rng() < 0.5) ? "male" : "female";

  // Job selection
  const pool = JOB_CATEGORIES_BY_TIER[tier] || [];
  const valid = pool.filter(j => age >= j.min_age);
  const placeholder = { name: "unemployed", criminal_weight: 0.0, min_age: 0 };
  const pickFrom = valid.length ? valid : [placeholder];
  const idxJob = Math.min(pickFrom.length-1, Math.floor(rng()*pickFrom.length));
  const job = pickFrom[idxJob];

  // Criminality
  let is_criminal = false;
  if (job.criminal_weight >= 1.0) is_criminal = true;
  else if (job.criminal_weight > 0.0) is_criminal = (rng() < job.criminal_weight);

  // Corruption 0..1
  const r_corr = rng();
  let minC = 0.7, maxC = 1.0;
  if (r_corr < 0.60){ minC = 0.0; maxC = 0.3; }
  else if (r_corr < 0.90){ minC = 0.3; maxC = 0.7; }
  const corruption_level = minC + rng()*(maxC-minC);

  // Traits 1..3 (naive rejection sampling, no duplicates)
  const r_trait = rng();
  let tcount = (r_trait < 0.35) ? 1 : (r_trait < 0.75 ? 2 : 3);
  const traits = [];
  while (traits.length < tcount){
    const idx = Math.min(TRAITS_CATALOG.length-1, Math.floor(rng()*TRAITS_CATALOG.length));
    const tr = TRAITS_CATALOG[idx];
    if (!traits.includes(tr)) traits.push(tr);
  }

  // Wealth tier by social tier
  let wealth_tier = 0;
  if (tier === 1) wealth_tier = Math.floor(7 + rng()*3);
  else if (tier === 2) wealth_tier = Math.floor(5 + rng()*4);
  else if (tier === 3) wealth_tier = Math.floor(2 + rng()*4);
  else wealth_tier = Math.floor(0 + rng()*2);

  // Faction reserved for future politics
const faction_id = null;  // Factions reserved for future politics system
// Player reputation -100..100 (typical -25..+25 as spec)
  const player_reputation = Math.floor((rng() - 0.5) * 50);

  // Home location
  const r_home = rng();
  let home_location = null;
  if (r_home < 0.8) home_location = sid;
  else if (r_home < 0.95) home_location = "wanderer";
  else home_location = null;

  // Position placeholder — uses authoritative L1 grid size
  const _l1w = 128, _l1h = 128; // matches DEFAULTS.L1_SIZE in Engine.js / WorldGen.js
  const position = { mx: 0, my: 0, lx: Math.floor(rng()*_l1w), ly: Math.floor(rng()*_l1h) };

  // Lifecycle timestamps (14 days span)
  const now = new Date();
  const created_at_utc = toISO(now);
  const expires_at_utc = toISO(new Date(now.getTime() + 14*24*3600*1000));

  const id = sid + "#npc_" + (seed|0);

  return {
    id, site_id: sid, age, gender, tier,
    job_category: job.name,
    home_location, faction_id, wealth_tier,
    player_reputation, traits, corruption_level, is_criminal,
    position, state: "active", created_at_utc, expires_at_utc, schedule: null
  };
}

/**
 * Generate a pool of NPCs for a site deterministically from a base seed
 * @param {string} site_id
 * @param {number} count
 * @param {number} baseSeed
 * @returns {Array<object>}
 */
function generateNPCPool(site_id, count, baseSeed){
  const out = [];
  const c = Math.max(0, count|0);
  const base = baseSeed|0;
  for (let i=0;i<c;i++){
    out.push(generateNPC(base + i, site_id));
  }
  return out;
}


module.exports = {
  // v3 exports
  tickAllNPCsGlobally, tickNPCs, regenNPCsOnTurn,
  // v4 additions
  TRAITS_CATALOG, JOB_CATEGORIES_BY_TIER, generateNPC, generateNPCPool
};
