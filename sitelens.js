// sitelens.js -- Sites & Localspaces Monitor (v1.82.0)
// Usage: node sitelens.js
// Live: remains open, refreshes automatically on each new game turn via /diagnostics/stream.
// Data source: GET /diagnostics/sites (structured JSON, read-only).

'use strict';
const http = require('http');

const PORT = process.env.PORT || 3000;
const HOST = 'localhost';
const SITES_PATH  = '/diagnostics/sites';
const SSE_PATH    = '/diagnostics/stream';
const RECONNECT_MS = 1000;
const W = 72;

// ── ANSI helpers ──────────────────────────────────────────────────────────────
const R   = '\x1b[0m';
const BLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GRN = '\x1b[32m';
const RED = '\x1b[31m';
const YLW = '\x1b[33m';
const CYN = '\x1b[36m';
const WHT = '\x1b[97m';

function grn(s)  { return `${GRN}${s}${R}`; }
function red(s)  { return `${RED}${s}${R}`; }
function ylw(s)  { return `${YLW}${s}${R}`; }
function cyn(s)  { return `${CYN}${s}${R}`; }
function dim(s)  { return `${DIM}${s}${R}`; }
function bld(s)  { return `${BLD}${s}${R}`; }
function wht(s)  { return `${WHT}${s}${R}`; }

function hr(label) {
  const pad = W - label.length - 4;
  return `${DIM}-- ${label} ${'─'.repeat(Math.max(1, pad))}${R}`;
}

function clr() { process.stdout.write('\x1b[H\x1b[2J\x1b[3J'); }

// ── Field display helpers ─────────────────────────────────────────────────────
const DEPTH_LABELS = { 1: 'L0 (overworld)', 2: 'L1 (site interior)', 3: 'L2 (local space interior)' };

function fillBadge(record) {
  if (!record) return dim('--');
  const nameOk = record.name != null;
  const descOk = record.description != null;
  if (record.is_filled && nameOk && descOk) return grn('[OK]');
  if (!nameOk && !descOk) return ylw('[--]') + dim(' (no name, no desc)');
  if (!nameOk) return ylw('[--]') + dim(' (no name)');
  if (!descOk) return ylw('[--]') + dim(' (no desc)');
  return ylw('[--]') + dim(' (is_filled:false)');
}

function gridStr(w, h) {
  if (w == null || h == null) return dim('--');
  return `${w}x${h}`;
}

function npcStr(n) {
  if (n == null || n === 0) return dim('0');
  return wht(String(n));
}

function intStateStr(s) {
  if (!s) return dim('--');
  if (s === 'GENERATED')              return grn('GENERATED');
  if (s === 'PENDING_FILL')           return ylw('PENDING_FILL');
  if (s === 'NOT_GENERATED')          return dim('NOT_GENERATED');
  if (s === 'NOT_APPLICABLE')         return dim('NOT_APPLICABLE');
  if (s === 'MISSING_INTERIOR_KEY')   return red('MISSING_INTERIOR_KEY');
  if (s === 'MISSING_INTERIOR_RECORD') return red('MISSING_INTERIOR_RECORD');
  return dim(s);
}

// Truncate a string for display
function trunc(s, max) {
  if (!s) return dim('(none)');
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + dim('~');
}

// ── Render ────────────────────────────────────────────────────────────────────
function render(d) {
  const lines = [];
  const push = l => lines.push(l);

  const title = ` SITES & SPACES  v1.82.0 `;
  const titlePad = '═'.repeat(Math.max(1, W - title.length - 2));
  push(`\n${CYN}${BLD}╔═${title}${titlePad}╗${R}`);
  push(`${CYN}${BLD}║${' '.repeat(W)}║${R}`);

  const depthLabel = DEPTH_LABELS[d.depth] || `depth ${d.depth}`;
  const cellLabel  = d.cell_key || '(no position)';
  push(`${CYN}${BLD}║${R}  Layer: ${wht(depthLabel)}  |  Cell: ${wht(cellLabel)}`);
  push(`${CYN}${BLD}║${R}`);
  push(`${CYN}${BLD}╚${'═'.repeat(W)}╝${R}`);
  push('');

  // ── ACTIVE SITE ────────────────────────────────────────────────────────────
  push(hr('ACTIVE SITE'));
  if (!d.active_site) {
    push(`  ${dim('(none)')}  -- not inside a site`);
  } else {
    const as = d.active_site;
    push(`  id        : ${wht(as.site_id || '(unknown)')}`);
    push(`  name      : ${as.name ? wht(as.name) : dim('(unfilled)')}`);
    push(`  filled    : ${fillBadge(as)}`);
    push(`  enterable : ${as.enterable ? grn('YES') : dim('NO')}   size: ${as.site_size != null ? wht(String(as.site_size)) : dim('--')}`);
  }
  push('');

  // ── ACTIVE LOCAL SPACE ─────────────────────────────────────────────────────
  push(hr('ACTIVE LOCAL SPACE'));
  if (!d.active_local_space) {
    push(`  ${dim('(none)')}  -- not inside a local space`);
  } else {
    const al = d.active_local_space;
    push(`  id         : ${wht(al.local_space_id || '(unknown)')}`);
    push(`  name       : ${al.name ? wht(al.name) : dim('(unfilled)')}`);
    push(`  parent     : ${wht(al.parent_site_id || '(unknown)')}`);
    push(`  filled     : ${fillBadge(al)}`);
    push(`  enterable  : ${al.enterable ? grn('YES') : dim('NO')}   grid: ${gridStr(al.width, al.height)}   NPCs: ${npcStr(al.npc_count)}`);
  }
  push('');

  // ── SITES IN CELL ──────────────────────────────────────────────────────────
  push(hr(`SITES IN CELL  (${d.cell_sites.length} entr${d.cell_sites.length === 1 ? 'y' : 'ies'})`));
  if (d.cell_sites.length === 0) {
    push(`  ${dim('(no sites at current cell)')}`);
  } else {
    for (const s of d.cell_sites) {
      const badge = fillBadge(s);
      const ent   = s.enterable ? grn('ent') : dim('non-ent');
      const grid  = gridStr(s.grid_w, s.grid_h);
      const npcs  = npcStr(s.npc_count);
      const istate = intStateStr(s.interior_state);
      const nameDisp = s.name ? trunc(s.name, 28) : dim('(unfilled)');
      push(`  ${badge} ${wht(s.site_id || '?')}  ${nameDisp.padEnd(30)}  ${ent}  ${istate}  grid:${grid}  NPCs:${npcs}`);
    }
  }
  push('');

  // ── LOCALSPACES IN ACTIVE SITE ─────────────────────────────────────────────
  const lsArr = d.active_site ? (d.active_site.local_spaces || []) : [];
  push(hr(`LOCALSPACES IN ACTIVE SITE  (${lsArr.length} entr${lsArr.length === 1 ? 'y' : 'ies'})`));
  if (!d.active_site) {
    push(`  ${dim('(no active site)')}`);
  } else if (lsArr.length === 0) {
    push(`  ${dim('(no local spaces)')}`);
  } else {
    for (const ls of lsArr) {
      const badge   = fillBadge(ls);
      const grid    = gridStr(ls.width, ls.height);
      const npcs    = npcStr(ls.npc_count);
      const parent  = ls.parent_site_id || '?';
      const nameDisp = ls.name ? trunc(ls.name, 24) : dim('(unfilled)');
      push(`  ${badge} ${wht(ls.local_space_id || '?')}  ${nameDisp.padEnd(26)}  grid:${grid}  parent:${dim(parent)}  NPCs:${npcs}`);
    }
  }
  push('');

  // ── FILL STATUS ────────────────────────────────────────────────────────────
  push(hr('FILL STATUS'));
  const siteFilled  = d.cell_sites.filter(s => s.is_filled).length;
  const siteTotal   = d.cell_sites.length;
  const spaceFilled = lsArr.filter(s => s.is_filled).length;
  const spaceTotal  = lsArr.length;
  const siteColor   = siteFilled  === siteTotal  && siteTotal  > 0 ? GRN : YLW;
  const spaceColor  = spaceFilled === spaceTotal  && spaceTotal > 0 ? GRN : YLW;
  push(`  Sites  : ${siteColor}${siteFilled}/${siteTotal}${R} filled`);
  push(`  Spaces : ${spaceColor}${spaceFilled}/${spaceTotal}${R} filled`);
  push('');

  // ── FILL LOG ───────────────────────────────────────────────────────────────
  push(hr('FILL LOG  (recent failures only)'));
  if (!d.fill_log || d.fill_log.length === 0) {
    push(`  ${grn('[OK]')} no fill failures recorded this session`);
  } else {
    for (const entry of d.fill_log) {
      const ts  = entry.ts ? new Date(entry.ts).toLocaleTimeString() : '??:??:??';
      const typ = entry.type || '?';
      const lbl = entry.error_label || 'error';
      const aff = entry.affected_id ? `  -- ${entry.affected_id}` : '';
      push(`  ${red('[X]')} ${dim(ts)}  ${red(typ + ' fill ' + lbl)}${dim(aff)}`);
    }
  }
  push('');

  // ── Footer ─────────────────────────────────────────────────────────────────
  push(dim(`  last updated ${new Date().toLocaleTimeString()}  |  Ctrl+C exit`));

  clr();
  process.stdout.write(lines.join('\n') + '\n');
}

// ── HTTP fetch ────────────────────────────────────────────────────────────────
function fetchAndRender() {
  const req = http.get({ host: HOST, port: PORT, path: SITES_PATH }, res => {
    let raw = '';
    res.on('data', chunk => { raw += chunk; });
    res.on('end', () => {
      try {
        const d = JSON.parse(raw);
        render(d);
      } catch (e) {
        process.stdout.write(`${RED}[sitelens] parse error: ${e.message}${R}\n`);
      }
    });
    res.on('error', () => {});
  });
  req.on('error', err => {
    process.stdout.write(`${RED}[sitelens] fetch error: ${err.message}${R}\n`);
  });
  req.end();
}

// ── SSE reconnect guard ───────────────────────────────────────────────────────
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
process.stdout.write(`${DIM}[sitelens] connecting to http://${HOST}:${PORT}${SSE_PATH}...${R}\n`);
fetchAndRender();
connectSSE();
