# ContinuityBrain.js Forensic Contract Reconciliation — v2
**Repository:** `mdunham726-coder/Game-main`  
**Fixed modern target:** commit `3adca046bd751ff22c751c8223da5cefca3b2706`, package `v1.92.22`  
**Artifact version:** v2 adversarial correction  
**Research posture:** evidence ledger only; no restoration plan, code changes, recommendations, version bump, commit, or push.
## 1. Scope and evidentiary standard
This audit asks one question: **for every meaningful contract present in the intact pre-corruption Continuity Brain, what is its exact status in the fixed modern target?**

Version 2 applies a stricter inclusion rule: the classified ledger contains only contracts evidenced in the intact historical `ContinuityBrain.js`. Consumer-side mechanics may establish that a CB contract operated, and modern-only architecture may establish that an old contract was replaced, but neither is counted as a separate historical contract. Modern-only capabilities are retained in a non-counted context section rather than forced into “Superseded.”

The intact `ContinuityBrain.js` is treated as forensic evidence, not as a preferred design or wholesale restoration source. A historical behavior is classified as **Superseded** only where a replacement contract is evidenced. A behavior is classified as **Accidentally missing** only where the recovery boundary visibly deletes an operative contract, the modern target supplies no equivalent replacement, and no evidence of deliberate retirement was found. “Older” is never treated as synonymous with “better.”

This is a **comprehensive manual contract census within the inspected evidence**, not a mechanically proven exhaustive census. The retained source ranges are broad and the ledger is structurally validated, but no automated parser or source-derived diff proved that every meaningful contract was found or that no conceptual overlap remains.

Adjacent source was inspected only where necessary to establish consumption, operation, replacement, or dormant support. No existing research notes, plans, roadmaps, issues, pull requests, or unrelated documentation were read.
## 2. Frozen comparison set
| Role | Commit | Timestamp | File | Blob | Version identity |
|---|---|---:|---|---|---|
| Intact CB | `b9c0da30d4c8762d1b75b27538c82f7abb4a051b` | 2026-05-16 07:00:18 UTC | `ContinuityBrain.js` | `830f2c2fa905f833b0ef993b5acc681f46bb82e5` | Header `v1.70.0`; internal `CB_VERSION = 1.5.2` |
| Companion consumer | `452966ce88b194a21115ceab0ea39a6355e18d71` | 2026-05-16 06:01:01 UTC | `index.js` | `a6690bafac5c802ad93436a5c951c1ab79d1cdf1` | Same intact CB blob as `b9c0da3`; earlier coherent consumer bridge |
| Recovery/loss boundary | `11dfc714156d1537cc93fbb39ce28c91231ab1dd` | 2026-05-16 07:32:43 UTC | `ContinuityBrain.js` | `162d122b5b3c60b4ab8a5643cce817ce88b39c96` | Header `v1.70.0`; internal `CB_VERSION = 1.5.1` |
| Modern target | `3adca046bd751ff22c751c8223da5cefca3b2706` | 2026-07-26 07:39:51 UTC | `ContinuityBrain.js` | `ec396660fa597fd380cf6f8e1369f9fb4b5a2706` | Package `v1.92.22`; header `v1.70.0`; internal `CB_VERSION = 1.5.2` |

`452966ce` is two commits before `b9c0da3`. Both commits contain the identical intact CB blob `830f2c2f…`; their `index.js` blobs differ. The pairing of CB from `b9c0da3` with the consumer from `452966ce` is therefore intentional. A second commit titled “gate patch,” `263fd944…`, also contains the same CB blob but is not the designated snapshot.
## 3. Classification summary
| Classification | Count |
|---|---:|
| Preserved | 48 |
| Restored | 9 |
| Partially restored | 10 |
| Incomplete hybrid | 8 |
| Superseded | 11 |
| Accidentally missing | 9 |
| Dormant downstream capability | 6 |
| Unresolved | 2 |

**Total classified historical-contract entries:** 103.  
**Non-counted modern/downstream/synthesis context records preserved in Section 5:** 16.

### Executive findings
1. The May 16 recovery did not merely simplify prose. It removed schema fields, source-precedence consequences, wrapper aliases, promotion behavior, parsing resilience, container vocabulary, fission successors, identity continuity, canonical environment dedup, and several downstream-facing contracts.
2. Current `main` restores a large portion of the object/entity machinery, but it does not restore the old founding model wholesale. Instead it combines a reduced player founding schema with a much newer BORN-NPC, ORS, TSL, receipt, and intro-capture architecture.
3. Three especially clear disconnected contracts remain:
   - `visible_objects` is still expected by current schema-drift/downstream code but cannot be emitted or returned by CB.
   - dedicated founding `capabilities` no longer exists, while Authority Gate still consumes `declared`/`ability` attributes.
   - direct `site` candidate support is absent from CB while site containers remain supported downstream.
4. The modern founding-NPC path is operational but hybrid: an identity pre-pass, full Phase B, pre-seeding, BORN materialization, founding registry, generic entity extraction, intro gear capture, and ORS all participate. These newer components are analyzed as current counterpart/context rather than counted as historical contracts.
5. Current fission/extraction ownership includes intentionally newer witness and receipt architecture. Those modern-only channels are relevant to the status of historical retirement/fission contracts but are not separately classified in the historical ledger.
6. The Turn-1 parse retry remains absent. Increased token headroom and longer raw diagnostics mitigate the same failure domain but do not partially restore the historical second-attempt contract.
7. The file header `v1.70.0`, internal `CB_VERSION`, and package version are distinct labels and must not be collapsed.
8. The 103-entry total is the result of a comprehensive manual census and adversarial correction, not a mechanically proven exhaustive source census.
## 4. Contract-by-contract reconciliation ledger

### Module, call, parse, wrapper, and export contracts

#### A01 — Separate file-header and internal version identities
- **Historical contract and location:** `b9:CB L1-48`: header says `ContinuityBrain.js — v1.70.0`; internal `CB_VERSION` is `1.5.2`.
- **Recovery boundary:** `11df:CB L1-45`: header remains `v1.70.0`, internal value regresses to `1.5.1`.
- **Current counterpart:** `3ad:CB L1-49`: header remains `v1.70.0`; internal value is again `1.5.2`; package is separately `1.92.22`.
- **Commit trail:** `11dfc714` changed the internal value; later restoration commit not isolated.
- **Runtime/downstream evidence:** All three files export `CB_VERSION`; package metadata independently reports engine version.
- **Classification:** **Restored**
- **Behavioral consequence:** Consumers can distinguish engine/package, file-era label, and CB schema version only if all three are recorded separately.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### A02 — Two-phase CB lifecycle
- **Historical contract and location:** `b9:CB L8-17`: Phase B performs extraction/association/promotion/mood; Phase C assembles narrator TRUTH and MOOD blocks.
- **Recovery boundary:** The same header and functions survive.
- **Current counterpart:** `3ad:CB L8-17`, `L1155+`, `L1690+`: both phases remain.
- **Commit trail:** No removal commit found; survives the recovery boundary.
- **Runtime/downstream evidence:** `452:index L3760+` and current `index L6260+` call Phase B; narrator assembly continues through exported Phase C.
- **Classification:** **Preserved**
- **Behavioral consequence:** The module remains both an observation/promotional coprocessor and continuity-packet assembler.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### A03 — Declared ownership map
- **Historical contract and location:** `b9:CB L18-32`: NPC facts → NPC attributes; location facts → location attributes; spatial/rejections audit-only; mood → history; promotions → log.
- **Recovery boundary:** Header survives, but several detailed channels and caps were removed.
- **Current counterpart:** `3ad:CB L18-32`: header still declares the same map; object lifecycle work is increasingly delegated downstream.
- **Commit trail:** Recovery diff at `11dfc714`; later TSL/ORS additions.
- **Runtime/downstream evidence:** Current `SemanticNormalizer` describes itself as the normalization layer between narration and authoritative ORS mutation.
- **Classification:** **Partially restored**
- **Behavioral consequence:** The high-level ownership statement survives, but current object authority is no longer accurately summarized by the old header alone.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### A04 — Forensic, camera-observable extraction stance
- **Historical contract and location:** `b9:CB prompt L80-90`: not summary or interpretation; capture what a stationary camera would see.
- **Recovery boundary:** Text preserved.
- **Current counterpart:** `3ad:CB L153-164`: text preserved verbatim in substance.
- **Commit trail:** No meaningful removal found.
- **Runtime/downstream evidence:** Physical/state/rejection schemas and banned-pattern filter still enforce it.
- **Classification:** **Preserved**
- **Behavioral consequence:** The central epistemic boundary remains a live prompt contract.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### A05 — Low-creativity LLM extraction call
- **Historical contract and location:** `b9:CB runPhaseB`: `deepseek-chat`, temperature `0.1`, `max_tokens:1600`.
- **Recovery boundary:** Same model/temperature/token ceiling.
- **Current counterpart:** `3ad:CB L1368-1380`: `deepseek-v4-flash`, thinking disabled, temperature `0.1`, `max_tokens:2800`.
- **Commit trail:** `6b331d79`: 1600→2800 after observed Turn-1 truncation.
- **Runtime/downstream evidence:** Commit message records JSON truncation preventing `starting_npc` write-back and BORN execution.
- **Classification:** **Superseded**
- **Behavioral consequence:** The forensic temperature survives, while model and capacity are deliberately replaced.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### A06 — Fail-closed guards for absent API key or narration
- **Historical contract and location:** `b9:CB runPhaseB`: skip with diagnostics when key or frozen narration is absent.
- **Recovery boundary:** Preserved.
- **Current counterpart:** `3ad:CB L1578-1590`: preserved.
- **Commit trail:** No contrary commit found.
- **Runtime/downstream evidence:** Current index marks Turn-1 extraction failure in `birth_record._extraction_failed`.
- **Classification:** **Preserved**
- **Behavioral consequence:** CB does not fabricate extraction when its evidence call cannot run.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### A07 — Single retry on transport reset
- **Historical contract and location:** `b9:CB`: retries once on `ECONNRESET`.
- **Recovery boundary:** Preserved.
- **Current counterpart:** `3ad:CB L1379-1400`: preserved.
- **Commit trail:** No contrary commit found.
- **Runtime/downstream evidence:** Both historical and current calls distinguish reset retry failure in diagnostics.
- **Classification:** **Preserved**
- **Behavioral consequence:** Transient connection resets do not immediately erase the turn’s CB result.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### A08 — Markdown-fence stripping before JSON parse
- **Historical contract and location:** `b9:CB`: strips optional ```json fences, then parses JSON.
- **Recovery boundary:** Preserved.
- **Current counterpart:** `3ad:CB L1402-1414`: preserved.
- **Commit trail:** No contrary commit found.
- **Runtime/downstream evidence:** Parse failure still records a bounded raw excerpt.
- **Classification:** **Preserved**
- **Behavioral consequence:** Minor model-format drift remains tolerated.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### A09 — Turn-1 JSON parse retry
- **Historical contract and location:** `b9:CB`: on Turn 1, parse failure triggers one second extraction call before final failure.
- **Recovery boundary:** `11df`: the retry block is deleted.
- **Current counterpart:** `3ad`: the retry remains absent. Current code instead increases response headroom to 2800 tokens and expands raw diagnostic capture to 3000 characters.
- **Commit trail:** Lost at `11dfc714`; `6b331d79` later mitigates a documented Turn-1 truncation failure without restoring the second extraction attempt.
- **Runtime/downstream evidence:** Commit `6b331d79` records that truncated Turn-1 JSON prevented `starting_npc` write-back and BORN execution; the mitigation addresses capacity and diagnosis, not retry semantics.
- **Classification:** **Accidentally missing**
- **Behavioral consequence:** A transient malformed or truncated Turn-1 response now ends Phase B after one parse attempt; larger output headroom reduces the risk but does not recreate the historical recovery path.
- **Confidence:** High
- **Unresolved evidence/contradiction:** No evidence was found that the retry was deliberately retired or replaced by an equivalent second-attempt contract.

#### A10 — Core required-key validation
- **Historical contract and location:** `b9:CB`: requires `entity_candidates`, `environmental_features`, `spatial_relations`, `rejected_interpretations`, `mood_snapshot`, `condition_events`.
- **Recovery boundary:** Preserved.
- **Current counterpart:** `3ad:CB L1416-1424`: same six keys.
- **Commit trail:** No meaningful change found.
- **Runtime/downstream evidence:** Missing core keys return `schema_missing_keys` rather than silently accepting summary mode.
- **Classification:** **Preserved**
- **Behavioral consequence:** The minimum continuity schema remains fail-closed.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### A11 — Exact top-level schema promise versus runtime enforcement
- **Historical contract and location:** `b9:CB prompt`: says exactly the listed keys; runtime validates only six core keys, not object/founding/watch channels.
- **Recovery boundary:** Prompt list shrinks; runtime still validates only six.
- **Current counterpart:** `3ad:CB L186-221`: list expands again, but runtime still validates only the same six.
- **Commit trail:** No commit found that closes the enforcement gap.
- **Runtime/downstream evidence:** Current index has an independent schema-drift detector for selected wrapper/extracted fields.
- **Classification:** **Incomplete hybrid**
- **Behavioral consequence:** The prompt is strict, but optional contract loss can pass CB validation and be noticed only later—or not at all.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### A12 — Prompt and raw-response archival
- **Historical contract and location:** `b9:CB return`: exposes `prompt` and `raw` for payload archive.
- **Recovery boundary:** Preserved.
- **Current counterpart:** `3ad:CB L1650-1665`: preserved.
- **Commit trail:** Introduced before the fixed snapshots (`v1.84.21` comments).
- **Runtime/downstream evidence:** `452:index L3782-3786` and current index store a CB payload snapshot.
- **Classification:** **Preserved**
- **Behavioral consequence:** Forensic reproduction can retain both model input and raw output.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### A13 — Last-run diagnostics API
- **Historical contract and location:** `b9:CB`: module-level `_lastRunDiagnostics`, getter, detailed counts/warnings.
- **Recovery boundary:** Preserved with fewer fields after lost channels.
- **Current counterpart:** `3ad:CB`: preserved and adds malformed held/worn count.
- **Commit trail:** No removal found.
- **Runtime/downstream evidence:** Exported in every snapshot.
- **Classification:** **Preserved**
- **Behavioral consequence:** Tooling can inspect the last CB run without reading game-state mutation logs.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### A14 — Mother watch brief and `watch_message`
- **Historical contract and location:** `b9:CB`: optional prompt section receives watch context and returns a one-sentence health judgment; wrapper exposes `watch_message`.
- **Recovery boundary:** `11df`: still present.
- **Current counterpart:** `3ad`: prompt signature no longer accepts watch context; schema and wrapper no longer expose `watch_message`.
- **Commit trail:** Removal commit not determined.
- **Runtime/downstream evidence:** `452:index L3760-3782` consumes and retains the message; no current code-search hit for `watch_message`.
- **Classification:** **Unresolved**
- **Behavioral consequence:** The per-turn CB-authored health judgment is gone.
- **Confidence:** Medium
- **Unresolved evidence/contradiction:** Current diagnostics may have replaced its operational purpose, but no equivalent one-sentence contract was proven.

#### A15 — Core wrapper envelope
- **Historical contract and location:** `b9:CB`: returns `extracted`, `log_entries`, `mood_snapshot`, `diagnostics`, plus payload and aliases.
- **Recovery boundary:** `11df`: same core envelope.
- **Current counterpart:** `3ad:CB L1648-1666`: same core envelope.
- **Commit trail:** No removal found.
- **Runtime/downstream evidence:** Current index uses `extracted`, `prompt`, `raw`, and object aliases.
- **Classification:** **Preserved**
- **Behavioral consequence:** The principal caller contract remains stable.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### A16 — Top-level `entity_candidates` alias
- **Historical contract and location:** `b9:CB return`: explicit `entity_candidates` alias points at `extracted.entity_candidates`.
- **Recovery boundary:** `11df`: alias disappears.
- **Current counterpart:** `3ad`: alias remains absent.
- **Commit trail:** Lost at recovery boundary.
- **Runtime/downstream evidence:** Current index deliberately reads `_extractionPacket?.entity_candidates`; schema drift checks the nested field, not a wrapper alias.
- **Classification:** **Superseded**
- **Behavioral consequence:** The data survives, but its stable access path moved to the nested extraction packet.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### A17 — Top-level object lifecycle aliases
- **Historical contract and location:** `b9:CB return`: candidates, transfers, condition updates, retirements are exposed explicitly.
- **Recovery boundary:** `11df`: preserved.
- **Current counterpart:** `3ad`: preserved and expanded with fission/extraction/receipt-description outputs.
- **Commit trail:** Expansion commits include `53f9701f`, `637529e7`, `f94da82c`, `f929cadb`.
- **Runtime/downstream evidence:** Both companion and current index consume these aliases directly.
- **Classification:** **Preserved**
- **Behavioral consequence:** Object-facing callers retain a dedicated bridge independent of the raw extraction packet.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### A18 — `visible_objects` wrapper alias
- **Historical contract and location:** `b9` prompt requires `visible_objects`, but the wrapper does not expose it even though the companion index reads `_phaseBResult.visible_objects`.
- **Recovery boundary:** `11df` removes the prompt field entirely.
- **Current counterpart:** `3ad` still cannot emit or return it; current index’s schema-drift detector nevertheless expects it.
- **Commit trail:** Deleted at `11dfc714`; no restoration commit found.
- **Runtime/downstream evidence:** `452:index` and current index retain a downstream expectation; current CB always triggers `missing_field:visible_objects` under that check.
- **Classification:** **Dormant downstream capability**
- **Behavioral consequence:** The historical barrier-visible concept survives only as a disconnected consumer expectation, not an expressible CB output.
- **Confidence:** High
- **Unresolved evidence/contradiction:** Whether any intermediate commit briefly supplied the missing alias was not established.

#### A19 — Core exports
- **Historical contract and location:** `b9`: exports `CB_VERSION`, `runPhaseB`, `assembleContinuityPacket`, `getLastRunDiagnostics`.
- **Recovery boundary:** Preserved.
- **Current counterpart:** `3ad`: preserves all four and adds `extractFoundingNpc`.
- **Commit trail:** `18642683`/later founding-NPC work added modern functionality.
- **Runtime/downstream evidence:** All fixed snapshots are CommonJS modules.
- **Classification:** **Preserved**
- **Behavioral consequence:** Existing imports remain compatible; current code adds one new entry point.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### A20 — Top-level `environmental_features` alias expectation
- **Historical contract and location:** `b9` prompt and `extracted` packet contain `environmental_features`, but the wrapper does not expose a same-named alias.
- **Recovery boundary:** The nested field survives; no wrapper alias is added.
- **Current counterpart:** Current CB still keeps the field only under `extracted`, while current index’s schema-drift detector expects `environmental_features` directly on `_phaseBResult`.
- **Commit trail:** No wrapper-restoration commit found.
- **Runtime/downstream evidence:** CB itself consumes the nested field for location promotion, so the data path works; only the downstream wrapper expectation is disconnected.
- **Classification:** **Incomplete hybrid**
- **Behavioral consequence:** Current schema-drift logging can report a missing field even when environmental extraction and promotion succeeded.
- **Confidence:** High
- **Unresolved evidence/contradiction:** Whether the drift detector intentionally checks a legacy wrapper shape or simply names the wrong level is not documented.


### Entity extraction, promotion, and equipment contracts

#### B01 — Exact entity-ID preference with descriptive fallback
- **Historical contract and location:** `b9:CB entity rule`: use exact visible `npc_id`; descriptive label only if no match.
- **Recovery boundary:** Preserved.
- **Current counterpart:** `3ad:CB L226-232`: preserved and strengthened for `#`-namespaced IDs.
- **Commit trail:** `599a94cd` documents namespace copying.
- **Runtime/downstream evidence:** Current resolution still warns on unresolved/fuzzy references.
- **Classification:** **Preserved**
- **Behavioral consequence:** Entity facts continue to prefer stable engine identity over prose labels.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### B02 — Learned-name privacy in prompt context
- **Historical contract and location:** `b9` helper hides `npc_name` unless `is_learned`.
- **Recovery boundary:** Preserved.
- **Current counterpart:** Current helper retains the learned-name gate and now includes L0 fallback.
- **Commit trail:** `2b3cf95a`, `748988bc` provide L0/privacy evidence.
- **Runtime/downstream evidence:** Current narrator and TRUTH block also gate names by `is_learned`.
- **Classification:** **Preserved**
- **Behavioral consequence:** CB is not given names the player has not learned.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### B03 — L0 non-player entity handling
- **Historical contract and location:** `b9`: no L0 NPC registry; non-player candidates are skipped and summarized as warnings.
- **Recovery boundary:** `11df`: same behavior.
- **Current counterpart:** `3ad`: resolves against `world._visible_npcs` at L0.
- **Commit trail:** `b3893c0e`, `2b3cf95a`, `599a94cd`.
- **Runtime/downstream evidence:** BORN-NPC and normal L0 NPCs can now receive continuity attributes.
- **Classification:** **Superseded**
- **Behavioral consequence:** The old fail-safe is replaced by an actual L0 entity registry/visibility contract.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### B04 — Player self-reference route
- **Historical contract and location:** `b9`: `player`/`you` entity candidates route to player attributes at every layer.
- **Recovery boundary:** Preserved.
- **Current counterpart:** `3ad`: preserved, with optional soliloquy suppression.
- **Commit trail:** No removal found.
- **Runtime/downstream evidence:** Current index also derives player extraction from nested entity candidates.
- **Classification:** **Preserved**
- **Behavioral consequence:** Narrated player appearance/state remains continuity-addressable.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### B05 — Permanent/semi-permanent `physical_attributes`
- **Historical contract and location:** `b9`: camera-verifiable bodily features; context/emotion excluded.
- **Recovery boundary:** Preserved in simplified wording.
- **Current counterpart:** `3ad`: preserved.
- **Commit trail:** No meaningful replacement.
- **Runtime/downstream evidence:** Promoted to `physical:` bucket for NPC/player.
- **Classification:** **Preserved**
- **Behavioral consequence:** Persistent appearance facts continue to survive narration turns.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### B06 — Changeable `observable_states`
- **Historical contract and location:** `b9`: visible current state; no inference; bodily harm may also require a condition event.
- **Recovery boundary:** Preserved.
- **Current counterpart:** `3ad`: preserved.
- **Commit trail:** No meaningful replacement.
- **Runtime/downstream evidence:** Promoted to `state:` bucket and aged in Phase C.
- **Classification:** **Preserved**
- **Behavioral consequence:** Temporary visible state remains distinct from permanent appearance and condition identity.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### B07 — Separate held and worn entity fields
- **Historical contract and location:** `b9`: distinct `held_objects[]` and `worn_objects[]` with carrying-versus-body tests.
- **Recovery boundary:** `11df`: collapsed to `held_or_worn_objects[]`.
- **Current counterpart:** `3ad:CB L236-275`: separate fields restored with stricter string-array definitions.
- **Commit trail:** `2b3cf95a`/`6b331d79`/`3bf86492`; current commit `3adca04` repairs Turn-1 ownership.
- **Runtime/downstream evidence:** Current intro capture creates `npc` versus `npc_worn` ObjectRecords.
- **Classification:** **Restored**
- **Behavioral consequence:** Held cargo and worn equipment again have different downstream ownership.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### B08 — Contested-emote outcome rule
- **Historical contract and location:** `b9`: if an asterisk emote’s object interaction is incomplete/failed/contested, do not infer NPC state changes as if it succeeded.
- **Recovery boundary:** `11df`: rule disappears.
- **Current counterpart:** `3ad`: no equivalent CB rule; Authority Gate handles world-authoring emotes and soliloquy gating suppresses unsupported player state/object promotion.
- **Commit trail:** Recovery deletion; current Authority Gate EMOTE RULE and soliloquy patches are later architecture.
- **Runtime/downstream evidence:** Current gates cover adjacent abuse modes but not the same narrated-outcome predicate.
- **Classification:** **Partially restored**
- **Behavioral consequence:** Some false state promotion is blocked, but the exact failed-interaction rule is not re-established.
- **Confidence:** Medium
- **Unresolved evidence/contradiction:** A runtime test is needed to determine whether other narrator/ORS gates cover the remaining case.

#### B09 — Per-entity rejected interpretations
- **Historical contract and location:** `b9`: required list of considered-but-rejected emotional/metaphorical/inferential phrases.
- **Recovery boundary:** Preserved.
- **Current counterpart:** `3ad`: preserved.
- **Commit trail:** No removal found.
- **Runtime/downstream evidence:** Included in extraction packet and diagnostics counts.
- **Classification:** **Preserved**
- **Behavioral consequence:** Rejected inference remains auditable rather than silently discarded.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### B10 — Top-level rejected interpretations
- **Historical contract and location:** `b9`: scene-level mood, atmosphere, future inference, and framing go to a separate rejection list.
- **Recovery boundary:** Preserved.
- **Current counterpart:** `3ad`: preserved.
- **Commit trail:** No removal found.
- **Runtime/downstream evidence:** Stored in extraction packet and counted diagnostically.
- **Classification:** **Preserved**
- **Behavioral consequence:** Scene-level interpretation remains separated from physical truth.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### B11 — Banned-interpretation post-filter
- **Historical contract and location:** `b9`: rejects strings containing aura/presence/demeanor/menace/sacred/magic/etc. before promotion.
- **Recovery boundary:** Preserved.
- **Current counterpart:** `3ad`: same pattern set.
- **Commit trail:** No removal found.
- **Runtime/downstream evidence:** Runs after schema extraction for entity and location promotion.
- **Classification:** **Preserved**
- **Behavioral consequence:** Prompt mistakes can still be blocked before state promotion.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### B12 — Promotion input type guards
- **Historical contract and location:** `b9`: non-string details are explicitly rejected and logged; object bucket can be suppressed.
- **Recovery boundary:** `11df`: explicit type guards disappear.
- **Current counterpart:** `3ad`: held/worn outputs are canonicalized post-parse, including `{name}` fallback, but physical/state/location paths still lack the old universal string guard.
- **Commit trail:** Lost at recovery; partial modern canonicalizer added later.
- **Runtime/downstream evidence:** Current diagnostics counts malformed held/worn entries only.
- **Classification:** **Incomplete hybrid**
- **Behavioral consequence:** Some malformed model shapes are normalized; others can still reach string-oriented filters.
- **Confidence:** High
- **Unresolved evidence/contradiction:** No runtime malformed physical/state sample was inspected.

#### B13 — Idempotent attribute keys and duplicate summaries
- **Historical contract and location:** `b9`: `${bucket}:${value}` keys; duplicates do not rewrite facts and are summarized by bucket.
- **Recovery boundary:** Preserved.
- **Current counterpart:** `3ad`: preserved.
- **Commit trail:** No meaningful change found.
- **Runtime/downstream evidence:** Promotion logs contain create/reject/duplicate summary entries.
- **Classification:** **Preserved**
- **Behavioral consequence:** Repeated narration does not continually append duplicate attributes.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### B14 — Player object-attribute suppression option
- **Historical contract and location:** `b9`: caller may suppress only player `object:` promotion for an emote/no-inventory mismatch.
- **Recovery boundary:** `11df`: option disappears.
- **Current counterpart:** `3ad`: replaced by `suppressUnsupportedPlayerStatePromotion`, suppressing player physical/state/object plus new conditions on soliloquy turns.
- **Commit trail:** Current soliloquy gate architecture; exact introduction commit not isolated.
- **Runtime/downstream evidence:** Current index passes `_soliloquyFired` into CB.
- **Classification:** **Superseded**
- **Behavioral consequence:** A narrow object-only switch became a broader authority decision covering player state.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.


### Environment, continuity packet, and mood contracts

#### C01 — Environmental feature extraction and promotion
- **Historical contract and location:** `b9`: concrete location-owned props/material conditions; mood and interpretation excluded.
- **Recovery boundary:** Preserved.
- **Current counterpart:** `3ad`: preserved.
- **Commit trail:** No meaningful replacement.
- **Runtime/downstream evidence:** Promoted to current location/cell `attributes` with `source:narration`.
- **Classification:** **Preserved**
- **Behavioral consequence:** Location continuity remains a first-class promoted channel.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### C02 — Spatial relations as audit-only output
- **Historical contract and location:** `b9` ownership header and schema: spatial facts are extracted but not promoted.
- **Recovery boundary:** Preserved.
- **Current counterpart:** `3ad`: preserved in schema; still no direct promotion path.
- **Commit trail:** No replacement found.
- **Runtime/downstream evidence:** Diagnostics count spatial relations; they remain inside `extracted`.
- **Classification:** **Preserved**
- **Behavioral consequence:** Positional observations are retained for audit without becoming durable attributes.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### C03 — Barrier-visible portable objects
- **Historical contract and location:** `b9`: named portable objects visible through a window/display/barrier go to `visible_objects`, not environmental features or reachable candidates.
- **Recovery boundary:** `11df`: field and instructions removed.
- **Current counterpart:** `3ad`: no CB field; current downstream still expects `visible_objects` in schema-drift checks.
- **Commit trail:** Loss at `11dfc714`; no restoration found.
- **Runtime/downstream evidence:** Disconnected consumer expectation proves downstream vocabulary survives.
- **Classification:** **Dormant downstream capability**
- **Behavioral consequence:** CB can no longer express visible-but-unreachable object truth as its own channel.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### C04 — Canonical environmental dedup at injection time
- **Historical contract and location:** `b9`: canonicalizer strips generic descriptors/location phrases, collapses variants, and may keep a richer older phrase.
- **Recovery boundary:** `11df`: canonicalizer and dedup pass disappear.
- **Current counterpart:** `3ad`: not restored; only recency caps remain.
- **Commit trail:** Direct loss in recovery diff; no replacement commit found.
- **Runtime/downstream evidence:** Current Phase C joins capped attributes without canonical collision handling.
- **Classification:** **Accidentally missing**
- **Behavioral consequence:** Variant environment facts can again occupy multiple continuity slots.
- **Confidence:** Medium
- **Unresolved evidence/contradiction:** No explicit intent to remove the canonicalizer was found; classification rests on the emergency loss boundary plus absence of replacement.

#### C05 — General environment/NPC attribute cap
- **Historical contract and location:** `b9`: `ENV_ATTR_WINDOW = 20`, most recent attributes survive.
- **Recovery boundary:** `11df`: constant and sorting/slicing disappear.
- **Current counterpart:** `3ad`: unified 20-entry recency cap is restored for NPCs and locations.
- **Commit trail:** Restoration commit not isolated; current comments explicitly state the cap.
- **Runtime/downstream evidence:** Current Phase C sorts by `turn_set` descending and slices 20.
- **Classification:** **Restored**
- **Behavioral consequence:** Unbounded truth-block growth is again limited.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### C06 — Dedicated `LOC_ATTR_WINDOW = 10`
- **Historical contract and location:** `b9`: constant is declared as a location backstop, but the inspected Phase C implementation slices with `ENV_ATTR_WINDOW`, not this constant.
- **Recovery boundary:** `11df`: constant removed.
- **Current counterpart:** `3ad`: no dedicated constant; unified 20-entry cap applies.
- **Commit trail:** Recovery deletion; later unified cap.
- **Runtime/downstream evidence:** No operative use of the historical constant was found in the intact file.
- **Classification:** **Superseded**
- **Behavioral consequence:** The declared 10-item location policy did not survive; one unified cap now owns both entity and location output.
- **Confidence:** High
- **Unresolved evidence/contradiction:** Whether another uninspected consumer used the exported/non-exported constant is effectively ruled out because it was module-local.

#### C07 — Single-use recent L0 location context
- **Historical contract and location:** `b9`: accepted L0 facts are stored in `_lastPhaseBLoc`, shown once as prior-position context, suppressed on movement, then cleared.
- **Recovery boundary:** Preserved.
- **Current counterpart:** `3ad`: preserved and tightened to true L0 only during layer transitions.
- **Commit trail:** `v1.92.5` comments document the tighter layer rule.
- **Runtime/downstream evidence:** Reads promoted, post-filter facts rather than raw candidates.
- **Classification:** **Preserved**
- **Behavioral consequence:** Narrator gets bounded recent-place continuity without indefinite stale bleed.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### C08 — Mood schema and trajectory
- **Historical contract and location:** `b9`: tone, tension level/direction, conversation state, focus, delta; short labels; uses previous snapshot.
- **Recovery boundary:** Preserved.
- **Current counterpart:** `3ad`: preserved.
- **Commit trail:** No meaningful replacement.
- **Runtime/downstream evidence:** Phase C renders current snapshot plus prior trajectory.
- **Classification:** **Preserved**
- **Behavioral consequence:** Mood remains temporal rather than a single-turn summary.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### C09 — Mood history cap and render window
- **Historical contract and location:** `b9`: hard cap 20; render window 5.
- **Recovery boundary:** Preserved.
- **Current counterpart:** `3ad`: preserved.
- **Commit trail:** No meaningful change.
- **Runtime/downstream evidence:** Push-and-shift implementation remains.
- **Classification:** **Preserved**
- **Behavioral consequence:** Mood memory remains bounded.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### C10 — Location-scoped mood filtering
- **Historical contract and location:** `b9`: L1/L2 snapshots are keyed; L0 uses null and can pass broadly.
- **Recovery boundary:** `11df`: same.
- **Current counterpart:** `3ad`: L0 receives exact `LOC:` key and filtering applies at all layers, with legacy undefined-only exception.
- **Commit trail:** `v1.92.5` comments in current CB.
- **Runtime/downstream evidence:** Current code excludes explicit-null old L0 snapshots lacking provable cell identity.
- **Classification:** **Superseded**
- **Behavioral consequence:** The old partial location filter is replaced by a stricter all-layer identity contract.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### C11 — TRUTH block before MOOD block
- **Historical contract and location:** `b9` design constraint and Phase C order.
- **Recovery boundary:** Preserved.
- **Current counterpart:** `3ad`: preserved.
- **Commit trail:** No contrary change.
- **Runtime/downstream evidence:** Both blocks are assembled by the same function in fixed order.
- **Classification:** **Preserved**
- **Behavioral consequence:** Narrator receives factual continuity before atmospheric trajectory.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### C12 — Player `state:` attribute aging
- **Historical contract and location:** `b9`: state facts older than five turns are suppressed; physical/object/declared facts are permanent.
- **Recovery boundary:** Preserved.
- **Current counterpart:** `3ad`: preserved.
- **Commit trail:** No meaningful change.
- **Runtime/downstream evidence:** Suppressed count is passed back through turn context.
- **Classification:** **Preserved**
- **Behavioral consequence:** Ephemeral posture/state does not remain narrator truth forever.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### C13 — Player identity line in TRUTH
- **Historical contract and location:** `b9`: Phase C renders canonical name/title/form and tracks `_lastIdentityTruthLine`.
- **Recovery boundary:** `11df`: identity rendering disappears together with identity write-back.
- **Current counterpart:** `3ad`: remains absent.
- **Commit trail:** Loss at `11dfc714`; no replacement contract found.
- **Runtime/downstream evidence:** No current code-search evidence of player identity continuity.
- **Classification:** **Accidentally missing**
- **Behavioral consequence:** The narrator no longer receives CB’s durable player-identity line.
- **Confidence:** Medium
- **Unresolved evidence/contradiction:** No commit message proves intent; emergency whole-file loss plus no replacement supports the classification.

#### C14 — NPC learned-name/recognition rendering
- **Historical contract and location:** `b9`: label can use learned name; optional recognition suffix is emitted.
- **Recovery boundary:** `11df`: reduced to `npc_name` gated by `is_learned`; recognition suffix and fallback disappear.
- **Current counterpart:** `3ad`: learned-name privacy remains, but recognition suffix is still absent.
- **Commit trail:** `748988bc` intentionally normalized current name exposure.
- **Runtime/downstream evidence:** Current rendering is privacy-safe but semantically narrower.
- **Classification:** **Partially restored**
- **Behavioral consequence:** Known identity is rendered, but recognition context no longer appears in CB truth.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### C15 — NPC/location recency ordering
- **Historical contract and location:** `b9`: facts sorted newest-first before output.
- **Recovery boundary:** `11df`: sorting removed.
- **Current counterpart:** `3ad`: restored with the unified 20-entry cap.
- **Commit trail:** Restoration commit not isolated.
- **Runtime/downstream evidence:** Current Phase C performs explicit sort/slice.
- **Classification:** **Restored**
- **Behavioral consequence:** Recent facts again dominate bounded continuity output.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

### Condition contracts

#### D01 — Condition event schema and exact-ID interactions
- **Historical contract and location:** `b9`: `new_condition` or `interaction`; interactions require exact active `condition_id`.
- **Recovery boundary:** Preserved.
- **Current counterpart:** `3ad`: preserved.
- **Commit trail:** No meaningful change.
- **Runtime/downstream evidence:** Unmatched IDs are dropped with a log.
- **Classification:** **Preserved**
- **Behavioral consequence:** Condition identity remains stable rather than name-fuzzy.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### D02 — Observable bodily harm may require both state and condition outputs
- **Historical contract and location:** `b9`: visible sign belongs in observable state; underlying injury belongs in condition event.
- **Recovery boundary:** Preserved.
- **Current counterpart:** `3ad`: preserved.
- **Commit trail:** No meaningful change.
- **Runtime/downstream evidence:** Promotion paths remain independent.
- **Classification:** **Preserved**
- **Behavioral consequence:** Appearance does not absorb medical/physical condition identity.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### D03 — Condition creation and interaction logs
- **Historical contract and location:** `b9`: creates condition ID, description, turn log; interactions append rolling notes (cap 5) and turn log.
- **Recovery boundary:** Preserved.
- **Current counterpart:** `3ad`: preserved.
- **Commit trail:** No meaningful change.
- **Runtime/downstream evidence:** Condition mutations occur inside CB.
- **Classification:** **Preserved**
- **Behavioral consequence:** Conditions retain both identity and interaction history.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### D04 — Duplicate-condition prevention
- **Historical contract and location:** `b9`: no semantic dedup beyond explicit active-list guidance.
- **Recovery boundary:** `11df`: same.
- **Current counterpart:** `3ad`: adds Jaccard overlap guard against existing description and recent logs.
- **Commit trail:** Current enhancement; exact introduction commit not isolated.
- **Runtime/downstream evidence:** Current code logs the overlap score and skips at `>=0.5`.
- **Classification:** **Superseded**
- **Behavioral consequence:** The original prompt-only avoidance is replaced by an in-process duplicate guard.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### D05 — Object condition updates by exact ID with name fallback
- **Historical contract and location:** `b9`: exact ID preferred; same-name ambiguity may emit `name_match` rather than omit a real change.
- **Recovery boundary:** `11df`: preserved.
- **Current counterpart:** `3ad`: preserved.
- **Commit trail:** No meaningful change.
- **Runtime/downstream evidence:** `452:index L4140-4202` broadcasts name matches across scene-scope active records.
- **Classification:** **Preserved**
- **Behavioral consequence:** Concrete object damage/state can be applied even when same-name identity is unresolved.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### D06 — Instrument residue rule
- **Historical contract and location:** `b9`: tool residue/embedded material belongs on the instrument, not the affected target.
- **Recovery boundary:** `11df`: special instruction disappears.
- **Current counterpart:** `3ad`: not restored in the inspected prompt.
- **Commit trail:** Lost at recovery; no replacement found.
- **Runtime/downstream evidence:** Generic exact-ID/name-match condition machinery still exists, but the routing rule does not.
- **Classification:** **Accidentally missing**
- **Behavioral consequence:** Residue can be attributed to the wrong object if narration names both tool and target.
- **Confidence:** Medium
- **Unresolved evidence/contradiction:** No runtime sample or explicit removal rationale was found.

#### D07 — Candidate initial-condition channel
- **Historical contract and location:** `b9`: new candidates may carry `initial_condition` and exact `initial_evidence`; pristine defaults omitted.
- **Recovery boundary:** `11df`: preserved.
- **Current counterpart:** `3ad`: preserved.
- **Commit trail:** No meaningful change.
- **Runtime/downstream evidence:** Companion/current index applies initial state after promotion using audit identity.
- **Classification:** **Preserved**
- **Behavioral consequence:** Objects introduced damaged or modified can begin with authoritative condition history.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

### Object candidate, transfer, condition, retirement, fission, and extraction contracts

#### E01 — Concrete, portable, explicitly grounded object candidates
- **Historical contract and location:** `b9`: named discrete portable objects; fixed furniture/architecture and implied ambiguity excluded.
- **Recovery boundary:** `11df`: preserved in reduced form.
- **Current counterpart:** `3ad`: preserves these base tests.
- **Commit trail:** No complete removal.
- **Runtime/downstream evidence:** Current ORS bridge still filters and materializes candidates.
- **Classification:** **Preserved**
- **Behavioral consequence:** CB remains an object-observation source rather than a general noun extractor.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### E02 — Candidate completeness/salience policy
- **Historical contract and location:** `b9`: extract qualifying objects, with several exclusions and special channels; no explicit mandate to inventory every passive object.
- **Recovery boundary:** `11df`: similarly narrow.
- **Current counterpart:** `3ad`: explicitly demands a complete inventory of every named portable scene object and says figurative embellishment does not disqualify a concrete noun.
- **Commit trail:** Modern prompt expansion; exact introduction commit not isolated.
- **Runtime/downstream evidence:** Current downstream origin/dedup gates compensate for higher candidate volume.
- **Classification:** **Superseded**
- **Behavioral consequence:** The old conservative candidate policy is replaced by broad capture plus downstream filtering.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### E03 — Do not promote already-tracked objects
- **Historical contract and location:** `b9`: tracked objects must use transfer/condition/retirement channels, not new candidates.
- **Recovery boundary:** `11df`: preserved.
- **Current counterpart:** `3ad`: preserved and extended to adjacent tracked floor objects.
- **Commit trail:** No removal; current adds nearby-object context.
- **Runtime/downstream evidence:** ORS/TSL dedup provides additional defense.
- **Classification:** **Preserved**
- **Behavioral consequence:** Existing object identity is protected against phantom duplicates.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### E04 — Exact tracked-object naming
- **Historical contract and location:** `b9`: candidate name for a tracked object must exactly match the tracked list.
- **Recovery boundary:** `11df`: rule disappears.
- **Current counterpart:** `3ad`: not restored verbatim; current uses alias rules, actor association, TSL alias resolution, and ORS gates.
- **Commit trail:** Recovery loss; later `SemanticNormalizer` architecture.
- **Runtime/downstream evidence:** Current SN resolves exact/token/actor/provenance aliases to ObjectRecords.
- **Classification:** **Superseded**
- **Behavioral consequence:** Identity safety moved from strict model wording to a richer normalization layer.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### E05 — Semantic-variant duplicate suppression
- **Historical contract and location:** `b9`: candidate names that are only semantic variants of tracked objects should not promote.
- **Recovery boundary:** `11df`: detailed rule disappears.
- **Current counterpart:** `3ad`: prompt has exact/alias transfer rules; SN computes dedup recommendations with provenance and vetoes.
- **Commit trail:** TSL Stage 1 and later dedup work.
- **Runtime/downstream evidence:** Current SN is observe/normalization infrastructure and index applies several replay/correlation gates.
- **Classification:** **Superseded**
- **Behavioral consequence:** Duplicate control is no longer owned by one prompt sentence.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### E06 — Authoritative valid-container list and exact IDs
- **Historical contract and location:** `b9`: prompt lists exact valid containers; IDs must be copied; prose labels rejected.
- **Recovery boundary:** `11df`: exact-ID rule remains but list loses several types.
- **Current counterpart:** `3ad`: exact-ID copying is strengthened, including namespaced NPC IDs and L0 NPC fallback.
- **Commit trail:** `599a94cd`.
- **Runtime/downstream evidence:** Current index validates/rewrites container IDs before ObjectHelper.
- **Classification:** **Preserved**
- **Behavioral consequence:** The model remains constrained to engine-supplied container identity.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### E07 — Direct `site` candidate container type
- **Historical contract and location:** `b9`: `site` is an allowed candidate container.
- **Recovery boundary:** `11df`: removed from candidate schema.
- **Current counterpart:** `3ad`: still absent from candidate schema, although tracked objects/transfers and downstream index/SN understand site floors.
- **Commit trail:** Loss at recovery; downstream site rewrite remains.
- **Runtime/downstream evidence:** `452:index` and current index can rewrite/validate site containers.
- **Classification:** **Dormant downstream capability**
- **Behavioral consequence:** The engine can own site-floor objects, but generic CB candidates cannot directly name `site` as their type.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### E08A — Direct `player_worn` candidate container type
- **Historical contract and location:** `b9`: `player_worn` is an allowed generic object-candidate container for equipment worn by the player.
- **Recovery boundary:** `11df`: `player_worn` disappears from the allowed candidate vocabulary.
- **Current counterpart:** `3ad`: CB still cannot emit a generic `player_worn` candidate. Player entity `worn_objects` can become continuity attributes, while player worn-object state remains represented elsewhere in engine records and consumers.
- **Commit trail:** Removed at the recovery boundary; no direct CB restoration commit was identified.
- **Runtime/downstream evidence:** Current Authority Gate and player state still read `player.worn_object_ids`, demonstrating that worn-player state remains meaningful downstream even though CB cannot express the historical candidate route.
- **Classification:** **Dormant downstream capability**
- **Behavioral consequence:** The engine can retain and consume player-worn objects, but narration extraction through CB cannot directly introduce or route one using the historical generic container contract.
- **Confidence:** Medium-high
- **Unresolved evidence/contradiction:** The inspected evidence does not establish a complete modern replacement for narration-introduced or newly observed player-worn equipment.

#### E08B — Direct `npc_worn` candidate container type
- **Historical contract and location:** `b9`: `npc_worn` is an allowed generic object-candidate container for equipment worn by an NPC.
- **Recovery boundary:** `11df`: `npc_worn` disappears from the allowed candidate vocabulary.
- **Current counterpart:** `3ad`: generic `npc_worn` candidates remain unavailable, but entity `worn_objects`, intro capture, and BORN founding gear can create `npc_worn` ObjectRecords in bounded introduction/founding paths.
- **Commit trail:** Held/worn split and NPC-introduction/BORN repairs culminate in the current ownership rules at `3adca04`.
- **Runtime/downstream evidence:** Current index explicitly materializes matched entity `worn_objects` as `npc_worn` records and BORN creates declared founding worn gear in the same storage class.
- **Classification:** **Partially restored**
- **Behavioral consequence:** The historical worn-NPC outcome exists for founding and introduction observations, but the broad generic candidate route is not restored for every later NPC-worn case.
- **Confidence:** High
- **Unresolved evidence/contradiction:** No evidence in the fixed inspection proves that post-introduction narration can materialize newly observed NPC-worn gear after `object_capture_turn` closes the intro path.

#### E09 — Grid is valid only at L0
- **Historical contract and location:** `b9`: explicit prompt rule.
- **Recovery boundary:** `11df`: rule removed.
- **Current counterpart:** `3ad`: prompt no longer states it; current index rewrites grid candidates to site/localspace according to actual depth.
- **Commit trail:** Companion/current index depth-normalization logic.
- **Runtime/downstream evidence:** Downstream rewrite is authoritative and can reject when rewrite data is unavailable.
- **Classification:** **Superseded**
- **Behavioral consequence:** Depth correctness moved from LLM compliance to deterministic normalization.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### E10 — Transfer-origin taxonomy
- **Historical contract and location:** `b9`: `npc_transfer`, `environment_interaction`, `narrator_independent`, `player_claimed`.
- **Recovery boundary:** `11df`: preserved.
- **Current counterpart:** `3ad`: same categories, expanded with compound-action and founding exceptions.
- **Commit trail:** No foundational removal.
- **Runtime/downstream evidence:** Current origin gate enforces category/container/action combinations.
- **Classification:** **Preserved**
- **Behavioral consequence:** Candidate provenance remains explicit and machine-checkable.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### E11 — Post-founding `player_claimed` anti-conjuration
- **Historical contract and location:** `b9`: claims/gestures/background possession are blocked; doubt resolves to `player_claimed`.
- **Recovery boundary:** `11df`: preserved.
- **Current counterpart:** `3ad`: preserved for Turn 2+, with explicit Turn-1 exception.
- **Commit trail:** Current origin gate enforces the same post-founding block.
- **Runtime/downstream evidence:** Blocked candidates are logged to object errors.
- **Classification:** **Preserved**
- **Behavioral consequence:** Player prose cannot normally create inventory.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### E12 — Narrator-independent items cannot appear directly in player inventory
- **Historical contract and location:** `b9`: narrator may place independent objects only in environment containers.
- **Recovery boundary:** `11df`: preserved with fewer environment types.
- **Current counterpart:** `3ad`: preserved after Turn 1; current index deliberately exempts Turn 1.
- **Commit trail:** Current comments `v1.88.25` explain the founding exception.
- **Runtime/downstream evidence:** Origin gate rejects post-Turn-1 player placement and records negative evidence.
- **Classification:** **Partially restored**
- **Behavioral consequence:** The normal anti-conjuration rule survives, but founding narration has broader authority.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### E13 — Environment-interaction four-part acquisition proof
- **Historical contract and location:** `b9`: acquisition verb, environmental basis, no already-held framing, narration confirms success.
- **Recovery boundary:** `11df`: preserved.
- **Current counterpart:** `3ad`: preserved and extended to object-action pairs in compound turns.
- **Commit trail:** Modern compound-turn expansion.
- **Runtime/downstream evidence:** Current index additionally checks parsed action except on unknown/Turn 1.
- **Classification:** **Preserved**
- **Behavioral consequence:** Acquisition remains evidence-based rather than inferred from nearby narration.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.


#### E16 — Transfer identity by `temp_ref` or exact `object_id`
- **Historical contract and location:** `b9`: same-turn candidate uses temp ref; prior tracked object uses exact ID; no name-only transfer.
- **Recovery boundary:** `11df`: preserved.
- **Current counterpart:** `3ad`: preserved.
- **Commit trail:** No meaningful removal.
- **Runtime/downstream evidence:** AP replay suppression and ObjectHelper idempotency add defense.
- **Classification:** **Preserved**
- **Behavioral consequence:** Transfers remain identity-bearing rather than prose-name mutations.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### E17 — Transfer container vocabulary
- **Historical contract and location:** `b9`: transfer types include grid, NPC, player, localspace, site, and worn containers.
- **Recovery boundary:** `11df`: reduced to grid/NPC/player.
- **Current counterpart:** `3ad`: prompt allows grid/NPC/player/localspace; site is referenced in prose but absent from schema; worn paths remain separate.
- **Commit trail:** Recovery loss plus later specialized architecture.
- **Runtime/downstream evidence:** Current downstream understands site and worn ObjectRecords.
- **Classification:** **Partially restored**
- **Behavioral consequence:** Common transfers work, but the direct schema no longer exposes the full historical container set.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### E18 — Same-turn promote-then-transfer ordering
- **Historical contract and location:** `b9`: candidate establishes starting container; transfer moves to final destination.
- **Recovery boundary:** `11df`: wording largely absent.
- **Current counterpart:** `3ad`: explicit again and forbids redundant same-container transfer.
- **Commit trail:** Restoration commit not isolated.
- **Runtime/downstream evidence:** ObjectHelper quarantine runs promote/transfer entries.
- **Classification:** **Restored**
- **Behavioral consequence:** Newly introduced objects can be born at one location and moved once without duplicate placement.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### E19 — Tracked object condition mutation
- **Historical contract and location:** `b9`: explicit physical change only; exact ID preferred; ambiguity uses name fallback.
- **Recovery boundary:** `11df`: preserved.
- **Current counterpart:** `3ad`: preserved with fission exclusion.
- **Commit trail:** No foundational change.
- **Runtime/downstream evidence:** ObjectHelper applies the update; current diagnostics preserve condition text.
- **Classification:** **Preserved**
- **Behavioral consequence:** Damage/state remains a distinct lifecycle operation.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### E20 — Retirement when the original ceases to exist
- **Historical contract and location:** `b9`: full consumption/destruction or split with no surviving original; not ordinary damage/movement.
- **Recovery boundary:** `11df`: basic retirement trigger survives.
- **Current counterpart:** `3ad`: preserved and expanded with split verbs and receipt exclusions.
- **Commit trail:** No complete removal.
- **Runtime/downstream evidence:** ObjectHelper retirement is a real consumer.
- **Classification:** **Preserved**
- **Behavioral consequence:** Object identity ends only when the object no longer exists as itself.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### E21 — Retirement successors for fission
- **Historical contract and location:** `b9`: successors are persistent/interactable pieces only; incidental debris omitted; inherit parent container unless stated.
- **Recovery boundary:** `11df`: successors schema disappears.
- **Current counterpart:** `3ad`: successors restored, but generic piece language is sufficient and stacks may use quantity.
- **Commit trail:** Companion `v1.85.8` bridge; modern fission work.
- **Runtime/downstream evidence:** `452:index L4203-4257` retires parent first and injects successors only on success.
- **Classification:** **Partially restored**
- **Behavioral consequence:** Parent→successor continuity exists again, but the threshold and aggregation semantics changed.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### E22 — Fission atomicity
- **Historical contract and location:** `b9` prompt forbids candidates alongside parent retirement; companion bridge injects successors only after successful retirement.
- **Recovery boundary:** `11df` CB cannot express successors, so atomic fission is incomplete.
- **Current counterpart:** `3ad` retains `object_retirements.successors` and also introduces separate `fission_events`/TSL operations.
- **Commit trail:** `198a6c21`, `d31e3ada`, `53f9701f`.
- **Runtime/downstream evidence:** Two current fission representations coexist: executable retirement entries and witness-normalized operations.
- **Classification:** **Incomplete hybrid**
- **Behavioral consequence:** Atomicity is well guarded per path, but overlapping paths require precedence discipline.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### E23 — Instrument-versus-source fission rule
- **Historical contract and location:** `b9`: retire the material being transformed, not the instrument; tool residue is a condition update.
- **Recovery boundary:** `11df`: detailed instruction removed.
- **Current counterpart:** `3ad`: object-ID binding rule strongly says retire the transformation target, not its container/co-located item; residue-specific part remains absent.
- **Commit trail:** Modern object-ID binding additions.
- **Runtime/downstream evidence:** Current prompt prefers omission/null over retiring the wrong object.
- **Classification:** **Partially restored**
- **Behavioral consequence:** Wrong-parent retirement is guarded, but the full instrument/residue split is not.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.


#### E28 — Current retirement-ID contradiction
- **Historical contract and location:** `b9`: exact tracked ID required; omit if identity cannot be established.
- **Recovery boundary:** `11df`: exact ID required.
- **Current counterpart:** `3ad`: one paragraph still says exact IDs only, while split-binding text permits `object_id:null` on uncertainty.
- **Commit trail:** Modern fission prompt evolution.
- **Runtime/downstream evidence:** Downstream retirement bridge treats missing ID as malformed; TSL witness path can resolve prose source separately.
- **Classification:** **Incomplete hybrid**
- **Behavioral consequence:** The same model output section contains two incompatible identity instructions; behavior depends on which channel the model follows.
- **Confidence:** High
- **Unresolved evidence/contradiction:** Runtime frequency of null retirement entries was not measured.

#### E29 — Tracked-object scene scope
- **Historical contract and location:** `b9` builds the tracked list from active player objects, current L0 cell, active site/localspace floor, and visible NPC ownership so CB can distinguish new objects from existing records.
- **Recovery boundary:** The reduced helper loses part of the active site/localspace container coverage.
- **Current counterpart:** Current tracking restores active scene containers, L0 NPC fallback, and adds adjacent one-tile L0 floor objects as tracked.
- **Commit trail:** `2b3cf95a` documents L0 tracked-object/NPC plumbing; later layer fixes extend it.
- **Runtime/downstream evidence:** The current prompt explicitly labels adjacent records `nearby (1 tile)` and forbids promoting them.
- **Classification:** **Restored**
- **Behavioral consequence:** CB again sees most authoritative objects that could otherwise be re-described as new, with stronger nearby-floor protection.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### E30 — AP action context for affected-object disambiguation
- **Historical contract and location:** `b9` injects IDs and last event reasons from `_apExecutedTransfers` into “Player actions this turn” so the model can identify which tracked object was physically affected.
- **Recovery boundary:** The helper and prompt insertion survive.
- **Current counterpart:** `_describeApActionsThisTurn()` remains and is supplemented by TSL/TLS receipts and replay-suppression gates.
- **Commit trail:** Core helper predates the fixed snapshots; receipt architecture later narrows authoritative partial operations.
- **Runtime/downstream evidence:** Current object-condition instructions still prefer the AP-named object ID; current index consumes AP stamps for dedup and provenance.
- **Classification:** **Preserved**
- **Behavioral consequence:** Deterministic execution evidence remains available to the observational model instead of relying only on narration phrasing.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.


### Founding-premise and founding-NPC contracts

#### F01 — Turn-1 primary-source precedence
- **Historical contract and location:** `b9:CB founding L313-365`: player’s verbatim input is primary; narration is fallback only when silent/ambiguous; anti-drift forbids embellished expansion.
- **Recovery boundary:** `11df`: precedence text survives.
- **Current counterpart:** `3ad:CB L366-402`: text survives, but current Turn-1 object and NPC pipelines add overlapping authority.
- **Commit trail:** No removal of the text; later BORN/origin-gate architecture.
- **Runtime/downstream evidence:** Full Phase B reads `birth_record.raw_input`; pre-NPC pass separately reads `world.founding_prompt`.
- **Classification:** **Incomplete hybrid**
- **Behavioral consequence:** The rule remains written, but multiple founding channels no longer share one source/ownership path.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### F02 — Founding `form` field
- **Historical contract and location:** `b9`: explicit character type/role from primary source.
- **Recovery boundary:** `11df`: retained.
- **Current counterpart:** `3ad`: retained and written to `birth_record.form`.
- **Commit trail:** No meaningful removal.
- **Runtime/downstream evidence:** Historical identity write-back used it for `current_form`; current only preserves the birth-record field.
- **Classification:** **Partially restored**
- **Behavioral consequence:** The extracted field survives, but its historical player-identity promotion does not.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### F03 — Founding `location_premise` field
- **Historical contract and location:** `b9`: starting location from primary source.
- **Recovery boundary:** `11df`: retained.
- **Current counterpart:** `3ad`: retained.
- **Commit trail:** No meaningful removal.
- **Runtime/downstream evidence:** Written into birth record in all snapshots.
- **Classification:** **Preserved**
- **Behavioral consequence:** The declared start location remains a durable founding record.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### F04 — Founding `possessions` field
- **Historical contract and location:** `b9`: physical items explicitly owned/carried in primary source; abilities excluded.
- **Recovery boundary:** `11df`: retained.
- **Current counterpart:** `3ad`: retained.
- **Commit trail:** No meaningful removal.
- **Runtime/downstream evidence:** Written to birth record and promoted as `object:carrying X` attributes.
- **Classification:** **Preserved**
- **Behavioral consequence:** The semantic distinction between possession and capability remains in the surviving field.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### F05 — Founding `capabilities` field
- **Historical contract and location:** `b9`: explicit abilities/powers; promoted to permanent `declared:` player attributes.
- **Recovery boundary:** `11df`: field, write-back, and promotion disappear.
- **Current counterpart:** `3ad`: still absent from founding schema and write-back.
- **Commit trail:** Direct recovery loss; no CB restoration commit found.
- **Runtime/downstream evidence:** Current Authority Gate still reads player attributes in `declared` or `ability` buckets to validate ability use.
- **Classification:** **Dormant downstream capability**
- **Behavioral consequence:** The downstream authorization surface exists, but CB no longer has a dedicated founding channel to populate it.
- **Confidence:** High
- **Unresolved evidence/contradiction:** Another non-CB creator may populate ability attributes; none was needed to classify the CB exposure loss.

#### F06 — Founding `status_claims` field
- **Historical contract and location:** `b9`: identity/authority/history assertions; promoted to permanent `declared:` attributes.
- **Recovery boundary:** `11df`: retained.
- **Current counterpart:** `3ad`: retained and promotion preserved.
- **Commit trail:** No meaningful removal.
- **Runtime/downstream evidence:** Authority Gate consumes `declared` attributes.
- **Classification:** **Preserved**
- **Behavioral consequence:** Founding declarations still reach later authorization/truth systems.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### F07 — Founding `scenario_notes` semantics
- **Historical contract and location:** `b9`: player-linked relationships, current activity, objectives, role context, and starting circumstances from primary source.
- **Recovery boundary:** `11df`: narrowed to notes only when primary source is ambiguous and narration adds grounding.
- **Current counterpart:** `3ad`: retains the narrowed recovery wording.
- **Commit trail:** Semantic narrowing occurs at recovery boundary.
- **Runtime/downstream evidence:** Current write-back preserves the array but no longer promotes notes to `declared:` attributes.
- **Classification:** **Partially restored**
- **Behavioral consequence:** The field name survives, but its admissible content and downstream effect are materially smaller.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### F08 — Founding `world_notes` field
- **Historical contract and location:** `b9`: world-setting, geography, history, culture, and atmospheric framing from primary source; deliberately not promoted to player attributes.
- **Recovery boundary:** `11df`: removed.
- **Current counterpart:** `3ad`: remains absent.
- **Commit trail:** Direct recovery loss; no replacement contract found.
- **Runtime/downstream evidence:** No current CB output exposes founding world lore as a distinct field.
- **Classification:** **Accidentally missing**
- **Behavioral consequence:** Player-supplied founding world context is no longer preserved by CB in a dedicated birth-record channel.
- **Confidence:** Medium
- **Unresolved evidence/contradiction:** World generation may independently use the founding prompt, but that does not restore the CB/birth-record contract.

#### F09 — Founding `canonical_name` field
- **Historical contract and location:** `b9`: explicit personal name, distinct from title/role.
- **Recovery boundary:** `11df`: removed.
- **Current counterpart:** `3ad`: remains absent for the player.
- **Commit trail:** Direct recovery loss; no replacement contract found.
- **Runtime/downstream evidence:** Historical runPhaseB wrote `player.identity.canonical_name` and Phase C rendered it.
- **Classification:** **Accidentally missing**
- **Behavioral consequence:** CB no longer establishes or re-injects the player’s personal name.
- **Confidence:** Medium
- **Unresolved evidence/contradiction:** A separate player-creation path could own names, but no current replacement was proven within allowed evidence.

#### F10 — Founding `title_or_role` field
- **Historical contract and location:** `b9`: formal title/rank/position, separate from personal name and form.
- **Recovery boundary:** `11df`: removed.
- **Current counterpart:** `3ad`: remains absent for the player.
- **Commit trail:** Direct recovery loss; no replacement contract found.
- **Runtime/downstream evidence:** Historical runPhaseB wrote `player.identity.title_or_role` and Phase C rendered it.
- **Classification:** **Accidentally missing**
- **Behavioral consequence:** Formal player title continuity is no longer supplied by CB.
- **Confidence:** Medium
- **Unresolved evidence/contradiction:** No explicit design decision to retire it was found.

#### F11 — Player identity write-back
- **Historical contract and location:** `b9`: creates/updates `player.identity`, including canonical name, title, current/last-known form, and public-identity-known flag.
- **Recovery boundary:** `11df`: entire write-back removed.
- **Current counterpart:** `3ad`: not restored.
- **Commit trail:** Direct recovery loss.
- **Runtime/downstream evidence:** Historical Phase C consumed the identity object; current Phase C does not.
- **Classification:** **Accidentally missing**
- **Behavioral consequence:** The field loss is not merely cosmetic; both storage and narrator exposure disappeared.
- **Confidence:** Medium
- **Unresolved evidence/contradiction:** Intent remains undocumented.

#### F12 — Status-claim promotion to declared attributes
- **Historical contract and location:** `b9`: each status claim becomes an idempotent `declared:` attribute.
- **Recovery boundary:** `11df`: preserved.
- **Current counterpart:** `3ad`: preserved.
- **Commit trail:** No meaningful removal.
- **Runtime/downstream evidence:** Current Authority Gate uses declared attributes as evidence.
- **Classification:** **Preserved**
- **Behavioral consequence:** Founding authority/history claims still influence later adjudication.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### F13 — Possession promotion to player object attributes
- **Historical contract and location:** `b9`: each possession becomes `object:carrying <item>`.
- **Recovery boundary:** `11df`: preserved.
- **Current counterpart:** `3ad`: preserved.
- **Commit trail:** No meaningful removal.
- **Runtime/downstream evidence:** Phase C renders permanent player object attributes.
- **Classification:** **Preserved**
- **Behavioral consequence:** Founding possessions still have a continuity representation even apart from ORS.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### F14 — Capability promotion to declared attributes
- **Historical contract and location:** `b9`: each capability becomes an idempotent `declared:` attribute.
- **Recovery boundary:** `11df`: removed with the field.
- **Current counterpart:** `3ad`: remains absent.
- **Commit trail:** Recovery loss.
- **Runtime/downstream evidence:** Authority Gate’s declared/ability evidence reader proves the consumer contract survives.
- **Classification:** **Dormant downstream capability**
- **Behavioral consequence:** A usable downstream authorization mechanism is no longer fed by CB’s dedicated capability extraction.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### F15 — Scenario-note promotion to declared attributes
- **Historical contract and location:** `b9`: player-linked scenario notes become permanent `declared:` attributes; world notes explicitly do not.
- **Recovery boundary:** `11df`: promotion removed.
- **Current counterpart:** `3ad`: remains absent.
- **Commit trail:** Recovery loss; no replacement found.
- **Runtime/downstream evidence:** The array is still written to birth record but not surfaced into continuity truth.
- **Classification:** **Accidentally missing**
- **Behavioral consequence:** Relationships/objectives/start circumstances can be stored yet never re-enter narrator truth through CB.
- **Confidence:** Medium
- **Unresolved evidence/contradiction:** Some notes may be represented by newer NPC/object systems, but the general contract is not replaced.

#### F16 — Turn-1 founding possessions as real ORS objects
- **Historical contract and location:** `b9`: birth-record possessions and object attributes exist, but the prompt’s `player_claimed` block lacks an explicit founding candidate exception; companion index exempts Turn 1 if candidates are emitted.
- **Recovery boundary:** `11df`: same ambiguity, with reduced schema.
- **Current counterpart:** `3ad`: prompt explicitly requires one player candidate per primary-source possession and current origin gate exempts Turn 1.
- **Commit trail:** Modern founding exceptions (`v1.85.7`/later comments).
- **Runtime/downstream evidence:** Current ObjectHelper can materialize the candidate into player inventory.
- **Classification:** **Restored**
- **Behavioral consequence:** The previously split intent between founding record and ORS bridge is now explicit.
- **Confidence:** High
- **Unresolved evidence/contradiction:** Historical runtime frequency of candidate duplication/omission was not measured.


#### F21 — Narration-only NPC equipment on Turn 1
- **Historical contract and location:** `b9`: generic entity held/worn fields can observe opening narration; companion intro capture can materialize them for an existing visible NPC.
- **Recovery boundary:** `11df`: collapsed field breaks the expected split consumer.
- **Current counterpart:** `3ad`: explicit rule routes narration-only gear through matched entity held/worn fields, not `starting_npc`, and prevents duplicate generic candidates.
- **Commit trail:** `3adca04`.
- **Runtime/downstream evidence:** Current intro capture materializes gear after BORN/registry reconciliation.
- **Classification:** **Restored**
- **Behavioral consequence:** Narrator observation can add visible equipment without retroactively rewriting the player-authorized birth record.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### F22 — Held versus worn founding equipment
- **Historical contract and location:** `b9`: generic entity fields distinguish carried/held from body-fitted equipment.
- **Recovery boundary:** `11df`: distinction lost.
- **Current counterpart:** `3ad`: distinction exists both in `starting_npc` gear arrays and entity held/worn arrays; BORN/intro capture map to `npc` vs `npc_worn`.
- **Commit trail:** `2b3cf95a`, `3bf86492`, `3adca04`.
- **Runtime/downstream evidence:** Current ORS records and NPC object-id arrays preserve the split.
- **Classification:** **Restored**
- **Behavioral consequence:** Equipment posture has end-to-end semantic and storage consequences again.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.


#### F25 — Turn-1 player input authorization boundary
- **Historical contract and location:** `b9`: founding fields are primary-source constrained; generic object/entity extraction still reads opening narration, and companion Turn-1 gates permit candidate materialization.
- **Recovery boundary:** `11df`: founding model shrinks but the mixed narration/object pipeline remains.
- **Current counterpart:** `3ad`: primary-source fields coexist with broad complete-scene extraction and Turn-1 exemptions for player-claimed, narrator-independent, and environment-interaction candidates.
- **Commit trail:** Current index comments `v1.88.25`, `v1.88.72`.
- **Runtime/downstream evidence:** Origin gates explicitly treat founding narration as constitutional initial reality.
- **Classification:** **Incomplete hybrid**
- **Behavioral consequence:** Player-authored premise and narrator-authored opening scene both can authorize different parts of initial state, with field-specific rather than global precedence.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### F26 — Narration fallback for founding fields
- **Historical contract and location:** `b9`: narration may fill a field only when primary source is silent/ambiguous and factual, not embellishment.
- **Recovery boundary:** `11df`: text survives but `scenario_notes` is narrowed to that fallback case.
- **Current counterpart:** `3ad`: text survives; pre-NPC pass ignores narration, full Phase B receives it.
- **Commit trail:** No single replacement commit.
- **Runtime/downstream evidence:** Two current founding extractors therefore apply different evidence sets.
- **Classification:** **Incomplete hybrid**
- **Behavioral consequence:** The same `starting_npc` can be seeded from premise-only evidence and then overwritten by a broader full extraction.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### F27 — Contested narration/emote effects during founding
- **Historical contract and location:** `b9`: contested-emote rule specifically blocks false NPC state consequences; founding field anti-drift limits narration.
- **Recovery boundary:** `11df`: contested rule removed.
- **Current counterpart:** `3ad`: Authority Gate bypasses itself on Turn 1; current origin gates broadly exempt founding objects, while NPC gear ownership is narrowly repaired.
- **Commit trail:** Authority Gate `turn_1_founding`; `3adca04` NPC equipment repair.
- **Runtime/downstream evidence:** No equivalent global contested-opening-narration gate was proven.
- **Classification:** **Unresolved**
- **Behavioral consequence:** The exact limit of narrator authority over disputed Turn-1 actions requires runtime evidence.
- **Confidence:** Medium
- **Unresolved evidence/contradiction:** A targeted Turn-1 contested-emote run is required.

#### F28 — Founding extraction failure signaling
- **Historical contract and location:** `b9` companion marks `birth_record._extraction_failed` when Turn-1 CB returns null.
- **Recovery boundary:** `11df` compatible.
- **Current counterpart:** `3ad` current index preserves the marker; token headroom was raised after observed failure.
- **Commit trail:** `6b331d79`.
- **Runtime/downstream evidence:** BORN does not fire if the required write-back never occurs.
- **Classification:** **Preserved**
- **Behavioral consequence:** Degraded founding state is explicitly marked rather than silently treated as complete.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

## 5. Modern architecture relevant to reconciliation — excluded from ledger totals

Version 1 counted the records below as though each were a historical CB contract. Version 2 preserves their evidence but removes them from the classified ledger because their unit of analysis is modern-only architecture, downstream consumer machinery, or synthesis. No new classification category is introduced; these records are explicitly non-counted context.

### 5.1 Downstream bridge mechanics

These records describe consumer-side mechanisms that made historical CB outputs operative. They remain evidence for the relevant CB contracts, but they are not themselves contracts located in the intact `ContinuityBrain.js`.

#### Context B15 — NPC intro equipment materialization
- **Historical contract and location:** `b9` entity fields feed the companion index’s intro-capture bridge, which makes ORS candidates for held and worn gear.
- **Recovery boundary:** `11df` collapses the fields, breaking the companion bridge’s expected names.
- **Current counterpart:** Current split fields and intro-capture bridge operate again; `3adca04` adds explicit Turn-1 equipment-channel ownership and receipts.
- **Commit trail:** `v1.85.28` comments in companion; `2b3cf95a` and `3adca04` later repairs.
- **Runtime/downstream evidence:** `452:index L3760-3960`; current index L6740-6830.
- **Ledger disposition:** **Excluded from the historical-contract count in v2**
- **Behavioral consequence:** Narrated NPC gear can again become authoritative ObjectRecords in the correct held/worn container.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### Context B16 — `object_capture_turn` one-time capture eligibility
- **Historical contract and location:** `452:index`: capture is skipped once set; zero-gear NPCs remain eligible.
- **Recovery boundary:** CB recovery’s collapsed field undermines the expected capture path.
- **Current counterpart:** Current bridge retains the rule; geared BORN NPCs are stamped and gearless NPCs remain eligible.
- **Commit trail:** `a23e99bb` documents the geared/gearless distinction.
- **Runtime/downstream evidence:** Current exact duplicate guards prevent recreation even before final stamping.
- **Ledger disposition:** **Excluded from the historical-contract count in v2**
- **Behavioral consequence:** Intro capture is bounded without permanently excluding NPCs whose gear appears later.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

### 5.2 Modern-only object architecture

These capabilities did not exist in the intact CB. They explain current ownership, replacement, or containment architecture, but they cannot be classified as preserved/restored/superseded historical contracts in their own right.

#### Context E14 — Object actor association
- **Historical contract and location:** `b9`: no `actor_npc_ref` field on generic candidates.
- **Recovery boundary:** `11df`: absent.
- **Current counterpart:** `3ad`: adds `actor_npc_ref` for active manipulation and possessive language; proximity alone is excluded.
- **Commit trail:** Modern addition; exact commit not isolated.
- **Runtime/downstream evidence:** SN consumes actor association during alias resolution.
- **Ledger disposition:** **Excluded from the historical-contract count in v2**
- **Behavioral consequence:** Actor ownership/handling is now explicit rather than inferred downstream from container alone.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### Context E15 — Quantity and unit metadata
- **Historical contract and location:** `b9`: no generic quantity/unit candidate fields.
- **Recovery boundary:** `11df`: absent.
- **Current counterpart:** `3ad`: optional explicit count/unit on candidates and successors.
- **Commit trail:** Modern stack architecture.
- **Runtime/downstream evidence:** Current ORS and partial-stack receipts use quantity-bearing records.
- **Ledger disposition:** **Excluded from the historical-contract count in v2**
- **Behavioral consequence:** Object identity now supports stacks rather than singular-only implicit records.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### Context E24 — `fission_events` witness channel
- **Historical contract and location:** `b9`: no separate witness channel; fission is expressed through retirement+successors.
- **Recovery boundary:** `11df`: no witness channel.
- **Current counterpart:** `3ad`: adds prose-source witness events normalized by SemanticNormalizer.
- **Commit trail:** `198a6c21` schema; `d31e3ada` normalization; `53f9701f` return wiring.
- **Runtime/downstream evidence:** SN creates ORS-compatible `fission_operations` with alias resolution.
- **Ledger disposition:** **Excluded from the historical-contract count in v2**
- **Behavioral consequence:** Fission observation has moved toward a witness→normalization architecture, though old retirement execution still coexists.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### Context E25 — `extraction_events` for source-surviving separation
- **Historical contract and location:** `b9`: no dedicated source-surviving split channel.
- **Recovery boundary:** `11df`: absent.
- **Current counterpart:** `3ad`: adds witness-only extraction when source persists with reduced quantity/state.
- **Commit trail:** `637529e7` schema; `89baa417` normalization; `97bdd42a` mutation-authority boundary.
- **Runtime/downstream evidence:** SN reads current source quantity and builds normalized extraction operations.
- **Ledger disposition:** **Excluded from the historical-contract count in v2**
- **Behavioral consequence:** Partial extraction is now distinguished from full fission rather than forced into candidate/retirement semantics.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### Context E26 — Validated partial-operation receipt precedence
- **Historical contract and location:** `b9`: no TLS/ObjectHelper receipt context.
- **Recovery boundary:** `11df`: absent.
- **Current counterpart:** `3ad`: validated TAKE/DROP/THROW receipts suppress generic candidate/transfer/fission/extraction/retirement reports for the same operation.
- **Commit trail:** `f94da82c` DROP; `f929cadb` THROW; `97bdd42a` witness boundary.
- **Runtime/downstream evidence:** Current index validates receipts and only passes accepted ones to CB.
- **Ledger disposition:** **Excluded from the historical-contract count in v2**
- **Behavioral consequence:** Authoritative execution identity now comes from TLS/ObjectHelper, while CB is limited to classification/description.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### Context E27 — Receipt-bound successor description
- **Historical contract and location:** `b9`: candidate descriptions could describe newly promoted objects; no dedicated child metadata.
- **Recovery boundary:** `11df`: same.
- **Current counterpart:** `3ad`: dedicated TAKE/DROP/THROW child description + verbatim evidence, stripped from general extraction and validated against copied parent text.
- **Commit trail:** `e7e78f0b` child-description fix; `97bdd42a`; `3adca04` current consumption.
- **Runtime/downstream evidence:** Current index applies description only to the receipt-identified successor via direct helper.
- **Ledger disposition:** **Excluded from the historical-contract count in v2**
- **Behavioral consequence:** CB no longer creates the child; it supplies bounded descriptive metadata to an already-authoritative record.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

### 5.3 Modern-only founding architecture

These records document the newer `starting_npc`/BORN system and its policies. They belong in the modern founding reconciliation, not in the historical-contract denominator.

#### Context F17 — Modern `starting_npc` founding field
- **Historical contract and location:** `b9`: no dedicated founding NPC field; NPCs are handled only through generic entity extraction if visible in narration.
- **Recovery boundary:** `11df`: no dedicated field at the recovery boundary.
- **Current counterpart:** `3ad`: `starting_npc` object adds identity, relation, description, demographics, job, carried gear, and worn gear.
- **Commit trail:** `18642683` initial BORN-NPC; `6168299b` ordering fix; later patches.
- **Runtime/downstream evidence:** Full Phase B writes it to birth record; BORN consumes it.
- **Ledger disposition:** **Excluded from the historical-contract count in v2**
- **Behavioral consequence:** A dedicated founding-NPC model replaces reliance on generic narration-only entity discovery for declared companions.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### Context F18 — Founding NPC identity pre-pass
- **Historical contract and location:** `b9`/`11df`: absent.
- **Recovery boundary:** `11df`: absent.
- **Current counterpart:** `3ad:CB L1907-1938`: a separate Turn-1 LLM call extracts only NPC identity before Phase B and writes `birth_record.starting_npc`.
- **Commit trail:** `v1.88.31` comments in current index/CB.
- **Runtime/downstream evidence:** Current index computes the deterministic BORN ID and pre-seeds a visible NPC before full Phase B.
- **Ledger disposition:** **Excluded from the historical-contract count in v2**
- **Behavioral consequence:** Identity is extracted twice—pre-pass and full Phase B—with different prompts and source fields.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### Context F19 — BORN-NPC materialization
- **Historical contract and location:** `b9`: no BORN path.
- **Recovery boundary:** `11df` is immediately followed in history by BORN work, but the recovery snapshot itself lacks `starting_npc`.
- **Current counterpart:** `3ad`: index creates one canonical NPC record, visibility placement, registry labels, and birth-custom ORS gear.
- **Commit trail:** `18642683`, `6168299b`, `fbdf06f9`, `ab59bab0`, `3d728dc3` and related patches.
- **Runtime/downstream evidence:** Current index L6440-6630 contains the real consumer.
- **Ledger disposition:** **Excluded from the historical-contract count in v2**
- **Behavioral consequence:** Declared founding NPCs are now engine entities rather than continuity attributes alone.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### Context F20 — Founding NPC primary-source gear ownership
- **Historical contract and location:** `b9`: no dedicated founding NPC gear; generic `entity_candidates` could observe narrated held/worn items.
- **Recovery boundary:** `11df`: generic fields collapsed.
- **Current counterpart:** `3ad`: `starting_npc.inventory_items/worn_items` authorize BORN birth records only when explicitly stated in primary source.
- **Commit trail:** `3bf86492`; `3adca04` ownership repair.
- **Runtime/downstream evidence:** BORN creates `npc` and `npc_worn` ObjectRecords with deterministic IDs and descriptions.
- **Ledger disposition:** **Excluded from the historical-contract count in v2**
- **Behavioral consequence:** Founding gear has explicit authorization and authoritative ORS ownership.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### Context F23 — Multiple founding NPC handling
- **Historical contract and location:** `b9`: no dedicated policy.
- **Recovery boundary:** `11df`: no policy.
- **Current counterpart:** `3ad`: instantiate only the first; record extras as `DEFERRED_NPC:` scenario notes that are not scene truth.
- **Commit trail:** Modern starting-NPC architecture.
- **Runtime/downstream evidence:** BORN consumes a single object, never an array except backward-compat first-element fallback.
- **Ledger disposition:** **Excluded from the historical-contract count in v2**
- **Behavioral consequence:** A deterministic single-NPC scope replaces unspecified multi-entity founding behavior.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### Context F24 — Founding NPC timing/identity registry
- **Historical contract and location:** `b9`: entity resolution expects an existing ID; no declared-NPC birth timing problem exists because no BORN path.
- **Recovery boundary:** `11df`: same.
- **Current counterpart:** `3ad`: pre-ID, pre-seed, BORN, `_turn1_founded_entities`, and post-BORN warning reclassification coordinate identity.
- **Commit trail:** `fbdf06f9`, `ab59bab0`, `ef1230a7`, `6585dc8e`.
- **Runtime/downstream evidence:** Commit history records several real timing failures and fixes.
- **Ledger disposition:** **Excluded from the historical-contract count in v2**
- **Behavioral consequence:** The system works through a staged reconciliation rather than one authoritative extraction/materialization transaction.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

#### Context F29 — Founding NPC gear descriptions
- **Historical contract and location:** `b9`: generic entity gear is string-only and intro-created objects receive empty descriptions.
- **Recovery boundary:** `11df`: combined strings only.
- **Current counterpart:** `3ad`: primary-source BORN gear uses `{name,description}` objects; narration-only intro gear still begins with empty description.
- **Commit trail:** `3bf86492`, `3adca04`.
- **Runtime/downstream evidence:** BORN falls back to item name when structured description is missing.
- **Ledger disposition:** **Excluded from the historical-contract count in v2**
- **Behavioral consequence:** Birth-custom gear receives physical descriptions, but narration-introduced gear still uses a weaker description path.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

### 5.4 Cross-system synthesis

This is a synthesis of several real contracts and newer components, not one independently classifiable historical contract.

#### Context F30 — Relationship among founding premise, BORN, generic candidates, entity extraction, and ORS
- **Historical contract and location:** `b9`: founding fields write birth record/attributes; generic candidates and entity gear reach ObjectHelper through companion index.
- **Recovery boundary:** `11df`: several fields and split gear channels are lost.
- **Current counterpart:** `3ad`: pre-pass/full Phase B populate founding record; BORN creates NPC/gear; entity extraction captures narration gear; generic candidates create player/scene objects; ORS owns final records.
- **Commit trail:** Cumulative v1.88.x and v1.90–1.92 architecture.
- **Runtime/downstream evidence:** Current index is the transaction coordinator; CB is no longer sole founding interpreter.
- **Ledger disposition:** **Excluded from the historical-contract count in v2**
- **Behavioral consequence:** Initial state is coherent only when several overlapping channels obey their ownership exclusions.
- **Confidence:** High
- **Unresolved evidence/contradiction:** None identified from fixed evidence.

## 6. Dedicated founding-premise reconciliation
### 6.1 Historical founding model

The intact model was a player-premise record with nine explicit fields:

| Historical field | Primary meaning | Historical downstream ownership |
|---|---|---|
| `form` | Player character type/role | `birth_record.form`; also `player.identity.current_form` / `last_known_form`; narrator identity line |
| `location_premise` | Declared starting place | `birth_record.location_premise` |
| `possessions` | Explicit physical items owned/carried | `birth_record.possessions`; permanent `object:carrying …` attributes |
| `capabilities` | Explicit powers/abilities | `birth_record.capabilities`; permanent `declared:` attributes |
| `status_claims` | Identity, authority, membership, history | `birth_record.status_claims`; permanent `declared:` attributes |
| `scenario_notes` | Player-linked relationships, objectives, activity, circumstances | `birth_record.scenario_notes`; permanent `declared:` attributes |
| `world_notes` | Player-supplied world setting/lore/geography/culture | `birth_record.world_notes`; deliberately *not* promoted to player attributes |
| `canonical_name` | Explicit personal name | `player.identity.canonical_name`; narrator identity line |
| `title_or_role` | Formal title/rank distinct from name/form | `player.identity.title_or_role`; narrator identity line |

The historical source rule was field-by-field: primary source first, narration only if the player was silent or ambiguous, no embellishment drift, and null/empty when neither source grounded the value.

### 6.2 Recovery model

The recovery retained only `form`, `location_premise`, `possessions`, `status_claims`, and `scenario_notes`. It removed the player capability channel, world-note channel, name/title identity fields, identity write-back, capability promotion, scenario-note promotion, and identity rendering. It also narrowed `scenario_notes` from a broad player-linked founding field to a narration-fallback field used only when primary input was ambiguous.

### 6.3 Modern player founding model

Current CB still uses the reduced five player fields. It preserves status and possession promotion, but does not restore:
- `capabilities`;
- `world_notes`;
- `canonical_name`;
- `title_or_role`;
- player identity write-back/rendering;
- scenario-note promotion.

The result is not simply a smaller birth record. It changes later authority. Current Authority Gate still validates ability use against `declared` or `ability` attributes, so the consumer survives while the dedicated founding producer does not.

### 6.4 Modern founding NPC model

Current CB adds `starting_npc` with:
- `name`;
- `generated_name`;
- `role_or_relation`;
- `description`;
- `gender`;
- `age`;
- `job_category`;
- `inventory_items`;
- `worn_items`.

Only the first declared NPC is instantiated; additional NPCs become `DEFERRED_NPC:` notes and are explicitly not scene truth.

This model is consumed by BORN-NPC, which creates a canonical NPC record, places it at the correct layer, creates deterministic birth-custom ObjectRecords for carried and worn gear, writes the founding registry, and refreshes visibility. It is materially newer architecture, not restoration of an old `starting_npc` field—the intact CB had no such field.

### 6.5 Held versus worn authority

Current `3adca04` establishes a useful ownership split:

| Evidence source | CB output channel | Authoritative owner |
|---|---|---|
| Primary source explicitly states starting NPC carries gear | `founding_premise.starting_npc.inventory_items` | BORN birth-custom `npc` ObjectRecords |
| Primary source explicitly states starting NPC wears gear | `founding_premise.starting_npc.worn_items` | BORN birth-custom `npc_worn` ObjectRecords |
| Opening narration shows matched NPC holding/carrying gear not in primary source | `entity_candidates[].held_objects` | Intro-capture bridge → ORS `npc` record |
| Opening narration shows matched NPC wearing gear not in primary source | `entity_candidates[].worn_objects` | Intro-capture bridge → ORS `npc_worn` record |
| Same narrated NPC gear also appears as generic portable object | Explicitly forbidden on Turn 1 | Prevents duplicate ORS creation |

This is a genuine restoration of the held/worn semantic distinction, but it operates inside a newer BORN/intro-capture system.

### 6.6 Turn-1 authorization and narration authority

The historical and current systems both state that the player’s input is the primary source for founding fields. The practical initial-state authority is broader:

- General CB entity/environment/object extraction reads the narrator’s opening narration.
- The companion/current ORS bridge can materialize CB object candidates.
- Current origin gates exempt Turn 1 from several normal anti-conjuration blocks.
- Current comments explicitly call founding narration “constitutional initial reality.”
- NPC gear was narrowed by `3adca04`, but player/scene object authority is still broader than the founding-field source rule.

Therefore the current founding model is an **incomplete hybrid**: source precedence is field-specific, while initial object/entity reality is authorized by several independent channels.

### 6.7 Pre-pass versus full Phase B

Current founding NPC identity is extracted twice:

1. `extractFoundingNpc()` reads `world.founding_prompt`, excludes objects and scene facts, writes `birth_record.starting_npc`, and allows the index to compute/pre-seed a canonical NPC ID.
2. Full Phase B reads `birth_record.raw_input` plus narration and writes `birth_record.starting_npc` again with a richer schema.

The pre-seed makes full Phase B able to use the eventual NPC ID, but it also means two LLM outputs can disagree. The fixed source shows no explicit reconciliation rule beyond later overwrite/order. That is a central unresolved hybrid-authority point.

### 6.8 Relationship map

```text
Player Turn-1 input
    ├─ world.founding_prompt ──> CB identity pre-pass ──> birth_record.starting_npc
    │                                              └─> deterministic pre-ID / visible pre-seed
    └─ birth_record.raw_input + opening narration ──> full CB Phase B
          ├─ reduced founding_premise fields ──> birth_record / selected player attributes
          ├─ starting_npc ──> BORN-NPC ──> NPC + birth-custom ORS gear
          ├─ entity_candidates held/worn ──> intro capture ──> ORS NPC gear
          ├─ object_candidates ──> origin/depth/dedup gates ──> ObjectHelper / ORS
          └─ environment/entity attributes ──> continuity TRUTH
```

The current architecture is strongest where ownership is explicit—especially BORN gear after `3adca04`—and weakest where multiple Turn-1 channels can authorize the same broad class of reality.

## 7. Concise loss-and-restoration map
| Loss boundary item | Recovery state | Modern state |
|---|---|---|
| `capabilities` field + declared promotion | Removed | Still absent; Authority Gate consumer remains |
| `world_notes` | Removed | Still absent |
| player `canonical_name` / `title_or_role` | Removed | Still absent |
| player identity object + TRUTH line | Removed | Still absent |
| broad scenario-note semantics + promotion | Narrowed/removed | Narrow field retained; promotion still absent |
| `visible_objects` | Removed | Still absent from CB; downstream expectation remains |
| held/worn split | Collapsed | Restored and operational |
| generic `player_worn` candidate type | Removed | Still absent from CB; worn-player state remains downstream |
| generic `npc_worn` candidate type | Removed | Partially restored through bounded entity-intro/BORN routes |
| `site` generic candidate type | Removed | Still absent from CB; downstream support remains |
| grid-only-L0 prompt rule | Removed | Replaced by deterministic depth rewrite |
| canonical environment dedup | Removed | Still absent |
| ENV/NPC/location output cap | Removed | Restored as unified 20-entry cap |
| dedicated 10-entry location cap | Removed | Replaced by unified cap; historical constant was not operative in inspected renderer |
| Turn-1 parse retry | Removed | Still missing; token ceiling/raw diagnostics are mitigation, not restoration |
| entity wrapper alias | Removed | Replaced by nested `extracted.entity_candidates` access |
| retirement successors | Removed | Restored with changed semantics; overlaps newer witness path |
| contested-emote outcome rule | Removed | Only adjacent authority gates restored |
| watch brief/message | Retained at recovery | Later removed; replacement not proven |

## 8. Contradiction log
| ID | Earlier conclusion | Revised conclusion |
|---|---|---|
| C-01 | The first assumption was that `b9c0da3` could supply both audit files. | Commit comparison showed `b9c0da3`’s CB is intact but its `index.js` differs substantially from `452966ce`; the specified cross-commit pairing is necessary. |
| C-02 | `visible_objects` initially looked like an intact operational channel. | The intact prompt emits it, but the intact wrapper omits the alias while companion index reads the alias. The historical contract was already bridge-incomplete; current CB removes it entirely while downstream still expects it. |
| C-03 | The header `v1.70.0` appeared to identify the CB version. | The internal `CB_VERSION` is independently `1.5.2` in intact/current and `1.5.1` in recovery; package version is a third label. |
| C-04 | Current held/worn support looked like a simple textual restoration. | Post-parse canonicalization, intro capture, BORN gear, object-capture timing, and `3adca04` ownership rules show it is an operational restoration inside newer architecture. |
| C-05 | Historical founding possessions appeared to be end-to-end ORS-authorized. | The historical prompt blocks `player_claimed` candidates without a Turn-1 exception, while companion index exempts Turn 1 if such candidates arrive. Current prompt makes the exception explicit; historical operation is therefore less certain than the field/write-back contract. |
| C-06 | Modern founding NPC looked like one new field. | It is actually a pre-pass + full Phase B + pre-seed + BORN + registry + entity intro-capture chain. |
| C-07 | Retirement successors appeared fully restored. | The historical successor contract is only partially restored because successor thresholds/aggregation changed; modern `fission_events` are separate non-counted architecture that also affects precedence. |
| C-08 | `extraction_events` initially looked like an authoritative split lane. | Commit `97bdd42a` and current receipt rules make generic extraction a witness only; TLS/ObjectHelper receipts own already-executed partial operations. |
| C-09 | Founding capabilities looked simply deleted. | Authority Gate still consumes `declared`/`ability` attributes, proving a dormant downstream capability rather than total architectural disappearance. |
| C-10 | The missing current `entity_candidates` wrapper alias looked accidental. | Current index explicitly reads entity candidates from `_phaseBResult.extracted`; the access contract was deliberately or effectively replaced. |
| C-11 | The missing Turn-1 parse retry was classified as partially restored because output headroom and diagnostics improved. | Capacity and diagnostic mitigation do not restore a second extraction attempt; the historical retry is classified as accidentally missing. |
| C-12 | `LOC_ATTR_WINDOW = 10` looked like a working historical location cap. | The intact renderer uses `ENV_ATTR_WINDOW` for the actual slice; the dedicated constant was declarative but not operative in the inspected file. |
| C-13 | Version 1 treated every relevant modern mechanism as an independently classifiable historical contract. | Version 2 limits the ledger denominator to contracts present in the intact CB and moves 16 modern-only, downstream, or synthesis records into non-counted context. |

## 9. Unresolved items requiring runtime or narrower historical evidence
1. Whether any intermediate revision between the fixed snapshots ever exposed `visible_objects` as a top-level CB return alias and produced a successful runtime consumer trace.
2. Whether removal of `capabilities`, `world_notes`, player canonical name/title, identity write-back, and scenario-note promotion was deliberately accepted after the emergency recovery or simply never revisited.
3. How current `extractFoundingNpc()` and full Phase B behave when they produce different NPC names, relations, or identity attributes from the same premise.
4. The exact authority limit for narrator-only player objects on Turn 1, especially contested or failed actions, because Authority Gate bypasses founding turns and origin gates broadly exempt them.
5. Which current fission representation wins when the model emits both `object_retirements.successors` and `fission_events` for the same event; static source shows exclusions but no runtime sample was inspected.
6. Whether optional output keys omitted by the model can still bypass core CB validation and produce silent partial operation despite current schema-drift logging.
7. Whether current post-BORN warning reclassification reads the correct diagnostics property (`diagnostics` versus `continuity_diagnostics`) in live state.
8. Whether malformed non-string physical/state/environment facts can reach `_isConcreteDetail` after the held/worn-only canonicalizer.
9. Whether the historical contested-emote rule is fully covered by current narrator, soliloquy, Authority Gate, and ORS gates.
10. Runtime evidence for historical founding possession materialization under the intact prompt’s lack of an explicit Turn-1 `player_claimed` exception.

## 10. Unrelated discoveries — pointers only
- The current post-BORN warning-reclassification code appears to look for `_phaseBResult.continuity_diagnostics`, while CB returns `diagnostics`. This was not expanded into a diagnostics investigation.
- Current index schema-drift detection expects `visible_objects` at the wrapper level even though current CB cannot emit it. This is included only because it directly classifies a historical CB contract.
- The historical `LOC_ATTR_WINDOW` constant appears unused by the inspected Phase C renderer. No broader dead-code audit was performed.
- Current `ContinuityBrain.js` retains the old `v1.70.0` file header despite modern internal/package versions. No versioning cleanup analysis was performed.
- Search results exposed an existing file named `CB_PROMPT_RECONCILIATION_LEDGER_2026-07-23.md`; it was not opened or used.

## 11. Reproducibility and complete helper-command record
### 11.1 Scripts

No parser, source-comparison script, OCR process, or generated source diff was used in the original research. Therefore no repository claim depends on an unpreserved source transformation. This also means completeness is a manual research conclusion rather than a property established by the validator.

The Markdown artifact itself was assembled with a preserved, uncommitted generation script:

```text
filename: /mnt/data/generate_cb_forensic_artifact.py
invocation: python /mnt/data/generate_cb_forensic_artifact.py
repository files inspected by the script: none
inputs: manually encoded findings derived from the connector retrievals listed below
output: /mnt/data/ContinuityBrain_Forensic_Contract_Audit.md
```

The completed artifact was structurally checked with a second preserved script:

```text
filename: /mnt/data/validate_cb_forensic_artifact.py
invocation: python /mnt/data/validate_cb_forensic_artifact.py
input: /mnt/data/ContinuityBrain_Forensic_Contract_Audit.md
checks: ledger-entry count and presence of all nine required ledger fields
observed v1 output: {'ledger_entries': 118, 'missing_required_fields': []}
```

Version 2 was produced by a preserved correction script that edits only the existing artifact:

```text
filename: /mnt/data/revise_cb_forensic_artifact_v2.py
invocation: python /mnt/data/revise_cb_forensic_artifact_v2.py
input: /mnt/data/ContinuityBrain_Forensic_Contract_Audit.md
repository files inspected by the script: none
operations: remove non-historical records from classified totals; preserve them as context; split E08; reclassify A09; update totals, maps, methodology, conclusions, and revision history
output: /mnt/data/ContinuityBrain_Forensic_Contract_Audit_v2.md
```

The revised artifact was checked with a dedicated validator:

```text
filename: /mnt/data/validate_cb_forensic_artifact_v2.py
invocation: python /mnt/data/validate_cb_forensic_artifact_v2.py
input: /mnt/data/ContinuityBrain_Forensic_Contract_Audit_v2.md
checks: 103 classified ledger entries; required fields; controlled classifications; expected counts; excluded records absent from ledger and present in context; revision history present
```

A local clone was attempted only to obtain immutable local blobs; it failed before any repository data was downloaded:

```text
git clone https://github.com/mdunham726-coder/Game-main.git /mnt/data/Game-main-research
fatal: unable to access 'https://github.com/mdunham726-coder/Game-main.git/': Could not resolve host: github.com
```

All source claims were then derived from preserved GitHub connector responses and explicit file-range retrieval.

### 11.2 Tool-discovery and repository/commit discovery calls

```text
api_tool.read_resource("skills://plugins/github/github/skill.md", start_line=1, num_lines=240)
api_tool.list_resources(paths=["GitHub"], query="repository")
api_tool.list_resources(paths=["GitHub"], query="fetch_file")
api_tool.list_resources(paths=["GitHub"], query="search")
GitHub.list_repositories({"page_size":20,"page_offset":0})
GitHub.search_commits({"query":"gate patch","repository_full_name":"mdunham726-coder/Game-main","topn":20})
GitHub.fetch_commit(repo="mdunham726-coder/Game-main", sha="b9c0da3")
GitHub.fetch_commit(repo="mdunham726-coder/Game-main", sha="452966ce")
GitHub.fetch_commit(repo="mdunham726-coder/Game-main", sha="11dfc714")
GitHub.fetch_commit(repo="mdunham726-coder/Game-main", sha="3adca04")
GitHub.compare_commits(repo="mdunham726-coder/Game-main", base="b9c0da3", head="452966ce")
GitHub.compare_commits(repo="mdunham726-coder/Game-main", base="452966ce", head="b9c0da3")
```

### 11.3 Primary file retrieval calls

Each range below was a separate `GitHub.fetch_file` call with repository `mdunham726-coder/Game-main` and UTF-8 decoding.

```text
ContinuityBrain.js @ b9c0da3:
  1-42, 1-500, 221-440, 441-660, 661-880, 881-1100, 1101-1320, 1321-1540

ContinuityBrain.js @ 452966ce:
  1-14

ContinuityBrain.js @ 263fd944:
  1-14

index.js @ b9c0da3:
  1-7

index.js @ 452966ce:
  1-32, 1100-1360, 3760-4010, 4000-4240, 4140-4280, 4241-4510, 7000-7020

ContinuityBrain.js @ 11dfc714:
  1-240, 241-480, 481-720, 721-960, 961-1200

ContinuityBrain.js @ 3adca04:
  1-240, 200-420, 421-660, 600-655, 640-880, 880-1120,
  1121-1360, 1361-1600, 1601-1840, 1841-1920, 1920-1945

index.js @ 3adca04:
  6200-6460, 6440-6750, 6740-6910, 6900-7160

package.json @ 3adca04:
  1-10

ContinuityBrain.js @ current main:
  1-10

package.json @ current main:
  1-8

SemanticNormalizer.js @ 3adca04:
  1-260, 500-760

authoritygate.js @ 3adca04:
  1-260
```

### 11.4 Targeted code searches

```text
GitHub.search(repository="mdunham726-coder/Game-main", query="ContinuityBrain.runPhaseB")
GitHub.search(repository="mdunham726-coder/Game-main", query="runPhaseB(")
GitHub.search(repository="mdunham726-coder/Game-main", query="visible_objects_count")
GitHub.search(repository="mdunham726-coder/Game-main", query="visible_objects")
GitHub.search(repository="mdunham726-coder/Game-main", query="starting_npc")
GitHub.search(repository="mdunham726-coder/Game-main", query="normalizeExtractionEvents")
GitHub.search(repository="mdunham726-coder/Game-main", query="DECLARED ABILITIES RULE")
GitHub.search(repository="mdunham726-coder/Game-main", query="player.identity")
GitHub.search(repository="mdunham726-coder/Game-main", query="_lastIdentityTruthLine")
GitHub.search(repository="mdunham726-coder/Game-main", query="watch_message")
GitHub.search(repository="mdunham726-coder/Game-main", query="continuity_diagnostics")
```

### 11.5 Targeted commit searches

All used `repository_full_name="mdunham726-coder/Game-main"`, `topn=100`, `sort="committer-date"`, `order="asc"` unless noted.

```text
query="ContinuityBrain"
query="founding premise"
query="capabilities world_notes canonical_name title_or_role"
query="capabilities"
query="birth_record"
query="player identity"
query="visible_objects"
query="canonical_name"
query="world_notes"
query="fission_events"
query="extraction_events"
query="starting_npc"
query="BORN-NPC"
```

### 11.6 Preserved response inspection calls

The connector returned large commit payloads as response resources. These were inspected without fetching additional repository content:

```text
api_tool.read_resource("/response/turn20", start_line=250, num_lines=260)
api_tool.read_resource("/response/turn20", start_line=200, num_lines=80)
api_tool.find_in_resource("/response/turn4", "created_at")
api_tool.find_in_resource("/response/turn8", "created_at")
api_tool.find_in_resource("/response/turn9", "created_at")
```

### 11.7 Output location

```text
/mnt/data/ContinuityBrain_Forensic_Contract_Audit.md      # preserved v1
/mnt/data/ContinuityBrain_Forensic_Contract_Audit_v2.md   # revised artifact
```

### 11.8 Artifact assembly and validation commands

```text
wc -l /mnt/data/ContinuityBrain_Forensic_Contract_Audit.md
sed -n '1,120p' /mnt/data/ContinuityBrain_Forensic_Contract_Audit.md
tail -80 /mnt/data/ContinuityBrain_Forensic_Contract_Audit.md
python /mnt/data/generate_cb_forensic_artifact.py
python /mnt/data/validate_cb_forensic_artifact.py
python /mnt/data/revise_cb_forensic_artifact_v2.py
python /mnt/data/validate_cb_forensic_artifact_v2.py
sha256sum /mnt/data/ContinuityBrain_Forensic_Contract_Audit.md /mnt/data/ContinuityBrain_Forensic_Contract_Audit_v2.md
```

Version 1 validation result:

```text
{'ledger_entries': 118, 'missing_required_fields': []}
```

Version 2 validation target/result:

```text
{'ledger_entries': 103, 'classification_counts': {'Preserved': 48, 'Restored': 9, 'Partially restored': 10, 'Incomplete hybrid': 8, 'Superseded': 11, 'Accidentally missing': 9, 'Dormant downstream capability': 6, 'Unresolved': 2}, 'missing_required_fields': {}, 'context_records': 16, 'revision_history': True}
```

## 12. Final forensic conclusion
The intact CB was not merely a longer prompt. It was a coupled set of source-precedence rules, schemas, promotion code, wrapper aliases, continuity rendering, and consumer expectations. The May 16 recovery preserved the module’s skeleton while removing a substantial portion of that coupled contract surface.

Current `main` is neither a restoration of the intact file nor a simple degraded descendant. It is a mixed system:

- core entity/environment/mood/condition continuity is largely preserved;
- held/worn entity semantics, output caps, L0 NPC continuity, fission successors, and Turn-1 object materialization were restored or rebuilt to differing degrees;
- strict player founding identity, capability, world-note, and scenario-note authority remain smaller than the intact model;
- BORN-NPC, ORS, TSL witnesses, and TLS receipts provide major newer architecture that did not exist in the intact CB and therefore is not counted as separate historical contracts;
- several disconnected surfaces remain, most clearly `visible_objects`, capability consumption without a CB producer, direct player-worn exposure, and site-container support without direct candidate expression;
- current founding and fission systems remain hybrids because historical outputs and newer ownership channels coexist.

The correct forensic reading is therefore contract-by-contract, not “old CB versus new CB.” Within the 103-entry manually derived historical ledger, some contracts survive byte-for-behavior; some were restored; some were replaced by evidenced architecture; some remain partial or hybrid; and a small but material set disappeared at the recovery boundary and still has no evidenced replacement. The ledger is comprehensive within the inspected evidence, but its completeness is not mechanically proven.

## 13. Revision history

### v1 — Initial forensic artifact — 2026-07-26
- **File:** `ContinuityBrain_Forensic_Contract_Audit.md`
- **SHA-256 before v2 revision:** `db27209626ad53c73a5e8f19bb91d5c606f9c7d581b60a3d895ca1e3c3c53db3`
- **Classified ledger total:** 118
- **Method:** Manual evidence encoding from the preserved GitHub connector retrievals; structural validation checked count and required fields.
- **Known limitation later corrected:** The classified denominator included modern-only capabilities, downstream consumer mechanics, and synthesis records alongside historical CB contracts.

### v2 — Adversarial inclusion and classification correction — 2026-07-26
- **File:** `ContinuityBrain_Forensic_Contract_Audit_v2.md`
- **Research expansion:** None. No new repository files, notes, plans, roadmaps, or broad commit history were inspected for this revision.
- **Classified ledger total:** 103
- **Non-counted context records preserved:** 16
- **Corrections applied:**
  - restricted the classified ledger to contracts present in the intact historical CB;
  - moved B15, B16, E14, E15, E24–E27, F17–F20, F23, F24, F29, and F30 to non-counted context;
  - split E08 into separate `player_worn` and `npc_worn` historical contracts;
  - reclassified A09 from **Partially restored** to **Accidentally missing**;
  - corrected the worn-container loss map and the Turn-1 retry language;
  - updated contradiction log, executive findings, final conclusion, and methodology claim;
  - replaced the unqualified completeness claim with “comprehensive manual contract census within the inspected evidence.”
- **Revised classification totals:** Preserved 48; Restored 9; Partially restored 10; Incomplete hybrid 8; Superseded 11; Accidentally missing 9; Dormant downstream capability 6; Unresolved 2.
- **Preserved correction script:** `/mnt/data/revise_cb_forensic_artifact_v2.py`
- **Preserved validator:** `/mnt/data/validate_cb_forensic_artifact_v2.py`
