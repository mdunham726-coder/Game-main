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
const CB_VERSION        = '1.5.1';

// ── Diagnostics ───────────────────────────────────────────────────────────────
let _lastRunDiagnostics = null;

function getLastRunDiagnostics() { return _lastRunDiagnostics; }

function _setDiag(d) { _lastRunDiagnostics = d; }

// ── Extraction prompt ─────────────────────────────────────────────────────────

function _buildExtractionPrompt(frozenNarration, gameState, previousMoodSnapshot, watchContext, rawInput) {
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
  const _vcLines = ['- player  (player inventory)', '- player_worn  (worn items)'];
  // v1.84.87: suppress cell key when inside a localspace — the interior floor is the correct container,
  // not the parent outdoor tile. Emitting both caused CB to pick the cell key (prior training bias).
  if (_vcPos && !(_vcLoc && _vcLoc.local_space_id)) _vcLines.push(`- LOC:${_vcPos.mx},${_vcPos.my}:${_vcPos.lx},${_vcPos.ly}  (current cell)`);
  // v1.84.85: add localspace floor when player is at L2 depth
  if (_vcLoc && _vcLoc.local_space_id) _vcLines.push(`- ${_vcLoc.local_space_id}  (localspace floor: ${_vcLoc.name || _vcLoc.local_space_id})`);;
  for (const _vn of ((_vcLoc && _vcLoc._visible_npcs) || [])) { if (_vn.id) _vcLines.push(`- ${_vn.id}  (NPC: ${_vn.npc_name || _vn.id})`); }
  const _validContainersList = _vcLines.join('\n');

  return `EXTRACTION TASK — TURN ${(gameState.turn_history || []).length}

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
Grid container_id MUST be an exact LOC:... value from this list. Never use prose labels (overworld, ground, current cell, nearby, area, field) — they are not valid container IDs and will be rejected. If narration implies an object in a container not on this list, omit that object.
CRITICAL: 'grid' is ONLY valid at L0 (overworld). If the player is inside a site (L1) or localspace interior (L2), the 'grid' container type is invalid — use the site or localspace container ID listed above instead.
Current player input (this turn): "${rawInput || ''}"
Confirmed player inventory (pre-turn): ${(() => { const _cbIds = Array.isArray(gameState.player?.object_ids) ? gameState.player.object_ids : []; const _cbObjs = (gameState.objects && typeof gameState.objects === 'object') ? gameState.objects : {}; const _cbNames = _cbIds.map(id => _cbObjs[id]?.status === 'active' ? _cbObjs[id].name : null).filter(Boolean); return _cbNames.length ? _cbNames.join(', ') : '(empty)'; })()}
Visible entities: ${entities}
Player character: always present — entity_ref "player" | known attributes: ${knownPlayerAttrs}
Active player conditions: ${activeConditions}
Tracked objects in scene:
${trackedObjects}
${apContext ? `\nPlayer actions this turn (use to identify which specific object was physically affected):\n${apContext}` : ''}

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
  "object_transfers": [],
  "object_condition_updates": [],
  "object_retirements": []${isFoundingTurn ? `,
  "founding_premise": {
    "form": null,
    "location_premise": null,
    "possessions": [],
    "capabilities": [],
    "status_claims": [],
    "scenario_notes": [],
    "canonical_name": null,
    "title_or_role": null
  }` : ''}
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

---

CONDITION EVENTS

Review the narration for evidence of new physical conditions or interactions with existing conditions.
Active player conditions are listed above.

CRITICAL RULE: Only emit condition_events when there is CLEAR physical evidence in the narration.
If you are unsure whether something is a new condition, do not emit it.
If you are unsure whether an interaction matches an existing condition, do not emit it.
False negatives are preferred over false positives.

event_type rules:
- "new_condition": narration clearly describes a NEW physical injury or condition not already in the active list. Emit ONLY if the evidence would independently describe a new physical condition without inference.
- "interaction": narration shows usage, aggravation, or treatment of an EXISTING active condition. Only emit if you can clearly match to a condition in the active list by description. If no strong match exists, do not emit — do not create new conditions from interaction evidence.

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
  form             — character type or role as stated in primary source (e.g. "merchant", "soldier", "wanderer"). null if not stated.
  location_premise — starting location as stated in primary source (e.g. "city gates", "the Thornwood road"). null if not stated.
  possessions      — physical items, objects, weapons, or gear explicitly named in primary source as owned or carried. Do NOT include abilities, powers, or things the player can do — those belong in capabilities. Empty array if none stated.
  capabilities     — abilities, powers, or things the player can do, as explicitly stated in primary source (e.g. "ability to transform", "power to fly", "magic to heal others"). Do NOT include physical items — those belong in possessions. Empty array if none stated.
  status_claims    — identity, authority, or history assertions from primary source (e.g. "I used to work for the guild", "I am a member of the order"). Empty array if none.
  scenario_notes   — freeform notes ONLY when primary source is ambiguous AND narration adds clear factual grounding (not embellishment). Empty array if no grounding exists.
  canonical_name   — the player's personal name if explicitly stated. A word or phrase the player uses to refer to themselves as a specific individual, distinct from a title, role, or job descriptor. Only extract what is explicitly stated — do not infer. null if not stated.
  title_or_role    — a formal title, rank, or positional designation if explicitly claimed. A social or authoritative label, not a personal name. Only extract what is explicitly stated — do not infer. null if not stated.

` : ''}

---

OBJECT CANDIDATES (optional)

Identify concrete, discrete, portable physical objects explicitly mentioned in the narration.
Do NOT include furniture, architecture, or fixed features.
Do NOT include objects that are ambiguous or only implied.
Do NOT emit a promote candidate for an object that already appears in TRACKED OBJECTS above.
If a tracked object moved to a new container this turn, capture that movement in object_transfers
using the exact object_id from TRACKED OBJECTS — not a promote candidate. Emitting a promote for
an already-tracked object creates a phantom duplicate with a new ID.
Fragment objects derived from a retiring tracked object must go in object_retirements[].successors[]
— never in object_candidates[].

For each object, emit one entry in the "object_candidates" array:
{
  "temp_ref": "<short stable handle — reuse the same ref if this object appears again in a later turn>",
  "name": "<object name, lowercase, specific>",
  "description": "<brief physical description>",
  "container_type": "grid" | "npc" | "player" | "localspace" | "site" | "player_worn" | "npc_worn",
  "container_id": "<exact value from valid containers list above — use the localspace ID when inside a localspace>",
  "reason": "<exact phrase from narration supporting this placement>",
  "initial_condition": "<optional — concrete physical state if the object is introduced in a non-pristine state this turn>",
  "initial_evidence": "<optional — exact narration phrase that establishes the initial condition>",
  "transfer_origin": "<required when container_type is 'player' AND item is not in Confirmed player inventory above — see TRANSFER ORIGIN RULES below>"
}

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
                              (container_type: 'localspace' if the player is currently
                              inside a localspace at L2 depth, 'site' if inside a site
                              at L1, or 'grid' if at L0),
                              NOT environment_interaction.
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
                          CONTAINER RESTRICTION: must use container_type 'localspace' or
                          'grid' or 'site' only — NEVER 'player'. Use 'localspace' (with
                          the active localspace ID as container_id) when the player is
                          currently inside a localspace at L2 depth. Use 'site' (with the
                          site container_id from the valid containers list above) when inside a site
                          at L1 depth. Use 'grid' (with the current LOC cell key as
                          container_id) when at L0. The narrator may place
                          items in the environment (on a table, on the floor, on the
                          ground), but narrator prose alone cannot put an item in the
                          player's hand. If the narration described the item as "in your
                          hand" or "in your pocket" but the player never requested it and
                          no NPC gave it, classify container_type as 'localspace' (if at
                          L2), 'site' (if at L1), or 'grid' (if at L0) — not 'player'.
                          ALLOW for localspace/site/grid.

  player_claimed        — Player input mentioned, implied, or gestured the item as currently
                          held, gathered, shown, or carried — in any form: speech ("I have X"),
                          emote (*holds up X*), assertion, or background claim
                          ("I've been gathering X"). BLOCK.

TIE-BREAK: when in doubt, classify as player_claimed.

OVERRIDE: if the item name or a clear reference to it appears in the player's input
framed as held, shown, or gathered — that is player_claimed with no exceptions.
The narrator's prose does not change this classification.

If no qualifying objects are present, emit: "object_candidates": []

---

OBJECT TRANSFERS (optional)

Identify objects that clearly changed hands or location in this narration.
Only emit when the narration explicitly describes the movement (e.g. handed over, dropped, taken).

For each transfer, emit one entry in the "object_transfers" array.
IMPORTANT: identify the object by temp_ref (same-turn object from object_candidates above) OR by object_id (if it was established in a prior turn). Do NOT use name-only references.
For objects already listed in TRACKED OBJECTS, always use the exact object_id field — never use temp_ref alone for a tracked object. temp_ref is only valid for objects born this turn via a promote candidate in object_candidates.

{
  "temp_ref": "<if the object was promoted this turn — must match an entry in object_candidates>",
  "object_id": "<if the object already exists from a prior turn>",
  "from_container_type": "grid" | "npc" | "player" | "localspace" | "site" | "player_worn" | "npc_worn",
  "from_container_id": "<exact value from valid containers list above>",
  "to_container_type": "grid" | "npc" | "player" | "localspace" | "site" | "player_worn" | "npc_worn",
  "to_container_id": "<exact value from valid containers list above>",
  "reason": "<exact phrase from narration supporting this transfer>"
}

If no transfers occurred, emit: "object_transfers": []

---

OBJECT CONDITION UPDATES (optional)

Annotate tracked objects whose physical condition changed in this narration.
Only use object_ids listed in "Tracked objects in scene" above — exact IDs only.

ACCEPT: concrete, observable physical changes — split, bruised, cracked, soaked, half-buried, burned, bent, shattered, dented, torn, bleeding, sticky, smeared, coated, stained, fouled, covered in residue.
REJECT: pristine or default states — unblemished, intact, undamaged, normal, clean, fine, whole.
REJECT: inferences or implied states — "looks worse for wear", "seems damaged".

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

---

OBJECT RETIREMENTS (optional)

When narration explicitly describes a tracked object physically ceasing to exist as itself — split into named sub-objects, fully consumed/eaten, destroyed with no remaining form — emit a retirement entry for the original.

EMIT for: object split into distinct sub-objects, object fully consumed/eaten, object burned to nothing.
DO NOT EMIT for: damage or condition change, movement, picking up, dropping, any interaction that leaves the object intact, or instrument use (cutting, striking, stabbing, smashing, throwing — the weapon or tool used to destroy something else is never retired by the act of use; only the target may be retired).
Only use object_ids from "Tracked objects in scene" above — exact IDs only, never by name.

FISSION BAR: The original object must be GONE AS ITSELF. Splitting an apple into two halves = fission
(the apple no longer exists as an apple). Denting a can = condition update (the can still exists).
Cracking a phone screen = condition update. Bruising an apple = condition update. When in doubt,
condition update wins — only retire when narration makes clear the original form is definitively gone.

INSTRUMENT RULE: An object that causes destruction is not itself destroyed. Only the object that physically ceases to exist as itself is retired. The tool, weapon, or instrument used in the action remains active — retire the target, never the instrument.

{
  "object_id": "<exact id from tracked objects list>",
  "reason": "<exact narration phrase — what happened to it>",
  "successors": [
    {
      "temp_ref": "frag_0",
      "name": "<fragment name, lowercase, specific>",
      "description": "<brief physical description>",
      "container_type": "<match retiring object's container_type, or override if narration is explicit>",
      "container_id": "<match retiring object's container_id, or narration-specified override>"
    }
  ]
}

successors[] rules:
- OPTIONAL. Omit the field entirely when nothing distinct survives (burned to ash, fully eaten,
  dissolved, absorbed, crumbled to powder).
- Emit successors ONLY for distinct, persistent, interactable physical remnants — objects a person
  could pick up, use, or reference independently. DO NOT emit for: juice, pulp, crumbs, dust,
  splinters, droplets, particles, or any incidental debris with no independent physical significance.
- Successors inherit the retiring object's container_type and container_id by default.
  Override ONLY when narration explicitly places a fragment somewhere else
  (e.g. "one half tumbled to the ground while the other stayed in your grip").
- temp_ref must be unique within this entry: use frag_0, frag_1, frag_2, etc.
- DO NOT duplicate successors in object_candidates[].

If none, emit: "object_retirements": []

${watchContext ? `\n---\n\nMOTHER WATCH BRIEF\nEngine state for this turn. Use this to write watch_message only.\n\nCONTINUITY: ${watchContext.continuity_injected ? 'injected' : watchContext.continuity_evicted ? 'evicted (' + (watchContext.continuity_eviction_reason || 'unknown') + ')' : 'not injected'}\nNARRATOR:   ${watchContext.narrator_status || 'ok'}\nMOVE:       ${watchContext.move_summary || 'none'}\nVIOLATIONS: ${watchContext.violation_count || 0}${watchContext.top_violation ? ' | top: "' + watchContext.top_violation + '"' : ''}\nCHANNEL:    ${watchContext.channel || '—'}\n\nAdd one optional field to your JSON output:\n\"watch_message\": \"<one sentence: your system health judgment for this turn. Start with ✓ if clean, ⚠ for a warning, ✗ for an error. Highest-priority issue only. Omit the field entirely if you have nothing to add.>\"\n` : ''}` ;
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
  const pos     = w.position;
  const loc     = w.active_local_space || w.active_site;

  const validContainers = new Set(['player']);
  if (pos) validContainers.add(`LOC:${pos.mx},${pos.my}:${pos.lx},${pos.ly}`);
  const visible = (loc && loc._visible_npcs) || [];
  for (const npc of visible) { if (npc.id) validContainers.add(npc.id); }

  const tracked = Object.values(objects).filter(r =>
    r.status === 'active' && validContainers.has(r.current_container_id)
  );
  if (!tracked.length) return '(none)';
  return tracked.map(r => {
    const containerLabel = r.current_container_type === 'player' ? 'player'
      : r.current_container_type === 'npc' ? `npc:${r.current_container_id}`
      : `${r.current_container_id}`;
    return `- ${r.id} | ${r.name} | container: ${containerLabel}`;
  }).join('\n');
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
  // skipFilter=true for object bucket: item names are concrete nouns, not atmospheric descriptions.
  const promote = (bucket, items, skipFilter = false) => {
    for (const item of (items || [])) {
      if (!skipFilter) {
        const _check = _isConcreteDetail(item);
        if (!_check.ok) {
          logEntries.push({ action: 'rejected_filter', entity_id: npc.id, bucket, value: item, turn, reason: 'banned_pattern:' + _check.pattern });
          continue;
        }
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
  promote('object',   candidate.held_or_worn_objects, true);
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
  // skipFilter=true for object bucket: item names are concrete nouns, not atmospheric descriptions.
  const promote = (bucket, items, skipFilter = false) => {
    for (const item of (items || [])) {
      if (!skipFilter) {
        const _check = _isConcreteDetail(item);
        if (!_check.ok) {
          logEntries.push({ action: 'rejected_filter', entity_id: player.id || 'player', bucket, value: item, turn, reason: 'banned_pattern:' + _check.pattern });
          continue;
        }
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
  promote('object',   candidate.held_or_worn_objects, true);
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

function _promoteConditions(conditionEvents, gameState, turn) {
  if (!Array.isArray(conditionEvents) || conditionEvents.length === 0) return;
  if (!gameState.player) return;
  if (!Array.isArray(gameState.player.conditions)) gameState.player.conditions = [];

  for (const event of conditionEvents) {
    if (!event || !event.event_type) continue;

    if (event.event_type === 'new_condition') {
      if (!event.initial_description) continue;
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

async function runPhaseB(frozenNarration, gameState, watchContext, rawInput) {
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
  const prompt = _buildExtractionPrompt(frozenNarration, gameState, previousMood, watchContext, rawInput);
  let raw = null;
  // v1.84.38: extract into closure for ECONNRESET retry
  const _makeExtractionCall = () => axios.post(
    DEEPSEEK_URL,
    {
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,  // low temperature — forensic, not creative
      max_tokens: 1600
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
    console.error('[CB] Phase B JSON parse failed:', parseErr.message, '| raw:', (raw || '').slice(0, 200));
    _setDiag({ error: 'json_parse_failed', raw: (raw || '').slice(0, 500), turn });
    return null;
  }

  // Validate top-level keys (watchpoint: do not let a collapsed schema slip through)
  const REQUIRED_KEYS = ['entity_candidates', 'environmental_features', 'spatial_relations', 'rejected_interpretations', 'mood_snapshot', 'condition_events'];
  const missing = REQUIRED_KEYS.filter(k => !(k in extracted));
  if (missing.length) {
    console.error('[CB] Phase B schema missing keys:', missing, '— summary-mode regression?');
    _setDiag({ error: 'schema_missing_keys', missing, turn });
    return null;
  }

  // Safely extract watch_message — optional, never blocks Phase B
  const watch_message = typeof extracted.watch_message === 'string' ? extracted.watch_message : null;

  // v1.84.33 — write founding_premise into birth_record on Turn 1
  if (turn === 1 && extracted.founding_premise && gameState.player?.birth_record) {
    const fp = extracted.founding_premise;
    gameState.player.birth_record.form             = fp.form             || null;
    gameState.player.birth_record.location_premise = fp.location_premise || null;
    gameState.player.birth_record.possessions      = Array.isArray(fp.possessions)   ? fp.possessions   : [];
    gameState.player.birth_record.capabilities     = Array.isArray(fp.capabilities)  ? fp.capabilities  : [];
    gameState.player.birth_record.status_claims    = Array.isArray(fp.status_claims) ? fp.status_claims : [];
    gameState.player.birth_record.scenario_notes   = Array.isArray(fp.scenario_notes)? fp.scenario_notes: [];
    console.log('[CB] birth_record populated on Turn 1:', JSON.stringify(gameState.player.birth_record).slice(0, 200));

    // v1.85.19: Populate player.identity from founding premise
    if (!gameState.player.identity) {
      gameState.player.identity = { canonical_name: null, title_or_role: null, current_form: null, aliases: [], public_identity_known: false };
    }
    gameState.player.identity.canonical_name       = fp.canonical_name || null;
    gameState.player.identity.title_or_role        = fp.title_or_role  || null;
    gameState.player.identity.current_form         = fp.form           || null;
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

    // v1.85.17: Promote capabilities → player.attributes[declared:] — idempotent, Turn 1 only
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

  // ── Condition events ───────────────────────────────────────────────────────
  _promoteConditions(extracted.condition_events, gameState, turn);

  // ── Mood snapshot ──────────────────────────────────────────────────────────
  const moodSnapshot = extracted.mood_snapshot || null;
  if (moodSnapshot) {
    if (!gameState.world.mood_history) gameState.world.mood_history = [];
    // v1.84.89: tag each snapshot with the current location so stale cross-location entries
    // can be filtered out of the MOOD BLOCK when the player changes scenes.
    const _moodLocKey = gameState.world.active_local_space?.local_space_id
      || gameState.world.active_site?.site_id
      || null;
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
    warnings,
    mood_captured: !!moodSnapshot,
  };
  _setDiag(diag);

  return {
    extracted,              // full LLM output (stored in narration_debug.extraction_packet)
    log_entries:     logEntries,
    mood_snapshot:   moodSnapshot,
    diagnostics:     diag,
    watch_message,          // Mother's one-sentence system health judgment (null if omitted or Phase B failed)
    raw,                    // v1.84.21: raw LLM response string (for payload archive)
    prompt,                 // v1.84.21: extraction prompt string (for payload archive)
    object_candidates:        Array.isArray(extracted.object_candidates)        ? extracted.object_candidates        : [],
    object_transfers:         Array.isArray(extracted.object_transfers)         ? extracted.object_transfers         : [],
    object_condition_updates: Array.isArray(extracted.object_condition_updates) ? extracted.object_condition_updates : [],
    object_retirements:       Array.isArray(extracted.object_retirements)       ? extracted.object_retirements       : [],
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
  if (_pid && (_pid.canonical_name || _pid.title_or_role || _pid.current_form)) {
    const _pidParts = [];
    if (_pid.canonical_name) _pidParts.push(`canonical name: ${_pid.canonical_name}`);
    if (_pid.title_or_role)  _pidParts.push(`title: ${_pid.title_or_role}`);
    if (_pid.current_form)   _pidParts.push(`current form: ${_pid.current_form}`);
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
  // v1.84.89: filter mood history to current location before slicing.
  // Prevents stale cross-location snapshots (e.g. "exiting into parking lot") from
  // bleeding into the narrator when the player re-enters a localspace or site.
  // Snapshots with no location_key (old saves) pass through unconditionally.
  const _moodLocKey = w.active_local_space?.local_space_id || w.active_site?.site_id || null;
  const _moodFiltered = _moodLocKey
    ? moodHistory.filter(m => m.location_key == null || m.location_key === _moodLocKey)
    : moodHistory;
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
  if (_ctxLoc && !_ctxIsMoved && Array.isArray(_ctxLoc.features) && _ctxLoc.features.length > 0) {
    lines.push('');
    lines.push('CONTEXT — RECENT LOCATION');
    lines.push('─────────────────────────────────────────────');
    lines.push(`[${_ctxLoc.locationRef} — prior position]: ${_ctxLoc.features.join(' | ')}`);
  }
  w._lastPhaseBLoc = null; // single-use: clear after read (even when suppressed)

  return lines.join('\n');
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  CB_VERSION,
  runPhaseB,
  assembleContinuityPacket,
  getLastRunDiagnostics,
};
