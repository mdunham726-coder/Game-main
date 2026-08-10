# Continuity Projection — Planning Charter

**Status:** Approved. **G-1 through G-10 complete. The planning process defined by §10 is closed.**
**Stage:** Requirements are in `CONTINUITY_PROJECTION_REQUIREMENTS.md` (G-8 passed after four audit
rounds); the implementation plan is `CONTINUITY_PROJECTION_IMPLEMENTATION_PLAN.md` (G-10 passed after
three). Seven amendments enacted here across revisions 8, 9, 10, and 11. The coding-agent handoff is
`CONTINUITY_PROJECTION_HANDOFF.md`. **No implementation work is authorized. Coding authorization is the
user's and has not been given; Phase 4 requires its own, separately.**
The release-one specification remains recorded in `CONTINUITY_PROJECTION_PLAN_INPUTS.md`.

---

## 0. What this document is

This is the **planning contract** for a proposed continuity projection subsystem. It exists to freeze
decisions already made, in writing, before the continuity research notes enter context — so that the
research material can inform the plan without being able to silently redefine the project.

This document is **not**:

- an implementation plan
- a research summary
- a design document
- authorization to read research notes, prior artifacts, or source
- authorization to write code

It binds the later research-to-plan conversion. Where a research finding and this charter conflict,
the charter wins until it is **amended under §11**, in writing, with the amendment recorded in §12.

---

## 1. Provenance and epistemic status

Everything in this charter derives from discussion between the user, ChatGPT, and Claude conducted
**before any source or research artifact was opened**. Consequently:

- No statement here is source-verified.
- Descriptions of existing engine systems — the CB TRUTH/MOOD rendering seam, ORS, ObjectHelper,
  Condition Bot, and their independent narrator routes — are recorded as the **user's stated intent
  and understanding**. They are treated as authoritative for *what this project is meant to be*, and
  as **unverified** for *what the engine currently does*.
- Where this charter names existing files or functions, it does so only to fix a **boundary or
  prohibition** — what the subsystem must not be built inside. Those names are unverified references
  carried from discussion, not source citations, and none of them constitutes an implementation map.
- Any charter statement that asserts current engine behavior must be verified against source before
  it is permitted to back a requirement (see §9).

Charter statements about intent, boundaries, prohibitions, and process do not require source
verification. Charter statements about existing behavior do.

---

## 2. Definitions

**Continuity fact** — an accumulated fact carried forward across turns within this subsystem's scoped
domain, as distinct from present-tense domain state owned by another authority.

**Packet** — the bounded, structured, deterministic object this subsystem constructs each projection,
containing the continuity facts selected for the narrator together with their dispositions.

**Disposition** — the verdict assigned to a managed continuity fact. Three states, settled:

- **live** — inside the category's bound. Rendered in full; the renderer may not drop one.
- **memory** — **displaced from the live set without a terminal verdict**, by either a capacity bound or
  a non-terminal age window. Not rendered. **Asserts nothing about ending or falsity** — it records only
  that a displacement rule applied, never that the fact ceased to be true. *(Broadened at revision 10;
  previously "displaced by capacity … records only that the bound ran out", which left a category's
  non-terminal age band with no available disposition.)*
- **retired** — policy expiry. The fact stops being carried forward. **Claims no observed ending** — it is
  a policy horizon, not evidence.

**Neither memory nor retired has a projector reinstatement path for a retained assertion instance in
release one.** With the same stored key and unchanged `turn_set`, both are terminal; they differ in what
they assert, which is why they remain distinct rather than collapsing into one non-live state. A genuine
spatial boundary may delete a player `state` assertion upstream, and later extraction may create the same
key with a new `turn_set`; that is a new assertion instance, not reinstatement of the prior one (F-9,
source-verified; amended at revision 11).

**Scoped continuity domain** — the complete return of `assembleContinuityPacket`: every section it emits,
whose input set is fixed by the assembler's read set. The packet's authority extends to this domain and no
further.

Within that domain, seam content divides into two kinds, and the division is load-bearing:

**Managed continuity fact** — an accumulated fact carried forward across turns that receives a
**disposition** (live / memory / retired) under a declared category policy. The truth-verdict statement in
§4 applies to these and only these.

**Auxiliary seam content** — content inside the scoped domain that is carried through the packet **without**
a disposition, because it is not an accumulated cross-turn assertion. It is rendered, accounted for, and
never silently dropped, but no live/memory/retired verdict attaches to it. INV-12 does not reach it.

**Current-state authority passthrough** — content inside the scoped domain that is **owned by another
authority** and read at projection time as present-tense state. The projector carries and formats it; it
does not own it, and it receives no disposition. It is preserved during normal projection and **omitted
rather than stale-replayed on failure**, because replaying it would re-assert another authority's state
from a prior turn.

The three kinds above classify the **semantic content** the packet carries. The packet's return also
contains generated text that is not content, and one rule for placing it:

**Framing** — text generated by the packet to frame or delimit content: section headers, rule lines, and
separators. It is emitted unconditionally, is drawn from nothing, asserts nothing, and is owned by no
authority. It receives **no classification and no disposition**, and INV-12 does not reach it. It remains
subject to INV-15 accounting and to byte-level preservation at cutover.

**A generated line that asserts a fact about the world is content, not framing**, and is classified by
what it asserts — regardless of whether the packet composed the wording. An absence marker derived from
engine state is therefore current-state authority passthrough, while an absence marker reporting only the
packet's own emptiness is framing.

**A field placeholder belongs to the content it stands in for**, and is classified and omitted with it.
A placeholder cannot outlive the line it occupies.

**Channel closure** — within the scoped continuity domain, the packet is the sole path by which
continuity truth reaches the narrator. Omission is therefore consequential, not cosmetic.

**Projection point** — the fixed, explicitly defined point in the turn cycle at which the packet
reads domain state and is constructed. *(Its exact location is OPEN — see F-6.)*

**Category** — a class of continuity fact governed by a single declared policy.

**Policy** — the declared, deterministic rule assigning dispositions within a category.

**Direction of caution** — for a category, which way policy errs when lifecycle evidence is absent:
**retain-until-proven-dead** or **omit-until-proven-live**. These produce opposite simulations.

**Shadow mode** — running the subsystem to build and archive packets without rendering them, with the
existing renderer still live.

The following two terms describe the planning process rather than the subsystem:

**Research ledger** — the continuity research artifact. It is the **final evidentiary authority**. It
leaves the drafting context after extraction and returns only for the independent audits at G-8 and
G-10.

**Extraction artifact** — the curated bridge document produced at G-3/G-4, converting ledger evidence
into bounded planning inputs and the decision surface for the user. It is **transitional but retained**:
superseded as a working input once the plan exists, and kept permanently as the provenance record of how
ledger evidence became planning input, so that later audits can test whether that compression was
faithful.

---

## 3. Settled subsystem definition — SETTLED

The proposed subsystem:

1. Replaces the existing CB TRUTH/MOOD rendering seam.
2. **Is implemented as a new standalone source file.** The projector/manager is its own component. It
   is not an expansion of `ContinuityBrain.js`, `index.js`, ORS, ObjectHelper, or Condition Bot.
   Existing code receives only the minimal integration changes required to supply inputs, invoke the
   new component, archive its output, and render it through the existing seam. "Replaces the CB
   TRUTH/MOOD rendering seam" does **not** mean rewriting packet assembly in place inside
   `ContinuityBrain.js`. This is settled, not an open implementation choice.
3. Builds, renders, and archives a structured, deterministic continuity packet, including the reason
   for every disposition, inclusion, and exclusion.
4. Is authoritative for continuity truth within its scoped domain, assigning **live**, **memory**, or
   **retired** dispositions.
5. Reads authoritative object state and player-condition state as **constraints** on what the packet
   may carry, **where a managed assertion carries a mechanically resolvable reference to those
   authorities. Where no such reference exists, no read is required and none may be simulated by
   inference.** It does not duplicate those systems' present-state output. *(Amended; see revision 8. No
   managed category currently carries such a reference, so release one performs no such read. This
   narrows when the obligation binds; it does not repeal it, and it re-binds automatically if a
   resolvable reference is ever established.)*
6. Does not replace, mutate, or subsume ORS, ObjectHelper, or Condition Bot, or their authority.
7. Leaves those systems' independent narrator routes intact.
8. Operates at a fixed, explicitly defined point in the turn cycle.
9. Assigns dispositions through declared deterministic policies, never through semantic inference
   that an unrecorded world event occurred.
10. Runs in shadow before replacing the existing renderer.
11. Adds no new simulation mechanic to the engine.

The rationale for item 2 is recorded because it constrains later decisions: it preserves the subsystem
boundary, keeps deterministic projection separate from stochastic extraction, prevents an existing
mixed-responsibility component from growing further, and makes the new logic independently testable and
replaceable. The filename and exact interface remain for the plan; **standalone** does not.

---

## 4. Authority boundary — SETTLED

Three systems own three different kinds of truth. They coexist because the domains are distinct, not
because one defers to another:

| System | Owns |
|---|---|
| ORS | Current physical object truth — what exists, where it is, what holds it, whether it was consumed |
| Player-condition pipeline — CB creates, Condition Bot evolves and resolves, index persists | Current player-condition truth. LLM-driven, not deterministic |
| This subsystem | Continuity truth — which accumulated facts remain live, which are memory, and which no longer carry forward |

The central authority statement, recorded verbatim and not to be paraphrased in derived documents:

> Within the packet's scoped continuity domain, live/memory/retired dispositions are truth verdicts,
> not merely presentation choices; the packet still does not mutate or replace the underlying
> authorities that supply object and condition truth.

**Precedence and reconciliation.** Where present-tense domain state conflicts with accumulated
continuity, the owning domain authority wins. The packet reconciles against live domain state at the
projection point, so contradictions are resolved before render rather than arbitrated at the narrator.
Precedence is the rule; reconciliation at the fixed point is the mechanism that keeps it from needing
to be exercised.

---

## 5. Invariants — SETTLED

Testable rules, not aspirations. Each carries the demonstration required to claim it holds.

| ID | Invariant | Demonstration |
|---|---|---|
| **INV-1** | **Determinism.** The same valid inputs produce the same packet and the same dispositions. | Repeat projection over identical inputs; compare packet and dispositions for exact equality. |
| **INV-2** | **Inspectability.** Every inclusion, exclusion, demotion, and retirement has an archived reason. | Archive contains a reason record for each disposition; no disposition is unaccounted for. |
| **INV-3** | **Domain precedence.** Current object and condition truth supplied by their owning systems takes precedence; contradictions are reconciled before render. **Reconciliation applies only to assertions carrying a mechanically resolvable authority reference. No managed category currently has one established** — where no such reference exists, the invariant imposes no reconciliation duty and none may be simulated by inference. | For assertions with a resolvable reference: construct a contradiction between domain state and accumulated continuity; confirm the packet defers and the narrator never receives both. For assertions without one: confirm the packet performs no reconciliation and asserts no validity it cannot resolve. |
| **INV-4** | **No projector resurrection.** A retained assertion instance that reaches `retired` cannot return to `live` while its stored key and `turn_set` remain unchanged. Upstream deletion followed by same-key creation with a new `turn_set` creates a new assertion instance and is not reinstatement. | Retire a retained assertion; advance turns without upstream deletion or recreation; confirm the same stored key and `turn_set` do not re-enter `live`. If the key is later recreated upstream, confirm it carries a new `turn_set` and is evaluated as a new instance. |
| **INV-5** | **Declared policy only.** Dispositions issue from declared deterministic policy. The packet may retire a fact under policy; it may never assert that an unrecorded world event occurred. | Every disposition traces to a named category policy; no disposition asserts an event with no upstream record. |
| **INV-6** | **No state mutation.** Projection changes no authoritative world state — objects, conditions, NPCs, locations, or otherwise. Non-authoritative writes are permitted and enumerated: diagnostic passback, the identity-line breadcrumb required by downstream consumers, and the transactional consumption of single-use content under INV-16. Nothing outside that enumeration may be written. | Authoritative state snapshot before and after projection is identical; every write the projector performs appears in the enumerated list. |
| **INV-7** | **Bounded live set — there is no live-but-unrendered state.** Each category policy produces a **bounded live set** before rendering. The renderer renders **every** live fact and may not independently truncate, sample, or drop one. Anything outside the live set carries an explicit non-live disposition and an archived reason under policy. The bound is part of the truth rule, not a view over it. | Overflow input yields a live set within the stated bound; every fact outside it carries a non-live disposition with a reason; rendered output contains exactly the live set — no more, no fewer. |
| **INV-8** | **Failure visibility, by content class.** Packet failure is **recorded** — into the turn record and emitted immediately for operator visibility — and never silently erases continuity truth. **The record is persisted on the same terms as the rest of the turn, which are asynchronous with swallowed write failures; release one does not guarantee it survives a disk failure.** Guaranteeing that would require a synchronous confirmed write on the turn's critical path, which is out of proportion to the stakes. Failure behavior differs by class: **managed continuity** replays last-good; **auxiliary seam content** is omitted; **current-state authority passthrough** is omitted and never stale-replayed. | Induce failure; confirm a record exists in the turn record and was emitted immediately, that managed continuity replays, and that no auxiliary or authority-owned content is emitted from a prior turn. Loss of the record to a swallowed write does not falsify this invariant. |
| **INV-9** | **Authority isolation.** Removing the packet leaves upstream authority behavior unchanged. | Disable the subsystem; upstream behavior is identical to its pre-project behavior. |
| **INV-10** | **Replacement scope.** The subsystem replaces only the CB TRUTH/MOOD seam, not every narrator input carrying world state. | Enumerate narrator inputs affected at cutover; confirm the set is exactly that seam. |
| **INV-11** | **Fixed projection point.** Reads and construction occur at one defined point in the turn cycle. | The projection point is named in the plan; no read occurs outside it. |
| **INV-12** | **Complete disposition.** Every **managed continuity fact** receives a disposition under an explicit category policy. Auxiliary seam content is out of its reach by definition (§2). | No managed fact exists in an unassigned state after projection. |
| **INV-13** | **Standalone component.** Projection logic lives in a new standalone source file. Changes to existing files are limited to supplying inputs, invoking the component, archiving its output, and rendering at the seam. | The diff shows all selection, policy, and disposition logic in the new file; no existing file gains disposition or selection logic. |
| **INV-14** | **Evidence-source extensibility.** The projector consumes lifecycle evidence through a boundary that admits new evidence sources without redesign of packet construction, archiving, or rendering. No single evidence source may be hard-coded as the only lifecycle input the projector can understand. | Adding a lifecycle-evidence source requires changes only at the evidence-input boundary and within category policy. |
| **INV-16** | **Transactional consumption of single-use content.** Single-use seam content is cleared **only after successful packet construction**. **Durable archival is not a precondition of consumption**, because archival is asynchronous and completes after the content has already reached the narrator; archival failure is recorded but does not retroactively affect the current turn's output or the completed clear. On **construction** failure the content is omitted from output and **not cleared**. "Not cleared" means the projector performs no clear; it does not guarantee that an upstream producer will refrain from replacing the value later in the same turn. | Induce construction failure after the read: confirm the content is absent from output and that the projector performed no clear, **verified immediately after the failed projection and before the upstream producer runs** — observing a non-empty field at the following projection is not proof, since a producer overwrite is indistinguishable from preservation. |
| **INV-17** | **Bounded-by-contract categories are declared.** Where a category's bound depends on an engine property outside this subsystem rather than on projector-side logic, that dependency is named, and violation of the input contract is recorded diagnostically rather than normalized. | Each category states whether its bound is projector-enforced or contract-dependent; contract violations produce a diagnostic, not a silent selection. |
| **INV-15** | **Seam accounting — no silent deletion.** Every input to the replaced seam is explicitly accounted for: carried as a managed category, carried as auxiliary seam content, **carried as current-state authority passthrough, emitted as framing**, or deliberately dropped by recorded decision. Nothing leaves the narrator's world as a side effect of replacement. | Enumerate the seam's inputs, sections, and generated text; each maps to exactly one of the **five** recorded treatments. Cutover diff shows no unaccounted loss. |

**Settled consequence, revision 11:** INV-4 is satisfied by stateless recomputation for a retained
assertion instance because its stored key and `turn_set` remain unchanged while turn history advances.
If upstream boundary cleanup deletes a player `state` assertion and later extraction creates the same
key with a new `turn_set`, the new record begins a new lifecycle; no prior disposition is reinstated or
carried into it. Packet history remains a sink under F-5.

---

## 6. Exclusions and non-goals — SETTLED

### 6.1 Out of project — not deferred, not release two, not this subsystem's concern

| ID | Excluded |
|---|---|
| **EX-1** | NPC death, liveness, departure, or retirement mechanics |
| **EX-2** | Location destruction, burning, collapse, or physical-state mechanics |
| **EX-3** | A universal world event log |
| **EX-4** | Unification of object audit and history surfaces |
| **EX-5** | Quest system repair |
| **EX-6** | Player inventory repair |
| **EX-7** | Generalized Arbiter archive repair |
| **EX-8** | Replacement of ORS, ObjectHelper, or Condition Bot |
| **EX-9** | Consolidation of all narrator-facing state into the packet |
| **EX-10** | An LLM-based packetizer |
| **EX-11** | Semantic inference that arbitrary prose has become false |
| **EX-12** | Unrelated cleanup discovered during planning |
| **EX-13** | Implementation work during the charter or evidence-conversion stages |

EX-1 and EX-2 are stated as **outside the project**, not as later phases. There is no mechanic to
integrate, and this project has no reason to invent one.

### 6.2 Out of release one — in-domain, deferred, no commitment made

Nothing may be added to this list as a way of keeping an excluded item alive.

| ID | Deferred |
|---|---|
| **DEF-1** | A CB attribute invalidation-evidence channel — working name **CB Attribute Invalidation Evidence Contract**. Excluded from release one; **not rejected**. Its absence is the basis of the accepted release-one ceiling: with no invalidation evidence available, dispositions for managed categories derive from creation-time evidence and declared policy, not from knowledge that an assertion became false. INV-14 exists so this can be added later without redesigning the subsystem. Release one must not design it. |

---

## 7. Reserved decisions — RESERVED FOR USER

These are the user's alone. They may be **informed** by research but never **settled** by it, and no
finding, however strong, converts into one of these by implication.

| ID | Decision |
|---|---|
| **D-1** | The closed release-one category list |
| **D-2** | The policy governing each category |
| **D-3** | The direction of caution for each category |
| **D-4** | Packet failure behavior |
| **D-5** | Whether shadow comparison is diagnostic or an approval gate |
| **D-6** | Approval of each individual upstream plumbing change |
| **D-7** | Authorization to move between planning stages (§10) |
| **D-8** | Any amendment to this charter |

---

## 8. Open forks — OPEN

Unresolved. Each must be closed explicitly, not by drift.

Several forks also appear in §7. This is intentional and the two lists answer different questions:
§7 records **who decides**, §8 records **what is not yet decided**. A fork leaving §8 does not leave §7.

| ID | Fork | Status |
|---|---|---|
| **F-1** | The closed release-one category list | **CLOSED** — five managed categories; two auxiliary; one carried without new lifecycle policy. Recorded in the extraction artifact |
| **F-2** | The exact policy for each managed category | **CLOSED** — matrix recorded in the extraction artifact |
| **F-3** | Retain-until-proven-dead vs. omit-until-proven-live, per managed category | **CLOSED** — omit-lean for C-1/C-4/C-5, retain-lean for C-2/C-3 |
| **F-4** | Packet failure behavior | **CLOSED** — three-class taxonomy, INV-8 |
| **F-5** | Whether packet history becomes an input for any category | **CLOSED** — **sink for all five**. No category's policy needs anything beyond `turn_set`, and no recurrence evidence exists to accumulate |
| **F-6** | The exact read point in the turn cycle | **CLOSED** — the existing call site, unchanged |
| **F-7** | Output bounds | **CLOSED** — overflow settled by INV-7; per-category bounds recorded as **provisional release-one constants**, to be validated by shadow comparison |
| **F-8** | The precise meaning and treatment of `memory` | **CLOSED** — see §2 |
| **F-9** | What constitutes new qualifying evidence after retirement | **CLOSED, source-verified; amended at revision 11.** For a retained assertion instance, none exists: `duplicate_silenced_summary` records per-entity, per-bucket counts with no key identity, so the stored record's `turn_set` is not refreshed and the projector has no reinstatement path. Player `state` assertions may instead be deleted upstream on a genuine spatial boundary and later created under the same key with a new `turn_set`; that is a new assertion instance, not new evidence applied to the retired instance |
| **F-10** | Whether the shadow comparison is diagnostic or a gate | **CLOSED** — **mandatory cutover gate** |

**The research notes will expose candidate categories and technical capabilities. They will not choose
the release-one scope.**

---

## 9. Evidence-to-requirement rules — SETTLED

The research-to-plan conversion is governed by these rules. They exist because this is the stage where
the project is most likely to be redefined by accident.

| ID | Rule |
|---|---|
| **EV-1** | A research finding is not automatically a requirement. |
| **EV-2** | Every finding receives an explicit disposition: accept, defer, reject, or informational. |
| **EV-3** | The user owns those dispositions. |
| **EV-4** | Every requirement must trace to verified evidence **and** to a settled charter objective. |
| **EV-5** | An absent mechanic normally creates an exclusion, not an implementation requirement. |
| **EV-6** | A discovered adjacent defect is logged and named, not repaired. |
| **EV-7** | No categorical requirement may be derived from evidence scoped to a single field, route, or subsystem. |
| **EV-8** | Source verification must preserve the narrowest supported wording. A finding that survives verification only in a narrower form enters the plan in that narrower form. |
| **EV-9** | Claims originating in notes or from another agent are hearsay until verified against source by the implementing agent. |
| **EV-10** | Upstream changes require explicit per-instance user approval. |
| **EV-11** | Permitted upstream work must be **additive, read-only plumbing** exposing truth the authority already owns. No new authority semantics, simulation mechanics, or mutation responsibilities may be added upstream. |
| **EV-12** | Any permitted upstream change must satisfy INV-9: removing the packet leaves upstream behavior unchanged. |
| **EV-13** | The research ledger is the final evidentiary authority. It leaves the drafting context after extraction but is reopened at G-8 and G-10 to verify the compression was faithful — including that nothing load-bearing was omitted. |
| **EV-14** | The extraction artifact must record evidence it discarded and the reason, not only evidence it retained. Omission is otherwise unauditable. |

---

## 10. Planning process gates — SETTLED

Sequential. Each transition requires explicit user authorization (D-7). No stage may begin because the
previous one appears finished.

| ID | Gate |
|---|---|
| **G-1** | Charter written and approved |
| **G-2** | Research notes opened |
| **G-3** | Candidate categories and capabilities extracted **into the extraction artifact**, which is its deliverable. Produced without open-ended discussion of the research: the stage ends by presenting only the decisions requiring a user answer, and nothing more. |
| **G-4** | Findings mapped against charter boundaries |
| **G-5** | Closed release-one category list chosen by the user |
| **G-6** | Category policies and remaining forks resolved |
| **G-7** | Planning requirements drafted |
| **G-8** | Requirements adversarially audited against source, the research ledger, and this charter, by a reviewer that did not author the artifact under audit |
| **G-9** | Formal implementation plan written |
| **G-10** | Plan independently audited before coding authorization, against source, the research ledger, and this charter, by a reviewer that did not author the artifact under audit |

### Context boundary — between G-6 and G-7

Requirements drafting is already planning work and must happen outside the raw-ledger context. A fresh
session therefore begins **after G-6 and before G-7**, and carries the drafting stages G-7 and G-9. It
does not carry G-8 or G-10, which are audits and independent by their own terms.

That session receives the charter, the extraction artifact, and the user's durably recorded decisions.
It does **not** receive the research ledger. The ledger returns only for the independent audits at G-8
and G-10.

Consequence, binding on the stages before the boundary: anything load-bearing must exist in a durable
artifact before the boundary is crossed. Material that lives only in conversation does not survive it,
and a decision recorded only in chat is not a recorded decision.

This charter deliberately contains **no implementation phases**. It governs the planning process. It
does not guess which files, functions, or code phases will be involved, because no source has been read.
The file-level constraint in §3 item 2 and INV-13 is not an exception: it fixes where the subsystem may
**not** be built, and leaves what will be built, and where, to the plan.

---

## 11. Amendment rule — SETTLED

1. This charter changes only by explicit user decision (D-8).
2. A research finding may **propose** an amendment. It may never **enact** one.
3. Every amendment is recorded in §12 with what changed, why, and what evidence prompted it.
4. Amendments are visible, never silently incorporated. A derived document that contradicts this
   charter is defective until the charter is amended to match.
5. Removing or weakening an invariant (§5) or an exclusion (§6.1) is an amendment, not a clarification,
   regardless of how it is framed.

---

## 12. Revision log

| # | Date | Change | Basis |
|---|---|---|---|
| 1 | 2026-08-03 | Charter created. All content derived from pre-research discussion in thread; no source or research artifact read. | Scope-definition conversation between user, ChatGPT, and Claude. |
| 2 | 2026-08-03 | Standalone-file constraint added as §3 item 2 and INV-13; §1 extended to cover named files as unverified boundary references; §10 reconciled with the new file-level constraint. | User direction that the subsystem is to be a new file, not an in-place rewrite of existing packet assembly. |
| 3 | 2026-08-03 | EV-13 and EV-14 added; G-8 and G-10 extended to name the research ledger as an audit input and to require an auditor that did not author the artifact under audit. | Evidence lifecycle correction: the ledger leaves the drafting context after extraction but remains final evidentiary authority, so extraction error and omission stay detectable rather than self-perpetuating. |
| 11 | 2026-08-10 | **No-resurrection scoped to an assertion instance on explicit D-8 authorization.** §2 now makes `memory` and `retired` terminal only for a retained assertion instance with the same stored key and unchanged `turn_set`. INV-4 and F-9 now distinguish projector reinstatement from the verified upstream lifecycle in which a genuine spatial boundary deletes a player `state` assertion and later extraction may create the same key with a new `turn_set`. `CONTINUITY_PROJECTION_PLAN_INPUTS.md` is deliberately unchanged as historical provenance. | User D-8 decision following source verification and repair of the older `index.js` boundary-cleanup wiring defect; the repaired policy is create-if-absent, persist within spatial context, clear on genuine boundary crossing, and permit later same-key creation as a new assertion instance. |
| 10 | 2026-08-03 | **`memory` broadened on user decision.** §2: the disposition now covers displacement from the live set without a terminal verdict, **by either a capacity bound or a non-terminal age window**, rather than by capacity alone. Its guarantee is unchanged and is restated more precisely: it asserts nothing about ending or falsity, recording only that a displacement rule applied. **Why this was needed:** the approved C-1 matrix makes a fact live at age ≤5 and retired past age 20 and assigns nothing to ages 6–20; the disposition set is closed, so those facts had no available verdict. The prior wording — "records only that the bound ran out" — is definitional, so routing age-displaced facts into `memory` widened the disposition rather than applying it, and G-9 was not permitted to close a matrix gap by elimination. **Deliberately not edited:** `CONTINUITY_PROJECTION_PLAN_INPUTS.md` §10.3 still carries the narrower G-6 wording. That document is the retained provenance record of how ledger evidence became planning input (§2); rewriting it would corrupt the record. Per §11.4 this charter is the authority where they differ. | User decision, following G-10's finding that the prior definition was definitional rather than illustrative. Raised by the implementation plan's own §4 note, which invited exactly this check. |
| 9 | 2026-08-03 | **INV-15's treatment enumeration reconciled with §2.** Two linked edits, one amendment: the invariant text now lists **five** treatments — managed category, auxiliary seam content, **current-state authority passthrough**, **framing**, or deliberate recorded drop — and the demonstration column now says "inputs, sections, and generated text" mapping to one of five. Purely a reconciliation: passthrough was added to §2 in revision 7 and framing in revision 8, and neither was carried into INV-15, which therefore named a treatment set that no longer existed. No behavior, scope, or obligation changes. | Found while enacting revision 8 and reported rather than fixed silently; user authorized it as a separate amendment. INV-15 is the invariant G-9's seam-accounting table cites, so a stale enumeration would have propagated into the implementation plan. |
| 8 | 2026-08-03 | **Four amendments enacted on user approval, following G-7 drafting and a passed G-8 audit.** §2: *framing* defined as a fourth kind of packet output that is **not content** and receives no classification, with two placement rules — a generated line asserting a world fact is content classified by what it asserts, and a field placeholder belongs to the content it stands in for. §3 item 5: the constraint-read obligation narrowed to bind only where a managed assertion carries a mechanically resolvable authority reference; none currently does, so release one performs no such read. **INV-8**: the failure record is *recorded* into the turn record and emitted immediately, persisted on the same asynchronous swallowed-failure terms as the rest of the turn; guaranteed disk survival is **not** promised, and its loss does not falsify the invariant. **INV-16**: consumption gated on successful packet **construction** rather than durable archival, since archival completes after the content has reached the narrator; demonstration corrected to check immediately after failure rather than at the following projection, which a producer overwrite would also satisfy. *Housekeeping in the same pass, no substantive change: the §0 stage header updated from "G-6 closed / next G-7" to record G-7 and G-8 complete.* | User decision on the eight-item settled decision set (DC-1 … DC-5, D-C, D-D, D-E) recorded in `CONTINUITY_PROJECTION_REQUIREMENTS.md`; §14 of that document states each amendment's required effect. Source basis for INV-8 and INV-16: the three disk writes at `index.js:8349`, `:8383–8390`, `:8694–8699` are asynchronous with swallowed failures, and all complete after the narrator prompt is committed at `:6189`; the single-use producer at `ContinuityBrain.js:1843` runs after the projection point via `index.js:6353`. |
| 7 | 2026-08-03 | **G-6 closure enacted on user approval.** §2: `live`/`memory`/`retired` fully defined with no reinstatement path; *current-state authority passthrough* added as a third content kind. §5: INV-6 given an enumerated permitted-write list; INV-8 restated as a three-class failure taxonomy; **INV-16** transactional consumption of single-use content added; **INV-17** bounded-by-contract declaration added. §8: all ten forks closed — F-5 sink for all five, F-6 existing call site, F-9 closed negatively on source evidence, F-10 mandatory cutover gate. | User approval of the corrected C-1..C-5 matrix, disposition definitions, failure taxonomy and default forks, following source verifications V-1 through V-5. |
| 6 | 2026-08-03 | **Six amendments enacted on user approval.** §2: scoped domain redefined as the assembler's complete return (A-1); *managed continuity fact* and *auxiliary seam content* defined as distinct kinds (A-2, resolved by separation rather than extension). §4: condition row restated as the CB → Condition Bot → index pipeline, LLM-driven (A-4). §5: INV-3 narrowed to assertions carrying a mechanically resolvable authority reference, with none established for any managed category (A-3, narrowed form); **INV-7 replaced** — bounded *live set*, no render-time truncation, no live-but-unrendered state; INV-12 scoped to managed facts; INV-14 evidence-source extensibility added (A-5); INV-15 seam accounting added. §6.2: DEF-1 recorded (A-6). §8: F-1 closed, F-7 partly closed, F-9 narrowed. | User decisions on R-1, R-2a, R-2b, R-3, R-6, R-7, R-EXT and amendments A-1..A-6, recorded in `CONTINUITY_PROJECTION_PLAN_INPUTS.md` §8.1. |
| 5 | 2026-08-03 | *Housekeeping, no substantive change.* Status header updated from "Draft, awaiting approval / Pre-research" to record G-1 approval and the G-2/G-3 stage. | User approval of the charter and authorization to proceed to G-2. Four amendments are **proposed** in `CONTINUITY_PROJECTION_PLAN_INPUTS.md` §6 (A-1..A-4); none is enacted here, per §11.2. |
| 4 | 2026-08-03 | §2 gained definitions of *research ledger* and *extraction artifact*; G-3 amended to name its deliverable and to bar open-ended research discussion; §10 gained the context boundary between G-6 and G-7. | Closed dangling references introduced by EV-13/EV-14, and recorded the planning workflow in the charter rather than leaving it in conversation that the boundary would discard. Boundary placed before requirements drafting, since that is already planning work. Extraction artifact defined as retained for provenance and audit, not superseded. |
