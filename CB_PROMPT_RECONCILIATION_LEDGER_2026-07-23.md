# Continuity Brain Prompt Reconciliation Ledger

**Created:** 2026-07-23  
**Repository:** `mdunham726-coder/Game-main`  
**Initial source anchor:** `078af6869aa43cbfcb21b4072d0cc2bb7a17203b` (`v1.92.16`)  
**Latest research anchor before D4 integration:** `b5ebb84ef9e59a17496c4775c7bb39f011330335`  
**Purpose:** Rolling evidence and decision ledger for reconciling the Continuity Brain extraction prompt with current engine truth. This file is deliberately not named `research-notes.md` so it remains distinct from prior research artifacts.

## Evidence discipline

- **Proven** means directly supported by current source, repository history, or a live reproduction.
- **Interpretation** means the evidence supports the reading, but the source does not explicitly declare it as a design law.
- **Decision** records the project owner's chosen direction.
- Questions remain open unless a decision is explicitly recorded here.
- GitHub issue #38 is excluded as a proof point for D1-D3 because its suspected reproduction did not survive retesting.
- GitHub issue #42 is accepted as live proof that CB's ordinary post-execution promotion pipeline can create duplicate objects for an operation already executed correctly. Its exact reproduction is whole-stack THROW, so it supports the general containment concern without automatically deciding every partial-operation channel.

## Question register

### D1 — Canonical channel for an unreceipted partial movement while the source survives

Should this case commit to one canonical CB output shape, or may `extraction_events`, Group Extraction candidates, and candidate fallback remain overlapping channels reconciled by code?

**Status:** Open.

### D2 — Fission dual lane

Should a fission remain represented through both `object_retirements + successors` and `fission_events`, with downstream deduplication, or collapse to one channel?

**Status:** Open.

### D3 — TAKE receipt echo versus DROP/THROW dedicated successor-description fields

Should receipt-covered partial TAKE be made mechanically symmetric with DROP/THROW, or should its existing mechanism remain with more honest labeling?

**Status:** Researched; project direction recorded.

### D4 — Independent facts, successful execution receipts, and fail-closed dry-run seals

The original question treated successful operation receipts and fail-closed bridge receipts as though they governed the same turns. Current-source research shows that they do not. The remaining decision is narrower: should a failed or deliberately non-executing DROP/THROW turn continue to freeze every object mutation from that narration, or should the engine attempt to admit independently proven object facts while still suppressing consequences of the failed operation?

**Status:** Researched; original premise corrected; fail-closed object-freeze policy remains open.

### D5 — Real versus simplified container model

This question was split into two distinct decisions:

- **D5a — Spatial depth taxonomy:** Should CB directly use the engine's real `grid` / `site` / `localspace` floor model?
- **D5b — Worn actor containers:** Should CB directly emit `player_worn` / `npc_worn`, or should introduced equipment remain represented through entity `worn_objects` and translated downstream?

**Status:** D5a decided; D5b resolved for prompt reconciliation. A separate later-equipment lifecycle gap is recorded below.

### D6 — Verb and example density

How much acquisition-verb and transfer-origin language should remain after deterministic engine gates became authoritative for the hard cases?

**Status:** Open.

---

# D3 research entry — receipt-covered partial TAKE description transport

## Target

Clarify what the repository does for receipt-covered partial TAKE, how that differs from partial DROP and THROW, and whether the asymmetry is stale machinery or an intentional consequence of different operation paths.

## Proven current behavior

1. A validated partial-TAKE receipt is accepted only after `ContinuityBrain.runPhaseB()` checks it against current ORS state: matching turn, TLS/ObjectHelper authority, executed status, distinct source and successor IDs, surviving active source, same-turn active successor, parent linkage, quantity, and player destination.
2. When present, `AUTHORITATIVE PARTIAL EXTRACTION PRECEDENCE` requires exactly one `extraction_events` entry for the receipt-identified operation. It forbids representing that successor as an `object_candidate` and forbids representing either source or successor as an `object_transfer`.
3. After CB returns, `index.js` reads the one extraction event and conditionally uses its `description` as child-specific text for the already-existing successor. It checks event count, quantity, actor, destination, non-empty description, and copied-parent-description rejection, then writes by exact successor ID through `ObjectHelper.setObjectDescriptionDirect()`.
4. The TAKE successor therefore exists before CB describes it. CB does not create that receipt successor.
5. Receipt-covered partial DROP and THROW instead use `partial_drop_successor_description` and `partial_throw_successor_description`. Those fields are explicitly non-executable descriptive metadata, and the receipt-governed operation is excluded from candidates, transfers, extraction events, fission events, and retirements.
6. `index.js` revalidates the receipt and applies each DROP/THROW description directly to the exact successor ID. THROW deliberately mirrors DROP.

## Proven history

- `v1.91.82` (`f8b2f23`) introduced the authoritative partial-TAKE receipt contract, enforcing one extraction event and reconciling the child description.
- `v1.91.91` (`135edd1`) later introduced the dedicated partial-DROP successor-description field.
- `v1.92.12` (`f929cad`) introduced partial THROW by cloning DROP's receipt and successor-description chain.

The chronology shows that DROP/THROW did not reveal an original universal mechanism that TAKE failed to follow. TAKE's contract came first; DROP adopted a later purpose-built field; THROW intentionally followed DROP.

## Interpretation

The asymmetry is real but not inherently contradictory. Partial TAKE moves a successor into player ownership and retained the extraction-event representation. Partial DROP and THROW move a successor out to Ground and were built later around dedicated receipt-bound descriptive metadata.

The clarity problem is TAKE's mixed identity: the event is shaped and labeled like a general extraction witness, while on this validated receipt path the engine has already executed the split and the downstream consumer uses the event's description to reconcile the existing child.

Issue #42 supports strong separation between receipt-bound description recovery and fresh promotion claims, but it does not prove that TAKE must adopt the DROP/THROW field shape. The reproduced failure is ordinary whole-stack THROW promotion, not this receipt-covered partial-TAKE path.

## D3 decision

**Preserve the existing TAKE, DROP, and THROW mechanics. Do not redesign TAKE merely for schema symmetry.**

- TAKE keeps its receipt-governed `extraction_events` echo.
- The prompt should describe that specific entry honestly as receipt-bound, post-execution description reconciliation for an already-created successor—not as authorization or independent execution.
- DROP and THROW keep their dedicated non-executable `partial_*_successor_description` fields.
- D3 can be resolved without first deciding D1.

---

# D4 research entry — independent facts versus receipt and seal scope

## Target

Answer four concrete questions before deciding D4:

1. What facts does the prompt mean when it says that independent facts may still use their normal channels?
2. Which channels are those facts supposed to enter, and what do downstream consumers do with them?
3. Do those facts currently reach their intended consumers, or are they stopped? If stopped, where?
4. What behavior is currently missing that would occur if the blocked facts were allowed through?

The original D4 formulation assumed one direct contradiction: the prompt promises that unrelated facts can flow on a receipt-governed turn, while the engine's receipt seal supposedly zeros every CB object channel on that same turn. Current source does not support that exact premise.

## Critical correction: two different kinds of receipt were conflated

The repository uses receipt-like evidence in two materially different situations.

### A. Successful execution receipts

These are the validated authoritative receipts supplied to CB after TLS/ObjectHelper has already executed a supported partial operation:

- `cb_tls_partial_stack_take_v1`
- `cb_tls_partial_stack_drop_v1`
- `cb_tls_partial_stack_throw_v1`

Their prompt rules are operation-scoped:

- Partial TAKE requires one receipt-governed `extraction_events` echo and suppresses candidate/transfer representations of the identified source and successor.
- Partial DROP and partial THROW suppress ordinary mutation-channel representations of the identified operation and permit only their dedicated successor-description fields.
- All three rules state that independent facts unrelated to the identified operation may still use normal channels.

These receipts prove successful execution. They exist to classify and contain CB's description of an operation that has already happened authoritatively.

### B. Fail-closed Object Operation Bridge receipts

The full-turn DROP/THROW dry-run seal is activated from `ObjectOperationBridge.evaluateOperation()` only when a supported semantic single-action object operation did **not** execute.

For DROP or THROW, the bridge requires evidence such as:

- AP recognized the family but refused ownership;
- no live whole-object execution result exists;
- no validated live partial split is confirmed;
- the turn is the supported semantic single-action path.

The bridge then produces `drop_dry_run_seal: true` or `throw_dry_run_seal: true` and a narration constraint stating that no object moved, split, appeared, disappeared, or changed.

These bridge receipts prove non-execution or fail-closed containment. They are not the successful operation receipts described above.

## Proven mutual exclusivity for partial DROP and THROW

The bridge explicitly checks whether partial execution succeeded before activating the seal.

For DROP:

- `partial_drop_execution_confirmed` becomes true only when the instruction, dry run, live `tls_partial_stack_result`, ObjectHelper result, quantities, source/successor IDs, and destination all align.
- `live_drop_execution_absent` requires both no whole-object live result and no confirmed partial execution.
- The dry-run seal activates only when AP refusal is confirmed **and** `live_drop_execution_absent` is true.

Therefore a successfully executed partial DROP cannot simultaneously activate the fail-closed DROP seal.

THROW mirrors the same logic through `partial_throw_execution_confirmed` and `live_throw_execution_absent`. A successfully executed partial THROW cannot simultaneously activate the fail-closed THROW seal.

TAKE does not use the DROP/THROW full-turn seal flags. Its successful partial receipt has separate replay-containment machinery.

### Corrected conclusion

A successful partial TAKE/DROP/THROW execution receipt and an active DROP/THROW fail-closed dry-run seal do not describe the same engine state. The original D4 framing treated them as though they collided on one turn; current source shows that they are different lanes.

## What “independent facts” means in practice

The prompt does not provide a formal definition. The operation-scoped receipt language supports the following interpretation:

> An independent fact is a concrete fact from the same narration that is not another representation, replay, consequence, repair, or reinterpretation of the receipt-identified operation.

Example: the player partially drops three arrows from a tracked stack, while the narration also establishes that a separate lantern is on a table, an NPC picks up an existing book, and rain has soaked the courtyard.

The arrow source, three-arrow successor, quantity change, and placement are receipt-governed. The lantern, the book movement, and the rain are separate facts.

Potential independent facts include:

- a new portable object unrelated to the operation;
- movement of another already-tracked object;
- a physical condition change to another tracked object;
- destruction or fission of another tracked object;
- an unrelated persistent-source extraction;
- an introduced NPC's initial carried or worn objects;
- an NPC's physical features or visible state;
- a location feature or material condition;
- a new player bodily condition or interaction with an existing condition;
- scene mood or conversational trajectory;
- spatial or rejected-interpretation observations that are diagnostic rather than authoritative mutations.

## Where independent object facts are supposed to go

### `object_candidates`

Purpose: introduce a genuinely new concrete portable object.

Expected path:

1. CB emits a candidate.
2. `index.js` applies origin gates, replay suppression, container normalization, and quarantine validation.
3. The surviving candidate becomes a `promote` entry.
4. `ObjectHelper.run()` creates or reconciles the authoritative ORS `ObjectRecord`.

If the candidate has an initial condition, a later initial-condition pass can attach it to the newly promoted object.

### `object_transfers`

Purpose: move an already-tracked object between authoritative containers.

Expected path:

1. CB identifies the exact tracked object ID or a valid same-turn temp reference.
2. `index.js` applies AP/TLS replay suppression and normalizes spatial container types.
3. The surviving transfer enters quarantine.
4. `ObjectHelper.run()` moves the existing object and maintains one-container ownership.

### `object_condition_updates`

Purpose: record a concrete physical change to a tracked object that continues to exist.

Expected path:

- Exact-ID updates call `ObjectHelper.applyConditionUpdate()` directly.
- Name-match fallback can broadcast to all same-name active objects in scene scope when CB cannot disambiguate.

### `object_retirements`

Purpose: mark a tracked object as no longer existing as itself because it was consumed, destroyed, or transformed.

Expected path:

1. The retirement is ID-bound or conservatively resolved.
2. Binding guards attempt to prevent retiring the wrong object.
3. `ObjectHelper.retireObject()` retires the parent.
4. If the retirement includes successors and the parent retirement succeeded, a second pass promotes successor objects atomically.

### `fission_events`

Purpose: provide a prose witness for splitting or division.

Expected path:

1. `SemanticNormalizer.analyze()` converts eligible witness evidence into `fission_operations`.
2. If CB retirement did not already handle the parent, TSL fission injection may retire the resolved source.
3. Successors then enter the existing fission second pass.

### `extraction_events`

Purpose outside the receipt-covered TAKE description echo: witness a portion removed while the tracked source survives.

Expected path:

1. `SemanticNormalizer.analyze()` converts eligible evidence into `extraction_operations`.
2. Resolved non-degenerate extraction operations become `partial_split` quarantine entries.
3. `ObjectHelper.run()` reduces the source and creates the successor.
4. Degenerate full-consumption cases can route through retirement/fission handling.

### NPC introduction `held_objects` / `worn_objects`

Purpose: observe the first narrated inventory and outfit of a newly introduced NPC.

Expected path:

1. CB places the observations under the entity candidate.
2. `index.js` converts them into synthetic candidates targeting `npc` and `npc_worn`.
3. The candidates enter ordinary ObjectHelper promotion.
4. Real ORS objects are created and linked through `object_ids` / `worn_object_ids`.

## Where independent non-object facts are supposed to go

These channels are important because they do not wait for the later ORS quarantine path. `ContinuityBrain.runPhaseB()` applies them synchronously before `index.js` reaches the DROP/THROW object seal.

### `entity_candidates`

- Player physical attributes and observable states are promoted into player attributes.
- Resolved NPC physical attributes, visible states, and object-description facts are promoted into NPC attributes.
- Unresolved NPC references produce warnings and are skipped rather than guessed.

### `environmental_features`

Concrete location facts are promoted into the active localspace, active site, or L0 cell attribute record. Accepted L0 features may also be captured for subsequent context assembly.

### `condition_events`

- `new_condition` can create a durable player condition after dedup checks.
- `interaction` can append treatment, aggravation, or usage evidence to an existing exact condition ID.

### `mood_snapshot`

The snapshot is appended to location-keyed mood history, capped and later rendered into the continuity mood block.

### `spatial_relations` and rejected interpretations

These survive in the extracted packet and diagnostics. No gameplay-state consumer was found that makes them authoritative spatial state or another durable mechanic. They primarily provide observation/debug visibility.

## What happens on a successful execution-receipt turn

No global DROP/THROW dry-run seal activates when the partial operation executed successfully.

The receipt-specific precedence applies only to the identified operation:

- do not recreate the already-existing successor;
- do not move the surviving source as though the whole stack transferred;
- do not route the completed operation through competing mutation channels;
- recover the successor description through the appropriate TAKE or DROP/THROW mechanism.

Unrelated facts remain eligible for their ordinary downstream paths. Research found no blanket successful-receipt gate that zeroes every CB object channel merely because the receipt exists.

Ordinary channel-specific gates can still reject a particular fact for separate reasons, such as unsupported origin, invalid container, ambiguous identity, or replay evidence. That is different from a receipt-wide seal.

## Narrow TAKE caveat

TAKE has broad replay-suppression rules that are not the DROP/THROW dry-run seal:

- environment-to-player candidates can be suppressed when AP reports quarantined/refused ownership;
- world-to-player transfers can be suppressed on TAKE turns when environmental gather is inactive;
- AP/TLS-completed object IDs and matching same-turn temp references are deduplicated.

These rules may deserve a separate targeted audit if the project needs proof that every conceivable unrelated world-to-player fact survives on a TAKE turn. They do not establish the original D4 claim that a successful receipt and a DROP/THROW dry-run seal collide.

## What happens on an actual fail-closed dry-run-sealed turn

CB still runs and can still emit raw evidence. The engine records counts and references for the suppressed object channels and marks that raw evidence was preserved.

The facts then split into two outcomes.

### Object mutations are stopped

The seal turns the following live mutation inputs into empty or inactive paths:

- CB candidates are preserved diagnostically but excluded from the mutation candidate array.
- CB transfers are preserved diagnostically but excluded from the mutation transfer array.
- Object condition updates are replaced with an empty live-processing list.
- Object retirements are replaced with an empty live-processing list.
- TSL fission injection is skipped.
- TSL extraction injection is skipped.
- NPC introduction held/worn materialization is skipped.
- Other object-mutating consumers guarded by the same full-turn seal, including live emote-removal transfer, are prevented from executing.

Repository history for THROW's observe-only migration states that the full-turn seal had seventeen real consumer sites in `index.js`, including a live ObjectHelper mutation and both TSL injection paths. This supports describing it as a deliberate full-turn object-mutation seal rather than a narrow filter around the attempted DROP/THROW object alone.

### Non-object facts still survive

Because entity, environment, player-condition, and mood promotion already occurred inside `runPhaseB()`, those facts are not undone by the later seal.

A sealed turn can therefore still retain:

- an NPC's scar, posture, or observable state;
- a player physical or observable attribute;
- a concrete environmental condition;
- a player bodily condition or condition interaction;
- the scene's mood trajectory.

This proves the seal is not literally a complete Continuity Brain seal. It is a full-turn **object-mutation** seal.

## Concrete behavior lost on a sealed turn

If the narration accompanying a failed DROP or THROW independently establishes these facts, they can be observed in raw CB output but will not become authoritative object truth:

- a newly noticed lantern will not be promoted into ORS;
- an NPC picking up a separate tracked book will not transfer that book;
- a separate glass cracking will not receive an object condition update;
- an unrelated rope being destroyed will not be retired;
- an unrelated object being split will not produce authoritative successors;
- an unrelated persistent-source extraction will not reduce its source and create a successor;
- a newly introduced NPC's narrated held or worn objects will not materialize as ORS objects.

### Important NPC-introduction divergence risk

Entity promotion happens before the object seal. Therefore a newly introduced NPC may still receive persistent `object:` attribute facts describing a hat or coat while the later intro-capture materialization is skipped.

On that sealed turn, descriptive memory can say the NPC has or wears the item while no corresponding `npc` / `npc_worn` ORS object is created. This is a concrete example of what would work differently if independently proven object facts were allowed through the seal.

## What is and is not currently broken

### Not proven broken

The successful partial TAKE/DROP/THROW receipt contract's promise that unrelated facts may use normal channels is not shown to be revoked by the DROP/THROW dry-run seal. The successful receipt and active fail-closed seal are different cases.

### Proven current policy

A failed or deliberately non-executing semantic single-action DROP/THROW turn freezes all object mutations from the narration, even mutations that appear unrelated to the attempted operation. Raw evidence remains available for diagnostics, but ORS is not changed through those channels.

This behavior is deliberate containment. It prevents the narrator from laundering a failed object operation into another object-state change, but it also sacrifices unrelated object developments on that turn.

## Corrected D4 decision point

The original binary question should not be carried forward unchanged.

It is **not**:

> Should successful receipt turns permit independent facts, or should the receipt seal block them?

The corrected question is:

> When a DROP or THROW fails closed and receives an Object Operation Bridge dry-run receipt, should the engine continue freezing every object mutation derived from that narration, or should it attempt to distinguish and admit unrelated object facts while still suppressing every consequence, replay, substitute, or reinterpretation of the failed operation?

### Option represented by current behavior

Keep the full-turn object freeze.

- Strongest containment.
- No need to trust CB to determine causal independence from a failed operation.
- Prevents consolation objects, substituted mutations, and narrated false consequences.
- Loses genuine unrelated object facts and can create descriptive-memory/ORS gaps such as the NPC outfit example.

### Alternative policy requiring new design

Permit independent object facts.

This would require a trustworthy scope/causality rule or deterministic evidence proving that each admitted mutation is unrelated to the failed operation. Merely retaining the prompt sentence is insufficient; the current seal intentionally prevents all such mutation consumers.

Any future design would need to answer at least:

- how independence is proven rather than asserted by CB;
- whether identity, actor, source, destination, and narration evidence are enough;
- how new-object candidates are distinguished from consolation or substitute objects;
- how compound or multi-event narration is handled;
- whether NPC introduction capture receives a special exception;
- how diagnostics expose admitted versus suppressed independent facts;
- how replay and duplicate containment remain fail-closed.

## D4 disposition after research

- **Successful operation receipts:** Operation-scoped; no proven global contradiction with the independent-facts promise.
- **DROP/THROW bridge dry-run seals:** Full-turn object-mutation seals on failed/non-executed supported turns.
- **Non-object CB facts:** Continue to be promoted before the seal.
- **Object facts unrelated to the failed operation:** Observed and preserved diagnostically, but blocked from authoritative mutation.
- **Original wording:** Misframed because it conflated two receipt classes.
- **Prompt reconciliation need:** Use distinct terms for successful execution receipts and fail-closed bridge receipts. Do not describe all “receipt-governed turns” as one category.
- **Remaining design decision:** Keep the full-turn fail-closed object freeze or design a proven-independent exception.
- **Decision status:** Open. No engine or prompt change is prescribed by this research entry.

---

# D5 research entry — container taxonomy and depth alignment

## The engine's actual spatial model

The engine has three mutually exclusive world-floor container types selected by the player's current depth:

1. **Overworld/grid floor (L0):** `container_type: "grid"`; ID shape `LOC:{mx},{my}:{lx},{ly}`.
2. **Site floor (L1):** `container_type: "site"`; ID shape `{site_id}:{x},{y}`.
3. **Localspace floor (L2):** `container_type: "localspace"`; ID is the active `local_space_id`.

The complete location context is cumulative in state:

- L0 retains the base world position (`mx`, `my`, `lx`, `ly`).
- L1 retains that position, adds `active_site`, and uses player `x/y` inside the site grid.
- L2 retains world and site context, adds `active_local_space`, and uses player `x/y` inside the localspace grid.

In plain terms: **world cell → site inside that cell → room/localspace inside that site.** ORS stores the current floor using the canonical container shape for the active level.

## What CB is currently taught

The object-candidate and object-transfer schemas expose only:

- `grid`
- `npc`
- `player`
- `localspace`

They omit `site`, `player_worn`, and `npc_worn`.

The prompt-facing valid-container list is spatially incomplete:

- At L0, it exposes the correct `LOC:...` grid cell.
- At L2, it suppresses the parent grid cell and exposes the localspace correctly.
- At L1, it does not expose the actual site-floor container. It still exposes the parent `LOC:...` grid cell.

The prompt then reinforces that stale abstraction by telling CB that grid IDs must use the `LOC:...` form.

## Internal inconsistency

`ContinuityBrain._describeTrackedObjects()` already understands the real depth model:

- grid only at L0,
- site floor only at L1,
- localspace only at L2.

CB can therefore be shown a tracked site-floor object while its output contract gives it no legal `site` value for a new placement or transfer. One part of CB uses current engine truth while the prompt schema preserves an older abstraction.

## Rewrite layer

Before ObjectHelper writes state, `index.js` compensates:

- `grid` promotes at L2 are rewritten to `localspace` plus the active localspace ID.
- `grid` promotes at L1 are rewritten to `site` plus the current `{site_id}:{x},{y}` key.
- malformed `site` IDs can be rewritten to the authoritative current site key.
- transfer endpoints typed as `grid` are similarly rewritten according to depth.
- entries are rejected when authoritative correction data is unavailable.

At L1 the normal path is effectively: **CB calls it grid; the engine knows it is site; the engine silently corrects it.**

## D5a decision — spatial depth taxonomy

**Decision: align Continuity Brain with the engine's real spatial model.**

CB should directly know and use `grid`, `site`, and `localspace`, with the same canonical container ID formats used elsewhere in the engine:

- outdoors: `grid` + exact `LOC:...` key,
- inside a site: `site` + exact `{site_id}:{x},{y}` key,
- inside a localspace: `localspace` + exact `local_space_id`.

The prompt-facing valid-container list, object-candidate schema, object-transfer schema, tracked-object presentation, and environmental placement guidance should tell the same spatial truth. The existing rewrite layer may remain as defensive validation/backward compatibility, but it should no longer be the expected normal translator for L1 output.

This is alignment with an existing authoritative mechanic, not a new mechanic.

## D5b — introduced worn objects

### Proven intended architecture

Repository history removes the earlier uncertainty. Commit `d6f768b` (`v1.88.12 Patch 1G`) explicitly describes separate routing:

- `held_objects` → `container_type: "npc"`
- `worn_objects` → `container_type: "npc_worn"`

That commit states that the intro-capture loop already expected those two CB fields and that CB's older combined field was the defect. This is direct historical evidence that the entity-observation channel followed by engine translation was intentional.

The live first-introduction pipeline is:

1. The narrator establishes an NPC's initial carried items and outfit.
2. CB reports them under `entity_candidates[].held_objects` and `entity_candidates[].worn_objects`.
3. `index.js` considers only visible NPCs whose `object_capture_turn` is still null.
4. Held entries become synthetic candidates targeting `npc`; worn entries become synthetic candidates targeting `npc_worn`.
5. Those candidates enter the ordinary quarantine/ObjectHelper promotion path.
6. ObjectHelper creates active records in `gameState.objects`, pushes each ID into `npc.object_ids` or `npc.worn_object_ids`, stamps provenance `source: "npc_introduction"`, and enforces one-container ownership.
7. `object_capture_turn` is stamped once at least one introduced item is captured or an already-materialized exact duplicate is confirmed.

### Clarification: these are already real objects

The introduction path does **not** stop at an NPC attribute or descriptive state record. It creates the same authoritative ORS `ObjectRecord` shape used for other promoted objects. In this engine, the durable record in `gameState.objects` plus membership in the owning container's object-ID array is the real object.

CB also writes `object:` attribute facts onto the NPC for narrator-facing context. Those attribute entries are complementary descriptive memory; they do not replace the ORS objects created by intro capture.

A historical exception exists for saves predating the intro-capture implementation: an old NPC may have `object:` attributes but no ORS records. Repository documentation calls those legacy ghost objects. That is a save-era compatibility condition, not the behavior of the current introduction pipeline.

## D5b decision for prompt reconciliation

**Keep `entity_candidates[].worn_objects` as the canonical CB channel for an NPC's first-introduction outfit, and keep the downstream translation to authoritative `npc_worn` ObjectRecords. Do not add `npc_worn` to ordinary CB object candidates merely for enum symmetry.**

Reasons:

- The route is historically documented as intentional.
- It already creates real ORS objects.
- Adding a second direct `npc_worn` candidate route would overlap with `worn_objects` and create duplicate-emission risk.
- `npc_worn` is an authoritative engine container, but not every authoritative container must be a direct value in every CB schema.

This closes D5b for the current prompt reconciliation.

## Separate engine gap — later equipment lifecycle

The repository does not provide a complete general equipment lifecycle after first introduction:

- The intro-capture loop permanently skips an NPC after `object_capture_turn` is stamped.
- CB may continue recording later `held_objects` / `worn_objects` phrases as persistent NPC `object:` attributes, but that attribute promotion does not create or move ORS objects after the one-time intro gate has closed.
- The ordinary CB transfer schema cannot name `npc_worn` or `player_worn`, so it cannot directly report a tracked object moving into or out of a worn container.
- The semantic parser recognizes `remove` for the player, and ActionProcessor can transfer an existing ORS object from `player_worn` to player inventory.
- There is no corresponding recognized `wear` / `equip` action in the parser's valid action set, and no general NPC equip/unequip authority path was found.

Therefore later changes such as an NPC putting on a newly acquired coat, taking off a tracked hat, or the player equipping an inventory object are not fully represented by the current authoritative object-operation system.

This is not evidence that D5b's introduction channel is wrong. It is a separate missing mechanic: **equipment lifecycle after materialization.**

### What currently blocks later real-object updates

The blocker is not ObjectHelper capability. ObjectHelper already understands `player_worn` and `npc_worn` and can resolve those ownership arrays. The missing piece is an authoritative operation contract that determines, without narrator invention or duplicate creation:

- which existing object changed equipment state,
- its exact source and destination containers,
- whether the event is a transfer of an existing object or introduction of a genuinely new object,
- who is authorized to cause the change,
- and how CB observation is suppressed or reconciled after execution.

Without that contract, simply reopening intro capture or adding worn container values to the prompt would risk conjuring duplicate garments or converting repeated descriptions into new objects.

## Sequencing implication

The spatial D5a prompt work can proceed independently.

D5b's first-introduction wording can also be reconciled now because its current contract is known and working. It should describe the observation-to-materialization route honestly.

If the intended prompt revision is also expected to support later equipment changes, the engine-side equipment lifecycle should be researched and designed before adding such promises to CB. Otherwise the prompt would advertise mutations the engine does not currently authorize or execute.

## D5 disposition

- **D5a spatial alignment:** Decided — align CB with `grid` / `site` / `localspace` engine truth.
- **D5b first-introduction worn objects:** Decided — retain `worn_objects` → downstream `npc_worn` ORS materialization.
- **Direct `npc_worn` addition to ordinary CB candidates:** Reject for current prompt reconciliation.
- **Later equipment lifecycle:** Separate unresolved engine feature/gap, not a remaining D5 prompt-taxonomy ambiguity.
- **No engine or prompt implementation changes made by this research entry.**