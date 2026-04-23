# Changelog

---

## v1.71.0 — April 23, 2026
**cbpanel.js + Mother Brain Context Completion**

- **New file:** `cbpanel.js` — live SSE terminal panel with 4 interactive views: Turn View, Promotion Log, Entity View, Explain This
- **Turn View:** source narration (labeled `Narrator output (T-N)`), extraction candidates (all 4 buckets + inline rejections), UNRESOLVED/FUZZY warnings, per-turn promotion results
- **Promotion Log:** full `promotion_log_recent` (20 entries) in chronological stream
- **Entity View:** all visible NPCs + site with `bucket | value | T-N` per attribute; `[Tab]` cycles entities
- **Explain This:** assembles last turn context and calls DeepSeek directly (ECONNRESET retry); renders explanation in panel
- **`diagnostics.js`:** `[B]` hotkey spawns `cbpanel.js`; footer updated to include `[B] cb panel`
- **`index.js` `buildDebugContext()`:** added `=== LAST NARRATIONS ===` (last 2, labeled `Narrator output (T-N):`); per-entity rejected_interpretations now inline strings (up to 3); entity attribute format `bucket:value (T-N)` with temporal tag; location attributes same; `RECENT PROMOTIONS` depth 5 → 10
- **`motherbrain.js` v2.0.0:** system prompt updated — `LAST NARRATIONS` section named in `TOOLS AND DATA ACCESS`; tone adjusted to interpretive/aware (not robotic, not expressive); `CAPABILITIES` updated with continuity gaps bullet; `OUTPUT STYLE` section added

---

## v1.70.0 — April 23, 2026
**Continuity Subsystem Redesign — ContinuityBrain**

- **New file:** `ContinuityBrain.js` — forensic extraction coprocessor replacing `NarrativeContinuity.js` extraction/freeze/build pipeline
- **Phase B:** `runPhaseB(frozenNarration, gameState)` — DeepSeek extraction per turn; promotes facts to entity-owned `attributes{}` records; appends `mood_snapshot` to `world.mood_history[]` (hard cap: 20)
- **Phase C:** `assembleContinuityPacket(gameState, turnContext)` — assembles TRUTH block (entity + location facts) followed by MOOD block (structured trajectory signals) for narrator injection
- **Data model:** `NPC.attributes{}`, `site.attributes{}`, `local_space.attributes{}`, `world.promotion_log[]`, `world.mood_history[]`
- **index.js:** 4 swap points — `CB.assembleContinuityPacket` replaces `NC.buildContinuityBlock`; `CB.runPhaseB` replaces `NC.runContinuityExtraction + NC.freezeContinuityState`; `CB.getLastRunDiagnostics` replaces `NC.getLastRunDiagnostics`
- `NarrativeContinuity.js` preserved (bypassed); scheduled for removal in Phase 6 cleanup
- **Phase 4 observability:** `/diagnostics/continuity` endpoint replaced with CB-native fields (`extraction_packet`, `cb_diagnostics`, `visible_npc_attributes`, `site_attributes`, `mood_history`, `promotion_log_recent`); `buildDebugContext()` updated with `ENTITY ATTRIBUTES`, `RECENT PROMOTIONS`, `MOOD TRAJECTORY`, `CB EXTRACTION`, `CB WARNINGS` sections; `summary.js` converted to live SSE panel; `continuity.js` rewritten as CB Extraction + Promotion View (9 sections); `dmletter.js` rewritten as Mood Pipeline Debug View (trajectory-primary, 3 sections); `diagnostics.js` footer labels updated
- **`motherbrain.js` v1.0.5:** SSE reconnect guard (`_sseReconnectPending` flag) prevents exponential listener accumulation on socket drop

---

## v1.67.0 — May 2026
**Logging Panel + DM Letter Window**

- `logging.js` — live SSE turn-by-turn log panel; all `narration_debug` fields; `[R]` range, `[C]` copy all, `[X]` copy range
- `dmletter.js` — one-shot DM note inspector; `--turns N` archive depth; `dm_note_archived` from turn_history
- `index.js` — `GET /diagnostics/log` endpoint with `?from=N&to=M` range filter
- `diagnostics.js` — `[L]` and `[D]` hotkeys; footer updated

---

## v1.62.1 — April 20, 2026
**Movement Fix + Narrative Memory Persistence Bug Triage**

- `index.js` — `_parsedAction` / `_actionType` source fixed from impossible `engineOutput?.actions?.action` path to `inputObj?.player_intent?.action`; legacy fallback path now stamps `.action`
- `NarrativeContinuity.js` — `checkEviction` archive label `'Overworld (L1)'` → `'Overworld (L0)'`; `buildContinuityBlock` log expanded with memory count

---

## v1.62.0 — April 20, 2026
**Movement Direction Fix + Narrative Memory Persistence**

- `index.js` — `_movementDisplayInput` map translates bare direction shorthands (`s` → `south`) for narration blocks
- `NarrativeContinuity.js` — archive-before-null eviction; `narrative_memory[]` with provenance; `buildContinuityBlock` renders `[PRIOR LOCATION MEMORY]` section

---

## v1.61.0 — April 20, 2026
**Narration Diagnostics Enhancement**

- `Index.html` — diagnostics monitor with VIOLATION/NOTICE checks; 5-pill flag matrix; narration pipeline section with routing row, movement resolution, continuity throughput

---

## v1.60.0 — April 20, 2026
**Copy Story Chronological Fix**

- `Index.html` — removed `.reverse()` from `copyStory()`; transcript now T1 → TN in play order

---

## v1.59.1 — April 20, 2026
**Body Size + Player Input Fixes**

- `index.js` — `express.json` body limit raised to `10mb`
- `Index.html` — `copyStory()` includes player input lines

---

## v1.59.0 — April 20, 2026
**Spatial Authority Enforcement + Session Persistence**

- `index.js` — `_engineSpatialBlock` 3-layer spatial authority enforcement; session autosave/restore on server restart

---

## Mother Brain

| Version | Date | Notes |
|---|---|---|
| v1.0.4 | April 23, 2026 | Paste debounce (60ms burst buffer); `/copy` command copies last exchange to clipboard |
| v1.0.3 | April 23, 2026 | Fix MaxListeners warning — bootstrap retry loop aborts when SSE sets session ID |
| v1.0.2 | April 23, 2026 | Phosphor green + deep red colors; backspace fix; session bootstrap + context pre-warm |
| v1.0.1 | April 22, 2026 | Always awake — responds before first game turn, no session gate |
| v1.0.0 | April 22, 2026 | Initial release — intelligent terminal coprocessor |
