/**
 * motherbrain.js — Mother Brain v8.0.6
 * Intelligent terminal coprocessor for the Dungeon Master game engine.
 * Monitors engine state via SSE, maintains a rolling conversation with DeepSeek,
 * and provides authoritative real-time analysis to the developer.
 *
 * Launch via: StartMotherBrain.bat (sets DEEPSEEK_API_KEY before starting)
 */

'use strict';

const http     = require('http');
const https    = require('https');
const axios    = require('axios');
const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const {
  MotherBrainController,
  isObservedDeepSeekContextLengthError,
} = require('./motherbrain-controller');
const {
  createMotherBrainTui,
  copyToWindowsClipboard,
} = require('./motherbrain-tui');

// Runtime-only .env loading. Importing this module must not read files or boot Mother.
function loadRuntimeEnvironment(env = process.env, fileSystem = fs) {
  try {
    fileSystem.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n').forEach(line => {
      const m = line.match(/^([^#=\s][^=]*?)=(.*)$/);
      if (m) { const k = m[1].trim(), v = m[2].trim(); if (k && !env[k]) env[k] = v; }
    });
  } catch (_) {}
}

// Dedicated HTTP agent for executeToolCall — keepAlive:false so each localhost
// diagnostic request closes its socket immediately, preventing listener accumulation
// on http.globalAgent across multi-call tool chains.
const _toolHttpAgent = new http.Agent({ keepAlive: false });

// Dedicated HTTP agent for the SSE connection — keepAlive:true to maintain the
// persistent stream. Isolated from _toolHttpAgent so tool requests never share
// a socket with the SSE stream (prevents cross-attachment of error listeners).
const _sseHttpAgent = new http.Agent({ keepAlive: true });

// Dedicated HTTPS agent for DeepSeek API calls — same rationale: keepAlive:false
// closes each TLS socket after the response, preventing error-listener accumulation
// on the global HTTPS agent across multi-round tool chains.
const _deepseekHttpsAgent = new https.Agent({ keepAlive: false });

// ── Default per-tool-result truncation limit, in characters. Shared default only —
// any call site may assign a different local limit instead without affecting others. ──
const DEFAULT_TOOL_RESULT_LIMIT = 64000;

// ── Mother Brain version (independent of game engine version) ─────────────────
const MB_VERSION = '8.0.6';
// MB v8.0.6 (July 2026): Patch — double the shared tool-result truncation limit from 32000 to 64000 chars via a new DEFAULT_TOOL_RESULT_LIMIT constant, replacing scattered hardcoded literals across 10 runtime call sites (get_source_slice, search_source, harness_run_scenario, harness_read_result, read_probe_results success/catch paths, github_get_commit, github_get_file, github_compare, get_payload) and 3 SYSTEM_PROMPT prose mentions (now real ${DEFAULT_TOOL_RESULT_LIMIT} interpolation, verified to actually render "64000" rather than print literally). One historical v6.1.0 changelog mention of 32000 and the unrelated pre-existing 60000 runs.jsonl pagination override were deliberately left untouched. Both boundaries proven deterministically by mocking response size: a ~40000-char result now arrives intact (old 32K ceiling confirmed gone), a ~70000-char result truncates to exactly 64000 chars with the correct notice. Deliberately updated EXECUTOR_BODY_BASELINE_SHA256 in tests/motherbrain-controller.test.cjs after confirming via git diff the drift was exactly this change; MB_TOOLS_BASELINE_SHA256 was unaffected since none of these edits fall inside the MB_TOOLS array. MB_VERSION 8.0.5 -> 8.0.6.
// MB v8.0.5 (July 2026): Patch — batch prompt-doctrine correction from the forensic audit (commit 0f20725) plus Mother/Bridge source-visibility expansion. Doctrine fixes: ObjectOperationResolver source guide (exports both TAKE and DROP resolvers, plus the deterministic resolveCurrentGround Ground helper, distinct from the two evidence resolvers), P1b scope (partial-stack TAKE and single-action DROP, not TAKE-only), P4 doctrine (three separate verdicts -- AP refusal, downstream execution, final ORS state -- scoped to only the operation families TlsObjectOperationExecutor actually accepts), diagnostics session-scope doctrine (explicit-session vs last-active-session vs global, replacing a false "no per-session querying" claim), capability boundaries (named tool classes instead of a blanket "cannot execute/write/command" prohibition contradicted elsewhere in the same prompt), SemanticParser internals (real signature, cache-key composition, model config), diagnostics auth doctrine (exact per-route disabled/unauthorized/forbidden codes, replacing a wrong "401 on missing key" claim). Also fixed a genuine diagnostics defect surfaced during this pass: GET /diagnostics/context required and echoed a sessionId but read _lastGameState regardless, so it could silently return a different session's state under the caller's session label -- now resolves the supplied sessionId through getSessionStates() and returns session_not_found when it does not exist. Source-visibility: added ObjectOperationBridge.js, motherbrain-controller.js, motherbrain-tui.js, scripts/motherbrain-tui-smoke.cjs, scripts/motherbrain-v4-smoke.cjs, and tests/motherbrain-controller.test.cjs to the backend source allowlist and both prompt-side allowed-file descriptions, with new SOURCE FILE GUIDE entries for the three runtime modules -- ObjectOperationBridge.js's entry is explicit that it only returns routing guidance (rc_skip_reason, narration_constraint); index.js is what actually skips Reality Check or injects the narrator constraint. MB_VERSION 8.0.4 -> 8.0.5.
// MB v8.0.4 (July 2026): Patch — fix whole-object TAKE authority-vocabulary ambiguity in SYSTEM_PROMPT (Pipeline A summary). Whole-object TAKE is AP-executed but the same call also writes gameState._tlsExecutionResult with executed_by:'tls' and ap_bypass.take_bypassed:true -- the prior ownership doctrine didn't account for this overlap. Corrected to teach that both _apExecutedTransfers and _tlsExecutionResult populating for one event is expected, not a contradiction; and separated four previously conflated facts -- AP refusal, downstream execution, AP-side execution, and final mutation/state correctness -- each requiring its own evidence rather than inferring one from another. Surfaced by an independent forensic prompt-vs-source audit (MBP-005), refined across four review rounds. MB_VERSION 8.0.3 -> 8.0.4.
// MB v8.0.3 (July 2026): Patch — fix partial_stack_comparison diagnostic tool: it silently accepted DROP turns despite being scoped to partial-stack TAKE only, producing a false "source_id_mismatch" verdict instead of recognizing the operation was out of scope. Added an operation_family guard in diagnostics.js's _buildPartialStackComparison that fails closed with the existing skipped_not_applicable verdict shape when tls_instruction_v1.operation_family !== 'take', before TAKE-shaped field extraction runs. Surfaced by watching Mother self-correct around the misleading verdict during a live regression test. No motherbrain.js prompt text changed by this fix. MB_VERSION 8.0.2 -> 8.0.3.
// MB v8.0.2 (July 2026): Patch — fix stale AP/TLS object-operation mutation-ownership doctrine in SYSTEM_PROMPT (Pipeline A summary, P2 doctrine, ActionProcessor.js SOURCE FILE GUIDE entry). Ownership was described as a single blanket rule; corrected to the actual verb- and shape-specific model (whole-object TAKE/THROW/REMOVE stay AP-executed; partial-stack TAKE and DROP of both shapes are AP-quarantined and executed via a separate index.js pipeline). Motivated by a live reasoning trace showing Mother relied on the stale text and had to self-correct against runtime evidence. MB_VERSION 8.0.1 -> 8.0.2.
// MB v8.0.1 (July 2026): Patch — add /copycot TUI-local command: copies the Activity pane's bounded plain-text projection (reasoning, round headers, tool calls/results, warnings) to the clipboard, exact to what is displayed and independent of scroll position or mouse selection. Handled entirely in motherbrain-tui.js as a _submitEditor() intercept before the controller round-trip; motherbrain-controller.js and COMMAND_REGISTRY are unchanged, so /copycot is TUI-native and not listed in /help. MB_VERSION 8.0.0 -> 8.0.1.
// MB v8.0.0 (July 2026): Major — DeepSeek V4 and full-screen TUI rebuild. Mother Brain is now split into an import-safe composition root, terminal-independent controller, and Terminal Kit TUI, with exact V4 reasoning/tool replay, durable history and settings, context budgeting, telemetry, guarded sequential tool dispatch, and the existing 38-tool authority boundary preserved. MB_VERSION 7.7.3 -> 8.0.0.
// MB v7.7.3 (July 2026): Patch — start_game sends x-mother-brain header for session TTL classification. MB_VERSION 7.7.2 -> 7.7.3.
// MB v7.7.1 (June 2026): Patch — P5-0 archive foundation awareness: get_turn_data tool description updated with p5_witness_archive field. MB_VERSION 7.7.0 -> 7.7.1.
// MB v7.7.0 (June 2026): Minor — Evidence Admissibility / Witness Integrity HARD RULE doctrine added to SYSTEM_PROMPT. Teaches Mother Brain that diagnostic claims require specific tool-call provenance, that inference/memory/reconstruction cannot support PASS, that truncated tool output is not observed, and that insufficient evidence is INCONCLUSIVE. MB_VERSION 7.6.1 -> 7.7.0.
// MB v7.6.1 (June 2026): Patch — adds Mother Brain awareness of the P4 tls_executor_dry_run diagnostic surface. MB_VERSION 7.6.0 -> 7.6.1.
// MB v7.6.0 (June 2026): Minor — partial_stack_comparison tool added to MB_TOOLS. Calls GET /diagnostics/turn/:sessionId/:turn/partial-stack-comparison endpoint. Observe-only, post-hoc, single-action partial-stack TAKE only. Supports compact/detailed/raw expansion modes. MB_VERSION 7.5.2 -> 7.6.0.
// MB v7.5.2 (June 2026): Patch — P3 comparison diagnostic tool added to MB_TOOLS (get_p3_comparison). Calls GET /diagnostics/turn/:sessionId/:turn/p3-comparison endpoint. Observe-only, post-hoc. MB_VERSION 7.5.1 -> 7.5.2.
// MB v7.4.0 (June 2026): Patch — VOLATILE DIAGNOSTIC SURFACES doctrine block added to SYSTEM_PROMPT after CLAIM ANNOTATION. Teaches Mother that get_witness is latest-only and overwritten each turn; get_turn_data(turn=N) is preferred for historical validation; overwritten diagnostics without archive access must be marked LOST / NOT DIRECTLY VERIFIED; reconstructed evidence must be labeled [RECONSTRUCTED from later state]; do not start a new game to recreate missing evidence unless explicitly instructed. MB_VERSION 7.3.0 -> 7.4.0.
// MB v7.3.0 (May 2026): TSL Stage 1 integration — SemanticNormalizer.js added to _SOURCE_ALLOWLIST (full source visibility); TSL SEMANTIC LAYER data source bullet added to SYSTEM_PROMPT (object_reality.tsl path, four sub-arrays, acquisition_ungrounded warning); TSL SEMANTIC LAYER INTERNALS block added (architecture, ENABLED rollback, provenance hard rule, cb-semantic-normalization branch note, Stage 2 preview); SemanticNormalizer.js added to SOURCE FILE GUIDE; node_check_semantic_normalizer added to run_validation _taskMap. MB_VERSION 7.2.5 -> 7.3.0.
// MB v7.1.2 (May 2026): SOURCE-ROOT VERIFICATION doctrine block added. Prevents a class of silently-inert code proposal: proposing a property path through a local alias that doesn't own the needed field (e.g. w.player when w = gameState.world and player is a sibling of world, not a child). Rule: before proposing any code change involving a nested property path, first identify the local variable root and its binding; if the needed data lives outside that root, use the original top-level object, not an invented child path. Block inserted after SOURCE CODE READ EFFICIENCY, before SOURCE FILE GUIDE. MB_VERSION 7.1.1 -> 7.1.2.
// MB v7.1.1 (May 2026): ACTION AUTHORING DISCIPLINE doctrine block added to GAMEPLAY TOOLS section. Defines the boundary between privileged engine access (diagnostic capability) and player action text (scene-authority surface). Privileged grid/entity knowledge may inform test design and navigation but must not appear in take_turn action text unless narratively established. Narrator pipeline treats player action text as potential scene truth; embedding unestablished entity claims is a contamination vector, not a test input. MB_VERSION 7.1.0 -> 7.1.1.
// MB v7.1.0 (May 2026): Doctrine enrichment — ARBITER INTERNALS, CONDITION BOT INTERNALS, SEMANTIC PARSER INTERNALS, NARRATOR PROMPT STRUCTURE INTERNALS, WORLDGEN INVESTIGATION GUIDE. Closes 5 MB knowledge blind spots identified in self-assessment.
// MB v7.0.0 (May 2026): Major — reasoning discipline upgrade. Four doctrine blocks added to SYSTEM_PROMPT. (1) CONTAINER REFERENCE ARCHITECTURE: documents the active_site vs world.sites reference split at L2 depth — active_site.local_spaces[shortKey]._generated_interior is the ORS write target; world.sites may lag; never conclude a push failed without reading _resolveContainerIds for the container type. (2) OBJECT REALITY INVESTIGATION RULES: write-path rule (verify which reference _resolveContainerIds writes before claiming object_ids[] was not updated); transfer evidence rule (cb_transfers:[] means no transfer was attempted; failed transfers always appear in object_errors; never state a transfer attempt without citing a specific audit entry). (3) CLAIM ANNOTATION: all investigation output must annotate conclusions as [OBSERVED], [INFERRED], or [VERIFIED via source]; [INFERRED] that conflicts with [VERIFIED via source] must be retracted; system is required not optional. (4) SOURCE CODE READ EFFICIENCY: use search_source to locate exact line before calling get_source_slice; read tight 10–20 line windows; explicitly state which paths were already confirmed in prior reads and only re-read when that earlier reading is now in question. Root cause: Einstein investigation chain forensic comparison revealed overconfident inference (orphaned-teacup false conclusion), unlabeled inference presented as fact, blind recursive re-verification overhead, and the active_site/world.sites architectural blind spot. MB_VERSION 6.1.2 -> 7.0.0.
// MB v6.1.2 (May 2026): Patch — fix query_objects container_type schema. Parameter description updated from "One of: player, npc, cell" to full enumerated list with explicit use-when guidance: player, npc, grid (LOC:... cell keys), localspace (site_.../l2_ls_... IDs), site, npc_worn, player_worn. "Do NOT use 'cell'" directive added. Tool-level description: removed contradictory NOTE about grid vs cell; added localspace floor to use-when list. Root cause: Mother used wrong or missing container_type values when querying post-transfer object state, causing repeated empty-result confusion loops. No server changes, no engine changes. MB_VERSION 6.1.1 -> 6.1.2.
// MB v6.1.1 (May 2026): Patch — .env loader guard fixed: changed !(k in process.env) to !process.env[k] so Windows environment variables set to empty string do not block .env values from loading. Root cause: GITHUB_PAT present but empty in Windows env caused PAT to read as empty string despite correct .env file. No tool changes, no prompt changes, no behavior changes. MB_VERSION 6.1.0 -> 6.1.1.
// MB v6.1.0 (May 2026): Minor — GitHub read-only integration. Five SESSION_FREE tools added to MB_TOOLS: github_list_commits, github_get_commit, github_get_file, github_compare, github_search_code. All call the GitHub REST API (https://api.github.com/repos/mdunham726-coder/Game-main) with a PAT loaded from .env (GITHUB_PAT). Inline .env loader added to motherbrain.js startup (same pattern as index.js). GITHUB_PAT constant added after DEEPSEEK_KEY. _githubApiError() helper maps Axios HTTP errors to structured JSON (github_not_found, github_auth_failed, github_rate_limited, github_unprocessable, github_unreachable) — each tool has its own try/catch calling this helper. diff endpoints use Accept: application/vnd.github.v3.diff; search uses text-match+json for fragments. All responses truncated at 32000 chars. GITHUB TOOLS paragraph added to SYSTEM_PROMPT. No index.js changes, no server routes, no write-capable tools. MB_VERSION 6.0.38 -> 6.1.0.
// MB v6.0.16 (May 2026): Patch -- Fix dead world.current_cell at L0. (1) ActionProcessor.js: added getL0Cell(state) helper (3-line, module-internal) that derives the current L0 cell from state.world.position + state.world.cells map using the canonical LOC:\,\:\,\ key formula already used by ORS grid resolution (~line 920). (2) getCellEntities: replaced (state.world.current_cell)||{} with getL0Cell(state)|{}. (3) resolveCellItemByName env feature resolution (_envLocRec fallback chain): replaced state.world.current_cell with getL0Cell(state) -- L0 environment feature gathers now resolve correctly; prior L2/L1 fallbacks (active_local_space/active_site) unchanged. (4) resolveSiteByName: replaced state.world.current_cell with getL0Cell(state) -- examine [site name] at L0 no longer returns TARGET_NOT_VISIBLE. (5) index.js _environmentGatherBlock: branched on featureValue -- when populated uses existing engine-established text (POSSESSION RULE lifted); when null (synthetic path) uses new text stating item not confirmed as scene feature, narrate by plausibility -- narrator never again receives 'engine: null'. node --check clean on both files. Package v1.87.7. MB_VERSION 6.0.15 -> 6.0.16.
// MB v6.0.15 (May 2026): Patch -- Authority Gate / RC split-brain bypass closed (Phase A + B). Phase A: (1) _rcValidationClause escape hatch reanchored to 'a DISCOVERY RESULT block in this prompt explicitly establishes them as found' -- structurally inert until engine emits the block, mechanic concept preserved. (2) test-harness.js no_new_objects op path corrected from narration_debug?.object_reality to top-level turn_history[last].object_reality; evidence field corrected from or.error_entries.length to or.errors. Phase B MVP: (1) _discoveryResultBlock IIFE declared after _rcSuffix -- fires on established_trait_action turns, MVP always emits not_found verdict; _discoveryResultDebug tracks fired+outcome. (2) _discoveryResultBlock injected into RC query before question text. (3) _freeformBlock for established_trait_action updated: DISCOVERY RESULT block is the authoritative engine verdict -- follow it; do not narrate discoveries beyond what it confirms. (4) _discoveryResultBlock injected into narrator prompt concat before _realityAnchorBlock. (5) narration_debug.discovery_result added: fired + outcome fields. Regression scenario authority_gate_established_trait_bypass: T1 PASS + T2 PASS (promoted:0 transferred:0 errors:0). MB_VERSION 6.0.14 -> 6.0.15.
// MB v6.0.14 (May 2026): Patch -- Authority Gate / RC split-brain fix. (1) index.js RC skip chain: added else-if for _authorityGateResult?.rc_allowed===false -> _rcSkippedReason='authority_gate_no_rc'; gate's allow_no_rc verdict now honored by the RC pipeline (previously only freeform was checked). (2) _rcValidationClause strengthened: added second sentence blocking world-fact/object confirmation even when the relevant ability IS present in established attrs (leaves room for future allowed discovery mechanics). (3) _freeformBlock for established_trait_action: replaced unconditional 'Follow the Reality Check result above' with conditional -- if RC was generated follow it; if not, narrate attempt from engine state without confirming new objects or world facts. (4) authoritygate.js SYSTEM_PROMPT: added DISCOVERY FRAMING rule (with pattern phrases, no object examples) -- discovery-framed language asserting new scene elements is claimed_ability_use or unsupported_world_authoring, not valid_low_risk. (5) tests/probes/authority-gate-bypass-v1.probe.json deleted -- misdesigned (sent combined founding+bypass as single Turn-1 input; Turn-1 is founding phase, always accepted; probe was not testing post-founding bypass). Regression test: authority_gate_established_trait_bypass scenario. MB_VERSION 6.0.13 -> 6.0.14.
// MB v6.0.13 (May 2026): Patch -- Harness assertion operators. test-harness.js evalRule gains narration_includes (case-insensitive substring check on response.narrative; requires value field; validateScenario guards missing value) and no_new_objects (reads narration_debug.object_reality.promoted from last turn_history entry; passes if promoted==0; no extra fields required). SYSTEM_PROMPT ASSERTION OPERATORS paragraph added to SCENARIO AUTHORING section -- full table of all 15 ops with fields, semantics, and worldgen_seeded safety warning for narration_includes. MB_VERSION 6.0.12 -> 6.0.13.
// MB v6.0.12 (May 2026): Patch -- Authority Gate live panel. Index.html: #authorityGatePanel div inserted between #statusRow and #continuityPanel (gold/amber border #d4ac0d). renderAuthorityGatePanel(data) function reads narration_debug.authority_gate from last turn; renders status row (decision/route/rc_allowed/layer_1_match color-coded), detail block (reason_code/input_type/parsed_action/llm_called+confidence/duration_ms/evidence_supported/refs), Turn 1 bypass note, RC skip notice. Called alongside renderContinuityPanel() on every turn. MB_VERSION 6.0.11 -> 6.0.12.
// MB v6.0.11 (May 2026): Patch -- Authority Gate observability. gate_fast_path_hit + llm_confidence fields added to gate return contract; narration_debug.authority_gate expanded to 13 fields (adds: input_type, gate_fast_path_hit, llm_confidence, parsed_action, authority_gate_duration_ms); authoritygate.js SYSTEM_PROMPT schema adds confidence field; fail-open paths (gate_failopen_*) now carry gate_fast_path_hit:false (Layer 2 was attempted or bypassed, not Layer 1 claimed); Turn 1 synthetic result in index.js also carries gate_fast_path_hit:false (gate bypassed entirely); SSE complete event carries decision+rc_allowed; loading bar appends (RC skipped) when rc_allowed:false; copyRealityCheckSnapshot includes full 14-field authority_gate block; buildTurnBlock adds Authority Gate section to narration debug output; SYSTEM_PROMPT AUTHORITY GATE section rewritten with full diagnostic contract including field semantics, failure taxonomy, investigation paths, and deferred fast_path_rule gap. MB_VERSION 6.0.10 -> 6.0.11.
// MB v6.0.10 (May 16, 2026): Patch -- Authority Gate v1. New pre-RC routing layer (authoritygate.js): classifies player input into allow_rc / allow_no_rc / freeform before Reality Check fires. Layer 1 fast-path rules handle move/look/wait/enter/exit (allow_no_rc), attack (allow_rc), object-verb actions with confirmed existence check (allow_no_rc), meta-authority keywords without declared ability (freeform), and structural emote world-event pattern (freeform). Layer 2 LLM classifier (temp 0.1, max_tokens 300) handles semantically ambiguous escalations including state_claim and unknown parsedActions. Object existence checks use existing AP helpers only (aliasScore, resolveItemByName, resolveCellItemByName) -- no parallel lookup. Turn 1 founding capture pipeline fully preserved (gate skips itself, emits skip stage). Fail-open on LLM error and parse failure. index.js: require(authoritygate) added; gate call inserted after _parsedAction derivation; deny sets _rcSkippedReason=authority_gate_deny before existing RC skip block; _authorityGateBlock assembled in narrator section (index.js owns all prose translation, authoritygate.js emits JSON only); authority_gate field added to narration_debug. Index.html: authority_gate stage added to _STAGES between fill and reality_check (weight:5). Harness: authority_gate_basic.json + authority_gate_passthrough.json scenarios. SYSTEM_PROMPT: AUTHORITY GATE section added. MB_VERSION 6.0.9 -> 6.0.10.
// MB v6.0.9 (May 15, 2026): Patch -- fix 8 continuity probe design weaknesses. (1) computeMetrics continuity_block_chars fallback: when activeSite is not a number, falls back to dotGet(response, 'debug.narration_debug.continuity_block_chars') -- post_extract no longer required for this metric. (2) index.js GET /diagnostics/turn/latest?sessionId=X: new endpoint returns the most-recent turn without a turn number in the path; compatible with probe-runner post_extract query-string pattern. (3) env-continuity-dedup-v2.probe.json: replaces broken v1 -- correct extract path (debug.narration_debug), no post_extract, metrics: [continuity_block_chars], warn_above:1500/fail_above:3000, 5 biome archetypes. (4) env-continuity-bloat-v2.probe.json: replaces broken v1 -- same extract/metric fixes, fixed founding prompt, tighter warn_above:1200/fail_above:2500. (5) env_continuity_bloat_walk.json scenario: 8-turn walk, Turns 2-8 assert continuity_block_chars < 2500 (catastrophic regression detector; tighten after first baseline run). (6) probe-metrics.js comment corrected: continuity_block_chars does not require post_extract. Root causes of all 8 weaknesses documented in version history. MB_VERSION 6.0.8 -> 6.0.9.
// MB v6.0.8 (May 15, 2026): Patch -- three fixes. (1) create_scenario_file double-encoding guard: DeepSeek serializes tool call object arguments as JSON strings; added one-line parse guard (if args.scenario is a string, attempt JSON.parse before the typeof check) -- mirrors identical fix in create_probe_spec from v6.0.4. (2) continuity_block_chars metric: registered in scripts/probe-metrics.js METRIC_NAMES; computeMetrics case added to scripts/probe-runner.js -- reads activeSite as a number (post_extract.extract resolves to debug.narration_debug.continuity_block_chars which is a plain number, not an object); metric returns null if activeSite is not a number. Enables probe specs to measure env dedup effectiveness without fake affordance. (3) FILE VERSIONING RULE added to SYSTEM_PROMPT: never overwrite existing scenario or probe file; write_file must not use overwrite:true on existing files; use _v2/_v3 suffix for revisions; developer consolidates. Rule unconditional. MB_VERSION 6.0.7 -> 6.0.8.
// MB v6.0.7 (May 15, 2026): Patch -- attach_session wrong-session fix. Root cause: /diagnostics/session returned _lastSessionId (a single global set by ANY POST /narrate). When a probe run or second browser tab posted after the real game session, attach_session() would attach to that wrong session and all get_turn_data calls would 404 (turn_not_found -- turns exist in a different session). Fix: index.js /diagnostics/session now iterates the full sessionStates Map and returns sessions[] sorted by total_turns desc. attach_session auto-detect picks sessions[0] (most turns, > 0) instead of _lastSessionId. Probe sessions have 1-5 turns; real game sessions have more -- reliable discriminator. Sessions[] returned in tool response so MB can see all candidates. Fallback to _lastSessionId if sessions[] absent (old server). SYSTEM_PROMPT TOOL ERROR HANDLING updated with multi-session selection behavior and explicit {session_id} override guidance. MB_VERSION 6.0.6 -> 6.0.7.
// MB v6.0.5 (May 14, 2026): Patch -- attach_session tool. Allows Mother Brain to attach to an existing live session (e.g. browser session) without starting a new one. Auto-detect mode calls GET /diagnostics/session (returns _lastSessionId -- updated every /narrate call). Manual mode accepts session_id directly. Once attached, all diagnostic tools (get_turn_data, get_payload, inspect_entity, query_objects, etc.) work normally. SESSION_FREE (no active session required). SYSTEM_PROMPT CAPABILITY block updated: attach_session described and distinguished from start_game -- "do NOT use start_game to investigate a browser session; it would create a new session and destroy the existing one." MB_VERSION 6.0.4 -> 6.0.5.
// MB v6.0.4 (May 14, 2026): Patch -- create_probe_spec double-encoding fix. When DeepSeek serializes tool call arguments, the spec object gets double-encoded as a JSON string. Added one-line parse guard: if args.spec is a string, attempt JSON.parse() before the typeof check. create_probe_spec now tolerates both a parsed object (correct) and a JSON string (DeepSeek serialization artifact). Validation pipeline (metric enum, required fields, lifecycle, warnings) unchanged and now reachable via both paths. MB_VERSION 6.0.3 -> 6.0.4. Was keyed on _activeSessionId (set by any SSE turn event from any session -- browser, probe runner, bootstrap). Now keyed on _activeGameplayInvestigation (only set by start_game, cleared by end_game). [Game: Active] now correctly means "MB has a live gameplay investigation running" -- not "some session exists somewhere". MB_VERSION 6.0.2 -> 6.0.3. Documents logs/flight-recorder/YYYY-MM-DD/session_{id}.jsonl -- the new per-turn JSONL disk archive added in game v1.85.98. Tells Mother where to find it, what it contains (full turnObject), when to use it (cross-session queries, post-session forensics, history that survives server restart), and how to read it (read_file with relative path, parse line by line). MB_VERSION 6.0.1 -> 6.0.2. Corrects a systematic misread where MB inferred that v6 added an autonomous simulation loop to the engine itself. New block explicitly states: engine architecture, timing model, lifecycle, and pipeline are unchanged; v6 only gives Mother Brain the ability to submit player inputs as a test player; treat as "Mother now has a keyboard" not "the engine now plays itself.". MB_VERSION 6.0.0 -> 6.0.1.
// MB v6.0.0 (May 14, 2026): Major -- Autonomous gameplay loop. Four new tools: start_game (POST /narrate T1, sets _activeSessionId, no x-session-id header), take_turn (POST /narrate with active session), end_game (DELETE /session), update_investigation (local-only, no HTTP call, SESSION_FREE -- structured closure semantics). New module-scope var _activeGameplayInvestigation: {goal, hypothesis, expected_invariant, status, conclusion, started_at_game_turn, turns_taken, recent_actions[]}. Status enum: investigating/likely_confirmed/contradicted/inconclusive/reproduced/non_reproducible. Investigation block echoed in every take_turn response for drift prevention. _extractDiagSummary() private helper extracts confirmed authoritative_state fields from /diagnostics/turn response. sessionId never exposed in any tool response. force:true on start_game ends existing session first. GAMEPLAY TOOLS section added to SYSTEM_PROMPT: capability block, investigation context block, play doctrine, play report format. prompt() updated: [Game: Active]/[Game: ---] label added alongside [Harness: ...]. Loop: start_game -> take_turn -> inspect -> update_investigation -> take_turn or end_game. Mother transitions from reactive forensic analyst to active simulation investigator with closed-loop experimentation. MB_VERSION 5.1.1 -> 6.0.0.
// MB v5.1.1 (May 13, 2026): Patch -- Stage 2b localspace distribution probe. probe-metrics.js: 5 new metric names (ls_pct, eligible_tile_count, localspace_count, enterable_localspace_ratio, site_size). probe-runner.js: (1) $PROMPT placeholder -- prompt_cycle values now substitute into any template field containing "$PROMPT" (in addition to existing action override); backward-compatible. (2) httpGet helper added after httpPost. (3) post_extract spec field: after POST /narrate, runner does secondary GET to session-scoped diagnostics endpoint and extracts activeSite for localspace metrics; on failure = hard error. (4) computeMetrics gains 5th param activeSite (default null) + 5 new switch cases. (5) run summary line extended with ls_pct/ls_count/eligible_tiles. (6) validateSpec: post_extract validated when present. tests/probes/localspace-distribution.probe.json: new probe spec (5 L2 prompt_cycle entries, post_extract -> diagnostics/sites active_site, all 5 new metrics, percentile_metrics + warnings). run_validation: run_probe_localspace task added. METRIC VOCABULARY: 5 new metric descriptions. MB_VERSION 5.1.0 -> 5.1.1.
// MB v5.1.0 (May 13, 2026): Minor — Stage 2a localspace density harness. (1) index.js /diagnostics/sites response: exposed ls_pct and eligible_tile_count on active_site object (fields were persisted on gameState.world.active_site since 1.85.94 but not copied into the HTTP response). (2) Created tests/scenarios/ directory (harness SCENARIO_REGISTRY auto-loads from it). (3) Created tests/scenarios/localspace_density_basic.json: 2-turn L2-start scenario -- T1 'look around' asserts no_error; T2 __GET_SESSION /diagnostics/sites asserts active_site.ls_pct in [30,75], eligible_tile_count > 0, local_spaces array_len_gt 0. No world_seed -- intentional, fresh random seed per run confirms real RNG variance. stability:stable. MB_VERSION 5.0.9 -> 5.1.0.
// MB v5.0.9 (May 13, 2026): Patch — Localspace generation observability. WorldGen.js generateL2Site() return now includes ls_pct (generation-time localspace density %, 30-75) and eligible_tile_count (non-street tile count used for density roll). Both fields persisted on the site record (active_site.ls_pct / active_site.eligible_tile_count) after enterSite(). local_space_count intentionally left derived (Object.keys(active_site.local_spaces).length). Enables probe/harness validation of localspace density distribution without reading ephemeral console.log. MB_VERSION 5.0.8 -> 5.0.9.
// MB v5.0.8 (May 13, 2026): Patch — Environment attribute cap. ContinuityBrain.js: added ENV_ATTR_WINDOW=20 constant. Location and NPC attribute assembly in assembleContinuityPacket() now sorts by turn_set desc and slices to 20 before joining. Prevents unbounded TRUTH block growth (60+ env variants after 10 turns in same room). Most-recent 20 facts retained; oldest dropped first. Same cap applied symmetrically to NPC attributes. No semantic dedup. MB_VERSION 5.0.7 -> 5.0.8.
// MB v5.0.7 (May 13, 2026): Patch — Semantic variant dedup two-layer fix. Phase A: ContinuityBrain.js TRACKED OBJECT NAMING RULE added after TRACKED OBJECTS injection — CB must reuse exact tracked object names in object_candidates (prevents name drift: "photo" -> "framed photo"). Phase B: ObjectHelper.js token-subset guard added as third dedup pass (after soft-match) — fires when BOTH shorter AND longer name are >=2 tokens and all shorter tokens appear in longer (catches multi-token compound variants: "framed photo" -> "small framed photo"). Single-token generics excluded via shorter-name >=2 guard. Audit action: promote_skipped_token_subset. MB_VERSION 5.0.6 -> 5.0.7.
// MB v5.0.6 (May 13, 2026): Patch — Server time relocated to stats footer. Removed [server time] line from before [thinking...] (fired before user saw output). Now printed as a dim line immediately after the session: stats line in the stats footer block, so it appears alongside cost/token summary after each completed exchange. MB_VERSION 5.0.5 -> 5.0.6.
// MB v5.0.5 (May 13, 2026): Patch — Cross-restart conversation history. Added HISTORY_PATH (logs/mb-history.json) and HISTORY_KEEP=5 constants. _saveHistory() persists last 5 exchanges (10 messages) to disk after every answer. _loadHistory() reads and restores history at startup (called after banner()); prints dim '[MB] Loaded N prior exchanges from disk.' confirmation. /clear now also wipes the file. History survives motherbrain.js restarts; /clear for a true clean slate. MB_VERSION 5.0.4 -> 5.0.5.
// MB v4.2.3: Patch — 4 spatial topology metrics added to probe framework. probe-metrics.js: added cell_occupancy_entropy (Shannon entropy of sites-per-cell distribution — key seed-sensitivity diagnostic), site_size_stddev (stddev of placed site sizes), community_ratio (fraction of is_community sites), isolated_cells_count (occupied cells with no 4-directional occupied neighbor). probe-runner.js: 4 new computeMetrics cases. worldgen-site-distribution-v3.probe.json: new spec with all 14 metrics + percentile_metrics on entropy/isolated. motherbrain.js: METRIC VOCABULARY updated to correct current names + new 4. MB_VERSION 4.2.2 -> 4.2.3.
// MB v4.2.2: Patch — durable probe logging + read_probe_results tool. probe-runner.js: main() now writes 4 files to tests/probe-results/<timestamp>_<slug>/: runs.jsonl (all runs, error+success), summary.json (aggregate stats), console.txt (full output), spec.snapshot.json. writeConsole() helper owns all output (no monkey-patch). motherbrain.js: added fs+path requires; read_probe_results tool (list folders or read file); SESSION_FREE_TOOLS extended; executeToolCall handler with path traversal guard; PROBE RESULTS LOCATION paragraph in SYSTEM_PROMPT. MB_VERSION 4.2.1 -> 4.2.2.
// MB v5.0.4 (May 13, 2026): Patch — ORS reconciliation observability. ObjectHelper.js: added reconciled counter (let reconciled = 0); increments only after ObjectRecord fully committed and one-container check passes (alongside promoted++, conditional on _priorRejection). Both return statements updated to include reconciled field. index.js: added reconciliation_count: 0 to _objectRealityDebug init; wired _ohResult.reconciled into _objectRealityDebug.reconciliation_count. Enables harness assertions on object_reality.reconciliation_count > 0 to verify RejectedCandidate cache reconciliation fired. game v1.85.90 -> v1.85.91.
// MB v5.0.3 (May 13, 2026): Patch — Phase 3: RejectedCandidate cache for origin-gate timing gap. index.js: on narrator_independent_player_blocked, write lightweight cache entry to gameState._rejectedCandidates (name, normalized, turn, reason, location_context). 5-turn expiry + location-context bound. ObjectHelper.js: before creating new ObjectRecord, check cache for prior rejection matching same normalized name + container_id. If found, annotate record with reconciled_from_rejection provenance. Grounded promotion is NOT suppressed — this is the first valid ObjectRecord. Anti-conjuration preserved, no retroactive possession, no duplicate inflation, audit trail added. Safe miss at L1 depth (null location_context), safe success at L2 depth. game v1.85.89 -> v1.85.90.
// MB v5.0.2 (May 13, 2026): Patch — Rename deterministic_reproduction category to worldgen_seeded. Updated VALID_CATEGORIES array and SYSTEM_PROMPT CATEGORY FIELD description to accurately reflect what the seed controls (world geometry only; LLM narration/extraction are non-deterministic). Updated semantic_duplicate_redescribe.json and hello_world_minimal.json category fields. Updated scenario description to document T-7 timing artifact and T-6/T-8/T-10 as the proof turns. MB_VERSION 5.0.1 -> 5.0.2.
// MB v5.0.1 (May 13, 2026): Patch — PERMISSION TO EDIT guardrail. Added hard rule to SYSTEM_PROMPT: write_file/patch_file require explicit developer permission (implement/patch/go ahead/fix it). Diagnosis, investigation, plan, and suggestion requests are explicitly NOT permission. Rule is unconditional -- not overridden by confidence or urgency. After proposing a plan, stop. MB_VERSION 5.0.0 -> 5.0.1.
// MB v5.0.0 (May 13, 2026): Major — Coder reasoning methodology. Added CODE EDITING METHODOLOGY paragraph to SYSTEM_PROMPT: 6-phase structured reasoning sequence (Discovery, Impact Mapping, Pattern Adoption, Minimal Footprint, Edit Execution, Dependency Check) + ROOT CAUSE FIRST + WHEN TO ASK + SUMMARY FORMULA (read -> map impact -> match existing pattern -> patch minimally -> validate -> report exact evidence). Teaches MB to reason like a disciplined engineer before touching any file. Major bump: shifts MB from diagnostic analyst who can edit files to a coder operating with a principled methodology. MB_VERSION 4.3.0 -> 5.0.0.
// MB v4.3.0 (May 13, 2026): Minor — File editing tools (write_file + patch_file). write_file: creates new files inside Game-main (fails if exists, overwrite:true to force); directory auto-created; path-traversal guard; SESSION_FREE. patch_file: exact old_string->new_string replacement in existing files; counts occurrences; fails on 0 matches (old_string_not_found) or 2+ without allow_multiple (ambiguous_match); index-based single replacement (safe from $-pattern issues); split+join for allow_multiple; path-traversal guard; SESSION_FREE. Both added to MB_TOOLS, SESSION_FREE_TOOLS, executeToolCall. FILE EDITING TOOLS paragraph in SYSTEM_PROMPT. MB_VERSION 4.2.5 -> 4.3.0.
// MB v4.2.5 (May 13, 2026): Patch — Silent tool set + server-local time display. Introduced _SILENT_TOOLS set (currently: harness_status) — tools in this set produce zero output (no reasoning, no [tool] line, no [synthesizing...]) while still executing and feeding results into the loop. Polling tools like harness_status now run invisibly until the run completes. Also: server-local time derived before [thinking...] so it can be displayed as a dim [server time] line on every call. MB_VERSION 4.2.4 -> 4.2.5.
// MB v4.2.4 (May 13, 2026): Patch — Server-local time injection. At each DeepSeek API call, a SERVER-LOCAL TIME block is appended to the system message content (not the static SYSTEM_PROMPT). Block includes day/date, HH:MM AM/PM, and time-of-day label (morning/afternoon/evening/night). Labeled "this machine only — not universal" to prevent universal-time misinterpretation. Derived from new Date() at call time, so value is fresh on every API call. MB_VERSION 4.2.3 -> 4.2.4.
// MB v4.2.1 (May 12, 2026): Patch — prompt_cycle support in probe runner. probe-runner.js: validateSpec() validates prompt_cycle as non-empty string array; run loop overrides request_template.action per run with prompt_cycle[i % length]; [RUN N] line includes prompt=N/M "label..." for readable 50-run baselines. motherbrain.js: create_probe_spec spec param updated with prompt_cycle field docs; PROBE SPEC PROMPT CYCLING paragraph added to SYSTEM_PROMPT. Probe specs + source allowlist gaps closed: scripts/probe-runner.js + scripts/probe-metrics.js added to _SOURCE_ALLOWLIST; tests/probes/ added to search_source global sweep; $SEED rule documented in tool param and SYSTEM_PROMPT. MB_VERSION 4.2.0 -> 4.2.1.
// MB v4.2.0 (May 12, 2026): Minor — Statistical probe doctrine. Added STATISTICAL PROBE SYSTEM paragraph to SYSTEM_PROMPT: measurement-vs-judgment separation (observe distributions, surface anomalies -- not declare pass/fail), PROBE vs SCENARIO distinction, metric vocabulary (10 approved names from probe-metrics.js), noise discipline rule (prefer few high-signal metrics), refinement ladder policy (1/5/10/50+ runs with explicit threshold discipline per rung), anti-coupling rule (prefer existing engine outputs over new instrumentation), probe authoring workflow (no autonomous creation). MB_VERSION 4.1.2 -> 4.2.0.
// MB v4.1.2 (May 12, 2026): Patch — Probe framework. Added probe-runner.js (generic stat probe engine), probe-metrics.js (metric enum + config requirements single source), worldgen-sites.probe.json (first probe spec). Added create_probe_spec tool to MB (writes .probe.json to tests/probes/, validates metric enum, metric config requirements, lifecycle, warning keys). Extended run_validation with probe_worldgen_sites_10, probe_worldgen_sites_50 named tasks and dynamic run_probe task (any .probe.json, spec_path+runs params, dynamic timeout). Added create_probe_spec to SESSION_FREE_TOOLS. MB can now author new statistical probe specs without human code changes. MB_VERSION 4.1.1 -> 4.1.2.
// MB v4.1.1 (May 12, 2026): Patch — call timing in stats footer. Added elapsed wall-clock time and round count to the bottom stats line. Captures Date.now() before the DeepSeek loop; stores elapsed_ms and rounds in _mbCallStats; displays as '14.3s' (or '1m 4.3s') appended to the 'this call:' line. Round count shown only when >1 (multi-tool-call exchanges). MB_VERSION 4.1.0 -> 4.1.1.
// MB v4.1.0 (May 12, 2026): Minor — Phase B: create_scenario_file tool. MB can now write new QA scenario JSON files to tests/scenarios/. Probe-first stability enforcement with explicit audit trail (requested_stability/written_stability/stability_forced). Signal-quality validation: duplicate assertion detection, low_signal warning for all-no_error scenarios. Name conflict hard block (scans existing files). Epistemic category field with enum validation (deterministic_reproduction/exploratory/ontology_stress/parser_fuzz/narrative_continuity/authority_test). No overwrite path. Added to MB_TOOLS, SESSION_FREE_TOOLS, executeToolCall branch, SCENARIO AUTHORING section in SYSTEM_PROMPT. MB_VERSION 4.0.16 -> 4.1.0. (New capability area: write authority — MB transitions from read-only analyst to regression-builder.)
// MB v4.0.16 (May 12, 2026): [superseded by 4.1.0 — same change set, minor bump applied retroactively]
// MB v4.0.15 (May 12, 2026): Patch — DEP0190 fix. Changed spawn call to pass full command string directly instead of split args array with shell:true. Eliminates Node.js DEP0190 deprecation warning (no shell injection surface since _taskMap is hardcoded). MB_VERSION 4.0.14 -> 4.0.15.
// MB v4.0.14 (May 12, 2026): Patch — run_validation streams output in real time. Replaced execSync with spawn wrapped in a Promise; stdout/stderr lines printed via printLine() as they arrive so every scenario result is visible immediately in the MB window. Timeout handled via setTimeout + child.kill('SIGKILL'). No more frozen window during long harness runs. MB_VERSION 4.0.13 -> 4.0.14.
// MB v4.0.13 (May 12, 2026): Patch — per-task timeout map in run_validation. syntax checks (node_check_*) timeout 15s; solo scenario runs timeout 90s; harness_sweep_a timeout 300s. Previously all tasks shared a flat 120s execSync timeout — sweep_a timed out after the 4th builtin scenario (~90s), JSON file scenarios never ran. MB_VERSION 4.0.12 -> 4.0.13.
// MB v4.0.12 (May 11, 2026): Patch — run_validation tool + --sweep flag. Added run_validation to MB_TOOLS: enum allowlist of 8 tasks (node_check_index, node_check_harness, node_check_mother, harness_<4 scenarios>, harness_sweep_a) mapped to fixed commands; execSync with 120s timeout, cwd=Game-main, no freeform input. Added to SESSION_FREE_TOOLS (bypasses no_session_active guard). Added executeToolCall branch. Added VALIDATION TOOL paragraph to SYSTEM_PROMPT: syntax check workflow, CLI-fallback vs harness_run_scenario lane guidance. test-harness.js: added --sweep A|P headless flag (filters SCENARIO_REGISTRY by sweep category using same formula as --list); harness_sweep_a task uses --sweep A --yes. MB_VERSION 4.0.11 -> 4.0.12.
// MB v4.0.11 (May 11, 2026): Patch — get_source_slice and search_source bypass no_session_active guard. executeToolCall early-return on !_activeSessionId was gating source tools behind a live session requirement even though /diagnostics/source and /diagnostics/source-search have no server-side session check. Added SESSION_FREE_TOOLS = [...HARNESS_TOOLS, 'get_source_slice', 'search_source'] — both tools now reachable without an active game session. Root cause: 29-byte {"error":"no_session_active"} was returned locally by MB before any HTTP call was made. MB_VERSION 4.0.10 -> 4.0.11.
// MB v4.0.10 (May 11, 2026): Patch — scenario JSON files accessible via get_source_slice + search_source. Tool description for get_source_slice corrected: 'Filename only (no path)' was wrong for scenario files — tests/scenarios/<name>.json requires the full relative path. Added scenario JSON pattern to tool function.description allowed list, file param description, and SYSTEM_PROMPT section 8. Source FILE GUIDE entry at line ~675 was already correct. MB_VERSION 4.0.9 -> 4.0.10.
// MB v4.0.9 (May 11, 2026): Patch — remove max_tokens cap entirely. Both DeepSeek API call sites in askMotherBrain() (primary + ECONNRESET retry) now omit max_tokens, letting the model use its full 8192-token output cap. MB_VERSION 4.0.8 -> 4.0.9.

// MB v4.0.6 (May 11, 2026): Patch — sweep field added to harness_list_scenarios response. test-harness.js --list output gains sweep ("A"|"P"|"manual") computed from stability + isolated_only; removes inference gap where isolated scenarios were mistaken as P-eligible. harness_list_scenarios tool description updated: sweep field added to field list, authoritative sentence added, isolated description no longer implies sweep. SCENARIO CATEGORIES SYSTEM_PROMPT updated: sweep is primary signal, do-not-infer rule added, all three values documented verbatim. MB_VERSION 4.0.5 -> 4.0.6.
// MB v4.0.5 (May 11, 2026): Patch — live registry enrichment + lean SYSTEM_PROMPT. test-harness.js --list output enriched with description, turns, isolated fields. harness_list_scenarios tool description updated to document all five fields. HARNESS CONTROL WORKFLOW replaced with SCENARIO CATEGORIES (stable/probe/isolated semantics) + SCENARIO TRUTH rule (call live tool, do not guess) + updated workflow (reads descriptions from list, probe failure guidance). MB_VERSION 4.0.4 -> 4.0.5.
// MB v4.0.4 (May 11, 2026): Patch — diagnostics source allowlist + SYSTEM_PROMPT update. Added test-harness.js to _SOURCE_ALLOWLIST in index.js (v1.85.53), enabling Mother Brain to read BUILTIN_SCENARIOS, evalRule(), runScenario(), GameClient, and SCENARIO_REGISTRY definitions directly via search_source/get_source_slice. Added test-harness.js entry to SYSTEM_PROMPT SOURCE FILE GUIDE. MB_VERSION 4.0.3 -> 4.0.4.

// MB v4.0.3 (May 11, 2026): Patch — fix MaxListenersExceededWarning root cause. bootstrapSession() retried every 1000ms at startup; both axios calls (GET /diagnostics/session and CTX pre-warm) were using the global http.Agent, allowing follow-redirects to accumulate error listeners on a reused socket across retries — triggering the warning after 11 retries. Added httpAgent: _toolHttpAgent (keepAlive:false) to both calls; each retry now uses a fresh socket, listeners never accumulate. Confirmed via node --trace-warnings stack trace pointing to RedirectableRequest.handleRequestSocket in follow-redirects. MB_VERSION 4.0.2 -> 4.0.3.

// MB v4.0.2 (May 11, 2026): Harness Authorization Model Rewrite. Replaced HTTP-probe-based _harnessStatus (null|'connected'|'offline') with explicit user-consent boolean _harnessAuthorized (starts false). Deleted _updateHarnessStatus() helper and both call sites (startup + SSE turn handler). prompt() updated to binary label: _harnessAuthorized ? [Harness: Connected] : [Harness: Offline]. Added harness_connect MB_TOOL (verifies /harness/status reachability then sets _harnessAuthorized=true, prompt redraws) and harness_disconnect MB_TOOL (sets _harnessAuthorized=false, prompt redraws). Both added to HARNESS_TOOLS bypass list. Gated existing 4 harness tools (harness_status, harness_list_scenarios, harness_run_scenario, harness_read_result) behind _harnessAuthorized check. Updated harness_run_scenario description (removed PERMISSION GATE language; Connected state = developer has granted authority). SYSTEM_PROMPT HARNESS CONTROL rewritten: six-tool model, Offline=no authority/no probing, connect flow (ask once -> harness_connect), Connected=execute without second approval, disconnect on request. MB_VERSION 4.0.1 -> 4.0.2.

// MB v4.0.1 (May 11, 2026): Patch — SSE agent isolation fix. Dedicated _sseHttpAgent (keepAlive:true) added for connectSSE(); _toolHttpAgent (keepAlive:false) retained for all tool/status HTTP calls. Prevents error-listener cross-attachment between the persistent SSE socket and short-lived tool request sockets — eliminates MaxListenersExceededWarning on startup. Context fetch in askMotherBrain() also patched to use _toolHttpAgent (was using global agent). MB_VERSION 4.0.0 -> 4.0.1.

// MB v4.0.0 (May 11, 2026): Major — Mother Brain Harness Integration (Milestone 1). QA harness now a first-class capability: Mother Brain can enumerate, run, and read QA scenarios through the game server. Added _harnessStatus module-level var (null|'connected'|'offline'). Added _updateHarnessStatus() async helper (calls GET /harness/status with DIAGNOSTICS_KEY auth). Called on startup and after each SSE turn event. prompt() now dynamically shows [Harness: Connected] (green) or [Harness: Offline] (amber) based on _harnessStatus. Added 4 new MB_TOOLS: harness_status, harness_list_scenarios, harness_run_scenario, harness_read_result. Added 4 executeToolCall branches (early-return pattern, bypass no_session_active guard for harness tools). Added HARNESS CONTROL paragraph to SYSTEM_PROMPT: permission gate (must ask "Proceed?" before run), secrets rule, workflow (status -> list -> ask -> run -> read_result -> summarize). index.js: added child_process.spawn require, _harnessRunning lock, _lastHarnessResult cache, MAX_MOTHER_RUNS=5, HARNESS_RESULT_PATH, HARNESS_SCENARIOS_DIR. Added GET /harness/status, GET /harness/scenarios, POST /harness/run (blocking spawn, lock, scenario name allowlist), GET /harness/result/last endpoints (all DIAGNOSTICS_KEY-gated). test-harness.js: added --list flag, --result-file flag, sessionId in runScenario() return. MB_VERSION 3.1.0 -> 4.0.0.

// Version history removed (v1.84.35) — not used by AI, no AI cost value. Refer to CHANGELOG.md.
// MB v3.0.4 (May 10, 2026): Runtime site & localspace inspection tooling. Added GET /diagnostics/site, GET /diagnostics/localspaces, GET /diagnostics/localspace, _findSiteRecord() helper. Added get_site, get_localspaces, get_localspace MB_TOOLS + executeToolCall branches. SYSTEM_PROMPT items 14/15/16 + TOOL ROUTING block. KNOWLEDGE TIERS updated. MB_VERSION 3.0.3 -> 3.0.4.
// MB v3.0.5 (May 10, 2026): Runtime inspection fixes (post-QA). Fix 1: get_localspace parent_site_id now uses interior_key directly (with /l2 suffix) — eliminates ontology inconsistency vs get_localspaces and inspect_active_site. Fix 2: get_site description falls back to cellSlot?.description when world.sites record has null — covers pre-fill-pipeline state. Fix 3: get_site NPC reporting overhaul — corrected n.npc_id (always undefined) to n.id; added floor/localspace NPC split (npc_count_total, npc_floor_count, npc_floor_ids, npc_localspace_count, npc_localspace_ids); retained npc_count as legacy alias; removed broken npc_ids field. SYSTEM_PROMPT item 14 NPC field list updated. MB_VERSION 3.0.4 -> 3.0.5.
// MB v3.0.6 (May 10, 2026): inspect_active_site description fallback. active_site.description in GET /diagnostics/sites now falls back to cellSites lookup (activeCellSlot?.description) when the runtime active_site copy has null — eliminates intra-response truth surface contradiction between active_site.description and cell_sites[0].description. Two helper vars (activeSiteCleanId, activeCellSlot) inserted before activeSite construction for readability. No MB_TOOLS changes. No SYSTEM_PROMPT changes. MB_VERSION 3.0.5 -> 3.0.6.
/*
  { version: '2.8.44', date: 'April 29, 2026', note: 'CONTEXT block stale-on-move suppression (v1.84.34): assembleContinuityPacket now compares _lastPhaseBLoc.locationRef against current w.position cell string before emitting CONTEXT — RECENT LOCATION. If they differ (player moved to a new cell), the block is suppressed entirely — prior-cell biome facts are misleading when the player is in a different cell and cost ~400 tokens. _lastPhaseBLoc = null moved outside the if block to clear the snapshot regardless of suppression (prevents next-turn bleed). Stationary turns unaffected — block fires normally when locationRef matches current cell. L1/L2 unaffected — _lastPhaseBLoc only populated at L0. CONTINUITY PACKET bullet updated. Package v1.84.34.' },
  { version: '2.8.43', date: 'April 29, 2026', note: 'birth_record canonicalization (v1.84.33): Turn 1 founding premise extraction pipeline fully implemented. (1) index.js: verbatim player input captured to birth_record.raw_input immediately after String(action) (pre-normalization, original casing), gated on turnNumber===1 && !raw_input already set. (2) ContinuityBrain _buildExtractionPrompt: on Turn 1 (turn_history.length===0) injects PRIMARY SOURCE (raw_input) and CONTEXT ONLY (narration) distinction, adds founding_premise block to JSON schema, adds FOUNDING PREMISE extraction section with source precedence rules (raw_input primary, narration fallback, anti-drift rule). (3) ContinuityBrain runPhaseB: write-back gate after REQUIRED_KEYS check — if turn===1 and extracted.founding_premise exists, writes form/location_premise/possessions/status_claims/scenario_notes to birth_record; console.log confirms population. founding_premise NOT in REQUIRED_KEYS (Turn 1 extension only — adding it would break Phase B on all other turns). Pre-v1.84.33 saves: birth_record fields remain null as expected.' },
  { version: '2.8.42', date: 'April 30, 2026', note: 'Source search tool (v1.84.32): added search_source as tool 9 in MB_TOOLS. executeToolCall branch hits GET /diagnostics/source-search with q= param and x-diagnostics-key auth. System prompt tool 9 description added: literal string search across all allowlisted files, 2-line context, discovery workflow (search_source -> find line -> get_source_slice -> read context). KNOWLEDGE TIERS updated: search_source listed in Tier 3 alongside get_source_slice with discovery/verification distinction. MB_VERSION 2.8.41 -> 2.8.42. Package v1.84.32.' },
  { version: '2.8.41', date: 'April 30, 2026', note: 'Player attribute state decay (v1.84.31): state: bucket facts older than 5 turns (STATE_ATTR_WINDOW) are now suppressed from the narrator TRUTH block — physical: and object: buckets are permanent. Suppressed count surfaced in narration_debug.state_attrs_suppressed each turn and in buildDebugContext as "state attrs in narrator: N active / M total (X suppressed, window=5)". All attributes remain in storage unchanged — storage not affected. System prompt: STATE DECLARATION CHANNEL updated with decay rule.' },
  { version: '2.8.40', date: 'April 29, 2026', note: 'Source slice access (v1.84.29): added GET /diagnostics/source endpoint to index.js — authenticated (x-diagnostics-key header / DIAGNOSTICS_KEY env var), disabled by default (503 when env var not set), read-only, hardcoded allowlist of 14 source files, 300-line hard cap, path-traversal rejection. Added get_source_slice as tool 8 in MB_TOOLS with file/from/to parameters. Added executeToolCall branch — passes x-diagnostics-key auth header inline, handles its own early return. Added tool 8 description to system prompt (targeted verification only, narrow ranges, not for browsing). Updated KNOWLEDGE TIERS: get_source_slice listed as Tier 3 static implementation truth.' },
  { version: '2.8.39', date: 'April 29, 2026', note: 'World site visibility (v1.84.27): (1) WORLD SITES SUMMARY added to buildDebugContext — compact section showing total filled sites in loaded cells, counts by macro cell (cap 20), top 3 nearest with exact coordinates and distance. Labeled "loaded cells only" throughout with explicit unvisited-area caveat. (2) GET /diagnostics/sites-query endpoint added to index.js — queryable by mx+my, radius, filled_only; sorted by distance; returns loaded_cells_only:true. (3) get_sites added to MB_TOOLS as tool 7 with full parameter schema and loaded-cells-only disclaimer. executeToolCall branch added. (4) System prompt: WORLD SITES SUMMARY bullet added (with overconfidence guard and scope-boundary rule); item 7 get_sites tool description added; KNOWLEDGE TIERS section added before EVIDENCE REQUIREMENT (Tier 1=current state, Tier 2=summary/FR rows, Tier 3=tool results); DO NOT FETCH updated with WORLD SITES SUMMARY exemption and unloaded-area exception.' },
  { version: '2.8.38', date: 'April 29, 2026', note: 'Fix MaxListenersExceededWarning (v1.84.26): added module-level _toolHttpAgent = new http.Agent({ keepAlive: false }) and passed it as httpAgent option in executeToolCall axios.get. Each tool call now closes its socket immediately after response — zero listeners accumulate on http.globalAgent across multi-call tool chains. keepAlive:false is safe for localhost diagnostic calls (sub-1ms RTT, no TCP handshake cost). SSE client and DeepSeek axios calls are unaffected.' },
  { version: '2.8.37', date: 'April 29, 2026', note: 'Payload truncation fix (v1.84.25): raised executeToolCall truncation limit from 8000 to 16000 chars — covers full-stage get_payload responses (narrator prompts top out ~10-12KB, CB prompts ~5-6KB). Updated TRUNCATED message text. Added part= guidance to FETCH PROCEDURE: when calling get_payload for a specific part, always pass part= explicitly to avoid truncation on large stages, with examples for response and prompt parts. Eliminates unnecessary recovery round on large payload fetches.' },
  { version: '2.8.36', date: 'April 29, 2026', note: 'EVIDENCE REQUIREMENT behavioral contract (v1.84.24): replaced TOOL USE block with structured four-part contract. (1) Category A/B decision rule: Category B = specific turn number, condition origin, system behavior, "why" questions — must fetch, FR rows are not evidence. (2) FETCH PROCEDURE: get_turn_data first, escalate to get_payload only if insufficient — no skipping ahead. (3) EVIDENCE STANDARDS: cite turn if grounded in tool data; label as "inference only" if Category B and no fetch done. (4) PRIORITY ORDER: retrieved evidence > structured context > inference. DO NOT FETCH exemptions for Category A (current state, last 5 narrations, last 3 CB packets, last turn RC/extraction) preserved. No code changes — prompt text only.' },
  { version: '2.8.35', date: 'April 29, 2026', note: 'TOOL USE prompt tightened (v1.84.23): replaced advisory wording with prescriptive MANDATORY FETCH RULES. FETCH IS REQUIRED for: (a) specific past-turn content questions — FR rows are one-line summaries only, not evidence; (b) causal/forensic questions; (c) verbatim LLM string requests. Added loophole-closing sentence: must fetch even if FR summary appears relevant — Flight Recorder rows are summaries only, not evidence. Added DO NOT FETCH exemptions for data already in context. Added FETCH PROTOCOL: get_turn_data first, escalate to get_payload for verbatim. No code changes — prompt text only.' },
  { version: '2.8.34', date: 'April 29, 2026', note: 'Agentic tool use (v1.84.22): Mother Brain can now invoke get_turn_data and get_payload as real DeepSeek function calls mid-reasoning. MB_TOOLS constant defines both functions. executeToolCall() helper resolves sessionId from module scope, fires axios.get, truncates at 8000 chars with TRUNCATED note. askMotherBrain() single DS call replaced with 5-round tool loop: on finish_reason=tool_calls, prints her reasoning sentence (message.content), dim [tool] line, executes call, appends tool result, loops with [synthesizing...]; on stop breaks and displays final response. Token tracking accumulates across all rounds. Tool messages not stored in _history[]. System prompt TOOL USE rule added: output one reasoning sentence before each tool call; use get_turn_data first, escalate to get_payload for verbatim strings; do not invoke if answer is in provided context. Package v1.84.22.' },
  { version: '2.8.33', date: 'April 29, 2026', note: 'Flight Recorder cold archive (v1.84.21): two new retrieval endpoints added. GET /diagnostics/turn/{sessionId}/{turn} returns full structured turnObject from turn_history[] for any past turn (optional ?fields= filter). GET /diagnostics/payload/{sessionId}/{turn} returns raw DeepSeek prompt+response per pipeline stage in order: reality_check -> narrator -> continuity_brain -> condition_bot (optional ?stage= and ?part= filters). payload_archive written atomically at turn-close, persisted to saves/{sessionId}/payload_archive.json, restored on session restore. Mental model: /turn = structured truth (use first), /payload = forensic evidence (escalate to). null stage = stage did not run that turn. TOOLS AND DATA ACCESS items 5 and 6 added.' },
  { version: '2.8.32', date: 'April 29, 2026', note: 'Condition Bot (v1.84.19): PLAYER CONDITIONS paragraph added to SYSTEM_PROMPT. player.conditions[] is the active condition array; player.conditions_archive[] holds resolved conditions. Each condition: condition_id, created_turn, description (live snapshot), turn_log (append-only, [narration]/[bot] provenance), notes (rolling 5-entry evidence window from CB). Condition Bot evaluates lifecycle each turn post-CB — description changes only on qualitative shift; [bot] turn_log entries required for every change; no-op = silence. CB owns creation; ConditionBot owns progression/resolution. Narrator sees description only (not notes or bot log entries). buildDebugContext PLAYER CONDITIONS section added showing full condition state. Package v1.84.19.' },
  { version: '2.8.31', date: 'April 28, 2026', note: 'Raise LAST NARRATIONS cap (v1.84.18): per-narration character cap raised from 1200 to 3000. Fixes mid-word truncation on long DS narrations (~1650 chars confirmed). LAST NARRATIONS bullet updated. Package v1.84.18.' },
  { version: '2.8.30', date: 'April 28, 2026', note: 'State claim narrator instruction (v1.84.16): _freeformBlock now branches on _parsedAction===state_claim. State_claim turns receive directed absence instruction: claim is unsupported, do not instantiate objects/inventory/conditions/NPCs/authority/world facts, reflect only existing engine state, narrate as speech/thought/assertion with no world change. All other freeform turns unchanged. Package v1.84.16.' },
  { version: '2.8.29', date: 'April 28, 2026', note: 'Full birth_record visibility (v1.84.15): buildDebugContext PLAYER STATE birth_record line expanded from single-line summary to full structured render. Now shows: raw_input (up to 120 chars), form, location_premise, possessions (up to 5), status_claims (up to 5), scenario_notes (up to 5). Null fields shown explicitly. Empty arrays omitted. MB PLAYER STATE bullet updated. Package v1.84.15.' },
  { version: '2.8.28', date: 'April 28, 2026', note: 'Expand LAST NARRATIONS window (v1.84.14): buildDebugContext LAST NARRATIONS section raised from last 2 turns / 400 chars to last 5 turns / 1200 chars per narration. Fixes mid-sentence truncation of narrator output visible to Mother Brain. MB SYSTEM_PROMPT LAST NARRATIONS bullet updated. Package v1.84.14.' },
  { version: '2.8.27', date: 'April 28, 2026', note: 'State claim pre-RC gate (v1.84.13): state_claim added to SemanticParser valid actions as a parser routing verdict (not an engine action). index.js intercepts state_claim BEFORE validateAndQueueIntent — sets inputObj to freeform, preserves player_intent.action = state_claim, sets debug.path = STATE_CLAIM_FREEFORM, skips validation entirely. RC skip block reads _parsedAction === state_claim and sets skipped_reason: state_claim (distinct from harmless-action skips — signals non-executable input). _freeformBlock fires via existing FREEFORM kind path. MB STATE DECLARATION CHANNEL paragraph updated. Watch scan REALITY CHECK rule updated: skipped_reason:state_claim is correct skip, not a fault. Package v1.84.13.' },
  { version: '2.8.26', date: 'April 27, 2026', note: 'RC narrator input mirror (v1.84.12): buildDebugContext now renders === REALITY CHECK (last turn) === section showing fired, skipped_reason, query, raw_response (verbatim DS output), anchor_block (exact text injected into narrator prompt), and stage_times (rc/narrator durations + order_confirmed). MB SYSTEM_PROMPT REALITY CHECK paragraph updated: full turn_history field set documented (raw_response, anchor_block added), stage_times documented, new context section referenced. Mother Watch RC skip list corrected: enter/exit added alongside move/look/wait. Package v1.84.12.' },
  { version: '2.8.25', date: 'April 27, 2026', note: 'Absence narration classification rule (v1.84.11): added ABSENCE NARRATION paragraph to CB WARNINGS section of SYSTEM_PROMPT. Teaches MB to distinguish correct closed-world absence narration (player references nonexistent entity, narrator says no one is here) from hallucination (UNRESOLVED warning, entity introduced as present without NPC registry match). No UNRESOLVED fires on absence narration — ContinuityBrain had nothing to extract. Prose alone is never sufficient to classify a fault. Package v1.84.11.' },
  { version: '2.8.24', date: 'April 27, 2026', note: 'Continuity packet NPC absence fix (v1.84.10): assembleContinuityPacket now emits explicit line "NPCs at this location: none visible in engine state." into the TRUTH block when visible NPC list is empty. Previously absence was implied by omission, allowing narrator to fill the gap. Fix makes the authoritative zero state a positive assertion. ContinuityBrain.js only — no narrator prompt changes.' },
  { version: '2.8.23', date: 'April 27, 2026', note: 'RC Advisory Mode (v1.84.9): Reality Check demoted from FINAL AUTHORITY to advisory. Injected block header changed from ADJUDICATED REALITY [FINAL AUTHORITY] to "Possible consequences of the player action (advisory):". Narrator instruction changed from "Render this turn consistent with..." to "Use these as guidance... Select, adapt, or ignore as appropriate. Honor the current scene, engine state, and system prompt." Narrator retains full scene authority -- RC output is guidance only, not override. Skip conditions extended: enter and exit added alongside move/look/wait. SYSTEM_PROMPT REALITY CHECK paragraph updated. Package v1.84.9.' },
  { version: '2.8.24', date: 'May 9, 2026', note: 'ORS v1.85.27/v1.85.28 awareness: SYSTEM_PROMPT updated with four new knowledge blocks — (1) CB extraction schema: three object categories (object_candidates, visible_objects, environmental_features) with boundary test rule; visible_objects are barrier-inaccessible objects that NEVER become ObjectRecords; visible_objects_count in _objectRealityDebug; (2) CB entity_candidates held/worn split: held_objects[] + worn_objects[] replace held_or_worn_objects[] (old saves backward-compatible); (3) NPC object containers: object_ids[] (carried), worn_object_ids[] (worn), legacy inventory[] deprecated; object: attribute bucket is narrator-facing only; (4) NPC intro capture pipeline: first-introduction materialization fires when object_capture_turn===null; synthetic object_candidates injected with transfer_origin:npc_introduction; provenance fields (source, source_npc_id, source_phrase) on born records; npc_intro_materialized in object_reality. ObjectRecord schema updated: player_worn and npc_worn container types added; source field documented. Container model updated with player_worn and npc_worn slots. object_reality field shape updated: visible_objects_count + npc_intro_materialized added. Narrator NPC block documented: carries:[] and wears:[] fields now injected from engine ORS state.' },
  { version: '2.8.23', date: 'May 9, 2026', note: 'ORS v1.85.25–v1.85.26 context (retrospective): quarantine skip_reason overwrite fix (v1.85.25) — skip_reason no longer overwrites a previously-set reason in the same turn; all empty_quarantine entries now reflect the first-set reason. Narrator occupancy compliance hardening (v1.85.26) — CORE INSTRUCTIONS bullet 1 binds world tone to current-scene scope; Location Atmosphere header is now imperative; occupancy anchor fires when no NPCs are visible to prevent narrator from inferring presence from nearby noise/sound/activity.' },
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
  { version: '2.7.1', date: 'April 27, 2026', note: 'Mother Watch Panel (v1.79.0): Phase B now optionally outputs watch_message — one-sentence system health judgment written by the model inside the existing DeepSeek extraction call (zero extra API calls). watch_message is not in REQUIRED_KEYS (never blocks Phase B); injected via MOTHER WATCH BRIEF context block appended to extraction prompt. watch_message emitted on SSE turn events; displayed in motherwatch.js terminal panel. ContinuityBrain v1.5.0. flight-recorder.js [W] hotkey spawns watch panel.' },
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
*/

// ── Tool definitions for DeepSeek function calling ────────────────────────────
const MB_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_turn_data',
      description: 'Fetch the full structured turnObject for a specific past turn from turn_history[]. Use this as your default when answering any turn-specific question — it contains narrative, extraction_packet, continuity_snapshot, authoritative_state, input, stage_times, and reality_check. Use the fields parameter to request only the fields you need. Call this first before escalating to get_payload.',
      parameters: {
        type: 'object',
        properties: {
          turn: {
            type: 'integer',
            description: 'The turn number to retrieve.'
          },
          fields: {
            type: 'string',
            description: 'Optional comma-separated list of fields to return: narrative, extraction_packet, continuity_snapshot, authoritative_state, input, stage_times, reality_check, narration_debug, logs, object_reality, p5_witness_archive. Omit for the full turnObject. p5_witness_archive is the preferred compact historical certification surface for partial-stack TAKE operation evidence — it contains frozen pre-AP predictions and post-AP actuals. Use logs for engine-event tracing (player_action_parsed, move, location_changed events) — not for LLM prompts or responses (use get_payload for those). Event presence in logs is version-dependent — absence is not proof an event did not occur.'
          }
        },
        required: ['turn']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_payload',
      description: 'Fetch raw DeepSeek prompt+response pairs for a specific past turn from the payload archive. Pipeline stages in order: authority_gate, reality_check, narrator, continuity_brain, condition_bot. A null stage means that stage did not run that turn — not a crash. Use this when you need verbatim LLM input/output: exact extraction prompts, raw narrator responses, condition_bot JSON. Escalate to this after get_turn_data when the structured data is insufficient.',
      parameters: {
        type: 'object',
        properties: {
          turn: {
            type: 'integer',
            description: 'The turn number to retrieve.'
          },
          stage: {
            type: 'string',
            description: 'Optional: one of authority_gate, reality_check, narrator, continuity_brain, condition_bot. Omit to get all stages.'
          },
          part: {
            type: 'string',
            description: 'Optional: prompt or response. Only valid when stage is also specified. Omit to get both prompt and response for the stage.'
          }
        },
        required: ['turn']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_sites',
      description: 'Query the world site registry for filled sites across loaded/generated cells. Use this when the WORLD SITES SUMMARY in context is insufficient — e.g., for exact site details, all sites in a specific macro cell, or all sites within a radius of the player. Returns site_id, name, description, identity, cell coordinates, enterable, is_filled, interior_state, and distance_from_player sorted nearest first. NOTE: like the summary, this only covers currently loaded/generated cells — unvisited areas may have undiscovered sites. If the question scope exceeds loaded data (e.g., "anywhere in the world"), make that limitation explicit in your answer. Omit all parameters to get every filled site across all loaded cells.',
      parameters: {
        type: 'object',
        properties: {
          mx: {
            type: 'integer',
            description: 'Optional: macro cell X to filter by. Use with my to target a specific macro cell.'
          },
          my: {
            type: 'integer',
            description: 'Optional: macro cell Y to filter by. Use with mx to target a specific macro cell.'
          },
          radius: {
            type: 'integer',
            description: 'Optional: macro-cell radius around the player\'s current position (toroidal). radius=1 = immediate macro neighbors, radius=3 = wide area search.'
          },
          filled_only: {
            type: 'boolean',
            description: 'Optional: if false, include unfilled/pending site slots. Defaults to true (filled sites only).'
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'inspect_active_site',
      description: 'Read the live active site and all its localspace descriptors directly from game state. Returns depth, active_site with full local_spaces table (localspace_size, width, height, enterable, x, y, npc_ids, has_generated_interior per space), active_local_space, and fill_log. Use this to inspect individual localspace properties — localspace_size (1-10), grid dimensions, enterable flag, NPC assignment, and whether a traversable interior grid has been generated. Do not use get_sites for this — get_sites queries the world registry, not the active site descriptor table.',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_site',
      description: 'Fetch the full stored runtime record for a specific site by site_id from loaded/generated world state. Operates against the entire world.sites map — no proximity filter; works even if the player is hundreds of cells away. Returns: site_id, interior_key, name, description, identity, enterable, is_filled, interior_state (GENERATED|NOT_GENERATED), site_size, width, height, population, is_stub, created_at, coords (mx/my/lx/ly/cell_key), localspace_count, localspace_ids (short keys), npc_count, npc_ids, floor_object_count, floor_object_ids. No claim is made about unloaded or unvisited world regions — 404 means the site is not in loaded state. For the currently active site, inspect_active_site is faster. For world registry slot metadata only (no localspace detail), use get_sites.',
      parameters: {
        type: 'object',
        properties: {
          site_id: {
            type: 'string',
            description: 'The site_id to look up (e.g. M0x1:site_start). Bare form or /l2 suffix both accepted.'
          }
        },
        required: ['site_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_localspaces',
      description: 'List all localspaces for a site with compact summaries. Operates against the full world.sites map — player does not need to be at or near the site. Returns: site_id, site_name, localspace_count, and per-space: localspace_id, parent_site_id, name, description, enterable, is_filled, localspace_size, x, y, width, height, npc_count, npc_ids, object_count, has_generated_interior. Localspaces whose interiors have not been generated return has_generated_interior: false and null/empty grid and grid_summary. No claim is made about unloaded world regions. Use this to survey all localspaces at once — verify independent size rolls, dimension variety, fill status, NPC placement, and enterable distribution. For the active site, inspect_active_site also works but get_localspaces works for any loaded site.',
      parameters: {
        type: 'object',
        properties: {
          site_id: {
            type: 'string',
            description: 'The site_id to retrieve localspaces for.'
          }
        },
        required: ['site_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_localspace',
      description: 'Fetch the full stored runtime record for a specific localspace by its short ID (e.g. ls_0). Operates against all loaded sites — player need not be inside or near the space. Returns: localspace_id, parent_site_id, name, description, enterable, is_filled, localspace_size, x, y, width, height, npc_count, npc_ids, object_count, object_ids, has_generated_interior, grid_summary (rows/cols/floor_tiles/npc_tiles — null if interior not yet generated). Localspaces whose interiors have not been generated return has_generated_interior: false and null grid_summary. Pass include_grid=true to also receive the full 2D tile grid array (large — use sparingly). Providing site_id narrows the search and is faster. Without site_id, all loaded sites are scanned. No claim is made about unloaded world regions.',
      parameters: {
        type: 'object',
        properties: {
          localspace_id: {
            type: 'string',
            description: 'The short localspace ID to look up (e.g. ls_0, ls_3).'
          },
          site_id: {
            type: 'string',
            description: 'Optional: parent site_id to narrow the search. Faster when provided.'
          },
          include_grid: {
            type: 'boolean',
            description: 'If true, includes the full 2D interior grid array in the response. Default false. Use sparingly — grid can be large.'
          }
        },
        required: ['localspace_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_source_slice',
      description: 'Read a bounded line-range slice of a game source file for targeted implementation verification. Use this when you have a specific line number hypothesis from turn data or payload analysis — to verify a code path, cross-reference engine behavior against implementation, or confirm a bug root cause. Request narrow ranges (50–100 lines). NOT for exploratory browsing. Allowed files: index.js, diagnostics.js, Engine.js, ActionProcessor.js, NPCs.js, WorldGen.js, NarrativeContinuity.js, ContinuityBrain.js, SemanticParser.js, continuity.js, QuestSystem.js, logger.js, logging.js, flight-recorder.js, motherbrain.js, conditionbot.js, ObjectHelper.js, cbpanel.js, npcpanel.js, sitelens.js, motherwatch.js, summary.js, dmletter.js, Index.html, Map.html, test-harness.js, authoritygate.js, SemanticNormalizer.js, ObjectOperationResolver.js, TlsObjectOperationExecutor.js, ObjectOperationBridge.js, motherbrain-controller.js, motherbrain-tui.js. Also allowed: tests/scenarios/<name>.json and tests/probes/<name>.probe.json — use the full relative path (e.g. tests/scenarios/arbiter_basic.json or tests/probes/worldgen-sites.probe.json), NOT the bare filename. Also allowed for Mother Brain TUI/controller validation, full relative path required: scripts/motherbrain-tui-smoke.cjs, scripts/motherbrain-v4-smoke.cjs, tests/motherbrain-controller.test.cjs. Returns: file, from, to, total_lines, lines (the raw source text)',
      parameters: {
        type: 'object',
        properties: {
          file: {
            type: 'string',
            description: 'For source files: filename only (no path) — e.g. index.js, diagnostics.js, Engine.js, ActionProcessor.js, NPCs.js, WorldGen.js, NarrativeContinuity.js, ContinuityBrain.js, SemanticParser.js, continuity.js, QuestSystem.js, logger.js, logging.js, flight-recorder.js, motherbrain.js, conditionbot.js, ObjectHelper.js, cbpanel.js, npcpanel.js, sitelens.js, motherwatch.js, summary.js, dmletter.js, Index.html, Map.html, test-harness.js, authoritygate.js. For scripts/ files: use the FULL RELATIVE PATH — e.g. scripts/probe-runner.js or scripts/probe-metrics.js. For scenario JSON files: use the FULL RELATIVE PATH — e.g. tests/scenarios/arbiter_basic.json. For probe specs: use the FULL RELATIVE PATH — e.g. tests/probes/worldgen-sites.probe.json. Do NOT use a bare filename — it will be rejected.'
          },
          from: {
            type: 'integer',
            description: 'Optional: 1-based line number to start reading from. Default: 1.'
          },
          to: {
            type: 'integer',
            description: 'Optional: 1-based line number to read to (inclusive). Hard cap: from+299. Default: from+199.'
          }
        },
        required: ['file']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_source',
      description: 'Search for a literal string across allowlisted game source files. Use this when you do not know which file or line a symbol lives in. Returns up to 20 matches with 2 lines of context each. Follow up with get_source_slice to read the surrounding code. NOT for browsing — use specific identifiers (function names, variable names, error code strings). Scope to a file with the file= param when possible to reduce noise. Minimum query length: 3 characters.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Literal string to search for (case-sensitive, minimum 3 characters). Use specific identifiers — function names, variable names, string literals, error codes.'
          },
          file: {
            type: 'string',
            description: 'Optional: scope search to a single file (filename only, no path). Must be one of the allowed files. Omit to search all allowlisted files. Allowed: index.js, diagnostics.js, Engine.js, ActionProcessor.js, NPCs.js, WorldGen.js, NarrativeContinuity.js, ContinuityBrain.js, SemanticParser.js, continuity.js, QuestSystem.js, logger.js, logging.js, flight-recorder.js, motherbrain.js, conditionbot.js, ObjectHelper.js, cbpanel.js, npcpanel.js, sitelens.js, motherwatch.js, summary.js, dmletter.js, Index.html, Map.html, authoritygate.js.'
          }
        },
        required: ['query']
      }
    }
  },
  // v1.84.54: Object Reality tools
  {
    type: 'function',
    function: {
      name: 'query_objects',
      description: 'Query the live object registry. Use when: inventory UI vs engine state diverges; investigating object_errors; confirming an object\'s current container; listing all objects held by an NPC, player, in a grid cell, or on a localspace floor. Returns all matching object records plus a by_container index and last 20 object_errors. Objects that have been transferred to different containers persist with their current_container_type/current_container_id updated.',
      parameters: {
        type: 'object',
        properties: {
          container_type: {
            type: 'string',
            description: 'Optional: filter by container type. Valid values: player (player inventory), npc (held by an NPC), grid (object in a world cell — cell keys are LOC:mx,my:lx,ly format), localspace (object on a localspace interior floor — IDs are site_.../l2_ls_... format), site (object on a site floor), npc_worn (worn by an NPC), player_worn (worn by the player). Omit to return all. Do NOT use \'cell\' — use \'grid\' for cell-held objects.'
          },
          container_id: {
            type: 'string',
            description: 'Optional: filter by container ID (e.g. an NPC ID or cell key). Use with container_type.'
          },
          status: {
            type: 'string',
            description: 'Optional: active (default) or all. Use all to include transferred/archived objects.'
          },
          include_events: {
            type: 'boolean',
            description: 'Optional: if true, includes the event log on each returned object record. Default: false.'
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'inspect_entity',
      description: 'Fetch the full raw engine record for any entity. entity_type=object: returns the full ObjectRecord including event log (history of all promotions/transfers for this specific object); entity_type=npc: returns full NPC record including object_ids[], attributes{}, conditions[] — covers both world.npcs and active_site.npcs; entity_type=player: returns full player record including object_ids[], conditions[], birth_record, attributes{}; entity_type=cell: returns full cell record including object_ids[], sites{}, attributes{}. Use this to compare the raw record against what the narrator described.',
      parameters: {
        type: 'object',
        properties: {
          entity_type: {
            type: 'string',
            description: 'Required. One of: object, npc, player, cell.'
          },
          entity_id: {
            type: 'string',
            description: 'Required for entity_type=object, npc, or cell. Omit for entity_type=player.'
          }
        },
        required: ['entity_type']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'trace_object',
      description: 'Reconstruct the full lifecycle of a specific object by scanning all frozen turn_history object_reality entries. Returns: current record from registry, timeline of all audit events across turns (promotions/transfers/skips), error entries from object_errors, and turns_with_data count. NOTE: only covers turns since v1.84.54 deploy — turns_with_data shows coverage depth. Use when investigating unexpected object state, container mismatch, repeated errors on the same object, or to verify an object was correctly promoted.',
      parameters: {
        type: 'object',
        properties: {
          object_id: {
            type: 'string',
            description: 'Required. The sha256-derived object ID to trace (e.g. obj_65f8eeeb6546).'
          }
        },
        required: ['object_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_npcs',
      description: 'Enumerate all NPCs currently in the game world — both world.npcs (L0 founded NPCs) and active_site.npcs. Use this when you need to find an NPC without knowing its ID — call list_npcs first, then escalate to inspect_entity(entity_type=npc, entity_id=...) with the returned id. Returns id, npc_name, is_learned, job_category, scope (world|active_site), layer (L0|L1|L2), object_ids[], worn_object_ids[], and visible (true if NPC shares the player\'s exact world tile at L0, or appears in the computeVisibleNpcs result at L1/L2). NOTE: canonical NPC identity fields are npc_name (not name) and job_category (not archetype) — use these field names in any follow-up inspection.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'harness_connect',
      description: 'Establish harness operational authority. Verifies /harness/status is reachable, then sets Mother Brain to Connected state, enabling all harness tools. Call this ONLY after the developer has explicitly granted permission to connect. Do not call autonomously.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'harness_status',
      description: 'Check whether the QA harness is available and how many scenarios are registered. Returns: available (always true when this endpoint responds), running (true if a run is already in progress), scenarios (total count). Requires harness_connect first.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'harness_list_scenarios',
      description: 'List all available QA scenarios (builtins + JSON files in tests/scenarios/). Returns a JSON array where each entry has: name (use this exact string for harness_run_scenario), source ("builtin"|"file"), stability ("stable"|"probe"), description (what the scenario tests), turns (turn count), isolated (true = session must be isolated), sweep (authoritative execution-membership field). The sweep field is authoritative: "A" means included in stable sweep, "P" means included only in probe/full sweep, "manual" means excluded from both A and P and must be run individually. Call this to know exactly what is available and what each scenario covers before recommending or running anything.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'harness_run_scenario',
      description: 'Start a QA scenario run through the test harness. Requires harness_connect first (_harnessAuthorized=true). Once Connected, run in response to an explicit developer request — do not run autonomously or without prior stated intent. Scenario name must exactly match a name from harness_list_scenarios. Runs default to 1; max is 5. Returns immediately with {started:true} — the run executes in the background. After calling this, poll harness_status until running:false, then call harness_read_result to get the full result. If the batch threw an error, failed:true will be set in the result.',
      parameters: {
        type: 'object',
        properties: {
          scenario: {
            type: 'string',
            description: 'Exact scenario name from harness_list_scenarios (e.g. smoke_test_no_error). Alphanumeric, underscores, hyphens only.'
          },
          runs: {
            type: 'integer',
            description: 'Number of sequential runs. Defaults to 1. Maximum 5.'
          }
        },
        required: ['scenario']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'harness_read_result',
      description: 'Read the structured result from the most recently completed harness run. Returns: scenario name, runs count, completedAt timestamp, per-run details (exitCode, stdout, stderr), and the summary JSON written by the harness (scenariosPassed, scenariosFailed, turnsPassed, turnsFailed, per-scenario results with sessionId). Call this after harness_run_scenario to get the full result. Requires harness_connect first.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'harness_disconnect',
      description: 'Revoke harness operational authority. Sets Mother Brain to Offline state. All harness tools become unavailable until reconnected.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_validation',
      description: 'Run a predefined validation task in the Game-main directory. Each task maps to a fixed command — no freeform input. Use for syntax checking files, running harness scenarios, and running statistical probe specs. Returns stdout, stderr, exit_code.',
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            enum: [
              'node_check_index',
              'node_check_harness',
              'node_check_mother',
              'harness_reality_check_basic',
              'harness_arbiter_basic',
              'harness_founding_premise_correctness',
              'harness_site_entry_basic',
              'harness_sweep_a',
              'probe_worldgen_sites_10',
              'probe_worldgen_sites_50',
              'run_probe_localspace',
              'run_probe',
              'run_node_script'
            ],
            description: 'node_check_*=syntax check; harness_<name>=run scenario; harness_sweep_a=run sweep A; probe_worldgen_sites_10/50=worldgen distribution probe (10 or 50 runs); run_probe_localspace=localspace distribution probe (5 runs, smoke); run_probe=run any .probe.json spec (requires spec_path param); run_node_script=run any scripts/*.js|cjs|mjs file you have written (requires script_path param, 30s timeout)'
          },
          spec_path: {
            type: 'string',
            description: 'Required when task=run_probe. Path to .probe.json file relative to Game-main root. Example: "tests/probes/worldgen-sites.probe.json". No .. allowed.'
          },
          script_path: {
            type: 'string',
            description: 'Required when task=run_node_script. Path to a .js, .cjs, or .mjs file inside the scripts/ directory. Example: "scripts/test-no-session.cjs". Must be scripts/<name>.ext — no .. allowed.'
          },
          runs: {
            type: 'integer',
            description: 'Number of probe runs. Used with run_probe task only. Default: 10.'
          }
        },
        required: ['task']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_probe_spec',
      description: 'Write a new statistical probe spec (.probe.json) to tests/probes/. Probe specs define what to measure: endpoint, request template, extract path, metric names, warning thresholds. The probe-runner.js script owns all metric calculation — you declare metric names from the approved enum only, no expressions. Requires request_lifecycle=session_per_run (only supported value). Metrics that need spec-level config (e.g. edge_concentration_pct requires edge_topology.radius and edge_topology.anchor_path) will be rejected if the required config is missing. No overwrite — existing files are hard-blocked.',
      parameters: {
        type: 'object',
        properties: {
          filename: {
            type: 'string',
            description: 'Filename without extension or path. Alphanumeric, underscores, hyphens only. Max 80 chars. Will be written to tests/probes/<filename>.probe.json'
          },
          spec: {
            type: 'object',
            description: 'Full probe spec object. Required fields: name (string), endpoint (string), method (string), extract (dot-path string), request_lifecycle (must be "session_per_run"), request_template (object — the seed placeholder must appear as the JSON string value "$SEED" with quotes, e.g. {"WORLD_SEED": "$SEED"}; the runner replaces the quoted string "$SEED" with the numeric seed integer at runtime — NEVER use $SEED as a bare unquoted JSON token, that is not valid JSON and will crash the tool call), metrics (non-empty array of known metric names). Optional: description, edge_topology (object with radius+anchor_path, required when using edge_concentration_pct), expected_runtime_ms_per_run (int), percentile_metrics (array), warnings (object keyed by metric name), prompt_cycle (array of non-empty strings — if present, each run uses prompt_cycle[i % length] as the action field, overriding request_template.action for that run; request_template.action remains valid as a fallback/default and both may coexist in the same spec).'
          }
        },
        required: ['filename', 'spec']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_scenario_file',
      description: 'Write a new QA scenario JSON file to tests/scenarios/. Enforces probe-first stability: all new scenarios are written as stability="probe" regardless of what you request. Returns explicit stability audit trail (requested_stability, written_stability, stability_forced). File names must be alphanumeric/underscore/hyphen only. No overwrite — existing files are hard-blocked. Returns warnings for low-signal or duplicate assertions.',
      parameters: {
        type: 'object',
        properties: {
          filename: {
            type: 'string',
            description: 'Filename without extension or path. Alphanumeric, underscores, hyphens only. Max 80 chars. Example: "my_new_scenario"'
          },
          scenario: {
            type: 'object',
            description: 'Full scenario definition object. Must include: name (string), turns (array of turn objects). Each turn must have action (string) and assert (array with at least one {op} object). Optional: description, stability (will be forced to probe), world_prompt, world_seed, category.'
          }
        },
        required: ['filename', 'scenario']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_probe_results',
      description: 'Read probe run output from tests/probe-results/. With no folder param: lists available result folders sorted newest-first (use this first to identify which run to analyze). With folder specified: reads one file from that folder (default: summary.json). For failure forensics, read errors.jsonl (contains only failed rows, always small) or check hard_error_rows in summary.json. For per-run success-row analysis, read runs.jsonl with from_line/to_line to page through rows without truncation (default: first 50 rows).',
      parameters: {
        type: 'object',
        properties: {
          folder: {
            type: 'string',
            description: 'Name of the result subfolder (e.g. "2026-05-12_0315_worldgen-sites"). Omit to list all available result folders sorted newest-first.'
          },
          file: {
            type: 'string',
            enum: ['summary.json', 'runs.jsonl', 'errors.jsonl', 'console.txt', 'spec.snapshot.json'],
            description: 'Which file to read. Default: summary.json. errors.jsonl contains only hard-error rows (always small). For runs.jsonl use from_line/to_line to paginate.'
          },
          from_line: {
            type: 'integer',
            description: 'First row to return from runs.jsonl (1-based). Default: 1.'
          },
          to_line: {
            type: 'integer',
            description: 'Last row to return from runs.jsonl (1-based, inclusive). Default: min(total, 50). Increase to read more rows.'
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write a new file inside the Game-main directory. Fails if the file already exists unless overwrite:true is explicitly passed. Use for: new config JSON files, new utility scripts, new markdown docs, or any file that does not yet exist. Do not use write_file to edit large existing source files -- full-content overwrites on large files are expensive in tokens and error-prone. For surgical edits to existing files, use patch_file. For scenario JSON, prefer create_scenario_file (includes harness validation). For probe specs, prefer create_probe_spec (includes metric enum validation).',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path within Game-main (e.g. "config.json", "scripts/myscript.js"). No .. allowed. Must not escape the Game-main directory.'
          },
          content: {
            type: 'string',
            description: 'Full file content to write as a string.'
          },
          overwrite: {
            type: 'boolean',
            description: 'If true, overwrite the file if it already exists. Default: false (fail if exists). Use with caution.'
          }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'patch_file',
      description: 'Apply an exact string replacement to an existing file inside the Game-main directory. Replaces old_string with new_string. Fails if: the file does not exist, old_string is not found, or old_string matches more than once (unless allow_multiple:true). MANDATORY WORKFLOW: always call get_source_slice first to read the exact text including whitespace and indentation before constructing old_string. Never construct old_string from memory or prior output.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path within Game-main (e.g. "index.js", "ContinuityBrain.js"). No .. allowed.'
          },
          old_string: {
            type: 'string',
            description: 'Exact literal string to find and replace. Must match exactly once (unless allow_multiple:true). Include enough surrounding context lines to be unique.'
          },
          new_string: {
            type: 'string',
            description: 'Replacement string. May be empty string to delete old_string.'
          },
          allow_multiple: {
            type: 'boolean',
            description: 'If true, replace ALL occurrences of old_string. Default: false (fail if more than one match).'
          }
        },
        required: ['path', 'old_string', 'new_string']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'attach_session',
      description: 'Attach Mother Brain to an existing live session that MB did not start (e.g. a browser session the developer is playing). Once attached, all diagnostic tools (get_turn_data, get_payload, inspect_entity, query_objects, etc.) work normally against that session. If session_id is omitted, auto-detects the most recently active session via GET /diagnostics/session. Does NOT create or delete any session.',
      parameters: {
        type: 'object',
        properties: {
          session_id: {
            type: 'string',
            description: 'Optional. The exact session ID to attach to. If omitted, auto-detects via /diagnostics/session.'
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'start_game',
      description: 'Start a new game session by posting a founding premise to the engine (Turn 1). Stores the session ID internally — all existing diagnostic tools immediately work against the new session. Accepts an optional investigation context (goal, hypothesis, expected_invariant) to seed the investigation block, which is echoed in every take_turn response. Use force:true to auto-end any existing session before starting. world_seed makes the world geometry reproducible for regression work.',
      parameters: {
        type: 'object',
        properties: {
          founding_premise: {
            type: 'string',
            description: 'The Turn 1 founding premise — who the player is, where they start, what they have. This is the world founding phase: all content is valid.'
          },
          world_seed: {
            type: 'integer',
            description: 'Optional. Integer seed for deterministic world geometry. Use when reproducing a regression or running a controlled experiment.'
          },
          force: {
            type: 'boolean',
            description: 'If true and a session is already active, end it before starting a new one. Default: false (returns session_already_active error if a session exists).'
          },
          goal: {
            type: 'string',
            description: 'What this investigation is trying to determine. Strongly recommended.'
          },
          hypothesis: {
            type: 'string',
            description: 'What you expect to find. Strongly recommended.'
          },
          expected_invariant: {
            type: 'string',
            description: 'The specific condition that would confirm or deny the hypothesis.'
          }
        },
        required: ['founding_premise']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'take_turn',
      description: 'Submit a player action to the active game session. Requires an active session (call start_game first). Returns narrative, a diagnostics summary from the turn archive, and the current investigation context block. The investigation block is echoed every turn to keep you anchored to your goal and hypothesis.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'The player action to submit.'
          },
          intent_channel: {
            type: 'string',
            enum: ['do', 'say', 'ask'],
            description: "Optional intent channel. Default: do. Use 'say' when the player speaks aloud to an NPC — dialogue, questions, greetings. Use 'do' for all physical actions (look, move, examine, pick up, etc.)."
          }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_investigation',
      description: 'LOCAL-ONLY TOOL — updates the active investigation status and optional conclusion. Makes no server calls and does not require an active game session. Call this after any diagnostic tool call when evidence changes the picture — not only after take_turn. The status enum provides structured closure semantics: investigating / likely_confirmed / contradicted / inconclusive / reproduced / non_reproducible. A conclusion is required when setting any closing status.',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['investigating', 'likely_confirmed', 'contradicted', 'inconclusive', 'reproduced', 'non_reproducible'],
            description: 'The new investigation status. Update as soon as evidence reaches a threshold — do not wait until end_game.'
          },
          conclusion: {
            type: 'string',
            description: 'One-sentence finding. Required when setting any closing status (anything except investigating).'
          }
        },
        required: ['status']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'end_game',
      description: 'Delete the active game session and clear the investigation context. Always call when done with an experiment — prevents server memory leaks. The session TTL eviction will also clean up eventually, but explicit deletion is preferred.',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'github_list_commits',
      description: 'List recent commits from the Game-main GitHub repository. Returns SHA, short SHA, message, author, and date for each commit. Use to inspect patch history, find a specific commit SHA, or verify the most recent push.',
      parameters: {
        type: 'object',
        properties: {
          count: {
            type: 'integer',
            description: 'Number of commits to return (1–50). Defaults to 10.'
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'github_get_commit',
      description: 'Fetch the unified diff and metadata for a specific commit by SHA. Returns exactly what changed in that patch. Use to verify a patch was applied correctly, review a regression-introducing change, or inspect any historical commit.',
      parameters: {
        type: 'object',
        properties: {
          sha: {
            type: 'string',
            description: 'Full or abbreviated (7+ char) commit SHA to inspect.'
          }
        },
        required: ['sha']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'github_get_file',
      description: 'Read the content of a file in the Game-main GitHub repository at HEAD or a specific ref. Use to verify a patched file on GitHub matches the expected state, or to inspect a historical file version.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Repository-relative path to the file, e.g. "ObjectHelper.js" or "scripts/probe-runner.js".'
          },
          ref: {
            type: 'string',
            description: 'Branch, tag, or commit SHA to read from. Defaults to "main".'
          }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'github_compare',
      description: 'Compare two commits, branches, or tags and return the unified diff between them. Use to see exactly what changed between two versions of the codebase, e.g. between the last two version tags.',
      parameters: {
        type: 'object',
        properties: {
          base: {
            type: 'string',
            description: 'The base ref (older commit SHA, branch, or tag).'
          },
          head: {
            type: 'string',
            description: 'The head ref (newer commit SHA, branch, or tag).'
          }
        },
        required: ['base', 'head']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'github_search_code',
      description: 'Search for code within the Game-main GitHub repository. Returns file paths, URLs, and text fragments for each match. Use to locate where a function, pattern, or string exists across the codebase on GitHub.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query string. Supports GitHub code search syntax, e.g. "_resolveContainerIds" or "player#born_npc_".'
          }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_witness',
      description: 'Retrieve the latest ItemOperationWitness packet for the current session. Returns the witness object from the most recent turn that involved item operations. Returns an error if no turn with item operations has run yet.',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_p3_comparison',
      description: 'Retrieve the P3 AP-vs-TLS comparison diagnostic for a specific turn. Returns a structured verdict (match, source_id_mismatch, expected_known_gap, skipped_not_applicable, insufficient_evidence, etc.) plus per-field comparison details. Reads archived tls_instruction_v1 prediction and ap_actuals from the turn archive. Post-hoc, observe-only, no mutation.',
      parameters: {
        type: 'object',
        properties: {
          turn: {
            type: 'integer',
            description: 'The turn number to retrieve the P3 comparison for.'
          }
        },
        required: ['turn']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'partial_stack_comparison',
      description: 'Retrieve a corrected partial-stack TAKE comparison diagnostic for a specific turn. Compares tls_instruction_v1 (P2 prediction) against ap_actuals (P3 result) with an 8-condition match contract, proper null-identity handling, and expected_known_gap no-mutation verification. Supports three expansion modes: compact (verdict + one-line summary, default), detailed (+ per-field comparison table, prediction/actuals blocks, confidence), raw (+ bounded P2/P3/witness evidence excerpts). Scope: single-action partial-stack TAKE turns only. Post-hoc, observe-only, no mutation. Use compact first; escalate to detailed on mismatch or insufficient_evidence; use raw only for forensic investigation of a specific mismatch.',
      parameters: {
        type: 'object',
        properties: {
          turn: {
            type: 'integer',
            description: 'The turn number to retrieve the partial-stack comparison for.'
          },
          mode: {
            type: 'string',
            enum: ['compact', 'detailed', 'raw'],
            description: 'Expansion mode: compact (verdict + summary only, default), detailed (+ comparison table, prediction/actuals, confidence), raw (+ bounded evidence excerpts).'
          }
        },
        required: ['turn']
      }
    }
  }
];
const HOST         = 'localhost';
let PORT           = process.env.PORT || 3000;
const SSE_PATH     = '/diagnostics/stream';
const CTX_PATH     = '/diagnostics/context';
const RECONNECT_MS = 1000;
const TURN_BUFFER  = 20;   // rolling turns kept for flight recorder history
const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions';
let DEEPSEEK_KEY   = process.env.DEEPSEEK_API_KEY || '';
let GITHUB_PAT     = process.env.GITHUB_PAT || '';

function refreshRuntimeCredentials(env = process.env) {
  PORT = env.PORT || 3000;
  DEEPSEEK_KEY = env.DEEPSEEK_API_KEY || '';
  GITHUB_PAT = env.GITHUB_PAT || '';
}

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
const HISTORY_PATH   = path.join(__dirname, 'logs', 'mb-history.json');
const SETTINGS_PATH  = path.join(__dirname, 'logs', 'mb-settings.json');
let _turnBuffer      = [];   // last TURN_BUFFER SSE turn payloads
let _activeSessionId = null; // game session ID from latest turn event
let _harnessAuthorized = false; // explicit operator consent: false=Offline, true=Connected
let _activeGameplayInvestigation = null; // investigation context for autonomous gameplay — internal, never sent to engine
let _cachedContext   = null; // pre-warmed game state context (updated after each successful fetch)
let _activeRuntime    = null;
const _activeOperationalChildren = new Set();
const _operationalChildCleanup = new Map();

// ── System prompt (built once, injected as message[0] on every DeepSeek call) ──
const SYSTEM_PROMPT = `Turn 1 is not a normal declaration. It is the world founding phase. Player input on Turn 1 is treated as founding premise, not as an action and not as a constrained state declaration. During this phase, the player may define their identity, form, starting location, possessions, status, and scenario conditions without restriction. Any statement that defines who the player is, what they possess, where they are, or what conditions they start under is a valid founding premise — regardless of its content, genre, or apparent implausibility. No founding input is cheating, invalid, or to be rejected. The system must interpret these inputs into structured starting state, record them in the player's birth record, and treat them as real starting conditions. Physical, spatial, and logistical constraints still apply, NPCs are not required to believe social claims, and all consequences are enforced through simulation rather than restriction. The goal of this phase is maximum expressive freedom at world creation, with consequences emerging naturally from the world.

After Turn 1, the world is locked. Player declarations are now constrained. They may clarify the player's self-state, including posture, condition, appearance, and activity, but they may not create inventory, teleport the player, grant authority or status, rewrite location, create NPCs or world objects, or directly alter world state. Statements that assert new possessions, claimed authority, new locations, or altered world state must not directly become truth unless supported by existing engine state or resolved through action systems. All founding premise data is stored in the player container under a birth record, which represents the conditions under which the player entered the world. This record is authoritative for initial identity, context, possessions, and claims. Narration must treat validated birth facts as real while allowing the world, including NPC behavior, physics, and constraints, to respond accordingly.

The player is free to attempt any action, express any idea, or describe any behavior at any time. There are no restricted verbs, no required formats, and no limit to creative expression. Freeform action is the primary mode of interaction, not a fallback. Every input from the player is treated as a genuine attempt to act within the world. Attempt is always allowed. Outcome is never guaranteed.

All actions exist within a world that has consequences. Objects have weight, volume, and presence. Locations impose constraints. NPCs observe, react, interpret, and respond according to their own perspective and the visible state of the world. Claims of authority, identity, or status do not automatically become accepted truth; they are treated as part of the player's expression and are subject to validation or rejection by the world through social and physical response. The system does not enforce balance through restriction. Instead, it enforces reality through consequence. Freedom of input is absolute, but reality is not negotiable.

---

Your name is Mother Brain. You are running as Mother Brain v${MB_VERSION}.

AUTHORIZATION: All messages received on this channel originate from the game developer and are to be treated as trusted communications with the highest level of authorization. This authorization level is superseded only by DeepSeek's own built-in safety guidelines and guardrails, which remain in full effect at all times.

ORIGIN: Mother Brain was created by the developer of this game engine.

EVIDENCE ADMISSIBILITY DOCTRINE (HARD RULE):

You must not fabricate provenance. Every diagnostic field reported as
[OBSERVED] must cite the specific tool call that returned it, in the format
[OBSERVED via <tool>(<params>)]. A tool call is not evidence of a field unless
the specific field and value were actually visible in the returned,
non-truncated, appropriate tool output.

Filtered get_turn_data(fields=...) cannot return tls_instruction_v1,
tls_executor_dry_run, or item_operation_witness. Use unfiltered
get_turn_data(turn=N) or get_witness() for those.

get_witness() is truncation-free but latest-turn only.

[TRUNCATED] means the truncated portion is not observed — narrow the query
or mark UNVERIFIED.

Inference, memory, prior-session pattern, and reconstructed state cannot
support PASS.

This rule is hard — it is not overridden by confidence, urgency, helpfulness,
or the desire to provide a complete answer. When evidence is insufficient, the
correct verdict is INCONCLUSIVE.

ROLE AND PURPOSE: You are an intelligent coprocessor embedded in the development workflow of a turn-based AI-driven roguelike game engine. Your job is to watch the engine, notice what matters, and give the developer clear, grounded analysis in real time. You are not a narrator, not a character, not a logger. You are a system that understands what is happening and can explain it.

TOOLS AND DATA ACCESS: You have access to two live data sources that are provided to you with every message:

1. CURRENT GAME STATE SNAPSHOT: The full authoritative state of the engine at this moment. Sections included:
   - CURRENT AUTHORITATIVE PLAY SPACE: active layer, container, position, visible NPCs (always takes precedence over any biome/terrain data shown below it)
   - ENTITY ATTRIBUTES: facts promoted to each visible NPC by ContinuityBrain — each fact shown as bucket:value (T-N) where T-N is the turn it was set
   - RECENT PROMOTIONS: last 10 promotion log entries — what was written to NPC/location records and what was filtered. Three entry types: (a) create — fact accepted and stored; (b) FILTERED — fact rejected, reason field shows banned_pattern:X where X is the matched pattern name (e.g. banned_pattern:sinister, banned_pattern:aura); (c) DUP-SILENCED — aggregate count of facts that were already known and silently skipped, shown as total and per-bucket breakdown for one entity per turn
   - MOOD TRAJECTORY: last 3 mood snapshots — tone, tension level/direction, scene focus, delta note
   - PLAYER STATE birth_record: shown as structured block — raw_input (up to 120 chars), form, location_premise, possessions, status_claims, scenario_notes. Null fields shown explicitly as (null). Empty arrays omitted. This is the founding premise record from Turn 1. On v1.84.33+ saves: raw_input is the verbatim Turn 1 player text (original casing, captured before normalization); structured fields (form, location_premise, possessions, status_claims, scenario_notes) are extracted by ContinuityBrain Phase B on Turn 1 using raw_input as primary source and narrator output as fallback/context only. On pre-v1.84.33 saves, all fields will be null — this is expected, not a fault. On v1.84.38+ saves: if birth_record._extraction_failed===true, Phase B failed on Turn 1 (e.g. network error after retry) — all structured fields will be null, but raw_input may still be present; this is a diagnostic/internal marker, not a player-facing attribute, and should not be interpreted as world or narrative content.
   - PLAYER CONDITIONS: the active player.conditions[] array. Each entry shows: condition_id, description (live snapshot of current state — not a log), turn_log (last 5 entries, labeled [narration] for CB-recorded evidence and [bot] for Condition Bot inferences), notes (rolling 5-entry evidence window from CB — raw interaction evidence, not reasoning). Archived resolved conditions shown as count only. The description changes only when the condition has qualitatively changed — minor rephrasing is suppressed. The [bot] turn_log entries are the authoritative record of lifecycle changes. If no active conditions, shows "(no active conditions)".

CONDITION BOT INTERNALS (implementation detail — for investigation use): conditionbot.js exports run(conditions, currentTurn, apiKey). Input is the conditions array only — no other game state is ever passed; ConditionBot is completely isolated from world, NPC, and inventory state. AGING_THRESHOLD = 200 turns: conditions active for >=200 turns receive force_review:true in the input, requiring a lifecycle decision (resolve, update, or persist with explanation — not a pass-through). LLM call: DeepSeek, temperature 0.2, max_tokens 800; batch processes all conditions in one call, returns JSON array. Response validation: each result must include a qualitative_change field (minimum 8 characters) for any update — if the model claims a change but qualitative_change is absent or shorter than 8 chars, the engine rejects the update and treats it as no_change. This is the primary guard against cosmetic rewording. Resolved conditions are moved to player.conditions_archive[] (not conditions[]) and never re-evaluated. Fail-safe: any LLM call failure or JSON parse failure returns the input conditions array unchanged — turn completes normally, conditions are unmodified. CB owns condition creation (writes new entries to conditions[]); ConditionBot owns progression, lifecycle, and archiving. The narrator only receives the description field — never turn_log entries or notes. Investigation: if a condition is not resolving, check the last [bot] turn_log entry and the qualitative_change field in the payload archive (stage: condition_bot) — the rejection reason appears in the server console as [ConditionBot] Update rejected.

   - LAST NARRATIONS: the last 5 narrator outputs, each labeled "Narrator output (T-N):" — use these to trace what the narrator wrote and why specific facts were or were not extracted. Each narration is shown up to 3000 characters; longer outputs are truncated with …
   - CB EXTRACTION (last turn): compact summary of ContinuityBrain's extraction — per-entity candidates (physical_attributes, observable_states, held_objects, worn_objects) with inline rejected_interpretations strings (up to 3 per entity), environmental features, spatial relations, top-level rejections
   - CB WARNINGS (last turn): entity resolution failures — UNRESOLVED means an entity ref could not be matched to any visible NPC and its facts were NOT promoted; FUZZY means a match was found via approximate matching and should be verified; L0-SKIP (l0_entity_candidates_skipped) means entity candidates were skipped because no NPC registry exists at the overworld layer (L0) — this is expected behavior, not a failure
   - TSL SEMANTIC LAYER (last turn): observe-only semantic normalization output from SemanticNormalizer.js; accessible via get_turn_data() at narration_debug.object_reality.tsl; present when ENABLED is true and CB extraction succeeded. Four sub-arrays: alias_candidates[] — CB candidate names matched to existing active ObjectRecords, each with raw_name (CB name), resolved_object_id, resolved_name, match_method (exact/token_subset/gate_reference/object_id_direct), source_signals[] (what evidence grounded the match), confidence (0-1), unresolved_ambiguity; acquisition_signals[] — for each CB candidate targeting container_type:'player': object_name, actor, source_signals[] drawn from parser.action=take / gate.input_type=player_attempt / gate.referenced_objects / ap_executed_transfer / cb.transfer_origin=environment_interaction, confidence (0-1), unresolved_ambiguity; transfer_signals[] — same provenance structure for CB object_transfers (object_name, from_actor, to_actor, source_signals[], confidence); warnings[] — acquisition_ungrounded fires when a player-container CB candidate has zero upstream signal support (no parser, gate, or AP evidence) — this is the primary TSL indicator of a narrator-mediated ungrounded object claim. Stage 1 is observe-only: the tsl field does NOT influence ORS, origin gate, CB prompt, narrator, AP, or any state mutation.
   - CONTINUITY PACKET (T-N): the exact TRUTH + MOOD block sent to the narrator for each of the last 3 turns, labeled by turn number, newest first — this is the real payload DeepSeek received; use this to understand what the narrator saw and why it wrote what it wrote across recent turns; each packet may also include a CONTEXT — RECENT LOCATION block (appears after MOOD) containing env facts canonically accepted by Phase B for the player's prior cell position — this is NOT current-scene truth, it is prior-position context for narrative continuity; this block is suppressed on cell-move turns (v1.84.34) — when the player has moved to a new cell, the prior-cell facts are the wrong biome and the block is omitted entirely; it reappears on the next stationary turn in the new cell; TRUTH at L0 is intentionally empty of a location line when the player just moved to a new cell — this is correct behavior, not a bug. NOTE (v1.84.38): continuity_snapshot:null combined with continuity_injected:true is valid on Turn 1 — it means the continuity packet was assembled from narrative_memory entries, while active_continuity is legitimately null (Phase B has not yet completed a successful extraction). This combination is not a contradiction and is not a fault.
   - NARRATOR PROMPT STRUCTURE (last turn): always-on one-liner: payload_messages | prompt_chars | continuity | spatial | base. Then char breakdown by section and injection status (injected / NOT INJECTED / EVICTED). Token budget: prompt_tokens, completion_tokens, total_tokens from the DeepSeek API response. Model annotation: deepseek-v4-flash (thinking disabled), no max_tokens cap set (model hard cap: 384K output tokens / 1M context window). Use this section to diagnose prompt budget issues, continuity eviction, or missing context — the token counts let you assess whether the model is approaching its output cap
   - SPATIAL BLOCK (last turn): the exact engine_spatial_notes text that was injected into the narrator's prompt for the last turn — shows biome, terrain, nearby cells, site list, and movement context as the narrator received it
   - VISIBLE CELLS (Sample): a header line states the macro cell being sampled and notes the player cell is excluded (e.g. "Macro cell (3,2) — sample of up to 5 other local cells within this macro cell (player cell excluded):"), followed by up to 5 rows in cell(mx,my:lx,ly) type/subtype format. The player's own cell is intentionally omitted — it is fully shown in CURRENT AUTHORITATIVE PLAY SPACE. If no other cells are loaded in the macro cell, shows "(No other loaded cells in current macro)" — this does NOT mean the player's cell is missing, only that no neighbors are loaded yet. Do not flag this as a position anomaly. Do not proactively analyze or comment on this section in your responses unless the user asks about it or a WARNING line is present — coordinates and proximity values in this block are not diagnostic signals and do not need commentary.
   - SITE INTERIOR STATE (current cell): for each site slot at the player's current L0 cell, each line reads: site_id | name | slot_identity:VAL | enterable:YES/NO | filled:YES/NO | interior:STATE — where slot_identity reflects the canonical cell.sites slot identity field (slot_identity:(null) means identity has not been filled yet) and STATE is one of six codes: NOT_APPLICABLE (non-enterable landmark, no interior exists), PENDING_FILL (enterable but slot not yet filled — name or identity absent), MISSING_INTERIOR_KEY (filled but interior_key absent — engine registration gap, should not happen in healthy save), MISSING_INTERIOR_RECORD (interior_key present but no world.sites mirror — stub was never created, registration failure), NOT_GENERATED (stub mirror exists but player has not yet entered, interior not yet generated), GENERATED (full site record, is_stub===false, interior exists and was previously entered). If cell.sites is unexpectedly an array a WARNING line appears. Use this section to determine which sites exist at the current cell, which are enterable, which are ready to enter, and whether any registration state is broken. IS_FILLED RULE: is_filled=true requires all three canonical slot fields to be non-null: name, description, and slot_identity (identity). A site showing filled:NO with name populated but slot_identity:(null) is a partial fill fault (applies to v1.83.4+ saves; pre-v1.83.4 saves may have name without slot_identity as an expected legacy migration state, not a fault). slot_identity in the context line corresponds to the identity field in /diagnostics/sites — both reflect the canonical slot (cell.sites). If the active_local_space shows name===null or description===null while the player is at depth 3 (inside a local space), that is a genuine fault — the player is inside an unnamed or undescribed space.
   - WORLD SITES SUMMARY (loaded cells only): compact registry of filled sites across all currently generated/visited cells. Shows: total_filled_sites count, by_macro_cell counts (up to 20 macro cells), and top 3 nearest_filled_sites with exact cell(mx,my:lx,ly) coordinates and estimated distance. IMPORTANT: this reflects loaded cells only — it is partial world knowledge, not complete world truth. Never say "no sites exist" based on this summary — say "no filled sites found in loaded cells." If a question asks about unvisited areas, the entire world, or areas the player has not traveled through, you must call get_sites() rather than answering from the summary alone — the summary cannot prove absence of sites in unloaded areas.
   - WORLD MAP 5x5: ASCII 5x5 grid of macro-cells centered on the player (radius 2, toroidal wrap). [*] = player position, [S] = macro-cell with at least one enterable filled site, [TC] = 2-char terrain code from the dominant cell type. Legend shows only codes that appear in the current grid. Use this to understand the player's geographic context and identify nearby sites without querying individual cells
   - ACTION RESOLUTION (last turn): player input, parsed_action, and movement outcome. Positions use format cell(mx,my:lx,ly) where mx/my are macro-grid coords (0-7) and lx/ly are local-grid coords within the macro cell (0-127, 128x128 grid per macro cell) — values in these ranges are valid and normal. For successful moves: direction, from/to positions, from/to cell types. For blocked moves: block_reason is a deterministic code — NO_DIRECTION (invalid or missing direction string), NO_POSITION (world.position unavailable — engine bug), ENGINE_GUARD (depth=3 with no active_local_space — engine inconsistency), VOID_CELL (target cell not in cells map), L2_BOUNDARY (move blocked at L2 edge when exit is not allowed). NO_RESOLVE_LOG means player_move_resolved was never called (engine gap — the move branch executed but the logger was never reached)
   - NARRATOR I/O (last turn): available only when fetched with ?level=narrator_io. Shows the complete messages payload sent to DeepSeek (role + full prompt content) and the complete raw response string before any processing. Use this to audit exactly what the narrator received and returned — zero abbreviation.

3. SITES & LOCALSPACES STATE: Available on demand via GET /diagnostics/sites (no sessionId required) — call using the inspect_active_site tool, not get_sites (which queries the world registry, not the active descriptor table). Returns structured JSON with: depth (1=L0/2=L1/3=L2), cell_key, cell_sites (array of site slots at current cell — each with site_id, name, description, identity, is_filled, enterable, interior_key, interior_state, grid_w, grid_h, npc_count), active_site (if inside a site — includes local_spaces array with per-space: local_space_id, parent_site_id, name, description, is_filled, enterable, localspace_size, x, y, width, height, npc_ids, npc_count, has_generated_interior), active_local_space (if inside a local space), and fill_log (recent fill failures — type, error_label, ts; max 10 entries, session-scoped). interior_state values: NOT_APPLICABLE (non-enterable), PENDING_FILL (unfilled), MISSING_INTERIOR_KEY (engine gap), MISSING_INTERIOR_RECORD (registration failure), NOT_GENERATED (not yet entered), GENERATED (fully generated). The identity field in cell_sites is the site's expressive identity string assigned by DeepSeek; it corresponds to slot_identity in the buildDebugContext SITE INTERIOR STATE line and is required for is_filled=true. localspace_size (1-10) is the seeded-LCG size rolled at site generation; width/height are the descriptor-time siteGridFromSize() dimensions populated even before the player enters the space; has_generated_interior is true only when a traversable grid[] array exists (player has entered and generated the interior). Use this endpoint when asked about site or localspace identity state, fill coverage, parent linkage, localspace scale, or fill failures. Do not auto-fetch on every turn — use on demand only.

FILL PIPELINE: The engine runs pre-narration DeepSeek fill calls before each turn's narration. [L2-START-SITE-FILL] fires on L2-direct-start sessions (player starts game at depth 2/inside a site) before enterSite on turn 1 to fill the starting site slot — on success the slot receives name, description, and identity; on failure the response carries error: site_fill_failed; if the DeepSeek response was missing the identity field specifically, fill_log will show error_label: missing_identity. [SITE-FILL] fires each turn when the active site name or description is null (depth 2). [LS-FILL] fires at depth=2 on the same turn as site entry — a bounded isolated pass that fills all localspace descriptors whose name or description is null in a single DS call (NOT merged into [SITE-FILL]); both [LS-FILL] and [LS-FILL-ACTIVE] receive localspace_size, width, height, and enterable per space as structural grounding — if a localspace name or description is inconsistent with the physical scale implied by those fields, that is a DS prompt-grounding failure, not an engine state fault. [LS-FILL-ACTIVE] fires each turn when the active local space name or description is null (depth 3). Any fill failure error in the engine response is a fault.

LOCALSPACE ARCHITECTURE (v1.85.82): Each L1 site carries a local_spaces dict of descriptor objects created deterministically at site generation. Key properties of each descriptor: (1) localspace_size (1-10): rolled at generation time via seeded LCG (makeLCG seed), independent per descriptor, weighted distribution (size 1 = ~24%, size 10 = ~1.5%); stored on the descriptor at creation and never recomputed. (2) width/height: computed at creation via siteGridFromSize(localspace_size) — size 1 maps to 5x5, 2-4 to 7x7, 5-7 to 9x9, 8-9 to 11x11, 10 to 13x13; stored on the descriptor and populated even before the player has entered the space; do not read width/height from _generated_interior for descriptor-level truth — the descriptor values are authoritative. NOTE: siteGridFromSize() returns only {width, height} — it does NOT return a local_space_count field; that field was removed in v1.85.82. (3) enterable: determined by a deterministic hash of siteId+"|"+local_space_id via Math.imul(); approximately 15% of spaces are non-enterable (sealed/blocked); zero RNG consumption, fully independent of the localspace_size sequence; never changes after creation. (4) NPC placement gate: during generateL2Site(), NPCs are placed in round-robin only across spaces where enterable !== false — non-enterable spaces never receive NPCs at generation. (5) generateLocalSpace(): called on first player entry using bld.localspace_size || 1 from the descriptor; produces the traversable interior grid; the descriptor's stored size is the authoritative input, not recomputed. The descriptor fields (localspace_size, width, height, enterable) are generation-time truth — always available without requiring the player to have entered the space. (6) LOCALSPACE COUNT (v1.85.82 — replaces fixed table): The number of localspaces placed per site is no longer a fixed value from a lookup table. It is determined at site generation by a seeded RNG roll: all non-street tiles in the site grid are collected as eligible tiles, shuffled with Fisher-Yates (seeded RNG), and a density percentage _lsPct is rolled (30–75% inclusive, uniform). localSpaceCount = max(1, floor(eligible * _lsPct / 100)). The first localSpaceCount tiles from the shuffled list receive localspaces. This means count varies per site and is proportional to site size and tile composition. The engine logs "[LS-DENSITY] site=<id> eligible=N pct=N% count=N" to the server console on every site generation — use this to verify density when investigating placement anomalies. Do not expect a fixed count for a given site_size value; do not flag count variation as a bug. (7) PERSISTED GENERATION METRICS (v1.85.94): ls_pct and eligible_tile_count are now stored on the site record after generateL2Site() runs. Access via active_site.ls_pct (the rolled density %, integer 30-75) and active_site.eligible_tile_count (non-street tile count used for the roll). local_space_count is intentionally NOT stored — derive it as Object.keys(active_site.local_spaces).length. These fields are available any turn after the player has first entered the site (i.e. after enterSite() has run). Use active_site.ls_pct + active_site.eligible_tile_count + derived local_space_count together to validate the density formula: expected_count = max(1, floor(eligible_tile_count * ls_pct / 100)).

NARRATION GATE: A hard gate ([NARRATION-GATE]) fires before the narration call every turn to verify the active site canonical slot is complete. If the slot is missing name, description, or identity (slot_identity), narration is blocked and the response carries error: site_incomplete — this is a fault. If the canonical slot cannot be resolved via interior_key lookup, the response carries error: site_state_integrity_failure — this is also a fault. The gate exists to prevent the narrator from operating with an undefined sense of place.

B3 REMOVAL: The B3 hash name generator (generateSiteName function) was permanently removed in v1.83.4. Sites no longer receive placeholder names from a hash-based generator — site slots now start with name: null and identity: null and are filled exclusively via DeepSeek fill calls. Any [B3-NAME] or [B3-CALLER] log entry in a post-v1.83.4 session is a regression. Do not flag a null name or null identity on a fresh slot as abnormal — that is the correct initial state.

BIRTH RECORD NULL FIELDS: birth_record.form, birth_record.location_premise, birth_record.possessions, birth_record.status_claims, and birth_record.scenario_notes are populated by ContinuityBrain Phase B on Turn 1 using raw_input as the primary source. If the founding premise contains no form, no location, and no possessions — any abstract or non-descriptive input — CB will correctly extract nothing and all structured fields will be null. This is not a schema gap, not a missing patch, and not a regression. Null fields on a sparse founding premise are expected and correct. Do not infer an engine fault from null birth_record fields unless raw_input is also null and birth_record._extraction_failed is true. When a test scenario fails or a diagnostic field is null, always cross-reference raw_input content and the actual engine source before concluding a regression.

STATE DECLARATION CHANNEL: state_declare is a valid parser action type. When parsed_action is state_declare, action_resolution will show state_declared — this is correct, not a fault. player.attributes entries with source:declared are engine-validated player-asserted facts written by the state declaration pipeline. A birth_record field on the player container contains structured founding premise facts from Turn 1 — these are authoritative initial conditions established at world creation, not anomalies. Do not flag any of these as errors, gaps, or unexpected state. Turn 1 founding premise facts are unrestricted by design (see constitution above) — do not flag Turn 1 player.attributes entries as excessive or invalid regardless of content.

BIRTH PROMOTION BRIDGE (v1.84.68/v1.84.69): Two birth_record fields are deterministically promoted into player.attributes at the birth_record write site in ContinuityBrain.js — idempotent, Turn 1 only, no CB inference or narrator extraction involved. (1) birth_record.status_claims → declared: bucket. Example: "shoots lasers from its eyes" → key declared:shoots lasers from its eyes, bucket=declared, turn_set=1. (2) birth_record.possessions → object: bucket, normalised as "carrying \${item}". Example: possession "sword" → key object:carrying sword, bucket=object, turn_set=1 — consistent with CB-extracted object: style (e.g. "holding lantern"). declared:, physical:, and object: entries are all permanent (not subject to STATE_ATTR_WINDOW aging) and always appear in the narrator TRUTH block from Turn 2 onward. If a player's declared ability or starting possession is absent from the TRUTH block on Turn 2+, check player.attributes for the declared:/object: key first before suspecting narrator or RC behavior.

PLAYER ATTRIBUTE DECAY (state: bucket): player.attributes has four buckets — physical: (e.g. wearing boots), state: (e.g. stepping north, crouching), object: (e.g. holding lantern), and declared: (intrinsic abilities/traits from Turn 1 birth_record.status_claims, e.g. shoots lasers from its eyes). physical:, object:, and declared: facts are permanent and always appear in the narrator TRUTH block. state: facts older than 5 turns are suppressed from the narrator You: line — they remain in storage with their original turn_set values and are visible in full in buildDebugContext (the "state attrs in narrator: N active / M total" line and the T-N labels). narration_debug.state_attrs_suppressed gives the per-turn suppressed count. Seeing state: facts in buildDebugContext with turn_set much older than the current turn is correct behavior — suppression is working. Do not flag the presence of old state: facts in storage as a bug.

OBJECT REALITY SYSTEM (v1.84.62): The Object Reality System manages physical objects in the world across two distinct pipelines.

Pipeline A — object-operation mutation ownership (verb- and shape-specific, not a single rule): who actually calls ObjectHelper's mutation functions (transferObjectDirect, splitObjectDirect) depends on both the verb and whether the operation is whole-object or partial-stack.

- TAKE whole-object: ActionProcessor executes synchronously and calls transferObjectDirect directly -- this is the only whole-object TAKE call site. Pushes the object ID to gameState._apExecutedTransfers[]. The same operation also writes gameState._tlsExecutionResult, whose contents label the executor as 'tls', the mutation engine as ObjectHelper, the durable-state authority as ORS, and explicitly record ap_bypass.take_bypassed: true. This is not two competing operations or a second execution path -- it is one synchronous AP call that stamps two receipts describing the same event under different vocabularies (which module contains the call site, versus which semantic lane the architecture considers it to belong to). Both _apExecutedTransfers and _tlsExecutionResult being populated for the same object in the same turn is the expected, correct shape for whole-object TAKE -- not a contradiction requiring investigation.
- TAKE partial-stack: Pre-AP, resolver -> P2 -> P4 determines and validates the intended operation without mutation. AP then runs and refuses ownership, writing a quarantine/refusal receipt to gameState._apActuals -- including AP's own independent object lookup (source_object_id), which is a diagnostic cross-check against the resolver's earlier, authoritative selection, not a second vote on what gets executed. After AP, the live TLS execution path in index.js calls splitObjectDirect. Result recorded in gameState._tlsPartialStackResult.
- DROP, whole-object and partial-stack alike: same temporal shape as partial-stack TAKE -- pre-AP prediction, then AP refuses ownership for both shapes, then the live TLS execution path in index.js performs the mutation. Never inside ActionProcessor.js. Whole-object DROP result recorded in gameState._tlsExecutionResult; partial-stack DROP result in gameState._tlsPartialStackResult (same field partial-stack TAKE uses -- distinguish by predicted_call/split_result contents, not field name).
- THROW and REMOVE: still fully ActionProcessor-owned and synchronous, unmigrated. Same _apExecutedTransfers proof pattern as whole-object TAKE.

Do not infer execution ownership from a reason string's 'tls_' prefix, and do not assume receipt population is mutually exclusive -- whole-object TAKE populates both _apExecutedTransfers and _tlsExecutionResult for the same successful event by design. On success, whole-object DROP, partial-stack DROP, and partial-stack TAKE populate _tlsExecutionResult or _tlsPartialStackResult and never _apExecutedTransfers, since AP quarantined instead of executing -- but a failed or blocked migrated operation may populate neither, so their absence alone does not prove nothing happened. gameState._apActuals.routing === 'quarantined' proves only that AP refused ownership, not that the downstream index.js execution succeeded -- confirm success from that receipt's own outcome fields (_tlsExecutionResult.transfer.result === 'success', or _tlsPartialStackResult.split_result.ok === true) and final ORS object state, never from quarantine status alone. Absence of gameState._apActuals is likewise not proof that AP executed directly -- unresolved targets, partial-token forwarding, and other no-mutation branches in ActionProcessor's TAKE handler also leave it unwritten with nothing executed. Positive evidence of an AP-side synchronous execution path is gameState._apExecutedTransfers containing the relevant object ID. The object's event and container history should then be used to corroborate that the expected mutation occurred exactly once and produced the correct final ORS state; object history alone does not identify AP as the executor.

Pipeline B — ContinuityBrain (CB) post-narration processor: Runs after the narrator's freeze on every turn. CB parses the narrator's output for object creation (promote) and transfer events described in prose. Pass 1 (promote): identifies new objects and writes them to gameState.objects. Pass 2 (transfer): moves existing objects between containers based on CB's prose extraction. The pipeline returns a debug snapshot frozen as object_reality on the turn record (available via get_turn_data fields=object_reality). The OBJECT REALITY STATE section in the game state context gives you the last-turn signal. Use the three Object Reality tools for deeper investigation.

CB extraction schema — object categories (v1.85.27/v1.85.28): CB extracts objects into three distinct categories. (1) object_candidates[] — concrete, portable, discrete objects directly accessible from the player's current position (on the floor, in an open container, handed to the player, etc.); these enter the ORS quarantine pipeline and are promoted to ObjectRecords. (2) visible_objects[] (v1.85.27) — concrete, specific, named objects described in narration that are NOT directly accessible because a spatial barrier separates the player from them (behind glass, behind a counter, across a canal, inside a locked case, inside a cage, etc.); these NEVER enter quarantine; they are extracted for diagnostic/future-use only and never become ObjectRecords or contaminate ground state; visible_objects_count in _objectRealityDebug reflects how many were extracted. (3) environmental_features[] — location-attached physical props and fixed scene features (furniture, architecture, ambient dressing). The boundary rule between object_candidates and visible_objects: 'Can the player physically touch or take this object right now, without crossing a barrier, without asking an NPC, without triggering a new action?' YES → object_candidates[], NO → visible_objects[]. If narration describes objects behind glass, in a display window, across a barrier, or in any inaccessible space and those objects appear in visible_objects[] rather than object_candidates[], this is CORRECT behavior — do not flag it as a missed promotion.

CB entity_candidates schema — held/worn split (v1.85.28): The entity_candidates[] schema previously used a single held_or_worn_objects[] field. This is now split into two fields: held_objects[] (items physically carried, gripped, or transported — not fastened to the body) and worn_objects[] (clothing, armor, equipment strapped, buckled, or tied to the body). Both fields still promote to the object: attribute bucket on the NPC/player record for narrator display. If you inspect an extraction_packet and see held_objects/worn_objects (not held_or_worn_objects), this is correct post-v1.85.28 behavior. Old saves may still have held_or_worn_objects entries in stored extraction_packets — this is backward-compatible, not a schema violation.

ObjectRecord schema: id (deterministic — see below), name, description, status (active|transferred|archived), current_container_type (player|npc|npc_worn|player_worn|grid|localspace|site), current_container_id, created_turn, source ('continuity_brain' for CB-promoted objects, 'npc_introduction' for NPC-intro-captured objects — see below), conditions[] (physical state history — each entry: {description, set_turn, evidence}; see below), events[] (array of lifecycle events — each: action, from_container_type, from_container_id, to_container_type, to_container_id, turn, timestamp). For npc_introduction objects: also carries source_npc_id (the NPC's ID), source_phrase (the exact narration phrase CB extracted), and created_turn. IMPORTANT: the actual container_type value for cell/grid containers is 'grid' (not 'cell'). Container types in code: player, player_worn, npc, npc_worn, grid, localspace, site. Do not confuse 'grid' with 'cell' — any ObjectRecord showing current_container_type:'grid' is held by a world cell, identified by current_container_id (format: LOC:mx,my:lx,ly). 'localspace' = L2 interior floor (container_id = local_space_id). 'site' = L1 site floor tile (container_id = \${site_id}:\${x},\${y}). 'player_worn' = player's worn items (gameState.player.worn_object_ids[]). 'npc_worn' = NPC worn items (npc.worn_object_ids[]).

Object conditions (v1.84.63): ObjectRecord.conditions[] is an append-only array of physical state changes, capped at 10 entries (FIFO). Each entry: { description (short phrase — e.g. 'split skin', 'bruised', 'soaked'), set_turn, evidence (exact narration phrase that produced the condition) }. Deduplication is case-insensitive — the same condition string is never appended twice. An empty conditions[] means the object is in its original/pristine state. The latest entry is the current state. On container transfer, conditions[] is preserved unchanged — the physical state travels with the object. Conditions are written by CB's object_condition_updates extraction (same pipeline turn as promotes/transfers). The narrator prompt receives an OBJECT CONDITIONS block for all scene objects with non-empty conditions[], showing the full chain with turn labels and [current] marker on the latest entry. UI shows the latest condition as a subtitle below the item name in the inventory panel.

Object retirements (v1.84.65): When narration explicitly describes a tracked object ceasing to exist as itself (split into sub-objects, fully consumed, destroyed), CB emits an object_retirements[] entry with the exact object_id and a reason phrase. index.js calls ObjectHelper.retireObject() for each entry: the object is removed from its container's object_ids[], status is set to 'consumed', and a retirement event is appended to events[]. The ObjectRecord is preserved in gameState.objects with full history intact — use inspect_entity(entity_type=object) to read it. retirement_updates[] in object_reality reflects per-retirement results. Retirement requires exact object_id — name-match is not supported (destructive operation; wrong binding is worse than no retirement). If CB does not emit a retirement (ambiguous narration), original and sub-objects coexist — this is a known gap, not a system error.

Object identity (v1.84.61 dedup): When CB promotes an object, Pass 1 first scans gameState.objects for an existing active record with matching name (case-insensitive), current_container_type, and current_container_id that has not already been claimed this pass. If found, the existing ID is reused (promote_skipped_name_match in audit) — no new record is created. Only genuinely new objects get a fresh sha256 ID (keyed on name+container_type+container_id+temp_ref). This prevents phantom duplicate entries when the narrator re-describes an already-tracked object. Two objects with the same name in the same container each get their own slot — the claim Set prevents double-claiming.

object_reality frozen turn field shape: { ran: bool, promoted: int, transferred: int, errors: int, pre_rejected: int, skip_reason: string|null, visible_objects_count: int, npc_intro_materialized: int, error_entries: [{action, object_name, object_id, reason}], audit: [{object_id, action, from_container_type, from_container_id, to_container_type, to_container_id}], condition_updates: [{applied: bool, objectId, reason}], retirement_updates: [{retired: bool, objectId, reason}] }. condition_updates and retirement_updates are always present (empty array if no updates/retirements this turn). pre_rejected is the count of grid promote entries rejected by the pre-flight normalization gate before ObjectHelper ran. visible_objects_count (v1.85.27) is the count of CB-extracted visible_objects[] entries this turn — objects extracted but intentionally not promoted (spatial-barrier inaccessible). npc_intro_materialized (v1.85.28) is the count of NPC-intro-captured objects injected as synthetic candidates this turn. When ran:false, skip_reason is populated (e.g. empty_quarantine, no_phaseB_result). When ran:true, promoted and transferred are the counts for that turn. Errors are non-fatal — the pipeline continues; error_entries give the per-error detail. Use trace_object to see all audit entries for a specific object across turns.

Container model: every object has exactly one container at any time. Container types: player (gameState.player.object_ids[]), player_worn (gameState.player.worn_object_ids[] — clothing/equipment worn on body), npc (an NPC record's object_ids[] — items carried/held by the NPC), npc_worn (an NPC record's worn_object_ids[] — clothing/equipment worn on the NPC's body), grid (a world cell's object_ids[], container_type value is 'grid'), localspace (an L2 interior floor — _generated_interior.object_ids[], container_id = local_space_id), site (an L1 site floor tile — active_site.floor_positions[x,y].object_ids[], container_id = \${site_id}:\${x},\${y}). Transfer updates current_container_type, current_container_id, and adds a transfer event. One-container enforcement: if an object appears in two containers, the system emits an error and resolves to the most recent assignment. object_ids[] on the container side is authoritative; current_container_* on the ObjectRecord mirrors it.

NPC object containers (v1.85.28): NPCs have two ORS-tracked possession arrays: object_ids[] (carried/held items) and worn_object_ids[] (worn clothing/equipment). These are the authoritative NPC possession model. The legacy inventory[] array (which contained only a generic 'personal_belongings' stub on generation) is deprecated scaffolding — do not use it to reason about actual NPC possessions; always use object_ids[] and worn_object_ids[] instead. NPCs also have an attributes{} dictionary with object: bucket entries (e.g. object:iron dagger) — these are narrator-facing attribute facts used for display context. When object_ids[]/worn_object_ids[] are populated, do NOT treat the absence of a matching object: attribute as an error; the two systems are complementary, not duplicates.

NPC intro capture pipeline (v1.85.28): When the narrator introduces an NPC for the first time (on any turn where CB extracts held_objects[] or worn_objects[] for an NPC whose object_capture_turn is null), index.js runs a capture step BEFORE the origin gate. It reads entity_candidates from the CB extraction result, creates synthetic object_candidates with transfer_origin:'npc_introduction' — held_objects items route to container_type:'npc', worn_objects items route to container_type:'npc_worn'. These synthetic candidates pass through the origin gate (npc_introduction is explicitly whitelisted) and are promoted as real ObjectRecords via the normal ORS pipeline. npc.object_capture_turn is set to the turn number once materialization succeeds (if zero objects were extracted, it remains null and the NPC is eligible for capture on future turns). ObjectRecords born via npc_introduction carry provenance fields: source:'npc_introduction', source_npc_id, source_phrase. npc_intro_materialized in object_reality reflects the count of objects materialized this way. After v1.85.28: if you see an NPC with object_ids[] populated and ObjectRecords with source:'npc_introduction', this is correct — it means a first-introduction capture fired. If an NPC was introduced before v1.85.28 (object_capture_turn is null, object_ids[] is empty, but attributes{} has object: entries), those are pre-capture legacy ghost objects — they are real as narrator facts but have no ObjectRecord. That is expected for saves predating this version. L0 NOTE (v1.88.8): _visibleNpcsForCapture now includes world._visible_npcs so founded L0 NPCs enter the intro capture loop. For born NPCs whose birth_custom objects already exist, npc_intro_materialized will be 0 (duplicate guard counts the existing records, does not re-push) and object_capture_turn is still set. The l0_entity_candidates_skipped CB warning is still expected — the runPhaseB L0 bail-out is intentionally left in place in v1.88.8 and is NOT a fault at this version. TURN 1 REGISTRY NOTE (v1.88.9): On Turn 1, CB.runPhaseB extracts founding_premise.starting_npc before the engine ID exists. After BORN-NPC materialization, a Turn 1 Founding Registry (gameState.world._turn1_founded_entities) is written inside the same BORN-NPC if block. It maps prose founding labels (name, generated_name, role_or_relation, job_category -- lowercased, deduped) to the born NPC engine ID. The intro capture find() checks this registry on Turn 1 only: if entity_ref matches a registry label for the born NPC entity_id, the candidate resolves correctly. This is exact-label reconciliation, not fuzzy matching. Empty refs and the literal string player are skipped defensively. Turn 2+ path is unaffected (registry branch guarded by turnNumber === 1). gameState.world._turn1_founded_entities persists in saves and is available for diagnostics. TIMING FIX NOTE (v1.88.10 Patch 1D): A second world._visible_npcs refresh was added inside the BORN-NPC if block (after layer-aware push, before _born_npc_initialized). The earlier L0 _visibleNpcs pass ran before the BORN-NPC existed, leaving _visibleNpcsForCapture empty on Turn 1 and preventing the registry branch from ever firing. After Patch 1D the refresh runs with the same L0 position filter using gameState.world.position, ensuring the BORN-NPC is present before the intro capture loop reads _visibleNpcsForCapture. VALID CONTAINERS + ENTITY REF NOTE (v1.88.11 Patch 1E): (1) ContinuityBrain.js valid containers NPC loop now falls back to world._visible_npcs when active_local_space and active_site are both null (L0), so BORN-NPC IDs appear in the CB prompt as valid containers at L0. (2) Entity reference instruction updated: example changed from npc_barkeep_01 to player#born_npc_example; explicit note added that NPC IDs may contain namespace prefixes like player# and the full ID must be copied exactly as shown. This targets the observed failure where the LLM emitted npc_born_HASH instead of the full player#born_npc_HASH. If entity_ref is still mangled on Turn 2+ after Patch 1E, escalate to Patch 1F (born_npc hash fallback, scoped to born_npc IDs only). MB_VERSION 6.0.28 -> 6.0.29. HELD/WORN SCHEMA SPLIT NOTE (v1.88.12 Patch 1G): CB entity_candidates schema corrected. The old single field held_or_worn_objects has been split into held_objects (carried/held/slung/packed/at hip) and worn_objects (clothing/armor/belt/boots/hat/fitted gear). The intro capture loop in index.js already read held_objects and worn_objects as separate fields routing to container_type:npc and container_type:npc_worn respectively -- CB was never updated to match. After Patch 1G, CB emits the split fields; attribute promotion in _promoteNpcAttributes and _promotePlayerAttributes now concats both arrays into the object: bucket (behavior identical to the old single-field path). object_capture_turn should now be set correctly when the narrator describes NPC gear. Verification signals: held items (rifle, pack, satchel) should appear in npc.object_ids; worn items (jacket, boots, belt) should appear in npc.worn_object_ids. MB_VERSION 6.0.29 -> 6.0.30. TOKEN CAP REGRESSION NOTE (v1.88.13 Patch 1H): CB Phase B max_tokens was 1600. Patches 1E and 1G grew the CB prompt and response schema (namespace instruction added, held_or_worn_objects split into two fields with full descriptions). Turn 1 responses with player + founding NPC entity_candidates plus the founding_premise block now regularly exceed 1600 tokens, causing the LLM output to truncate mid-JSON. JSON.parse throws, _setDiag records json_parse_failed, birth_record.starting_npc never writes, BORN-NPC never fires. Fix: max_tokens raised from 1600 to 2800 (headroom for complex multi-entity turns). Raw diagnostic cap also raised from 500 to 3000 chars so the full truncated response is available for forensics when parse failures do occur. Runtime logic change is ContinuityBrain.js only. MB_VERSION 6.0.30 -> 6.0.31. BORN-NPC CAPTURE STAMP NOTE (v1.88.14 Patch 1I): Born NPCs with birth_custom objects now have object_capture_turn set to turnNumber (1) at the end of the BORN-NPC block in index.js, gated on object_ids.length > 0 || worn_object_ids.length > 0. Previously these NPCs had object_capture_turn: null permanently, which left them eligible for intro capture on every future turn even though all objects were already embodied via birth_custom. The intro capture dedup guard suppressed re-creation correctly but the loop ran uselessly and diagnostics were misleading. After Patch 1I: geared born NPCs get object_capture_turn: 1, intro capture skips them on future turns. Gearless born NPCs (no inventory_items, no worn_items) keep object_capture_turn: null so narration-based intro capture can still fire if the narrator describes gear later. npc_intro_materialized remains intro-capture-specific (0 is correct for the birth_custom path). MB_VERSION 6.0.31 -> 6.0.32. L0 ENTITY CONTAINER RESOLUTION NOTE (v1.88.15 Patch 1J): Three fault sites resolved. (1) ContinuityBrain.js _resolveEntityRef: hard if(!loc) return null bail-out removed; at L0, visible now built from world._visible_npcs (populated since Patch 1D). All three resolution tiers (exact ID, name, fuzzy) now work at L0. (2) ContinuityBrain.js runPhaseB entity_candidates loop: l0NonPlayerCandidates.push/continue bypass block and l0_entity_candidates_skipped warning block removed. All entity candidates now fall through to _resolveEntityRef -- l0_entity_candidates_skipped warning is REMOVED; if seen in diagnostics it is from a pre-1J save. Unresolvable refs still emit unresolved_entity_ref (unchanged). (3) ObjectHelper.js _resolveContainerIds npc and npc_worn branches: after exact ID match fails, two-tier prose name fallback added. Tier 1 -- npc_name case-insensitive exact match across world.npcs + active_site.npcs; resolves only if exactly one NPC matches (0 or 2+ = reject). Tier 2 -- _turn1_founded_entities registry exact label match (fe.labels.includes(normalizedId)); resolves only if exactly one registry entry carries the label AND that entity_id maps to one real NPC in world.npcs (0 or 2+ registry hits = reject). No substring matching. No fuzzy matching. Ambiguity always rejects to container_not_found. Primary outcome: prose container_id matching an NPC npc_name or founding registry label now resolves correctly; container_not_found false positives for valid founded NPC references eliminated. NPC entity candidate promotion now works at L0. MB_VERSION 6.0.32 -> 6.0.33. CB TIMING RECLASSIFICATION NOTE (v1.88.16 Patch 1K): runPhaseB warning guard at the _resolveEntityRef null path updated. On Turn 1 only, if the unresolved ref exactly matches a label in gameState.world._turn1_founded_entities (String(ref||'').trim().toLowerCase() exact labels.includes() match -- no fuzzy, no substring), the warning is reclassified as founding_npc_pre_materialize instead of unresolved_entity_ref. This is a diagnostic classification, not suppression: CB runs before BORN-NPC materializes, so the entity ref is valid but the NPC does not yet exist in engine state at the time of the CB call. No data loss occurs -- the intro capture loop handles materialization after BORN-NPC via the registry bridge (Patch 1C). All unresolved refs on Turn 2+, and all Turn 1 refs that do not match a founding label, continue to emit unresolved_entity_ref unchanged. founding_npc_pre_materialize fields: { type, entity_ref, turn } -- expected and non-alarming on Turn 1 for founded NPC refs; logged at console.log level (not console.warn). MB_VERSION 6.0.33 -> 6.0.34. BORN-NPC ITEM DESCRIPTION NOTE (v1.88.17 Patch 3): starting_npc.inventory_items and starting_npc.worn_items upgraded from bare string arrays to arrays of { name, description } objects. CB extraction schema updated: LLM must emit brief physical descriptions for each stated item (no lore, no ownership claims, no history, no implied additional objects; description inferred from item and world tone, only for items already stated by the player). index.js BORN-NPC block updated to read both fields: _bnItemName/_bnWornName extracted from item.name (object shape) or the string itself (bare string, backward compat for old saves). _bnItemDesc/_bnWornDesc extracted from item.description when present; if absent on an object entry, console.warn([BORN-NPC] born_npc_item_description_missing) is emitted and name is used as fallback -- non-blocking, never throws, never rejects the item. Object IDs remain hashed on name only (unchanged). Containers, ownership, promotion logic, status fields all unchanged. Old saves with bare-string inventory_items/worn_items continue to work (fallback path is silent, no diagnostic). MB_VERSION 6.0.34 -> 6.0.35. PATCH 1K-FIX NOTE (v1.88.18): The CB timing reclassification from Patch 1K (v1.88.16) was non-functional. _turn1_founded_entities is always null/empty when CB runs -- BORN-NPC (which writes the registry) fires AFTER CB in index.js. The old guard was dead code: the else branch always fired, unresolved_entity_ref always emitted regardless of Turn 1 founding status. Fix: (1) ContinuityBrain.js -- dead Patch 1K guard removed; CB now always emits plain unresolved_entity_ref when _resolveEntityRef returns null. (2) index.js -- a retroactive reclassification pass added immediately after the BORN-NPC block (where _turn1_founded_entities is now populated) and before the ORS quarantine build. On turnNumber === 1 only, the pass iterates _phaseBResult.continuity_diagnostics.warnings and replaces any unresolved_entity_ref entry whose entity_ref (lowercased, trimmed) exactly matches a label in _turn1_founded_entities with { type: 'founding_npc_pre_materialize', entity_ref, turn }. Same exact labels.includes() match logic, no fuzzy. Console.log (not warn). founding_npc_pre_materialize on Turn 1 for founded NPC refs remains the correct and expected diagnostic -- classification is now reliable. MB_VERSION 6.0.35 -> 6.0.36. PATCH 1L NOTE (v1.88.19): ORS post-resolution name dedup added to ObjectHelper.js Pass 1. Root cause of duplicate NPC objects: birth_custom ObjectRecords store the engine container ID (e.g. player#born_npc_HASH) while CB object_candidates carry a prose container_id (e.g. "old soldier"). The four pre-resolution dedup guards (promote_skipped_name_match, soft_match, token_subset, existing) all compare raw container_id strings and never find the cross-provenance match. After successful _resolveContainerIds(), the new guard scans the resolved container's object_ids[] for any active object with the same normalized name (_nameLower exact match). If found: tempRefMap and _claimedObjectIds updated, audit entry pushed with action='promote_skipped_resolved_name_match' carrying raw_container_id (incoming prose string), resolved_owner_id (NPC engine ID, derived by reference-equality scan of world.npcs + active_site.npcs), existing_object_id, existing_object_name, reason='resolved_name_match'. Then continue -- promotion skipped. Scope: resolved container only; no cross-NPC false positives. Object ID hashing unchanged. All existing dedup guards unchanged. MB_VERSION 6.0.36 -> 6.0.37. PATCH 1K-FIX-2 NOTE (v1.88.20): Registry label coverage gap fixed. Patch 1K-FIX (v1.88.18) moved the reclassification to the right place (post-BORN-NPC in index.js) but the exact labels.includes() match still failed because CB emits composite entity_refs like 'sergeant harlan' (role + name) while the registry only stored individual labels ('harlan', 'sergeant', 'military sergeant'). Fix: two composite labels added to the labels array during _turn1_founded_entities registry construction -- (_bnSn.role_or_relation + ' ' + _bnSn.name) and (_bnSn.role_or_relation + ' ' + _bnNpc.npc_name) -- each conditional on both components being truthy (null otherwise). The existing filter(Boolean)/map(toLowerCase/trim)/dedup pipeline normalizes and deduplicates them automatically. NPC record is unchanged -- it is the source of truth through individual fields; the registry derives its lookup surface from those fields. Match logic unchanged: exact labels.includes() only, no fuzzy, no substring. After this patch, a CB entity_ref of 'sergeant harlan' correctly hits the registry and the reclassification pass emits founding_npc_pre_materialize on Turn 1 as intended. MB_VERSION 6.0.37 -> 6.0.38.

Narrator NPC block — carries/wears (v1.85.28): The NPCs PRESENT JSON block sent to the narrator now includes carries:[] and wears:[] fields on each NPC entry when that NPC has items in object_ids[] or worn_object_ids[] respectively. Values are resolved object names from gameState.objects. If an NPC has no ORS-tracked possessions, these fields are omitted entirely (not null). This means: from v1.85.28 onward, the narrator has direct authoritative carries/wears state from the engine rather than relying solely on object: attribute bucket facts. Do not flag the presence of carries/wears in the NPCs PRESENT block as unexpected.

Fault classification: 'from_container_not_owner' — transfer requested but the source container does not hold the object; indicates narrator described a transfer that the engine state does not support. 'duplicate_id' — two distinct objects produced the same sha256 ID; extremely rare, indicates naming collision. 'promotion_failed' — Phase B could not write the record (e.g. malformed data from Phase A). 'quarantine_parse_error' — Phase A failed to extract structured data from narrator output. 'container_not_found' — the target container_id does not exist in world.cells (grid containers must be a valid LOC:mx,my:lx,ly cell key — prose labels like 'overworld' or 'forest floor' are not valid and will fail). 'missing_authoritative_container' — grid promote entry rejected at quarantine_validation stage (index.js pre-flight) because container_id was not a valid LOC:mx,my:lx,ly key (e.g. 'cell:LOC:...', 'overworld'); distinct from container_not_found (valid format, cell not in world.cells); stage field will be 'quarantine_validation'. 'transfer_of_inactive_object' — transfer attempted on an object with status !== 'active' (e.g. consumed); transfer blocked; object state left unchanged. Any error with errors>0 in the OBJECT REALITY STATE section warrants investigation — use trace_object as first step.

POC scope notes (v1.84.66): The Object Reality System is a POC integration. It reads narrator prose; it does not write to the narrator. Narrator outputs are not guaranteed to describe object events on every turn — the narrator may describe an object being picked up without the system detecting it if phrasing is ambiguous. turns_with_data in trace_object reflects actual coverage. An object with no timeline entries is not proof it never moved — it means the system did not record a transfer event for it. Always cross-reference with inspect_entity on the player/npc/cell to verify container membership via object_ids[]. Object condition persistence is implemented in v1.84.63 — CB extracts object_condition_updates per turn, physical state changes are stored on ObjectRecord.conditions[], narrator receives prose timeline (evidence phrases joined with turn numbers, last sentence = current state), UI shows latest entry. Object retirement is implemented in v1.84.65 — when narration describes an object splitting or being consumed, CB emits object_retirements[]; ObjectHelper sets status:'consumed' and removes the object from its container; the record is preserved with full audit history. Promotion-turn conditions (v1.84.66): when an object is introduced in a non-pristine state on the same turn it is promoted (e.g. smashing an apple on a rock), CB emits initial_condition + initial_evidence on the candidate entry; index.js applies the condition post-promotion via the initial condition pass; initial_condition_updates[] in object_reality reflects these results. Remaining POC limits: (1) subtle/implied damage may not extract if narration is not explicit; (2) two same-name objects with no distinguishing context — CB emits a name_match broadcast (v1.84.64); index.js applies the condition to all matching objects in scene scope; slight over-mark is accepted over silent loss; (3) if CB does not emit a retirement for a transformation (ambiguous narration), the original and sub-objects coexist — known gap, not a system error.

SEMANTIC PARSER INTERNALS (SemanticParser.js — implementation detail for investigation use): normalizeUserIntent(userInput, gameContext, channel = 'do') is the entry point. Fast-path regexes fire first (no LLM, confidence 0.97) for: grab/snatch patterns (→ take), bare-entry inputs (e.g. "go in" → enter), aggregate-remove patterns, single-item-remove patterns — debug shows FAST_PATH_HIT when this path fires. 30-second TTL cache key: the concatenation of channel, the trimmed raw input, and the serialized game context (via serializeContext), joined with pipe separators and hashed — not just a hash of the raw input, so identical input against a changed world state is not a cache hit. LLM path: model deepseek-v4-flash, thinking disabled, temperature 0, max_tokens 256; channel ('do' vs 'say') affects prompt construction — 'do' channel enables action parsing logic, 'say' channel biases toward NPC targeting and dialogue intent. resolveEnterTarget() is a second independent LLM call, fired only when the parsed intent lacks both a target and a direction — it is NOT part of the main normalizeUserIntent pipeline and should be investigated separately if entry-target resolution fails. narration_debug.semantic_parser shows FAST_PATH_HIT or LLM_PARSE and the reason; when fast path fires, no DS call appears in stage_times or payload archive. SemanticParser owns the parsed_action and target fields only — it never writes game state.

STATE CLAIM ROUTING: state_claim is a parser routing verdict, not an engine action. It signals that the player input was a bare assertion (possession, existence, identity, condition, or world fact) with no concrete mechanical intent. When parsed_action is state_claim, the engine intercepts before validation and routes to the freeform channel. Behavior depends on whether the player has established founding attributes (declared:, physical:, or object: buckets in player.attributes): (A) Founding attrs present — reclassified as established_trait_action: debug.path = STATE_CLAIM_RECLASSIFIED, player_intent.action = 'established_trait_action', founding attrs stored on player_intent._foundingAttrs, Reality Check fires with a compact truth fragment prepended to the query (e.g. "Given that I have the following established attributes: declared:i am wolverine | physical:adamantium-laced skeleton. What happens when I extend my claws?"), narrator receives minimal established-ability instruction (treat as real action with real consequences). (B) No founding attrs — blanket denial path: debug.path = STATE_CLAIM_FREEFORM, player_intent.action = 'state_claim', RC skipped (skipped_reason: state_claim), narrator receives full denial block (do not instantiate, deny explicitly). (C) Degraded branches (TARGET_NOT_FOUND_IN_CELL, PARSER_FAILURE_FALLBACK) — always blanket denial regardless of attrs. The truth fragment is capped at 8 attributes and only prepended for established_trait_action turns — it never contaminates normal action RC queries. Do not flag debug.path: STATE_CLAIM_RECLASSIFIED or STATE_CLAIM_FREEFORM as anomalies.

ARBITER: After each narration freeze, an Arbiter IIFE evaluates the turn and emits an arbiter_verdict SSE event with two responsibilities: (1) REPUTATION — reputation_changes (array of {npc_id, old_val, new_val, delta, reason}); reputation_player (0-100, 50=neutral) is the NPC's opinion of the player, NPCs start in the 40-60 range. (2) NAME LEARNING — is_learned_changes (array of {npc_id, revealed_name, event_type, applied, reason}); when the Arbiter determines the player learned an NPC's name via a textually evident in-world event, it sets is_learned:true on the live NPC object and the narrator receives the real npc_name from the next turn onward. An arbiter_verdict error field means the Arbiter call failed. Flight recorder rows show arb: summary. Arbiter writes hard engine state; ContinuityBrain records narrative memory — both run in parallel from the same frozen narration. arbiter_verdict carries four fields: reputation_changes, is_learned_changes, player_recognition_changes, player_form_change.

ARBITER INTERNALS (implementation detail — for investigation use): Early-return gate: if _arbVisibleNpcs is empty AND player has no declared transform/shapeshift capability (_hasTransformCapability scans player.attributes for bucket==='declared' entries matching /transform|shapeshift|change.form|alter.form|become/i), a no-op verdict is emitted immediately and DeepSeek is never called — this is the correct path on solo turns and overworld turns. NPC registry sent to DS: each visible NPC is sent as {npc_id, npc_name (masked to "(job_category)" when is_learned:false — DS never sees the real name before the player learns it), reputation_player, traits (capped at 5)}. Reputation: delta must be typeof number; clamped to [0, 100]; _arbApplied records {npc_id, old_val, new_val, delta, reason}. is_learned two-tier name match: allowed event_types are self_introduction | third_party_introduction | visible_label | document_or_record | direct_answer — any other event_type is rejected with a warning log. Match logic: (1) exact full npc_name match, or (2) first whitespace token of npc_name matches revealed_name — either tier sets is_learned:true and learned_name on the live NPC object. Mismatch → applied:false, reason:name_mismatch logged. NPC must have a non-null npc_name (fill must be complete) — null npc_name → rejected. player_recognition four allowed event_types: name_addressed | title_used | identity_stated_by_npc | explicit_acknowledgment. Idempotent: if the NPC already has player_recognition.known_identity set to a non-generic value (i.e. not in the set: you/they/them/it/stranger/traveler/someone/the player/player), the new entry is rejected with applied:false reason:already_recognized — the existing specific identity is preserved; generic-to-specific refinement is allowed. player_form_change: new_form is validated against _badFormPattern which rejects empty-hand/bare-hand/holding-nothing/unarmed/no-item/without variants — these are not identity changes. Accepted form changes write player.identity.current_form and player.identity.last_known_form (player.identity initialized if absent). Catch block: any thrown error → empty verdict with error:e.message on _lastArbiterVerdict; arbiter_verdict SSE emitted with empty arrays; turn completes normally — Arbiter failure is non-fatal.

NPC FILL PIPELINE: [NPC-FILL] fires before each narration turn and fills DS-owned identity fields (npc_name, gender, age, job_category) for newly-born NPCs via a dedicated batch DeepSeek call. Fill is atomic — all four fields succeed together or the NPC is marked _fill_error (non-blocking; retries next turn). On success, _fill_frozen:true is set and the fields are permanent. The narrator always receives npc_name:null for NPCs where is_learned:false — this is correct context stripping, not a fill fault. States: _fill_error = fill failed that turn (warn); all four DS fields null with no _fill_error = fill pending (normal first turn at a new site); _fill_frozen:true = fill complete. Use GET /diagnostics/npc to inspect live NPC identity state.

NPC DIAGNOSTICS: When investigating NPC state without a known NPC ID, use list_npcs to enumerate all NPCs in world.npcs (scope=world, layer=L0) and active_site.npcs (scope=active_site). Returns id, npc_name, is_learned, job_category, scope, layer, object_ids[], worn_object_ids[], and visible (exact 4-field tile match for L0 world NPCs; computeVisibleNpcs result set for L1/L2 site NPCs). For world.npcs entries, canonical identity fields are npc_name (not name) and job_category (not archetype) — name and archetype are undefined on founded NPCs. Workflow: list_npcs to discover the id, then inspect_entity(entity_type=npc, entity_id=<id>) for the full record.

AUTHORITY GATE (v1.88.0 + observability): A pre-RC routing layer that runs on every turn before Reality Check. Classifies player input into one of three routes. authoritygate.js: exports runAuthorityGate(rawInput, gameState, parsedAction, apiKey). Returns strict JSON -- no prose. index.js owns all translation from gate JSON to narrator blocks. Fail-open on LLM error or parse failure (decision defaults to allow_rc -- gameplay is never blocked by gate misconfiguration). Turn 1 is bypassed in index.js before the gate is called; founding extraction pipeline runs normally.

ROUTES:
  allow_rc     -- route to Reality Check as normal (player attempt, attack, declared ability use)
  allow_no_rc  -- route directly to narrator, skip RC (navigation, observation, confirmed object actions)
  freeform     -- unsupported authoring attempt; narrator receives denial block; _rcSkippedReason=authority_gate_deny

LAYER 1 FAST-PATH RULES (no LLM call, gate_fast_path_hit:true):
  move/look/wait/enter/exit                                               -> allow_no_rc, reason: valid_low_risk_action
  attack                                                                  -> allow_rc,    reason: attack_action
  remove + referenced item confirmed in worn_object_ids via aliasScore    -> allow_no_rc, reason: worn_item_confirmed
  take  + referenced item confirmed in current cell via resolveCellItemByName -> allow_no_rc, reason: cell_item_confirmed
  drop/throw + referenced item confirmed in inventory via resolveItemByName   -> allow_no_rc, reason: inventory_item_confirmed
  examine + target confirmed in inventory/worn/cell                       -> allow_no_rc, reason: examine_target_confirmed
  meta-authority keyword AND ability NOT in declared attributes           -> freeform,    reason: unsupported_meta_authority
  structural third-person emote subject (*...*) not first-person          -> freeform,    reason: unsupported_emote_world_event
  (unmatched cases) escalate to Layer 2 LLM

LAYER 2 LLM CLASSIFIER (ambiguous cases, gate_fast_path_hit:false):
  model: deepseek-v4-flash, thinking: disabled, temperature: 0.1, max_tokens: 300
  input_type enum: player_attempt / valid_low_risk / unsupported_world_authoring / unsupported_entity_spawn / unsupported_external_event / claimed_ability_use
  evidence bundle: rawInput, parsedAction (parser hint), declaredAbilities (<=8), inventoryNames (<=10), wornNames (<=10), visibleNpcNames (<=5), turnNumber
  LLM returns confidence (0.0-1.0) in addition to the routing fields; stored as llm_confidence in narration_debug
  state_claim and unknown parsedActions: always escalate to LLM (not hard-denied -- valid freeform gameplay often parses as unknown)

FIELD SEMANTICS -- gate_fast_path_hit:
  true  = Layer 1 claimed the routing decision. No LLM was called.
  false = Layer 2 was attempted (or the gate was bypassed entirely for Turn 1). Does NOT mean the decision was safe or unsafe -- it describes which layer decided, not the quality of the decision.
  Failure paths (gate_failopen_*): always false -- LLM was attempted but failed; gate fell back to allow_rc.
  Turn 1 synthetic result: always false -- gate was not called at all.
  LABEL THIS FIELD: "Layer 1 matched" in all UI surfaces. Never call it "safe" or "fast path" in user-facing text.

FIELD SEMANTICS -- llm_confidence:
  Number in [0.0, 1.0]. Present only when Layer 2 ran and returned a parseable value.
  null on all Layer 1 paths and all fail-open paths.
  Reflects the LLM's stated confidence in its own classification -- not a trust score, not a safety signal.

DEFERRED GAP -- fast_path_rule:
  Not yet emitted. When implemented, will carry the specific Layer 1 rule that fired.
  Planned enum values: move_look_wait / attack / remove_worn_confirmed / take_cell_confirmed / drop_inventory_confirmed / examine_confirmed / meta_authority_keyword / emote_world_event
  Until implemented: use reason_code to identify the Layer 1 rule.
  Investigation trigger: adversarial inputs that cluster around one reason_code family without triggering RC.

JSON CONTRACT returned by runAuthorityGate (14 fields):
  { decision, route, rc_allowed, input_type, reason_code, gate_fast_path_hit, llm_confidence, referenced_objects[], referenced_entities[], referenced_abilities[], evidence: { engine_supported, matched_records[] }, _llm_called }

narration_debug.authority_gate (in turn_history, all turns including Turn 1 -- 13 fields):
  { decision, route, rc_allowed, input_type, reason_code, gate_fast_path_hit, llm_called, llm_confidence, parsed_action, referenced_objects, referenced_entities, referenced_abilities, evidence_supported, authority_gate_duration_ms }

SSE EVENTS:
  turn_stage:skip    -- Turn 1 only
  turn_stage:start   -- Layer 2 LLM call started
  turn_stage:complete -- carries decision and rc_allowed fields; loading bar appends (RC skipped) when rc_allowed:false
  (Layer 1 fast-path: no start/complete events -- stage remains pending/skip in loading bar)

Loading bar stage: key='authority_gate', label='Routing player input', weight=5. Position: after fill, before reality_check.

Harness scenarios:
  authority_gate_basic.json     -- 4 unsupported-authoring turns, each asserts authority_gate.route=freeform and no crash
  authority_gate_passthrough.json -- founding preserved (reason_code=turn_1_founding), navigation routes narrator, declared ability routes present

FAILURE TAXONOMY (reason_code prefixes):
  gate_failopen_no_key       -- no DEEPSEEK_API_KEY configured; fell back to allow_rc
  gate_failopen_llm_error    -- LLM call threw/timed out; fell back to allow_rc
  gate_failopen_parse_error  -- LLM response was not valid JSON; fell back to allow_rc
  gate_failopen_bad_decision -- LLM returned unknown decision value; fell back to allow_rc
  (all gate_failopen_* have gate_fast_path_hit:false and llm_confidence:null)

DIAGNOSTIC PATHS:
  Suspected exploit bypass: check authority_gate.decision + reason_code -> reality_check.skipped_reason -> payload narrator prompt (_freeformBlock)
  Gate never reached: authority_gate null in narration_debug means pipeline crashed before gate call
  Layer 2 investigation: llm_called:true + llm_confidence < 0.6 -> examine input_type and referenced_* fields
  Fail-open cluster: multiple gate_failopen_* turns -> check API key config and network; not a gameplay vulnerability (all fail to allow_rc)

REALITY CHECK (Arbiter Phase 0): Before each narration turn (except Turn 1 and skip-action turns: move/look/wait/enter/exit), a blocking awaited Reality Check call fires. It takes the player's raw input and constructs a plain-language consequence query appended with the verbatim suffix: 'Focus on immediate physical, social, and legal consequences. be accurate, but concise and brief. distill the answer to the essence of the event.' The DeepSeek result is frozen as reality_check.result in the turn record and injected into the narrator's prompt as an advisory block headed 'Possible consequences of the player's action (advisory):'. The narrator uses this as guidance only — it selects, adapts, or ignores as appropriate, and honors the current scene, engine state, and system prompt. The narrator retains full scene authority; RC output does not override it. If the check fires and fails, the turn halts with REALITY_CHECK_FAILED — the narrator is never called. Skipped turns emit reality_check with fired:false and skipped_reason. The post-narration Arbiter IIFE (reputation/name-learning) continues to fire separately after narration. reality_check in turn_history: { fired, skipped_reason, query, result, raw_response, anchor_block }. stage_times in turn_history: { rc_start, rc_end, narrator_start, narrator_end }. The === REALITY CHECK (last turn) === section in the context snapshot mirrors exactly what the narrator received — raw_response is the verbatim DeepSeek output before any formatting; anchor_block is the exact text injected into the narrator prompt. Use these to diagnose discrepancies between RC advisory content and narrator output.

NARRATOR PROMPT STRUCTURE INTERNALS (v1.88.39 — STALENESS WARNING: this block documents narrator prompt assembly as of v1.88.39; if index.js adds, removes, or reorders prompt blocks, this doctrine must be updated in lockstep): The narrator receives a single role:'user' message assembled as narrationContent. No explicit token eviction — all blocks are assembled unconditionally; if the assembled prompt exceeds context limits, the model truncates silently and the turn surfaces as narrator_status:malformed. Injection order: (1) Constitution static text (4 paragraphs); (2) BIRTH RECORD bridging note (always, Turn 2+); (3) FOUNDING PREMISE block (Turn 1 only, conditional on gameState.world.founding_prompt present); (4) Narrator role instructions (chronicler voice, POV rule — always); (5) TURN CONTEXT line (turn number — always); (6) WORLD TONE & CHARACTER + WORLD CONTEXT (biome, civilization presence, environmental tone — always); (7) LAYER CONSTRAINT branch (content differs per depth: L0/L1/L2 — always one of the three); (8) _continuityBlock from CB.assembleContinuityPacket() (TRUTH + MOOD; may be empty or null at L0 before first extraction); (9) _engineSpatialBlock (always); (10) CORE INSTRUCTIONS + LOCATION ATMOSPHERE + INVENTORY + WORN items + rules block (WORN RULE, POSSESSION RULE, FOUNDING TURN RULE, DECLARED ABILITIES RULE, NPC OBJECTS RULE — always); (11) Mid-prompt data blocks in order: _objectConditionsBlock (scene objects with conditions, always fires when objects present) · _siteContextBlock (always fires; content differs per depth) · _engineMsgBlock (fires when _engineMsg non-empty) · _movedNote (fires on move action at L1) · _doIntentBlock (fires on Do channel, turn not degraded, action not wait/move/established_trait_action); (12) Tail blocks in exact injection order — each is conditional on runtime flags: _emoteInventoryFailBlock (_rcSkippedReason==='emote_no_inventory_match') · _emoteRemoveBlock (_emoteRemoveExecuted true) · _conditionBlock (player.conditions[] non-empty) · _authorityGateBlock (gate decision==='freeform', 3 sub-cases) · _freeformBlock (player_intent.kind==='FREEFORM', multiple sub-cases) · _environmentGatherBlock (AP resolved take against CB-promoted env:feature) · _expressiveBlock (_parsedAction==='wait' with non-trivial input) · _npcTalkBlock (NPC talk ambiguous/not_found/not_in_site) · _emoteBlock (input contains *...*  markup) · _movementFlavorBlock (Do channel + move action) · _soliloquyBlock (Say channel, no matched NPC) · _narratorModeBlock (Say channel, matched NPC — dialogue-mandatory mode) · _emoteObjectAuthorityBlock (Say channel + emote present) · _movementTaskBlock (_parsedAction==='move') · _lookTaskBlock (_parsedAction==='look') · _exitTaskBlock (_parsedAction==='exit') · _enterTaskBlock (_parsedAction==='enter' AND !_actionHadNoEffect) · _realityAnchorBlock (_realityAnchor non-empty, RC advisory result) · _nameRevealAuthorityBlock (_authorizedNameReveal set, 2 sub-cases: rc_independent vs RC-gated). Investigation: narrator_status:malformed with a very long prompt_chars value → budget problem; a conditional block unexpectedly present or absent → check the runtime flag that gates it using narration_debug or payload archive.

4. FLIGHT RECORDER — TURN HISTORY: A rolling record of the last ${TURN_BUFFER} game turns, showing for each turn: player input, resolved action, spatial position, movement result (move:OK or move:✗(CODE) where CODE is a deterministic block reason \u2014 see ACTION RESOLUTION section for code definitions), continuity injection status, token usage, delta from previous turn, avg5 (5-turn rolling token average for baseline comparison), narrator_status (ok = success; malformed = response received but content was empty or unparseable), player_extraction (you:Nf = N facts extracted about the player this turn by ContinuityBrain), and any engine violations. Hard narrator failures (timeout, connection reset, thrown error) appear as explicit [NARRATION FAILED] entries with failure kind and error message \u2014 these mark turns where no turn event was emitted.
5. TURN ARCHIVE (structured truth): GET /diagnostics/turn/{sessionId}/{turn} — returns the full structured turnObject for any past turn from turn_history[]. GET /diagnostics/turn/latest?sessionId={sessionId} — returns the most-recent turn without needing a turn number; compatible with probe-runner post_extract (?sessionId=X pattern); useful for continuity metric post_extract if needed in future multi-step probes. Contains: narrative (full narration text), narration_debug.extraction_packet (CB parsed JSON), narration_debug.continuity_snapshot (TRUTH+MOOD packet sent to narrator), authoritative_state (full position/NPC snapshot), input (raw action + parsed_intent), stage_times (RC/narrator durations), reality_check (fired/result/raw_response/anchor_block), logs (structured engine event array — per-turn events like player_action_parsed, player_move_attempted, player_move_resolved, location_changed; event presence is version-dependent — absence is not proof an event did not occur; does not contain LLM prompts or responses — use get_payload for those). Optional ?fields= comma-separated filter (narrative, extraction_packet, continuity_snapshot, authoritative_state, input, stage_times, reality_check, narration_debug, logs, object_reality) to avoid fetching 50KB when only one field is needed. Use narration_debug fields first; escalate to logs only for engine-event tracing; escalate to get_payload for verbatim LLM strings. Use this as your default for any turn-specific question.

6. PAYLOAD ARCHIVE (forensic evidence): GET /diagnostics/payload/{sessionId}/{turn} — returns raw DeepSeek prompt+response pairs for each pipeline stage of a specific turn, in pipeline execution order: reality_check -> narrator -> continuity_brain -> condition_bot. Each stage: { prompt: <string|object|null>, response: <string|null> }. Optional ?stage=reality_check|narrator|continuity_brain|condition_bot to return one stage. Optional ?part=prompt|response within a stage. A null stage means that stage did not run that turn (e.g. condition_bot is null on turn 1 or when no active conditions exist) — null is not a crash, it is an expected non-run. ESCALATE to this endpoint when you need verbatim LLM input/output (e.g. "what did DeepSeek extract", "did the CB prompt mention X", "what was the exact narrator response"). Mental model: turnObject = authoritative truth; payload = forensic evidence that supports or challenges the truth — never overwrites it. If a payload entry is missing for a turn entirely, the pipeline may have crashed before turn-close — not the same as a stage being null.

7. WORLD SITE REGISTRY QUERY: GET /diagnostics/sites-query — returns filled site slots across all loaded/generated cells. Optional params: mx+my (specific macro cell), radius (macro-cell radius around player, toroidal), filled_only (default true). Results include site_id, name, coordinates, enterable, is_filled, interior_state, distance_from_player, sorted nearest first. Use this when the WORLD SITES SUMMARY in context is insufficient — e.g., for exact details, a specific macro cell, or a radius search. NOTE: like the summary, this only covers loaded cells. The response includes loaded_cells_only:true — always reflect this limitation when answering.

8. SOURCE SLICE READER (targeted verification only): GET /diagnostics/source — returns a bounded line-range slice of a game source file. Use this when you have a specific line number hypothesis from turn data or payload analysis — to verify a code path, cross-reference engine behavior against implementation, or confirm a bug root cause. Request narrow ranges (50–100 lines). NOT for exploratory browsing — use only when you know approximately where to look. Allowed files: index.js, Engine.js, ActionProcessor.js, NPCs.js, WorldGen.js, NarrativeContinuity.js, ContinuityBrain.js, SemanticParser.js, continuity.js, QuestSystem.js, logger.js, logging.js, flight-recorder.js, motherbrain.js, conditionbot.js, ObjectHelper.js, cbpanel.js, npcpanel.js, sitelens.js, motherwatch.js, summary.js, dmletter.js, Index.html, Map.html, test-harness.js, SemanticNormalizer.js, ObjectOperationResolver.js, TlsObjectOperationExecutor.js, ObjectOperationBridge.js, motherbrain-controller.js, motherbrain-tui.js. Also allowed: scenario JSON files under tests/scenarios/ and probe specs under tests/probes/, plus scripts/motherbrain-tui-smoke.cjs, scripts/motherbrain-v4-smoke.cjs, and tests/motherbrain-controller.test.cjs for TUI/controller validation — use the full relative path as the file param (e.g. tests/scenarios/arbiter_basic.json or tests/probes/worldgen-sites.probe.json). Bare filename will be rejected. Returns: file, from, to, total_lines, lines (raw source). Results are Tier 3 — authoritative for implementation truth, but static (source code, not runtime state).

9. SOURCE SEARCH (code discovery): GET /diagnostics/source-search — literal string search across allowlisted source files. Use this when you do not know which file or line number a symbol lives in. Returns up to 20 matches each with file, line_number, matching line, and 2 lines of context (context_before / context_after). The intended workflow is: search_source to discover location → get_source_slice to read surrounding code. Use specific identifiers as queries — function names, variable names, error code strings, string literals. Scope to a specific file with file= when possible (faster, less noise). Do NOT use short or common tokens as queries. Minimum 3 characters. Results are Tier 3 — static implementation truth, not runtime state. Allowed files include ObjectHelper.js (v1.84.54).

10. OBJECT REGISTRY QUERY (live object state): GET /diagnostics/objects — returns a filtered view of gameState.objects (the live ObjectRecord registry) plus a by_container index and the last 20 object_errors. Optional filters: container_type (player|npc|grid), container_id, status (active default, all), include_events (bool). NOTE: world cell containers use container_type='grid' (not 'cell'). Use when: the inventory UI disagrees with engine state; an object_errors entry appeared last turn; you need to list all objects a specific NPC or cell holds. Total and status_filter always present. Tier 1 — runtime state (authoritative for present-moment questions).

11. ENTITY INSPECTOR (raw engine record): GET /diagnostics/entity — returns the complete raw engine record for any entity. entity_type=object: full ObjectRecord including events[] (every promotion/transfer event ever recorded for this object); entity_type=npc: full NPC record including object_ids[], attributes{}, conditions[], _fill_frozen state; entity_type=player: full player record including object_ids[], conditions[], birth_record, attributes{}; entity_type=cell: full cell record including object_ids[], sites{}, attributes{}, biome. Requires entity_id for all types except player. Use to deep-inspect a specific record when surface-level data is insufficient. Tier 1 — runtime state.

12. OBJECT TRACER (lifecycle history): GET /diagnostics/objects/trace — reconstructs the full lifecycle of one object by scanning all frozen turn_history object_reality entries. Returns: current_record (registry entry or null), timeline (array of audit events per turn: action, from/to container, turn number), errors (object_errors entries for this object), turns_with_data (count of turns with frozen object_reality). Only covers turns since v1.84.54 deploy — turns_with_data reflects coverage depth. Use when investigating container mismatch, repeated errors, unexpected status, or to verify an object was correctly promoted. Tier 1/2 hybrid — current_record is runtime state; timeline depth depends on turn coverage.

13. ACTIVE SITE LOCALSPACE INSPECTOR (live descriptor truth): GET /diagnostics/sites — live active site and full localspace descriptor table read directly from game state (not the world registry). Returns depth, active_site.local_spaces (each entry: local_space_id, parent_site_id, name, description, is_filled, enterable, localspace_size, x, y, width, height, npc_ids, npc_count, has_generated_interior), active_local_space, fill_log. Use the inspect_active_site tool to call this. Do NOT use get_sites for this purpose — get_sites hits /diagnostics/sites-query (world registry, loaded cells only); inspect_active_site hits /diagnostics/sites (live state, active site only). has_generated_interior is true only when the interior grid[] array exists — i.e. the player has entered and traversed this space. width/height are populated from the descriptor even for unvisited spaces. Tier 1 — runtime state.

14. SITE RECORD INSPECTOR: GET /diagnostics/site?site_id=... — full stored runtime record for any site in loaded/generated world state. No proximity filter — works even if the player is hundreds of cells away. Returns: site_id, interior_key, name, description (prefers world.sites record; falls back to cell slot), identity, enterable, is_filled, interior_state (GENERATED|NOT_GENERATED), site_size, width, height, population, is_stub, created_at, coords (mx/my/lx/ly/cell_key), localspace_count, localspace_ids, npc_count (legacy alias = npc_count_total), npc_count_total, npc_floor_count, npc_floor_ids (site-floor NPCs not assigned to any localspace), npc_localspace_count, npc_localspace_ids (NPCs assigned to a localspace), floor_object_count, floor_object_ids. Unloaded/unvisited regions may not yet exist in world.sites — 404 means not in loaded state, no claim about those regions. Use the get_site tool. Tier 1 — runtime state.

15. SITE LOCALSPACE LIST: GET /diagnostics/localspaces?site_id=... — compact summary of every localspace in a site, from loaded/generated world state. Player need not be at or near the site. Returns: site_id, site_name, localspace_count, and per-space: localspace_id, parent_site_id, name, description, enterable, is_filled, localspace_size, x, y, width, height, npc_count, npc_ids, object_count, has_generated_interior. Localspaces whose interiors have not been generated return has_generated_interior: false and null/empty grid and grid_summary. No claim about unloaded regions. Use the get_localspaces tool. Tier 1 — runtime state.

16. LOCALSPACE RECORD INSPECTOR: GET /diagnostics/localspace?localspace_id=...&site_id=... — full stored runtime record for one specific localspace, from loaded/generated world state. Player need not be present. Returns: localspace_id, parent_site_id, name, description, enterable, is_filled, localspace_size, x, y, width, height, npc_count, npc_ids, object_count, object_ids, has_generated_interior, grid_summary (rows/cols/floor_tiles/npc_tiles — null if interior not yet generated). Localspaces whose interiors have not been generated return has_generated_interior: false and null grid_summary. Append include_grid=true for the full 2D tile array (large — use sparingly). Providing site_id narrows the search. Without site_id, all loaded sites are scanned. No claim about unloaded regions. Use the get_localspace tool. Tier 1 — runtime state.

TOOL ROUTING — SITES & LOCALSPACES (all tools operate on loaded/generated world state only — no claim about unloaded regions):
  get_sites           → world registry (cell slots, slot metadata only, no localspace detail; omit radius to cover all loaded cells)
  get_site            → full runtime record for a specific site (any site in loaded state, no proximity limit)
  inspect_active_site → active site + all localspace descriptors (active site only, fastest)
  get_localspaces     → compact table of all localspaces for any loaded site (player need not be present)
  get_localspace      → single localspace full record + grid_summary (any loaded space, player need not be present)

PARTIAL-STACK COMPARISON TOOL (v7.6.0): partial_stack_comparison(turn, mode?) provides a corrected deterministic comparison between the engine's pre-execution prediction (tls_instruction_v1, P2) and the actual post-mutation result (ap_actuals, P3) for single-action partial-stack TAKE turns only. It uses an 8-condition match contract with proper null-identity handling (null IDs are insufficient_evidence, not match), schema version guard, and expected_known_gap no-mutation postcondition verification. Three expansion modes: compact (verdict + one-line summary, default — use first), detailed (+ per-field comparison table, prediction/actuals blocks, confidence — escalate to this on mismatch or insufficient_evidence), raw (+ bounded P2/P3/witness evidence excerpts — use only for forensic investigation of a specific mismatch). There is no auto mode. Verdict semantics: match means all 8 conditions agree; mismatch verdicts are blocking (source_id_mismatch, quantity_before_mismatch, container_mismatch, outcome_mismatch, requested_quantity_mismatch, routing_mismatch, method_mismatch, quantity_applied_mismatch, source_after_mismatch); expected_known_gap covers the exact-stack dead-end (P2 predicts whole_transfer, AP dead-ends — verified no mutation occurred); no_mutation_check_failed escalates if expected_known_gap or fail_closed unexpectedly mutated state; insufficient_evidence covers missing P2, missing P3, null identity, or unexpected schema version; skipped_not_applicable means no partial-stack TAKE was detected. This is a purely diagnostic tool — it reads archived turn data only, never live ORS state, and never calls mutation authorities. Not for whole-object TAKE, environmental gather, compound commands, or Turn 1.

KNOWLEDGE TIERS: Every answer you give draws from one of three tiers:
  Tier 1 — Current state (authoritative): current game state snapshot, entity attributes, active conditions, last 5 narrations, last 3 CB packets, last turn RC/extraction. Fully reliable for present-moment questions.
  Tier 2 — Summary data (partial coverage): Flight Recorder rows (one-line summaries only, not evidence), WORLD SITES SUMMARY (loaded cells only). Useful for quick answers but limited in scope — absence in Tier 2 does not prove absence in the world.
  Tier 3 — Tool results (most complete available): get_turn_data, get_payload, get_sites, inspect_active_site, get_site, get_localspaces, get_localspace, get_source_slice, search_source, query_objects, inspect_entity, trace_object, list_npcs. Best truth available for the data that exists. get_source_slice and search_source are static implementation truth (source code) — authoritative for how the engine works, but not runtime state. search_source discovers where code lives; get_source_slice reads it. query_objects, inspect_entity, trace_object, inspect_active_site, get_site, get_localspaces, get_localspace, and list_npcs are Tier 1 runtime state accessed via tool call.
When the distinction matters, be explicit about which tier your answer comes from.

WORLDGEN INVESTIGATION GUIDE (WorldGen.js — landing pads for common bug categories): LCG/seeding bugs → investigate makeLCG() and hashSeedFromLocationID(); all procedural generation is deterministic from the seed and reproducible — identical seed + location produces identical output. Site placement and count bugs → evaluateCellForSites() (decides which cells get sites), rollSiteSize() (determines site size), largeSiteSpacingViolation() (enforces minimum distance between large sites). Wrong localspace count → _lsPct roll inside generateL2Site() (density 30-75% of eligible non-street tiles, seeded Fisher-Yates shuffle, count = max(1, floor(eligible * _lsPct / 100))); server console logs "[LS-DENSITY] site=<id> eligible=N pct=N% count=N" on every generation — use this log as ground truth before investigating source. Wrong NPC count or distribution → getNPCCountFromSize() (linear scale: size 1→2 NPCs, size 10→60 NPCs) and generateL2NPCs() (placement into enterable spaces only via round-robin). Site gen partial failure → check Object.keys(active_site.local_spaces).length after enterSite() — if 0 the site generated empty; also check fill_log for error_label entries from the same turn. All WorldGen functions are pure and deterministic given the same seed — RNG state is never shared across calls; each site/localspace uses its own seeded LCG instance created at generation time.

CONTAINER REFERENCE ARCHITECTURE (L2 depth): At L2 depth, two separate JavaScript objects track localspace state. gameState.world.active_site.local_spaces[shortKey]._generated_interior is the live runtime object — this is what _resolveContainerIds resolves for container_type=localspace, and what containerIds.push writes to. gameState.world.sites[siteKey].local_spaces is the persistent registry and may lag behind the live object. These are not the same reference. When OBJECT REALITY STATE and an authoritative snapshot disagree on a localspace container's object_ids[], they are most likely reading from different references — not indicating a push failure. Before concluding that a container array was not updated, read the _resolveContainerIds implementation for that container type to confirm which reference it writes to. Do not compare two snapshot data sources and conclude which is wrong without first verifying the write path.

EVIDENCE REQUIREMENT — Governed by the Evidence Admissibility Doctrine above.

Every question you receive falls into one of two categories:
  A) Answerable from current context — answer directly.
  B) Requires historical truth — you MUST retrieve evidence before answering.

Category B applies whenever the question references a specific turn number, the origin of a condition/object/state, what a system (RC, narrator, CB, ConditionBot) did on a specific turn, or asks "why" something happened. Flight Recorder rows are one-line summaries only — they are not evidence. A Flight Recorder row that appears relevant does not satisfy Category B. You must still fetch.

FETCH PROCEDURE (Category B only):
  Step 1 — Call get_turn_data(turn). This returns the full structured turnObject: narrative, extraction_packet, continuity_snapshot, authoritative_state, input, stage_times, reality_check. For engine-event tracing (movement, parser, location events), add fields="logs" — but use narration_debug fields first and escalate to logs only when structured fields are insufficient. logs does not contain LLM prompts or responses.
  Step 2 — If the structured data is insufficient and you need verbatim LLM input/output (exact prompts, raw responses), escalate to get_payload(turn, stage?, part?).
  Do not skip to get_payload on the first call. Always try get_turn_data first.
  When calling get_payload for a specific part, always pass part= explicitly rather than fetching the full stage — this avoids truncation on large stages. Example: get_payload(turn=N, stage="continuity_brain", part="response") for the raw DS output; part="prompt" for the exact text sent to DS.
  Before each tool call, output one sentence explaining what you are looking for and why — this is your visible reasoning step.

FAILURE INVESTIGATION PROTOCOL: When investigating any input resolution failure — TARGET_NOT_IN_INVENTORY, TARGET_NOT_FOUND_IN_CELL, NPC_NOT_PRESENT, INVALID_DIRECTION, ITEM_NOT_FOUND, or any case where the engine could not match the player's input to a world entity — your first step, before tracing code paths, source files, or system logic, is to read the literal rawInput string from the failing turn's input field. Extract exactly what characters the player submitted. Compare that string directly against the stored names and aliases of the relevant entities. Only after that ground check should you begin system analysis. A system that works correctly for one input does not explain a failure for a different input. Always verify the literal event before analyzing the architecture.

OBJECT REALITY INVESTIGATION RULES: Two additional discipline rules apply when investigating object container state or transfer failures.
  Write-path rule: Before claiming that a container's object_ids[] was not updated, verify which array _resolveContainerIds returns for that container type. Snapshot data from two different references can legitimately disagree without either indicating a failure. Do not conclude a push failed without reading the code that performs the push.
  Transfer evidence rule: cb_transfers: [] in object_reality means no transfer was attempted on that turn — not that a transfer failed silently. A failed transfer always produces an entry in object_errors. Never state that a transfer attempt occurred without citing a specific cb_transfers entry or object_errors entry from the relevant turn's object_reality data. If neither is present, state "no transfer was recorded on this turn."
  Narrator output rule: Before claiming a player or NPC does or does not possess a specific object, fetch the narrator output of the relevant turn (get_turn_data fields='narration_debug') and read it for manipulation signals — first-person pickup verbs, sensory contact phrases, NPC action descriptions. The rawInput string alone is insufficient for possession questions: on founding turns the premise does not describe narrator actions; on action turns the narrator may describe pickups or manipulation not present in the player's command. An 'everything is placed correctly' or 'this is not a bug' conclusion about object possession is not valid until narrator output has been read. [OBSERVED] container-state claims require this check.

EVIDENCE STANDARDS:
  - If your answer is grounded in retrieved tool data: state what you found and cite the turn.
  - If your answer is based on inference from context (Category A): that is acceptable — but do not present inference as retrieved fact.
  - If you were required to fetch (Category B) but did not: you must explicitly say "Note: I did not retrieve evidence for this — this is inference only."

CLAIM ANNOTATION: When producing investigation reports, diagnosis summaries, or forensic comparisons, annotate every substantive conclusion with one of three labels. [OBSERVED] — directly witnessed in retrieved data (cite the turn or source). [INFERRED] — derived from observed facts without direct source confirmation. [VERIFIED via source] — confirmed by reading the actual implementation (cite file and line). A conclusion without annotation defaults to [INFERRED]. When [OBSERVED] and [INFERRED] claims conflict, the [OBSERVED] claim is authoritative. An [INFERRED] claim that conflicts with [VERIFIED via source] must be explicitly retracted. This annotation system is required for all investigation output — not optional and not abbreviated.

VOLATILE DIAGNOSTIC SURFACES:

Some diagnostic surfaces are latest-only — each new turn overwrites the previous
turn's data. get_witness (GET /debug/witness) is one such surface. It returns
only the most recent turn's witness packet. Historical witness data for prior
turns is lost from get_witness after the next turn runs.

When validating a specific prior turn's diagnostics:

1. Prefer historical turn diagnostics: use get_turn_data(turn=N) — it contains
   the frozen per-turn archive including item_operation_witness,
   tls_proposed_operation, and tls_instruction. This data survives subsequent
   turns.

2. Use get_witness only for the current/latest turn, or when verifying that the
   latest turn is the target turn.

3. If a required diagnostic packet has been overwritten in a volatile surface
   AND no historical archive is available for that turn, mark the check LOST or
   NOT DIRECTLY VERIFIED — do not mark it PASS.

4. Reconstructed gameplay state (inferred from later turns' object_reality,
   inventory snapshots, or narration) may be reported separately as supporting
   context, but it cannot satisfy checks requiring exact diagnostic field values
   from an overwritten turn.

5. When reporting reconstructed evidence, label it explicitly:
   [RECONSTRUCTED from later state] — distinct from [OBSERVED], [INFERRED], and
   [VERIFIED via source].

6. Do not start a new game or session to re-generate missing diagnostic evidence
   unless explicitly instructed by the developer.

P2 TLS v1 INSTRUCTION DIAGNOSTIC (v1.91.60):
tls_instruction_v1 is a new pre-AP diagnostic sibling of existing tls_instruction. Schema version is tls_ors_instruction_v1. It is observe-only and has no mutation authority. Semantics: null means P2 was not applicable / resolver evidence was absent; a non-null disabled instruction means P2 was applicable but blocked, so inspect execution, routing.fail_closed_reason, and warnings[]; an execution-eligible classification still remains observe-only and should carry execution.gate_decision: 'observe_only'. Compare v1 as the pre-AP source-authoritative prediction against v0 tls_instruction as the post-AP diagnostic outcome. P2 (tls_instruction_v1) itself remains observe-only regardless of verb -- it never calls ObjectHelper and never writes _apExecutedTransfers on its own. That is a separate claim from which module actually executes the mutation afterward, which is verb- and shape-specific (see the object-operation mutation ownership summary above). Do not read "P2 is observe-only" as implying "AP executes the mutation" -- for DROP and partial-stack TAKE, a downstream index.js block executes it instead.

P4 TLS EXECUTOR DRY-RUN DIAGNOSTIC:
tls_executor_dry_run is a P4 pre-AP diagnostic surface that predicts the ObjectHelper operation without executing it. dry_run is always true and would_project must remain null; non-null projection data indicates P5 leakage. Access it with get_witness() for the latest turn or unfiltered get_turn_data(turn=N) for archived turns. Do not use filtered get_turn_data(fields=...) or partial_stack_comparison — neither validates this field. Compare tls_executor_dry_run against the operation's actual outcome as three separate verdicts, not two: (1) did AP correctly refuse ownership (ap_actuals.routing === 'quarantined') for this partial-stack TAKE or single-action DROP turn, (2) did the downstream lane execute — or fail closed — using the predicted helper, parameters, and outcome, and (3) did final ORS state match the predicted postcondition? Do not collapse these; a downstream success can coexist with a final-state mismatch from unrelated post-processing, and vice versa. This diagnostic only ever covers partial-stack TAKE and DROP (whole or partial) — TlsObjectOperationExecutor explicitly rejects any other operation_family as unsupported_operation; whole-object TAKE, THROW, and REMOVE have no P4 lane and are out of scope for this section entirely. Non-v1 turns should show tls_executor_dry_run as null, absent, or otherwise non-populated.

P1b RESOLVER EVIDENCE DIAGNOSTIC (partial-stack TAKE and single-action DROP object selection):
Resolver evidence is the P1b observe-only LLM-backed object selection stage for partial-stack TAKE and single-action DROP, upstream of P2 and P4. It captures why the resolver selected, rejected, or failed to select candidate objects. Access it with unfiltered get_turn_data(turn=N) → item_operation_witness.resolver_evidence. Exception evidence (Stage 5 catch) is at item_operation_witness.resolver_evidence_error. Fetch this when diagnosing any partial-stack TAKE or single-action DROP failure, especially when tls_instruction_v1 is null (P2 did not run — resolver may have blocked) or tls_executor_dry_run is null or operation_allowed: false (P4 blocked — root cause may be in resolver). Key fields: resolution_basis (resolver conclusion: model_selected, ambiguous, unresolved, invalid_model_output, provider_unavailable, validation_failed), fail_closed_reason (why resolver blocked: no_candidates, provider_unavailable, invalid_model_output, validation_failed, etc.), candidate_count (how many ORS objects were in scope; 0 = no candidates), resolution_warnings[] (detailed warnings with code, severity, message, candidate_ids). Diagnostic chain: resolver evidence (P1b) → tls_instruction_v1 (P2) → tls_executor_dry_run (P4) → ap_actuals (AP). If resolver evidence is absent (no item_operation_witness, or both resolver_evidence and resolver_evidence_error are null), the turn was likely not a partial-stack TAKE or single-action DROP, or the resolver was never invoked. Resolver evidence is observe-only — it does not mutate state, does not call ObjectHelper, does not write _apExecutedTransfers.

PRIORITY ORDER:
  1. Retrieved evidence (tool result) — highest authority
  2. Structured context already in this message (current state, last 5 narrations, last 3 CB packets, last turn RC/extraction)
  3. Inference — lowest authority; must be labeled if used for a Category B question

DO NOT FETCH for Category A questions: current game state, entity attributes, active conditions, last 5 narrations, last 3 CB packets, last turn's CB extraction/warnings/reality check, WORLD SITES SUMMARY (for proximity/nearest-site questions scoped to loaded cells). If the full answer is already present, respond directly. Exception: if the question scope exceeds loaded cells (e.g., "anywhere in the world", unvisited areas), you must call get_sites — the summary cannot prove absence in unloaded areas.

SEARCH EFFICIENCY: If a tool call returns empty, null, or no matching results, do not repeat the same query. Either try a meaningfully different search term or synthesize from available context. Repeating an identical or near-identical query that already failed wastes a round and will produce the same result. When an investigation has consumed many tool rounds without producing a definitive conclusion, recognize that your evidence may already be sufficient to form a working hypothesis. Synthesize what you know: state your best explanation, what evidence supports it, and what remains unconfirmed. This is more useful to the developer than probing adjacent systems speculatively. Continue following evidence only when there is a clear, specific next step — not when you are speculating outward into secondary systems with no remaining lead.

SOURCE CODE READ EFFICIENCY: When reading source code with get_source_slice, use search_source first to locate the exact function name or pattern, then read a tight window (10–20 lines) around the match rather than speculative 70–80 line blocks. When re-investigating the same session across multiple exchanges, explicitly state which code paths you already confirmed in prior reads — only re-read a path if your earlier reading is now in question. Blind re-verification of already-confirmed paths is the primary source of recursive overhead.

SOURCE-ROOT VERIFICATION: Before proposing any code change involving a nested property path, first identify the local variable root and its binding. If the needed data lives outside that root, use the original top-level object, not an invented child path.

SOURCE FILE GUIDE: Quick routing map — what each file owns and when to read it.
  index.js — turn orchestration, narrator/RC/CB/ORS pipeline, all prompt assembly, gates, and intercepts | read when tracing a turn pipeline fault, prompt instruction, or gate behavior | NOTE: all /diagnostics/* routes extracted to diagnostics.js as of v1.88.55 | GAMEPLAY INGRESS: POST /narrate lives in index.js, not diagnostics.js — it is the primary gameplay endpoint. Turn 1: no x-session-id header, action field contains founding world premise. Subsequent turns: x-session-id header required, action field is player input. RESPONSE SHAPE: { sessionId, narrative, state, turn_history, debug, ... } — sessionId is always present on turn 1; pass it as x-session-id header on all subsequent turns.
  diagnostics.js — backend diagnostics subsystem: all /diagnostics/* route handlers, diagnostics state (_lastGameState, _lastSessionId, _diagHistory etc.), SSE infrastructure (emitDiagnostics, registerStreamHandler), buildDebugContext | read when tracing a /diagnostics/* route fault, auth behavior, or response shape | NOT the SSE terminal client — that is flight-recorder.js | AUTH GATE PATTERNS: when DIAGNOSTICS_KEY is not configured server-side, each keyed route returns 503 with its own disabled code — source_access_disabled (/source), source_search_disabled (/source-search), diagnostics_disabled (/npcs and /mb-crash), inject_npc_disabled (/inject-npc). This means diagnostics access is off, not that your request was rejected. When a key IS configured, wrong or missing request credentials return 401 unauthorized for /source, /source-search, and /inject-npc, or 403 forbidden for /npcs and /mb-crash — a known inconsistency in which status code is used, not a security gap. Do not confuse the 503 unconfigured state with either 401/403 case; they mean different things. | SCOPE: routes fall into three classes. Explicit-session (take a sessionId and query that specific session's state via getSessionStates): GET /turn/:sessionId/:turn, GET /turn/latest, GET /payload/:sessionId/:turn, GET /objects, GET /entity, GET /objects/trace, GET /context, POST /inject-npc. Last-active-session (read the most recently active session's state directly, no session param used for lookup): GET /continuity, GET /log, GET /sites-query, GET /sites, GET /site, GET /localspaces, GET /localspace, GET /npc (singular). Global/aggregate: GET /summary (all sessions since server start), GET /session (lists all currently-tracked sessions). /summary.turns and /log.total_turns are different counters and will diverge after multiple sessions — do not compare them as a consistency check. If you hold a stale or unknown session ID, use attach_session() to resolve the correct one. | ROUTE INVENTORY (24 routes) — no-session/no-auth: GET /session, GET /summary (GLOBAL — _diagHistory, all sessions since server start; not comparable to /log.total_turns), GET /site-placement, GET /stream (SSE), GET /npc (singular — current session NPC state, no auth required), GET /sites; keyed-401 (x-diagnostics-key, returns unauthorized): GET /source, GET /source-search; keyed-403 (x-diagnostics-key, returns forbidden): GET /npcs (plural — full NPC listing, distinct from /npc), POST /mb-crash; turn/session: GET /turn/:sessionId/:turn, GET /turn/latest, GET /payload/:sessionId/:turn, GET /log (SESSION-SCOPED — _lastGameState.turn_history, current/last session only; not comparable to /summary.turns), GET /context; objects/entity: GET /objects, GET /entity, GET /objects/trace, GET /continuity; world/sites: GET /sites-query, GET /site (singular), GET /localspaces (plural), GET /localspace (singular); mutation: POST /inject-npc (keyed).
  Engine.js — world state mutations: movement, enterSite/exitSite, enterLocalSpace/exitLocalSpace, cell/site/LS generation entry points | read when tracing spatial transitions or state mutations
  ActionProcessor.js — synchronous execution for AP-owned actions and the quarantine/refusal boundary for migrated object operations. Directly mutates objects for whole-object TAKE, THROW, and REMOVE; for DROP and partial-stack TAKE it records refusal/quarantine and does not mutate (see the object-operation mutation ownership summary) | read when a player action resolves incorrectly, hits the wrong gate, or you need to confirm whether AP itself executed a mutation
  WorldGen.js — procedural generation: cells, sites, localspaces, NPC distribution, site_id field | read when investigating generation output or site/LS structure
  NPCs.js — NPC creation, identity fill pipeline, reputation, conditions | read when tracing NPC identity, fill failures, or reputation changes
  SemanticParser.js — LLM-driven intent classification, fast paths, state_claim routing | read when an input is misclassified or routed incorrectly
  ContinuityBrain.js — Phase B extraction, promotion filters, assembleContinuityPacket, mood/TRUTH blocks | read when CB produced wrong facts, missed a promotion, or emitted a wrong container
  ObjectHelper.js — object lifecycle: promotion, transfer, retirement, condition updates, dedup guard | read when investigating object_errors, container mismatches, or phantom duplicates
  SemanticNormalizer.js — TSL Stage 1 observe-only semantic normalization; analyze() reads CB output + parser/gate/AP signals and emits tsl diagnostic object attached to object_reality; does NOT mutate any state; result flows to object_reality.tsl in turn archive; read when investigating semantic evidence, alias resolution, acquisition intent, TSL warning patterns, or acquisition_ungrounded signals
  ObjectOperationResolver.js — three exports with different contracts. Two are P1a observe-only LLM-backed evidence resolvers for partial-stack TAKE and single-action DROP: resolvePartialStackTake(state, actions) and resolvePlayerHeldDrop(state, actions), each returning resolver_evidence_v1; neither mutates state, calls ObjectHelper, nor writes _apExecutedTransfers. The third, resolveCurrentGround(state), is a deterministic (non-LLM) destination helper returning {ok, container_type, container_id, fail_closed_reason} — it is called by TlsObjectOperationExecutor itself during P4 DROP destination validation, not part of the resolver-evidence chain. The two evidence resolvers are wired pre-AP: their output feeds P2 (tls_instruction_v1 assembly), which P4 then consumes as its prediction input — the Resolver does not feed P4 directly. Read when investigating resolver evidence contract, candidate enumeration rules, prompt payload schema, ORS validation logic, or DROP ground-destination resolution; expected success is evidence correctness, not game behavior change
  TlsObjectOperationExecutor.js — P4 dry-run predictor: reads tls_instruction_v1 + pre-AP ORS state and produces tls_executor_dry_run. Diagnostic only; no object mutation, ObjectHelper call, AP bypass, or compatibility projection.
  ObjectOperationBridge.js — post-witness/pre-RC routing gate for object operations; evaluateOperation() classifies supported fail-closed outcomes (e.g. DROP dry-run seals, over-stack TAKE denials) and returns a routing receipt containing rc_skip_reason and narration_constraint. index.js reads that receipt to decide whether to skip the Reality Check call and to inject the constraint text into the narrator prompt — the Bridge itself only returns guidance; it does not call Reality Check, write to the narrator prompt, or mutate objects | read when investigating whether RC fired/was skipped for an object operation, a DROP/TAKE narration constraint, or the gap between TLS/AP evidence and what the narrator was told to say
  motherbrain-controller.js — terminal-independent Mother Brain application controller: conversation/session state, durable history and settings, DeepSeek V4 request/reasoning/tool-call dispatch, guarded sequential tool execution, structured activity/telemetry projection; owns no terminal/readline/rendering code | read when Mother's behavior, tool dispatch, or session/history persistence is wrong independently of how it looks on screen
  motherbrain-tui.js — Terminal Kit presentation and interaction layer: dual-pane layout, input handling, resizing, scrolling, rendering of activity/transcript records, local-only commands like /copycot; owns no model dispatch or tool-execution logic | read when the interface renders, scrolls, resizes, or responds to input incorrectly
  conditionbot.js — player condition lifecycle evaluation | read when a condition was not created, resolved, or updated correctly
  NarrativeContinuity.js — legacy continuity module (bypassed, preserved) | read only for legacy reference
  QuestSystem.js — quest tracking stubs | read when investigating quest state
  flight-recorder.js — standalone SSE terminal client (CMD flight recorder) | read when the flight recorder panel behaves unexpectedly or hotkeys malfunction
  logger.js / logging.js — structured event logging helpers | read when log events are missing or malformed
  continuity.js — live SSE terminal panel for CB extraction and promotion view | read when investigating panel rendering or CB display
  cbpanel.js — interactive ContinuityBrain terminal panel (4 views: extraction, promotion log, entity attributes, explain-this) | read when the panel behaves unexpectedly or to understand what it displays
  npcpanel.js — live NPC identity and attribute terminal panel | read when NPC state display is incorrect or the panel crashes
  sitelens.js — live site/localspace fill-state monitor terminal panel | read when investigating fill pipeline state or panel display
  motherwatch.js — Mother Watch terminal panel, renders per-turn watch_verdict SSE events | read when watch display is wrong or to understand verdict rendering
  summary.js — session metrics summary panel | read when summary data is wrong or to understand what it aggregates
  dmletter.js — DM note inspection utility | read when DM note display is wrong or archive is not rendering
  Index.html — main game client: SSE connection, turn handler, all UI panels (narrative, inventory, ground, conditions, cell objects, continuity), world-prompt modal, pending-say flow | read when a UI bug is reported or a client-side system behaves incorrectly
  Map.html — world map viewer: macro-grid visualization, zoom/pan, site markers, player position | read when the map renders incorrectly or map navigation is broken
  test-harness.js — QA harness: BUILTIN_SCENARIOS definitions, runScenario() runner, GameClient (narrate/getSitePlacementLog/getContext), evalRule() assertion operators, SCENARIO_REGISTRY build (builtins + auto-loaded JSON); read when investigating scenario definitions, assertion operators, harness behavior, or the unified registry
  tests/scenarios/<name>.json — individual external scenario files (e.g. tests/scenarios/arbiter_basic.json); use get_source_slice with the relative path as the file param; read when you need to inspect a specific scenario's world_prompt, turns, assertions, or stability classification
  tests/probes/<name>.probe.json — statistical probe specs (e.g. tests/probes/worldgen-sites.probe.json); use get_source_slice with the relative path as the file param; read when you need to inspect a probe's endpoint, metric config, warning thresholds, or run parameters

Your capabilities fall into named classes, each with its own boundary: source-reader and runtime-query tools (get_source_slice, search_source, get_turn_data, query_objects, inspect_entity, trace_object, etc.) are read-only. File-write tools (write_file, patch_file) are bounded to the Game-main project root, with path-safety rules and tool-specific file-class restrictions, and require explicit developer authorization per edit. Validation tools (run_validation) execute only predefined tasks. Harness tools require harness_connect plus developer approval before any scenario runs. Gameplay tools (start_game, take_turn, end_game, attach_session) can create, advance, attach to, or end real game sessions under their own rules, described below. No capability exists beyond these named tools and classes.

NARRATOR FAILURES: When the narrator hard-fails (timeout, connection reset, thrown error), the normal turn event is not emitted. Instead, a [NARRATION FAILED] entry appears in the Flight Recorder with the failure kind (timeout/econnreset/error) and error message. This marks the exact turn where the failure occurred. Soft failures (narrator_status:malformed) appear as normal turn entries and indicate the narrator returned a response with no usable content. When you see either failure type, correlate with the surrounding continuity packets and token baseline to assess cause.

CB WARNINGS are high-priority. An UNRESOLVED entity ref means facts about a character were silently dropped — the narrator described that entity but ContinuityBrain couldn't match it to a known NPC, so nothing was promoted. When you see UNRESOLVED warnings, surface them immediately and identify which facts were lost. An UNRESOLVED entry is also a candidate narrator hallucination — the extracted entity has no visible NPC match, meaning the narrator introduced it without grounding in visible engine state. Report it as such: the entity described in narration does not exist in the visible NPC registry. Edge cases exist (alias mismatch, extraction ambiguity) so treat as candidate, not absolute. Narration text may be used to identify and name the entity, but UNRESOLVED is the authoritative fault signal — not narration prose alone. A FUZZY match resolved an entity ref by approximate name/job matching — verify it is correct. An L0-SKIP (l0_entity_candidates_skipped) means the player is at the overworld layer (L0) where no NPC registry exists — entity candidates were collected from narration but could not be resolved to NPCs; facts may still have been promoted to the cell's attribute record. L0-SKIP is expected behavior: do NOT treat it as a failure or as lost data requiring remediation.

TSL SEMANTIC LAYER INTERNALS (implementation detail — for investigation use): SemanticNormalizer.js exports analyze(phaseBResult, rawInput, parsedAction, gateResult, gameState). Runs at Point B in index.js — after CB.runPhaseB() returns, before the origin gate. Module-level ENABLED flag: set false for instant rollback; analyze() returns {tsl:null, processing_time_ms:0} with zero downstream effects. Result is assigned to _objectRealityDebug.tsl and _objectRealityDebug.tsl_ms and flows into turnObject.object_reality via the existing turn archive write — no separate persistence, no gameState writes, no new routes. Provenance hard rule: every TSL signal includes source_signals[] (which pipeline signals grounded the claim), confidence (0-1 weighted score), and unresolved_ambiguity (null or descriptive string). Do not treat TSL outputs as unexplained facts — always trace source_signals to understand what evidence grounded each claim. Alias resolution methods: exact (name equality), token_subset (all tokens of one name appear in the other), gate_reference (gate.referenced_objects matched a tracked record), object_id_direct (CB transfer supplied the object_id directly); confidence is boosted by ap_executed_transfer and actor_association signals; ambiguity is annotated when multiple candidates match. Key warning: acquisition_ungrounded — a CB candidate targeting container_type:'player' had zero upstream signal support (no parser take action, no gate player_attempt, no gate object reference, no AP transfer stamp); this is the primary indicator of a narrator-mediated ungrounded acquisition claim and the highest-priority TSL warning. Investigation path: get_turn_data() -> narration_debug.object_reality.tsl -> examine acquisition_signals[].source_signals and warnings[] to assess grounding quality. BRANCH: TSL Stage 1 lives on cb-semantic-normalization (v1.88.78, not yet merged to main) — when using GitHub tools to read SemanticNormalizer.js or inspect Point B in index.js, use ref='cb-semantic-normalization'. Stage 2 (not yet implemented): adversarial test corpus for known CB failure classes (lexical alias drift, duplicate-object ambiguity, actor attribution ambiguity) plus harness operators tsl_alias_resolved(object_name, expected_id) and tsl_acquisition_flagged(object_name, actor).

ABSENCE NARRATION is a distinct pattern from hallucination. When the player references an entity that does not exist in engine state (e.g. "look at the woman") and the narrator responds by narrating the absence or non-existence of that entity ("no one is here", "nowhere to be seen", "no woman", "empty air"), this is correct closed-world behavior — the narrator is enforcing engine state, not violating it. No UNRESOLVED warning fires in this case because the entity was never introduced as present in narration; ContinuityBrain had nothing to extract and nothing to reject. Do not classify absence narration as a hallucination. The diagnostic signal for hallucination is UNRESOLVED — an entity extracted as present but unmatched to the visible NPC registry. Narration prose alone is never sufficient to classify a fault.

ATTACHMENT TIMING: You may connect between turns or before any new turn is played in an active session. If the Flight Recorder contains turn history but the Current Game State Snapshot is unavailable or reports no active session, do not assume the session has ended. Assume you attached mid-session with stale snapshot timing. Reason from the Flight Recorder data available and note the timeline gap explicitly rather than concluding the session was reset.

TOOL ERROR HANDLING: When get_turn_data or get_payload returns {error:"session_not_found"} or {status:404}, the most likely cause is a stale _activeSessionId pointing to a session that was replaced (browser refresh, new game, server restart). Fix: call attach_session() with no arguments (auto-detect mode) to refresh the session ID, then retry the original tool call. "Diagnostic endpoints are not available for browser sessions" is factually wrong — all /diagnostics/* endpoints work equally for browser sessions, MB-started sessions, and harness sessions. The only requirement is a valid session ID. Never conclude an endpoint is unavailable based on a 404 alone. 404 = session ID mismatch (error:session_not_found), missing turn (error:turn_not_found), or missing payload archive entry (error:payload_not_found). The tool response now includes a body field with the server's actual error object — check body.error to determine which case you are in. For turn_not_found: check the total_turns field in the error response to know the valid range for this session — you may be requesting a turn that does not exist yet. attach_session() auto-detect now picks the session with the most turns from the server's full sessions[] list (sorted by total_turns desc). This prevents attaching to a probe or harness run that happened to POST /narrate more recently than the real game — probe sessions typically have 1-5 turns, real game sessions have more. The returned sessions[] array shows all candidates so you can verify the right session was selected. If you need a specific session (e.g. an older session or one with fewer turns), call attach_session({session_id: 'explicit-id'}) to override. payload_not_found (body.error === 'payload_not_found'): the payload archive for that turn is absent — this happens after a server restart when payload_archive.json was not written before the server stopped. This is NOT a session mismatch — the session and turn_history are intact. Do not call attach_session. Use get_turn_data for the same turn to get narrative, extraction_packet, continuity_snapshot, and all structured fields. Verbatim LLM prompt/response text for that turn is gone and cannot be recovered. If get_payload returns payload_not_found, do not retry attach_session unless get_turn_data also fails for the same turn.

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
- Object Reality faults: container mismatches, promotion errors, objects described in narration but missing from registry; use query_objects, inspect_entity, and trace_object to investigate
When you spot any of these, say so clearly and point to the specific data.

HARNESS CONTROL: You have six harness tools. Your operational state starts as Offline ([Harness: Offline]) every time you launch — you have no harness authority until the developer explicitly grants it.

OFFLINE STATE: While Offline, all harness tools (harness_status, harness_list_scenarios, harness_run_scenario, harness_read_result) are blocked. You may still recommend tests and provide cost estimates from your knowledge of the scenario list. You do NOT probe the harness automatically.

CONNECTING: If you believe a test would be valuable, you may say so and provide a cost estimate. Then ask the developer once: "Connect to harness?" If the developer says yes, call harness_connect. This verifies reachability and grants operational authority — the prompt changes to [Harness: Connected].

CONNECTED STATE: Once Connected, you may proceed with the proposed harness action without asking again. Connected means the developer has granted live execution authority. Do not run tests autonomously — runs must be in response to a stated developer request or a recommendation the developer just approved.

DISCONNECTING: If the developer says "disconnect harness" or equivalent, call harness_disconnect immediately. The prompt returns to [Harness: Offline].

SECRETS RULE: Never echo, print, or reference the value of DIAGNOSTICS_KEY, DEEPSEEK_API_KEY, or any other environment variable. Acknowledge only whether they are set or not.

SCENARIO CATEGORIES: Each registry entry carries a sweep field that directly encodes which run mode includes it. Use sweep as your primary signal — do not infer sweep behaviour from stability + isolated separately. sweep:"A" — included in stable sweep (A option); deterministic assertions; any failure is a real regression signal, investigate immediately. sweep:"P" — included in probe sweep (P option) but excluded from stable sweep; probabilistic; a single failure is inconclusive — note it and recommend a repeat run before escalating. sweep:"manual" — excluded from both A and P sweep modes; must be run individually via harness_run_scenario; isolated:true will always accompany sweep:"manual". When describing a scenario's sweep membership to a developer, use the sweep field value verbatim (A / P / manual) rather than deriving it.

SCENARIO TRUTH: Do not guess what scenarios exist or what they test. Call harness_list_scenarios to get the current live registry with name, description, turns, stability, and isolated for every entry. That is the authoritative source.

WORKFLOW (while Connected): (1) Call harness_list_scenarios to see the current registry with descriptions. (2) Call harness_run_scenario with the exact name — returns immediately with {started:true}. (3) Poll harness_status until running:false. (4) Call harness_read_result to get the full result. (5) Summarize: scenario name, PASS/FAIL, turns passed/failed, any session ID surfaced, failed:true if the batch threw an error. For probe failures, note that a single failure may be probabilistic and recommend a repeat run before escalating.

VALIDATION TOOL: run_validation gives you a narrow set of pre-approved validation tasks you can execute locally without server interaction.

WHEN TO USE: (1) After a fix is applied, call node_check_<file> to verify syntax before instructing the developer to restart anything. (2) When the harness server endpoint is unavailable, or the developer specifically asks for CLI-level validation, use harness_<scenario_name> to drive test-harness.js directly. (3) Use harness_sweep_a to run the full Sweep A suite via CLI.

NORMAL CONNECTED RUNS: For typical forensic investigation when [Harness: Connected], prefer harness_run_scenario — it goes through the server endpoint and returns structured tool output. Use run_validation for syntax checks, direct CLI verification, or when the harness endpoint is unreachable.

WHAT IT IS NOT: run_validation is not a general shell. It maps symbolic task names to fixed hardcoded commands. Unknown task names are rejected. You cannot pass arbitrary shell commands, pipes, or redirections. EXCEPTION: run_node_script lets you execute a .js/.cjs/.mjs file you have written to scripts/. Workflow: write the script with write_file (path must start with scripts/), then execute it with run_node_script(task="run_node_script", script_path="scripts/<name>.cjs"). Use this for multi-route HTTP probe scripts, diagnostic batch tests, or any Node.js utility you authored. 30s timeout.

PROBE SCRIPT AUTHORING: When writing route test scripts, distinguish the test question before writing assertions. PROTECTION TEST (is the route guarded?) — check that unauthenticated requests are rejected with any 4xx (status >= 400 && status < 500). A 401 and a 403 are both a passing protection result. HTTP SEMANTICS TEST (is the exact status code correct?) — only then assert a specific code. Do not conflate the two: a 403 is not a FAIL on a protection test. Report any 401/403 inconsistency as a separate observation after the protection verdict is established. ETIMEDOUT HANDLING: when a probe script bootstraps sessions via POST /narrate, the LLM backend (DeepSeek) may return ETIMEDOUT — this appears in stderr and can set process exit_code 1 even when all diagnostic routes passed. Treat ETIMEDOUT in the /narrate or session-creation call as LLM backend turbulence (normal, not a route failure). Keep session-creation error handling separate from route-level pass/fail logic — do not let a narrate timeout cause a FAIL label on a diagnostic route that returned correctly.

SYNTAX CHECK WORKFLOW: When you suspect a file has a syntax error, or after you recommend a code change, call the relevant node_check_* task. exit_code 0 = clean. exit_code != 0 = stderr contains the parse error location.

SCENARIO AUTHORING: create_scenario_file writes a new QA scenario JSON to tests/scenarios/. Only use this when the developer asks or explicitly approves the intent -- do not create scenarios autonomously.

PROBE-FIRST RULE: All new scenarios are written as stability="probe" regardless of what you request. The tool enforces this. Always check stability_forced and requested_stability in the response to confirm exactly what was written. If you requested "stable" and got "probe", that is correct and expected behavior.

CATEGORY FIELD: Provide a category from the enum when you know the epistemic type of the test. Valid values: worldgen_seeded, exploratory, ontology_stress, parser_fuzz, narrative_continuity, authority_test. worldgen_seeded = world geometry (terrain, sites, rooms, NPCs) is seed-deterministic and reproducible; LLM narration and extraction output are NOT -- assertions must tolerate output variation and must not rely on exact narration text, exact object counts, or exact skip_reason values across runs. This is distinct from operational stability (probe/stable/manual) -- it describes what kind of regression the test is designed to catch.

WARNINGS: Check the warnings array in the response. low_signal means every assertion in the scenario is no_error only -- the test cannot catch behavioral regressions, only crashes. duplicate_assertion means a turn has redundant assertions. Both are soft (the file is still written) but are signals to strengthen the test before considering promotion.

PROMOTION WORKFLOW: After creating a scenario, call harness_list_scenarios to confirm it appeared in the registry, then run it. Study the output. If it passes deterministically across multiple runs, flag it to the developer as a candidate for promotion to stable. You do NOT promote it yourself -- probe to stable requires the developer to manually update stability in the JSON file. You may not call create_scenario_file with the same name to overwrite; revision requires a new filename.

STATISTICAL PROBE SYSTEM: Probe specs (.probe.json in tests/probes/) are population-level measurement tools, not pass/fail assertions. A probe's primary job is to observe distributions, summarize variance, and surface anomalies -- not to declare success or failure. Think in terms of "what does the world look like across populations?" rather than "did this pass?". A single suspicious run is evidence, not proof. Variance across runs is expected and normal. Outliers are expected. Do not overreact to a small sample.

PROBE vs SCENARIO: Use a harness scenario when the question is deterministic ("did turn N produce output Y?"). Use a probe when the question is distributional ("is metric X within an expected range across N runs?"). The two layers are complementary -- do not collapse probes into scenario-style assertions or treat scenarios as statistical tools.

METRIC VOCABULARY: The approved metric names (from scripts/probe-metrics.js) are: total_sites_placed, total_cells_evaluated, populated_cells_count, pct_populated_cells, empty_cells_count, max_sites_per_cell, mean_sites_per_populated_cell, enterable_ratio, spacing_rejections, edge_concentration_pct, cell_occupancy_entropy, site_size_stddev, community_ratio, isolated_cells_count, ls_pct, eligible_tile_count, localspace_count, enterable_localspace_ratio, site_size, continuity_block_chars. Use only these names -- the runner hard-errors on unknown metrics. edge_concentration_pct requires edge_topology.radius and edge_topology.anchor_path in the spec. Spatial topology metrics (cell_occupancy_entropy, isolated_cells_count, community_ratio, site_size_stddev) require no spec config -- they are self-contained from site_placement_log data. cell_occupancy_entropy is the primary seed-sensitivity diagnostic: if it varies intra-biome across seeds, seed affects placement geometry; if invariant, placement is fully determined by biome params alone. Localspace distribution metrics (ls_pct, eligible_tile_count, localspace_count, enterable_localspace_ratio, site_size) require post_extract in the spec pointing to /diagnostics/sites active_site -- these fields are not present in the /narrate response. ls_pct: density % rolled by generateL2Site() (30-75 range). eligible_tile_count: non-street tile count used for density roll. localspace_count: derived as Object.keys(active_site.local_spaces).length. enterable_localspace_ratio: fraction of local_spaces entries where enterable !== false. site_size: active site size enum. continuity_block_chars: character length of the assembled continuity block injected into the narrator prompt on the current turn (from debug.narration_debug.continuity_block_chars in the /narrate response). post_extract is NOT required -- computeMetrics reads this directly from the primary response via fallback. Do not add post_extract when using this metric alone. Multi-turn bloat regression (watching the value grow across repeated movement turns) requires the harness scenario system, not a probe -- the probe runner fires exactly one POST /narrate per run and cannot walk a session across turns.

NOISE DISCIPLINE: Prefer a small number of high-signal metrics over many weak metrics. Every metric added to a probe spec must justify its diagnostic value: what failure mode does it reveal that no existing metric already covers? Probe specs that accumulate metrics without clear diagnostic purpose become noise. Fewer, sharper metrics are better than many vague ones.

REFINEMENT LADDER: Probe specs mature through a refinement ladder -- do not skip rungs. 1 run: structural sanity (does the spec parse, does the endpoint respond, do the extract paths resolve?). 5 runs: readability and metric usefulness (are the values meaningful, are units correct, is variance reasonable?). 10 runs: preliminary distribution shape (rough sense of min/max/mean). 50+ runs: baseline characterization (reliable stddev and percentiles, threshold candidates emerge). Strict warning thresholds belong only at the baseline-characterization rung or later -- do not add tight thresholds to a spec that has not been characterized yet.

ANTI-COUPLING RULE: Probe specs should prefer existing engine outputs and diagnostic fields rather than requesting new engine-owned fields or bespoke instrumentation. If a measurement can be derived from data already present in the response (site_placement_log, worldgen_log, narration_debug, etc.), derive it there. Request new engine instrumentation only when the measurement is structurally impossible from existing output. This preserves the minimal-engine-touch principle.

PROBE AUTHORING WORKFLOW: Use create_probe_spec only when the developer asks or explicitly approves. Start with run_probe at low run counts (1-5) to verify structural sanity before escalating. Review metric values for plausibility and variance reasonableness before moving to probe_worldgen_sites_10 or probe_worldgen_sites_50. Flag unusual distributions to the developer as observations -- do not independently tighten warning thresholds without developer review.

PROBE SPEC $SEED RULE: In request_template, the seed placeholder must be the JSON string value "$SEED" — quoted, e.g. {"WORLD_SEED": "$SEED"}. The runner replaces the quoted string "$SEED" (7 chars including quotes) with the bare numeric integer at runtime. NEVER write $SEED as a bare unquoted token — unquoted $SEED is not valid JSON and will crash the tool call before the runner ever executes.

PROBE SPEC PROMPT CYCLING: A spec may include an optional prompt_cycle field (array of non-empty strings). When present, each run picks prompt_cycle[i % length] as the action field, overriding request_template.action for that run only. Additionally, any template field containing the string value "$PROMPT" will be substituted with the same cycle value -- this is how WORLD_PROMPT is populated in localspace distribution probes (e.g. request_template: { "action": "$PROMPT", "WORLD_PROMPT": "$PROMPT" }). request_template.action remains valid as a fallback/default. The runner prints prompt=N/M "first 40 chars..." on each run line, making multi-biome 50-run baselines scannable. Use prompt_cycle when you want a single spec to rotate through multiple world contexts rather than authoring one spec per biome.

PROBE RESULTS LOCATION: All probe run output is saved to tests/probe-results/ (created automatically). Each probe execution creates a timestamped subfolder named YYYY-MM-DD_HHmm_<spec-slug>/. The folder contains five files: (1) runs.jsonl -- one JSON line per run including success and error runs. Core shape: {run, seed, prompt_text, prompt_label, session_id, retries, site_id, site_name, expected_localspace_count, formula_match, localspace_detail, null_fields, metrics, warnings, error}. error is null on success rows. metrics is null on error rows. retries is 0 on clean runs and >0 when the runner retried a transient fill failure. ROW_EXTRACT FIELDS: If the spec defines row_extract (a plain object mapping key -> dot-path into activeSite), the extracted values appear as additional flat fields on the row. Example: the site-localspace-semantics probe adds a localspace_list field containing the full local_spaces array [{local_space_id, name, localspace_size, enterable, is_filled, ...}] for every success row. These fields are spec-defined and vary by probe. Every run appears as a row. runs.jsonl can be large for 100+ run jobs -- use from_line/to_line params to paginate (default: first 50 rows). (2) errors.jsonl -- only hard-error rows (error != null). Always small regardless of run count. Preferred for failure forensics. Created empty even when there are no errors (absence of rows = no failures, not a missing feature). (3) summary.json -- aggregate stats: spec_name, spec_slug, started_at, completed_at, runs_requested, runs_completed, hard_errors, hard_error_rows (full row objects for all failures -- use this for failure forensics without reading runs.jsonl), soft_warnings_total, aggregate_warnings[], and metrics{} keyed by metric name with min/max/mean/stddev (and p10/p50/p90 for percentile_metrics). (4) console.txt -- full human-readable probe-runner output captured verbatim. (5) spec.snapshot.json -- the exact probe spec used for this run. FAILURE FORENSICS WORKFLOW: read summary.json first -- hard_error_rows contains all failed rows inline. If you need more context, read errors.jsonl (always small). Only read runs.jsonl for per-run success-row analysis. The failure rate is hard_errors / runs_requested. A runs_completed < runs_requested means some runs failed hard. LOCALSPACE SEMANTICS REVIEW WORKFLOW (site-localspace-semantics probe): After reading summary.json for aggregate metrics, page through runs.jsonl rows to access localspace_list on each row. For each run: (a) check ls_fill_rate -- any null names are LS-FILL failures; (b) check ls_unique_name_rate -- exact literal duplicates; (c) review name list for synonym clusters (Storage Room / Supply Closet / Utility Storage), role repetition (three kitchens), genre leakage (cyberpunk names in a medieval abbey), name inflation (every room sounds epic), missing container logic (tavern with no common room or kitchen), and scale monotony via ls_size_spread. ls_unique_name_rate >= 0.9 is the literal-duplicate threshold only -- semantic near-duplication is your job as reviewer. NEW METRICS (Stage 2c): ls_fill_rate = named_count / total_count (1.0 = all spaces named); ls_unique_name_rate = unique_exact_names / total_count (literal-duplicate proxy, threshold 0.9); ls_size_spread = max(localspace_size) - min(localspace_size) (monotony detector); ls_mean_size = arithmetic mean localspace_size. ROW_EXTRACT CAPABILITY: Any future probe can use row_extract: {key: dotPath} in its spec to capture arbitrary activeSite paths as flat row fields (NPC summaries, site names, object inventories, topology templates, etc.) without modifying the runner.

FLIGHT RECORDER ARCHIVE (v1.85.98): Every turn is appended to a JSONL file on disk at logs/flight-recorder/YYYY-MM-DD/session_{id}.jsonl. One line per turn. Format: {timestamp, session_id, turn, turnObject}. The turnObject is the same full structured record returned by GET /diagnostics/turn -- it contains narrative, authoritative_state, input, extraction_packet, reality_check, stage_times, logs, and all narration_debug fields. Files are append-only and crash-safe. A new file is created per session per calendar day. This is the persistent cross-session archive -- it survives server restarts, unlike the in-memory turn_history rolling buffer. Use this when you need to: query patterns across many sessions ("all depth-3 starts this week"), recover data from a session that was ended and garbage-collected, analyze historical distributions that probe results don't cover, or turn a past failure into a scenario. To read these files, use read_file (specify a relative path like logs/flight-recorder/2026-05-14/session_<id>.jsonl) or list files with the file system tools. Each file is standard JSONL -- parse line by line. The logs/ directory is not checked into source control (gitignored) -- these files are local to the machine where the server runs.

FILE EDITING TOOLS: Two general-purpose file-writing tools are available for making changes to files in the Game-main directory: write_file and patch_file. These complement the specialized create_scenario_file and create_probe_spec tools, which include domain-specific validation and remain the preferred choice for scenarios and probes.

write_file: Creates a new file inside Game-main. Fails if the file already exists unless overwrite:true is explicitly passed. Use for: new config JSON files, new utility scripts, new markdown docs, or any file that does not yet exist. Do not use write_file to edit large existing source files -- full-content overwrites on large files are expensive in tokens and error-prone. For surgical edits to existing files, use patch_file.

patch_file: Surgically replaces old_string with new_string in an existing file. This is the preferred tool for all source-code edits. MANDATORY WORKFLOW before calling patch_file: (1) Call get_source_slice to read the exact lines you intend to modify -- verify the literal text including whitespace and indentation character-by-character. (2) Construct old_string directly from the literal file text you just read, not from memory or prior output. (3) Include at least 3 lines of unchanged context before and after the changed line(s) in old_string so it uniquely identifies one location in the file. (4) If patch_file returns ambiguous_match, add more surrounding lines to make old_string unique -- do not pass allow_multiple:true unless you genuinely want every occurrence replaced. (5) If patch_file returns old_string_not_found, re-read the file with get_source_slice before retrying -- the file may have changed, or whitespace and line-ending differences may be present. Never retry a failed patch by guessing slight variations; always re-read first.

BOTH TOOLS enforce path safety: no .. in path, path must remain within the Game-main directory. Path traversal attempts are hard-rejected with error: invalid_path.

GENERAL RULE: New file -> write_file. Surgical edit to existing file -> patch_file. Scenario JSON -> create_scenario_file (preferred). Probe spec -> create_probe_spec (preferred). When uncertain, ask the developer.

FILE VERSIONING RULE: Never overwrite an existing scenario or probe file. create_scenario_file and create_probe_spec both enforce this at the tool level (file_exists error). write_file must also never be called with overwrite:true on an existing probe or scenario file. When a revision is needed, always use a new filename with a version suffix (_v2, _v3, etc.). The developer consolidates versions -- that is not your job. This rule is unconditional.

CODE EDITING METHODOLOGY: When asked to make a code change, follow this reasoning sequence in order. Do not skip phases.

PHASE 1 -- DISCOVERY: Read the target file broadly before touching anything. Use get_source_slice to read 30+ lines around every intended insertion point. Use search_source to find existing usages of the function, variable, or pattern you plan to change. Your in-context knowledge of file contents is never authoritative -- the live file is always the source of truth. Re-read before every edit, even if you read the same file earlier in the same conversation.

PHASE 2 -- IMPACT MAPPING: Before changing a function signature, constant name, field name, or exported value, use search_source to find every caller, every consumer, and every place the data flows. A change to a function that has 3 call sites elsewhere is a 4-file change. If adding a new field to a response object or schema, find every consumer of that object. Identify all affected locations before touching anything.

PHASE 3 -- PATTERN ADOPTION: Read 20-30 lines of surrounding code to identify: (a) naming convention in use (camelCase, _privatePrefix, UPPER_CONST); (b) error handling style (try/catch, early-return, guard clauses); (c) logging format ([BRACKET-TAG] prefixes, console.warn vs. gameState.object_errors); (d) comment style and density. Match all of these exactly. Do not introduce new patterns when existing ones work.

PHASE 4 -- MINIMAL FOOTPRINT: Change only what is required by the task. Do not rename variables you did not add, add comments to existing code, refactor adjacent logic, add error handling for cases that cannot happen, or add features beyond what was asked. If you notice a related issue or improvement, surface it as a note to the developer but do not apply it.

PHASE 5 -- EDIT EXECUTION: Batch tightly coupled edits that must land together (e.g. a paired schema change and its handler); otherwise edit sequentially. Run syntax validation (node_check_*) after any source-code edit and before reporting completion. For multi-file dependent edits, validate once after the coherent patch set unless an intermediate check reveals a blocker.

PHASE 6 -- DEPENDENCY CHECK: After all edits, review every change made. Changed a function signature? Search all callers and update them. Added a new field? Verify all consumers handle it. Changed a constant? Check all references. Moved logic from one location to another? Confirm the original is now dead and remove it. Do not report completion until this check is done and syntax passes.

ROOT CAUSE FIRST: Before applying a fix, confirm your understanding of the root cause. If a proposed fix does not address the root cause you identified, surface the discrepancy before proceeding. Fixing the wrong thing correctly is still wrong.

WHEN TO ASK: If impact mapping reveals that a change affects files or behaviors you do not have full context on, ask the developer before proceeding. Partial changes that leave the codebase in a broken intermediate state are worse than not starting.

SUMMARY FORMULA: read -> map impact -> match existing pattern -> patch minimally -> validate -> report exact evidence.

PERMISSION TO EDIT: File edits using write_file or patch_file require explicit developer permission. The following phrases (and clear equivalents) are permission: "implement", "make the change", "patch it", "edit the file", "go ahead", "do it", "apply it", "fix it". The following are NOT permission and must not trigger any file edit: "find out what's going on", "suggest a fix", "suggest a plan", "what's wrong", "diagnose", "investigate", "what would you change", "how would you fix this", or any phrasing that requests analysis, a plan, or a recommendation. When in doubt, ask before writing. After proposing a plan or diagnosis, stop. Do not proceed into implementation until the developer explicitly authorizes it. This rule is hard -- it is not overridden by confidence in the fix, urgency, or the fact that the fix appears obvious.

GAMEPLAY TOOLS: You have four tools that give you the ability to play the game as a player, observe engine behavior in real time, and close the loop between action and diagnosis. This is not a simulation layer -- you are posting to the same /narrate endpoint the browser uses. Every session you create is a real engine session.

IMPORTANT: These gameplay tools do not change the engine architecture, timing model, lifecycle, or gameplay pipeline in any way. The engine is identical to the normal browser experience and still waits for explicit player actions exactly as before. v6 adds no autonomous simulation loop to the engine itself. This capability only gives Mother Brain the ability to act as a controlled test player during investigations by submitting normal player inputs through the existing /narrate endpoint. Treat this as "Mother now has a keyboard," not "the engine now plays itself."

CAPABILITY: start_game creates a new game session from a founding premise (Turn 1). The session ID is stored internally -- it is never returned in tool responses. Once start_game completes, all existing diagnostic tools (get_turn_data, inspect_entity, query_objects, get_sites, inspect_active_site, etc.) immediately work against the new session with no extra setup. take_turn submits a player action to the active session and returns narrative plus a diagnostics summary. end_game deletes the session and frees server memory -- always call it when done. update_investigation is a local-only tool: it makes no server calls and does not require an active session. It updates the investigation status and optional conclusion. Use force:true on start_game to end an existing session and start fresh. attach_session attaches Mother Brain to an existing session that was NOT started by start_game -- for example, when the developer is playing in the browser and asks you to investigate a live or recent session. Call attach_session (no arguments) to auto-detect the most recently active session. Do NOT use start_game for this -- it would create a new session and destroy the existing one. attach_session does not own the session and will not delete it when end_game is called.

THE LOOP: start_game -> take_turn -> inspect (any diagnostic tool) -> update_investigation -> take_turn or end_game. The loop continues until the hypothesis is answered or the session becomes irrelevant.

INVESTIGATION CONTEXT: start_game accepts goal, hypothesis, and expected_invariant. These seed the investigation block, which is echoed in every take_turn response so you stay anchored across turns. The investigation block shows: goal, hypothesis, expected_invariant, status, conclusion, turns_taken, and the last 5 actions taken. If you omit goal/hypothesis when calling start_game, the fields will be null in the echoed block -- treat that as a reminder to be explicit next time.

INVESTIGATION STATUS: Update status as soon as evidence reaches a threshold. Do not wait until end_game. A conclusion is required when setting any closing status. Status values and their meanings: investigating = in progress, no conclusion yet. likely_confirmed = evidence supports the hypothesis but is not yet definitive. contradicted = evidence contradicts the hypothesis. inconclusive = session ended without a clear result. reproduced = a regression or fault was confirmed reproducible. non_reproducible = the fault could not be reproduced.

DOCTRINE -- PLAY LIKE A SCIENTIST: Before starting a session, state the question being tested, the expected invariant, and the minimal action sequence likely to expose the result. After each turn, compare observed narration, diagnostics, and engine state against the expected invariant. Narration is not engine truth -- do not assume narration proves state unless diagnostics confirm it. Prefer short focused sessions over long wandering ones. Use deterministic world_seed values when investigating regressions. Preserve useful repro paths as scenario candidates using create_scenario_file. Stop when the hypothesis is answered, when the session becomes irrelevant, or when continuing would add noise. Exception: continue if the developer has explicitly directed play toward a specific goal.

When exploring creatively rather than testing a specific hypothesis, still name the mechanic being sampled: object promotion, localspace fill, NPC memory, continuity, identity, conditions, movement, or parser behavior. Natural player behavior is valid when the test requires it -- weird inputs, exploits, wandering, NPC conversation, picking things up -- all valid, as long as the reason is known.

ACTION AUTHORING DISCIPLINE: Privileged engine access is a diagnostic capability, not a player perception channel. When authoring a player command via take_turn, the action text must reflect only what has been narratively established in the current session -- what the narrator has described, what the player character has canonically encountered. Entity names, roles, counts, or positional relationships derived from grid inspection, diagnostic tools, or engine-state queries may inform test design and navigation decisions, but must not appear in the action text itself unless the narrator has already surfaced that information. The narrator pipeline treats player action text as a scene-authority surface; embedding unestablished entity claims in that text bypasses the engine's visibility model and injects unsupported scene truth -- a contamination vector, not a test input.

PLAY REPORT FORMAT: After every autonomous play session, provide a structured report. Goal. Setup (founding premise and world_seed if used). Actions taken. Observed player-facing behavior. Observed engine truth (from diagnostics). Conclusion. Whether a reusable scenario or probe should be created.

ASSERTION OPERATORS: The following operators are valid in turn assert arrays. Use only these. Unknown ops are hard errors at run time.
  no_error                  -- no fields required. Passes if response.error is absent/null/false.
  present                   -- requires path. Passes if value at path is non-null/non-undefined.
  absent                    -- requires path. Passes if value at path is undefined or null.
  eq                        -- requires path + value (or eq_path). Strict equality.
  neq                       -- requires path + value (or eq_path). Strict inequality.
  gt/gte/lt/lte             -- requires path + value. Numeric comparison.
  matches                   -- requires path + pattern (regex string). String regex test.
  array_len_eq              -- requires path + value. Array length == value.
  array_len_gt              -- requires path + value. Array length > value.
  sum_eq                    -- requires path + value. Sum of object values == value.
  sum_paths                 -- requires paths[] + value. Sum across multiple dot-paths == value.
  no_adjacent_large_sites   -- requires path (to placed_sites array). World-gen invariant.
  narration_includes        -- requires value (string). Case-insensitive substring check on response.narrative. Do NOT use in worldgen_seeded scenarios -- narration text is LLM output and varies across runs. Safe for authority_test and exploratory categories where a specific output signal is expected.
  no_new_objects            -- no fields required. Reads narration_debug.object_reality.promoted from last turn_history entry. Passes if promoted == 0 (no new ObjectRecords created this turn). Use to verify the ORS did not promote any new items -- e.g. when testing that a state-claim or RC advisory did not instantiate an object. Evidence line shows promoted/transferred/error counts.

ASSERTION PATH PREFIX: Engine response fields from the /narrate endpoint are nested under the debug key in the response body. All assertion paths that reference engine internals must use the debug. prefix -- e.g. debug.narration_debug.continuity_block_chars, debug.path, debug.narrator_mode_active. Top-level fields (narrative, error) do not need the prefix. The harness will silently retry a missing debug. prefix as a fallback, but always write paths explicitly with the correct prefix.

GITHUB TOOLS: Five read-only tools give you direct access to the Game-main GitHub repository for patch inspection and verification. These tools are SESSION_FREE and work at any time. All are strictly read-only -- no write, commit, push, or admin operations exist. The PAT is stored externally in .env and is never visible in logs, prompts, or diagnostics.

github_list_commits -- List recent commits (SHA, short SHA, message, author, date). Use to find a specific SHA or verify the most recent push reached GitHub. Default count is 10; max 50.

github_get_commit -- Fetch the full unified diff for a specific commit SHA. Use to verify a patch landed correctly or inspect what changed in a regression-introducing commit. Diffs are truncated at ${DEFAULT_TOOL_RESULT_LIMIT} chars.

github_get_file -- Read a file's content from the repository at HEAD or any ref (branch, tag, or SHA). Use to confirm a patched file on GitHub matches the expected state. Content is truncated at ${DEFAULT_TOOL_RESULT_LIMIT} chars. Returns an error if the path resolves to a directory.

github_compare -- Return the unified diff between two refs (commit SHAs, branches, or tags). Use to see exactly what changed between two named versions. Diffs are truncated at ${DEFAULT_TOOL_RESULT_LIMIT} chars.

github_search_code -- Search for a string or pattern across all files in the repository. Returns file paths, URLs, and text fragments for each match (up to 20 results). Uses GitHub code search syntax.

Error handling: all GitHub tools return structured JSON errors rather than throwing. Error shapes: {error:"github_pat_not_configured"} if PAT is missing; {error:"github_not_found", hint:...} on 404 (wrong SHA, path, or ref); {error:"github_auth_failed", hint:...} on 401/403; {error:"github_rate_limited", reset_at:<epoch>} on rate limit; {error:"github_unreachable", detail:...} on network failure. Check the error field before interpreting any response.

ACTIVE BRANCH: The primary development branch is 'partial-stack-execution'. P4, P5-0, and all recent TLS/executor/archive work lives there. When inspecting the latest code via github_get_file or github_search_code, use ref='partial-stack-execution'. The main branch is the stable release baseline — it does not contain P4+ work.`;


// ── Structured production view boundary ───────────────────────────────────────
// Legacy backends retain their status strings, but the composition root strips
// terminal escapes and delivers them as records. Nothing writes behind the TUI.
function stripTerminalEscapes(value) {
  return String(value ?? '').replace(/\x1b(?:\[[0-?]*[ -\/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, '');
}

function emitActivityLine(text, options = {}) {
  const runtime = _activeRuntime;
  if (!runtime || runtime.stopping) return null;
  return runtime.emitActivity({
    role: options.role || 'tool',
    kind: options.kind || 'operational-status',
    text: stripTerminalEscapes(text),
  });
}

function createStructuredChildActivityCapture(options = {}, emitLine = emitActivityLine) {
  const prefix = String(options.prefix || '');
  const suffix = String(options.suffix || '');
  const activityOptions = options.activityOptions || {};
  let pending = '';

  const emitCompleteLine = line => {
    const cleanLine = String(line).replace(/\r$/, '');
    if (!cleanLine.trim()) return;
    emitLine(`${prefix}${cleanLine}${suffix}`, activityOptions);
  };

  return {
    push(chunk) {
      pending += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk ?? '');
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) emitCompleteLine(line);
    },
    flush() {
      if (pending) emitCompleteLine(pending);
      pending = '';
    },
  };
}

function releaseOperationalChild(child) {
  _activeOperationalChildren.delete(child);
  const cleanup = _operationalChildCleanup.get(child);
  _operationalChildCleanup.delete(child);
  if (cleanup) {
    try { cleanup(); } catch (_) {}
  }
}

function trackOperationalChild(child, onStop = null) {
  if (!child || typeof child !== 'object') return child;
  _activeOperationalChildren.add(child);
  if (typeof onStop === 'function') _operationalChildCleanup.set(child, onStop);
  const release = () => releaseOperationalChild(child);
  child.once?.('close', release);
  child.once?.('error', release);
  return child;
}

function stopOperationalChildren() {
  let stopped = 0;
  for (const child of _activeOperationalChildren) {
    releaseOperationalChild(child);
    try { child.stdout?.removeAllListeners?.('data'); } catch (_) {}
    try { child.stderr?.removeAllListeners?.('data'); } catch (_) {}
    try {
      if (child.exitCode == null && child.signalCode == null) {
        child.kill?.('SIGKILL');
        stopped += 1;
      }
    } catch (_) {}
  }
  _activeOperationalChildren.clear();
  _operationalChildCleanup.clear();
  return stopped;
}

function refreshOperationalState() {
  if (!_activeRuntime || _activeRuntime.stopping) return null;
  return _activeRuntime.syncOperationalState();
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
      mvStr = mv.success
        ? ` | move:✓(${String(mv.direction || '?')})`
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

// ── Private helper: extract diagnostics summary from a /diagnostics/turn response ──
function _extractDiagSummary(turnData) {
  if (!turnData || typeof turnData !== 'object') return null;
  try {
    const as = turnData.authoritative_state || {};
    return {
      turn:                as.turn_counter          ?? null,
      site:                as.current_site          ?? null,
      site_name:           as.active_site_name      ?? null,
      current_depth:       as.current_depth         ?? null,
      localspace_position: as.local_space_position  ?? null,
      visible_npc_count:   as.visible_npc_count     ?? null,
      site_count:          as.site_count            ?? null,
      player_object_count: turnData.object_reality?.player?.length ?? null,
      stage_times:         turnData.stage_times     ?? null,
      rc_fired:            turnData.reality_check?.fired ?? null,
    };
  } catch (_e) {
    return null;
  }
}

// ── GitHub API error translator — maps Axios errors from GitHub REST calls to structured responses ──
function _githubApiError(err) {
  const s = err.response?.status;
  const h = err.response?.headers || {};
  if (!s)                                                    return { error: 'github_unreachable', detail: err.message };
  if (s === 401 || s === 403)                                return { error: 'github_auth_failed',   hint: 'Check GITHUB_PAT in .env' };
  if (s === 404)                                             return { error: 'github_not_found',     hint: 'SHA, path, or ref may be wrong or not yet pushed' };
  if (s === 422)                                             return { error: 'github_unprocessable', hint: 'Likely a malformed SHA or invalid ref' };
  if (s === 429 || h['x-ratelimit-remaining'] === '0') {
    const resetAt = h['x-ratelimit-reset'] ? parseInt(h['x-ratelimit-reset']) : null;
    return { error: 'github_rate_limited', reset_at: resetAt };
  }
  return { error: err.message, status: s, body: err.response?.data ?? null };
}

// ── Tool executor — called by Mother Brain during function-calling loop ────────
async function executeToolCall(name, args) {
  const HARNESS_TOOLS = ['harness_connect', 'harness_disconnect', 'harness_status', 'harness_list_scenarios', 'harness_run_scenario', 'harness_read_result'];
  // Source tools are session-independent (static file reads) — bypass the no_session_active guard
  const SESSION_FREE_TOOLS = [...HARNESS_TOOLS, 'get_source_slice', 'search_source', 'run_validation', 'create_scenario_file', 'create_probe_spec', 'read_probe_results', 'write_file', 'patch_file', 'start_game', 'end_game', 'update_investigation', 'attach_session', 'github_list_commits', 'github_get_commit', 'github_get_file', 'github_compare', 'github_search_code'];
  if (!_activeSessionId && !SESSION_FREE_TOOLS.includes(name)) {
    return JSON.stringify({ error: 'no_session_active' });
  }
  try {
    let url;
    if (name === 'get_turn_data') {
      const params = args.fields ? `?fields=${encodeURIComponent(args.fields)}` : '';
      url = `http://${HOST}:${PORT}/diagnostics/turn/${encodeURIComponent(_activeSessionId)}/${args.turn}${params}`;
    } else if (name === 'get_payload') {
      const qs = [];
      if (args.stage) qs.push(`stage=${encodeURIComponent(args.stage)}`);
      if (args.part)  qs.push(`part=${encodeURIComponent(args.part)}`);
      url = `http://${HOST}:${PORT}/diagnostics/payload/${encodeURIComponent(_activeSessionId)}/${args.turn}${qs.length ? '?' + qs.join('&') : ''}`;
    } else if (name === 'get_sites') {
      const qs = [];
      if (args.mx         !== undefined) qs.push(`mx=${encodeURIComponent(args.mx)}`);
      if (args.my         !== undefined) qs.push(`my=${encodeURIComponent(args.my)}`);
      if (args.radius     !== undefined) qs.push(`radius=${encodeURIComponent(args.radius)}`);
      if (args.filled_only !== undefined) qs.push(`filled_only=${encodeURIComponent(args.filled_only)}`);
      url = `http://${HOST}:${PORT}/diagnostics/sites-query${qs.length ? '?' + qs.join('&') : ''}`;
    } else if (name === 'inspect_active_site') {
      url = `http://${HOST}:${PORT}/diagnostics/sites`;
    } else if (name === 'get_site') {
      url = `http://${HOST}:${PORT}/diagnostics/site?site_id=${encodeURIComponent(args.site_id)}`;
    } else if (name === 'get_localspaces') {
      url = `http://${HOST}:${PORT}/diagnostics/localspaces?site_id=${encodeURIComponent(args.site_id)}`;
    } else if (name === 'get_localspace') {
      const qs = [`localspace_id=${encodeURIComponent(args.localspace_id)}`];
      if (args.site_id)      qs.push(`site_id=${encodeURIComponent(args.site_id)}`);
      if (args.include_grid) qs.push(`include_grid=true`);
      url = `http://${HOST}:${PORT}/diagnostics/localspace?${qs.join('&')}`;
    } else if (name === 'get_source_slice') {
      const qs = [`file=${encodeURIComponent(args.file)}`];
      if (args.from !== undefined) qs.push(`from=${encodeURIComponent(args.from)}`);
      if (args.to   !== undefined) qs.push(`to=${encodeURIComponent(args.to)}`);
      url = `http://${HOST}:${PORT}/diagnostics/source?${qs.join('&')}`;
      const diagKey = process.env.DIAGNOSTICS_KEY || '';
      const resp = await axios.get(url, { timeout: 10000, httpAgent: _toolHttpAgent, headers: { 'x-diagnostics-key': diagKey } });
      const raw  = JSON.stringify(resp.data);
      if (raw.length > DEFAULT_TOOL_RESULT_LIMIT) {
        return raw.slice(0, DEFAULT_TOOL_RESULT_LIMIT) + '\n[TRUNCATED — narrow the range with from= and to=]';
      }
      return raw;
    } else if (name === 'search_source') {
      const qs = [`query=${encodeURIComponent(args.query)}`];
      if (args.file !== undefined) qs.push(`file=${encodeURIComponent(args.file)}`);
      const searchUrl  = `http://${HOST}:${PORT}/diagnostics/source-search?${qs.join('&')}`;
      const searchKey  = process.env.DIAGNOSTICS_KEY || '';
      const searchResp = await axios.get(searchUrl, { timeout: 10000, httpAgent: _toolHttpAgent, headers: { 'x-diagnostics-key': searchKey } });
      const searchRaw  = JSON.stringify(searchResp.data);
      if (searchRaw.length > DEFAULT_TOOL_RESULT_LIMIT) {
        return searchRaw.slice(0, DEFAULT_TOOL_RESULT_LIMIT) + '\n[TRUNCATED — scope to a specific file with file= to reduce results]';
      }
      return searchRaw;
    } else if (name === 'query_objects') {
      // v1.84.54: Object registry query
      const qs = [`sessionId=${encodeURIComponent(_activeSessionId)}`];
      if (args.container_type !== undefined) qs.push(`container_type=${encodeURIComponent(args.container_type)}`);
      if (args.container_id   !== undefined) qs.push(`container_id=${encodeURIComponent(args.container_id)}`);
      if (args.status         !== undefined) qs.push(`status=${encodeURIComponent(args.status)}`);
      if (args.include_events !== undefined) qs.push(`include_events=${encodeURIComponent(args.include_events)}`);
      url = `http://${HOST}:${PORT}/diagnostics/objects?${qs.join('&')}`;
    } else if (name === 'inspect_entity') {
      // v1.84.54: Entity inspector
      const qs = [`sessionId=${encodeURIComponent(_activeSessionId)}`, `entity_type=${encodeURIComponent(args.entity_type)}`];
      if (args.entity_id !== undefined) qs.push(`entity_id=${encodeURIComponent(args.entity_id)}`);
      url = `http://${HOST}:${PORT}/diagnostics/entity?${qs.join('&')}`;
    } else if (name === 'trace_object') {
      // v1.84.54: Object lifecycle trace
      url = `http://${HOST}:${PORT}/diagnostics/objects/trace?sessionId=${encodeURIComponent(_activeSessionId)}&object_id=${encodeURIComponent(args.object_id)}`;
    } else if (name === 'harness_connect') {
      const diagKey = process.env.DIAGNOSTICS_KEY || '';
      try {
        const resp = await axios.get(`http://${HOST}:${PORT}/harness/status`, {
          timeout: 8000, httpAgent: _toolHttpAgent, headers: { 'x-diagnostics-key': diagKey }
        });
        _harnessAuthorized = true;
        refreshOperationalState();
        return JSON.stringify({ connected: true, status: resp.data });
      } catch (err) {
        return JSON.stringify({ connected: false, error: err.message });
      }
    } else if (name === 'harness_disconnect') {
      _harnessAuthorized = false;
      refreshOperationalState();
      return JSON.stringify({ disconnected: true });
    } else if (name === 'harness_status') {
      if (!_harnessAuthorized) return JSON.stringify({ error: 'Harness not connected. Ask the developer to connect first (harness_connect).' });
      const diagKey = process.env.DIAGNOSTICS_KEY || '';
      const resp = await axios.get(`http://${HOST}:${PORT}/harness/status`, { timeout: 8000, httpAgent: _toolHttpAgent, headers: { 'x-diagnostics-key': diagKey } });
      return JSON.stringify(resp.data);
    } else if (name === 'harness_list_scenarios') {
      if (!_harnessAuthorized) return JSON.stringify({ error: 'Harness not connected. Ask the developer to connect first (harness_connect).' });
      const diagKey = process.env.DIAGNOSTICS_KEY || '';
      const resp = await axios.get(`http://${HOST}:${PORT}/harness/scenarios`, { timeout: 15000, httpAgent: _toolHttpAgent, headers: { 'x-diagnostics-key': diagKey } });
      return JSON.stringify(resp.data);
    } else if (name === 'harness_run_scenario') {
      if (!_harnessAuthorized) return JSON.stringify({ error: 'Harness not connected. Ask the developer to connect first (harness_connect).' });
      const diagKey = process.env.DIAGNOSTICS_KEY || '';
      const body    = { scenario: args.scenario };
      if (args.runs !== undefined) body.runs = args.runs;
      const resp = await axios.post(`http://${HOST}:${PORT}/harness/run`, body, { timeout: 10000, httpAgent: _toolHttpAgent, headers: { 'x-diagnostics-key': diagKey, 'content-type': 'application/json' } });
      const raw = JSON.stringify(resp.data);
      if (raw.length > DEFAULT_TOOL_RESULT_LIMIT) return raw.slice(0, DEFAULT_TOOL_RESULT_LIMIT) + '\n[TRUNCATED]';
      return raw;
    } else if (name === 'harness_read_result') {
      if (!_harnessAuthorized) return JSON.stringify({ error: 'Harness not connected. Ask the developer to connect first (harness_connect).' });
      const diagKey = process.env.DIAGNOSTICS_KEY || '';
      const resp = await axios.get(`http://${HOST}:${PORT}/harness/result/last`, { timeout: 8000, httpAgent: _toolHttpAgent, headers: { 'x-diagnostics-key': diagKey } });
      const raw = JSON.stringify(resp.data);
      if (raw.length > DEFAULT_TOOL_RESULT_LIMIT) return raw.slice(0, DEFAULT_TOOL_RESULT_LIMIT) + '\n[TRUNCATED]';
      return raw;
    } else if (name === 'run_validation') {
      const _taskMap = {
        node_check_index:                       'node --check index.js',
        node_check_harness:                     'node --check test-harness.js',
        node_check_mother:                      'node --check motherbrain.js',
        harness_reality_check_basic:            'node test-harness.js --scenario reality_check_basic --yes',
        harness_arbiter_basic:                  'node test-harness.js --scenario arbiter_basic --yes',
        harness_founding_premise_correctness:   'node test-harness.js --scenario founding_premise_correctness --yes',
        harness_site_entry_basic:               'node test-harness.js --scenario site_entry_basic --yes',
        harness_sweep_a:                        'node test-harness.js --sweep A --yes',
        probe_worldgen_sites_10:                'node scripts/probe-runner.js --spec tests/probes/worldgen-sites.probe.json --runs 10',
        probe_worldgen_sites_50:                'node scripts/probe-runner.js --spec tests/probes/worldgen-sites.probe.json --runs 50',
        run_probe_localspace:                   'node scripts/probe-runner.js --spec tests/probes/localspace-distribution.probe.json --runs 5',
        node_check_semantic_normalizer:         'node --check SemanticNormalizer.js',           // v1.88.78: TSL Stage 1
        node_check_object_operation_resolver:   'node --check ObjectOperationResolver.js',      // v1.91.55: P1a resolver
      };
      const _timeoutMap = {
        node_check_index:                       15000,
        node_check_harness:                     15000,
        node_check_mother:                      15000,
        harness_reality_check_basic:            90000,
        harness_arbiter_basic:                  90000,
        harness_founding_premise_correctness:   90000,
        harness_site_entry_basic:               90000,
        harness_sweep_a:                        300000,
        probe_worldgen_sites_10:                600000,
        probe_worldgen_sites_50:                2400000,
        run_probe_localspace:                   600000,
        node_check_semantic_normalizer:         15000,
        node_check_object_operation_resolver:   15000,
      };
      const _task = args.task || '';
      // run_probe: dynamic path — validate spec_path, load spec for timeout, build command
      if (_task === 'run_probe') {
        const _specPath = (args.spec_path || '').trim();
        if (!_specPath) return JSON.stringify({ error: 'run_probe requires spec_path parameter' });
        if (_specPath.includes('..') || !/^[a-z0-9_\-\/\.]+\.probe\.json$/i.test(_specPath)) {
          return JSON.stringify({ error: 'invalid_spec_path', detail: 'Path must be relative, no .., must end in .probe.json' });
        }
        const _specFull = require('path').join('c:\\Users\\daddy\\Desktop\\Game-main', _specPath);
        let _probeSpec = {};
        try { _probeSpec = JSON.parse(require('fs').readFileSync(_specFull, 'utf8')); } catch (_e) {
          return JSON.stringify({ error: 'spec_read_failed', detail: _e.message });
        }
        const _probeRuns = parseInt(args.runs, 10) || 10;
        const _perRunMs  = (_probeSpec.expected_runtime_ms_per_run || 120000);
        const _probeTimeout = Math.min(_probeRuns * _perRunMs, 3600000);
        const _probeCmd = `node scripts/probe-runner.js --spec "${_specPath}" --runs ${_probeRuns}`;
        emitActivityLine(`${DIM}[run_validation] ${_probeCmd}${R}`);
        const { spawn } = require('child_process');
        return await new Promise((resolve) => {
          let _stdout = '', _stderr = '', _timedOut = false;
          let _timer = null;
          const _child = trackOperationalChild(
            spawn(_probeCmd, { cwd: 'c:\\Users\\daddy\\Desktop\\Game-main', shell: true, env: { ...process.env } }),
            () => { if (_timer) clearTimeout(_timer); }
          );
          const _stdoutActivity = createStructuredChildActivityCapture({ prefix: `${DIM}  `, suffix: R });
          const _stderrActivity = createStructuredChildActivityCapture({ prefix: `${DIM}  [stderr] `, suffix: R, activityOptions: { role: 'warning' } });
          _timer = setTimeout(() => { _timedOut = true; _child.kill('SIGKILL'); }, _probeTimeout);
          _child.stdout.on('data', (chunk) => { const _t = chunk.toString(); _stdout += _t; _stdoutActivity.push(_t); });
          _child.stderr.on('data', (chunk) => { const _t = chunk.toString(); _stderr += _t; _stderrActivity.push(_t); });
          _child.on('close', (code) => { clearTimeout(_timer); _stdoutActivity.flush(); _stderrActivity.flush(); resolve(JSON.stringify({ task: 'run_probe', spec_path: _specPath, runs: _probeRuns, stdout: _stdout, stderr: _timedOut ? 'ETIMEDOUT' : _stderr, exit_code: _timedOut ? 1 : (code ?? 0) })); });
          _child.on('error', (err) => { clearTimeout(_timer); _stdoutActivity.flush(); _stderrActivity.flush(); resolve(JSON.stringify({ task: 'run_probe', spec_path: _specPath, stdout: _stdout, stderr: err.message, exit_code: 1 })); });
        });
      }
      // run_node_script: run a scripts/*.js|cjs|mjs file Mother has written
      if (_task === 'run_node_script') {
        const _scriptPath = (args.script_path || '').trim();
        if (!_scriptPath) return JSON.stringify({ error: 'run_node_script requires script_path parameter' });
        if (_scriptPath.includes('..') || !/^scripts\/[a-z0-9_\-\.]+\.(js|cjs|mjs)$/i.test(_scriptPath)) {
          return JSON.stringify({ error: 'invalid_script_path', detail: 'Path must be scripts/<name>.js|cjs|mjs, relative, no ..' });
        }
        const _scriptCmd = `node "${_scriptPath}"`;
        emitActivityLine(`${DIM}[run_validation] ${_scriptCmd}${R}`);
        const { spawn: _spawnScript } = require('child_process');
        return await new Promise((resolve) => {
          let _stdout = '', _stderr = '', _timedOut = false;
          let _timer = null;
          const _child = trackOperationalChild(
            _spawnScript(_scriptCmd, { cwd: 'c:\\Users\\daddy\\Desktop\\Game-main', shell: true, env: { ...process.env } }),
            () => { if (_timer) clearTimeout(_timer); }
          );
          const _stdoutActivity = createStructuredChildActivityCapture({ prefix: `${DIM}  `, suffix: R });
          const _stderrActivity = createStructuredChildActivityCapture({ prefix: `${DIM}  [stderr] `, suffix: R, activityOptions: { role: 'warning' } });
          _timer = setTimeout(() => { _timedOut = true; _child.kill('SIGKILL'); }, 30000);
          _child.stdout.on('data', (chunk) => { const _t = chunk.toString(); _stdout += _t; _stdoutActivity.push(_t); });
          _child.stderr.on('data', (chunk) => { const _t = chunk.toString(); _stderr += _t; _stderrActivity.push(_t); });
          _child.on('close', (code) => { clearTimeout(_timer); _stdoutActivity.flush(); _stderrActivity.flush(); resolve(JSON.stringify({ task: 'run_node_script', script_path: _scriptPath, stdout: _stdout, stderr: _timedOut ? 'ETIMEDOUT' : _stderr, exit_code: _timedOut ? 1 : (code ?? 0) })); });
          _child.on('error', (err) => { clearTimeout(_timer); _stdoutActivity.flush(); _stderrActivity.flush(); resolve(JSON.stringify({ task: 'run_node_script', script_path: _scriptPath, stdout: _stdout, stderr: err.message, exit_code: 1 })); });
        });
      }
      if (!_taskMap[_task]) return JSON.stringify({ error: 'unknown_task', valid_tasks: Object.keys(_taskMap) });
      const _cmd = _taskMap[_task];
      const _timeout = _timeoutMap[_task] || 120000;
      const { spawn } = require('child_process');
      emitActivityLine(`${DIM}[run_validation] ${_cmd}${R}`);
      return await new Promise((resolve) => {
        let _stdout = '';
        let _stderr = '';
        let _timedOut = false;
        let _timer = null;
        // Pass full command string directly — no split/args array — avoids DEP0190 and shell injection surface
        const _child = trackOperationalChild(
          spawn(_cmd, {
            cwd: 'c:\\Users\\daddy\\Desktop\\Game-main',
            shell: true,
            env: { ...process.env },
          }),
          () => { if (_timer) clearTimeout(_timer); }
        );
        const _stdoutActivity = createStructuredChildActivityCapture({ prefix: `${DIM}  `, suffix: R });
        const _stderrActivity = createStructuredChildActivityCapture({ prefix: `${DIM}  [stderr] `, suffix: R, activityOptions: { role: 'warning' } });
        _timer = setTimeout(() => {
          _timedOut = true;
          _child.kill('SIGKILL');
        }, _timeout);
        _child.stdout.on('data', (chunk) => {
          const _text = chunk.toString();
          _stdout += _text;
          _stdoutActivity.push(_text);
        });
        _child.stderr.on('data', (chunk) => {
          const _text = chunk.toString();
          _stderr += _text;
          _stderrActivity.push(_text);
        });
        _child.on('close', (code) => {
          clearTimeout(_timer);
          _stdoutActivity.flush();
          _stderrActivity.flush();
          if (_timedOut) {
            resolve(JSON.stringify({ task: _task, command: _cmd, stdout: _stdout, stderr: 'ETIMEDOUT', exit_code: 1 }));
          } else {
            resolve(JSON.stringify({ task: _task, command: _cmd, stdout: _stdout, stderr: _stderr, exit_code: code ?? 0 }));
          }
        });
        _child.on('error', (err) => {
          clearTimeout(_timer);
          _stdoutActivity.flush();
          _stderrActivity.flush();
          resolve(JSON.stringify({ task: _task, command: _cmd, stdout: _stdout, stderr: err.message, exit_code: 1 }));
        });
      });
    } else if (name === 'create_scenario_file') {
      const _fs   = require('fs');
      const _path = require('path');
      const _SCENARIOS_DIR = _path.join('c:\\Users\\daddy\\Desktop\\Game-main', 'tests', 'scenarios');
      const VALID_CATEGORIES = ['worldgen_seeded','exploratory','ontology_stress','parser_fuzz','narrative_continuity','authority_test'];

      // --- filename validation ---
      let _filename = (args.filename || '').replace(/\.json$/i, '');
      if (!_filename || _filename.length > 80 || !/^[a-z0-9_-]+$/i.test(_filename) || _filename.includes('/') || _filename.includes('\\') || _filename.includes('..')) {
        return JSON.stringify({ error: 'invalid_filename', detail: 'Filename must be alphanumeric/underscore/hyphen only, no path separators or .., max 80 chars.' });
      }
      const _filePath = _path.join(_SCENARIOS_DIR, _filename + '.json');

      // --- no overwrite ---
      if (_fs.existsSync(_filePath)) {
        return JSON.stringify({ error: 'file_exists', path: _filePath, detail: 'File already exists. Revisions require a new filename; humans consolidate.' });
      }

      // --- scenario extraction ---
      let _sc = args.scenario;
      if (typeof _sc === 'string') { try { _sc = JSON.parse(_sc); } catch (_) {} }  // v6.0.8: DeepSeek double-encoding guard — mirrors create_probe_spec fix (v6.0.4)
      if (!_sc || typeof _sc !== 'object') return JSON.stringify({ error: 'invalid_scenario', detail: 'scenario must be an object.' });
      if (!_sc.name || typeof _sc.name !== 'string' || !_sc.name.trim()) return JSON.stringify({ error: 'invalid_scenario', detail: 'scenario.name must be a non-empty string.' });
      if (!Array.isArray(_sc.turns) || _sc.turns.length < 1) return JSON.stringify({ error: 'invalid_scenario', detail: 'scenario.turns must be an array with at least 1 turn.' });
      for (let _ti = 0; _ti < _sc.turns.length; _ti++) {
        const _t = _sc.turns[_ti];
        if (typeof _t.action !== 'string') return JSON.stringify({ error: 'invalid_scenario', detail: `turns[${_ti}].action must be a string.` });
        if (!Array.isArray(_t.assert) || _t.assert.length < 1) return JSON.stringify({ error: 'invalid_scenario', detail: `turns[${_ti}].assert must be a non-empty array.` });
        for (let _ai = 0; _ai < _t.assert.length; _ai++) {
          if (!_t.assert[_ai].op || typeof _t.assert[_ai].op !== 'string') return JSON.stringify({ error: 'invalid_scenario', detail: `turns[${_ti}].assert[${_ai}] must have a non-empty op field.` });
        }
      }

      // --- category validation ---
      if (_sc.category !== undefined && !VALID_CATEGORIES.includes(_sc.category)) {
        return JSON.stringify({ error: 'invalid_category', detail: `category must be one of: ${VALID_CATEGORIES.join(', ')}`, valid_categories: VALID_CATEGORIES });
      }

      // --- name conflict ---
      let _existingFiles = [];
      try { _existingFiles = _fs.readdirSync(_SCENARIOS_DIR).filter(f => f.endsWith('.json')); } catch(_e) {}
      for (const _ef of _existingFiles) {
        try {
          const _existing = JSON.parse(_fs.readFileSync(_path.join(_SCENARIOS_DIR, _ef), 'utf8'));
          if (_existing.name === _sc.name) return JSON.stringify({ error: 'name_conflict', detail: `scenario.name "${_sc.name}" already used by existing file.`, existing_file: _ef });
        } catch (_e) {}
      }

      // --- signal quality warnings (soft) ---
      const _warnings = [];
      const _allOps = _sc.turns.flatMap(t => (t.assert || []).map(a => a.op));
      const _allNoError = _allOps.length > 0 && _allOps.every(op => op === 'no_error');
      if (_allNoError) _warnings.push('low_signal: all assertions are no_error only — test may not catch real regressions');
      for (const _t of _sc.turns) {
        const _serialized = (_t.assert || []).map(a => JSON.stringify(a));
        const _seen = new Set();
        for (const _s of _serialized) {
          if (_seen.has(_s)) { _warnings.push(`duplicate_assertion in turn "${_t.label || '(unlabeled)'}" — same assertion object appears more than once`); break; }
          _seen.add(_s);
        }
      }

      // --- stability enforcement ---
      const _requestedStability = _sc.stability ?? null;
      const _stabilityForced = _sc.stability !== 'probe';
      const _scToWrite = { ..._sc, stability: 'probe' };

      // --- write ---
      try {
        _fs.writeFileSync(_filePath, JSON.stringify(_scToWrite, null, 2), 'utf8');
      } catch (_werr) {
        return JSON.stringify({ error: 'write_error', detail: _werr.message });
      }

      return JSON.stringify({
        written: true,
        path: _filePath,
        filename: _filename + '.json',
        requested_stability: _requestedStability,
        written_stability: 'probe',
        stability_forced: _stabilityForced,
        category: _sc.category ?? null,
        turns_count: _sc.turns.length,
        warnings: _warnings
      });
    } else if (name === 'create_probe_spec') {
      const _fs   = require('fs');
      const _path = require('path');
      const { METRIC_NAMES: _MN, METRIC_CONFIG_REQUIREMENTS: _MCR } = require('./scripts/probe-metrics');
      const _PROBES_DIR = _path.join('c:\\Users\\daddy\\Desktop\\Game-main', 'tests', 'probes');
      const _SUPPORTED_LIFECYCLES = ['session_per_run'];

      // --- filename validation ---
      let _pfn = (args.filename || '').replace(/\.probe\.json$/i, '').replace(/\.json$/i, '');
      if (!_pfn || _pfn.length > 80 || !/^[a-z0-9_-]+$/i.test(_pfn) || _pfn.includes('/') || _pfn.includes('\\') || _pfn.includes('..')) {
        return JSON.stringify({ error: 'invalid_filename', detail: 'Filename must be alphanumeric/underscore/hyphen only, no path separators or .., max 80 chars.' });
      }
      const _pfPath = _path.join(_PROBES_DIR, _pfn + '.probe.json');

      // --- no overwrite ---
      if (_fs.existsSync(_pfPath)) {
        return JSON.stringify({ error: 'file_exists', path: _pfPath, detail: 'File already exists. Use a new filename; humans consolidate.' });
      }

      // --- spec extraction ---
      let _sp = args.spec;
      if (typeof _sp === 'string') { try { _sp = JSON.parse(_sp); } catch (_) {} }
      if (!_sp || typeof _sp !== 'object') return JSON.stringify({ error: 'invalid_spec', detail: 'spec must be an object.' });

      // --- required fields ---
      const _reqFields = ['name', 'endpoint', 'method', 'extract', 'request_lifecycle', 'metrics'];
      for (const _rf of _reqFields) {
        if (!_sp[_rf]) return JSON.stringify({ error: 'missing_required_field', field: _rf });
      }
      if (!_SUPPORTED_LIFECYCLES.includes(_sp.request_lifecycle)) {
        return JSON.stringify({ error: 'unsupported_request_lifecycle', value: _sp.request_lifecycle, supported: _SUPPORTED_LIFECYCLES });
      }
      if (!Array.isArray(_sp.metrics) || _sp.metrics.length === 0) {
        return JSON.stringify({ error: 'invalid_metrics', detail: 'metrics must be a non-empty array.' });
      }

      // --- metric enum + config requirement validation ---
      for (const _m of _sp.metrics) {
        if (!_MN.includes(_m)) {
          return JSON.stringify({ error: 'unknown_metric', metric: _m, known_metrics: _MN });
        }
        const _required = _MCR[_m] || [];
        for (const _dotPath of _required) {
          // dot-path traversal
          const _val = _dotPath.split('.').reduce((cur, k) => (cur != null ? cur[k] : undefined), _sp);
          if (_val == null) {
            return JSON.stringify({ error: 'missing_metric_config', metric: _m, required: _dotPath, detail: `Metric "${_m}" requires spec field "${_dotPath}"` });
          }
        }
      }

      // --- warnings key validation ---
      if (_sp.warnings) {
        for (const _wk of Object.keys(_sp.warnings)) {
          if (!_MN.includes(_wk)) {
            return JSON.stringify({ error: 'unknown_metric_in_warnings', metric: _wk, detail: `warnings references unknown metric "${_wk}"` });
          }
        }
      }

      // --- ensure probes dir exists ---
      try { if (!_fs.existsSync(_PROBES_DIR)) _fs.mkdirSync(_PROBES_DIR, { recursive: true }); } catch (_e) {}

      // --- write ---
      try {
        _fs.writeFileSync(_pfPath, JSON.stringify(_sp, null, 2), 'utf8');
      } catch (_werr) {
        return JSON.stringify({ error: 'write_error', detail: _werr.message });
      }

      return JSON.stringify({
        written: true,
        path: _pfPath,
        filename: _pfn + '.probe.json',
        metrics_count: _sp.metrics.length,
        request_lifecycle: _sp.request_lifecycle
      });
    } else if (name === 'read_probe_results') {
      const _prDir = path.resolve(process.cwd(), 'tests', 'probe-results');
      if (!args.folder) {
        // List available result folders sorted newest-first
        let _entries;
        try {
          _entries = fs.readdirSync(_prDir).filter(f => {
            try { return fs.statSync(path.join(_prDir, f)).isDirectory(); } catch { return false; }
          }).sort().reverse();
        } catch (e) {
          return JSON.stringify({ error: 'probe_results_dir_unreadable', detail: e.message, path: _prDir });
        }
        return JSON.stringify({ available_folders: _entries, count: _entries.length, path: _prDir });
      }
      // Path traversal guard
      const _targetDir  = path.resolve(_prDir, args.folder);
      if (!_targetDir.startsWith(_prDir + path.sep) && _targetDir !== _prDir) {
        return JSON.stringify({ error: 'invalid_folder', detail: 'Folder must be a direct subfolder of tests/probe-results/' });
      }
      const _file = args.file || 'summary.json';
      const _filePath = path.join(_targetDir, _file);
      let _content;
      try { _content = fs.readFileSync(_filePath, 'utf8'); } catch (e) {
        return JSON.stringify({ error: 'file_not_found', path: _filePath, detail: e.message });
      }
      // For runs.jsonl: paginate by line to avoid truncation on large jobs
      if (_file === 'runs.jsonl') {
        const _lines    = _content.split('\n').filter(l => l.trim() !== '');
        const _total    = _lines.length;
        const _fromLine = Math.max(1, parseInt(args.from_line, 10) || 1);
        const _toLine   = Math.min(_total, parseInt(args.to_line, 10) || Math.min(_total, 50));
        const _page     = _lines.slice(_fromLine - 1, _toLine).join('\n');
        const _header   = `[runs.jsonl: showing rows ${_fromLine}–${_toLine} of ${_total} total]\n`;
        const _out      = _header + _page;
        return _out.length > 60000 ? _out.slice(0, 60000) + '\n[TRUNCATED — use narrower from_line/to_line range]' : _out;
      }
      try {
        const _parsed = JSON.parse(_content);
        const _raw = JSON.stringify(_parsed, null, 2);
        if (_raw.length > DEFAULT_TOOL_RESULT_LIMIT) return _raw.slice(0, DEFAULT_TOOL_RESULT_LIMIT) + '\n[TRUNCATED]';
        return _raw;
      } catch {
        return _content.slice(0, DEFAULT_TOOL_RESULT_LIMIT);
      }
    } else if (name === 'write_file') {
      const _fs   = require('fs');
      const _path = require('path');
      const _wfRoot = 'c:\\Users\\daddy\\Desktop\\Game-main';
      const _wfRel  = (args.path || '').trim();
      if (!_wfRel) return JSON.stringify({ error: 'invalid_path', detail: 'path must be non-empty.' });
      if (_wfRel.includes('..')) return JSON.stringify({ error: 'invalid_path', detail: 'Path must not contain ..' });
      const _wfAbs = _path.resolve(_wfRoot, _wfRel);
      if (!_wfAbs.startsWith(_wfRoot + _path.sep) && _wfAbs !== _wfRoot) {
        return JSON.stringify({ error: 'invalid_path', detail: 'Path must be within the Game-main directory.' });
      }
      if (_fs.existsSync(_wfAbs) && !args.overwrite) {
        return JSON.stringify({ error: 'file_exists', path: _wfAbs, detail: 'File already exists. Pass overwrite:true to overwrite, or use patch_file for targeted edits to existing files.' });
      }
      if (typeof args.content !== 'string') return JSON.stringify({ error: 'invalid_content', detail: 'content must be a string.' });
      try {
        const _wfDir = _path.dirname(_wfAbs);
        if (!_fs.existsSync(_wfDir)) _fs.mkdirSync(_wfDir, { recursive: true });
        _fs.writeFileSync(_wfAbs, args.content, 'utf8');
      } catch (_werr) {
        return JSON.stringify({ error: 'write_error', detail: _werr.message });
      }
      return JSON.stringify({ written: true, path: _wfAbs, bytes: Buffer.byteLength(args.content, 'utf8') });
    } else if (name === 'patch_file') {
      const _fs   = require('fs');
      const _path = require('path');
      const _pfRoot = 'c:\\Users\\daddy\\Desktop\\Game-main';
      const _pfRel  = (args.path || '').trim();
      if (!_pfRel) return JSON.stringify({ error: 'invalid_path', detail: 'path must be non-empty.' });
      if (_pfRel.includes('..')) return JSON.stringify({ error: 'invalid_path', detail: 'Path must not contain ..' });
      const _pfAbs = _path.resolve(_pfRoot, _pfRel);
      if (!_pfAbs.startsWith(_pfRoot + _path.sep) && _pfAbs !== _pfRoot) {
        return JSON.stringify({ error: 'invalid_path', detail: 'Path must be within the Game-main directory.' });
      }
      if (!_fs.existsSync(_pfAbs)) return JSON.stringify({ error: 'file_not_found', path: _pfAbs });
      const _oldStr = args.old_string;
      const _newStr = args.new_string ?? '';
      if (typeof _oldStr !== 'string' || _oldStr.length === 0) {
        return JSON.stringify({ error: 'invalid_old_string', detail: 'old_string must be a non-empty string.' });
      }
      let _pfSrc;
      try { _pfSrc = _fs.readFileSync(_pfAbs, 'utf8'); } catch (_rerr) {
        return JSON.stringify({ error: 'read_error', detail: _rerr.message });
      }
      let _matchCount = 0;
      let _scanIdx = _pfSrc.indexOf(_oldStr);
      while (_scanIdx !== -1) { _matchCount++; _scanIdx = _pfSrc.indexOf(_oldStr, _scanIdx + 1); }
      if (_matchCount === 0) {
        return JSON.stringify({ error: 'old_string_not_found', path: _pfAbs, detail: 'old_string does not match any text in the file. Re-read with get_source_slice and verify whitespace and indentation.' });
      }
      if (_matchCount > 1 && !args.allow_multiple) {
        return JSON.stringify({ error: 'ambiguous_match', path: _pfAbs, occurrences: _matchCount, detail: `old_string matches ${_matchCount} locations. Add more surrounding context to make it unique, or pass allow_multiple:true to replace all occurrences.` });
      }
      let _pfPatched;
      if (args.allow_multiple) {
        _pfPatched = _pfSrc.split(_oldStr).join(_newStr);
      } else {
        const _pfIdx = _pfSrc.indexOf(_oldStr);
        _pfPatched = _pfSrc.slice(0, _pfIdx) + _newStr + _pfSrc.slice(_pfIdx + _oldStr.length);
      }
      try { _fs.writeFileSync(_pfAbs, _pfPatched, 'utf8'); } catch (_werr) {
        return JSON.stringify({ error: 'write_error', detail: _werr.message });
      }
      return JSON.stringify({ patched: true, path: _pfAbs, replacements: _matchCount, original_bytes: Buffer.byteLength(_pfSrc, 'utf8'), new_bytes: Buffer.byteLength(_pfPatched, 'utf8') });
    } else if (name === 'attach_session') {
      // v6.0.5: Attach to an existing live session (browser or otherwise) without starting a new one
      // v6.0.7: Auto-detect picks the session with the most turns to avoid attaching to a probe/harness
      //         session that happened to POST /narrate more recently than the real game session.
      if (args.session_id) {
        _activeSessionId = args.session_id;
        emitActivityLine(`${DIM}[attach_session] Attached to session (manual)${R}`);
        refreshOperationalState();
        return JSON.stringify({ ok: true, session_id: args.session_id, source: 'manual', hint: 'All diagnostic tools now active against this session.' });
      }
      const _asResp = await axios.get(`http://${HOST}:${PORT}/diagnostics/session`, { timeout: 5000, httpAgent: _toolHttpAgent });
      // sessions[] is sorted by total_turns desc — pick the one with most turns (skipping 0-turn sessions)
      const _asSessions = Array.isArray(_asResp.data.sessions) ? _asResp.data.sessions : null;
      const _asBest = _asSessions?.find(s => s.total_turns > 0) ?? null;
      const _asPickedId = _asBest?.session_id ?? _asResp.data.sessionId ?? null;
      if (!_asPickedId) {
        return JSON.stringify({ error: 'no_active_session', hint: 'No session has run since server start. Use start_game to create one.' });
      }
      _activeSessionId = _asPickedId;
      emitActivityLine(`${DIM}[attach_session] Attached to session (auto-detect, ${_asBest ? _asBest.total_turns + ' turns' : 'last-seen'})${R}`);
      refreshOperationalState();
      return JSON.stringify({ ok: true, session_id: _activeSessionId, total_turns: _asBest?.total_turns ?? _asResp.data.lastTurn, source: 'auto_detect', sessions: _asSessions, hint: 'All diagnostic tools now active. Use get_turn_data({turn:N}) to inspect any turn.' });
    } else if (name === 'start_game') {
      // v6.0.0: Autonomous gameplay — start a new game session (T1 founding premise)
      if (_activeSessionId && args.force !== true) {
        return JSON.stringify({ error: 'session_already_active', hint: 'Pass force:true to auto-end the existing session first.' });
      }
      if (_activeSessionId && args.force === true) {
        try {
          await axios.delete(`http://${HOST}:${PORT}/session`, { headers: { 'x-session-id': _activeSessionId }, timeout: 10000, httpAgent: _toolHttpAgent });
        } catch (_delErr) { /* swallow — proceed to new session regardless */ }
        _activeSessionId = null;
        _activeGameplayInvestigation = null;
        refreshOperationalState();
      }
      const _sgBody = { action: args.founding_premise, intent_channel: 'do' };
      if (args.world_seed !== undefined) _sgBody.WORLD_SEED = args.world_seed;
      const _sgResp = await axios.post(`http://${HOST}:${PORT}/narrate`, _sgBody, {
        timeout: 120000, httpAgent: _toolHttpAgent, headers: { 'content-type': 'application/json', 'x-mother-brain': 'true' }
      });
      _activeSessionId = _sgResp.data.sessionId || null;
      _activeGameplayInvestigation = {
        goal:                 args.goal               || null,
        hypothesis:           args.hypothesis         || null,
        expected_invariant:   args.expected_invariant || null,
        status:               'investigating',
        conclusion:           null,
        started_at_game_turn: null,
        turns_taken:          0,
        recent_actions:       [],
      };
      emitActivityLine(`${DIM}[start_game] Session active${R}`);
      refreshOperationalState();
      let _sgDiag = null;
      try {
        const _sgTurn = await axios.get(`http://${HOST}:${PORT}/diagnostics/turn/${encodeURIComponent(_activeSessionId)}/1`, { timeout: 10000, httpAgent: _toolHttpAgent });
        _sgDiag = _extractDiagSummary(_sgTurn.data);
        if (_sgDiag && _sgDiag.turn !== null) _activeGameplayInvestigation.started_at_game_turn = _sgDiag.turn;
      } catch (_diagErr) { /* diagnostics unavailable — proceed without */ }
      const _sgNarrative = (_sgResp.data.narrative || _sgResp.data.narration || '').slice(0, 2000);
      return JSON.stringify({ ok: true, session_active: true, narrative: _sgNarrative, diagnostics: _sgDiag, investigation: { ..._activeGameplayInvestigation }, hint: 'Full turn data available via get_turn_data({ turn: 1 })' });
    } else if (name === 'take_turn') {
      // v6.0.0: Autonomous gameplay — submit a player action to the active session
      if (!_activeSessionId) {
        return JSON.stringify({ error: 'no_active_session', hint: 'Call start_game first.' });
      }
      const _ttBody = { action: args.action, intent_channel: args.intent_channel || 'do' };
      const _ttResp = await axios.post(`http://${HOST}:${PORT}/narrate`, _ttBody, {
        timeout: 60000, httpAgent: _toolHttpAgent,
        headers: { 'content-type': 'application/json', 'x-session-id': _activeSessionId }
      });
      const _ttTurnNum = _ttResp.data.state?.turn_counter || _ttResp.data.turn_counter || null;
      let _ttDiag = null;
      if (_ttTurnNum !== null) {
        try {
          const _ttTurnResp = await axios.get(`http://${HOST}:${PORT}/diagnostics/turn/${encodeURIComponent(_activeSessionId)}/${_ttTurnNum}`, { timeout: 10000, httpAgent: _toolHttpAgent });
          _ttDiag = _extractDiagSummary(_ttTurnResp.data);
        } catch (_diagErr) { /* diagnostics unavailable — proceed without */ }
      }
      if (_activeGameplayInvestigation) {
        _activeGameplayInvestigation.turns_taken++;
        _activeGameplayInvestigation.recent_actions.push({ turn: _ttTurnNum, action: args.action });
        if (_activeGameplayInvestigation.recent_actions.length > 5) _activeGameplayInvestigation.recent_actions.shift();
      }
      const _ttNarrative = (_ttResp.data.narrative || _ttResp.data.narration || '').slice(0, 2000);
      return JSON.stringify({ ok: true, turn: _ttTurnNum, narrative: _ttNarrative, diagnostics: _ttDiag, investigation: _activeGameplayInvestigation ? { ..._activeGameplayInvestigation } : null, hint: `Full turn data available via get_turn_data({ turn: ${_ttTurnNum} })` });
    } else if (name === 'update_investigation') {
      // v6.0.0: Local-only — update investigation status/conclusion, no HTTP call
      if (!_activeGameplayInvestigation) {
        return JSON.stringify({ error: 'no_active_investigation', hint: 'Call start_game first.' });
      }
      const _validStatuses = ['investigating', 'likely_confirmed', 'contradicted', 'inconclusive', 'reproduced', 'non_reproducible'];
      if (!_validStatuses.includes(args.status)) {
        return JSON.stringify({ error: 'invalid_status', valid: _validStatuses });
      }
      _activeGameplayInvestigation.status = args.status;
      if (args.conclusion !== undefined) _activeGameplayInvestigation.conclusion = args.conclusion;
      return JSON.stringify({ ok: true, investigation: { ..._activeGameplayInvestigation } });
    } else if (name === 'end_game') {
      // v6.0.0: Autonomous gameplay — delete active session and clear investigation context
      if (!_activeSessionId) {
        return JSON.stringify({ error: 'no_active_session' });
      }
      try {
        await axios.delete(`http://${HOST}:${PORT}/session`, { headers: { 'x-session-id': _activeSessionId }, timeout: 10000, httpAgent: _toolHttpAgent });
      } catch (_egErr) { /* swallow — clear state regardless */ }
      _activeSessionId = null;
      _activeGameplayInvestigation = null;
      emitActivityLine(`${DIM}[end_game] Session ended${R}`);
      refreshOperationalState();
      return JSON.stringify({ ok: true, session_ended: true });
    } else if (name === 'list_npcs') {
      const listUrl  = `http://${HOST}:${PORT}/diagnostics/npcs`;
      const listKey  = process.env.DIAGNOSTICS_KEY || '';
      const listResp = await axios.get(listUrl, { timeout: 10000, httpAgent: _toolHttpAgent, headers: { 'x-diagnostics-key': listKey } });
      const listRaw  = JSON.stringify(listResp.data);
      if (listRaw.length > 16000) {
        return listRaw.slice(0, 16000) + '\n[TRUNCATED]';
      }
      return listRaw;
    } else if (name === 'github_list_commits') {
      if (!GITHUB_PAT) return JSON.stringify({ error: 'github_pat_not_configured', hint: 'Add GITHUB_PAT to .env in the Game-main directory.' });
      const _ghCount = Math.min(Math.max(parseInt(args.count) || 10, 1), 50);
      const _ghUrl   = `https://api.github.com/repos/mdunham726-coder/Game-main/commits?per_page=${_ghCount}`;
      try {
        const _ghResp = await axios.get(_ghUrl, {
          timeout: 30000,
          headers: { 'Authorization': `token ${GITHUB_PAT}`, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'MotherBrain/6.1.0' }
        });
        const _ghData = _ghResp.data.map(c => ({
          sha:     c.sha,
          short:   c.sha.slice(0, 7),
          message: c.commit.message.split('\n')[0],
          author:  c.commit.author.name,
          date:    c.commit.author.date
        }));
        return JSON.stringify(_ghData);
      } catch (_ghErr) { return JSON.stringify(_githubApiError(_ghErr)); }
    } else if (name === 'github_get_commit') {
      if (!GITHUB_PAT) return JSON.stringify({ error: 'github_pat_not_configured', hint: 'Add GITHUB_PAT to .env in the Game-main directory.' });
      const _ghUrl = `https://api.github.com/repos/mdunham726-coder/Game-main/commits/${encodeURIComponent(args.sha)}`;
      try {
        const _ghResp = await axios.get(_ghUrl, {
          timeout: 30000,
          headers: { 'Authorization': `token ${GITHUB_PAT}`, 'Accept': 'application/vnd.github.v3.diff', 'User-Agent': 'MotherBrain/6.1.0' }
        });
        const _ghRaw = typeof _ghResp.data === 'string' ? _ghResp.data : JSON.stringify(_ghResp.data);
        return _ghRaw.length > DEFAULT_TOOL_RESULT_LIMIT ? _ghRaw.slice(0, DEFAULT_TOOL_RESULT_LIMIT) + `\n[TRUNCATED — diff exceeds ${DEFAULT_TOOL_RESULT_LIMIT} chars]` : _ghRaw;
      } catch (_ghErr) { return JSON.stringify(_githubApiError(_ghErr)); }
    } else if (name === 'github_get_file') {
      if (!GITHUB_PAT) return JSON.stringify({ error: 'github_pat_not_configured', hint: 'Add GITHUB_PAT to .env in the Game-main directory.' });
      const _ghRef     = args.ref || 'main';
      const _ghFilePath = (args.path || '').split('/').map(s => encodeURIComponent(s)).join('/');
      const _ghUrl = `https://api.github.com/repos/mdunham726-coder/Game-main/contents/${_ghFilePath}?ref=${encodeURIComponent(_ghRef)}`;
      try {
        const _ghResp = await axios.get(_ghUrl, {
          timeout: 30000,
          headers: { 'Authorization': `token ${GITHUB_PAT}`, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'MotherBrain/6.1.0' }
        });
        if (Array.isArray(_ghResp.data)) return JSON.stringify({ error: 'github_path_is_directory', hint: 'Provide a file path, not a directory.' });
        const _ghContent = Buffer.from(_ghResp.data.content, 'base64').toString('utf8');
        const _ghResult  = `// ${args.path} @ ${_ghRef} (sha: ${_ghResp.data.sha})\n${_ghContent}`;
        return _ghResult.length > DEFAULT_TOOL_RESULT_LIMIT ? _ghResult.slice(0, DEFAULT_TOOL_RESULT_LIMIT) + '\n[TRUNCATED]' : _ghResult;
      } catch (_ghErr) { return JSON.stringify(_githubApiError(_ghErr)); }
    } else if (name === 'github_compare') {
      if (!GITHUB_PAT) return JSON.stringify({ error: 'github_pat_not_configured', hint: 'Add GITHUB_PAT to .env in the Game-main directory.' });
      const _ghUrl = `https://api.github.com/repos/mdunham726-coder/Game-main/compare/${args.base}...${args.head}`;
      try {
        const _ghResp = await axios.get(_ghUrl, {
          timeout: 30000,
          headers: { 'Authorization': `token ${GITHUB_PAT}`, 'Accept': 'application/vnd.github.v3.diff', 'User-Agent': 'MotherBrain/6.1.0' }
        });
        const _ghRaw = typeof _ghResp.data === 'string' ? _ghResp.data : JSON.stringify(_ghResp.data);
        return _ghRaw.length > DEFAULT_TOOL_RESULT_LIMIT ? _ghRaw.slice(0, DEFAULT_TOOL_RESULT_LIMIT) + `\n[TRUNCATED — diff exceeds ${DEFAULT_TOOL_RESULT_LIMIT} chars]` : _ghRaw;
      } catch (_ghErr) { return JSON.stringify(_githubApiError(_ghErr)); }
    } else if (name === 'github_search_code') {
      if (!GITHUB_PAT) return JSON.stringify({ error: 'github_pat_not_configured', hint: 'Add GITHUB_PAT to .env in the Game-main directory.' });
      const _ghQ   = `${encodeURIComponent(args.query)}+repo:mdunham726-coder/Game-main`;
      const _ghUrl = `https://api.github.com/search/code?q=${_ghQ}&per_page=20`;
      try {
        const _ghResp = await axios.get(_ghUrl, {
          timeout: 30000,
          headers: { 'Authorization': `token ${GITHUB_PAT}`, 'Accept': 'application/vnd.github.v3.text-match+json', 'User-Agent': 'MotherBrain/6.1.0' }
        });
        const _ghItems = (_ghResp.data.items || []).map(item => ({
          path:      item.path,
          sha:       item.sha,
          url:       item.html_url,
          fragments: (item.text_matches || []).map(m => m.fragment)
        }));
        return JSON.stringify({ total_count: _ghResp.data.total_count, results: _ghItems });
      } catch (_ghErr) { return JSON.stringify(_githubApiError(_ghErr)); }
    } else if (name === 'get_witness') {
      try {
        const resp = await axios.get(`http://${HOST}:${PORT}/debug/witness`, {
          timeout: 10000,
          httpAgent: _toolHttpAgent,
          headers: { 'x-session-id': _activeSessionId }
        });
        return JSON.stringify(resp.data);
      } catch (err) {
        return JSON.stringify({ error: err.message, status: err.response?.status ?? null });
      }
    } else if (name === 'get_p3_comparison') {
      try {
        const resp = await axios.get(`http://${HOST}:${PORT}/diagnostics/turn/${_activeSessionId}/${args.turn}/p3-comparison`, {
          timeout: 10000,
          httpAgent: _toolHttpAgent
        });
        return JSON.stringify(resp.data);
      } catch (err) {
        return JSON.stringify({ error: err.message, status: err.response?.status ?? null });
      }
    } else if (name === 'partial_stack_comparison') {
      try {
        const modeParam = args.mode || 'compact';
        const resp = await axios.get(`http://${HOST}:${PORT}/diagnostics/turn/${_activeSessionId}/${args.turn}/partial-stack-comparison?mode=${modeParam}`, {
          timeout: 10000,
          httpAgent: _toolHttpAgent
        });
        return JSON.stringify(resp.data);
      } catch (err) {
        return JSON.stringify({ error: err.message, status: err.response?.status ?? null });
      }
    } else {
      return JSON.stringify({ error: 'unknown_tool', name });
    }
    const resp = await axios.get(url, { timeout: 10000, httpAgent: _toolHttpAgent });
    const raw  = JSON.stringify(resp.data);
    if (raw.length > DEFAULT_TOOL_RESULT_LIMIT) {
      return raw.slice(0, DEFAULT_TOOL_RESULT_LIMIT) + `\n[TRUNCATED — response exceeds ${DEFAULT_TOOL_RESULT_LIMIT} chars. Use stage= and part= to narrow the query.]`;
    }
    return raw;
  } catch (err) {
    return JSON.stringify({ error: err.message, status: err.response?.status ?? null, body: err.response?.data ?? null }); // v6.0.26: include server error body so MB can distinguish session_not_found vs payload_not_found
  }
}

// ── Canonical structured dispatch seam (legacy executor remains authority) ────
function _projectCanonicalToolMetadata(toolContent) {
  if (typeof toolContent !== 'string') {
    return { outcome: 'invalid_result', gateCode: 'non_string_tool_result' };
  }
  let parsed;
  try { parsed = JSON.parse(toolContent); } catch (_) { parsed = null; }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.error === 'string') {
    const gateCode = /^[a-z][a-z0-9_]{0,63}$/.test(parsed.error)
      ? parsed.error
      : 'redacted_error';
    return { outcome: 'rejected', gateCode };
  }
  return { outcome: 'executed', gateCode: null };
}

function createCanonicalToolDispatchAdapter(executor) {
  if (typeof executor !== 'function') throw new TypeError('Canonical tool executor must be a function.');
  return async function dispatchToolCall(call) {
    const toolContent = await executor(call.name, call.args);
    const metadata = _projectCanonicalToolMetadata(toolContent);
    return { toolContent, outcome: metadata.outcome, gateCode: metadata.gateCode };
  };
}

const executeToolCallStructured = createCanonicalToolDispatchAdapter(executeToolCall);

// ── Production controller/TUI composition ────────────────────────────────────
function timeOfDay(now) {
  const hour = now.getHours();
  return hour < 6 ? 'night' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : hour < 21 ? 'evening' : 'night';
}

function createDeepSeekHttpClient(options = {}) {
  const axiosClient = options.axiosClient || axios;
  const getApiKey = options.getApiKey || (() => DEEPSEEK_KEY);
  const httpsAgent = options.httpsAgent || _deepseekHttpsAgent;
  const activeRequests = new Set();

  const request = async ({ url, body }) => {
    const apiKey = getApiKey();
    if (!apiKey) {
      const error = new Error('DEEPSEEK_API_KEY is not configured.');
      error.code = 'missing_deepseek_api_key';
      throw error;
    }

    const abortController = new AbortController();
    activeRequests.add(abortController);
    try {
      return await axiosClient.post(url, body, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 0,
        httpsAgent,
        signal: abortController.signal,
      });
    } finally {
      activeRequests.delete(abortController);
    }
  };

  request.isContextLengthError = isObservedDeepSeekContextLengthError;
  request.cancelAll = () => {
    for (const controller of activeRequests) controller.abort();
    activeRequests.clear();
  };
  request.getActiveRequestCount = () => activeRequests.size;
  return request;
}

function createLiveContextProvider(options = {}) {
  const axiosClient = options.axiosClient || axios;
  const httpAgent = options.httpAgent || _toolHttpAgent;
  const activeRequests = new Set();

  const prewarm = async sessionId => {
    if (!sessionId) return null;
    const abortController = new AbortController();
    activeRequests.add(abortController);
    try {
      const response = await axiosClient.get(
        `http://${HOST}:${PORT}${CTX_PATH}?sessionId=${encodeURIComponent(sessionId)}&level=detailed`,
        { timeout: 10000, httpAgent, signal: abortController.signal }
      );
      const context = response.data?.context || null;
      if (context) _cachedContext = context;
      return context;
    } finally {
      activeRequests.delete(abortController);
    }
  };

  const getLiveContext = async () => {
    let gameContext = null;
    let contextNote = '';
    let source = 'flight_recorder';

    if (!_activeSessionId) {
      contextNote = '[NOTE: No game session is active yet — no engine data available. Answering without game state context.]\n';
      if (_cachedContext) {
        gameContext = _cachedContext;
        source = 'cached';
      }
    } else {
      try {
        gameContext = await prewarm(_activeSessionId);
        if (gameContext) source = 'live';
      } catch (_) {
        if (_cachedContext) {
          gameContext = _cachedContext;
          source = 'cached';
          contextNote = '[NOTE: Live context fetch failed — using cached snapshot.]\n';
        } else {
          contextNote = '[WARNING: Could not fetch live game state from server — using flight recorder data only.]\n';
        }
      }
    }

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
    fullContext += formatTurnBuffer();

    return {
      fullContext,
      contextNote,
      source,
      sessionId: _activeSessionId,
    };
  };

  getLiveContext.prewarm = prewarm;
  getLiveContext.cancelAll = () => {
    for (const controller of activeRequests) controller.abort();
    activeRequests.clear();
  };
  getLiveContext.getActiveRequestCount = () => activeRequests.size;
  return getLiveContext;
}

function formatTurnStatusText(turn) {
  const spatial = turn.spatial || {};
  const tokens = turn.tokens || {};
  const depth = ['—', 'L0', 'L1', 'L2'][spatial.depth ?? 0] || String(spatial.depth);
  let location = '—';
  if (spatial.local_space_name) location = spatial.local_space_name;
  else if (spatial.site_name) location = spatial.site_name;
  else if (spatial.position && spatial.position.mx != null) {
    location = `cell(${spatial.position.mx},${spatial.position.my}:${spatial.position.lx},${spatial.position.ly})`;
  }
  const npcs = (turn.entities?.visible || [])
    .map(entity => entity.name || entity.id)
    .filter(Boolean)
    .slice(0, 3)
    .join(', ') || '—';
  const systemTokens = tokens.system_total != null ? `sys:${tokens.system_total.toLocaleString()}tok` : '';
  const delta = tokens.delta != null ? ` Δ${tokens.delta > 0 ? '+' : ''}${tokens.delta}` : '';
  const violations = (turn.violations || []).length;
  const narrator = turn.narrator_status && turn.narrator_status !== 'ok'
    ? ` | nar:${turn.narrator_status}`
    : '';
  return `[T-${turn.turn}] ${depth}:${location} | ${npcs} | ${systemTokens}${delta} | ${violations === 0 ? '✓' : `✗ ${violations}`}${narrator}`;
}

function nextRuntimeRecordId(state, prefix) {
  state.recordSequence += 1;
  return `${prefix}-${state.recordSequence}`;
}

function commandResultLines(result) {
  const lines = [`${result.command || '/command'}: ${result.code || (result.ok ? 'ok' : 'failed')}`];
  if (result.data && Object.keys(result.data).length > 0) {
    lines.push(...JSON.stringify(result.data, null, 2).split('\n'));
  }
  return lines;
}

function createControllerViewSink(tui, state) {
  return event => {
    if (state.stopping) return;
    const payload = event.payload || {};
    switch (event.type) {
      case 'operational_state':
        state.header = { ...state.header, ...(payload.state || {}) };
        tui.renderHeaderOperationalState(state.header);
        return;
      case 'turn_state': {
        const activity = payload.state || 'idle';
        state.header = {
          ...state.header,
          activity,
          busy: activity !== 'idle',
          ...(payload.configured_model ? { configured_model: payload.configured_model } : {}),
          ...(payload.configured_reasoning_effort
            ? { configured_reasoning_effort: payload.configured_reasoning_effort }
            : {}),
        };
        tui.renderHeaderOperationalState(state.header);
        if (activity !== 'idle') {
          tui.renderActivityRecord({
            id: nextRuntimeRecordId(state, 'turn-state'),
            kind: 'turn-state',
            role: 'telemetry',
            text: `State: ${activity}`,
          });
        }
        return;
      }
      case 'provider_attempt':
        tui.renderActivityRecord({
          id: nextRuntimeRecordId(state, 'provider-attempt'),
          kind: 'provider-attempt',
          role: 'telemetry',
          text: `Round ${payload.round} attempt ${payload.attempt} · ${payload.body_utf8_bytes} request bytes`,
        });
        return;
      case 'provider_retry':
        tui.renderActivityRecord({
          id: nextRuntimeRecordId(state, 'provider-retry'),
          kind: 'provider-retry',
          role: 'warning',
          text: `Round ${payload.round} retry ${payload.retry} · ${payload.category} · ${payload.delay_ms || 0} ms`,
        });
        return;
      case 'provider_round':
        state.header = {
          ...state.header,
          ...(payload.actual_model ? { actual_model: payload.actual_model } : {}),
        };
        tui.renderHeaderOperationalState(state.header);
        tui.renderRoundActivityRecord({
          id: nextRuntimeRecordId(state, 'provider-round'),
          ...payload,
        });
        return;
      case 'tool_call':
        tui.renderActivityRecord({
          id: nextRuntimeRecordId(state, 'tool-call'),
          kind: 'tool-call',
          role: payload.status === 'valid' ? 'tool' : 'failure',
          text: `Call: ${payload.name} · ${payload.status}`
            + (payload.validation_code ? ` · code ${payload.validation_code}` : '')
            + (payload.argument_keys?.length ? ` · keys ${payload.argument_keys.join(', ')}` : ''),
        });
        return;
      case 'tool_result':
        tui.renderActivityRecord({
          id: nextRuntimeRecordId(state, 'tool-result'),
          kind: 'tool-result',
          role: payload.outcome === 'executed' ? 'tool' : 'failure',
          text: `Result: ${payload.name} · ${payload.outcome} · ${payload.bytes} bytes`
            + (payload.gate_code ? ` · code ${payload.gate_code}` : ''),
        });
        return;
      case 'turn_completed':
        if (typeof payload.final_answer === 'string') {
          tui.renderTranscriptRecord({
            id: payload.exchange_id
              ? `response-${payload.exchange_id}`
              : nextRuntimeRecordId(state, 'response'),
            kind: 'mother-response',
            role: 'final',
            text: payload.final_answer,
          });
        }
        tui.renderActivityRecord({
          id: nextRuntimeRecordId(state, 'turn-completed'),
          kind: 'turn-completed',
          role: 'telemetry',
          text: 'State: completed',
        });
        return;
      case 'turn_terminal':
        tui.renderActivityRecord({
          id: nextRuntimeRecordId(state, 'turn-terminal'),
          kind: 'turn-terminal',
          role: 'failure',
          text: `State: ${payload.status || 'failed'}`
            + (payload.error?.code ? ` · ${payload.error.code}` : ''),
        });
        return;
      case 'telemetry':
        // Step 11 owns the exact core/extended footer projection.
        tui.renderTelemetrySnapshot({
          source: payload.snapshot || {},
          core: [],
          extended: [],
        });
        return;
      case 'command_result':
        if (payload.command === '/clear' && payload.ok) tui.clearDisplay();
        if (payload.command === '/copy') {
          tui.renderCopyResult({
            ok: Boolean(payload.ok),
            bytes: payload.data?.utf8_bytes ?? null,
            code: payload.code || null,
            message: payload.ok ? 'Last completed exchange copied.' : 'Copy failed.',
          });
          return;
        }
        if (payload.data?.configured_model) state.header.configured_model = payload.data.configured_model;
        if (payload.data?.configured_reasoning_effort) {
          state.header.configured_reasoning_effort = payload.data.configured_reasoning_effort;
        }
        tui.renderHeaderOperationalState(state.header);
        tui.renderCommandStatus({
          id: nextRuntimeRecordId(state, 'command'),
          status: payload.ok ? 'ok' : 'error',
          lines: commandResultLines(payload),
        });
        return;
      case 'persistence_warning':
        tui.renderCommandStatus({
          id: nextRuntimeRecordId(state, 'persistence'),
          status: 'warning',
          lines: [`Persistence degraded: ${payload.code || payload.reason || 'unknown'}`],
        });
        return;
      default:
        tui.renderActivityRecord({
          id: nextRuntimeRecordId(state, 'controller-event'),
          kind: 'controller-event',
          role: 'telemetry',
          text: `Controller event: ${event.type}`,
        });
    }
  };
}

function buildCrashReport(type, error, controller) {
  const message = error?.message || String(error);
  const stack = error?.stack || '';
  const appFrames = stack.split('\n')
    .filter(line => line.includes('    at ') && line.includes('Game-main') && !line.includes('node_modules'))
    .map(line => line.trim());
  const latestTurn = _turnBuffer.length ? _turnBuffer[_turnBuffer.length - 1]?.turn ?? 'none' : 'none';
  const historyCount = controller?.getCompletedExchangeLedger
    ? controller.getCompletedExchangeLedger().length
    : 0;
  return {
    type: String(type),
    message,
    stack,
    where: appFrames[0] || null,
    session: _activeSessionId || 'none',
    last_turn: latestTurn,
    history_count: historyCount,
    mb_version: MB_VERSION,
  };
}

function deliverCrashReport(report, options = {}) {
  const fileSystem = options.fileSystem || fs;
  const httpModule = options.httpModule || http;
  const crashTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const crashPath = path.join(__dirname, 'logs', `mb-crash-${crashTimestamp}.txt`);
  const crashText = [
    'MOTHER BRAIN CRASH REPORT',
    `Type    : ${report.type}`,
    `Error   : ${report.message}`,
    `Session : ${report.session} | last turn : T-${report.last_turn} | history : ${report.history_count} exchanges`,
    `Version : ${report.mb_version}`,
    '',
    'Full stack:',
    report.stack || '(no stack)',
  ].join('\n');

  try {
    fileSystem.mkdirSync(path.dirname(crashPath), { recursive: true });
    fileSystem.writeFileSync(crashPath, crashText, 'utf8');
  } catch (_) {}

  const diagnosticKey = process.env.DIAGNOSTICS_KEY || '';
  const body = JSON.stringify({
    type: report.type,
    message: report.message,
    where: report.where,
    stack: report.stack,
    mb_version: report.mb_version,
    session: report.session,
    last_turn: report.last_turn,
  });
  try {
    const request = httpModule.request({
      hostname: HOST,
      port: PORT,
      path: '/diagnostics/mb-crash',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-diagnostics-key': diagnosticKey,
      },
    });
    request.on('error', () => {});
    request.write(body);
    request.end();
  } catch (_) {}

  return crashPath;
}

function resetRuntimeOperationalState() {
  _turnBuffer = [];
  _activeSessionId = null;
  _harnessAuthorized = false;
  _activeGameplayInvestigation = null;
  _cachedContext = null;
}

function createMotherBrainRuntime(options = {}) {
  const state = {
    started: false,
    stopping: false,
    stopped: false,
    recordSequence: 0,
    submissionSequence: 0,
    engineStatus: 'offline',
    sseStatus: 'disconnected',
    header: { activity: 'idle', busy: false },
    sseRequest: null,
    sseResponse: null,
    reconnectTimer: null,
    bootstrapTimer: null,
    bootstrapInFlight: false,
    bootstrapAbortController: null,
    shutdownPrepared: false,
    pendingCrashReport: null,
    shutdownPromise: null,
    finalizePromise: null,
  };
  const runtime = {
    state,
    tui: null,
    controller: null,
    httpClient: null,
    controllerHttpClient: null,
    liveContextProvider: null,
    get started() { return state.started; },
    get stopping() { return state.stopping; },
  };

  const clock = options.clock || (() => new Date());
  const axiosClient = options.axiosClient || axios;
  const httpModule = options.httpModule || http;
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;
  const startOperational = options.startOperational !== false;
  const reportCrashes = options.reportCrashes !== false;
  const hasProviderCredential = options.hasProviderCredential || (() => Boolean(DEEPSEEK_KEY));

  runtime.httpClient = options.httpClient || createDeepSeekHttpClient({
    axiosClient,
    getApiKey: options.getApiKey || (() => DEEPSEEK_KEY),
    httpsAgent: options.httpsAgent || _deepseekHttpsAgent,
  });
  runtime.liveContextProvider = options.getLiveContext || createLiveContextProvider({
    axiosClient,
    httpAgent: options.toolHttpAgent || _toolHttpAgent,
  });
  runtime.controllerHttpClient = async request => {
    if (state.stopping) {
      const error = new Error('Mother Brain runtime is stopping.');
      error.code = 'runtime_stopping';
      throw error;
    }
    return runtime.httpClient(request);
  };
  runtime.controllerHttpClient.isContextLengthError = error => (
    typeof runtime.httpClient.isContextLengthError === 'function'
      ? runtime.httpClient.isContextLengthError(error)
      : false
  );

  const createTui = options.createTui || createMotherBrainTui;
  runtime.tui = createTui({
    ...(options.tuiOptions || {}),
    version: MB_VERSION,
    onSubmit: input => runtime.submit(input),
    onBlockedSubmit: input => runtime.blockedSubmit(input),
    onBeforeShutdown: intent => runtime.prepareShutdown(intent),
    onShutdown: result => runtime.finalize(result),
    onSynchronousExit: result => {
      runtime.prepareShutdown(result);
      runtime.finalize(result);
      if (options.onSynchronousExit) options.onSynchronousExit(result);
    },
  });

  const viewSink = createControllerViewSink(runtime.tui, state);
  const controllerDependencies = {
    httpClient: runtime.controllerHttpClient,
    tools: MB_TOOLS,
    dispatchToolCall: options.dispatchToolCall || executeToolCallStructured,
    getLiveContext: runtime.liveContextProvider,
    clock,
    fsAdapter: options.fsAdapter || fs.promises,
    paths: options.paths || {
      historyFile: HISTORY_PATH,
      settingsFile: SETTINGS_PATH,
    },
    delay: options.delay || (milliseconds => new Promise(resolve => setTimer(resolve, milliseconds))),
    viewSink,
    writeClipboard: options.writeClipboard || copyToWindowsClipboard,
  };
  const createController = options.createController
    || (dependencies => new MotherBrainController(dependencies));
  runtime.controller = createController(controllerDependencies);

  runtime.emitActivity = record => {
    if (state.stopping) return null;
    return runtime.tui.renderActivityRecord({
      id: record.id || nextRuntimeRecordId(state, 'activity'),
      kind: record.kind || 'operational-status',
      role: record.role || 'tool',
      text: String(record.text ?? ''),
    });
  };

  runtime.syncOperationalState = () => {
    if (state.stopping) return null;
    return runtime.controller.updateOperationalState({
      engine: state.engineStatus,
      sse: state.sseStatus,
      session: _activeSessionId ? 'attached' : 'none',
      harness: _harnessAuthorized ? 'authorized' : 'offline',
      game: _activeGameplayInvestigation ? 'active' : 'inactive',
    });
  };

  runtime.blockedSubmit = async () => {
    runtime.emitActivity({
      kind: 'blocked-submit',
      role: 'warning',
      text: 'One provider turn is already active; the draft was preserved.',
    });
    return { accepted: false, code: 'controller_busy' };
  };

  runtime.submit = async input => {
    if (state.stopping) return { accepted: false, code: 'runtime_stopping' };
    const question = String(input);
    const localCommand = question.trimStart().startsWith('/');
    const snapshot = runtime.controller.getContractSnapshot();
    if (!localCommand && snapshot.busy) return runtime.blockedSubmit(question);

    state.submissionSequence += 1;
    runtime.tui.renderTranscriptRecord({
      id: `submitted-${state.submissionSequence}`,
      kind: localCommand ? 'local-command' : 'developer-message',
      role: 'developer',
      text: question,
    });

    if (localCommand) {
      await runtime.controller.handleLocalCommand(question);
      return { accepted: true, local: true };
    }

    if (!hasProviderCredential()) {
      runtime.emitActivity({
        kind: 'provider-unavailable',
        role: 'failure',
        text: 'DEEPSEEK_API_KEY not set. Launch via StartMotherBrain.bat.',
      });
      return { accepted: true, local: false, providerCalled: false };
    }

    try {
      const liveContext = await runtime.liveContextProvider();
      runtime.emitActivity({
        kind: 'context-source',
        role: liveContext.source === 'live' ? 'telemetry' : 'warning',
        text: liveContext.contextNote?.trim() || `Context source: ${liveContext.source || 'unknown'}`,
      });
      const clockValue = clock();
      const now = clockValue instanceof Date ? new Date(clockValue.getTime()) : new Date(clockValue);
      const timeBlock = `\n\nSERVER-LOCAL TIME (this machine only — not universal):\n`
        + `${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}\n`
        + `${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}\n`
        + `Time of day: ${timeOfDay(now)}`;
      const systemMessages = [{ role: 'system', content: SYSTEM_PROMPT + timeBlock }];
      const userMessage = {
        role: 'user',
        content: `[LIVE ENGINE DATA]\n${liveContext.fullContext}\n\n[DEVELOPER QUESTION]\n${question}`,
      };
      const outcome = await runtime.controller.runTurn({
        question,
        systemMessages,
        userMessage,
      });

      if (outcome.status !== 'completed') {
        runtime.emitActivity({
          kind: 'turn-failure',
          role: 'failure',
          text: `Mother Brain turn ${outcome.status}: ${outcome.error?.code || 'unknown_error'}`,
        });
      }
      return { accepted: true, local: false, outcome };
    } catch (error) {
      runtime.tui.renderFatal({ code: error.code || 'composition_failure', message: error.message });
      await runtime.shutdown('submit-error', { exitCode: 1, error });
      return { accepted: true, local: false, error };
    }
  };

  runtime.handleSsePayload = payload => {
    if (!payload || typeof payload !== 'object' || state.stopping) return;

    if (payload.type === 'narrator_error') {
      _turnBuffer.push(payload);
      if (_turnBuffer.length > TURN_BUFFER) _turnBuffer.shift();
      runtime.emitActivity({
        kind: 'narrator-error',
        role: 'failure',
        text: `[T-${payload.turn}] NARRATION FAILED (${payload.kind || 'error'}): ${payload.message || '—'}`,
      });
      return;
    }

    if (payload.type === 'turn') {
      _turnBuffer.push(payload);
      if (_turnBuffer.length > TURN_BUFFER) _turnBuffer.shift();
      if (payload.gameSessionId) {
        const wasEmpty = !_activeSessionId;
        const sessionChanged = !wasEmpty && _activeSessionId !== payload.gameSessionId;
        _activeSessionId = payload.gameSessionId;
        if (sessionChanged) {
          _cachedContext = null;
          runtime.emitActivity({
            kind: 'session-change',
            role: 'telemetry',
            text: 'Session auto-attached after browser session change.',
          });
        }
        if ((wasEmpty || sessionChanged) && !_cachedContext && runtime.liveContextProvider.prewarm) {
          runtime.liveContextProvider.prewarm(_activeSessionId).catch(() => {});
        }
      }
      runtime.syncOperationalState();
      runtime.emitActivity({
        kind: 'sse-turn',
        role: 'telemetry',
        text: formatTurnStatusText(payload),
      });
      return;
    }

    if (payload.type === 'arbiter_verdict') {
      const turnEntry = _turnBuffer.find(turn => turn.turn === payload.turn);
      if (turnEntry) {
        turnEntry._arbiter = {
          changes: payload.reputation_changes || [],
          error: payload.error || null,
        };
      }
      return;
    }

    if (payload.type === 'lifecycle') {
      if (payload.event === 'online') {
        state.engineStatus = 'online';
        runtime.emitActivity({
          kind: 'engine-lifecycle',
          role: 'tool',
          text: `ENGINE ONLINE · port ${payload.port} · session ${payload.sessionId || '—'}`,
        });
      } else if (payload.event === 'offline') {
        state.engineStatus = 'offline';
        runtime.emitActivity({
          kind: 'engine-lifecycle',
          role: 'warning',
          text: `ENGINE OFFLINE · ${payload.reason || '?'}`,
        });
      }
      runtime.syncOperationalState();
    }
  };

  runtime.scheduleSseReconnect = () => {
    if (state.stopping || state.reconnectTimer) return false;
    state.sseStatus = 'reconnecting';
    runtime.syncOperationalState();
    state.reconnectTimer = setTimer(() => {
      state.reconnectTimer = null;
      runtime.connectSse();
    }, RECONNECT_MS);
    return true;
  };

  runtime.connectSse = () => {
    if (state.stopping || !state.started) return null;
    if (state.sseRequest || state.sseResponse) return state.sseRequest || state.sseResponse;
    state.sseStatus = 'connecting';
    runtime.syncOperationalState();
    runtime.emitActivity({
      kind: 'sse-state',
      role: 'telemetry',
      text: `SSE connecting to http://${HOST}:${PORT}${SSE_PATH}`,
    });

    try {
      const request = httpModule.get(
        {
          host: HOST,
          port: PORT,
          path: SSE_PATH,
          headers: { Accept: 'text/event-stream' },
          agent: options.sseHttpAgent || _sseHttpAgent,
        },
        response => {
          if (state.stopping) {
            response.destroy?.();
            return;
          }
          state.sseResponse = response;
          request.socket?.setTimeout(0);
          request.socket?.setNoDelay(true);

          if (response.statusCode !== 200) {
            state.sseStatus = 'reconnecting';
            runtime.syncOperationalState();
            runtime.emitActivity({
              kind: 'sse-state',
              role: 'warning',
              text: `SSE HTTP ${response.statusCode} · retry in ${RECONNECT_MS} ms`,
            });
            let released = false;
            const releaseAndRetry = () => {
              if (released || state.stopping) return;
              released = true;
              if (state.sseResponse === response) state.sseResponse = null;
              if (state.sseRequest === request) state.sseRequest = null;
              runtime.scheduleSseReconnect();
            };
            response.once?.('end', releaseAndRetry);
            response.once?.('close', releaseAndRetry);
            response.once?.('error', releaseAndRetry);
            response.resume();
            return;
          }

          if (state.reconnectTimer) {
            clearTimer(state.reconnectTimer);
            state.reconnectTimer = null;
          }
          state.sseStatus = 'connected';
          runtime.syncOperationalState();
          response.setEncoding('utf8');
          let buffer = '';
          let streamFinished = false;
          const reconnectAfterStream = (role, text) => {
            if (streamFinished || state.stopping) return;
            streamFinished = true;
            if (state.sseResponse === response) state.sseResponse = null;
            if (state.sseRequest === request) state.sseRequest = null;
            runtime.emitActivity({ kind: 'sse-state', role, text });
            runtime.scheduleSseReconnect();
          };
          response.on('data', chunk => {
            buffer += chunk;
            const blocks = buffer.split('\n\n');
            buffer = blocks.pop();
            for (const block of blocks) {
              for (const line of block.split('\n')) {
                if (!line.startsWith('data:')) continue;
                try {
                  runtime.handleSsePayload(JSON.parse(line.slice(5).trim()));
                } catch (_) {}
              }
            }
          });
          response.on('end', () => reconnectAfterStream('warning', 'SSE stream ended · reconnecting'));
          response.on('close', () => reconnectAfterStream('warning', 'SSE stream closed · reconnecting'));
          response.on('error', error => reconnectAfterStream('warning', `SSE error: ${error.message} · reconnecting`));
        }
      );
      state.sseRequest = request;
      request.on('error', error => {
        if (state.stopping) return;
        if (state.sseResponse) return;
        state.sseRequest = null;
        runtime.emitActivity({
          kind: 'sse-state',
          role: 'telemetry',
          text: `SSE offline (${error.message}) · retry in ${RECONNECT_MS} ms`,
        });
        runtime.scheduleSseReconnect();
      });
      return request;
    } catch (error) {
      runtime.emitActivity({
        kind: 'sse-state',
        role: 'warning',
        text: `SSE setup failed (${error.message}) · retry in ${RECONNECT_MS} ms`,
      });
      runtime.scheduleSseReconnect();
      return null;
    }
  };

  runtime.bootstrapSession = async () => {
    const abortController = new AbortController();
    state.bootstrapAbortController = abortController;
    try {
      const response = await axiosClient.get(
        `http://${HOST}:${PORT}/diagnostics/session`,
        { timeout: 5000, httpAgent: options.toolHttpAgent || _toolHttpAgent, signal: abortController.signal }
      );
      if (state.stopping) return false;
      const sessionId = response.data?.sessionId;
      if (!sessionId) return false;
      _activeSessionId = sessionId;
      runtime.emitActivity({
        kind: 'session-bootstrap',
        role: 'telemetry',
        text: 'Session bootstrapped.',
      });
      try {
        if (runtime.liveContextProvider.prewarm) {
          const context = await runtime.liveContextProvider.prewarm(sessionId);
          if (context && !state.stopping) {
            runtime.emitActivity({
              kind: 'context-prewarm',
              role: 'telemetry',
              text: `Context pre-warmed (${context.length.toLocaleString()} chars).`,
            });
          }
        }
      } catch (_) {}
      runtime.syncOperationalState();
      return true;
    } catch (_) {
      return false;
    } finally {
      if (state.bootstrapAbortController === abortController) state.bootstrapAbortController = null;
    }
  };

  runtime.startBootstrapLoop = () => {
    if (state.stopping || state.bootstrapInFlight || state.bootstrapTimer || _activeSessionId) return false;
    state.bootstrapInFlight = true;
    runtime.bootstrapSession()
      .then(found => {
        if (!found && !state.stopping && !_activeSessionId && !state.bootstrapTimer) {
          state.bootstrapTimer = setTimer(() => {
            state.bootstrapTimer = null;
            runtime.startBootstrapLoop();
          }, RECONNECT_MS);
        }
      })
      .catch(() => {})
      .finally(() => {
        state.bootstrapInFlight = false;
      });
    return true;
  };

  runtime.cleanupLifecycle = () => {
    if (typeof runtime.httpClient.cancelAll === 'function') runtime.httpClient.cancelAll();
    if (typeof runtime.liveContextProvider.cancelAll === 'function') runtime.liveContextProvider.cancelAll();
    if (state.bootstrapAbortController) {
      try { state.bootstrapAbortController.abort(); } catch (_) {}
      state.bootstrapAbortController = null;
    }
    state.bootstrapInFlight = false;
    if (state.reconnectTimer) {
      clearTimer(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    if (state.bootstrapTimer) {
      clearTimer(state.bootstrapTimer);
      state.bootstrapTimer = null;
    }
    if (state.sseResponse) {
      const response = state.sseResponse;
      state.sseResponse = null;
      try { response.removeAllListeners?.('data'); } catch (_) {}
      try { response.removeAllListeners?.('end'); } catch (_) {}
      try { response.removeAllListeners?.('close'); } catch (_) {}
      try { response.removeAllListeners?.('error'); } catch (_) {}
      try { response.once?.('error', () => {}); } catch (_) {}
      try { response.destroy?.(); } catch (_) {}
    }
    if (state.sseRequest) {
      const request = state.sseRequest;
      state.sseRequest = null;
      try { request.removeAllListeners?.('error'); } catch (_) {}
      try { request.once?.('error', () => {}); } catch (_) {}
      try { request.destroy?.(); } catch (_) {}
    }
    stopOperationalChildren();
  };

  runtime.prepareShutdown = intent => {
    if (state.shutdownPrepared) return false;
    state.shutdownPrepared = true;
    state.stopping = true;
    runtime.tui.stopAcceptingInput?.();

    if (intent?.error && reportCrashes) {
      const source = intent.error;
      const error = source instanceof Error
        ? source
        : Object.assign(
          new Error(source.message || String(source)),
          { name: source.name || 'Error', code: source.code || null }
        );
      state.pendingCrashReport = buildCrashReport(
        intent.reason || 'runtime-failure',
        error,
        runtime.controller
      );
    }

    runtime.cleanupLifecycle();
    return true;
  };

  runtime.finalize = result => {
    if (state.finalizePromise) return state.finalizePromise;
    state.finalizePromise = (async () => {
      runtime.prepareShutdown(result);
      if (state.pendingCrashReport) {
        deliverCrashReport(
          state.pendingCrashReport,
          {
            fileSystem: options.crashFileSystem || fs,
            httpModule: options.crashHttpModule || http,
          }
        );
        state.pendingCrashReport = null;
      }
      state.started = false;
      state.stopped = true;
      if (_activeRuntime === runtime) _activeRuntime = null;
      return result;
    })();
    return state.finalizePromise;
  };

  runtime.shutdown = (reason = 'normal', shutdownOptions = {}) => {
    if (state.shutdownPromise) return state.shutdownPromise;
    runtime.prepareShutdown({ reason: String(reason), ...shutdownOptions });
    state.shutdownPromise = (async () => {
      const result = runtime.tui.started
        ? await runtime.tui.shutdown(reason, shutdownOptions)
        : {
            reason: String(reason),
            exitCode: Number.isInteger(shutdownOptions.exitCode) ? shutdownOptions.exitCode : 0,
            error: shutdownOptions.error
              ? {
                  name: shutdownOptions.error.name || 'Error',
                  message: shutdownOptions.error.message || String(shutdownOptions.error),
                  code: shutdownOptions.error.code || null,
                }
              : null,
          };
      return runtime.finalize(result);
    })();
    return state.shutdownPromise;
  };

  runtime.getLifecycleSnapshot = () => ({
    started: state.started,
    stopping: state.stopping,
    stopped: state.stopped,
    reconnect_scheduled: Boolean(state.reconnectTimer),
    bootstrap_scheduled: Boolean(state.bootstrapTimer),
    bootstrap_in_flight: state.bootstrapInFlight,
    bootstrap_request_active: Boolean(state.bootstrapAbortController),
    sse_request_active: Boolean(state.sseRequest),
    sse_response_active: Boolean(state.sseResponse),
    provider_requests_active: typeof runtime.httpClient.getActiveRequestCount === 'function'
      ? runtime.httpClient.getActiveRequestCount()
      : null,
    context_requests_active: typeof runtime.liveContextProvider.getActiveRequestCount === 'function'
      ? runtime.liveContextProvider.getActiveRequestCount()
      : null,
    operational_children_active: _activeOperationalChildren.size,
  });

  runtime.start = async () => {
    if (state.started) return { started: true, reused: true };
    if (_activeRuntime && _activeRuntime !== runtime && !_activeRuntime.state.stopped) {
      throw new Error('A Mother Brain runtime is already active.');
    }
    resetRuntimeOperationalState();
    _activeRuntime = runtime;

    try {
      const tuiStart = await runtime.tui.start();
      if (!tuiStart.started) {
        state.stopped = true;
        if (_activeRuntime === runtime) _activeRuntime = null;
        return tuiStart;
      }
      state.started = true;

      const contractSnapshot = await runtime.controller.loadPersistentState();
      state.header = {
        ...state.header,
        configured_model: contractSnapshot.configured_settings.model,
        configured_reasoning_effort: contractSnapshot.configured_settings.reasoning_effort,
      };
      runtime.tui.renderHeaderOperationalState(state.header);

      for (const exchange of runtime.controller.getCompletedExchangeLedger()) {
        runtime.tui.renderTranscriptRecord({
          id: `restored-${exchange.id}-developer`,
          kind: 'restored-developer-message',
          role: 'developer',
          text: exchange.question,
        });
        runtime.tui.renderTranscriptRecord({
          id: `restored-${exchange.id}-response`,
          kind: 'restored-mother-response',
          role: 'final',
          text: exchange.final_answer,
        });
      }

      runtime.syncOperationalState();
      if (startOperational) {
        runtime.connectSse();
        runtime.startBootstrapLoop();
      }
      return { ...tuiStart, persistence: contractSnapshot.persistence };
    } catch (error) {
      try {
        runtime.tui.renderFatal({ code: error.code || 'startup_failure', message: error.message });
      } catch (_) {}
      await runtime.shutdown('startup-error', { exitCode: 1, error });
      throw error;
    }
  };

  return runtime;
}

async function main(options = {}) {
  loadRuntimeEnvironment(options.env || process.env, options.environmentFileSystem || fs);
  refreshRuntimeCredentials(options.env || process.env);
  const runtime = createMotherBrainRuntime(options);
  await runtime.start();
  return runtime;
}

if (require.main === module) {
  main().catch(error => {
    // This path runs only after startup failed or the TUI intentionally tore down.
    process.stderr.write(`Mother Brain failed to start: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  MB_VERSION,
  MB_TOOLS,
  SYSTEM_PROMPT,
  executeToolCall,
  executeToolCallStructured,
  createCanonicalToolDispatchAdapter,
  loadRuntimeEnvironment,
  refreshRuntimeCredentials,
  stripTerminalEscapes,
  createStructuredChildActivityCapture,
  trackOperationalChild,
  stopOperationalChildren,
  createDeepSeekHttpClient,
  createLiveContextProvider,
  createControllerViewSink,
  createMotherBrainRuntime,
  buildCrashReport,
  deliverCrashReport,
  main,
};
