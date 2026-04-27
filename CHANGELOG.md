# CHANGELOG

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
