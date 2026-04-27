'use strict';

/**
 * ContinuityBrain.js — v1.70.0
 *
 * Active continuity coprocessor. Operates in two phases per turn:
 *
 *   Phase B  runPhaseB(frozenNarration, gameState)
 *            Forensic extraction → association → promotion → mood capture.
 *            Replaces NC.runContinuityExtraction() + NC.freezeContinuityState().
 *
 *   Phase C  assembleContinuityPacket(gameState, turnContext)
 *            Selection → Truth block + Mood block assembly for the narrator.
 *            Replaces NC.buildContinuityBlock().
 *
 * Ownership rules enforced by this module:
 *   - NPC-owned facts  → NPC.attributes{}
 *   - Location facts   → site_record.attributes{} or local_space.attributes{}
 *   - Spatial facts    → narration_debug.extraction_packet (audit only, not promoted)
 *   - Rejected items   → narration_debug.extraction_packet (debug + MB explainability)
 *   - Mood trajectory  → world.mood_history[] (hard cap: MOOD_HISTORY_CAP)
 *   - Promotion events → world.promotion_log[]
 *
 * Design constraints (DO NOT SOFTEN):
 *   1. entity_ref must resolve to npc_id — descriptive labels log a warning; never silently float
 *   2. rejected_interpretations (per-entity AND top-level) stored every turn — never removed to save tokens
 *   3. TRUTH block rendered before MOOD block — ordering is fixed
 *   4. Mood fields are short labels/phrases — no prose
 *   5. Promotion filters: LIBERAL on concrete visible detail; CONSERVATIVE on interpretation
 */

const axios = require('axios');

// ── Constants ─────────────────────────────────────────────────────────────────
const DEEPSEEK_URL      = 'https://api.deepseek.com/v1/chat/completions';
const MOOD_HISTORY_CAP  = 20;   // hard cap on world.mood_history[]
const MOOD_WINDOW       = 5;    // entries used for MOOD block in packet
const EXTRACTION_TIMEOUT = 30000; // ms — Phase B LLM call
const CB_VERSION        = '1.5.0';

// ── Diagnostics ───────────────────────────────────────────────────────────────
let _lastRunDiagnostics = null;

function getLastRunDiagnostics() { return _lastRunDiagnostics; }

function _setDiag(d) { _lastRunDiagnostics = d; }

// ── Extraction prompt ─────────────────────────────────────────────────────────

function _buildExtractionPrompt(frozenNarration, gameState, previousMoodSnapshot, watchContext) {
  const location         = _describeLocation(gameState);
  const entities         = _describeVisibleEntities(gameState);
  const knownPlayerAttrs = _describePlayerAttributes(gameState);
  const prevMood  = previousMoodSnapshot
    ? JSON.stringify(previousMoodSnapshot, null, 2)
    : '(none — first turn)';

  return `EXTRACTION TASK — TURN ${(gameState.turn_history || []).length}

You are a forensic extraction system. Your job is to read the narration below and identify structured facts. You are NOT summarizing. You are NOT interpreting. You are identifying what a stationary camera in the room would capture.

NARRATION (verbatim):
${frozenNarration}

CURRENT ENGINE STATE:
Active location: ${location}
Visible entities: ${entities}
Player character: always present — entity_ref "player" | known attributes: ${knownPlayerAttrs}

PREVIOUS MOOD SNAPSHOT:
${prevMood}

---

Produce a JSON object with EXACTLY these top-level keys. Do not add, remove, or merge any keys.

{
  "entity_candidates": [...],
  "environmental_features": [...],
  "spatial_relations": [...],
  "rejected_interpretations": [...],
  "mood_snapshot": { ... }
}

---

ENTITY REFERENCE RULE:
Check the Visible entities list above before writing any entity_ref.
If the entity matches a known entry, use the EXACT npc_id (e.g. "npc_barkeep_01").
Only use a descriptive label ("man near hearth") if no match exists in the list.
A descriptive label that should have been an npc_id is a silent continuity break.
"player" is always a valid entity_ref — use it when the narration describes the player character's appearance, clothing, equipment, or current physical state.

---

ENTITY CANDIDATES

For each named or identifiable entity in the narration, produce one entry:

{
  "entity_ref": "<npc_id from engine state, or descriptive label ONLY if no match>",
  "physical_attributes": [],
  "observable_states": [],
  "held_or_worn_objects": [],
  "rejected_interpretations": []
}

physical_attributes
  Permanent or semi-permanent features of the body.
  Test: "Would this still be true if I walked away and came back tomorrow?"
  ACCEPT: scar over left eye | grey beard | missing finger | patched eyebrow
  REJECT: suspicious expression | tired look | nervous energy

observable_states
  Current verifiable condition. Changeable. No inference required.
  Test: "Can I confirm this by looking, without guessing why?"
  ACCEPT: arm in sling | hood pulled low | lamp is unlit | hunched over counter
  REJECT: hiding something | grieving | planning

held_or_worn_objects
  Items visibly on or in the hands/body of THIS entity specifically.
  Test: "Is this object attached to or held by this entity right now?"
  ACCEPT: black umbrella | worn leather coat | sealed letter | iron ring
  REJECT: "weapons" (too vague) | "burdens" (metaphor)

rejected_interpretations (per-entity)
  REQUIRED. Items you considered but rejected. Format: "phrase → reason"
  EXAMPLES:
    suspicious demeanor → interpretive, not observable
    sacred aura → metaphorical
    melancholy presence → emotional inference
    hidden motive → requires mind-reading

---

ENVIRONMENTAL FEATURES

Physical props and conditions belonging to the LOCATION, not any entity.
Test: "Would this be here if there were no people in the room?"

Format: { "location_ref": "<location name>", "features": [...] }

ACCEPT: chipped wooden counter | overturned stool | water stain on east wall | guttered candle near door
REJECT: oppressive silence (mood) | sacred atmosphere (interpretation) | dimly lit (ambiguous — only include if explicitly stated)

---

SPATIAL RELATIONS

Verifiable positional facts. One per entry. Short natural language.
Test: "Is this a position, or an inference about intent?"

ACCEPT: "merchant standing near the east door"
        "crate blocking the north passage"
        "two men seated at the corner table"
REJECT: "merchant seems to be watching the door" (intent inference)
        "the room feels crowded" (mood)

---

TOP-LEVEL REJECTED INTERPRETATIONS

Items about the scene or environment as a whole that you identified but rejected.
These are scene-level or environment-level inferences that don't belong to any single entity.

Format: ["phrase → reason", ...]

EXAMPLES:
  "the room feels ceremonial → scene-level interpretation"
  "a confrontation seems inevitable → inference about future event"
  "oppressive silence → mood, not a physical feature"

---

MOOD SNAPSHOT

Read the narration AND the previous mood snapshot together.
You are capturing TRAJECTORY, not just current state.
All values are SHORT LABELS or PHRASES. No sentences. No narrative prose.

{
  "tone": "<2-3 comma-separated labels>",
  "tension_level": "<low|medium|high|critical>",
  "tension_direction": "<rising|falling|stable>",
  "conversational_state": "<none|active|hostile|guarded|open>",
  "scene_focus": "<concrete noun phrase only>",
  "delta_note": "<one short phrase: what shifted, or 'stable — no shift'>"
}

tone
  ACCEPT: "quiet, watchful" | "tense, formal" | "hostile, guarded"
  REJECT: "the air hangs heavy with unspoken threat" → prose, not a label

scene_focus
  ACCEPT: "central dais" | "north exit" | "the merchant's hands"
  REJECT: "the tension coiled around the man near the fire" → this is a sentence

delta_note
  ACCEPT: "tension easing since confrontation resolved"
          "hostility introduced this turn"
          "stable — no shift"
  REJECT: multi-sentence narrative explanation

Respond with ONLY the JSON object. No explanation, no wrapper text.
${watchContext ? `\n---\n\nMOTHER WATCH BRIEF\nEngine state for this turn. Use this to write watch_message only.\n\nCONTINUITY: ${watchContext.continuity_injected ? 'injected' : watchContext.continuity_evicted ? 'evicted (' + (watchContext.continuity_eviction_reason || 'unknown') + ')' : 'not injected'}\nNARRATOR:   ${watchContext.narrator_status || 'ok'}\nMOVE:       ${watchContext.move_summary || 'none'}\nVIOLATIONS: ${watchContext.violation_count || 0}${watchContext.top_violation ? ' | top: "' + watchContext.top_violation + '"' : ''}\nCHANNEL:    ${watchContext.channel || '\u2014'}\n\nAdd one optional field to your JSON output:\n\"watch_message\": \"<one sentence: your system health judgment for this turn. Start with \u2713 if clean, \u26a0 for a warning, \u2715 for an error. Highest-priority issue only. Omit the field entirely if you have nothing to add.>\"\n` : ''}` ;
}

// ── Location / entity description helpers ─────────────────────────────────────

function _describeLocation(gameState) {
  const w = gameState.world || {};
  if (w.active_local_space) return `${w.active_local_space.name || 'local space'} (L2)`;
  if (w.active_site)        return `${w.active_site.name || 'site'} (L1)`;
  return 'overworld (L0)';
}

function _describeVisibleEntities(gameState) {
  const w   = gameState.world || {};
  const loc = w.active_local_space || w.active_site;
  if (!loc) return '(none)';
  const visible = loc._visible_npcs || [];
  if (!visible.length) return '(none)';
  return visible.map(n => {
    const label = n.npc_name ? `${n.npc_name} (${n.id})` : `unnamed ${n.job_category || 'person'} (${n.id})`;
    return label;
  }).join(', ');
}

function _describePlayerAttributes(gameState) {
  const attrs = gameState.player?.attributes;
  if (!attrs || !Object.keys(attrs).length) return '(none yet)';
  return Object.values(attrs).map(a => `${a.bucket}:${a.value}`).join(' | ');
}

// ── NPC id resolution ─────────────────────────────────────────────────────────

function _resolveEntityRef(entityRef, gameState) {
  const w   = gameState.world || {};
  const loc = w.active_local_space || w.active_site;
  if (!loc) return null;
  const visible = loc._visible_npcs || [];

  // Exact npc_id match
  const exact = visible.find(n => n.id === entityRef);
  if (exact) return exact;

  // Name match (case-insensitive)
  const byName = visible.find(n => n.npc_name && n.npc_name.toLowerCase() === entityRef.toLowerCase());
  if (byName) return byName;

  // Partial job/description match (best-effort — warns if used)
  const lower = entityRef.toLowerCase();
  const byJob = visible.find(n => (n.job_category || '').toLowerCase().includes(lower) || (n.npc_name || '').toLowerCase().includes(lower));
  if (byJob) return { _fuzzy: true, ...byJob };

  return null;
}

// ── Promotion logic ───────────────────────────────────────────────────────────
// LIBERAL on concrete visible detail; CONSERVATIVE on interpretation.
// Promotion filters run AFTER extraction schema separates fields.

const BANNED_INTERPRETATION_PATTERNS = {
  aura:         /\baura\b/i,
  presence:     /\bpresence\b/i,
  demeanor:     /\bdemeanor\b/i,
  menace:       /\bmenace\b/i,
  sinister:     /\bsinister\b/i,
  mystic:       /\bmystic\b/i,
  sacred:       /\bsacred\b/i,
  blessed:      /\bblessed\b/i,
  cursed:       /\bcursed\b/i,
  ominous:      /\bominous\b/i,
  forbidding:   /\bforbidding\b/i,
  magic:        /\bmagic\b/i,
  melancholy:   /\bmelancholy\b/i,
  sorrow:       /\bsorrow\b/i,
  intimidating: /\bintimidating\b/i,
};

// Returns { ok: true } if str passes all filters, or { ok: false, pattern: 'name' } on first match.
function _isConcreteDetail(str) {
  if (!str) return { ok: false, pattern: 'empty' };
  for (const [name, rx] of Object.entries(BANNED_INTERPRETATION_PATTERNS)) {
    if (rx.test(str)) return { ok: false, pattern: name };
  }
  return { ok: true };
}

function _promoteEntityAttributes(npc, candidate, turn, logEntries) {
  const _dupCounts = {};
  const promote = (bucket, items) => {
    for (const item of (items || [])) {
      const _check = _isConcreteDetail(item);
      if (!_check.ok) {
        logEntries.push({ action: 'rejected_filter', entity_id: npc.id, bucket, value: item, turn, reason: 'banned_pattern:' + _check.pattern });
        continue;
      }
      const key = `${bucket}:${item}`;
      const existing = npc.attributes[key];
      if (!existing) {
        npc.attributes[key] = { value: item, bucket, turn_set: turn, confidence: 'initial' };
        logEntries.push({ action: 'create', entity_type: 'npc', entity_id: npc.id, entity_name: npc.npc_name || npc.id, attribute: key, old_value: null, new_value: item, evidence_quote: null, turn });
      } else {
        _dupCounts[bucket] = (_dupCounts[bucket] || 0) + 1;
      }
      // Existing facts: only update on positive evidence of change (not mere omission).
      // Contradiction detection is a future evolution — for now facts persist until retracted.
    }
  };
  promote('physical', candidate.physical_attributes);
  promote('state',    candidate.observable_states);
  promote('object',   candidate.held_or_worn_objects);
  const _dupTotal = Object.values(_dupCounts).reduce((s, c) => s + c, 0);
  if (_dupTotal > 0) {
    logEntries.push({ action: 'duplicate_silenced_summary', entity_type: 'npc', entity_id: npc.id, entity_name: npc.npc_name || npc.id, count_by_bucket: _dupCounts, total: _dupTotal, turn });
  }
}

function _promoteLocationAttributes(locationRecord, locationRef, features, turn, logEntries) {
  if (!locationRecord.attributes) locationRecord.attributes = {}; // backward-compat: old saves lack attributes field
  let _dupCount = 0;
  for (const feat of (features || [])) {
    const _check = _isConcreteDetail(feat);
    if (!_check.ok) {
      logEntries.push({ action: 'rejected_filter', entity_id: locationRef, bucket: 'environment', value: feat, turn, reason: 'banned_pattern:' + _check.pattern });
      continue;
    }
    const key = `env:${feat}`;
    if (!locationRecord.attributes[key]) {
      locationRecord.attributes[key] = { value: feat, bucket: 'environment', turn_set: turn, confidence: 'initial', source: 'narration' };
      logEntries.push({ action: 'create', entity_type: 'location', entity_id: locationRef, entity_name: locationRef, attribute: key, old_value: null, new_value: feat, evidence_quote: null, turn });
    } else {
      _dupCount++;
    }
  }
  if (_dupCount > 0) {
    logEntries.push({ action: 'duplicate_silenced_summary', entity_type: 'location', entity_id: locationRef, entity_name: locationRef, count_by_bucket: { environment: _dupCount }, total: _dupCount, turn });
  }
}

// ── Player attribute promotion ──────────────────────────────────────────────────
// Parallel to _promoteEntityAttributes — targets gameState.player.attributes.
function _promotePlayerAttributes(player, candidate, turn, logEntries) {
  if (!player.attributes) player.attributes = {}; // migration guard: old saves
  const _dupCounts = {};
  const promote = (bucket, items) => {
    for (const item of (items || [])) {
      const _check = _isConcreteDetail(item);
      if (!_check.ok) {
        logEntries.push({ action: 'rejected_filter', entity_id: player.id || 'player', bucket, value: item, turn, reason: 'banned_pattern:' + _check.pattern });
        continue;
      }
      const key = `${bucket}:${item}`;
      if (!player.attributes[key]) {
        player.attributes[key] = { value: item, bucket, turn_set: turn, confidence: 'initial' };
        logEntries.push({ action: 'create', entity_type: 'player', entity_id: player.id || 'player', entity_name: 'player', attribute: key, old_value: null, new_value: item, evidence_quote: null, turn });
      } else {
        _dupCounts[bucket] = (_dupCounts[bucket] || 0) + 1;
      }
    }
  };
  promote('physical', candidate.physical_attributes);
  promote('state',    candidate.observable_states);
  promote('object',   candidate.held_or_worn_objects);
  const _dupTotal = Object.values(_dupCounts).reduce((s, c) => s + c, 0);
  if (_dupTotal > 0) {
    logEntries.push({ action: 'duplicate_silenced_summary', entity_type: 'player', entity_id: player.id || 'player', entity_name: 'player', count_by_bucket: _dupCounts, total: _dupTotal, turn });
  }
}

// ── L0 cell record helper ─────────────────────────────────────────────────────
// Returns the world cell record for the player's current overworld position,
// or null if position/cells are unavailable.
function _getL0CellRecord(gameState) {
  const w   = gameState.world || {};
  const pos = w.position;
  if (!pos) return null;
  const key = `LOC:${pos.mx},${pos.my}:${pos.lx},${pos.ly}`;
  return w.cells?.[key] || null;
}

// ── Phase B ───────────────────────────────────────────────────────────────────

async function runPhaseB(frozenNarration, gameState, watchContext) {
  const apiKey = process.env.DEEPSEEK_API_KEY || '';
  const turn   = (gameState.turn_history || []).length + 1;

  _setDiag(null);

  // Guard
  if (!apiKey) {
    console.warn('[CB] DEEPSEEK_API_KEY not set — Phase B skipped');
    _setDiag({ skipped: true, reason: 'no_api_key', turn });
    return null;
  }
  if (!frozenNarration) {
    console.warn('[CB] No frozen narration — Phase B skipped');
    _setDiag({ skipped: true, reason: 'no_narration', turn });
    return null;
  }

  // Get previous mood snapshot for temporal chain
  const moodHistory = gameState.world.mood_history || [];
  const previousMood = moodHistory.length ? moodHistory[moodHistory.length - 1] : null;

  // ── LLM extraction call ────────────────────────────────────────────────────
  const prompt = _buildExtractionPrompt(frozenNarration, gameState, previousMood, watchContext);
  let raw = null;
  try {
    const resp = await axios.post(
      DEEPSEEK_URL,
      {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,  // low temperature — forensic, not creative
        max_tokens: 1200
      },
      {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: EXTRACTION_TIMEOUT
      }
    );
    raw = resp?.data?.choices?.[0]?.message?.content || null;
  } catch (err) {
    console.error('[CB] Phase B LLM call failed:', err.message);
    _setDiag({ error: err.message, turn });
    return null;
  }

  // ── Parse LLM output ───────────────────────────────────────────────────────
  let extracted = null;
  try {
    // Strip markdown code fences if model wrapped the JSON
    const cleaned = (raw || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    extracted = JSON.parse(cleaned);
  } catch (parseErr) {
    console.error('[CB] Phase B JSON parse failed:', parseErr.message, '| raw:', (raw || '').slice(0, 200));
    _setDiag({ error: 'json_parse_failed', raw: (raw || '').slice(0, 500), turn });
    return null;
  }

  // Validate top-level keys (watchpoint: do not let a collapsed schema slip through)
  const REQUIRED_KEYS = ['entity_candidates', 'environmental_features', 'spatial_relations', 'rejected_interpretations', 'mood_snapshot'];
  const missing = REQUIRED_KEYS.filter(k => !(k in extracted));
  if (missing.length) {
    console.error('[CB] Phase B schema missing keys:', missing, '— summary-mode regression?');
    _setDiag({ error: 'schema_missing_keys', missing, turn });
    return null;
  }

  // Safely extract watch_message — optional, never blocks Phase B
  const watch_message = typeof extracted.watch_message === 'string' ? extracted.watch_message : null;

  // ── Association + Promotion ────────────────────────────────────────────────
  const logEntries  = [];
  const warnings    = [];
  const w           = gameState.world || {};
  const locationRecord = w.active_local_space || w.active_site || _getL0CellRecord(gameState);
  const pos            = w.position;
  const locationRef    = w.active_local_space?.name || w.active_site?.name ||
                         (pos ? `cell(${pos.mx},${pos.my}:${pos.lx},${pos.ly})` : 'unknown');

  const loc    = w.active_local_space || w.active_site;
  const player = gameState.player;

  // Route entity candidates: player self-refs first (any layer), then NPC resolution.
  // At L0, non-player candidates collapse into a single warning (no NPC registry).
  const l0NonPlayerCandidates = [];
  for (const candidate of (extracted.entity_candidates || [])) {
    const ref = candidate.entity_ref;
    if (!ref) continue;

    // Player self-ref — always route to player container regardless of layer
    const refLower = ref.toLowerCase();
    if (refLower === 'player' || refLower === 'you') {
      if (player) _promotePlayerAttributes(player, candidate, turn, logEntries);
      continue;
    }

    // At L0: no NPC registry — collect for warning
    if (!loc) {
      l0NonPlayerCandidates.push(candidate);
      continue;
    }

    // L1/L2: resolve and promote
    const resolved = _resolveEntityRef(ref, gameState);
    if (!resolved) {
      warnings.push({ type: 'unresolved_entity_ref', entity_ref: ref, turn });
      console.warn(`[CB] entity_ref "${ref}" could not be resolved to any visible NPC — promotion skipped`);
      continue;
    }

    if (resolved._fuzzy) {
      warnings.push({ type: 'fuzzy_entity_ref', entity_ref: ref, resolved_to: resolved.id, turn });
      console.warn(`[CB] entity_ref "${ref}" resolved via fuzzy match to ${resolved.id} — should use exact npc_id`);
    }

    _promoteEntityAttributes(resolved, candidate, turn, logEntries);
  }

  // Fire L0 warning for non-player entity candidates that could not be resolved
  if (!loc && l0NonPlayerCandidates.length > 0) {
    warnings.push({
      type: 'l0_entity_candidates_skipped',
      reason: 'no_npc_registry',
      count: l0NonPlayerCandidates.length,
      entities: l0NonPlayerCandidates.map(c => c.entity_ref),
      turn,
    });
    console.warn(`[CB] L0: ${l0NonPlayerCandidates.length} entity candidate(s) skipped — no NPC registry at overworld (L0)`);
  }

  // Promote environmental features to location record
  for (const envBlock of (extracted.environmental_features || [])) {
    if (locationRecord) {
      _promoteLocationAttributes(locationRecord, locationRef, envBlock.features, turn, logEntries);
    }
  }

  // L0 context snapshot: capture canonically accepted env facts for next assembly's CONTEXT block.
  // Read from locationRecord.attributes (post-filter, post-dedup) — NOT raw extraction candidates.
  // Filter by turn_set === turn so only this Phase B run's accepted facts are captured.
  if (!loc && locationRecord) {
    const _canonFeats = Object.values(locationRecord.attributes || {})
      .filter(a => a.bucket === 'environment' && a.turn_set === turn)
      .map(a => a.value);
    if (_canonFeats.length > 0) {
      gameState.world._lastPhaseBLoc = { locationRef, features: _canonFeats };
    }
  }

  // Append promotion log entries
  if (!gameState.world.promotion_log) gameState.world.promotion_log = [];
  gameState.world.promotion_log.push(...logEntries);

  // ── Mood snapshot ──────────────────────────────────────────────────────────
  const moodSnapshot = extracted.mood_snapshot || null;
  if (moodSnapshot) {
    if (!gameState.world.mood_history) gameState.world.mood_history = [];
    gameState.world.mood_history.push({ turn, ...moodSnapshot });
    // Hard cap
    if (gameState.world.mood_history.length > MOOD_HISTORY_CAP) {
      gameState.world.mood_history.shift();
    }
  }

  const diag = {
    turn,
    promoted_count:            logEntries.filter(e => e.action === 'create').length,
    rejected_filter_count:     logEntries.filter(e => e.action === 'rejected_filter').length,
    entity_candidates_count:   (extracted.entity_candidates || []).length,
    env_features_count:        (extracted.environmental_features || []).reduce((s, b) => s + (b.features || []).length, 0),
    spatial_relations_count:   (extracted.spatial_relations || []).length,
    top_level_rejections_count:(extracted.rejected_interpretations || []).length,
    per_entity_rejections_count:(extracted.entity_candidates || []).reduce((s, c) => s + (c.rejected_interpretations || []).length, 0),
    warnings,
    mood_captured: !!moodSnapshot,
  };
  _setDiag(diag);

  return {
    extracted,       // full LLM output (stored in narration_debug.extraction_packet)
    log_entries:     logEntries,
    mood_snapshot:   moodSnapshot,
    diagnostics:     diag,
    watch_message,   // Mother's one-sentence system health judgment (null if omitted or Phase B failed)
  };
}

// ── Phase C ───────────────────────────────────────────────────────────────────

function assembleContinuityPacket(gameState, turnContext) {
  const w   = gameState.world || {};
  const loc = w.active_local_space || w.active_site;
  // L0 fallback: env features are promoted to the cell record, not active_site/local_space
  const locRecord = loc || _getL0CellRecord(gameState);
  const locLabel  = locRecord
    ? (locRecord.name || (w.position ? `cell(${w.position.mx},${w.position.my}:${w.position.lx},${w.position.ly})` : 'location'))
    : 'location';
  const lines = [];

  // ── TRUTH BLOCK (always first) ─────────────────────────────────────────────
  lines.push('CONTINUITY — TRUTH');
  lines.push('═══════════════════════════════════════════');

  const visible = (loc && loc._visible_npcs) || [];
  let truthLines = 0;

  // Player attributes — always first in TRUTH block (layer-agnostic)
  const player      = gameState.player;
  const playerAttrs = player?.attributes ? Object.values(player.attributes) : [];
  if (playerAttrs.length > 0) {
    const pStr = playerAttrs.map(a => `${a.bucket}:${a.value}`).join(' | ');
    lines.push(`You: ${pStr}`);
    truthLines++;
  }

  // Entity attributes
  for (const npc of visible) {
    if (!npc.attributes || !Object.keys(npc.attributes).length) continue;
    const label = npc.npc_name ? `${npc.npc_name} (${npc.id})` : `${npc.job_category || 'person'} (${npc.id})`;
    const attrs = Object.values(npc.attributes)
      .map(a => a.value)
      .join(' | ');
    lines.push(`${label}: ${attrs}`);
    truthLines++;
  }

  // Location attributes — includes L0 cell attributes via locRecord fallback
  if (locRecord && locRecord.attributes && Object.keys(locRecord.attributes).length) {
    const locAttrs = Object.values(locRecord.attributes)
      .map(a => a.value)
      .join(' | ');
    lines.push(`[${locLabel}]: ${locAttrs}`);
    truthLines++;
  }

  if (truthLines === 0) {
    lines.push('(no promoted facts yet for this scene)');
  }

  lines.push('');

  // ── MOOD BLOCK (always second) ─────────────────────────────────────────────
  lines.push('CONTINUITY — MOOD');
  lines.push('─────────────────────────────────────────────');

  const moodHistory = w.mood_history || [];
  const recent = moodHistory.slice(-MOOD_WINDOW);

  if (!recent.length) {
    lines.push('(no mood data yet)');
  } else {
    // Render most recent snapshot for narrator — trajectory context from prior entries
    const latest = recent[recent.length - 1];
    lines.push(`tone: ${latest.tone || '—'}`);
    lines.push(`tension: ${latest.tension_level || '—'} (${latest.tension_direction || '—'})`);
    lines.push(`conversation: ${latest.conversational_state || '—'}`);
    lines.push(`focus: ${latest.scene_focus || '—'}`);
    lines.push(`shift: ${latest.delta_note || '—'}`);

    // Prior trajectory — one-liner per entry if more than one
    if (recent.length > 1) {
      lines.push('');
      lines.push('recent trajectory:');
      for (const snap of recent.slice(0, -1).reverse()) {
        lines.push(`  T-${snap.turn}: ${snap.tone} / ${snap.tension_level} ${snap.tension_direction} / ${snap.delta_note}`);
      }
    }
  }

  // ── CONTEXT — RECENT LOCATION (L0 only, single-use) ─────────────────────────
  // Shows env facts canonically accepted by Phase B for the player's prior position.
  // NOT current-scene truth — prior-cell context for narrative continuity.
  // Cleared after one read so stale facts never linger across turns.
  const _ctxLoc = w._lastPhaseBLoc;
  if (_ctxLoc && Array.isArray(_ctxLoc.features) && _ctxLoc.features.length > 0) {
    lines.push('');
    lines.push('CONTEXT — RECENT LOCATION');
    lines.push('─────────────────────────────────────────────');
    lines.push(`[${_ctxLoc.locationRef} — prior position]: ${_ctxLoc.features.join(' | ')}`);
    w._lastPhaseBLoc = null; // single-use: clear after read
  }

  return lines.join('\n');
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  CB_VERSION,
  runPhaseB,
  assembleContinuityPacket,
  getLastRunDiagnostics,
};
