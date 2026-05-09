/**
 * cbpanel.js — ContinuityBrain Interactive Panel v1.0.0
 * Live SSE panel with 4 inspectable views of continuity extraction + promotion state.
 *
 * Views:
 *   [T] Turn View    — extraction candidates, warnings, promotions, source narration
 *   [P] Promotion Log — chronological stream of all promotions/filters
 *   [E] Entity View  — current promoted attributes per visible NPC + site
 *   [X] Explain This — DeepSeek explanation of last turn's extraction behavior
 *
 * Launch: node cbpanel.js
 * Hotkey from diagnostics.js: [B]
 */

'use strict';

const http  = require('http');
const axios = require('axios');

const HOST         = 'localhost';
const PORT         = 3000;
const SSE_PATH     = '/diagnostics/stream';
const CTX_PATH     = '/diagnostics/continuity';
const RECONNECT_MS = 1000;
const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions';
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || '';

// ── ANSI helpers ───────────────────────────────────────────────────────────────
const R   = '\x1b[0m';
const B   = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GRN = '\x1b[32m';
const AMB = '\x1b[33m';
const BLU = '\x1b[34m';
const CYN = '\x1b[36m';
const WHT = '\x1b[37m';

function clr()   { process.stdout.write('\x1b[H\x1b[2J\x1b[3J'); }
function bold(s) { return `${B}${s}${R}`; }
function dim(s)  { return `${DIM}${s}${R}`; }
function red(s)  { return `${RED}${s}${R}`; }
function grn(s)  { return `${GRN}${s}${R}`; }
function amb(s)  { return `${AMB}${s}${R}`; }
function cyn(s)  { return `${CYN}${s}${R}`; }

const W = () => process.stdout.columns || 100;

function divider(label) {
  if (!label) return `${DIM}${'─'.repeat(W())}${R}`;
  const inner = ` ${label} `;
  const side  = Math.max(2, Math.floor((W() - inner.length) / 2));
  return `${DIM}${'─'.repeat(side)}${R}${B}${inner}${R}${DIM}${'─'.repeat(Math.max(0, W() - side - inner.length))}${R}`;
}

// ── State ──────────────────────────────────────────────────────────────────────
let _activeView       = 'T';    // T | P | E | X
let _entityIndex      = 0;      // cycling index for Entity View
let _lastData         = null;   // last fetched /diagnostics/continuity payload
let _explanationText  = null;   // last Explain This result
let _explaining       = false;  // true while DeepSeek call in flight
let _reconnectPending = false;

// ── HTTP fetch ─────────────────────────────────────────────────────────────────
function fetchAndRender() {
  const req = http.get(
    { host: HOST, port: PORT, path: CTX_PATH },
    res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try {
          const data = JSON.parse(raw);
          if (!data.no_data) _lastData = data;
        } catch (_) {}
        render();
      });
    }
  );
  req.on('error', () => { render(); });
  req.end();
}

// ── Render dispatcher ──────────────────────────────────────────────────────────
function render() {
  const lines = [];
  const push  = s => lines.push(s);

  const VIEW_LABELS = { T: 'TURN VIEW', P: 'PROMOTION LOG', E: 'ENTITY VIEW', X: 'EXPLAIN THIS' };
  const title    = `  CONTINUITY BRAIN PANEL  —  ${VIEW_LABELS[_activeView]}  `;
  const ts       = new Date().toLocaleTimeString();
  const turnStr  = _lastData ? `T-${_lastData.turn}` : '—';
  const pad      = Math.max(0, W() - 4 - ts.length - turnStr.length);

  push(`${B}${BLU}╔${'═'.repeat(W() - 2)}╗${R}`);
  push(`${B}${BLU}║${R}${cyn(title.padEnd(pad))}${dim(turnStr)}  ${dim(ts)}  ${B}${BLU}║${R}`);
  push(`${B}${BLU}╚${'═'.repeat(W() - 2)}╝${R}`);
  push('');

  if (!_lastData) {
    push(dim('  waiting for first turn — start the game and take an action…'));
    push('');
  } else {
    if      (_activeView === 'T') renderTurnView(push);
    else if (_activeView === 'P') renderPromotionLog(push);
    else if (_activeView === 'E') renderEntityView(push);
    else if (_activeView === 'X') renderExplainView(push);
  }

  // Footer
  const vi = ['T','P','E','X'].map(v => v === _activeView ? `${B}[${v}]${R}` : dim(`[${v}]`));
  push(dim(`  ${vi[0]} turn  ${vi[1]} promotions  ${vi[2]} entities  ${vi[3]} explain  ${dim('[Tab]')} cycle entities  Ctrl+C exit`));

  clr();
  process.stdout.write(lines.join('\n') + '\n');
}

// ── Turn View ──────────────────────────────────────────────────────────────────
function renderTurnView(push) {
  const d          = _lastData;
  const extraction = d.extraction_packet;
  const diag       = d.cb_diagnostics;
  const narrations = d.last_narrations || [];

  // Narrator output
  push(divider('NARRATOR OUTPUT'));
  if (narrations.length === 0) {
    push(dim('  (no narrations archived)'));
  } else {
    for (const n of narrations) {
      const text = (n.narrative || '').slice(0, 400);
      const ell  = (n.narrative || '').length > 400 ? '…' : '';
      push(`  ${dim(`T-${n.turn_number}:`)} ${WHT}${text}${ell}${R}`);
      push('');
    }
  }

  // Extraction candidates
  push(divider('EXTRACTION CANDIDATES'));
  if (!extraction) {
    push(dim('  (no extraction data for last turn)'));
    push('');
  } else {
    const candidates = extraction.entity_candidates       || [];
    const envBlocks  = extraction.environmental_features  || [];
    const spatial    = extraction.spatial_relations       || [];
    const topRej     = extraction.rejected_interpretations || [];
    const envCount   = envBlocks.reduce((s, b) => s + (b.features || []).length, 0);

    push(dim(`  candidates:${candidates.length}  env_features:${envCount}  spatial:${spatial.length}  top_rejected:${topRej.length}`));
    push('');

    for (const cand of candidates) {
      const ref  = cand.entity_ref              || '?';
      const pa   = cand.physical_attributes     || [];
      const os   = cand.observable_states       || [];
      const held = cand.held_objects            || [];
      const worn = cand.worn_objects            || [];
      const rej  = cand.rejected_interpretations || [];

      push(`  ${bold(cyn(ref))}`);
      if (pa.length   > 0) push(`    ${dim('physical:')}   ${pa.join('  │  ')}`);
      if (os.length   > 0) push(`    ${dim('states:')}     ${os.join('  │  ')}`);
      if (held.length > 0) push(`    ${dim('held:')}       ${held.join('  │  ')}`);
      if (worn.length > 0) push(`    ${dim('worn:')}       ${worn.join('  │  ')}`);
      if (rej.length  > 0) push(`    ${dim('rejected:')}   ${amb(rej.join('  │  '))}`);

      push('');
    }

    if (topRej.length > 0) {
      push(dim('  top-level rejections:'));
      topRej.forEach(r => push(`    ${amb('✗')} ${amb(r)}`));
      push('');
    }

    if (spatial.length > 0) {
      push(dim('  spatial relations:'));
      spatial.forEach(s => push(`    ${dim('→')} ${s}`));
      push('');
    }

    for (const eb of envBlocks) {
      if ((eb.features || []).length > 0) {
        push(dim(`  [${eb.location_ref || 'location'}] features: ${eb.features.join('  │  ')}`));
      }
    }
    if (envCount > 0) push('');
  }

  // Warnings
  push(divider('WARNINGS'));
  const warnings = diag?.warnings || [];
  if (warnings.length === 0) {
    push(`  ${grn('✓')} ${dim('none — all entity refs resolved cleanly')}`);
  } else {
    for (const w of warnings) {
      if (w.type === 'unresolved_entity_ref') {
        push(`  ${red('UNRESOLVED')} "${w.entity_ref}" — facts NOT promoted (no NPC match)`);
      } else if (w.type === 'fuzzy_entity_ref') {
        push(`  ${amb('FUZZY')} "${w.entity_ref}" → resolved to "${w.resolved_to}" — verify correctness`);
      } else if (w.type === 'l0_entity_candidates_skipped') {
        push(`  ${amb('L0-SKIP')}  ${w.count} candidate(s) — no NPC registry at overworld (L0)  [${(w.entities || []).join(', ')}]`);
      } else {
        push(`  ${amb(w.type)}: ${JSON.stringify(w)}`);
      }
    }
  }
  push('');

  // Promotions this turn
  push(divider('PROMOTIONS THIS TURN'));
  if (diag) {
    push(dim(`  promoted:${diag.promoted_count || 0}  filtered:${diag.rejected_filter_count || 0}  candidates:${diag.entity_candidates_count || 0}  mood:${diag.mood_captured ? 'captured' : 'none'}`));
  }
  const promoLog     = d.promotion_log_recent || [];
  const thisTurnLogs = promoLog.filter(e => e.turn === d.turn);
  if (thisTurnLogs.length === 0) {
    push(dim('  (no promotion entries for this turn)'));
  } else {
    for (const e of thisTurnLogs) {
      if (e.action === 'create') {
        push(`  ${grn('+')} ${cyn(e.entity_name || e.entity_id)} ${dim('→')} ${e.attribute} = ${B}"${e.new_value}"${R}`);
      } else if (e.action === 'rejected_filter') {
        push(`  ${red('✗')} ${dim(e.entity_id)} ${e.bucket}:"${e.value}" ${dim(`(${e.reason})`)}`);
      }
    }
  }
  push('');
}

// ── Promotion Log ──────────────────────────────────────────────────────────────
function renderPromotionLog(push) {
  const log = _lastData.promotion_log_recent || [];

  push(divider('PROMOTION LOG  (last 20 entries — chronological)'));
  push('');

  if (log.length === 0) {
    push(dim('  (no promotions recorded yet)'));
    push('');
    return;
  }

  for (const e of log) {
    if (e.action === 'create') {
      const entity = e.entity_name || e.entity_id || '?';
      push(`  ${dim(`[T-${e.turn}]`)} ${grn('+')} ${cyn(entity)} ${dim('→')} ${bold(e.attribute)} = ${B}"${e.new_value}"${R}`);
    } else if (e.action === 'rejected_filter') {
      push(`  ${dim(`[T-${e.turn}]`)} ${red('✗')} FILTERED ${dim(e.entity_id)} ${e.bucket}:"${e.value}" ${dim(`(${e.reason})`)}`);
    } else {
      push(`  ${dim(`[T-${e.turn}]`)} ${dim(JSON.stringify(e))}`);
    }
  }
  push('');
}

// ── Entity View ────────────────────────────────────────────────────────────────
function renderEntityView(push) {
  const d        = _lastData;
  const npcMap   = d.visible_npc_attributes || {};
  const siteAttr = d.site_attributes        || {};
  const playerAt = d.player_attributes      || null;

  const allEntities = [];

  // Player slot first
  if (playerAt) {
    allEntities.push({
      key:        '__player__',
      label:      'YOU',
      attributes: playerAt.attributes || {},
      isSite:     false,
      isPlayer:   true
    });
  }

  // NPCs
  for (const k of Object.keys(npcMap)) {
    allEntities.push({
      key:        k,
      label:      npcMap[k].label,
      attributes: npcMap[k].attributes || {},
      isSite:     false,
      isPlayer:   false
    });
  }

  const hasSite = siteAttr.name || Object.keys(siteAttr.attributes || {}).length > 0;
  if (hasSite) {
    allEntities.push({
      key:        '__site__',
      label:      siteAttr.name || 'location',
      attributes: siteAttr.attributes || {},
      isSite:     true,
      isPlayer:   false
    });
  }

  if (allEntities.length === 0) {
    push(dim('  (no visible entities at current position)'));
    push('');
    return;
  }

  if (_entityIndex >= allEntities.length) _entityIndex = 0;
  const current = allEntities[_entityIndex];

  // Nav bar
  const nav = allEntities.map((e, i) =>
    i === _entityIndex ? `${B}${CYN}[${e.label}]${R}` : dim(`[${e.label}]`)
  ).join('  ');
  push(`  ${dim('Entity:')} ${nav}  ${dim('— [Tab] to cycle')}`);
  push('');

  push(divider(current.isPlayer ? 'YOU (PLAYER)' : current.isSite ? `LOCATION: ${current.label}` : `NPC: ${current.label}`));
  push('');

  const attrs = Object.values(current.attributes);
  if (attrs.length === 0) {
    push(dim('  (no promoted facts yet)'));
  } else {
    const bucketW = Math.max(...attrs.map(a => (a.bucket || '').length), 8);
    push(`  ${dim(('BUCKET').padEnd(bucketW + 2))}${'VALUE'.padEnd(40)}${'SET'}`);
    push(dim(`  ${'─'.repeat(bucketW + 50)}`));
    for (const a of attrs) {
      const bucket  = (a.bucket || '—').padEnd(bucketW + 2);
      const value   = (a.value  || '—').slice(0, 38).padEnd(40);
      const turnTag = a.turn_set != null ? dim(`T-${a.turn_set}`) : dim('—');
      push(`  ${cyn(bucket)}${WHT}${value}${R}  ${turnTag}`);
    }
  }
  push('');
  push(dim(`  ${_entityIndex + 1} of ${allEntities.length} entities`));
  push('');
}

// ── Explain This — view ────────────────────────────────────────────────────────
function renderExplainView(push) {
  push(divider('EXPLAIN THIS — LAST TURN EXTRACTION'));
  push('');

  if (_explaining) {
    push(`  ${amb('⟳  Calling DeepSeek…')}`);
    push('');
    return;
  }

  if (!_explanationText) {
    push(dim('  Press [X] to call DeepSeek and explain the last turn extraction.'));
    push(dim('  Context sent: extraction_packet + cb_diagnostics + visible_npc_attributes + last narrations.'));
    push('');
    return;
  }

  // Word-wrap explanation
  const width = W() - 4;
  const paragraphs = _explanationText.split('\n');
  for (const para of paragraphs) {
    if (para.trim() === '') { push(''); continue; }
    const words = para.split(' ');
    let line = '  ';
    for (const word of words) {
      if (line.length + word.length + 1 > width && line.trim().length > 0) {
        push(line);
        line = '  ';
      }
      line += (line === '  ' ? '' : ' ') + word;
    }
    if (line.trim()) push(line);
  }

  push('');
  push(dim('  [X] to refresh explanation'));
  push('');
}

// ── Explain This — DeepSeek call ───────────────────────────────────────────────
async function runExplainThis() {
  if (!DEEPSEEK_KEY) {
    _explanationText = 'DEEPSEEK_API_KEY not set. Launch via StartMotherBrain.bat or set env var before running.';
    _explaining      = false;
    render();
    return;
  }
  if (!_lastData) {
    _explanationText = 'No continuity data available. Play at least one turn first.';
    _explaining      = false;
    render();
    return;
  }

  _explaining      = true;
  _explanationText = null;
  render();

  const d = _lastData;
  const extraction = d.extraction_packet;
  const diag       = d.cb_diagnostics;
  const npcMap     = d.visible_npc_attributes || {};
  const siteAttr   = d.site_attributes        || {};
  const narrations = d.last_narrations        || [];

  // Assemble context for DeepSeek
  let ctx = '';

  ctx += 'NARRATOR OUTPUT:\n';
  if (narrations.length === 0) {
    ctx += '  (none available)\n';
  } else {
    for (const n of narrations) {
      const text = (n.narrative || '').slice(0, 400);
      const ell  = (n.narrative || '').length > 400 ? '…' : '';
      ctx += `  Narrator output (T-${n.turn_number}): ${text}${ell}\n`;
    }
  }
  ctx += '\n';

  ctx += 'EXTRACTION RESULTS:\n';
  if (!extraction) {
    ctx += '  (no extraction packet available)\n';
  } else {
    for (const cand of (extraction.entity_candidates || [])) {
      ctx += `  Entity: ${cand.entity_ref || '?'}\n`;
      if ((cand.physical_attributes     || []).length > 0) ctx += `    physical_attributes: ${cand.physical_attributes.join(', ')}\n`;
      if ((cand.observable_states       || []).length > 0) ctx += `    observable_states: ${cand.observable_states.join(', ')}\n`;
      if ((cand.held_objects            || []).length > 0) ctx += `    held_objects: ${cand.held_objects.join(', ')}\n`;
      if ((cand.worn_objects            || []).length > 0) ctx += `    worn_objects: ${cand.worn_objects.join(', ')}\n`;
      if ((cand.rejected_interpretations|| []).length > 0) ctx += `    rejected_interpretations: ${cand.rejected_interpretations.join(' | ')}\n`;
    }
    const topRej = extraction.rejected_interpretations || [];
    if (topRej.length > 0) ctx += `  top-level rejected: ${topRej.join(' | ')}\n`;
    const spatial = extraction.spatial_relations || [];
    if (spatial.length > 0) ctx += `  spatial relations: ${spatial.join(' | ')}\n`;
  }
  ctx += '\n';

  ctx += 'PROMOTION DIAGNOSTICS:\n';
  if (diag) {
    ctx += `  promoted:${diag.promoted_count || 0}  filtered:${diag.rejected_filter_count || 0}  candidates:${diag.entity_candidates_count || 0}  mood_captured:${diag.mood_captured}\n`;
    const warnings = diag.warnings || [];
    if (warnings.length > 0) {
      ctx += '  warnings:\n';
      for (const w of warnings) {
        if (w.type === 'unresolved_entity_ref') ctx += `    UNRESOLVED: "${w.entity_ref}" — facts NOT promoted\n`;
        else if (w.type === 'fuzzy_entity_ref') ctx += `    FUZZY: "${w.entity_ref}" → resolved to "${w.resolved_to}"\n`;
        else if (w.type === 'l0_entity_candidates_skipped') ctx += `    L0-SKIP: ${w.count} entity candidate(s) skipped — no NPC registry at overworld (L0)\n`;
        else ctx += `    ${w.type}: ${JSON.stringify(w)}\n`;
      }
    } else {
      ctx += '  warnings: none\n';
    }
  } else {
    ctx += '  (no diagnostics available)\n';
  }
  ctx += '\n';

  ctx += 'CURRENT ENTITY STATE (post-promotion):\n';
  for (const [, npc] of Object.entries(npcMap)) {
    const attrs = Object.values(npc.attributes || {});
    if (attrs.length > 0) {
      ctx += `  ${npc.label}: ${attrs.map(a => `${a.bucket}:${a.value} (T-${a.turn_set ?? '?'})`).join(', ')}\n`;
    } else {
      ctx += `  ${npc.label}: (no promoted facts yet)\n`;
    }
  }
  if (hasSiteData(siteAttr)) {
    const locAttrs = Object.values(siteAttr.attributes || {}).map(a => a.value).join(', ') || '(none)';
    ctx += `  [${siteAttr.name || 'location'}]: ${locAttrs}\n`;
  }

  const systemPrompt =
    `You are a continuity analysis assistant for a turn-based AI game engine. ` +
    `The developer will show you extraction and promotion results from a single game turn. ` +
    `Explain clearly what happened: what was extracted, what was promoted, what was filtered and why, ` +
    `and whether any warnings need attention. Be concise, grounded, and specific. Do not pad your response.`;

  const userMsg =
    `[TURN EXTRACTION DATA]\n${ctx}\n` +
    `[DEVELOPER REQUEST]\n` +
    `Explain what happened in this turn's extraction and promotion pass. ` +
    `What was captured? What was filtered and why? Any warnings I should act on?`;

  async function callDeepSeek() {
    const resp = await axios.post(
      DEEPSEEK_URL,
      { model: 'deepseek-chat', messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMsg }], temperature: 0.3, max_tokens: 1000 },
      { headers: { Authorization: `Bearer ${DEEPSEEK_KEY}`, 'Content-Type': 'application/json' }, timeout: 60000 }
    );
    return resp?.data?.choices?.[0]?.message?.content || '(no response)';
  }

  try {
    _explanationText = await callDeepSeek();
  } catch (err) {
    if (err.code === 'ECONNRESET') {
      try { _explanationText = await callDeepSeek(); }
      catch (err2) { _explanationText = `DeepSeek error: ${err2.message}`; }
    } else {
      _explanationText = `DeepSeek error: ${err.message}`;
    }
  }

  _explaining = false;
  render();
}

function hasSiteData(siteAttr) {
  return siteAttr.name || Object.keys(siteAttr.attributes || {}).length > 0;
}

// ── SSE client ──────────────────────────────────────────────────────────────────
function scheduleReconnect() {
  if (_reconnectPending) return;
  _reconnectPending = true;
  setTimeout(() => { _reconnectPending = false; connectSSE(); }, RECONNECT_MS);
}

function connectSSE() {
  const req = http.get(
    { host: HOST, port: PORT, path: SSE_PATH, headers: { Accept: 'text/event-stream' } },
    res => {
      req.socket.setTimeout(0);
      req.socket.setNoDelay(true);
      if (res.statusCode !== 200) {
        res.resume();
        scheduleReconnect();
        return;
      }
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', chunk => {
        buf += chunk;
        const parts = buf.split('\n\n');
        buf = parts.pop();
        for (const block of parts) {
          for (const line of block.split('\n')) {
            if (!line.startsWith('data:')) continue;
            let payload;
            try { payload = JSON.parse(line.slice(5).trim()); } catch (_) { continue; }
            if (payload.type !== 'turn') continue;
            fetchAndRender();
          }
        }
      });
      res.on('end',   () => { scheduleReconnect(); });
      res.on('error', () => { scheduleReconnect(); });
    }
  );
  req.on('error', () => { scheduleReconnect(); });
  req.end();
}

// ── Hotkeys ────────────────────────────────────────────────────────────────────
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', key => {
    if (key === '\u0003') { process.exit(); }
    if (key === 't' || key === 'T') { _activeView = 'T'; render(); }
    if (key === 'p' || key === 'P') { _activeView = 'P'; render(); }
    if (key === 'e' || key === 'E') { _activeView = 'E'; render(); }
    if (key === 'x' || key === 'X') { _activeView = 'X'; runExplainThis(); }
    if (key === '\t') {
      // Tab -- cycle entities (works in any view, switches to Entity View)
      const npcMap    = _lastData?.visible_npc_attributes || {};
      const siteAttr  = _lastData?.site_attributes        || {};
      const playerAt  = _lastData?.player_attributes      || null;
      const total     = (playerAt ? 1 : 0) + Object.keys(npcMap).length + (hasSiteData(siteAttr) ? 1 : 0);
      if (total > 0) {
        _activeView  = 'E';
        _entityIndex = (_entityIndex + 1) % total;
        render();
      }
    }
  });
}

// ── Boot ───────────────────────────────────────────────────────────────────────
connectSSE();
fetchAndRender(); // immediate render on startup if server already has data
