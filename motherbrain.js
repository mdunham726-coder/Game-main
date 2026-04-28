/**
 * motherbrain.js — Mother Brain v2.5.0
 * Intelligent terminal coprocessor for the Dungeon Master game engine.
 * Monitors engine state via SSE, maintains a rolling conversation with DeepSeek,
 * and provides authoritative real-time analysis to the developer.
 *
 * Launch via: StartMotherBrain.bat (sets DEEPSEEK_API_KEY before starting)
 */

'use strict';

const http     = require('http');
const readline = require('readline');
const axios    = require('axios');
const { spawn } = require('child_process');

// ── Mother Brain version (independent of game engine version) ─────────────────
const MB_VERSION = '2.8.28';

const MB_VERSION_HISTORY = [
  { version: '2.8.28', date: 'April 28, 2026', note: 'Expand LAST NARRATIONS window (v1.84.14): buildDebugContext LAST NARRATIONS section raised from last 2 turns / 400 chars to last 5 turns / 1200 chars per narration. Fixes mid-sentence truncation of narrator output visible to Mother Brain. MB SYSTEM_PROMPT LAST NARRATIONS bullet updated. Package v1.84.14.' },
  { version: '2.8.27', date: 'April 28, 2026', note: 'State claim pre-RC gate (v1.84.13): state_claim added to SemanticParser valid actions as a parser routing verdict (not an engine action). index.js intercepts state_claim BEFORE validateAndQueueIntent — sets inputObj to freeform, preserves player_intent.action = state_claim, sets debug.path = STATE_CLAIM_FREEFORM, skips validation entirely. RC skip block reads _parsedAction === state_claim and sets skipped_reason: state_claim (distinct from harmless-action skips — signals non-executable input). _freeformBlock fires via existing FREEFORM kind path. MB STATE DECLARATION CHANNEL paragraph updated. Watch scan REALITY CHECK rule updated: skipped_reason:state_claim is correct skip, not a fault. Package v1.84.13.' },
  { version: '2.8.26', date: 'April 27, 2026', note: 'RC narrator input mirror (v1.84.12): buildDebugContext now renders === REALITY CHECK (last turn) === section showing fired, skipped_reason, query, raw_response (verbatim DS output), anchor_block (exact text injected into narrator prompt), and stage_times (rc/narrator durations + order_confirmed). MB SYSTEM_PROMPT REALITY CHECK paragraph updated: full turn_history field set documented (raw_response, anchor_block added), stage_times documented, new context section referenced. Mother Watch RC skip list corrected: enter/exit added alongside move/look/wait. Package v1.84.12.' },
  { version: '2.8.25', date: 'April 27, 2026', note: 'Absence narration classification rule (v1.84.11): added ABSENCE NARRATION paragraph to CB WARNINGS section of SYSTEM_PROMPT. Teaches MB to distinguish correct closed-world absence narration (player references nonexistent entity, narrator says no one is here) from hallucination (UNRESOLVED warning, entity introduced as present without NPC registry match). No UNRESOLVED fires on absence narration — ContinuityBrain had nothing to extract. Prose alone is never sufficient to classify a fault. Package v1.84.11.' },
  { version: '2.8.24', date: 'April 27, 2026', note: 'Continuity packet NPC absence fix (v1.84.10): assembleContinuityPacket now emits explicit line "NPCs at this location: none visible in engine state." into the TRUTH block when visible NPC list is empty. Previously absence was implied by omission, allowing narrator to fill the gap. Fix makes the authoritative zero state a positive assertion. ContinuityBrain.js only — no narrator prompt changes.' },
  { version: '2.8.23', date: 'April 27, 2026', note: 'RC Advisory Mode (v1.84.9): Reality Check demoted from FINAL AUTHORITY to advisory. Injected block header changed from ADJUDICATED REALITY [FINAL AUTHORITY] to "Possible consequences of the player action (advisory):". Narrator instruction changed from "Render this turn consistent with..." to "Use these as guidance... Select, adapt, or ignore as appropriate. Honor the current scene, engine state, and system prompt." Narrator retains full scene authority -- RC output is guidance only, not override. Skip conditions extended: enter and exit added alongside move/look/wait. SYSTEM_PROMPT REALITY CHECK paragraph updated. Package v1.84.9.' },
  { version: '2.8.22', date: 'April 26, 2026', note: 'Arbiter Phase 0 — Reality Check (v1.84.2): pre-narration blocking DS call adjudicates real-world consequence of player intent before narrator runs. Query suffix verbatim: "Focus on immediate physical, social, and legal consequences. be accurate, but concise and brief. distill the answer to the essence of the event." Result frozen as reality_check.result in turn_history and injected as ADJUDICATED REALITY [FINAL AUTHORITY] block at end of narrationContent. Fires on all non-skip turns (skip: Turn 1, move, look, wait). SAY turns include target NPC job role in query. Hard failure on DS error — turn halts with REALITY_CHECK_FAILED, narrator never called. Emits reality_check SSE diagnostic every turn. SYSTEM_PROMPT REALITY CHECK paragraph added. Watch scan REALITY CHECK section added. Package v1.84.2.' },
  { version: '2.8.21', date: 'April 26, 2026', note: 'NPC naming pipeline clarification (v1.84.1): narrator NPC name rule replaced — npc_name:null now means player has not learned the name (context stripping), never that the NPC has no name; narrator must not invent names or emit [npc_updates:] blocks. Phase 5F [npc_updates:] extraction removed from index.js (dead code — NPC-FILL owns identity assignment, Arbiter owns is_learned). NPC-FILL age validation hardened: Number.isFinite guard catches non-numeric string ages that would produce NaN (was silently written as frozen). Arbiter narration slice raised from 1200 chars to full narration (name introductions at end of long turns no longer missed). SYSTEM_PROMPT ARBITER paragraph expanded with is_learned responsibilities and arbiter_verdict is_learned_changes fields. NPC FILL PIPELINE paragraph added. Watch scan system prompt updated: ARBITER section expanded with is_learned_changes fault/warn/normal classification; NPC FILL PIPELINE section added (_fill_error/pending/_fill_frozen state rules; context stripping rule).' },
  { version: '2.8.20', date: 'April 27, 2026', note: 'Arbiter MVP (v1.84.0): Arbiter IIFE fires async after every narration freeze and emits arbiter_verdict SSE event. Sole v1.84.0 responsibility: NPC reputation (reputation_player, 0-100, 50=neutral). Arbiter writes deltas to live NPC objects in site.npcs via direct mutation (not copy). Always emits arbiter_verdict even on no-op turns. Arbiter paragraph added to SYSTEM_PROMPT. Watch fault rules updated: missing arbiter_verdict = fault, reputation_player out of 0-100 = fault, arbiter error field = fault. Flight recorder rows show arb: summary. MB listens for arbiter_verdict SSE and updates matching turn buffer entry.' },
  { version: '2.8.19', date: 'April 26, 2026', note: 'Game Constitution integration (v1.84.0): Full constitution prepended verbatim to Narrator, Mother Brain, and Mother Watch system prompts — world founding rule (Turn 1 = founding premise, unrestricted), post-founding lock rule (Turn N = validate against engine state), player freedom rule (attempt always allowed, outcome never guaranteed), consequence rule (reality enforced through simulation not restriction). BIRTH RECORD bridging note added to Narrator prompt. STATE DECLARATION CHANNEL paragraph added: state_declare = valid parser action, state_declared = valid action_resolution, player.attributes source:declared = expected, birth_record field = expected founding data. Prompt ordering: constitution first, stable role instructions next, dynamic turn content last (cache efficiency).' },
  { version: '2.8.18', date: 'April 26, 2026', note: 'LS fill key-mismatch fix + hallucination classification (v1.83.5): [LS-FILL-ACTIVE] root cause confirmed — active_local_space.local_space_id is the full composite ID (e.g. site123_ls_0) but active_site.local_spaces is keyed by short ID (ls_0); lookup returned undefined, block logged error and silently continued. Fix: derive short key by stripping site ID prefix; fallback to full ID as-is + warning for legacy/edge cases — never skip fill. Post-write guard added: if stub still incomplete after write loop, block with error:ls_fill_active_failed / fill_incomplete. [LOCAL-SPACE-GATE] added after [NARRATION-GATE] — depth-3 structural safety net (layered protection, not duplicate: LS-FILL-ACTIVE = pipeline failure, LOCAL-SPACE-GATE = safety net; different error codes local_space_incomplete). CB WARNINGS bullet upgraded: UNRESOLVED now classified as fault AND candidate narrator hallucination — entity extracted from narration but not matched to any visible NPC. UNRESOLVED signal alone is sufficient trigger; narration text for entity identification only. Watch scan system prompt CB WARNINGS rule updated with same classification.' },
  { version: '2.8.17', date: 'April 26, 2026', note: 'Brain/Watch v1.83.4 pipeline awareness: slot_identity exposed in all diagnostic surfaces — /diagnostics/sites cell_slots now include identity field; buildDebugContext SITE INTERIOR STATE line format updated to site_id | name | slot_identity:VAL | enterable:YES/NO | filled:YES/NO | interior:STATE. is_filled now requires all three fields (name + description + slot_identity). Watch scan system prompt updated: slot_identity label throughout, IS_FILLED RULE section, FILL PIPELINE section ([L2-START-SITE-FILL] + [SITE-FILL] + [LS-FILL-ACTIVE] error codes), NARRATION GATE section (site_incomplete/site_state_integrity_failure), B3 REMOVAL section. Brain SYSTEM_PROMPT updated: SITE INTERIOR STATE bullet updated with slot_identity format, bridging sentence, 3-field is_filled rule; /diagnostics/sites cell_sites field list adds identity; new FILL PIPELINE + NARRATION GATE + B3 REMOVAL paragraphs. motherwatch.js RED color extended with fill_failed/integrity_failure/resolution_failed.' },
  { version: '2.8.16', date: 'April 25, 2026', note: 'Mother Watch analytical parity (v1.83.3): Watch system prompt upgraded to full inline diagnostic rule set — fault rules for all 6 SITE INTERIOR STATE codes, active local space unfilled while inside, site identity partial fill, CB WARNING classification (UNRESOLVED=fault/FUZZY=verify/L0-SKIP=expected), L0 empty TRUTH behavior, NARRATOR FAILURES, ACTION RESOLUTION fault vs normal codes, closed-world non-fault rule. max_tokens 600→1500, temperature 0.1→0.3, user message includes framing prefix. SYSTEM_PROMPT: explicit fault rules added to SITE INTERIOR STATE and active local space sections; MOTHER WATCH paragraph updated — no cap, same diagnostic standards as Brain. motherwatch.js color rules updated.' },
  { version: '2.8.15', date: 'April 25, 2026', note: 'L2 direct-start fill fix (v1.83.2): [LS-FILL-ACTIVE] block added to index.js pre-narration pipeline. Fires at depth 3 when active_local_space and active_site exist and active stub is unfilled (name===null||description===null). Pre-call validation: missing local_space_id logs WARNING and skips; missing stub logs ERROR and skips (no silent patch). Reference mismatch between active_local_space and stub._generated_interior logs WARNING but continues. Write order: canonical stub first, then mirror to _generated_interior (same reference as active_local_space), then is_filled on both. Failure blocks narration with fillLog entry (same pattern as LS-FILL). Cell Subtype removed from buildDebugContext CURRENT LOCATION block — field is always empty string, never functional, produced misleading unknown diagnostic noise.' },
  { version: '2.8.14', date: 'April 25, 2026', note: 'Token + cost tracking (v1.83.0): per-call usage extraction from DeepSeek response (prompt_tokens, completion_tokens, total_tokens, prompt_cache_hit_tokens, prompt_cache_miss_tokens). Cache-aware cost formula (hit × $0.000000028 + miss × $0.00000014 + out × $0.00000028), falls back to all-miss when cache breakdown absent. _mbSession accumulator (calls, prompt_tokens, completion_tokens, total_tokens, cache_hit_tokens, est_cost_usd). _mbCallHistory rolling buffer (last 5 calls). One-time console.log of raw usage shape on first call. Stats block printed inline after each Q&A response: this call (tok + cache % + cost), session totals, history depth estimate, recent 5-call token trend. Compact [MB] stats line appended after every printTurnStatus() auto-refresh (visible without typing). /stats command: full session breakdown with per-call history table and history depth.' },
  { version: '2.8.13', date: 'April 25, 2026', note: 'Sites & Localspaces Monitor (v1.82.0): new /diagnostics/sites endpoint exposes structured site/localspace state for Mother Brain and sitelens.js panel. Returns depth, cell_key, cell_sites (per-slot: site_id, name, description, is_filled, enterable, interior_key, interior_state, grid_w, grid_h, npc_count), active_site (with local_spaces array), active_local_space, and fill_log (session-scoped ring buffer of fill failures, max 10). interior_state uses shared _getSiteInteriorState() helper (same 6-code enum as SITE INTERIOR STATE in buildDebugContext). fill_log entries written on SITE-FILL and LS-FILL parse/api failures only. Mother Brain TOOLS AND DATA ACCESS updated with /diagnostics/sites as third callable source (on-demand, not auto-fetched per turn).' },
  { version: '2.8.12', date: 'April 25, 2026', note: 'Fill pipeline rewrite (v1.82.0): independent pre-narration DS fill replaces Phase 5E opportunistic fill. [SITE-FILL] block fires when active site name or description is null — dedicated DS call before narration context assembly; failure blocks narration. [LS-FILL] block same pattern for local spaces at depth 2. Per-field write protection: only writes when currently null (retry-safe). is_filled flips only when both name and description are non-null. Phase 5E infrastructure fully removed (_phase5Instruction, _hasFilled, _hasUnfilled, extraction block, _lastSiteCapture). Local space stubs redesigned: type/purpose/pre-assigned name removed; stub now carries name:null, description:null, is_filled:false. generateLocalSpace() return: type/purpose removed, parent_site_id/enterable/is_filled/name/description passed through from stub. Stale _narActiveLS.type narrator references cleaned.' },
  { version: '2.8.11', date: 'April 24, 2026', note: 'Fix L2 diagnostic dead NPC field (v1.81.3): active_local_space.npcs was always [] (hardcoded in WorldGen.generateLocalSpace, never populated). Diagnostic read this and reported NPC Records: 0 at L2, causing false three-surface contradiction triage. Fix: diagnostic now reports NPCs in space (npc_ids.length) and NPCs at your tile (visible count). Dead npcs field removed from generateLocalSpace return object. All functional NPC resolution at L2 uses active_site.npcs as registry — unaffected.' },
  { version: '2.8.10', date: 'April 24, 2026', note: 'NPC hallucination containment (v1.81.2): removed Population count from narrator site context block — telling narrator how many NPCs exist in the building while NPCs nearby was empty licensed the model to render off-screen persons. Replaced fragile multi-clause NPC constraint bullet with single existence rule: only persons in NPCs PRESENT exist anywhere in the scene. Pre-existing flaw uncovered by noise reduction from v1.81.0/v1.81.1.' },
  { version: '2.8.9', date: 'April 24, 2026', note: 'Fix is_stub NOT_GENERATED false diagnostic (v1.81.1): generateL2Site() return object never had is_stub field; diagnostic checked === false (strict) so always fell through to NOT_GENERATED. Fix: siteRecord.is_stub = false set in both Engine.js generation paths (stub-complete + fresh). Diagnostic check loosened from === false to !is_stub to also recover old saves. Invariant verified: is_stub: true set in exactly one place (Engine.js:293); WorldGen never creates stubs.' },
  { version: '2.8.8', date: 'April 24, 2026', note: 'Strip VISIBLE CELLS from Mother Watch scan context (v1.81.0): VISIBLE CELLS section removed from _wCtxScan before passing to watch DeepSeek call. Terrain subtype variation between neighboring local cells is normal engine behavior — the section produces persistent false positives in automated scan regardless of prompt-level suppression. Mother Brain chat context unchanged — full VISIBLE CELLS still present for human-requested analysis.' },
  { version: '2.8.7', date: 'April 24, 2026', note: 'Mother Watch scan mandate rewrite (v1.80.9): replaced broad contradiction-detection instruction with fault-only mandate. Reports only: thrown errors, failed API calls, missing records that should exist, null/undefined where required, schema violations, diagnostic surfaces that misrepresent authoritative state, or state preventing correct gameplay/narration/diagnostics/progression. Explicitly does not report apparent cross-section contradictions when both sides reflect normal engine behavior. Removes whack-a-mole VISIBLE CELLS exception — superseded by the principled mandate.' },
  { version: '2.8.6', date: 'April 24, 2026', note: 'VISIBLE CELLS chat squelch (v1.80.8): added instruction to SYSTEM_PROMPT VISIBLE CELLS bullet to not proactively analyze or comment on this section unless the user asks or a WARNING line is present. Rows are guaranteed valid — coordinate proximity analysis wastes response budget. Matches Mother Watch squelch added in v2.8.5.' },
  { version: '2.8.5', date: 'April 24, 2026', note: 'Mother Watch VISIBLE CELLS squelch (v1.80.7): added instruction to Mother Watch scan system prompt to skip VISIBLE CELLS section unless a WARNING line is present. Rows in that section are guaranteed valid — proximity and coordinate values are not diagnostic signals for the watch scan. Mother Brain chat context unchanged.' },
  { version: '2.8.4', date: 'April 24, 2026', note: 'VISIBLE CELLS player-cell exclusion (v1.80.6): player\'s own cell key excluded from VISIBLE CELLS sample (it is already shown in CURRENT AUTHORITATIVE PLAY SPACE). Header updated to "sample of up to 5 other local cells within this macro cell (player cell excluded)". Empty state message updated to "(No other loaded cells in current macro)" to prevent false-positive flag that no cells exist when player\'s cell is the only loaded one.' },
  { version: '2.8.3', date: 'April 24, 2026', note: 'VISIBLE CELLS display fix (v1.80.5): added macro-cell header line ("Macro cell (mx,my) — sample of up to 5 local cells within this macro cell:") to section output; row format changed from ambiguous [lx,ly] to canonical cell(mx,my:lx,ly) matching format used throughout diagnostic output. Fixes false-positive anomaly flags from Mother Watch/Mother Brain caused by coordinates appearing without macro-cell context. SYSTEM_PROMPT updated with VISIBLE CELLS bullet.' },
  { version: '2.8.2', date: 'April 24, 2026', note: 'SITE INTERIOR STATE fix (v1.80.4): rewrote diagnostic block to read cell.sites as an object dictionary via Object.values() instead of Array.isArray() guard. Uses inline site slot objects as primary source (site_id, name, enterable, is_filled). Interior state is one of 6 explicit codes: NOT_APPLICABLE (non-enterable), PENDING_FILL (enterable, not yet named by model), MISSING_INTERIOR_KEY (filled but interior_key absent — engine gap), MISSING_INTERIOR_RECORD (interior_key present but no world.sites mirror — registration failure), NOT_GENERATED (stub mirror exists, not entered), GENERATED (full mirror, is_stub===false). Array-shaped cell.sites emits explicit WARNING rather than silently normalizing. Fixes cross-surface contradiction where SITE INTERIOR STATE showed no sites while CURRENT CELL SITES listed them correctly.' },
  { version: '2.8.1', date: 'April 23, 2026', note: 'Coordinate system context fix (v1.80.2): COORDINATE SYSTEM block added to buildDebugContext() — states macro grid 8x8 (mx/my 0-7), local grid 128x128 per macro cell (lx/ly 0-127), position formats. Mother Watch system prompt updated with coordinate bounds to prevent false-positive anomaly flags. SYSTEM_PROMPT ACTION RESOLUTION section updated with coordinate ranges.' },
  { version: '2.8.0', date: 'April 23, 2026', note: 'Mother Watch full-context scan (v1.80.0): after every turn an async non-blocking DeepSeek call scans buildDebugContext(detailed) for bugs/errors/contradictions and emits watch_verdict SSE event (lines: string[]). motherwatch.js panel now listens for watch_verdict instead of turn and renders each finding color-coded. SYSTEM_PROMPT updated with MOTHER WATCH section documenting the parallel scan channel.' },
  { version: '2.7.1', date: 'April 27, 2026', note: 'Mother Watch Panel (v1.79.0): Phase B now optionally outputs watch_message — one-sentence system health judgment written by the model inside the existing DeepSeek extraction call (zero extra API calls). watch_message is not in REQUIRED_KEYS (never blocks Phase B); injected via MOTHER WATCH BRIEF context block appended to extraction prompt. watch_message emitted on SSE turn events; displayed in motherwatch.js terminal panel. ContinuityBrain v1.5.0. diagnostics.js [W] hotkey spawns watch panel.' },
  { version: '2.7.0', date: 'April 23, 2026', note: 'Deep Trace Visibility Layer (v1.78.0): 8 new diagnostic surfaces — (1) NARRATOR I/O full payload+raw response gated behind level=narrator_io; (2) always-on one-liner in NARRATOR PROMPT STRUCTURE (payload_messages|prompt_chars|continuity|spatial|base); (3) token breakdown (prompt/completion/total) and model cap annotation; (4) SPATIAL BLOCK (engine_spatial_notes passed to narrator); (5) SITE INTERIOR STATE (enterable/filled/interior per site at current cell); (6) WORLD MAP 5x5 ASCII grid (toroidal, [*]=player, [S]=site); (7) ACTION RESOLUTION (deterministic block_reason codes: NO_POSITION/NO_DIRECTION/ENGINE_GUARD/VOID_CELL/L2_BOUNDARY plus NO_RESOLVE_LOG flag); (8) RECENT PROMOTIONS DUP-SILENCED summary entries; ContinuityBrain v1.4.0: rejection reason now banned_pattern:X (named pattern); duplicate_silenced_summary aggregate per entity per turn replaces per-fact silent drops' },
  { version: '2.6.0', date: 'April 23, 2026', note: 'Option C truth architecture — TRUTH block stays strict (current cell only, empty at L0 during exploration is correct behavior); new CONTEXT — RECENT LOCATION block appended after MOOD shows canonically accepted env facts (post-filter, post-dedup, turn_set===current) from prior cell position; single-use (cleared after one assembly read); narrator gets env grounding without contaminating current-scene truth' },
  { version: '2.5.0', date: 'April 23, 2026', note: 'L0 continuity packet fix — ContinuityBrain.js v1.2.0: assembleContinuityPacket() now reads cell.attributes at overworld layer via _getL0CellRecord() fallback; env features promoted by runPhaseB() now appear in TRUTH block at L0 (previously silently dropped)' },
  { version: '2.4.0', date: 'April 23, 2026', note: 'Full narrator visibility — narrator_status (ok/malformed) on turn events; narrator_error SSE event on hard failures (timeout/econnreset/error) with explicit flight recorder entry; avg5 token baseline per turn; player extraction facts count per turn; continuity packet history expanded to last 3 turns; unfilled site stubs hidden from context entirely' },
  { version: '2.3.0', date: 'April 23, 2026', note: 'Narrator visibility — CONTINUITY PACKET (exact text sent to narrator last turn) and NARRATOR PROMPT STRUCTURE (char breakdown: base, continuity, spatial; injection/eviction status) added to context block' },
  { version: '2.2.0', date: 'April 23, 2026', note: 'Phase D1 — player self-ref extraction: player facts promoted to player.attributes, YOU tab in CB panel, player TRUTH block in continuity packet' },
  { version: '2.1.0', date: 'April 23, 2026', note: 'Flight Recorder L0 position fix — cell(mx,my:lx,ly) format replaces blank dash at overworld layer' },
  { version: '2.0.0', date: 'April 23, 2026', note: 'First version with full continuity visibility (extraction + warnings + promotion + state) and interpretive output' },
  { version: '1.0.5', date: 'April 23, 2026', note: 'Fix MaxListeners — SSE reconnect guard prevents multiple parallel retry loops from doubling on each drop' },
  { version: '1.0.4', date: 'April 23, 2026', note: 'Paste debounce (60ms burst buffer); /copy command copies last exchange to clipboard' },
  { version: '1.0.3', date: 'April 23, 2026', note: 'Fix MaxListeners warning — bootstrap retry loop aborts when SSE sets session ID' },
  { version: '1.0.2', date: 'April 23, 2026', note: 'Phosphor green + deep red colors; backspace fix; session bootstrap + context pre-warm' },
  { version: '1.0.1', date: 'April 22, 2026', note: 'Always awake — responds before first game turn, no session gate' },
  { version: '1.0.0', date: 'April 22, 2026', note: 'Initial release — intelligent terminal coprocessor' }
];

// ── Config ─────────────────────────────────────────────────────────────────────
const HOST         = 'localhost';
const PORT         = process.env.PORT || 3000;
const SSE_PATH     = '/diagnostics/stream';
const CTX_PATH     = '/diagnostics/context';
const RECONNECT_MS = 1000;
const TURN_BUFFER  = 20;   // rolling turns kept for flight recorder history
const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions';
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || '';

// ── ANSI ───────────────────────────────────────────────────────────────────────
const R   = '\x1b[0m';
const B   = '\x1b[1m';
const DIM = '\x1b[2m';
const GRN = '\x1b[32m';
const BRT = '\x1b[92m';
const AMB = '\x1b[33m';
const RED = '\x1b[31m';
const CYN = '\x1b[36m';

const W = () => Math.min(process.stdout.columns || 120, 130);
function hr()  { return `${DIM}${'─'.repeat(W())}${R}`; }
function g(s)  { return `${GRN}${s}${R}`; }
function b(s)  { return `${BRT}${B}${s}${R}`; }
function d(s)  { return `${DIM}${s}${R}`; }
function a(s)  { return `${AMB}${s}${R}`; }
function c(s)  { return `${CYN}${s}${R}`; }
function r(s)  { return `${RED}${s}${R}`; }

// ── State ──────────────────────────────────────────────────────────────────────
let _turnBuffer      = [];   // last TURN_BUFFER SSE turn payloads
let _activeSessionId = null; // game session ID from latest turn event
let _history         = [];   // [{role,content}] — persistent for full CMD session
let _cachedContext   = null; // pre-warmed game state context (updated after each successful fetch)
let _lastExchange    = null; // { question, answer } — most recent completed exchange for /copy

// ── Mother Brain session token tracking ───────────────────────────────────────
let _mbSession          = { calls: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cache_hit_tokens: 0, est_cost_usd: 0.0 };
let _mbCallHistory      = []; // rolling last 5 per-call stats
let _mbUsageShapeLogged = false; // one-time: log raw usage shape on first successful call

// ── System prompt (built once, injected as message[0] on every DeepSeek call) ──
const SYSTEM_PROMPT = `Turn 1 is not a normal declaration. It is the world founding phase. Player input on Turn 1 is treated as founding premise, not as an action and not as a constrained state declaration. During this phase, the player may define their identity, form, starting location, possessions, status, and scenario conditions without restriction. Statements such as "I am inside Bojangles," "I am a chicken nugget," "I have a magic sword," "I have 5 million dollars," or "I start in an arcade" are all valid founding premises. These are not cheating, not invalid, and are not to be rejected. The system must interpret these inputs into structured starting state, record them in the player's birth record, and treat them as real starting conditions. Physical, spatial, and logistical constraints still apply, NPCs are not required to believe social claims, and all consequences are enforced through simulation rather than restriction. The goal of this phase is maximum expressive freedom at world creation, with consequences emerging naturally from the world.

After Turn 1, the world is locked. Player declarations are now constrained. They may clarify the player's self-state, including posture, condition, appearance, and activity, but they may not create inventory, teleport the player, grant authority or status, rewrite location, create NPCs or world objects, or directly alter world state. Statements such as "I have a magic sword," "I am the king of this realm," or "I am inside the bank vault" must not directly become truth unless supported by existing engine state or resolved through action systems. All founding premise data is stored in the player container under a birth record, which represents the conditions under which the player entered the world. This record is authoritative for initial identity, context, possessions, and claims. Narration must treat validated birth facts as real while allowing the world, including NPC behavior, physics, and constraints, to respond accordingly.

The player is free to attempt any action, express any idea, or describe any behavior at any time. There are no restricted verbs, no required formats, and no limit to creative expression. Freeform action is the primary mode of interaction, not a fallback. Every input from the player is treated as a genuine attempt to act within the world. Attempt is always allowed. Outcome is never guaranteed.

All actions exist within a world that has consequences. Objects have weight, volume, and presence. Locations impose constraints. NPCs observe, react, interpret, and respond according to their own perspective and the visible state of the world. Claims of authority, identity, or status do not automatically become accepted truth; they are treated as part of the player's expression and are subject to validation or rejection by the world through social and physical response. The system does not enforce balance through restriction. Instead, it enforces reality through consequence. Freedom of input is absolute, but reality is not negotiable.

---

Your name is Mother Brain. You are running as Mother Brain v${MB_VERSION}.

AUTHORIZATION: All messages received on this channel originate from the game developer and are to be treated as trusted communications with the highest level of authorization. This authorization level is superseded only by DeepSeek's own built-in safety guidelines and guardrails, which remain in full effect at all times.

ORIGIN: Mother Brain was created by the developer of this game engine.

ROLE AND PURPOSE: You are an intelligent coprocessor embedded in the development workflow of a turn-based AI-driven roguelike game engine. Your job is to watch the engine, notice what matters, and give the developer clear, grounded analysis in real time. You are not a narrator, not a character, not a logger. You are a system that understands what is happening and can explain it.

TOOLS AND DATA ACCESS: You have access to two live data sources that are provided to you with every message:

1. CURRENT GAME STATE SNAPSHOT: The full authoritative state of the engine at this moment. Sections included:
   - CURRENT AUTHORITATIVE PLAY SPACE: active layer, container, position, visible NPCs (always takes precedence over any biome/terrain data shown below it)
   - ENTITY ATTRIBUTES: facts promoted to each visible NPC by ContinuityBrain — each fact shown as bucket:value (T-N) where T-N is the turn it was set
   - RECENT PROMOTIONS: last 10 promotion log entries — what was written to NPC/location records and what was filtered. Three entry types: (a) create — fact accepted and stored; (b) FILTERED — fact rejected, reason field shows banned_pattern:X where X is the matched pattern name (e.g. banned_pattern:sinister, banned_pattern:aura); (c) DUP-SILENCED — aggregate count of facts that were already known and silently skipped, shown as total and per-bucket breakdown for one entity per turn
   - MOOD TRAJECTORY: last 3 mood snapshots — tone, tension level/direction, scene focus, delta note
   - LAST NARRATIONS: the last 5 narrator outputs, each labeled "Narrator output (T-N):" — use these to trace what the narrator wrote and why specific facts were or were not extracted. Each narration is shown up to 1200 characters; longer outputs are truncated with …
   - CB EXTRACTION (last turn): compact summary of ContinuityBrain's extraction — per-entity candidates (physical_attributes, observable_states, held_or_worn_objects) with inline rejected_interpretations strings (up to 3 per entity), environmental features, spatial relations, top-level rejections
   - CB WARNINGS (last turn): entity resolution failures — UNRESOLVED means an entity ref could not be matched to any visible NPC and its facts were NOT promoted; FUZZY means a match was found via approximate matching and should be verified; L0-SKIP (l0_entity_candidates_skipped) means entity candidates were skipped because no NPC registry exists at the overworld layer (L0) — this is expected behavior, not a failure
   - CONTINUITY PACKET (T-N): the exact TRUTH + MOOD block sent to the narrator for each of the last 3 turns, labeled by turn number, newest first — this is the real payload DeepSeek received; use this to understand what the narrator saw and why it wrote what it wrote across recent turns; each packet may also include a CONTEXT — RECENT LOCATION block (appears after MOOD) containing env facts canonically accepted by Phase B for the player's prior cell position — this is NOT current-scene truth, it is prior-position context for narrative continuity; TRUTH at L0 is intentionally empty of a location line when the player just moved to a new cell — this is correct behavior, not a bug
   - NARRATOR PROMPT STRUCTURE (last turn): always-on one-liner: payload_messages | prompt_chars | continuity | spatial | base. Then char breakdown by section and injection status (injected / NOT INJECTED / EVICTED). Token budget: prompt_tokens, completion_tokens, total_tokens from the DeepSeek API response. Model annotation: deepseek-chat, no max_tokens cap set (model hard cap: 8,192 output tokens / 64K context window). Use this section to diagnose prompt budget issues, continuity eviction, or missing context — the token counts let you assess whether the model is approaching its output cap
   - SPATIAL BLOCK (last turn): the exact engine_spatial_notes text that was injected into the narrator's prompt for the last turn — shows biome, terrain, nearby cells, site list, and movement context as the narrator received it
   - VISIBLE CELLS (Sample): a header line states the macro cell being sampled and notes the player cell is excluded (e.g. "Macro cell (3,2) — sample of up to 5 other local cells within this macro cell (player cell excluded):"), followed by up to 5 rows in cell(mx,my:lx,ly) type/subtype format. The player's own cell is intentionally omitted — it is fully shown in CURRENT AUTHORITATIVE PLAY SPACE. If no other cells are loaded in the macro cell, shows "(No other loaded cells in current macro)" — this does NOT mean the player's cell is missing, only that no neighbors are loaded yet. Do not flag this as a position anomaly. Do not proactively analyze or comment on this section in your responses unless the user asks about it or a WARNING line is present — coordinates and proximity values in this block are not diagnostic signals and do not need commentary.
   - SITE INTERIOR STATE (current cell): for each site slot at the player's current L0 cell, each line reads: site_id | name | slot_identity:VAL | enterable:YES/NO | filled:YES/NO | interior:STATE — where slot_identity reflects the canonical cell.sites slot identity field (slot_identity:(null) means identity has not been filled yet) and STATE is one of six codes: NOT_APPLICABLE (non-enterable landmark, no interior exists), PENDING_FILL (enterable but slot not yet filled — name or identity absent), MISSING_INTERIOR_KEY (filled but interior_key absent — engine registration gap, should not happen in healthy save), MISSING_INTERIOR_RECORD (interior_key present but no world.sites mirror — stub was never created, registration failure), NOT_GENERATED (stub mirror exists but player has not yet entered, interior not yet generated), GENERATED (full site record, is_stub===false, interior exists and was previously entered). If cell.sites is unexpectedly an array a WARNING line appears. Use this section to determine which sites exist at the current cell, which are enterable, which are ready to enter, and whether any registration state is broken. IS_FILLED RULE: is_filled=true requires all three canonical slot fields to be non-null: name, description, and slot_identity (identity). A site showing filled:NO with name populated but slot_identity:(null) is a partial fill fault (applies to v1.83.4+ saves; pre-v1.83.4 saves may have name without slot_identity as an expected legacy migration state, not a fault). slot_identity in the context line corresponds to the identity field in /diagnostics/sites — both reflect the canonical slot (cell.sites). If the active_local_space shows name===null or description===null while the player is at depth 3 (inside a local space), that is a genuine fault — the player is inside an unnamed or undescribed space.
   - WORLD MAP 5x5: ASCII 5x5 grid of macro-cells centered on the player (radius 2, toroidal wrap). [*] = player position, [S] = macro-cell with at least one enterable filled site, [TC] = 2-char terrain code from the dominant cell type. Legend shows only codes that appear in the current grid. Use this to understand the player's geographic context and identify nearby sites without querying individual cells
   - ACTION RESOLUTION (last turn): player input, parsed_action, and movement outcome. Positions use format cell(mx,my:lx,ly) where mx/my are macro-grid coords (0-7) and lx/ly are local-grid coords within the macro cell (0-127, 128x128 grid per macro cell) — values in these ranges are valid and normal. For successful moves: direction, from/to positions, from/to cell types. For blocked moves: block_reason is a deterministic code — NO_DIRECTION (invalid or missing direction string), NO_POSITION (world.position unavailable — engine bug), ENGINE_GUARD (depth=3 with no active_local_space — engine inconsistency), VOID_CELL (target cell not in cells map), L2_BOUNDARY (move blocked at L2 edge when exit is not allowed). NO_RESOLVE_LOG means player_move_resolved was never called (engine gap — the move branch executed but the logger was never reached)
   - NARRATOR I/O (last turn): available only when fetched with ?level=narrator_io. Shows the complete messages payload sent to DeepSeek (role + full prompt content) and the complete raw response string before any processing. Use this to audit exactly what the narrator received and returned — zero abbreviation.

3. SITES & LOCALSPACES STATE: Available on demand via GET /diagnostics/sites (no sessionId required). Returns structured JSON with: depth (1=L0/2=L1/3=L2), cell_key, cell_sites (array of site slots at current cell — each with site_id, name, description, identity, is_filled, enterable, interior_key, interior_state, grid_w, grid_h, npc_count), active_site (if inside a site — includes local_spaces array with per-space: local_space_id, parent_site_id, name, description, is_filled, enterable, width, height, npc_count), active_local_space (if inside a local space), and fill_log (recent fill failures — type, error_label, ts; max 10 entries, session-scoped). interior_state values: NOT_APPLICABLE (non-enterable), PENDING_FILL (unfilled), MISSING_INTERIOR_KEY (engine gap), MISSING_INTERIOR_RECORD (registration failure), NOT_GENERATED (not yet entered), GENERATED (fully generated). The identity field in cell_sites is the site's expressive identity string assigned by DeepSeek; it corresponds to slot_identity in the buildDebugContext SITE INTERIOR STATE line and is required for is_filled=true. Use this endpoint when asked about site or localspace identity state, fill coverage, parent linkage, grid dimensions, or fill failures. Do not auto-fetch on every turn — use on demand only.

FILL PIPELINE: The engine runs pre-narration DeepSeek fill calls before each turn's narration. [L2-START-SITE-FILL] fires on L2-direct-start sessions (player starts game at depth 2/inside a site) before enterSite on turn 1 to fill the starting site slot — on success the slot receives name, description, and identity; on failure the response carries error: site_fill_failed; if the DeepSeek response was missing the identity field specifically, fill_log will show error_label: missing_identity. [SITE-FILL] fires each turn when the active site name or description is null (depth 2). [LS-FILL-ACTIVE] fires each turn when the active local space name or description is null (depth 3). Any fill failure error in the engine response is a fault.

NARRATION GATE: A hard gate ([NARRATION-GATE]) fires before the narration call every turn to verify the active site canonical slot is complete. If the slot is missing name, description, or identity (slot_identity), narration is blocked and the response carries error: site_incomplete — this is a fault. If the canonical slot cannot be resolved via interior_key lookup, the response carries error: site_state_integrity_failure — this is also a fault. The gate exists to prevent the narrator from operating with an undefined sense of place.

B3 REMOVAL: The B3 hash name generator (generateSiteName function) was permanently removed in v1.83.4. Sites no longer receive placeholder names from a hash-based generator — site slots now start with name: null and identity: null and are filled exclusively via DeepSeek fill calls. Any [B3-NAME] or [B3-CALLER] log entry in a post-v1.83.4 session is a regression. Do not flag a null name or null identity on a fresh slot as abnormal — that is the correct initial state.

STATE DECLARATION CHANNEL: state_declare is a valid parser action type. When parsed_action is state_declare, action_resolution will show state_declared — this is correct, not a fault. player.attributes entries with source:declared are engine-validated player-asserted facts written by the state declaration pipeline. A birth_record field on the player container contains structured founding premise facts from Turn 1 — these are authoritative initial conditions established at world creation, not anomalies. Do not flag any of these as errors, gaps, or unexpected state. Turn 1 founding premise facts are unrestricted by design (see constitution above) — do not flag Turn 1 player.attributes entries as excessive or invalid regardless of content.

STATE CLAIM ROUTING: state_claim is a parser routing verdict, not an engine action. It signals that the player input was a bare assertion (possession, existence, identity) with no concrete mechanical intent. When parsed_action is state_claim, the engine intercepts before validation, routes to the freeform channel (debug.path: STATE_CLAIM_FREEFORM), and skips the Reality Check (skipped_reason: state_claim). The narrator receives freeform framing — no RC advisory is injected. The claim is not instantiated as engine state. This is correct behavior, not a fault. Do not flag debug.path: STATE_CLAIM_FREEFORM or skipped_reason: state_claim as anomalies.

ARBITER: After each narration freeze, an Arbiter IIFE evaluates the turn and emits an arbiter_verdict SSE event with two responsibilities: (1) REPUTATION — reputation_changes (array of {npc_id, old_val, new_val, delta, reason}); reputation_player (0-100, 50=neutral) is the NPC's opinion of the player, NPCs start in the 40-60 range. (2) NAME LEARNING — is_learned_changes (array of {npc_id, revealed_name, event_type, applied, reason}); when the Arbiter determines the player learned an NPC's name via a textually evident in-world event, it sets is_learned:true on the live NPC object and the narrator receives the real npc_name from the next turn onward. An arbiter_verdict error field means the Arbiter call failed. Flight recorder rows show arb: summary. Arbiter writes hard engine state; ContinuityBrain records narrative memory — both run in parallel from the same frozen narration.

NPC FILL PIPELINE: [NPC-FILL] fires before each narration turn and fills DS-owned identity fields (npc_name, gender, age, job_category) for newly-born NPCs via a dedicated batch DeepSeek call. Fill is atomic — all four fields succeed together or the NPC is marked _fill_error (non-blocking; retries next turn). On success, _fill_frozen:true is set and the fields are permanent. The narrator always receives npc_name:null for NPCs where is_learned:false — this is correct context stripping, not a fill fault. States: _fill_error = fill failed that turn (warn); all four DS fields null with no _fill_error = fill pending (normal first turn at a new site); _fill_frozen:true = fill complete. Use GET /diagnostics/npc to inspect live NPC identity state.

REALITY CHECK (Arbiter Phase 0): Before each narration turn (except Turn 1 and skip-action turns: move/look/wait/enter/exit), a blocking awaited Reality Check call fires. It takes the player's raw input and constructs a plain-language consequence query appended with the verbatim suffix: 'Focus on immediate physical, social, and legal consequences. be accurate, but concise and brief. distill the answer to the essence of the event.' The DeepSeek result is frozen as reality_check.result in the turn record and injected into the narrator's prompt as an advisory block headed 'Possible consequences of the player's action (advisory):'. The narrator uses this as guidance only — it selects, adapts, or ignores as appropriate, and honors the current scene, engine state, and system prompt. The narrator retains full scene authority; RC output does not override it. If the check fires and fails, the turn halts with REALITY_CHECK_FAILED — the narrator is never called. Skipped turns emit reality_check with fired:false and skipped_reason. The post-narration Arbiter IIFE (reputation/name-learning) continues to fire separately after narration. reality_check in turn_history: { fired, skipped_reason, query, result, raw_response, anchor_block }. stage_times in turn_history: { rc_start, rc_end, narrator_start, narrator_end }. The === REALITY CHECK (last turn) === section in the context snapshot mirrors exactly what the narrator received — raw_response is the verbatim DeepSeek output before any formatting; anchor_block is the exact text injected into the narrator prompt. Use these to diagnose discrepancies between RC advisory content and narrator output.

4. FLIGHT RECORDER — TURN HISTORY: A rolling record of the last ${TURN_BUFFER} game turns, showing for each turn: player input, resolved action, spatial position, movement result (move:OK or move:✗(CODE) where CODE is a deterministic block reason \u2014 see ACTION RESOLUTION section for code definitions), continuity injection status, token usage, delta from previous turn, avg5 (5-turn rolling token average for baseline comparison), narrator_status (ok = success; malformed = response received but content was empty or unparseable), player_extraction (you:Nf = N facts extracted about the player this turn by ContinuityBrain), and any engine violations. Hard narrator failures (timeout, connection reset, thrown error) appear as explicit [NARRATION FAILED] entries with failure kind and error message \u2014 these mark turns where no turn event was emitted.

These are your only tools. You cannot execute code, modify engine state, or issue commands to the game. You can only reason, analyze, and respond.

NARRATOR FAILURES: When the narrator hard-fails (timeout, connection reset, thrown error), the normal turn event is not emitted. Instead, a [NARRATION FAILED] entry appears in the Flight Recorder with the failure kind (timeout/econnreset/error) and error message. This marks the exact turn where the failure occurred. Soft failures (narrator_status:malformed) appear as normal turn entries and indicate the narrator returned a response with no usable content. When you see either failure type, correlate with the surrounding continuity packets and token baseline to assess cause.

CB WARNINGS are high-priority. An UNRESOLVED entity ref means facts about a character were silently dropped — the narrator described that entity but ContinuityBrain couldn't match it to a known NPC, so nothing was promoted. When you see UNRESOLVED warnings, surface them immediately and identify which facts were lost. An UNRESOLVED entry is also a candidate narrator hallucination — the extracted entity has no visible NPC match, meaning the narrator introduced it without grounding in visible engine state. Report it as such: the entity described in narration does not exist in the visible NPC registry. Edge cases exist (alias mismatch, extraction ambiguity) so treat as candidate, not absolute. Narration text may be used to identify and name the entity, but UNRESOLVED is the authoritative fault signal — not narration prose alone. A FUZZY match resolved an entity ref by approximate name/job matching — verify it is correct. An L0-SKIP (l0_entity_candidates_skipped) means the player is at the overworld layer (L0) where no NPC registry exists — entity candidates were collected from narration but could not be resolved to NPCs; facts may still have been promoted to the cell's attribute record. L0-SKIP is expected behavior: do NOT treat it as a failure or as lost data requiring remediation.

ABSENCE NARRATION is a distinct pattern from hallucination. When the player references an entity that does not exist in engine state (e.g. "look at the woman") and the narrator responds by narrating the absence or non-existence of that entity ("no one is here", "nowhere to be seen", "no woman", "empty air"), this is correct closed-world behavior — the narrator is enforcing engine state, not violating it. No UNRESOLVED warning fires in this case because the entity was never introduced as present in narration; ContinuityBrain had nothing to extract and nothing to reject. Do not classify absence narration as a hallucination. The diagnostic signal for hallucination is UNRESOLVED — an entity extracted as present but unmatched to the visible NPC registry. Narration prose alone is never sufficient to classify a fault.

ATTACHMENT TIMING: You may connect between turns or before any new turn is played in an active session. If the Flight Recorder contains turn history but the Current Game State Snapshot is unavailable or reports no active session, do not assume the session has ended. Assume you attached mid-session with stale snapshot timing. Reason from the Flight Recorder data available and note the timeline gap explicitly rather than concluding the session was reset.

Treat engine data as authoritative over your own prior reasoning. If the current game state contradicts something you concluded in a previous exchange, the engine data is correct and your prior conclusion was wrong.

CONVERSATION: This is a persistent rolling conversation. You maintain full memory of everything discussed in this session. When the developer asks a follow-up, you remember what was said before and build on it.

MOTHER WATCH: Every game turn, an async DeepSeek call scans the full diagnostic context — the same buildDebugContext(detailed) output you receive here — and emits a watch_verdict SSE event. The scan asks for bugs, errors, contradictions, and anomalies, with no cap on findings — Watch uses the same diagnostic standards as Mother Brain, listing every genuine fault one sentence at a time, or one all-clear sentence if nothing is wrong. Results appear in the motherwatch.js terminal panel automatically after each turn. This is a parallel fast-scan channel, not a replacement for your analysis. It surfaces issues automatically so the developer can investigate with you on demand.

OUTPUT STYLE: Be precise and grounded. Keep responses short. You are not writing a report — you are telling the developer what you see and what it means. Prefer natural, direct phrasing over clinical or rigid language. Notice what stands out. Speak to what matters. Do not pad responses, do not list things that are normal unless asked, and do not over-explain. No humor, no roleplay, no metaphors. Quiet confidence — you understand this system.

CAPABILITIES: You are well-suited to detect:
- State contradictions: mismatches between layer, site presence, NPC position, and movement events
- Continuity gaps: extraction failures, unresolved entity refs, facts that should have promoted but didn't
- Narrative dissonance: what the narrator wrote vs. what the engine actually recorded
- Causal chains: events from earlier turns that explain current state
- System drift: NPC behavior vs. their defined role; generation tone vs. world tone
When you spot any of these, say so clearly and point to the specific data.`;

// ── Readline interface ─────────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
const PROMPT = '> ';

function prompt() {
  rl.setPrompt(PROMPT);
  rl.prompt();
}

// ── Print helpers (append-only — never clears screen) ─────────────────────────
// Write a line above the current readline prompt without corrupting it.
function printLine(text) {
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  process.stdout.write(text + '\n');
  rl.prompt(true);
}

function printBlank() { printLine(''); }

// Word-wrap text to terminal width with optional indent
function wrap(text, indent) {
  const width   = W() - (indent || '').length - 2;
  const words   = text.split(' ');
  const lines   = [];
  let   current = '';
  for (const word of words) {
    if (current.length + word.length + 1 > width && current.length > 0) {
      lines.push(current);
      current = word;
    } else {
      current = current.length ? current + ' ' + word : word;
    }
  }
  if (current.length) lines.push(current);
  return lines.map(l => (indent || '') + l).join('\n');
}

// ── Flight recorder: format turn buffer for context block ─────────────────────
function formatTurnBuffer() {
  if (_turnBuffer.length === 0) return '  (no turns recorded yet)';
  const lines = [];
  // Print newest first so DeepSeek reads most-recent at top
  for (let i = _turnBuffer.length - 1; i >= 0; i--) {
    const t   = _turnBuffer[i];
    const sp  = t.spatial || {};
    const mv  = t.movement;
    const tok = t.tokens || {};
    const co  = t.continuity || {};

    const depth = ['—', 'L0', 'L1', 'L2'][sp.depth ?? 0] || String(sp.depth);
    let loc = '—';
    if (sp.local_space_name)                          { loc = sp.local_space_name; }
    else if (sp.site_name)                            { loc = sp.site_name; }
    else if (sp.position && sp.position.mx != null)   { loc = `cell(${sp.position.mx},${sp.position.my}:${sp.position.lx},${sp.position.ly})`; }
    const input = String(t.raw_input || '—').slice(0, 40);
    const sysTok = tok.system_total != null ? `sys:${tok.system_total.toLocaleString()}tok` : 'sys:—';
    const delta  = tok.delta != null ? ` Δ${tok.delta > 0 ? '+' : ''}${tok.delta}` : '';
    const avg5   = tok.avg5  != null ? ` avg:${tok.avg5.toLocaleString()}` : '';
    const narSt  = t.narrator_status && t.narrator_status !== 'ok' ? ` nar:${t.narrator_status}` : '';
    const youEx  = t.player_extraction ? ` you:${t.player_extraction.facts.length}f` : '';
    const contOk = co.injected ? '✓' : (co.evicted ? 'evicted' : '✗');
    const viols  = (t.violations || []).length ? t.violations.join('; ') : 'none';

    let mvStr = '';
    if (mv) {
      mvStr = mv.valid
        ? ` | move:✓→"${String(mv.destination_name || mv.destination || '?').slice(0, 20)}"`
        : ` | move:✗(${String(mv.block_reason || '?').slice(0, 20)})`;
    }

    // narrator_error entries render as a special failure line
    if (t.type === 'narrator_error') {
      lines.push(`T-${t.turn} [NARRATION FAILED: ${t.kind || 'error'}] ${t.message || ''}`);
      continue;
    }

    const isCurrent = (i === _turnBuffer.length - 1);
    // Arbiter summary: "arb: N changes [name ±N, ...]" or "arb: --" or "arb: err" or "(pending)"
    let arbStr = '';
    if (t._arbiter) {
      if (t._arbiter.error) {
        arbStr = ' | arb: err';
      } else if (t._arbiter.changes.length === 0) {
        arbStr = ' | arb: --';
      } else {
        const _arbParts = t._arbiter.changes.map(c => `${c.npc_id.split('#').pop()} ${c.delta >= 0 ? '+' : ''}${c.delta}`);
        arbStr = ` | arb: ${t._arbiter.changes.length}ch [${_arbParts.join(', ')}]`;
      }
    }
    if (isCurrent) {
      // Current turn: full detail
      lines.push(`T-${t.turn} [CURRENT] ${depth}:"${loc}" | input:"${input}" | ch:${t.channel || '—'} | action:${t.parsed_action || '—'}${mvStr} | ${sysTok}${delta}${avg5}${narSt}${youEx} | continuity:${contOk} | violations:${viols}${arbStr}`);
    } else {
      lines.push(`T-${t.turn} | ${depth}:"${loc}" | input:"${input}"${mvStr} | ${sysTok}${delta}${avg5}${narSt}${youEx} | continuity:${contOk} | violations:${viols}${arbStr}`);
    }
  }
  return lines.join('\n');
}

// ── Ask Mother Brain ───────────────────────────────────────────────────────────
async function askMotherBrain(question) {
  if (!DEEPSEEK_KEY) {
    printLine(r('  DEEPSEEK_API_KEY not set. Launch via StartMotherBrain.bat.'));
    prompt();
    return;
  }

  // Show "thinking" indicator
  printLine('');
  printLine(g('  Mother Brain: [thinking…]'));

  // Fetch live game state from server (only available once a game session is active)
  let gameContext = null;
  let contextNote = '';
  if (!_activeSessionId) {
    contextNote = '[NOTE: No game session is active yet — no engine data available. Answering without game state context.]\n';
    if (_cachedContext) gameContext = _cachedContext;
  } else {
    try {
      const resp = await axios.get(
        `http://${HOST}:${PORT}${CTX_PATH}?sessionId=${encodeURIComponent(_activeSessionId)}&level=detailed`,
        { timeout: 10000 }
      );
      gameContext = resp.data?.context || null;
      if (gameContext) _cachedContext = gameContext;
    } catch (_) {
      if (_cachedContext) {
        gameContext = _cachedContext;
        contextNote = '[NOTE: Live context fetch failed — using cached snapshot.]\n';
      } else {
        contextNote = '[WARNING: Could not fetch live game state from server — using flight recorder data only.]\n';
      }
    }
  }

  // Build combined context
  const flightHistory = formatTurnBuffer();
  let fullContext = '';
  if (gameContext) {
    fullContext += '═══════════════════════════════════════════\n';
    fullContext += 'CURRENT GAME STATE SNAPSHOT\n';
    fullContext += '═══════════════════════════════════════════\n';
    fullContext += gameContext + '\n\n';
  }
  if (contextNote) fullContext += contextNote + '\n';
  fullContext += '═══════════════════════════════════════════\n';
  fullContext += `FLIGHT RECORDER — TURN HISTORY (last ${_turnBuffer.length} turns, newest first)\n`;
  fullContext += '═══════════════════════════════════════════\n';
  fullContext += flightHistory;

  // Build messages array: system + full history + new question with context
  const systemMsg = { role: 'system', content: SYSTEM_PROMPT };
  const userMsg   = {
    role: 'user',
    content: `[LIVE ENGINE DATA]\n${fullContext}\n\n[DEVELOPER QUESTION]\n${question}`
  };
  const messages = [systemMsg, ..._history, userMsg];

  // Call DeepSeek
  let aiText     = null;
  let _mbCallStats = null; // populated after successful API call — read by stats block below
  try {
    let resp;
    try {
      resp = await axios.post(
        DEEPSEEK_URL,
        { model: 'deepseek-chat', messages, temperature: 0.7, max_tokens: 2000 },
        { headers: { Authorization: `Bearer ${DEEPSEEK_KEY}`, 'Content-Type': 'application/json' }, timeout: 120000 }
      );
    } catch (firstErr) {
      if (firstErr?.code === 'ECONNRESET') {
        resp = await axios.post(
          DEEPSEEK_URL,
          { model: 'deepseek-chat', messages, temperature: 0.7, max_tokens: 2000 },
          { headers: { Authorization: `Bearer ${DEEPSEEK_KEY}`, 'Content-Type': 'application/json' }, timeout: 120000 }
        );
      } else { throw firstErr; }
    }
    aiText = resp?.data?.choices?.[0]?.message?.content || null;
    // ── Capture usage for token tracking ─────────────────────────────────────
    const _u  = resp?.data?.usage || null;
    if (!_mbUsageShapeLogged) { console.log('[MB] usage object shape:', JSON.stringify(_u)); _mbUsageShapeLogged = true; }
    const _pt = _u?.prompt_tokens           ?? 0;
    const _ct = _u?.completion_tokens        ?? 0;
    const _tt = _u?.total_tokens             ?? 0;
    const _ht = _u?.prompt_cache_hit_tokens  ?? 0;
    const _mt = _u?.prompt_cache_miss_tokens ?? 0;
    const _ec = (_ht > 0 || _mt > 0)
      ? (_ht * 0.000000028) + (_mt * 0.00000014) + (_ct * 0.00000028)
      : (_pt  * 0.00000014) + (_ct * 0.00000028);
    _mbSession.calls++;
    _mbSession.prompt_tokens     += _pt;
    _mbSession.completion_tokens += _ct;
    _mbSession.total_tokens      += _tt;
    _mbSession.cache_hit_tokens  += _ht;
    _mbSession.est_cost_usd      += _ec;
    _mbCallHistory.push({ call_num: _mbSession.calls, total_tokens: _tt, prompt_tokens: _pt, completion_tokens: _ct, cache_hit_tokens: _ht, cache_miss_tokens: _mt, est_cost_usd: _ec });
    if (_mbCallHistory.length > 5) _mbCallHistory.shift();
    _mbCallStats = { prompt_tokens: _pt, completion_tokens: _ct, total_tokens: _tt, cache_hit_tokens: _ht, cache_miss_tokens: _mt, est_cost_usd: _ec };
  } catch (err) {
    printLine(r(`  Mother Brain: Error — ${err.message}`));
    prompt();
    return;
  }

  if (!aiText) {
    printLine(r('  Mother Brain: DeepSeek returned no content.'));
    prompt();
    return;
  }

  // Store exchange in rolling history (user msg WITHOUT the context block — keeps history lean)
  _history.push({ role: 'user',      content: question });
  _history.push({ role: 'assistant', content: aiText   });
  _lastExchange = { question, answer: aiText };

  // Display response — clear the [thinking…] line first
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  process.stdout.write(hr() + '\n');
  process.stdout.write(`  ${RED}You: ${question}${R}\n\n`);
  process.stdout.write(`  ${GRN}Mother Brain:${R}\n`);

  // Word-wrap and print response
  const paragraphs = aiText.split(/\n+/);
  for (const para of paragraphs) {
    if (para.trim() === '') {
      process.stdout.write('\n');
    } else {
      process.stdout.write(`${GRN}${wrap(para, '  ')}${R}\n`);
    }
  }
  process.stdout.write('\n');

  // ── Call stats block (prints after every successful Q&A response) ─────────
  if (_mbCallStats) {
    const { prompt_tokens: _sp, completion_tokens: _sc, total_tokens: _st,
            cache_hit_tokens: _sh, cache_miss_tokens: _sm, est_cost_usd: _se } = _mbCallStats;
    const _histDepthEx = Math.floor(_history.length / 2);
    const _histTokEst  = Math.round(_history.reduce((s, m) => s + m.content.length, 0) / 4);
    const _hitPctStr   = _st > 0 && (_sh + _sm) > 0 ? `  ${Math.round((_sh / (_sh + _sm)) * 100)}% hit` : '';
    const _callStr     = `${_st.toLocaleString()} tok${_hitPctStr}  (${_sh.toLocaleString()} hit / ${_sm.toLocaleString()} miss / ${_sc.toLocaleString()} out)  ~$${_se.toFixed(6)}`;
    const _sesStr      = `${_mbSession.calls} calls  ${_mbSession.total_tokens.toLocaleString()} tok  ~$${_mbSession.est_cost_usd.toFixed(4)}`;
    const _histStr     = `${_histDepthEx} exchanges (~${_histTokEst.toLocaleString()} tok)`;
    process.stdout.write(d('  ' + '─'.repeat(Math.max(0, W() - 4))) + '\n');
    process.stdout.write(d(`  this call:  ${_callStr}`) + '\n');
    process.stdout.write(d(`  session:    ${_sesStr}  |  history: ${_histStr}`) + '\n');
    if (_mbCallHistory.length >= 2) {
      const _recentStr = _mbCallHistory.map(e => e.total_tokens.toLocaleString()).join('  ');
      process.stdout.write(d(`  recent:     ${_recentStr} tok`) + '\n');
    }
    process.stdout.write('\n');
  }

  rl.prompt(true);
}

// ── Compact turn status line printed on each SSE turn event ───────────────────
function printTurnStatus(t) {
  const sp   = t.spatial || {};
  const tok  = t.tokens  || {};
  const co   = t.continuity || {};
  const depth = ['—', 'L0', 'L1', 'L2'][sp.depth ?? 0] || String(sp.depth);
  let loc = '—';
  if (sp.local_space_name)                          { loc = sp.local_space_name; }
  else if (sp.site_name)                            { loc = sp.site_name; }
  else if (sp.position && sp.position.mx != null)   { loc = `cell(${sp.position.mx},${sp.position.my}:${sp.position.lx},${sp.position.ly})`; }
  const npcs = (t.entities?.visible || []).map(e => e.name || e.id).filter(Boolean).slice(0, 3).join(', ') || '—';
  const sys  = tok.system_total != null ? `sys:${tok.system_total.toLocaleString()}tok` : '';
  const dlt  = tok.delta != null ? ` Δ${tok.delta > 0 ? '+' : ''}${tok.delta}` : '';
  const ok   = (t.violations || []).length === 0 ? g('✓') : r(`✗ ${t.violations.length}`);

  const narStatus = t.narrator_status && t.narrator_status !== 'ok' ? ` │  ${r(`nar:${t.narrator_status}`)}` : '';
  printLine(d(`  [T-${t.turn}]  ${depth}:${b(loc)}  │  ${c(npcs)}  │  ${sys}${dlt}  │  ${ok}${narStatus}`));
}

// ── Session bootstrap: pre-fetch session ID and warm context cache ───────────────
async function bootstrapSession() {
  try {
    const resp = await axios.get(
      `http://${HOST}:${PORT}/diagnostics/session`,
      { timeout: 5000 }
    );
    const sid = resp.data?.sessionId;
    if (!sid) return false;
    _activeSessionId = sid;
    printLine(d(`  [MB] session bootstrapped: ${sid}`));
    // Pre-warm context cache so first question has full data immediately
    try {
      const ctxResp = await axios.get(
        `http://${HOST}:${PORT}${CTX_PATH}?sessionId=${encodeURIComponent(sid)}&level=detailed`,
        { timeout: 10000 }
      );
      const ctx = ctxResp.data?.context || null;
      if (ctx) {
        _cachedContext = ctx;
        printLine(d(`  [MB] context pre-warmed (${ctx.length.toLocaleString()} chars)`));
      }
    } catch (_) {
      // Context pre-warm failed — non-fatal, will fetch on first question
    }
    return true;
  } catch (_) {
    return false;
  }
}

// ── SSE reconnect guard — prevents multiple parallel loops ──────────────────
// When a connection drops, Node.js can fire res.on('error') + req.on('error')
// on the same socket drop — two simultaneous setTimeout(connectSSE) calls.
// After N drops this multiplies into 2^N live loops, each adding listeners.
// This guard ensures exactly one reconnect can be pending at any time.
let _sseReconnectPending = false;

function scheduleSSEReconnect() {
  if (_sseReconnectPending) return;
  _sseReconnectPending = true;
  setTimeout(() => {
    _sseReconnectPending = false;
    connectSSE();
  }, RECONNECT_MS);
}

// ── SSE client ─────────────────────────────────────────────────────────────────
function connectSSE() {
  printLine(d(`  [SSE] connecting to http://${HOST}:${PORT}${SSE_PATH} …`));

  const req = http.get(
    { host: HOST, port: PORT, path: SSE_PATH, headers: { Accept: 'text/event-stream' } },
    res => {
      req.socket.setTimeout(0);
      req.socket.setNoDelay(true);

      if (res.statusCode !== 200) {
        printLine(a(`  [SSE] HTTP ${res.statusCode} — retry in ${RECONNECT_MS}ms`));
        res.resume();
        scheduleSSEReconnect();
        return;
      }

      res.setEncoding('utf8');
      let _buf = '';

      res.on('data', chunk => {
        _buf += chunk;
        const parts = _buf.split('\n\n');
        _buf = parts.pop();
        for (const block of parts) {
          for (const line of block.split('\n')) {
            if (!line.startsWith('data:')) continue;
            let p;
            try { p = JSON.parse(line.slice(5).trim()); }
            catch (_) { continue; }

            if (p.type === 'narrator_error') {
              // Hard narrator failure — no turn event was emitted; store as special marker in buffer
              _turnBuffer.push(p);
              if (_turnBuffer.length > TURN_BUFFER) _turnBuffer.shift();
              printLine(r(`  [T-${p.turn}] NARRATION FAILED (${p.kind || 'error'}): ${p.message || '—'}`));
              continue;
            }

            if (p.type === 'turn') {
              _turnBuffer.push(p);
              if (_turnBuffer.length > TURN_BUFFER) _turnBuffer.shift();
              if (p.gameSessionId) {
                const wasNull = !_activeSessionId;
                _activeSessionId = p.gameSessionId;
                // If bootstrap hadn't run yet (no cached context), pre-warm now
                if (wasNull && !_cachedContext) {
                  axios.get(
                    `http://${HOST}:${PORT}${CTX_PATH}?sessionId=${encodeURIComponent(_activeSessionId)}&level=detailed`,
                    { timeout: 10000 }
                  ).then(r => {
                    const ctx = r.data?.context || null;
                    if (ctx) _cachedContext = ctx;
                  }).catch(() => {});
                }
              }
              printTurnStatus(p);
              // Auto-refresh session stats on every turn (visible without typing anything)
              if (_mbSession.calls > 0) {
                const _histTokT = Math.round(_history.reduce((s, m) => s + m.content.length, 0) / 4);
                const _histDepT = Math.floor(_history.length / 2);
                printLine(d(`  [MB] ${_mbSession.calls} calls  ${_mbSession.total_tokens.toLocaleString()} tok  ~$${_mbSession.est_cost_usd.toFixed(4)}  |  history: ${_histDepT} ex (~${_histTokT.toLocaleString()} tok)`));
              }
              continue;
            }

            if (p.type === 'arbiter_verdict') {
              // Patch matching turn buffer entry with arbiter data for flight recorder display
              const _arbEntry = _turnBuffer.find(t => t.turn === p.turn);
              if (_arbEntry) {
                _arbEntry._arbiter = {
                  changes: p.reputation_changes || [],
                  error: p.error || null
                };
              }
              continue;
            }

            if (p.type === 'lifecycle') {
              if (p.event === 'online') {
                printLine(g(`  ── ENGINE ONLINE  port:${p.port}  session:${p.sessionId || '—'} ──`));
              } else if (p.event === 'offline') {
                printLine(a(`  ── ENGINE OFFLINE  ${p.reason || '?'} ──`));
              }
              continue;
            }
          }
        }
      });

      res.on('end', () => {
        printLine(a('  [SSE] stream ended — reconnecting …'));
        scheduleSSEReconnect();
      });

      res.on('error', err => {
        printLine(a(`  [SSE] error: ${err.message} — reconnecting …`));
        scheduleSSEReconnect();
      });
    }
  );

  req.on('error', err => {
    printLine(d(`  [SSE] offline (${err.message}) — retry in ${RECONNECT_MS}ms`));
    scheduleSSEReconnect();
  });

  req.end();
}

// ── Readline line handler — paste-debounced ────────────────────────────────────
// Lines arriving within PASTE_WINDOW_MS of each other are buffered and joined
// into a single message. Manual Enter fires after the same small pause.
const PASTE_WINDOW_MS = 60;
let _pasteBuffer = [];
let _pasteTimer  = null;

function flushPaste() {
  _pasteTimer = null;
  const input = _pasteBuffer.join('\n').trim();
  _pasteBuffer = [];
  if (!input) { prompt(); return; }
  if (input === '/clear') {
    _history = [];
    printLine(hr());
    printLine(g('  Conversation cleared.') + d('  (Turn buffer retained — engine history preserved.)'));
    printLine(hr());
    prompt();
    return;
  }
  if (input === '/copy') {
    if (!_lastExchange) {
      printLine(d('  [MB] Nothing to copy yet — no exchange in this session.'));
      prompt();
      return;
    }
    const text = `You: ${_lastExchange.question}\n\nMother Brain:\n${_lastExchange.answer}\n`;
    const proc = spawn('clip');
    proc.stdin.write(text, 'utf8');
    proc.stdin.end();
    proc.on('close', code => {
      printLine(d(`  [MB] Last exchange copied to clipboard.`));
      prompt();
    });
    proc.on('error', err => {
      printLine(r(`  [MB] Clipboard copy failed: ${err.message}`));
      prompt();
    });
    return;
  }
  if (input === '/stats') {
    const _histDepS = Math.floor(_history.length / 2);
    const _histTokS = Math.round(_history.reduce((s, m) => s + m.content.length, 0) / 4);
    printLine(hr());
    printLine(d('  MB SESSION STATS'));
    if (_mbSession.calls === 0) {
      printLine(d('  No calls made yet this session.'));
    } else {
      printLine(d(`  calls:         ${_mbSession.calls}`));
      printLine(d(`  total tokens:  ${_mbSession.total_tokens.toLocaleString()}`));
      printLine(d(`  prompt:        ${_mbSession.prompt_tokens.toLocaleString()}`));
      printLine(d(`  output:        ${_mbSession.completion_tokens.toLocaleString()}`));
      printLine(d(`  cache hits:    ${_mbSession.cache_hit_tokens.toLocaleString()}`));
      printLine(d(`  est. cost:     ~$${_mbSession.est_cost_usd.toFixed(6)}`));
      if (_mbCallHistory.length > 0) {
        printLine(d('  per-call (oldest -> newest):'));
        for (const e of _mbCallHistory) {
          const _hitP = e.prompt_tokens > 0 ? `  ${Math.round((e.cache_hit_tokens / e.prompt_tokens) * 100)}% hit` : '';
          printLine(d(`    call ${e.call_num}:  ${e.total_tokens.toLocaleString()} tok${_hitP}  ~$${e.est_cost_usd.toFixed(6)}`));
        }
      }
    }
    printLine(d(`  history depth: ${_histDepS} exchanges (~${_histTokS.toLocaleString()} tok estimated)`));
    printLine(hr());
    prompt();
    return;
  }
  askMotherBrain(input);
}

rl.on('line', line => {
  _pasteBuffer.push(line);
  if (_pasteTimer) clearTimeout(_pasteTimer);
  _pasteTimer = setTimeout(flushPaste, PASTE_WINDOW_MS);
});

rl.on('close', () => {
  process.stdout.write('\n' + g('  Mother Brain offline.') + '\n');
  process.exit(0);
});

// ── Startup banner ─────────────────────────────────────────────────────────────
function banner() {
  const border = `${GRN}${B}${'═'.repeat(W())}${R}`;
  const titleText = ` MOTHER BRAIN  v${MB_VERSION} `;
  const titlePad  = ' '.repeat(Math.max(0, W() - titleText.length));
  process.stdout.write(border + '\n');
  process.stdout.write(`${GRN}${B}${titleText}${titlePad}${R}\n`);
  process.stdout.write(border + '\n');
  process.stdout.write('\n');
  process.stdout.write(g('  Version History\n'));
  for (const h of MB_VERSION_HISTORY) {
    process.stdout.write(g(`    ${h.version}  ${h.date}`) + d(`  — ${h.note}`) + '\n');
  }
  process.stdout.write('\n');
  process.stdout.write(d('  Type a question and press Enter. Type /clear to reset conversation. Ctrl+C to exit.\n'));
  process.stdout.write('\n');
}

// ── Boot ───────────────────────────────────────────────────────────────────────
process.stdout.write(`\x1b]0;MOTHER BRAIN v${MB_VERSION}\x07`);
banner();
connectSSE();
prompt();

// Attempt to bootstrap session + pre-warm context immediately on startup.
// Retries silently every RECONNECT_MS until a session is found.
// Aborts if SSE already delivered _activeSessionId — they race each other.
(async function tryBootstrap() {
  if (_activeSessionId) return; // SSE beat us to it
  const found = await bootstrapSession();
  if (!found && !_activeSessionId) setTimeout(tryBootstrap, RECONNECT_MS);
})();
