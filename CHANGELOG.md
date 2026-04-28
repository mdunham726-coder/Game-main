# CHANGELOG

---

## v1.84.14 — Expand MB Narration Window (April 28, 2026)

**Mother Brain now sees the last 5 narrator outputs at up to 1200 characters each — was 2 turns / 400 chars.**

### index.js
- `buildDebugContext` LAST NARRATIONS section: `.slice(-2)` → `.slice(-5)`, `.slice(0, 400)` → `.slice(0, 1200)`. Fixes mid-sentence truncation of narrator output in the MB context snapshot.

### motherbrain.js (v2.8.28)
- LAST NARRATIONS bullet updated: "last 5 narrator outputs... up to 1200 characters; longer outputs truncated with …"

---

## v1.84.13 — State Claim Pre-RC Gate (April 28, 2026)

**Player possession/existence assertions are now intercepted before validation and RC, routing to freeform without treating the claim as true.**

### SemanticParser.js
- `state_claim` added to valid actions list with definition: player is asserting possession, existence, or identity with no concrete mechanical intent. Parser routing verdict only — not an engine action.

### index.js
- `[STATE-CLAIM]` pre-validation intercept: when `parseResult.intent.primaryAction.action === 'state_claim'`, engine intercepts before `validateAndQueueIntent`, sets `inputObj` to freeform via `mapActionToInput(userInput, 'FREEFORM')`, preserves `player_intent.action = 'state_claim'`, sets `debug.path = 'STATE_CLAIM_FREEFORM'`, and sets `_degradedToFreeform = true`. Validation is skipped entirely.
- RC skip block: `state_claim` added with `skipped_reason: 'state_claim'`. Comment distinguishes it from harmless-action skips (move/look/wait/enter/exit) — this is non-executable input, not a valid action that happens to not need RC.
- Mother Watch system prompt: RC rule updated — `skipped_reason:state_claim` = correct skip, not a fault.

### motherbrain.js (v2.8.27)
- `STATE CLAIM ROUTING` paragraph added: documents `state_claim` as routing verdict, `STATE_CLAIM_FREEFORM` debug path, RC skip with `skipped_reason:state_claim`, and no-instantiation guarantee. Instructs MB not to flag these signals as faults.

---

## v1.84.12 — RC Narrator Input Mirror + MB Full Visibility (April 27, 2026)

**Mother Brain now sees exactly what the narrator saw for every RC turn.**

### index.js
- `buildDebugContext`: added `=== REALITY CHECK (last turn) ===` section rendered from `turn_history.reality_check` and `turn_history.stage_times`. When `fired:false` — shows skipped_reason only. When `fired:true` — shows query, `raw_response` (verbatim DeepSeek output before any processing), `anchor_block` (exact text injected into narrator prompt), and stage timing (rc duration, narrator duration, order_confirmed).
- Mother Watch system prompt: RC skip list updated from `move/look/wait` to `move/look/wait/enter/exit` — Watch was incorrectly flagging enter/exit turns as missing RC faults.

### motherbrain.js (v2.8.26)
- REALITY CHECK paragraph updated: `turn_history` field set expanded from `{ fired, skipped_reason, query, result }` to full set including `raw_response` and `anchor_block`. `stage_times` fields documented. New `=== REALITY CHECK (last turn) ===` context section referenced with usage guidance.

---

## v1.84.11 — MB Absence Narration Classification Rule (April 27, 2026)

**Mother Brain no longer misclassifies correct absence narration as hallucination.**

### motherbrain.js (v2.8.25)
- Added `ABSENCE NARRATION` paragraph to the `CB WARNINGS` section of MB's SYSTEM_PROMPT. Defines the pattern: player references a nonexistent entity, narrator responds by narrating the absence ("no one is here", "nowhere to be seen"). No UNRESOLVED warning fires — ContinuityBrain had nothing to extract. This is correct closed-world behavior, not a fault.
- Rule: the authoritative hallucination signal remains UNRESOLVED. Narration prose alone is never sufficient to classify a fault.

---

## v1.84.10 — Continuity Packet NPC Absence Fix (April 27, 2026)

**Narrator no longer infers NPC presence from silence. Zero NPCs is now a positive engine assertion.**

### ContinuityBrain.js
- `assembleContinuityPacket`: when `visible.length === 0`, pushes `'NPCs at this location: none visible in engine state.'` into the TRUTH block. Previously the entity loop simply produced nothing when no NPCs were present — the narrator received silence and could fill the gap with invented characters. The explicit line makes the zero state authoritative.

---

## v1.84.9 — RC Advisory Mode + Enter/Exit Skip (April 27, 2026)

**Restores narrator authority. RC becomes guidance, not override.**

### index.js
- Injected anchor block header changed: `ADJUDICATED REALITY [FINAL AUTHORITY]:` → `Possible consequences of the player's action (advisory):`. "Possible" frames the entire block as conditional before the narrator reads the content.
- Injected instruction changed: `Render this turn consistent with the above adjudicated consequence. This is what actually happens...` → `Use these as guidance when narrating the outcome. Select, adapt, or ignore as appropriate. Honor the current scene, engine state, and system prompt.`
- Added `enter` and `exit` to RC skip conditions (alongside `move`, `look`, `wait`). Structural/spatial transitions are handled by engine state, not consequence modeling. `skipped_reason: 'enter'` / `skipped_reason: 'exit'` emitted on skip.

### motherbrain.js (v2.8.23)
- REALITY CHECK paragraph updated: skip list now includes `enter`/`exit`; "ADJUDICATED REALITY [FINAL AUTHORITY]" and "narrator renders from it" removed; replaced with advisory framing (narrator uses as guidance, selects/adapts/ignores, retains scene authority).
- Version history entry `v2.8.23` added.

---

## v1.84.8 — cbpanel Player Slot Fix (April 27, 2026)

**Player entity was counted in Tab cycling but never rendered. Now renders correctly.**

### cbpanel.js
- Added player as first entry in `allEntities` in `renderEntityView()`. Uses `d.player_attributes` (already returned by `/diagnostics/continuity`). Slot key `__player__`, label `YOU`, section header `YOU (PLAYER)`. Renders the same CB-promoted attributes table as NPC slots.
- Removed manual `hasPlayer` boolean in Tab handler. `total` now counts `playerAt ? 1 : 0` (matching `renderEntityView` exactly), eliminating the off-by-one that caused the phantom index.
- Tab cycle order: YOU → NPCs → location (site).

---

## v1.84.7 — Diagnostic Polish (April 27, 2026)

**Two targeted diagnostic fixes. No changes to pipeline logic or game behavior.**

### index.js
- Fixed `_location_check` false alarm in `/diagnostics/npc`: the `POSITION MISMATCH` check was comparing `npc.position.mx/my` against `gs.world.position` (the world root anchor, set at startup) instead of `playerPos` (the player's live position). Changed both sides of the comparison to use `playerPos.mx/my`. `playerPos` is already declared in scope and guarded in the outer condition.

### npcpanel.js
- Suppressed automatic screen redraw when in detail view: both the 5-second poll callback and the SSE turn callback now guard `render()` with `if (_screen !== 'detail')`. Data continues to refresh silently in the background. Pressing `[r]` in detail view still forces an immediate fetch and redraw. Prevents the panel from scrolling back to the top while the user is reading NPC attributes.

---

## v1.84.6 — NPC Panel Access + Continuity Turn Index Fix + Snapshot Cleanup (April 27, 2026)

**Accessibility, correctness, and log clarity. No changes to pipeline logic.**

### diagnostics.js
- Added `[N]` hotkey: spawns `npcpanel.js` in a new CMD window (matches existing pattern for `[B]` cbpanel, `[I]` sitelens, etc.).
- Updated footer to include `[N] npc` in the hotkey legend.

### ContinuityBrain.js
- Fixed T-0 labeling at source: changed `const turn = (gameState.turn_history || []).length` to `(gameState.turn_history || []).length + 1`. Phase B runs before the current turn is pushed to `turn_history`, so the previous formula stamped Turn 1 entries as `turn_set: 0`. Now stamps `turn_set: 1` on Turn 1, aligning with player-visible turn numbering. No display-layer offset applied — fix is at source.

### Index.html
- Fixed `order_confirmed` false alarm in `copyRealityCheckSnapshot()`: changed `st.rc_end < st.narrator_start` to `st.rc_end <= st.narrator_start`. Updated label to `YES -- rc_end <= narrator_start`.
- Removed `query` field from REALITY CHECK section of snapshot output. `fired`, `skipped_reason`, `result`, and `raw_response` are retained. Eliminates redundant DeepSeek prompt text now that query correctness has been verified.

---

## v1.84.5 — Reality Check Observability + Turn 1 Fix (April 27, 2026)

**Correctness fix + full pipeline observability for the Reality Check system.**

### index.js
- Fixed Turn 1 Reality Check skip: changed `if (isFirstTurn)` to `if (turnNumber === 1)`. `isFirstTurn` is set to `false` at L927 during world-gen, hundreds of lines before the RC block, so the skip guard was never firing on genuine Turn 1.
- Added `_rcRawResponse` capture: the verbatim string from `_rcResp?.data?.choices?.[0]?.message?.content` (before `.trim()`) stored immediately after the RC DeepSeek await returns. `_realityAnchor` (trimmed) is derived from it, not the reverse.
- Added `_rcStart` / `_rcEnd`: `Date.now()` set immediately before/after the RC `await`. Both remain `null` on skipped turns — no misleading zero-delta timestamps.
- Added `_narratorStart` / `_narratorEnd`: `Date.now()` set immediately before/after the narrator `await` (both call paths: first attempt and ECONNRESET retry).
- Extended `reality_check` in `turnObject`: added `raw_response: _rcRawResponse || null`.
- Added `stage_times` to `turnObject`: `{ rc_start, rc_end, narrator_start, narrator_end }` — all four initialized as `null`, only overwritten on actual execution.

### Index.html
- Updated `copyRealityCheckSnapshot()`: added `RAW DEEPSEEK RESPONSE (verbatim)` section (verbatim DS content, or `(skipped -- RC did not fire)`); added `STAGE TIMES` section with all four timestamps, derived `rc_duration_ms`, `narrator_duration_ms`, and `order_confirmed` field (`YES -- rc_end < narrator_start` / `NO -- ORDER VIOLATION DETECTED` / `(n/a -- RC skipped or data absent)`).

---

## v1.84.4 — diagnostics TDZ + L1 Start Site Fill (April 27, 2026)

**Crash fix: L1-start games no longer fail on turn 1.**

### index.js
- Removed `diagnostics` from 5 early error `res.json()` returns in `[L2-START-SITE-FILL]` (~L1171, L1182, L1205) and `[NARRATION-GATE]` (~L2251, L2259) — `const diagnostics` is declared at L1832, referencing it in earlier return paths caused a TDZ crash (`Cannot access 'diagnostics' before initialization`) that swallowed the actual error and surfaced as `[NARRATE] Error`.
- Added `[L1-START-SITE-FILL]` block immediately after `[L2-START-SITE-FILL]`, before `[START-CONTAINER]`. Fires when `start_container === 'L1'` and `_startSlot` has any null field (name/description/identity). Mirrors `[L2-START-SITE-FILL]` exactly: same DeepSeek call (temperature 0.4, timeout 30000), 3-field all-or-nothing requirement, canonical slot write + `is_filled` flip + `world.sites` mirror, hard-fail on any error. Fixes: `[START-CONTAINER]` was calling `Engine.enterSite()` before any fill ran, setting `active_site` and bumping `_sfDepth` to 2 — causing `[SITE-FILL]`'s `_sfDepth === 1` guard to skip the slot, leaving it unfilled, causing `[NARRATION-GATE]` to hard-block every L1 turn 1.

---

## v1.84.3 — Turn Snapshot Log (April 27, 2026)

**QA pipeline trace tool added to flight recorder.**

### index.js
- Added `anchor_block: _realityAnchorBlock || null` to the `reality_check` field in `turnObject` — the exact ADJUDICATED REALITY injected block is now frozen verbatim in `turn_history` per turn, available for offline pipeline tracing.

### Index.html
- Added `copyRealityCheckSnapshot()` function — walks all turns in `lastGameResponse.turn_history` and builds a full pipeline trace per turn:
  - `INPUT` — raw_input + parsed_action
  - `REALITY CHECK` — fired / skipped_reason / query / result
  - `REALITY ANCHOR (INJECTED BLOCK)` — verbatim anchor text or `(skipped -- no anchor)`
  - `NARRATOR OUTPUT` — full narrative text
  - POST-ARBITER labeled as async / not in synchronous snapshot
- Added "Copy Reality Check Snapshot" button (red) to the flight recorder panel (logsPanel), below "Copy Story" — copies full trace to clipboard and shows confirmation in logsResponse for 3 seconds.

---

## v1.84.2 — Arbiter Phase 0 / Pre-narration Reality Check (April 26, 2026)

**Arbiter's primary function (reality adjudication) implemented.**

### index.js
- Blocking awaited DeepSeek call fires before narration on all non-skip turns.
- Player input → adjudicated consequence frozen as `ADJUDICATED REALITY [FINAL AUTHORITY]` block in narrator prompt.
- Narrator renders from adjudicated reality rather than inferring outcome.
- Hard failure on DS error: `REALITY_CHECK_FAILED` — narrator never called, turn halts entirely, no turn record written.
- Query suffix verbatim: `'Focus on immediate physical, social, and legal consequences. be accurate, but concise and brief. distill the answer to the essence of the event.'`
- Skip conditions: Turn 1, move, look, wait.
- SAY turns include target NPC job role in query.
- `reality_check` field frozen in `turnObject`: fired / skipped_reason / query / result.
- SSE `type: 'reality_check'` emitted with all fields.
- Watch scan REALITY CHECK section added.

### motherbrain.js (v2.8.22)
- REALITY CHECK paragraph added documenting Arbiter Phase 0.
- Version history entry added.

---

## v1.84.1 — NPC Naming Pipeline Hardening (April 26, 2026)

**Narrator NPC name rules replaced; dead code removed; pipeline guards hardened.**

### index.js
- Narrator NPC name rule replaced: `npc_name:null` means player has not yet learned the name (context stripping by design) — narrator must not invent names or emit `[npc_updates:]` blocks.
- Phase 5F `[npc_updates:]` extraction block removed (dead code — freeze-guard was blocking all writes; NPC-FILL owns identity, Arbiter owns `is_learned`).
- NPC-FILL age validation hardened: `Number.isFinite()` guard catches non-numeric string ages (NaN was silently frozen).
- Arbiter narration slice raised from 1200 chars to full narration (name introductions at end of long turns no longer missed by Arbiter).
- Watch scan system prompt updated: ARBITER section expanded with `is_learned_changes` fault/warn/normal classification; NPC FILL PIPELINE section added.

### motherbrain.js (v2.8.21)
- ARBITER paragraph expanded with `is_learned` responsibilities and `arbiter_verdict.is_learned_changes` fields.
- NPC FILL PIPELINE paragraph added.

---

## v1.84.0 — Game Constitution Integration (April 26, 2026)

**Full game constitution prepended to all three AI system prompts.**

### index.js
- World founding rule + post-founding lock rule + player freedom rule + consequence rule prepended verbatim to Narrator, Mother Brain, and Mother Watch system prompts.
- Constitution is the highest-level rule set, appears first in all three prompts for cache efficiency.
- No existing prompt content removed.
- Narrator BIRTH RECORD bridging note added.
- Watch STATE DECLARATIONS rule added.
- Brain STATE DECLARATION CHANNEL paragraph added.

### motherbrain.js (v2.8.19)
- Version history entry added.

---

## Prior History

See the Development Status header in `ULTIMATE_DUNGEON_MASTER_GAME_DOCUMENTATION.md` for full version history prior to v1.84.0.
