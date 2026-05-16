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
 *   - Does not read full turn history, full continuity, or world gen state.
 *   - Object existence checks use existing AP helpers only — no parallel lookup.
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
      return (rec && rec.status === 'active') ? rec.name : null;
    }).filter(Boolean),
  ].slice(0, 10);

  const wornNames = (gameState?.player?.worn_object_ids || []).map(id => {
    const rec = gameState?.objects?.[id];
    return (rec && rec.status === 'active') ? rec.name : null;
  }).filter(Boolean).slice(0, 10);

  const visibleNpcNames = (() => {
    const depth = gameState?.world?.current_depth ?? 1;
    const visNpcs = (depth >= 3)
      ? (gameState?.world?.active_local_space?._visible_npcs || [])
      : (depth >= 2)
        ? (gameState?.world?.active_site?._visible_npcs || [])
        : [];
    return visNpcs.map(n => n.job_category || n.job || n.npc_name || 'unknown').slice(0, 5);
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

  // ── Layer 1: known safe actions (pure navigation / observation) ───────────
  const _LOW_RISK_ACTIONS = new Set(['move', 'look', 'wait', 'enter', 'exit']);
  if (_LOW_RISK_ACTIONS.has(parsedAction)) {
    return _fastResult('allow_no_rc', 'narrator', false, 'valid_low_risk', 'valid_low_risk_action');
  }

  // ── Layer 1: object-verb existence checks ─────────────────────────────────
  // Use existing AP helpers — single source of truth for object resolution.
  const _target = gameState?._lastParsedTarget || null; // see index.js injection note

  if (parsedAction === 'remove') {
    if (_hasWornMatch(gameState, _target)) {
      return _fastResult('allow_no_rc', 'narrator', false, 'valid_low_risk', 'worn_item_confirmed');
    }
    // No worn match — escalate to LLM (could be legitimate edge case)
  }

  if (parsedAction === 'take') {
    if (_hasCellMatch(gameState, _target)) {
      return _fastResult('allow_no_rc', 'narrator', false, 'valid_low_risk', 'cell_item_confirmed');
    }
    // No cell match — escalate to LLM
  }

  if (parsedAction === 'drop' || parsedAction === 'throw') {
    if (_hasInventoryMatch(gameState, _target)) {
      return _fastResult('allow_no_rc', 'narrator', false, 'valid_low_risk', 'inventory_item_confirmed');
    }
    // No inventory match — escalate to LLM
  }

  if (parsedAction === 'examine') {
    // examine with a confirmed inventory, worn, or cell match → low risk
    if (_target && (_hasInventoryMatch(gameState, _target) || _hasWornMatch(gameState, _target) || _hasCellMatch(gameState, _target))) {
      return _fastResult('allow_no_rc', 'narrator', false, 'valid_low_risk', 'examine_target_confirmed');
    }
    // No confirmed match — escalate to LLM
  }

  // ── Layer 1: attack → always allow_rc ────────────────────────────────────
  if (parsedAction === 'attack') {
    return _fastResult('allow_rc', 'reality_check', true, 'player_attempt', 'attack_action');
  }

  // ── Layer 1: meta-authority keyword fast deny ─────────────────────────────
  if (_isMetaAuthorityAttempt(rawInput, evidence.declaredAbilities)) {
    return _fastResult('freeform', 'freeform', false, 'unsupported_world_authoring', 'unsupported_meta_authority');
  }

  // ── Layer 1: clear third-party emote subject fast deny ────────────────────
  if (_isWorldAuthoringEmote(rawInput)) {
    return _fastResult('freeform', 'freeform', false, 'unsupported_world_authoring', 'unsupported_emote_world_event');
  }

  // ── Layer 2: LLM classifier for everything else ───────────────────────────
  if (!apiKey) {
    // No API key — fail open (allow_rc) so gameplay is never blocked by gate misconfiguration
    console.warn('[AUTHORITY-GATE] No API key — fail open: allow_rc');
    return _fastResult('allow_rc', 'reality_check', true, 'player_attempt', 'gate_failopen_no_key', false);
  }

  const userMessage = `Classify this player input.

PLAYER INPUT: ${JSON.stringify(rawInput)}
PARSED ACTION (parser hint, may be wrong): ${JSON.stringify(parsedAction)}
DECLARED ABILITIES: ${JSON.stringify(evidence.declaredAbilities)}
INVENTORY (names): ${JSON.stringify(evidence.inventoryNames)}
WORN (names): ${JSON.stringify(evidence.wornNames)}
VISIBLE NPCS (roles): ${JSON.stringify(evidence.visibleNpcNames)}
TURN: ${turnNumber}

Return the JSON schema described in your instructions. No prose.`;

  let raw = null;
  try {
    const resp = await axios.post(
      DEEPSEEK_URL,
      {
        model:       'deepseek-chat',
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
    return _fastResult('allow_rc', 'reality_check', true, 'player_attempt', 'gate_failopen_llm_error', false);
  }

  let result = null;
  try {
    const cleaned = (raw || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    result = JSON.parse(cleaned);
    if (!result || typeof result.decision !== 'string') throw new Error('Missing decision field');
  } catch (parseErr) {
    console.error('[AUTHORITY-GATE] JSON parse failed:', parseErr.message, '| raw:', (raw || '').slice(0, 200), '— fail open: allow_rc');
    return _fastResult('allow_rc', 'reality_check', true, 'player_attempt', 'gate_failopen_parse_error', false);
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

  return result;
}

module.exports = {
  runAuthorityGate,
  AUTHORITY_GATE_VERSION,
};
