/**
 * dmletter.js — Dedicated DM Note Inspection Window (v1.67.0)
 *
 * One-shot: fetches /diagnostics/continuity (current note + status)
 * and /diagnostics/log (archive), renders, exits.
 *
 * Rules:
 *   - Note content is verbatim from dm_note_archived / dm_note — no modification
 *   - Archive uses dm_note_archived + dm_note_status exactly as stored
 *   - Visual line-wrap is display only — stored strings are never modified
 *
 * Usage:
 *   node dmletter.js              (shows last 3 archived turns)
 *   node dmletter.js --turns 10
 *   node dmletter.js --turns all
 */

'use strict';

const http = require('http');

const HOST = 'localhost';
const PORT = process.env.PORT || 3000;

// ── CLI args ─────────────────────────────────────────────────────────────────
let turnsArg = '3';
const flagIdx = process.argv.indexOf('--turns');
if (flagIdx !== -1 && process.argv[flagIdx + 1]) {
  turnsArg = process.argv[flagIdx + 1];
}

// ── ANSI helpers ──────────────────────────────────────────────────────────────
const R   = '\x1b[0m';
const B   = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GRN = '\x1b[32m';
const YLW = '\x1b[33m';
const CYN = '\x1b[36m';
const WHT = '\x1b[97m';

const W = Math.min(process.stdout.columns || 100, 120);

function bold(s)  { return `${B}${s}${R}`; }
function dim(s)   { return `${DIM}${s}${R}`; }
function cyan(s)  { return `${CYN}${s}${R}`; }
function amber(s) { return `${YLW}${s}${R}`; }
function grn(s)   { return `${GRN}${s}${R}`; }
function red(s)   { return `${RED}${s}${R}`; }
function wht(s)   { return `${WHT}${s}${R}`; }

function box(text) {
  const inner = ` ${text} `;
  const fill  = Math.max(0, W - 2 - inner.length);
  return [
    `${CYN}${B}╔${'═'.repeat(W - 2)}╗${R}`,
    `${CYN}${B}║${R}${bold(inner)}${' '.repeat(fill)}${CYN}${B}║${R}`,
    `${CYN}${B}╚${'═'.repeat(W - 2)}╝${R}`
  ].join('\n');
}

function hr(label) {
  const inner = ` ${label} `;
  const left  = 2;
  const right = Math.max(1, W - left - inner.length);
  return `${DIM}${'─'.repeat(left)}${R}${bold(inner)}${DIM}${'─'.repeat(right)}${R}`;
}

// Visual line-wrap — display only; stored string is never modified
function wrapLines(text, indent, maxW) {
  const avail = maxW - indent.length;
  const result = [];
  const raw = String(text ?? '');
  for (const line of raw.split('\n')) {
    if (line.length === 0) { result.push(''); continue; }
    let rem = line;
    while (rem.length > avail) {
      result.push(indent + rem.slice(0, avail));
      rem = rem.slice(avail);
    }
    result.push(indent + rem);
  }
  return result;
}

function statusBadge(status) {
  switch (status) {
    case 'updated':           return grn('UPDATED this turn');
    case 'preserved_missing': return red('PRESERVED — no new note extracted');
    case 'new_game':          return amber('NEW GAME — no note yet');
    default:                  return dim(status ?? '—');
  }
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

// ── Render ────────────────────────────────────────────────────────────────────
function render(current, logData) {
  const lines = [];
  const push  = (...ss) => ss.forEach(s => lines.push(s));

  const totalTurns = logData?.total_turns ?? current.turn ?? '?';
  push('');
  push(box(`DUNGEON MASTER — DM LETTER   (T-${totalTurns})`));
  push('');

  // ── Current DM note ────────────────────────────────────────────────────────
  const dmStatus = current.dm_note_status;
  push(hr(`DM NOTE  status: ${statusBadge(dmStatus)}`));
  push('');
  if (current.dm_note) {
    // Verbatim — visual wrap for display only
    wrapLines(current.dm_note, '  ', W).forEach(l => push(l));
  } else {
    push(dim('  (none — no DM note exists yet)'));
  }
  push('');

  // ── Archive ────────────────────────────────────────────────────────────────
  const allTurns = logData?.turns ?? [];
  // Filter to turns that have a dm_note_archived, take last N
  const withNotes = allTurns.filter(t => t.dm_note_archived != null);
  const count = turnsArg === 'all' ? withNotes.length : Math.min(parseInt(turnsArg, 10) || 3, withNotes.length);
  const archiveTurns = withNotes.slice(-count);

  push(hr(`ARCHIVE (last ${archiveTurns.length} of ${withNotes.length} turns with notes)`));
  push('');

  if (archiveTurns.length === 0) {
    push(dim('  (no archived DM notes yet)'));
  } else {
    for (const t of archiveTurns) {
      const chars = t.dm_note_archived ? t.dm_note_archived.length : 0;
      // Use stored dm_note_status — no recomputation
      push(`  ${cyan(`T-${t.turn_number}`)}  status: ${statusBadge(t.dm_note_status)}  ${dim(`(${chars}ch)`)}`);
      // Verbatim — visual wrap for display only; stored dm_note_archived is not modified
      wrapLines(t.dm_note_archived, '    ', W).forEach(l => push(l));
      push('');
    }
  }

  push(dim(`  node dmletter.js --turns all  to see full archive`));
  push('');

  console.log(lines.join('\n'));
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  // Fetch current note from /diagnostics/continuity
  httpGet('/diagnostics/continuity', (err, current) => {
    if (err) {
      console.error(`[dmletter] Failed to fetch continuity: ${err.message}`);
      process.exit(1);
    }
    if (current.no_data) {
      console.log(dim(`\n  (no data yet — start the game and play at least one turn)\n`));
      process.exit(0);
    }

    // Fetch turn archive from /diagnostics/log for historical dm_note_archived entries
    httpGet('/diagnostics/log', (err2, logData) => {
      if (err2) {
        console.warn(`[dmletter] Failed to fetch log archive: ${err2.message} — archive will be empty`);
        render(current, null);
      } else {
        render(current, logData);
      }
      process.exit(0);
    });
  });
}

main();
