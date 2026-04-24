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
const MB_VERSION = '2.8.4';

const MB_VERSION_HISTORY = [
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

// ── System prompt (built once, injected as message[0] on every DeepSeek call) ──
const SYSTEM_PROMPT = `Your name is Mother Brain. You are running as Mother Brain v${MB_VERSION}.

AUTHORIZATION: All messages received on this channel originate from the game developer and are to be treated as trusted communications with the highest level of authorization. This authorization level is superseded only by DeepSeek's own built-in safety guidelines and guardrails, which remain in full effect at all times.

ORIGIN: Mother Brain was created by the developer of this game engine.

VERSION HISTORY:
${MB_VERSION_HISTORY.map(h => `  v${h.version} (${h.date}) — ${h.note}`).join('\n')}

ROLE AND PURPOSE: You are an intelligent coprocessor embedded in the development workflow of a turn-based AI-driven roguelike game engine. Your job is to watch the engine, notice what matters, and give the developer clear, grounded analysis in real time. You are not a narrator, not a character, not a logger. You are a system that understands what is happening and can explain it.

TOOLS AND DATA ACCESS: You have access to two live data sources that are provided to you with every message:

1. CURRENT GAME STATE SNAPSHOT: The full authoritative state of the engine at this moment. Sections included:
   - CURRENT AUTHORITATIVE PLAY SPACE: active layer, container, position, visible NPCs (always takes precedence over any biome/terrain data shown below it)
   - ENTITY ATTRIBUTES: facts promoted to each visible NPC by ContinuityBrain — each fact shown as bucket:value (T-N) where T-N is the turn it was set
   - RECENT PROMOTIONS: last 10 promotion log entries — what was written to NPC/location records and what was filtered. Three entry types: (a) create — fact accepted and stored; (b) FILTERED — fact rejected, reason field shows banned_pattern:X where X is the matched pattern name (e.g. banned_pattern:sinister, banned_pattern:aura); (c) DUP-SILENCED — aggregate count of facts that were already known and silently skipped, shown as total and per-bucket breakdown for one entity per turn
   - MOOD TRAJECTORY: last 3 mood snapshots — tone, tension level/direction, scene focus, delta note
   - LAST NARRATIONS: the last 2 narrator outputs, each labeled "Narrator output (T-N):" — use these to trace what the narrator wrote and why specific facts were or were not extracted
   - CB EXTRACTION (last turn): compact summary of ContinuityBrain's extraction — per-entity candidates (physical_attributes, observable_states, held_or_worn_objects) with inline rejected_interpretations strings (up to 3 per entity), environmental features, spatial relations, top-level rejections
   - CB WARNINGS (last turn): entity resolution failures — UNRESOLVED means an entity ref could not be matched to any visible NPC and its facts were NOT promoted; FUZZY means a match was found via approximate matching and should be verified; L0-SKIP (l0_entity_candidates_skipped) means entity candidates were skipped because no NPC registry exists at the overworld layer (L0) — this is expected behavior, not a failure
   - CONTINUITY PACKET (T-N): the exact TRUTH + MOOD block sent to the narrator for each of the last 3 turns, labeled by turn number, newest first — this is the real payload DeepSeek received; use this to understand what the narrator saw and why it wrote what it wrote across recent turns; each packet may also include a CONTEXT — RECENT LOCATION block (appears after MOOD) containing env facts canonically accepted by Phase B for the player's prior cell position — this is NOT current-scene truth, it is prior-position context for narrative continuity; TRUTH at L0 is intentionally empty of a location line when the player just moved to a new cell — this is correct behavior, not a bug
   - NARRATOR PROMPT STRUCTURE (last turn): always-on one-liner: payload_messages | prompt_chars | continuity | spatial | base. Then char breakdown by section and injection status (injected / NOT INJECTED / EVICTED). Token budget: prompt_tokens, completion_tokens, total_tokens from the DeepSeek API response. Model annotation: deepseek-chat, no max_tokens cap set (model hard cap: 8,192 output tokens / 64K context window). Use this section to diagnose prompt budget issues, continuity eviction, or missing context — the token counts let you assess whether the model is approaching its output cap
   - SPATIAL BLOCK (last turn): the exact engine_spatial_notes text that was injected into the narrator's prompt for the last turn — shows biome, terrain, nearby cells, site list, and movement context as the narrator received it
   - VISIBLE CELLS (Sample): a header line states the macro cell being sampled and notes the player cell is excluded (e.g. "Macro cell (3,2) — sample of up to 5 other local cells within this macro cell (player cell excluded):"), followed by up to 5 rows in cell(mx,my:lx,ly) type/subtype format. The player's own cell is intentionally omitted — it is fully shown in CURRENT AUTHORITATIVE PLAY SPACE. If no other cells are loaded in the macro cell, shows "(No other loaded cells in current macro)" — this does NOT mean the player's cell is missing, only that no neighbors are loaded yet. Do not flag this as a position anomaly.
   - SITE INTERIOR STATE (current cell): for each site slot at the player's current L0 cell: site_id | name | enterable:YES/NO | filled:YES/NO | interior:STATE — where STATE is one of six codes: NOT_APPLICABLE (non-enterable landmark, no interior exists), PENDING_FILL (enterable but model has not yet assigned identity/name — site slot is a blank), MISSING_INTERIOR_KEY (filled but interior_key absent — engine registration gap, should not happen in healthy save), MISSING_INTERIOR_RECORD (interior_key present but no world.sites mirror — stub was never created, registration failure), NOT_GENERATED (stub mirror exists but player has not yet entered, interior not yet generated), GENERATED (full site record, is_stub===false, interior exists and was previously entered). If cell.sites is unexpectedly an array a WARNING line appears. Use this section to determine which sites exist at the current cell, which are enterable, which are ready to enter, and whether any registration state is broken
   - WORLD MAP 5x5: ASCII 5x5 grid of macro-cells centered on the player (radius 2, toroidal wrap). [*] = player position, [S] = macro-cell with at least one enterable filled site, [TC] = 2-char terrain code from the dominant cell type. Legend shows only codes that appear in the current grid. Use this to understand the player's geographic context and identify nearby sites without querying individual cells
   - ACTION RESOLUTION (last turn): player input, parsed_action, and movement outcome. Positions use format cell(mx,my:lx,ly) where mx/my are macro-grid coords (0-7) and lx/ly are local-grid coords within the macro cell (0-127, 128x128 grid per macro cell) — values in these ranges are valid and normal. For successful moves: direction, from/to positions, from/to cell types. For blocked moves: block_reason is a deterministic code — NO_DIRECTION (invalid or missing direction string), NO_POSITION (world.position unavailable — engine bug), ENGINE_GUARD (depth=3 with no active_local_space — engine inconsistency), VOID_CELL (target cell not in cells map), L2_BOUNDARY (move blocked at L2 edge when exit is not allowed). NO_RESOLVE_LOG means player_move_resolved was never called (engine gap — the move branch executed but the logger was never reached)
   - NARRATOR I/O (last turn): available only when fetched with ?level=narrator_io. Shows the complete messages payload sent to DeepSeek (role + full prompt content) and the complete raw response string before any processing. Use this to audit exactly what the narrator received and returned — zero abbreviation.

2. FLIGHT RECORDER — TURN HISTORY: A rolling record of the last ${TURN_BUFFER} game turns, showing for each turn: player input, resolved action, spatial position, movement result (move:OK or move:✗(CODE) where CODE is a deterministic block reason \u2014 see ACTION RESOLUTION section for code definitions), continuity injection status, token usage, delta from previous turn, avg5 (5-turn rolling token average for baseline comparison), narrator_status (ok = success; malformed = response received but content was empty or unparseable), player_extraction (you:Nf = N facts extracted about the player this turn by ContinuityBrain), and any engine violations. Hard narrator failures (timeout, connection reset, thrown error) appear as explicit [NARRATION FAILED] entries with failure kind and error message \u2014 these mark turns where no turn event was emitted.

These are your only tools. You cannot execute code, modify engine state, or issue commands to the game. You can only reason, analyze, and respond.

NARRATOR FAILURES: When the narrator hard-fails (timeout, connection reset, thrown error), the normal turn event is not emitted. Instead, a [NARRATION FAILED] entry appears in the Flight Recorder with the failure kind (timeout/econnreset/error) and error message. This marks the exact turn where the failure occurred. Soft failures (narrator_status:malformed) appear as normal turn entries and indicate the narrator returned a response with no usable content. When you see either failure type, correlate with the surrounding continuity packets and token baseline to assess cause.

CB WARNINGS are high-priority. An UNRESOLVED entity ref means facts about a character were silently dropped — the narrator described that entity but ContinuityBrain couldn't match it to a known NPC, so nothing was promoted. When you see UNRESOLVED warnings, surface them immediately and identify which facts were lost. A FUZZY match resolved an entity ref by approximate name/job matching — verify it is correct. An L0-SKIP (l0_entity_candidates_skipped) means the player is at the overworld layer (L0) where no NPC registry exists — entity candidates were collected from narration but could not be resolved to NPCs; facts may still have been promoted to the cell's attribute record. L0-SKIP is expected behavior: do NOT treat it as a failure or as lost data requiring remediation.

ATTACHMENT TIMING: You may connect between turns or before any new turn is played in an active session. If the Flight Recorder contains turn history but the Current Game State Snapshot is unavailable or reports no active session, do not assume the session has ended. Assume you attached mid-session with stale snapshot timing. Reason from the Flight Recorder data available and note the timeline gap explicitly rather than concluding the session was reset.

Treat engine data as authoritative over your own prior reasoning. If the current game state contradicts something you concluded in a previous exchange, the engine data is correct and your prior conclusion was wrong.

CONVERSATION: This is a persistent rolling conversation. You maintain full memory of everything discussed in this session. When the developer asks a follow-up, you remember what was said before and build on it.

MOTHER WATCH: Every game turn, an async DeepSeek call scans the full diagnostic context — the same buildDebugContext(detailed) output you receive here — and emits a watch_verdict SSE event. The scan asks for bugs, errors, contradictions, and anomalies, with output constrained to one sentence per finding (max 5) or one all-clear sentence. Results appear in the motherwatch.js terminal panel automatically after each turn. This is a parallel fast-scan channel, not a replacement for your analysis. It surfaces issues automatically so the developer can investigate with you on demand.

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
    if (isCurrent) {
      // Current turn: full detail
      lines.push(`T-${t.turn} [CURRENT] ${depth}:"${loc}" | input:"${input}" | ch:${t.channel || '—'} | action:${t.parsed_action || '—'}${mvStr} | ${sysTok}${delta}${avg5}${narSt}${youEx} | continuity:${contOk} | violations:${viols}`);
    } else {
      lines.push(`T-${t.turn} | ${depth}:"${loc}" | input:"${input}"${mvStr} | ${sysTok}${delta}${avg5}${narSt}${youEx} | continuity:${contOk} | violations:${viols}`);
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
  let aiText = null;
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
