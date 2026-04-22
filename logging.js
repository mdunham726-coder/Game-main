/**
 * logging.js — Turn-by-Turn Logging Panel (v1.67.0)
 *
 * Live: SSE-connected. Appends a structured log entry per turn (scroll style).
 *       In-memory accumulator drives live display — convenience only.
 *
 * Authority: /diagnostics/log endpoint is the SOLE source of truth.
 *   R → range re-fetch from endpoint
 *   C → copy-all re-fetch from endpoint → clipboard + file
 *   X → copy-range re-fetch from endpoint → clipboard + file
 *
 * Section names, order, and field labels match diagnostics.js exactly.
 *
 * Run standalone: node logging.js
 */

'use strict';

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const { execSync } = require('child_process');

const HOST         = 'localhost';
const PORT         = process.env.PORT || 3000;
const SSE_PATH     = '/diagnostics/stream';
const LOG_PATH     = '/diagnostics/log';
const RECONNECT_MS = 500;

// ── ANSI helpers (matching diagnostics.js) ───────────────────────────────────
const R   = '\x1b[0m';
const B   = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GRN = '\x1b[32m';
const YLW = '\x1b[33m';
const CYN = '\x1b[36m';
const MAG = '\x1b[35m';
const WHT = '\x1b[97m';

const W = Math.min(process.stdout.columns || 100, 120);

function bold(s)  { return `${B}${s}${R}`; }
function dim(s)   { return `${DIM}${s}${R}`; }
function cyan(s)  { return `${CYN}${s}${R}`; }
function amber(s) { return `${YLW}${s}${R}`; }
function grn(s)   { return `${GRN}${s}${R}`; }
function red(s)   { return `${RED}${s}${R}`; }
function mag(s)   { return `${MAG}${s}${R}`; }
function wht(s)   { return `${WHT}${s}${R}`; }
function yn(v)    { return v ? grn('YES') : red('NO'); }
function ok(v)    { return v ? grn('success') : red('FAILED'); }

// Strip ANSI for plain-text copy output
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

// Visual line-wrap at terminal width (display only — stored strings never modified)
function wrapLines(text, indent, maxW) {
  const avail = maxW - indent.length;
  const out = [];
  const raw = String(text ?? '');
  for (const line of raw.split('\n')) {
    if (line.length === 0) { out.push(''); continue; }
    let remaining = line;
    while (remaining.length > avail) {
      out.push(indent + remaining.slice(0, avail));
      remaining = remaining.slice(avail);
    }
    out.push(indent + remaining);
  }
  return out;
}

function divider(label) {
  const inner = ` ${label} `;
  const left  = 2;
  const right = Math.max(1, W - left - inner.length);
  return `${DIM}${'─'.repeat(left)}${R}${bold(inner)}${DIM}${'─'.repeat(right)}${R}`;
}

function field(label, value, labelW = 24) {
  const lbl = (label + ' ').padEnd(labelW, ' ');
  const val = value === null || value === undefined ? dim('—') : wht(String(value));
  return `  ${DIM}${lbl}${R}${val}`;
}

function nullOr(v) {
  return (v === null || v === undefined) ? '—' : String(v);
}

// ── Format one turn entry as display lines ────────────────────────────────────
// Sections and field labels match diagnostics.js exactly.
function formatEntry(t) {
  const lines = [];
  const push  = (...ss) => ss.forEach(s => lines.push(s));

  const ts = t.timestamp ? new Date(t.timestamp).toLocaleString() : '—';
  push('');
  push(bold(`${'═'.repeat(W)}`));
  push(bold(`  === TURN ${t.turn_number ?? '?'} | ${ts} ===`));
  push(bold(`${'═'.repeat(W)}`));
  push('');

  // ── PARSER / INPUT ─────────────────────────────────────────────────────────
  push(divider('PARSER / INPUT'));
  push(field('Channel',       t.channel));
  push(field('Raw Input',     t.raw_input));
  push(field('Parsed Action', t.parsed_action));
  push(field('Parsed Dir',    t.parsed_dir));
  push(field('Intent Source', t.parsed_intent_source));
  push('');

  // ── SPATIAL ───────────────────────────────────────────────────────────────
  push(divider('SPATIAL'));
  const sp = t.spatial || {};
  const depthLabel = ['—', 'OVERWORLD', 'SITE', 'LOCAL'][sp.depth ?? 0] || String(sp.depth ?? '—');
  const pos = sp.position
    ? `mx:${sp.position.mx ?? '?'} my:${sp.position.my ?? '?'} / lx:${sp.position.lx ?? '?'} ly:${sp.position.ly ?? '?'}`
    : '—';
  push(field('Depth',       depthLabel));
  push(field('Position',    pos));
  push(field('Site',        sp.site_name));
  push(field('Local Space', sp.local_space_name));
  push('');

  // ── MOVEMENT ──────────────────────────────────────────────────────────────
  push(divider('MOVEMENT'));
  const mv = t.movement;
  if (mv) {
    push(field('Direction',   mv.direction));
    push(field('Destination', mv.destination_name ?? mv.destination));
    push(field('Valid',       mv.valid !== undefined ? (mv.valid ? 'YES' : 'NO') : '—'));
    if (mv.block_reason) push(field('Block Reason', mv.block_reason));
  } else {
    push(dim('  no movement this turn'));
  }
  push('');

  // ── CONTINUITY ────────────────────────────────────────────────────────────
  push(divider('CONTINUITY'));
  const co = t.continuity || {};
  push(field('Injected',         co.injected !== null ? (co.injected ? 'YES' : 'NO') : '—'));
  push(field('block_chars',      nullOr(co.block_chars)));
  push(field('Evicted',          co.evicted !== null ? (co.evicted ? 'YES' : 'NO') : '—'));
  push(field('Extraction',       co.extraction_success !== null ? ok(co.extraction_success) : dim('—')));
  if (co.rejection_reason) push(field('Rejection Reason', co.rejection_reason));
  push(field('History Block',    co.extraction_packet_present ? 'present' : 'empty'));
  if (co.alerts && co.alerts.length) {
    push(`  ${amber('Alerts:')}`)
    co.alerts.forEach(a => {
      const label = a?.type ? `[${a.type}] ${a.description ?? ''}` : String(a);
      push(`    ${amber('⚠')} ${amber(label.slice(0, W - 6))}`);
    });
  } else {
    push(field('Alerts',         'none'));
  }
  push(field('Entity Updates',   (co.entity_updates || []).join(', ') || 'none'));
  push(field('Entity Cleared',   (co.entity_cleared  || []).join(', ') || 'none'));
  push('');

  // ── DM NOTE ───────────────────────────────────────────────────────────────
  push(divider('DM NOTE'));
  const dmStatus = t.dm_note_status ?? '—';
  const dmStatusLabel = dmStatus === 'updated'           ? grn('updated')
                      : dmStatus === 'preserved_missing' ? red('preserved_missing')
                      : dmStatus === 'new_game'          ? amber('new_game')
                      : dim(dmStatus);
  push(field('Status', dmStatusLabel));
  push(`  ${dim('Note:')}`)
  if (t.dm_note_archived) {
    // Visual wrap only — raw string is what is in dm_note_archived; display wrap does not touch stored content
    wrapLines(t.dm_note_archived, '    ', W).forEach(l => push(l));
  } else {
    push(dim('    (none)'));
  }
  push('');

  // ── NARRATION ─────────────────────────────────────────────────────────────
  push(divider('NARRATION'));
  const narText = t.narrative ?? '';
  push(field('Length', `${narText.length}ch`));
  wrapLines(narText, '  ', W).forEach(l => push(l));
  push('');

  // ── ENTITIES ──────────────────────────────────────────────────────────────
  push(divider('ENTITIES'));
  const ents = t.entities_visible || [];
  if (ents.length) {
    ents.forEach(e => {
      const label = e.npc_name ? `${e.npc_name} (${e.id})` : (e.id || '?');
      push(`  ${cyan(label)}${e.job_category ? dim(` [${e.job_category}]`) : ''}`);
    });
  } else {
    push(dim('  none visible'));
  }
  push('');

  // ── ENGINE MESSAGE ────────────────────────────────────────────────────────
  if (t.engine_message) {
    push(divider('ENGINE MESSAGE'));
    push(`  ${amber(String(t.engine_message).slice(0, W - 4))}`);
    push('');
  }

  // ── VIOLATIONS ────────────────────────────────────────────────────────────
  push(divider('VIOLATIONS'));
  const viol = t.violations || [];
  if (viol.length) {
    viol.forEach(v => push(`  ${red('✗')} ${red(v)}`));
  } else {
    push(`  ${grn('✓ no violations')}`);
  }
  push('');

  // ── TOKENS — all fields; any null/absent renders as — ────────────────────
  // Note: token data is not stored per-turn in turn_history.
  // Tokens are available from SSE payload only. This section shows — for all fields
  // when accessing via endpoint (range/copy). Live display fills from SSE below.
  push(divider('TOKENS'));
  const tok = t._tokens || {};  // populated by SSE live path; absent for endpoint-fetched entries
  const fmtTok = n => n != null ? `${Number(n).toLocaleString()}tok` : '—';
  push(field('Narrator',     `prompt:${nullOr(tok.narrator?.prompt)}  compl:${nullOr(tok.narrator?.completion)}  total:${fmtTok(tok.narrator?.total)}`));
  push(field('Parser',       `total:${fmtTok(tok.parser?.total)}  cached:${tok._parser_cached !== undefined ? (tok._parser_cached ? 'YES' : 'no') : '—'}`));
  push(field('System Total', `${fmtTok(tok.system_total)}  Δ${nullOr(tok.delta)}  avg5:${nullOr(tok.avg5)}`));
  const bd = tok.breakdown || {};
  push(field('Breakdown',    `base:${nullOr(bd.base_chars)}ch  cont:${nullOr(bd.continuity_chars)}ch  spatial:${nullOr(bd.spatial_chars)}ch  out:${nullOr(bd.output_chars)}ch`));
  push('');

  return lines;
}

// ── In-memory accumulator (live display convenience only) ─────────────────────
// Contains: { turn_number, display_lines[], plain_text (for copy) }
const _liveTurns = [];

function appendEntry(t) {
  const displayLines = formatEntry(t);
  _liveTurns.push({ turn_number: t.turn_number, display_lines: displayLines });
  process.stdout.write(displayLines.join('\n') + '\n');
  printFooter();
}

function printFooter() {
  const ts = new Date().toLocaleTimeString();
  process.stdout.write(dim(`  [R] range  [C] copy all  [X] copy range  Ctrl+C exit  │  last updated ${ts}`) + '\n');
}

// ── HTTP helper ───────────────────────────────────────────────────────────────
function httpGet(urlPath, cb) {
  const req = http.get({ host: HOST, port: PORT, path: urlPath }, res => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', c => { buf += c; });
    res.on('end', () => {
      try { cb(null, JSON.parse(buf)); }
      catch (e) { cb(e); }
    });
  });
  req.on('error', cb);
  req.end();
}

// ── Write files + clipboard (authority: endpoint) ─────────────────────────────
function copyAndSave(turns, label) {
  // Build plain-text log from endpoint data (raw stored strings — no display transform applied)
  const lines = [];
  for (const t of turns) {
    const fmtLines = formatEntry(t);
    fmtLines.forEach(l => lines.push(stripAnsi(l)));
  }
  const text = lines.join('\n');

  // Write file
  const logsDir = path.join(__dirname, 'logs');
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `log_${label}_${ts}.txt`;
  const filepath = path.join(logsDir, filename);
  fs.writeFileSync(filepath, text, 'utf8');

  // Clipboard via clip (Windows)
  try {
    const { execSync } = require('child_process');
    execSync('clip', { input: text });
  } catch (e) {
    process.stdout.write(red(`  ✗ Clipboard write failed: ${e.message}\n`));
    process.stdout.write(dim(`  File saved: ${filepath}\n`));
    return;
  }

  process.stdout.write(grn(`  ✓ Copied to clipboard and saved to logs/${filename}\n`));
}

// ── Range prompt helper ───────────────────────────────────────────────────────
function promptRange(onResult) {
  // Temporarily leave raw mode for line input
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdout.write(dim('  Enter range (e.g. 5-10 or 5): '));
  let input = '';
  const onData = chunk => {
    input += chunk;
    if (input.includes('\n') || input.includes('\r')) {
      process.stdin.removeListener('data', onData);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
        process.stdin.setEncoding('utf8');
      }
      const trimmed = input.replace(/[\r\n]/g, '').trim();
      const match = trimmed.match(/^(\d+)(?:-(\d+))?$/);
      if (!match) {
        process.stdout.write(red(`  Invalid range: "${trimmed}"\n`));
        onResult(null, null);
      } else {
        onResult(parseInt(match[1], 10), match[2] ? parseInt(match[2], 10) : parseInt(match[1], 10));
      }
    }
  };
  process.stdin.on('data', onData);
}

// ── Keypress handler ─────────────────────────────────────────────────────────
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  process.stdin.on('data', key => {
    if (key === '\u0003') { process.exit(); } // Ctrl+C

    // [R] — range display (re-fetch from endpoint)
    if (key === 'r' || key === 'R') {
      promptRange((from, to) => {
        if (from === null) return;
        let urlPath = `${LOG_PATH}?from=${from}&to=${to}`;
        httpGet(urlPath, (err, data) => {
          if (err || data.no_data) {
            process.stdout.write(red(`  ✗ Fetch failed: ${err?.message || data?.reason || 'no data'}\n`));
            return;
          }
          process.stdout.write(dim(`\n  ── Range T-${from} to T-${to} (${data.turns.length} entries) ──\n`));
          data.turns.forEach(t => {
            const displayLines = formatEntry(t);
            process.stdout.write(displayLines.join('\n') + '\n');
          });
          printFooter();
        });
      });
    }

    // [C] — copy all (re-fetch full session from endpoint)
    if (key === 'c' || key === 'C') {
      httpGet(LOG_PATH, (err, data) => {
        if (err || data.no_data) {
          process.stdout.write(red(`  ✗ Fetch failed: ${err?.message || data?.reason || 'no data'}\n`));
          return;
        }
        const first = data.turns[0]?.turn_number ?? 1;
        const last  = data.turns[data.turns.length - 1]?.turn_number ?? 1;
        copyAndSave(data.turns, `turn${first}-${last}`);
      });
    }

    // [X] — copy range (re-fetch from endpoint)
    if (key === 'x' || key === 'X') {
      promptRange((from, to) => {
        if (from === null) return;
        httpGet(`${LOG_PATH}?from=${from}&to=${to}`, (err, data) => {
          if (err || data.no_data) {
            process.stdout.write(red(`  ✗ Fetch failed: ${err?.message || data?.reason || 'no data'}\n`));
            return;
          }
          copyAndSave(data.turns, `turn${from}-${to}`);
        });
      });
    }
  });
}

// ── SSE connection — live display ─────────────────────────────────────────────
function connect() {
  process.stdout.write(`${DIM}[logging] connecting to http://${HOST}:${PORT}${SSE_PATH}…${R}\n`);

  const req = http.get({ host: HOST, port: PORT, path: SSE_PATH, headers: { Accept: 'text/event-stream' } }, res => {
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);

    if (res.statusCode !== 200) {
      process.stdout.write(`${RED}[logging] HTTP ${res.statusCode} — retry in ${RECONNECT_MS}ms${R}\n`);
      res.resume();
      setTimeout(connect, RECONNECT_MS);
      return;
    }

    process.stdout.write(`${GRN}[logging] connected — waiting for turns…${R}\n`);
    printFooter();
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
          try { payload = JSON.parse(line.slice(5).trim()); }
          catch (e) { process.stdout.write(`${RED}[PARSE ERR] ${e.message}${R}\n`); continue; }
          if (payload.type !== 'turn') continue;

          // Build a turn entry from SSE payload fields
          // Token data only available via SSE — attach under _tokens for formatEntry
          const t = {
            turn_number:          payload.turn,
            timestamp:            new Date().toISOString(),
            channel:              payload.channel,
            raw_input:            payload.raw_input,
            parsed_action:        payload.parsed_action,
            parsed_dir:           payload.parsed_dir,
            parsed_intent_source: payload.parser,
            spatial:              payload.spatial,
            movement:             payload.movement,
            continuity: {
              injected:               payload.continuity?.injected ?? null,
              block_chars:            payload.continuity?.block_chars ?? null,
              evicted:                payload.continuity?.evicted ?? null,
              extraction_success:     payload.continuity?.extraction_success ?? null,
              rejection_reason:       payload.continuity?.rejection_reason ?? null,
              extraction_packet_present: null, // not in SSE payload
              alerts:                 payload.continuity?.alerts ?? [],
              entity_updates:         payload.continuity?.entity_updates ?? [],
              entity_cleared:         payload.continuity?.entity_cleared ?? [],
            },
            // DM note is NOT in SSE payload — will show — for live display.
            // Authoritative values available via endpoint (R/C/X).
            dm_note_archived: null,
            dm_note_status:   null,
            narrative:        null,   // not in SSE payload
            engine_message:   payload.engine_message ?? null,
            entities_visible: payload.entities?.visible ?? [],
            violations:       payload.violations ?? [],
            _tokens: {
              narrator:       payload.tokens?.narrator,
              parser:         payload.tokens?.parser,
              system_total:   payload.tokens?.system_total,
              delta:          payload.tokens?.delta,
              avg5:           payload.tokens?.avg5,
              breakdown:      payload.tokens?.breakdown,
              _parser_cached: payload.parser === null || payload.parser === 'cached',
            }
          };

          appendEntry(t);
        }
      }
    });

    res.on('end', () => {
      process.stdout.write(`\n${YLW}[logging] stream ended — reconnecting in ${RECONNECT_MS}ms…${R}\n`);
      setTimeout(connect, RECONNECT_MS);
    });
    res.on('error', err => {
      process.stdout.write(`\n${RED}[logging] stream error: ${err.message}${R}\n`);
      setTimeout(connect, RECONNECT_MS);
    });
  });

  req.on('error', err => {
    process.stdout.write(`${RED}[logging] connection failed: ${err.message} — retry in ${RECONNECT_MS}ms${R}\n`);
    setTimeout(connect, RECONNECT_MS);
  });
  req.end();
}

connect();
