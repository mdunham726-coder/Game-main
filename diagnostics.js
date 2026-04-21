/**
 * diagnostics.js — CMD Flight Recorder for the Dungeon Master Engine
 * Connects to /diagnostics/stream (SSE) and redraws the terminal every turn.
 * Run standalone: node diagnostics.js
 */

'use strict';

const http = require('http');

const HOST = 'localhost';
const PORT = 3000;
const PATH = '/diagnostics/stream';
const RECONNECT_MS = 2500;

// ── ANSI helpers ────────────────────────────────────────────────────────────
const R  = '\x1b[0m';
const B  = '\x1b[1m';
const DIM= '\x1b[2m';
const RED= '\x1b[31m';
const GRN= '\x1b[32m';
const YLW= '\x1b[33m';
const BLU= '\x1b[34m';
const MAG= '\x1b[35m';
const CYN= '\x1b[36m';
const WHT= '\x1b[37m';

function clr()  { process.stdout.write('\x1Bc'); }
function pad(s, w) { s = String(s ?? ''); return s.length >= w ? s.slice(0, w) : s + ' '.repeat(w - s.length); }
function rpad(s, w) { s = String(s ?? ''); return s.length >= w ? s.slice(0, w) : ' '.repeat(w - s.length) + s; }
function bar(char, w) { return char.repeat(w); }
function yn(v) { return v ? `${GRN}YES${R}` : `${RED}NO${R}`; }
function ok(v) { return v ? `${GRN}OK${R}` : `${RED}FAIL${R}`; }
function amber(s) { return `${YLW}${s}${R}`; }
function cyan(s)  { return `${CYN}${s}${R}`; }
function bold(s)  { return `${B}${s}${R}`; }
function dim(s)   { return `${DIM}${s}${R}`; }
function red(s)   { return `${RED}${s}${R}`; }
function grn(s)   { return `${GRN}${s}${R}`; }
function mag(s)   { return `${MAG}${s}${R}`; }

const WIDTH = process.stdout.columns || 100;
function divider(label) {
  if (!label) return dim(bar('─', WIDTH));
  const inner = ` ${label} `;
  const side = Math.max(2, Math.floor((WIDTH - inner.length) / 2));
  return dim(bar('─', side)) + bold(inner) + dim(bar('─', WIDTH - side - inner.length));
}

// ── Render ──────────────────────────────────────────────────────────────────
function render(p) {
  const lines = [];
  const push = s => lines.push(s);

  // Header
  push(bold(`${BLU}╔${ bar('═', WIDTH - 2) }╗${R}`));
  const title = '  DUNGEON MASTER ENGINE — FLIGHT RECORDER  ';
  const ts = new Date().toLocaleTimeString();
  push(bold(`${BLU}║${R}`) + cyan(pad(title, WIDTH - 4 - ts.length)) + dim(ts) + `  ${bold(`${BLU}║${R}`)}`);
  push(bold(`${BLU}╚${ bar('═', WIDTH - 2) }╝${R}`));
  push('');

  // Turn / Channel / Input
  const turnLabel = rpad(`T-${p.turn ?? '??'}`, 6);
  const chan = pad(String(p.channel ?? '—').toUpperCase(), 8);
  const rawIn = String(p.raw_input ?? '').slice(0, WIDTH - 30);
  push(`${bold('TURN')} ${bold(`${CYN}${turnLabel}${R}`)}  ${bold('CH')} ${amber(chan)}  ${bold('INPUT')} ${WHT}"${rawIn}"${R}`);

  // Parser
  const parser   = pad(p.parser ?? '—', 18);
  const parsed   = pad(p.parsed_action ?? '—', 14);
  const parsedDir= pad(p.parsed_dir ?? '—', 6);
  const conf     = p.confidence !== null && p.confidence !== undefined ? `${Math.round(p.confidence * 100)}%` : '—';
  const degraded = p.degraded ? amber(`↓${p.degraded}`) : grn('CLEAN');
  push(`${bold('PARSER')} ${cyan(parser)} ${bold('ACTION')} ${cyan(parsed)} ${bold('DIR')} ${cyan(parsedDir)} ${bold('CONF')} ${conf}  ${bold('PATH')} ${degraded}`);
  push('');

  // Spatial
  push(divider('SPATIAL'));
  const sp = p.spatial || {};
  const depth = ['—','OVERWORLD','SITE','LOCAL'][sp.depth ?? 0] || String(sp.depth);
  const pos   = sp.position ? `(${sp.position.x ?? '?'}, ${sp.position.y ?? '?'})` : '(—)';
  const site  = sp.site_name || '—';
  const local = sp.local_space_name || '—';
  push(`${bold('DEPTH')} ${mag(pad(depth, 12))}  ${bold('POS')} ${pad(pos, 12)}  ${bold('SITE')} ${pad(site, 24)}  ${bold('LOCALSPACE')} ${local}`);
  push('');

  // Movement
  push(divider('MOVEMENT'));
  const mv = p.movement;
  if (mv) {
    const dir   = pad(mv.direction ?? '—', 10);
    const dest  = pad(mv.destination_name ?? mv.destination ?? '—', 24);
    const valid = mv.valid !== undefined ? yn(mv.valid) : '—';
    const reason= mv.block_reason || mv.reason || '';
    push(`${bold('DIR')} ${cyan(dir)} ${bold('DEST')} ${cyan(dest)} ${bold('VALID')} ${valid}${reason ? `  ${dim(reason.slice(0, 40))}` : ''}`);
  } else {
    push(dim('  no movement this turn'));
  }
  push('');

  // Continuity
  push(divider('CONTINUITY'));
  const co = p.continuity || {};
  const injRow   = `${bold('INJECTED')}     ${yn(co.injected)}`;
  const evictRow = `${bold('EVICTED')}      ${yn(co.evicted)}${co.eviction_reason ? `  ${dim(co.eviction_reason.slice(0, 40))}` : ''}`;
  const extrRow  = `${bold('EXTRACTION')}   ${ok(co.extraction_success !== false)}${co.rejection_reason ? `  ${amber(co.rejection_reason.slice(0, 50))}` : ''}`;
  const memRow   = `${bold('MEMORY COUNT')} ${cyan(String(co.memory_count ?? '—'))}`;
  const charRow  = `${bold('BLOCK CHARS')}  ${cyan(String(co.block_chars ?? 0))}`;
  push(injRow + '   ' + evictRow);
  push(extrRow + '   ' + memRow + '   ' + charRow);
  if (co.snapshot) {
    const snip = co.snapshot.slice(0, WIDTH - 4).replace(/\n/g, ' ');
    push(dim(`  ↳ "${snip}"`));
  }
  if (co.alerts && co.alerts.length) {
    co.alerts.forEach(a => push(`  ${amber('⚠')} ${amber(String(a).slice(0, WIDTH - 4))}`));
  }
  if (co.entity_updates && co.entity_updates.length) {
    push(`  ${grn('ENTITY UPDATES')} ${co.entity_updates.slice(0, 4).map(u => `${u.id || u}`).join(', ')}`);
  }
  push('');

  // Entities in scene
  push(divider('ENTITIES'));
  const ents = p.entities?.visible || [];
  if (ents.length) {
    const row = ents.slice(0, 8).map(e => `${cyan(e.name || e.id)}${e.job ? dim(`[${e.job}]`) : ''}`).join('  ');
    push('  ' + row);
  } else {
    push(dim('  none visible'));
  }
  push('');

  // Engine message
  if (p.engine_message) {
    push(divider('ENGINE MESSAGE'));
    push(`  ${amber(String(p.engine_message).slice(0, WIDTH - 4))}`);
    push('');
  }

  // Violations
  push(divider('VIOLATIONS'));
  const viol = p.violations || [];
  if (viol.length) {
    viol.forEach(v => push(`  ${red('✗')} ${red(v)}`));
  } else {
    push(`  ${grn('✓ no violations')}`);
  }
  push('');

  // Narration length
  if (p.narration_length !== undefined) {
    push(dim(`  narration_length=${p.narration_length} chars`));
  }

  // Footer
  push(dim(`  last updated ${new Date().toLocaleTimeString()}  │  press Ctrl+C to exit`));

  clr();
  process.stdout.write(lines.join('\n') + '\n');
}

// ── SSE client ───────────────────────────────────────────────────────────────
function connect() {
  process.stdout.write(`${DIM}[flight-recorder] connecting to http://${HOST}:${PORT}${PATH}…${R}\n`);

  const req = http.get({ host: HOST, port: PORT, path: PATH, headers: { Accept: 'text/event-stream' } }, res => {
    if (res.statusCode !== 200) {
      process.stdout.write(`${RED}[flight-recorder] HTTP ${res.statusCode} — will retry in ${RECONNECT_MS}ms${R}\n`);
      res.resume();
      setTimeout(connect, RECONNECT_MS);
      return;
    }

    process.stdout.write(`${GRN}[flight-recorder] connected — waiting for first turn…${R}\n`);
    res.setEncoding('utf8');

    let buf = '';
    res.on('data', chunk => {
      buf += chunk;
      const parts = buf.split('\n\n');
      buf = parts.pop(); // keep incomplete tail
      for (const block of parts) {
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue;
          try {
            const payload = JSON.parse(line.slice(5).trim());
            if (payload.type === 'turn') render(payload);
          } catch (_) { /* ignore malformed */ }
        }
      }
    });

    res.on('end', () => {
      process.stdout.write(`\n${YLW}[flight-recorder] stream ended — reconnecting in ${RECONNECT_MS}ms…${R}\n`);
      setTimeout(connect, RECONNECT_MS);
    });

    res.on('error', err => {
      process.stdout.write(`\n${RED}[flight-recorder] stream error: ${err.message}${R}\n`);
      setTimeout(connect, RECONNECT_MS);
    });
  });

  req.on('error', err => {
    process.stdout.write(`${RED}[flight-recorder] connection failed: ${err.message} — retry in ${RECONNECT_MS}ms${R}\n`);
    setTimeout(connect, RECONNECT_MS);
  });

  req.end();
}

connect();
