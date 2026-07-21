# THROW → TLS MIGRATION ROADMAP

- **Status:** READY FOR REVIEW — no stage is complete; no stage may be marked complete merely because it is planned.
- **Derived from:** `THROW_TLS_MIGRATION_IMPLEMENTATION_PLAN.md` (the detailed planning contract; this roadmap is the staged sequence view of that contract and must not diverge from it).
- **Source state at planning:** `main` @ `41dff601d5c56516eee8a9e6a5281b7530b43724` (v1.92.8).
- **Approval:** NOT approved. Only the user may approve. Each stage additionally requires the plan's Gate A (source re-verification + explicit implementation instruction) before its slice is coded.
- **Precedent:** the completed DROP → TLS migration (12-step staged sequence, quarantine-first / inert-first / one-authority-layer-at-a-time). The supplied precedent file is the v1.91.84-checkpoint revision of that roadmap; its endpoint is corroborated by current source, where DROP is fully live through TLS.

## FINAL CONTRACT

AP recognizes THROW but has no object-operation authority. TLS owns THROW resolution and execution policy. ObjectHelper performs the authoritative mutation. ORS remains authoritative state. THROW moves a player-held ORS object — one unit by default, an explicitly requested quantity, or the entire stack — to the authoritative current Ground (active localspace → active site tile → current L0 grid cell). Over-stack, vague, malformed, contradictory, zero, negative, fractional, or otherwise unsupported quantity requests fail closed without mutation. Single-action turns only; compound queues do not enter the THROW TLS lane. THROW has no impact-target mechanics (parser-proven current design, preserved).

## MIGRATION METHOD

First make THROW inert. Then restore capability one authority layer at a time. Every live-mutation checkpoint begins from a previously proven no-mutation state so the cause of the first successful movement is identifiable. Any departure from the DROP sequence below is explicitly justified in the stage's notes; there are two: (a) the diagnostics slice (issue #37) is scheduled early because the unguarded P3 comparison already misreads DROP turns today and would misread THROW validation evidence; (b) Stages 10 and 11 must deploy as one unit because the DROP incident history (2026-07-14 CB replay handoff) proves that partial-split live execution without extraction-layer containment invites surviving-source replay.

## STAGE SEQUENCE

### Stage 1 — Freeze the authoritative THROW contract and scope

- **Objective:** fix the mechanical contract (source, quantity classes, Ground destination, fail-closed set, single-action boundary, no impact-target) and the reuse-not-reinvent architecture decision.
- **Authority transition:** none (documentation of intent).
- **Dependencies:** research-notes(226) with closure addenda; DROP precedent documents; current-source verification.
- **Validation gate:** user review of the implementation plan's frozen contract and D2 behavior-change table (three intentional divergences from legacy AP THROW are surfaced there for sign-off).
- **Exit condition:** implementation plan + this roadmap APPROVED by the user.
- **Stop/rollback boundary:** any contract ambiguity the D2 table does not determine → NEEDS USER DECISION before any code.
- **Status:** planned (this document); awaiting review.

### Stage 2 — Establish baseline source and runtime evidence

- **Objective:** record pre-migration THROW behavior as the comparison baseline: AP handler behavior (wrong-layer destination, hardcoded quantity 1, whole-stack default), `_apExecutedTransfers` stamping, audit `requested_quantity` misreporting, and one observed whole + one observed partial THROW turn's witness output.
- **Authority transition:** none (read-only).
- **Dependencies:** Stage 1 approval; a runnable deployment (runtime rows cannot be closed from source alone — work-environment constraint noted in the plan).
- **Validation gate:** baseline evidence archived (witness/Mother Brain captures) sufficient for later parity comparison; source anchors re-verified.
- **Exit condition:** baseline recorded; no source drift from the plan's anchors.
- **Stop/rollback boundary:** material anchor drift → NEEDS SOURCE RE-VERIFICATION of the plan before proceeding.

### Slice D1 (independent) — Issue #37 diagnostics guard

- **Objective:** add the operation-family guard to `_buildP3ApTlsComparison` (diagnostics.js) so non-TAKE turns fail closed as `skipped_not_applicable`, mirroring the existing `_buildPartialStackComparison` guard. Diagnostics-only; never part of THROW mutation authority.
- **Authority transition:** none (diagnostics truthfulness only).
- **Dependencies:** none on any THROW stage; may land any time, recommended before Stage 7 so observe-only THROW validation evidence is not contaminated by fabricated P3 mismatches. Already justified independently: the gap misreads DROP turns today.
- **Validation gate:** plan row V22 — non-TAKE families return the stable skipped shape naming the family; TAKE output byte-equivalent to pre-change.
- **Exit condition:** V22 PASS; issue #37 closable.
- **Stop/rollback boundary:** any TAKE output delta → revert the guard; single-file rollback.

### Stage 3 — Quarantine ActionProcessor THROW ownership

- **Objective:** insert the four-field refusal stub (`operation_family:'throw'`, `routing:'quarantined'`, `helper_method:null`, `outcome:'refused_ownership'`) at the top of AP's THROW branch; legacy mechanics become unreachable and remain untouched.
- **Authority transition:** AP loses THROW execution; no layer gains it yet — THROW becomes a recognized no-op.
- **Dependencies:** Stage 2 baseline.
- **Validation gate:** plan rows V1 (receipt exact), V26 (syntax/diff scope).
- **Exit condition:** stub live; AP performs zero THROW mutation.
- **Stop/rollback boundary:** revert = remove the stub (legacy code is intact beneath it, restoring prior behavior exactly). Stop if the AP branch shape has drifted from the plan's anchor.

### Stage 4 — Prove the controlled no-op

- **Objective:** demonstrate exact ORS invariance for THROW attempts across whole, partial, and unsupported input classes.
- **Authority transition:** none (proof stage).
- **Dependencies:** Stage 3.
- **Validation gate:** plan row V2 — identical membership, quantities, object count; empty THROW audit. **Known transitional exposure (mirrors DROP's equivalent phase):** the engine lane is proven inert, but no narration seal exists yet, so narration may still describe success and CB may act on that narration. The no-op proof is scoped to the engine lane; full-turn zero mutation is guaranteed only from Stage 6's seal onward. This exposure is dev-only and is the reason Stages 3-6 should be traversed promptly.
- **Exit condition:** V2 PASS on the engine lane; any observed CB-lane mutation documented and carried as Stage-6 motivation, not treated as a Stage-4 failure of the stub.
- **Stop/rollback boundary:** any engine-lane mutation → stop immediately; the quarantine is defective.

### Stage 5 — Preserve the narrow AP recognition/refusal receipt

- **Objective:** confirm the four-field receipt is the permanent AP THROW surface: recognition + refusal evidence only, distinguishing intentional quarantine from parser/routing failure.
- **Authority transition:** none (the stub from Stage 3 is the mechanism; this stage locks its contract).
- **Dependencies:** Stage 4.
- **Validation gate:** V1 across supported and unsupported THROW inputs; receipt visible in witness surfaces.
- **Exit condition:** receipt contract documented as permanent (mirrors DROP roadmap step 10's end-state: AP retains recognition and evidence, never semantic or mutation ownership).
- **Stop/rollback boundary:** if any downstream logic is found gating on the receipt as an execution precondition → stop; authority-model violation.

### Stage 6 — Connect single-action THROW to TLS in observe-only mode

- **Objective:** land the full decision/evidence path with zero mutation: `_throwPolicy` + `resolvePlayerHeldThrow` (resolver), THROW family branch with `_deriveThrowEffectiveQuantity` (validation), executor allowlist + family-point extensions (P4 predicts, never executes), index.js resolver branch, bridge THROW branch with `throw_dry_run_seal`, seal derivation + CB mutation-array zeroing extension, alignment THROW labeling. P2 assembly needs no change (verified family-agnostic).
- **Authority transition:** TLS gains THROW resolution/validation/prediction authority; execution authority still nowhere — dry-run only, bridge seal active on every THROW turn.
- **Dependencies:** Stages 3-5; Slice D1 recommended landed.
- **Validation gate:** syntax checks; source review of the five executor family points (re-grep required); V12 (seal scope), V26.
- **Exit condition:** THROW turns produce resolver evidence, v1 instruction, dry-run prediction, seal receipt, truthful no-execution narration constraint — and zero mutation.
- **Stop/rollback boundary:** rollback = remove the resolver branch (index.js) — with no live blocks, all other additions are inert. Stop if executor re-grep finds unverified family points or the bridge branch cannot mirror DROP's structure.

### Stage 7 — Validate dry-run evidence, diagnostics, narration constraints, and zero mutation

- **Objective:** prove TLS understands THROW: correct source ID, authoritative quantity, effective quantity per the frozen table, whole/partial/over routing, Ground destination per layer, fail-closed classes, ambiguity override, and full-turn zero mutation under the seal.
- **Authority transition:** none (proof stage).
- **Dependencies:** Stage 6.
- **Validation gate:** plan rows V3-V12, V20, V21; TAKE/DROP regressions V23, V24. This is the stage where parser "all"/`selection_mode` runtime behavior for THROW (plan Uncertainties 1-2) is first observed; fail-closed outcomes are acceptable passes.
- **Exit condition:** all listed rows PASS, including full-turn zero mutation (V11) — the seal now covers the Stage-4 exposure.
- **Stop/rollback boundary:** any mutation on an observe-only turn → stop immediately (V11 fail). Any TAKE/DROP regression → stop.

### Stage 8 — Enable whole-object THROW through TLS → ObjectHelper

- **Objective:** activate the simplest live case: one whole object or exact/all whole stack, player → current Ground, via `transferObjectDirect` exactly once, reason `tls_whole_object_throw`, consuming the P4 prediction; `_tlsExecutionResult` written; Authority Gate compensation reused.
- **Authority transition:** first live mutation authority: TLS → ObjectHelper for whole-object THROW only. Partial remains observe-only. Bridge seal deactivates only for an actually executed, corroborated whole THROW; all denied/unresolved cases keep the seal.
- **Dependencies:** Stage 7 complete from a proven no-mutation state.
- **Validation gate:** V13, V14, V21, V23, V24, V26.
- **Exit condition:** whole THROW live and validated; every non-executed THROW class still sealed and non-mutating.
- **Stop/rollback boundary:** rollback = remove the whole-THROW live block (system returns to Stage-6 observe-only). Stop on: object recreation instead of ID movement, wrong-layer placement, more than one helper call, AG inspecting uncompensated post-transfer inventory.

### Stage 9 — Validate whole-object THROW

- **Objective:** prove identity (original ID moves), current-Ground containment per layer (localspace / site / L0), Authority Gate behavior, narration matching authoritative outcome (generic post-mutation INVENTORY/GROUND grounding — no new work, provided layer-correct placement), persistence across save/reload, and TAKE/DROP/no-duplication regressions (CB re-narration of a moved object must be absorbed by the dedup guard / fail ObjectHelper source validation — `promoted === 0`).
- **Authority transition:** none (proof stage).
- **Dependencies:** Stage 8.
- **Validation gate:** V13, V14, V17 (whole-turn half), V21, V23, V24, V25.
- **Exit condition:** all rows PASS at all three Ground layers.
- **Stop/rollback boundary:** any duplication, wrong-layer, or persistence failure → stop; whole-THROW live block reverts to observe-only while diagnosed.

### Stage 10 — Enable partial-stack THROW through the existing split path

- **Objective:** activate `splitObjectDirect` for approved partial predictions, reason `tls_partial_stack_throw`: source persists player-held at the reduced quantity; exactly one successor with lineage at the predicted Ground; shared `tls_partial_stack_execution_v1` envelope + request-local archive lifecycle (already family-neutral); description target capture; quantity-one successor rename; successor description clear; THROW CB receipt capture. Do not restore AP's one-unit special case.
- **Authority transition:** TLS → ObjectHelper split authority for THROW.
- **Dependencies:** Stage 9 complete. **Deployment constraint:** Stage 10 must not reach a deployed/playable build without Stage 11 in the same unit (justified departure from strict step ordering — the DROP rocks incident is direct evidence of Bug-B replay when a partial split ships without extraction-layer containment).
- **Validation gate:** V15, V26 (structural); full behavioral gate deferred to Stage 12 by design.
- **Exit condition:** partial split executes once with correct arithmetic, lineage, and containment in dev validation.
- **Stop/rollback boundary:** rollback = remove the partial live block (whole THROW unaffected). Stop if the split cannot consume predicted parameters verbatim.

### Stage 11 — Integrate description-reconciliation and Continuity Brain protections for partial THROW

- **Objective:** land the full Bug-B containment chain and description handling: request-local THROW receipt slots + capture + sanitizer (index.js); `tlsPartialStackThrowReceipt` into `runPhaseB`; ContinuityBrain second sanitizer, prompt receipt block + precedence rules at the DROP block's tier, `partial_throw_successor_description` extraction; index.js post-CB successor-description consumption, third source-normalization call, and the deterministic replay-suppression filter keyed to the THROW receipt's source ID + exact containers (transfers only, successor never matched, promote path untouched).
- **Authority transition:** none gained; CB's ability to replay the surviving source as a transfer is deterministically removed for receipt-matched entries. **Two failure modes remain distinct:** Bug B (surviving-source transfer replay) is closed by this chain; Bug A (new duplicate promote) is mitigated by layer-correct placement + the existing generic dedup guard, with the residual identity-precision gap explicitly out of scope (shared pre-existing limitation, tracked as follow-up O2 in the plan).
- **Dependencies:** Stage 10 (same deployment unit).
- **Validation gate:** V16, V17, V18, V19, V26.
- **Exit condition:** replay suppression proven against a live CB replay attempt (or a constructed quarantine fixture if CB does not emit one during validation); descriptions reconcile; unrelated CB operations untouched.
- **Stop/rollback boundary:** stop if the prompt block cannot be inserted without restructuring the extraction prompt, or the suppression predicate cannot reject foreign/contradictory receipts from existing fields. Rollback of Stage 11 requires rollback of Stage 10 (unit rule).

### Stage 12 — Complete full validation

- **Objective:** run the entire verification matrix: quantity classes (default-one, explicit partial, exact stack, all, over-stack, vague, zero/negative/fractional/malformed), ambiguity, unresolved targets, invalid destinations, all three Ground layers, identity and lineage, surviving-source replay, the two-assertion duplication check (`object_reality.promoted === 0` AND exactly one TLS successor — never collapsed into one assertion), persistence, narration, diagnostics labeling, bridge behavior, issue-#37 guard behavior on THROW turns, single-action scope, TAKE regression, DROP regression, unrelated-CB preservation.
- **Authority transition:** none (proof stage).
- **Dependencies:** Stages 8-11 live; Slice D1 landed.
- **Validation gate:** every plan matrix row V1-V26 PASS, each reported individually with its evidence surface.
- **Exit condition:** full matrix green; parity with the frozen contract demonstrated; results archived for Mother Brain.
- **Stop/rollback boundary:** any failed row stops Stage 13 unconditionally; a failed row is never summarized as partial success.

### Stage 13 — Remove or permanently dead-end obsolete AP THROW mechanics

- **Objective:** delete the unreachable legacy AP THROW implementation (the code beneath the Stage-3 stub), correct the stale "same path as drop" comment, and confirm the permanent end-state: AP keeps only the recognition/refusal stub and receipt.
- **Authority transition:** none (dead code removal); the authority model is already final.
- **Dependencies:** Stage 12 fully green — removal is forbidden before TLS authority and parity are proven.
- **Validation gate:** V1 and V19 rerun; V23/V24 rerun; syntax check; diff review confirming only the legacy region was removed.
- **Exit condition:** one authority path for THROW; no transitional or duplicate THROW handling remains; migration complete.
- **Stop/rollback boundary:** if removal reveals any live reference into the legacy region → stop and restore; the region was not dead.

## PERMANENT BOUNDARIES (apply to every stage)

- ObjectHelper/ORS remains the sole mutation authority; AP remains diagnostic-only; narration and CB are never authority.
- No stage may enable compound-command THROW, impact-target semantics, parser changes, ObjectHelper changes, Authority Gate logic changes, or a generalized verb framework.
- Every live-mutation activation begins from the previously proven no-mutation state.
- Denied, unresolved, stale, ambiguous, or unsupported THROW turns remain non-mutating and truthfully narrated at every stage.
- Any newly discovered requirement touching a subsystem this roadmap defers must be reported for approval before implementation.
- Nothing in this roadmap is complete until its validation gate has actually been run and observed; planning is not completion.
