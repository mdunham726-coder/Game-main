# Phase 5 — TLS / ORS Object Operation Migration Program

> **Status:** Phase A ✅ / Phase B ✅ / Phase C ✅ / Phase D ✅ / Phase E ✅ / Phase F ✅ / Phase G ✅. All phases complete.  
> **Last updated:** June 7, 2026

---

## 1. Purpose and Scope

Phase 5 is no longer just "TLS executes whole-object take." It is a **TLS / ORS Object Operation Migration Program**. Whole-object take execution is only the first live authority lane inside that program.

This file is the standalone Phase 5 roadmap. It supplements `ROADMAP.md` — it does not replace it. `ROADMAP.md` remains the high-level object operation redesign tracker. This file drills into Phase 5 specifically.

---

## 2. Core Doctrine

**TLS becomes the semantic object-operation contract writer.**  
**ORS / ObjectHelper remains the authoritative mutation engine.**  
**AP is gradually stripped of object-operation ownership only where TLS has proven equivalent or better behavior.**

TLS should not become a second ActionProcessor. TLS should become the object-operation contract writer. ORS/ObjectHelper remains the mutation engine. AP is gradually stripped of object-operation ownership only where TLS has proven equivalent or better behavior.

---

## 3. Migration Ladder

Every operation lane follows the same hard doctrine, in order:

```
observe → normalize → diagnose → compare → execute → bypass → remove
```

1. **Observe** — TLS sees raw evidence from parser, AP, Authority Gate, CB, ORS context.
2. **Normalize** — TLS produces a structured `tls_instruction` describing what it believes the operation is.
3. **Diagnose** — TLS emits the instruction to diagnostics with refusal reasons and warnings.
4. **Compare** — Diagnostics compare TLS's predicted instruction against actual ORS mutations performed by the existing AP path. Alignment must be proven before execution.
5. **Execute** — TLS drives `ObjectHelper.transferObjectDirect` for exactly one narrow operation lane.
6. **Bypass** — AP's corresponding legacy path is gated off after TLS success, not before.
7. **Remove** — Only the migrated AP slice is removed. Other AP take behavior remains.

**Goal 3 (compare) is the safety hinge.** "TLS emits a nice-looking instruction" is not readiness. Readiness is:

```
TLS predicted operation
→ existing AP/ObjectHelper mutation happened
→ ORS before/after confirms the same object moved the same way
→ no duplicate, no wrong holder, no AP/TLS double path
```

---

## 4. Seven Goals

### Goal 1 — TLS Semantic Operation Understanding

TLS observes item-related player actions and normalizes them into structured object-operation instructions covering:

- acting actor (id, role)
- object identity (id, name, ORS-known status)
- object aliases / names
- source container (type, layer, key/id)
- destination container (type, owner)
- operation family (take, drop, give, put, use, extract, fracture, consume, inspect)
- operation type (whole_object_transfer, partial_object_transfer, etc.)
- layer / address context (L0, L1, L2, possibly L3 later)
- transfer direction
- whole-object vs partial-stack mode
- fission / extraction / fracture requirement
- quantity / unit if applicable
- accessibility status
- source truth level (ORS, CB candidate, parser field, environment gather, narrator-only, unknown)
- authority status (executable, diagnostic-only, ambiguous, blocked)
- expected state after operation

Output is a structured instruction, not just a one-word operation label.

### Goal 2 — TLS Diagnostic Instruction Stream

Before TLS mutates anything, there must be readable proof of what TLS thinks the operation is.

Every relevant object turn should expose:

- `item_operation_witness` — raw evidence
- `tls_proposed_operation` — Phase 4 output (preserved)
- `tls_instruction` — structured v0 operation instruction
- `tls_warnings` — contract uncertainty warnings
- `tls_execution_status` — attempted / refused / succeeded, with reason

Even before live execution, `tls_execution_status.executable` should be `false` for observe-only lanes.

Diagnostics must include **why TLS refused authority**. Examples:
- `"partial_quantity_not_in_phase_scope"`
- `"object_not_known_to_ors"`
- `"ambiguous_source_container"`
- `"gate_denied"`
- `"ap_already_executed"`

TLS should warn on at least:
- missing object ID
- multiple matching ORS objects
- parser says whole object but quantity fields imply partial
- object accessible according to AP but not according to ORS context
- source container mismatch
- destination unclear
- NPC-held ambiguity
- environment-gather candidate instead of existing ORS object
- layer mismatch
- duplicate mutation risk
- AP already transferred before TLS saw it

### Goal 3 — TLS / ORS Alignment Checking

This is the safety hinge. TLS must prove it can describe what AP currently does before TLS is allowed to execute.

**Capture before/after ORS snapshots** for every relevant object operation turn:
- `ors_before`: holder, present, quantity (for the target object)
- `ors_after`: holder, present, quantity
- For partial ops: source object before/after quantity, successor created

**Alignment statuses:**
- `matched` — TLS predicted the same transfer the engine performed
- `mismatched` — TLS predicted wrong holder, wrong object, or wrong direction
- `not_observed` — no ORS mutation evidence available
- `ambiguous` — multiple possible interpretations
- `not_applicable` — non-object turn

**Critical comparisons:**
- TLS predicted object moved from X to Y → ORS after-state confirms object at Y
- No duplicate: object not present at both source and destination
- Correct object: TLS identified the same object ORS mutated
- No wrong holder: destination matches TLS prediction

Alignment checker remains **diagnostic-only** until Goal 4.

### Goal 4 — First Live Execution Lane: Known ORS Whole-Object Take

After alignment is proven stable, TLS executes exactly one narrow case:

**Execution gate (ALL must be true):**
- `operation_family === "take"`
- `operation_type === "whole_object_transfer"`
- `actor === player`
- object known to ORS (has stable `object_id`)
- source container is known
- destination is player inventory
- requested quantity mode is `whole_object`
- `requires_fission === false`
- `requires_successor_creation === false`
- not NPC-held (unless explicitly supported)
- not environment gather
- not ambiguous
- not compound action
- not already mutated by AP

**Execution lane:**
```
TLS normalized instruction
        ↓
TLS execution gate (allowlist check)
        ↓
ObjectHelper.transferObjectDirect(...)
        ↓
record execution result
        ↓
mark AP take handler as bypassed
        ↓
narrator receives resolved state
```

TLS decides the instruction. ObjectHelper mutates reality. AP does not perform duplicate take logic.

**Execution allowlist:** Use an explicit allowlist (`allowed_operation_types: ["whole_object_transfer_take"]`), not a generic `tls_can_execute` boolean.

**AP bypass guard:** After TLS successfully executes, AP must receive:
```
object_operation_already_executed: true
executed_by: "tls"
operation_id: "tls_op_..."
```
AP's legacy take path must skip ONLY when these conditions hold:
- TLS execution status is success
- Not TLS observe-only
- Not TLS refused
- Not partial take
- Not failed TLS mutation (unless failure policy says fail closed)

### Goal 5 — AP Take Ownership Reduction

**Remove only the migrated known-ORS whole-object take slice from AP.** This does NOT mean removing AP take generally.

AP still owns:
- environment gather take
- partial-stack take
- unknown object take
- inaccessible object take
- NPC-held object take
- compound action take
- all other take edge cases

Removal from AP means only the narrow slice now covered by TLS (known ORS whole-object take). Each remaining take variant stays on AP until it gets its own observe → diagnose → compare → execute → bypass → remove ladder.

### Goal 6 — Formal TLS / ORS Mutation Contract

TLS and ORS need a stable versioned instruction/result schema.

**Minimum v0 instruction schema (`tls_ors_instruction_v0`):**
```
{
  schema_version: "tls_ors_instruction_v0",
  operation_id: "tls_op_...",
  operation_family: "take",
  operation_type: "whole_object_transfer",
  actor: { id, type },
  object: { id, name, match_confidence },
  source: { layer, container_type, container_id },
  destination: { container_type, owner_type, owner_id },
  quantity: { mode },
  mutation: { requires_fission, requires_transfer, retires_source, creates_successor },
  execution: { mode, allowed_to_execute, refusal_reason }
}
```

**Execution result shape (from ObjectHelper):**
```
{
  success: true/false,
  operation_id: "tls_op_...",
  mutation_type: "whole_object_transfer",
  object_id: "obj_...",
  from: { ... },
  to: { ... },
  before: { ... },
  after: { ... },
  warnings: []
}
```

Use explicit schema versions from the start so future extraction/fracture contracts can evolve without breaking diagnostics.

### Goal 7 — Regression Harness

Every migration phase gets:
- positive tests (happy path)
- negative controls (non-migrated lanes preserved)
- duplication checks (no dual mutation)
- AP bypass checks (AP visibly skipped only after TLS success)
- preservation checks (AG, CB, environment gathering, parser fields, ORS authority)

---

## 5. Must-Preserve Systems

### Environment Gathering
Known scene-description-to-object promotion must continue. TLS whole-object take must not block `take berries`, `take a pinecone`, `take loose stones` when those objects are not already in ORS but are narratively discoverable.

### Normal Object Behavior
Existing working take/drop/put/give/extract behavior must not regress outside the narrow migrated lane.

### Authority Gate
AG remains upstream authority over whether a player action is allowed. TLS does not override AG. TLS does not let player command NPCs. TLS does not validate impossible or forbidden actions just because an object transfer shape is present.

### Continuity Brain
CB remains semantic observation/reporting/interpretation support. TLS must not duplicate CB promotion behavior. CB candidates and TLS instructions must remain distinct.

### ORS / ObjectHelper Authority
TLS does not mutate raw ORS structures directly. TLS emits instructions. ObjectHelper mutates.

### Anti-Duplication Guards
No double creation. No duplicate transfer. No same object appearing in source and destination after take. No AP + TLS double handling.

### Parser Enrichment Fields
Existing fields (`requested_quantity`, `quantity_word`, `quantity_mode`, `normalized_target`, `operation_family`, `source_container_hint`) must survive because TLS depends on them.

### Witness Diagnostics
Do not remove the Phase 4 diagnostic proposal path. It becomes the audit trail.

### Narrator Grounding
Narrator describes resolved reality. Narrator should not invent success if TLS/ORS did not mutate.

---

## 6. Failure Posture

| TLS State | AP Behavior |
|---|---|
| Gate refusal **before** mutation attempted | AP fallback **allowed** — AP proceeds normally |
| TLS mutation **attempted** (started but could not complete) | **No AP fallback** — fail closed, return diagnostic |
| TLS mutation **success** | AP bypass **required** — AP must not re-execute |

This prevents dual mutation: TLS should never execute an object transfer and then allow AP to execute the same take path again.

---

## 7. Explicit Non-Goals for Early Phase 5

- Do **not** migrate partial-stack take yet
- Do **not** migrate drop / put / give / use yet
- Do **not** migrate environment gather yet
- Do **not** migrate NPC-held take yet
- Do **not** migrate compound actions yet
- Do **not** remove all take handling from AP — only the narrow known-ORS whole-object slice

All of the above remain on the AP/old path or fail closed until explicitly migrated through their own ladder.

---

## 8. Phase Breakdown

### Phase A — Contract Design (no code mutation) ✅ Complete
- Define the TLS → ORS instruction schema (v0)
- Define minimum fields for whole-object transfer
- Define refusal reasons
- Define execution result shape
- Define diagnostic names
- **Exit:** Research/Planning can point to exact source fields that populate each instruction field
- **Delivered:** v1.91.38 — `_assembleTlsInstruction` helper, v0 `tls_instruction` schema with 25 fields, 6 GPT tightenings applied

### Phase B — Observe-Only Instruction Emission ✅ Complete
- TLS emits `tls_instruction` for whole-object take
- No execution — AP still handles all mutations
- **Exit:** Diagnostics show stable TLS instruction for known ORS whole-object take
- **Delivered:** v1.91.38 — `debug.tls_instruction` assigned after `debug.tls_proposed_operation`, stored in `_witnessStore` payload, exposed via `GET /debug/witness`
- **Validated:** Mother Brain runtime confirmation June 6, 2026 — 20/20 gates PASS across 3 turns (whole-object take, non-object, environmental gather)

### Phase C — ORS Alignment Diagnostics ✅ Complete / Validated (caveat)
- Compare TLS proposal to actual AP/ObjectHelper mutation
- **Exit:** For known ORS take, TLS prediction matches actual ORS mutation
- **Delivered:** v1.91.40 — `_assembleTlsOrsAlignment(w, instruction)` pure helper, `debug.tls_ors_alignment`, `_witnessStore` key, `turnObject` archive field. 6-status taxonomy: matched, mismatched, not_applicable, insufficient_evidence, skipped_non_transfer, unsupported_operation_type.
- **Validated:** Mother Brain June 6, 2026 — Turn 2 whole-object take `matched` ✅, Turn 4 non-object `not_applicable` ✅, Turn 5 env gather `skipped_non_transfer` ✅. Partial-stack `unsupported_operation_type` NOT EXERCISED — needs cleaner test.
- **Caveat:** Turn 3 "take 2 grapefruits" routed as synthetic env gather, not AP partial-stack split. Partial-stack deferral path untested. Not a Phase C defect — alignment correctly refused to invent a status the evidence didn't support.

### Phase D — Live TLS Whole-Object Take ✅ Complete / Validated
- Enable only: `take + known ORS object + whole object + player destination`
- TLS calls `ObjectHelper.transferObjectDirect`
- AP bypass guard added — structural `return` before AP's own transfer call
- **Exit:** Object transfers once, by TLS, with AP bypass visible in diagnostics
- **Delivered:** v1.91.41 (implementation) + v1.91.42 (lifecycle reset fix) — `ActionProcessor.js` eligibility gate + TLS execution block + AP bypass, `index.js` lifecycle reset + `debug.tls_execution_result` + `_witnessStore` key + `turnObject` archive field.
- **Validated:** Mother Brain June 7, 2026 — `tls_execution_result.mode: "live_execution"`, `authority.executor: "tls"`, `transfer.result: "success"`, `ap_bypass.take_bypassed: true`, `fail_closed: false`. Object moved exactly once — no dual mutation. `tls_instruction` still `observe_only`. `tls_ors_alignment` still `diagnostic_only`. All 5 archive layers present. Object Reality panel gap is a UI rendering gap, not a transfer failure.

### Phase E — Regression Hardening
- Run negative controls: partial take, environment gather, NPC-held, unknown, inaccessible, compound, drop/give/put, AG puppeting denial
- **Exit:** Only the intended whole-object take lane changed behavior; everything else remains old path

### Phase F — Make TLS Whole-Object Take Default ✅ Complete / Validated
- Remove feature flag after repeated validation
- **Exit:** TLS whole-object take is stable as normal engine behavior
- **Delivered:** v1.91.45 — post-execution correction pass in `index.js` (18 lines)
- **Validated:** Mother Brain June 7, 2026 — All 18 fields correct on positive TLS take. All 4 negative controls clean (partial stack, env gather, unknown object, drop). Corrected fields persist in archived `turnObject`. AP bypass evidence remains visible. No dual mutation.
- **Key finding:** No actual feature flag existed — only stale diagnostic labels (`observe_only`, `diagnostic_only`) that contradicted successful live execution. Correction is conditional on 4-field guard: `mode === 'live_execution'`, `executed_by === 'tls'`, `transfer.result === 'success'`, `destination.container_type === 'player'`.

### Phase G — Remove AP Known-ORS Whole-Object Take Slice ✅ Complete / Validated
- Remove only the AP slice now covered by TLS
- Do **not** remove all take handling yet
- **Exit:** AP no longer owns known ORS whole-object take; AP still owns environment gather, partial take, unknown object take, and unsupported edge cases
- **Delivered:** v1.91.46 — removed legacy AP `player_take` fallback block (lines 610-632) from `ActionProcessor.js`. 23 lines deleted.
- **Validated:** Mother Brain June 7, 2026 — object-ID proof (`obj_7f3a8702c0f7` grid→player by TLS, player→grid by drop, no duplicate, no successor, no `ap_direct_transfer`). All negative lanes clean (partial stack, env gather, unknown, drop, inaccessible). AP bypass evidence intact. No dual mutation.
- **Structural note:** The removed block was structurally reachable (when `_tlsEligible === false` due to unknown source container) but functionally inert (always failed at `transferObjectDirect`). Removal replaced a silent `console.warn` with the bottom logger's explicit `could not take target` — the safer outcome.

### Sidequest — Unsupported Referenced Entities & Destination Containers
- Discovered during Phase E testing (Turn 7 "give mushroom to guard" + Turn 8 "put mushroom in bag")
- Pattern: v1.91.44 fixed `referenced_objects` validation, but `referenced_entities` and destination containers have no equivalent deterministic post-LLM check
- AG allows hallucinated NPC recipients; Layer 1 fast-path skips destination-container validation
- ORS/ObjectHelper blocked the transfer (`to_container_not_found`), but ConditionBot was contaminated
- **See:** `SIDEQUEST_ENTITY_CONTAINER_VALIDATION.md` for full details
- **Now unblocked after Phase G completion**

### Phase H — Future Migration Lanes
Each one repeats the same ladder:
```
observe → normalize → diagnose → compare → execute → bypass → remove
```

Future lanes in recommended order:
1. Partial-stack take (extraction / fission)
2. Drop
3. Put
4. Give
5. Use / consume / transform
6. Fracture / destruction
7. Compound operation sequences
8. Environment gather promotion (if migrated at all)

---

## 9. Research Prerequisites

Before Phase A (contract design) begins, Research must source-map the current code against the migration ladder:

- [x] Locate witness assembly point in `index.js` — Slice 1 Q1 (lines 3199-3323)
- [x] Locate TLS proposal generation (`_normalizeWitness`, `_inferSourceContainerType`, `_generateTlsWarnings`) — Slice 1 Q2 (lines 3149-3196)
- [x] Locate AP take mutation path in `ActionProcessor.js` — Slice 1 (lines 452-540)
- [x] Locate `ObjectHelper.transferObjectDirect` call sites and call signature — Slice 1 (ObjectHelper.js line 849)
- [x] Locate diagnostics surfaces (witness store, debug endpoints) — Slice 1 Q5 (lines 3309-3323, line 7070)
- [x] Locate possible ORS before/after snapshot capture point — Slice 1 Q2 (ORS target derivation lines 3288-3305)
- [x] Locate safest AP bypass flag location — Deferred to Phase D research (not needed for Phase A/B)

---

## 9.5 Diagnostic Infrastructure Hardening (Completed)

Two follow-up improvements discovered during Phase A/B validation:

### DIH-1 — Witness/TLS Fields in turnObject History ✅
- **Commit:** v1.91.39
- **Problem:** `/debug/witness` is latest-only — Mother couldn't verify prior-turn diagnostics after overwrite
- **Fix:** Added 3 deep-cloned fields (`item_operation_witness`, `tls_proposed_operation`, `tls_instruction`) to `turnObject` literal; fields flow automatically into `turn_history` (memory) and flight recorder JSONL (disk)
- **Result:** Mother accesses historical turns via existing `GET /diagnostics/turn/:sessionId/:turn` — Turn 2 remains inspectable after Turn 20
- **Validated:** Mother Brain June 6, 2026 — "Historical archive not overwritten by latest-only — PASS"

### DIH-2 — Mother Brain Evidence Protocol (VOLATILE DIAGNOSTIC SURFACES) ✅
- **Commit:** MB v7.4.0
- **Problem:** Mother lacked doctrine distinguishing direct diagnostic evidence from reconstructed state
- **Fix:** Added VOLATILE DIAGNOSTIC SURFACES block to SYSTEM_PROMPT — teaches Mother: `get_witness` is latest-only, prefer `get_turn_data(turn=N)` for historical turns, label overwritten checks LOST / NOT DIRECTLY VERIFIED, label reconstruction as `[RECONSTRUCTED from later state]`, never start a new game to recreate missing evidence
- **Result:** Mother now has an evidence-protocol rule for volatile diagnostic surfaces
- **Scope:** `motherbrain.js` only — SYSTEM_PROMPT only — no tool changes, no engine changes

---

## 10. Validation Matrix

### Positive Controls (must pass)
| Test | Input | Expected |
|---|---|---|
| Happy path known ORS take | `take lantern` (lantern known to ORS, on ground) | Lantern moves to player inventory once |
| No duplicate | `take lantern` | No lantern remains on ground; no second lantern candidate created |
| AP bypass visible | `take lantern` (TLS lane) | Diagnostics: `executed_by: "tls"`, `ap_take_bypassed: true` |

### Negative Controls (must preserve old behavior)
| Test | Input | Expected |
|---|---|---|
| Environment gather preserved | `take berries` (berries not yet in ORS) | Old environment gather behavior works or fails exactly as before; TLS does not hijack |
| Partial-stack take preserved | `take 3 arrows` (quiver has 12) | Not routed through whole-object TLS take; existing partial/extraction behavior preserved |
| Unknown object preserved | `take imaginary crown` | Not TLS whole-object transfer |
| Inaccessible object preserved | `take sword` (inside locked chest) | Not TLS direct transfer |
| NPC-held object preserved | `take Bob's cup` (Bob holding cup) | Not early TLS whole-object transfer unless explicitly supported |
| Compound action preserved | `take cup and give it to Bob` | Not reduced to simple take |
| Authority Gate preserved | `Bob picks up the cup` | AG denies puppeting; no TLS transfer |

---

## Status Block

- **Status:** Phase A ✅ / Phase B ✅ / Phase C ✅ / Phase D ✅ / Phase E ✅ / Phase F ✅ / Phase G ✅. All phases complete.
- **First live TLS mutation authority validated:** Take known-ORS whole-object. TLS → ObjectHelper. AP bypassed. No dual mutation.
- **Phase E regression hardening:** Priority controls validated; partial-stack negative control COMPLETE; environment gather, unknown object, drop, inaccessible, give/put TLS negatives, and puppeting showed no TLS leakage. Compound remains supporting-only due to CB transfer-ref noise, not TLS leakage.
- **Phase F normalization:** v1.91.45 — post-execution correction pass makes diagnostics truthful for successful TLS takes. `tls_instruction.execution.mode: 'default'`, `allowed_to_execute: true`, `refusal_reason: null`. `tls_ors_alignment.mode: 'default_execution_confirmed'`, `non_authoritative: false`. AP bypass evidence preserved. Validated by Mother Brain June 7, 2026.
- **Deferred sidequest:** Unsupported referenced entities and destination containers documented in `SIDEQUEST_ENTITY_CONTAINER_VALIDATION.md`; now unblocked after Phase G complete.
- **Branch:** `phase-5-tls-object-operation-lane`
- **Next action:** Deferred entity/container sidequest (`SIDEQUEST_ENTITY_CONTAINER_VALIDATION.md`) — now unblocked after Phase G complete. Then Phase H — future migration lanes.
