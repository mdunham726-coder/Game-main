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
const STATE_ATTR_WINDOW = 5;    // state: bucket decay window — state facts older than this many turns are suppressed from the narrator TRUTH block
                                // physical: and object: buckets are permanent and always included
                                // NOTE: state: is a mixed bucket (ephemeral motion + ongoing aftermath); a future pass may split
                                //   into state:ephemeral (window=1-2) and state:persistent (longer/condition-backed)
const ENV_ATTR_WINDOW   = 20;   // cap on env attributes emitted per entity (NPC or location) in the TRUTH block
                                // sorted by turn_set desc so the most recent facts survive the cut
const CB_VERSION        = '1.5.2';
// v1.5.2 — founding NPC extraction: starting_npc field added to founding_premise schema and prompt;
//           Phase B write-back populates birth_record.starting_npc; NPC-FILL npc_name guard added.

// ── Diagnostics ───────────────────────────────────────────────────────────────
let _lastRunDiagnostics = null;

function getLastRunDiagnostics() { return _lastRunDiagnostics; }

function _setDiag(d) { _lastRunDiagnostics = d; }

// ── Extraction prompt ─────────────────────────────────────────────────────────

function _buildExtractionPrompt(frozenNarration, gameState, previousMoodSnapshot, rawInput, currentTurn, tlsPartialStackTakeReceipt, tlsPartialStackDropReceipt, tlsPartialStackThrowReceipt) {
  const location         = _describeLocation(gameState);
  const entities         = _describeVisibleEntities(gameState);
  const knownPlayerAttrs = _describePlayerAttributes(gameState);
  const activeConditions = _describeActiveConditions(gameState);
  const trackedObjects   = _describeTrackedObjects(gameState);
  const apContext        = _describeApActionsThisTurn(gameState);
  const prevMood  = previousMoodSnapshot
    ? JSON.stringify(previousMoodSnapshot, null, 2)
    : '(none — first turn)';
  const isFoundingTurn = (gameState.turn_history || []).length === 0;

  // v1.84.65: build authoritative valid containers list for this turn's scope
  const _vcPos  = (gameState.world || {}).position;
  const _vcLoc  = (gameState.world || {}).active_local_space || (gameState.world || {}).active_site;
  const _vcLines = ['- player  (player inventory)'];
  // v1.84.87: suppress cell key when inside a localspace — the interior floor is the correct container,
  // not the parent outdoor tile. Emitting both caused CB to pick the cell key (prior training bias).
  if (_vcPos && !(_vcLoc && _vcLoc.local_space_id)) _vcLines.push(`- LOC:${_vcPos.mx},${_vcPos.my}:${_vcPos.lx},${_vcPos.ly}  (current cell)`);
  // v1.84.85: add localspace floor when player is at L2 depth
  if (_vcLoc && _vcLoc.local_space_id) _vcLines.push(`- ${_vcLoc.local_space_id}  (localspace floor — container_type: localspace)`);;
  // v1.88.11: L0 fallback — when active_local_space and active_site are both null, fall back to world._visible_npcs so BORN-NPCs at L0 appear as valid containers
  const _vcVisNpcs = (_vcLoc && _vcLoc._visible_npcs) || (gameState.world || {})._visible_npcs || [];
  for (const _vn of _vcVisNpcs) { if (_vn.id) _vcLines.push(`- ${_vn.id}  (NPC: ${_vn.npc_name || _vn.id})`); }
  const _validContainersList = _vcLines.join('\n');
  const _authoritativeOperationReceiptContext = tlsPartialStackTakeReceipt ? `
=== VALIDATED AUTHORITATIVE OPERATION RECEIPT — CURRENT TURN ===
schema_version: "cb_tls_partial_stack_take_v1"
authority: "tls_object_helper"
turn_number: ${tlsPartialStackTakeReceipt.turn_number}
operation_type: "tls_partial_stack_take"
status: "executed"
actor_ref: "player"
source_object_id: ${tlsPartialStackTakeReceipt.source_object_id}
source_persists: true
successor_object_id: ${tlsPartialStackTakeReceipt.successor_object_id}
successor_created_this_turn: true
extracted_quantity: ${tlsPartialStackTakeReceipt.extracted_quantity}
destination_container_type: "player"
destination_container_id: "player"

This validated receipt is authoritative execution evidence for Continuity Brain reporting only. It proves that TLS/ObjectHelper already completed the identified operation during the current request. It does not authorize Continuity Brain to create, move, transfer, decrement, replay, repair, or otherwise mutate either object or any other authoritative state. Use the receipt IDs only as prompt-side classification anchors for the source and successor governed by PARTIAL TAKE RECEIPT PRECEDENCE. The only permitted receipt-governed output is partial_take_successor_description. Do not report, replay, restate, or repair that operation through object_candidates, object_transfers, extraction_events, fission_events, or object_retirements. If this validated block is absent, do not reconstruct or infer it from narration, object names, containers, verbs, ordering, pluralization, diagnostics, witnesses, AP evidence, persistent state, or fuzzy matching.
=== END VALIDATED AUTHORITATIVE OPERATION RECEIPT ===
` : '';
  const _authoritativePartialDropReceiptContext = tlsPartialStackDropReceipt ? `
=== VALIDATED AUTHORITATIVE PARTIAL DROP RECEIPT - CURRENT TURN ===
schema_version: "cb_tls_partial_stack_drop_v1"
authority: "tls_object_helper"
turn_number: ${tlsPartialStackDropReceipt.turn_number}
operation_type: "tls_partial_stack_drop"
status: "executed"
actor_ref: "player"
source_object_id: ${tlsPartialStackDropReceipt.source_object_id}
source_persists: true
successor_object_id: ${tlsPartialStackDropReceipt.successor_object_id}
successor_created_this_turn: true
requested_quantity: ${tlsPartialStackDropReceipt.requested_quantity}
extracted_quantity: ${tlsPartialStackDropReceipt.extracted_quantity}
source_quantity_before: ${tlsPartialStackDropReceipt.source_quantity_before}
source_quantity_after: ${tlsPartialStackDropReceipt.source_quantity_after}
source_container_type: "${tlsPartialStackDropReceipt.source_container_type}"
source_container_id: "${tlsPartialStackDropReceipt.source_container_id}"
destination_container_type: "${tlsPartialStackDropReceipt.destination_container_type}"
destination_container_id: "${tlsPartialStackDropReceipt.destination_container_id}"

TLS/ObjectHelper already executed this exact partial split during the current request. The identified source persisted at its reduced quantity in its retained authoritative container, and the distinct same-turn successor was created directly in the identified destination. Neither fact is whole-object movement. This receipt gives Continuity Brain reporting and classification context only; it does not authorize Continuity Brain to create, move, transfer, split, retire, replay, repair, or otherwise mutate either object or any authoritative state. Use the receipt IDs only as classification anchors for PARTIAL DROP RECEIPT PRECEDENCE, and never copy them into output witness fields as mutation authority. If this validated block is absent, do not reconstruct or infer it from narration, names, aliases, containers, diagnostics, AP evidence, persistent state, or fuzzy matching.
=== END VALIDATED AUTHORITATIVE PARTIAL DROP RECEIPT ===
` : '';
  const _authoritativePartialThrowReceiptContext = tlsPartialStackThrowReceipt ? `
=== VALIDATED AUTHORITATIVE PARTIAL THROW RECEIPT - CURRENT TURN ===
schema_version: "cb_tls_partial_stack_throw_v1"
authority: "tls_object_helper"
turn_number: ${tlsPartialStackThrowReceipt.turn_number}
operation_type: "tls_partial_stack_throw"
status: "executed"
actor_ref: "player"
source_object_id: ${tlsPartialStackThrowReceipt.source_object_id}
source_persists: true
successor_object_id: ${tlsPartialStackThrowReceipt.successor_object_id}
successor_created_this_turn: true
requested_quantity: ${tlsPartialStackThrowReceipt.requested_quantity}
extracted_quantity: ${tlsPartialStackThrowReceipt.extracted_quantity}
source_quantity_before: ${tlsPartialStackThrowReceipt.source_quantity_before}
source_quantity_after: ${tlsPartialStackThrowReceipt.source_quantity_after}
source_container_type: "${tlsPartialStackThrowReceipt.source_container_type}"
source_container_id: "${tlsPartialStackThrowReceipt.source_container_id}"
destination_container_type: "${tlsPartialStackThrowReceipt.destination_container_type}"
destination_container_id: "${tlsPartialStackThrowReceipt.destination_container_id}"

TLS/ObjectHelper already executed this exact partial split during the current request. The identified source persisted at its reduced quantity in its retained authoritative container, and the distinct same-turn successor was created directly in the identified destination. Neither fact is whole-object movement. This receipt gives Continuity Brain reporting and classification context only; it does not authorize Continuity Brain to create, move, transfer, split, retire, replay, repair, or otherwise mutate either object or any authoritative state. Use the receipt IDs only as classification anchors for PARTIAL THROW RECEIPT PRECEDENCE, and never copy them into output witness fields as mutation authority. If this validated block is absent, do not reconstruct or infer it from narration, names, aliases, containers, diagnostics, AP evidence, persistent state, or fuzzy matching.
=== END VALIDATED AUTHORITATIVE PARTIAL THROW RECEIPT ===
` : '';

  return `EXTRACTION TASK — TURN ${currentTurn}

You are a forensic extraction system. Your job is to read the narration below and identify structured facts. You are NOT summarizing. You are NOT interpreting. You are identifying what a stationary camera in the room would capture.

${isFoundingTurn ? `TURN 1 — FOUNDING EXTRACTION
This is the player's very first turn. You have two sources. Use them as directed below.

PRIMARY SOURCE — Player's verbatim founding input (original casing, unedited):
"${gameState.player?.birth_record?.raw_input || '(not captured)'}"

CONTEXT ONLY — Narrator's opening narration (may contain embellishment and creative flavoring):` : 'NARRATION (verbatim):'}
${frozenNarration}

CURRENT ENGINE STATE:
Active location: ${location}
Valid containers for object placement this turn:
${_validContainersList}
Grid container_id MUST be an exact LOC:... value from this list. NPC container_id MUST be copied exactly from the ID shown in this list — do not construct or derive it from the NPC's name or any other string. Never use prose labels (overworld, ground, current cell, nearby, area, field) — they are not valid container IDs and will be rejected. If narration implies an object in a container not on this list, omit that object.
Current player input (this turn): "${rawInput || ''}"
CURRENT AUTHORITATIVE PLAYER INVENTORY (AFTER ENGINE/TLS PROCESSING): ${(() => { const _cbIds = Array.isArray(gameState.player?.object_ids) ? gameState.player.object_ids : []; const _cbObjs = (gameState.objects && typeof gameState.objects === 'object') ? gameState.objects : {}; const _cbNames = _cbIds.map(id => _cbObjs[id]?.status === 'active' ? _cbObjs[id].name : null).filter(Boolean); return _cbNames.length ? _cbNames.join(', ') : '(empty)'; })()}
Visible entities: ${entities}
Player character: always present — entity_ref "player" | known attributes: ${knownPlayerAttrs}
Active player conditions: ${activeConditions}
Tracked objects in scene:
${trackedObjects}
${apContext ? `\nPlayer actions this turn (use to identify which specific object was physically affected):\n${apContext}` : ''}
${_authoritativeOperationReceiptContext}${_authoritativePartialDropReceiptContext}${_authoritativePartialThrowReceiptContext}

PREVIOUS MOOD SNAPSHOT:
${prevMood}

---

Produce a JSON object with EXACTLY these top-level keys. Do not add, remove, or merge any keys.

{
  "entity_candidates": [...],
  "environmental_features": [...],
  "spatial_relations": [...],
  "rejected_interpretations": [...],
  "mood_snapshot": { ... },
  "condition_events": [...],
  "object_candidates": [],
  "visible_objects": [],
  "object_transfers": [],
  "object_condition_updates": [],
  "object_retirements": [],
  "fission_events": [],
  "extraction_events": []${tlsPartialStackTakeReceipt ? `,
  "partial_take_successor_description": {
    "description": "<brief child-specific physical description grounded in the narration>",
    "evidence": "<one contiguous verbatim supporting substring from the narration>"
  }` : ''}${tlsPartialStackDropReceipt ? `,
  "partial_drop_successor_description": {
    "description": "<brief child-specific physical description grounded in the narration>",
    "evidence": "<one contiguous verbatim supporting substring from the narration>"
  }` : ''}${tlsPartialStackThrowReceipt ? `,
  "partial_throw_successor_description": {
    "description": "<brief child-specific physical description grounded in the narration>",
    "evidence": "<one contiguous verbatim supporting substring from the narration>"
  }` : ''}${isFoundingTurn ? `,
  "founding_premise": {
    "form": null,
    "location_premise": null,
    "possessions": [],
    "capabilities": [],
    "status_claims": [],
    "scenario_notes": [],
    "canonical_name": null,
    "title_or_role": null,
    "starting_npc": null
  }` : ''}
}

---

ENTITY REFERENCE RULE:
Check the Visible entities list above before writing any entity_ref.
If the entity matches a known entry, use the EXACT npc_id as shown (e.g. "player#born_npc_example").
NPC IDs may contain namespace prefixes separated by "#" (e.g. "player#born_npc_...") — copy the FULL ID exactly as shown, including any prefix before "#". Never truncate or reformat.
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
  "held_objects": ["<item name string>"],
  "worn_objects": ["<item name string>"],
  "rejected_interpretations": []
}

physical_attributes
  Permanent or semi-permanent features of the body.
  Test: "Would this still be true if I walked away and came back tomorrow?"
  Include only features that exist independently of context, mood, or current activity. Exclude emotional expressions, behavioral tendencies, and inferred character traits.

observable_states
  Current verifiable condition. Changeable. No inference required.
  Test: "Can I confirm this by looking, without guessing why?"
  Include only states that are directly visible — posture, position, and physical indicators confirmable on sight without knowing the reason. Exclude intent, emotion, and states that require inference to identify. When an observable state is a visible sign of bodily harm to the player, the underlying injury must also be emitted as a condition_event. An observable state does not absorb a condition.

held_objects
  Output a JSON array of non-empty item-name strings only. Never emit objects or nested arrays; do not include descriptions, quantities, units, IDs, or container metadata in this field.
  Items carried, held, slung, packed, or hanging at the hip of THIS entity.
  Route here: rifle slung over shoulder, pack on back, satchel at hip, item in hand, anything loaded or stowed as cargo.
  Test: "Is this something they are carrying or transporting — not wearing as attire?"
  Include only explicitly named items. Exclude category labels, vague collective nouns, and absence descriptions.

FISSION EXCEPTION: An observable state does not replace a fission retirement. When a tracked object is torn, split, halved, divided, sliced, cut, or broken, recording the player's observable state (holding pieces, gripping halves, clutching torn material) does not substitute for emitting object_retirements with successors[]. The lifecycle event must be recorded in object_retirements. The observable state may still describe the player's resulting posture or physical condition, but it must not serve as the sole output for a fission event.

FISSION EXCEPTION: Do not route the resulting pieces of a fission event into held_objects. When a tracked object is split, torn, halved, divided, sliced, cut, chopped, broken, or snapped, the original object must be retired with successors[] in object_retirements — regardless of whether narration describes the player immediately picking up or holding the resulting pieces. The player's possession of the pieces is captured by the retirement's successors[], not by held_objects. Routing the pieces into held_objects without also emitting the retirement is always wrong when the source was a tracked object.

worn_objects
  Output a JSON array of non-empty item-name strings only. Never emit objects or nested arrays; do not include descriptions, quantities, units, IDs, or container metadata in this field.
  Items worn, equipped, or fitted to the body of THIS entity as clothing or gear.
  Route here: boots, belt, hat, jacket, armor, cloak, gloves, scabbard, holster, any clothing or body-fitted equipment.
  Test: "Is this on their body as attire or fitted gear — not cargo?"
  Include only explicitly named items. Exclude category labels and absence descriptions.

rejected_interpretations (per-entity)
  REQUIRED. Items you considered but rejected. Format: "phrase → reason"
  Capture interpretive, emotional, metaphorical, and inferential phrases from the narration that did not qualify for any field above.

---

ENVIRONMENTAL FEATURES

Physical props and conditions belonging to the LOCATION, not any entity.
Test: "Would this be here if there were no people in the room?"

Format: { "location_ref": "<location name>", "features": [...] }

Include only concrete, named physical objects or material conditions of the space itself. Exclude mood, atmosphere, interpretation, and ambiguous sensory descriptions unless a specific physical state is explicitly named.
Note: named, specific objects visible through a window, display case, or barrier but not directly reachable are NOT environmental features. Place them in visible_objects[] instead.

---

SPATIAL RELATIONS

Verifiable positional facts. One per entry. Short natural language.
Test: "Is this a position, or an inference about intent?"

Include only positions and orientations that are explicitly stated in the narration. Exclude intent inferences, mood descriptions, and anything requiring a guess about purpose or feeling.

---

TOP-LEVEL REJECTED INTERPRETATIONS

Items about the scene or environment as a whole that you identified but rejected.
These are scene-level or environment-level inferences that don't belong to any single entity.

Format: ["phrase → reason", ...]

Capture scene-level mood, atmosphere, inferred future events, and interpretive framing that cannot be verified from physical observation alone.

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
  Two to three short adjective labels, comma-separated. Must be a mood or atmosphere label — not a prose sentence or narrative description.

scene_focus
  A concrete noun phrase naming what the scene's attention centers on. Must identify a specific object, place, or person — not a feeling, abstraction, or interpretive framing.

delta_note
  One short phrase describing what changed this turn, or 'stable — no shift'. A single phrase only — not a sentence, not an explanation.

Respond with ONLY the JSON object. No explanation, no wrapper text.

---

CONDITION EVENTS

Review the narration for evidence of new physical conditions or interactions with existing conditions.
Active player conditions are listed above.

CRITICAL RULE: When evidence is ambiguous or requires inference, do not emit — omission is preferred over fabrication. When the narration explicitly describes a physical effect on the player's body, that is not inference — emit it. The condition_events and observable_states buckets are not mutually exclusive. A visible sign of bodily harm belongs in observable_states; the underlying bodily injury belongs in condition_events. When both apply, both must be emitted.

event_type rules:
- "new_condition": narration explicitly describes a new physical harm, impairment, contamination, intoxication, illness, residue, or embedded foreign material affecting the player, not already in the active list. The evidence must state the condition directly, not imply it.
- "interaction": narration shows usage, aggravation, or treatment of an existing active condition. Only emit if you can match to a condition in the active list by exact condition_id. If no match exists, do not emit.

Format each event:
{
  "event_type": "new_condition" | "interaction",
  "condition_id": "<interaction only — exact condition_id from the active conditions list above. Must match exactly.>",
  "initial_description": "<new_condition only — plain-language snapshot of current state. No inference. No prognosis. No timeline.>",
  "interaction_type": "<interaction only — one of: aggravation | treatment | usage>",
  "evidence": "<exact phrase from narration that supports this event>"
}

IMPORTANT for interaction events: you MUST use the exact condition_id string from the active conditions list. Do not use a description label. If you cannot identify the matching condition_id with certainty, do not emit the event.

If there are no condition events, emit an empty array: "condition_events": []

${isFoundingTurn ? `---

FOUNDING PREMISE (Turn 1 only)

Extract the player's founding premise from the PRIMARY SOURCE (player's verbatim input).

SOURCE PRECEDENCE RULES — read carefully:
1. PRIMARY SOURCE is the player's own words. Extract ONLY what is explicitly stated there.
2. CONTEXT (narration) is a fallback — use it ONLY when primary source is silent or ambiguous on a field.
3. ANTI-DRIFT: If the player wrote "I am a merchant", write form: "merchant". Do NOT expand to "weathered merchant from distant lands" even if the narration added that flavor. The birth_record must reflect what the player said, not what the narrator embellished.
4. If a field cannot be determined from the primary source AND the narration provides no factual grounding, leave it null or empty.

Fields:
  form             — the player's currently embodied physical form: what kind of body or being they are, as explicitly stated in primary source. Do NOT include personal names, titles, ranks, occupations, social roles, affiliations, or other identity/authority/history assertions — form is a physical fact about the body, not a social fact about the person. Do NOT include clothing, equipment, posture, or a physical condition that does not itself change what kind of body or being the player currently is — a transformation into a different body or kind is still a form, even if temporary or reversible. null if not stated.
  location_premise — starting location as stated in primary source (e.g. "city gates", "the Thornwood road"). null if not stated.
  possessions      — items explicitly named in primary source as owned or carried. Do NOT include abilities, powers, or things the player can do — those belong in capabilities. Empty array if none stated.
  capabilities     — abilities, powers, or things the player can do, as explicitly stated in primary source. Do NOT include physical items — those belong in possessions. Empty array if none stated.
  status_claims    — identity, authority, or history assertions from primary source. Empty array if none.
  scenario_notes   — freeform notes ONLY when primary source is ambiguous AND narration adds clear factual grounding (not embellishment). Empty array if no grounding exists.
  canonical_name   — the player's personal name if explicitly stated. A word or phrase the player uses to refer to themselves as a specific individual, distinct from a title, role, or job descriptor. Only extract what is explicitly stated — do not infer. null if not stated.
  title_or_role    — a formal title, rank, or positional designation if explicitly claimed. A social or authoritative label, not a personal name. Only extract what is explicitly stated — do not infer. null if not stated.
  starting_npc     — a single NPC declared by the player in the founding input. null if no NPC is declared.
    When present, extract as a single object (never an array) with these fields:
      name            — the name the player explicitly gave this NPC. null if no name was stated. Never infer a name into this field.
      generated_name  — a canonical name fitting the NPC's role and the world tone. Required only when name is null. Extraction scaffolding — not stored as a separate engine field.
      role_or_relation — the NPC's relationship to the player or occupational role as stated in the founding input.
      description     — brief physical description if stated. null if not stated.
      gender          — infer from role, description, and world tone. null only if genuinely indeterminate.
      age             — integer, infer from role and description. null if indeterminate.
      job_category    — occupation or role category fitting the world context. null if indeterminate.
      inventory_items — array of objects for items the NPC is explicitly described as carrying. Each entry: { "name": "<item name, lowercase specific>", "description": "<brief physical description of the item — no lore, no ownership claims, no history, no implied additional objects>" }. Empty array if none stated. Never add items not stated. Description is inferred from the item and world tone, but only for items already stated.
      worn_items      — array of objects for items the NPC is explicitly described as wearing. Same object shape as inventory_items: { "name": "<item name, lowercase specific>", "description": "<brief physical description of the item — no lore, no ownership claims, no history, no implied additional objects>" }. Empty array if none stated. Never add items not stated. Description is inferred from the item and world tone, but only for items already stated.
    If multiple NPCs are declared, instantiate only the first. Record additional NPCs in scenario_notes as "DEFERRED_NPC: <description>". Deferred NPCs are not scene truth and must not appear as present entities.

TURN 1 NPC EQUIPMENT CHANNEL OWNERSHIP — MANDATORY:
- founding_premise.starting_npc.inventory_items and worn_items contain only equipment explicitly stated in PRIMARY SOURCE; those fields authorize founding birth records.
- Separately, entity_candidates[].held_objects and worn_objects describe concrete equipment explicitly shown on matched NPCs in CONTEXT narration. Include such narrated equipment even when PRIMARY SOURCE did not name it. Do not add narration-only equipment to founding_premise.starting_npc.
- If an item is currently narrated as held or worn by an NPC and is emitted in those entity fields, do not also emit it in object_candidates on Turn 1. The entity fields are the exclusive NPC-equipment observation channel for this turn.
- This rule overrides the complete scene inventory mandate below for this object class.

` : ''}

---

OBJECT CANDIDATES (optional)

Your goal is a complete inventory of all concrete, portable physical objects present in this
scene — not a filtered list of the most active or salient ones. Extract every named concrete
portable object in the narration whether it is actively handled or merely present (on a surface,
in a pile, within reach, described as part of the setting). A named object's passive presence in
the narration is sufficient reason to emit a candidate. Do not apply a salience or relevance
filter — if it is named, portable, and concrete, extract it. For plural or group mentions, emit
a single group object candidate unless the narration clearly distinguishes individual instances.
First decide whether the object should be extracted. Then independently decide its physical
container — do not let the reason an object was extracted determine its container. If the
narration shows a specific instance being held, eaten, drunk, used, carried, grabbed, lifted,
bitten, unwrapped, or otherwise physically manipulated by the player or an NPC, that specific
instance belongs in the player or npc container even if similar objects are also present in the
scene. Sensory contact also signals possession: phrases such as "soft under my fingers" or
"warm in my hand" indicate physical handling — assign to the actor's container. Passive
surface/pile/table presence applies only to objects that are not actively possessed or
manipulated. When the same object is described as a scene or surface item earlier in the
narration and later picked up or manipulated by the player or NPC in the same narration, the
manipulation state is authoritative for container assignment — override the earlier placement.
Do NOT include furniture, architecture, or fixed features.
Do NOT include objects that are ambiguous or only implied.
Do NOT emit an object_candidate for an object that is visible but spatially separated from the player by a barrier (display window, glass pane, counter, locked case, enclosed shelf, or any other physical boundary). Even if concrete and named, if the player cannot directly touch or take it without crossing a barrier or triggering an additional action, place it in visible_objects[] instead.
Figurative or embellished prose does not disqualify extraction. Apply this test: is there a
concrete, portable physical object named in the phrase? If yes, extract it — evocative adjectives,
dramatized verbs, and metaphorical modifiers around a named object do not nullify the object's
existence. If no concrete portable noun is named — only a metaphor, impression, or abstract
quality — do not invent an object.
Do NOT emit a promote candidate for an object that already appears in TRACKED OBJECTS above.
Objects annotated with "nearby (1 tile)" in TRACKED OBJECTS are placed objects at a fixed floor location adjacent to the player — treat them as tracked and do not emit promote candidates for them.
SOURCE-SURVIVING SEPARATION EXCLUSION:
When a product's asserted existence depends on removal from a tracked source that persists
after the operation, do not emit that product in object_candidates. Report the depicted removal
only through \`extraction_events\` as a nonauthoritative witness. This witness does not authorize
state mutation or product creation.
A validated authoritative partial-operation receipt overrides this generic witness route:
follow the receipt-specific precedence and emit only its permitted dedicated metadata, not a
generic extraction witness.
This exclusion does not change ordinary independent object candidates, authorized founding
objects, NPC-introduced objects, fission handling for a source that does not persist, or transfers
of existing tracked objects.
If a tracked object moved to a new container this turn, capture that movement in object_transfers
using the exact object_id from TRACKED OBJECTS — not a promote candidate. Emitting a promote for
an already-tracked object creates a phantom duplicate with a new ID.

CONTAINER-CHANGE IDENTIFICATION RULE:
When the narration describes a physical relocation action (set down, place, put, drop, slide,
push, lay, leave beside, move) applied to an object — and that object resolves to ONE clearly
identified tracked object — emit a TRANSFER of the existing object_id. Do NOT promote.

The referent qualifies as "clearly identified" under exactly ONE of these conditions:
  (a) Exact name match — narration name matches a tracked object name exactly.
  (b) Strong normalized alias — a subset of the tracked name that uniquely identifies one
      tracked object (e.g. "Baja Blast" uniquely matches "mountain dew baja blast" if no
      other tracked object shares that substring).
  (c) Actor-association alias — a possessive reference whose actor resolves to exactly one
      tracked object: "my drink" → tracked object with actor: player; "Bob's soda" → tracked
      soda/drink with actor: Bob.

Do NOT apply container-change transfer when:
  - Two or more tracked objects could plausibly match (e.g. two cups, two sodas, two drinks).
  - The reference is proximity-only ("the drink nearest my hand", "that one", "the cup").
  - The reference is a bare generic noun with no actor association and multiple possible matches.

If the referent is ambiguous, leave the action unresolved — do not promote a duplicate, do not
guess. Ambiguity is not an error; silence is the correct output.

For each object, emit one entry in the "object_candidates" array:
{
  "temp_ref": "<short stable handle — reuse the same ref if this object appears again in a later turn>",
  "name": "<object name, lowercase, specific>",
  "description": "<brief physical description>",
  "container_type": "grid" | "npc" | "player" | "localspace",
  "container_id": "<exact value from valid containers list above — use the localspace ID when inside a localspace>",
  "reason": "<exact phrase from narration supporting this placement>",
  "actor_npc_ref": "<optional — see ACTOR ASSOCIATION RULES below>",
  "initial_condition": "<optional — concrete physical state if the object is introduced in a non-pristine state this turn>",
  "initial_evidence": "<optional — exact narration phrase that establishes the initial condition>",
  "quantity": "<optional — integer count when narration explicitly states a number (e.g. 'three coins', 'a dozen arrows', '12 slices'). Omit when count is unspecified or clearly singular.>",
  "unit": "<optional — unit label when narration gives one (e.g. 'piece', 'slice', 'coin', 'arrow'). Omit when not stated. Must match the name field (e.g. name:'bread slice' unit:'slice').>",
  "transfer_origin": "<required when container_type is 'player' AND item is not in Confirmed player inventory above — see TRANSFER ORIGIN RULES below>"
}

quantity and unit rules:
- EMIT quantity only when the narration or player input contains an explicit count (a numeral or spelled-out number directly attached to this object).
- DO NOT EMIT quantity for singular objects, vague amounts ('some', 'a few', 'several'), or when count is unknown.
- DO NOT EMIT quantity: 1 explicitly — singular is the default and omitting the field is correct.
- EMIT unit only when the narration uses a clear unit label that meaningfully describes a single instance of the stack (e.g. 'slice' for bread slices, 'coin' for coins). Omit for abstract or unnamed units.
- Both fields are optional and independent — quantity can appear without unit and vice versa.

initial_condition rules:
- EMIT when the object is introduced already damaged, modified, or in a non-default state (e.g. split skin, cracked, soaked, bent).
- DO NOT EMIT for objects in their original, unmodified state (pristine, intact, undamaged, normal, clean, whole).
- Same ACCEPT/REJECT rules as object_condition_updates.
- Omit both fields entirely if the object is in its original state.

TRANSFER ORIGIN RULES (apply when classifying new player-held objects):

  npc_transfer          — An NPC performed an explicit physical transfer: gave, handed,
                          pressed, passed, dropped at player's feet. NPC is causal agent.
                          Player input irrelevant. ALLOW.

  environment_interaction — ALL FOUR must be true:
                          (1) Player input was an acquisition request (take, pick up, grab,
                              collect, lift, break, tear, scoop, pull from ground, etc.)
                              IMPORTANT: examine, search, check, look, inspect, and
                              investigate are NOT acquisition verbs — they are discovery
                              actions. If the player's input uses any of these verbs with
                              no accompanying take/grab/pick-up instruction, condition (1)
                              is NOT met. Classify such items as narrator_independent
                              (container_type: grid or localspace), NOT
                              environment_interaction.
                              COMPOUND TURNS: on inputs containing multiple actions,
                              evaluate condition (1) per individual object-action pair.
                              If any acquisition verb in the player's input is directly
                              paired with this specific object (e.g. "grab [object]",
                              "tear open [object]", "pick up [object]"), condition (1)
                              is met for that object regardless of other non-acquisition
                              actions in the same input. Trace each named object to its
                              specific verb — do not evaluate the turn globally.
                          (2) Item has environmental basis in described scene (ground, floor,
                              attached to something visible, plausible feature of location).
                          (3) Player input does NOT frame item as already held, carried,
                              or being displayed.
                          (4) Narration explicitly confirms the item was successfully acquired —
                              described as detached, collected, plucked, or transferred to the
                              player. If the narration shows the attempt failing, the item
                              remaining in place, or the item staying attached or embedded,
                              do NOT emit an object_candidate for this item. ALLOW.

  narrator_independent  — Narrator introduced the item with no player request and no NPC
                          transfer. Player input did not reference the item in any way.
                          CONTAINER RESTRICTION: must use container_type 'grid' or 'localspace'
                          only — NEVER 'player'. This is an absolute rule with no exceptions.
                          SELF-CORRECTION: if you find yourself assigning container_type
                          'player' with transfer_origin 'narrator_independent', you have made
                          a classification error — stop and reassign: use
                          'environment_interaction' if any acquisition verb in the player's
                          input directly pairs with this object, or change container_type to
                          'localspace' if the narrator placed it on a surface. The combination
                          narrator_independent + player container is always wrong.
                          The narrator may place items in the environment (on a table, on the
                          floor, on the ground), but narrator prose alone cannot put an item in
                          the player's hand. If the narration described the item as "in your
                          hand" or "in your pocket" but the player never requested it and no
                          NPC gave it, classify container_type as 'grid' (current
                          floor/surface) — not 'player'. ALLOW for grid/localspace.

  player_claimed        — Player input mentioned, implied, or gestured the item as currently
                          held, gathered, shown, or carried — in any form: speech ("I have X"),
                          emote (*holds up X*), assertion, or background claim
                          ("I've been gathering X").
${isFoundingTurn ? `                          FOUNDING TURN EXCEPTION: When the PRIMARY SOURCE explicitly establishes a
                          concrete portable possession, emit exactly one object_candidates entry
                          for that possession with container_type: "player", container_id: "player",
                          and transfer_origin: "player_claimed". Preserve any explicitly stated
                          quantity. Also record the possession in founding_premise.possessions.
                          This exception overrides the normal player_claimed block on the founding
                          turn only. ALLOW.` : `                          BLOCK.`}

TIE-BREAK: when in doubt, classify as player_claimed.

${isFoundingTurn ? `FOUNDING TURN OVERRIDE: if the PRIMARY SOURCE names a concrete portable item as
held, shown, carried, or possessed, it is an authorized founding possession and must follow the
FOUNDING TURN EXCEPTION above.` : `OVERRIDE: if the item name or a clear reference to it appears in the player's input
framed as held, shown, or gathered — that is player_claimed with no exceptions.`}
The narrator's prose does not change this classification.

If no qualifying objects are present, emit: "object_candidates": []

FISSION EXCEPTION: Do not emit object_candidates for pieces, portions, fragments, or halves that are the direct result of splitting, tearing, or dividing a tracked object. Those resulting pieces belong exclusively in the successors[] array of the parent's object_retirement entry. Emitting them as candidates alongside a retirement creates duplicate records and is always wrong when the parent is being retired.

EXTRACTION EXCEPTION: Do not emit an \`object_candidates\` entry for the exact successor identified by the VALIDATED AUTHORITATIVE OPERATION RECEIPT as the direct child of the authoritative partial extraction. The child already exists in authoritative object state; CB reports the extraction and does not promote or recreate the child.

PARTIAL DROP RECEIPT EXCEPTION: When the VALIDATED AUTHORITATIVE PARTIAL DROP RECEIPT identifies the source and successor of an already-executed partial DROP, do not emit either identified object in \`object_candidates\` for that receipt-governed operation. Do not recreate the successor or reinterpret the surviving source as a new object.

  Emit actor_npc_ref when the narration signals EITHER of the following:

  TRIGGER 1 — Active physical interaction:
  The actor is physically doing something with the object: eating, drinking, using, holding,
  carrying, gripping, opening, wearing, reaching for, or physically manipulating the object.

  TRIGGER 2 — Possessive language (two strength tiers):

    Strong possessive — always emit:
    A possessive pronoun or possessive construction directly modifying the object name:
    first-person (my, mine) or third-person (his, her, their, [actor-name]'s).
    These are unambiguous ownership signals regardless of context.

    Contextual assignment — emit only for concrete possessible/usable items:
    Intent phrases (for me, for him, for [actor-name]) signal physical assignment ONLY when
    the object is something the actor will concretely hold, consume, wear, or carry.
    Do NOT emit when the phrase expresses purpose, destination, or abstract benefit rather
    than direct physical possession — the phrase must imply the actor ends up with the object,
    not merely that the object serves some function in relation to them.

  ACTOR REF VALUES:
  - First-person references (my, mine, for me) → use "player"
  - Third-person references to a known NPC (his, her, their, [NPC-name]'s, for [NPC-name])
    → use that NPC's entity_ref from entity_candidates (the same ref assigned this turn)

  DO NOT EMIT for spatial proximity alone:
  "near", "beside", "in front of", "behind", "next to", "between" are NOT triggers.
  Proximity without possessive language or active interaction → omit the field.

  Omit the field entirely when no actor is actively or possessively associated with this object.
  One actor_npc_ref per object candidate — the most directly involved actor only.

---

VISIBLE OBJECTS (optional)

Identify concrete, specific, named objects explicitly described in the narration that are NOT directly accessible from the player's current position due to a spatial boundary.

Use this category when ALL THREE conditions are true:
  (1) The object is concretely named or specifically described — not a generic reference.
  (2) The object is not in the player's inventory or worn items.
  (3) The object is separated from the player by a physical boundary of any kind.

Boundary test: "Can the player physically touch or take this object right now, without crossing a barrier, without asking an NPC, and without triggering a new action?"
  YES → use object_candidates[] instead.
  NO  → use visible_objects[] here.

Use object_candidates[] instead when the object is on open floor, directly within reach, or has been handed to the player.
Use environmental_features[] instead when the reference is generic or collective rather than a specific named object.

For each qualifying object, emit one entry:
{
  "name": "<object name, lowercase, specific>",
  "description": "<brief physical description>",
  "reason": "<exact phrase from narration supporting this placement>",
  "spatial_context": "<freeform short phrase describing the barrier or spatial separation — describe plainly what separates the player from the object>"
}

If no qualifying objects are present, emit: "visible_objects": []

---

OBJECT TRANSFERS (optional)

Identify objects that clearly changed hands or location in this narration.
Only emit when the narration explicitly describes the movement (e.g. handed over, dropped, taken).

PARTIAL TAKE RECEIPT EXCEPTION: Do not emit either object identified by the VALIDATED AUTHORITATIVE OPERATION RECEIPT in \`object_transfers\` for that receipt-governed operation. The source persisted in its retained container, and the successor was created directly in the destination; neither object transferred. The operation permits only \`partial_take_successor_description\` metadata. Independent transfers unrelated to that operation still use this channel normally.

PARTIAL DROP RECEIPT EXCEPTION: Do not emit either object identified by the VALIDATED AUTHORITATIVE PARTIAL DROP RECEIPT in \`object_transfers\` for that receipt-governed operation. The source persisted in its retained container, and the successor was created directly at the destination; neither object transferred.

Also emit a transfer when the narration shows an actor taking possession of, picking up, using,
handling, or beginning to consume/use/handle an already-tracked object that appears in TRACKED
OBJECTS with a localspace/grid/site container AND has an actor annotation (actor:) matching that
actor. Use the tracked object_id — do NOT emit a new promote candidate for this object.
Exception: do not apply this rule when the narration clearly introduces a new separate instance —
words like "another", "new", "second", "fresh", or "different" signal a genuinely new object that
should be promoted.

For each transfer, emit one entry in the "object_transfers" array.
IMPORTANT: identify the object by temp_ref (same-turn object from object_candidates above) OR by object_id (if it was established in a prior turn). Do NOT use name-only references.
For objects already listed in TRACKED OBJECTS, always use the exact object_id field — never use temp_ref alone for a tracked object. temp_ref is only valid for objects born this turn via a promote candidate in object_candidates.

{
  "temp_ref": "<if the object was promoted this turn — must match an entry in object_candidates>",
  "object_id": "<if the object already exists from a prior turn>",
  "from_container_type": "grid" | "npc" | "player" | "localspace",
  "from_container_id": "<exact value from valid containers list above>",
  "to_container_type": "grid" | "npc" | "player" | "localspace",
  "to_container_id": "<exact value from valid containers list above>",
  "reason": "<exact phrase from narration supporting this transfer>"
}

Promote container is the object's starting location this turn. If the object is also transferred
the same turn, the promote container is where it exists BEFORE the action; the transfer moves it
to the final destination. Never assign the same container as both the promote destination and the
transfer destination for the same temp_ref — doing so creates a redundant transfer that will be
silently skipped.

If no transfers occurred, emit: "object_transfers": []

---

OBJECT CONDITION UPDATES (optional)

Annotate tracked objects whose physical condition changed in this narration.
Only use object_ids listed in "Tracked objects in scene" above — exact IDs only.

Include only concrete, observable physical changes explicitly described in the narration. Exclude pristine or default states — an unmodified object requires no annotation. Exclude inferences and impressions — only emit when the physical change is stated directly.

Rules:
- Only emit when narration EXPLICITLY describes the physical change to the object.
- If PLAYER ACTIONS THIS TURN names the affected object, use that object_id.
- If two tracked objects share a name and the narration does not clearly distinguish them, and no player action context resolves it, emit a name_match entry instead — never omit a real condition.
- One entry per affected object only.
- When narration explicitly describes residue, debris, or material adhering to a tracked object that was used as an instrument, emit a condition update for that instrument. Implied contact alone does not qualify — the adhering material must be concretely described on the instrument in the narration.

Preferred form (use when object_id is unambiguous):
{
  "object_id": "<exact id from tracked objects list>",
  "condition": "<concrete physical state — short phrase only>",
  "evidence": "<exact phrase from narration>"
}

Fallback form (use only when same-name ambiguity cannot be resolved):
{
  "name_match": "<object name — exact text from narration>",
  "condition": "<concrete physical state — short phrase only>",
  "evidence": "<exact phrase from narration>"
}

If no object condition changes are present, emit: "object_condition_updates": []

FISSION EXCEPTION: Do not emit a condition update for an object when you are also emitting (or would emit) an object_retirement for that same object. Retirement means the object no longer exists as itself — annotating its condition is contradictory. If the object is being split or divided into pieces and you are classifying this as a fission event, the retirement is the correct and sole output for the parent — omit the condition update entirely.

---

OBJECT RETIREMENTS (optional)

When narration explicitly describes a tracked object physically ceasing to exist as itself — split into named sub-objects, fully consumed/eaten, destroyed with no remaining form — emit a retirement entry for the original.

EMIT for: object split into distinct sub-objects, object fully consumed/eaten, object burned to nothing.
DO NOT EMIT for: damage or condition change, movement, picking up, dropping, or any interaction that leaves the object intact.
Only use object_ids from "Tracked objects in scene" above — exact IDs only, never by name.

SPLIT VERB RECOGNITION: The following verbs, when applied to a tracked physical object and when the narration implies resulting pieces or transformed material, mandate a retirement entry with successors[]:
- Separation verbs: tear, rip, split, halve, divide, separate
- Cutting verbs: slice, cut, chop, carve
- Breaking verbs: break, snap, shatter, crack, fracture
This mandate overrides any other classification path — including interaction, manipulation, and entity held_objects events. Even when narration describes the player immediately holding or carrying the resulting pieces, the retirement for the original object must still be emitted. The destination of the pieces does not affect whether the parent retirement is required.
When one of these verbs applies to a tracked object AND the narration describes resulting pieces (halves, slices, chunks, shards, fragments, portions), emit the retirement with successors[]. Each distinct named stack is one successor entry — use quantity when a count is stated. If the object_id is uncertain, emit object_id: null rather than guessing. Omit successors[] only when the verb produces no trackable pieces (e.g. "snapped the twig and discarded both pieces" with no further scene presence, or "cut the rope" where no rope pieces appear in narration). The retirement+successors path is the exclusive output for a fission event — do not simultaneously emit a condition update for the parent object or emit the resulting pieces as object_candidates. Fission replaces both of those patterns, it does not supplement them.

OBJECT_ID BINDING RULE: Before selecting an object_id, verify that the tracked object's name directly matches what is physically undergoing the transformation in the narration. The retirement must target the object itself — not its container, not a co-located inventory item, not a nearby object in the same space. If the player splits or tears an object, select the ID of that object — not the container it came from, not the surface it rests on. If you cannot find a tracked object whose name clearly matches the transformation target, omit the retirement entry entirely. Omission is always safer than retiring the wrong object. Multi-object disambiguation: If there are multiple tracked objects in scope with similar or related names, descriptions, or types, and you are uncertain which one is the primary transformation target, emit object_id: null rather than selecting the most recently active or most accessible option. Null is always safer than retiring the wrong object from a group of similar candidates.

{
  "object_id": "<exact id from tracked objects list>",
  "reason": "<exact narration phrase — what happened to it>",
  "successors": [
    {
      "name": "<name of the successor object, lowercase, specific>",
      "description": "<brief physical description>",
      "container_type": "<same type as parent unless narration specifies otherwise>",
      "container_id": "<same container as parent unless narration specifies otherwise>",
      "temp_ref": "<short stable handle for this successor>",
      "quantity": "<optional — integer count when narration explicitly states a number. Same rules as object_candidates quantity. Omit when singular or unspecified.>",
      "unit": "<optional — unit label when narration gives one. Same rules as object_candidates unit. Omit when not stated.>"
    }
  ]
}

successors rules:
- EMIT successors when the retirement describes a physical split into pieces, portions, or fragments. Generic piece language (halves, pieces, chunks, slices, fragments) is sufficient successor identity — pieces do not require unique individual names or placement in different containers. Two pieces held simultaneously in the same container are still two separate successors.
- DO NOT EMIT successors for consumption, burning, or destruction where no new objects emerge.
- Emit ONE successor entry per named stack — not one entry per individual item. Use quantity for count.
- Successors inherit the retired parent's container unless narration explicitly places them elsewhere.
- quantity and unit on each successor follow identical rules to object_candidates quantity and unit.
- Omit the successors field entirely (or emit [] ) when no successor objects emerge.

If none, emit: "object_retirements": []

---

FISSION EVENTS (optional)

When a split or division verb is applied to a tracked physical object in the narration, emit an entry in fission_events. This is a witness report only — do not attempt to resolve object IDs or containers.

Split verbs that trigger fission_events: tear, rip, split, halve, divide, separate, slice, cut, chop, carve, break, snap, shatter, crack, fracture

{
  "source_ref": "<prose name of the object that was split — as named in narration>",
  "verb": "<the split verb>",
  "products": [{"name": "<noun phrase for this piece — include the source material in the name>", "destination_hint": "<player_hands | table | ground | unknown>"}],
  "actor_ref": "<entity ref who performed the split — player or npc_id>",
  "destination_hint": "<player_hands | table | ground | unknown>",
  "evidence": "<exact phrase from narration that describes the split>"
}

Rules:
- source_ref: the object's prose name as it appears in narration. Never an object_id.
- products: one object per individual physical piece produced — not per piece type. If two identical pieces end up in different locations, emit two separate entries.
- products[].name: a noun phrase that includes the source material — reference what was split, not just a bare fragment word alone.
- products[].destination_hint: where this specific piece ends up immediately after the split.
- destination_hint (top-level): where most or all pieces end up; used as fallback when a product entry omits its own destination_hint.
- Emit one entry per fission event. If no split verb applies to a tracked object this turn, emit: "fission_events": []

---

EXTRACTION EVENTS (optional)

PARTIAL DROP RECEIPT PRECEDENCE: Apply this rule only when the current prompt contains the VALIDATED AUTHORITATIVE PARTIAL DROP RECEIPT block for \`schema_version: "cb_tls_partial_stack_drop_v1"\`, whose \`turn_number\` matches the current CB turn, whose \`authority\` is \`tls_object_helper\`, whose \`operation_type\` is \`tls_partial_stack_drop\`, whose \`status\` is \`executed\`, and which supplies exact \`source_object_id\` and \`successor_object_id\` classification anchors from that same successful split. TLS/ObjectHelper already executed the receipt-governed operation: the source persisted at reduced quantity in its retained container, and the distinct successor was created directly at the destination. Emit no \`object_candidates\`, \`object_transfers\`, \`extraction_events\`, \`fission_events\`, or \`object_retirements\` for that operation. The only permitted receipt-governed output is \`partial_drop_successor_description\`, which is non-executable descriptive metadata and does not report, redirect, restate, or repair the completed operation. Independent facts unrelated to that operation may still use their normal channels. The receipt IDs are classification anchors only and must not be copied into witness fields as mutation authority. If the VALIDATED AUTHORITATIVE PARTIAL DROP RECEIPT block is absent, do not assume or infer that this precedence applies.

PARTIAL DROP SUCCESSOR DESCRIPTION: Apply this rule only when the VALIDATED AUTHORITATIVE PARTIAL DROP RECEIPT is present. Write \`partial_drop_successor_description.description\` in the same compact style as \`object_candidates[].description\`: a brief physical noun phrase describing only the receipt-identified successor, not a sentence or summary of the narration. Include only appearance, material, or physical condition specifically supported by the frozen narration. Keep the description distinct from the evidence and do not copy the evidence wholesale. Set \`partial_drop_successor_description.evidence\` to exactly one contiguous verbatim substring from the frozen narration; never combine separate excerpts, insert an ellipsis, or paraphrase the evidence. Do not include movement, sound, location, spatial relations, action history, the surviving source, a copied parent description, invented details, object IDs, the DROP action, quantity change, containment, transfer, split, or any other operation. If the narration provides no usable child-specific physical description, emit \`partial_drop_successor_description\`: null.

PARTIAL THROW RECEIPT PRECEDENCE: Apply this rule only when the current prompt contains the VALIDATED AUTHORITATIVE PARTIAL THROW RECEIPT block for \`schema_version: "cb_tls_partial_stack_throw_v1"\`, whose \`turn_number\` matches the current CB turn, whose \`authority\` is \`tls_object_helper\`, whose \`operation_type\` is \`tls_partial_stack_throw\`, whose \`status\` is \`executed\`, and which supplies exact \`source_object_id\` and \`successor_object_id\` classification anchors from that same successful split. TLS/ObjectHelper already executed the receipt-governed operation: the source persisted at reduced quantity in its retained container, and the distinct successor was created directly at the destination. Emit no \`object_candidates\`, \`object_transfers\`, \`extraction_events\`, \`fission_events\`, or \`object_retirements\` for that operation. The only permitted receipt-governed output is \`partial_throw_successor_description\`, which is non-executable descriptive metadata and does not report, redirect, restate, or repair the completed operation. Independent facts unrelated to that operation may still use their normal channels. The receipt IDs are classification anchors only and must not be copied into witness fields as mutation authority. If the VALIDATED AUTHORITATIVE PARTIAL THROW RECEIPT block is absent, do not assume or infer that this precedence applies.

PARTIAL THROW SUCCESSOR DESCRIPTION: Apply this rule only when the VALIDATED AUTHORITATIVE PARTIAL THROW RECEIPT is present. Write \`partial_throw_successor_description.description\` in the same compact style as \`object_candidates[].description\`: a brief physical noun phrase describing only the receipt-identified successor, not a sentence or summary of the narration. Include only appearance, material, or physical condition specifically supported by the frozen narration. Keep the description distinct from the evidence and do not copy the evidence wholesale. Set \`partial_throw_successor_description.evidence\` to exactly one contiguous verbatim substring from the frozen narration; never combine separate excerpts, insert an ellipsis, or paraphrase the evidence. Do not include movement, sound, location, spatial relations, action history, the surviving source, a copied parent description, invented details, object IDs, the THROW action, quantity change, containment, transfer, split, or any other operation. If the narration provides no usable child-specific physical description, emit \`partial_throw_successor_description\`: null.

PARTIAL TAKE RECEIPT PRECEDENCE: Apply this rule only when the current prompt contains the VALIDATED AUTHORITATIVE OPERATION RECEIPT block for \`schema_version: "cb_tls_partial_stack_take_v1"\`, whose \`turn_number\` matches the current CB turn, whose \`authority\` is \`tls_object_helper\`, whose \`operation_type\` is \`tls_partial_stack_take\`, whose \`status\` is \`executed\`, and which supplies exact \`source_object_id\` and \`successor_object_id\` classification anchors from that same successful split. TLS/ObjectHelper already executed the receipt-governed operation: the source persisted at reduced quantity in its retained container, and the distinct successor was created directly at the destination. Emit no \`object_candidates\`, \`object_transfers\`, \`extraction_events\`, \`fission_events\`, or \`object_retirements\` for that operation. The only permitted receipt-governed output is \`partial_take_successor_description\`, which is non-executable descriptive metadata and does not report, redirect, restate, or repair the completed operation. This rule overrides separated-subunit promotion, Group Extraction promotion, candidate acquisition/handling classification, and broad moved/taken transfer classification for this operation only. Independent facts unrelated to that operation may still use their normal channels. The receipt IDs are classification anchors only and must not be copied into witness fields as mutation authority. If the VALIDATED AUTHORITATIVE OPERATION RECEIPT block is absent, do not assume or infer that this precedence applies.

PARTIAL TAKE SUCCESSOR DESCRIPTION: Apply this rule only when the VALIDATED AUTHORITATIVE OPERATION RECEIPT is present. Write \`partial_take_successor_description.description\` in the same compact style as \`object_candidates[].description\`: a brief physical noun phrase describing only the receipt-identified successor, not a sentence or summary of the narration. Include only appearance, material, or physical condition specifically supported by the frozen narration. Keep the description distinct from the evidence and do not copy the evidence wholesale. Set \`partial_take_successor_description.evidence\` to exactly one contiguous verbatim substring from the frozen narration; never combine separate excerpts, insert an ellipsis, or paraphrase the evidence. Do not include movement, sound, location, spatial relations, action history, the surviving source, a copied parent description, invented details, object IDs, the TAKE action, quantity change, containment, transfer, split, or any other operation. If the narration provides no usable child-specific physical description, emit \`partial_take_successor_description\`: null.

When a portion of a tracked object is removed while the SOURCE PERSISTS with altered quantity or state, emit an entry in extraction_events. This is a witness report only — do not attempt to resolve object IDs.

Verb examples: take from, pull from, pour from, draw from, remove from, scoop from, tear off, slice off, cut off, pluck, snap off

Key distinction from fission_events: fission = source is fully split or destroyed; extraction = source survives with reduced quantity or state.

{
  "source_ref": "<prose name of the object being extracted from — as named in narration>",
  "verb": "<the extraction verb>",
  "extracted_quantity": <integer count of items extracted, or null if not a discrete count>,
  "extracted_unit": "<unit of measure if applicable, or null>",
  "product_name": "<noun phrase naming the extracted portion — include the source material in the name>",
  "description": "<brief description of the extracted product observed in the narration>",
  "destination_hint": "<player_hands | table | ground | unknown>",
  "actor_ref": "<entity ref who performed the extraction — player or npc_id>",
  "evidence": "<exact phrase from narration that describes the extraction>"
}

Rules:
- source_ref: the source object's prose name as it appears in narration. Never an object_id.
- extracted_quantity: emit only when the narration makes the count explicit as a discrete integer. Null otherwise.
- product_name: a noun phrase referencing the source material — not just a bare count or generic word.
- description: describe only the extracted product, not the surviving source. Base it on the frozen narration.
- If the narration provides no usable description specifically grounded in the extracted items, emit a minimal generic description based only on product_name and extracted_quantity.
- Emit one entry per extraction event. If no extraction applies this turn, emit: "extraction_events": []

` ;
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
  // v1.88.8: L0 fallback — use world._visible_npcs when no active site/local_space
  const visible = loc ? (loc._visible_npcs || []) : (w._visible_npcs || []);
  if (!visible.length) return '(none)';
  return visible.map(n => {
    // v1.84.82: respect is_learned — do not expose npc_name to CB context until the player has learned it
    const label = (n.is_learned && n.npc_name) ? `${n.npc_name} (${n.id})` : `unnamed ${n.job_category || 'person'} (${n.id})`;
    return label;
  }).join(', ');
}

function _describePlayerAttributes(gameState) {
  const attrs = gameState.player?.attributes;
  if (!attrs || !Object.keys(attrs).length) return '(none yet)';
  return Object.values(attrs).map(a => `${a.bucket}:${a.value}`).join(' | ');
}

function _describeActiveConditions(gameState) {
  const conditions = gameState.player?.conditions;
  if (!conditions || !conditions.length) return '(none)';
  return conditions.map(c => `[${c.condition_id}] ${c.description} (since T-${c.created_turn})`).join('\n');
}

function _describeTrackedObjects(gameState) {
  const objects = gameState.objects || {};
  const w       = gameState.world || {};
  // v1.88.45: use player.position (has site-local x/y at depth 2) not world.position (lx/ly only)
  const pos     = gameState.player?.position || w.position;
  const loc     = w.active_local_space || w.active_site;
  // v1.92.5: mutually-exclusive current-layer container, mirroring index.js's #15-validated
  // _groundDepth pattern — grid only at L0, site floor only at L1, localspace only at L2.
  const depth   = w.active_local_space ? 3 : w.active_site ? 2 : 1;

  const validContainers = new Set(['player']);
  if (depth === 1 && pos) validContainers.add(`LOC:${pos.mx},${pos.my}:${pos.lx},${pos.ly}`);
  if (depth === 3 && loc?.local_space_id) validContainers.add(loc.local_space_id);
  if (depth === 2) {
    const siteId = w.active_site?.site_id || (w.active_site?.id ? w.active_site.id.replace(/\/l2$/, '') : null);
    if (siteId != null && typeof pos?.x === 'number' && typeof pos?.y === 'number') {
      validContainers.add(`${siteId}:${pos.x},${pos.y}`);
    }
  }
  // v1.88.8: L0 fallback — include world._visible_npcs NPC IDs as valid containers
  const visible = loc ? (loc._visible_npcs || []) : (w._visible_npcs || []);
  for (const npc of visible) { if (npc.id) validContainers.add(npc.id); }

  const tracked = Object.values(objects).filter(r =>
    r.status === 'active' && validContainers.has(r.current_container_id)
  );

  // v1.88.43: include site-floor objects at Manhattan distance === 1 from the player's
  // site-local position. Fixes spatial duplicate promotion: CB could not suppress
  // re-promotion of objects at adjacent tiles because they were absent from this list.
  // ORS dedup is container-scoped, so cross-tile re-promotes escaped it.
  // Naturally bounded — gameState.objects only contains ORS-promoted persistent entities.
  // Fail closed: skip any object whose container_id doesn't match the exact format.
  const nearby = [];
  if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
    for (const r of Object.values(objects)) {
      if (r.status !== 'active') continue;
      if (r.current_container_type !== 'site') continue;
      if (validContainers.has(r.current_container_id)) continue;
      const cid = r.current_container_id || '';
      const lastColon = cid.lastIndexOf(':');
      if (lastColon < 0) continue;
      const xyPart = cid.slice(lastColon + 1);
      const xyMatch = /^(-?\d+),(-?\d+)$/.exec(xyPart);
      if (!xyMatch) continue;
      const objX = parseInt(xyMatch[1], 10);
      const objY = parseInt(xyMatch[2], 10);
      const dist = Math.abs(objX - pos.x) + Math.abs(objY - pos.y);
      if (dist !== 1) continue;
      nearby.push(r);
    }
    nearby.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  if (!tracked.length && !nearby.length) return '(none)';

  const lines = tracked.map(r => {
    const containerLabel = r.current_container_type === 'player' ? 'player'
      : r.current_container_type === 'npc' ? `npc:${r.current_container_id}`
      : `${r.current_container_id}`;
    const actorLabel = r.associated_actor_id ? ` | actor: ${r.associated_actor_id}` : '';
    return `- ${r.id} | ${r.name} | container: ${containerLabel}${actorLabel}`;
  });
  for (const r of nearby) {
    const actorLabel = r.associated_actor_id ? ` | actor: ${r.associated_actor_id}` : '';
    lines.push(`- ${r.id} | ${r.name} | container: ${r.current_container_id} | nearby (1 tile)${actorLabel}`);
  }
  return lines.join('\n');
}

function _describeApActionsThisTurn(gameState) {
  const apIds   = Array.isArray(gameState._apExecutedTransfers) ? gameState._apExecutedTransfers : [];
  const objects = gameState.objects || {};
  const lines   = [];
  for (const id of apIds) {
    const rec = objects[id];
    if (!rec) continue;
    const events    = rec.events || [];
    const lastEvent = events.length ? events[events.length - 1] : null;
    const reason    = lastEvent ? (lastEvent.reason || 'unknown') : 'unknown';
    lines.push(`- ${id} (${rec.name}): ${reason}`);
  }
  return lines.length ? lines.join('\n') : null;
}

// ── NPC id resolution ─────────────────────────────────────────────────────────

// v1.88.15 Patch 1J: L0 fallback — when no active_local_space or active_site, resolve against
// world._visible_npcs (populated since Patch 1D). All three resolution tiers work at L0.
function _resolveEntityRef(entityRef, gameState) {
  const w   = gameState.world || {};
  const loc = w.active_local_space || w.active_site;
  const visible = loc ? (loc._visible_npcs || []) : (w._visible_npcs || []);

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

// ── Injection-time environment dedup helpers ────────────────────────────────
// Used only to produce a dedup key — originals are always what go into the prompt.
// Conservative: only strips known location-ish trailing phrases. Preserves
// state-carrying prepositions (with, in, on, under, covered/filled/stained with).
const _ENV_STRIP_PHRASES = [
  /\bacross the way\b/g,
  /\bof main street\b/g,
  /\bof the street\b/g,
  /\bof the road\b/g,
  /\balong the street\b/g,
  /\bagainst the facade\b/g,
  /\bagainst the wall\b/g,
  /\bagainst facade\b/g,
  /\bagainst wall\b/g,
  /\bfrom this angle\b/g,
  /\bbetween buildings\b/g,
  /\bon the corner\b/g,
  /\bof the building\b/g,
  /\bof the area\b/g,
  /\bof the block\b/g,
  /\bjutting from the facade\b/g,
  /\bjutting from facade\b/g,
  /\bon the far side\b/g,
  /\bon the near side\b/g,
  /\bon the other side\b/g,
];

function _toCanonicalEnv(str) {
  let s = str.toLowerCase().replace(/\s+/g, ' ').trim();
  // strip leading articles
  s = s.replace(/^(?:a |an |the )/, '');
  // strip allowlisted trailing location phrases
  for (const rx of _ENV_STRIP_PHRASES) s = s.replace(rx, '');
  return s.trim();
}

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
      if (typeof item !== 'string') {
        let _safeVal; try { _safeVal = JSON.stringify(item); } catch { _safeVal = String(item); }
        logEntries.push({ action: 'rejected_filter', entity_id: npc.id, bucket, value: _safeVal, turn, reason: 'type_error:expected_string' });
        continue;
      }
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
  promote('object',   [...(candidate.held_objects || []), ...(candidate.worn_objects || [])]);  // v1.88.12: split fields
  const _dupTotal = Object.values(_dupCounts).reduce((s, c) => s + c, 0);
  if (_dupTotal > 0) {
    logEntries.push({ action: 'duplicate_silenced_summary', entity_type: 'npc', entity_id: npc.id, entity_name: npc.npc_name || npc.id, count_by_bucket: _dupCounts, total: _dupTotal, turn });
  }
}

function _promoteLocationAttributes(locationRecord, locationRef, features, turn, logEntries) {
  if (!locationRecord.attributes) locationRecord.attributes = {}; // backward-compat: old saves lack attributes field
  let _dupCount = 0;
  for (const feat of (features || [])) {
    if (typeof feat !== 'string') {
      let _safeVal; try { _safeVal = JSON.stringify(feat); } catch { _safeVal = String(feat); }
      logEntries.push({ action: 'rejected_filter', entity_id: locationRef, bucket: 'environment', value: _safeVal, turn, reason: 'type_error:expected_string' });
      continue;
    }
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

// v6.0.18: accepts options = { suppressUnsupportedPlayerStatePromotion } to gate
// player body/equipment state promotion on soliloquy turns.
function _promotePlayerAttributes(player, candidate, turn, logEntries, options = {}) {
  if (!player.attributes) player.attributes = {}; // migration guard: old saves
  const _suppress = options.suppressUnsupportedPlayerStatePromotion === true;
  const _dupCounts = {};
  const promote = (bucket, items) => {
    for (const item of (items || [])) {
      if (typeof item !== 'string') {
        let _safeVal; try { _safeVal = JSON.stringify(item); } catch { _safeVal = String(item); }
        logEntries.push({ action: 'rejected_filter', entity_id: player.id || 'player', bucket, value: _safeVal, turn, reason: 'type_error:expected_string' });
        continue;
      }
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
  if (_suppress) {
    console.warn('[CB] suppressUnsupportedPlayerStatePromotion: physical/state/object buckets skipped (soliloquy turn)');
  } else {
    promote('physical', candidate.physical_attributes);
    promote('state',    candidate.observable_states);
    promote('object',   [...(candidate.held_objects || []), ...(candidate.worn_objects || [])]);  // v1.88.12: split fields
  }
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

// ── Condition promotion ───────────────────────────────────────────────────────

// v6.0.18: accepts options = { suppressUnsupportedPlayerStatePromotion } to gate
// new_condition events on soliloquy turns while allowing condition_update/interaction through.
function _promoteConditions(conditionEvents, gameState, turn, options = {}) {
  if (!Array.isArray(conditionEvents) || conditionEvents.length === 0) return;
  if (!gameState.player) return;
  if (!Array.isArray(gameState.player.conditions)) gameState.player.conditions = [];
  const _suppress = options.suppressUnsupportedPlayerStatePromotion === true;

  for (const event of conditionEvents) {
    if (!event || !event.event_type) continue;

    if (event.event_type === 'new_condition') {
      if (_suppress) {
        console.warn(`[CB] suppressUnsupportedPlayerStatePromotion: new_condition skipped on soliloquy turn: "${(event.initial_description || '').slice(0, 60)}"`);
        continue;
      }
      if (!event.initial_description) continue;
      // Dedup guard — Jaccard word-set overlap against existing condition description + last 2 turn_log entries.
      // Prevents duplicate condition creation when the narrator re-describes the same injury in different words.
      // Threshold 0.5: score is logged so it can be tuned later from evidence.
      {
        const _normDesc = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
        const _wordSet  = s => new Set(_normDesc(s).split(' ').filter(Boolean));
        const _jaccard  = (a, b) => {
          const shared = [...a].filter(w => b.has(w)).length;
          const union  = new Set([...a, ...b]).size;
          return union === 0 ? 0 : shared / union;
        };
        const newWords = _wordSet(event.initial_description);
        let _dupFound = false;
        for (const existing of gameState.player.conditions) {
          const lastTwo = (existing.turn_log || []).slice(-2)
            .map(e => typeof e === 'string' ? e : String(e || '').slice(0, 200));
          const corpus = [existing.description || '', ...lastTwo].join(' ');
          const score  = _jaccard(newWords, _wordSet(corpus));
          if (score >= 0.5) {
            console.warn(`[CB] Condition skipped — overlap with existing ${existing.condition_id} score=${score.toFixed(2)}: "${event.initial_description.slice(0, 60)}"`);
            _dupFound = true;
            break;
          }
        }
        if (_dupFound) continue;
      }
      const condition_id = `cond_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
      const firstEntry = `Turn ${turn} [narration]: ${event.evidence || event.initial_description}`;
      gameState.player.conditions.push({
        condition_id,
        created_turn: turn,
        description: event.initial_description,
        turn_log: [firstEntry],
        notes: []
      });
      console.log(`[CB] Condition created: ${condition_id} — ${event.initial_description.slice(0, 80)}`);

    } else if (event.event_type === 'interaction') {
      if (!event.condition_id || !event.evidence) continue;
      // Find condition by exact condition_id (no proximity matching — stable identity)
      const conditions = gameState.player.conditions;
      if (!conditions.length) continue;
      const match = conditions.find(c => c.condition_id === event.condition_id);
      if (!match) {
        console.log(`[CB] Condition interaction dropped — no condition found for id: "${event.condition_id}"`);
        continue;
      }
      // Add to notes (rolling 5)
      const noteEntry = `Turn ${turn}: ${event.evidence}`;
      match.notes.push(noteEntry);
      if (match.notes.length > 5) match.notes.shift();
      // Add [narration] turn_log entry
      const logEntry = `Turn ${turn} [narration]: ${event.interaction_type || 'interaction'} — ${event.evidence}`;
      match.turn_log.push(logEntry);
      console.log(`[CB] Condition interaction recorded on ${match.condition_id} (${event.interaction_type})`);
    }
  }
}

async function runPhaseB(frozenNarration, gameState, rawInput, options = {}) {
  const apiKey = process.env.DEEPSEEK_API_KEY || '';
  const turn   = (gameState.turn_history || []).length + 1;
  const _receipt = options?.tlsPartialStackTakeReceipt;
  const _receiptSourceId = _receipt?.source_object_id;
  const _receiptSuccessorId = _receipt?.successor_object_id;
  const _receiptSource = gameState.objects?.[_receiptSourceId];
  const _receiptSuccessor = gameState.objects?.[_receiptSuccessorId];
  let _sanitizedTlsPartialStackTakeReceipt = null;

  if (
    _receipt?.schema_version === 'cb_tls_partial_stack_take_v1' &&
    _receipt.authority === 'tls_object_helper' &&
    _receipt.operation_type === 'tls_partial_stack_take' &&
    _receipt.status === 'executed' &&
    _receipt.actor_ref === 'player' &&
    _receipt.source_persists === true &&
    _receipt.successor_created_this_turn === true &&
    Number.isInteger(_receipt.turn_number) && _receipt.turn_number > 0 &&
    _receipt.turn_number === turn &&
    typeof _receiptSourceId === 'string' && _receiptSourceId.trim().length > 0 &&
    typeof _receiptSuccessorId === 'string' && _receiptSuccessorId.trim().length > 0 &&
    _receiptSourceId !== _receiptSuccessorId &&
    Number.isInteger(_receipt.extracted_quantity) && _receipt.extracted_quantity > 0 &&
    _receipt.destination_container_type === 'player' &&
    _receipt.destination_container_id === 'player' &&
    _receiptSource?.status === 'active' &&
    Number.isInteger(_receiptSource.quantity) && _receiptSource.quantity >= 1 &&
    _receiptSuccessor?.status === 'active' &&
    _receiptSuccessor.parent_object_id === _receiptSourceId &&
    _receiptSuccessor.created_turn === _receipt.turn_number &&
    _receiptSuccessor.quantity === _receipt.extracted_quantity &&
    _receiptSuccessor.current_container_type === _receipt.destination_container_type &&
    _receiptSuccessor.current_container_id === _receipt.destination_container_id
  ) {
    _sanitizedTlsPartialStackTakeReceipt = {
      schema_version: 'cb_tls_partial_stack_take_v1',
      authority: 'tls_object_helper',
      turn_number: _receipt.turn_number,
      operation_type: 'tls_partial_stack_take',
      status: 'executed',
      actor_ref: 'player',
      source_object_id: _receiptSourceId,
      source_persists: true,
      successor_object_id: _receiptSuccessorId,
      successor_created_this_turn: true,
      extracted_quantity: _receipt.extracted_quantity,
      destination_container_type: 'player',
      destination_container_id: 'player'
    };
  }

  const _dropReceipt = options?.tlsPartialStackDropReceipt;
  const _dropReceiptSourceId = _dropReceipt?.source_object_id;
  const _dropReceiptSuccessorId = _dropReceipt?.successor_object_id;
  const _dropReceiptSource = gameState.objects?.[_dropReceiptSourceId];
  const _dropReceiptSuccessor = gameState.objects?.[_dropReceiptSuccessorId];
  const _dropDestinationTypes = new Set(['grid', 'localspace', 'site']);
  let _sanitizedTlsPartialStackDropReceipt = null;

  if (
    _dropReceipt?.schema_version === 'cb_tls_partial_stack_drop_v1' &&
    _dropReceipt.authority === 'tls_object_helper' &&
    _dropReceipt.operation_type === 'tls_partial_stack_drop' &&
    _dropReceipt.status === 'executed' &&
    _dropReceipt.actor_ref === 'player' &&
    _dropReceipt.source_persists === true &&
    _dropReceipt.successor_created_this_turn === true &&
    Number.isInteger(_dropReceipt.turn_number) && _dropReceipt.turn_number > 0 &&
    _dropReceipt.turn_number === turn &&
    typeof _dropReceiptSourceId === 'string' && _dropReceiptSourceId.trim().length > 0 &&
    typeof _dropReceiptSuccessorId === 'string' && _dropReceiptSuccessorId.trim().length > 0 &&
    _dropReceiptSourceId !== _dropReceiptSuccessorId &&
    Number.isInteger(_dropReceipt.requested_quantity) && _dropReceipt.requested_quantity > 0 &&
    Number.isInteger(_dropReceipt.extracted_quantity) && _dropReceipt.extracted_quantity > 0 &&
    _dropReceipt.requested_quantity === _dropReceipt.extracted_quantity &&
    Number.isInteger(_dropReceipt.source_quantity_before) && _dropReceipt.source_quantity_before > 0 &&
    Number.isInteger(_dropReceipt.source_quantity_after) && _dropReceipt.source_quantity_after > 0 &&
    _dropReceipt.source_quantity_before - _dropReceipt.extracted_quantity === _dropReceipt.source_quantity_after &&
    _dropReceipt.source_container_type === 'player' &&
    _dropReceipt.source_container_id === 'player' &&
    _dropDestinationTypes.has(_dropReceipt.destination_container_type) &&
    typeof _dropReceipt.destination_container_id === 'string' && _dropReceipt.destination_container_id.trim().length > 0 &&
    _dropReceiptSource?.status === 'active' &&
    _dropReceiptSource.quantity === _dropReceipt.source_quantity_after &&
    _dropReceiptSource.current_container_type === _dropReceipt.source_container_type &&
    _dropReceiptSource.current_container_id === _dropReceipt.source_container_id &&
    Array.isArray(gameState.player?.object_ids) && gameState.player.object_ids.includes(_dropReceiptSourceId) &&
    _dropReceiptSuccessor?.status === 'active' &&
    _dropReceiptSuccessor.parent_object_id === _dropReceiptSourceId &&
    _dropReceiptSuccessor.created_turn === _dropReceipt.turn_number &&
    _dropReceiptSuccessor.quantity === _dropReceipt.extracted_quantity &&
    _dropReceiptSuccessor.current_container_type === _dropReceipt.destination_container_type &&
    _dropReceiptSuccessor.current_container_id === _dropReceipt.destination_container_id
  ) {
    _sanitizedTlsPartialStackDropReceipt = {
      schema_version: 'cb_tls_partial_stack_drop_v1',
      authority: 'tls_object_helper',
      turn_number: _dropReceipt.turn_number,
      operation_type: 'tls_partial_stack_drop',
      status: 'executed',
      actor_ref: 'player',
      source_object_id: _dropReceiptSourceId,
      source_persists: true,
      successor_object_id: _dropReceiptSuccessorId,
      successor_created_this_turn: true,
      requested_quantity: _dropReceipt.requested_quantity,
      extracted_quantity: _dropReceipt.extracted_quantity,
      source_quantity_before: _dropReceipt.source_quantity_before,
      source_quantity_after: _dropReceipt.source_quantity_after,
      source_container_type: 'player',
      source_container_id: 'player',
      destination_container_type: _dropReceipt.destination_container_type,
      destination_container_id: _dropReceipt.destination_container_id
    };
  }

  const _throwReceipt = options?.tlsPartialStackThrowReceipt;
  const _throwReceiptSourceId = _throwReceipt?.source_object_id;
  const _throwReceiptSuccessorId = _throwReceipt?.successor_object_id;
  const _throwReceiptSource = gameState.objects?.[_throwReceiptSourceId];
  const _throwReceiptSuccessor = gameState.objects?.[_throwReceiptSuccessorId];
  const _throwDestinationTypes = new Set(['grid', 'localspace', 'site']);
  let _sanitizedTlsPartialStackThrowReceipt = null;

  if (
    _throwReceipt?.schema_version === 'cb_tls_partial_stack_throw_v1' &&
    _throwReceipt.authority === 'tls_object_helper' &&
    _throwReceipt.operation_type === 'tls_partial_stack_throw' &&
    _throwReceipt.status === 'executed' &&
    _throwReceipt.actor_ref === 'player' &&
    _throwReceipt.source_persists === true &&
    _throwReceipt.successor_created_this_turn === true &&
    Number.isInteger(_throwReceipt.turn_number) && _throwReceipt.turn_number > 0 &&
    _throwReceipt.turn_number === turn &&
    typeof _throwReceiptSourceId === 'string' && _throwReceiptSourceId.trim().length > 0 &&
    typeof _throwReceiptSuccessorId === 'string' && _throwReceiptSuccessorId.trim().length > 0 &&
    _throwReceiptSourceId !== _throwReceiptSuccessorId &&
    Number.isInteger(_throwReceipt.requested_quantity) && _throwReceipt.requested_quantity > 0 &&
    Number.isInteger(_throwReceipt.extracted_quantity) && _throwReceipt.extracted_quantity > 0 &&
    _throwReceipt.requested_quantity === _throwReceipt.extracted_quantity &&
    Number.isInteger(_throwReceipt.source_quantity_before) && _throwReceipt.source_quantity_before > 0 &&
    Number.isInteger(_throwReceipt.source_quantity_after) && _throwReceipt.source_quantity_after > 0 &&
    _throwReceipt.source_quantity_before - _throwReceipt.extracted_quantity === _throwReceipt.source_quantity_after &&
    _throwReceipt.source_container_type === 'player' &&
    _throwReceipt.source_container_id === 'player' &&
    _throwDestinationTypes.has(_throwReceipt.destination_container_type) &&
    typeof _throwReceipt.destination_container_id === 'string' && _throwReceipt.destination_container_id.trim().length > 0 &&
    _throwReceiptSource?.status === 'active' &&
    _throwReceiptSource.quantity === _throwReceipt.source_quantity_after &&
    _throwReceiptSource.current_container_type === _throwReceipt.source_container_type &&
    _throwReceiptSource.current_container_id === _throwReceipt.source_container_id &&
    Array.isArray(gameState.player?.object_ids) && gameState.player.object_ids.includes(_throwReceiptSourceId) &&
    _throwReceiptSuccessor?.status === 'active' &&
    _throwReceiptSuccessor.parent_object_id === _throwReceiptSourceId &&
    _throwReceiptSuccessor.created_turn === _throwReceipt.turn_number &&
    _throwReceiptSuccessor.quantity === _throwReceipt.extracted_quantity &&
    _throwReceiptSuccessor.current_container_type === _throwReceipt.destination_container_type &&
    _throwReceiptSuccessor.current_container_id === _throwReceipt.destination_container_id
  ) {
    _sanitizedTlsPartialStackThrowReceipt = {
      schema_version: 'cb_tls_partial_stack_throw_v1',
      authority: 'tls_object_helper',
      turn_number: _throwReceipt.turn_number,
      operation_type: 'tls_partial_stack_throw',
      status: 'executed',
      actor_ref: 'player',
      source_object_id: _throwReceiptSourceId,
      source_persists: true,
      successor_object_id: _throwReceiptSuccessorId,
      successor_created_this_turn: true,
      requested_quantity: _throwReceipt.requested_quantity,
      extracted_quantity: _throwReceipt.extracted_quantity,
      source_quantity_before: _throwReceipt.source_quantity_before,
      source_quantity_after: _throwReceipt.source_quantity_after,
      source_container_type: 'player',
      source_container_id: 'player',
      destination_container_type: _throwReceipt.destination_container_type,
      destination_container_id: _throwReceipt.destination_container_id
    };
  }

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
  const prompt = _buildExtractionPrompt(
    frozenNarration,
    gameState,
    previousMood,
    rawInput,
    turn,
    _sanitizedTlsPartialStackTakeReceipt,
    _sanitizedTlsPartialStackDropReceipt,
    _sanitizedTlsPartialStackThrowReceipt
  );
  let raw = null;
  // v1.84.38: extract into closure for ECONNRESET retry
  const _makeExtractionCall = () => axios.post(
    DEEPSEEK_URL,
    {
      model: 'deepseek-v4-flash',
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,  // low temperature — forensic, not creative
      max_tokens: 2800
    },
    {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: EXTRACTION_TIMEOUT
    }
  );
  try {
    let resp;
    try {
      resp = await _makeExtractionCall();
    } catch (err) {
      if (err.code === 'ECONNRESET') {
        console.warn('[CB] Phase B ECONNRESET — retrying once...');
        resp = await _makeExtractionCall();
      } else {
        throw err;
      }
    }
    raw = resp?.data?.choices?.[0]?.message?.content || null;
  } catch (err) {
    const _errLabel = err.code === 'ECONNRESET' ? 'econnreset_retry_failed' : err.message;
    console.error('[CB] Phase B LLM call failed:', _errLabel);
    _setDiag({ error: _errLabel, turn });
    return null;
  }

  // ── Parse LLM output ───────────────────────────────────────────────────────
  let extracted = null;
  try {
    // Strip markdown code fences if model wrapped the JSON
    const cleaned = (raw || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    extracted = JSON.parse(cleaned);
  } catch (parseErr) {
    // Turn 1 founding extraction is uniquely critical — retry once before giving up
    if (turn === 1) {
      const _firstFailedRaw = (raw || '').slice(0, 3000);
      console.warn('[CB] Phase B JSON parse failed on Turn 1 — retrying once...', parseErr.message, '| raw:', _firstFailedRaw.slice(0, 200));
      let _retryRaw = null;
      try {
        const _retryResp = await _makeExtractionCall();
        _retryRaw = _retryResp?.data?.choices?.[0]?.message?.content || null;
        const _retryCleaned = (_retryRaw || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
        extracted = JSON.parse(_retryCleaned);
        console.log('[CB] Phase B Turn 1 retry parse succeeded.');
      } catch (retryErr) {
        if (retryErr instanceof SyntaxError) {
          // Both attempts produced malformed JSON — preserve both raw snippets for diagnosis
          console.error('[CB] Phase B Turn 1 retry also failed to parse:', retryErr.message);
          _setDiag({
            error: 'json_parse_failed_retry_exhausted',
            raw_attempt_1: _firstFailedRaw,
            raw_attempt_2: (_retryRaw || '').slice(0, 3000),
            turn
          });
        } else {
          // Retry API call itself threw (network, timeout, etc.)
          const _retryErrLabel = retryErr.code || retryErr.message;
          console.error('[CB] Phase B Turn 1 retry API call failed:', _retryErrLabel);
          _setDiag({
            error: 'json_parse_failed_retry_api_error',
            raw_attempt_1: _firstFailedRaw,
            retry_error: _retryErrLabel,
            turn
          });
        }
        return null;
      }
    } else {
      console.error('[CB] Phase B JSON parse failed:', parseErr.message, '| raw:', (raw || '').slice(0, 200));
      _setDiag({ error: 'json_parse_failed', raw: (raw || '').slice(0, 3000), turn });
      return null;
    }
  }

  // Validate top-level keys (watchpoint: do not let a collapsed schema slip through)
  const REQUIRED_KEYS = ['entity_candidates', 'environmental_features', 'spatial_relations', 'rejected_interpretations', 'mood_snapshot', 'condition_events'];
  const missing = REQUIRED_KEYS.filter(k => !(k in extracted));
  if (missing.length) {
    console.error('[CB] Phase B schema missing keys:', missing, '— summary-mode regression?');
    _setDiag({ error: 'schema_missing_keys', missing, turn });
    return null;
  }

  // Canonicalize held/worn item names before any continuity consumer sees them.
  // The raw model response remains separately preserved in `raw`.
  let _heldWornRejectedCount = 0;
  for (const _candidate of (Array.isArray(extracted.entity_candidates) ? extracted.entity_candidates : [])) {
    if (!_candidate || typeof _candidate !== 'object' || Array.isArray(_candidate)) continue;
    for (const _field of ['held_objects', 'worn_objects']) {
      if (!Array.isArray(_candidate[_field])) continue;
      _candidate[_field] = _candidate[_field].flatMap(_item => {
        if (typeof _item === 'string') {
          const _name = _item.trim();
          if (_name.length > 0) return [_name];
        } else if (
          _item &&
          typeof _item === 'object' &&
          !Array.isArray(_item) &&
          typeof _item.name === 'string'
        ) {
          const _name = _item.name.trim();
          if (_name.length > 0) return [_name];
        }
        _heldWornRejectedCount++;
        return [];
      });
    }
  }
  if (_heldWornRejectedCount > 0) {
    console.warn(`[CB] Rejected ${_heldWornRejectedCount} malformed held/worn item entr${_heldWornRejectedCount === 1 ? 'y' : 'ies'}`);
  }

  // Receipt-bound descriptive metadata only; remove it from the general extracted packet.
  let partial_take_successor_description = null;
  const _rawPartialTakeSuccessorDescription = extracted.partial_take_successor_description;
  if (
    _sanitizedTlsPartialStackTakeReceipt &&
    _rawPartialTakeSuccessorDescription &&
    typeof _rawPartialTakeSuccessorDescription === 'object' &&
    !Array.isArray(_rawPartialTakeSuccessorDescription)
  ) {
    const _description = typeof _rawPartialTakeSuccessorDescription.description === 'string'
      ? _rawPartialTakeSuccessorDescription.description.trim() : '';
    const _evidence = typeof _rawPartialTakeSuccessorDescription.evidence === 'string'
      ? _rawPartialTakeSuccessorDescription.evidence.trim() : '';
    const _parentDescription = typeof _receiptSource?.description === 'string'
      ? _receiptSource.description.trim() : '';
    if (
      _description.length > 0 &&
      _evidence.length > 0 &&
      frozenNarration.includes(_evidence) &&
      _description.toLowerCase() !== _parentDescription.toLowerCase()
    ) {
      partial_take_successor_description = {
        description: _description,
        evidence: _evidence
      };
    }
  }
  delete extracted.partial_take_successor_description;

  // Receipt-bound descriptive metadata only; remove it from the general extracted packet.
  let partial_drop_successor_description = null;
  const _rawPartialDropSuccessorDescription = extracted.partial_drop_successor_description;
  if (
    _sanitizedTlsPartialStackDropReceipt &&
    _rawPartialDropSuccessorDescription &&
    typeof _rawPartialDropSuccessorDescription === 'object' &&
    !Array.isArray(_rawPartialDropSuccessorDescription)
  ) {
    const _description = typeof _rawPartialDropSuccessorDescription.description === 'string'
      ? _rawPartialDropSuccessorDescription.description.trim() : '';
    const _evidence = typeof _rawPartialDropSuccessorDescription.evidence === 'string'
      ? _rawPartialDropSuccessorDescription.evidence.trim() : '';
    const _parentDescription = typeof _dropReceiptSource?.description === 'string'
      ? _dropReceiptSource.description.trim() : '';
    if (
      _description.length > 0 &&
      _evidence.length > 0 &&
      frozenNarration.includes(_evidence) &&
      _description.toLowerCase() !== _parentDescription.toLowerCase()
    ) {
      partial_drop_successor_description = {
        description: _description,
        evidence: _evidence
      };
    }
  }
  delete extracted.partial_drop_successor_description;

  // Receipt-bound descriptive metadata only; remove it from the general extracted packet.
  let partial_throw_successor_description = null;
  const _rawPartialThrowSuccessorDescription = extracted.partial_throw_successor_description;
  if (
    _sanitizedTlsPartialStackThrowReceipt &&
    _rawPartialThrowSuccessorDescription &&
    typeof _rawPartialThrowSuccessorDescription === 'object' &&
    !Array.isArray(_rawPartialThrowSuccessorDescription)
  ) {
    const _description = typeof _rawPartialThrowSuccessorDescription.description === 'string'
      ? _rawPartialThrowSuccessorDescription.description.trim() : '';
    const _evidence = typeof _rawPartialThrowSuccessorDescription.evidence === 'string'
      ? _rawPartialThrowSuccessorDescription.evidence.trim() : '';
    const _parentDescription = typeof _throwReceiptSource?.description === 'string'
      ? _throwReceiptSource.description.trim() : '';
    if (
      _description.length > 0 &&
      _evidence.length > 0 &&
      frozenNarration.includes(_evidence) &&
      _description.toLowerCase() !== _parentDescription.toLowerCase()
    ) {
      partial_throw_successor_description = {
        description: _description,
        evidence: _evidence
      };
    }
  }
  delete extracted.partial_throw_successor_description;

  // v1.84.33 — write founding_premise into birth_record on Turn 1
  if (turn === 1 && extracted.founding_premise && gameState.player?.birth_record) {
    const fp = extracted.founding_premise;
    gameState.player.birth_record.form             = fp.form             || null;
    gameState.player.birth_record.location_premise = fp.location_premise || null;
    gameState.player.birth_record.possessions      = Array.isArray(fp.possessions)   ? fp.possessions   : [];
    gameState.player.birth_record.capabilities     = Array.isArray(fp.capabilities)  ? fp.capabilities  : [];
    gameState.player.birth_record.status_claims    = Array.isArray(fp.status_claims) ? fp.status_claims : [];
    gameState.player.birth_record.scenario_notes   = Array.isArray(fp.scenario_notes)? fp.scenario_notes: [];
    gameState.player.birth_record.starting_npc     = (fp.starting_npc && typeof fp.starting_npc === 'object' && !Array.isArray(fp.starting_npc)) ? fp.starting_npc : (Array.isArray(fp.starting_npc) && fp.starting_npc.length > 0 ? fp.starting_npc[0] : null);
    console.log('[CB] birth_record populated on Turn 1:', JSON.stringify(gameState.player.birth_record).slice(0, 200));

    // v1.85.19: Populate player.identity from founding premise
    if (!gameState.player.identity) {
      gameState.player.identity = { canonical_name: null, title_or_role: null, current_form: null, last_known_form: null, aliases: [], public_identity_known: false };
    }
    gameState.player.identity.canonical_name       = fp.canonical_name || null;
    gameState.player.identity.title_or_role        = fp.title_or_role  || null;
    gameState.player.identity.current_form         = fp.form           || null;
    gameState.player.identity.last_known_form      = fp.form           || null; // v1.86.0: mirror current_form at founding
    gameState.player.identity.public_identity_known = !!(fp.canonical_name || fp.title_or_role);
    // Also store in birth_record for audit
    gameState.player.birth_record.canonical_name   = fp.canonical_name || null;
    gameState.player.birth_record.title_or_role    = fp.title_or_role  || null;
    console.log('[CB] player.identity populated on Turn 1:', JSON.stringify(gameState.player.identity));

    // v1.84.68: Promote status_claims → player.attributes[declared:] — idempotent, Turn 1 only
    // Bridges the gap between birth_record ingestion and narrator TRUTH block.
    // declared: bucket is permanent (not subject to STATE_ATTR_WINDOW aging).
    if (!gameState.player.attributes) gameState.player.attributes = {};
    let _declaredPromoted = 0;
    for (const _claim of (gameState.player.birth_record.status_claims || [])) {
      const _dKey = `declared:${_claim}`;
      if (!gameState.player.attributes[_dKey]) {
        gameState.player.attributes[_dKey] = { value: _claim, bucket: 'declared', turn_set: 1, confidence: 'initial' };
        _declaredPromoted++;
      }
    }
    if (_declaredPromoted > 0) {
      console.log(`[CB] birth_record promoted ${_declaredPromoted} declared attribute(s) to player.attributes`);
    }

    // v1.84.69: Promote possessions → player.attributes[object:] — idempotent, Turn 1 only
    // Normalised as "carrying ${item}" to match CB-extracted object: bucket style.
    let _possessionsPromoted = 0;
    for (const _poss of (gameState.player.birth_record.possessions || [])) {
      const _pVal = `carrying ${_poss}`;
      const _pKey = `object:${_pVal}`;
      if (!gameState.player.attributes[_pKey]) {
        gameState.player.attributes[_pKey] = { value: _pVal, bucket: 'object', turn_set: 1, confidence: 'initial' };
        _possessionsPromoted++;
      }
    }
    if (_possessionsPromoted > 0) {
      console.log(`[CB] birth_record promoted ${_possessionsPromoted} possession(s) to player.attributes`);
    }

    // Promote capabilities → player.attributes[declared:] — idempotent, Turn 1 only
    // Capabilities are things the player can DO, distinct from physical items they carry.
    // CB classifies them into capabilities[] at extraction time; promote as declared: so they
    // appear in the narrator TRUTH block and trigger DECLARED ABILITIES RULE correctly.
    let _capabilitiesPromoted = 0;
    for (const _cap of (gameState.player.birth_record.capabilities || [])) {
      const _cKey = `declared:${_cap}`;
      if (!gameState.player.attributes[_cKey]) {
        gameState.player.attributes[_cKey] = { value: _cap, bucket: 'declared', turn_set: 1, confidence: 'initial' };
        _capabilitiesPromoted++;
      }
    }
    if (_capabilitiesPromoted > 0) {
      console.log(`[CB] birth_record promoted ${_capabilitiesPromoted} capabilit${_capabilitiesPromoted === 1 ? 'y' : 'ies'} to player.attributes[declared:]`);
    }
  }

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
  // v1.88.15 Patch 1J: _resolveEntityRef now handles L0 via world._visible_npcs fallback —
  // no special-case bail-out required here.
  for (const candidate of (extracted.entity_candidates || [])) {
    const ref = candidate.entity_ref;
    if (!ref) continue;

    // Player self-ref — always route to player container regardless of layer
    const refLower = ref.toLowerCase();
    if (refLower === 'player' || refLower === 'you') {
      if (player) _promotePlayerAttributes(player, candidate, turn, logEntries, options);
      continue;
    }

    // Resolve entity ref — falls back to world._visible_npcs at L0
    const resolved = _resolveEntityRef(ref, gameState);
    if (!resolved) {
      // v1.88.18 Patch 1K-fix: Registry check moved to index.js post-BORN-NPC where
      // _turn1_founded_entities actually exists. CB runs before BORN-NPC so the registry
      // is always empty here — the old guard was dead code. Emit plain unresolved_entity_ref;
      // index.js will reclassify founding-NPC refs to founding_npc_pre_materialize after BORN-NPC.
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

  // ── Condition events ───────────────────────────────────────────────────────
  _promoteConditions(extracted.condition_events, gameState, turn, options);

  // ── Mood snapshot ──────────────────────────────────────────────────────────
  const moodSnapshot = extracted.mood_snapshot || null;
  if (moodSnapshot) {
    if (!gameState.world.mood_history) gameState.world.mood_history = [];
    // v1.84.89: tag each snapshot with the current location so stale cross-location entries
    // can be filtered out of the MOOD BLOCK when the player changes scenes.
    // v1.92.5: L0 now gets a real grid-cell key instead of null — null previously collided
    // with the legacy-save "absent field" sentinel, letting every L0 snapshot pass every filter.
    const _moodLocKey = gameState.world.active_local_space?.local_space_id
      || gameState.world.active_site?.site_id
      || (gameState.world.position
            ? `LOC:${gameState.world.position.mx},${gameState.world.position.my}:${gameState.world.position.lx},${gameState.world.position.ly}`
            : null);
    gameState.world.mood_history.push({ turn, location_key: _moodLocKey, ...moodSnapshot });
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
    condition_events_count:      (extracted.condition_events || []).length,
    held_worn_rejected_count:    _heldWornRejectedCount,
    warnings,
    mood_captured: !!moodSnapshot,
  };
  _setDiag(diag);

  return {
    extracted,              // full LLM output (stored in narration_debug.extraction_packet)
    log_entries:     logEntries,
    mood_snapshot:   moodSnapshot,
    diagnostics:     diag,
    raw,                    // v1.84.21: raw LLM response string (for payload archive)
    prompt,                 // v1.84.21: extraction prompt string (for payload archive)
    object_candidates:        Array.isArray(extracted.object_candidates)        ? extracted.object_candidates        : [],
    visible_objects:          Array.isArray(extracted.visible_objects)          ? extracted.visible_objects          : [],
    object_transfers:         Array.isArray(extracted.object_transfers)         ? extracted.object_transfers         : [],
    object_condition_updates: Array.isArray(extracted.object_condition_updates) ? extracted.object_condition_updates : [],
    object_retirements:       Array.isArray(extracted.object_retirements)       ? extracted.object_retirements       : [],
    fission_events:           Array.isArray(extracted.fission_events)           ? extracted.fission_events           : [],
    extraction_events:        Array.isArray(extracted.extraction_events)        ? extracted.extraction_events        : [],
    partial_take_successor_description,
    partial_drop_successor_description,
    partial_throw_successor_description,
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

  const visible = (loc && loc._visible_npcs) || w._visible_npcs || []; // v1.88.5: L0 fallback — BORN-NPC visible to TRUTH block
  let truthLines = 0;

  // Player attributes — always first in TRUTH block (layer-agnostic)
  // state: facts older than STATE_ATTR_WINDOW turns are suppressed (decay) — physical: and object: are permanent
  const player      = gameState.player;
  const playerAttrs = player?.attributes ? Object.values(player.attributes) : [];
  if (playerAttrs.length > 0) {
    const _curTurn = (gameState.turn_history?.length || 0) + 1;
    const _stateThreshold = _curTurn - STATE_ATTR_WINDOW;
    const _activeAttrs = playerAttrs.filter(a =>
      a.bucket !== 'state' || a.turn_set == null || a.turn_set >= _stateThreshold
    );
    const _suppressed = playerAttrs.length - _activeAttrs.length;
    if (turnContext) turnContext.stateAttrsSuppressed = _suppressed;  // v1.84.31: diagnostic passback
    if (_activeAttrs.length > 0) {
      const pStr = _activeAttrs.map(a => `${a.bucket}:${a.value}`).join(' | ');
      lines.push(`You: ${pStr}`);
      truthLines++;
    }
  }

  // v1.85.19: Player identity line
  gameState._lastIdentityTruthLine = null; // v1.85.21: reset each assembly — null when no identity fields present
  const _pid = gameState.player?.identity;
  if (_pid && (_pid.canonical_name || _pid.title_or_role || _pid.current_form || _pid.last_known_form)) {
    const _pidParts = [];
    if (_pid.canonical_name) _pidParts.push(`canonical name: ${_pid.canonical_name}`);
    if (_pid.title_or_role)  _pidParts.push(`title: ${_pid.title_or_role}`);
    const _activeForm = _pid.current_form || _pid.last_known_form; // v1.86.0: fall back to last_known_form when current_form absent
    if (_activeForm)         _pidParts.push(`current form: ${_activeForm}`);
    lines.push(`Player: ${_pidParts.join(' | ')}`);
    gameState._lastIdentityTruthLine = lines[lines.length - 1]; // v1.85.21: verbatim — exactly what narrator received
    truthLines++;
  }

  // Entity attributes
  for (const npc of visible) {
    if (!npc.attributes || !Object.keys(npc.attributes).length) continue;
    // v1.84.82: respect is_learned — do not expose npc_name in TRUTH block until the player has learned it
    const label = (npc.is_learned && npc.npc_name) ? `${npc.npc_name} (${npc.id})` : `${npc.job_category || 'person'} (${npc.id})`;
    const attrs = Object.values(npc.attributes)
      .sort((x, y) => (y.turn_set || 0) - (x.turn_set || 0))
      .slice(0, ENV_ATTR_WINDOW)
      .map(a => a.value)
      .join(' | ');
    // v1.85.19: append recognition suffix if NPC has recognized the player
    const _npcRec = npc.player_recognition;
    const _recSuffix = (_npcRec?.recognizes_player && _npcRec.known_identity)
      ? ` | recognizes-player: ${_npcRec.known_identity} (since T-${_npcRec.learned_turn})`
      : '';
    lines.push(`${label}: ${attrs}${_recSuffix}`);
    truthLines++;
  }
  if (visible.length === 0) {
    lines.push('NPCs at this location: none visible in engine state.');
    truthLines++;
  }

  // Location attributes — includes L0 cell attributes via locRecord fallback
  // v1.5.2: injection-time dedup pass — collapses near-duplicate env phrasings before narrator sees them.
  // Storage (locRecord.attributes) is untouched; only the narrator-facing view is deduped.
  // Newest wins by default (sort DESC); exception: if newest is a strict generic substring of an already-kept
  // older richer fact, the richer one is retained. Both the survivor list AND the seen-map entry are updated
  // on replacement so the joined output always reflects the winner correctly.
  if (locRecord && locRecord.attributes && Object.keys(locRecord.attributes).length) {
    const _sorted = Object.values(locRecord.attributes)
      .sort((x, y) => (y.turn_set || 0) - (x.turn_set || 0))
      .slice(0, ENV_ATTR_WINDOW);

    const _seenCanonical = new Map(); // canonical key -> index in _survivors
    const _survivors = [];
    let _collapsed = 0;

    for (const attr of _sorted) {
      // Restoration hardening: promotion never enforces that attr.value is a string (matches historical gap),
      // but the historical dedup pass assumes string ops (.length/.includes) unguarded. Coerce once here so
      // every comparison below acts on the same safe representation instead of the raw stored value.
      const _val = (typeof attr.value === 'string') ? attr.value : String(attr.value ?? '');
      const _ckey = _toCanonicalEnv(_val);
      if (!_seenCanonical.has(_ckey)) {
        _seenCanonical.set(_ckey, _survivors.length);
        _survivors.push(_val);
      } else {
        // Collision — check exception: if currently kept value is a strict generic substring of incoming
        // (incoming is longer and contains kept as a substring), replace with the richer incoming value.
        const _keptIdx = _seenCanonical.get(_ckey);
        const _keptVal = _survivors[_keptIdx];
        if (_val.length > _keptVal.length && _val.includes(_keptVal)) {
          // Older richer fact wins — replace both the survivor list entry and the seen-map index
          _survivors[_keptIdx] = _val;
          // seen-map index unchanged (same slot); value in _survivors is now the richer one
        }
        _collapsed++;
      }
    }

    if (_collapsed > 0) {
      console.log(`[CB-DEDUP] env_dedup_collapsed location="${locLabel}" turn=${turnContext?.turn ?? '?'} original=${_sorted.length} kept=${_survivors.length} collapsed=${_collapsed}`);
    }

    const locAttrs = _survivors.join(' | ');
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
  // v1.84.89: filter mood history to current location before slicing.
  // v1.92.5: filtering now applies unconditionally, including at L0 — previously L0 applied
  // no filter at all, letting every other location's mood history bleed in when the player
  // returned to L0. Snapshots with a genuinely absent location_key (pre-fix saves) pass through
  // as a narrow legacy exception; snapshots with an explicit null location_key (written by the
  // prior version's L0 tagging) do not match and are correctly excluded — they carry no provable
  // cell identity.
  const _moodLocKey = w.active_local_space?.local_space_id
    || w.active_site?.site_id
    || (w.position
          ? `LOC:${w.position.mx},${w.position.my}:${w.position.lx},${w.position.ly}`
          : null);
  const _moodFiltered = moodHistory.filter(m => m.location_key === undefined || m.location_key === _moodLocKey);
  const recent = _moodFiltered.slice(-MOOD_WINDOW);

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
  // Suppressed on cell-move turns (v1.84.34): if the player has moved to a new cell,
  // the prior-cell features are the wrong biome and actively mislead the narrator.
  // Cleared after one read (regardless of suppression) so stale facts never linger.
  const _ctxLoc = w._lastPhaseBLoc;
  const _pos = w.position;
  const _currentCellRef = _pos ? `cell(${_pos.mx},${_pos.my}:${_pos.lx},${_pos.ly})` : null;
  const _ctxIsMoved = _ctxLoc && _currentCellRef && _ctxLoc.locationRef !== _currentCellRef;
  // v1.92.5: enforce the "L0 only" doctrine stated above — a same-cell layer transition
  // (entering a site/localspace without world.position changing) must not inject prior-L0 context.
  const _ctxAtL0 = !w.active_local_space && !w.active_site;
  if (_ctxLoc && !_ctxIsMoved && _ctxAtL0 && Array.isArray(_ctxLoc.features) && _ctxLoc.features.length > 0) {
    lines.push('');
    lines.push('CONTEXT — RECENT LOCATION');
    lines.push('─────────────────────────────────────────────');
    lines.push(`[${_ctxLoc.locationRef} — prior position]: ${_ctxLoc.features.join(' | ')}`);
  }
  w._lastPhaseBLoc = null; // single-use: clear after read (even when suppressed)

  return lines.join('\n');
}

// ── v1.88.31: Founding NPC identity pre-pass ──────────────────────────────────
// Extracts ONLY the NPC identity fields needed to compute the born-NPC hash ID
// before Phase B runs. No objects, no continuity, no scene details.
// Called from index.js on Turn 1 only, before the pre-seed block and runPhaseB().
// Two internal guards prevent any execution on Turn 2+.
async function extractFoundingNpc(gameState) {
  if (!gameState.world?.founding_prompt) return null;
  if (gameState._born_npc_initialized)   return null;

  const apiKey = process.env.DEEPSEEK_API_KEY || '';
  if (!apiKey) {
    console.warn('[CB-PRENPC] DEEPSEEK_API_KEY not set — pre-pass skipped');
    return null;
  }

  const premise = gameState.world.founding_prompt;
  const prompt = [
    'You are a data-extraction assistant. Read the founding premise below and extract ONLY the identity of the named companion or NPC.',
    'Return a single JSON object with ONLY this structure:',
    '{ "starting_npc": { "name": string|null, "generated_name": string|null, "role_or_relation": string|null, "description": string|null, "gender": string|null, "age": string|null, "job_category": string|null } }',
    'If the premise does not mention a companion or NPC, return: { "starting_npc": null }',
    'IMPORTANT: Do NOT extract objects, inventory items, worn items, conditions, scene details, world facts, or any other information.',
    'Do NOT include any keys other than "starting_npc" in your response.',
    '',
    'FOUNDING PREMISE:',
    premise,
  ].join('\n');

  let raw = null;
  try {
    const resp = await axios.post(
      DEEPSEEK_URL,
      {
        model: 'deepseek-v4-flash',
        thinking: { type: 'disabled' },
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 300,
      },
      {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 15000,
      }
    );
    raw = resp?.data?.choices?.[0]?.message?.content || null;
  } catch (err) {
    console.warn('[CB-PRENPC] LLM call failed:', err.message);
    return null;
  }

  let parsed = null;
  try {
    const cleaned = (raw || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (parseErr) {
    console.warn('[CB-PRENPC] JSON parse failed:', parseErr.message);
    return null;
  }

  // Discard any extra keys — only starting_npc is permitted
  const sn = parsed?.starting_npc;
  if (!sn || typeof sn !== 'object') {
    console.log('[CB-PRENPC] No founding NPC detected in premise — pre-pass returns null');
    return null;
  }

  // Narrow write-back: ONLY starting_npc — never touch any other birth_record field
  if (gameState.player?.birth_record) {
    gameState.player.birth_record.starting_npc = sn;
  }
  console.log(`[CB-PRENPC] Founding NPC extracted: name="${sn.name || sn.generated_name || '(unnamed)'}"`);
  return { starting_npc: sn };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  CB_VERSION,
  runPhaseB,
  assembleContinuityPacket,
  getLastRunDiagnostics,
  extractFoundingNpc,
};
