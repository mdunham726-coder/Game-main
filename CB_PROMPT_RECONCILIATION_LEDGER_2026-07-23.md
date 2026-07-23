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

**Status:** Open.

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
