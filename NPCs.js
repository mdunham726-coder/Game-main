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
    //   For now: ensure NPC position defaults to site center if schedule undefined
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

  // DeepSeek owns: npc_name, gender, age, job_category (all null at birth, filled by [NPC-FILL])
  // Advance RNG state for determinism (consumed slots previously used by tier/age/gender/job/criminality/corruption)
  rng(); // slot: tier
  rng(); // slot: age
  rng(); // slot: gender
  rng(); // slot: job
  rng(); // slot: criminality
  rng(); // slot: corruption r_corr
  rng(); // slot: corruption value

  // Traits 2..4 (naive rejection sampling, no duplicates)
  const r_trait = rng();
  const tcount = (r_trait < 0.50) ? 2 : (r_trait < 0.85 ? 3 : 4);
  const traits = [];
  while (traits.length < tcount){
    const idx = Math.min(TRAITS_CATALOG.length-1, Math.floor(rng()*TRAITS_CATALOG.length));
    const tr = TRAITS_CATALOG[idx];
    if (!traits.includes(tr)) traits.push(tr);
  }

  // Player reputation 0-100 (50 = neutral; generated range 40-60)
  rng(); // slot: wealth_tier
  const reputation_player = Math.floor(40 + rng() * 20);

  // Position placeholder — uses authoritative L1 grid size
  rng(); // slot: home_location
  const _l1w = 128, _l1h = 128; // matches DEFAULTS.L1_SIZE in Engine.js / WorldGen.js
  const position = { mx: 0, my: 0, lx: Math.floor(rng()*_l1w), ly: Math.floor(rng()*_l1h) };

  const id = sid + "#npc_" + (seed|0);

  return {
    id, site_id: sid,
    reputation_player, traits,
    npc_name: null, gender: null, age: null, job_category: null,
    is_learned: false,
    player_recognition: null,  // v1.85.19: {recognizes_player, known_identity, learned_turn, source} — set by Arbiter only
    object_capture_turn: null, // v1.85.28: turn on which NPC's held/worn objects were first materialized as ObjectRecords; null = never captured (eligible for capture on first visible turn with extracted objects)
    position,
    attributes: {}  // ContinuityBrain: promoted facts (physical_attributes, observable_states, held_objects, worn_objects)
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
  TRAITS_CATALOG, generateNPC, generateNPCPool
};
