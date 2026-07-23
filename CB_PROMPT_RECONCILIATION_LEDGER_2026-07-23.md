# Continuity Brain Prompt Reconciliation Ledger

**Created:** 2026-07-23  
**Repository:** `mdunham726-coder/Game-main`  
**Source anchor:** `078af6869aa43cbfcb21b4072d0cc2bb7a17203b` (`v1.92.16`)  
**Purpose:** Rolling evidence and decision ledger for reconciling the current Continuity Brain extraction prompt with current engine behavior. This is deliberately not named `research-notes.md` so it remains distinct from prior project research artifacts.

## Evidence discipline

- **Proven** means directly supported by current source, repository history, or a live issue reproduction.
- **Interpretation** means the evidence supports the reading, but the source does not state it as an explicit design law.
- **Decision** records the project owner's chosen direction.
- Questions remain open unless a decision is explicitly recorded here.
- GitHub issue #38 is excluded as a proof point for D1-D3 because its suspected reproduction did not survive retesting.
- GitHub issue #42 is accepted as a live proof that CB's ordinary post-execution promotion pipeline can create duplicate objects for an operation that the engine already executed correctly. Its exact reproduction is whole-stack THROW, so it supports the general containment concern without automatically deciding the mechanics of every partial-operation channel.

## Question register

### D1 — Canonical channel for an unreceipted partial movement while the source survives

Should this case commit to one canonical CB output shape, or may `extraction_events`, Group Extraction candidates, and candidate fallback remain overlapping channels reconciled by code?

**Status:** Open.

### D2 — Fission dual lane

Should a fission remain represented through both `object_retirements + successors` and `fission_events`, with downstream deduplication, or collapse to one channel?

**Status:** Open.

### D3 — TAKE receipt echo versus DROP/THROW dedicated successor-description fields

Should receipt-covered partial TAKE be made mechanically symmetric with DROP/THROW, or should its existing mechanism remain with more honest labeling?

**Status:** Researched; provisional project decision recorded below.

### D4 — Independent-facts promise versus the actual receipt seal

Should the prompt describe receipt-governed turns as fully sealed, or should the engine be changed so genuinely independent CB facts can flow as currently promised?

**Status:** Open.

### D5 — Real versus simplified container model

Should CB receive the engine's full container taxonomy, including `site` and `npc_worn`, or retain a simplified model backed by deterministic rewrite logic?

**Status:** Researched; decision pending.

### D6 — Verb and example density

How much acquisition-verb and transfer-origin language should remain after deterministic engine gates became authoritative for the hard cases?

**Status:** Open.

---

# D3 research entry — receipt-covered partial TAKE description transport

## Target

Clarify what the current repository actually does for receipt-covered partial TAKE, how that differs from receipt-covered partial DROP and THROW, and whether the asymmetry is stale machinery or an intentional consequence of different operation paths.

## Proven current prompt behavior

1. A validated partial-TAKE receipt is admitted only after `ContinuityBrain.runPhaseB()` verifies the receipt against current ORS state: matching turn, TLS/ObjectHelper authority, executed status, distinct source and successor IDs, surviving active source, same-turn active successor, parent linkage, extracted quantity, and player destination.

2. When that receipt is present, the prompt's `AUTHORITATIVE PARTIAL EXTRACTION PRECEDENCE` requires exactly one `extraction_events` entry for the identified operation. It forbids representing the receipt-identified successor as an `object_candidate` and forbids representing either source or successor as an `object_transfer`.

3. The required TAKE entry retains the full general extraction-event shape, including source prose, verb, quantity, product name, description, destination, actor, and evidence. The prompt calls the channel a witness report, while simultaneously using the receipt to make the quantity, actor, and destination deterministic for this particular event.

4. After CB returns, `index.js` locates the one extraction event and conditionally consumes its `description` as child-specific descriptive text for the already-existing receipt successor. Before applying it, the code checks the event count, extracted quantity, `player_hands` destination, player actor, non-empty description, and inequality with the captured parent description. The write is then made by exact successor object ID through `ObjectHelper.setObjectDescriptionDirect()`.

5. The TAKE successor therefore already exists before CB describes it. CB does not create the receipt successor in this path. The extraction event's live post-CB job is at least partly descriptive reconciliation for that exact already-created child.

6. Receipt-covered partial DROP and partial THROW use separate top-level fields: `partial_drop_successor_description` and `partial_throw_successor_description`. Their prompt rules explicitly classify those fields as non-executable descriptive metadata and forbid the receipt-governed operation from appearing in candidates, transfers, extraction events, fission events, or retirements.

7. `ContinuityBrain.runPhaseB()` validates each DROP/THROW description against the frozen narration, rejects empty evidence, rejects a description identical to the surviving parent's description, removes the special field from the general extracted packet, and returns it separately.

8. `index.js` revalidates the matching receipt and applies the DROP/THROW description directly to the exact successor ID. THROW's current consumer is explicitly documented as a mirror of DROP's successor-description consumption.

9. `ObjectHelper.setObjectDescriptionDirect()` is a narrow exact-ID mutation. It changes only the active object's base description; the caller owns content policy.

## Proven history

- `v1.91.82` (`f8b2f23`) introduced the authoritative partial-TAKE receipt contract. Its commit message states that the change enforced exactly one extraction event, excluded successor candidates and source/successor transfers, and reconciled narration-grounded child descriptions.
- `v1.91.91` (`135edd1`) later introduced the dedicated partial-DROP successor-description field and its post-CB exact-successor consumer.
- `v1.92.12` (`f929cad`) introduced partial THROW by deliberately cloning DROP's receipt and successor-description containment chain.

This chronology matters: DROP and THROW did not expose an original universal mechanism that TAKE failed to follow. TAKE's receipt contract came first. DROP later adopted a more purpose-built field, and THROW intentionally followed DROP because they share the player-to-Ground direction and migration architecture.

## Interpretation

The asymmetry is real but not inherently contradictory.

- Partial TAKE moves the new successor into player ownership and retained the pre-existing extraction-event representation used for persistent-source extraction.
- Partial DROP and THROW move the successor out of player ownership to Ground and were designed later around dedicated receipt-bound descriptive metadata.
- The current TAKE entry has a mixed identity: it is shaped and labeled as a general extraction witness, but on the validated receipt path the engine has already executed the split and the post-CB consumer uses the event's description to reconcile the existing successor.

That mixed identity is the actual D3 clarity problem. Mechanical symmetry is not required merely because all three commands perform partial splits.

## Relevance of issue #42

Issue #42 proves that ordinary CB narrative promotion can duplicate objects after a correct authoritative operation. It therefore supports strong separation between receipt-governed description recovery and fresh mutation/promotion claims. It does **not** directly prove that TAKE's receipt echo must be replaced by the DROP/THROW field shape: the reproduced bug is whole-stack THROW through ordinary promotion, not receipt-covered partial TAKE through the exact event consumer described above.

## Provisional project decision

**Preserve the existing TAKE, DROP, and THROW mechanics. Do not redesign TAKE merely for schema symmetry.**

TAKE, DROP, and THROW have different transfer directions and were intentionally built through different receipt-description paths. The current mechanisms are working. D3 is therefore a prompt-honesty and labeling problem, not a mechanical migration problem.

The TAKE receipt-governed entry should be described honestly as a receipt-bound, post-execution description/reconciliation echo for the already-created partial-TAKE successor, while preserving the fact that it occupies the `extraction_events` channel. Its wording should not imply that CB is authorizing, requesting, or independently executing the split.

DROP and THROW should retain their dedicated non-executable `partial_*_successor_description` fields.

## Remaining narrow question for prompt editing

The later prompt-edit pass still needs to choose the cleanest terminology for TAKE without falsely claiming that the entire `extraction_events` channel is non-executable in all contexts. The honest distinction is operation-specific: the receipt-governed TAKE entry is descriptive/post-execution for that identified operation, while ordinary unreceipted extraction events remain a separate D1 architecture question.

## D3 disposition

- **Mechanics:** Keep.
- **Schema symmetry project:** Reject.
- **Prompt labeling/explanation:** Revise for semantic honesty.
- **Dependency on D1:** Limited. D3 can be resolved without deciding the canonical channel for unreceipted partial movement.
- **Dependency on D4:** None for the basic D3 decision; D4 still governs whether unrelated facts may survive the receipt seal.

---

# D5 research entry — container taxonomy and depth alignment

## Target

Explain in plain terms what container model Continuity Brain is currently taught, what container model the engine actually uses, what the rewrite layer is compensating for, and what an alignment update would mean before selecting a design.

## The engine's actual spatial model

The engine has three mutually exclusive world-floor container types, selected by the player's current depth:

1. **Overworld/grid floor (L0):** `container_type: "grid"`; ID shape `LOC:{mx},{my}:{lx},{ly}`.
2. **Site floor (L1):** `container_type: "site"`; ID shape `{site_id}:{x},{y}`.
3. **Localspace floor (L2):** `container_type: "localspace"`; ID is the active `local_space_id`.

The current-ground resolver uses exactly that priority: active localspace first, otherwise active site tile, otherwise current overworld grid cell. These are not three names for the same container. They identify three distinct storage layers.

The user's remembered nesting is substantially correct, with one nuance: the full location context is cumulative in engine state, but the object container IDs themselves are not one progressively longer universal address.

- At L0, the player has the base world position (`mx`, `my`, `lx`, `ly`).
- At L1, the base world position remains, `active_site` identifies which site is open, and `player.position.x/y` identifies the tile inside that site.
- At L2, the base world position and active site remain, `active_local_space` identifies the room/interior, and `player.position.x/y` identifies the tile inside that localspace grid.

In layman's terms: **world cell → site inside that cell → room/localspace inside that site.** Each deeper level retains the parent context, even though ORS stores the current floor using the canonical ID shape for that specific level.

## The engine's actual actor-container model

ObjectHelper resolves distinct actor containers for:

- `player` — carried player inventory
- `player_worn` — player-worn equipment
- `npc` — NPC-carried inventory
- `npc_worn` — NPC-worn equipment

Together with `grid`, `site`, and `localspace`, ObjectHelper therefore understands seven concrete container types. This does not automatically mean all seven must be direct CB `object_candidates` values; it proves only that the authoritative object system distinguishes them.

## What Continuity Brain is currently taught

The object-candidate and object-transfer schemas expose only:

- `grid`
- `npc`
- `player`
- `localspace`

They omit `site`, `player_worn`, and `npc_worn`.

The prompt-facing valid-container list is also depth-incomplete:

- It always exposes player inventory.
- At L0 it exposes the correct `LOC:...` grid cell.
- At L2 it suppresses the parent grid cell and exposes the active localspace correctly.
- At L1 it does **not** expose the actual site-floor container. Because an active site does not have `local_space_id`, the old condition still exposes the parent `LOC:...` grid cell instead.
- It exposes visible NPC IDs, but does not distinguish NPC carried inventory from NPC worn inventory in the candidate/transfer container taxonomy.

The prompt then reinforces the simplified story by telling CB that grid IDs must be `LOC:...`, and several placement rules speak only of `grid` or `localspace` for environmental objects.

## Internal inconsistency inside Continuity Brain

`ContinuityBrain._describeTrackedObjects()` already understands the real mutually exclusive depth model. It builds its visible-container scope as:

- grid only at L0,
- site floor only at L1,
- localspace only at L2.

It can therefore show CB objects that are authoritatively stored on a site floor, even though the output schema gives CB no `site` value with which to report a new site-floor placement or transfer. For non-player/non-NPC objects, the tracked-object text prints the container ID without explicitly naming its type, so a site key can appear as an opaque string beside a schema that does not permit `site`.

This is not a wholly simplified subsystem. It is a mixed model: one helper uses current engine truth, while the prompt contract and valid-placement list preserve an older abstraction.

## What the rewrite layer currently does

After CB output is converted into quarantine entries, `index.js` repairs the mismatch before ObjectHelper writes state:

- A `grid` promote emitted while inside a localspace is rewritten to `localspace` plus the active `local_space_id`.
- A `grid` promote emitted while inside a site is rewritten to `site` plus the current `{site_id}:{x},{y}` key.
- A `site` promote with the wrong site-floor ID is rewritten to the authoritative current site key when enough state exists.
- Transfer endpoints typed as `grid` are similarly rewritten to `localspace` or `site` according to active depth.
- If authoritative rewrite data is unavailable, invalid entries are rejected rather than guessed.

So at L1 the current contract effectively says: **CB calls it grid; the engine knows it is site; the engine silently corrects the answer.** At L2, CB can already say localspace directly, but the rewrite remains as protection when it emits grid anyway.

The normalized candidate snapshot used by later condition reconciliation repeats this same depth correction, showing that the compensation is not confined to one isolated validation check.

## How worn NPC objects work today

The prompt asks for an entity's `held_objects` and `worn_objects` separately. It does not ask CB to emit `npc_worn` as an object-candidate container type.

Later, the NPC-introduction capture path converts:

- `held_objects` into synthetic `object_candidates` with `container_type: "npc"`, and
- `worn_objects` into synthetic `object_candidates` with `container_type: "npc_worn"`.

That means `npc_worn` is currently an engine-side translation from a separate CB entity field, not a direct value in CB's ordinary object schema. The distinction matters because merely adding `npc_worn` to the candidate enum without deciding channel precedence could let the same worn item appear once through `entity_candidates[].worn_objects` and again through `object_candidates`.

The same broader taxonomy includes `player_worn`, although the original D5 wording named only `site` and `npc_worn`. A claim that CB has been updated to the engine's **full** container taxonomy would need either to account for `player_worn` too or explicitly explain why worn-player items remain outside the direct CB object-placement contract.

## Layman's current-versus-aligned comparison

### Current arrangement

CB is given a simplified map legend. It knows the outdoor ground, player inventory, NPC inventory, and localspace floor. When the player is inside a site, CB is still told to label that floor as outdoor `grid`. The engine receives the answer, looks at the player's real depth, and changes `grid` into `site` before storing the object.

For NPC equipment, CB says, in effect, “the NPC is wearing a hat” in a separate entity list. The engine later turns that statement into an object stored in `npc_worn`. CB never directly names that container.

### A spatially aligned arrangement

CB would be shown exactly one canonical current Ground container for the active depth:

- outdoors: `grid` + exact `LOC:...` key,
- inside a site: `site` + exact `{site_id}:{x},{y}` key,
- inside a localspace: `localspace` + exact `local_space_id`.

The object-candidate and transfer schemas, tracked-object display, and environmental placement rules would use the same names. The rewrite layer could remain as defensive compatibility, but it would no longer be the expected normal path for ordinary L1 output.

### A fully actor-container-aligned arrangement

CB would also be taught the distinction between carried and worn storage (`player` versus `player_worn`, `npc` versus `npc_worn`). That is a larger contract change than adding `site`, because the prompt already has separate `held_objects` and `worn_objects` channels. A full alignment design would need to state which channel is canonical and how duplicates are prevented.

## Decision decomposition

D5 is easier to reason about as two linked but separable decisions:

### D5a — Spatial depth taxonomy

Should CB directly use the engine's true `grid` / `site` / `localspace` current-floor model instead of relying on `grid` rewrites at deeper levels?

### D5b — Worn actor containers

Should CB directly emit `player_worn` / `npc_worn`, or should worn equipment remain represented through entity `worn_objects` and translated by code?

A decision to align D5a does not require immediately redesigning D5b.

## Current evidence-weighted reading, not yet a decision

- The spatial mismatch is proven and concrete. The prompt-facing list is stale at L1, while the resolver, tracked-object helper, ObjectHelper, and rewrite layer all already recognize `site` as authoritative reality.
- Updating the spatial language would describe what the engine already does rather than invent a new mechanic.
- The worn-container question is structurally different. It involves overlapping CB channels and therefore carries duplicate-emission risk if treated as a simple enum expansion.

## D5 disposition

- **Research:** Complete enough for a design decision.
- **Decision:** Pending.
- **Safe conceptual split:** D5a spatial alignment versus D5b worn-container/channel ownership.
- **No engine or prompt changes made.**
