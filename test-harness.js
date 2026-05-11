'use strict';

// =============================================================================
// GAME TEST HARNESS
// Drives the game server via HTTP. Run against an already-running local server.
// No npm dependencies — pure Node.js built-ins.
//
// Usage:
//   node test-harness.js                        — run all built-in scenarios
//   node test-harness.js --scenario <name>       — run one built-in scenario
//   node test-harness.js --file <path>           — run external JSON scenario(s)
//   node test-harness.js --server <url>          — override base URL
//   node test-harness.js --verbose               — print scene/narrative text
//   node test-harness.js --json                  — print full response JSON
//   node test-harness.js --out <dir>             — write fail dumps to directory
//   node test-harness.js --yes                   — confirm paid headless runs (bypasses Y/N; does not bypass HARNESS_MAX_COST_USD)
// =============================================================================

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ─── CLI arg parsing ──────────────────────────────────────────────────────────
const _args = process.argv.slice(2);

function getFlag(name) {
  const i = _args.indexOf(name);
  if (i === -1) return null;
  return _args[i + 1] || true;
}
function hasFlag(name) { return _args.includes(name); }

const BASE_URL        = getFlag('--server')   || 'http://localhost:3000';
let   VERBOSE         = hasFlag('--verbose');
const JSON_MODE       = hasFlag('--json');
const ONLY_NAME       = getFlag('--scenario') || null;
const FILE_PATH       = getFlag('--file')     || null;
let   OUT_DIR         = getFlag('--out')      || null;
const INTERACTIVE_MODE = _args.length === 0;
const HAS_YES          = hasFlag('--yes');

// ─── Cost estimation & safety config ─────────────────────────────────────────
// DeepSeek V4 Flash pricing. Source: api-docs.deepseek.com (May 10 2026).
// Update manually — do NOT rely on live fetch during runs.
const COST_ESTIMATES = {
  model:               'DeepSeek V4 Flash',
  inputPerMillionUsd:  0.14,   // cache-miss rate; actual likely lower due to prompt caching
  outputPerMillionUsd: 0.28,
};
// Hard guardrail. Interactive: require exact-cost string to override. Headless: always refuse.
const HARNESS_MAX_COST_USD = 1.00;

// ─── Per-scenario token estimates ─────────────────────────────────────────────
// Conservative estimates per scenario. Long-term should account for context size
// growth, continuity packet size, and Mother Brain injections.
const SCENARIO_TOKEN_ESTIMATES = {
  worldgen_basic:          { turns: 1, inputTokens: 22000, outputTokens: 4000 },
  founding_premise:        { turns: 1, inputTokens: 22000, outputTokens: 4000 },
  multi_turn_session:      { turns: 3, inputTokens: 60000, outputTokens: 9000 },
  site_placement_endpoint: { turns: 0, inputTokens: 0,     outputTokens: 0    },
};
const UNKNOWN_SCENARIO_ESTIMATE = { turns: 3, inputTokens: 30000, outputTokens: 5000 };

// ─── Session cost accumulator ─────────────────────────────────────────────────
let _sessionCost = { estimatedUsd: 0, actualUsd: 0, actualAvailable: false, runs: 0, turns: 0 };

// ─── HTTP helper ──────────────────────────────────────────────────────────────
function httpRequest(method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (e) { return reject(new Error(`Bad URL: ${url}`)); }

    const lib     = parsed.protocol === 'https:' ? https : http;
    const bodyStr = body ? JSON.stringify(body) : null;
    const reqHeaders = { 'Content-Type': 'application/json', ...headers };
    if (bodyStr) reqHeaders['Content-Length'] = Buffer.byteLength(bodyStr);

    const req = lib.request(
      { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + (parsed.search || ''), method, headers: reqHeaders },
      (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try   { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      }
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ─── GameClient ───────────────────────────────────────────────────────────────
class GameClient {
  constructor(baseUrl) {
    this.baseUrl   = baseUrl;
    this.sessionId = null;
    this.turnCount = 0;
  }

  async narrate(action, opts = {}) {
    const headers = {};
    if (this.sessionId) headers['x-session-id'] = this.sessionId;

    const body = { action, intent_channel: opts.intent_channel || 'do' };
    if (opts.WORLD_PROMPT) body.WORLD_PROMPT = opts.WORLD_PROMPT;
    if (opts.npc_target)   body.npc_target   = opts.npc_target;

    const result   = await httpRequest('POST', `${this.baseUrl}/narrate`, body, headers);
    const response = result.body;

    // Capture session ID from first response
    if (response.sessionId && !this.sessionId) {
      this.sessionId = response.sessionId;
    }
    this.turnCount++;
    return response;
  }

  async getSitePlacementLog() {
    const result = await httpRequest('GET', `${this.baseUrl}/diagnostics/site-placement`, null);
    return result.body;
  }

  async getContext(level = 'detailed') {
    const url    = `${this.baseUrl}/diagnostics/context?sessionId=${this.sessionId || ''}&level=${level}`;
    const result = await httpRequest('GET', url, null);
    return result.body;
  }

  reset() {
    this.sessionId = null;
    this.turnCount = 0;
  }
}

// ─── Path resolver ────────────────────────────────────────────────────────────
function resolvePath(obj, dotPath) {
  if (!dotPath) return obj;
  return dotPath.split('.').reduce((cur, key) => {
    if (cur === undefined || cur === null) return undefined;
    return cur[key];
  }, obj);
}

// Parse "LOC:mx,my:lx,ly" cell key
function parseCellKey(str) {
  const m = String(str).match(/^LOC:(-?\d+),(-?\d+):(-?\d+),(-?\d+)$/);
  if (!m) return null;
  return { mx: parseInt(m[1], 10), my: parseInt(m[2], 10), lx: parseInt(m[3], 10), ly: parseInt(m[4], 10) };
}

// Resolve comparison target: eq_path (dynamic) takes precedence over literal value
function resolveTarget(rule, response) {
  if (rule.eq_path !== undefined) return resolvePath(response, rule.eq_path);
  return rule.value;
}

// ─── Assertion engine ─────────────────────────────────────────────────────────
function assertResponse(response, rules) {
  const failures = [];
  const evidence = [];
  for (const rule of rules) {
    try {
      const result = evalRule(rule, response);
      if (!result.passed) {
        failures.push({ rule, ...result });
      } else {
        evidence.push({ rule, evidence: result.evidence || null });
      }
    } catch (err) {
      failures.push({ rule, passed: false, error: err.message });
    }
  }
  return { passed: failures.length === 0, failures, evidence };
}

function evalRule(rule, response) {
  const { op } = rule;

  switch (op) {

    case 'no_error': {
      const err    = response.error;
      const passed = err === undefined || err === null || err === false;
      return { passed, expected: 'no error', actual: err ?? null, evidence: 'no error' };
    }

    case 'present': {
      const val    = resolvePath(response, rule.path);
      const passed = val !== undefined && val !== null;
      let ev = 'present';
      if (passed) {
        if (Array.isArray(val))                           ev = `array length=${val.length}`;
        else if (val !== null && typeof val === 'object') ev = `object, ${Object.keys(val).length} keys`;
        else                                              ev = `= ${String(val).slice(0, 60)}`;
      }
      return { passed, expected: 'present', actual: val, evidence: ev };
    }

    case 'absent': {
      const val    = resolvePath(response, rule.path);
      const passed = val === undefined || val === null;
      return { passed, expected: 'absent', actual: val, evidence: 'absent' };
    }

    case 'eq': {
      const val    = resolvePath(response, rule.path);
      const target = resolveTarget(rule, response);
      return { passed: val === target, expected: target, actual: val,
        evidence: `= ${String(val).slice(0, 60)}` };
    }

    case 'neq': {
      const val    = resolvePath(response, rule.path);
      const target = resolveTarget(rule, response);
      return { passed: val !== target, expected: `!= ${target}`, actual: val,
        evidence: `!= ${target} (= ${String(val).slice(0, 60)})` };
    }

    case 'gt': {
      const val    = resolvePath(response, rule.path);
      const target = resolveTarget(rule, response);
      return { passed: typeof val === 'number' && val > target, expected: `> ${target}`, actual: val,
        evidence: `${val} > ${target}` };
    }

    case 'gte': {
      const val    = resolvePath(response, rule.path);
      const target = resolveTarget(rule, response);
      return { passed: typeof val === 'number' && val >= target, expected: `>= ${target}`, actual: val,
        evidence: `${val} >= ${target}` };
    }

    case 'lt': {
      const val    = resolvePath(response, rule.path);
      const target = resolveTarget(rule, response);
      return { passed: typeof val === 'number' && val < target, expected: `< ${target}`, actual: val,
        evidence: `${val} < ${target}` };
    }

    case 'lte': {
      const val    = resolvePath(response, rule.path);
      const target = resolveTarget(rule, response);
      return { passed: typeof val === 'number' && val <= target, expected: `<= ${target}`, actual: val,
        evidence: `${val} <= ${target}` };
    }

    case 'matches': {
      const val    = resolvePath(response, rule.path);
      const regex  = new RegExp(rule.pattern);
      return { passed: typeof val === 'string' && regex.test(val), expected: `matches /${rule.pattern}/`, actual: val,
        evidence: `matches /${rule.pattern}/` };
    }

    case 'sum_eq': {
      const obj = resolvePath(response, rule.path);
      if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
        return { passed: false, expected: 'object of numbers at path', actual: obj };
      }
      const sum    = Object.values(obj).reduce((acc, v) => acc + (Number(v) || 0), 0);
      const target = resolveTarget(rule, response);
      return { passed: sum === target, expected: `sum == ${target}`, actual: sum, evidence: `sum=${sum}` };
    }

    case 'array_len_eq': {
      const arr = resolvePath(response, rule.path);
      if (!Array.isArray(arr)) {
        return { passed: false, expected: 'array at path', actual: arr };
      }
      const target = resolveTarget(rule, response);
      return { passed: arr.length === target, expected: `length == ${target}`, actual: arr.length,
        evidence: `length=${arr.length}` };
    }

    case 'sum_paths': {
      if (!Array.isArray(rule.paths) || rule.paths.length === 0) {
        return { passed: false, error: 'sum_paths requires non-empty paths array' };
      }
      const parts  = rule.paths.map(p => Number(resolvePath(response, p)) || 0);
      const sum    = parts.reduce((acc, v) => acc + v, 0);
      const target = resolveTarget(rule, response);
      return { passed: sum === target, expected: `sum(${rule.paths.join(' + ')}) == ${target}`, actual: sum,
        evidence: `${parts.join('+')}=${sum}` };
    }

    case 'no_adjacent_large_sites': {
      // path resolves to placed_sites array (each has site_size + parent_cell)
      const sites = resolvePath(response, rule.path);
      if (!Array.isArray(sites)) {
        return { passed: false, expected: 'placed_sites array at path', actual: sites };
      }
      const large = sites.filter(s => (s.site_size ?? 0) >= 8);
      const violations = [];
      for (let i = 0; i < large.length; i++) {
        for (let j = i + 1; j < large.length; j++) {
          const a = parseCellKey(large[i].parent_cell);
          const b = parseCellKey(large[j].parent_cell);
          if (!a || !b) continue;
          if (a.mx !== b.mx || a.my !== b.my) continue;          // different macro cells — allowed
          const dx = Math.abs(a.lx - b.lx);
          const dy = Math.abs(a.ly - b.ly);
          if (dx <= 1 && dy <= 1) {
            violations.push({
              a: large[i].site_id, a_size: large[i].site_size,
              b: large[j].site_id, b_size: large[j].site_size,
              dx, dy,
            });
          }
        }
      }
      return {
        passed: violations.length === 0,
        expected: 'no 8-directionally adjacent large sites (size>=8) within same macro cell',
        actual:   violations.length === 0 ? `none (${large.length} large sites)` : violations,
        evidence: `checked ${sites.length} sites, ${large.length} large (size>=8), 0 adjacent pairs`,
      };
    }

    default:
      return { passed: false, error: `unknown operator: "${op}"` };
  }
}

// ─── Scenario validator ───────────────────────────────────────────────────────
function validateScenario(scenario) {
  if (typeof scenario.name !== 'string' || !scenario.name)
    throw new Error('scenario missing name');
  if (!Array.isArray(scenario.turns))
    throw new Error('scenario missing turns array');
  for (const turn of scenario.turns) {
    if (typeof turn.action !== 'string' || !turn.action)
      throw new Error(`turn missing action: ${JSON.stringify(turn)}`);
    for (const rule of (turn.assert || [])) {
      if (!rule.op)
        throw new Error(`rule missing op: ${JSON.stringify(rule)}`);
      // Operators that require exactly one of value or eq_path
      if (['sum_eq', 'array_len_eq', 'sum_paths'].includes(rule.op)) {
        const hasValue  = rule.value  !== undefined;
        const hasEqPath = rule.eq_path !== undefined;
        if (hasValue && hasEqPath)
          throw new Error(`rule "${rule.op}" must not have both value and eq_path: ${JSON.stringify(rule)}`);
        if (!hasValue && !hasEqPath)
          throw new Error(`rule "${rule.op}" requires value or eq_path: ${JSON.stringify(rule)}`);
      }
    }
  }
}

// Safe JSON stringify — handles undefined (which JSON.stringify returns as undefined, not a string)
// and circular references.
function safeStr(val, maxLen = 500) {
  if (val === undefined) return '(undefined)';
  if (val === null)      return 'null';
  try {
    const s = JSON.stringify(val);
    if (s === undefined) return '(undefined)'; // e.g. JSON.stringify of a function
    return s.length > maxLen ? s.slice(0, maxLen) + '...' : s;
  } catch {
    return String(val).slice(0, maxLen);
  }
}

// ─── ANSI colors ──────────────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  dim:    '\x1b[2m',
};

// ─── Reporter ─────────────────────────────────────────────────────────────────
function pad(str, len) { return String(str).padEnd(len); }

function printPass(idx, label, ms, evidence) {
  process.stdout.write(`\r  ${C.green}[T${idx}] PASS${C.reset} | ${pad(label, 30)} | ${C.dim}${ms}ms${C.reset}\n`);
  if (Array.isArray(evidence)) {
    for (const e of evidence) {
      const loc = e.rule.path || (e.rule.paths ? e.rule.paths.join('+') : null) || e.rule.op;
      const ev  = e.evidence || '';
      console.log(`    ${C.green}[ok]${C.reset} ${C.dim}${loc}${C.reset} -- ${ev}`);
    }
  }
}

function printFail(idx, label, ms, action, sessionId, failures, response) {
  process.stdout.write(`\r  ${C.red}[T${idx}] FAIL${C.reset} | ${pad(label, 30)} | ${C.dim}${ms}ms${C.reset}\n`);
  console.log(`    ${C.cyan}Action${C.reset}  : "${action}"`);
  console.log(`    ${C.cyan}Session${C.reset} : ${sessionId || '(none)'}`);
  console.log(`    ${C.cyan}Failures${C.reset}:`);
  for (const f of failures) {
    const loc = f.rule.path || (f.rule.paths ? f.rule.paths.join('+') : null) || f.rule.op;
    if (f.error) {
      console.log(`      [!] ${loc} -- ERROR: ${f.error}`);
    } else {
    const actual      = safeStr(f.actual, 200);
      console.log(`      [x] ${loc} -- expected: ${f.expected}, actual: ${actual}`);
    }
  }
  console.log(`    ${C.cyan}--- Response Snapshot ---${C.reset}`);
  if (response.error)              console.log(`    error       : ${response.error}`);
  if (response.scene)              console.log(`    scene       : ${String(response.scene).slice(0, 300)}`);
  if (response.diagnostics)        console.log(`    diagnostics : ${safeStr(response.diagnostics)}`);
  if (response.engine_output)      console.log(`    engine_out  : ${safeStr(response.engine_output)}`);
  if (response.site_placement_log) console.log(`    site_log    : ${safeStr(response.site_placement_log)}`);
}

function writeFail(dir, scenarioName, label, action, sessionId, failures, response) {
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const ts       = Date.now();
    const safeName = `${scenarioName}_${label}`.replace(/[^a-z0-9_-]/gi, '_');
    const filePath = path.join(dir, `fail_${safeName}_${ts}.json`);
    // Build a lean diagnostic dump — include only fields useful for debugging
    const responseForDump = {
      sessionId:          response.sessionId,
      error:              response.error,
      narrative:          response.narrative,
      diagnostics:        response.diagnostics,
      worldgen_log:       response.worldgen_log,
      site_placement_log: response.site_placement_log,
      visibility:         response.visibility,
      player_identity:    response.player_identity,
      // engine_output: include block count + truncated first block only
      engine_output: response.engine_output ? {
        block_count: Array.isArray(response.engine_output.blocks) ? response.engine_output.blocks.length : 0,
        first_block:  Array.isArray(response.engine_output.blocks) && response.engine_output.blocks[0]
                      ? String(response.engine_output.blocks[0]).slice(0, 300)
                      : null,
      } : undefined,
    };
    const dump     = {
      scenario: scenarioName, label, action, sessionId,
      timestamp: new Date().toISOString(),
      failures,
      response: responseForDump,
    };    let dumpStr;
    try   { dumpStr = JSON.stringify(dump, null, 2); }
    catch { dumpStr = JSON.stringify({ scenario: scenarioName, label, action, sessionId, error: 'response_not_serializable', failures }, null, 2); }    fs.writeFileSync(filePath, dumpStr);
    console.log(`    ${C.dim}[dump] ${filePath}${C.reset}`);
  } catch (err) {
    console.log(`    ${C.yellow}[WARN] Could not write fail dump: ${err.message}${C.reset}`);
  }
}

// ─── Scenario runner ──────────────────────────────────────────────────────────
async function runScenario(scenario) {
  const client   = new GameClient(BASE_URL);
  let passed     = 0;
  let failed     = 0;
  let firstTurn  = true;

  for (let i = 0; i < scenario.turns.length; i++) {
    const turn  = scenario.turns[i];
    const label = turn.label || `turn_${i + 1}`;
    const idx   = i + 1;
    const t0    = Date.now();
    let response;

    process.stdout.write(`  T${idx} ${pad(label, 30)} ... `);

    try {
      if (String(turn.action).startsWith('__GET ')) {
        // Global diagnostic endpoint — caller must ensure session isolation
        const endpoint = turn.action.slice(6).trim();
        const result   = await httpRequest('GET', `${BASE_URL}${endpoint}`, null);
        response       = result.body;
      } else {
        const opts = { intent_channel: turn.intent_channel || 'do' };
        if (firstTurn && scenario.world_prompt) opts.WORLD_PROMPT = scenario.world_prompt;
        if (turn.npc_target) opts.npc_target = turn.npc_target;
        response  = await client.narrate(turn.action, opts);
        firstTurn = false;
        // Capture actual token usage if server surfaces it in the response body
        const _turnUsage = _extractUsageFromResponse(response);
        if (_turnUsage) {
          _sessionCost.actualUsd += (_turnUsage.inputTokens  / 1_000_000) * COST_ESTIMATES.inputPerMillionUsd
                                  + (_turnUsage.outputTokens / 1_000_000) * COST_ESTIMATES.outputPerMillionUsd;
          _sessionCost.actualAvailable = true;
        }
      }
    } catch (err) {
      process.stdout.write(`\r  ${C.red}[T${idx}] ERROR${C.reset} | ${pad(label, 30)} | ${err.message}\n`);
      failed++;
      continue;
    }

    const ms = Date.now() - t0;

    if (VERBOSE && response.narrative) {
      console.log(`  ${C.dim}[narrative] ${String(response.narrative).slice(0, 200)}${C.reset}`);
    }
    if (JSON_MODE) {
      console.log(`  ${C.dim}[json] ${JSON.stringify(response).slice(0, 1000)}${C.reset}`);
    }

    const rules              = turn.assert || [];
    const { passed: ok, failures, evidence: ok_evidence } = assertResponse(response, rules);

    if (ok) {
      printPass(idx, label, ms, ok_evidence);
      passed++;
    } else {
      printFail(idx, label, ms, turn.action, client.sessionId, failures, response);
      writeFail(OUT_DIR, scenario.name, label, turn.action, client.sessionId, failures, response);
      failed++;
    }
  }

  const total = passed + failed;
  if (failed === 0) {
    console.log(`  ${C.green}SCENARIO PASS (${passed}/${total})${C.reset}\n`);
  } else {
    console.log(`  ${C.red}SCENARIO FAIL (${passed}/${total} passed)${C.reset}\n`);
  }
  return { name: scenario.name, skipped: false, passed, failed, total };
}

// ─── Built-in scenarios ───────────────────────────────────────────────────────
const BUILTIN_SCENARIOS = [
  // --- 1. worldgen_basic ---
  // Session-safe: all assertions read from Turn 1 POST /narrate response body.
  {
    name:         'worldgen_basic',
    description:  'Turn 1 generates worldgen_log and site_placement_log; site placement invariants hold',
    world_prompt: 'i am standing in an open field',
    turns: [
      {
        label:          'worldgen',
        action:         'look around',
        intent_channel: 'do',
        assert: [
          { op: 'no_error' },
          { path: 'worldgen_log',                                   op: 'present' },
          { path: 'site_placement_log',                             op: 'present' },
          { path: 'site_placement_log.total_sites_placed',          op: 'gt',                  value: 0 },
          { path: 'site_placement_log.size_counts',                 op: 'sum_eq',              eq_path: 'site_placement_log.total_sites_placed' },
          { path: 'site_placement_log.placed_sites',                op: 'array_len_eq',        eq_path: 'site_placement_log.total_sites_placed' },
          { op: 'sum_paths', paths: ['site_placement_log.total_enterable', 'site_placement_log.total_non_enterable'], eq_path: 'site_placement_log.total_sites_placed' },
          { path: 'site_placement_log.placed_sites',                op: 'no_adjacent_large_sites' },
          { path: 'site_placement_log.spacing_rejections',          op: 'gte',                 value: 0 },
        ],
      },
    ],
  },

  // --- 2. founding_premise ---
  // Unusual Turn 1 input — engine must accept it without error.
  {
    name:         'founding_premise',
    description:  'Unusual founding premise completes without engine error; placement log is present',
    world_prompt: 'I am a weary traveler arriving at a crossroads at dusk, carrying a lantern and a worn satchel',
    turns: [
      {
        label:          'founding',
        action:         'look around',
        intent_channel: 'do',
        assert: [
          { op: 'no_error' },
          { path: 'site_placement_log',                    op: 'present' },
          { path: 'site_placement_log.total_sites_placed', op: 'gt',      value: 0    },
        ],
      },
    ],
  },

  // --- 3. multi_turn_session ---
  // Three turns in a single session — session must persist, no engine errors.
  {
    name:         'multi_turn_session',
    description:  'Three-turn session: session persists and no engine errors across turns',
    world_prompt: 'I am in a quiet village square',
    turns: [
      {
        label:          'turn_1_look',
        action:         'look around',
        intent_channel: 'do',
        assert: [
          { op: 'no_error' },
          { path: 'worldgen_log', op: 'present' },
        ],
      },
      {
        label:          'turn_2_move',
        action:         'walk north',
        intent_channel: 'do',
        assert: [
          { op: 'no_error' },
          { path: 'narrative', op: 'present' },
        ],
      },
      {
        label:          'turn_3_examine',
        action:         'examine surroundings',
        intent_channel: 'do',
        assert: [
          { op: 'no_error' },
          { path: 'narrative', op: 'present' },
        ],
      },
    ],
  },

  // --- 4. site_placement_endpoint ---
  // ISOLATED ONLY — reads from global _lastGameState via GET endpoint.
  // Skipped when multiple scenarios are queued; run with --scenario site_placement_endpoint.
  {
    name:         'site_placement_endpoint',
    description:  'GET /diagnostics/site-placement returns correct structure [ISOLATED ONLY]',
    isolated_only: true,
    world_prompt:  'i am in the wilderness',
    turns: [
      {
        label:          'worldgen_seed',
        action:         'look around',
        intent_channel: 'do',
        assert: [
          { op: 'no_error' },
          { path: 'site_placement_log', op: 'present' },
        ],
      },
      {
        label:  'diag_endpoint',
        action: '__GET /diagnostics/site-placement',
        assert: [
          { path: 'total_sites_placed',  op: 'gt',           value: 0 },
          { path: 'size_counts',         op: 'present' },
          { path: 'placed_sites',        op: 'present' },
          { path: 'spacing_rejections',  op: 'gte',          value: 0 },
          { path: 'size_counts',         op: 'sum_eq',       eq_path: 'total_sites_placed' },
          { path: 'placed_sites',        op: 'array_len_eq', eq_path: 'total_sites_placed' },
        ],
      },
    ],
  },
];

// ─── Cost estimation helpers ──────────────────────────────────────────────────
function estimateRuns(scenarios, runCount) {
  let totalTurns  = 0;
  let totalInput  = 0;
  let totalOutput = 0;
  let hasUnknown  = false;
  const breakdown = [];
  for (const sc of scenarios) {
    let perRun = SCENARIO_TOKEN_ESTIMATES[sc.name];
    if (!perRun) { hasUnknown = true; perRun = UNKNOWN_SCENARIO_ESTIMATE; }
    const scTurns  = perRun.turns        * runCount;
    const scInput  = perRun.inputTokens  * runCount;
    const scOutput = perRun.outputTokens * runCount;
    totalTurns  += scTurns;
    totalInput  += scInput;
    totalOutput += scOutput;
    breakdown.push({ name: sc.name, perRun, turns: scTurns, input: scInput, output: scOutput });
  }
  const totalCostUsd = (totalInput  / 1_000_000) * COST_ESTIMATES.inputPerMillionUsd
                     + (totalOutput / 1_000_000) * COST_ESTIMATES.outputPerMillionUsd;
  return { totalTurns, totalInput, totalOutput, totalCostUsd, hasUnknown,
           modelCalls: totalTurns > 0, breakdown };
}

function printCostEstimate(label, runs, est) {
  const fmt    = (n) => Number(n).toLocaleString();
  const fmtUsd = (n) => `$${Number(n).toFixed(4)}`;
  console.log(`\n${C.cyan}  --- Estimated run cost ---${C.reset}`);
  console.log(`  Scenario     : ${label}`);
  console.log(`  Runs         : ${runs}`);
  if (!est.modelCalls) {
    console.log(`  Model calls  : NO`);
    console.log(`  Cost (est.)  : $0.00`);
  } else {
    console.log(`  Model calls  : YES (${COST_ESTIMATES.model})`);
    if (est.breakdown.length === 1) {
      const b = est.breakdown[0];
      console.log(`  Turns        : ${fmt(est.totalTurns)}  (${b.perRun.turns} turn${b.perRun.turns !== 1 ? 's' : ''} x ${runs} run${runs !== 1 ? 's' : ''})`);
      console.log(`  Input tokens : ~${fmt(est.totalInput)}  (${fmt(b.perRun.inputTokens)} x ${runs} run${runs !== 1 ? 's' : ''})`);
      console.log(`  Output tokens: ~${fmt(est.totalOutput)}  (${fmt(b.perRun.outputTokens)} x ${runs} run${runs !== 1 ? 's' : ''})`);
    } else {
      for (const b of est.breakdown) {
        if (b.perRun.turns === 0) continue;
        console.log(`    ${b.name}: ${b.perRun.turns} turn${b.perRun.turns !== 1 ? 's' : ''}  in ~${fmt(b.perRun.inputTokens)}  out ~${fmt(b.perRun.outputTokens)}  x ${runs} run${runs !== 1 ? 's' : ''}`);
      }
      console.log(`  Turns (total): ${fmt(est.totalTurns)}`);
      console.log(`  Input (total): ~${fmt(est.totalInput)} tokens`);
      console.log(`  Output(total): ~${fmt(est.totalOutput)} tokens`);
    }
    console.log(`  Cost (est.)  : ~${fmtUsd(est.totalCostUsd)} USD  [cache-miss rate; actual likely lower]`);
    console.log(`  Pricing ref  : see COST_ESTIMATES in test-harness.js`);
  }
  if (est.hasUnknown) {
    console.log(`\n  ${C.yellow}WARNING:${C.reset}`);
    console.log(`  One or more scenarios do not have explicit token estimates.`);
    console.log(`  Using conservative fallback estimates.`);
    console.log(`  Actual costs may differ substantially.`);
  }
}

// Interactive-only: print estimate then gate execution. Returns true = proceed.
async function askProceed(ask, label, runs, est) {
  printCostEstimate(label, runs, est);
  if (!est.modelCalls) return true;          // $0.00 — no model calls, no prompt needed
  if (est.totalCostUsd > HARNESS_MAX_COST_USD) {
    const formatted = est.totalCostUsd.toFixed(4);
    console.log(`\n  ${C.red}WARNING:${C.reset}`);
    console.log(`  Estimated cost $${formatted} USD exceeds HARNESS_MAX_COST_USD ($${HARNESS_MAX_COST_USD.toFixed(2)}).`);
    console.log(`  To proceed, type the exact estimated cost (e.g. "${formatted}"):`);
    const answer = (await ask('  > ')).trim();
    if (answer === formatted) return true;
    console.log(`  Aborted.`);
    return false;
  }
  const answer = (await ask('\n  Proceed? [Y/N]: ')).trim();
  if (answer === 'Y' || answer === 'y') return true;
  console.log(`  Aborted.`);
  return false;
}

function printSessionTotals() {
  if (_sessionCost.runs === 0) return;
  console.log(`\n${C.cyan}  Session totals:${C.reset}`);
  console.log(`    Runs      : ${_sessionCost.runs}`);
  console.log(`    Estimated : ~$${_sessionCost.estimatedUsd.toFixed(4)} USD`);
  if (_sessionCost.actualAvailable) {
    console.log(`    Actual    : ~$${_sessionCost.actualUsd.toFixed(4)} USD`);
  } else {
    console.log(`    Actual    : unavailable (usage fields not found in response)`);
  }
}

// Search known response locations for token usage. Returns null if not found.
function _extractUsageFromResponse(response) {
  const candidates = [response?.usage, response?.token_usage, response?._usage];
  for (const u of candidates) {
    if (u && typeof u.prompt_tokens === 'number' && typeof u.completion_tokens === 'number') {
      return { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens };
    }
  }
  return null;
}

// ─── Server health check ──────────────────────────────────────────────────────
// Returns { status: 'ONLINE'|'OFFLINE'|'UNREACHABLE', label: string }
// ONLINE      = server reachable and responded
// OFFLINE     = connection refused (server probably not running)
// UNREACHABLE = timeout or unexpected network failure
function serverHealthCheck(baseUrl) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(baseUrl); } catch { return resolve({ status: 'UNREACHABLE', label: '[UNREACHABLE] bad server URL' }); }

    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(
      { hostname: parsed.hostname, port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: '/', method: 'GET' },
      (res) => {
        res.resume(); // drain response
        resolve({ status: 'ONLINE', label: `${C.green}[ONLINE]${C.reset}  server reachable and responded` });
      }
    );
    req.setTimeout(3000, () => {
      req.destroy();
      resolve({ status: 'UNREACHABLE', label: `${C.red}[UNREACHABLE]${C.reset}  timeout or unexpected network failure` });
    });
    req.on('error', (err) => {
      if (err.code === 'ECONNREFUSED') {
        resolve({ status: 'OFFLINE', label: `${C.red}[OFFLINE]${C.reset}  connection refused — server probably not running` });
      } else {
        resolve({ status: 'UNREACHABLE', label: `${C.red}[UNREACHABLE]${C.reset}  ${err.message}` });
      }
    });
    req.end();
  });
}

// ─── Interactive menu ─────────────────────────────────────────────────────────
// ─── Server readiness wait loop ───────────────────────────────────────────────
// Polls serverHealthCheck() every 1s for up to maxMs milliseconds.
// Prints a single "Waiting for server" line that updates in place.
// Returns the final health result (ONLINE, OFFLINE, or UNREACHABLE).
async function waitForServer(maxMs = 10000) {
  const interval = 1000;
  const start    = Date.now();
  let dots       = '';
  process.stdout.write(`Waiting for server`);
  while (Date.now() - start < maxMs) {
    const health = await serverHealthCheck(BASE_URL);
    if (health.status === 'ONLINE') {
      process.stdout.write(`\r${C.green}Server is ONLINE${C.reset}                    \n`);
      return health;
    }
    dots += '.';
    process.stdout.write(`\rWaiting for server${dots}`);
    await new Promise(r => setTimeout(r, interval));
  }
  // Timed out — do one final check and return whatever we get
  const final = await serverHealthCheck(BASE_URL);
  process.stdout.write(`\rWaiting for server — timed out.               \n`);
  return final;
}

async function interactiveMenu() {
  const readline = require('readline');
  const INTERACTIVE_OUT = './test-fails';
  OUT_DIR = INTERACTIVE_OUT;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let _rlClosed = false;
  rl.on('close', () => { _rlClosed = true; }); // Ctrl+C or EOF — loop will exit on next ask()
  const ask = (prompt) => new Promise((resolve) => {
    if (_rlClosed) return resolve('Q');
    rl.question(prompt, resolve);
  });

  // Wait for server before showing the menu
  await waitForServer(10000);

  // Prompt for run count; blank = 1, invalid = 1 with notice
  async function askRunCount() {
    const raw = (await ask('How many runs? [1]: ')).trim();
    if (raw === '') return 1;
    const n = parseInt(raw, 10);
    if (isNaN(n) || n <= 0) {
      console.log('Invalid run count; defaulting to 1.');
      return 1;
    }
    return n;
  }

  // Build run-all helper (mirrors headless multi-scenario path)
  async function runAll() {
    const results = [];
    for (const scenario of BUILTIN_SCENARIOS) {
      const isIsolated = scenario.isolated_only === true;
      const hasGlobal  = scenario.turns.some(t => String(t.action).startsWith('__GET '));
      console.log(`\n${C.cyan}[${scenario.name}]${C.reset} ${scenario.description || ''}`);
      if (isIsolated || hasGlobal) {
        console.log(`  ${C.yellow}[SKIP] isolated scenario — run it individually (type its number)${C.reset}`);
        results.push({ name: scenario.name, skipped: true, passed: 0, failed: 0, total: 0 });
        continue;
      }
      results.push(await runScenario(scenario));
    }
    const ran      = results.filter(r => !r.skipped);
    const skipped  = results.filter(r => r.skipped);
    const scenPass = ran.filter(r => r.failed === 0).length;
    const scenFail = ran.filter(r => r.failed > 0).length;
    const turnPass = ran.reduce((a, r) => a + r.passed, 0);
    const turnFail = ran.reduce((a, r) => a + r.failed, 0);
    const failColor = (n) => n > 0 ? `${C.red}${n}${C.reset}` : String(n);
    const skipColor = (n) => n > 0 ? `${C.yellow}${n}${C.reset}` : String(n);
    console.log(`\n${C.cyan}=== SUMMARY ===${C.reset}`);
    console.log(`Scenarios : ${ran.length} run | ${C.green}${scenPass} passed${C.reset} | ${failColor(scenFail)} failed | ${skipColor(skipped.length)} skipped`);
    console.log(`Turns     : ${turnPass + turnFail} run | ${C.green}${turnPass} passed${C.reset} | ${failColor(turnFail)} failed`);
  }

  while (true) {
    // Re-check server status each time menu displays
    const health = await serverHealthCheck(BASE_URL);

    console.log(`\n${C.cyan}=== GAME TEST HARNESS ===${C.reset}`);
    console.log(`This is a command-line QA harness for Ultimate Dungeon Master.`);
    console.log(`Run it in a CMD window while the game server is running separately.\n`);
    console.log(`Server : ${BASE_URL}  ${health.label}`);
    if (health.status !== 'ONLINE') {
      console.log(`${C.yellow}  Server appears offline. Start it in another window with: node index.js${C.reset}`);
      console.log(`${C.yellow}  You can still choose options, but tests will fail until the server is running.${C.reset}`);
    }
    console.log(`Dumps  : ${INTERACTIVE_OUT}  (automatic on failure)`);
    console.log(`Verbose: ${VERBOSE ? 'ON' : 'OFF'}\n`);

    console.log(`Scenarios:`);
    BUILTIN_SCENARIOS.forEach((s, i) => {
      const tag = s.isolated_only ? ` ${C.yellow}[ISOLATED]${C.reset}` : '';
      console.log(`  [${i + 1}] ${s.name}${tag}`);
      console.log(`      ${C.dim}${s.description || ''}${C.reset}`);
    });

    console.log(`\nOptions:`);
    console.log(`  Type A then Enter     — run all non-isolated scenarios`);
    console.log(`  Type 1-${BUILTIN_SCENARIOS.length} then Enter   — run a single scenario by number`);
    console.log(`  Type V then Enter     — toggle verbose (narrative text on/off)`);
    console.log(`  Type Q then Enter     — quit`);
    console.log('');

    const answer = (await ask('> ')).trim().toUpperCase();

    if (answer === 'Q') {
      printSessionTotals();
      console.log('Goodbye.');
      rl.close();
      return;
    }

    if (answer === 'V') {
      VERBOSE = !VERBOSE;
      console.log(`Verbose is now ${VERBOSE ? 'ON' : 'OFF'}.`);
      continue; // redisplay menu
    }

    if (answer === 'A') {
      const runs = await askRunCount();
      const _allScenarios = BUILTIN_SCENARIOS.filter(
        s => !s.isolated_only && !s.turns.some(t => String(t.action).startsWith('__GET '))
      );
      const est = estimateRuns(_allScenarios, runs);
      if (!(await askProceed(ask, 'all non-isolated scenarios', runs, est))) continue;
      _sessionCost.estimatedUsd += est.totalCostUsd;
      let runsPassed = 0;
      for (let r = 1; r <= runs; r++) {
        if (runs > 1) console.log(`\n${C.cyan}--- Run ${r}/${runs} ---${C.reset}`);
        await runAll();
        runsPassed++; // individual run summary already shown by runAll
      }
      if (runs > 1) {
        console.log(`\n${C.cyan}--- ${runs}-run summary ---${C.reset}`);
        console.log(`Runs: ${runs}  (see individual summaries above for pass/fail detail)`);
      }
      _sessionCost.runs += runs;
      _sessionCost.turns += est.totalTurns;
      console.log(`\nPress Enter to return to the menu.`);
      await ask('');
      continue;
    }

    const num = parseInt(answer, 10);
    if (!isNaN(num) && num >= 1 && num <= BUILTIN_SCENARIOS.length) {
      const scenario = BUILTIN_SCENARIOS[num - 1];
      const runs = await askRunCount();
      const est  = estimateRuns([scenario], runs);
      if (!(await askProceed(ask, scenario.name, runs, est))) continue;
      _sessionCost.estimatedUsd += est.totalCostUsd;
      let scenPassed = 0;
      let scenFailed = 0;
      for (let r = 1; r <= runs; r++) {
        if (runs > 1) console.log(`\n${C.cyan}--- Run ${r}/${runs} ---${C.reset}`);
        console.log(`${C.cyan}[${scenario.name}]${C.reset} ${scenario.description || ''}`);
        const result = await runScenario(scenario);
        if (result.failed === 0) scenPassed++; else scenFailed++;
      }
      if (runs > 1) {
        const fc = scenFailed > 0 ? `${C.red}${scenFailed}${C.reset}` : String(scenFailed);
        console.log(`\n${C.cyan}--- ${runs}-run summary ---${C.reset}`);
        console.log(`Runs: ${runs}  |  ${C.green}${scenPassed} passed${C.reset}  |  ${fc} failed`);
      }
      _sessionCost.runs += runs;
      _sessionCost.turns += est.totalTurns;
      console.log(`\nPress Enter to return to the menu.`);
      await ask('');
      continue;
    }

    console.log(`${C.yellow}Unrecognized input: "${answer}". Type A, 1-${BUILTIN_SCENARIOS.length}, V, or Q then Enter.${C.reset}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  // Auto-create tests/scenarios/ directory for JSON scenario files
  const SCENARIOS_DIR = path.join(process.cwd(), 'tests', 'scenarios');
  if (!fs.existsSync(SCENARIOS_DIR)) {
    fs.mkdirSync(SCENARIOS_DIR, { recursive: true });
  }

  console.log(`\n${C.cyan}=== GAME TEST HARNESS ===${C.reset}`);
  console.log(`Server : ${BASE_URL}`);
  if (OUT_DIR) console.log(`Dumps  : ${OUT_DIR}`);
  console.log('');

  let scenarios = [];

  if (FILE_PATH) {
    let raw;
    try   { raw = fs.readFileSync(FILE_PATH, 'utf8'); }
    catch (err) {
      console.error(`${C.red}Cannot read file: ${FILE_PATH} -- ${err.message}${C.reset}`);
      process.exit(1);
    }
    let loaded;
    try   { loaded = JSON.parse(raw); }
    catch (err) {
      console.error(`${C.red}Invalid JSON in file: ${err.message}${C.reset}`);
      process.exit(1);
    }
    const list = Array.isArray(loaded) ? loaded : [loaded];
    for (const s of list) {
      try   { validateScenario(s); scenarios.push(s); }
      catch (err) {
        console.error(`${C.red}Invalid scenario "${s.name || '?'}": ${err.message}${C.reset}`);
        process.exit(1);
      }
    }

  } else if (ONLY_NAME) {
    const found = BUILTIN_SCENARIOS.find(s => s.name === ONLY_NAME);
    if (!found) {
      console.error(`${C.red}No built-in scenario named "${ONLY_NAME}".${C.reset}`);
      console.error(`Available: ${BUILTIN_SCENARIOS.map(s => s.name).join(', ')}`);
      process.exit(1);
    }
    scenarios = [found];

  } else {
    scenarios = BUILTIN_SCENARIOS;
  }

  const multiMode = scenarios.length > 1;
  const results   = [];

  // ─── Headless cost gate ────────────────────────────────────────────────────
  {
    const _runnableForCost = scenarios.filter(sc => {
      const isIsolated = sc.isolated_only === true;
      const hasGlobal  = sc.turns.some(t => String(t.action).startsWith('__GET '));
      return !(isIsolated || hasGlobal) || !multiMode;
    });
    const _hEst = estimateRuns(_runnableForCost, 1);
    if (_hEst.totalCostUsd > HARNESS_MAX_COST_USD) {
      // Hard guardrail — no override path in headless mode
      printCostEstimate(ONLY_NAME || 'selected scenarios', 1, _hEst);
      console.log(`\n  ${C.red}ERROR:${C.reset} Estimated cost $${_hEst.totalCostUsd.toFixed(4)} USD exceeds HARNESS_MAX_COST_USD ($${HARNESS_MAX_COST_USD.toFixed(2)}).`);
      console.log(`  Headless mode has no guardrail override. Reduce scope or raise HARNESS_MAX_COST_USD.`);
      process.exit(1);
    }
    if (_hEst.modelCalls && !HAS_YES) {
      printCostEstimate(ONLY_NAME || 'selected scenarios', 1, _hEst);
      console.log(`\n  Add --yes to confirm and run paid scenarios.`);
      process.exit(1);
    }
  }

  for (const scenario of scenarios) {
    const isIsolatedOnly = scenario.isolated_only === true;
    const hasGlobal      = scenario.turns.some(t => String(t.action).startsWith('__GET '));
    const shouldSkip     = (isIsolatedOnly || hasGlobal) && multiMode;

    console.log(`${C.cyan}[${scenario.name}]${C.reset} ${scenario.description || ''}`);

    if (shouldSkip) {
      console.log(`  ${C.yellow}[SKIP] global diagnostic endpoint — run isolated: node test-harness.js --scenario ${scenario.name}${C.reset}\n`);
      results.push({ name: scenario.name, skipped: true, passed: 0, failed: 0, total: 0 });
      continue;
    }

    const result = await runScenario(scenario);
    results.push(result);
  }

  // ─── Summary ───────────────────────────────────────────────────────────────
  const ran      = results.filter(r => !r.skipped);
  const skipped  = results.filter(r => r.skipped);
  const scenPass = ran.filter(r => r.failed === 0).length;
  const scenFail = ran.filter(r => r.failed > 0).length;
  const turnPass = ran.reduce((a, r) => a + r.passed, 0);
  const turnFail = ran.reduce((a, r) => a + r.failed, 0);

  const failColor = (n) => n > 0 ? `${C.red}${n}${C.reset}` : String(n);
  const skipColor = (n) => n > 0 ? `${C.yellow}${n}${C.reset}` : String(n);

  console.log(`${C.cyan}=== SUMMARY ===${C.reset}`);
  console.log(`Scenarios : ${ran.length} run | ${C.green}${scenPass} passed${C.reset} | ${failColor(scenFail)} failed | ${skipColor(skipped.length)} skipped`);
  console.log(`Turns     : ${turnPass + turnFail} run | ${C.green}${turnPass} passed${C.reset} | ${failColor(turnFail)} failed`);

  if (scenFail > 0) process.exit(1);
}

if (INTERACTIVE_MODE) {
  interactiveMenu().catch(err => {
    console.error(`\n${C.red}Fatal: ${err.message}${C.reset}`);
    process.exit(1);
  });
} else {
  main().catch(err => {
    console.error(`\n${C.red}Fatal: ${err.message}${C.reset}`);
    process.exit(1);
  });
}
