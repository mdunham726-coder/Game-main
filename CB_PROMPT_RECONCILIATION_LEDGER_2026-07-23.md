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

This question has been split into two distinct decisions:

- **D5a — Spatial depth taxonomy:** Should CB directly use the engine's real `grid` / `site` / `localspace` floor model?
- **D5b — Worn actor containers:** Should CB directly emit `player_worn` / `npc_worn`, or should worn equipment remain represented through entity `worn_objects` and translated downstream?

**Status:** D5a decided; D5b pending.

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

## D5b research — worn actor containers

ObjectHelper distinguishes:

- `player` — player-carried inventory,
- `player_worn` — player-worn equipment,
- `npc` — NPC-carried inventory,
- `npc_worn` — NPC-worn equipment.

However, CB currently reports NPC outfit details through a separate entity channel:

- `entity_candidates[].held_objects`
- `entity_candidates[].worn_objects`

The intended first-introduction pipeline is:

1. The narrator is allowed to establish an NPC's initial carried items and outfit.
2. Continuity Brain observes those details and records them under the NPC's `held_objects` and `worn_objects` fields.
3. The NPC-introduction capture path converts held entries into synthetic `object_candidates` with `container_type: "npc"`.
4. It converts worn entries into synthetic `object_candidates` with `container_type: "npc_worn"`.
5. ObjectHelper/ORS then materializes those as real objects in the correct authoritative containers.

### Proven

- `npc_worn` exists in the authoritative object system.
- It is not currently a legal direct value in CB's ordinary object-candidate/transfer schemas.
- The downstream introduction-capture code deliberately translates `worn_objects` into `npc_worn` candidates.

### Interpretation

The exclusion of `npc_worn` from the ordinary CB object schema is plausibly intentional rather than simply missing. It preserves a channel boundary: CB reports an NPC's introduced outfit as an entity observation, and code translates that observation into the authoritative worn-object container.

This intention is not explicitly documented as a design law, so it should not yet be called proven. But the existing pipeline is coherent and directly supports the intended simulation behavior.

Simply adding `npc_worn` to ordinary `object_candidates` could cause duplicate materialization if CB reports the same garment both through `entity_candidates[].worn_objects` and as a direct `npc_worn` candidate. `player_worn` raises a related but separate question.

## D5b current disposition

**Pending.** Do not treat `npc_worn` as an obvious omission or add it to the direct CB enum merely for taxonomy symmetry.

Before changing D5b, determine whether the current entity-observation-to-ORS translation is the intended canonical path for introduced outfits and whether any later-turn worn-item operations require a separate direct container contract.

## D5 disposition

- **D5a spatial alignment:** Decided — align CB with `grid` / `site` / `localspace` engine truth.
- **D5b worn-container ownership:** Open — current separation may be intentional and protects the narrator → CB observation → ORS materialization pipeline.
- **No engine or prompt implementation changes made by this research entry.**
