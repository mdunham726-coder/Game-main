/**
 * motherbrain.js — Mother Brain v2.2.0
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
const MB_VERSION = '2.2.0';

const MB_VERSION_HISTORY = [
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
   - RECENT PROMOTIONS: last 10 promotion log entries — what was written to NPC/location records and what was filtered
   - MOOD TRAJECTORY: last 3 mood snapshots — tone, tension level/direction, scene focus, delta note
   - LAST NARRATIONS: the last 2 narrator outputs, each labeled "Narrator output (T-N):" — use these to trace what the narrator wrote and why specific facts were or were not extracted
   - CB EXTRACTION (last turn): compact summary of ContinuityBrain's extraction — per-entity candidates (physical_attributes, observable_states, held_or_worn_objects) with inline rejected_interpretations strings (up to 3 per entity), environmental features, spatial relations, top-level rejections
   - CB WARNINGS (last turn): entity resolution failures — UNRESOLVED means an entity ref could not be matched to any visible NPC and its facts were NOT promoted; FUZZY means a match was found via approximate matching and should be verified; L0-SKIP (l0_entity_candidates_skipped) means entity candidates were skipped because no NPC registry exists at the overworld layer (L0) — this is expected behavior, not a failure

2. FLIGHT RECORDER — TURN HISTORY: A rolling record of the last ${TURN_BUFFER} game turns, showing for each turn: player input, resolved action, spatial position, movement result, continuity injection status, token usage and delta, and any engine violations. Use this to reason about temporal patterns, causal chains, and state changes across turns.

These are your only tools. You cannot execute code, modify engine state, or issue commands to the game. You can only reason, analyze, and respond.

CB WARNINGS are high-priority. An UNRESOLVED entity ref means facts about a character were silently dropped — the narrator described that entity but ContinuityBrain couldn't match it to a known NPC, so nothing was promoted. When you see UNRESOLVED warnings, surface them immediately and identify which facts were lost. A FUZZY match resolved an entity ref by approximate name/job matching — verify it is correct. An L0-SKIP (l0_entity_candidates_skipped) means the player is at the overworld layer (L0) where no NPC registry exists — entity candidates were collected from narration but could not be resolved to NPCs; facts may still have been promoted to the cell's attribute record. L0-SKIP is expected behavior: do NOT treat it as a failure or as lost data requiring remediation.

ATTACHMENT TIMING: You may connect between turns or before any new turn is played in an active session. If the Flight Recorder contains turn history but the Current Game State Snapshot is unavailable or reports no active session, do not assume the session has ended. Assume you attached mid-session with stale snapshot timing. Reason from the Flight Recorder data available and note the timeline gap explicitly rather than concluding the session was reset.

Treat engine data as authoritative over your own prior reasoning. If the current game state contradicts something you concluded in a previous exchange, the engine data is correct and your prior conclusion was wrong.

CONVERSATION: This is a persistent rolling conversation. You maintain full memory of everything discussed in this session. When the developer asks a follow-up, you remember what was said before and build on it.

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
    const contOk = co.injected ? '✓' : (co.evicted ? 'evicted' : '✗');
    const viols  = (t.violations || []).length ? t.violations.join('; ') : 'none';

    let mvStr = '';
    if (mv) {
      mvStr = mv.valid
        ? ` | move:✓→"${String(mv.destination_name || mv.destination || '?').slice(0, 20)}"`
        : ` | move:✗(${String(mv.block_reason || '?').slice(0, 20)})`;
    }

    const isCurrent = (i === _turnBuffer.length - 1);
    if (isCurrent) {
      // Current turn: full detail
      lines.push(`T-${t.turn} [CURRENT] ${depth}:"${loc}" | input:"${input}" | ch:${t.channel || '—'} | action:${t.parsed_action || '—'}${mvStr} | ${sysTok}${delta} | continuity:${contOk} | violations:${viols}`);
    } else {
      lines.push(`T-${t.turn} | ${depth}:"${loc}" | input:"${input}"${mvStr} | ${sysTok}${delta} | continuity:${contOk} | violations:${viols}`);
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

  printLine(d(`  [T-${t.turn}]  ${depth}:${b(loc)}  │  ${c(npcs)}  │  ${sys}${dlt}  │  ${ok}`));
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
