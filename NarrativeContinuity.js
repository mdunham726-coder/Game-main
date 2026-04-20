'use strict';
// =============================================================================
// NarrativeContinuity.js — v1.56.0
// =============================================================================
// Owner of all narrative continuity logic.
// index.js is a consumer only — it calls these functions but owns nothing here.
//
// Architecture — three domains:
//   World Truth         → engine-owned (gameState.world)
//   Narrative Continuity → this module (gameState.world.active_continuity + npc.narrative_state)
//   Narrative Output    → LLM prose (expressive, not authoritative)
//
// Phase 1 scope: Active Continuity + Entity Continuity
// Phase 2 hooks: dialogue_state_ref, rolling_summary_ref (reserved null in schema)
// =============================================================================

const axios = require('axios');

// -----------------------------------------------------------------------------
// EXTRACTION SYSTEM PROMPT
// Defines the schema for the extraction call. Injected as system role message.
// Temperature 0.1 — deterministic extraction, not creative generation.
// This is NOT a summarizer. It is a schema-targeted extraction of persistence-
// relevant facts only. Missing required fields = invalid extraction = null return.
// -----------------------------------------------------------------------------
const EXTRACTION_SYSTEM_PROMPT = `You are a continuity extraction engine for an interactive narrative game. Your sole task is to extract persistence-relevant facts from a narration turn into a structured JSON schema.

You are NOT summarizing. You are NOT interpreting. You are extracting specific observable facts stated or clearly implied in the narration.

Return ONLY valid JSON matching the exact schema below. No markdown. No explanation. No commentary. No code blocks. Raw JSON only.

REQUIRED OUTPUT SCHEMA:
{
  "active_continuity": {
    "player_locomotion": "REQUIRED string, never null — exact locomotion described: 'walking south', 'standing still', 'running north', 'driving', 'crouching', etc.",
    "player_physical_state": "REQUIRED string, never null — overall physical state: 'moving', 'stationary', 'interacting', 'fleeing', etc.",
    "scene_focus_primary": "string or null — the single entity or location this scene is primarily about. MUST exactly match the key marked 'primary' in scene_focus_tier. Null only if no clear primary focus.",
    "scene_focus_tier": "object — map of entity name to tier string. Exactly one entry must have value 'primary'. Others use 'secondary' or 'background'. Example: {\"Corinne\": \"primary\", \"bartender\": \"secondary\"}. Empty object {} if no entities.",
    "tone": "REQUIRED string, never null — current emotional/atmospheric tone: 'tense', 'casual', 'ominous', 'tense and controlled', 'hostile', 'warm', etc.",
    "interaction_mode": "REQUIRED string, never null — one of: 'conversation', 'exploration', 'combat', 'none'",
    "interaction_status": "REQUIRED string, never null — one of: 'active', 'concluded', 'none'",
    "active_interaction": "string or null — brief factual description of the active interaction if any. Null if interaction_mode is 'none'.",
    "environment_continuity": "REQUIRED string, never null — concise factual description of the specific environment the player occupies right now. Prefer generic descriptive language ('small concrete building off the road', 'open dirt road through sparse terrain') over narrator-invented proper nouns. If the narration introduced a named building, business, or organization not found in the provided site context, omit that proper noun and describe the physical setting only.",
    "unresolved_threads": "array of strings — [] if nothing is unresolved. Max 3 items. Max 15 words each. Only genuinely unresolved narrative elements."
  },
  "entity_updates": [
    {
      "npc_id": "string — exact NPC id from the context provided",
      "narrative_state": {
        "wearing": "string or null — ONLY if clothing/attire is explicitly described in the narration. Null otherwise.",
        "holding": "string or null — ONLY if a held item is explicitly described. Null otherwise.",
        "posture": "string or null — ONLY if posture or stance is explicitly described. Null otherwise.",
        "activity": "string or null — ONLY if a specific activity is explicitly described. Null otherwise.",
        "relative_position": "string or null — ONLY if position relative to player is explicitly described. Null otherwise.",
        "emotional_state": "string or null — ONLY if emotional state is explicitly described. Null otherwise.",
        "last_seen_turn": 0
      }
    }
  ]
}

CRITICAL RULES:
1. scene_focus_primary MUST equal the key marked 'primary' in scene_focus_tier. If they conflict, the extraction is INVALID — do not attempt to reconcile them. Output a consistent, non-conflicting scene_focus_primary that matches your tier map from the start.
2. Exactly one entity in scene_focus_tier must have value 'primary'. No more. No less. (Unless scene_focus_tier is empty {}, in which case scene_focus_primary must be null.)
3. entity_updates: include ONLY NPCs explicitly described or present in the narration. Do not include NPCs not mentioned.
4. All narrative_state fields (wearing, holding, posture, activity, relative_position, emotional_state): set to null if not explicitly stated in the narration. Do not infer or guess.
5. unresolved_threads: max 3 items, each max 15 words. Use [] if nothing is unresolved.
6. interaction_mode and interaction_status: use 'none' if no active interaction is occurring.
7. Missing any REQUIRED field makes the entire extraction invalid — do not omit them.
8. Do not invent, interpret, or add content not present in the narration.
9. environment_continuity must NOT freeze narrator-invented named entities (buildings, businesses, organizations) not present in the provided site context. If the narration named a building not in the site data, describe the physical setting generically — omit the invented proper noun entirely.
10. entity_updates MUST NOT include is_learned, npc_name, or any identity or social-knowledge fields. Name learning authority belongs to the engine exclusively — do not output these fields in any form.`;

// -----------------------------------------------------------------------------
// 1. initContinuityState(gameState)
// Sets active_continuity to null on gameState.world.
// Called once at startup and on world reset.
// -----------------------------------------------------------------------------
function initContinuityState(gameState) {
  gameState.world.active_continuity = null;
}

// -----------------------------------------------------------------------------
// 2. checkEviction(gameState)
// Compares active_continuity eviction keys against live engine state.
// Evicts (sets active_continuity to null) on:
//   - depth change (e.g. L1 → L2 or L2 → L1)
//   - site identity change (entering a different site, or leaving a site entirely)
//   - local_space identity change (entering a different room/building)
// Does NOT evict on:
//   - L0 cell-to-cell traversal (site_id remains null, depth remains 1)
// Returns { evicted: boolean }
// -----------------------------------------------------------------------------
function checkEviction(gameState) {
  const ac = gameState.world.active_continuity;
  if (!ac) return { evicted: false };

  const currentDepth = gameState.world.active_local_space ? 3
    : gameState.world.active_site ? 2
    : 1;
  const currentSiteId = gameState.world.active_site?.site_id || null;
  const currentLocalSpaceId = gameState.world.active_local_space?.local_space_id || null;

  const depthMismatch = ac.depth_when_set !== currentDepth;
  const siteMismatch = ac.site_id_when_set !== currentSiteId;
  const localSpaceMismatch = ac.local_space_id_when_set !== currentLocalSpaceId;

  if (depthMismatch || siteMismatch || localSpaceMismatch) {
    gameState.world.active_continuity = null;
    console.log(`[CONTINUITY] evicted (depth:${depthMismatch}, site:${siteMismatch}, ls:${localSpaceMismatch})`);
    return { evicted: true };
  }

  return { evicted: false };
}

// -----------------------------------------------------------------------------
// 3. runContinuityExtraction(narrationText, gameState)  [async]
// Second DeepSeek call — separate from narration call, dedicated to extraction.
// Temperature 0.1 for deterministic schema-targeted output.
// 30s timeout (extraction is fast — short input, structured output).
// On any failure: console.warn + return null (turn never blocked).
// Returns: { active_continuity: {...}, entity_updates: [...] } or null
// -----------------------------------------------------------------------------
async function runContinuityExtraction(narrationText, gameState) {
  const depth = gameState.world.active_local_space ? 3
    : gameState.world.active_site ? 2
    : 1;
  const siteId = gameState.world.active_site?.site_id || null;
  const siteName = gameState.world.active_site?.name || null;

  const visibleNpcs = depth === 3
    ? (gameState.world.active_local_space?._visible_npcs || [])
    : depth === 2
    ? (gameState.world.active_site?._visible_npcs || [])
    : [];

  const npcContext = visibleNpcs.length > 0
    ? visibleNpcs.map(n => `${n.id} (${n.is_learned ? n.npc_name : (n.job_category || 'unknown')})`).join(', ')
    : 'none';

  const userMessage = `NARRATION:\n${narrationText}\n\nCONTEXT:\nLayer depth: ${depth} (1=overworld L0, 2=site interior L1, 3=local space interior L2)\nActive site: ${siteId ? `${siteName || siteId} (id: ${siteId})` : 'none'}\nVisible NPCs: ${npcContext}`;

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await axios.post('https://api.deepseek.com/v1/chat/completions', {
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
        { role: 'user', content: userMessage }
      ],
      temperature: 0.1
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000,
      signal: controller.signal
    });

    clearTimeout(timeoutHandle);

    const raw = response?.data?.choices?.[0]?.message?.content;
    if (!raw) {
      console.warn('[CONTINUITY] extraction: empty response from API');
      return null;
    }

    // Strip markdown code fences if model emits them despite instructions
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      console.warn('[CONTINUITY] extraction: JSON parse failed:', parseErr.message);
      return null;
    }

    // Validate required top-level fields
    const ac = parsed?.active_continuity;
    if (!ac) { console.warn('[CONTINUITY] extraction: missing active_continuity key'); return null; }
    if (!ac.player_locomotion) { console.warn('[CONTINUITY] extraction: missing required player_locomotion'); return null; }
    if (!ac.player_physical_state) { console.warn('[CONTINUITY] extraction: missing required player_physical_state'); return null; }
    if (!ac.tone) { console.warn('[CONTINUITY] extraction: missing required tone'); return null; }
    if (!ac.interaction_mode) { console.warn('[CONTINUITY] extraction: missing required interaction_mode'); return null; }
    if (!ac.interaction_status) { console.warn('[CONTINUITY] extraction: missing required interaction_status'); return null; }
    if (!ac.environment_continuity) { console.warn('[CONTINUITY] extraction: missing required environment_continuity'); return null; }
    if (!Array.isArray(parsed?.entity_updates)) { console.warn('[CONTINUITY] extraction: missing entity_updates array'); return null; }

    // Focus integrity: strict reject mode — any mismatch = extraction invalid, return null.
    // scene_focus_primary MUST match the entity keyed 'primary' in scene_focus_tier.
    // No healing: model must output consistent state. Inconsistency surfaces the bug.
    if (ac.scene_focus_tier && typeof ac.scene_focus_tier === 'object') {
      const primaryKey = Object.keys(ac.scene_focus_tier).find(k => ac.scene_focus_tier[k] === 'primary');
      if (primaryKey && ac.scene_focus_primary !== primaryKey) {
        console.warn(`[CONTINUITY] focus integrity mismatch — extraction rejected (scene_focus_primary "${ac.scene_focus_primary}" ≠ tier key "${primaryKey}")`);
        return null;
      }
      // Ensure unresolved_threads is always an array
      if (!Array.isArray(ac.unresolved_threads)) {
        ac.unresolved_threads = [];
      }
    }

    console.log(`[CONTINUITY] extraction succeeded — entities: ${parsed.entity_updates.length}`);
    return parsed;

  } catch (err) {
    clearTimeout(timeoutHandle);
    console.warn('[CONTINUITY] extraction failed:', err.message);
    return null;
  }
}

// -----------------------------------------------------------------------------
// 4. freezeContinuityState(extraction, gameState)
// Writes the extraction result into gameState.
// - active_continuity: written with eviction keys injected
// - npc.narrative_state: written per entity_updates entry
// - EPHEMERAL RULE: narrative_state cleared (to null) for visible NPCs absent
//   from entity_updates. It is scene-scoped continuity data, NOT persistent
//   canonical NPC state. It does not accumulate.
// Graceful degrade: if extraction is null, returns immediately — turn never fails.
// -----------------------------------------------------------------------------
function freezeContinuityState(extraction, gameState) {
  if (!extraction) return;

  const currentDepth = gameState.world.active_local_space ? 3
    : gameState.world.active_site ? 2
    : 1;
  const turnCount = (gameState.turn_history ? gameState.turn_history.length : 0) + 1;

  // Write active_continuity — inject eviction keys and Phase 2 hooks
  gameState.world.active_continuity = {
    ...extraction.active_continuity,
    depth_when_set: currentDepth,
    site_id_when_set: gameState.world.active_site?.site_id || null,
    local_space_id_when_set: gameState.world.active_local_space?.local_space_id || null,
    turn_when_set: turnCount,
    dialogue_state_ref: null,    // Phase 2 hook — reserved
    rolling_summary_ref: null    // Phase 2 hook — reserved
  };

  // Write narrative_state per entity_updates entry
  const allNpcs = gameState.world.active_site?.npcs || [];
  const updatedIds = new Set();
  let updatedCount = 0;
  let clearedCount = 0;

  for (const entry of (extraction.entity_updates || [])) {
    if (!entry?.npc_id) continue;
    const npc = allNpcs.find(n => n.id === entry.npc_id);
    if (!npc) {
      console.warn(`[CONTINUITY] entity update: npc id "${entry.npc_id}" not found in site registry`);
      continue;
    }
    npc.narrative_state = {
      wearing: entry.narrative_state?.wearing || null,
      holding: entry.narrative_state?.holding || null,
      posture: entry.narrative_state?.posture || null,
      activity: entry.narrative_state?.activity || null,
      relative_position: entry.narrative_state?.relative_position || null,
      emotional_state: entry.narrative_state?.emotional_state || null,
      last_seen_turn: turnCount
    };
    updatedIds.add(entry.npc_id);
    updatedCount++;
  }

  // Ephemerality: clear narrative_state for visible NPCs NOT in entity_updates
  // If the extractor did not mention an NPC, their state does not persist
  const visibleNpcs = currentDepth === 3
    ? (gameState.world.active_local_space?._visible_npcs || [])
    : currentDepth === 2
    ? (gameState.world.active_site?._visible_npcs || [])
    : [];

  for (const npc of visibleNpcs) {
    if (!updatedIds.has(npc.id) && npc.narrative_state !== undefined) {
      npc.narrative_state = null;
      clearedCount++;
    }
  }

  console.log(`[CONTINUITY] Froze active_continuity + ${updatedCount} entity updates, cleared ${clearedCount} stale`);
}

// -----------------------------------------------------------------------------
// 5. buildContinuityBlock(gameState)
// Renders active_continuity as a structured, labeled, deterministic block for
// injection into the narration prompt immediately after LAYER CONSTRAINT.
// NOT prose. NOT raw JSON. Section headers, colon-separated fields, null fields
// omitted entirely.
// Returns '' if active_continuity is null (no continuity to inject).
// Logs block character length every call for future cap calibration.
// -----------------------------------------------------------------------------
function buildContinuityBlock(gameState) {
  const ac = gameState.world.active_continuity;
  if (!ac) return '';

  const lines = ['[NARRATIVE CONTINUITY]', ''];

  // Scene Focus section
  const sfLines = [];
  if (ac.scene_focus_primary) {
    sfLines.push(`- Primary: ${ac.scene_focus_primary}`);
  }
  if (ac.scene_focus_tier && typeof ac.scene_focus_tier === 'object') {
    const secondaries = Object.entries(ac.scene_focus_tier)
      .filter(([, tier]) => tier === 'secondary')
      .map(([name]) => name);
    if (secondaries.length > 0) {
      sfLines.push(`- Secondary: ${secondaries.join(', ')}`);
    }
  }
  if (ac.environment_continuity) {
    sfLines.push(`- Location: ${ac.environment_continuity}`);
  }
  if (sfLines.length > 0) {
    lines.push('Scene Focus:');
    lines.push(...sfLines);
    lines.push('');
  }

  // Player State section
  const psLines = [];
  if (ac.player_locomotion) psLines.push(`- Locomotion: ${ac.player_locomotion}`);
  if (ac.player_physical_state) psLines.push(`- Physical state: ${ac.player_physical_state}`);
  if (psLines.length > 0) {
    lines.push('Player State:');
    lines.push(...psLines);
    lines.push('');
  }

  // Interaction section
  const intLines = [];
  if (ac.interaction_mode && ac.interaction_mode !== 'none') {
    intLines.push(`- Mode: ${ac.interaction_mode} (${ac.interaction_status || 'unknown'})`);
  }
  if (ac.tone) intLines.push(`- Tone: ${ac.tone}`);
  if (ac.active_interaction) intLines.push(`- Active: ${ac.active_interaction}`);
  if (Array.isArray(ac.unresolved_threads) && ac.unresolved_threads.length > 0) {
    for (const thread of ac.unresolved_threads) {
      intLines.push(`- Unresolved: ${thread}`);
    }
  }
  if (intLines.length > 0) {
    lines.push('Interaction:');
    lines.push(...intLines);
    lines.push('');
  }

  // Entity State sections — one per visible NPC with narrative_state
  const visibleNpcs = gameState.world.active_local_space
    ? (gameState.world.active_local_space._visible_npcs || [])
    : gameState.world.active_site
    ? (gameState.world.active_site._visible_npcs || [])
    : [];

  for (const npc of visibleNpcs) {
    if (!npc.narrative_state) continue;
    const ns = npc.narrative_state;
    const hasAnyField = ns.wearing || ns.holding || ns.posture || ns.activity || ns.relative_position || ns.emotional_state;
    if (!hasAnyField) continue;

    const label = (npc.is_learned && npc.npc_name) ? npc.npc_name : (npc.job_category || npc.id);
    const entityLines = [];
    if (ns.wearing) entityLines.push(`  - Wearing: ${ns.wearing}`);
    if (ns.holding) entityLines.push(`  - Holding: ${ns.holding}`);
    if (ns.posture) entityLines.push(`  - Posture: ${ns.posture}`);
    if (ns.activity) entityLines.push(`  - Activity: ${ns.activity}`);
    if (ns.relative_position) entityLines.push(`  - Position: ${ns.relative_position}`);
    if (ns.emotional_state) entityLines.push(`  - Emotional state: ${ns.emotional_state}`);

    if (entityLines.length > 0) {
      lines.push(`Entity State (${label}):`);
      lines.push(...entityLines);
      lines.push('');
    }
  }

  lines.push('[Do NOT reintroduce the scene. Do NOT change established details. Continue from this state.]');

  const block = lines.join('\n');
  console.log(`[CONTINUITY] block: ${block.length} chars`);
  return block;
}

// -----------------------------------------------------------------------------
// EXPORTS
// index.js is a consumer only. All continuity logic lives here.
// -----------------------------------------------------------------------------
module.exports = {
  initContinuityState,
  checkEviction,
  runContinuityExtraction,
  freezeContinuityState,
  buildContinuityBlock
};
