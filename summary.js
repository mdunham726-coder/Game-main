// summary.js — Dungeon Master session summary viewer (v1.64.3)
// Usage: node summary.js
// Fetches /diagnostics/summary from the running engine and renders a static ANSI display.

'use strict';
const http = require('http');

const PORT = process.env.PORT || 3000;
const HOST = 'localhost';

const W = 52; // display width

const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  cyan:   '\x1b[36m',
  yellow: '\x1b[33m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  white:  '\x1b[97m',
};

function box(text, color = c.cyan) {
  const inner = ` ${text} `.padEnd(W - 2);
  return `${color}${c.bold}╔${'═'.repeat(W - 2)}╗\n║${inner}║\n╚${'═'.repeat(W - 2)}╝${c.reset}`;
}

function hr(label) {
  const pad = '─'.repeat(Math.max(1, W - label.length - 3));
  return `${c.dim}── ${label} ${pad}${c.reset}`;
}

function fmt(n) {
  if (n == null) return c.dim + 'n/a' + c.reset;
  return c.white + n.toLocaleString() + c.reset;
}

function pct(num, denom) {
  if (!denom) return '';
  return c.dim + ` (${Math.round((num / denom) * 100)}% cached)` + c.reset;
}

function render(d) {
  const lines = [];

  lines.push('');
  lines.push(box('DUNGEON MASTER \u2014 SESSION SUMMARY'));
  lines.push('');

  // Turns
  lines.push(`  ${c.yellow}TURNS PLAYED${c.reset}    ${fmt(d.turns)}   ${c.dim}(since last server restart)${c.reset}`);
  lines.push('');

  // Token averages
  lines.push(hr('TOKEN AVERAGES'));
  lines.push(`  ${c.cyan}NARRATOR  avg${c.reset}   ${fmt(d.avg_narrator)} tok/turn`);
  lines.push(`  ${c.cyan}PARSER    avg${c.reset}   ${fmt(d.avg_parser)} tok/turn${pct(d.cached_turns, d.turns)}`);
  lines.push(`  ${c.cyan}SYSTEM    avg${c.reset}   ${fmt(d.avg_system)} tok/turn`);
  lines.push(`  ${c.yellow}TOTAL SPENT${c.reset}     ${fmt(d.total_spent)} tok this session`);
  lines.push('');

  // Cost trend
  lines.push(hr('COST TREND'));
  if (d.peak_entry) {
    lines.push(`  ${c.cyan}PEAK TURN${c.reset}   T-${d.peak_entry.turn_number}   ${fmt(d.peak_entry.system_total)} tok`);
  } else {
    lines.push(`  ${c.dim}no data yet${c.reset}`);
  }
  lines.push('');

  // Continuity growth
  lines.push(hr('CONTINUITY GROWTH'));
  const first = d.cont_chars_first;
  const last  = d.cont_chars_last;
  if (first != null && last != null) {
    const delta = last - first;
    const sign  = delta >= 0 ? '+' : '';
    lines.push(`  ${c.cyan}START${c.reset}  ${fmt(first)}ch  ${c.dim}\u2192${c.reset}  ${c.cyan}LATEST${c.reset}  ${fmt(last)}ch  ${c.dim}(${sign}${delta}ch over ${d.turns} turn${d.turns !== 1 ? 's' : ''})${c.reset}`);
  } else {
    lines.push(`  ${c.dim}no data yet${c.reset}`);
  }
  lines.push('');

  // Violations
  lines.push(hr('VIOLATIONS'));
  const entries = Object.entries(d.violation_counts || {});
  if (entries.length === 0) {
    lines.push(`  ${c.green}\u2713 no violations recorded${c.reset}`);
  } else {
    entries.sort((a, b) => b[1] - a[1]).forEach(([label, count]) => {
      lines.push(`  ${c.red}${label.padEnd(36)}${c.reset}  \u00d7${count}`);
    });
  }
  lines.push('');

  lines.push(`  ${c.dim}(data since last server restart \u2014 not persisted across restarts)${c.reset}`);
  lines.push('');

  console.log(lines.join('\n'));
}

// ── Fetch summary ─────────────────────────────────────────────────────────────
const req = http.get({ host: HOST, port: PORT, path: '/diagnostics/summary' }, res => {
  let raw = '';
  res.on('data', chunk => { raw += chunk; });
  res.on('end', () => {
    try {
      const data = JSON.parse(raw);
      render(data);
    } catch (e) {
      console.error('[summary.js] Failed to parse response:', e.message);
      console.error('Raw:', raw);
      process.exit(1);
    }
  });
});

req.on('error', err => {
  console.error(`[summary.js] Could not reach engine at ${HOST}:${PORT} — is the server running?`);
  console.error(err.message);
  process.exit(1);
});

req.end();
