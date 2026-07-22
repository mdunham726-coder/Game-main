# THROW → TLS Migration Implementation Plan

## Plan Status

- **Status:** APPROVED — Stages 1-6 of the companion roadmap are complete. **Stage 7 authority validation passed with explicitly accepted exceptions** (see roadmap Stage 7 status and O5/O6 below): entire-stack natural-language routing blocked by issue #40 (cross-family, pre-existing); zero/invalid quantity source-validated only; compound-queue full inertness fails because Continuity Brain can independently promote a real duplicate object outside the single-action seal — a state-mutation limitation, not merely a narration gap, accepted and deferred by explicit user decision. No new TAKE or DROP regression attributable to this migration was observed (issue #38, unrelated and pre-existing, still exists independently). Slice D1 (issue #37 guard) has not landed. **Stages 8-13 have not started.**
- **Active plan:** Migrate single-action THROW object-operation ownership from ActionProcessor to the existing TLS → ObjectHelper → ORS authority pipeline, mirroring the completed DROP migration. Includes one independent diagnostics slice (GitHub issue #37).
- **Planning mode:** HIGH-RISK (index.js, ActionProcessor.js, ContinuityBrain.js, SemanticParser.js implicated; SemanticParser.js is read-only in this plan)
- **Last updated:** 2026-07-21
- **Branch/source state:** `main` at `41dff601d5c56516eee8a9e6a5281b7530b43724` (`v1.92.8: add "acquire" to deterministic TAKE fast path`)
- **Working tree at planning time:** ` M .gitignore`, ` D tests/.last-harness-result.json` — both unrelated to this plan's scope; preserved untouched.
- **Evidence basis:**
  - `research-notes(226)(1).md` — THROW→TLS migration feasibility research (2026-07-21), including three closure addenda; principal evidence summary.
  - `DROP_TLS_MIGRATION_ROADMAP_UPDATED_v1.91.843.txt` — DROP migration precedent (see discrepancy note below).
  - `partial-drop-slice-1-plan(1).md` — receipt-lifecycle / live-partial-DROP slice precedent.
  - `DROP_STEP4_IMPLEMENTATION_PLAN(2).md` — dry-run-integration stage precedent.
  - `partial-drop-cb-replay-containment-evidence-handoff-2026-07-14(1).md` — forensic evidence for CB replay of a surviving source after a partial split (Bug B). Historical: the DROP protections it lists as missing have since been implemented on `main` (verified this pass).
  - Direct source verification during this planning pass (all file:line receipts below re-verified against `main` @ `41dff60`).
  - GitHub issue #37 (fetched live this pass; state OPEN; title and body match the diagnostics gap recorded in research Addendum 3 Item 5).
- **Precedent-document discrepancy (recorded, not blocking):** the task named the "reconciled v1.91.88" DROP roadmap; the supplied file is the earlier v1.91.84-checkpoint revision (filename suffix `v1.91.843`). Its 12-step staged sequence is the same shape the task's 13-step mirror instruction encodes, and the migration endpoint it describes is fully corroborated by current source (DROP is complete and live on `main`). The precedent is therefore usable; no stop condition triggered.
- **Evidence freshness:** research notes dated 2026-07-21 (same day as this plan); every planning-critical anchor was independently re-verified against the current working tree during this pass. Findings below are marked re-verified unless stated otherwise.
- **Re-verification triggers:** branch or HEAD change; edits to `ActionProcessor.js`, `ObjectOperationResolver.js`, `TlsObjectOperationExecutor.js`, `ObjectOperationBridge.js`, `ObjectHelper.js`, `ContinuityBrain.js`, `SemanticParser.js`, `authoritygate.js`, `diagnostics.js`, or the implicated `index.js` regions; closure or edit of issue #37; new runtime evidence contradicting recorded behavior; user scope change.
- **Approval:** APPROVED by the user via direct conversational authorization on 2026-07-21, given after the GPT forensic review revision (Revision 1) was pushed. The user explicitly stated this authorization is "ceremonial authority" in place of a file edit; this Revision 2 syncs the file text to match. Implementation is authorized per this contract and the companion roadmap's per-stage gates — each stage still requires Gate A (source re-verification) before its slice is coded.
- **Companion document:** `THROW_TLS_MIGRATION_ROADMAP.md` (staged sequence derived from this contract). The two documents were written together and must be revised together.

## Objective

Move single-action THROW object-operation ownership out of ActionProcessor and into the existing TLS → ObjectHelper → ORS authority pipeline, reusing the TAKE/DROP architecture: `ObjectOperationResolver` policy resolution, `tls_ors_instruction_v1` assembly, `TlsObjectOperationExecutor` dry-run prediction, post-Engine live execution in `index.js`, `ObjectOperationBridge` routing/seal, the request-local partial-stack receipt lifecycle, CB receipt/sanitizer/prompt-precedence/replay-suppression protections, description reconciliation, and existing diagnostics surfaces.

Do not invent a new THROW subsystem. Do not broaden compound-command support. Do not change validated TAKE or DROP contracts.

### Frozen THROW mechanical contract (authoritative for this migration; set by current user instruction 2026-07-21)

1. THROW begins with a player-held authoritative ORS object (active, `player`/`player` container, present in `player.object_ids`).
2. It moves one object unit (default when quantity is unspecified or article-form), an explicitly requested integer quantity, or the entire stack (explicit "all" with truthful all-stack metadata, or explicit quantity equal to the stack).
3. Destination is the authoritative current Ground resolved by `resolveCurrentGround(state)` ([ObjectOperationResolver.js:68-103](ObjectOperationResolver.js:68)): active localspace → active site tile → current L0 grid cell, each branch fail-closed.
4. Over-stack, vague ("some"), malformed, contradictory, zero, negative, fractional, or otherwise unsupported quantity requests fail closed with no mutation.
5. Single-action TLS boundary only (`validation.queue.length === 1`), identical to DROP. Compound queues do not enter the THROW TLS lane.
6. Impact-target language ("throw X at Y"): the parser schema (`SemanticParser.js:127-128`) carries no structured impact-target field and the THROW instruction (`SemanticParser.js:81`) directs target to the base item name only — there is no **authoritative** impact-target mechanic. However, trailing target phrasing is already interpreted and narrated by the existing narration layers (user runtime evidence: a thrown object narrated as striking a named structure and coming to rest on the ground; the defect in that session was wrong-layer authoritative placement, not target comprehension). That observable behavior is preserved unchanged. This migration does not add, remove, or redesign impact-target behavior; it only moves object-operation authority and corrects authoritative Ground placement. Coding must not treat trailing target phrasing as unsupported or suppress its narration.

## Research Basis

### Observed facts (all re-verified against `main` @ `41dff60` during this planning pass)

**THROW today (AP-owned, mutating):**

1. `ActionProcessor.js:667-758` — full THROW handler. Resolves source via deterministic `resolveItemByName` (call at line 670, not the LLM resolver). Destination hardcoded to `'grid'` + cell key from `state.world.position` (lines 687-688, 736-737, 695, 740) — never reads `active_site`/`active_local_space`, so THROW at L1/L2 places objects in the wrong layer.
2. Partial branch (685-726): fires on `selection_mode === 'partial_from_stack'` with stack quantity > 1; calls `splitObjectDirect` with literal extract quantity `1` (line 695) regardless of `actions.requested_quantity`; stamps `_apExecutedTransfers` with the successor ID; writes an `ap_partial_split` audit entry whose `requested_quantity` echoes the hardcoded 1.
3. Whole branch (728-753): fires when `selection_mode` is absent, even for stacks (log-only warning at 734); calls `transferObjectDirect` reason `player_throw`; stamps `_apExecutedTransfers` with the source ID.
4. `ActionProcessor.js:600-608` — DROP quarantine stub: writes `{ operation_family:'drop', routing:'quarantined', helper_method:null, outcome:'refused_ownership' }` to `state._apActuals` and returns. THROW has no equivalent.
5. Comment at `ActionProcessor.js:668` ("same path as drop") is stale — DROP no longer has an AP transfer path.

**Parser / enrichment (read-only in this plan):**

6. `SemanticParser.js:81` — THROW LLM instruction already directs quantity-prefix phrases to set `selection_mode:"partial_from_stack"` and target to base item name only. Identical in shape to DROP's instruction at line 82.
7. Generic enrichment (`_enrichPrimaryAction`) supplies `requested_quantity`, `quantity_word`, `quantity_mode`, `normalized_target`, and `operation_family` (map includes `throw:'throw'`) for THROW already; the deterministic `selection_mode` backstop is gated to `take` only (research Addendum; DROP also lacks it and works — mirror DROP: no parser change).
8. Parser output schema (`SemanticParser.js:127-128`) has no structured impact-target field of any kind; repo-wide grep for impact-target field names returned zero hits (research Addendum 3 Item 4). This proves absence of an authoritative impact-target mechanic only — it does not prove trailing target phrasing has no effect. User runtime evidence shows the narrator already renders impact against a named trailing target with the object landing on the ground. That narration behavior is non-authoritative, currently working, and out of scope to change (frozen contract item 6).

**TLS lane (DROP precedent, live on main):**

9. `ObjectOperationResolver.js` — `resolveCurrentGround` (68-103, exported at 1103); `_enumerateDropCandidates` (165-190, player-held membership-order enumeration); `_dropPolicy` (204-214: destination = current Ground, `strictDestinationValidation`, `strictPlayerSourceValidation`, `deterministicDuplicateAmbiguity` all true); `_deriveDropEffectiveQuantity` (437-464: all→available with truthful metadata, some→fail, unspecified/article→1, exact→parser integer, else fail); `_validateModelResponse` family branches at 755-797 (`drop` / `take` only — a third family currently falls through with quantity fields unset); public wrappers + exports at 1095-1103.
10. `_assembleTlsInstructionV1` (`index.js:1468+`) is family-agnostic: family-match trust gate at 1473-1481, no family literals. No THROW change needed at P2.
11. `TlsObjectOperationExecutor.js` — allowlist at line 72 rejects any family other than `take`/`drop` (`unsupported_operation`); DROP-keyed checks at 191-196 (`dropSourceValid` player-held enforcement), 199-207 (`currentGround` recompute + destination agreement), 279-281 (fail-reason selection). Executor is pure dry-run; never calls ObjectHelper.
12. `index.js` DROP wiring: resolver branch gated `operation_family === 'drop' && validation.queue.length === 1` (2826-2836); P2 assembly (2851-2856); P4 dry-run (2858-2865); AP runs inside `Engine.buildOutput` (2867; `Engine.js:7,541` per research, re-verified in research closure pass); live whole-DROP block (2880-2926: gates on instruction+dry-run family, `operation_allowed`, `outcome==='whole_transfer'`, predicted method; sets `_authorityGateWholeDropObjectId`, writes `gameState._tlsExecutionResult`); live partial-DROP block (2927-2993: additionally gated `queue.length===1`; writes `gameState._tlsPartialStackResult` + `_tlsPartialStackArchive`; captures `_tlsPartialStackDropDescriptionTarget`; quantity-one successor rename via `_singularizeDropSuccessorName`; captures CB receipt via `_captureCbTlsPartialStackDropReceipt`; clears successor description via `ObjectHelper.setObjectDescriptionDirect`).
13. Per-request locals at `index.js:1106-1125` include `_authorityGateWholeDropObjectId`, `_tlsPartialDescriptionTarget`, `_tlsPartialStackDropDescriptionTarget`, `_tlsPartialStackArchive`, and both CB receipt slots with state flags. All are function-local per request — no staleness risk by construction.
14. Authority Gate whole-transfer compensation: `index.js:4315-4320` builds a non-mutating spread-clone re-adding `_authorityGateWholeDropObjectId` to `player.object_ids` for the gate call only. Partial splits never need it (source never leaves `player.object_ids`).
15. `authoritygate.js:261-266` — Layer-1 fast path already groups `'drop'` and `'throw'` for the inventory-match `allow_no_rc` route. No Authority Gate change needed for THROW.
16. CB protection chain for partial DROP (all live on main; the 2026-07-14 handoff's "missing equivalents" list is historical): capture `_captureCbTlsPartialStackDropReceipt` (`index.js:1346-1399`, schema `cb_tls_partial_stack_drop_v1`, strict cross-validation against split result + predicted call); request-local sanitizer `_sanitizeCbTlsPartialStackDropReceipt` (`index.js:1127+`); receipt passed to `CB.runPhaseB` as `tlsPartialStackDropReceipt` (`index.js:5792-5798`); ContinuityBrain-side sanitizer (`ContinuityBrain.js:1184-1219`) and prompt schema/precedence content (schema string at `ContinuityBrain.js:104`; precedence text region ~735-737); CB-supplied successor description path `partial_drop_successor_description` (extraction `ContinuityBrain.js:1326-1352`, return 1517; consumption `index.js:5800-5827`); deterministic post-CB replay suppression (`index.js:6731-6766`) — matches quarantine `transfer` entries on `source_object_id` + exact source/destination containers only; never on `successor_object_id`; never the promote path.
17. Two distinct CB duplication failure modes (must not be conflated): **Bug B** — CB emits a transfer of the real surviving source ID after a successful split (rocks incident, handoff §4-§14); deterministically suppressed for DROP by the receipt-keyed filter at 6731-6766. **Bug A** — CB promotes a brand-new duplicate object (name + temp_ref, no ID) that duplicates an authoritatively placed object; only mitigated by the generic name+exact-container dedup guard (`ObjectHelper.js:411-435`, plus soft-match guard at 437+), which is identity-blind (first unclaimed same-name match). No identity-precise Bug-A fix exists for DROP today either (research Addendum 2 cross-check).
18. Bug-A causal chain for THROW (research, Inferred/well-supported): the observed THROW duplicate arose because AP placed the thrown object in the hardcoded-wrong layer while CB independently inferred the layer-correct container; the containers differed, so the exact-container dedup guard could not match. Layer-correct TLS placement makes the existing guard applicable with no new suppression code, provided names and containers line up.
19. Narrator quantity grounding is generic and post-mutation: INVENTORY/GROUND blocks are rebuilt each turn from live ORS records with a layer-bound `_isGroundContainer` predicate (`index.js:3952-3962`); works for any action family automatically, provided mutation lands in the layer-correct container. Descriptions are NOT rendered there — description staleness is a separate, real surface (fact 16 covers the DROP mechanisms).
20. Source-description normalization `_normalizePartialSplitSourceDescription` (`index.js:1327-1344`) is target-driven and family-agnostic; called once per description target at `index.js:5855-5856` (TAKE target, DROP target).
21. DROP dry-run seal derivation: `_dropDryRunSealActive` (`index.js:4827-4828`) from the bridge receipt (`active === true && drop_dry_run_seal === true && parser === 'semantic' && queue_length === 1`); CB mutation arrays zeroed under the seal (`index.js:6499`, `6531-6532`).
22. `ObjectOperationBridge.js` — activates only for `semanticOperationFamily === 'drop' && semanticPathSingleAction === true` (line 51) with AP-refusal corroboration (55) and instruction/dry-run family checks (69, 72); separate TAKE no-candidates corner (206-209); returns `active:false` for unrecognized families (fails safe, gives THROW no benefit until a branch is added).
23. Diagnostics consumers (research Addendum 3 Item 5, all re-verified): `_buildPartialStackComparison` (`diagnostics.js:1577-1601`) has an explicit TAKE-only operation-family guard failing closed as `skipped_not_applicable`; `_buildP3ApTlsComparison` (`diagnostics.js:1318+`) has **no** family guard — proceeds to TAKE-shaped comparison whenever `tls_instruction_v1` and `ap_actuals` both exist (issue #37; already wrong for DROP today); `_assembleTlsOrsAlignment` (`index.js:4494-4529`) has a DROP branch (4507-4514: `not_executed` / `drop_tls_dry_run_no_transfer_expected`) and no THROW branch — a THROW dry-run turn would be mislabeled via the generic branches; witness surfaces at `index.js:4370-4371`, `4384`, `4711` are already THROW-aware (`'drop' || 'throw'` source derivation, `_objOps` includes throw, family hint includes throw).
24. `ObjectHelper.js` mutation surface (unchanged by this plan): `transferObjectDirect` (849), `splitObjectDirect` (1037) → `_executePartialSplit` (918), `setObjectDescriptionDirect` (1051). Split semantics: decrement source in place, create successor at destination with `parent_object_id` lineage; source never moves.
25. Issue #37 (fetched live): OPEN; diagnostics-only scope; acceptance criteria: unsupported families return stable `skipped_not_applicable` before TAKE-shaped extraction; TAKE unchanged; DROP and (future) THROW fixtures produce no fabricated P3 mismatch.
26. No THROW footprint exists in `ObjectOperationResolver.js`, `TlsObjectOperationExecutor.js`, or `ObjectOperationBridge.js` (research full-file grep). No throw-specific test files exist under `tests/` (research; glob returned none) — the THROW verification matrix has no existing regression baseline to extend.
27. `_apExecutedTransfers`-based CB transfer suppression (`index.js:6533-6573`) currently covers AP-executed THROW; after quarantine, AP no longer stamps it for THROW. Replacement protections: layer-correct placement + dedup guard (Bug A), THROW receipt chain (Bug B), and ObjectHelper's own source-container validation (a whole-transfer replay against an object no longer in `player`/`player` fails validation).

### Inferences

1. THROW's TLS integration is structurally isomorphic to DROP's: same source domain (player-held), same destination policy (current Ground), same routing math (partial/exact/over), same helper methods. A `_throwPolicy` mirroring `_dropPolicy` plus family extensions at the executor's five DROP-keyed points is sufficient; no new subsystem is required.
2. Because P2 assembly, the request-local receipt lifecycle (`_tlsPartialStackResult` active slot + `_tlsPartialStackArchive`), witness family surfaces, Authority Gate fast path, and narrator quantity grounding are already family-agnostic or already THROW-aware, the migration's index.js footprint is confined to: one resolver branch, two live-execution blocks, receipt locals/capture/sanitizer, runPhaseB option, post-CB consumption/suppression, alignment branch, and seal derivation.
3. Layer-correct THROW placement converts the observed Bug-A duplicate from "guard cannot apply" to "existing guard applies"; the residual identity-precision gap (pre-existing same-named object already in the destination container) is a pre-existing architectural limitation shared with DROP, not a THROW-migration defect.
4. The DROP incident history proves that enabling partial-split live execution without the CB receipt chain invites Bug-B replay. The THROW partial-live stage and its CB/description protections must therefore ship as one contiguous deployment unit (roadmap Stages 10-11), even though they are planned as distinct stages.

### Uncertainties

1. **Parser "all" metadata for THROW (runtime-unverified):** DROP runtime evidence showed the LLM parser emitting `quantity_mode:'all'` + `selection_mode:'all_from_stack'` for all-stack DROP phrasing. Whether it does the same for THROW phrasing has never been observed. Fail-safe: if it does not, `_deriveThrowEffectiveQuantity` fails closed (`contradictory_quantity_metadata`) — no mutation, truthful refusal. However, fail-closed is a safety floor, not contract completion: if runtime observation (Stage 7 / Stage 12) shows normal entire-stack phrasing consistently failing closed because the parser never emits the metadata, the entire-stack contract item is unmet — stop and return NEEDS USER DECISION rather than shipping it as contract-complete (Stop Condition 10a, row V7). Not a planning blocker.
2. **Parser `selection_mode` reliability for THROW partial phrasing:** depends on the line-81 LLM instruction (no deterministic backstop, same as DROP). Not load-bearing for routing (partial-vs-whole derives from effective quantity vs available), only for the `all` branch above and parse-quality. Runtime observation required; not a blocker.
3. **CB prompt-precedence effectiveness for the THROW receipt** is probabilistic (LLM compliance), exactly as for TAKE/DROP. The deterministic post-CB suppression filter is the enforced invariant; prompt precedence is defense-in-depth. Runtime validation required.
4. **Authority Gate Layer-1 fast-path firing conditions for THROW** were not exhaustively traced (research left this open; the observed Turn-8 transcript escalated to LLM). The fast path's existing drop/throw grouping is verified; whether it fires on a given input is runtime-dependent. Not load-bearing: both routes reach the same TLS lane.
5. **No runtime harness was executed during this planning pass** (work-environment constraint: Render-only access). All runtime claims are labeled as requiring later validation; every live-mutation stage has a runtime validation gate.

## Active Decisions

### D1 — Resolver layout: `_throwPolicy` over shared core, reusing DROP candidate enumeration

- **Decision:** Add `THROW_RESOLVER_KIND` constant, `_throwPolicy(state)` mirroring `_dropPolicy` (`operationFamily:'throw'`, `enumerateCandidates:_enumerateDropCandidates` reused unchanged, `destination:resolveCurrentGround(state)`, all three strict flags true), and public wrapper `resolvePlayerHeldThrow(state, actions)` mirroring `resolvePlayerHeldDrop` (`ObjectOperationResolver.js:1099-1101`), exported at 1103.
- **Reason:** THROW's source domain is identical to DROP's (active player-held `player`/`player` objects in membership order); duplicating the enumerator would create drift risk with zero benefit.
- **Rejected:** separate THROW enumerator (pointless duplication); generalizing the TAKE path (different source domain); new resolver module (violates minimality; DROP precedent D1 already rejected this).
- **Re-verification trigger:** `_enumerateDropCandidates` or `_dropPolicy` change before implementation.

### D2 — Quantity semantics: clone DROP's derivation as `_deriveThrowEffectiveQuantity` with throw-named basis strings

- **Decision:** Add `_deriveThrowEffectiveQuantity(actions, availableQuantity)` as an exact behavioral clone of `_deriveDropEffectiveQuantity` (`ObjectOperationResolver.js:437-464`) with basis strings `throw_default_one` / `throw_all_available` (and `parser_explicit` unchanged), plus a new `else if (policy.operationFamily === "throw")` branch in `_validateModelResponse` after the DROP branch (755-776), identical in structure (destination echo, effective-quantity fields, fail-closed warning, `requested_vs_available`, `is_stack`).
- **Behavioral contract (frozen by the user instruction; this is an intentional, reviewed behavior change from legacy AP THROW, not a silent one):**

| Input class | quantity_mode | Legacy AP THROW | New TLS THROW | Status |
|---|---|---|---|---|
| bare noun, stack > 1, no selection_mode | unspecified | whole-stack transfer | effective quantity 1 → partial split | **Intentional change** per frozen contract item 2 |
| article form ("a/the/one of the") | article | partial split of hardcoded 1 | effective quantity 1 | Match (and now honest) |
| explicit integer n < stack | exact | partial split of hardcoded 1 (**observed defect**) | partial split of n | **Fixes observed defect** |
| explicit integer = stack | exact | hardcoded 1 (defect) | whole transfer | Fixes defect |
| explicit integer > stack | exact | hardcoded 1 (defect) | fail closed `over_stack`, no mutation | Fixes defect |
| "all" with `all_from_stack` metadata | all | whole-stack transfer | whole transfer (effective = available) | Match |
| "all" without truthful metadata | all | whole-stack transfer | fail closed `contradictory_quantity_metadata` | **Intentional change** (fail-closed per frozen contract item 4; see Uncertainty 1) |
| "some" / vague | some | whole-stack transfer | fail closed `unsupported_quantity_mode` | **Intentional change** per frozen contract item 4 |
| zero / negative / fractional / malformed | exact/other | undefined/whole | fail closed `invalid_quantity`, no mutation | Intentional (fail-closed) |

- **Reason for clone over direct reuse:** direct reuse of the DROP function would stamp `drop_default_one` / `drop_all_available` basis strings into THROW resolver evidence — misleading diagnostics (Validation Truthfulness). The clone leaves the validated DROP function byte-untouched (zero DROP regression surface) at the cost of ~28 duplicated lines, matching the existing TAKE/DROP per-family precedent.
- **Rejected:** direct reuse (dishonest evidence basis strings); parametrized shared helper (touches validated DROP path — unapproved TAKE/DROP contract change); preserving legacy whole-stack-by-default (contradicts the frozen contract; also unpreservable through TLS without inventing new quantity semantics DROP does not have).
- **Re-verification trigger:** `_deriveDropEffectiveQuantity` changes; parser quantity enrichment changes.

### D3 — Destination: `resolveCurrentGround`, unchanged

- **Decision:** THROW destination is the existing exported `resolveCurrentGround(state)` result. No new Ground formula, no executor-local variant.
- **Reason:** frozen contract item 3 matches the function's exact priority and fail-closed set; this also repairs the layer bug that produced the observed Bug-A duplicate (Observed 18).
- **Rejected:** preserving AP's hardcoded grid destination (it is the proven root of both the wrong-layer placement and the CB duplicate chain); a THROW-specific "trajectory/distance" destination model (new subsystem; excluded by user instruction).

### D4 — AP quarantine shape: refusal stub inserted above legacy mechanics; legacy code removed only in the final stage

- **Decision:** Insert at the top of the `if (act === 'throw')` branch (`ActionProcessor.js:667`) a refusal stub structurally identical to DROP's (600-608): write `state._apActuals = { operation_family:'throw', routing:'quarantined', helper_method:null, outcome:'refused_ownership' }` and return. Lines 669-758 become unreachable and are left byte-untouched until the final removal stage.
- **Consequences accepted:** AP stops stamping `_apExecutedTransfers` for THROW (Observed 27 — replacement protections land in later stages); during quarantine-only stages THROW is a controlled no-op with no narration seal yet (same transitional exposure DROP accepted between its steps 3 and 4; documented in the roadmap Stage 4 gate).
- **Rejected:** deleting legacy code in the same change (violates the inert-first causal-checkpoint method: the first live TLS mutation must be attributable to exactly one new path, and rollback of the stub must restore prior behavior trivially); keeping AP execution behind a flag (a second hidden authority — forbidden by the authority model).

### D5 — Executor: extend the five DROP-keyed points to `drop || throw`; no math changes

- **Decision:** In `TlsObjectOperationExecutor.js`: add `'throw'` to the allowlist (line 72); extend `dropSourceValid` (191-196) to enforce player-held source for `throw` as well; compute `currentGround` (199-200) for `throw`; destination validation (201-207) then applies unchanged; extend the fail-reason selection (279-281) to `throw`. The routing recomputation, quantity checks, and predicted-call assembly are family-agnostic and remain untouched. Coding must re-grep every `operation_family` comparison in the file and stop if occurrences beyond these five verified points exist.
- **Reason:** these five points are the executor's complete family-specific surface (verified this pass); everything between them is direction-neutral.
- **Rejected:** a parallel THROW validation path (duplication); relaxing `strictDestinationValidation` for THROW (would silently weaken the Ground contract).

### D6 — index.js wiring: mirror the DROP branches exactly; reuse `_authorityGateWholeDropObjectId` without rename

- **Decision:**
  - Resolver call: add `else if (mapped?.player_intent?.operation_family === 'throw' && validation.queue.length === 1)` after the DROP branch (2826-2836), calling `ObjectOperationResolver.resolvePlayerHeldThrow` with the same try/catch → evidence/error shape.
  - Live whole-THROW block mirroring 2880-2926: gates on instruction family `throw` + dry-run family `throw` + `operation_allowed === true` + `outcome === 'whole_transfer'` + predicted method `transferObjectDirect`; calls `ObjectHelper.transferObjectDirect` once with the dry-run's predicted parameters, reason `tls_whole_object_throw`; on success sets `_authorityGateWholeDropObjectId` (reused, see below) and writes `gameState._tlsExecutionResult` in the existing `tls_execution_result_v0` shape.
  - Live partial-THROW block mirroring 2927-2993: additionally gated `validation.queue.length === 1`, `outcome === 'partial_split'`, predicted method `splitObjectDirect`; calls `ObjectHelper.splitObjectDirect` once with predicted parameters, reason `tls_partial_stack_throw`; writes the shared `tls_partial_stack_execution_v1` envelope to `gameState._tlsPartialStackResult` and `_tlsPartialStackArchive` (schema unchanged — family is carried by `split_result.reason` and `predicted_call`); on success captures `_tlsPartialStackThrowDescriptionTarget`, applies the quantity-one successor rename via the existing `_singularizeDropSuccessorName` (family-agnostic name transformation; reused unchanged), captures the THROW CB receipt (D7), and clears the successor description via `setObjectDescriptionDirect`.
  - `_authorityGateWholeDropObjectId` is **reused** for whole-THROW: its semantic is "object ID whose whole-object Ground transfer this turn must be compensated for at the Authority Gate," and its consumption (4315-4320) is family-blind. Renaming to a family-neutral identifier is deferred as follow-up cleanup (wider diff in a high-risk file for zero behavior).
- **Reason:** these are the exact post-Engine boundaries the DROP migration proved; mirroring preserves ordering (mutation pre-narration/pre-CB) and the once-only helper-call guarantee.
- **Rejected:** new envelope schema for THROW partial (schema proliferation; the shared envelope already distinguishes family); a THROW-specific Authority Gate variable (cosmetic duplication).
- **Re-verification trigger:** any drift in the 2826-3070 region or 4315-4320 before implementation.

### D7 — CB Bug-B containment: clone the DROP receipt chain end-to-end for THROW

- **Decision:** Mirror every link of the DROP partial-split receipt chain with THROW identity:
  1. Request-locals beside 1118-1125: `_tlsPartialStackThrowDescriptionTarget`, `_cbTlsPartialStackThrowReceipt`, `_cbTlsPartialStackThrowReceiptState`.
  2. `_sanitizeCbTlsPartialStackThrowReceipt` mirroring the DROP sanitizer (1127+): schema `cb_tls_partial_stack_throw_v1`, operation type `tls_partial_stack_throw`, current-turn, distinct source/successor IDs, live-state cross-checks, ground-destination container-type set (`grid`/`localspace`/`site`).
  3. `_captureCbTlsPartialStackThrowReceipt(splitResult, predictedCall)` mirroring 1346-1399: single-capture state machine, strict split/prediction cross-validation, sanitizer pass before acceptance.
  4. `runPhaseB` option `tlsPartialStackThrowReceipt` beside the existing two (5792-5798).
  5. ContinuityBrain: second sanitizer mirroring 1184-1219; authoritative receipt block + precedence rules in the extraction prompt at the same insertion position and precedence tier as the DROP block (pattern-based text only — no literal gameplay examples); `partial_throw_successor_description` extraction field mirroring 1326-1352 and returned beside 1517.
  6. index.js post-CB: `partial_throw_successor_description` consumption mirroring 5800-5827; third `_normalizePartialSplitSourceDescription` call beside 5855-5856; deterministic replay-suppression filter mirroring 6731-6766, keyed to the THROW receipt's `source_object_id` + exact source/destination containers, transfer-entries only.
- **Bug A vs Bug B (explicitly distinct):** the chain above contains **Bug B** (replay-as-transfer of the real surviving source). **Bug A** (CB promoting a new duplicate after authoritative placement) is mitigated for THROW by layer-correct placement + the existing generic dedup guard (`ObjectHelper.js:411-435`) — no new suppression code. The residual identity-precision gap in that guard (pre-existing same-named object already occupying the destination container) predates this migration, affects DROP identically, and would require a shared change to validated behavior; it is **exposed as a separate follow-up, out of scope** (Scope Exclusion 9, Open Item O2).
- **Rejected:** generalizing the DROP receipt schema/filter to cover both families (touches validated DROP behavior — unapproved); prompt-only protection (probabilistic; handoff §11 proves insufficiency); suppressing by name matching (violates exact-identity requirement).

### D8 — Bridge and seal: THROW branch mirroring the DROP branch; seal fed into the existing CB zeroing gates

- **Decision:** Add to `ObjectOperationBridge.evaluateOperation` a THROW branch mirroring the DROP branch (51-179): activates only for `semanticOperationFamily === 'throw' && semanticPathSingleAction === true`; corroborates AP refusal (`operation_family === 'throw'`, `routing === 'quarantined'`, `outcome === 'refused_ownership'`); checks instruction/dry-run family `throw`; computes live-execution absence from the current-turn `liveExecutionResult` (whole) and a corroborated-partial-success predicate structurally identical to DROP's (receipt schema, `executed === true`, `split_result.ok === true`, reason `tls_partial_stack_throw`, prediction-scalar equality, arithmetic identity, distinct IDs); when execution is absent, emits the no-execution narration constraint and a `throw_dry_run_seal:true` receipt field. In `index.js`, derive `_throwDryRunSealActive` beside 4827-4828 from the bridge receipt's `throw_dry_run_seal`, and extend the CB mutation-array zeroing gates (6499, 6531-6532) to `(_dropDryRunSealActive || _throwDryRunSealActive)`.
- **Reason:** during observe-only and for every denied/unresolved/failed THROW after activation, narration must not claim success and CB/TSL must not mutate — the exact contract the DROP seal already enforces.
- **Rejected:** reusing the `drop_dry_run_seal` field for THROW (dishonest diagnostics); a turn-global seal for compound queues (excluded, mirrors DROP D5 scope).

### D9 — Issue #37: independent diagnostics-only slice

- **Decision:** In `diagnostics.js` `_buildP3ApTlsComparison`, insert an operation-family guard immediately after the two evidence-presence gates (after line 1338, before the comparison helpers): if the instruction's `operation_family !== 'take'`, return the stable `skipped_not_applicable` shape mirroring the guard at 1577-1601 (reason naming the actual family, scope naming the TAKE-only contract). No other diagnostics change. This slice is sequenced before THROW observe-only validation (it already misreads DROP turns today) but has no code dependency on any THROW slice and must never gate or participate in THROW mutation authority.
- **Rejected:** generalizing P3 into family-specific comparison contracts (broad diagnostics redesign, explicitly excluded by the issue's scope note and the user instruction).

### D10 — `_assembleTlsOrsAlignment`: THROW branch beside the DROP branch

- **Decision:** Extend the alignment status tree (`index.js:4507-4514`) so a THROW instruction with no executed transfer is labeled `not_executed` / `throw_tls_dry_run_no_transfer_expected` (parallel branch, or the existing branch extended to both families with the reason string reflecting the actual family — Coding follows the DROP branch's exact shape; both statuses must remain family-truthful). Also extend the `scope` label at 4634 for THROW turns. Diagnostics-labeling only; no authority.
- **Reason:** without it, observe-only THROW turns are mislabeled `non_object_turn_no_transfer_expected` — misleading during exactly the validation stages that depend on this surface.

## Superseded / Rejected Alternatives (summary ledger)

- Rejected: new THROW subsystem, trajectory/impact-target mechanics, compound-command support, parser prompt changes, generalized multi-family receipt schema, name-based CB suppression, AP execution behind a flag, preserving the AP whole-stack-by-default quantity semantic, renaming `_authorityGateWholeDropObjectId` in this migration, generalizing P3 diagnostics.
- Superseded (from legacy AP behavior, by the frozen contract): bare-noun whole-stack default; silent "some"/"all-without-metadata" whole-stack; hardcoded quantity-1 partial; hardcoded grid destination.

## Semantic Authority

| Layer | THROW responsibility after migration | Explicit non-authority |
|---|---|---|
| SemanticParser / enrichment | action, target, quantity metadata, selection_mode, operation_family | no ORS identity, no mutation |
| Authority Gate | existing low-risk routing (drop/throw fast path unchanged); whole-transfer compensation view | its inventory match is not TLS source identity |
| ActionProcessor | recognize THROW; write the four-field quarantine refusal receipt; nothing else | no resolution, quantity, destination, or mutation; refusal is not an execution gate |
| ObjectOperationResolver (THROW policy) | candidate domain, player-source requirement, current-Ground destination, effective quantity, deterministic duplicate ambiguity | no mutation |
| TLS instruction assembly (P2) | family-agnostic trust gate + routing (unchanged) | no mutation |
| TlsObjectOperationExecutor (P4) | independent revalidation + exact helper-call prediction | never calls ObjectHelper |
| index.js live-execution blocks | consume the P4 prediction; call the approved helper exactly once | no re-resolution of source/quantity/destination |
| ObjectHelper / ORS | sole durable mutation authority (transfer, split, lineage, containment, descriptions via `setObjectDescriptionDirect`) | — |
| ObjectOperationBridge | read-only routing; no-execution narration constraint; seal receipt | no mutation |
| ContinuityBrain | witness/extraction; receipt-informed prompt; optional successor description supply | its transfers/promotes are proposals, never authority; exact replays are suppressed deterministically |
| Narrator | presentation grounded in post-mutation state | not object truth |
| Mother Brain / diagnostics | verification evidence (P3 guard, alignment labels, witness store) | never mutation authority; never a THROW execution gate |

## Current Behavior

1. THROW executes inside AP with deterministic name matching, hardcoded grid destination (wrong layer at L1/L2), hardcoded quantity 1 for partial splits regardless of the requested amount, whole-stack transfer for bare-noun stacks, and an audit trail that misreports the requested quantity (Observed 1-3, research Diagnostics note).
2. TLS has no THROW footprint; the executor rejects a THROW instruction outright (Observed 11, 26).
3. CB duplicate exposure: AP's wrong-layer placement defeats the exact-container dedup guard (Bug A observed); no THROW receipt chain exists (Bug B unprotected once AP stops stamping `_apExecutedTransfers`).
4. Diagnostics: P3 comparison misreads non-TAKE turns (issue #37, live for DROP today); alignment mislabels would apply to THROW turns.

## Intended Behavior

1. Single-action THROW resolves through `resolvePlayerHeldThrow` → P2 → P4 → post-Engine live execution: whole transfer or partial split via ObjectHelper, exactly once, to the layer-correct current Ground, per the frozen quantity contract.
2. AP recognizes THROW and refuses ownership with the four-field receipt; it never mutates.
3. Denied/unresolved/ambiguous/over-stack/vague THROW turns fail closed with zero mutation, sealed CB mutation arrays, and truthful no-success narration.
4. Partial THROW produces exactly one TLS-originated successor with correct lineage; the surviving source stays player-held at the reduced quantity; CB cannot replay the surviving source (deterministic receipt-keyed suppression) and CB-originated promotes of the placed object are absorbed by the existing dedup guard (`object_reality.promoted === 0`).
5. Descriptions: successor description cleared at split, optionally refilled by validated CB output, source leading-count normalization applied — mirroring DROP.
6. Diagnostics label THROW turns truthfully (alignment branch; P3 guard fails closed for all non-TAKE families).

## Unchanged Behavior

1. TAKE: resolver, policies, quantity derivation, live execution, receipts, prompt blocks, suppression filters, fast paths — byte-untouched surfaces; behavior identical.
2. DROP: everything listed in Observed 9-22 remains byte-untouched except the shared gates explicitly extended (`6499`/`6531-6532` seal OR-condition, executor family points, alignment tree) — and at those points DROP-family inputs must produce identical outputs to today.
3. SemanticParser.js, authoritygate.js, ObjectHelper.js, Engine.js: no edits anywhere in this migration.
4. THROW semantics outside the migration scope: existing interpretation and narration of trailing target phrasing ("at [target]") preserved unchanged — no structured impact-target subsystem added, and no suppression of the currently working impact narration; smash/throw parser boundary (`SemanticParser.js:81/83`) unchanged; compound-queue THROW remains outside TLS (becomes a recognized no-op after quarantine, exactly like compound DROP today — pre-existing limitation, preserved not extended, with full-turn inertness proven by V27 rather than assumed).
5. Unrelated CB operations: transfers/promotes/condition updates/retirements not matching the exact THROW receipt or seal conditions remain eligible; non-object CB continuity output untouched.
6. Legacy fallback parser: no THROW TLS enrichment (mirrors DROP exclusion).
7. Persistence: no schema changes; the existing request-local receipt lifecycle (active slot reset/archive/delete) already covers the shared `_tlsPartialStackResult` slot for any family.

## Invariants

1. ObjectHelper/ORS is the only durable mutation authority for THROW; resolver, P2, P4, bridge, CB, narrator, and diagnostics never mutate.
2. AP's post-quarantine THROW behavior is exactly: write the four-field refusal receipt, return. It has no branch that decides whether execution happens (corrected invariant, research Addendum 1).
3. One allowed P4 prediction causes at most one helper call; denied predictions cause zero.
4. Live execution consumes the dry-run's exact predicted parameters; re-resolving source, quantity, or destination in the live block is forbidden.
5. Whole THROW moves the original object ID (no recreation); partial THROW leaves the source ID player-held at `before - applied` and creates exactly one successor with `parent_object_id` lineage at the predicted Ground.
6. Exactly-one-successor vs zero-CB-duplicates are two separate assertions: `object_reality.promoted === 0` (zero CB-originated objects) AND one TLS-originated successor verified via `_tlsPartialStackResult.split_result.successor_object_id` (research Addendum item 3).
7. The THROW receipt chain suppresses only quarantine `transfer` entries matching the receipt's `source_object_id` + exact source/destination containers; unrelated transfers remain eligible; the promote path is untouched by the filter.
8. Frozen quantity contract (D2 table) — every unsupported class fails closed with no helper prediction and no mutation.
9. `resolveCurrentGround` is the single Ground formula; no second derivation anywhere in the THROW path.
10. Single-action boundary: no THROW TLS lane activation, seal activation, or mutation for compound queues.
11. TAKE and DROP contracts unchanged (Unchanged Behavior 1-2); the shared-gate edits are output-identical for non-THROW families.
12. No literal gameplay object/NPC/location examples in any production prompt text added by this migration.
13. Diagnostics truthfulness: dry-run proposals are never reported as executed; suppressed CB output is counted and archived, not silently destroyed; P3/alignment surfaces never gate execution.
14. No package version, changelog, docs, tests, git state, or branch changes as part of any slice unless the user separately authorizes them per established repo practice at implementation time.

## Scope Exclusions

1. Compound-command THROW resolution or any turn-wide seal for compound queues.
2. Impact-target ("throw X at Y") semantics, trajectories, damage, or any new THROW subsystem.
3. Parser/enrichment changes of any kind (SemanticParser.js is read-only), including the `selection_mode` backstop and "some"/"a few" numeric semantics.
4. PUT, GIVE, PLACE, or any other verb family.
5. ObjectHelper.js changes, including the dedup guard.
6. Authority Gate logic changes (the fast path already covers THROW; the compensation clone is consumed, not modified).
7. Broad CB prompt restructuring beyond the mirrored THROW receipt block/precedence/description field.
8. Broad diagnostics redesign; Mother Brain tool additions; UI surfaces (`Map.html`/`Index.html`).
9. Identity-precise Bug-A dedup (pre-existing shared gap; separate follow-up — Open Item O2).
10. Renaming `_authorityGateWholeDropObjectId` or other family-named shared identifiers (follow-up cleanup).
11. Legacy fallback-parser THROW enrichment.
12. Save/persistence redesign.
13. Unrelated dirty-tree files (`.gitignore`, `tests/.last-harness-result.json`).

## Blast Radius

**Classification: cross-subsystem behavior change / staged architecture migration** (same class as the DROP migration it mirrors).

Files with source edits, by slice (no other files may change):

| Slice | Files | Character |
|---|---|---|
| T1 (quarantine) | `ActionProcessor.js` | insert refusal stub above unreachable legacy code |
| T2 (observe-only) | `ObjectOperationResolver.js`, `TlsObjectOperationExecutor.js`, `ObjectOperationBridge.js`, `index.js` | additive policy/wrapper/family-branches; resolver call branch; alignment branch; seal derivation + zeroing-gate extension |
| T3 (whole live) | `index.js` | one live-execution block |
| T4 (partial live + CB) | `index.js`, `ContinuityBrain.js` | live block + receipt chain + description handling + suppression filter |
| T6 (legacy removal) | `ActionProcessor.js` | delete unreachable 669-758 region |
| D1 (issue #37) | `diagnostics.js` | one fail-closed guard |

`index.js`, `ActionProcessor.js`, and `ContinuityBrain.js` are high-risk files: surgical additive edits only, mirroring existing adjacent patterns. Justification for the cross-subsystem classification: authority migration inherently crosses parser-consumer, executor, mutation-boundary, narration-constraint, and extraction-containment layers; the DROP precedent proved this exact seam set is sufficient and stable.

## Minimal Safe Plan (per-change contracts)

Changes are grouped by slice. Every change is additive unless stated. Exact anchors were verified this pass; Coding must re-read each region before editing (drift = stop).

### Slice T1 — AP quarantine (Stages 3-5)

**Change T1.1 — `ActionProcessor.js:667`** — insert the four-field THROW refusal stub (D4) as the first statements of the `throw` branch; early return. Legacy 669-758 untouched. ~6 lines. Verification: V1, V2, V19. Stop if the branch shape at 667 or the DROP stub at 600-608 has drifted.

### Slice T2 — TLS observe-only (Stages 6-7) + D1 diagnostics slice

**Change T2.1 — `ObjectOperationResolver.js`** — `THROW_RESOLVER_KIND` beside 34-35; `_throwPolicy` beside 204-214 (D1); `_deriveThrowEffectiveQuantity` beside 437-464 (D2); `throw` family branch in `_validateModelResponse` after 755-776; `resolvePlayerHeldThrow` beside 1099-1101; export at 1103. ~60-75 lines. Verification: V3-V9. Stop if `_resolveWithPolicy`'s policy contract has changed.

**Change T2.2 — `TlsObjectOperationExecutor.js`** — the five family-point extensions (D5): lines 72, 191, 199, 279 (+ scope label if family literals appear in envelope assembly — re-grep required). ~8-12 changed lines. Verification: V3-V10. Stop if re-grep finds family comparisons beyond the verified five.

**Change T2.3 — `index.js` resolver branch** — `else if` THROW branch after 2826-2836 (D6). ~10 lines. Verification: V3, V20.

**Change T2.4 — `ObjectOperationBridge.js`** — THROW branch mirroring the DROP branch (D8), including the corroborated-partial predicate (false during T2 by construction) and `throw_dry_run_seal` receipt field. ~60-90 lines. Verification: V11, V12.

**Change T2.5 — `index.js` seal + alignment** — `_throwDryRunSealActive` beside 4827-4828; OR-extension at 6499 and 6531-6532; alignment THROW branch at 4507-4514 area + scope label at 4634 (D10). ~10-15 lines. Verification: V11, V12, V21. Stop if the zeroing gates have moved or changed shape.

**Change D1.1 — `diagnostics.js`** — family guard in `_buildP3ApTlsComparison` after line 1338 (D9). ~15-20 lines. Verification: V22. Independent slice; may land before T2.

### Slice T3 — whole-object live (Stages 8-9)

**Change T3.1 — `index.js`** — live whole-THROW block mirroring 2880-2926 (D6), reason `tls_whole_object_throw`, `_authorityGateWholeDropObjectId` reuse, `_tlsExecutionResult` write. Placed as a sibling `else if` alongside the DROP blocks (mutually exclusive by family gates). ~45 lines. Verification: V13, V14, V21. Stop if `_tlsExecutionResult` writer contract or the AG clone at 4315-4320 has drifted.

### Slice T4 — partial live + CB/description protections (Stages 10-11; one deployment unit)

**Change T4.1 — `index.js`** — live partial-THROW block mirroring 2927-2993 (D6): split call, shared envelope + archive, description target, successor rename, receipt capture, successor description clear. ~65 lines. Verification: V15-V18.

**Change T4.2 — `index.js`** — request-locals beside 1118-1125; `_sanitizeCbTlsPartialStackThrowReceipt` beside the DROP sanitizer; `_captureCbTlsPartialStackThrowReceipt` beside 1346-1399 (D7 items 1-3). ~90 lines. Verification: V16, V17.

**Change T4.3 — `index.js`** — `tlsPartialStackThrowReceipt` option at 5792-5798; `partial_throw_successor_description` consumption mirroring 5800-5827; third normalization call beside 5855-5856; replay-suppression filter mirroring 6731-6766 (D7 items 4, 6). ~60 lines. Verification: V16-V18.

**Change T4.4 — `ContinuityBrain.js`** — THROW receipt sanitizer mirroring 1184-1219; prompt receipt block + precedence rules at the DROP block's insertion tier (pattern-based text only); `partial_throw_successor_description` extraction mirroring 1326-1352, returned beside 1517 (D7 item 5). ~80-110 lines. Verification: V16-V18. Stop if the extraction prompt's insertion anchors have moved.

### Slice T6 — legacy removal (Stage 13)

**Change T6.1 — `ActionProcessor.js`** — delete the unreachable legacy THROW mechanics (669-758) leaving the stub; update or remove the stale comment at 668. Only after Stage 12 parity sign-off. Verification: V1, V19 rerun.

## Implementation Steps (ordered, gated)

1. **Gate A (every slice):** re-verify branch/HEAD, target-region content, and this plan's status is APPROVED with an explicit user implementation instruction. Stop on drift.
2. T1.1 → `node --check ActionProcessor.js` → runtime Stage-4 controlled no-op validation (roadmap Stage 4 gate).
3. D1.1 (may run before or in parallel with step 2 as its own commit) → `node --check diagnostics.js` → V22.
4. T2.1 → T2.2 → T2.3 → T2.4 → T2.5 → syntax checks on all four files → Stage-7 observe-only validation matrix (V3-V12, V20, V21) with zero-mutation proof.
5. T3.1 → syntax check → Stage-9 whole-object validation (V13, V14, V21, regressions V23, V24).
6. T4.1 → T4.2 → T4.3 → T4.4 as one reviewed unit → syntax checks (`index.js`, `ContinuityBrain.js`) → Stage-12 full matrix.
7. T6.1 only after Stage-12 sign-off → syntax check → V1/V19 rerun.
8. After every slice: diff review confirming only that slice's files changed.

## Verification Matrix

Validation types: SRC = source/diff review; SYN = `node --check`; RT = runtime/manual via deployed build or local run; MB = Mother Brain/witness/diagnostics surfaces; HARN = test-harness where a scenario exists. No throw baseline exists in `tests/` (Observed 26) — RT/MB rows are primary until a harness scenario is separately authorized.

| ID | Contract under test | Trigger | Evidence surface | Pass | Fail | Class / type |
|---|---|---|---|---|---|---|
| V1 | AP quarantine receipt | any semantic THROW reaching AP | `_apActuals` in witness | exact four fields `throw/quarantined/null/refused_ownership`; no AP helper call | missing/changed fields or any AP mutation | intended / MB+SRC |
| V2 | Controlled no-op (engine lane) | THROW of a held object during T1 (pre-TLS) | ORS snapshot before/after; ObjectHelper audit | identical player/ground membership, quantities, object count; empty THROW audit | any engine-lane mutation | intended / RT+MB |
| V3 | Resolver evidence for supported classes | article, explicit-partial, explicit-exact-stack, all-with-metadata THROW | `resolver_evidence_v1` in witness | family `throw`; correct source ID; effective quantity per D2 table with `throw_*`/`parser_explicit` basis | wrong family/qty/basis or DROP-named basis strings | intended / MB |
| V4 | Default-one on bare-noun stack | unspecified-quantity THROW of stack > 1 | evidence + dry-run | effective 1, `throw_default_one`, outcome `partial_split` | whole-stack routing | intended change / MB |
| V5 | Fail-closed: vague | "some"-class THROW | evidence `fail_closed_reason` | `unsupported_quantity_mode`; no prediction; no mutation | any prediction/mutation or invented number | negative / MB+RT |
| V6 | Fail-closed: zero/negative/fractional/malformed | exact-mode THROW with non-positive/non-integer quantity | evidence | `invalid_quantity`; no prediction; no mutation | any prediction/mutation | negative / MB |
| V7 | Fail-closed: contradictory all | all-mode without `all_from_stack` or with numeric request | evidence | `contradictory_quantity_metadata`; no mutation. **Escalation:** if normal entire-stack phrasing consistently lands here at runtime, the outcome is NEEDS USER DECISION (Stop Condition 10a), not a completed contract | silent whole transfer | negative / MB+RT (Uncertainty 1) |
| V8 | Over-stack denial | explicit quantity > available | dry-run | `fail_closed` `over_stack`; no helper call; sealed narration | prediction or mutation | negative / MB+RT |
| V9 | Duplicate-signature ambiguity | two player-held candidates with identical identity signatures | evidence | deterministic ambiguous override; null source; no prediction | model/first-match selection accepted | authority / MB (fixture per DROP precedent: direct/white-box; do not alter architecture to manufacture it) |
| V10 | Invalid destination fail-closed | Ground unresolvable for current layer | dry-run `fail_closed_reason` | exact `resolveCurrentGround` reason; no prediction | grid/player fallback | negative / MB |
| V11 | Observe-only zero mutation full-turn | supported single-action THROW during T2 | ORS before/after; ObjectHelper audit; seal receipt; suppressed counts | zero mutation anywhere incl. CB lane; `throw_dry_run_seal` active; narration claims no success | any mutation or success narration | intended / RT+MB |
| V12 | Seal scope | compound queue containing THROW; unrelated non-object turn | bridge receipt; CB arrays | no THROW TLS lane, no seal activation for compound; unrelated turns unaffected | seal fires on compound or suppresses unrelated ops | scope / RT+MB |
| V13 | Whole-object live | exact-stack or all THROW after T3 | ORS; `_tlsExecutionResult`; ObjectHelper audit | original ID moved player→correct Ground layer exactly once; membership updated both sides; audit reason `tls_whole_object_throw` | recreation, wrong layer, double call | intended / RT+MB |
| V14 | Authority Gate compensation | whole THROW turn | AG inputs/decision | AG sees compensated inventory view; no AG error from post-transfer state | AG inspects post-transfer inventory uncompensated | intended / MB |
| V15 | Partial live split | explicit n < stack after T4 | ORS; `_tlsPartialStackResult` | source ID persists player-held at before−n; exactly one successor, quantity n, lineage `parent_object_id` = source, at predicted Ground | wrong quantities/lineage/container; source moved | intended / RT+MB |
| V16 | Bug-B replay suppression | partial THROW where CB emits a transfer of the surviving source ID player→Ground | quarantine before/after; `suppressed_replays` | exact-match entry suppressed with THROW receipt reason; source remains player-held | surviving source moved post-split | authority / RT+MB |
| V17 | Two-assertion duplicate check | partial and whole THROW turns | `object_reality.promoted`; `_tlsPartialStackResult.split_result.successor_object_id`; ORS count | `promoted === 0` AND (partial: exactly one TLS successor; whole: zero new objects) | any CB-originated promote of the thrown object; extra successors | authority / MB+HARN (`no_new_objects` = promoted-counter assertion, per research Addendum item 3) |
| V18 | Descriptions | partial THROW of a stack with leading-count description | source + successor `description` fields | successor cleared at split (then only validated CB text may fill it); source leading count stripped when normalizer conditions hold | successor inherits stale parent description unmodified; source description corrupted when conditions don't hold | intended / RT+MB |
| V19 | Unrelated CB preservation | THROW turn where CB also emits unrelated valid transfers/promotes | quarantine; ORS | unrelated entries execute normally | unrelated ops suppressed | unchanged / RT+MB |
| V20 | Single-action boundary | compound queue with THROW + other action | resolver-call evidence; queue metadata | THROW resolver not invoked; other action unaffected | resolver/seal/mutation for compound THROW | scope / MB |
| V21 | Alignment + witness labeling | observe-only and live THROW turns | `tls_ors_alignment`; witness family surfaces | observe-only: `not_executed`/THROW-truthful reason; live: family-truthful labels | `non_object_turn` mislabel or DROP-labeled THROW | diagnostics / MB |
| V22 | Issue #37 guard | archived DROP turn and (once available) THROW turn through P3 endpoint; TAKE baseline turn | `get_p3_comparison` output | non-TAKE families → stable `skipped_not_applicable` naming the family; TAKE output byte-equivalent to pre-change | fabricated mismatch for non-TAKE or any TAKE delta | regression+intended / MB+diagnostics |
| V23 | TAKE regression | partial-stack TAKE and over-stack TAKE baselines after each slice | TAKE receipts, ORS, audit | identical to pre-slice baseline | any delta | regression / RT+MB |
| V24 | DROP regression | whole, partial, all, over-stack, ambiguous DROP after each slice | DROP receipts, seal, ORS, audit | identical to pre-slice baseline incl. seal behavior on shared gates | any delta | regression / RT+MB |
| V25 | Persistence | save/reload after whole and partial THROW | reloaded ORS; top-level state | moved objects/lineage survive reload; no top-level active `_tlsPartialStackResult` persisted (existing lifecycle) | lost/duplicated objects; leaked active receipt | intended / RT |
| V26 | Syntax + diff scope | after every slice | `node --check` each edited file; `git diff --name-only` | checks pass; only the slice's files changed | any failure or out-of-scope file | scope / SYN+SRC |
| V27 | Compound-turn full-turn inertness | compound queue containing THROW + another action, run after T1 (quarantine) and again after T2 (seal landed) | thrown object's ORS record before/after (container, quantity, status); quarantine contents; narration | thrown object unchanged end-to-end; no CB-derived mutation of it executes; the other queued action unaffected | any mutation of the thrown object during a compound turn | authority-boundary / RT+MB — V20 proves the resolver was not invoked; this row proves the *outcome* is inert, which V20 alone does not establish |

## Stop Conditions (hard abort gates for Coding)

1. Branch/HEAD or any verified anchor region differs materially from this plan → NEEDS SOURCE RE-VERIFICATION.
2. Executor re-grep finds family comparisons beyond the five verified points, or the resolver policy contract has changed → stop; re-plan the executor change.
3. Any THROW change requires editing `SemanticParser.js`, `authoritygate.js`, `ObjectHelper.js`, `Engine.js`, or validated TAKE/DROP logic beyond the enumerated shared gates → stop; unapproved contract change.
4. The live blocks cannot consume dry-run predictions without re-resolving source/quantity/destination → stop; authority violation.
5. The CB prompt receipt block cannot be inserted at the DROP block's tier without restructuring the prompt → stop; broad CB redesign is excluded.
6. The replay-suppression predicate cannot reject failed/foreign-family/contradictory receipts using existing fields → stop.
7. Any slice's validation shows TAKE or DROP regression (V23/V24 fail) → stop, report, do not proceed to the next stage.
8. Any observe-only stage shows THROW-caused mutation (V11 fail) → stop immediately.
9. Issue #37 guard cannot be added without changing TAKE output (V22 TAKE half fails) → stop.
10. A required user decision emerges (any input class whose behavior the D2 table does not determine) → NEEDS USER DECISION; do not improvise semantics.
10a. Runtime observation shows normal entire-stack THROW phrasing consistently failing closed for missing parser metadata (V7 escalation) → NEEDS USER DECISION; do not declare the entire-stack contract item complete.
10b. V27 shows any mutation of the thrown object during a compound-queue turn → stop for a bounded containment decision; "resolver not invoked" (V20) is not sufficient proof of inertness.
11. Implementation would require >1 slice's files in one change, or the plan and roadmap disagree → stop; reconcile documents first.
12. User approval absent: this plan is READY FOR REVIEW; no slice may be implemented until the user approves and explicitly instructs implementation.

## Coding Handoff

- Implement strictly slice-by-slice in roadmap order; one slice per review cycle; Gate A before every slice.
- May change only the files listed for the active slice (Blast Radius table). Everything else is read-only.
- All architecture, authority, scope, quantity semantics, receipt schemas, seal shape, and validation criteria are decided here — Coding decides none of them.
- Re-read every anchor region immediately before editing; mirror the adjacent DROP pattern's structure, naming style, and comment density; small additive patches; no rewrites of surrounding code.
- Run `node --check` on every edited JS file and report observed results truthfully; never claim runtime validation that was not run.
- Preserve the unrelated dirty-tree entries untouched.
- Stop at the first triggered stop condition and report the exact source evidence.

## QA / Mother Brain Handoff

- Establish pre-turn snapshots (player membership, Ground membership, ORS key count, source record, ObjectHelper audit) for every RT row; judge from state and receipts, never narrator prose.
- Stage gates: V1-V2 close T1; V3-V12+V20-V21+V23-V24+V27 close T2; V13-V14+V21+V23-V24 close T3; V15-V19+V23-V25 close T4; the full matrix (V1-V27) closes Stage 12; V22 closes slice D1.
- Run TAKE/DROP regression baselines after THROW checks as well as before (shared-gate drift detection).
- The two-assertion duplicate check (V17) must never be collapsed into one assertion.
- Report each row PASS/FAIL with its evidence surface; a failed row is never "partial success."
- Runtime-only rows (V2, V5, V7, V8, V11-V19, V23-V25, V27) require a deployed or locally run build; source review cannot close them.

## Open Questions / Blockers

- **O1 (user decision, non-blocking for review):** none outstanding — the frozen contract resolves all quantity/destination/scope semantics. The intentional behavior changes in the D2 table are surfaced for explicit user sign-off at plan review.
- **O2 (exposed follow-up, out of scope):** identity-precise Bug-A dedup (pre-existing same-named object already in the destination container defeats exact identity attribution in the generic guard). Shared TAKE/DROP/THROW surface; requires its own research/plan cycle.
- **O3 (follow-up):** family-neutral rename of `_authorityGateWholeDropObjectId` and any THROW-adjacent naming cleanup.
- **O4 (resolved at Stage 7):** parser "all"/"selection_mode" runtime behavior for THROW phrasing (Uncertainties 1-2) — confirmed fail-closed as anticipated. Superseded by O6 below, which names the exact mechanism.
- **O5 (accepted limitation, deferred to a future project, not a plan gap):** vivid, physically-loaded THROW phrasing ("hurl it as far as I can") can still produce false-success narration during observe-only/denied turns, even though ORS remains correct and the deterministic bridge seal prevents any actual mutation. Root cause proven from a captured live narrator prompt: `_doIntentBlock`'s "VALIDATED ACTION is the only mechanical reality" framing, combined with unrestricted permission to use the player's raw phrasing, creates a genuine contradiction against the bridge's later no-execution instruction. A bridge-aware wording fix resolved 5 of 6 tested narration classes (plain THROW, DROP denial, TAKE denial, successful DROP, successful TAKE); a second, more aggressive fix constraining the word "freely" itself was tested three times on the vivid case, produced no compliance improvement, visibly flattened prose, and was reverted. The user has scoped a future, separate project — after this migration completes — to exclude mechanical object-operation verbs (TAKE/DROP/THROW/REMOVE and similar) from broad FREEFORM narrator treatment entirely, narrating them from authoritative state and execution receipts only. This migration does not attempt that redesign; the residual vivid-THROW narration gap is accepted, not silently hidden, and is not a Stage 7 blocker on its own since the authority-critical invariant (zero mutation) holds regardless.
- **O6 (accepted limitation, cross-family, tracked as issue #40, not a plan gap):** THROW's "all" quantity contract is currently unreachable via natural language. `quantity_mode:'all'` is correctly captured with clean verb-first phrasing, but the resolver's "all" branch requires `selection_mode === 'all_from_stack'`, which no parser instruction for TAKE/DROP/THROW ever emits. Confirmed cross-family at Stage 7 by reproducing the identical failure on DROP ("drop all pebbles" fails closed with zero mutation, same as THROW). Pre-existing — flagged as a "dormant, unexercised" gap in the original research before planning began, not introduced by this migration. Deferred to whichever future work addresses `SemanticParser.js` (out of scope here; that file is read-only for this plan).
- **O7 (accepted limitation, state-mutation class, not merely narration — deferred to the future mechanical-verbs project, not a plan gap):** compound-queue THROW full inertness fails. For a compound queue containing THROW, the single-action seal correctly never activates (by design — compound support is explicitly out of scope), and the original held object is correctly never mutated — but with no seal active, nothing suppresses Continuity Brain's own narrative-driven object promotion, and CB can independently create a **real, new, authoritative ORS object** (confirmed live: `source: "continuity_brain"`, a duplicate object promoted to the grid from CB's own reading of narration describing an unauthorized throw). This is distinct in kind from O5 — O5 is the narrator describing a false outcome with no effect on state; O7 is a second object actually entering durable state through a door the seal was never built to cover. Accepted and deferred by explicit user decision. The future mechanical-verbs/anti-FREEFORM project must include CB containment for this case specifically when it lands, not just narrator-prompt cleanup — noted here so that scope requirement isn't lost by the time that project starts.
- **Approval blocker:** implementation unauthorized until user approval of this plan and the companion roadmap.

## Revision History

- **2026-07-22 — Revision 5 (Stage 7 checkpoint: authority validation passed with explicitly accepted exceptions).** Status updated: Stage 7 complete, three rows resolved by explicit user decision rather than silent pass (O6 "all"/issue #40, cross-family; O7 compound-queue CB state-mutation limitation, distinct in kind from O5's narration-only gap; V6 source-validated only). O4 resolved and superseded by O6. TAKE/DROP regression language corrected to "no new regression attributable to this migration," since issue #38 (pre-existing, unrelated) remains open independently. Confirmed Slice D1 has not landed before writing this entry, so Stage 7 diagnostics evidence is not implied to fix issue #37. See companion roadmap Revision 5 for full per-row evidence. No architectural or contract change.
- **2026-07-21 — Revision 4 (Stage 6 implementation + narration investigation reconciled).** Status updated: Stage 6 implementation complete and live-verified; narration truthfulness partially corrected (5/6 classes) with the vivid-THROW residual explicitly accepted and deferred (O5, new). Stage 7 explicitly noted as not started. See companion roadmap Revision 4 for the full evidence: two plan-vs-source gaps found during implementation (resolver strict-quantity gate, 17-site seal mechanism), the narration root-cause proof, the retained fix, and the reverted second fix attempt. No architectural or contract change.
- **2026-07-21 — Revision 3 (Slice T1 closure).** Status updated to reflect Stages 3-5 (Slice T1, AP quarantine) complete and validated — see companion roadmap Revision 3 for the full per-stage evidence (attribution-based engine-lane invariance proof across whole/partial/unsupported input classes, using fresh isolated sessions rather than final-state judgment). No architectural or contract change.
- **2026-07-21 — Revision 2 (status sync; approval + Stage 1-2 closure).** Status changed READY FOR REVIEW → APPROVED per explicit user conversational approval. Approval line updated to record how/when authorization was given. No architectural or contract change. See the companion roadmap's Revision 2 for the live Stage 2 baseline evidence (partial-quantity defect, whole-object control, wrong-layer defect) recorded against real object IDs.
- **2026-07-21 — Revision 1 (post-review; GPT forensic audit + user runtime clarification).** Four focused corrections, no architectural change, status remains READY FOR REVIEW: (1) impact-target claims narrowed per user runtime evidence — the engine already interprets and narrates trailing target phrasing (the observed defect was wrong-layer authoritative placement, not target comprehension); plan now states that behavior is preserved unchanged and Coding must not suppress it (frozen contract 6, Observed 8, Unchanged 4). (2) Stage-4 no-op claim narrowed to engine-lane invariance in the companion roadmap; full-turn inertness is proven at Stage 7. (3) Added V27 (compound-turn full-turn inertness) + Stop Condition 10b — compound THROW turns must be proven inert, not assumed inert from resolver non-invocation. (4) V7/Uncertainty-1 escalation + Stop Condition 10a — consistent runtime failure of normal entire-stack phrasing becomes NEEDS USER DECISION rather than an automatic pass.
- **2026-07-21 — Initial READY FOR REVIEW.** Created from research-notes(226) (same-day research, fully re-verified against `main` @ `41dff60` in a bounded planning pass), the four DROP precedent documents, and live issue #37. Root `plan.md` intentionally not used per explicit user override for this task. Key decisions: mirror DROP end-to-end (policy/executor/live-blocks/bridge/seal/receipt-chain/descriptions); clone quantity derivation with throw-named basis strings; reuse Ground resolver, candidate enumerator, AG compensation variable, and successor-rename helper unchanged; treat Bug A (promote duplicate) and Bug B (surviving-source replay) as distinct with distinct protections; issue #37 as an independent diagnostics slice; partial-live + CB protections bound into one deployment unit. Precedent-document revision discrepancy (v1.91.84 file supplied where task named reconciled v1.91.88) recorded as non-blocking.
