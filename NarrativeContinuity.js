'use strict';
// =============================================================================
// NarrativeContinuity.js — v1.58.0
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
//
// v1.58.0: Diagnostic API added — alert accumulator, rejection reason tracking,
//   entity update/clear tracking, getLastRunDiagnostics() export.
// =============================================================================

const axios = require('axios');

// -----------------------------------------------------------------------------
// DIAGNOSTIC ACCUMULATOR
// Resets every turn via resetDiagnostics(). Hard invariant — index.js calls this
// exactly once per turn before any continuity logic executes.
// No previous_ac_snapshot — delta is computed client-side from narration_debug
// continuity_snapshot fields in turn_history. Single source of truth, no desync.
// -----------------------------------------------------------------------------
let _diagnostics = {
  alerts: [],
  rejection_reason: null,
  entity_updates_applied: [],
  entity_continuity_cleared: []
};

// -----------------------------------------------------------------------------
// resetDiagnostics()
// Hard overwrite — no partial reuse, no fallback state.
// MUST be called exactly once per turn, before checkEviction.
// -----------------------------------------------------------------------------
function resetDiagnostics() {
  _diagnostics = {
    alerts: [],
    rejection_reason: null,
    entity_updates_applied: [],
    entity_continuity_cleared: []
  };
}

// -----------------------------------------------------------------------------
// pushAlert(alert)
// Called by index.js for engine-owned alert events (eviction, name guard).
// Also called internally for Critical-class extraction failures.
// Alert shape: { severity: 'Critical'|'Warning'|'Info', type: string,
//               description: string, entity_ref: string|null, turn: number }
// -----------------------------------------------------------------------------
function pushAlert(alert) {
  _diagnostics.alerts.push(alert);
}

// -----------------------------------------------------------------------------
// getLastRunDiagnostics()
// Returns the full diagnostic accumulator for this turn.
// Called by index.js after extraction+freeze, injected into narration_debug.
// -----------------------------------------------------------------------------
function getLastRunDiagnostics() {
  return {
    alerts: [..._diagnostics.alerts],
    rejection_reason: _diagnostics.rejection_reason,
    entity_updates_applied: [..._diagnostics.entity_updates_applied],
    entity_continuity_cleared: [..._diagnostics.entity_continuity_cleared]
  };
}

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
    "player_locomotion": "REQUIRED string, never null — format: <verb> <direction> OR 'standing still'. Max 3 words. Must reflect resolved movement this turn, not narration tone.",
    "player_physical_state": "REQUIRED string, never null — must be exactly one of: 'moving', 'stationary', 'observing', 'interacting'. No other values permitted.",
    "scene_focus_primary": "string or null — the single entity or location this scene is primarily about. MUST exactly match the key marked 'primary' in scene_focus_tier. Null only if no clear primary focus.",
    "scene_focus_tier": "object — map of entity name to tier string. Exactly one entry must have value 'primary'. Others use 'secondary' or 'background'. Example: {\"Corinne\": \"primary\", \"bartender\": \"secondary\"}. Empty object {} if no entities.",
    "tone": "REQUIRED string, never null — one emotional descriptor + one environmental descriptor, 2–4 words total. Diagnostic only, not prose. Example: 'tense cold', 'uneasy torchlit', 'calm open'.",
    "interaction_mode": "REQUIRED string, never null — one of: 'conversation', 'exploration', 'combat', 'none'",
    "active_interaction": "string or null — max 6–8 words, concrete description only. Must be null if interaction_mode is 'none' or no clear interaction exists.",
    "environment_continuity": "REQUIRED string, never null — max 12–16 words. Physical description only — no mood, no narrative flourish. Must reflect current spatial state, not generic location type. No narrator-invented proper nouns.",
    "unresolved_threads": "array of strings — [] if nothing is unresolved. Max 3 items. Max 10–12 words each. Persistent situational or environmental facts only — not NPC states, not narrative fluff.",
    "spine_scene": "REQUIRED string, never null — 1 to 2 sentences. Must reflect current position after this turn. Must include concrete distinguishing details. Must not default to prior scene description. environment_continuity is the compact physical anchor — spine_scene may expand it but must not contradict it.",
    "spine_atmosphere": "REQUIRED string, never null — exactly 1 sentence. Must include emotional tone and at least one sensory or environmental anchor. Must expand on 'tone', not duplicate it verbatim.",
    "spine_player": "REQUIRED string, never null — exactly 1 sentence. Must reflect current turn outcome. Must not lag behind player_locomotion or player_physical_state."
  },
  "dm_note": "REQUIRED string — Write a 4–6 sentence handoff note for yourself as the next DM. Cover: key NPC states, unresolved tensions, player intent, scene mood. If a previous note is provided above, evolve it forward — do not restart from scratch.",
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
5. unresolved_threads: max 3 items, each max 10–12 words. Persistent situational or environmental facts only — not narrative fluff or NPC states. Use [] if nothing is unresolved.
6. interaction_mode: use 'none' if no active interaction is occurring.
7. Missing any REQUIRED field makes the entire extraction invalid — do not omit them.
8. Do not invent, interpret, or add content not present in the narration.
9. environment_continuity must NOT freeze narrator-invented named entities (buildings, businesses, organizations) not present in the provided site context. If the narration named a building not in the site data, describe the physical setting generically — omit the invented proper noun entirely.
10. entity_updates MUST NOT include is_learned, npc_name, or any identity or social-knowledge fields. Name learning authority belongs to the engine exclusively — do not output these fields in any form.
11. spine_scene: 1–2 sentences. Must reflect current position after this turn. environment_continuity is the compact physical anchor — spine_scene may expand it but must not contradict it. Never null.
12. spine_atmosphere: 1 sentence. Must include emotional tone and at least one sensory/environmental anchor. Must expand on 'tone', not duplicate it. Never null.
13. spine_player: 1 sentence. Must reflect current turn outcome. Must not lag behind player_locomotion or player_physical_state. Never null.
14. spine_player must not contradict player_locomotion or player_physical_state. If spine_player implies a different movement state than player_locomotion or player_physical_state, the extraction is INVALID.
15. environment_continuity is the compact physical anchor; spine_scene may expand it, but must not contradict it (same location, same spatial context).
16. spine_atmosphere may expand 'tone' but must not conflict with it in emotional direction.
17. If interaction_mode is 'none', active_interaction MUST be null. Any non-null value with interaction_mode 'none' makes the extraction INVALID.
18. player_physical_state MUST be exactly one of: 'moving', 'stationary', 'observing', 'interacting'. Any other value makes the extraction INVALID.
19. dm_note MUST be a plain string of 4–6 sentences. Never an object, never an array. Must evolve from the previous note if one was provided — do not start over.`;

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
    // Archive before nulling — memories persist with provenance across layer crossings
    if (!Array.isArray(gameState.world.narrative_memory)) {
      gameState.world.narrative_memory = [];
    }
    const archiveDepth = ac.depth_when_set;
    const siteName = gameState.world.active_site?.name || null;
    const localSpaceName = gameState.world.active_local_space?.name || null;
    let layerLabel;
    if (archiveDepth === 3) layerLabel = `Inside ${ac.local_space_name_when_set || localSpaceName || 'interior'} (L3)`;
    else if (archiveDepth === 2) layerLabel = `Inside ${ac.site_name_when_set || siteName || 'site'} (L2)`;
    else layerLabel = 'Overworld (L0)';
    gameState.world.narrative_memory.push({
      ...ac,
      layer_label: layerLabel,
      site_name_when_set: ac.site_name_when_set || siteName,
      local_space_name_when_set: ac.local_space_name_when_set || localSpaceName
    });
    gameState.world.active_continuity = null;
    const reasonParts = [];
    if (depthMismatch) reasonParts.push('depth');
    if (siteMismatch) reasonParts.push('site');
    if (localSpaceMismatch) reasonParts.push('local_space');
    const reason = reasonParts.join('+');
    console.log(`[CONTINUITY] archived to narrative_memory + evicted (${reason}), total archived: ${gameState.world.narrative_memory.length}`);
    return { evicted: true, reason };
  }

  return { evicted: false, reason: null };
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

  // v1.59.0: Build SPATIAL AUTHORITY prefix — absolute, not advisory
  let spatialAuthorityNote = '';
  if (depth === 1) {
    const _saPos = gameState.world.position;
    const _saCellKey = _saPos ? `LOC:${_saPos.mx},${_saPos.my}:${_saPos.lx},${_saPos.ly}` : null;
    const _saCellSites = (_saCellKey && gameState.world.cells?.[_saCellKey]?.sites) ? gameState.world.cells[_saCellKey].sites : {};
    const _saUnenteredNames = Object.values(_saCellSites).filter(s => !s.entered).map(s => s.name || s.site_id).filter(Boolean).join(', ') || 'none';
    spatialAuthorityNote = `SPATIAL AUTHORITY:\nLayer: L0. Player is OUTDOORS. No site entry confirmed.\nAny interior descriptions in the narration below are narrator errors.\nExtract only outdoor state. Do NOT record interior spatial data.\nStructures visible, NOT entered: ${_saUnenteredNames}`;
  } else if (depth === 2) {
    spatialAuthorityNote = `SPATIAL AUTHORITY:\nLayer: L1 (open site area — ${siteName || siteId}). Player is NOT inside any local space or building.`;
  }

  const prevDmNote = gameState.world.dm_note || null;
  const dmNotePrefix = prevDmNote
    ? `PREVIOUS DM NOTE (evolve this — do not restart):\n${prevDmNote}\n\n`
    : `PREVIOUS DM NOTE: none — this is the first turn, write from scratch.\n\n`;
  const userMessage = `${dmNotePrefix}${spatialAuthorityNote ? spatialAuthorityNote + '\n\n' : ''}NARRATION:\n${narrationText}\n\nCONTEXT:\nLayer depth: ${depth} (1=overworld L0, 2=site interior L1, 3=local space interior L2)\nActive site: ${siteId ? `${siteName || siteId} (id: ${siteId})` : 'none'}\nVisible NPCs: ${npcContext}`;

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
      _diagnostics.rejection_reason = 'empty_response';
      return null;
    }

    // Strip markdown code fences if model emits them despite instructions
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      console.warn('[CONTINUITY] extraction: JSON parse failed:', parseErr.message);
      _diagnostics.rejection_reason = 'json_parse_failed';
      return null;
    }

    // Validate required top-level fields
    const ac = parsed?.active_continuity;
    if (!ac) { console.warn('[CONTINUITY] extraction: missing active_continuity key'); _diagnostics.rejection_reason = 'missing_required_field:active_continuity'; return null; }
    if (!ac.player_locomotion) { console.warn('[CONTINUITY] extraction: missing required player_locomotion'); _diagnostics.rejection_reason = 'missing_required_field:player_locomotion'; return null; }
    if (!ac.player_physical_state) { console.warn('[CONTINUITY] extraction: missing required player_physical_state'); _diagnostics.rejection_reason = 'missing_required_field:player_physical_state'; return null; }
    const VALID_PHYSICAL_STATES = ['moving', 'stationary', 'observing', 'interacting'];
    if (!VALID_PHYSICAL_STATES.includes(ac.player_physical_state)) { console.warn(`[CONTINUITY] extraction: invalid player_physical_state value: "${ac.player_physical_state}"`); _diagnostics.rejection_reason = 'invalid_enum:player_physical_state'; return null; }
    if (!ac.tone) { console.warn('[CONTINUITY] extraction: missing required tone'); _diagnostics.rejection_reason = 'missing_required_field:tone'; return null; }
    if (!ac.interaction_mode) { console.warn('[CONTINUITY] extraction: missing required interaction_mode'); _diagnostics.rejection_reason = 'missing_required_field:interaction_mode'; return null; }
    if (!ac.environment_continuity) { console.warn('[CONTINUITY] extraction: missing required environment_continuity'); _diagnostics.rejection_reason = 'missing_required_field:environment_continuity'; return null; }
    if (!Array.isArray(parsed?.entity_updates)) { console.warn('[CONTINUITY] extraction: missing entity_updates array'); _diagnostics.rejection_reason = 'missing_required_field:entity_updates'; return null; }
    if (!ac.spine_scene)       { console.warn('[CONTINUITY] extraction: missing required spine_scene');       _diagnostics.rejection_reason = 'missing_required_field:spine_scene';       return null; }
    if (!ac.spine_atmosphere)  { console.warn('[CONTINUITY] extraction: missing required spine_atmosphere');  _diagnostics.rejection_reason = 'missing_required_field:spine_atmosphere';  return null; }
    if (!ac.spine_player)      { console.warn('[CONTINUITY] extraction: missing required spine_player');      _diagnostics.rejection_reason = 'missing_required_field:spine_player';      return null; }

    // Cross-field consistency (Rule 17): interaction_mode 'none' requires null active_interaction
    if (ac.interaction_mode === 'none' && ac.active_interaction != null) {
      console.warn(`[CONTINUITY] extraction: active_interaction must be null when interaction_mode is 'none' (value: "${ac.active_interaction}")`);
      _diagnostics.rejection_reason = 'cross_field:active_interaction_with_none_mode';
      return null;
    }

    // Focus integrity: strict reject mode — any mismatch = extraction invalid, return null.
    // scene_focus_primary MUST match the entity keyed 'primary' in scene_focus_tier.
    // No healing: model must output consistent state. Inconsistency surfaces the bug.
    if (ac.scene_focus_tier && typeof ac.scene_focus_tier === 'object') {
      const primaryKey = Object.keys(ac.scene_focus_tier).find(k => ac.scene_focus_tier[k] === 'primary');
      if (primaryKey && ac.scene_focus_primary !== primaryKey) {
        console.warn(`[CONTINUITY] focus integrity mismatch — extraction rejected (scene_focus_primary "${ac.scene_focus_primary}" ≠ tier key "${primaryKey}")`);
        _diagnostics.rejection_reason = 'focus_integrity_mismatch';
        _diagnostics.alerts.push({ severity: 'Critical', type: 'focus_integrity_mismatch', description: `scene_focus_primary "${ac.scene_focus_primary}" ≠ tier key "${primaryKey}"`, entity_ref: null, turn: null });
        return null;
      }
      // Ensure unresolved_threads is always an array
      if (!Array.isArray(ac.unresolved_threads)) {
        ac.unresolved_threads = [];
      }
    }

    // dm_note: warn loudly if missing but do not reject the extraction — fallback handled in freezeContinuityState
    if (!parsed.dm_note || typeof parsed.dm_note !== 'string' || !parsed.dm_note.trim()) {
      console.warn('[CONTINUITY] dm_note: missing or empty in extraction response — previous note will be preserved');
    }
    console.log(`[CONTINUITY] extraction succeeded — entities: ${parsed.entity_updates.length}, dm_note: ${parsed.dm_note ? `${parsed.dm_note.length}ch` : 'MISSING'}`);
    return parsed;

  } catch (err) {
    clearTimeout(timeoutHandle);
    if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
      console.warn('[CONTINUITY] extraction failed (timeout):', err.message);
      _diagnostics.rejection_reason = 'api_timeout';
    } else {
      console.warn('[CONTINUITY] extraction failed:', err.message);
      _diagnostics.rejection_reason = 'api_error';
    }
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

  // Ensure narrative_memory array is initialized
  if (!Array.isArray(gameState.world.narrative_memory)) {
    gameState.world.narrative_memory = [];
  }

  const currentDepth = gameState.world.active_local_space ? 3
    : gameState.world.active_site ? 2
    : 1;
  const turnCount = (gameState.turn_history ? gameState.turn_history.length : 0) + 1;

  // Write active_continuity — inject eviction keys and Phase 2 hooks
  gameState.world.active_continuity = {
    ...extraction.active_continuity,
    depth_when_set: currentDepth,
    site_id_when_set: gameState.world.active_site?.site_id || null,
    site_name_when_set: gameState.world.active_site?.name || null,
    local_space_id_when_set: gameState.world.active_local_space?.local_space_id || null,
    local_space_name_when_set: gameState.world.active_local_space?.name || null,
    turn_when_set: turnCount,
    dialogue_state_ref: null,    // Phase 2 hook — reserved
    rolling_summary_ref: null    // Phase 2 hook — reserved
  };

  // v1.59.0: Hard spatial guard — system layer, not prompt layer.
  // If engine confirms L0 + unentered sites, override interaction fields and
  // environment_continuity regardless of what extraction returned.
  // Kills both the interaction-layer fix AND the environmental frame bleed-through.
  if (currentDepth === 1) {
    const _sgPos = gameState.world.position;
    const _sgCellKey = _sgPos ? `LOC:${_sgPos.mx},${_sgPos.my}:${_sgPos.lx},${_sgPos.ly}` : null;
    const _sgHasUnentered = Object.values(gameState.world.cells?.[_sgCellKey]?.sites || {}).some(s => !s.entered);
    if (_sgHasUnentered) {
      const _ac = gameState.world.active_continuity;
      if (_ac) {
        _ac.interaction_mode = 'none';
        _ac.interaction_status = 'none';
        _ac.active_interaction = null;
        _ac.environment_continuity = null; // strip interior-flavored env frame entirely
        _ac.spine_scene = null;            // prevent interior-flavored scene from entering Packet 1
      }
      console.log('[SPATIAL GUARD] L0+unentered — forced interaction + env_continuity + spine_scene to outdoor defaults');
    }
  }

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
    _diagnostics.entity_updates_applied.push(entry.npc_id);
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
      _diagnostics.entity_continuity_cleared.push(npc.id);
      clearedCount++;
    }
  }

  // Write dm_note verbatim — no modification to content whatsoever.
  // Returns a dm_note_status string so callers can record the outcome in turn metadata:
  //   'updated'           — new note extracted and written this turn
  //   'preserved_missing' — extraction provided no note; previous note retained
  //   'new_game'          — extraction provided no note; no previous note existed (first-turn miss)
  let dm_note_status;
  if (extraction.dm_note && typeof extraction.dm_note === 'string' && extraction.dm_note.trim().length > 0) {
    gameState.world.dm_note = extraction.dm_note;
    dm_note_status = 'updated';
  } else {
    const hadPrevious = !!gameState.world.dm_note;
    dm_note_status = hadPrevious ? 'preserved_missing' : 'new_game';
    console.warn(`[CONTINUITY] dm_note: extraction provided no note — status: ${dm_note_status}`);
  }

  console.log(`[CONTINUITY] Froze active_continuity + ${updatedCount} entity updates, cleared ${clearedCount} stale — dm_note_status: ${dm_note_status}`);
  return { dm_note_status };
}

// -----------------------------------------------------------------------------
// 5a. buildHistoryBlock(gameState, maxTurns)
// Assembles the 50-turn structured history injection block.
// Source: turn_history[n].narration_debug.extraction_packet (post-freeze canonical).
// Non-intelligent assembler: reads, enforces window, preserves chronological order, formats.
// NEVER re-extracts. NEVER mutates stored packets. Assembly = presentation only.
// Fails loudly: every turn missing an extraction_packet is logged with its turn number.
// Returns '' if no valid turns found — new game or pre-v1.66 save.
// -----------------------------------------------------------------------------
function buildHistoryBlock(gameState, maxTurns = 50) {
  const history = gameState.turn_history || [];
  if (history.length === 0) {
    return '';
  }

  const missingTurns = [];
  let validCount = 0;
  for (const turn of history) {
    if (turn.narration_debug?.extraction_packet) {
      validCount++;
    } else {
      missingTurns.push(turn.turn_number ?? '?');
    }
  }

  if (missingTurns.length > 0) {
    console.warn(`[CONTINUITY] buildHistoryBlock: ${missingTurns.length} turn(s) have no extraction_packet — excluded from history block. Turns: ${missingTurns.join(', ')}. Cause: pre-v1.66 save data or extraction failure on those turns.`);
  }

  if (validCount === 0) {
    console.warn('[CONTINUITY] buildHistoryBlock: zero turns with extraction_packet — history block will be empty');
    return '';
  }

  // Filter to valid turns only, then take last maxTurns (already chronological — no sort needed)
  const window = history
    .filter(t => t.narration_debug?.extraction_packet != null)
    .slice(-maxTurns);

  const lines = ['--- CONTINUITY (STRUCTURED) ---', ''];

  for (const turn of window) {
    const p = turn.narration_debug.extraction_packet;
    const tn = turn.turn_number ?? '?';
    lines.push(`[Turn ${tn}]`);
    lines.push(`Locomotion: ${p.player_locomotion || '—'}  Physical State: ${p.player_physical_state || '—'}`);
    const tierEntries = (p.scene_focus_tier && typeof p.scene_focus_tier === 'object')
      ? Object.entries(p.scene_focus_tier).map(([k, v]) => `${k}:${v}`).join(' ')
      : '—';
    lines.push(`Scene Focus: ${p.scene_focus_primary || '—'}  Tier: ${tierEntries}`);
    lines.push(`Tone: ${p.tone || '—'}`);
    lines.push(`Interaction: ${p.interaction_mode || '—'}  Active: ${p.active_interaction || 'none'}`);
    lines.push(`Environment: ${p.environment_continuity || '—'}`);
    const threads = Array.isArray(p.unresolved_threads) && p.unresolved_threads.length > 0
      ? p.unresolved_threads.join(' | ')
      : 'none';
    lines.push(`Threads: ${threads}`);
    if (p.spine_scene)      lines.push(`Scene: ${p.spine_scene}`);
    if (p.spine_atmosphere) lines.push(`Atmosphere: ${p.spine_atmosphere}`);
    if (p.spine_player)     lines.push(`Player: ${p.spine_player}`);
    lines.push('');
  }

  return lines.join('\n');
}

// -----------------------------------------------------------------------------
// 5b. buildDMNoteBlock(gameState)
// Returns the current DM handoff note under a section header.
// The note content is stored and injected VERBATIM — no reformatting, no
// summarization, no modification of any kind. The model reads its own prior
// output byte-for-byte. This is the entire point of the evolving note system.
// Returns '' if dm_note is null (first turn before any extraction).
// -----------------------------------------------------------------------------
function buildDMNoteBlock(gameState) {
  const note = gameState.world.dm_note;
  if (!note) return '';
  return `--- DM HANDOFF NOTES ---\n\n${note}`;
}

// -----------------------------------------------------------------------------
// 5cc. buildContinuityBlock(gameState)
// Renders the full three-section continuity injection block:
//   Section 1 — CONTINUITY (STRUCTURED): 50-turn history from extraction_packet archives
//   Section 2 — DM HANDOFF NOTES: evolving note verbatim from gameState.world.dm_note
//   Section 3 — CURRENT STATE: Scene Spine from active_continuity
// Each section is independently optional — present only when data exists.
// Logs character count and which sections are active every call.
// -----------------------------------------------------------------------------
function buildContinuityBlock(gameState) {
  const sections = [];
  const activeSections = [];

  // Section 1: structured 50-turn history
  const historyBlock = buildHistoryBlock(gameState);
  if (historyBlock) {
    sections.push(historyBlock);
    activeSections.push('history');
  }

  // Section 2: DM handoff note — verbatim, no modification
  const dmBlock = buildDMNoteBlock(gameState);
  if (dmBlock) {
    sections.push(dmBlock);
    activeSections.push('dm_note');
  }

  // Section 3: current state — Scene Spine
  const ac = gameState.world.active_continuity;
  if (ac) {
    if (!ac.spine_scene || !ac.spine_atmosphere || !ac.spine_player) {
      console.log('[CONTINUITY] CURRENT STATE: spine fields absent — Scene Spine skipped (graceful degradation)');
    } else {
      const threads = Array.isArray(ac.unresolved_threads) && ac.unresolved_threads.length > 0
        ? ac.unresolved_threads.join('\n')
        : 'none';
      const spineBlock = [
        '--- CURRENT STATE ---',
        '',
        '[NARRATIVE CONTINUITY — SCENE SPINE]',
        '',
        'Scene:',
        ac.spine_scene,
        '',
        'Atmosphere:',
        ac.spine_atmosphere,
        '',
        'Player:',
        ac.spine_player,
        '',
        'Active Threads:',
        threads,
        '',
        '[Continue from this exact state. Do not reset or generalize the scene.]'
      ].join('\n');
      sections.push(spineBlock);
      activeSections.push('scene_spine');
    }
  }

  if (sections.length === 0) {
    console.log('[CONTINUITY] block: 0 chars (no continuity data)');
    return '';
  }

  const block = sections.join('\n\n');
  console.log(`[CONTINUITY] block: ${block.length} chars (${activeSections.join('+')} — ${sections.length} section(s))`);
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
  buildContinuityBlock,
  resetDiagnostics,
  pushAlert,
  getLastRunDiagnostics
};
