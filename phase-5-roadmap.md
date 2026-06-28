# Phase 5 Roadmap

**Branch**: `partial-stack-execution`
**Last updated**: 2026-06-28
**Status**: P5-A2 COMPLETE — live TLS partial-stack execution handoff deployed, runtime-validated (single-action). P5-A1 dead-end seals remain active. **P5-A3 is the next active phase.**

---

## P5-A1 — AP Quarantine / Dead-End Proof ✅ COMPLETE

### Purpose

Prove that partial-stack TAKE reaches ActionProcessor, but ActionProcessor cannot mutate it, and no downstream path (TSL injection, CB transfer, CB candidate promotion) silently creates an ORS mutation after AP refusal.

### What was implemented

Four seals, all in `partial-stack-execution`:

| # | Commit | File | What |
|---|---|---|---|
| 1 | `v1.91.67` | `ActionProcessor.js` | AP quarantine — replaced TEMP BRIDGE with `_apActuals` quarantine/refusal + immediate return. No mutation, no split, no transfer. |
| 2 | `v1.91.68` | `index.js` | TSL injection guard — `_apRefusedTake` suppresses fission and extraction injection blocks when AP refused ownership. |
| 3 | `v1.91.69` | `index.js` | CB transfer guard — Phase 3 filter in `_cbTransfers.filter()` suppresses environment→player transfers during TAKE turns when env gathering not active. |
| 4 | `v1.91.70` | `index.js` | CB candidate promotion guard — in-place filter after extraction gate suppresses `environment_interaction` → `player` candidates when AP refused ownership. Six-condition structural guard, no name matching. |

### CB candidate promotion guard details

Inserted in the gap between the extraction gate and `_cbCandidates` capture. Filters `_phaseBResult.object_candidates` in-place. Suppresses only when all six are true: `container_type === 'player'`, `transfer_origin === 'environment_interaction'`, `_parsedAction === 'take'`, `_envGatherLabel === null`, `_apActuals.routing === 'quarantined'`, `_apActuals.outcome === 'refused_ownership'`. Breadcrumbs in `suppressed_replays` with reason `cb_candidate_take_suppressed`. Counter exposed as `cb_candidate_take_suppressed`.

### What was validated (runtime)

All four seals working correctly:

- AP writes `routing: 'quarantined'`, `outcome: 'refused_ownership'`, returns without mutation
- TSL fission/extraction injection suppressed when `_apRefusedTake` is true
- CB environment→player transfers suppressed during TAKE with no env gather
- CB player-candidate promotion suppressed after AP-refused partial-stack TAKE
- Source stack quantity unchanged through the full turn
- No successor created anywhere
- Whole-object TAKE still works through TLS direct transfer
- Environmental gathering still works through CB candidate promotion

### Current P5-A1 status

| Component | Status |
|---|---|
| AP quarantine implementation | ✅ Complete |
| TSL fission/extraction injection suppressed | ✅ Verified |
| CB transfer guard (environment→player) | ✅ Verified |
| CB candidate promotion guard (environment→player) | ✅ Verified |
| Source quantity unchanged through full turn | ✅ Verified |
| No successor created | ✅ Verified |
| Player receives nothing on partial-stack TAKE | ✅ Verified |
| Full turn is a dead end | ✅ Verified |
| Whole-object TAKE unaffected | ✅ Verified |
| Environmental gathering unaffected | ✅ Verified |

### Exit criteria — all met

- AP writes `routing: 'quarantined'`, `outcome: 'refused_ownership'` ✅
- Source stack quantity remains unchanged ✅
- No AP successor created ✅
- No TSL fission/extraction ObjectHelper partial split ✅
- No CB transfer creates duplicate player inventory ✅
- No CB candidate promotion creates duplicate player inventory ✅

### Next phase — P5-A2 ✅ COMPLETE → P5-A3 ⏳

P5-A1 is complete. The dead-end proof holds. P5-A2 has been implemented and runtime-validated — the live TLS partial-stack execution lane is deployed. The four P5-A1 guards remain active (not yet narrowed). P5-A3 (Single-Mutator Validation) is the next active phase.

---

## P5-A2 — Live TLS Partial-Stack Execution Handoff ✅ COMPLETE

### Purpose

Convert the P4 dry-run prediction into a live TLS partial-stack execution lane. When P4 predicted a valid partial split, the TLS lane calls `ObjectHelper.splitObjectDirect()` directly — AP is not a precondition. The new lane owns execution.

### What was implemented

Six items, two files (`v1.91.71`):

| # | File | What |
|---|---|---|
| 1 | `index.js` | Live TLS handoff block — two-condition P4-prediction gate (`operation_allowed === true && outcome === 'partial_split'`), calls `ObjectHelper.splitObjectDirect()` pre-narration/pre-CB |
| 2 | `index.js` | Audit entry `tls_partial_stack_take` pushed to `_objectRealityDebug.audit` |
| 3 | `index.js` | `_preserveDirectAuditActions` allowlist addition |
| 4 | `index.js` | Witness field `tls_partial_stack_result` in `_witnessStore` payload |
| 5 | `index.js` | Turn-history field `tls_partial_stack_result` cloned via `_cloneForArchive` |
| 6 | `Index.html` | `[TLS-PARTIAL]` display branch in `or.ran === true` audit loop |

Frontend display fix (same commit):

| # | File | What |
|---|---|---|
| 7 | `Index.html` | `[TLS-PARTIAL]` display + `_reasonLabel` override in `!or.ran` skipped path — fixes unreachable rendering when ORS is skipped, replaces stale "ActionProcessor (AP-dedup)" label with "transfers handled by TLS partial-stack executor" |

### Execution gate (exactly two conditions)

`debug.tls_executor_dry_run?.operation_allowed === true && debug.tls_executor_dry_run?.outcome === 'partial_split'`

AP is diagnostic only — `ap_actuals` captured via `gameState._apActuals ?? null`, not gated on.

### What was validated (runtime)

- `tls_partial_stack_take` audit action present and `executed: true`
- Source stack decremented (7 → 3), successor object created (4 tacos in player inventory)
- AP writes `routing: 'quarantined'`, `outcome: 'refused_ownership'` — spectator only
- CB candidate + CB transfer both suppressed (`cb_candidate_take_suppressed: 1`, `cb_take_transfers_suppressed: 1`)
- ORS skip reason `ap_dedup_all_transfers` — transfer already handled by TLS
- `debug.tls_executor_dry_run` preserved frozen
- P5-A1 guards untouched
- Whole-object TLS TAKE unaffected
- Frontend correctly displays `[TLS-PARTIAL]` with "transfers handled by TLS partial-stack executor"

### Design invariants held

| # | Invariant | Status |
|---|---|---|
| I1 | `debug.tls_executor_dry_run` frozen and unchanged | ✅ Held |
| I2 | AP quarantine unchanged | ✅ Held |
| I3 | ObjectHelper mutation authority unchanged | ✅ Held |
| I4 | P5-A1 guards remain active | ✅ Held |
| I5 | `_objectRealityDebug` rebuild not disrupted | ✅ Held |
| I6 | P4 prediction preserved for Mother Brain comparison | ✅ Held |
| I7 | Whole-object TLS TAKE unaffected | ✅ Held |
| I8 | Non-TAKE turns unaffected | ✅ Held |
| I9 | Multi-action queue correctness | ⏳ Pending multi-action runtime test |
| I10 | No new endpoints, no broad redesign | ✅ Held |

### Exit criteria — P5-A2 core criteria met

- TLS lane executes on P4's authority alone ✅
- AP is diagnostic, not gating ✅
- ObjectHelper mutation produces correct ORS state ✅
- CB suppressed (no duplicate) ✅
- Frontend shows correct TLS attribution ✅
- `debug.tls_executor_dry_run` untouched ✅

---

## P5-A3 — Single-Mutator Validation ⏳ NEXT ACTIVE

### Purpose

Prove that partial-stack TAKE works through exactly one live mutator.

### Expected result

A successful partial-stack TAKE produces:

- One source stack decrement
- One successor object
- One inventory update
- Diagnostics that agree across all surfaces
- No AP split
- No duplicate downstream CB/TSL/ObjectHelper split

P5-A3 is the proof that the new lane is the only live mutator for partial-stack TAKE.
