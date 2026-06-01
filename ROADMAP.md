# Game-Main — Object Operation Redesign Roadmap

> Branch: `object-op-redesign`  
> Last updated: v1.91.31 (June 1, 2026)

---

## Overview

This branch implements the **ItemOperationWitness** system — a passive, diagnostics-only observation lane that captures a complete per-turn snapshot of every object operation the engine executes. The witness packet feeds a **TLS (Trusted Layer System)** normalization pipeline across Phases 4 and 5. Phase 4 is observe-only. Phase 5 is where TLS gains mutation authority for the first narrow case.

---

## Phase Status

| Phase | Title | Status | Version |
|---|---|---|---|
| Phase 1 | Parser enrichment — operation_family, quantity fields | ✅ Complete | v1.91.25 |
| Phase 2 | Authority Gate integration | ✅ Complete | v1.91.28 |
| Phase 3 | ItemOperationWitness observe-only skeleton + ORS target snapshot | ✅ Complete / Runtime Validated | v1.91.31 |
| Phase 4 | TLS observe-only normalization — propose canonical operation, no execution | 🔓 Unblocked — Not Started | — |
| Phase 5 | Whole-object take: ORS execution lane — TLS drives ObjectHelper for first narrow case | ⏳ Blocked on Phase 4 | — |

---

## Phase 3 — Detailed Log

### v1.91.22 — Witness Store Declared
- `_witnessStore = new Map()` added at module level in `index.js`
- Session eviction hook wired: `_witnessStore.delete(_sid)` fires with session TTL sweep
- `GET /debug/witness` endpoint wired to return `_witnessStore.get(sessionId)`
- **Status at this point:** Store allocated, endpoint live, no packet assembled yet

### v1.91.25 — Parser Enrichment (Phase 1 / Phase 3 prerequisite)
- `operation_family`, `requested_quantity`, `quantity_mode`, `normalized_target`, `source_container_hint` threaded into `mapped.player_intent` in the narrate queue loop
- These fields became the parser inference section of the future witness packet

### v1.91.28 — Authority Gate Integration (Phase 2 / Phase 3 prerequisite)
- Authority Gate result fields (`decision`, `reason_code`, `referenced_objects`, `engine_supported`, `gate_fast_path_hit`) captured and made available at witness assembly time

### v1.91.29 — Witness Packet Assembly (29 fields)
Initial `debug.itemOperationWitness` packet assembled in `index.js` (~line 3116).  
Packet includes:
- **Engine truth:** `raw_input`, `channel`, `turn_number`, `actor_id`, `container_type`, `container_id`
- **Parser inference:** `action`, `target`, `selection_mode`, `requested_quantity`, `quantity_word`, `quantity_mode`, `normalized_target`, `source_container_hint`, `operation_family`
- **AP validation evidence:** `ap_env_gather_label`, `ap_env_gather_source_object_id`, `ap_env_gather_synthetic`, `ap_executed_transfer_ids`, `ap_player_held`
- **Authority Gate:** `gate_decision`, `gate_reason_code`, `gate_referenced_objects`, `gate_engine_supported`, `gate_fast_path_hit`
- **Witness hints:** `epistemic_hint`, `operation_family_hint`, `confidence_hint`, `notes`
- Packet stored to `_witnessStore` per turn (latest-per-session, overwrites on each turn)

### v1.91.31 — Phase 3 Alignment: ORS Target Snapshot ✅
**Commit:** `06adb28` on `object-op-redesign`  
**File touched:** `index.js` only (~22 lines added)

Added 9 trusted ORS target snapshot fields to the existing witness packet:

| Field | Source | Notes |
|---|---|---|
| `target_object_exists` | `!!_orsRec` | False when no AP evidence |
| `target_object_id` | `_orsRec?.id` | Matches `ap_executed_transfer_ids` last entry |
| `target_object_name` | `_orsRec?.name` | Direct ObjectRecord passthrough |
| `target_object_status` | `_orsRec?.status` | `"active"` or other |
| `target_object_quantity` | `_orsRec?.quantity` | Number or null |
| `target_object_unit` | `_orsRec?.unit` | String or null |
| `target_object_container_type` | `_orsRec?.current_container_type` | Post-transfer snapshot |
| `target_object_container_id` | `_orsRec?.current_container_id` | Post-transfer snapshot |
| `target_object_accessible` | `true` when AP-resolved current turn | NOT derived from status — AP current-turn evidence only |

**Design decisions:**
- All fields use flat `snake_case` consistent with the existing 29-field convention
- `target_object_accessible = true` only when AP resolved the object this turn — never inferred from container status alone
- Labeled in code as "post-AP evidence" — reflects what AP actually operated on, not pre-execution intent
- All fields default to `false`/`null` when no AP evidence — packet never throws, never absent
- **Diagnostics only.** No TLS execution, no ObjectHelper mutation, no behavior change

**Total witness fields after v1.91.31:** 38 (29 original + 9 ORS target snapshot)

---

## Phase 3 Runtime Validation Results

All three validation cases run autonomously by Mother Brain (June 1, 2026):

### Case 1 — Take Object (`take every arrow`) — PASS
| Field | Value | Expected | Match |
|---|---|---|---|
| `target_object_exists` | `true` | `true` | ✅ |
| `target_object_id` | matches `ap_executed_transfer_ids[0]` | AP audit match | ✅ |
| `target_object_name` | `"arrows"` | ObjectRecord name | ✅ |
| `target_object_status` | `"active"` | ObjectRecord status | ✅ |
| `target_object_quantity` | `1` | ObjectRecord quantity | ✅ |
| `target_object_unit` | `null` | ObjectRecord unit | ✅ |
| `target_object_container_type` | `"player"` | Post-transfer (expected) | ✅ |
| `target_object_container_id` | `"player"` | Post-transfer (expected) | ✅ |
| `target_object_accessible` | `true` | AP-resolved current turn | ✅ |

Path: Authority Gate Layer 1 fast-path (`cell_item_confirmed`) → AP direct transfer via `transferObjectDirect`.

### Case 2 — Non-Object Control (`look around`) — PASS
All 9 `target_object_*` fields correctly null/false. No false positive from parser text, movement, narrator output, or CB-promoted objects (8 objects promoted to localspace floor — none falsely claimed as player target).

### Case 3 — Storage / Endpoint Validation — PASS
- All 9 fields present on both object and non-object turns (46 total witness keys, no truncation)
- Correct session and turn number confirmed via cross-check
- No runtime errors when no target object exists
- No TLS execution, no ObjectHelper mutation, no gameplay change

---

## Operational Notes

### Witness Store Behavior
`_witnessStore` holds **one packet per session** — the latest turn only. Each turn overwrites the previous packet. `GET /debug/witness` always returns the most recent turn's witness for the requesting session.

**Implication for validation runs:** Fetch witness immediately after the turn being tested. The next turn will overwrite it. Historical witness packets are not retained.

**Implication for Phase 4:** TLS will read the witness in-memory at assembly time, not via the endpoint. The latest-per-session store is a diagnostics exposure lane only — TLS does not depend on it for execution.

### Post-AP Timing Contract
The witness `target_object_*` snapshot is assembled **after** AP has executed. For `take` operations, `target_object_container_type` will read `player` (post-transfer), not `localspace`/`grid` (where the object originated). This is correct and expected. If pre-execution origin tracking is needed in future, add `target_object_prior_container_type` as a Phase 3.5 addition — out of scope for Phase 3.

### Partial Split Edge Case
On `drop`/`throw` with `selection_mode: partial_from_stack`, the ID pushed to `_apExecutedTransfers` is the **successor** (the split-off piece), not the source stack. The witness `target_object_id` will reflect the successor. If the source stack's pre-split state is needed by TLS in Phase 4, this will require a targeted fix.

---

## Phase 4 — Next Up

**Title:** TLS Observe-Only Normalization — Propose Canonical Operation, No Execution  
**Status:** 🔓 Unblocked  
**Prerequisite:** Phase 3 complete ✅

### What Phase 4 Is

TLS reads the completed witness packet and proposes a **canonical normalized operation** describing what it believes happened. This proposal is emitted to diagnostics only. AP still executes the actual mechanics. ORS/ObjectHelper is not driven by TLS yet.

Example — for `take every arrow`, Phase 4 TLS output should look like:

```json
{
  "operation_type": "whole_object_transfer",
  "verb": "take",
  "actor_id": "player",
  "source_object_id": "obj_774efda01a55",
  "source_object_name": "arrows",
  "quantity_mode": "all",
  "from_container_type": "localspace",
  "from_container_id": "site_a304c407/l2_ls_0",
  "to_container_type": "player",
  "to_container_id": "player",
  "confidence": "high",
  "mode": "observe_only"
}
```

This proposal is surfaced in the diagnostics panel as a `TLS ITEM OPERATION` block, e.g.:

```
TLS ITEM OPERATION
mode:               observe_only
normalized_op:      whole_object_transfer
source_object_id:   obj_774efda01a55
from:               localspace:site_a304c407/l2_ls_0
to:                 player:player
requested_quantity: null
resolved_quantity:  1
warnings:           []
```

### What Phase 4 Is NOT
- Not a mutation pass — no state changes, no ObjectHelper calls
- Not a replacement for AP or CB — AP still executes everything
- Not Phase 5 — TLS does not drive `transferObjectDirect` yet
- Not a new game mechanic

### Why Phase 4 Exists

Phase 4 proves TLS can correctly interpret the witness packet before it is trusted with mutation authority. If TLS proposes the wrong canonical operation on a known input, that is caught here at zero cost — no broken game state, no player-visible side effects. Only after Phase 4 validation does TLS earn the right to drive ObjectHelper in Phase 5.

### Phase 4 Deliverable
- A `tls_proposed_operation` block emitted per turn when `target_object_exists === true`
- Stored alongside or adjacent to the witness packet in diagnostics
- Readable via `GET /debug/witness` or a new `GET /debug/tls` endpoint
- All fields are proposals only — `mode: "observe_only"` is non-negotiable for this phase

### Phase 4 Entry Condition
Witness packet complete and runtime-validated ✅ (met as of v1.91.31)

---

## Phase 5 — On Deck (Blocked on Phase 4)

**Title:** Whole-Object Take — ORS Execution Lane  
**Status:** ⏳ Blocked on Phase 4  

### What Phase 5 Is

For the narrow case of **known accessible ORS object + take + whole-object intent**, TLS's normalized operation proposal is allowed to drive `ObjectHelper.transferObjectDirect` directly. AP remains the fallback for all other cases.

Transition:
```
known accessible ORS object
+ take
+ whole-object intent
→ TLS normalized operation
→ ObjectHelper.transferObjectDirect
→ narrator describes resolved reality
```

This is the first point at which TLS has mutation authority. All other object operation types remain on the AP path until subsequent phases extend the execution lane.

### Phase 5 Entry Condition
Phase 4 TLS normalization validated on known cases — TLS proposals match expected canonical operations.
