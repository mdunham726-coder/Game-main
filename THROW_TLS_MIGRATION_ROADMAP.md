# THROW → TLS MIGRATION ROADMAP

- **Status:** APPROVED — Stages 1-5 complete (Slice T1, the AP quarantine unit, is fully validated; the `ActionProcessor.js` source change is written and passing but not yet committed as of this revision — committing is a deliberate separate step); Stage 6 (Slice T2, TLS observe-only wiring) next. Beyond Stage 5, no stage may be marked complete merely because it is planned — each still requires its own validation gate to actually be run and observed.
- **Derived from:** `THROW_TLS_MIGRATION_IMPLEMENTATION_PLAN.md` (the detailed planning contract; this roadmap is the staged sequence view of that contract and must not diverge from it).
- **Source state at planning:** `main` @ `41dff601d5c56516eee8a9e6a5281b7530b43724` (v1.92.8). Implementation is proceeding on branch `throw-migration-branch`.
- **Approval:** APPROVED by the user via direct conversational authorization on 2026-07-21, given after the GPT forensic review revision (Revision 1) was pushed. The user explicitly stated this authorization is to be treated as "ceremonial authority" in place of a file edit; this Revision 2 now syncs the file text to match. Each remaining stage still requires the plan's Gate A (source re-verification + explicit implementation instruction) before its slice is coded.
- **Precedent:** the completed DROP → TLS migration (12-step staged sequence, quarantine-first / inert-first / one-authority-layer-at-a-time). The supplied precedent file is the v1.91.84-checkpoint revision of that roadmap; its endpoint is corroborated by current source, where DROP is fully live through TLS.

## FINAL CONTRACT

AP recognizes THROW but has no object-operation authority. TLS owns THROW resolution and execution policy. ObjectHelper performs the authoritative mutation. ORS remains authoritative state. THROW moves a player-held ORS object — one unit by default, an explicitly requested quantity, or the entire stack — to the authoritative current Ground (active localspace → active site tile → current L0 grid cell). Over-stack, vague, malformed, contradictory, zero, negative, fractional, or otherwise unsupported quantity requests fail closed without mutation. Single-action turns only; compound queues do not enter the THROW TLS lane. Existing interpretation and narration of trailing target phrasing ("throw X at Y") are preserved unchanged: there is no authoritative structured impact-target mechanic, and this migration adds, removes, and redesigns none — it only moves object-operation authority and corrects authoritative Ground placement.

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
- **Status:** COMPLETE (2026-07-21). Both the implementation plan and this roadmap were revised once after GPT forensic review (impact-target claim narrowed per user's live spoon-at-house evidence; Stage 4 no-op claim narrowed; V27 compound-inertness row added; V7 entire-stack escalation added), then explicitly approved by the user in conversation. No open contract ambiguities remained.

### Stage 2 — Establish baseline source and runtime evidence

- **Objective:** record pre-migration THROW behavior as the comparison baseline: AP handler behavior (wrong-layer destination, hardcoded quantity 1, whole-stack default), `_apExecutedTransfers` stamping, audit `requested_quantity` misreporting, and one observed whole + one observed partial THROW turn's witness output.
- **Authority transition:** none (read-only).
- **Dependencies:** Stage 1 approval; a runnable deployment (runtime rows cannot be closed from source alone — work-environment constraint noted in the plan).
- **Validation gate:** baseline evidence archived (witness/Mother Brain captures) sufficient for later parity comparison; source anchors re-verified.
- **Exit condition:** baseline recorded; no source drift from the plan's anchors.
- **Stop/rollback boundary:** material anchor drift → NEEDS SOURCE RE-VERIFICATION of the plan before proceeding.
- **Status:** COMPLETE (2026-07-21). Captured live against a locally-run isolated server instance (port 3001, `throw-migration-branch`, pre-quarantine code) via direct adaptive turn-by-turn play — not a scripted harness file. Three classes recorded with real object IDs and witness data:
  - **Partial-quantity defect** — session `1784659562098-rsssplmj0`: `obj_c757a03911bf` "rock" qty 5, `player/player`. Command "I throw 3 rocks onto the ground." Result: source landed at qty **4** (not 2) — AP hardcoded the split-extract quantity to 1 regardless of the requested 3 (`ActionProcessor.js:695`). Successor `obj_814f9dd686b4` qty 1 at `grid/LOC:7,5:19,8`, correct `parent_object_id` lineage.
  - **Whole-object control** — same session: `obj_943d5bc68cc6` "spoon" qty 1, `player/player`. Command "I throw the spoon onto the ground." Result: same object ID moved intact to `grid/LOC:7,5:19,8` — correct Ground at L0 (open ground, no active site/localspace). Witness confirmed `ap_executed_transfer_ids: ["obj_943d5bc68cc6"]`, count 1.
  - **Wrong-layer defect** — session `1784661280145-ufmvr1i9x`, L1 (`active_site: M2x7:site_start`, "Spooner's Diner"; player container `site/M2x7:site_start:4,8`): `obj_27862089d196` "spoon" qty 1. Command "I throw the spoon at the counter." Result: same object ID landed in `grid/LOC:2,7:89,55` instead of the correct site container — confirms the exact destination-layer defect `resolveCurrentGround` (localspace → site → grid) is designed to fix. Identity preserved; no CB duplicate on this particular run.
  - **Side observations, out of scope, not acted on:** narration disagreed with authoritative state on the partial-stack turn (claimed "one rock left" vs actual qty 4 — reinforces why validation uses ORS, not prose); Authority Gate returned `freeform`/`unsupported_referenced_object` for the wrong-layer turn yet AP executed the transfer anyway (witness-flagged `gate_denied_but_executed`) — pre-existing AG/AP behavior, unrelated to THROW ownership, explicitly not touched by this migration (Scope Exclusion 6).
  - Full session IDs, exact commands, before/after state, and raw witness JSON are additionally preserved in the implementing session's task record.

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
- **Status:** COMPLETE (2026-07-21). Stub inserted at `ActionProcessor.js:667` (7 lines; legacy 668-758 left byte-untouched and unreachable). `node --check` passed. Diff scope confirmed exactly `ActionProcessor.js`. Live-verified on the isolated test server: `state._apActuals` = `{operation_family:'throw', routing:'quarantined', helper_method:null, outcome:'refused_ownership'}`, `ap_executed_transfer_count: 0`. One transitional-exposure observation (expected, not a defect, documented under Stage 4 below): the thrown object still moved via post-narration Continuity Brain extraction on both initial test turns, since no bridge seal exists yet. Source change written and passing; not yet committed (commit is a deliberate separate step per user instruction).

### Stage 4 — Prove AP quarantine (engine-lane invariance)

- **Objective:** demonstrate that ActionProcessor no longer mutates: exact engine-lane ORS invariance for THROW attempts across whole, partial, and unsupported input classes. This stage does **not** claim a full-turn controlled no-op — full-turn inertness (narration seal + CB containment) is established at Stage 6 and proven at Stage 7 (V11).
- **Authority transition:** none (proof stage).
- **Dependencies:** Stage 3.
- **Validation gate:** plan row V2 — identical membership, quantities, object count; empty THROW audit — scoped explicitly to the engine lane. **Known transitional exposure (mirrors DROP's equivalent phase):** no narration seal exists yet, so narration may still describe success and CB may act on that narration. This exposure is dev-only and is the reason Stages 3-6 should be traversed promptly.
- **Exit condition:** V2 PASS on the engine lane; any observed CB-lane mutation documented and carried as Stage-6 motivation, not treated as a Stage-4 failure of the stub — and not represented as a passed no-op either.
- **Stop/rollback boundary:** any engine-lane mutation → stop immediately; the quarantine is defective.
- **Status:** COMPLETE (2026-07-21). Judged by attribution, not final ORS state, per explicit methodology correction (fresh isolated session per input class, since Continuity Brain can still mutate objects downstream of AP during this transitional window and would contaminate an end-state-only judgment). Three input classes tested, each in its own fresh session:
  - Whole-object — "leather satchel" (single object), command "I hurl the leather satchel as far as I can." — `parsed_action: throw`; `_apActuals` exact four-field receipt; `ap_executed_transfer_count: 0`; no AP-authored audit entries.
  - Partial-stack — "5 coins" stack, command "I throw 3 coins onto the ground." — same receipt shape; count 0; no audit entries.
  - Unsupported/vague quantity — "5 coins" stack, command "I throw some of the coins away." (`quantity_mode: unspecified`) — same receipt shape; count 0; no audit entries.
  All three: zero AP-originated ObjectHelper calls, zero `_objectRealityDebug.audit` entries attributable to AP (confirms the unreachable legacy code truly never executes regardless of input shape). One test-methodology note, not a code finding: an earlier attempt using the phrase "I throw the hat onto the ground" was parsed as `operation_family: 'drop'` rather than `'throw'` — pre-existing LLM parser ambiguity between THROW and DROP example phrasing ("onto the ground" overlaps DROP's own instruction text), out of scope, not investigated further.

### Stage 5 — Preserve the narrow AP recognition/refusal receipt

- **Objective:** confirm the four-field receipt is the permanent AP THROW surface: recognition + refusal evidence only, distinguishing intentional quarantine from parser/routing failure.
- **Authority transition:** none (the stub from Stage 3 is the mechanism; this stage locks its contract).
- **Dependencies:** Stage 4.
- **Validation gate:** V1 across supported and unsupported THROW inputs; receipt visible in witness surfaces.
- **Exit condition:** receipt contract documented as permanent (mirrors DROP roadmap step 10's end-state: AP retains recognition and evidence, never semantic or mutation ownership).
- **Stop/rollback boundary:** if any downstream logic is found gating on the receipt as an execution precondition → stop; authority-model violation.
- **Status:** COMPLETE (2026-07-21). Closed on the same evidence set as Stage 4, by user agreement: the receipt was byte-identical in shape across three genuinely different input classes (whole-object, explicit partial quantity, vague/unsupported quantity) — proving it is a deliberate, input-independent quarantine marker rather than a parser-failure artifact. No downstream execution-gating exists to violate: source-level verification during planning already confirmed `ObjectOperationResolver.js`, `TlsObjectOperationExecutor.js`, and `ObjectOperationBridge.js` have zero THROW footprint as of this stage, so nothing in the current codebase could consume `_apActuals` as an execution precondition yet. This closes Slice T1 (Stages 3-5) as one validated unit.

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
- **Validation gate:** plan rows V3-V12, V20, V21, V27 (compound-turn full-turn inertness — if the thrown object mutates during a compound turn, stop for a bounded containment decision per Stop Condition 10b); TAKE/DROP regressions V23, V24. This is the stage where parser "all"/`selection_mode` runtime behavior for THROW (plan Uncertainties 1-2) is first observed. Individual fail-closed outcomes are acceptable passes, **except**: if normal entire-stack phrasing consistently fails closed because the parser never emits the metadata, that is NEEDS USER DECISION (plan Stop Condition 10a), not a completed entire-stack contract.
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
- **Validation gate:** every plan matrix row V1-V27 PASS, each reported individually with its evidence surface. The V7 entire-stack escalation and the V27 compound-inertness proof are explicitly re-checked here on the final build.
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
- Denied, unresolved, stale, ambiguous, or unsupported THROW turns remain non-mutating and truthfully narrated at every stage from Stage 6 onward; during the Stage 3-5 transitional window only engine-lane invariance is guaranteed (see Stage 4), and compound-turn inertness is proven by V27 rather than assumed.
- Any newly discovered requirement touching a subsystem this roadmap defers must be reported for approval before implementation.
- Nothing in this roadmap is complete until its validation gate has actually been run and observed; planning is not completion.

## REVISION HISTORY

- **2026-07-21 — Revision 3 (Slice T1 closure; Stages 3-5 complete).** Stage 3 marked COMPLETE: `ActionProcessor.js:667` refusal stub implemented, syntax-checked, and live-verified (receipt exact, zero AP mutation). Stage 4 marked COMPLETE: engine-lane invariance proven by attribution (not final-state) across whole/partial/unsupported input classes in fresh isolated sessions, per explicit methodology correction — final-state judgment would have been contaminated by the documented transitional CB-mutation exposure. Stage 5 marked COMPLETE on the same evidence: receipt shape proven stable and input-independent; no downstream consumer of `_apActuals` exists yet to violate the non-authorization invariant. Overall status remains APPROVED; Slice T1 is fully validated with its source change written and passing but intentionally not yet committed — commit/push is being done as a separate deliberate step per user instruction. No architectural or contract change.
- **2026-07-21 — Revision 2 (status sync; Stage 1-2 closure).** Status changed READY FOR REVIEW → APPROVED per explicit user conversational approval (given as "ceremonial authority" rather than a prior file edit; this revision syncs the text to match). Stage 1 marked COMPLETE. Stage 2 marked COMPLETE with live baseline evidence recorded directly in this document (partial-quantity defect, whole-object control, wrong-layer defect, two out-of-scope side observations). No architectural or contract change — this is a status/evidence update only.
- **2026-07-21 — Revision 1 (post-review; GPT forensic audit + user runtime clarification).** Stage 4 retitled "Prove AP quarantine (engine-lane invariance)" — it no longer claims a controlled full-turn no-op, which is proven at Stage 7; FINAL CONTRACT impact-target sentence replaced with preservation language (existing trailing-target interpretation/narration unchanged; no authoritative structured mechanic exists; migration only moves authority and corrects Ground placement); Stage 7 and Stage 12 gates gained V27 (compound-turn full-turn inertness) and the V7 entire-stack NEEDS USER DECISION escalation; PERMANENT BOUNDARIES non-mutating claim scoped to Stage 6 onward. Status remains READY FOR REVIEW.
- **2026-07-21 — Initial READY FOR REVIEW.**
