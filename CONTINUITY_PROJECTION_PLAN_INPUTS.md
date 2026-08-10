# Continuity Projection — Plan Inputs

**Stage:** G-3/G-4 deliverable. Extraction artifact under `CONTINUITY_PROJECTION_PLANNING_CHARTER.md`.
**Source:** `research-notes-continuity-packet.md` at commit `a856c99`. Part I and Part II only — Part III is
declared non-current by the ledger itself and was not drawn on.
**Status:** Draft 5 — **G-6 complete.** The approved release-one specification is §10; source-verification
findings are §11. Those two sections plus the charter are what crosses the context boundary.

*(Historical status: Draft 4.)* Two audits reconciled against raw artifacts (§9) plus an external review pass verified
against the ledger. **Closed by user decision (§8.1):** R-1, R-2a, R-2b, R-3, R-6, R-7, R-EXT, and
amendments A-1..A-6, all enacted in charter revision 6. **Open:** per-category policy and direction of
caution, plus the forks listed in §8.2.

This document converts ledger evidence into bounded planning inputs. It selects no categories, drafts no
requirements, proposes no implementation. Every material claim carries its observation reference.

---

## 1. What the seam actually is

The charter defines the scoped continuity domain as "the content presently carried by the CB TRUTH/MOOD
rendering seam." The ledger bounds that precisely.

- One assembly point for the whole narrator prompt (O1); one interpolation for the continuity block (O4);
  one producing call, `CB.assembleContinuityPacket(gameState, _cbMeta)` at `index.js:4474` (O5).
- The call returns **a flat rendered string**, not structured data (O6).
- It emits **three** sections, not two: `CONTINUITY — TRUTH`, `CONTINUITY — MOOD`, and conditionally
  `CONTEXT — RECENT LOCATION` (O6). The third is L0-only, single-use, and cleared after render.
- O52 gives its input set as `player.attributes`, `player.identity`, `npc.attributes`,
  `locRecord.attributes`, `w.mood_history`, `w._lastPhaseBLoc`. **⚠ This list is incomplete — superseded by
  the source enumeration in §11.4.** The assembler also reads `npc.player_recognition`,
  `gameState.turn_history.length`, NPC label fields, mood location keys and world position, and it performs
  four writes. Use §11.4, not this list, for any accounting purpose.

**Consequence for scope.** O52 closes the candidate universe. Anything not in that read set is outside the
scoped domain by construction, not by choice. **The charter's name for the domain undercounts it:** a
component replacing this call necessarily replaces the RECENT LOCATION section too. See amendment A-1.

**Confirmed separately:** the seam is *not* a universal continuity choke point. Three routes carry
accumulated cross-turn continuity outside it — object condition history (O78), player conditions (O79),
legacy `npc.narrative_state` (O80). This is exactly the boundary the charter drew in §4, and I22 states it
in the same narrowed form.

---

## 2. Candidate categories

Derived from the seam's read set (O52). This is the complete candidate space; it is not a recommendation,
and D-1 remains the user's.

| # | Candidate | In seam via | Identity | Birth evidence | Retirement evidence | Current bound |
|---|---|---|---|---|---|---|
| C-1 | Player attributes — `state` | TRUTH | content is the key (O12) | `turn_set` always; `promotion_log` if helper-promoted (O85) | **none** (O15, O16, I27) | age 5 turns (O17); no count cap (O19) |
| C-2 | Player attributes — `physical` | TRUTH | content is the key (O12) | as above (O85) | **none** (O15, I27) | **none** — not age-suppressed (O17), not sliced (O19) |
| C-3 | Player attributes — `declared` | TRUTH | content is the key (O12) | `turn_set` only — founding `declared:` bypasses `promotion_log` (O85) | **none**; explicitly permanent (O19) | **none** |
| C-4 | NPC attribute map | TRUTH | NPC subject stable, assertion not (O12) | birth only (O85) | **none** (O15) | top-20 by `turn_set` (O17) |
| C-5 | Location / environment attributes | TRUTH | container stable, assertion not (O12) | birth only (O85) | **none** (O15) | top-20 (O17) + dedup (O18) |
| C-6 | Mood | MOOD | n/a — snapshot series | series is per-turn by construction | window-capped at 5 (O17) | 5 entries (O17), current-location filter (O57) |
| C-7 | `player.identity` | read by the assembler (O52); **rendered section not established** | structured record | separate from CB attr lifecycle | **not traced** (U16) | n/a |
| C-8 | RECENT LOCATION (`_lastPhaseBLoc`) | third section | n/a — single value | n/a | **self-clearing** — single-use, cleared at render (O6) | 1 |

**Excluded from the TRUTH block already, in current code:** the `object` bucket, for both player and NPC
(O20, at `ContinuityBrain.js:1933` and `:1970`). It is not a candidate.

**Evidence gap — since CLOSED by source verification (V-3, §11.2).** The ledger enumerated no bucket
vocabulary; four player buckets were merely *observed across four sampled saves* (O72). Source now
establishes the writers: NPC buckets are `physical` and `state`; player buckets are `physical`, `state`,
`declared`; location is always `environment`.

### Per-candidate notes that bear on policy

**C-1 `state`** — the demonstrated defect lives here. Three sequential postural facts were simultaneously
live for the player at T-10, one of them a **completed motion** stored as durable state and destined to
age out rather than be retired (O43). Cause is structural: the extraction schema has a durability axis but
**no completion axis** (O54, O55, I14). Measured: 50 `state` attrs in one 17-turn save, 25 already
suppressed by age (O72).

**C-2 `physical` and C-3 `declared`** — the unbounded **visible** growth vector (I21). Exempt from the
5-turn window (only `state` decays, O17) and from slicing (O19). Observed 25 + 3 at 23 turns, all rendered
every turn (O72). Any bound chosen under INV-7 changes render behavior here immediately.

**Evidentiary tiers differ within this finding.** The *structural* claim — that these buckets are exempt
from both suppressors — rests on O17 and O19, which are source-read findings an external auditor can
re-verify. The *magnitude* rests on O72, which the ledger marks as Observed-by-me against the local save
corpus and **not reproducible by its external auditor**. The structure survives without the corpus; the
numbers do not. Same tier caveat applies wherever O70–O72 and O74–O76 are cited below.

**C-5 location/env** — displacement is **permanent** under current code: selection re-sorts the same store
by `turn_set` desc and slices, and nothing distinguishes "suppressed because stale" from "suppressed
because outranked" (I20). Measured: one location held 97 stored env facts, ≤20 rendered, ≥77 permanently
displaced (O72, with the ledger's own caveat that the assembler was not executed against those saves).

**C-6 mood** — structurally unlike C-1..C-5. It is already a per-turn series with a working window, not an
accumulated assertion store. Whether `live`/`memory`/`retired` is even meaningful for it is a scope
question, not an evidence question. See amendment A-2.

**C-7 identity** — read by the assembler (O52), but its lifecycle is **untraced** (U16), including whether
identity fields can change; form transformation is contemplated at `ContinuityBrain.js:399`. This is the
only candidate whose lifecycle evidence is *unknown* rather than *absent*. **The render-section gap is
CLOSED by source verification (V-1, §11.1):** identity renders in the TRUTH block as a `Player: …` line.
U16 — whether identity fields can change and whether such a change leaves a record — remains open, which is
why C-7 receives no lifecycle policy in release one.

**C-8 recent location** — already has a terminating lifecycle by construction (O6).

---

## 3. Constraint sources, and whether they can actually be joined

The charter's §3 item 5 requires the packet to read authoritative object and condition state **as
constraints**. Both authorities are real and readable. The join is the problem.

**ORS / object records — strong and mechanically readable.** Stable `id` (O30); `events[]` with turn,
action, from/to, reason (O32); `status:'consumed'` with the record preserved (O31); the retirement event is
terminal and cannot be displaced by the 10-entry FIFO (O59). Retirement is proposed by CB narration
extraction and validated/owned by the engine + ORS (I7, O56, O38).

**Player conditions — strong and mechanically readable.** Stable `condition_id` independent of content;
append-only uncapped `turn_log`; `conditions_archive` with `resolved_turn` (O21). Exercised: 88 Condition
Bot runs across 37 sessions, 153 conditions evaluated (O93). The resolution step is rare for a *designed*
reason — serious conditions need treatment evidence and `AGING_THRESHOLD = 200` has never been reachable in
a corpus whose longest session is 27 turns (O94).

**The blocking finding.** The ledger states it directly: a packetizer reading CB attributes **cannot
mechanically determine current validity; it could only infer it** (I3, confidence high, from O12–O16).

Supporting, and scoped carefully: a CB assertion has **no identity independent of its own content** (O12),
and the record shape written at all three promotion sites is `{ value, bucket, turn_set, confidence }` with
no reference field (O11). Stated at its narrowest — **no reference field appears in the written record
shape, and no observation reports one existing at runtime.** It is not established that none is ever added;
the ledger retracted a claim built on exactly that reasoning from constructor shape to runtime shape, so the
absolute form is not asserted here. The blocking finding does not depend on it: I3 is stated independently.

So the constraint sources are readable but **not joinable to C-1..C-5 assertions by any mechanism the
ledger establishes**. Reconciliation as INV-3 describes it is available only where an assertion carries a
resolvable reference, and the ledger establishes no such reference for CB attributes. See amendment A-3.

**Determinism differs between the two authorities — do not merge them.** The ledger's "both" at O61 means
*CB extraction and Condition Bot*, not ORS. Precisely:

- **The player-condition lifecycle is LLM-driven.** CB creates, Condition Bot evolves and resolves, index
  persists (O61); both stages are DeepSeek calls (O61, O23). The ledger calls it "a valid lifecycle
  precedent, **not a deterministic one**" (O61).
- **ORS's retirement *application* is guard-based and engine-owned** — narration proposes, engine guards
  validate and can refuse, ORS holds authority (I7, O38). The *proposal* originates in LLM narration
  extraction (O56); the *application* does not.

---

## 4. Charter statements confirmed, narrowed, or contradicted

### Confirmed

| Charter | Evidence |
|---|---|
| §3.1 — single seam replacement is real | One interpolation (O4), one call (O5), one export at `ContinuityBrain.js:2187` |
| §3.6/§3.7 — other authorities keep independent routes | O78, O79, O80 confirm three separate routes exist and are outside the block |
| §2 channel closure, **scoped to the seam** | I22 states it in exactly this narrowed form: sole consolidated route for CB-promoted attribute maps, not for continuity generally |
| §4 — the three-domain split, **partially** | ORS owns object current-state and CB attributes are unowned (I27) are confirmed. The Condition Bot row is **not** — see N-5 |
| INV-2 inspectability has existing substrate | Block text (O8), full prompt (O24), payload archive (O25), per-stage payloads (O26), flight recorder (O27), uncapped `turn_history` (O28), Mother Brain query tools (O29) |
| The project replaces proxies, not nothing | Selection already exists — age windows, recency caps, dedup, bucket exclusion (O17, O18, O57). What is absent is **truth-aware** selection: identity, eligibility, per-fact reasons, archived decisions (I16) |
| INV-7 is necessary, not precautionary | C-2/C-3 render unbounded every turn (I21, O72) |
| EX-1, EX-2 correctly excluded | NPC liveness and location physical state have **no authoritative contract**; those contracts would have to be **invented, not extended** (I18, I26) |
| EX-4 correctly excluded | Object mutation evidence is fragmented across ≥7 surfaces with differing coverage, identity shapes and timing; two paths overwrite or omit (I29, O81, O82c) |
| EX-5, EX-6 correctly excluded | Quests: broken integration, zero ever executed across 1823 saves, user-scoped out (O86, O87, O88, I30). `player.inventory`: empty in all 1823 saves, handed to issue #60 (O91) |

### Narrowed

**N-1 — the scoped domain is three sections, not two** (O6). "TRUTH/MOOD" undernames what the call returns.

**N-2 — INV-3 reconciliation is not mechanically available for C-1..C-5.** Identity is content (O12);
no assertion carries a resolvable reference to the authorities that would constrain it; validity "could
only be inferred" (I3). INV-3 as written cannot be demonstrated for these categories.

**N-3 — INV-2's substrate is qualified.** Archive completeness holds **on the normal success path only**:
a malformed narrator response or a failed async disk write can leave gaps (O62), and the flight-recorder
JSONL is serialized at `index.js:8354` before the Arbiter runs at `:8558`, so `turn_history` and the JSONL
are **not equivalent snapshots** of a completed turn (O77).

**N-6 — INV-4's feasibility for C-1..C-5 depends on a storage change the charter may not permit.** I6:
*"The CB attribute model cannot carry a stable `fact_id` without a storage change, because identity is
content (O12): any change to a fact's text creates a new key rather than a new version."* No-resurrection
requires being able to say *this* retired fact is the same fact — which content-keying cannot express, since
an edited assertion is a new key rather than a new version of the old one. So INV-4 is demonstrable for
these categories only if assertion identity changes, and per I6 that is a storage change, which is upstream
work gated by D-6, EV-10 and EV-11.

*Scoped deliberately, twice.* This bears on **INV-4** only — content keys are deterministic, so INV-1 is
untouched, and dispositions can attach to content-keyed facts, so INV-12 is untouched.

**And narrower still than first written.** Identity-as-content is stable for *unchanged wording*: the same
text yields the same key, and CB already counts recurrences of an existing key (O13). So no-resurrection
**for an exact key is achievable without new identity**. What content-keying cannot express is
same-fact-across-changed-wording — I6's own limit: *"any change to a fact's text creates a new key rather
than a new version."* A reworded assertion is a new fact to the store, and no mechanism links it to the one
it supersedes. INV-4 is therefore demonstrable at exact-key granularity today, and **not** demonstrable at
semantic granularity without the storage change I6 describes.

**N-5 — charter §4 attributes player-condition truth to Condition Bot; the ledger calls it shared.** The
matrix row reads: *"Shared subsystem: CB creates → Condition Bot evolves/resolves → index persists (O61).
LLM-driven, not deterministic."* I5 carries the same qualification. Condition Bot does not create conditions
at all — `conditionbot.js:18`, quoted in O61: *"Never creates conditions (CB owns creation)."* So the
constraint source the packet consults for conditions is a **three-component, LLM-driven pipeline**, not a
single deterministic owner. See A-4.

**N-4 — INV-4 no-resurrection is currently a non-issue and becomes one under the new design.** Under
current code, displacement past the top-20 window is **permanent** — a displaced fact can never re-enter
(I20). A new selector that re-evaluates eligibility could reintroduce facts the old one had permanently
dropped. The invariant is sound; the risk it guards against is created by this project, not inherited.

### Contradicted / in tension

**T-1 — the central tension of release one.** Charter §3.9 and INV-5 permit dispositions only from declared
deterministic policy and forbid asserting an unrecorded event. The evidence says CB assertions have
**creation evidence and no invalidation evidence anywhere, for any bucket** (I27, O15, O16), and that
current validity cannot be mechanically determined (I3).

Taken together: for C-1..C-5, the only inputs a compliant policy can use are `turn_set`, bucket, category,
and whatever domain constraint is joinable — which per §3 is close to none. **Release-one dispositions for
CB attributes are therefore bounded to roughly the same information the current proxies use.** The gain is
not better knowledge of truth; it is that selection becomes identified, explicit, reasoned, archived, and
bounded rather than implicit and unlogged — which is precisely I16's framing. This is not a charter
violation, but it materially bounds what "truth-aware" can mean at release one, and it should be settled
knowingly rather than discovered during drafting. **This is the decision I most need answered (see R-1).**

**T-2 — §2's definition of "continuity fact" does not cover two candidates.** It defines an accumulated
fact carried forward across turns. C-6 mood is a snapshot series; C-8 recent location is single-use and
self-clearing (O6). Both are inside the seam. Either the definition extends or those candidates fall out of
scope while remaining inside the replaced call — which is not a coherent end state. See A-2.

**T-3 — the charter has no name for a fact that is disposed live but not rendered.** This is the largest
unresolved tension found in this pass, and neither audit could have caught it: it is internal to the
charter, not a mis-citation of the ledger.

Three charter positions collide:

- **INV-12** requires every in-scope fact to receive a disposition — so the disposition set is *complete*.
- **INV-7** requires narrator-facing output to be *bounded*.
- **Channel closure** (§2) makes the packet the sole path by which continuity truth reaches the narrator,
  so *omission is consequential, not cosmetic* — and §4 makes dispositions **truth verdicts**.

If more facts are disposed `live` than the bound admits, the unrendered remainder is simultaneously
*true* (by disposition) and *absent from the only channel truth travels on* (by bound). The charter has no
term for that state and no rule for who wins.

This is not hypothetical. One location held 97 stored environment facts against a 20-item render window,
with displacement permanent under current code (O72, I20) — today that is proxy suppression with no truth
claim attached, but under a disposition model those 77 would carry verdicts they never deliver.

Three resolutions, surfaced not chosen: the bound governs disposition too, so unrenderable means demoted or
retired and the bound becomes part of the truth rule; or the disposition set is complete while the render is
an explicitly bounded *view*, which concedes that omission at render is not a truth verdict and weakens
channel closure; or policy must keep the live set small enough to always render, making the bound a
constraint on policy design rather than a render-time filter. **This is R-7.**

---

## 5. Evidence bearing on open forks

Informational only. None of these closes a fork; F-1..F-10 remain the user's.

**F-5 (archive as sink vs. substrate).** `turn_set` is stamped at creation and **never updated** — writes
are create-only, never update, never delete (O13, O14, I20). So for any age-derived policy, the derivation
input is monotonic, and the charter's stated condition for keeping the archive a pure sink is satisfied.
Categories whose policy needs anything beyond `turn_set` are not covered by this.

**And there is no external substrate for them to reach for.** I29 establishes engine-wide that
`turn_history` is *"a container for domain-specific surfaces, not a canonical series"* — there is no
engine-wide event log. So a policy needing history beyond `turn_set` cannot source it from an existing
canonical series, because none exists. That pushes such a category toward the packet's own archive as its
only substrate, which is precisely the condition under which F-5 closes toward *substrate* rather than
*sink*. This is the engine-wide facet of I29, distinct from its object-fragmentation facet (which is EX-4).

**F-6 (projection point).** The current call site is `index.js:4474` (O5), the prompt assembles at
`:6089–6229` (O1), the continuity block text archives at `:8283` (O8), the turn pushes to `turn_history` at
`:8345` (O28), the Arbiter runs at `:8558` and back-patches its verdict at `:8691` (O69, O77). Any projection point choice inherits the O77 ordering hazard: state written after
`:8354` does not reach the JSONL for that turn.

**F-7 (bounds and overflow).** Current values are concrete: `STATE_ATTR_WINDOW = 5`, `ENV_ATTR_WINDOW = 20`,
`MOOD_WINDOW = 5` (O17); player attributes uncapped (O19). Measured pressure: 97 stored env facts at one
location (O72); 50 player `state` attrs in a 17-turn save (O72); 25 `physical` + 3 `declared` rendered every
turn at 23 turns (O72). Continuity was ~8% of the narrator prompt at T-10 — 393 of 4,662 tokens (O46), so
budget is not the binding constraint at low turn counts (I13). **All O72 figures carry the corpus tier
caveat recorded in §2** — Observed-by-me, not externally reproducible. The current constants (O17, O19) do
not.

**F-8 (`memory` semantics).** Two in-engine precedents exist. `conditions_archive` + `resolved_turn` is a
working retire-to-archive model (O21). Separately, NarrativeContinuity implemented an eviction-to-memory
tier — `checkEviction` archived `active_continuity` into `narrative_memory[]` with layer label and
provenance — but it evicted on **location change, not truth change** (O48), and the path is vestigial:
`active_continuity` is never populated in the live path and `narrative_memory` receives nothing (O50, I8),
confirmed empty across 1823 saves (O89). A prior "memory tier" design exists and was abandoned; its
trigger semantics are the part worth not repeating.

**F-9 (what counts as new qualifying evidence after retirement).** The ledger holds one directly relevant
precedent, and it cuts both ways. `object_retirements` is a **real CB narration-extraction channel** — a
schema slot, prompt instruction, successor rules covering consumption/destruction, returned by `runPhaseB`
and applied after engine guards (O56). I15 draws the consequence: *"Narration extraction is not
categorically incapable of proposing retirement — it has a dedicated channel for objects and none for
ordinary attributes."*

So retirement evidence for CB assertions is **architecturally precedented but absent**: the mechanism
pattern exists inside CB itself, one channel over. Whether adding an equivalent channel for attributes
would be *extending an existing pattern* or *inventing a mechanic* is a scope judgment, not an evidence
question — and it collides with EX-11 (semantic inference that arbitrary prose has become false), INV-5
(never assert an unrecorded event) and §3.11 (adds no new simulation mechanic). Note also that the ledger
retracted a claim in this exact area: *"Retirement evidence cannot come from narration extraction"* was
over-generalized and false. **This is R-6.**

**Wording narrowed (EV-8).** `object_retirements` is the **only existing invalidation-evidence channel the
ledger identifies anywhere**, and the only precedent for one. It is *not* established to be the only
possible route — a deterministic engine-side invalidation source, or a domain join enabled by a change to
assertion identity, are neither found nor ruled out by the ledger. Earlier wording here and at R-6 said
"the only route," which claimed more than O56/I15 support.

**F-4 (failure behavior).** Existing failure recording is weak in the relevant places: async disk writes
swallow failures via `.catch()` and payload capture is conditional on a well-formed response (O62). INV-8
will need something the current substrate does not provide.

**F-3 (direction of caution).** Per candidate, the asymmetry is uneven. C-2/C-3 currently render forever, so
omit-until-proven-live is a *behavior change* with visible loss. C-1 already vanishes at 5 turns regardless
of truth (I4), so retain-until-proven-dead is the change there. C-5 already permanently displaces (I20).
The "conservative" direction is a different direction for each of them.

---

## 6. Proposed charter amendments

**All six are now ENACTED in the charter (revision 6), on user approval.** A-1, A-4, A-5 and A-6 as written.
A-3 approved in narrowed form: reconciliation applies only to assertions carrying a mechanically resolvable
authority reference, and none is established for any managed category. **A-2 resolved by separation rather
than extension** — §2 now defines *managed continuity fact* and *auxiliary seam content* as distinct kinds,
so the disposition model applies to the first and not the second, instead of stretching one definition over
both. No INV-4 amendment proved necessary: per the narrowed N-6, no-resurrection already holds at exact-key
granularity, and the semantic-granularity gap is now recorded as DEF-1 rather than as a weakened invariant.

The text below is retained as the provenance record of what was proposed and on what basis.

**A-1 — redefine the scoped domain by the call, not by section names.** §2 currently says "the content
presently carried by the CB TRUTH/MOOD rendering seam." O6 shows the call emits three sections. Proposed:
define the scoped domain as the complete return of `assembleContinuityPacket`, whose input set is fixed by
O52. *Basis: O6, O52.*

**A-2 — resolve the definitional mismatch for C-6 and C-8.** §2's "continuity fact" covers accumulated
cross-turn facts; mood is a series and recent-location is single-use (O6, O17). Either extend §2 to name
non-accumulated content inside the seam, or state that those sections are rendered through the packet
without receiving dispositions. *Basis: O6, O17, O57.*

**A-3 — narrow INV-3's demonstration.** As written it requires reconciling accumulated continuity against
live domain state. Per O12 and I3 no CB assertion carries a resolvable reference to those authorities, so
the demonstration cannot be performed for C-1..C-5. Proposed: scope INV-3 to assertions that carry a
resolvable reference, and record that no current category does. *Basis: O12, I3.* **This is the amendment
with the largest consequence — it concedes that domain-precedence reconciliation is aspirational at release
one unless assertion identity changes, and assertion identity cannot change without a storage change (I6).*

**A-4 — reconsider charter §4's attribution of player-condition truth.** §4's table assigns it to Condition
Bot. Per N-5 the ledger describes a shared CB → Condition Bot → index pipeline in which Condition Bot
*"never creates conditions"* (O61), and calls the lifecycle LLM-driven and non-deterministic. Proposed:
either restate the row as the shared pipeline, or record that the packet's condition constraint source is
non-deterministic. *Basis: O61, O23, I5.*

**A-5 — record the evidence-source extensibility constraint (R-EXT).** Release one adds no invalidation
producer, but the architecture must not foreclose one. Proposed as a new invariant so it is testable rather
than aspirational. *Basis: user decision on R-1/R-6; I6, O56, I15 for why the future source is plausible.*

**A-6 — populate §6.2 with its first entry.** §6.2 (out of release one, in-domain, deferred) is currently
empty. R-6 belongs there: excluded from release one, not rejected. *Basis: user decision on R-6.*

---

## 7. Evidence examined and discarded — EV-14

Recorded so omission is auditable. Each line states what was set aside and on what ground.

| Evidence | Disposition | Ground |
|---|---|---|
| Part III in its entirety | Discarded | Declared non-current by the ledger (line 13); "do not quote from it" |
| NPC liveness/death — O63–O66, O76, I18 | Retained as constraint note only | EX-1. Confirms no contract exists to consult; does not create work |
| Location physical state — O83, I26 | Retained as constraint note only | EX-2. Same |
| Quests — O84a, O86, O86b, O86c, O87, O88 | Discarded | EX-5, and user-scoped out at O88 |
| **Freeform promises, debts, favors, alliances, changing role/relation — O84b, I30** | **Discarded, on its own ground** | **EV-5 — an absent mechanic creates an exclusion, not a requirement. "No store found" (O84b). Recorded separately because EX-5 is quest-system repair and does not reach these: O84a states the quest store covers "formal quests only" and names these as having no equivalent. Content of this kind could in principle be promoted into CB's free-text buckets like any other narration, so the exclusion is a decision, not a non-event** |
| `player.inventory` / Authority Gate fall-through — O91, U22 | Discarded | EX-6; handed to issue #60 |
| Arbiter social state — O67, O68, O69, O74, O75, I19, I23 | Discarded | Not in the seam's read set (O52). Archive defects are EV-6 log-not-repair |
| Object audit fragmentation — O81, O81b, O82, O82b, O82c, I25 | Discarded | EX-4 |
| **I29, object-fragmentation facet** | Discarded | EX-4 |
| **I29, engine-wide facet — no canonical event series exists** | **Retained under F-5** | EX-4 covers unification of *object* history surfaces only. The absence of any engine-wide series bears directly on whether a policy can source history externally, which is the F-5 question |
| `turn_history` vs JSONL divergence — O77 | **Retained** as N-3 and under F-6 | Constrains where the packet may archive; not repaired here (EV-6) |
| NarrativeContinuity vestigial path — O48–O53, I8, I9, I10 | Partly retained under F-8 | Memory-tier precedent is load-bearing for F-8; the rest is vestigial |
| `npc.narrative_state` legacy merge — O80 | Retained as boundary evidence only | Live code, no current producer; outside the seam |
| Object retirement mechanics — O30–O39, O56, O59, I7, I15, I17 | Retained as §3 constraint-source evidence | `object` bucket already excluded from TRUTH (O20), so not category evidence |
| Dead/empty containers — O89 | Discarded | Informational; none is in the seam's read set. *(I31's taxonomy is retained separately below — it is a method finding, not container evidence)* |
| **O90 denominator caveat — 1006/1823 saves are 1-turn, 422 are 2-turn, 246 exceed 3 turns** | **Retained as a method constraint** | Not a read-set question. It governs how much weight corpus-**negative** findings carry — including O87 and O91, which this document cites as confirming EX-5 and EX-6. The ledger's own most recent correction was this exact error: "thinly exercised" was concluded from a wrong denominator and overturned |
| **Reproducibility tier — O70–O72, O74–O76 are Observed-by-me against the local corpus and were not reproducible by the ledger's external auditor** | **Retained as a method constraint** | Bears on EV-9 and on the G-8/G-10 external-audit gates, which cannot re-verify corpus measurements. Applied inline at C-2/C-3 and F-7 |
| Spatial relations — U12 | Discarded | No promotion path; not persistent continuity |
| Object condition history route — O78 | Retained as boundary evidence only | Outside the seam; ORS-adjacent authority renders it independently |
| Player conditions route — O79 | Retained as constraint source (§3) | Outside the seam; charter §4 assigns it to Condition Bot |
| Prompt-size measurements — O46, I13 | Retained under F-7 | Bears on bounds |
| Ledger's own failure-mode analysis (over-generalization, absence-as-evidence, schema-from-one-instance) | **Retained as a method constraint on this artifact** | Directly relevant to EV-7 and EV-8 |
| **I31 — the five-category taxonomy: source existence ≠ integration ≠ exercise** | **Retained as a method constraint** | Applied here to quests and to freeform obligations; any future "it exists in source" claim about a domain must be classified under it before being weighted (EV-7, EV-9) |

**Open uncertainties inherited, not resolved:** U8 (writers of object `status` beyond ObjectHelper), U11
(no genuinely pre-CB save located), U13 (`cbpanel.js` / `flight-recorder.js` read paths), U15
(`ObjectOperationResolver.js` uninspected), U16 (**identity lifecycle — bears directly on C-7**). Only U16
touches a candidate category.

---

## 8. Reserved decisions requiring an answer

### 8.1 Decisions taken — recorded 2026-08-03

**R-1 — CLOSED. The release-one existing-data ceiling is accepted.** For C-1..C-5 no invalidation evidence
exists anywhere (I27) and validity cannot be mechanically determined (I3). Release one therefore delivers
*identified, explicit, reasoned, archived, bounded* selection, not better knowledge of truth. **No new
invalidation producer is added.**

**R-6 — CLOSED. The attribute-retirement extraction channel is excluded from release one.** Excluded, not
rejected: it is preserved as separate durable future work under the working name **CB Attribute
Invalidation Evidence Contract**. Nothing in release one may be designed as though that work will never
happen, and nothing in release one may design it. Basis for the sequencing: objects have a workable
retirement channel because they carry stable ids, a successor relationship, engine guards that can refuse,
and archived refusal reasons (O30, O32, O36, O38, O59, O82). CB assertions have none of these, and semantic
identity requires a storage change (I6). Building it first would move category policy, no-resurrection,
archive design, input schema and the upstream boundary — after the plan depends on them.

**R-EXT — NEW CONSTRAINT, recorded. Evidence-source extensibility.** Release one creates no invalidation
producer, but the projector must accept future explicit replacement or retirement evidence through a clean
input boundary **without redesigning packet construction, archiving, or rendering**. Concretely: `turn_set`
must not be hard-coded as the only lifecycle evidence the projector can understand. The future channel's
schema is **not** specified here and must not be designed in this plan. Proposed as amendment A-5.

**R-7 — CLOSED. Third resolution: there is no live-but-unrendered state.** Each category policy produces a
**bounded live set** before rendering. The renderer renders every live fact and may not independently
truncate one. Anything outside the live set receives an explicit non-live disposition and archived reason
under policy. The bound is part of the truth rule, not a view over it. Enacted as the replacement INV-7.
*Consequence for policy design:* a category's bound is now a policy obligation, not a render-time safety
net — C-2/C-3, which currently have no bound at all, must acquire one at the policy layer.

**R-2a — CLOSED. Category treatments assigned.**

| Candidate | Treatment |
|---|---|
| C-1 player `state`, C-2 player `physical`, C-3 player `declared`, C-4 NPC attributes, C-5 location/env attributes | **Managed continuity facts** — receive new disposition policies |
| C-6 mood, C-8 recent location | **Auxiliary seam content** — carried through the new packet, no live/memory/retired disposition |
| C-7 player identity | **Carried, no new lifecycle policy in release one.** Its actual rendering behavior must be **verified and preserved** — see V-1 |

**R-2b — CLOSED. Every seam input is accounted for, with no silent deletion.** Enacted as INV-15. The
assembler's six inputs and three emitted sections each map to exactly one recorded treatment above.

**R-3 — CLOSED. RECENT LOCATION is inside replacement scope but outside disposition scope.** It is carried
as auxiliary seam content. The distinction the charter previously lacked now exists in §2.

**V-1 — verification obligation carried forward.** No ledger observation establishes which rendered section
`player.identity` populates, or whether it is rendered as visible text at all versus read for internal use.
"Preserve C-7's rendering behavior" therefore cannot be discharged from the ledger — it requires source
verification before any requirement depends on it. Recorded here so it survives the context boundary.

### 8.2 Decisions formerly required — ALL NOW CLOSED

R-5, R-8 and R-9 were closed by user approval on 2026-08-03; the outcome is §10. The text below is retained
as the provenance record of what was asked and why. **G-6 is complete.**

*Context carried forward from the closed R-2a, because it bears on the direction-of-caution decisions below:*
C-5's "97 stored / ≥77 displaced" is a **single-save measurement** from one 23-turn session (O72), not a
corpus statistic. Read with the O90 denominator caveat, that cuts *toward* concern rather than away from it:
1006 of 1823 saves are single-turn and the longest is 27 turns, so the observed accumulation reflects short
play and plausibly **understates** what long sessions would produce. It is not evidence that 97 is typical;
it is evidence that 97 is reachable by turn 23.


**R-4 — CLOSED.** A-2 resolved by separation, A-3 approved narrowed, both enacted. No INV-4 amendment needed.

**R-5 — per-category policy (D-2 / F-2) and direction of caution (D-3 / F-3), for C-1 through C-5.** These
now close together, because under the new INV-7 a category's bound is part of its policy rather than a
render-time filter. For each managed category: the disposition rule, the bound on its live set, and the
direction policy errs when lifecycle evidence is absent. Per §5 F-3 the conservative direction differs by
category, and for C-2/C-3 either direction is a visible behavior change.

**R-8 — `memory` semantics (F-8).** Now blocking, because R-7 made non-live dispositions load-bearing: every
fact outside a bounded live set must land in an explicit non-live state, so what `memory` *is* — and how it
differs from `retired` in what the narrator can see — determines what those facts become. The two in-engine
precedents are in §5 F-8.

**R-9 — the remaining forks**, which do not block G-6 individually but must be closed before G-7 drafting:
F-4 packet failure behavior, F-5 archive-as-substrate per category, F-6 projection point, F-9 qualifying
evidence within existing data, F-10 whether shadow comparison is a gate.


---

## 9. Audit record

Two independent Sonnet auditors, per charter G-8 practice. Neither authored this document. The omission
auditor read the charter and full ledger and committed its own load-bearing-evidence list to disk **before**
being permitted to open this document, so its findings are not anchored on this framing.

| Audit | File | Result |
|---|---|---|
| Claim traceability and scope-widening | `AUDIT_PLAN_INPUTS_TRACEABILITY.md` | 82 supported / 4 widened / 2 miscited / 2 uncited / 0 fabricated citations |
| Omission direction | `AUDIT_PLAN_INPUTS_OMISSION.md` | 5 findings; no unsupported assertions found |

Every finding was independently re-verified against the ledger before acceptance (EV-9). All eleven were
accepted; two were accepted in narrower form than reported, recorded below as required by EV-8.

| # | Finding | Verification | Disposition |
|---|---|---|---|
| T-1 | Player bucket list stated as enumerated; O72 shows four sampled saves | Confirmed — no observation enumerates the bucket vocabulary | Accepted. §2 gap widened; gap is larger than originally written |
| T-2 | "No reference to any object/condition/NPC id" miscited to O12 | Confirmed — O12 gives identity-is-content; record shape is O11 | Accepted. §3 rewritten to lead on I3, with the shape claim scoped to the written record and the absolute form explicitly not asserted |
| T-3 | "Both authorities are LLM-driven" implies ORS is | Confirmed — O61's "both" is CB extraction + Condition Bot; I7 makes ORS application guard-based | Accepted. §3 split into two precise statements |
| T-4 | C-7 assigned to the TRUTH section without citation | Confirmed — O52 gives the read, O6 gives the sections, nothing maps one to the other | Accepted. Marked unestablished; recorded as a second gap |
| T-5 | §4 "Condition Bot owns player conditions" listed as Confirmed | Confirmed — ledger calls it a shared pipeline; Condition Bot never creates conditions | Accepted. Moved from Confirmed to narrowing N-5; raised as amendment A-4 |
| T-6 | F-6 line numbers cited to the wrong observations | Confirmed — `:8283` is O8, `:8345` is O28 | Accepted. Citations corrected |
| O-1 | Freeform obligations absent; I30 bundled under EX-5 | Confirmed — O84a scopes quests to "formal quests only" and names these as separate | Accepted. Own row, ground EV-5 |
| O-2 | F-9 unaddressed despite O56/I15 | Confirmed, and more consequential than reported | Accepted. F-9 section added; escalated to reserved decision R-6 |
| O-3 | I29 discarded wholly under EX-4 | Confirmed — EX-4 reaches only the object facet | Accepted. Row split; engine-wide facet retained under F-5 |
| O-4 | O90 corpus-skew caveat discarded on read-set grounds | Confirmed, **narrowed on acceptance** — auditor tied it to O72; O72's figures are per-save with stated turn counts, so the denominator does not weaken them. Accepted only as it bears on corpus-**negative** claims (O87, O91) | Accepted in narrowed form |
| O-5 | Reproducibility tier never marked | Confirmed, **narrowed on acceptance** — the structural claim for C-2/C-3 rests on O17/O19, which are source-read and externally checkable; only the magnitude depends on the corpus | Accepted in narrowed form |

### Reconciliation against the raw audit files

The eleven dispositions above were first recorded against the auditors' completion summaries. They were
then re-run against the **raw audit files**, which are preserved unchanged. All eleven findings and all
eleven dispositions survived that check unaltered. Three items surfaced in the raw files that the summaries
did not carry:

| # | Item | Verification | Disposition |
|---|---|---|---|
| X-1 | The two auditors **disagree** about §7's quests row. The traceability auditor rated all 17 discard rows SUPPORTED, including that one. The omission auditor rated its ground wrong for the freeform-obligations evidence bundled under it. | Adjudicated against the ledger: O84a scopes the quest store to *"formal quests only"* and names freeform promises, debts, favors, alliances as having no equivalent. EX-5 is quest-system repair and does not reach them | **Omission auditor upheld.** The two checked different things — whether the ground matches the ledger, versus whether the ground covers everything filed under it. Only the second catches this |
| X-2 | I6's consequence for invariant feasibility appears in the omission auditor's independent phase-3 list but was scored CARRIED and never raised as a finding. It claims INV-1, INV-4 and INV-12 are all threatened for CB categories absent a storage change | Verified I6 states the storage-change requirement. **Rejected in part:** content keys are deterministic, so INV-1 is not threatened; dispositions can attach to content-keyed facts, so INV-12 is not either. Only the sameness-across-time claim needs identity | **Accepted narrowed to INV-4 only.** Added as N-6 with the rejection of the INV-1/INV-12 half recorded inline |
| X-3 | I31's taxonomy was applied in substance but never named | Confirmed — reasoning consistent with I31 appears in the quests and obligations treatment, but the taxonomy itself was uncited | **Accepted.** Added to §7 as a method constraint |

**Also recorded from the raw files, requiring no change:**

- The traceability auditor independently flagged the reproducibility gap at its §4 cross-check but
  deliberately declined to score it, since no claim's *content* was overstated by the omission. It reached
  the same place as omission finding O-5 by a different route — independent corroboration, not a second
  finding.
- Positive verifications worth preserving: the O72 non-execution caveat was carried forward in its narrowed
  form rather than reverting to the stronger original; I27's coverage split was not flattened into a blanket
  "no birth record"; and T-1 kept "no invalidation evidence" (I27) distinct from "cannot be mechanically
  determined" (I3) rather than collapsing them.
- The omission auditor's independent pre-read confirms the scoping of player conditions as a constraint
  source rather than a candidate category: *"a plan that treats it as informational-only is correct; one
  that treats it as a candidate category is wrong."*

### External review pass — verified against the ledger

A fourth set of findings arrived as external review, treated as claims to verify rather than authority.

| # | Finding | Verification | Disposition |
|---|---|---|---|
| E-1 | R-6/F-9's "the only route" over-claims | Confirmed — O56/I15 establish the only *existing* channel and the only precedent; they do not rule out a deterministic engine-side source or a domain join enabled by changed identity | **Accepted.** Narrowed at both sites |
| E-2 | N-6 over-claims: stable identity is needed for same-fact-across-changed-wording, not for exact-key no-resurrection | Confirmed against I6's own wording — *"any change to a fact's text creates a new key rather than a new version"* — and O13, where an unchanged key is already detected as a recurrence | **Accepted.** N-6 narrowed a second time. Worth naming: I had already narrowed the auditor's version of this and still left it too broad |
| E-3 | The distinction between the complete disposition set and the bounded render is unresolved | Confirmed — INV-12 (complete), INV-7 (bounded) and channel closure (omission is consequential) cannot all hold as written once more facts are live than the bound admits | **Accepted.** Added as T-3 and reserved decision R-7. **Neither audit could have caught this** — it is a charter-internal contradiction, not a mis-citation, and both audits were scoped to document-vs-ledger |
| E-4 | R-2 conflates two questions | Confirmed — O52's six inputs and O6's three sections must all be accounted for under INV-10 and channel closure, independent of which become categories | **Accepted.** Split into R-2a and R-2b |

### Not verified by either audit

Both audits were **document-to-document against the ledger**. Neither re-verified the ledger against live
source; both say so explicitly. Every claim in this document therefore inherits the ledger's evidentiary
status, and source verification remains owed at G-8 per EV-9. The corpus-derived figures (O70–O76, O89–O94)
sit at a lower tier still — not reproducible by any auditor without the local save corpus.

---

## 10. Approved release-one specification — G-6 outcome

Approved 2026-08-03. This section and §11 are the planning input that crosses the context boundary.

### 10.1 Content classification

Every element of the scoped domain falls into exactly one class.

| Class | Members | Disposition? | On projector failure |
|---|---|---|---|
| **Managed continuity** | C-1 … C-5 | Yes | **Last-good replay**, with durable failure record |
| **Auxiliary seam content** | C-6 mood, C-8 recent location | No | **Omit** |
| **Current-state authority passthrough** | C-7 player identity, Arbiter recognition suffix | No | **Omit — never stale-replay** |

Recognition suffix: the Arbiter remains the source of truth; the projector carries and formats it only.

### 10.2 Category matrix

**All numeric bounds are provisional release-one constants, to be validated through shadow comparison.
None is evidence-established.**

| | C-1 `state` | C-2 `physical` | C-3 `declared` | C-4 NPC attrs | C-5 location/env |
|---|---|---|---|---|---|
| **Live set** | age ≤5 **and** top-10 by `turn_set` | top-12 | top-8 | top-20 for the single visible NPC | top-20, then dedup within |
| **Category bound** | 10 | 12 | 8 | 20 | ≤20 |
| **Terminal horizon** | **age > 20** — the only category with one | none | none | none | none |
| **Overflow →** | memory | memory | memory | memory | memory |
| **Retired reachable?** | yes, by age only | no | no | no | no |
| **Direction of caution** | omit-lean | retain-lean | retain-lean | omit-lean | omit-lean |
| **History as input** | no | no | no | no | no |
| **Visible change** | minimal | items past 12 stop rendering — the one real loss | minimal | none | **none** |

**C-5 mechanics.** Rank top-20, dedup *within* those 20, mark collapsed entries `memory` with reason
`duplicate_suppressed`, **no backfill**. Output is identical to current behavior. Dedup-before-ranking with
backfill would also satisfy INV-7 but is a deliberate behavior change and was not chosen.

**C-4 bound is contract-dependent, not projector-enforced.** See §11.4. No multi-NPC selection behavior is
defined; an unsupported multiple-visible-NPC state is recorded diagnostically, never normalized.

### 10.3 Dispositions

**live** — inside the bound; rendered in full; the renderer may not drop one.
**memory** — displaced by capacity; asserts nothing about ending or falsity.
**retired** — policy expiry; stops carrying the fact forward without claiming an observed ending.

**No reinstatement path exists in release one**, for any category. This is forced by evidence, not chosen —
see §11.3.

### 10.4 Closed forks

| Fork | Resolution |
|---|---|
| F-2 policy | The matrix above |
| F-3 direction | Omit-lean C-1/C-4/C-5; retain-lean C-2/C-3 |
| F-4 failure | Three-class taxonomy (§10.1) |
| F-5 archive | **Sink for all five.** No policy needs more than `turn_set`, and no recurrence evidence exists to accumulate |
| F-6 projection point | **The existing call site**, unchanged |
| F-7 bounds | Per §10.2, provisional |
| F-8 `memory` | Per §10.3 |
| F-9 qualifying evidence | **None exists** — source-verified, §11.3 |
| F-10 shadow | **Mandatory cutover gate** |

---

## 11. Source-verification findings — V-1 … V-5

Narrow, verification-scoped reads only. No plan drafted, no source modified.

### 11.1 V-1 — player identity renders in TRUTH

`ContinuityBrain.js:1960` pushes a `Player: …` line into the TRUTH block, built at `:1954–1959` from
`identity.{canonical_name, title_or_role, current_form, last_known_form}`, with `current_form ||
last_known_form` fallback. C-7's rendering behavior is now a verified, concrete preservation target.

### 11.2 V-2 / V-3 — NPC selection scope and bucket vocabulary

The 20-slice is **per NPC** (`:1966` loop, `:1969–1974`). NPC bucket vocabulary is **`physical` and
`state`** — the only writer to `npc.attributes[key]` in the repo is `:1129`, promoting exactly those two
buckets (`:1138`, `:1139`). The `bucket !== 'object'` filter at `:1970` is defensive; no current writer
produces an `object` bucket on an NPC. Player writers produce `physical`, `state` (`:1193`) and `declared`
(`:1757`, `:1773`); location is always `environment` (`:1162`). The `object` player bucket observed in saves
has no writer matching the grep — origin unestablished, and it renders nowhere.

### 11.3 V-4 — no qualifying evidence exists

The three `duplicate_silenced_summary` writers — `ContinuityBrain.js:1142` (NPC), `:1169` (location),
`:1208` (player) — emit `{ action, entity_type, entity_id, entity_name, count_by_bucket, total, turn }`.
**They carry no `attribute` field.** Only `create` entries (`:1130`, `:1163`, `:1194`) carry `attribute: key`.
The counter increments over *proposed* items (`:1132`, `:1165`, `:1196`), which are never logged when they
duplicate, so a count cannot be matched to a stored key. `_dupCounts` is function-local and reset per call
(`:1113`, `:1148`, `:1178`), so no cumulative per-key value exists anywhere.

**Consequence:** `world.promotion_log` cannot establish an exact key's latest evidenced turn. Age remains
**time since first assertion**, not time since last mentioned. Retirement has no reinstatement rule.

### 11.4 V-5 — assembler enumeration

**O52's six-input read set is incomplete.** The actual set is approximately fourteen read groups plus four
writes. INV-15's accounting must be built from this enumeration.

**Reads.** `world.{active_local_space, active_site, position, mood_history, _lastPhaseBLoc, _visible_npcs}` ·
`_getL0CellRecord(gameState)` (helper) · `locRecord.{name, attributes}` · `player.attributes` ·
`player.identity.{canonical_name, title_or_role, current_form, last_known_form}` ·
**`gameState.turn_history.length`** (`:1937`) · per-NPC `{id, npc_name, is_learned, job_category,
attributes, player_recognition}` · mood snapshot `{location_key, tone, tension_level, tension_direction,
conversational_state, scene_focus, delta_note, turn}` · `_lastPhaseBLoc.{locationRef, features}` ·
`turnContext.turn` · `_toCanonicalEnv` (helper).

**Writes and side effects — the current assembler is not pure.**

| Site | Effect | Treatment |
|---|---|---|
| `:1935`, `:1943` | `turnContext.stateAttrsSuppressed` | Diagnostic passback; permitted under INV-6 |
| `:1952`, `:1961` | `gameState._lastIdentityTruthLine` | **Preservation obligation** — see below |
| `:2103` | `w._lastPhaseBLoc = null` | **Now transactional** under INV-16 |
| `:2029` | `console.log('[CB-DEDUP]…')` | Diagnostic |

**`_lastIdentityTruthLine` is a preservation obligation, not residue.** Read at `index.js:8731` and archived
per turn as `last_identity_truth_line`; surfaced in `motherbrain.js:144`. It must continue to be produced.

**Transactional consumption, recorded.** `_lastPhaseBLoc` is cleared **only after** successful packet
construction and durable archival. On failure the content is omitted from output and left **pending** for
the following turn. Current code clears unconditionally at the end of assembly (`:2103`).

**Determinism note.** Age math derives the current turn from `turn_history.length` (`:1937`), not from a
turn counter. Any future trimming of `turn_history` would silently shift every age-based disposition.

### 11.5 Recorded engine-contract dependencies and preservation items

**C-4's bound depends on a world-state contract, not on projector logic.** At most one NPC occupies a tile
in the current engine. `visible` is read at `:1926` as `(loc && loc._visible_npcs) || w._visible_npcs || []`.
Writers route through `computeVisibleNpcs` (capped at 5, `ActionProcessor.js:1455`, `:1470`) **except**
`index.js:4460`, `:6627`, `:7901`, which filter `world.npcs` by exact cell position with **no slice**
(verified at `index.js:4460–4463`). The expression therefore permits an unbounded list; the engine contract
never produces one. C-1/C-2/C-3/C-5 bound themselves inside the projector — **C-4 does not.**

*Consequence for the future:* multi-NPC occupancy is a planned expansion outside this project. When it
arrives, C-4 is the first place continuity stops satisfying INV-7, and the INV-17 diagnostic is the tripwire.

**Founding-friend L0 path — do not remove.** NPCs ordinarily do not spawn at L0; the founding prompt may
validly create one friend there on turn 1, and that behavior works and must not be altered. `:1926`'s
`w._visible_npcs` fallback is that route. Anyone simplifying the L0 branch out of the projector or its
inputs breaks working behavior.
