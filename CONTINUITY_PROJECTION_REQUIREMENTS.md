# Continuity Projection — Requirements

**Stage:** G-7 deliverable, decisions settled. **Supersedes all prior revisions of this file.**
**Status:** Complete and unblocked. **G-8 passed.** The implementation plan
(`CONTINUITY_PROJECTION_IMPLEMENTATION_PLAN.md`) passed G-10 and Phases 1–3 are implemented, corrected
per a post-implementation follow-up review, and committed. See revision 2 below and the plan's revision
7. **R-27's two cutover preconditions are now satisfied** — forced-overflow evidence for C-1 through C-5
with both the byte gate and structural gate holding throughout, and the user's read acceptance of the
10/12/8 bounds on real before-and-after output. **Phase 4 cutover itself remains a separate, unauthorized
decision** — the preconditions being met is not the authorization.
**Depends on:** the seven charter amendments in §14, **all enacted** — charter revisions 8, 9, 10,
and 11.

**Source state — the evidence baseline every `file:line` claim below was verified against, not
necessarily the branch current work is on.** Branch `main`, HEAD `a856c99`. Implementation subsequently
happened on `continuity-projection-shadow`, which shared this commit when coding began; see the plan's
own source-state note and this document's status line above for where things stand now.
Claims carried at a lower evidentiary tier are marked **[tier-2]** and listed together in §15.

---

## 1. What this is

The contract for replacing the CB TRUTH/MOOD rendering seam with a standalone continuity projector.
It defines what must be true, not how to build it. File layout, interfaces, data structures, and
implementation order belong to G-9.

Release one delivers **identified, explicit, reasoned, archived, bounded** selection. It does not
deliver better knowledge of truth: no new invalidation evidence is produced or consumed.

---

## 2. Semantic authority

| Layer | Owns | Relation |
|---|---|---|
| ORS / ObjectHelper | Physical object truth | Untouched, unread |
| CB → Condition Bot → index | Player-condition truth | Untouched, unread |
| Arbiter (`index.js:8534–8688`) | `player.identity.current_form` / `last_known_form`; `npc.player_recognition`; `npc.is_learned` / `learned_name` | Source of truth for four passthrough elements. The projector formats and carries; never writes |
| CB Phase B (`ContinuityBrain.js:1112–1210`, `:1752–1779`) | Creation of all C-1…C-5 assertions and their `turn_set`; production of `_lastPhaseBLoc` | Upstream producer. The projector reads only |
| **The projector** (new file) | **Which managed facts are `live`, `memory`, or `retired`, and the archived reason for each** | Authoritative for dispositions only |
| `index.js` turn handler | Turn sequencing, archival, HTTP response | Integration: input supply, invocation, archiving, render |
| `diagnostics.js` | Capture and exposure of the rendered block | Consumer; contract preserved |

The projector is not an authority for object existence, object state, player conditions, NPC identity,
player identity, player location, or action outcome, and does not become one by observing, formatting,
or archiving any of them.

The charter's central authority statement, carried verbatim as its §4 requires:

> Within the packet's scoped continuity domain, live/memory/retired dispositions are truth verdicts,
> not merely presentation choices; the packet still does not mutate or replace the underlying
> authorities that supply object and condition truth.

---

## 3. Observed facts

**The seam**

- **F-1** `assembleContinuityPacket(gameState, turnContext)` — defined `ContinuityBrain.js:1912`,
  exported `:2187`, called from exactly one site, `index.js:4474`.
- **F-2** Returns a flat string (`:2105`). Emits three sections: `CONTINUITY — TRUTH` (`:1923`),
  `CONTINUITY — MOOD` (`:2044`), and conditionally `CONTEXT — RECENT LOCATION` (`:2099`).
- **F-3** Reads roughly fourteen groups, not the six the extraction artifact's §1 lists:
  `world.{active_local_space, active_site, position, mood_history, _lastPhaseBLoc, _visible_npcs}`,
  `_getL0CellRecord()` (`:1916`, defined `:1215`), `locRecord.{name, attributes}`, `player.attributes`,
  `player.identity.{canonical_name, title_or_role, current_form, last_known_form}`,
  `gameState.turn_history.length` (`:1937`), per-NPC `{id, npc_name, is_learned, job_category,
  attributes, player_recognition}`, mood snapshot fields, `_lastPhaseBLoc.{locationRef, features}`,
  `turnContext.turn` (`:2029`), plus helpers `_toCanonicalEnv` (`:1076`) and `_getL0CellRecord`.
- **F-4** Reads no object record, no `player.conditions`, no ORS surface.

**Selection, per category**

- **F-5** Player attributes render as **one** line. Non-`object` buckets filtered (`:1933`), age-filtered
  (`:1939–1941`), joined into `You: bucket:value | …` (`:1945–1946`) in `Object.values()` order —
  storage order, **not** sorted by `turn_set`. Buckets interleave.
- **F-6** C-1 age rule: `bucket !== 'state' || turn_set == null || turn_set >= _curTurn - 5`
  (`:1938–1941`, `STATE_ATTR_WINDOW = 5` at `:39`), with `_curTurn = turn_history.length + 1` (`:1937`).
  A `state` attribute with null/absent `turn_set` is **exempt** from suppression.
- **F-7** C-2 (`physical`) and C-3 (`declared`) have no count cap and no age rule. Every one renders
  every turn.
- **F-8** Every `declared` attribute carries `turn_set: 1`. Only writers are `:1757`
  (`birth_record.status_claims`) and `:1773` (`birth_record.capabilities`), both Turn-1 guarded, both
  hard-coding the value.
- **F-9** C-4's 20-slice is applied **per NPC**, inside the loop at `:1966` (`ENV_ATTR_WINDOW = 20` at
  `:43`, sort/slice at `:1971–1972`). Rendered set is at most 20 × visible NPCs; an NPC with no
  attributes and no recognition emits no line (`:1980`).
- **F-10** The visible-NPC count is not projector-controlled. `:1926` resolves
  `(loc && loc._visible_npcs) || w._visible_npcs || []`. L1/L2 writers route through
  `computeVisibleNpcs`, capped at 5 (`ActionProcessor.js:1455`, `:1470`). L0 writers
  (`index.js:4460–4463`, `:6627`, `:7901`) filter by exact cell with no slice.
- **F-11** C-5: sort by `turn_set` desc, slice 20 (`:1997–1999`), then dedup **within** those 20 by
  canonical key with **no backfill** (`:2005–2026`). Non-string values coerced (`:2009`).
  **Order consequence:** on a canonical-key collision where the incoming (older) value is longer and
  contains the kept one, `:2021` writes `_survivors[_keptIdx] = _val` — mutating the value **in the slot
  the newer fact occupied, without repositioning**. Rendered order is therefore **first-appearance order
  of canonical keys**, not descending by the surviving values' own `turn_set`.
- **F-12** The C-5 path applies **no bucket filter** (`:1997`), unlike player (`:1933`) and NPC
  (`:1970`). The only writer found produces `bucket: 'environment'`, key prefix `env:` (`:1160–1162`).
  **[tier-2]**
- **F-13** C-6: location-filtered (`:2060`, with an `undefined`-key legacy exception), last 5 (`:2061`,
  `MOOD_WINDOW = 5` at `:37`); latest snapshot expanded to five labelled lines (`:2068–2072`), prior
  entries as a **reversed** `recent trajectory:` list (`:2075–2081`). The `'—'` placeholder appears
  **only** as the per-field fallback inside those five lines (`:2068–2072`); it exists nowhere else and
  cannot outlive them.
- **F-14** C-7: four-field guard (`:1954`), `current_form || last_known_form` fallback (`:1958`),
  rendered as `Player: …` (`:1960`).
- **F-15** Recognition suffix ` | recognizes-player: <identity> (since T-<turn>)` built at `:1977–1979`,
  appended to the NPC's attribute string, or emitted with its leading `' | '` stripped via `.slice(3)`
  when the NPC has no attributes (`:1981`).
- **F-16** C-8: read at `:2090`, suppressed on cell-move (`:2093`) and on any non-L0 layer (`:2096`);
  `:2103` sets `w._lastPhaseBLoc = null` **unconditionally**, including when suppressed.

**Generated text**

- **F-17** Framing literals: section headers and rule lines (`:1923–1924`, `:2044–2045`, `:2099–2100`)
  and the blank separator (`:2041`). These are emitted unconditionally and are drawn from nothing.
  *The `'—'` placeholder and the `[<locLabel>]:` prefix are **not** in this group — see F-13 and F-19.
  Both are conditioned on content and are classified with it (R-8).*
- **F-18** Three absence markers, and they are not alike:
  - `NPCs at this location: none visible in engine state.` (`:1986`) fires **only** under
    `visible.length === 0` (`:1985`). It **asserts a world fact** derived from engine state.
  - `(no mood data yet)` (`:2064`) fires when the filtered mood window is empty. It reports the state of
    C-6's data.
  - `(no promoted facts yet for this scene)` (`:2038`) fires **only** under `truthLines === 0` (`:2037`).
    Because the NPC-absence line increments the same counter, this is reachable only when NPCs are
    present but every one was skipped. It asserts nothing about the world.
- **F-19** Current-state presentation labels: the location prefix (`:2033`) from `locRecord.name` or
  `w.position`; the NPC label (`:1968`), `(is_learned && npc_name) ? "<name> (<id>)" : "<job> (<id>)"`;
  the `(since T-N)` stamp (`:1978`). `is_learned` and `learned_name` are written by the Arbiter at
  `index.js:8622` and `:8624`, after the projection point.

**The assembler's writes**

- **F-20** Four sites:

  | Site | Write | Consumer |
  |---|---|---|
  | `:1935`, `:1943` | `turnContext.stateAttrsSuppressed` | `index.js:4473` supplies `_cbMeta`; `:8291` → `narration_debug.state_attrs_suppressed` → `turn_history` (`:8345`) and JSONL (`:8349`) |
  | `:1952`, `:1961` | `gameState._lastIdentityTruthLine` — reset to `null`, then set verbatim | `index.js:8731` → HTTP response `last_identity_truth_line`; `Index.html:2512` |
  | `:2103` | `w._lastPhaseBLoc = null` | Producer is `ContinuityBrain.js:1843` |
  | `:2029` | `console.log('[CB-DEDUP] …')` | Console |

- **F-21** The breadcrumb reset at `:1952` occurs **after** the player-attribute block, so a throw before
  that line leaves the previous turn's value live in `gameState`, which `index.js:8731` then emits.

**Consumers of the returned string**

- **F-22** `index.js:4475`, `:4476`, `:4481`, `:6189` (narrator prompt), `:8281`, `:8283`, `:8419`,
  `:8437`, `:8481`, `:8514–8515`, `:8710`; `diagnostics.js:109–113`, `:1031`/`:1035`, `:2225`, `:2276`.
  **[tier-2]** — verified set, not certified exhaustive.
- **F-23** `diagnostics.js:2225` treats `null` as "no data"; a `null` return would silently disable
  `/diagnostics/continuity`.

**Turn ordering and durability**

- **F-24** Projection point `index.js:4474` runs **before** narration, **before** `CB.runPhaseB`
  (`:6353`), **before** the turn archive (`:8345`), **before** the Arbiter (`:8534`). The narrator prompt
  is committed at `:6189`.
- **F-25** `_lastPhaseBLoc` is written by Phase B at `ContinuityBrain.js:1843` — i.e. at
  `index.js:6353`, **after** the projection point. Conditional (L0 only, non-empty features, `:1841`),
  a full replace, never a clear.
- **F-26** **Three** disk writes, all after render, all fire-and-forget, all swallowing failure:
  flight-recorder JSONL `index.js:8349` (`.catch` `:8353`), payload archive `:8383–8390` (`.catch`
  `:8390`), autosave `:8694–8699` (`.catch` `:8699`). None exposes a completion signal.
- **F-27** The JSONL is serialized at `:8349`; the Arbiter verdict is back-patched onto
  `turn_history[last]` at `:8691`. The JSONL for a turn never contains that turn's `arbiter_verdict`.
- **F-28** `turn_history` is push-only: initialized `index.js:902`, pushed `:975` (aborted turn) and
  `:8345` (normal). No trim, splice, or reassignment found. **[tier-2]**
- **F-29** Nothing wraps `index.js:4474`. A throw reaches the outer `catch` at `:8736`, emits
  `narrator_error`, calls `_abortTurn`, and returns an error response. **The packet cannot currently
  fail independently of the turn.**

**Assertion lifecycle**

- **F-30** Attribute writers are create-if-absent: `ContinuityBrain.js:1129` (NPC), `:1162`
  (location), `:1193` (player `physical`/`state`), `:1757`, `:1773` (`declared`). Player `state`
  attributes persist while the relevant site/local-space context remains, then `index.js:1114–1123`
  intentionally deletes them on a genuine site or local-space boundary crossing; the semantic and
  fallback engine-result call sites are `:3098` and `:3579`. A later extraction may therefore create
  the same exact key again with a new `turn_set`. No in-place `turn_set` update was found, and no
  equivalent deletion path was found for player `physical`/`declared`, NPC, or location attributes.
  **[tier-2]**
- **F-31** Bucket vocabulary — NPC: `physical`, `state`. Player: `physical`, `state`, `declared`.
  Location: `environment`. The `bucket !== 'object'` filters at `:1933` and `:1970` are **exclusions,
  not allowlists**: an attribute in any other bucket renders today.
- **F-32** `motherbrain.js:1102` documents a `birth_record.possessions → object:` promoter. No such
  writer exists in current source; `:1728` still populates `possessions` but only `status_claims` and
  `capabilities` promote, both to `declared:`. The stray `object` bucket in saves is consistent with
  legacy provenance and is in any case explicitly filtered. **[tier-2]**
- **F-33** Player identity is mutable after founding: `index.js:8662–8679` writes `current_form` and
  `last_known_form` from an accepted Arbiter `player_form_change`, capturing `prior_form` (`:8673`) into
  `_lastArbiterVerdict` (`:8683`) and `turn_history[last].arbiter_verdict` (`:8691`). The Arbiter is
  awaited (`:8534`). `canonical_name` and `title_or_role` have no writer found outside
  `ContinuityBrain.js:1739–1740`. **[tier-2]**

---

## 4. Inferences

- **I-1** Because the projection point precedes the Arbiter (F-24, F-33), a form change applied on turn
  N first appears in the packet on turn N+1. Current behavior, preserved.
- **I-2** For any assertion record currently present in a store, its age-derived disposition is a pure
  function of `(turn_set, turn_history.length)` because that record's `turn_set` is immutable (F-30) and
  `turn_history` is push-only (F-28). A retained record therefore cannot move from `retired` back to
  `live` by stateless recomputation. This is not a global exact-key lifecycle guarantee: a genuine
  boundary crossing may delete a player `state` record, and later extraction may create the same key as
  a new record with a new `turn_set`. The projector persists no disposition state and cannot itself
  resurrect an absent record.
- **I-3** `turn_set` ties are the normal case, not an edge case, and C-3 is one category-wide tie (F-8).
  Any `top-N by turn_set` bound requires a declared tiebreak to be deterministic.
- **I-4** C-4's live set is at most 20 × N with N supplied by the engine (F-9, F-10) — a per-NPC bound
  the projector enforces, over a count it does not.
- **I-5** Passthrough elements and current-state labels render inside managed lines (F-15, F-19), so the
  failure path must decompose lines that are currently atomic.
- **I-6** No durable archival has occurred at the projection point (F-24, F-26), so a
  wait-for-archival clear cannot be performed there.
- **I-7** The seam reads no object or condition surface (F-4) and no managed assertion carries a
  resolvable reference to one, so no reconciliation is mechanically available.

---

## 5. Uncertainties

| ID | Uncertainty | Handling |
|---|---|---|
| **U-1** | Whether more than one NPC can be visible at once. `computeVisibleNpcs` admits 5; L0 admits unbounded (F-10); NPC placement was not traced | R-31 requires the count be **recorded** every turn rather than asserting a threshold. The contract gets characterized from data instead of guessed |
| **U-2** | Whether an attribute with null/absent `turn_set` occurs in real saves | R-6 ranks it last. New policy for an unobserved case, not preservation |
| **U-3** | Whether any bucket outside the known vocabulary exists in stored saves | R-10 excludes and logs. See R-27: this is an approved shadow difference, not a regression |
| **U-4** | Whether `[CB-DEDUP]` is consumed by an external pipeline | Kept (R-25) |
| **U-5** | Whether `world.active_continuity` (`index.js:4482`) has a live producer | Out of scope; §16 L-2 |

---

## 6. Current behavior

One synchronous function, invoked once per turn before narration, returning a flat string. It performs
implicit, unlogged, unbounded-in-two-categories selection over content-keyed assertion stores;
interleaves authority-owned content and mutable labels into the same lines as managed facts; writes four
side effects; consumes a single-use field unconditionally; and cannot fail without taking the turn down.

| Section | Content | Selection | Accounting |
|---|---|---|---|
| `You:` | C-1 + C-2 + C-3, one line, storage order | C-1 aged out past 5 turns; C-2/C-3 unbounded | Aggregate suppressed count only |
| `Player:` | C-7 | Rendered when any of four fields set | Verbatim copy to `_lastIdentityTruthLine` |
| NPC lines | C-4 + recognition suffix + label | Top-20 per NPC, `turn_set` desc | None |
| `[loc]:` | C-5 + location label | Top-20, dedup within, no backfill | Console log only |
| MOOD | C-6 | Location-filtered, last 5 | None |
| CONTEXT | C-8 | L0 only, suppressed on move, single-use | Cleared unconditionally |

No per-fact reason exists anywhere. No failure isolation exists.

---

## 7. Requirements

### 7.1 Component boundary

**R-1** All selection, policy, disposition, bound, reason, and classification logic lives in one new
source file. No existing file gains any of it.

**R-2** Changes to existing files are limited to four kinds: input supply, invocation, archiving the
projector's output, and render at the seam.

**R-3** Any **input-supply** change to an existing file is additive read-only plumbing exposing state the
owning authority already holds. No new authority semantics, simulation mechanics, or mutation
responsibilities upstream. Each such change requires per-instance user approval.
*Scoped to input supply deliberately:* archiving the packet is a write, and R-2 permits it. A blanket
read-only rule over all existing-file changes would forbid what R-2 allows.

### 7.2 Projection and determinism

**R-4** The projector reads domain state and constructs the packet at `index.js:4474` and nowhere else.

**R-5** Identical input state produces an identical packet, dispositions, reasons, and rendered string.
No wall-clock, no random source, no iteration over an unordered collection without a declared order.

**R-6** Every bounded selection declares a total order: **primary** `turn_set` descending; **ties broken
by storage order** of the backing attribute object; **null or absent `turn_set` ranks last**. The
null-rank rule is new policy for an unobserved case (U-2); the age-filter exemption at F-6 is unchanged,
so such a fact never ages out — ranking it last only means a newer fact wins a contested slot.

**R-7** The current turn is derived from `gameState.turn_history.length + 1`. No substitute source, and
nothing in this project may trim or compact `turn_history`.

### 7.3 Classification

**R-8** Every element of the packet's output is classified as exactly one of:

| Class | Members | Disposition | On failure |
|---|---|---|---|
| **Managed continuity** | C-1 `state`, C-2 `physical`, C-3 `declared`, C-4 NPC attributes, C-5 location/env attributes | Yes | Per R-19 — differs by category |
| **Auxiliary seam content** | C-6 mood, C-8 recent location, the `(no mood data yet)` marker, **and the `'—'` field placeholders**, which appear only inside C-6's own snapshot lines (`:2068–2072`) and therefore cease to exist when C-6 is omitted | No | Omitted |
| **Current-state authority passthrough** | C-7 identity, recognition suffix, the F-19 labels **including the `[<locLabel>]:` prefix**, which is built from the current location name or cell coordinates (`:1917–1919`, `:2033`), **and the `NPCs at this location: none visible…` marker**, which asserts a world fact derived from engine state | No | Omitted, never stale-replayed |
| **Framing** — *not content, receives no classification* | Section headers, rule lines, separators, **and the `(no promoted facts yet for this scene)` marker**, which asserts nothing about the world | No | Emitted normally; it is structure, not truth |

Framing is exempt from disposition but **not** from R-24 accounting or from byte-level preservation.

**R-9** Category policy is exactly the approved matrix. **All numeric bounds are provisional release-one
constants to be validated by shadow comparison, declared as such at their definition site, and not
presented as evidence-established.**

| | C-1 `state` | C-2 `physical` | C-3 `declared` | C-4 NPC | C-5 location/env |
|---|---|---|---|---|---|
| Live set | age ≤5 **and** top-10 | top-12 | top-8 | top-20 **per NPC** | top-20, dedup within |
| Bound | 10 | 12 | 8 | 20 per NPC | ≤20 |
| Terminal horizon | age > 20 | none | none | none | none |
| Overflow → | memory | memory | memory | memory | memory |
| Retired reachable | yes, by age | no | no | no | no |
| Direction of caution | omit-lean | retain-lean | retain-lean | omit-lean | omit-lean |
| History as input | no | no | no | no | no |

C-5 mechanics: rank top-20, dedup within those 20, mark collapsed entries `memory` with reason
`duplicate_suppressed`, no backfill. Where the substring-replacement branch fires, the entry recorded as
collapsed is the **previously-kept newer value**, not the surviving older one.

**R-10** An attribute whose bucket is outside the verified vocabulary belongs to no category. It is
**excluded from output and recorded in the archive** with a reason naming the unrecognized bucket. It is
never assigned to a category by inference. The `object`-bucket exclusion is untouched. This is a
deliberate behavior change — such an attribute renders today (F-31) — and R-27 declares it an approved
shadow difference.

**R-11** `live` — inside the bound, rendered in full, the renderer may not drop one. `memory` — displaced
from the live set **without a terminal verdict, by either a capacity bound or a non-terminal age window**,
asserting nothing about ending or falsity. `retired` — policy expiry, claiming no observed ending. The
projector has no reinstatement path: a retained assertion instance with unchanged `turn_set` may not
re-enter `live` after retirement. Upstream deletion followed by later same-key creation with a new
`turn_set` is a new assertion instance, not projector reinstatement. No disposition asserts an
unrecorded world event.
*The `memory` wording follows charter revision 10. It closes C-1's 6–20 age band, which the approved
matrix left with no available disposition — live ends at 5, retired begins past 20.*

**R-12** Retirement is a projection-time verdict recomputed each turn from `turn_set` and the current
turn. The projector never deletes, rewrites, or annotates the assertion store to express it.

**R-13** The projector performs no reconciliation against object or condition authority and simulates
none. Under the amended §3 item 5 (§14), that obligation binds only where a managed assertion carries a
mechanically resolvable reference to those authorities; none does.

**R-14** C-7 is carried, not managed. Rendered form preserved exactly: four-field guard, fallback order,
part order and labels.

**R-15** Passthrough elements rendering inside managed lines are represented in the packet as separately
classified parts of those lines, so R-19 can treat the parts differently.

**R-16** C-6 and C-8 are carried, accounted for, never silently dropped, and receive no disposition.

### 7.4 Render

**R-17** The seam receives a non-null string. Section order, headers, rule lines, separators, absence
markers, field labels, delimiters, and placeholders are reproduced exactly. Every consumer at F-22
continues to work unmodified.

**R-18** The renderer renders exactly the live set — no independent truncation, sampling, reordering, or
dropping, and no non-live fact. Order preserves current behavior, which differs by category:

- `You:` — storage order of `player.attributes` across survivors;
- C-4 — `turn_set` descending;
- **C-5 — first-appearance order of canonical keys, with a replaced survivor holding its original
  position** (F-11). This is **not** `turn_set`-descending over surviving values. An implementation that
  sorts survivors by `turn_set` produces a different string than current code.

**"Exactly the live set" extends to line presence, not only line content.** A line asserting there is
live content — a category label such as `[locLabel]:` — must not render over zero live contributors, in
live mode only. This is a live-mode-only consequence of R-10 vocabulary exclusion, ruled during the G-10
follow-up review; see §8 U-4 for the one place it currently applies (C-5's label) and why it does not
retroactively change any *other* currently-reachable empty-render case.

### 7.5 Failure

**R-19** On projector failure:

| Content | Behavior |
|---|---|
| **C-1, C-2, C-3** (player attributes) | **Replay last-good.** They carry the stable `You:` subject and are bound to no place or person |
| **C-4, C-5** | **Omitted.** They are bound to the currently visible NPCs and the current location, so replaying them after a move or a visibility change would attribute facts to the wrong subject — and their rendered subject label is authority-owned and may not be replayed |
| **Auxiliary** (C-6, C-8, mood marker) | Omitted |
| **Passthrough** (C-7, suffix, labels, NPC-absence marker) | Omitted, never stale-replayed |
| **Framing** | Emitted normally |

A **shadow-mode packet counts as last-good** — it was produced by the real projector from real state;
narrator delivery does not make a packet more truthful. Where no prior qualifying packet exists, managed
continuity is omitted and the failure record notes the absence.

**The failure record has two parts, with different jobs, and neither is guaranteed durable.** It is
written into the in-memory turn record, which reaches disk through the existing autosave — the
**persisted** half, subject to the same swallowed-failure model as every other write in the turn
(F-26). And it is emitted to the console immediately — the **visible** half, which is immediate
visibility, not storage.

**This is a deliberate limit, not an oversight.** Guaranteeing durability would require a synchronous
confirmed write on the turn's critical path, which was rejected as disproportionate to the stakes. The
consequence is that release one records packet failure on the same terms as everything else the engine
persists, and no better. **Charter INV-8's promise of a durably recorded failure is amended accordingly
(§14 item 4).** No new durable-write mechanism is built.

**The failure does not abort the turn.** This is new behavior (F-29).

### 7.6 Write ownership

**R-20** Nothing outside this enumeration may be written:

| Write | Owner | Constraint |
|---|---|---|
| `turnContext.stateAttrsSuppressed` | Projector | **Meaning unchanged**: it counts C-1 facts excluded by the age≤5 rule and nothing else. Exclusions from the new count bounds are accounted separately in the archive |
| `gameState._lastIdentityTruthLine` | Projector | Byte-identical to the rendered `Player:` line; `null` when no identity field is present; reset must be failure-safe (R-22) |
| `w._lastPhaseBLoc = null` | **Projector**, per R-21 | Cleared after successful construction |
| `console.log('[CB-DEDUP] …')` | Projector | Preserved (R-25) |

**R-21** Single-use content is cleared by the projector **after successful packet construction**.
Durable archival is asynchronous and completes after the content has already reached the narrator
(F-24, F-26), so archival success is **not** a precondition of consumption; an archival failure is
recorded but does not retroactively affect the current turn's output or the completed clear.

On **construction** failure the content is omitted from output and **not cleared**. "Not cleared" means
the projector performs no clear; it does not guarantee the upstream producer will refrain from replacing
the value later in the same turn (F-25).

**Suppression is not failure.** The current unconditional clear on cell-move suppression and on non-L0
layers (F-16) is preserved — those are successful projections in which the content was deliberately not
rendered.

**R-22** After a failed projection, `gameState._lastIdentityTruthLine` must not retain a prior turn's
value, and consequently no downstream surface can emit one (F-21). The contract is on the stored field,
not merely on what is emitted.

### 7.7 Archiving

**R-23** Every inclusion, exclusion, demotion, and retirement is archived with the fact it applies to,
the category policy that produced it, and the reason.

**R-24** Every read in F-3, and every section, label, marker, and framing literal in F-17…F-19, maps to
exactly one recorded treatment: managed category, auxiliary, passthrough, framing, or deliberate
recorded drop. The accounting is built from F-3, not from the extraction artifact's six-input list.

**R-25** These continue to be produced with unchanged type and meaning:
`narration_debug.state_attrs_suppressed`, `continuity_block_text`, `continuity_block_chars`,
`continuity_injected`, the rolling three-block history, `/diagnostics/continuity`'s `rendered_block`, and
the `[CB-DEDUP]` console line.

**R-26** The packet archive must not depend on being present in the flight-recorder JSONL for the same
turn unless written before serialization at `index.js:8349` (F-27).

### 7.8 Cutover

**R-27** Shadow comparison is a mandatory cutover gate, with four properties:

1. **Input isolation.** Both implementations receive the same pre-mutation state. The existing assembler
   is impure (F-20) — invoking the two sequentially against the live object consumes `_lastPhaseBLoc`
   before the second reads it, producing a false C-8 difference. Baseline side effects must be isolated
   or replayed, not shared.
2. **Comparison method.** A declared normalization or fact-level comparison that can classify a
   difference by category. "Equal except" is not an executable criterion.
3. **Approved difference set.** **Content** differs **only** in: C-1's new top-10, C-2's new top-12,
   C-3's new top-8, and **unknown-bucket attributes now excluded and logged** (R-10). Any other content
   difference fails the gate.

   **Structural consequences of those exclusions are approved, and only these four — each settled by user
   ruling during the G-10 follow-up review, not inferred:**

   | # | Consequence | Approved when |
   |---|---|---|
   | A | The `You:` line disappears | every player attribute is `unrecognized_bucket` |
   | B | An NPC line disappears | that NPC's in-window attributes are all `unrecognized_bucket` **and** it has no recognition suffix — the same condition under which the existing assembler already omits an NPC line (`:1980`, U-3), applied to a smaller attribute set, not a new rule |
   | C | The location line disappears | every surviving location attribute is `unrecognized_bucket` — **new behavior**, since the existing assembler has no vocabulary exclusion and so can never reach a state where a populated location record renders empty; see R-18, U-4 |
   | D | The empty-scene marker appears where the baseline has none | **solely** as a downstream consequence of A and/or B and/or C, and only when each contributing loss was itself approved |

   A capacity bound (`overflow_capacity`) can never cause A, B, or C: bounds trim a category, they do not
   empty one — only vocabulary exclusion can. **Content appearing in the new implementation that the
   baseline lacks is never approved, under any reason** — the new implementation may only ever withhold
   relative to the baseline.
4. **Forced overflow.** The shadow period must include deliberately constructed cases that exceed each
   of the C-1, C-2, and C-3 bounds. Ordinary play may never reach them, and a gate that passes without
   exercising the caps has validated nothing about them.

**Bound acceptance is human judgment, not a computed threshold.** Whether 10 / 12 / 8 still read well is
a narration-quality question, decided by the user reading before-and-after TRUTH blocks. The automated
half of the gate is property 3.

**R-28** Disabling the projector restores exactly current upstream behavior. No upstream system acquires
a dependency on it.

**R-29** At cutover the affected narrator-input set is exactly the string interpolated at
`index.js:6189`.

### 7.9 Extensibility and contract dependence

**R-30** Lifecycle evidence enters through a single input boundary. `turn_set` must not be hard-coded as
the only lifecycle evidence the projector can understand; adding a future source must require changes
only at that boundary and within category policy. Note that C-5's `duplicate_suppressed` disposition also
consumes the attribute value and its canonical form, so the boundary review must account for
value-derived inputs. **Release one adds no invalidation producer and must not design one.**

**R-31** Each category declares whether its bound is projector-enforced or contract-dependent. C-1, C-2,
C-3, C-5 and **C-4's per-NPC bound of 20** are projector-enforced. **The number of visible NPCs is
contract-dependent.** Because no verified predicate defines the engine's occupancy contract (U-1), the
projector **records the visible-NPC count every turn as a diagnostic** rather than asserting a threshold.
No multi-NPC selection behavior is defined.

### 7.10 Preservation

**R-32** The `w._visible_npcs` fallback at `ContinuityBrain.js:1926` is the route by which a
founding-prompt NPC created at L0 on turn 1 reaches the TRUTH block. It must not be altered, simplified,
or refactored out of the projector or its input supply. Removing it would delete C-4 content from the
narrator's world as a side effect of replacement. *That the path exists is source-verified; that it
succeeds at runtime is carried, not verified.* **[tier-2]**

**R-33** `_lastIdentityTruthLine` continues to be produced, including its `null` reset, byte-identical to
the rendered line otherwise.

---

## 8. Unchanged behavior

| # | Must not change |
|---|---|
| U-1 | The call site, its position in the turn cycle, its synchronous string return |
| U-2 | Section order, headers, rule lines, separators, markers, labels, delimiters, `'—'` placeholders |
| U-3 | C-4 output — per-NPC top-20, `turn_set` desc, the label rule at `:1968`, the skip at `:1980`, the `.slice(3)` suffix-only form at `:1981` |
| U-4 | C-5 output — top-20 then dedup within, no backfill, the substring exception at `:2019`, the coercion at `:2009`, the `[locLabel]` derivation. **Ruled exception, live mode only:** when every surviving location attribute is `unrecognized_bucket`, the label and line are omitted rather than rendering `[locLabel]: ` empty — a state the existing assembler cannot reach (it has no vocabulary exclusion), so U-4 protects a rule the old code never needed and this exception does not weaken it. Compat mode is unaffected; the attribute-coerces-to-`''` case at `:2009` is untouched and still renders `[locLabel]: ` in both modes, since that state *is* reachable today. See R-18 |
| U-5 | C-6 output — location filter including the `undefined`-key exception, last-5, expanded latest, reversed trajectory |
| U-6 | C-7 output — guard, fallback order, part order, labels |
| U-7 | C-8 output and its three suppression conditions |
| U-8 | Recognition suffix and F-19 labels — exact text and position |
| U-9 | C-1's age filter, including the null-`turn_set` exemption |
| U-10 | `state_attrs_suppressed` meaning and type |
| U-11 | Every consumer at F-22 |
| U-12 | Phase B promotion, filtering, bucket assignment, `turn_set` stamping, `promotion_log`, `_lastPhaseBLoc` production |
| U-13 | Arbiter behavior and its ordering after the projection point |
| U-14 | The three continuity routes outside the seam |
| U-15 | The founding-friend L0 path |
| U-16 | `turn_history` push-only growth |
| U-17 | The `object`-bucket exclusion at `:1933` and `:1970` |

---

## 9. Invariants

| ID | Contract | Discharged by | Falsified by |
|---|---|---|---|
| INV-1 | Determinism | R-5, R-6, R-7 | Two projections over identical state differing in packet, disposition, reason, or string |
| INV-2 | Inspectability | R-23, R-24, R-26 | Any disposition without an archived reason |
| INV-3 | Domain precedence | R-13, under amended §3 item 5 | Reconciliation performed or simulated |
| INV-4 | No projector resurrection | R-11, R-12, I-2 | A retained assertion instance re-entering `live` after retirement with unchanged lifecycle evidence; an upstream-deleted key later created with a new `turn_set` is a new instance, not a violation |
| INV-5 | Declared policy only | R-9, R-11 | A disposition untraceable to a named policy, or asserting an unrecorded event |
| INV-6 | No state mutation | R-12, R-20 | Any write outside R-20's four rows |
| INV-7 | Bounded live set | R-9, R-18 | A live fact absent from render, or a non-live fact present |
| INV-8 | Failure visibility, **as amended** (§14 item 4) | R-19, R-22 | Silent failure; stale passthrough; a failure aborting the turn. **Not** falsified by the failure record being lost to a swallowed write — release one does not promise that |
| INV-9 | Authority isolation | R-3, R-28, R-32 | Any upstream behavior differing with the projector disabled |
| INV-10 | Replacement scope | R-29 | Any narrator input outside `index.js:6189` changing |
| INV-11 | Fixed projection point | R-4 | Any projector read outside the call site |
| INV-12 | Complete disposition | R-8, R-9, R-10 | A managed fact unassigned after projection |
| INV-13 | Standalone component | R-1, R-2 | Selection or disposition logic in an existing file |
| INV-14 | Evidence-source extensibility | R-30 | `turn_set` hard-coded as the sole lifecycle input |
| INV-15 | Seam accounting | R-24, R-32 | Any read, section, marker, or literal without exactly one treatment |
| INV-16 | Transactional consumption | R-21, under amended INV-16 | Single-use content cleared on a construction failure |
| INV-17 | Bounded-by-contract declared | R-31 | A contract violation silently normalized, or a threshold asserted without evidence |

---

## 10. Scope exclusions

From the charter, unchanged: EX-1 … EX-13; DEF-1 deferred, not rejected.

| ID | Excluded | Why |
|---|---|---|
| X-1 | Any change to Phase B extraction, promotion, bucket assignment, or `turn_set` stamping | Changes projector inputs and invalidates shadow comparison |
| X-2 | Any change to assertion identity or storage shape | Upstream work gated by D-6/EV-10/EV-11; no requirement needs it |
| X-3 | Any change to the Arbiter | It is the authority for four passthrough elements |
| X-4 | Repair of the JSONL / `turn_history` divergence | Log-not-repair; R-26 accommodates it |
| X-5 | Repair or removal of the vestigial NarrativeContinuity path | Not seam output |
| X-6 | A turn counter, or trimming/compacting `turn_history` | Would silently shift every age-based disposition |
| X-7 | Multi-NPC selection behavior for C-4 | Inventing selection is a new mechanic |
| X-8 | Narrator prompt text outside the interpolated block | Replacement scope |
| X-9 | **Unrelated** changes to docs, changelog, package version, tests, git state, agent files, prompts | Scope discipline. Verification support required by §12 is not excluded and is subject to normal approval |
| X-10 | Any change to the `object`-bucket exclusion | Settled boundary |

**Blast radius: multi-file contract change.** One new file carrying all logic, plus bounded integration
at one call site, its archive path, and its render path in `index.js`, with a preserved read-only
contract to `diagnostics.js` and `Index.html`. No authority boundary moves; no upstream producer is
modified. The single-use clear stays inside the projector (R-21), so `index.js` gains no mutation
responsibility.

---

## 11. Minimal safe change surface

| Surface | Role |
|---|---|
| One new source file | All selection, policy, disposition, bound, reason, classification, render, and the single-use clear |
| `index.js:4473–4476` | Input supply and invocation |
| `index.js` archive path | Durable archival of the packet; placement constrained by F-27 |
| `index.js:6189` | Render at the seam; string contract unchanged |
| `ContinuityBrain.js:1912–2106` | Removed from the live path at cutover only; not modified during shadow |

**Verify before editing:** that the call site, the four write sites, the F-22 consumers, and the two
`_lastIdentityTruthLine` consumers still match §3. Any mismatch is S-1.

**Why not narrower:** the packet archive cannot be projector-side without the projector performing I/O
the charter does not assign it.

**Why not broader:** no requirement needs a storage change, an upstream producer change, or a new
evidence channel. Every disposition derives from inputs the projector can already read at the projection
point — `turn_set`, bucket, category, the current turn, and, for C-5's dedup, the attribute value and its
canonical form.

---

## 12. Verification matrix

Columns: **Contract · Trigger · Evidence · Pass · Fail · Class · Type**.
Classes: `I` intended · `U` unchanged · `E` edge · `N` negative · `C` contradiction · `A` authority ·
`R` regression.

| ID | Contract | Trigger | Evidence | Pass | Fail | Class | Type |
|---|---|---|---|---|---|---|---|
| V-01 | R-1 | Any selection/disposition logic | Diff | All in the new file | Any in an existing file | I | Diff |
| V-02 | R-2 | Any existing-file edit | Diff | Each hunk is one of four kinds | Any hunk outside them | I | Diff |
| V-03 | R-3 | Any upstream edit | Diff + approval record | Additive, read-only, approved | New semantics, mutation, or unapproved | A | User |
| V-04 | R-4 | Full turn | Diff | One projector read site | Any read elsewhere | I | Source |
| V-05 | R-5 | Same state projected twice | Packet, dispositions, reasons, string | Byte-exact on all four | Any difference | I | Runtime |
| V-06 | R-6 | Category with ≥2 facts sharing `turn_set`, plus a null-stamped fact | Packet order | `turn_set` desc, ties in storage order, null last | Any other order | E | Runtime |
| V-07 | R-7 | Any projection | Diff | Turn from `turn_history.length + 1` | Any other source | U | Source |
| V-08 | R-8 | Every output element | Packet + accounting | Each in exactly one class; framing unclassified but accounted | Any element unclassified or double-classified | I | Runtime |
| V-09 | R-9 | Overflow per category | Packet | Live set within bound; every excluded fact non-live with a reason | Bound exceeded or missing disposition | I | Runtime |
| V-10 | R-9 | C-1 fact with null `turn_set`, aged past 5 | Packet | Still live — age exemption preserved | Suppressed | E | Runtime |
| V-11 | R-10 | Synthetic attribute in an out-of-vocabulary bucket | Output + archive | Excluded from output, recorded with an unrecognized-bucket reason; `object` handling unchanged | Rendered, silently dropped, or inferred into a category | N | Runtime |
| V-12 | R-11 | Retire a retained assertion; advance turns without upstream deletion or recreation | Packet over turns plus the stored key and `turn_set` | The same assertion instance never re-enters `live`; a later same-key record is distinguishable by a new `turn_set` | Re-entry with the original stored key and unchanged `turn_set`, or same-key recreation retaining the prior lifecycle stamp | I | Runtime |
| V-13 | R-11 | Every disposition | Archive | Traces to a named policy; asserts no unrecorded event | Any that does not | A | Runtime |
| V-14 | R-12 | Facts past C-1's horizon | `player.attributes` before/after | Store byte-identical | Any key deleted, rewritten, annotated | A | Runtime |
| V-15 | R-20 | Full projection | Authoritative-state snapshot | Identical; every write in R-20's four rows | Any fifth write | A | Runtime |
| V-16 | R-13 | Any projection | Diff + packet | No reconciliation performed or simulated | Any performed or inferred | A | Source |
| V-17 | R-14 | Identity present, absent, each field subset | Rendered string | Byte-identical, including fallback | Any difference | U | Shadow |
| V-18 | R-15 | NPC with recognition; learned and unlearned labels | Rendered string | Suffix and labels byte-identical, including the `.slice(3)` form | Any difference | U | Shadow |
| V-19 | R-16 | C-6, C-8 present | Packet | Carried and accounted; no disposition | Disposition attached, or silently dropped | I | Runtime |
| V-20 | R-17 | Any projection, including empty state | Return value | Non-null string always | `null`, `undefined`, non-string | R | Runtime |
| V-21 | R-17 | Empty attrs; zero NPCs; no mood; no context; **and the narrow case where NPCs are present but all skipped** | Rendered string | Every F-17/F-18 literal exact | Any missing, reworded, reordered | U | Shadow |
| V-22 | R-18 | Overflow input | Live set vs string | Rendered content is exactly the live set | A live fact absent, or a non-live fact present | I | Runtime |
| V-23 | R-18 | Multi-fact categories; **C-5 case must include a substring-replacement collision** | Rendered string | `You:` storage order; C-4 `turn_set` desc; C-5 first-appearance order with the replaced survivor in its original position | Any reordering, including "correcting" C-5 to `turn_set` desc | U | Shadow |
| V-24 | R-19 | Induced failure across five cases: no prior packet; only shadow-mode priors; same scene; after a location change; after a visible-NPC change | Rendered output + failure record | C-1/C-2/C-3 replay last-good; C-4/C-5 omitted; auxiliary and passthrough omitted; framing emitted; failure recorded in the turn record and on the console | Any stale passthrough; any C-4/C-5 content from a prior turn; silent failure; no defined behavior for the no-prior case | I | Runtime |
| V-25 | R-19 | Induced failure | HTTP response | Turn completes; no `narrator_error`; no `_abortTurn` | Turn aborts | I | Runtime |
| V-26 | R-20 | Turn with both aged-out and bound-excluded C-1 facts | `state_attrs_suppressed` + archive | Counter reflects age exclusions only | Bound exclusions folded in | R | Runtime |
| V-27 | R-21 | Induce construction failure after the single-use read | `w._lastPhaseBLoc` **immediately after the failed projection, before `CB.runPhaseB` runs at `index.js:6353`** | Content absent from output; projector performed no clear | Cleared, or content emitted. *Checking at the following projection is not valid proof — Phase B's replacement is indistinguishable from preservation* | I | Runtime |
| V-28 | R-21 | Cell-move turn and non-L0 turn | `w._lastPhaseBLoc` after projection | Cleared in both, as today | Left pending on a suppressed-but-successful projection | U | Runtime |
| V-29 | R-22 | Induced failure **before the reset point** | `gameState._lastIdentityTruthLine` **and** the HTTP response field | Neither holds a prior turn's value | Either does — the stored field alone fails the row | E | Runtime |
| V-30 | R-23 | Any projection | Archive | Every inclusion, exclusion, demotion, retirement has a reason | Any unaccounted | I | Runtime |
| V-31 | R-23 | C-5 dedup collision hitting the substring branch | Archive | The collapsed entry recorded is the previously-kept newer value | The wrong entry recorded | E | Runtime |
| V-32 | R-24 | Cutover | Accounting vs F-3/F-17/F-18/F-19 | Every read, section, marker, literal maps to one treatment | Any unaccounted item | I | Source + user |
| V-33 | R-25 | Full turn | Each named surface | All produced, unchanged type and meaning | Any missing or changed | R | Runtime |
| V-34 | R-26 | Full turn | Archive location vs `index.js:8349` | No assumption of same-turn JSONL presence unless written before serialization | Archive silently absent from the turn's record | E | Source |
| V-35 | R-27 (1) | Shadow run | Both implementations' inputs | Both receive the same pre-mutation state; baseline side effects isolated | Shared mutable state producing a false difference | C | Runtime |
| V-36 | R-27 (3) | Shadow run over real turns | Classified diff — byte gate (`compatEqual`) **and** structural manifest gate (`structural.approved`), independent signals, both required | Content differences confined to C-1/C-2/C-3 bounds and unknown-bucket exclusions; every structural consequence is one of the four approved cases A–D | Any other content difference; any unapproved structural consequence; any content present in the new implementation the baseline lacks, under any reason; the manifest gate failing to classify an input and reporting it as approved instead of closed | I | Runtime |
| V-37 | R-27 (4) | **Constructed** cases exceeding each of the C-1, C-2, C-3 bounds | Classified diff | Each bound demonstrably exercised; differences confined as above | The shadow period completes without any category reaching its cap | I | Runtime |
| V-38 | R-28 | Projector disabled | Upstream behavior | Identical to pre-project | Any upstream difference | A | Runtime |
| V-39 | R-29 | Cutover | Enumerated narrator inputs | Exactly `index.js:6189` changes | Any other input affected | A | Source |
| V-40 | R-30 | Review of the evidence boundary | Source | A lifecycle source could be added at boundary + policy only; value-derived C-5 inputs accounted for | `turn_set` reachable from construction, archiving, or rendering | I | Source + user |
| V-41 | R-31 | Each category; any turn | Policy declaration + diagnostic output | Each states its classification; visible-NPC count recorded every turn | Any category silent, or a threshold asserted without evidence | I | Source + runtime |
| V-42 | R-32 | Turn 1 with a founding-prompt NPC at L0 | Rendered TRUTH block | NPC appears exactly as today | NPC missing or altered | R | Runtime |
| V-43 | R-33 | Identity present, then absent | Response field + `Index.html` | Byte-identical; `null` when absent | Missing, stale, divergent | R | Runtime |

**Bound acceptance (R-27) is deliberately not a matrix row.** It is a human judgment on sample output,
and writing it as a binary criterion would be theater.

---

## 13. Stop conditions

| ID | Trigger | Why unsafe | Next |
|---|---|---|---|
| S-1 | Live source no longer matches a §3 fact | Every requirement traces to §3; drift misdirects shadow comparison | Re-verify §3; mark the requirement stale |
| S-2 | Implementation requires a change to assertion identity or storage shape | Excluded at X-2; no requirement needs it, so needing it means a requirement was misread | User decision |
| S-3 | Any of the seven §14 amendments is found not enacted, or is later reverted | R-13, R-21, R-8, R-19, R-24, R-11, and INV-4 depend on them; implementing against an unamended charter would make the charter and the code disagree | Verify charter revisions 8, 9, 10, and 11; enact what is missing, or revise the requirements |
| S-4 | An output element fits no class in R-8 | INV-12 and INV-15 both fail silently | User classification decision |
| S-5 | Shadow comparison produces a difference outside R-27's approved set | The gate exists for exactly this | Diagnose to a named cause; do not cut over |
| S-6 | Any work introduces trimming or compaction of `turn_history`, or a different current-turn source | Every age-based disposition shifts silently, with no diagnostic | Stop; out of scope |
| S-7 | A requirement appears to need a new invalidation-evidence producer | That is DEF-1, deferred by decision | Stop; the requirement is misread |
| S-8 | The projector must perform I/O, mutate authoritative state, or write outside R-20 | INV-6's enumeration is exhaustive | Stop; user decision |
| S-9 | An adjacent defect appears to require repair to complete the work | Log-not-repair; if the work genuinely cannot proceed, the scope boundary is wrong | Log it; obtain explicit scope expansion |
| S-10 | The shadow period ends without any category having reached its cap | The caps were never validated; the gate passed on nothing | Construct overflow cases (V-37) before cutover |

---

## 14. Charter amendments

Seven, **all enacted** by the user in the charter's own revision log. Stated here as effect; the charter
carries the binding wording. Items 1–4 landed as charter **revision 8**, item 5 as **revision 9**, item 6
as **revision 10**, and item 7 as **revision 11**.

| # | Provision | Effect |
|---|---|---|
| 1 | **§3 item 5** | The obligation to read object and player-condition state as constraints binds only where a managed assertion carries a mechanically resolvable reference to those authorities. None currently does. |
| 2 | **INV-16** | Consumption of single-use content is gated on successful packet **construction**, not on durable archival, because archival is asynchronous and completes after the content has reached the narrator. Archival failure is recorded but does not affect the current turn's output. "Left pending" means the projector performs no clear. |
| 3 | **§2** | The three content kinds classify semantic content. Framing text generated by the packet — headers, rule lines, separators — is not content and receives no classification, while remaining subject to INV-15 accounting and byte-level preservation. A generated line that asserts a fact about the world is content, classified by what it asserts, and a field placeholder belongs to the content it stands in for. |
| 4 | **INV-8** | Packet failure is **recorded** — into the turn record and to the console immediately — on the same persistence terms as the rest of the turn, which are asynchronous with swallowed write failures. Release one does not guarantee the record survives a disk failure, because guaranteeing it would require a synchronous confirmed write on the turn's critical path. The invariant's other clauses are unchanged: failure never silently erases continuity truth, and the class-by-class behavior in §10.1 still holds. |
| 5 | **INV-15** | The treatment enumeration reconciled with §2: **five** treatments, not three — managed category, auxiliary seam content, current-state authority passthrough, framing, or deliberate recorded drop. Passthrough entered §2 at charter revision 7 and framing at revision 8; neither had been carried into the invariant, which named a treatment set that no longer existed. Reconciliation only; no behavior, scope, or obligation changed. |
| 6 | **§2, `memory`** | Broadened to mean displacement from the live set **without a terminal verdict, by either a capacity bound or a non-terminal age window** — previously by capacity alone. Its guarantee is unchanged: it asserts nothing about ending or falsity, recording only that a displacement rule applied. **Why needed:** the approved C-1 matrix makes a fact live at age ≤5 and retired past 20 and assigns nothing to 6–20; with a closed disposition set those facts had no available verdict, and the prior wording was definitional rather than illustrative, so using `memory` widened it rather than applying it. Reflected in R-11. |
| 7 | **§2, INV-4, F-9** | No-resurrection is scoped to a retained assertion instance with the same stored key and unchanged `turn_set`. A genuine spatial boundary may delete a player `state` assertion upstream, and later extraction may create the same key with a new `turn_set`; that is a new assertion instance, not projector reinstatement. Reflected in F-30, I-2, R-11, INV-4, and V-12. |

---

## 15. Lower-tier claims

These are carried at a lower evidentiary tier than the rest and should be treated as such by G-8 and by
any later reader. Each is a repository-wide negative or a runtime claim that source reading supports but
does not certify.

| Claim | What is established | What is not |
|---|---|---|
| F-12 | The only location-attribute writer **found** produces `bucket: 'environment'` | That no other writer exists anywhere |
| F-22 | The listed consumers are verified | That the list is exhaustive |
| F-28 | No `turn_history` mutation found outside `:902`, `:975`, `:8345`; greps covered `tests/` and `scripts/` | Unrestricted repository-wide absence — `historical-reference/` and `saves/` were excluded |
| F-30 | The five create-if-absent writers, the player-`state` boundary deletion path, and absence of in-place `turn_set` updates were verified in the stated grep scope; source permits same-key player-`state` recreation after deletion | Unrestricted repository-wide absence of other mutators, or that same-key recreation has been observed in a live session |
| F-32 | A documented historical `object:` producer exists and is absent from current source | That every persisted `object` bucket came from it |
| F-33 | `canonical_name` / `title_or_role` have no writer **found** outside the founding path | That none exists |
| R-32 | The founding-friend L0 path exists in source | That it succeeds at runtime |

---

## 16. Adjacent findings — logged, not repaired

| ID | Finding |
|---|---|
| L-1 | Player identity form fields are mutable by the Arbiter and a record with prior form is constructed (F-33). Its **durability** is not established: the JSONL is already serialized (F-27) and the autosave swallows failure (F-26). Recorded for whatever future work takes up C-7's lifecycle |
| L-2 | `index.js:4482` and `:4469–4471` sit on the vestigial NarrativeContinuity path (U-5) |
| L-3 | The C-5 render path applies no bucket filter, unlike the player and NPC paths (F-12). Asymmetry, not a proven defect |
| L-4 | All three disk writes swallow failures (F-26). Archive completeness holds on the success path only — which is why §14 item 4 amends INV-8 rather than the projector adding a write of its own |
| L-5 | `turn_history` is pushed at two sites, so aborted turns advance the age clock (F-28). Existing behavior, unchanged by this project |
| L-6 | **`motherbrain.js:1102` is stale on two counts** — it documents a `possessions → object:` promoter that no longer exists, and states that `object:` entries "always appear in the narrator TRUTH block," which `:1933` and `:1970` contradict. Worth a separate task: the doctrine actively misdirects investigation |
| L-7 | `gameState._lastIdentityTruthLine` can survive a failed projection and be emitted at `index.js:8731` (F-21). In scope here as R-22, listed because it is a live defect in current code |

---

## 17. Revision log

| # | Date | Change |
|---|---|---|
| 2 | 2026-08-04 | **Post-implementation reconciliation.** R-27 property 3 restated: the prior blanket claim — "equal for C-4, C-5, C-6, C-7, C-8, passthrough, and every framing literal" — is false. A G-10 follow-up review that executed the shipped code against constructed edge cases (not a re-read) found that withholding entries can delete a whole line, and can trigger the empty-scene marker as a knock-on effect; neither is visible to a per-category content diff. Property 3 now separates **content** differences (unchanged: only the three new bounds and unrecognized-bucket exclusion) from four **structural** consequences, each an explicit user ruling: the `You:` line, an NPC line, or the location line disappearing under stated conditions, and the empty-scene marker appearing only as their downstream effect. R-18 gained a note that "exactly the live set" extends to line presence, not only content. §8 U-4 gained a ruled exception: the location line now omits itself in live mode when zero attributes survive vocabulary exclusion — new behavior, since the existing assembler has no vocabulary filter and can never reach that state, so nothing prior is weakened. V-36 updated to require both the byte gate and the new structural manifest gate, and to fail closed on unclassifiable input. R-27, R-18, and U-4's text plainly changed — that is what this revision is. What did not happen is a **new design decision**: every changed word reconciles wording to a user ruling already made and code already corrected, not a fresh choice made in the course of editing this document. See `CONTINUITY_PROJECTION_IMPLEMENTATION_PLAN.md` revision 7 for the corresponding implementation-side account. |
| 1 | 2026-08-03 | Written at G-7 from the charter, the extraction artifact §10/§11, and direct source verification. Supersedes four prior revisions of this file, which carried unresolved decision clusters and their audit history; those decisions are settled and the amendments they require are §14. |
