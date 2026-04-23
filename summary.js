// summary.js — Dungeon Master session summary viewer (v1.70.0)
// Usage: node summary.js
// Live: SSE-connected. Redraws on every new game turn.

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
  lines.push(`  ${c.dim}last updated ${new Date().toLocaleTimeString()}  \u2502  Ctrl+C exit${c.reset}`);
  lines.push('');

  process.stdout.write('\x1b[H\x1b[2J\x1b[3J');
  console.log(lines.join('\n'));
}

// ── HTTP fetch ────────────────────────────────────────────────────────────────
function fetchAndRender() {
  const req = http.get({ host: HOST, port: PORT, path: '/diagnostics/summary' }, res => {
    let raw = '';
    res.on('data', chunk => { raw += chunk; });
    res.on('end', () => {
      try { render(JSON.parse(raw)); }
      catch (e) { process.stdout.write(`\x1b[31m[summary.js] parse error: ${e.message}\x1b[0m\n`); }
    });
    res.on('error', () => {});
  });
  req.on('error', () => {});
  req.end();
}

// ── SSE reconnect guard ───────────────────────────────────────────────────────
const SSE_PATH     = '/diagnostics/stream';
const RECONNECT_MS = 1000;
let _reconnectPending = false;

function scheduleReconnect() {
  if (_reconnectPending) return;
  _reconnectPending = true;
  setTimeout(() => { _reconnectPending = false; connectSSE(); }, RECONNECT_MS);
}

// ── SSE client ────────────────────────────────────────────────────────────────
function connectSSE() {
  const req = http.get(
    { host: HOST, port: PORT, path: SSE_PATH, headers: { Accept: 'text/event-stream' } },
    res => {
      req.socket.setTimeout(0);
      req.socket.setNoDelay(true);
      if (res.statusCode !== 200) { res.resume(); scheduleReconnect(); return; }
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', chunk => {
        buf += chunk;
        const parts = buf.split('\n\n');
        buf = parts.pop();
        for (const block of parts) {
          for (const line of block.split('\n')) {
            if (!line.startsWith('data:')) continue;
            let p; try { p = JSON.parse(line.slice(5).trim()); } catch (_) { continue; }
            if (p.type === 'turn') fetchAndRender();
          }
        }
      });
      res.on('end',   () => scheduleReconnect());
      res.on('error', () => scheduleReconnect());
    }
  );
  req.on('error', () => scheduleReconnect());
  req.end();
}

// ── Boot ──────────────────────────────────────────────────────────────────────
fetchAndRender();
connectSSE();
