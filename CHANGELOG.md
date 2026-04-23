# Changelog

---

## v1.70.0 — April 23, 2026
**Continuity Subsystem Redesign — ContinuityBrain**

- **New file:** `ContinuityBrain.js` — forensic extraction coprocessor replacing `NarrativeContinuity.js` extraction/freeze/build pipeline
- **Phase B:** `runPhaseB(frozenNarration, gameState)` — DeepSeek extraction per turn; promotes facts to entity-owned `attributes{}` records; appends `mood_snapshot` to `world.mood_history[]` (hard cap: 20)
- **Phase C:** `assembleContinuityPacket(gameState, turnContext)` — assembles TRUTH block (entity + location facts) followed by MOOD block (structured trajectory signals) for narrator injection
- **Data model:** `NPC.attributes{}`, `site.attributes{}`, `local_space.attributes{}`, `world.promotion_log[]`, `world.mood_history[]`
- **index.js:** 4 swap points — `CB.assembleContinuityPacket` replaces `NC.buildContinuityBlock`; `CB.runPhaseB` replaces `NC.runContinuityExtraction + NC.freezeContinuityState`; `CB.getLastRunDiagnostics` replaces `NC.getLastRunDiagnostics`
- `NarrativeContinuity.js` preserved (bypassed); scheduled for removal in Phase 5 cleanup

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
