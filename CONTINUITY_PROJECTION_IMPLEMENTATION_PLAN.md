# Continuity Projection — Implementation Plan

**Stage:** G-9 deliverable. **Status: G-10 PASSED.** Audited against the charter, the requirements, the
research ledger, and source at `a856c99` by a reviewer that did not author it. **Coding authorization for
Phases 1–3 was given and executed** — see revision 7. Committed as `e7b51bf` on branch
`continuity-projection-shadow`. Six defects found in a post-implementation follow-up review are fixed;
see revision 7. **Both Phase 4 preconditions from §7's gate are now satisfied**: forced-overflow evidence
exists for C-1 through C-5 against real and realistically-constructed data with both `compatEqual` and
`structural.approved` holding throughout (R-27 properties 3–4, S-P3/S-10 discharged), and the user has
read real before-and-after `compat`/`live` output and accepted the 10/12/8 bounds (R-27 human judgment).
**Phase 4 cutover itself remains unauthorized** — satisfying the gate's preconditions is not the separate,
explicit authorization §7 requires, and that has not been given.
**Governs:** how the subsystem is built. **Does not govern:** what it must do — that is
`CONTINUITY_PROJECTION_REQUIREMENTS.md`, which this plan is subordinate to. Where this plan and the
requirements disagree, the requirements win and this plan is defective.

**Charter state:** amendments 1–4 (revision 8) and the INV-15 reconciliation (revision 9) are **enacted**.
S-3 is discharged.

**Source state — the evidence baseline this plan was audited against, not the branch to operate on now.**
Branch `main`, HEAD `a856c99`, at the time of the G-10 audit. Implementation happened on
`continuity-projection-shadow`, which shared that same commit at the point coding began; current work is
at `e7b51bf` on that branch — see the status line above. Requirement IDs (R-n), fact IDs (F-n), and verification
IDs (V-n) refer to the requirements document and are not restated here.

---

## 1. Decisions this plan closes

The requirements deliberately left six things to G-9. This plan closes exactly these and nothing else.

| # | Decision | Resolution |
|---|---|---|
| 1 | File name and location | `ContinuityProjector.js` at repository root |
| 2 | Interface shape | Four exports; one entry point that never throws (§3) |
| 3 | Packet data structure | §4 |
| 4 | Archive record schema and placement | §5 |
| 5 | Ordering of integration changes | Five phases, §7 |
| 6 | Shadow-mode mechanism | Read-only projector run *before* the live assembler, §6 |

Anything not on this list was settled earlier. If implementation appears to require a seventh decision,
that is stop condition **S-P4**.

---

## 2. Target file

`ContinuityProjector.js`, repository root — matching the convention of `ContinuityBrain.js`,
`ObjectHelper.js`, `ActionProcessor.js`. Required in `index.js` as `const CP = require('./ContinuityProjector');`
alongside the existing `const CB = require('./ContinuityBrain');` at `index.js:36`.

**Everything in R-1's list lives here:** selection, category policy, bounds, dispositions, reasons,
classification, render, failure handling, and the single-use clear.

**The file was not on the high-risk list** because it did not exist when that list was drawn up. It has
since been created (revision 7) and become the owner of logic formerly inside a high-risk file, which is
the point of INV-13. It carries no such designation of its own in the coding-agent constitution; that
remains a standing gap, not a decision made here.

---

## 3. Interface

Four exports. No others.

```
PROJECTOR_VERSION      string   // '1.0.0' at first release; semver, owned by this file alone
project(gameState, turnContext, options)  -> projection
renderPacket(packet, options)             -> string
compareToBaseline(packet, baselineString) -> report
```

### 3.1 `project(gameState, turnContext, options)`

The single entry point. **It never throws.** Any error inside packet construction is caught, converted
into a failure projection per R-19, and returned. This is what satisfies "the failure does not abort the
turn" without `index.js` acquiring failure-policy logic, which INV-13 forbids.

`options`:

| Field | Effect |
|---|---|
| `shadow: true` | **Suppresses all writes** — no single-use clear, no identity breadcrumb, no diagnostic passback, no console dedup line. Required for §6 |

Returns:

```
{
  rendered:  string        // never null — R-17, F-23
  packet:    object|null   // null only when construction failed before a packet existed
  failure:   object|null   // R-19 failure record, or null on success
}
```

### 3.2 `renderPacket(packet, options) -> string`

**Pure.** Same packet and options in, same string out, no reads of `gameState`, no writes anywhere. Three
callers need this property: the live path, shadow comparison (§6), and last-good replay (§8). If render
needed live state, none would be sound.

`options.mode` is `'live'` (default) or `'compat'`. Compat renders the same packet under the **old**
selection rules and exists solely so the gate can be decided by byte equality instead of by parsing —
see §6.

### 3.3 `compareToBaseline(packet, baselineString) -> report`

The shadow comparator, §6. It lives here rather than in `index.js` because deciding whether a difference
is approved is classification logic, which R-1 confines to this file. `index.js` calls it and logs the
result; that is invocation, which R-2 permits.

**Two contracts, both required. Purity is not enough:**

- **Pure** — no reads of `gameState`, no writes anywhere.
- **Total — it never throws, for any input.** It must accept `packet: null`, which `project()` returns
  after an early construction failure, and it must contain any error raised by the compat render. A
  comparator that throws would reach the outer handler at `index.js:8736`, emit `narrator_error`, and
  abort the turn — which contradicts Phase 2's "no behavior change" and R-19's guarantee that projector
  failure does not abort the turn. **A diagnostic must never be able to take down narration.**

On `packet: null` or an internal error it returns a report with `compatEqual: false` and an `error`
string, never an exception.

### 3.4 What the interface deliberately does not expose

No per-category selector, no policy object, no disposition helper. Exporting them would let a future
caller assemble a packet outside `project()`, which is how INV-11's fixed projection point erodes.
`compareToBaseline` is not such a hole: it **consumes** a finished packet and cannot produce one.

---

## 4. Packet structure

One object, fully serializable, no functions, no live references into `gameState`. Serializability is
load-bearing: the packet is archived (§5) and read back as last-good (§8).

```
{
  version:    PROJECTOR_VERSION,
  turn:       <integer>,              // R-7: turn_history.length + 1
  scene: {                            // R-19 axis-5 eligibility, §8
    locationKey:    <string|null>,
    visibleNpcIds:  [<string>]        // sorted, for stable comparison
  },
  entries: [ <entry> ],               // every classified element, in render order
  framing: [ <framing> ],             // R-8 framing, emitted unconditionally
  diagnostics: {
    stateAttrsSuppressed: <int>,      // R-20: age-rule exclusions ONLY
    boundExclusions:      { c1:<int>, c2:<int>, c3:<int>, c4:<int>, c5:<int> },
    dedupCollapsed:       <int>,
    visibleNpcCount:      <int>,      // R-31 contract tripwire
    droppedCount:         <int>       // count only; the drops themselves are entries
  },
  identityLine: <string|null>         // R-33; the verbatim Player: line or null
}
```

**`entry`** — one per classified element:

```
{
  class:       'managed' | 'auxiliary' | 'passthrough' | 'dropped',
  category:    'C-1'…'C-8' | 'identity' | 'recognition' | 'label' | 'npc-absence' | 'mood-absence'
               | null,        // null is REQUIRED for 'dropped' — see below
  subjectKey:  <string|null>,   // npc id, location key, or null for player/global
  key:         <string|null>,   // the attribute key, for managed and dropped entries
  value:       <string>,
  bucket:      <string|null>,
  turnSet:     <int|null>,
  disposition: 'live' | 'memory' | 'retired' | null,   // null for non-managed — R-8
  rendered:    <bool>,           // false for 'dropped' and for non-live managed entries
  reason:      <string>          // required for every entry, including live — R-23
}
```

**Two additive fields, beyond what this section originally specified — ruled by the user during the G-10
follow-up review (post-implementation, source re-verified against the corrected file), not an
implementation liberty exercised without authorization:**

```
  renderedCompat: <bool>,        // inclusion in the 'compat' render — mirrors `rendered`, which is 'live'
  lineKey:        <string>       // which output line this entry composes
```

§6 requires two renders — `'live'` and `'compat'` — over **one** packet, and the schema above as
originally written carried no mode information and no line grouping. `lineKey` is required rather than
optional because a dropped entry carries `category: null` (below) and would otherwise have no way to be
routed to a line at all. Neither field changes a classification, a disposition, a reason, or a bound —
render-support only. See revision 7.

**`class: 'dropped'` carries the fifth INV-15 treatment.** A dropped element never reaches output, but
INV-15 requires it be accounted for, and the accounting has to live somewhere inspectable. Dropped
entries carry `rendered: false`.

**The verified vocabulary is per path, not global** (F-31):

| Path | Verified buckets |
|---|---|
| Player | `physical`, `state`, `declared` |
| NPC | `physical`, `state` |
| Location | `environment` |

**One general rule, one exception.**

- **General — any attribute outside its path's verified vocabulary** → `unrecognized_bucket`. **Compat
  includes it; live excludes and records it.** This is an approved shadow difference (R-10, R-27). It
  holds because the existing filters are **exclusions, not allowlists**: player and NPC filter only
  `bucket !== 'object'` (`:1933`, `:1970`) and the location path filters nothing at all (`:1997`), so an
  attribute in an unheard-of bucket renders today on every path.
- **Exception — player or NPC `object`** → `bucket_excluded_by_policy`. **Excluded from both compat and
  live**, producing **no** shadow difference, because the current assembler already excludes it there.

Concretely:

| Attribute | Reason | Compat | Live | Shadow |
|---|---|---|---|---|
| Player or NPC, bucket `object` | `bucket_excluded_by_policy` | Excluded | Excluded | **No difference** |
| Player or NPC, any other unverified bucket | `unrecognized_bucket` | **Included** | Excluded | Approved difference |
| Location, any bucket other than `environment` — **including `object`** | `unrecognized_bucket` | **Included** | Excluded | Approved difference |

**Two traps this closes.** The `object` exception is **path-scoped**: the location path has no historical
`object` filter to preserve, so dropping it there in compat would omit what the baseline emits, break
byte equality, and silently change C-5. And the vocabulary is **per path**: `declared` is verified for
the player but not for an NPC, so an NPC attribute in that bucket takes the general rule, not a pass.

X-10 protects the **existing filters**, which are player and NPC only. There is no location filter to
protect, and no filter anywhere for buckets other than `object`.

**A dropped entry carries `category: null`, and this is required rather than permitted.** R-10 states
that an out-of-vocabulary attribute *belongs to no category*, so assigning it one would be a false
record — and the player/NPC `object` bucket is likewise outside the candidate list entirely, recorded as
a non-candidate before any category existed. The bucket is recorded
in the entry's `bucket` field and the reason distinguishes the two drop routes; neither needs a category,
and inventing one would make the archive assert a classification the requirements deny.

**Reason vocabulary** — closed set. A reason outside it is a defect, not a free-text field:

| Reason | Class | Disposition |
|---|---|---|
| `in_bound` | managed | `live` |
| `age_within_window` | managed | `live` |
| `overflow_capacity` | managed | `memory` |
| `duplicate_suppressed` | managed | `memory` |
| **`age_beyond_window`** | managed | `memory` |
| `age_beyond_horizon` | managed | `retired` |
| `carried_auxiliary` | auxiliary | `null` |
| `carried_passthrough` | passthrough | `null` |
| **`bucket_excluded_by_policy`** | dropped | `null` |
| **`unrecognized_bucket`** | dropped | `null` |

**`in_bound` vs `age_within_window` on C-1 — settled, G-10 follow-up review.** Both carry disposition
`live`, and the table alone does not say which a given surviving C-1 fact takes. A numeric `turn_set`
that was actually **tested** against the age window and passed takes `age_within_window` — the test was
run and the fact is within it. A **null or absent `turn_set`** is **exempt** from that test (F-6, U-9) —
it was never measured against the window, so calling it "within" the window would assert an evaluation
that never happened. It takes `in_bound` instead: the bound that genuinely applied to it (the top-10
count, alongside C-2/C-3) is the one it survived. This closes the one C-1 sub-case the reason table left
implicit; it changes no disposition, no age-exemption behavior (U-9 is unaffected), and no ranking (R-6's
null-last rule is unchanged).

**`age_beyond_window` — settled, charter revision 10.** C-1 is live at age ≤5 and retired past age 20;
the approved matrix assigned nothing to ages 6–20, and the disposition set is closed, so those facts had
no available verdict.

G-10 established that this could not be closed by elimination. The charter's prior wording — `memory` is
"displaced by capacity … records only that the bound ran out" — is definitional, and no bound ran out for
a fact that merely aged past a window, so routing them into `memory` widened the disposition rather than
applying it. That is an amendment, not an inference, and G-9 may not make one.

**The user enacted it: charter revision 10 broadens `memory`** to cover displacement from the live set
without a terminal verdict, by either a capacity bound or a non-terminal age window. Its guarantee is
unchanged — it asserts nothing about ending or falsity. `age_beyond_window` is therefore a valid reason
carrying disposition `memory`, and V-09 covers C-1's 6–20 band with no special case.

**`framing`** — `{ text, position }`. Framing carries no class, no disposition, and no reason (R-8), but
appears here so R-24's accounting can enumerate it and V-32 can check it.

**Order.** `entries` is stored in **render order**, so `renderPacket` performs no sorting. All ordering
decisions happen once, during build, under R-6 and R-18 — including C-5's first-appearance order with an
in-place replaced survivor (F-11). A renderer that sorts is a defect: V-23.

---

## 5. Archive record and placement

**Schema — an envelope, not the packet itself:**

```
turnObject.continuity_packet = {
  ok:      <bool>,             // true only when construction AND render succeeded
  packet:  <packet|null>,      // §4; null when construction failed before a packet existed
  failure: <record|null>       // §8; null when ok
}
```

**The envelope exists because the packet can be `null`.** `project()` returns `packet: null` on an early
construction failure, and a failure record has to attach somewhere — it cannot hang off a null. The
envelope also gives last-good replay a single field to test (`ok`) rather than inferring success from the
presence of a key.

The packet inside is stored exactly as §4 — no transformation, no summary. INV-2 requires the reason for
every disposition to be recoverable, and a summarized archive cannot deliver that.

**Placement:** a new key `continuity_packet` on `turnObject`, a **sibling of `narration_debug`**, not
nested inside it. `narration_debug` is a debug surface; the packet is the inspectability substrate INV-2
depends on, and burying it under a debug key invites future trimming.

**Site:** inside the `turnObject` literal that opens near `index.js:8262`, before the push at `:8345`.

**Why there and not later:** F-27 — the flight-recorder JSONL is serialized at `:8349` from `turnObject`.
Any key added after that point is absent from the JSONL for that turn, exactly as `arbiter_verdict` is.
Adding the packet inside the literal puts it in both `turn_history` and the JSONL. This satisfies R-26.

**Retention:** none added. The packet inherits `turn_history`'s unbounded growth (F-28). Introducing a
cap would silently shift age-based dispositions (X-6) and is out of scope.

---

## 6. Shadow mechanism

**The problem this solves.** The existing assembler is impure (F-20). It clears `_lastPhaseBLoc`, resets
and writes `_lastIdentityTruthLine`, and writes the diagnostic passback. Running both implementations
against the live `gameState` means the first consumes state the second needs — producing a **false C-8
difference** that has nothing to do with either implementation's correctness. R-27 property 1.

**The mechanism.** No cloning, no snapshot infrastructure:

1. Call `CP.project(gameState, _cbShadowMeta, { shadow: true })` **first**. With `shadow: true` it
   performs **no writes at all**, so `gameState` is exactly as it was.
2. Call `CB.assembleContinuityPacket(gameState, _cbMeta)` **second**, unchanged. It sees precisely the
   state it would have seen with no projector present, and its output is what reaches the narrator.
3. Compare `CP` output against `CB` output. Log the classified result. Discard the projector's string.

**Ordering is the whole mechanism.** Read-only-first is what makes the two runs independent. Reversing
the order, or letting the projector write during shadow, breaks it — V-35.

**Comparison method (R-27 property 2) — compatibility render, no parsing anywhere.**

The baseline string cannot be parsed into authoritative fact identities. `You:` renders `bucket:value`
pairs, but values are freeform narration that may contain `|` or `:`, so splitting is unsound; and C-4
and C-5 render **bare values** with no bucket and no key (`:1973`, `:2013`), so a missing NPC or location
fact cannot be attributed to anything at all from the string. **Any algorithm whose first step extracts
facts from the baseline inherits that unsoundness**, and looking the extracted strings up in the packet
does not repair it — a mis-extracted string simply fails to match and reads as an unaccounted loss.

The gate therefore never parses the baseline. It renders a second time and compares bytes.

`renderPacket(packet, { mode })` supports two modes over one packet:

| Mode | Applies |
|---|---|
| `'live'` (default) | The new policy: all bounds, unrecognized buckets excluded |
| `'compat'` | The **old** selection rules: no C-1/C-2/C-3 count bounds, unrecognized buckets included on every path. Everything else — C-1's age window, C-4's per-NPC 20, C-5's dedup and ordering, **the existing player/NPC `object`-bucket exclusions**, every literal — identical |

`compareToBaseline(packet, baselineString)` then:

1. Render `compat` from the packet.
2. **Compare `compat` to `baselineString` by exact string equality.** This is the gate. Byte-identical
   means the projector reads the same inputs, selects the same facts, and orders and formats them
   identically — which is the whole question, proven without interpreting a single line.
3. Any inequality **fails the gate**. Report the first differing line index and both lines for human
   diagnosis. That report is lossy by design; it locates a defect, it does not adjudicate one.
4. Report exclusion **counts**, `{c1, c2, c3, unrecognizedBucket}`, so V-37 can confirm each bound was
   exercised. Counted from entries that **genuinely contributed to `compat` and not to `live`** — not
   from every entry carrying an approved reason. An unrecognized C-4/C-5 attribute beyond the *unchanged*
   top-20 window renders in neither mode and is not a difference; counting it anyway over-reports. This
   was a defect in the first implementation, found and fixed in the G-10 follow-up review — see revision
   7 and the corrected §11 note below.

**Revision 7 — the "by construction" claim in the prior version of this step was false, and the fix is a
second, independent half of the gate.** The claim: *"the delta between `compat` and `live` is, by
construction, exactly the entries carrying an approved exclusion reason — no comparison is needed to
establish it."* An external review that **executed the shipped code against constructed edge cases**
(rather than re-reading the design) found two counter-examples: withholding an entry can delete an
**entire line**, not just shrink it — and doing so can trigger the content-conditioned empty-scene marker
as a knock-on effect. Neither consequence is visible to an entry-level count, and the byte gate above
never looks at `live` at all, so both were structurally invisible to the original design.

The fix does not reintroduce string parsing. `renderPacket`'s internal composition step now also emits a
**line manifest** — one record per output line, in both modes, carrying: the line's identity, whether it
is `content` or `framing`, whether it was emitted, and the indices of the packet entries that contributed
to it. `compareToBaseline` diffs the `compat` and `live` manifests **structurally** — line-by-line,
contributor-by-contributor — never the rendered strings. This is a second, independent check alongside
the byte gate above, not a replacement for it: the byte gate asks whether `compat` reproduces the
baseline; the manifest gate asks whether every `compat`-to-`live` consequence is an approved one. A run is
clean only when **both** hold.

**Four structural consequences are approved, and only these — each a user ruling, not an inference:**

| # | Consequence | Approved when | Because |
|---|---|---|---|
| A | The `You:` line vanishes from `live` | every player attribute is `unrecognized_bucket` | direct effect of R-10; nothing left to render |
| B | An NPC line vanishes from `live` | that NPC's in-window attributes are all `unrecognized_bucket` **and** it has no recognition suffix | CB already emits no line for an NPC with neither (`:1980`, U-3) — live is that same rule over a smaller attribute set, not a new one |
| C | The location line vanishes from `live` | every surviving location attribute is `unrecognized_bucket` | **new behavior** — see §4/render note below |
| D | The empty-scene marker (`(no promoted facts yet for this scene)`) appears in `live` where `compat` has none | **solely** as a downstream consequence of A and/or B and/or C, and only when each contributing loss was itself approved | content-conditioned framing following the intended effect of the bounds, not a defect |

**A can never happen via `overflow_capacity`.** The bounds trim a category; a bound never empties one.
Only vocabulary exclusion can. `unrecognized_bucket` is the sole approved cause for A, B, and C alike.

**Case C is new, ruled behavior, not a preserved one.** The old assembler has no empty-guard on the
location line (unlike the NPC path at `:1980`) because it never needed one: with no vocabulary exclusion,
a location holding any attribute always had something to print, so an empty line was unreachable. The
projector introduces the state the old code could never reach — attributes stored, none in the live set —
and the ruling is that `live` omits the line and its label there, matching the NPC convention that no
content means no prefixed line. **The guard triggers on zero live contributors, not on an empty joined
string** — a location attribute whose *value* coerces to `''` (`:2009`) is a state the old assembler *can*
reach and already prints as `[label]: ` today, so that case is preserved untouched; only the
never-reachable zero-contributor case is guarded. Compat is unaffected either way.

**Any content appearing in `live` that `compat` lacks is never approved, under any reason.** `live` may
only ever withhold relative to `compat` — this is what makes the approved-difference set a set of
*absences* (R-27 property 3). The manifest gate fails closed on any addition.

```
{ turn,
  compatEqual:   bool,
  firstDiff:     { lineIndex, baseline, compat } | null,
  exclusions:    { c1: <int>, c2: <int>, c3: <int>, unrecognizedBucket: <int> },
  structural:    { approved: bool, differences: [ { lineKey, kind, type, approved, reasons } ] },
  error:         <string|null> }   // set when packet was null or compat render failed
```

`structural.approved` and `compatEqual` are independent signals. Neither implies the other. A clean turn
requires both `true`.

**Degenerate inputs are outcomes, not exceptions.** `packet: null` — the projector failed before a packet
existed — yields `{ compatEqual: false, structural: { approved: false }, error: 'no_packet', … }`. A
compat render that throws, or the manifest classification itself throwing, yields the same
`compatEqual: false, structural: { approved: false }` shape with `error: <message>`. **The manifest gate
fails closed**: anything it cannot classify is not approved, never silently passed. Both are gate failures
to be diagnosed, and neither may propagate. The turn continues either way.

**Approved differences between `compat` and `live` — two kinds only:**

| Reason | Categories |
|---|---|
| `overflow_capacity` | C-1, C-2, C-3 only |
| `unrecognized_bucket` | any |

**`bucket_excluded_by_policy` is not an approved difference and must not appear as one.** The old
assembler already excludes `object` on the **player and NPC** paths at `:1933` and `:1970`, so the
projector excluding it there produces no difference — `compat` and `baselineString` must both omit it,
and a difference is a defect. **This does not extend to the location path**, which has no bucket filter
(`:1997`): a non-`environment` location attribute is emitted by the baseline, must be emitted by
`compat`, and is excluded from `live` under `unrecognized_bucket` — an approved difference. See §4.

`overflow_capacity` on **C-4 or C-5** is likewise not approved: those bounds are unchanged.

This is why the packet must carry withheld and dropped entries rather than only what it rendered — the
`compat` render is built from them.

**Approved differences (R-27 property 3)** — anything in this set is expected; anything outside fails the
gate:

| Category | Expected difference |
|---|---|
| C-1 | Items beyond the new top-10 absent from the projector's `You:` line |
| C-2 | Items beyond top-12 absent |
| C-3 | Items beyond top-8 absent |
| any | An attribute in an unrecognized bucket present in CB output, absent from projector output (R-10) |
| structural | A whole line vanishing, or the empty-scene marker appearing — the four cases A–D above, and no others |

**Forced overflow (R-27 property 4).** Ordinary play may never reach a bound, so the shadow period must
include constructed saves that exceed each of C-1, C-2, C-3. The comparison record carries
`boundExclusions` from §4, so V-37 can confirm each bound was actually exercised rather than assumed.

**Where shadow output goes:** `console.log` per turn plus a `continuity_shadow` key on `turnObject`
alongside `continuity_packet`.

**Shadow comparison ends at Phase 4 cutover.** Read-only-first works only while the projector is
suppressed. Once it goes live it performs its four writes — clearing `_lastPhaseBLoc` above all — so the
old assembler can no longer be run afterward against untouched state, and any comparison from that point
would be measuring the second reader's starvation rather than the two implementations. Keeping the
comparison alive past cutover would require cloning `gameState` per turn, which is infrastructure this
plan deliberately avoids. The shadow call, `compareToBaseline`, and `continuity_shadow` are therefore
removed **as part of Phase 4**, not deferred to Phase 5.

---

## 7. Implementation phases

Five phases. Each is independently revertible, and each ends in a state that is safe to leave running.

### Phase 1 — Build the projector, invoke nothing

**Change:** create `ContinuityProjector.js` complete: build, policy, dispositions, reasons,
classification, render, failure handling, single-use clear.
**Existing files touched:** none.
**Behavior change:** none — nothing calls it.
**Exit criteria:** V-01, V-02 (no existing-file logic), V-04 (single read site by construction), and
source review of §3/§4 conformance. Syntax check runs clean.
**Revert:** delete the file.

### Phase 2 — Shadow invocation

**Change:** `index.js` — require the module at `:36`; at `:4473–4476` insert the shadow call **before**
the existing `CB.assembleContinuityPacket` call, then the comparison and its log.
**The shadow call and the comparison must both be wrapped in a `try`/`catch` that swallows and logs.**
`project()` and `compareToBaseline` are both contractually non-throwing (§3), but this block is pure
diagnostics running alongside a live turn, and a contract violation must degrade to a missing shadow
report rather than a dead turn. The guard is error containment, not policy, so it does not put
classification logic in `index.js`.
**Behavior change:** none to the narrator. `_continuityBlock` still comes from `CB`.
**Exit criteria:** V-35 (input isolation — no false C-8 difference across turns where C-8 is populated),
V-05 (determinism over repeated projection), V-36 (differences confined to the approved set — both the
byte gate, `compatEqual`, and the structural gate, `structural.approved`; see revision 7 §6). The console
line and archived `continuity_shadow` both carry `structural_ok` as an independent signal alongside
`compat_equal` — a clean turn requires both `true`.
**Revert:** remove the inserted block.

### Phase 3 — Archive the packet

**Change:** `index.js` — add `continuity_packet` and `continuity_shadow` to the `turnObject` literal near
`:8262`, before the push at `:8345`.
**Behavior change:** none to the narrator. Turn records grow.
**Exit criteria:** V-30 (every disposition has a reason), V-31 (C-5 collapse identity), V-32 (seam
accounting complete against all five INV-15 treatments), V-34 (packet present in both `turn_history` and
the JSONL for the same turn).
**Why before cutover:** last-good replay reads the archive (§8). Cutting over first would mean the first
post-cutover failure has no last-good to find.
**Revert:** remove the two keys.

### Phase 4 — Cutover

**Change:** `index.js:4473–4476` — the projector call loses `shadow: true` and becomes the source of
`_continuityBlock`; the `CB.assembleContinuityPacket` call is removed from the live path. **The shadow
comparison, the `compareToBaseline` call, and `continuity_shadow` are removed in the same change** — see
§6: read-only-first cannot survive the projector becoming a writer.
**Behavior change:** the intended one. C-1/C-2/C-3 bounds take effect; unrecognized buckets stop
rendering.
**Gate:** shadow comparison must have run across a period including the forced-overflow cases, with no
difference outside the approved set (V-36, V-37), **and** the user must accept the bounds on sample
output (R-27, human judgment).
**Exit criteria:** V-09, V-17, V-18, V-21, V-22, V-23, V-24, V-25, V-26, V-27, V-28, V-29, V-33, V-38,
V-39, V-41, V-42, V-43.
**Revert:** restore the `CB` call as the source of `_continuityBlock`. This is why Phase 5 is separate.

### Phase 5 — Retire the old path

**Change:** remove `assembleContinuityPacket` from `ContinuityBrain.js` and from its exports at `:2187`.
*(The shadow comparison is already gone — it was removed at Phase 4.)*
**Precondition:** Phase 4 has run without incident for a period the user judges sufficient. **Not
mechanically gated** — this is a confidence decision.
**Exit criteria:** V-39 (replacement scope), V-33 (diagnostics unchanged), plus a repository grep
confirming **no remaining production caller**. Test callers are knowingly left broken — see §11 — so a
grep demanding zero callers of any kind would never pass.
**Revert:** git.

**Phases 1–3 are behavior-preserving and may proceed on a single authorization. Phase 4 requires separate
explicit authorization** — it is the first change a player can observe.

---

## 8. Failure path

**Last-good source: the archive, not a new field.** On failure, the projector reads the most recent
`continuity_packet` from `gameState.turn_history`, walking backward to the first entry that has one.

**Why not a cache or a `gameState` field:** either would be a fifth write, outside INV-6's enumeration,
which is stop condition S-8. The archive already exists (Phase 3), already persists through autosave, and
already survives restart. **This is a read, not a write.**

**Note for G-10, because it looks like a violation and is not.** F-5 closed "archive as sink" for all
five categories — no *category policy* may take history as an input, and none does. Failure replay is not
a category policy: it selects nothing, disposes nothing, and derives no verdict. It reproduces a prior
verdict wholesale. The sink rule is untouched.

**Replay procedure, per R-19:**

1. Walk `gameState.turn_history` backward for the most recent envelope with **`ok === true`**. Envelopes
   with `ok === false` are skipped, not selected — consecutive failures must not cause a failed or
   framing-only record to be replayed as though it were good. None found → emit framing only; record the
   absence.
2. **Eligibility:** a successful projection qualifies whether it was built live or in shadow. Same code,
   same real state; narrator delivery does not make a packet more truthful. A **failed** projection never
   qualifies, in either mode.
3. Take only `class === 'managed'` entries in categories **C-1, C-2, C-3**.
4. **Discard everything else** — C-4 and C-5 managed entries, all `auxiliary`, all `passthrough`. C-4/C-5
   are bound to the current NPCs and location, and their subject labels are authority-owned.
5. Emit framing normally.
6. Render through `renderPacket` on the reconstructed packet, so the failure path and the success path
   share one renderer.

**Scene check is not required under this policy** and must not be implemented. C-1/C-2/C-3 are player
attributes, bound to no place or person; the `scene` field in §4 exists for diagnostics and for any future
policy that needs it, not for a check on this path.

**Failure record** — written into `turnObject.continuity_packet.failure` and emitted to console
immediately:

```
{ stage: 'build'|'render', message, replayedFrom: <turn|null>, categoriesReplayed: [...] }
```

**Console format**, fixed so it is not invented at implementation time. One line, matching the existing
`[CB-DEDUP]` convention of a bracketed tag followed by `key=value` pairs:

```
[CP-FAIL] stage=build turn=42 replayed_from=41 categories=C-1,C-2 message="..."
```

`replayed_from=none` when no qualifying packet was found. The message is the caught error's `.message`,
truncated to 200 characters.

Persisted on the same terms as the rest of the turn; **not guaranteed to survive a disk failure**, per
amended INV-8. No new durable-write mechanism.

---

## 9. The four writes

Per R-20. All four live in `ContinuityProjector.js`; none moves to `index.js`.

| Write | When | Shadow |
|---|---|---|
| `turnContext.stateAttrsSuppressed` | During build. **Age-rule exclusions only** — bound exclusions go to `diagnostics.boundExclusions` (R-20, IN-8) | Suppressed |
| `gameState._lastIdentityTruthLine` | **Reset to `null` as the first STATE MUTATION in `project()`, before packet construction** — R-22, F-21. Set to the rendered line when identity renders | Suppressed |
| `w._lastPhaseBLoc = null` | After successful packet construction. Not on construction failure. **Still cleared when the content was suppressed** — suppression is a successful projection (R-21, F-16) | Suppressed |
| `console.log('[CB-DEDUP] …')` | On collapse, format unchanged (R-25) | Suppressed |

**No fifth write exists.** Adding one is S-8.

**Shadow determination may precede the breadcrumb reset — a G-10 follow-up ruling, not a relaxation of
R-22.** Whether to write depends on `options.shadow`, and reading an arbitrary caller-supplied `options`
object can itself throw — the literal requirement ("reset before anything that can throw") and the
requirement that shadow suppress the write cannot both be satisfied to the letter at once. The ruling:
shadow determination is read defensively (any throw degrades to `shadow = false`, which fails toward
*performing* the reset — the safe direction, since the hazard is a stale value surviving, not an extra
null) and is not itself counted as the state-mutating operation the write ordering protects. On every
non-shadow call, the reset remains the **first state mutation**, strictly before packet construction.

---

## 10. Verification mapping

Every V row from the requirements, assigned to the phase that first satisfies it.

| Phase | Verification rows |
|---|---|
| 1 | V-01, V-02, V-03, V-04 |
| 2 | V-05, V-06, V-07, V-08, V-10, V-11, V-13, V-14, V-15, V-16, V-19, V-20, V-35, V-40 |
| 3 | V-12, V-30, V-31, V-32, V-34 |
| 4 | V-09, V-17, V-18, V-21, V-22, V-23, V-24, V-25, V-26, V-27, V-28, V-29, V-33, V-36, V-37, V-38, V-41, V-42, V-43 |
| 5 | V-39 |

All 43 rows are assigned. Bound acceptance is not a row — it is the human judgment named in R-27.

---

## 11. Coding handoff

**May change:** `ContinuityProjector.js` (new, freely). `index.js` at exactly **three** sites — the
require at `:36`, the projection block at `:4473–4476`, and the `turnObject` literal near `:8262`. The
shadow call, the comparison, and `continuity_shadow` are all inside those same three sites and are
**removed at Phase 4**, not Phase 5 — see §6 and §7. `ContinuityBrain.js` at Phase 5 only, to delete the
assembler and its export.

**Must not change:** anything in the requirements' §8 unchanged-behavior table or §10 exclusions. In
particular: Phase B promotion and `turn_set` stamping, the Arbiter, the `object`-bucket filters, the
narrator prompt outside the interpolated block, and `turn_history` growth.

**Inspect before editing** (S-1): the call site, the four write sites, the string consumers at F-22, and
both `_lastIdentityTruthLine` consumers. Any drift from §3 of the requirements halts work.

**Already decided — do not revisit:** category policy and bounds; disposition semantics; classification of
every element including the three absence markers; failure behavior by class; tiebreak order; the clear's
timing and owner; the projection point; the six decisions in §1 of this plan.

**Coding must not decide:** what a category's bound is; what class an element belongs to; what replays on
failure; whether a difference in shadow is acceptable; whether a stop condition has been met.

**Accepted consequence at Phase 5.** `tests/actor-possession-authority.test.cjs` invokes
`CB.assembleContinuityPacket` directly and will break when Phase 5 deletes it. Three probe and scenario
fixtures under `tests/` also reference the assembler by name. **The user has explicitly accepted this
breakage**; migrating them is not part of this plan, and the coding agent must not expand scope to fix
them. Report the breakage, do not repair it.

**Validation required after edits:** syntax check on every changed file; the phase's exit criteria in §7
before proceeding to the next phase. **Do not claim validation that was not run.**

---

## 12. QA handoff

**What changed:** narrator-visible output changes at Phase 4 only, and only for C-1/C-2/C-3 bounds and
unrecognized-bucket exclusion. Everything else is byte-identical by design.

**Most likely regressions**, in order: C-5 render order "corrected" to `turn_set` descending (V-23 —
this is the single most likely defect, because the correct order looks like a bug); the identity
breadcrumb reset moved back below the attribute block (V-29); `state_attrs_suppressed` silently
absorbing bound exclusions (V-26); the founding-friend L0 path simplified out of input supply (V-42).

**Runtime-only:** V-05, V-09…V-31, V-33, V-35…V-38, V-41…V-43.
**Source-only:** V-01, V-02, V-04, V-07, V-16, V-34, V-39, V-40.
**User judgment:** V-03 (upstream approval), R-27 bound acceptance.

---

## 13. Stop conditions

Inherits S-1 … S-10 from the requirements. Four are specific to this plan.

| ID | Trigger | Why unsafe | Next |
|---|---|---|---|
| **S-P1** | Shadow comparison cannot be made to produce a clean baseline — differences appear in categories with no approved difference and cannot be traced to a named cause | The gate exists to catch exactly this. A gate that is silenced rather than satisfied is not a gate | Diagnose to a named cause; do not proceed to Phase 4 |
| **S-P2** | `renderPacket` needs to read `gameState` or perform a write to produce correct output | Purity is what makes shadow comparison and failure replay sound. If render needs live state, both are unsound and the design is wrong | Stop; the packet structure is incomplete — revise §4, not the renderer |
| **S-P3** | Phase 4 is reached before the forced-overflow cases have run | The bounds are the only intended behavior change, and they would ship unvalidated — S-10 | Construct the overflow cases first |
| **S-P4** | Implementation requires a decision not in §1's list of six | Every other decision was settled in the requirements or the charter. Needing a seventh means something was misread, or the plan is incomplete | Stop; identify which settled decision was misread |

---

## 14. Revision log

| # | Date | Change | Basis |
|---|---|---|---|
| 7 | 2026-08-04 | **Post-implementation G-10 follow-up review, six findings, all fixed; four structural-consequence rulings and one containment ruling, all made by the user.** §6: the **"by construction" claim in revision 3 is false** — an external review that *executed* the shipped code against constructed edge cases (not a re-read) found that withholding entries can delete a whole line and can trigger the content-conditioned empty-scene marker, neither visible to an entry-level count. `compareToBaseline` now composes a **line manifest** (per-line: emitted, contributing entry indices, in both modes) and classifies structural differences from it — a second, independent gate alongside the byte gate, never parsing rendered prose. The report gains `structural: {approved, differences}`. Four consequences are approved, each a user ruling: (A) `You:` vanishes when all player attributes are unrecognized; (B) an NPC line vanishes under the same condition CB already applies for no-attributes-no-recognition (`:1980`); (C) the location line vanishes via a **new** live-only empty guard, added because the projector reaches a state (attributes stored, none live) the old assembler could never encounter and so never needed a guard for; (D) the empty-scene marker appears as a downstream consequence of A/B/C, approved only when the loss causing it was itself approved. Any content in `live` absent from `compat` is never approved, under any reason. §4: two additive fields, `renderedCompat` and `lineKey`, close a gap in the original entry schema — it carried no mode information and no line-routing for a dropped entry (`category: null`). §6 step 4: the exclusion-count method changed from "every entry carrying an approved reason" to "entries that genuinely contributed to `compat` and not `live`" — the prior method over-counted an unrecognized C-4/C-5 attribute beyond the *unchanged* top-20 window, which renders in neither mode and is not a difference. §9: shadow determination may now precede the identity-breadcrumb reset, contained so a hostile `options` read cannot escape; the reset remains the first *state mutation* on every non-shadow call, which is the property V-29 actually needs. | User-authorized review following G-9 implementation; findings independently reproduced against source and against a corrected-code differential harness (54 fixture checks) before being accepted; all four structural rulings and the containment ruling are explicit user decisions, not inferred |
| 6 | 2026-08-03 | **Bucket-drop table generalized.** §4 covered player/NPC `object` and location non-`environment` but omitted the general case: a **player or NPC attribute in any other unverified bucket**. The existing filters are exclusions, not allowlists (`bucket !== 'object'` at `:1933`/`:1970`), so such an attribute renders today and must be included by compat, excluded from live, and recorded as `unrecognized_bucket`. Restructured as **one general rule with one exception** rather than an enumeration, with the per-path vocabulary stated explicitly — which also closes a second trap: `declared` is verified for the player but **not** for an NPC, so an NPC attribute in that bucket takes the general rule. §6's compat description narrowed from "the `object`-bucket exclusion" to "the existing player/NPC `object`-bucket exclusions". No new design decision — R-10 and the comparator's `unrecognized_bucket \| any` row already implied it; the schema table was simply incomplete. | G-10 targeted recheck |
| 5 | 2026-08-03 | **G-10 full-audit hold, two functional findings plus two cleanups, all accepted.** §3.3/§6: `compareToBaseline` was declared **pure but not total**. `project()` can return `packet: null` after an early construction failure, and the compat render can throw; either would have propagated to `index.js:8736`, emitted `narrator_error`, and **aborted a live turn from a diagnostic** — contradicting Phase 2's "no behavior change" and R-19. The comparator now must accept `packet: null`, must never throw, and returns `{compatEqual: false, error}` for degenerate input; the Phase-2 integration call is additionally guarded, since error containment is not policy. §4/§6: **the `object`-bucket rule was globally scoped and source does not support that.** The player and NPC paths filter `object` at `:1933`/`:1970`; the **location path has no bucket filter at all** (`:1997`, F-12). Treating `object` as universally dropped would have made the compat render omit what the baseline emits, breaking byte equality and silently changing C-5. Split by path: player/NPC `object` → `bucket_excluded_by_policy`, excluded in both modes, **no** shadow difference; location non-`environment` → `unrecognized_bucket`, **included** in compat and excluded from live, an approved difference. X-10 protects the existing filters, and there is no location filter to protect. §7 Phase 5: grep criterion narrowed to **no remaining production caller**, since test callers are knowingly left broken. §11: permitted `index.js` sites corrected from four to three, with shadow removal at Phase 4. | G-10 full audit against the current charter, requirements, ledger, and source at `a856c99`; source re-verification of the three bucket-filter sites |
| 4 | 2026-08-03 | **`age_beyond_window` unblocked.** User enacted charter revision 10, broadening `memory` to cover displacement without a terminal verdict by either a capacity bound or a non-terminal age window. §4's reason table and its accompanying note updated; the reason now carries disposition `memory` with no qualification, and V-09 covers C-1's 6–20 band without a special case. Requirements R-11 updated to match. No other section changed. | User decision on the one open item from the G-10 second hold |
| 3 | 2026-08-03 | **G-10 second hold, three findings, all accepted.** §3/§6: the comparator **no longer parses the baseline at all**. Revision 2's algorithm argued that baseline parsing is unsound and then made extraction its first step; looking a mis-extracted string up in the packet does not repair it. `renderPacket` now takes a `mode`, and the gate is **byte equality between a `compat` render and the baseline string**, with the live/compat delta being the approved exclusions by construction rather than by comparison. `bucket_excluded_by_policy` **removed from the approved-difference set** — the old assembler already excludes the `object` bucket, so that must be *equal*, not different; `overflow_capacity` on C-4/C-5 likewise excluded, since those bounds are unchanged. §4: dropped entries now carry `category: null` as a requirement, because R-10 says an out-of-vocabulary attribute belongs to no category and asserting one would falsify the archive. §4: **`age_beyond_window` demoted to BLOCKED pending a user decision** — the charter's "records only that the bound ran out" is definitional, so routing age-displaced facts into `memory` widens the disposition rather than applying it, and G-9 may not fill a matrix gap by elimination. Recommendation recorded; nothing else in the plan depends on the outcome. | G-10 re-audit; source re-verification of the `object`-bucket filters at `ContinuityBrain.js:1933`, `:1970` and of the charter's `memory` definition |
| 2 | 2026-08-03 | **G-10 hold, three findings, all accepted.** §3/§6: the comparator becomes **fact-aware** — it interprets a diff against the packet's `entries` rather than by line prefix, because C-4 and C-5 render bare values with no key and freeform values make `You:` parsing unsound; it moves into `ContinuityProjector.js` as a fourth export, since deciding whether a difference is approved is classification logic that R-1 confines to that file; and it **ends at Phase 4** rather than Phase 5, because read-only-first cannot survive the projector becoming a writer. §5: the archive becomes an **envelope** `{ok, packet, failure}`, since `packet` can be null and a failure record cannot hang off null. §8: last-good selects the most recent envelope with `ok === true`, so consecutive failures cannot replay a failed record. §4: `class: 'dropped'` added to carry INV-15's fifth treatment, covering both the `object`-bucket policy drop and unrecognized buckets; **`age_beyond_window` added** for C-1 facts aged 6–20, which the settled matrix already places in `memory` but for which no reason string existed. §11: the accepted Phase-5 test breakage recorded. **Finding #4 withdrawn by the user** — a test targeting the retired assembler may break. | G-10 audit; source re-verification of the rendered value forms at `ContinuityBrain.js:1945`, `:1973`, `:2013` and of the affected test files |
| 1 | 2026-08-03 | Written at G-9 against the settled requirements and charter revisions 8–9. Closes the six decisions the requirements deferred; adds no requirement and no policy. | User authorization to proceed to G-9 following G-8 PASS and enactment of all five charter amendments |
