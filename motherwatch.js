/**
 * motherwatch.js — Mother Watch Panel for the Dungeon Master Engine
 * Connects to /diagnostics/stream (SSE) and displays Mother's per-turn
 * system health verdict from Phase B watch_message.
 * Run standalone: node motherwatch.js
 */

'use strict';

const http = require('http');

const HOST         = 'localhost';
const PORT         = 3000;
const PATH         = '/diagnostics/stream';
const RECONNECT_MS = 500;

// ── ANSI helpers ────────────────────────────────────────────────────────────
const R   = '\x1b[0m';
const B   = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GRN = '\x1b[32m';
const YLW = '\x1b[33m';
const CYN = '\x1b[36m';
const WHT = '\x1b[37m';
const MAG = '\x1b[35m';

function clr()        { process.stdout.write('\x1b[H\x1b[2J\x1b[3J'); }
function bold(s)      { return `${B}${s}${R}`; }
function dim(s)       { return `${DIM}${s}${R}`; }
function cyan(s)      { return `${CYN}${s}${R}`; }
function bar(c, w)    { return c.repeat(w); }

const WIDTH = process.stdout.columns || 100;

// ── Session accumulator ─────────────────────────────────────────────────────
const _session = { calls: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cache_hit_tokens: 0, est_cost_usd: 0.0 };

function divider(label) {
  if (!label) return dim(bar('─', WIDTH));
  const inner = ` ${label} `;
  const side   = Math.max(2, Math.floor((WIDTH - inner.length) / 2));
  return dim(bar('─', side)) + bold(inner) + dim(bar('─', WIDTH - side - inner.length));
}

// ── Render ──────────────────────────────────────────────────────────────────
function render(p, session) {
  const out = [];
  const push = s => out.push(s);
  const turn = p.turn ?? '??';
  const ts   = new Date().toLocaleTimeString();

  // Header
  push(bold(`${MAG}╔${bar('═', WIDTH - 2)}╗${R}`));
  const title = '  MOTHER WATCH  —  FULL SCAN  ';
  const gap = Math.max(0, WIDTH - 4 - title.length - ts.length);
  push(bold(`${MAG}║${R}`) + cyan(title) + ' '.repeat(gap) + dim(ts) + `  ${bold(`${MAG}║${R}`)}`);
  push(bold(`${MAG}╚${bar('═', WIDTH - 2)}╝${R}`));
  push('');
  push(`${bold('TURN')} ${bold(`${CYN}${turn}${R}`)}`);
  push('');
  push(dim(bar('─', WIDTH)));
  push('');

  // Findings
  const scanLines = Array.isArray(p.lines) ? p.lines : ['(no scan results)'];
  for (const line of scanLines) {
    const l = line.trim();
    if (!l) continue;
    const lo = l.toLowerCase();
    let colored;
    if (lo.startsWith('error') || lo.startsWith('[scan failed') || lo.includes('missing') || lo.includes('undefined') || lo.includes('unfilled') || lo.includes('partial fill') || lo.includes('not populated') || lo.includes('incomplete') || lo.includes('fill_failed') || lo.includes('integrity_failure') || lo.includes('resolution_failed')) {
      colored = `  ${RED}${l}${R}`;
    } else if (lo.startsWith('warn') || lo.includes('inconsisten') || lo.includes('mismatch') || lo.includes('unexpected') || lo.includes('verify') || lo.includes('blank')) {
      colored = `  ${YLW}${l}${R}`;
    } else if (lo.includes('no issue') || lo.includes('all clear') || lo.includes('no error') || lo.includes('no bug') || lo.includes('everything looks') || lo.includes('nothing wrong') || lo.includes('no problem') || lo.includes('nothing is wrong') || lo.includes('no faults') || lo.includes('no genuine')) {
      colored = `  ${GRN}${l}${R}`;
    } else {
      colored = `  ${WHT}${l}${R}`;
    }
    push(colored);
  }

  push('');
  push(dim(bar('─', WIDTH)));
  // Footer: per-scan stats + session totals
  const u = p.usage || {};
  const scanTok  = u.total_tokens   || 0;
  const scanCost = u.est_cost_usd   || 0;
  const scanHit  = u.cache_hit_tokens || 0;
  const scanMiss = u.cache_miss_tokens || 0;
  const hitPct   = scanTok > 0 && (scanHit + scanMiss) > 0
    ? Math.round((scanHit / (scanHit + scanMiss)) * 100) + '% hit'
    : '';
  const scanStr  = scanTok > 0
    ? `scan: ${scanTok.toLocaleString()} tok${hitPct ? '  ' + hitPct : ''}  ~$${scanCost.toFixed(6)}`
    : 'scan: --';
  const sesStr   = `session: ${session.calls} calls  ${session.total_tokens.toLocaleString()} tok  ~$${session.est_cost_usd.toFixed(4)}`;
  push(dim(`  turn ${turn}  |  ${scanStr}  |  ${sesStr}  |  Ctrl+C exit`));

  clr();
  process.stdout.write(out.join('\n') + '\n');
}

// ── SSE client ───────────────────────────────────────────────────────────────
function connect() {
  process.stdout.write(`${DIM}[mother-watch] connecting to http://${HOST}:${PORT}${PATH}…${R}\n`);

  const req = http.get({ host: HOST, port: PORT, path: PATH, headers: { Accept: 'text/event-stream' } }, res => {
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    if (res.statusCode !== 200) {
      process.stdout.write(`${RED}[mother-watch] HTTP ${res.statusCode} — will retry in ${RECONNECT_MS}ms${R}\n`);
      res.resume();
      setTimeout(connect, RECONNECT_MS);
      return;
    }

    process.stdout.write(`${GRN}[mother-watch] connected — waiting for first turn…${R}\n`);
    res.setEncoding('utf8');

    let buf = '';
    res.on('data', chunk => {
      buf += chunk;
      const parts = buf.split('\n\n');
      buf = parts.pop(); // keep incomplete tail
      for (const block of parts) {
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue;
          let payload;
          try {
            payload = JSON.parse(line.slice(5).trim());
          } catch (e) {
            process.stdout.write(`${RED}[PARSE ERR] ${e.message.slice(0, 80)}${R}\n`);
            continue;
          }
          if (payload.type !== 'watch_verdict') continue;
          try {
            // Accumulate session stats
            const u = payload.usage || {};
            _session.calls++;
            _session.prompt_tokens     += u.prompt_tokens     || 0;
            _session.completion_tokens += u.completion_tokens || 0;
            _session.total_tokens      += u.total_tokens      || 0;
            _session.cache_hit_tokens  += u.cache_hit_tokens  || 0;
            _session.est_cost_usd      += u.est_cost_usd      || 0;
            render(payload, { ..._session });
          } catch (e) {
            process.stdout.write(`${RED}[RENDER ERR T-${payload.turn}] ${e.message}\n${e.stack || ''}${R}\n`);
          }
        }
      }
    });

    res.on('end', () => {
      process.stdout.write(`\n${YLW}[mother-watch] stream ended — reconnecting in ${RECONNECT_MS}ms…${R}\n`);
      setTimeout(connect, RECONNECT_MS);
    });

    res.on('error', err => {
      process.stdout.write(`\n${RED}[mother-watch] stream error: ${err.message}${R}\n`);
      setTimeout(connect, RECONNECT_MS);
    });
  });

  req.on('error', err => {
    process.stdout.write(`${RED}[mother-watch] connection failed: ${err.message} — retry in ${RECONNECT_MS}ms${R}\n`);
    setTimeout(connect, RECONNECT_MS);
  });

  req.end();
}

connect();

// ── Hotkeys ─────────────────────────────────────────────────────────────────
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', key => {
    if (key === '\u0003') { process.exit(); } // Ctrl+C
  });
}
