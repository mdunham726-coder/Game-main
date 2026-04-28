/**
 * npcpanel.js -- NPC Truth Surface Panel
 * Standalone terminal display for NPC diagnostics.
 * Connects to /diagnostics/npc (poll) and /diagnostics/stream (SSE).
 * Run standalone: node npcpanel.js
 */

'use strict';

const http = require('http');

const HOST         = 'localhost';
const PORT         = 3000;
const NPC_PATH     = '/diagnostics/npc';
const SSE_PATH     = '/diagnostics/stream';
const RECONNECT_MS = 500;
const POLL_MS      = 5000;

// -- ANSI helpers -------------------------------------------------------------
const R   = '\x1b[0m';
const B   = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GRN = '\x1b[32m';
const YLW = '\x1b[33m';
const CYN = '\x1b[36m';
const WHT = '\x1b[37m';
const MAG = '\x1b[35m';

function clr()     { process.stdout.write('\x1b[H\x1b[2J\x1b[3J'); }
function bold(s)   { return `${B}${s}${R}`; }
function dim(s)    { return `${DIM}${s}${R}`; }
function red(s)    { return `${RED}${s}${R}`; }
function yel(s)    { return `${YLW}${s}${R}`; }
function grn(s)    { return `${GRN}${s}${R}`; }
function cyn(s)    { return `${CYN}${s}${R}`; }

const WIDTH = process.stdout.columns || 100;

function bar(c, w) { return c.repeat(Math.max(0, w)); }
function divider(label) {
  if (!label) return dim(bar('-', WIDTH));
  const inner = ` ${label} `;
  const side  = Math.max(2, Math.floor((WIDTH - inner.length) / 2));
  return dim(bar('-', side)) + bold(inner) + dim(bar('-', WIDTH - side - inner.length));
}

// -- State -------------------------------------------------------------------
let _screen      = 'list'; // 'list' | 'detail'
let _npcs        = [];
let _location    = null;
let _siteNpcCount = 0;
let _selectedIdx = 0;
let _lastFetchTs = null;
let _fetchError  = null;

// -- NPC display name --------------------------------------------------------
function npcDisplayName(npc) {
  if (npc.is_learned && npc.npc_name) return npc.npc_name;
  if (npc.job_category)               return `(${npc.job_category})`;
  return '(unfilled)';
}

// -- Location check label ----------------------------------------------------
function locationCheckLabel(npc) {
  const lc = npc._location_check || 'UNKNOWN';
  if (lc === 'OK')               return grn('OK');
  if (lc === 'POSITION MISMATCH') return yel('POSITION MISMATCH');
  if (lc === 'OTHER SITE')       return red('OTHER SITE');
  return yel(lc); // UNKNOWN or anything else
}

// -- Field checks ------------------------------------------------------------
const DS_FIELDS     = ['npc_name', 'gender', 'age', 'job_category'];
const CORE_FIELDS   = ['id', 'site_id', 'reputation_player', 'traits', 'is_learned', 'position', 'attributes'];

function runFieldChecks(npc) {
  const lines = [];
  const err  = (s) => lines.push(red(`  ERROR -- ${s}`));
  const warn = (s) => lines.push(yel(`  WARN  -- ${s}`));
  const ok   = (s) => lines.push(grn(`  OK    -- ${s}`));

  // Core fields must exist
  for (const f of CORE_FIELDS) {
    if (!(f in npc) || npc[f] === undefined) {
      err(`field absent: ${f}`);
    }
  }

  // DS-owned fields
  for (const f of DS_FIELDS) {
    if (npc[f] == null) {
      if (npc._fill_error) {
        err(`LLM fill failed: ${npc._fill_error}  [field: ${f}]`);
      } else {
        warn(`fill pending  [field: ${f}]`);
      }
    }
  }

  // reputation_player range
  if (npc.reputation_player != null) {
    if (typeof npc.reputation_player !== 'number' || npc.reputation_player < 0 || npc.reputation_player > 100) {
      err(`reputation_player out of range: ${npc.reputation_player}`);
    } else {
      ok(`reputation_player: ${npc.reputation_player}`);
    }
  }

  // traits
  if (!Array.isArray(npc.traits)) {
    err('traits is not an array');
  } else if (npc.traits.length < 2) {
    warn(`traits.length=${npc.traits.length} (expected >= 2)`);
  } else {
    ok(`traits: ${npc.traits.length} entries`);
  }

  // position
  if (!npc.position || typeof npc.position !== 'object') {
    err('position not an object');
  } else {
    const p = npc.position;
    if (p.lx == null || p.ly == null) {
      warn('position.lx/ly missing');
    } else {
      ok(`position: mx=${p.mx ?? '?'} my=${p.my ?? '?'} lx=${p.lx} ly=${p.ly}`);
    }
  }

  // _location_check
  const lc = npc._location_check || 'UNKNOWN';
  if (lc === 'OK') {
    ok('_location_check: OK');
  } else if (lc === 'POSITION MISMATCH') {
    warn('_location_check: POSITION MISMATCH');
  } else if (lc === 'OTHER SITE') {
    err('_location_check: OTHER SITE');
  } else {
    warn(`_location_check: ${lc}`);
  }

  // is_learned consistency
  if (npc.is_learned && !npc.npc_name) {
    warn('is_learned=true but npc_name is null');
  }

  if (lines.length === 0) {
    ok('no issues detected');
  }
  return lines;
}

// -- Render: list screen ------------------------------------------------------
function renderList() {
  const out = [];
  const ts  = _lastFetchTs ? new Date(_lastFetchTs).toLocaleTimeString() : '--';

  out.push(bold(`${MAG}${bar('=', WIDTH)}${R}`));
  out.push(bold(`${MAG}  NPC PANEL  --  LIST  ${R}`) + dim(`  loc: ${_location || '?'}  site_npcs: ${_siteNpcCount}  ${ts}`));
  out.push(bold(`${MAG}${bar('=', WIDTH)}${R}`));
  out.push('');

  if (_fetchError) {
    out.push(red(`  [fetch error] ${_fetchError}`));
    out.push('');
  }

  if (_npcs.length === 0) {
    out.push(dim('  (none visible at this tile)'));
  } else {
    for (let i = 0; i < _npcs.length; i++) {
      const npc = _npcs[i];
      const label = `${i + 1}. ${npcDisplayName(npc)}`;
      const lcTag = locationCheckLabel(npc);
      const idx   = String(i + 1);
      out.push(`  ${bold(cyn(idx))} ${WHT}${label.slice(3)}${R}  ${lcTag}`);
    }
  }

  out.push('');
  out.push(dim(bar('-', WIDTH)));
  const keys = _npcs.length > 0 ? '  1-9 select  |  r refresh  |  Ctrl+C exit' : '  r refresh  |  Ctrl+C exit';
  out.push(dim(keys));

  clr();
  process.stdout.write(out.join('\n') + '\n');
}

// -- Render: detail screen ----------------------------------------------------
function renderDetail(idx) {
  const npc = _npcs[idx];
  if (!npc) { _screen = 'list'; renderList(); return; }

  const out = [];
  const ts  = _lastFetchTs ? new Date(_lastFetchTs).toLocaleTimeString() : '--';
  const displayName = npcDisplayName(npc);

  out.push(bold(`${MAG}${bar('=', WIDTH)}${R}`));
  out.push(bold(`${MAG}  NPC PANEL  --  DETAIL  ${R}`) + dim(`  ${displayName}  ${ts}`));
  out.push(bold(`${MAG}${bar('=', WIDTH)}${R}`));
  out.push('');

  // -- Section 1: RAW ENGINE RECORD -----------------------------------------
  out.push(divider('RAW ENGINE RECORD'));
  out.push('');
  const _print = (npc) => {
    const entries = [];
    for (const [k, v] of Object.entries(npc)) {
      const val = (v === null) ? dim('null')
                : (v === undefined) ? dim('undefined')
                : (typeof v === 'object' && !Array.isArray(v)) ? JSON.stringify(v)
                : (Array.isArray(v)) ? `[${v.join(', ')}]`
                : String(v);
      entries.push(`  ${cyn(k)}: ${WHT}${val}${R}`);
    }
    return entries;
  };
  out.push(..._print(npc));
  out.push('');

  // -- Section 2: FIELD CHECKS -----------------------------------------------
  out.push(divider('FIELD CHECKS'));
  out.push('');
  out.push(...runFieldChecks(npc));
  out.push('');

  out.push(dim(bar('-', WIDTH)));
  out.push(dim('  b back  |  r refresh  |  Ctrl+C exit'));

  clr();
  process.stdout.write(out.join('\n') + '\n');
}

// -- Render dispatch ----------------------------------------------------------
function render() {
  if (_screen === 'detail') {
    renderDetail(_selectedIdx);
  } else {
    renderList();
  }
}

// -- Fetch NPCs ---------------------------------------------------------------
function fetchNpcs(callback) {
  const req = http.get({ host: HOST, port: PORT, path: NPC_PATH }, res => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', c => { body += c; });
    res.on('end', () => {
      try {
        const data = JSON.parse(body);
        _npcs         = Array.isArray(data.npcs) ? data.npcs : [];
        _location     = data.location || null;
        _siteNpcCount = data.site_npc_count || 0;
        _lastFetchTs  = Date.now();
        _fetchError   = null;
      } catch (e) {
        _fetchError = `parse error: ${e.message}`;
      }
      if (callback) callback();
    });
    res.on('error', e => {
      _fetchError = e.message;
      if (callback) callback();
    });
  });
  req.on('error', e => {
    _fetchError = e.message;
    if (callback) callback();
  });
  req.end();
}

// -- Polling fallback ---------------------------------------------------------
let _pollTimer = null;
function schedulePoll() {
  if (_pollTimer) clearTimeout(_pollTimer);
  _pollTimer = setTimeout(() => {
    fetchNpcs(() => { if (_screen !== 'detail') render(); schedulePoll(); });
  }, POLL_MS);
}

// -- SSE client ---------------------------------------------------------------
function connect() {
  process.stdout.write(`${DIM}[npcpanel] connecting to http://${HOST}:${PORT}${SSE_PATH}...${R}\n`);

  const req = http.get({ host: HOST, port: PORT, path: SSE_PATH, headers: { Accept: 'text/event-stream' } }, res => {
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    if (res.statusCode !== 200) {
      process.stdout.write(`${RED}[npcpanel] HTTP ${res.statusCode} -- retry in ${RECONNECT_MS}ms${R}\n`);
      res.resume();
      setTimeout(connect, RECONNECT_MS);
      return;
    }
    process.stdout.write(`${GRN}[npcpanel] connected -- waiting for first turn...${R}\n`);
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
          // New turn: fetch fresh NPC data, reset poll timer
          fetchNpcs(() => { if (_screen !== 'detail') render(); schedulePoll(); });
        }
      }
    });

    res.on('end', () => {
      process.stdout.write(`\n${YLW}[npcpanel] stream ended -- reconnecting in ${RECONNECT_MS}ms...${R}\n`);
      setTimeout(connect, RECONNECT_MS);
    });

    res.on('error', err => {
      process.stdout.write(`\n${RED}[npcpanel] stream error: ${err.message}${R}\n`);
      setTimeout(connect, RECONNECT_MS);
    });
  });

  req.on('error', err => {
    process.stdout.write(`${RED}[npcpanel] connection failed: ${err.message} -- retry in ${RECONNECT_MS}ms${R}\n`);
    setTimeout(connect, RECONNECT_MS);
  });

  req.end();
}

// -- Keyboard -----------------------------------------------------------------
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', key => {
    if (key === '\u0003') { process.exit(); } // Ctrl+C

    if (_screen === 'list') {
      if (key >= '1' && key <= '9') {
        const i = parseInt(key, 10) - 1;
        if (i < _npcs.length) {
          _selectedIdx = i;
          _screen = 'detail';
          render();
        }
      } else if (key === 'r' || key === 'R') {
        fetchNpcs(() => { render(); schedulePoll(); });
      }
    } else if (_screen === 'detail') {
      if (key === 'b' || key === 'B') {
        _screen = 'list';
        render();
      } else if (key === 'r' || key === 'R') {
        fetchNpcs(() => { render(); });
      }
    }
  });
}

// -- Startup ------------------------------------------------------------------
fetchNpcs(() => { render(); schedulePoll(); connect(); });
