// continuity.js — Dungeon Master continuity inspector (v1.64.4)
// Usage: node continuity.js [--turns N|all]
// Fetches /diagnostics/continuity and renders a static ANSI display, then exits.

'use strict';
const http = require('http');

const PORT = process.env.PORT || 3000;
const HOST = 'localhost';

// ── Parse --turns flag ────────────────────────────────────────────────────────
let turnsArg = '3';
const flagIdx = process.argv.indexOf('--turns');
if (flagIdx !== -1 && process.argv[flagIdx + 1]) {
  turnsArg = process.argv[flagIdx + 1];
}

// ── ANSI helpers ──────────────────────────────────────────────────────────────
const R   = '\x1b[0m';
const B   = '\x1b[1m';
const DIM = '\x1b[2m';
const CYN = '\x1b[36m';
const YLW = '\x1b[33m';
const GRN = '\x1b[32m';
const RED = '\x1b[31m';
const MAG = '\x1b[35m';
const WHT = '\x1b[97m';

const W = Math.min(process.stdout.columns || 100, 120);

function bold(s)   { return `${B}${s}${R}`; }
function dim(s)    { return `${DIM}${s}${R}`; }
function cyan(s)   { return `${CYN}${s}${R}`; }
function amber(s)  { return `${YLW}${s}${R}`; }
function grn(s)    { return `${GRN}${s}${R}`; }
function red(s)    { return `${RED}${s}${R}`; }
function mag(s)    { return `${MAG}${s}${R}`; }

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

function field(label, value, labelW = 26) {
  const lbl = (label + ' ').padEnd(labelW, ' ');
  return `  ${DIM}${lbl}${R}${WHT}${value ?? dim('—')}${R}`;
}

// ── Render ────────────────────────────────────────────────────────────────────
function render(d) {
  const lines = [];
  const push  = (...ss) => ss.forEach(s => lines.push(s));

  push('');
  push(box(`DUNGEON MASTER \u2014 CONTINUITY INSPECTOR  (T-${d.turn})`));
  push('');

  // ── Injected block ──────────────────────────────────────────────────────────
  const blockChars = d.rendered_block ? d.rendered_block.length : 0;
  push(hr(`INJECTED BLOCK  (${blockChars}ch  ~${Math.round(blockChars / 4)}tok)  \u2190 fed to model this turn`));
  push(dim(`  (built from previous turn's extraction — reflects state entering this narration)`));
  push('');
  if (d.rendered_block) {
    d.rendered_block.split('\n').forEach(l => push('  ' + l));
  } else {
    push(dim('  (empty — no continuity state yet)'));
  }
  push('');

  // ── Extraction result ───────────────────────────────────────────────────────
  push(hr('EXTRACTION RESULT  \u2192 will be injected next turn'));
  push('');
  const ac = d.active_continuity;
  if (ac) {
    const threads = Array.isArray(ac.unresolved_threads) ? ac.unresolved_threads : [];
    push(field('player_locomotion',      ac.player_locomotion));
    push(field('player_physical_state',  ac.player_physical_state));
    push(field('scene_focus_primary',    ac.scene_focus_primary));
    push(field('tone',                   ac.tone));
    push(field('interaction_mode',       ac.interaction_mode));
    push(field('active_interaction',     ac.active_interaction));
    push(field('environment_continuity', ac.environment_continuity));
    push(field('unresolved_threads',     threads.length ? `${threads.length} active` : 'none'));
    threads.forEach((t, i) => push(`  ${dim(`    [${i + 1}]`)} ${t}`));
    push(field('turn_when_set',          ac.turn_when_set != null ? `T-${ac.turn_when_set}` : null));
    push(field('site_when_set',          ac.site_name_when_set));
    const tier = ac.scene_focus_tier;
    if (tier && typeof tier === 'object') {
      const tierStr = Object.entries(tier).map(([k, v]) => `${k}:${v}`).join('  ');
      push(field('scene_focus_tier', tierStr));
    }
  } else {
    push(dim('  (no active_continuity — not yet extracted)'));
  }
  push('');

  // ── DM Note ────────────────────────────────────────────────────────────────
  {
    const noteStatus = d.dm_note_status ?? null;
    const statusLabel = noteStatus === 'updated'           ? grn('UPDATED this turn')
                      : noteStatus === 'preserved_missing' ? red('PRESERVED — extraction provided no note')
                      : noteStatus === 'new_game'          ? amber('NEW GAME — no note yet')
                      : dim('unknown');
    push(hr(`DM HANDOFF NOTE  (verbatim — model reads this exact text next turn)  status: ${statusLabel}`));
    push('');
    if (d.dm_note) {
      d.dm_note.split('\n').forEach(l => push('  ' + l));
    } else {
      push(dim('  (none — no DM note generated yet)'));
    }
    push('');
  }

  // ── Prior location memories ────────────────────────────────────────────────
  const mems = d.narrative_memory || [];
  push(hr(`PRIOR LOCATION MEMORIES (${mems.length})`));
  push('');
  if (mems.length) {
    mems.forEach((m, i) => {
      const text = typeof m === 'string' ? m : JSON.stringify(m);
      push(`  ${mag(`[M${i + 1}]`)} ${text.slice(0, W - 10)}`);
    });
  } else {
    push(dim('  none — no prior locations visited'));
  }
  push('');

  // ── Narration archive ───────────────────────────────────────────────────────
  const total   = d.narrative_archive_total ?? 0;
  const showing = (d.last_narrations || []).length;
  push(hr(`NARRATION ARCHIVE  (showing ${showing} of ${total})`));
  push('');
  if (!d.last_narrations || d.last_narrations.length === 0) {
    push(dim('  (none)'));
  } else {
    d.last_narrations.forEach(entry => {
      const chars = entry.continuity_block_chars != null ? `  ${dim(`[cont: ${entry.continuity_block_chars}ch]`)}` : '';
      push(`  ${cyan(`T-${entry.turn_number}`)}  ${dim(`(${(entry.narrative || '').length}ch)`)}${chars}`);
      const narText = entry.narrative || '';
      // Wrap at W-4 chars
      const wrapW = W - 4;
      for (let i = 0; i < narText.length; i += wrapW) {
        push('    ' + narText.slice(i, i + wrapW));
      }
      push('');
    });
  }

  push(dim(`  node continuity.js --turns all  to see full archive`));
  push(dim(`  data since last server restart \u2014 not persisted across restarts`));
  push('');

  console.log(lines.join('\n'));
}

// ── Fetch ─────────────────────────────────────────────────────────────────────
const req = http.get(
  { host: HOST, port: PORT, path: `/diagnostics/continuity?turns=${encodeURIComponent(turnsArg)}` },
  res => {
    let raw = '';
    res.on('data', chunk => { raw += chunk; });
    res.on('end', () => {
      let data;
      try { data = JSON.parse(raw); }
      catch (e) {
        console.error('[continuity.js] Failed to parse response:', e.message);
        console.error('Raw:', raw.slice(0, 500));
        process.exit(1);
      }
      if (data.no_data) {
        console.log('\n' + amber(`  ${data.reason}`) + '\n');
        process.exit(0);
      }
      render(data);
    });
  }
);

req.on('error', err => {
  console.error(`[continuity.js] Could not reach engine at ${HOST}:${PORT} — is the server running?`);
  console.error(err.message);
  process.exit(1);
});

req.end();
