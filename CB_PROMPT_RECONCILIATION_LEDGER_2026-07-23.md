# Continuity Brain Prompt Reconciliation Ledger

**Created:** 2026-07-23  
**Repository:** `mdunham726-coder/Game-main`  
**Initial source anchor:** `078af6869aa43cbfcb21b4072d0cc2bb7a17203b` (`v1.92.16`)  
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

### D4 — Independent-facts promise versus the actual receipt seal

Should the prompt describe receipt-governed turns as fully sealed, or should the engine be changed so genuinely independent CB facts can flow as currently promised?

**Status:** Open.

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
