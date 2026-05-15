'use strict';
// Generic statistical probe runner.
// Usage: node scripts/probe-runner.js --spec <path> [--runs N] [--seed-start N] [--strict]
//
// - Spec (.probe.json) defines what to measure: endpoint, request template, extract path, metrics.
// - This file owns ALL metric calculation logic. Specs declare names only.
// - probe-metrics.js is the single source of truth for valid metric names and required config keys.

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { METRIC_NAMES, METRIC_CONFIG_REQUIREMENTS } = require('./probe-metrics');

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { spec: null, runs: 10, seedStart: null, strict: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--spec'       && argv[i + 1]) { args.spec      = argv[++i]; continue; }
    if (argv[i] === '--runs'       && argv[i + 1]) { args.runs      = parseInt(argv[++i], 10); continue; }
    if (argv[i] === '--seed-start' && argv[i + 1]) { args.seedStart = parseInt(argv[++i], 10); continue; }
    if (argv[i] === '--strict')                     { args.strict    = true; continue; }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Dot-path resolution (e.g. "site_placement_log" or "state.world.position")
// ---------------------------------------------------------------------------
function dotGet(obj, dotPath) {
  if (!dotPath) return obj;
  return dotPath.split('.').reduce((cur, k) => (cur != null ? cur[k] : undefined), obj);
}

// ---------------------------------------------------------------------------
// Spec validation
// ---------------------------------------------------------------------------
const SUPPORTED_LIFECYCLES = ['session_per_run'];

function validateSpec(spec, specPath) {
  const errors = [];
  const req = (field) => { if (!spec[field]) errors.push(`spec missing required field: ${field}`); };
  req('name'); req('endpoint'); req('method'); req('extract');
  req('request_lifecycle'); req('metrics');

  if (spec.request_lifecycle && !SUPPORTED_LIFECYCLES.includes(spec.request_lifecycle)) {
    errors.push(`unsupported request_lifecycle: "${spec.request_lifecycle}". Supported: ${SUPPORTED_LIFECYCLES.join(', ')}`);
  }

  if (!Array.isArray(spec.metrics) || spec.metrics.length === 0) {
    errors.push('spec.metrics must be a non-empty array');
  } else {
    for (const m of spec.metrics) {
      if (!METRIC_NAMES.includes(m)) {
        errors.push(`unknown metric: "${m}"`);
      } else {
        // Check metric-specific config requirements
        const required = METRIC_CONFIG_REQUIREMENTS[m] || [];
        for (const dotPath of required) {
          if (dotGet(spec, dotPath) == null) {
            errors.push(`metric "${m}" requires spec field "${dotPath}"`);
          }
        }
      }
    }
  }

  if (spec.warnings) {
    for (const wk of Object.keys(spec.warnings)) {
      if (!METRIC_NAMES.includes(wk)) {
        errors.push(`spec.warnings references unknown metric: "${wk}"`);
      }
    }
  }

  if (spec.prompt_cycle != null) {
    if (!Array.isArray(spec.prompt_cycle) || spec.prompt_cycle.length === 0) {
      errors.push('spec.prompt_cycle must be a non-empty array');
    } else {
      for (let i = 0; i < spec.prompt_cycle.length; i++) {
        if (typeof spec.prompt_cycle[i] !== 'string' || spec.prompt_cycle[i].trim() === '') {
          errors.push(`spec.prompt_cycle[${i}] must be a non-empty string`);
        }
      }
    }
  }

  if (spec.prompt_mode != null) {
    if (spec.prompt_mode !== 'cycle' && spec.prompt_mode !== 'random') {
      errors.push('spec.prompt_mode must be "cycle" or "random"');
    }
    if (spec.prompt_cycle == null) {
      errors.push('spec.prompt_mode requires spec.prompt_cycle to be defined');
    }
  }

  if (spec.post_extract != null) {
    if (typeof spec.post_extract.endpoint !== 'string' || spec.post_extract.endpoint.trim() === '') {
      errors.push('spec.post_extract.endpoint must be a non-empty string');
    }
    if (typeof spec.post_extract.extract !== 'string' || spec.post_extract.extract.trim() === '') {
      errors.push('spec.post_extract.extract must be a non-empty string');
    }
  }

  if (spec.max_retries != null) {
    if (!Number.isInteger(spec.max_retries) || spec.max_retries < 0 || spec.max_retries > 10) {
      errors.push('spec.max_retries must be a non-negative integer <= 10');
    }
  }

  if (spec.row_extract != null) {
    if (typeof spec.row_extract !== 'object' || Array.isArray(spec.row_extract)) {
      errors.push('spec.row_extract must be a plain object');
    } else {
      for (const [k, v] of Object.entries(spec.row_extract)) {
        if (typeof v !== 'string' || v.trim() === '') {
          errors.push(`spec.row_extract["${k}"] must be a non-empty string dot-path`);
        }
      }
    }
  }

  if (errors.length > 0) {
    console.error(`[probe-runner] Spec validation failed (${specPath}):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// HTTP request helper
// ---------------------------------------------------------------------------
function httpPost(host, port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { host, port, path: `/${urlPath}`, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          }
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error(`JSON parse failed: ${e.message}`)); }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function httpGet(host, port, urlPath, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host, port, path: `/${urlPath}`, method: 'GET', headers: headers || {} },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          }
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error(`JSON parse failed: ${e.message}`)); }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function httpDelete(host, port, urlPath, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host, port, path: `/${urlPath}`, method: 'DELETE', headers: headers || {} },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => { resolve(res.statusCode); });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Parse parent_cell string: "LOC:mx,my:lx,ly" -> { mx, my, lx, ly }
// ---------------------------------------------------------------------------
function parseParentCell(str) {
  const m = /^LOC:(\d+),(\d+):(\d+),(\d+)$/.exec(str);
  if (!m) return null;
  return { mx: +m[1], my: +m[2], lx: +m[3], ly: +m[4] };
}

// ---------------------------------------------------------------------------
// Metric calculations
// ---------------------------------------------------------------------------
function computeMetrics(metricNames, log, spec, response, activeSite = null) {
  const results = {};
  const totalSites = log.total_sites_placed || 0;
  const totalCells = log.total_cells_evaluated || 0;
  const placed     = Array.isArray(log.placed_sites) ? log.placed_sites : [];

  // Parse all parent cells once
  const cellCounts = {};    // "lx,ly" -> count
  let parseError = null;
  for (const s of placed) {
    const parsed = parseParentCell(s.parent_cell);
    if (!parsed) { parseError = s.parent_cell; break; }
    const key = `${parsed.lx},${parsed.ly}`;
    cellCounts[key] = (cellCounts[key] || 0) + 1;
  }
  if (parseError) throw new Error(`Unparseable parent_cell: "${parseError}"`);

  const populatedCells = Object.keys(cellCounts).length;
  const maxPerCell     = populatedCells > 0 ? Math.max(...Object.values(cellCounts)) : 0;

  for (const m of metricNames) {
    switch (m) {
      case 'total_sites_placed':            results[m] = totalSites; break;
      case 'total_cells_evaluated':         results[m] = totalCells; break;
      case 'populated_cells_count':         results[m] = populatedCells; break;
      case 'pct_populated_cells':           results[m] = totalCells > 0 ? (populatedCells / totalCells) * 100 : 0; break;
      case 'empty_cells_count':             results[m] = totalCells - populatedCells; break;
      case 'max_sites_per_cell':            results[m] = maxPerCell; break;
      case 'mean_sites_per_populated_cell': results[m] = populatedCells > 0 ? totalSites / populatedCells : 0; break;
      case 'enterable_ratio':               results[m] = totalSites > 0 ? (log.total_enterable || 0) / totalSites : 0; break;
      case 'spacing_rejections':            results[m] = log.spacing_rejections || 0; break;
      case 'edge_concentration_pct':        results[m] = computeEdgePct(placed, spec, response); break;
      case 'cell_occupancy_entropy': {
        // Shannon entropy of sites-per-cell distribution
        const _total = placed.length;
        if (_total === 0) { results[m] = 0; break; }
        let _entropy = 0;
        for (const _count of Object.values(cellCounts)) {
          const _p = _count / _total;
          _entropy -= _p * Math.log2(_p);
        }
        results[m] = _entropy;
        break;
      }
      case 'site_size_stddev': {
        // Stddev of placed site sizes, from log.size_counts
        const _sc = log.size_counts || {};
        const _sizes = [];
        for (const [_sz, _cnt] of Object.entries(_sc)) {
          for (let _i = 0; _i < _cnt; _i++) _sizes.push(Number(_sz));
        }
        if (_sizes.length === 0) { results[m] = 0; break; }
        const _mean = _sizes.reduce((a, b) => a + b, 0) / _sizes.length;
        const _variance = _sizes.reduce((s, v) => s + (v - _mean) ** 2, 0) / _sizes.length;
        results[m] = Math.sqrt(_variance);
        break;
      }
      case 'community_ratio':
        results[m] = placed.length > 0 ? placed.filter(s => s.is_community).length / placed.length : 0;
        break;
      case 'isolated_cells_count': {
        // Occupied cells with no 4-directional occupied neighbor
        const _cellSet = new Set(Object.keys(cellCounts));
        let _isolated = 0;
        for (const _key of _cellSet) {
          const [_lx, _ly] = _key.split(',').map(Number);
          const _hasNeighbor = _cellSet.has(`${_lx+1},${_ly}`) || _cellSet.has(`${_lx-1},${_ly}`) ||
                               _cellSet.has(`${_lx},${_ly+1}`) || _cellSet.has(`${_lx},${_ly-1}`);
          if (!_hasNeighbor) _isolated++;
        }
        results[m] = _isolated;
        break;
      }
      // Localspace distribution metrics — require post_extract to have fired
      case 'ls_pct':                  results[m] = activeSite != null ? (activeSite.ls_pct ?? null) : null; break;
      case 'eligible_tile_count':      results[m] = activeSite != null ? (activeSite.eligible_tile_count ?? null) : null; break;
      case 'localspace_count': {
        if (activeSite == null || !Array.isArray(activeSite.local_spaces)) { results[m] = null; break; }
        results[m] = activeSite.local_spaces.length;
        break;
      }
      case 'enterable_localspace_ratio': {
        if (activeSite == null || !Array.isArray(activeSite.local_spaces)) { results[m] = null; break; }
        const _spaces = activeSite.local_spaces;
        if (_spaces.length === 0) { results[m] = null; break; }
        const _enterable = _spaces.filter(s => s.enterable !== false).length;
        results[m] = _enterable / _spaces.length;
        break;
      }
      case 'site_size':                results[m] = activeSite != null ? (activeSite.site_size ?? null) : null; break;
      case 'ls_fill_rate': {
        if (activeSite == null || !Array.isArray(activeSite.local_spaces)) { results[m] = null; break; }
        const _spaces = activeSite.local_spaces;
        if (_spaces.length === 0) { results[m] = null; break; }
        const _named = _spaces.filter(s => s.name != null && String(s.name).trim() !== '').length;
        results[m] = _named / _spaces.length;
        break;
      }
      case 'ls_unique_name_rate': {
        if (activeSite == null || !Array.isArray(activeSite.local_spaces)) { results[m] = null; break; }
        const _spaces = activeSite.local_spaces;
        if (_spaces.length === 0) { results[m] = null; break; }
        const _names = _spaces.map(s => s.name).filter(n => n != null && String(n).trim() !== '');
        const _unique = new Set(_names.map(n => String(n).toLowerCase().trim())).size;
        results[m] = _unique / _spaces.length;
        break;
      }
      case 'ls_size_spread': {
        if (activeSite == null || !Array.isArray(activeSite.local_spaces)) { results[m] = null; break; }
        const _sizes = activeSite.local_spaces.map(s => s.localspace_size).filter(s => s != null);
        if (_sizes.length === 0) { results[m] = null; break; }
        results[m] = Math.max(..._sizes) - Math.min(..._sizes);
        break;
      }
      case 'ls_mean_size': {
        if (activeSite == null || !Array.isArray(activeSite.local_spaces)) { results[m] = null; break; }
        const _sizes = activeSite.local_spaces.map(s => s.localspace_size).filter(s => s != null);
        if (_sizes.length === 0) { results[m] = null; break; }
        results[m] = _sizes.reduce((a, b) => a + b, 0) / _sizes.length;
        break;
      }
      // Continuity/narrator metrics — reads from activeSite when post_extract resolves to a number,
      // otherwise falls back to the primary /narrate response at debug.narration_debug.continuity_block_chars.
      // post_extract is NOT required for this metric; the fallback covers single-turn probe specs.
      case 'continuity_block_chars': {
        if (typeof activeSite === 'number') {
          results[m] = activeSite;
        } else {
          const _fallback = dotGet(response, 'debug.narration_debug.continuity_block_chars');
          results[m] = (typeof _fallback === 'number') ? _fallback : null;
        }
        break;
      }
      default: results[m] = null;
    }
  }
  return results;
}

function computeEdgePct(placed, spec, response) {
  if (placed.length === 0) return 0;

  // Topology from spec (validated to exist before we get here)
  const radius     = spec.edge_topology && spec.edge_topology.radius;
  const anchorPath = spec.edge_topology && spec.edge_topology.anchor_path;
  const anchor     = anchorPath ? dotGet(response, anchorPath) : null;

  let edgeCount = 0;
  let edgeBoundsSource = 'patch_radius_anchor';

  if (radius != null && anchor && anchor.lx != null && anchor.ly != null) {
    // Primary path: use declared patch radius + anchor position
    for (const s of placed) {
      const p = parseParentCell(s.parent_cell);
      if (!p) continue;
      if (Math.abs(p.lx - anchor.lx) === radius || Math.abs(p.ly - anchor.ly) === radius) edgeCount++;
    }
  } else {
    // Fallback: infer from min/max of lx, ly in placed sites
    edgeBoundsSource = 'inferred';
    const lxVals = placed.map(s => parseParentCell(s.parent_cell)?.lx).filter(v => v != null);
    const lyVals = placed.map(s => parseParentCell(s.parent_cell)?.ly).filter(v => v != null);
    const lxMin = Math.min(...lxVals), lxMax = Math.max(...lxVals);
    const lyMin = Math.min(...lyVals), lyMax = Math.max(...lyVals);
    for (const s of placed) {
      const p = parseParentCell(s.parent_cell);
      if (!p) continue;
      if (p.lx === lxMin || p.lx === lxMax || p.ly === lyMin || p.ly === lyMax) edgeCount++;
    }
  }

  // Store source on result as a side-channel string (runner will print it once per run if inferred)
  computeEdgePct._lastSource = edgeBoundsSource;
  return placed.length > 0 ? (edgeCount / placed.length) * 100 : 0;
}

// ---------------------------------------------------------------------------
// Statistics helpers
// ---------------------------------------------------------------------------
function stats(values) {
  if (values.length === 0) return { min: null, max: null, mean: null, stddev: null };
  const min  = Math.min(...values);
  const max  = Math.max(...values);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return { min, max, mean, stddev: Math.sqrt(variance) };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function fmt(v, decimals = 2) {
  if (v == null) return 'n/a';
  return typeof v === 'number' ? v.toFixed(decimals) : String(v);
}

// ---------------------------------------------------------------------------
// Warning evaluation
// ---------------------------------------------------------------------------
function checkWarnings(metricName, value, warningDef, isAggregate) {
  if (!warningDef) return [];
  const msgs = [];
  if (warningDef.aggregate_only && !isAggregate) return [];
  if (warningDef.min  != null && value < warningDef.min)  msgs.push(`${metricName} = ${fmt(value)} below min ${warningDef.min}`);
  if (warningDef.max  != null && value > warningDef.max)  msgs.push(`${metricName} = ${fmt(value)} above max ${warningDef.max}`);
  if (warningDef.hard_max != null && value > warningDef.hard_max) msgs.push(`${metricName} = ${fmt(value)} exceeds hard_max ${warningDef.hard_max}`);
  return msgs;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const cliArgs = parseArgs(process.argv);

  if (!cliArgs.spec) {
    console.error('[probe-runner] --spec <path> is required');
    process.exit(1);
  }

  const specPath = path.resolve(process.cwd(), cliArgs.spec);
  if (!fs.existsSync(specPath)) {
    console.error(`[probe-runner] Spec file not found: ${specPath}`);
    process.exit(1);
  }

  let spec;
  try { spec = JSON.parse(fs.readFileSync(specPath, 'utf8')); }
  catch (e) { console.error(`[probe-runner] Failed to parse spec JSON: ${e.message}`); process.exit(1); }

  validateSpec(spec, specPath);

  const PORT   = parseInt(process.env.PORT || '3000', 10);
  const runs   = cliArgs.runs;
  const strict = cliArgs.strict;

  // ── Durable logging setup ────────────────────────────────────────────────
  const _now       = new Date();
  const _pad       = (n) => String(n).padStart(2, '0');
  const _timestamp = `${_now.getFullYear()}-${_pad(_now.getMonth() + 1)}-${_pad(_now.getDate())}_${_pad(_now.getHours())}${_pad(_now.getMinutes())}`;
  const _slug      = (spec.name || 'probe').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32);
  const _relDir    = `tests/probe-results/${_timestamp}_${_slug}`;
  const _resultDir = path.join(process.cwd(), 'tests', 'probe-results', `${_timestamp}_${_slug}`);
  fs.mkdirSync(_resultDir, { recursive: true });
  fs.writeFileSync(path.join(_resultDir, 'spec.snapshot.json'), JSON.stringify(spec, null, 2) + '\n', 'utf8');

  const _logLines    = [];
  const _runsPath    = path.join(_resultDir, 'runs.jsonl');
  const _errorsPath  = path.join(_resultDir, 'errors.jsonl');
  const _consolePath = path.join(_resultDir, 'console.txt');
  const _summaryPath = path.join(_resultDir, 'summary.json');
  fs.writeFileSync(_errorsPath, '', 'utf8'); // always created; populated only on hard-error rows
  const _startedAt   = new Date();
  const aggregateStats = {};

  // Owned output helper: prints to CMD and captures for console.txt
  function writeConsole(line) {
    console.log(line);
    _logLines.push(line);
  }

  // Row writer: appends to runs.jsonl always; also writes to errors.jsonl and collects hardErrorRows when error != null
  function writeRunRow(rowObj) {
    const _rowLine = JSON.stringify(rowObj) + '\n';
    fs.appendFileSync(_runsPath, _rowLine, 'utf8');
    if (rowObj.error != null) {
      hardErrorRows.push(rowObj);
      fs.appendFileSync(_errorsPath, _rowLine, 'utf8');
    }
  }

  writeConsole('');
  writeConsole(`[probe-runner] Results folder: ${_relDir}`);
  writeConsole(`[probe-runner] Spec: ${spec.name}`);
  writeConsole(`[probe-runner] Runs: ${runs} | Lifecycle: ${spec.request_lifecycle} | Strict: ${strict}`);
  writeConsole(`[probe-runner] Metrics: ${spec.metrics.join(', ')}`);
  writeConsole('');

  const allResults    = [];   // array of { seed, metrics: {}, warnings: [] }
  const hardErrors    = [];   // error message strings
  const hardErrorRows = [];   // full row objects for failed runs — written to errors.jsonl + summary.json
  let   softWarnings  = [];

  for (let i = 0; i < runs; i++) {
    const seed = cliArgs.seedStart != null
      ? cliArgs.seedStart + i
      : (Math.random() * 0xFFFFFFFF | 0);
    let _sessionId  = null; // populated after successful POST; null on HTTP error
    let _retries    = 0;    // incremented on each transient retry
    const _maxRetries = spec.max_retries != null ? spec.max_retries : 2;

    // Build request body — apply prompt_cycle override then substitute $SEED / $PROMPT
    let templateToUse = spec.request_template;
    let promptLabel   = null;
    let promptText    = null;
    if (Array.isArray(spec.prompt_cycle) && spec.prompt_cycle.length > 0) {
      const isRandom   = spec.prompt_mode === 'random';
      const promptIdx  = isRandom
        ? Math.floor(Math.random() * spec.prompt_cycle.length)
        : i % spec.prompt_cycle.length;
      promptText       = spec.prompt_cycle[promptIdx];
      templateToUse    = Object.assign({}, spec.request_template, { action: promptText });
      const truncated  = promptText.length > 40 ? promptText.slice(0, 40) + '...' : promptText;
      promptLabel      = isRandom
        ? `random "${truncated}"`
        : `prompt=${promptIdx + 1}/${spec.prompt_cycle.length} "${truncated}"`;
    }
    let _bodyJson = JSON.stringify(templateToUse).replace(/"\$SEED"/g, String(seed));
    if (promptText != null) {
      _bodyJson = _bodyJson.replace(/"\$PROMPT"/g, JSON.stringify(promptText));
    }
    const body = JSON.parse(_bodyJson);

    let response;
    let log;
    // Retry loop — only retries transient fill/engine failures; HTTP errors and non-transient null extracts are not retried
    runLoop: while (true) {
      try {
        response = await httpPost('localhost', PORT, spec.endpoint, body);
      } catch (e) {
        const errMsg = `HTTP error: ${e.message}`;
        hardErrors.push(`[RUN ${i + 1}] ${errMsg}`);
        writeConsole(`[RUN ${i + 1}] seed=${seed}${promptLabel ? ' ' + promptLabel : ''} ERROR: ${e.message}`);
        writeRunRow({ run: i + 1, seed, prompt_text: promptText, prompt_label: promptLabel, session_id: null, retries: _retries, metrics: null, warnings: [], error: errMsg });
        log = null;
        break runLoop;
      }

      _sessionId = response.sessionId ?? null;
      // Extract log from response
      log = dotGet(response, spec.extract);
      if (log == null) {
        const _errCode = (response && response.error) ? String(response.error) : 'missing_extract';
        // Retry on any null extract — worldgen failures can have arbitrary error codes
        if (_retries < _maxRetries) {
          _retries++;
          writeConsole(`[RUN ${i + 1}] retry ${_retries}/${_maxRetries} (${_errCode}) seed=${seed}`);
          continue runLoop;
        }
        const _retrySuffix = _retries > 0 ? ` after ${_retries} retr${_retries === 1 ? 'y' : 'ies'}` : '';
        const errMsg = `missing extract path "${spec.extract}"${_retrySuffix}`;
        hardErrors.push(`[RUN ${i + 1}] extract path "${spec.extract}" returned null/undefined${_retrySuffix}`);
        writeConsole(`[RUN ${i + 1}] seed=${seed}${promptLabel ? ' ' + promptLabel : ''} ERROR: ${errMsg}`);
        writeRunRow({ run: i + 1, seed, prompt_text: promptText, prompt_label: promptLabel, session_id: _sessionId, retries: _retries, metrics: null, warnings: [], error: errMsg });
        break runLoop;
      }
      break runLoop; // log populated — exit retry loop
    }
    if (log == null) continue; // run failed — advance to next run

    // Guard: placed_sites empty when count > 0
    if ((log.total_sites_placed || 0) > 0 && (!Array.isArray(log.placed_sites) || log.placed_sites.length === 0)) {
      const errMsg = `placed_sites empty but total_sites_placed=${log.total_sites_placed}`;
      hardErrors.push(`[RUN ${i + 1}] ${errMsg}`);
      writeConsole(`[RUN ${i + 1}] seed=${seed}${promptLabel ? ' ' + promptLabel : ''} ERROR: placed_sites empty`);
      writeRunRow({ run: i + 1, seed, prompt_text: promptText, prompt_label: promptLabel, session_id: _sessionId, retries: _retries, metrics: null, warnings: [], error: errMsg });
      continue;
    }

    // post_extract: secondary GET to session-scoped diagnostics endpoint (e.g. /diagnostics/sites)
    let activeSite = null;
    if (spec.post_extract) {
      if (!_sessionId) {
        const errMsg = 'post_extract: response missing sessionId';
        hardErrors.push(`[RUN ${i + 1}] ${errMsg}`);
        writeConsole(`[RUN ${i + 1}] seed=${seed}${promptLabel ? ' ' + promptLabel : ''} ERROR: ${errMsg}`);
        writeRunRow({ run: i + 1, seed, prompt_text: promptText, prompt_label: promptLabel, session_id: null, retries: _retries, metrics: null, warnings: [], error: errMsg });
        continue;
      }
      const _diagKey  = process.env.DIAGNOSTICS_KEY || '';
      const _peUrl    = `${spec.post_extract.endpoint}?sessionId=${encodeURIComponent(_sessionId)}`;
      const _peHeaders = _diagKey ? { 'x-diagnostics-key': _diagKey } : {};
      try {
        const _sitesResp = await httpGet('localhost', PORT, _peUrl, _peHeaders);
        activeSite = dotGet(_sitesResp, spec.post_extract.extract);
        if (activeSite == null) {
          const errMsg = `post_extract: extract path "${spec.post_extract.extract}" returned null`;
          hardErrors.push(`[RUN ${i + 1}] ${errMsg}`);
          writeConsole(`[RUN ${i + 1}] seed=${seed}${promptLabel ? ' ' + promptLabel : ''} ERROR: ${errMsg}`);
          writeRunRow({ run: i + 1, seed, prompt_text: promptText, prompt_label: promptLabel, session_id: _sessionId, retries: _retries, metrics: null, warnings: [], error: errMsg });
          continue;
        }
      } catch (e) {
        const errMsg = `post_extract HTTP error: ${e.message}`;
        hardErrors.push(`[RUN ${i + 1}] ${errMsg}`);
        writeConsole(`[RUN ${i + 1}] seed=${seed}${promptLabel ? ' ' + promptLabel : ''} ERROR: ${errMsg}`);
        writeRunRow({ run: i + 1, seed, prompt_text: promptText, prompt_label: promptLabel, session_id: _sessionId, retries: _retries, metrics: null, warnings: [], error: errMsg });
        continue;
      }
    }

    // Derive diagnostic enrichment fields from activeSite for per-run log row
    let _siteDiagId = null, _siteDiagName = null;
    let _localspaceDetail = null;
    let _expectedLsCount = null, _formulaMatch = null;
    let _nullFields = [];
    if (activeSite != null) {
      _siteDiagId   = activeSite.site_id ?? null;
      _siteDiagName = activeSite.name    ?? null;
      if (Array.isArray(activeSite.local_spaces) && activeSite.local_spaces.length > 0) {
        _localspaceDetail = activeSite.local_spaces.map(ls => ({
          local_space_id:  ls.local_space_id  ?? null,
          localspace_size: ls.localspace_size ?? null,
          enterable:       ls.enterable       ?? null,
          width:           ls.width           ?? null,
          height:          ls.height          ?? null,
        }));
      }
      const _elg = activeSite.eligible_tile_count;
      const _pct = activeSite.ls_pct;
      if (_elg != null && _pct != null) {
        _expectedLsCount = Math.max(1, Math.floor(_elg * _pct / 100));
        const _actualLs  = Array.isArray(activeSite.local_spaces) ? activeSite.local_spaces.length : null;
        _formulaMatch    = _actualLs != null ? _actualLs === _expectedLsCount : null;
      }
      for (const _f of ['site_id', 'name', 'site_size', 'ls_pct', 'eligible_tile_count']) {
        if (activeSite[_f] == null) _nullFields.push(_f);
      }
    }

    // row_extract: store arbitrary activeSite dot-paths as extra fields on the row (generic, spec-defined)
    const _rowExtractFields = {};
    if (spec.row_extract && activeSite != null) {
      for (const [k, dotPath] of Object.entries(spec.row_extract)) {
        _rowExtractFields[k] = dotGet(activeSite, dotPath) ?? null;
      }
    }

    // Compute metrics
    let metrics;
    try {
      metrics = computeMetrics(spec.metrics, log, spec, response, activeSite);
    } catch (e) {
      const errMsg = `metric computation error: ${e.message}`;
      hardErrors.push(`[RUN ${i + 1}] ${errMsg}`);
      writeConsole(`[RUN ${i + 1}] seed=${seed}${promptLabel ? ' ' + promptLabel : ''} ERROR: ${e.message}`);
      writeRunRow({ run: i + 1, seed, prompt_text: promptText, prompt_label: promptLabel, session_id: _sessionId, retries: _retries, metrics: null, warnings: [], error: errMsg });
      continue;
    }

    // Per-run soft warning check (skip aggregate_only thresholds)
    const runWarnings = [];
    if (spec.warnings) {
      for (const [mk, wd] of Object.entries(spec.warnings)) {
        if (metrics[mk] != null) {
          runWarnings.push(...checkWarnings(mk, metrics[mk], wd, false));
        }
      }
    }
    if (runWarnings.length > 0) softWarnings.push(...runWarnings.map(w => `[RUN ${i + 1}] ${w}`));

    const edgeSrc = computeEdgePct._lastSource !== 'patch_radius_anchor' ? ` [edge:${computeEdgePct._lastSource}]` : '';

    // One-line run summary
    writeConsole(
      `[RUN ${i + 1}] seed=${seed}` +
      (promptLabel ? ' ' + promptLabel : '') +
      (metrics.total_sites_placed      != null ? ` total_sites=${fmt(metrics.total_sites_placed, 0)}` : '') +
      (metrics.populated_cells_count   != null ? ` populated=${fmt(metrics.populated_cells_count, 0)}` : '') +
      (metrics.pct_populated_cells     != null ? ` (${fmt(metrics.pct_populated_cells, 1)}%)` : '') +
      (metrics.max_sites_per_cell      != null ? ` max_in_cell=${fmt(metrics.max_sites_per_cell, 0)}` : '') +
      (metrics.enterable_ratio         != null ? ` enterable=${fmt(metrics.enterable_ratio * 100, 0)}%` : '') +
      (metrics.edge_concentration_pct  != null ? ` edge=${fmt(metrics.edge_concentration_pct, 1)}%${edgeSrc}` : '') +
      (metrics.spacing_rejections          != null ? ` rejections=${fmt(metrics.spacing_rejections, 0)}` : '') +
      (metrics.ls_pct                       != null ? ` ls_pct=${fmt(metrics.ls_pct, 0)}%` : '') +
      (metrics.localspace_count             != null ? ` ls_count=${fmt(metrics.localspace_count, 0)}` : '') +
      (metrics.eligible_tile_count          != null ? ` eligible_tiles=${fmt(metrics.eligible_tile_count, 0)}` : '') +
      (runWarnings.length > 0 ? ' [WARN]' : '')
    );

    allResults.push({ seed, metrics, warnings: runWarnings });
    writeRunRow({
      run: i + 1, seed,
      prompt_text:               promptText,
      prompt_label:              promptLabel,
      session_id:                _sessionId,
      retries:                   _retries,
      site_id:                   _siteDiagId,
      site_name:                 _siteDiagName,
      expected_localspace_count: _expectedLsCount,
      formula_match:             _formulaMatch,
      localspace_detail:         _localspaceDetail,
      null_fields:               _nullFields.length > 0 ? _nullFields : null,
      ..._rowExtractFields,
      metrics,
      warnings: runWarnings,
      error: null,
    });

    // Explicit session teardown — free server memory immediately after all data is captured.
    // This keeps RAM flat regardless of run count (critical for 500-1000 run tests).
    if (_sessionId) {
      try {
        await httpDelete('localhost', PORT, `session?sessionId=${encodeURIComponent(_sessionId)}`);
      } catch (_delErr) {
        // Non-fatal — server may have already evicted it; do not abort the probe.
      }
    }

    // Inter-run delay: let the server settle between worldgen sessions.
    // Spec field `inter_run_delay_ms` overrides default. Skip delay after the last run.
    if (i < runs - 1) {
      const delayMs = (spec.inter_run_delay_ms != null) ? spec.inter_run_delay_ms : 3000;
      if (delayMs > 0) {
        writeConsole(`[pause] ${delayMs}ms between runs…`);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Aggregate block
  // ---------------------------------------------------------------------------
  writeConsole('');
  writeConsole('='.repeat(70));
  writeConsole(`AGGREGATE  (${allResults.length}/${runs} runs succeeded)`);
  writeConsole('='.repeat(70));

  const aggregateWarnings = [];
  const pctMetrics = new Set(spec.percentile_metrics || []);

  for (const m of spec.metrics) {
    const values = allResults.map(r => r.metrics[m]).filter(v => v != null);
    if (values.length === 0) { writeConsole(`  ${m.padEnd(32)} no data`); continue; }

    const s = stats(values);
    aggregateStats[m] = { min: s.min, max: s.max, mean: s.mean, stddev: s.stddev };
    let line = `  ${m.padEnd(32)} min=${fmt(s.min)}  max=${fmt(s.max)}  mean=${fmt(s.mean)}  stddev=${fmt(s.stddev)}`;

    if (pctMetrics.has(m)) {
      const sorted = [...values].sort((a, b) => a - b);
      const p10 = percentile(sorted, 10), p50 = percentile(sorted, 50), p90 = percentile(sorted, 90);
      aggregateStats[m].p10 = p10; aggregateStats[m].p50 = p50; aggregateStats[m].p90 = p90;
      line += `  p10=${fmt(p10)}  p50=${fmt(p50)}  p90=${fmt(p90)}`;
    }

    // Aggregate-only warning check
    if (spec.warnings && spec.warnings[m]) {
      const ws = checkWarnings(m, s.mean, spec.warnings[m], true);
      if (ws.length > 0) { aggregateWarnings.push(...ws.map(w => `[AGGREGATE] ${w} (mean)`)); line += ' [WARN]'; }
    }

    writeConsole(line);
  }

  // ---------------------------------------------------------------------------
  // Write summary.json
  // ---------------------------------------------------------------------------
  const _summary = {
    spec_name:           spec.name,
    spec_slug:           _slug,
    started_at:          _startedAt.toISOString(),
    completed_at:        new Date().toISOString(),
    runs_requested:      runs,
    runs_completed:      allResults.length,
    hard_errors:         hardErrors.length,
    hard_error_rows:     hardErrorRows,
    soft_warnings_total: softWarnings.length + aggregateWarnings.length,
    aggregate_warnings:  aggregateWarnings,
    metrics:             aggregateStats,
  };
  fs.writeFileSync(_summaryPath, JSON.stringify(_summary, null, 2) + '\n', 'utf8');
  writeConsole(`[probe-runner] Results saved: ${_relDir}`);

  // ---------------------------------------------------------------------------
  // Final anomaly summary
  // ---------------------------------------------------------------------------
  const hasHard = hardErrors.length > 0;
  const hasSoft = softWarnings.length > 0 || aggregateWarnings.length > 0;

  if (hasHard || hasSoft) {
    writeConsole('');
    writeConsole('-'.repeat(70));
    if (hasHard) {
      writeConsole('HARD ERRORS (exit 1):');
      for (const e of hardErrors) writeConsole(`  [ERROR] ${e}`);
    }
    if (hasSoft) {
      writeConsole('SOFT WARNINGS:');
      for (const w of [...softWarnings, ...aggregateWarnings]) writeConsole(`  [WARN] ${w}`);
    }
    writeConsole('-'.repeat(70));
  } else {
    writeConsole('');
    writeConsole('[probe-runner] No anomalies detected.');
  }

  // Write console.txt — full captured probe-runner output
  fs.writeFileSync(_consolePath, _logLines.join('\n') + '\n', 'utf8');

  if (hasHard) { process.exit(1); }
  if (hasSoft && strict) { process.exit(1); }
  process.exit(0);
}

main().catch((e) => {
  console.error('[probe-runner] Fatal:', e.message);
  process.exit(1);
});
