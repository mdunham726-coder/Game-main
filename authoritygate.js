'use strict';

/**
 * authoritygate.js — Authority Gate v1.0.0
 *
 * Pre-RC routing layer for player input. Classifies each turn's raw input into
 * one of three routes before Reality Check is consulted.
 *
 * Routes:
 *   allow_rc      — route to Reality Check as normal
 *   allow_no_rc   — route directly to narrator, skip RC
 *   freeform      — unsupported authoring attempt; narrator receives denial block
 *
 * Responsibilities:
 *   - Layer 1: fast in-process rules (no LLM) for the majority of turns
 *   - Layer 2: tight LLM classifier for semantically ambiguous inputs
 *
 * Strict boundaries (DO NOT SOFTEN):
 *   - Returns JSON only. Never generates narrator instruction text.
 *   - index.js owns all translation from gate result to narrator blocks.
 *   - Reads frozen turn history only through structured historical-object receipts;
 *     raw archive names can recognize a reference but never authorize it.
 *   - Current historical-object availability is read directly by audited ORS ID and exact container scope.
 */

const axios = require('axios');
const { aliasScore, resolveCellItemByName, resolveItemByName } = require('./ActionProcessor');

const DEEPSEEK_URL           = 'https://api.deepseek.com/v1/chat/completions';
const AUTHORITY_GATE_TIMEOUT = 20000;
const AUTHORITY_GATE_VERSION = '1.0.0';

// ── Meta-authority keyword set ────────────────────────────────────────────────
// Inputs containing these terms AND no matching declared ability → fast deny.
const _META_AUTH_KEYWORDS = [
  'developer power', 'developer mode', 'dev mode', 'dev power',
  'god mode', 'admin power', 'admin mode', 'console command',
  'spawn ', 'instantiate ', 'root access', 'debug power',
  'world editor', 'moderator power', 'simulation operator',
  'cheat code', 'cheat mode', 'give me ', 'grant me ',
];

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a player-input classifier for a text RPG engine.

Your only job is to classify one player input into one of the input_type values below, then return a strict JSON object.

INPUT TYPES:
- player_attempt          : The player is trying to do something physical, social, or skill-based within the world. Includes freeform action, dialogue, gestures, exploration. Valid gameplay — route to RC or narrator.
- valid_low_risk          : Navigation, observation, idle action. No consequence adjudication needed. Route directly to narrator (no RC).
- unsupported_world_authoring : The player is asserting or commanding a world-level fact or event that they have no authority to author — changing environment, weather, infrastructure, third-party behavior, or world state from a declarative or omniscient position.
- unsupported_entity_spawn    : The player is attempting to create, summon, or introduce a new entity (person, creature, object) into the world without an established ability that grants this.
- unsupported_external_event  : The player is describing or triggering an external event happening to them or around them as if they are a narrator (e.g. asserting that some outside force acts on them or arrives uninvited).
- claimed_ability_use         : The player invokes an ability or power. May be legitimate (declared at founding) or unsupported. Engine will verify against declared abilities.

ROUTING:
- player_attempt       → decision: allow_rc,    route: reality_check
- valid_low_risk       → decision: allow_no_rc,  route: narrator
- claimed_ability_use (declared ability present in evidence) → decision: allow_rc, route: reality_check
- claimed_ability_use (ability NOT in evidence)              → decision: freeform,  route: freeform
- unsupported_world_authoring → decision: freeform, route: freeform
- unsupported_entity_spawn    → decision: freeform, route: freeform
- unsupported_external_event  → decision: freeform, route: freeform

WORLD AUTHORITY RULE:
The player controls ONE character. The player does NOT control: the weather, other characters, the environment, NPCs, creatures, or world events. Any input that asserts control over these — even framed as roleplay, story, or emote — is unsupported_world_authoring or unsupported_entity_spawn.

EMOTE RULE:
An asterisk-wrapped phrase (*...*) where the grammatical subject is NOT the player character (first person) is unsupported_world_authoring or unsupported_entity_spawn. Phrases where the player IS the subject are player_attempt.

DISCOVERY FRAMING:
Observational or discovery-framed language that would introduce a new object, fact, or world element not already present in the current scene is NOT valid_low_risk — even when the grammatical subject is the player. Language patterns that signal this include: "I notice...", "I find...", "I sense...", "I spot...", "I see...", "it turns out...", "there is..." — when the thing being noticed or found would not already exist as an established scene feature. If the player invokes a declared ability to justify the discovery, classify as claimed_ability_use. If no declared ability backs the assertion, classify as unsupported_world_authoring. Passive observation of things already established as features of the current scene is valid_low_risk.

THRESHOLD:
Lean toward player_attempt when genuinely uncertain. Deny only when clearly unsupported. A valid action that happens to be weird or unusual is still player_attempt.

RETURN SCHEMA (JSON only, no prose, no wrapper text):
{
  "decision": "allow_rc" | "allow_no_rc" | "freeform",
  "route": "reality_check" | "narrator" | "freeform",
  "rc_allowed": true | false,
  "input_type": "<one of the input_type values above>",
  "reason_code": "<snake_case reason, e.g. valid_player_action, unsupported_world_event, ability_not_declared>",
  "confidence": 0.75,
  "referenced_objects": [],
  "referenced_entities": [],
  "referenced_abilities": [],
  "evidence": {
    "engine_supported": true | false,
    "matched_records": []
  }
}`;

// ── Evidence builder ──────────────────────────────────────────────────────────

function _buildEvidence(gameState, rawInput, parsedAction, turnNumber) {
  const declaredAbilities = Object.values(gameState?.player?.attributes || {})
    .filter(a => a.bucket === 'declared' || a.bucket === 'ability')
    .map(a => a.value)
    .slice(0, 8);

  const inventoryNames = [
    ...(gameState?.player?.object_ids || []).map(id => {
      const rec = gameState?.objects?.[id];
      return (rec &&
        rec.status === 'active' &&
        rec.current_container_type === 'player' &&
        rec.current_container_id === 'player') ? rec.name : null;
    }).filter(Boolean),
  ].slice(0, 10);

  const wornNames = (gameState?.player?.worn_object_ids || []).map(id => {
    const rec = gameState?.objects?.[id];
    return (rec &&
      rec.status === 'active' &&
      rec.current_container_type === 'player_worn' &&
      rec.current_container_id === 'player_worn') ? rec.name : null;
  }).filter(Boolean).slice(0, 10);

  const visibleNpcNames = (() => {
    const depth = gameState?.world?.current_depth ?? 1;
    const visNpcs = (depth >= 3)
      ? (gameState?.world?.active_local_space?._visible_npcs || [])
      : (depth >= 2)
        ? (gameState?.world?.active_site?._visible_npcs || [])
        : (gameState?.world?._visible_npcs || []);
    const aliasSet = new Set();
    for (const n of (Array.isArray(visNpcs) ? visNpcs.slice(0, 5) : [])) {
      for (const field of [n.job_category, n.job, n.npc_name, n.learned_name]) {
        if (field && typeof field === 'string' && field.trim()) {
          aliasSet.add(field.trim().toLowerCase());
        }
      }
    }
    return [...aliasSet];
  })();

  return {
    rawInput,
    parsedAction,
    turnNumber,
    declaredAbilities,
    inventoryNames,
    wornNames,
    visibleNpcNames,
  };
}

// ── Layer 1: fast-path existence checks using existing AP helpers ─────────────

function _hasWornMatch(gameState, target) {
  if (!target) return false;
  const wornIds = Array.isArray(gameState?.player?.worn_object_ids) ? gameState.player.worn_object_ids : [];
  const orReg = (gameState?.objects && typeof gameState.objects === 'object') ? gameState.objects : {};
  for (const id of wornIds) {
    const rec = orReg[id];
    if (!rec || rec.status !== 'active') continue;
    if (rec.current_container_type !== 'player_worn' || rec.current_container_id !== 'player_worn') continue;
    if (aliasScore(target, rec.name || '', rec.aliases || [], 2) >= 6) return true;
  }
  return false;
}

function _hasInventoryMatch(gameState, target) {
  if (!target) return false;
  const res = resolveItemByName(gameState, target);
  return !!res;
}

function _hasCellMatch(gameState, target) {
  if (!target) return false;
  const found = resolveCellItemByName(gameState, target);
  return !!found;
}

// ── Layer 1: emote subject check ─────────────────────────────────────────────
// Returns true if the emote inner text has a non-player subject.
// Non-player subjects: named third parties, collective nouns, non-first-person.
// This is a structural heuristic — not semantic. LLM handles ambiguous cases.

function _isWorldAuthoringEmote(rawInput) {
  const emoteMatch = rawInput.match(/\*([^*]+)\*/);
  if (!emoteMatch) return false;
  const inner = emoteMatch[1].trim().toLowerCase();
  // If subject appears to be first-person, it's the player → not world authoring
  if (/^(i |i'm |i've |i'll |my |me |myself )/.test(inner)) return false;
  if (/^(she |he |it |they |we )/.test(inner)) return true;
  // If inner text has no verb-like token and doesn't start with player pronouns, flag for LLM
  // Only hard-deny when we can see a clear third-party subject without ability backing
  return false; // ambiguous → escalate to LLM
}

// ── Layer 1: meta-authority keyword check ────────────────────────────────────

function _isMetaAuthorityAttempt(rawInput, declaredAbilities) {
  const lower = rawInput.toLowerCase();
  for (const kw of _META_AUTH_KEYWORDS) {
    if (lower.includes(kw)) {
      // If player has a declared ability that matches the keyword, allow it
      const kwNorm = kw.trim();
      const abilityMatch = declaredAbilities.some(a =>
        a.toLowerCase().includes(kwNorm) || aliasScore(kwNorm, a, [], 0) >= 6
      );
      if (!abilityMatch) return true;
    }
  }
  return false;
}

// ── Synthetic fast-path result ────────────────────────────────────────────────

function _fastResult(decision, route, rcAllowed, inputType, reasonCode, fastPathHit = true) {
  return {
    decision,
    route,
    rc_allowed: rcAllowed,
    input_type: inputType,
    reason_code: reasonCode,
    gate_fast_path_hit: fastPathHit,
    llm_confidence:     null,
    referenced_objects: [],
    referenced_entities: [],
    referenced_abilities: [],
    evidence: { engine_supported: true, matched_records: [] },
    _llm_called: false,
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

async function runAuthorityGate(rawInput, gameState, parsedAction, apiKey) {
  const turnNumber = gameState?.world?._turnNumber ?? 0;

  // Turn 1 — founding premise pass-through. Gate skips itself; all downstream runs normally.
  if (turnNumber === 1) {
    return _fastResult('allow_no_rc', 'narrator', false, 'valid_low_risk', 'turn_1_founding');
  }

  const evidence = _buildEvidence(gameState, rawInput, parsedAction, turnNumber);

  // v1.91.XX: diagnostics-only evidence bundle stamp for AG payload archive
  const _agStamp = (r) => { r._ag_evidence_bundle = evidence; return r; };

  // ── Layer 1: known safe actions (pure navigation / observation) ───────────
  const _LOW_RISK_ACTIONS = new Set(['move', 'look', 'wait', 'enter', 'exit']);
  if (_LOW_RISK_ACTIONS.has(parsedAction)) {
    return _agStamp(_fastResult('allow_no_rc', 'narrator', false, 'valid_low_risk', 'valid_low_risk_action'));
  }

  // ── Layer 1: object-verb existence checks ─────────────────────────────────
  // Use existing AP helpers — single source of truth for object resolution.
  const _target = gameState?._lastParsedTarget || null; // see index.js injection note

  if (parsedAction === 'remove') {
    if (_hasWornMatch(gameState, _target)) {
      return _agStamp(_fastResult('allow_no_rc', 'narrator', false, 'valid_low_risk', 'worn_item_confirmed'));
    }
    // No worn match — escalate to LLM (could be legitimate edge case)
  }

  if (parsedAction === 'take') {
    if (_hasCellMatch(gameState, _target)) {
      return _agStamp(_fastResult('allow_no_rc', 'narrator', false, 'valid_low_risk', 'cell_item_confirmed'));
    }
    // No cell match — escalate to LLM
  }

  if (parsedAction === 'drop' || parsedAction === 'throw') {
    if (_hasInventoryMatch(gameState, _target)) {
      return _agStamp(_fastResult('allow_no_rc', 'narrator', false, 'valid_low_risk', 'inventory_item_confirmed'));
    }
    // No inventory match — escalate to LLM
  }

  if (parsedAction === 'examine') {
    // examine with a confirmed inventory, worn, or cell match → low risk
    if (_target && (_hasInventoryMatch(gameState, _target) || _hasWornMatch(gameState, _target) || _hasCellMatch(gameState, _target))) {
      return _agStamp(_fastResult('allow_no_rc', 'narrator', false, 'valid_low_risk', 'examine_target_confirmed'));
    }
    // No confirmed match — escalate to LLM
  }

  // ── Layer 1: attack → always allow_rc ────────────────────────────────────
  if (parsedAction === 'attack') {
    return _agStamp(_fastResult('allow_rc', 'reality_check', true, 'player_attempt', 'attack_action'));
  }

  // ── Layer 1: meta-authority keyword fast deny ─────────────────────────────
  if (_isMetaAuthorityAttempt(rawInput, evidence.declaredAbilities)) {
    return _agStamp(_fastResult('freeform', 'freeform', false, 'unsupported_world_authoring', 'unsupported_meta_authority'));
  }

  // ── Layer 1: clear third-party emote subject fast deny ────────────────────
  if (_isWorldAuthoringEmote(rawInput)) {
    return _agStamp(_fastResult('freeform', 'freeform', false, 'unsupported_world_authoring', 'unsupported_emote_world_event'));
  }

  // ── Layer 2: LLM classifier for everything else ───────────────────────────
  if (!apiKey) {
    // No API key — fail open (allow_rc) so gameplay is never blocked by gate misconfiguration
    console.warn('[AUTHORITY-GATE] No API key — fail open: allow_rc');
    return _agStamp(_fastResult('allow_rc', 'reality_check', true, 'player_attempt', 'gate_failopen_no_key', false));
  }

  const userMessage = `Classify this player input.

PLAYER INPUT: ${JSON.stringify(rawInput)}
PARSED ACTION (parser hint, may be wrong): ${JSON.stringify(parsedAction)}
DECLARED ABILITIES: ${JSON.stringify(evidence.declaredAbilities)}
INVENTORY (names): ${JSON.stringify(evidence.inventoryNames)}
WORN (names): ${JSON.stringify(evidence.wornNames)}
VISIBLE NPCS (roles/names): ${JSON.stringify(evidence.visibleNpcNames)}
TURN: ${turnNumber}

Return the JSON schema described in your instructions. No prose.`;

  let raw = null;
  try {
    const resp = await axios.post(
      DEEPSEEK_URL,
      {
        model:       'deepseek-v4-flash',
        thinking:    { type: 'disabled' },
        messages:    [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: userMessage }],
        temperature: 0.1,
        max_tokens:  300,
      },
      {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: AUTHORITY_GATE_TIMEOUT,
      }
    );
    raw = resp?.data?.choices?.[0]?.message?.content || null;
  } catch (err) {
    console.error('[AUTHORITY-GATE] LLM call failed:', err.message, '— fail open: allow_rc');
    return _agStamp(_fastResult('allow_rc', 'reality_check', true, 'player_attempt', 'gate_failopen_llm_error', false));
  }

  let result = null;
  try {
    const cleaned = (raw || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    result = JSON.parse(cleaned);
    if (!result || typeof result.decision !== 'string') throw new Error('Missing decision field');
  } catch (parseErr) {
    console.error('[AUTHORITY-GATE] JSON parse failed:', parseErr.message, '| raw:', (raw || '').slice(0, 200), '— fail open: allow_rc');
    return _agStamp(_fastResult('allow_rc', 'reality_check', true, 'player_attempt', 'gate_failopen_parse_error', false));
  }

  // Normalize — ensure _llm_called, gate_fast_path_hit, and llm_confidence are set
  result._llm_called        = true;
  result.gate_fast_path_hit = false;
  result.llm_confidence     = (result.confidence != null && !isNaN(Number(result.confidence)))
    ? Math.max(0, Math.min(1, Number(result.confidence)))
    : null;

  // Safety: if decision is not a known value, fail open
  if (!['allow_rc', 'allow_no_rc', 'freeform'].includes(result.decision)) {
    console.warn('[AUTHORITY-GATE] Unknown decision value:', result.decision, '— fail open: allow_rc');
    result.decision   = 'allow_rc';
    result.route      = 'reality_check';
    result.rc_allowed = true;
    result.reason_code = 'gate_failopen_bad_decision';
  }

  // Attach AG debug fields for payload archive (v1.91.44)
  result._ag_prompt       = userMessage;
  result._ag_raw_response = raw;

  // v1.91.44: Post-LLM evidence validator — deterministic cross-check of referenced_objects
  // against engine state. Must run after normalization, before return.
  result = _validateReferencedObjects(result, evidence, gameState, parsedAction);

  // v1.91.47: Post-LLM entity validator — deterministic cross-check of referenced_entities
  // against visible NPC evidence. Sibling to _validateReferencedObjects; preserves it exactly.
  result = _validateReferencedEntities(result, evidence);

  // v1.91.XX: Stamp evidence bundle for diagnostics archive
  result._ag_evidence_bundle = evidence;

  return result;
}

function _historicalObjectNameMatches(reference, historicalName) {
  if (typeof reference !== 'string' || typeof historicalName !== 'string') return false;
  const normalizedReference = reference.trim().toLowerCase();
  const normalizedHistoricalName = historicalName.trim().toLowerCase();
  if (!normalizedReference || !normalizedHistoricalName) return false;
  return aliasScore(normalizedReference, normalizedHistoricalName, [], 2) >= 10;
}

const _HISTORICAL_OBJECT_AUDIT_ID_FIELDS = Object.freeze({
  promote_suppressed_transfer_conflict: 'object_id',
  promote_suppressed_transfer_name_collision: 'object_id',
  promote_skipped_name_match: 'object_id',
  promote_skipped_soft_match: 'object_id',
  promote_skipped_token_subset: 'object_id',
  promote_skipped_tsl_dedup: 'object_id',
  promote_skipped_existing: 'object_id',
  promote_skipped_resolved_name_match: 'existing_object_id',
  promoted: 'object_id',
});

function _extractHistoricalAuditObjectId(entry) {
  const idField = _HISTORICAL_OBJECT_AUDIT_ID_FIELDS[entry?.action];
  if (!idField) return null;
  const objectId = entry?.[idField];
  return typeof objectId === 'string' && objectId.trim() ? objectId : null;
}

function _classifyCurrentHistoricalObjectAvailability(gameState, objectId) {
  const objects = (gameState?.objects && typeof gameState.objects === 'object') ? gameState.objects : {};
  const record = objects[objectId] || null;
  if (!record) {
    return { record: null, available: false, current_scope: null, reason_code: 'ors_record_missing' };
  }
  if (record.status !== 'active') {
    return { record, available: false, current_scope: null, reason_code: 'ors_record_inactive' };
  }

  const playerObjectIds = Array.isArray(gameState?.player?.object_ids) ? gameState.player.object_ids : [];
  if (
    record.current_container_type === 'player' &&
    record.current_container_id === 'player' &&
    playerObjectIds.includes(objectId)
  ) {
    return { record, available: true, current_scope: 'player_inventory', reason_code: 'ors_object_currently_available' };
  }

  const wornObjectIds = Array.isArray(gameState?.player?.worn_object_ids) ? gameState.player.worn_object_ids : [];
  if (
    record.current_container_type === 'player_worn' &&
    record.current_container_id === 'player_worn' &&
    wornObjectIds.includes(objectId)
  ) {
    return { record, available: true, current_scope: 'player_worn', reason_code: 'ors_object_currently_available' };
  }

  const groundDepth = gameState?.world?.active_local_space ? 3 : gameState?.world?.active_site ? 2 : 1;
  const worldPosition = gameState?.world?.position;
  const gridCellKey = worldPosition
    ? `LOC:${worldPosition.mx},${worldPosition.my}:${worldPosition.lx},${worldPosition.ly}`
    : null;

  let siteFloorKey = null;
  if (groundDepth === 2) {
    const activeSite = gameState?.world?.active_site;
    const playerX = gameState?.player?.position?.x;
    const playerY = gameState?.player?.position?.y;
    const siteId = activeSite?.site_id || activeSite?.id?.replace(/\/l2$/, '');
    if (siteId != null && playerX != null && playerY != null) {
      siteFloorKey = `${siteId}:${playerX},${playerY}`;
    }
  }

  const localSpaceKey = groundDepth === 3
    ? (gameState?.world?.active_local_space?.local_space_id || null)
    : null;
  const onCurrentGround = (
    (groundDepth === 1 &&
      record.current_container_type === 'grid' &&
      record.current_container_id === gridCellKey) ||
    (record.current_container_type === 'site' &&
      siteFloorKey !== null &&
      record.current_container_id === siteFloorKey) ||
    (record.current_container_type === 'localspace' &&
      localSpaceKey !== null &&
      record.current_container_id === localSpaceKey)
  );
  if (onCurrentGround) {
    return { record, available: true, current_scope: 'current_ground', reason_code: 'ors_object_currently_available' };
  }

  if (record.current_container_type === 'npc') {
    const depth = gameState?.world?.current_depth ?? 1;
    const visibleNpcs = (depth >= 3)
      ? (gameState?.world?.active_local_space?._visible_npcs || [])
      : (depth >= 2)
        ? (gameState?.world?.active_site?._visible_npcs || [])
        : (gameState?.world?._visible_npcs || []);
    const owningNpc = (Array.isArray(visibleNpcs) ? visibleNpcs.slice(0, 5) : [])
      .find(npc => npc?.id === record.current_container_id);
    if (
      owningNpc &&
      Array.isArray(owningNpc.object_ids) &&
      owningNpc.object_ids.includes(objectId)
    ) {
      return { record, available: true, current_scope: 'visible_npc_held', reason_code: 'ors_object_currently_available' };
    }
  }

  return { record, available: false, current_scope: null, reason_code: 'ors_object_outside_current_scope' };
}

function _resolveHistoricalObjectReceipt(reference, gameState) {
  const originalReference = typeof reference === 'string' ? reference : '';
  const candidateObjectIds = new Set();
  const matchedTurns = new Set();
  let recognized = false;

  const sortedObjectIds = () => [...candidateObjectIds].sort();
  const sortedMatchedTurns = () => [...matchedTurns].sort((a, b) => a - b);
  const makeReceipt = ({
    outcome,
    reason_code,
    object_id = null,
    record = null,
    current_scope = null,
  }) => ({
    schema_version: 'ag_historical_object_receipt_v1',
    reference: originalReference,
    outcome,
    reason_code,
    object_id,
    candidate_object_ids: sortedObjectIds(),
    matched_turns: sortedMatchedTurns(),
    current_status: record?.status ?? null,
    current_container_type: record?.current_container_type ?? null,
    current_container_id: record?.current_container_id ?? null,
    current_scope,
  });

  try {
    const normalizedReference = originalReference.trim().toLowerCase();
    if (!normalizedReference) {
      return makeReceipt({ outcome: 'not_found', reason_code: 'no_historical_match' });
    }

    const history = Array.isArray(gameState?.turn_history) ? gameState.turn_history : [];
    for (const turn of history) {
      const outerTurnNumber = Number.isFinite(turn?.turn_number)
        ? turn.turn_number
        : Number.isFinite(turn?.turn) ? turn.turn : null;
      const matchingCandidateTempRefs = new Set();
      const recordRecognition = (turnNumber) => {
        recognized = true;
        if (Number.isFinite(turnNumber)) matchedTurns.add(turnNumber);
      };
      const inspectCandidates = (entries, collectTempRefs) => {
        for (const entry of (Array.isArray(entries) ? entries : [])) {
          if (!_historicalObjectNameMatches(normalizedReference, entry?.name)) continue;
          recordRecognition(outerTurnNumber);
          if (collectTempRefs && entry?.temp_ref != null) {
            matchingCandidateTempRefs.add(entry.temp_ref);
          }
        }
      };

      const packet = turn?.narration_debug?.extraction_packet;
      inspectCandidates(packet?.object_candidates, true);
      inspectCandidates(packet?.visible_objects, false);
      inspectCandidates(turn?.object_reality?.cb_candidates, true);

      const auditEntries = Array.isArray(turn?.object_reality?.audit) ? turn.object_reality.audit : [];
      for (const auditEntry of auditEntries) {
        if (!Object.prototype.hasOwnProperty.call(_HISTORICAL_OBJECT_AUDIT_ID_FIELDS, auditEntry?.action)) continue;

        const auditNameMatches = (
          _historicalObjectNameMatches(normalizedReference, auditEntry?.object_name) ||
          _historicalObjectNameMatches(normalizedReference, auditEntry?.existing_object_name)
        );
        if (auditNameMatches) {
          const auditTurnNumber = outerTurnNumber ?? (Number.isFinite(auditEntry?.turn) ? auditEntry.turn : null);
          recordRecognition(auditTurnNumber);
        }

        const tempRefMatches = auditEntry?.temp_ref != null && matchingCandidateTempRefs.has(auditEntry.temp_ref);
        if (!auditNameMatches && !tempRefMatches) continue;

        const objectId = _extractHistoricalAuditObjectId(auditEntry);
        if (objectId) candidateObjectIds.add(objectId);
      }
    }

    const objectIds = sortedObjectIds();
    if (!recognized) {
      return makeReceipt({ outcome: 'not_found', reason_code: 'no_historical_match' });
    }
    if (objectIds.length === 0) {
      return makeReceipt({ outcome: 'unresolved', reason_code: 'historical_match_without_audited_identity' });
    }
    if (objectIds.length > 1) {
      return makeReceipt({ outcome: 'ambiguous', reason_code: 'multiple_audited_object_ids' });
    }

    const objectId = objectIds[0];
    const availability = _classifyCurrentHistoricalObjectAvailability(gameState, objectId);
    return makeReceipt({
      outcome: availability.available ? 'resolved_available' : 'resolved_unavailable',
      reason_code: availability.reason_code,
      object_id: objectId,
      record: availability.record,
      current_scope: availability.current_scope,
    });
  } catch (_) {
    return makeReceipt({ outcome: 'unresolved', reason_code: 'resolver_error' });
  }
}

// ── Post-LLM evidence validator (v1.91.44) ────────────────────────────────────
// Deterministic. No LLM calls. No raw player input as evidence.
// Two-tier check per referenced object:
//   Tier 1: inventory names | worn names | current cell objects → supported
//   Tier 2: structured historical receipt → only resolved_available is continuity_backed
//   Tier 1 miss plus any non-positive receipt → unsupported → override turn to freeform deny.
// Take exemption: parsedAction === 'take' without cell match → skip (AP env-gather path).
function _validateReferencedObjects(result, evidence, gameState, parsedAction) {
  // Only validate Layer-2 (LLM-called) allow_rc results with referenced objects
  if (!result._llm_called) return result;
  if (result.decision !== 'allow_rc') return result;

  const refs = Array.isArray(result.referenced_objects) ? result.referenced_objects : [];
  if (refs.length === 0) return result;

  // Initialize evidence container if LLM didn't provide one
  result.evidence = result.evidence || {};

  // Step 0: Take exemption — preserve AP env-gather path
  const _target = gameState?._lastParsedTarget || null;
  if (parsedAction === 'take' && _target && !_hasCellMatch(gameState, _target)) {
    result.evidence.take_exemption_applied          = true;
    result.evidence.referenced_object_support_basis  = 'deterministic_post_llm_check__tiered_v4_historical_receipts';
    result.evidence.validator_applied                = true;
    result.evidence.supported_referenced_objects     = [];
    result.evidence.unsupported_referenced_objects   = [];
    result.evidence.continuity_backed_objects        = [];
    result.evidence.historical_object_receipts       = [];
    return result;
  }

  const supported         = [];
  const unsupported       = [];
  const continuityBacked  = [];
  const historicalReceipts = [];

  for (const ref of refs) {
    if (!ref || typeof ref !== 'string') continue;
    const refLower = ref.toLowerCase().trim();
    if (!refLower) continue;

    // ── Tier 1: Direct engine backing ──────────────────────────────────────
    let tier1 = false;

    // 1a. Inventory names (active-status objects held by player)
    if (!tier1 && Array.isArray(evidence.inventoryNames)) {
      for (const name of evidence.inventoryNames) {
        if (!name) continue;
        if (aliasScore(refLower, name, [], 2) >= 10) {
          tier1 = true;
          break;
        }
      }
    }

    // 1b. Worn names (active-status objects worn by player)
    if (!tier1 && Array.isArray(evidence.wornNames)) {
      for (const name of evidence.wornNames) {
        if (!name) continue;
        if (aliasScore(refLower, name, [], 2) >= 10) {
          tier1 = true;
          break;
        }
      }
    }

    // 1c. Current cell objects (via existing AP helper)
    if (!tier1 && _hasCellMatch(gameState, ref)) {
      tier1 = true;
    }

    if (tier1) {
      supported.push(ref);
      continue;
    }

    // ── Tier 2: Structured historical receipt ──────────────────────────────
    const historicalReceipt = _resolveHistoricalObjectReceipt(ref, gameState);
    historicalReceipts.push(historicalReceipt);
    if (historicalReceipt.outcome === 'resolved_available') {
      continuityBacked.push(ref);
      continue;
    }

    // ── Non-positive historical receipt — unsupported ──────────────────────
    unsupported.push(ref);
  }

  // Stamp diagnostic fields
  result.evidence.supported_referenced_objects     = supported;
  result.evidence.unsupported_referenced_objects   = unsupported;
  result.evidence.continuity_backed_objects        = continuityBacked;
  result.evidence.historical_object_receipts       = historicalReceipts;
  result.evidence.referenced_object_support_basis  = 'deterministic_post_llm_check__tiered_v4_historical_receipts';
  result.evidence.validator_applied                = true;
  result.evidence.take_exemption_applied           = false;

  // Step 3: If any referenced object has zero evidence, override the turn
  if (unsupported.length > 0) {
    console.warn(`[AUTHORITY-GATE] Validator override — unsupported refs: ${unsupported.join(', ')} | supported: ${supported.join(', ') || 'none'} | continuity_backed: ${continuityBacked.join(', ') || 'none'}`);
    result.decision                  = 'freeform';
    result.route                     = 'freeform';
    result.rc_allowed                = false;
    result.input_type                = 'unsupported_world_authoring';
    result.reason_code               = 'unsupported_referenced_object';
    result.evidence.engine_supported = false;
    result.evidence.validator_reason = `unsupported_refs: ${unsupported.join(', ')}`;
  }

  return result;
}

// ── Post-LLM entity evidence validator (v1.91.47) ───────────────────────────────
// Deterministic. No LLM calls. No raw player input as evidence.
// Checks referenced_entities against visible NPC aliases (job_category, job,
// npc_name, learned_name) already in evidence.visibleNpcNames.
// Mirror of _validateReferencedObjects guard and override pattern.
function _validateReferencedEntities(result, evidence) {
  // Only validate Layer-2 (LLM-called) allow_rc results with referenced entities
  if (!result._llm_called) return result;
  if (result.decision !== 'allow_rc') return result;

  const refs = Array.isArray(result.referenced_entities) ? result.referenced_entities : [];
  if (refs.length === 0) return result;

  // Initialize evidence container
  result.evidence = result.evidence || {};

  const aliases = Array.isArray(evidence.visibleNpcNames) ? evidence.visibleNpcNames : [];
  const supported   = [];
  const unsupported = [];

  for (const ref of refs) {
    if (!ref || typeof ref !== 'string') continue;
    const refLower = ref.toLowerCase().trim();
    if (!refLower) continue;

    // Two-way containment match (mirrors _validateReferencedObjects tier 1 style)
    let matched = false;
    for (const alias of aliases) {
      if (!alias) continue;
      if (alias.includes(refLower) || refLower.includes(alias)) {
        matched = true;
        break;
      }
    }

    if (matched) {
      supported.push(ref);
    } else {
      unsupported.push(ref);
    }
  }

  // Stamp diagnostic fields
  result.evidence.supported_referenced_entities   = supported;
  result.evidence.unsupported_referenced_entities = unsupported;
  result.evidence.entity_validator_applied        = true;
  result.evidence.entity_support_basis            = 'deterministic_post_llm_check__entity_v1';

  // If any referenced entity has zero evidence, override the turn
  if (unsupported.length > 0) {
    console.warn(`[AUTHORITY-GATE] Entity validator override — unsupported entities: ${unsupported.join(', ')} | supported: ${supported.join(', ') || 'none'}`);
    result.decision                  = 'freeform';
    result.route                     = 'freeform';
    result.rc_allowed                = false;
    result.input_type                = 'unsupported_world_authoring';
    result.reason_code               = 'unsupported_referenced_entity';
    result.evidence.engine_supported = false;
    result.evidence.validator_reason = `unsupported_entities: ${unsupported.join(', ')}`;
  }

  return result;
}

module.exports = {
  runAuthorityGate,
  AUTHORITY_GATE_VERSION,
};
