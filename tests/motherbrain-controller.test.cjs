'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const vm = require('node:vm');

const REPO = path.resolve(__dirname, '..');
const controllerModule = require(path.join(REPO, 'motherbrain-controller.js'));

const {
  MotherBrainController,
  DURABLE_HISTORY_EXCHANGE_LIMIT,
  HISTORY_SCHEMA_VERSION,
  HISTORY_V1_BACKUP_BASENAME,
  MAX_HISTORY_FILE_BYTES,
  MODEL_IDS,
  REASONING_EFFORTS,
  MAX_REQUEST_UTF8_BYTES,
  COMMAND_REGISTRY,
  REDACTED_DISPLAY_VALUE,
  TELEMETRY_FIELD_AUTHORITY,
  TOOL_RESULT_PREVIEW_CHAR_LIMIT,
  boundedToolResultPreview,
  buildServerClockSnapshot,
  buildCommandPromptBlock,
  buildContextBudgetedV4Request,
  createObservedToolSchemaIndex,
  aggregateUsage,
  buildDurableHistorySnapshot,
  calculateRoundCost,
  classifyProviderFinish,
  buildV4RequestBody,
  captureAssistantMessage,
  displayTokenEstimate,
  environmentSecretValues,
  flattenProviderReplay,
  isObservedDeepSeekContextLengthError,
  loadHistoryStore,
  loadSettingsStore,
  migrateLegacyHistory,
  normalizeUsage,
  redactDisplayValue,
  saveHistoryStore,
  saveSettingsStore,
  serializedBodyUtf8Bytes,
  validateToolCallBatch
} = controllerModule;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadProductionTools() {
  const source = fs.readFileSync(path.join(REPO, 'motherbrain.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf('const MB_TOOLS = [');
  const end = source.indexOf('\n];\nconst HOST', start);
  assert.notEqual(start, -1, 'MB_TOOLS declaration must exist');
  assert.notEqual(end, -1, 'MB_TOOLS declaration end must exist');
  const sandbox = {};
  vm.runInNewContext(
    `${source.slice(start, end + 3)}\nglobalThis.__TOOLS = MB_TOOLS;`,
    sandbox,
    { filename: 'motherbrain-tools-contract.vm.js', timeout: 1000 }
  );
  return clone(sandbox.__TOOLS);
}

// Step 12 changes only run_validation child-stream capture/teardown inside this frozen body.
const EXECUTOR_BODY_BASELINE_SHA256 = '8A44B76417F5B517565AC1AA9EF60BA9C26F816561F6BA02CA983534A228CE66';
const MB_TOOLS_BASELINE_SHA256 = '5B6EEB8B52ADEE18D9ABFAB0F5AAE460F183093E78A266C88D81BAF82426FCA7';

function normalizeStep10ExecutorOutputBoundary(executorBody) {
  return executorBody
    .replace(/\r\n/g, '\n')
    .replaceAll('emitActivityLine', 'printLine')
    .replaceAll('refreshOperationalState', 'prompt')
    .replace(/, \{ role: 'warning' \}/g, '')
    .replace(/\n/g, '\r\n');
}

function loadProductionExecutorHarness({
  activeSessionId = null,
  harnessAuthorized = false,
  githubPat = '',
  diagnosticKey = 'DIAGNOSTIC_SENTINEL_DO_NOT_RENDER',
  axiosGet = null,
  fsImpl = null
} = {}) {
  const source = fs.readFileSync(path.join(REPO, 'motherbrain.js'), 'utf8');
  const executorStart = source.indexOf('async function executeToolCall(name, args) {');
  const seamStart = source.indexOf('// ── Canonical structured dispatch seam', executorStart);
  const projectorStart = source.indexOf('function _projectCanonicalToolMetadata', seamStart);
  const instanceStart = source.indexOf('const executeToolCallStructured', projectorStart);
  assert.notEqual(executorStart, -1, 'legacy executor declaration must exist');
  assert.notEqual(seamStart, -1, 'canonical adapter seam must exist');
  assert.notEqual(projectorStart, -1, 'canonical metadata projector must exist');
  assert.notEqual(instanceStart, -1, 'canonical structured adapter instance must exist');

  const httpCalls = [];
  const filesystemCalls = [];
  const defaultFs = {
    existsSync(target) { filesystemCalls.push(['existsSync', target]); return false; },
    mkdirSync(target, options) { filesystemCalls.push(['mkdirSync', target, options]); },
    writeFileSync(target, value, encoding) { filesystemCalls.push(['writeFileSync', target, value, encoding]); },
    readFileSync(target, encoding) { filesystemCalls.push(['readFileSync', target, encoding]); return ''; },
    readdirSync(target) { filesystemCalls.push(['readdirSync', target]); return []; }
  };
  const injectedFs = fsImpl ?? defaultFs;
  const sandbox = {
    Buffer,
    console,
    process: { env: { DIAGNOSTICS_KEY: diagnosticKey } },
    require(moduleName) {
      if (moduleName === 'fs') return injectedFs;
      if (moduleName === 'path') return path;
      return require(moduleName);
    },
    axios: {
      async get(url, options) {
        httpCalls.push({ method: 'get', url, options: clone(options) });
        if (axiosGet) return axiosGet(url, options);
        return { data: { ok: true } };
      },
      async post(url, body, options) {
        httpCalls.push({ method: 'post', url, body: clone(body), options: clone(options) });
        return { data: { ok: true } };
      },
      async delete(url, options) {
        httpCalls.push({ method: 'delete', url, options: clone(options) });
        return { data: { ok: true } };
      }
    },
    HOST: '127.0.0.1',
    PORT: 3000,
    GITHUB_PAT: githubPat,
    _activeSessionId: activeSessionId,
    _harnessAuthorized: harnessAuthorized,
    _activeGameplayInvestigation: null,
    _toolHttpAgent: null,
    DIM: '',
    R: '',
    prompt() {},
    printLine() {},
    refreshOperationalState() {},
    emitActivityLine() {}
  };
  vm.runInNewContext(
    `${source.slice(executorStart, seamStart)}\n${source.slice(projectorStart, instanceStart)}\n`
      + 'globalThis.__legacy = executeToolCall; globalThis.__createAdapter = createCanonicalToolDispatchAdapter;',
    sandbox,
    { filename: 'motherbrain-canonical-executor.vm.js', timeout: 1000 }
  );
  return {
    legacy: sandbox.__legacy,
    createAdapter: sandbox.__createAdapter,
    httpCalls,
    filesystemCalls,
    fsImpl: injectedFs
  };
}

const TOOLS = loadProductionTools();
assert.equal(TOOLS.length, 38);
assert.equal(new Set(TOOLS.map(tool => tool.function.name)).size, 38);
const TOOL_NAME = TOOLS[0].function.name;

function validSchemaValue(propertySchema) {
  if (propertySchema.enum) return propertySchema.enum[0];
  if (propertySchema.type === 'string') return 'fixture';
  if (propertySchema.type === 'integer') return 1;
  if (propertySchema.type === 'boolean') return true;
  if (propertySchema.type === 'object') return { fixture: { nested: [1, null, 'kept'] } };
  throw new Error(`unsupported fixture schema type: ${propertySchema.type}`);
}

function validArgsForTool(tool) {
  const schema = tool.function.parameters;
  const args = {};
  for (const name of schema.required ?? []) args[name] = validSchemaValue(schema.properties[name]);
  return args;
}

function providerToolCall(tool, id, args, rawArguments = null) {
  return {
    id,
    type: 'function',
    function: {
      name: tool.function.name,
      arguments: rawArguments === null ? JSON.stringify(args) : rawArguments
    }
  };
}

function usage(overrides = {}) {
  return {
    prompt_tokens: 100,
    completion_tokens: 50,
    total_tokens: 150,
    prompt_cache_hit_tokens: 40,
    prompt_cache_miss_tokens: 60,
    completion_tokens_details: { reasoning_tokens: 20 },
    ...overrides
  };
}

function providerResponse({
  model = MODEL_IDS.flash,
  finishReason = 'stop',
  content = 'Mother final answer',
  includeContent = true,
  reasoningContent = 'provider reasoning',
  includeReasoning = true,
  toolCalls,
  responseUsage = usage()
} = {}) {
  const message = { role: 'assistant' };
  if (includeContent) message.content = content;
  if (includeReasoning) message.reasoning_content = reasoningContent;
  if (toolCalls !== undefined) message.tool_calls = clone(toolCalls);
  return {
    data: {
      model,
      choices: [{ finish_reason: finishReason, message }],
      usage: clone(responseUsage)
    }
  };
}

function toolCall(id, args = { turn: 1 }, name = TOOL_NAME) {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) }
  };
}

function providerError({ status = null, code = null, headers = null, contextFixture = false } = {}) {
  const error = new Error('mock provider failure');
  if (code) error.code = code;
  if (status !== null) {
    error.response = {
      status,
      headers: headers || {},
      data: { error: { code: 'opaque_mock_error' } }
    };
  } else if (headers) {
    error.headers = headers;
  }
  error.contextFixture = contextFixture;
  return error;
}

function completedExchange(id, answer = `answer-${id}`, question = `question-${id}`) {
  return {
    id,
    question,
    completed_at: '2026-07-16T12:00:00.000Z',
    request_snapshot: { model: MODEL_IDS.flash, reasoning_effort: REASONING_EFFORTS.high },
    actual_models: [MODEL_IDS.flash],
    provider_messages: [
      { role: 'user', content: question },
      { role: 'assistant', content: answer, reasoning_content: `reasoning-${id}` }
    ],
    round_summaries: [],
    final_answer: answer,
    status: 'completed'
  };
}

function turnOptions(label = 'probe') {
  return {
    question: `question-${label}`,
    systemMessages: [{ role: 'system', content: `system-${label}` }],
    userMessage: {
      role: 'user',
      content: `[LIVE ENGINE DATA]\ncontext-${label}\n\n[DEVELOPER QUESTION]\nquestion-${label}`
    }
  };
}

const FIXED_TIME = '2026-07-16T12:00:00.000Z';

function persistenceFixture(t, label = 'store') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `mb-step6-${label}-`));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return {
    directory,
    fsAdapter: fs.promises,
    paths: {
      historyFile: path.join(directory, 'mb-history.json'),
      settingsFile: path.join(directory, 'mb-settings.json')
    },
    clock: () => new Date(FIXED_TIME)
  };
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function sha256Json(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function createHarness({
  actions = [],
  model = MODEL_IDS.flash,
  effort = REASONING_EFFORTS.high,
  dispatchImpl = null,
  contextClassifier = null,
  writeClipboardImpl = null,
  fsAdapter = {},
  paths = {},
  clock = () => new Date(FIXED_TIME)
} = {}) {
  const queue = [...actions];
  const requests = [];
  const events = [];
  const delays = [];
  const dispatchCalls = [];
  const clipboardWrites = [];

  const httpClient = async request => {
    requests.push(clone(request));
    assert.ok(queue.length > 0, 'mock transport queue exhausted');
    const action = queue.shift();
    if (action instanceof Error) throw action;
    if (typeof action === 'function') return action(request);
    return clone(action);
  };
  if (contextClassifier) httpClient.isContextLengthError = contextClassifier;

  const controller = new MotherBrainController({
    httpClient,
    tools: TOOLS,
    dispatchToolCall: async call => {
      dispatchCalls.push(clone(call));
      if (dispatchImpl) return dispatchImpl(call, { events, dispatchCalls });
      return {
        toolContent: JSON.stringify({ ok: true, id: call.id }),
        outcome: 'executed',
        gateCode: null
      };
    },
    getLiveContext: async () => null,
    clock,
    fsAdapter,
    paths,
    delay: async milliseconds => { delays.push(milliseconds); },
    viewSink: event => { events.push(clone(event)); },
    writeClipboard: async text => {
      clipboardWrites.push(text);
      if (writeClipboardImpl) return writeClipboardImpl(text);
      return undefined;
    }
  });
  controller._configuredSettings = {
    schema_version: 1,
    model,
    reasoning_effort: effort
  };
  return { controller, httpClient, requests, events, delays, dispatchCalls, clipboardWrites, queue };
}

function loadProductionComposition() {
  return require(path.join(REPO, 'motherbrain.js'));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(turns = 8) {
  for (let index = 0; index < turns; index++) await Promise.resolve();
}

function createFakeTuiHarness() {
  const instances = [];
  const factory = options => {
    const records = {
      headers: [],
      transcript: [],
      rounds: [],
      activity: [],
      telemetry: [],
      commands: [],
      copies: [],
      fatals: [],
      lifecycle: [],
      clearCount: 0
    };
    const tui = {
      started: false,
      records,
      options,
      shutdownPromise: null,
      async start() {
        this.started = true;
        return { started: true, layout: { supported: true } };
      },
      stopAcceptingInput() {
        if (records.lifecycle.includes('input-stopped')) return false;
        records.lifecycle.push('input-stopped');
        return true;
      },
      shutdown(reason = 'normal', shutdownOptions = {}) {
        if (this.shutdownPromise) return this.shutdownPromise;
        this.stopAcceptingInput();
        const error = shutdownOptions.error instanceof Error ? shutdownOptions.error : null;
        if (options.onBeforeShutdown) {
          options.onBeforeShutdown({
            reason: String(reason),
            exitCode: Number.isInteger(shutdownOptions.exitCode) ? shutdownOptions.exitCode : 0,
            error
          });
        }
        this.shutdownPromise = (async () => {
          this.started = false;
          records.lifecycle.push('terminal-restored');
          const result = {
            reason: String(reason),
            exitCode: Number.isInteger(shutdownOptions.exitCode) ? shutdownOptions.exitCode : 0,
            error: error ? { name: error.name, message: error.message, code: error.code || null } : null,
            retainedState: { fake: true }
          };
          await options.onShutdown(result);
          records.lifecycle.push('runtime-finalized');
          return result;
        })();
        return this.shutdownPromise;
      },
      renderHeaderOperationalState(value) { records.headers.push(clone(value)); return value; },
      renderTranscriptRecord(value) { records.transcript.push(clone(value)); return value; },
      renderRoundActivityRecord(value) { records.rounds.push(clone(value)); return value; },
      renderActivityRecord(value) { records.activity.push(clone(value)); return value; },
      renderTelemetrySnapshot(value) { records.telemetry.push(clone(value)); return value; },
      renderCommandStatus(value) { records.commands.push(clone(value)); return value; },
      renderCopyResult(value) { records.copies.push(clone(value)); return value; },
      renderFatal(value) { records.fatals.push(clone(value)); return value; },
      clearDisplay() { records.clearCount += 1; }
    };
    instances.push(tui);
    return tui;
  };
  return { factory, instances, get latest() { return instances.at(-1) || null; } };
}

function createFakeTimers() {
  let sequence = 0;
  const timers = new Map();
  return {
    setTimeout(callback, milliseconds) {
      const token = { id: ++sequence };
      timers.set(token, { callback, milliseconds });
      return token;
    },
    clearTimeout(token) { timers.delete(token); },
    runNext() {
      const entry = timers.entries().next();
      if (entry.done) return false;
      const [token, record] = entry.value;
      timers.delete(token);
      record.callback();
      return true;
    },
    activeCount() { return timers.size; },
    records() { return [...timers.values()].map(value => ({ milliseconds: value.milliseconds })); }
  };
}

function createFakeSseHttpModule() {
  const requests = [];
  return {
    requests,
    respond(index, statusCode = 200) {
      const entry = requests[index];
      assert.ok(entry, `missing synthetic SSE request ${index}`);
      const response = new EventEmitter();
      response.statusCode = statusCode;
      response.destroyed = false;
      response.encoding = null;
      response.setEncoding = encoding => { response.encoding = encoding; };
      response.resume = () => { response.resumed = true; };
      response.destroy = () => { response.destroyed = true; };
      entry.response = response;
      entry.callback(response);
      return response;
    },
    get(options, callback) {
      const request = new EventEmitter();
      request.socket = { setTimeout() {}, setNoDelay() {} };
      request.destroyed = false;
      request.destroy = () => {
        request.destroyed = true;
        request.removeAllListeners();
      };
      requests.push({
        options: {
          host: options.host,
          port: options.port,
          path: options.path,
          headers: clone(options.headers || {}),
          agent: options.agent
        },
        callback,
        request
      });
      return request;
    }
  };
}

async function createCompositionHarness(t, options = {}) {
  const production = loadProductionComposition();
  const fixture = persistenceFixture(t, options.label || 'step10');
  const tuiHarness = options.tuiHarness || createFakeTuiHarness();
  const queue = [...(options.actions || [])];
  const requests = [];
  let activeRequests = 0;
  let cancellationCount = 0;
  const httpClient = options.httpClient || (async request => {
    requests.push(clone(request));
    activeRequests += 1;
    try {
      assert.ok(queue.length > 0, 'composition transport queue exhausted');
      const action = queue.shift();
      if (action instanceof Error) throw action;
      const value = typeof action === 'function' ? await action(request) : await action;
      return clone(value);
    } finally {
      activeRequests -= 1;
    }
  });
  if (typeof httpClient.cancelAll !== 'function') httpClient.cancelAll = () => { cancellationCount += 1; };
  if (typeof httpClient.getActiveRequestCount !== 'function') {
    httpClient.getActiveRequestCount = () => activeRequests;
  }
  const liveContextProvider = options.getLiveContext || Object.assign(
    async () => ({ fullContext: 'STEP10 LIVE CONTEXT', source: 'fixture', contextNote: '', sessionId: null }),
    { prewarm: async () => null }
  );
  const runtime = production.createMotherBrainRuntime({
    createTui: tuiHarness.factory,
    httpClient,
    getLiveContext: liveContextProvider,
    hasProviderCredential: options.hasProviderCredential || (() => true),
    fsAdapter: fixture.fsAdapter,
    paths: fixture.paths,
    clock: fixture.clock,
    delay: async () => {},
    dispatchToolCall: options.dispatchToolCall || (async call => ({
      toolContent: JSON.stringify({ ok: true, id: call.id }),
      outcome: 'executed',
      gateCode: null
    })),
    writeClipboard: async () => {},
    startOperational: options.startOperational === true,
    reportCrashes: options.reportCrashes === true,
    ...(options.runtimeOptions || {})
  });
  await runtime.start();
  t.after(async () => {
    if (!runtime.state.stopped) await runtime.shutdown('test-cleanup');
  });
  return {
    production,
    runtime,
    fixture,
    tuiHarness,
    tui: tuiHarness.latest,
    requests,
    queue,
    get cancellationCount() { return cancellationCount; }
  };
}

test('V37: the authoritative registry alone drives local help and command documentation', async () => {
  const harness = createHarness();
  const tokens = COMMAND_REGISTRY.map(entry => entry.token);
  assert.deepEqual(tokens, ['/help', '/model', '/reasoning', '/status', '/stats', '/clear', '/copy']);
  assert.equal(new Set(tokens).size, tokens.length);

  assert.deepEqual(await harness.controller.handleLocalCommand('ordinary developer text'), { handled: false });
  const help = await harness.controller.handleLocalCommand('/help');
  assert.equal(help.ok, true);
  assert.deepEqual(help.data.commands.map(entry => entry.token), tokens);
  assert.deepEqual(
    help.data.commands.map(entry => entry.syntax),
    COMMAND_REGISTRY.map(entry => entry.syntax)
  );
  const modelHelp = await harness.controller.handleLocalCommand('/help model');
  assert.equal(modelHelp.ok, true);
  assert.deepEqual(modelHelp.data.commands.map(entry => entry.token), ['/model']);

  const promptBlock = buildCommandPromptBlock();
  for (const entry of COMMAND_REGISTRY) {
    assert.equal(promptBlock.split(entry.syntax).length - 1, 1, `${entry.syntax} must appear once`);
  }
  assert.equal(harness.requests.length, 0);
});

test('V38: restart copy is exact and clear commits durable emptiness before changing memory', async t => {
  const fixture = persistenceFixture(t, 'commands-copy-clear');
  const exchanges = [
    completedExchange('copy-1', 'older answer', 'older question'),
    completedExchange('copy-2', 'newest answer', 'newest question')
  ];
  const seeded = await saveHistoryStore({
    fsAdapter: fixture.fsAdapter,
    historyPath: fixture.paths.historyFile,
    exchanges,
    clock: fixture.clock
  });
  assert.equal(seeded.ok, true);

  const restarted = createHarness({ fsAdapter: fixture.fsAdapter, paths: fixture.paths, clock: fixture.clock });
  await restarted.controller.loadPersistentState();
  restarted.controller.updateOperationalState({ sse_connected: true, phase: 'ready' });
  const beforeClear = restarted.controller.getContractSnapshot();

  const copied = await restarted.controller.handleLocalCommand('/copy');
  assert.equal(copied.ok, true);
  assert.deepEqual(restarted.clipboardWrites, [
    'You: newest question\n\nMother Brain:\nnewest answer\n'
  ]);

  const stats = await restarted.controller.handleLocalCommand('/stats');
  assert.equal(stats.data.live_history.exchange_count, 2);
  assert.deepEqual(stats.data.durable_history.exchange_ids, ['copy-1', 'copy-2']);

  const cleared = await restarted.controller.handleLocalCommand('/clear');
  assert.equal(cleared.ok, true);
  assert.equal(cleared.data.cleared_exchange_count, 2);
  assert.deepEqual(restarted.controller.getCompletedExchangeLedger(), []);
  assert.equal(restarted.controller.getLastCompletedExchange(), null);
  assert.deepEqual(JSON.parse(fs.readFileSync(fixture.paths.historyFile, 'utf8')).exchanges, []);
  const afterClear = restarted.controller.getContractSnapshot();
  assert.deepEqual(afterClear.operational_state, beforeClear.operational_state);
  assert.deepEqual(afterClear.telemetry.session, beforeClear.telemetry.session);
});

test('V38: clear persistence failure preserves the live ledger, copy source, and prior durable file', async t => {
  const fixture = persistenceFixture(t, 'commands-clear-failure');
  const exchanges = [completedExchange('clear-safe', 'safe answer', 'safe question')];
  const seeded = await saveHistoryStore({
    fsAdapter: fixture.fsAdapter,
    historyPath: fixture.paths.historyFile,
    exchanges,
    clock: fixture.clock
  });
  assert.equal(seeded.ok, true);

  let failRename = false;
  const adapter = Object.create(fs.promises);
  adapter.rename = async (...args) => {
    if (!failRename) return fs.promises.rename(...args);
    const error = new Error('injected clear rename failure');
    error.code = 'EACCES';
    throw error;
  };
  const harness = createHarness({ fsAdapter: adapter, paths: fixture.paths, clock: fixture.clock });
  await harness.controller.loadPersistentState();
  const ledgerBefore = harness.controller.getCompletedExchangeLedger();
  const copyBefore = harness.controller.getLastCompletedExchange();
  const durableHashBefore = sha256File(fixture.paths.historyFile);

  failRename = true;
  const result = await harness.controller.handleLocalCommand('/clear');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'save_failed');
  assert.deepEqual(harness.controller.getCompletedExchangeLedger(), ledgerBefore);
  assert.deepEqual(harness.controller.getLastCompletedExchange(), copyBefore);
  assert.equal(sha256File(fixture.paths.historyFile), durableHashBefore);
  const snapshot = harness.controller.getContractSnapshot();
  assert.equal(snapshot.persistence.history.degraded, true);
  assert.equal(snapshot.persistence.history.live_exchange_count, 1);
  assert.deepEqual(snapshot.persistence.history.durable_exchange_ids, ['clear-safe']);
});

test('V39: model command queries, validates, and atomically persists only supported next-turn values', async t => {
  const fixture = persistenceFixture(t, 'command-model');
  const harness = createHarness({ fsAdapter: fixture.fsAdapter, paths: fixture.paths, clock: fixture.clock });
  await harness.controller.loadPersistentState();

  const queried = await harness.controller.handleLocalCommand('/model');
  assert.equal(queried.data.configured_model, MODEL_IDS.flash);
  const invalid = await harness.controller.handleLocalCommand('/model turbo');
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'invalid_argument');
  const tooMany = await harness.controller.handleLocalCommand('/model pro now');
  assert.equal(tooMany.code, 'too_many_arguments');

  const saved = await harness.controller.handleLocalCommand('/model pro');
  assert.equal(saved.ok, true);
  assert.equal(saved.data.configured_model, MODEL_IDS.pro);
  assert.equal(harness.controller.getContractSnapshot().configured_settings.model, MODEL_IDS.pro);
  assert.equal(JSON.parse(fs.readFileSync(fixture.paths.settingsFile, 'utf8')).model, MODEL_IDS.pro);
  assert.equal(harness.requests.length, 0);
});

test('V40: reasoning command queries, validates, and atomically persists high or max', async t => {
  const fixture = persistenceFixture(t, 'command-reasoning');
  const harness = createHarness({ fsAdapter: fixture.fsAdapter, paths: fixture.paths, clock: fixture.clock });
  await harness.controller.loadPersistentState();

  const queried = await harness.controller.handleLocalCommand('/reasoning');
  assert.equal(queried.data.configured_reasoning_effort, REASONING_EFFORTS.high);
  assert.equal(queried.data.attribution, 'configured');
  const invalid = await harness.controller.handleLocalCommand('/reasoning extreme');
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'invalid_argument');

  const saved = await harness.controller.handleLocalCommand('/reasoning max');
  assert.equal(saved.ok, true);
  assert.equal(saved.data.configured_reasoning_effort, REASONING_EFFORTS.max);
  assert.equal(harness.controller.getContractSnapshot().configured_settings.reasoning_effort, REASONING_EFFORTS.max);
  assert.equal(JSON.parse(fs.readFileSync(fixture.paths.settingsFile, 'utf8')).reasoning_effort, REASONING_EFFORTS.max);
  assert.equal(harness.requests.length, 0);
});

test('V41: status and stats expose configuration, attribution, replay, session, and durability locally', async t => {
  const fixture = persistenceFixture(t, 'command-observability');
  const harness = createHarness({
    actions: [providerResponse({ model: MODEL_IDS.flash, content: 'observed answer' })],
    fsAdapter: fixture.fsAdapter,
    paths: fixture.paths,
    clock: fixture.clock
  });
  await harness.controller.loadPersistentState();
  harness.controller.updateOperationalState({ sse_connected: true, transport: 'idle' });
  const turn = await harness.controller.runTurn(turnOptions('command-observability'));
  assert.equal(turn.status, 'completed');

  const status = await harness.controller.handleLocalCommand('/status');
  assert.equal(status.ok, true);
  assert.equal(status.data.configured_settings.model, MODEL_IDS.flash);
  assert.equal(status.data.last_actual_model, MODEL_IDS.flash);
  assert.equal(status.data.attribution.last_actual_model, 'provider_response');
  assert.equal(status.data.attribution.configured_reasoning_effort, 'configured');
  assert.equal(status.data.operational_state.sse_connected, true);
  assert.equal(status.data.persistence.ready, true);
  assert.equal(status.data.fallback, 'none');
  assert.equal(status.data.replay.included_exchange_count, 0);

  const stats = await harness.controller.handleLocalCommand('/stats');
  assert.equal(stats.ok, true);
  assert.equal(stats.data.session.completed_calls, 1);
  assert.equal(stats.data.session.api_rounds, 1);
  assert.equal(stats.data.last_call.rounds, 1);
  assert.equal(stats.data.live_history.exchange_count, 1);
  assert.deepEqual(stats.data.durable_history.exchange_ids, ['runtime-1']);
  assert.equal(typeof stats.data.durable_history.bytes, 'number');
  assert.equal(stats.data.replay.body_utf8_bytes, turn.telemetry.replay.body_utf8_bytes);
  assert.equal(harness.requests.length, 1);
});

test('V42: unknown or malformed slash commands stay local and direct provider dispatch is guarded', async () => {
  const harness = createHarness();
  const unknown = await harness.controller.handleLocalCommand('/launch warp');
  assert.equal(unknown.handled, true);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'unknown_command');
  assert.match(unknown.data.help_hint, /\/help/);

  const malformed = await harness.controller.handleLocalCommand('/status extra');
  assert.equal(malformed.ok, false);
  assert.equal(malformed.code, 'unexpected_argument');
  await assert.rejects(
    harness.controller.runTurn({ ...turnOptions('slash-guard'), question: '  /launch warp' }),
    error => error?.code === 'slash_command_requires_local_dispatch'
  );
  assert.equal(harness.requests.length, 0);
  assert.ok(harness.events.some(event =>
    event.type === 'command_result' && event.payload.code === 'unknown_command'
  ));
});

test('V43: busy next-turn settings are isolated from the active snapshot and prompt grounding is registry-derived', async t => {
  const fixture = persistenceFixture(t, 'command-busy');
  let resolveActive;
  const activeResponse = new Promise(resolve => { resolveActive = resolve; });
  const harness = createHarness({
    actions: [() => activeResponse, providerResponse({ model: MODEL_IDS.pro, content: 'next answer' })],
    fsAdapter: fixture.fsAdapter,
    paths: fixture.paths,
    clock: fixture.clock
  });
  await harness.controller.loadPersistentState();

  const active = harness.controller.runTurn(turnOptions('active-snapshot'));
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.requests[0].body.model, MODEL_IDS.flash);
  assert.equal(harness.requests[0].body.reasoning_effort, REASONING_EFFORTS.high);

  const busyStatus = await harness.controller.handleLocalCommand('/status');
  assert.equal(busyStatus.ok, true);
  assert.equal(busyStatus.data.busy, true);
  const blockedClear = await harness.controller.handleLocalCommand('/clear');
  assert.equal(blockedClear.ok, false);
  assert.equal(blockedClear.code, 'command_requires_idle');
  assert.equal((await harness.controller.handleLocalCommand('/model pro')).ok, true);
  assert.equal((await harness.controller.handleLocalCommand('/reasoning max')).ok, true);
  assert.equal(harness.controller.getContractSnapshot().configured_settings.model, MODEL_IDS.pro);
  assert.equal(harness.controller.getContractSnapshot().configured_settings.reasoning_effort, REASONING_EFFORTS.max);

  resolveActive(providerResponse({ model: MODEL_IDS.flash, content: 'active answer' }));
  const activeResult = await active;
  assert.equal(activeResult.telemetry.configured_model, MODEL_IDS.flash);
  assert.equal(activeResult.telemetry.configured_reasoning_effort, REASONING_EFFORTS.high);
  assert.deepEqual(activeResult.telemetry.actual_models, [MODEL_IDS.flash]);

  const nextResult = await harness.controller.runTurn(turnOptions('next-snapshot'));
  assert.equal(nextResult.status, 'completed');
  assert.equal(harness.requests[1].body.model, MODEL_IDS.pro);
  assert.equal(harness.requests[1].body.reasoning_effort, REASONING_EFFORTS.max);

  const systemContent = harness.requests[0].body.messages[0].content;
  const promptBlock = buildCommandPromptBlock();
  assert.ok(systemContent.endsWith(promptBlock));
  for (const entry of COMMAND_REGISTRY) {
    assert.equal(systemContent.split(entry.syntax).length - 1, 1, `${entry.syntax} must be grounded once`);
  }
});

test('V02: the real 38-tool catalogue exactly matches canonical executor dispatch coverage', () => {
  const source = fs.readFileSync(path.join(REPO, 'motherbrain.js'), 'utf8');
  const start = source.indexOf('async function executeToolCall(name, args) {');
  const end = source.indexOf('// ── Canonical structured dispatch seam', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const executorSource = source.slice(start, end);
  const dispatchedNames = new Set(
    [...executorSource.matchAll(/name === '([^']+)'/g)].map(match => match[1])
  );
  assert.deepEqual(
    [...dispatchedNames].sort(),
    TOOLS.map(tool => tool.function.name).sort()
  );
});

test('V44: malformed and nonobject arguments receive one linked deterministic rejection without dispatch', async () => {
  const tool = TOOLS.find(candidate => (candidate.function.parameters.required ?? []).length > 0);
  assert.ok(tool);
  const cases = [
    ['invalid_json', '{bad', 'invalid_tool_arguments_json'],
    ['array', '[]', 'invalid_tool_arguments_object'],
    ['null', 'null', 'invalid_tool_arguments_object'],
    ['scalar', '7', 'invalid_tool_arguments_object']
  ];
  for (const [label, rawArguments, expectedCode] of cases) {
    const call = providerToolCall(tool, `v44-${label}`, {}, rawArguments);
    const harness = createHarness({
      actions: [
        providerResponse({ finishReason: 'tool_calls', content: null, toolCalls: [call] }),
        providerResponse({ content: `completed-${label}` })
      ]
    });
    const result = await harness.controller.runTurn(turnOptions(`v44-${label}`));
    assert.equal(result.status, 'completed');
    assert.equal(harness.dispatchCalls.length, 0);
    const linked = result.exchange.provider_messages.filter(message =>
      message.role === 'tool' && message.tool_call_id === call.id
    );
    assert.equal(linked.length, 1);
    assert.equal(typeof linked[0].content, 'string');
    const rejection = JSON.parse(linked[0].content);
    assert.equal(rejection.error, 'invalid_tool_call');
    assert.equal(rejection.code, expectedCode);
    assert.equal(result.exchange.round_summaries[0].tool_results[0].outcome, 'rejected');
    assert.equal(result.exchange.round_summaries[0].tool_results[0].gate_code, expectedCode);
  }
});

test('V45: required, extra, scalar-type, and enum violations are rejected factually before dispatch', async () => {
  const requiredTool = TOOLS.find(tool => (tool.function.parameters.required ?? []).length > 0);
  const enumTool = TOOLS.find(tool =>
    Object.values(tool.function.parameters.properties ?? {}).some(property => Array.isArray(property.enum))
  );
  assert.ok(requiredTool);
  assert.ok(enumTool);

  const requiredName = requiredTool.function.parameters.required[0];
  const missingArgs = validArgsForTool(requiredTool);
  delete missingArgs[requiredName];
  const extraArgs = { ...validArgsForTool(requiredTool), invented_field: 'forbidden' };
  const typedName = Object.keys(requiredTool.function.parameters.properties)[0];
  const typedSchema = requiredTool.function.parameters.properties[typedName];
  const wrongValue = typedSchema.type === 'string' ? 7
    : typedSchema.type === 'integer' ? 'seven'
      : typedSchema.type === 'boolean' ? 'true'
        : [];
  const wrongTypeArgs = { ...validArgsForTool(requiredTool), [typedName]: wrongValue };
  const enumEntry = Object.entries(enumTool.function.parameters.properties)
    .find(([, property]) => Array.isArray(property.enum));
  const enumArgs = { ...validArgsForTool(enumTool), [enumEntry[0]]: '__outside_enum__' };

  const cases = [
    ['missing', requiredTool, missingArgs, 'missing_tool_argument', requiredName],
    ['extra', requiredTool, extraArgs, 'unexpected_tool_argument', 'invented_field'],
    ['type', requiredTool, wrongTypeArgs, 'invalid_tool_argument_type', typedName],
    ['enum', enumTool, enumArgs, 'invalid_tool_argument_enum', enumEntry[0]]
  ];
  for (const [label, tool, args, expectedCode, fieldName] of cases) {
    const call = providerToolCall(tool, `v45-${label}`, args);
    const harness = createHarness({
      actions: [
        providerResponse({ finishReason: 'tool_calls', content: null, toolCalls: [call] }),
        providerResponse({ content: `completed-${label}` })
      ]
    });
    const result = await harness.controller.runTurn(turnOptions(`v45-${label}`));
    assert.equal(result.status, 'completed');
    assert.equal(harness.dispatchCalls.length, 0);
    const linked = result.exchange.provider_messages.find(message =>
      message.role === 'tool' && message.tool_call_id === call.id
    );
    const rejection = JSON.parse(linked.content);
    assert.equal(rejection.code, expectedCode);
    assert.match(rejection.detail, new RegExp(fieldName));
  }
});

test('V46: every envelope is preflighted and an unlinkable batch aborts before its first valid call', async () => {
  const tool = TOOLS.find(candidate => (candidate.function.parameters.required ?? []).length > 0);
  const args = validArgsForTool(tool);
  const baseValid = providerToolCall(tool, 'v46-valid-first', args);
  const second = providerToolCall(tool, 'v46-second', args);
  const missingId = clone(second);
  delete missingId.id;
  const wrongType = { ...clone(second), type: 'not_function' };
  const missingName = clone(second);
  delete missingName.function.name;
  const duplicate = providerToolCall(tool, baseValid.id, args);
  const cases = [
    ['missing-id', [baseValid, missingId], 'missing_tool_call_id'],
    ['duplicate-id', [baseValid, duplicate], 'duplicate_tool_call_id'],
    ['wrong-type', [baseValid, wrongType], 'invalid_tool_call_type'],
    ['missing-name', [baseValid, missingName], 'invalid_tool_name']
  ];
  for (const [label, calls, expectedCode] of cases) {
    const harness = createHarness({
      actions: [providerResponse({ finishReason: 'tool_calls', content: null, toolCalls: calls })]
    });
    const result = await harness.controller.runTurn(turnOptions(`v46-${label}`));
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, expectedCode);
    assert.equal(harness.dispatchCalls.length, 0);
    assert.equal(harness.requests.length, 1);
    assert.ok(harness.events.some(event =>
      event.type === 'turn_terminal' && event.payload.error.code === expectedCode
    ));
  }
});

test('V47: the structured adapter invokes the unchanged canonical gate once and preserves exact provider bytes', async () => {
  const guardedFs = ({ exists = false, source = '' } = {}) => {
    const calls = [];
    return {
      calls,
      existsSync(target) { calls.push(['existsSync', target]); return exists; },
      mkdirSync(target, options) { calls.push(['mkdirSync', target, options]); },
      writeFileSync(target, value, encoding) { calls.push(['writeFileSync', target, value, encoding]); },
      readFileSync(target, encoding) { calls.push(['readFileSync', target, encoding]); return source; },
      readdirSync(target) { calls.push(['readdirSync', target]); return []; }
    };
  };
  const rejectedHttp = status => async () => {
    const error = new Error('diagnostic request failed');
    error.response = { status, data: { error: status === 401 ? 'unauthorized' : 'forbidden' } };
    throw error;
  };
  const scenarios = [
    {
      label: 'no-session required', name: 'get_turn_data', args: { turn: 1 },
      options: () => ({ activeSessionId: null }), outcome: 'rejected', gateCode: 'no_session_active',
      assertDenied: harness => assert.equal(harness.httpCalls.length, 0)
    },
    {
      label: 'session-free exception', name: 'harness_disconnect', args: {},
      options: () => ({ activeSessionId: null }), outcome: 'executed', gateCode: null
    },
    {
      label: 'harness offline', name: 'harness_status', args: {},
      options: () => ({ harnessAuthorized: false }), outcome: 'rejected', gateCode: 'redacted_error',
      assertDenied: harness => assert.equal(harness.httpCalls.length, 0)
    },
    {
      label: 'harness connected', name: 'harness_status', args: {},
      options: () => ({
        harnessAuthorized: true,
        axiosGet: async () => ({ data: { z_null: null, first: 1, omitted: undefined, last: 2 } })
      }), outcome: 'executed', gateCode: null,
      assertAdapted: harness => assert.equal(harness.httpCalls.length, 1)
    },
    {
      label: 'missing GitHub PAT', name: 'github_get_commit', args: { sha: 'abc' },
      options: () => ({ githubPat: '' }), outcome: 'rejected', gateCode: 'github_pat_not_configured',
      assertDenied: harness => assert.equal(harness.httpCalls.length, 0)
    },
    {
      label: 'diagnostic 401', name: 'get_source_slice', args: { file: 'index.js' },
      options: () => ({ axiosGet: rejectedHttp(401) }), outcome: 'rejected', gateCode: 'redacted_error'
    },
    {
      label: 'diagnostic 403', name: 'get_source_slice', args: { file: 'index.js' },
      options: () => ({ axiosGet: rejectedHttp(403) }), outcome: 'rejected', gateCode: 'redacted_error'
    },
    {
      label: 'filesystem containment', name: 'write_file', args: { path: '../escape.txt', content: 'blocked' },
      options: () => ({ fsImpl: guardedFs() }), outcome: 'rejected', gateCode: 'invalid_path',
      assertDenied: harness => assert.equal(harness.fsImpl.calls.some(call => call[0] === 'writeFileSync'), false)
    },
    {
      label: 'filesystem no-overwrite', name: 'write_file', args: { path: 'existing.txt', content: 'blocked' },
      options: () => ({ fsImpl: guardedFs({ exists: true }) }), outcome: 'rejected', gateCode: 'file_exists',
      assertDenied: harness => assert.equal(harness.fsImpl.calls.some(call => call[0] === 'writeFileSync'), false)
    },
    {
      label: 'filesystem exact-match denial', name: 'patch_file',
      args: { path: 'existing.txt', old_string: 'same', new_string: 'changed' },
      options: () => ({ fsImpl: guardedFs({ exists: true, source: 'same\nsame\n' }) }),
      outcome: 'rejected', gateCode: 'ambiguous_match',
      assertDenied: harness => assert.equal(harness.fsImpl.calls.some(call => call[0] === 'writeFileSync'), false)
    }
  ];

  for (const scenario of scenarios) {
    const baselineHarness = loadProductionExecutorHarness(scenario.options());
    const baseline = await baselineHarness.legacy(scenario.name, clone(scenario.args));
    const adapterHarness = loadProductionExecutorHarness(scenario.options());
    let canonicalInvocations = 0;
    const adapter = adapterHarness.createAdapter(async (name, args) => {
      canonicalInvocations++;
      return adapterHarness.legacy(name, args);
    });
    const adapted = await adapter({ id: `v47-${scenario.label}`, name: scenario.name, args: clone(scenario.args) });
    assert.equal(canonicalInvocations, 1, scenario.label);
    assert.equal(adapted.toolContent, baseline, scenario.label);
    assert.equal(adapted.outcome, scenario.outcome, scenario.label);
    assert.equal(adapted.gateCode, scenario.gateCode, scenario.label);
    assert.equal(JSON.stringify(adapted).includes('DIAGNOSTIC_SENTINEL_DO_NOT_RENDER'), false, scenario.label);
    if (typeof baseline === 'string' && baseline.startsWith('{')) {
      const providerValue = JSON.parse(baseline);
      assert.equal(Object.hasOwn(providerValue, 'outcome'), false, scenario.label);
      assert.equal(Object.hasOwn(providerValue, 'gateCode'), false, scenario.label);
    }
    if (scenario.assertDenied) scenario.assertDenied(adapterHarness);
    if (scenario.assertAdapted) scenario.assertAdapted(adapterHarness);
  }

  const controllerSource = fs.readFileSync(path.join(REPO, 'motherbrain-controller.js'), 'utf8');
  for (const forbiddenPolicyCopy of [
    'SESSION_FREE_TOOLS', '_harnessAuthorized', 'GITHUB_PAT', 'no_session_active', 'github_pat_not_configured'
  ]) {
    assert.equal(controllerSource.includes(forbiddenPolicyCopy), false, forbiddenPolicyCopy);
  }
});

test('V48: the legacy executor authority body, tool catalogue, edit doctrine, and hard write guards remain contained', async () => {
  const source = fs.readFileSync(path.join(REPO, 'motherbrain.js'), 'utf8');
  const declaration = 'async function executeToolCall(name, args) {';
  const bodyStart = source.indexOf(declaration) + declaration.length;
  const bodyEnd = source.indexOf('// ── Canonical structured dispatch seam', bodyStart);
  const executorBody = source.slice(bodyStart, bodyEnd).trimEnd();
  assert.equal(
    crypto.createHash('sha256').update(normalizeStep10ExecutorOutputBoundary(executorBody), 'utf8').digest('hex').toUpperCase(),
    EXECUTOR_BODY_BASELINE_SHA256
  );
  const toolsStart = source.indexOf('const MB_TOOLS = [');
  const hostStart = source.indexOf('const HOST', toolsStart);
  assert.equal(
    crypto.createHash('sha256').update(source.slice(toolsStart, hostStart), 'utf8').digest('hex').toUpperCase(),
    MB_TOOLS_BASELINE_SHA256
  );
  for (const doctrine of [
    'write_file: Creates a new file inside Game-main. Fails if the file already exists unless overwrite:true is explicitly passed.',
    'MANDATORY WORKFLOW before calling patch_file:',
    'Never overwrite an existing scenario or probe file.'
  ]) assert.ok(source.includes(doctrine), doctrine);

  const calls = [];
  const noMatchFs = {
    existsSync(target) { calls.push(['existsSync', target]); return true; },
    readFileSync(target, encoding) { calls.push(['readFileSync', target, encoding]); return 'alpha\nbeta\n'; },
    writeFileSync(target, value, encoding) { calls.push(['writeFileSync', target, value, encoding]); },
    mkdirSync() {},
    readdirSync() { return []; }
  };
  const harness = loadProductionExecutorHarness({ fsImpl: noMatchFs });
  const result = JSON.parse(await harness.legacy('patch_file', {
    path: 'existing.txt', old_string: 'not-present', new_string: 'replacement'
  }));
  assert.equal(result.error, 'old_string_not_found');
  assert.equal(calls.some(call => call[0] === 'writeFileSync'), false);
});

test('V49: distinct valid IDs execute sequentially once even when tool name and arguments are identical', async () => {
  const tool = TOOLS.find(candidate => (candidate.function.parameters.required ?? []).length > 0);
  const args = validArgsForTool(tool);
  const order = [];
  let activeDispatches = 0;
  const harness = createHarness({
    actions: [
      providerResponse({
        finishReason: 'tool_calls',
        content: null,
        toolCalls: [
          providerToolCall(tool, 'same-args-1', args),
          providerToolCall(tool, 'same-args-2', args)
        ]
      }),
      providerResponse({ content: 'same-args-complete' })
    ],
    dispatchImpl: async call => {
      activeDispatches++;
      assert.equal(activeDispatches, 1);
      order.push(`start:${call.id}`);
      await Promise.resolve();
      order.push(`end:${call.id}`);
      activeDispatches--;
      return { toolContent: `result:${call.id}`, outcome: 'executed', gateCode: null };
    }
  });
  const result = await harness.controller.runTurn(turnOptions('v49-distinct-ids'));
  assert.equal(result.status, 'completed');
  assert.deepEqual(order, [
    'start:same-args-1', 'end:same-args-1',
    'start:same-args-2', 'end:same-args-2'
  ]);
  assert.deepEqual(harness.dispatchCalls.map(call => call.id), ['same-args-1', 'same-args-2']);
});

test('V49: a provider-replayed call ID receives a linked rejection and never executes twice', async () => {
  const tool = TOOLS.find(candidate => (candidate.function.parameters.required ?? []).length > 0);
  const args = validArgsForTool(tool);
  const repeated = providerToolCall(tool, 'logical-once', args);
  const harness = createHarness({
    actions: [
      providerResponse({ finishReason: 'tool_calls', content: null, toolCalls: [repeated] }),
      providerResponse({ finishReason: 'tool_calls', content: null, toolCalls: [repeated] }),
      providerResponse({ content: 'replay-complete' })
    ]
  });
  const result = await harness.controller.runTurn(turnOptions('v49-replayed-id'));
  assert.equal(result.status, 'completed');
  assert.deepEqual(harness.dispatchCalls.map(call => call.id), ['logical-once']);
  const linked = result.exchange.provider_messages.filter(message =>
    message.role === 'tool' && message.tool_call_id === 'logical-once'
  );
  assert.equal(linked.length, 2);
  assert.equal(JSON.parse(linked[1].content).code, 'replayed_tool_call_id');
  assert.equal(result.exchange.round_summaries[1].tool_results[0].outcome, 'rejected');
});

test('V49: a denied call remains non-executable through context recovery and corrected replay', async () => {
  const tool = TOOLS.find(candidate => (candidate.function.parameters.required ?? []).length > 0);
  const args = validArgsForTool(tool);
  const denied = providerToolCall(tool, 'denied-logical-call', {}, '[]');
  const correctedReplay = providerToolCall(tool, 'denied-logical-call', args);
  const harness = createHarness({
    actions: [
      providerResponse({ finishReason: 'tool_calls', content: null, toolCalls: [denied] }),
      providerError({ status: 400, contextFixture: true }),
      providerResponse({ finishReason: 'tool_calls', content: null, toolCalls: [correctedReplay] }),
      providerResponse({ content: 'denial-recovery-complete' })
    ],
    contextClassifier: error => error.contextFixture === true
  });
  harness.controller._completedExchanges = [completedExchange('v49-prior')];
  const result = await harness.controller.runTurn(turnOptions('v49-denial-recovery'));
  assert.equal(result.status, 'completed');
  assert.equal(result.telemetry.retry_count, 1);
  assert.equal(harness.dispatchCalls.length, 0);
  const linked = result.exchange.provider_messages.filter(message =>
    message.role === 'tool' && message.tool_call_id === 'denied-logical-call'
  );
  assert.equal(linked.length, 2);
  assert.equal(JSON.parse(linked[0].content).code, 'invalid_tool_arguments_object');
  assert.equal(JSON.parse(linked[1].content).code, 'replayed_tool_call_id');
});

test('V50: all real schemas fit the frozen subset, opaque objects stay opaque, and rendered activity hides values', async () => {
  const schemaIndex = createObservedToolSchemaIndex(TOOLS);
  assert.equal(schemaIndex.size, 38);
  const allowedTypes = new Set(['string', 'integer', 'boolean', 'object']);
  const opaqueParameters = [];
  for (const tool of TOOLS) {
    const properties = tool.function.parameters.properties ?? {};
    const allArgs = {};
    for (const [name, property] of Object.entries(properties)) {
      assert.ok(allowedTypes.has(property.type), `${tool.function.name}.${name}`);
      allArgs[name] = validSchemaValue(property);
      if (property.type === 'object') opaqueParameters.push([tool, name]);
    }
    const validation = validateToolCallBatch([
      providerToolCall(tool, `schema-${tool.function.name}`, allArgs)
    ], TOOLS);
    assert.equal(validation.abort, false, tool.function.name);
    assert.equal(validation.calls[0].status, 'valid', tool.function.name);
  }
  assert.deepEqual(
    opaqueParameters.map(([tool, name]) => `${tool.function.name}.${name}`).sort(),
    ['create_probe_spec.spec', 'create_scenario_file.scenario']
  );

  const opaqueCalls = opaqueParameters.map(([tool, propertyName], index) => {
    const args = validArgsForTool(tool);
    args[propertyName] = {
      arbitrary_internal_key: { nested_array: [1, null, { retained: true }] },
      backend_owned_shape: 'unchanged'
    };
    return providerToolCall(tool, `opaque-valid-${index + 1}`, args);
  });
  const validHarness = createHarness({
    actions: [
      providerResponse({ finishReason: 'tool_calls', content: null, toolCalls: opaqueCalls }),
      providerResponse({ content: 'opaque-complete' })
    ]
  });
  const validResult = await validHarness.controller.runTurn(turnOptions('v50-opaque-valid'));
  assert.equal(validResult.status, 'completed');
  assert.deepEqual(validHarness.dispatchCalls.map(call => call.id), ['opaque-valid-1', 'opaque-valid-2']);
  for (let index = 0; index < opaqueParameters.length; index++) {
    const propertyName = opaqueParameters[index][1];
    assert.deepEqual(
      validHarness.dispatchCalls[index].args[propertyName],
      JSON.parse(opaqueCalls[index].function.arguments)[propertyName]
    );
  }

  for (const [tool, propertyName] of opaqueParameters) {
    for (const invalidValue of [[], null, 'scalar']) {
      const args = validArgsForTool(tool);
      args[propertyName] = invalidValue;
      const validation = validateToolCallBatch([
        providerToolCall(tool, `opaque-invalid-${tool.function.name}-${String(invalidValue)}`, args)
      ], TOOLS);
      assert.equal(validation.abort, false);
      assert.equal(validation.calls[0].status, 'rejected');
      assert.equal(validation.calls[0].error.code, 'invalid_tool_argument_type');
    }
  }

  const stringTool = TOOLS.find(tool =>
    Object.entries(tool.function.parameters.properties ?? {})
      .some(([, property]) => property.type === 'string' && !property.enum)
  );
  const secretArgs = validArgsForTool(stringTool);
  const secretEntry = Object.entries(stringTool.function.parameters.properties)
    .find(([, property]) => property.type === 'string' && !property.enum);
  const secretValue = 'ACTUAL_SECRET_SENTINEL_MUST_NOT_RENDER';
  secretArgs[secretEntry[0]] = secretValue;
  const secretCall = providerToolCall(stringTool, 'secret-shaped-call', secretArgs);
  const secretHarness = createHarness({
    actions: [
      providerResponse({ finishReason: 'tool_calls', content: null, toolCalls: [secretCall] }),
      providerResponse({ content: 'secret-render-complete' })
    ],
    dispatchImpl: () => ({
      toolContent: JSON.stringify({ error: 'forbidden', detail: 'credential not rendered' }),
      outcome: 'rejected',
      gateCode: 'forbidden'
    })
  });
  const secretResult = await secretHarness.controller.runTurn(turnOptions('v50-secret-render'));
  assert.equal(secretResult.status, 'completed');
  assert.equal(JSON.stringify(secretHarness.events).includes(secretValue), false);
  const providerToolResult = secretResult.exchange.provider_messages.find(message => message.role === 'tool');
  assert.equal(providerToolResult.content, JSON.stringify({ error: 'forbidden', detail: 'credential not rendered' }));
  assert.equal(Object.hasOwn(providerToolResult, 'outcome'), false);
  assert.equal(Object.hasOwn(providerToolResult, 'gateCode'), false);
  assert.equal(JSON.stringify(secretResult.exchange.provider_messages).includes('gate_code'), false);
  assert.equal(secretResult.exchange.round_summaries[0].tool_results[0].gate_code, 'forbidden');
});

test('V55: controller view redaction and server-clock projection are recursive, bounded, deterministic, and pure', () => {
  const explicitSecret = 'ENV_VALUE_NEVER_RENDER_4242';
  const environmentSecrets = environmentSecretValues({
    DEEPSEEK_API_KEY: 'synthetic-deepseek-secret',
    GITHUB_PAT: 'synthetic-github-secret',
    DIAGNOSTICS_KEY: 'synthetic-diagnostics-secret',
    USERNAME: 'ordinary-user-name',
    NUMBER_OF_PROCESSORS: '12',
  });
  assert.deepEqual(environmentSecrets.sort(), [
    'synthetic-deepseek-secret',
    'synthetic-diagnostics-secret',
    'synthetic-github-secret',
  ]);
  const source = {
    authorization: 'Bearer provider-token-never-render',
    visible: 'ordinary visible value',
    nested: {
      api_key: 'sk-secretvalue123456',
      opaque: {
        github_pat: 'github_pat_secretvalue123456',
        retained: true,
      },
    },
    list: ['ACTUAL_SECRET_SENTINEL_MUST_NOT_RENDER', explicitSecret, 7, false],
    payload: 'x'.repeat(600),
  };
  const before = clone(source);
  const redacted = redactDisplayValue(source, { secretValues: [explicitSecret] });
  const rendered = JSON.stringify(redacted);
  for (const forbidden of [
    'provider-token-never-render',
    'sk-secretvalue123456',
    'github_pat_secretvalue123456',
    'ACTUAL_SECRET_SENTINEL_MUST_NOT_RENDER',
    explicitSecret,
  ]) assert.equal(rendered.includes(forbidden), false, `view redaction leaked ${forbidden}`);
  assert.equal(redacted.authorization, REDACTED_DISPLAY_VALUE);
  assert.equal(redacted.nested.api_key, REDACTED_DISPLAY_VALUE);
  assert.equal(redacted.nested.opaque.github_pat, REDACTED_DISPLAY_VALUE);
  assert.equal(redacted.visible, source.visible);

  const preview = boundedToolResultPreview(JSON.stringify(source), {
    maxChars: TOOL_RESULT_PREVIEW_CHAR_LIMIT,
    secretValues: [explicitSecret],
  });
  assert.ok([...preview.preview].length <= TOOL_RESULT_PREVIEW_CHAR_LIMIT);
  assert.equal(preview.truncated, true);
  assert.equal(preview.redacted, true);
  for (const forbidden of [
    'provider-token-never-render',
    'sk-secretvalue123456',
    'github_pat_secretvalue123456',
    'ACTUAL_SECRET_SENTINEL_MUST_NOT_RENDER',
    explicitSecret,
  ]) assert.equal(preview.preview.includes(forbidden), false, `bounded preview leaked ${forbidden}`);
  assert.deepEqual(source, before, 'view redaction mutated the canonical source object');

  const injectedDate = new Date(2026, 6, 16, 15, 30, 0, 0);
  const serverClock = buildServerClockSnapshot(() => injectedDate);
  assert.deepEqual(serverClock, {
    iso: injectedDate.toISOString(),
    date: '07/16/2026',
    time: '3:30 PM',
    weekday: 'Thu',
    daypart: 'afternoon',
    timezone: 'server-local',
  });
  assert.equal(TELEMETRY_FIELD_AUTHORITY.configured_effort, 'configured_settings.reasoning_effort (configured)');
  assert.equal(Object.hasOwn(TELEMETRY_FIELD_AUTHORITY, 'actual_effort'), false);
  assert.match(TELEMETRY_FIELD_AUTHORITY.actual_model, /provider response model/);
  assert.match(TELEMETRY_FIELD_AUTHORITY.unavailable, /never coerced to zero/);
});

test('V52/V54/V55: structured rounds retain exact provider data while exposing stable, redacted, truthful projections', async t => {
  const environmentKey = 'MB_STEP11_DISPLAY_SECRET_TOKEN';
  const previousEnvironmentValue = process.env[environmentKey];
  const syntheticEnvironmentSecret = 'synthetic-live-environment-secret';
  process.env[environmentKey] = syntheticEnvironmentSecret;
  t.after(() => {
    if (previousEnvironmentValue === undefined) delete process.env[environmentKey];
    else process.env[environmentKey] = previousEnvironmentValue;
  });
  const tool = TOOLS.find(candidate =>
    Object.values(candidate.function.parameters.properties ?? {})
      .some(property => property.type === 'string' && !property.enum)
  );
  const args = validArgsForTool(tool);
  const secretToolResult = JSON.stringify({
    ok: true,
    authorization: 'Bearer runtime-tool-result-secret',
    nested: { api_key: 'sk-runtime-tool-result-secret' },
    innocuous_backend_field: syntheticEnvironmentSecret,
    visible: 'result detail remains visible',
    payload: 'z'.repeat(600),
  });
  const calls = [
    providerToolCall(tool, 'step11-tool-alpha', args),
    providerToolCall(tool, 'step11-tool-beta', args),
  ];
  const harness = createHarness({
    actions: [
      providerResponse({
        model: MODEL_IDS.flash,
        finishReason: 'tool_calls',
        content: null,
        reasoningContent: 'exact first-round reasoning',
        toolCalls: calls,
      }),
      providerError({ status: 503 }),
      providerResponse({
        model: MODEL_IDS.pro,
        content: 'step 11 grouped completion',
        includeReasoning: false,
      }),
    ],
    dispatchImpl: () => ({
      toolContent: secretToolResult,
      outcome: 'executed',
      gateCode: null,
    }),
  });
  harness.controller.updateOperationalState({
    engine: 'online',
    sse: 'connected',
    session: 'attached',
    game: 'active',
    harness: 'authorized',
  });

  const result = await harness.controller.runTurn(turnOptions('step11-structured-rounds'));
  assert.equal(result.status, 'completed');
  assert.equal(result.telemetry.fallback, 'none');
  assert.equal(result.telemetry.round_records.length, 2);
  assert.deepEqual(result.telemetry.round_records.map(round => round.id), [
    'turn-1-round-1',
    'turn-1-round-2',
  ]);

  const [firstRound, secondRound] = result.telemetry.round_records;
  assert.equal(firstRound.reasoning, 'exact first-round reasoning');
  assert.deepEqual(firstRound.tool_calls.map(call => call.call_id_suffix), ['ol-alpha', 'ool-beta']);
  assert.equal(firstRound.tool_calls.length, 2);
  assert.equal(firstRound.tool_results.length, 2);
  assert.deepEqual(firstRound.states, ['waiting', 'executing', 'synthesizing']);
  assert.equal(firstRound.tool_results.every(item => item.truncated && item.redacted), true);
  assert.equal(firstRound.tool_results.every(item => item.preview.includes('result detail remains visible')), true);
  assert.equal(secondRound.reasoning, null);
  assert.equal(secondRound.actual_model, MODEL_IDS.pro);
  assert.equal(secondRound.attempt_count, 2);
  assert.equal(secondRound.retries.length, 1);
  assert.deepEqual(secondRound.states, ['waiting', 'retrying', 'completed']);

  const providerToolMessages = result.exchange.provider_messages.filter(message => message.role === 'tool');
  assert.equal(providerToolMessages.length, 2);
  assert.equal(providerToolMessages.every(message => message.content === secretToolResult), true);
  assert.equal(result.exchange.round_summaries[0].tool_results.every(item => item.bytes === Buffer.byteLength(secretToolResult)), true);
  const viewText = JSON.stringify({ round_records: result.telemetry.round_records, events: harness.events });
  assert.equal(viewText.includes('runtime-tool-result-secret'), false);
  assert.equal(viewText.includes('sk-runtime-tool-result-secret'), false);
  assert.equal(viewText.includes(syntheticEnvironmentSecret), false);
  assert.equal(viewText.includes(secretToolResult), false);

  const snapshot = harness.controller.getTelemetrySnapshot();
  assert.equal(snapshot.last_actual_model, MODEL_IDS.pro);
  assert.equal(snapshot.configured_settings.model, MODEL_IDS.flash);
  assert.equal(snapshot.configured_settings.reasoning_effort, REASONING_EFFORTS.high);
  assert.equal(snapshot.configured_settings.effort_attribution, 'configured');
  assert.equal(snapshot.state.busy, false);
  assert.equal(snapshot.session.completed_calls, 1);
  assert.equal(snapshot.session.api_rounds, 2);
  assert.equal(snapshot.session.api_attempts, 3);
  assert.equal(snapshot.conversation.exchange_count, 1);
  assert.ok(Number.isInteger(snapshot.conversation.estimated_history_tokens));
  assert.deepEqual(snapshot.operational_state, {
    engine: 'online', sse: 'connected', session: 'attached', game: 'active', harness: 'authorized',
  });
  assert.equal(snapshot.server_clock.iso, FIXED_TIME);
  assert.equal(snapshot.pricing.source_date, '2026-07-16');
  assert.deepEqual(snapshot.field_authority, TELEMETRY_FIELD_AUTHORITY);
  assert.equal(Object.hasOwn(snapshot, 'actual_effort'), false);
  assert.equal(Object.hasOwn(snapshot.last_call, 'actual_effort'), false);

  const status = await harness.controller.handleLocalCommand('/status');
  const stats = await harness.controller.handleLocalCommand('/stats');
  assert.equal(status.ok, true);
  assert.equal(stats.ok, true);
  assert.deepEqual(status.data.operational_state, snapshot.operational_state);
  assert.deepEqual(status.data.telemetry.field_authority, TELEMETRY_FIELD_AUTHORITY);
  assert.deepEqual(stats.data.last_call.per_round, snapshot.last_call.per_round);
  assert.deepEqual(stats.data.last_call.round_records, snapshot.last_call.round_records);
  assert.deepEqual(stats.data.session, snapshot.session);
  assert.deepEqual(stats.data.replay, snapshot.replay);
});

test('V13/V14: all four model/effort combinations emit the exact V4 request', async () => {
  for (const model of Object.values(MODEL_IDS)) {
    for (const effort of Object.values(REASONING_EFFORTS)) {
      const harness = createHarness({
        model,
        effort,
        actions: [providerResponse({ model })]
      });
      const result = await harness.controller.runTurn(turnOptions(`${model}-${effort}`));
      assert.equal(result.status, 'completed');
      assert.equal(harness.requests.length, 1);
      const request = harness.requests[0];
      assert.equal(request.method, 'POST');
      assert.equal(request.url, 'https://api.deepseek.com/chat/completions');
      assert.deepEqual(Object.keys(request.body), [
        'model', 'thinking', 'reasoning_effort', 'max_tokens', 'messages', 'tools'
      ]);
      assert.equal(request.body.model, model);
      assert.deepEqual(request.body.thinking, { type: 'enabled' });
      assert.equal(request.body.reasoning_effort, effort);
      assert.equal(request.body.max_tokens, 128000);
      assert.equal(request.body.tools.length, 38);
      for (const excluded of [
        'temperature', 'top_p', 'frequency_penalty', 'presence_penalty',
        'tool_choice', 'stream', 'response_format'
      ]) assert.equal(Object.hasOwn(request.body, excluded), false, excluded);
      assert.equal(
        Buffer.byteLength(JSON.stringify(request.body), 'utf8'),
        result.telemetry.replay.body_utf8_bytes
      );
      assert.equal(result.telemetry.configured_model, model);
      assert.equal(result.telemetry.configured_reasoning_effort, effort);
      assert.equal(result.telemetry.effort_attribution, 'configured');
      assert.equal(result.telemetry.fallback, 'none');
      const completionEvents = harness.events.filter(event => event.type === 'turn_completed');
      assert.equal(completionEvents.length, 1);
      assert.equal(completionEvents[0].payload.exchange_id, result.exchange.id);
      assert.equal(completionEvents[0].payload.final_answer, result.final_answer);
    }
  }
});

test('V15/V25-V30: actual-model authority, usage identities, reasoning subset, and pricing remain truthful', async () => {
  const millionUsage = usage({
    prompt_tokens: 1000000,
    completion_tokens: 1000000,
    total_tokens: 2000000,
    prompt_cache_hit_tokens: 400000,
    prompt_cache_miss_tokens: 600000,
    completion_tokens_details: { reasoning_tokens: 250000 }
  });
  const harness = createHarness({
    model: MODEL_IDS.flash,
    actions: [
      providerResponse({
        model: MODEL_IDS.flash,
        finishReason: 'tool_calls',
        content: null,
        toolCalls: [toolCall('price-1')],
        responseUsage: millionUsage
      }),
      providerResponse({ model: MODEL_IDS.pro, responseUsage: millionUsage })
    ]
  });
  const result = await harness.controller.runTurn(turnOptions('pricing'));
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.telemetry.actual_models, [MODEL_IDS.flash, MODEL_IDS.pro]);
  assert.equal(result.telemetry.usage.prompt_identity_valid, true);
  assert.equal(result.telemetry.usage.total_identity_valid, true);
  assert.equal(result.telemetry.usage.prompt_tokens, 2000000);
  assert.equal(result.telemetry.usage.completion_tokens, 2000000);
  assert.equal(result.telemetry.usage.total_tokens, 4000000);
  assert.equal(result.telemetry.reasoning_tokens, 500000);
  assert.ok(Math.abs(result.telemetry.per_round[0].cost_usd - 0.36512) < 1e-12);
  assert.ok(Math.abs(result.telemetry.per_round[1].cost_usd - 1.13245) < 1e-12);
  assert.ok(Math.abs(result.telemetry.cost_usd - 1.49757) < 1e-12);
  assert.equal(result.telemetry.per_round[1].effort_attribution, 'configured');
  assert.ok(result.telemetry.warnings.some(warning => warning.warning === 'actual_model_mismatch'));

  const unknown = createHarness({
    actions: [providerResponse({ model: 'deepseek-v4-unknown' })]
  });
  const unknownResult = await unknown.controller.runTurn(turnOptions('unknown-model'));
  assert.equal(unknownResult.status, 'completed');
  assert.equal(unknownResult.telemetry.actual_models[0], 'deepseek-v4-unknown');
  assert.equal(unknownResult.telemetry.cost_available, false);
  assert.equal(unknownResult.telemetry.cost_usd, null);
  assert.ok(unknownResult.telemetry.warnings.some(warning => warning.warning === 'unknown_actual_model'));

  const normalized = normalizeUsage(millionUsage);
  assert.equal(normalized.reasoning_tokens, 250000);
  assert.equal(normalized.completion_tokens, 1000000);
  assert.equal(normalized.total_tokens, 2000000);
  assert.ok(Math.abs(calculateRoundCost(MODEL_IDS.flash, millionUsage).cost_usd - 0.36512) < 1e-12);
  assert.ok(Math.abs(calculateRoundCost(MODEL_IDS.pro, millionUsage).cost_usd - 1.13245) < 1e-12);
});

test('V25 regression: additive usage aggregation cannot erase an earlier invalid identity', () => {
  const positiveDiscrepancy = usage({
    prompt_tokens: 100,
    completion_tokens: 10,
    total_tokens: 105,
    prompt_cache_hit_tokens: 40,
    prompt_cache_miss_tokens: 50
  });
  const cancellingDiscrepancy = usage({
    prompt_tokens: 90,
    completion_tokens: 10,
    total_tokens: 105,
    prompt_cache_hit_tokens: 40,
    prompt_cache_miss_tokens: 60
  });
  const validLaterUsage = usage({
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
    prompt_cache_hit_tokens: 4,
    prompt_cache_miss_tokens: 6
  });

  const earlierAggregate = aggregateUsage([positiveDiscrepancy, cancellingDiscrepancy]);
  assert.equal(earlierAggregate.prompt_identity_valid, false);
  assert.equal(earlierAggregate.total_identity_valid, false);

  const laterAggregate = aggregateUsage([earlierAggregate, validLaterUsage]);
  assert.equal(laterAggregate.prompt_identity_valid, false);
  assert.equal(laterAggregate.total_identity_valid, false);
});

test('finish reasons are explicit and incomplete responses never commit an exchange', async () => {
  assert.equal(classifyProviderFinish('stop', { content: 'ok' }).state, 'completed');
  assert.equal(classifyProviderFinish('tool_calls', { content: null, tool_calls: [toolCall('x')] }).state, 'tool_round');
  const cases = [
    ['length', 'incomplete', 'output_length_reached'],
    ['content_filter', 'incomplete', 'content_filtered'],
    ['insufficient_system_resource', 'failed', 'insufficient_system_resource'],
    ['future_reason', 'failed', 'unknown_finish_reason']
  ];
  for (const [finishReason, status, code] of cases) {
    const harness = createHarness({
      actions: [providerResponse({ finishReason, content: `partial-${finishReason}` })]
    });
    const result = await harness.controller.runTurn(turnOptions(finishReason));
    assert.equal(result.status, status);
    assert.equal(result.error.code, code);
    assert.equal(result.partial_content, `partial-${finishReason}`);
    assert.equal(harness.controller.getContractSnapshot().completed_exchange_count, 0);
  }

  const missing = createHarness({
    actions: [providerResponse({ finishReason: 'stop', includeContent: false })]
  });
  const missingResult = await missing.controller.runTurn(turnOptions('missing-content'));
  assert.equal(missingResult.status, 'incomplete');
  assert.equal(missingResult.error.code, 'missing_final_content');
  assert.equal(missing.controller.getContractSnapshot().completed_exchange_count, 0);
});

test('provider envelopes require exactly one assistant choice and an attributable actual model', async () => {
  const malformed = [
    [{ data: { model: MODEL_IDS.flash, choices: [], usage: usage() } }, 'invalid_provider_choices'],
    [{ data: {
      model: MODEL_IDS.flash,
      choices: [
        { finish_reason: 'stop', message: { role: 'assistant', content: 'one' } },
        { finish_reason: 'stop', message: { role: 'assistant', content: 'two' } }
      ],
      usage: usage()
    } }, 'invalid_provider_choices'],
    [{ data: {
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'missing model' } }],
      usage: usage()
    } }, 'missing_actual_model'],
    [{ data: {
      model: MODEL_IDS.flash,
      choices: [{ finish_reason: 'stop', message: { role: 'user', content: 'wrong role' } }],
      usage: usage()
    } }, 'invalid_provider_assistant']
  ];
  for (const [response, expectedCode] of malformed) {
    const harness = createHarness({ actions: [response] });
    const result = await harness.controller.runTurn(turnOptions(expectedCode));
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, expectedCode);
    assert.equal(result.telemetry.retry_count, 0);
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.controller.getContractSnapshot().completed_exchange_count, 0);
  }
});

test('V16/V17: raw reasoning/content is recorded before one linked tool result and replay uses empty content', async () => {
  let providerRoundSeenBeforeDispatch = false;
  const rawToolCall = toolCall('single-1', { turn: 7 });
  const harness = createHarness({
    actions: [
      providerResponse({
        finishReason: 'tool_calls',
        content: null,
        reasoningContent: 'RAW-REASONING-BYTES',
        toolCalls: [rawToolCall]
      }),
      providerResponse({ content: 'final-after-tool', reasoningContent: 'final-reasoning' })
    ],
    dispatchImpl: (call, context) => {
      providerRoundSeenBeforeDispatch = context.events.some(event =>
        event.type === 'provider_round'
        && event.payload.assistant.reasoning_content === 'RAW-REASONING-BYTES'
        && event.payload.assistant.content === null
      );
      return { toolContent: 'EXACT-TOOL-RESULT', outcome: 'executed', gateCode: null };
    }
  });
  const result = await harness.controller.runTurn(turnOptions('single-tool'));
  assert.equal(result.status, 'completed');
  assert.equal(providerRoundSeenBeforeDispatch, true);
  assert.equal(harness.dispatchCalls.length, 1);
  assert.deepEqual(harness.dispatchCalls[0], {
    id: 'single-1',
    name: TOOL_NAME,
    args: { turn: 7 },
    rawArguments: '{"turn":7}'
  });

  const messages = harness.requests[1].body.messages;
  const replayAssistant = messages.find(message => message.role === 'assistant' && message.tool_calls);
  assert.equal(replayAssistant.content, '');
  assert.equal(replayAssistant.reasoning_content, 'RAW-REASONING-BYTES');
  const linked = messages.find(message => message.role === 'tool');
  assert.equal(linked.tool_call_id, 'single-1');
  assert.equal(linked.content, 'EXACT-TOOL-RESULT');

  const rawAssistant = result.exchange.provider_messages.find(message => message.role === 'assistant' && message.tool_calls);
  assert.equal(rawAssistant.content, null);
  assert.equal(rawAssistant.reasoning_content, 'RAW-REASONING-BYTES');
  assert.deepEqual(rawAssistant.tool_calls, [rawToolCall]);

  const absentContent = captureAssistantMessage({
    role: 'assistant',
    reasoning_content: 'absent-content-reasoning',
    tool_calls: [toolCall('absent-content')]
  });
  assert.equal(Object.hasOwn(absentContent.raw, 'content'), false);
  assert.equal(absentContent.replay.content, '');
});

test('V18: multiple calls in one round execute once, sequentially, and preserve returned order', async () => {
  let activeDispatches = 0;
  const order = [];
  const harness = createHarness({
    actions: [
      providerResponse({
        finishReason: 'tool_calls',
        content: 'using two tools',
        toolCalls: [toolCall('multi-1', { turn: 1 }), toolCall('multi-2', { turn: 2 })]
      }),
      providerResponse({ content: 'multi final' })
    ],
    dispatchImpl: async call => {
      activeDispatches++;
      assert.equal(activeDispatches, 1, 'dispatches must not overlap');
      order.push(`start:${call.id}`);
      await Promise.resolve();
      order.push(`end:${call.id}`);
      activeDispatches--;
      return { toolContent: `result:${call.id}`, outcome: 'executed', gateCode: null };
    }
  });
  const result = await harness.controller.runTurn(turnOptions('multi-tool'));
  assert.equal(result.status, 'completed');
  assert.deepEqual(order, ['start:multi-1', 'end:multi-1', 'start:multi-2', 'end:multi-2']);
  assert.deepEqual(harness.dispatchCalls.map(call => call.id), ['multi-1', 'multi-2']);
  const secondBody = harness.requests[1].body.messages;
  assert.equal(secondBody.filter(message => message.role === 'assistant' && message.tool_calls).length, 1);
  assert.deepEqual(
    secondBody.filter(message => message.role === 'tool').map(message => message.tool_call_id),
    ['multi-1', 'multi-2']
  );
});

test('V19: consecutive tool rounds retain every earlier reasoning/call/result chain element', async () => {
  const harness = createHarness({
    actions: [
      providerResponse({
        finishReason: 'tool_calls', content: null, reasoningContent: 'reasoning-one',
        toolCalls: [toolCall('round-1', { turn: 1 })]
      }),
      providerResponse({
        finishReason: 'tool_calls', content: null, reasoningContent: 'reasoning-two',
        toolCalls: [toolCall('round-2', { turn: 2 })]
      }),
      providerResponse({ content: 'consecutive final', reasoningContent: 'reasoning-final' })
    ],
    dispatchImpl: call => ({
      toolContent: `tool-result-${call.id}`,
      outcome: 'executed',
      gateCode: null
    })
  });
  const result = await harness.controller.runTurn(turnOptions('consecutive'));
  assert.equal(result.status, 'completed');
  assert.equal(harness.requests.length, 3);
  assert.deepEqual(harness.dispatchCalls.map(call => call.id), ['round-1', 'round-2']);

  const second = harness.requests[1].body.messages;
  assert.ok(second.some(message => message.reasoning_content === 'reasoning-one'));
  assert.ok(second.some(message => message.tool_call_id === 'round-1' && message.content === 'tool-result-round-1'));
  const third = harness.requests[2].body.messages;
  assert.ok(third.some(message => message.reasoning_content === 'reasoning-one'));
  assert.ok(third.some(message => message.reasoning_content === 'reasoning-two'));
  assert.deepEqual(
    third.filter(message => message.role === 'tool').map(message => message.tool_call_id),
    ['round-1', 'round-2']
  );
  assert.equal(result.exchange.provider_messages.filter(message => message.role === 'assistant').length, 3);
});

test('V20: a reloaded completed tool exchange replays exactly before the next developer message', async () => {
  const first = createHarness({
    actions: [
      providerResponse({
        finishReason: 'tool_calls', content: null, reasoningContent: 'restart-reasoning',
        toolCalls: [toolCall('restart-1')]
      }),
      providerResponse({ content: 'restart-first-final' })
    ],
    dispatchImpl: () => ({ toolContent: 'restart-tool-result', outcome: 'executed', gateCode: null })
  });
  const firstResult = await first.controller.runTurn(turnOptions('restart-first'));
  assert.equal(firstResult.status, 'completed');

  const second = createHarness({ actions: [providerResponse({ content: 'restart-followup-final' })] });
  second.controller._completedExchanges = [clone(firstResult.exchange)];
  const followupOptions = turnOptions('restart-followup');
  const secondResult = await second.controller.runTurn(followupOptions);
  assert.equal(secondResult.status, 'completed');
  const messages = second.requests[0].body.messages;
  const priorAssistantIndex = messages.findIndex(message => message.reasoning_content === 'restart-reasoning');
  const priorToolIndex = messages.findIndex(message => message.tool_call_id === 'restart-1');
  const priorFinalIndex = messages.findIndex(message => message.content === 'restart-first-final');
  const currentUserIndex = messages.findIndex(message => message.content === followupOptions.userMessage.content);
  assert.ok(priorAssistantIndex > 0);
  assert.ok(priorAssistantIndex < priorToolIndex);
  assert.ok(priorToolIndex < priorFinalIndex);
  assert.ok(priorFinalIndex < currentUserIndex);
  assert.equal(messages[priorAssistantIndex].content, '');
  assert.equal(messages[priorAssistantIndex].reasoning_content, 'restart-reasoning');
});

test('V21: v1 migration preserves every complete pair, creates one exact backup, and restores the newest exchange', async t => {
  const fixture = persistenceFixture(t, 'migration');
  const legacy = [
    { role: 'user', content: 'legacy-question-1' },
    { role: 'assistant', content: 'legacy-answer-1' },
    { role: 'user', content: 'legacy-question-2' },
    { role: 'assistant', content: 'legacy-answer-2' }
  ];
  const rawLegacy = JSON.stringify(legacy, null, 2);
  fs.writeFileSync(fixture.paths.historyFile, rawLegacy, 'utf8');

  const loaded = await loadHistoryStore({
    fsAdapter: fixture.fsAdapter,
    historyPath: fixture.paths.historyFile,
    clock: fixture.clock
  });
  assert.equal(loaded.status, 'migrated_v1_to_v2');
  assert.deepEqual(loaded.ledger.map(exchange => [exchange.question, exchange.final_answer]), [
    ['legacy-question-1', 'legacy-answer-1'],
    ['legacy-question-2', 'legacy-answer-2']
  ]);
  assert.deepEqual(loaded.durable_exchange_ids, ['legacy-1', 'legacy-2']);
  assert.equal(loaded.last_exchange.id, 'legacy-2');
  const backupPath = path.join(fixture.directory, HISTORY_V1_BACKUP_BASENAME);
  assert.equal(fs.readFileSync(backupPath, 'utf8'), rawLegacy);
  const backupHash = sha256File(backupPath);

  const migratedFile = JSON.parse(fs.readFileSync(fixture.paths.historyFile, 'utf8'));
  assert.equal(migratedFile.schema_version, HISTORY_SCHEMA_VERSION);
  assert.deepEqual(migratedFile.exchanges, loaded.ledger);
  const secondLoad = await loadHistoryStore({
    fsAdapter: fixture.fsAdapter,
    historyPath: fixture.paths.historyFile,
    clock: fixture.clock
  });
  assert.equal(secondLoad.status, 'loaded_v2');
  assert.equal(sha256File(backupPath), backupHash);
  assert.deepEqual(secondLoad.ledger, loaded.ledger);

  const oddMigration = migrateLegacyHistory([...legacy, { role: 'user', content: 'recoverable-tail' }], {
    clock: fixture.clock,
    createExchangeId: ({ pair_index: pairIndex }) => `odd-${pairIndex + 1}`
  });
  assert.equal(oddMigration.exchanges.length, 2);
});

test('V22: a multi-round multi-call tool exchange survives an exact v2 save/load round trip', async t => {
  const fixture = persistenceFixture(t, 'tool-roundtrip');
  const exchange = {
    id: 'tool-roundtrip',
    question: 'use several tools',
    completed_at: FIXED_TIME,
    request_snapshot: { model: MODEL_IDS.pro, reasoning_effort: REASONING_EFFORTS.max },
    actual_models: [MODEL_IDS.pro, MODEL_IDS.pro, MODEL_IDS.flash],
    provider_messages: [
      { role: 'user', content: '[LIVE ENGINE DATA]\nexact\n\n[DEVELOPER QUESTION]\nuse several tools' },
      {
        role: 'assistant',
        content: null,
        reasoning_content: 'round-one-reasoning',
        tool_calls: [toolCall('roundtrip-a', { turn: 1 }), toolCall('roundtrip-b', { turn: 2 })]
      },
      { role: 'tool', tool_call_id: 'roundtrip-a', content: '{"a":true}' },
      { role: 'tool', tool_call_id: 'roundtrip-b', content: '{"b":true}' },
      {
        role: 'assistant',
        reasoning_content: 'round-two-reasoning',
        tool_calls: [toolCall('roundtrip-c', { turn: 3 })]
      },
      { role: 'tool', tool_call_id: 'roundtrip-c', content: '{"c":true}' },
      { role: 'assistant', content: 'roundtrip-final', reasoning_content: 'round-three-reasoning' }
    ],
    round_summaries: [
      { round: 1, actual_model: MODEL_IDS.pro, tool_call_ids: ['roundtrip-a', 'roundtrip-b'] },
      { round: 2, actual_model: MODEL_IDS.pro, tool_call_ids: ['roundtrip-c'] },
      { round: 3, actual_model: MODEL_IDS.flash, tool_call_ids: [] }
    ],
    final_answer: 'roundtrip-final',
    status: 'completed'
  };

  const saved = await saveHistoryStore({
    fsAdapter: fixture.fsAdapter,
    historyPath: fixture.paths.historyFile,
    exchanges: [exchange],
    clock: fixture.clock
  });
  assert.equal(saved.ok, true);
  const loaded = await loadHistoryStore({
    fsAdapter: fixture.fsAdapter,
    historyPath: fixture.paths.historyFile,
    clock: fixture.clock
  });
  assert.equal(loaded.status, 'loaded_v2');
  assert.deepEqual(loaded.ledger, [exchange]);
  assert.equal(loaded.ledger[0].provider_messages[1].content, null);
  assert.equal(Object.hasOwn(loaded.ledger[0].provider_messages[4], 'content'), false);
});

test('V23/V34: admission uses the complete UTF-8 body, selects whole newest suffixes, and never mutates history', async () => {
  const systemMessages = [{ role: 'system', content: 'boundary-system' }];
  const currentTurnMessages = [{ role: 'user', content: 'boundary-user' }];
  const requestForLength = length => buildContextBudgetedV4Request({
    model: MODEL_IDS.flash,
    reasoningEffort: REASONING_EFFORTS.high,
    systemMessages,
    completedExchanges: [completedExchange('boundary', 'x'.repeat(length))],
    currentTurnMessages,
    tools: TOOLS
  });

  let low = 0;
  let high = MAX_REQUEST_UTF8_BYTES;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (requestForLength(mid).selected_exchanges.length === 1) low = mid;
    else high = mid - 1;
  }
  const justBelow = requestForLength(low);
  const justAbove = requestForLength(low + 1);
  const exactCandidate = length => buildV4RequestBody({
    model: MODEL_IDS.flash,
    reasoningEffort: REASONING_EFFORTS.high,
    messages: [
      ...systemMessages,
      ...flattenProviderReplay([completedExchange('boundary', 'x'.repeat(length))]),
      ...currentTurnMessages
    ],
    tools: TOOLS
  });
  const exactBelowBytes = serializedBodyUtf8Bytes(exactCandidate(low));
  const exactAboveBytes = serializedBodyUtf8Bytes(exactCandidate(low + 1));
  assert.equal(justBelow.selected_exchanges.length, 1);
  assert.ok(exactBelowBytes <= MAX_REQUEST_UTF8_BYTES);
  assert.ok(exactAboveBytes > MAX_REQUEST_UTF8_BYTES);
  assert.equal(exactAboveBytes, exactBelowBytes + 1);
  assert.equal(justAbove.selected_exchanges.length, 0);
  assert.equal(justAbove.excluded_exchanges.length, 1);
  assert.ok(justAbove.body_utf8_bytes <= MAX_REQUEST_UTF8_BYTES);

  const ledger = [completedExchange('older', 'O'.repeat(800000)), completedExchange('newest', 'newest-answer')];
  const before = JSON.stringify(ledger);
  const suffix = buildContextBudgetedV4Request({
    model: MODEL_IDS.flash,
    reasoningEffort: REASONING_EFFORTS.high,
    systemMessages,
    completedExchanges: ledger,
    currentTurnMessages,
    tools: TOOLS
  });
  assert.deepEqual(suffix.selected_exchanges.map(exchange => exchange.id), ['newest']);
  assert.deepEqual(suffix.excluded_exchanges.map(exchange => exchange.id), ['older']);
  assert.equal(JSON.stringify(ledger), before);

  const multibyte = '🧠'.repeat(180000);
  const preflight = buildContextBudgetedV4Request({
    model: MODEL_IDS.flash,
    reasoningEffort: REASONING_EFFORTS.high,
    systemMessages,
    completedExchanges: [],
    currentTurnMessages: [{ role: 'user', content: multibyte }],
    tools: TOOLS
  });
  assert.equal(preflight.fits, false);
  assert.ok(preflight.body_utf8_bytes > MAX_REQUEST_UTF8_BYTES);
  assert.ok(displayTokenEstimate(preflight.body) < MAX_REQUEST_UTF8_BYTES);
  assert.equal(serializedBodyUtf8Bytes(preflight.body), preflight.body_utf8_bytes);

  const noTransport = createHarness({ actions: [] });
  const result = await noTransport.controller.runTurn({
    question: 'multibyte preflight',
    systemMessages,
    userMessage: { role: 'user', content: multibyte }
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'context_too_large_preflight');
  assert.equal(noTransport.requests.length, 0);
  assert.equal(result.telemetry.rounds, 0);
  assert.equal(result.telemetry.attempts, 0);
  assert.equal(noTransport.controller.getContractSnapshot().completed_exchange_count, 0);
});

test('V24: corrupt and over-ceiling history files are quarantined intact before replacement is possible', async t => {
  const corruptFixture = persistenceFixture(t, 'corrupt');
  const corruptRaw = '{ definitely not json';
  fs.writeFileSync(corruptFixture.paths.historyFile, corruptRaw, 'utf8');
  const corrupt = await loadHistoryStore({
    fsAdapter: corruptFixture.fsAdapter,
    historyPath: corruptFixture.paths.historyFile,
    clock: corruptFixture.clock
  });
  assert.equal(corrupt.status, 'corrupt_quarantined');
  assert.equal(fs.existsSync(corruptFixture.paths.historyFile), false);
  assert.equal(fs.readFileSync(corrupt.quarantine_path, 'utf8'), corruptRaw);
  assert.equal(corrupt.warnings[0].code, 'history_corrupt_quarantined');

  const oversizeFixture = persistenceFixture(t, 'oversize');
  const oversizeRaw = 'x'.repeat(257);
  fs.writeFileSync(oversizeFixture.paths.historyFile, oversizeRaw, 'utf8');
  const oversize = await loadHistoryStore({
    fsAdapter: oversizeFixture.fsAdapter,
    historyPath: oversizeFixture.paths.historyFile,
    clock: oversizeFixture.clock,
    maxFileBytes: 256
  });
  assert.equal(oversize.status, 'oversize_quarantined');
  assert.equal(fs.existsSync(oversizeFixture.paths.historyFile), false);
  assert.equal(fs.readFileSync(oversize.quarantine_path, 'utf8'), oversizeRaw);
  assert.equal(oversize.warnings[0].code, 'history_oversize_quarantined');
});

test('V24: bounded atomic saves preserve the live ledger and prior file across eviction, oversize, and rename failure', async t => {
  const fixture = persistenceFixture(t, 'atomic');
  const ledger = Array.from({ length: 6 }, (_, index) => completedExchange(`durable-${index + 1}`));
  const ledgerBefore = JSON.stringify(ledger);
  const countBounded = await saveHistoryStore({
    fsAdapter: fixture.fsAdapter,
    historyPath: fixture.paths.historyFile,
    exchanges: ledger,
    clock: fixture.clock
  });
  assert.equal(countBounded.ok, true);
  assert.equal(countBounded.count_evicted, 1);
  assert.deepEqual(countBounded.selected_exchange_ids, [
    'durable-2', 'durable-3', 'durable-4', 'durable-5', 'durable-6'
  ]);
  assert.equal(JSON.stringify(ledger), ledgerBefore);

  const newestThree = buildDurableHistorySnapshot({
    exchanges: ledger.slice(-3),
    clock: fixture.clock,
    maxFileBytes: 100000
  });
  const sizeBounded = await saveHistoryStore({
    fsAdapter: fixture.fsAdapter,
    historyPath: fixture.paths.historyFile,
    exchanges: ledger,
    clock: fixture.clock,
    maxFileBytes: newestThree.body_utf8_bytes
  });
  assert.equal(sizeBounded.ok, true);
  assert.deepEqual(sizeBounded.selected_exchange_ids, ['durable-4', 'durable-5', 'durable-6']);
  assert.equal(sizeBounded.warning.code, 'history_size_eviction');
  assert.equal(sizeBounded.size_evicted, 2);
  assert.ok(fs.statSync(fixture.paths.historyFile).size <= newestThree.body_utf8_bytes);
  assert.equal(JSON.stringify(ledger), ledgerBefore);
  const sizeLimitedRestart = await loadHistoryStore({
    fsAdapter: fixture.fsAdapter,
    historyPath: fixture.paths.historyFile,
    clock: fixture.clock,
    maxFileBytes: newestThree.body_utf8_bytes
  });
  assert.deepEqual(sizeLimitedRestart.ledger.map(exchange => exchange.id), [
    'durable-4', 'durable-5', 'durable-6'
  ]);

  const previousHash = sha256File(fixture.paths.historyFile);
  const failingAdapter = Object.create(fs.promises);
  failingAdapter.rename = async () => {
    const error = new Error('injected rename failure');
    error.code = 'EACCES';
    throw error;
  };
  const failed = await saveHistoryStore({
    fsAdapter: failingAdapter,
    historyPath: fixture.paths.historyFile,
    exchanges: [...ledger, completedExchange('durable-7')],
    clock: fixture.clock
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.status, 'save_failed');
  assert.equal(failed.warning.code, 'history_save_failed');
  assert.equal(sha256File(fixture.paths.historyFile), previousHash);
  assert.equal(fs.readdirSync(fixture.directory).some(name => name.includes('.tmp.')), false);

  const small = completedExchange('small-after-oversize');
  const smallSnapshot = buildDurableHistorySnapshot({
    exchanges: [small],
    clock: fixture.clock,
    maxFileBytes: 100000
  });
  const giant = completedExchange('giant-memory-only', 'G'.repeat(smallSnapshot.body_utf8_bytes));
  const mixedLedger = [giant];
  const mixedBefore = JSON.stringify(mixedLedger);
  const memoryOnly = await saveHistoryStore({
    fsAdapter: fixture.fsAdapter,
    historyPath: fixture.paths.historyFile,
    exchanges: mixedLedger,
    clock: fixture.clock,
    maxFileBytes: smallSnapshot.body_utf8_bytes
  });
  assert.equal(memoryOnly.ok, false);
  assert.equal(memoryOnly.status, 'memory_only_oversize');
  assert.equal(memoryOnly.warning.code, 'history_memory_only_oversize');
  assert.equal(sha256File(fixture.paths.historyFile), previousHash);
  assert.equal(JSON.stringify(mixedLedger), mixedBefore);

  mixedLedger.push(small);
  const laterSave = await saveHistoryStore({
    fsAdapter: fixture.fsAdapter,
    historyPath: fixture.paths.historyFile,
    exchanges: mixedLedger,
    clock: fixture.clock,
    maxFileBytes: smallSnapshot.body_utf8_bytes
  });
  assert.equal(laterSave.ok, true);
  assert.deepEqual(laterSave.selected_exchange_ids, ['small-after-oversize']);
  assert.deepEqual(JSON.parse(fs.readFileSync(fixture.paths.historyFile, 'utf8')).exchanges.map(exchange => exchange.id), [
    'small-after-oversize'
  ]);
  assert.deepEqual(mixedLedger.map(exchange => exchange.id), ['giant-memory-only', 'small-after-oversize']);
});

test('V24: controller persistence failure is visibly degraded without losing the completed live exchange', async t => {
  const fixture = persistenceFixture(t, 'degraded');
  const failingAdapter = Object.create(fs.promises);
  failingAdapter.rename = async () => {
    const error = new Error('injected controller rename failure');
    error.code = 'EACCES';
    throw error;
  };
  const harness = createHarness({
    actions: [providerResponse({ content: 'memory-only-answer' })],
    fsAdapter: failingAdapter,
    paths: fixture.paths,
    clock: fixture.clock
  });
  await harness.controller.loadPersistentState();
  const result = await harness.controller.runTurn(turnOptions('memory-only')); 
  assert.equal(result.status, 'completed');
  assert.equal(harness.controller.getCompletedExchangeLedger().length, 1);
  assert.equal(harness.controller.getLastCompletedExchange().final_answer, 'memory-only-answer');
  assert.ok(result.telemetry.warnings.some(warning => warning.code === 'history_save_failed'));
  const snapshot = harness.controller.getContractSnapshot();
  assert.equal(snapshot.persistence.history.status, 'save_failed');
  assert.equal(snapshot.persistence.history.degraded, true);
  assert.equal(snapshot.persistence.history.live_exchange_count, 1);
  assert.deepEqual(snapshot.persistence.history.durable_exchange_ids, []);
  assert.equal(fs.existsSync(fixture.paths.historyFile), false);
  assert.ok(harness.events.some(event =>
    event.type === 'persistence_warning' && event.payload.code === 'history_save_failed'
  ));
});

test('V32/V33: settings use exact schema v1, survive restart, default safely, and preserve the prior file on failure', async t => {
  const fixture = persistenceFixture(t, 'settings');
  const first = createHarness({ fsAdapter: fixture.fsAdapter, paths: fixture.paths, clock: fixture.clock });
  const initial = await first.controller.loadPersistentState();
  assert.deepEqual(initial.configured_settings, {
    schema_version: 1,
    model: MODEL_IDS.flash,
    reasoning_effort: REASONING_EFFORTS.high
  });
  assert.equal(initial.persistence.settings.status, 'missing_defaulted');

  const saved = await first.controller.setConfiguredSettings({
    model: MODEL_IDS.pro,
    reasoningEffort: REASONING_EFFORTS.max
  });
  assert.equal(saved.ok, true);
  const exactFile = JSON.parse(fs.readFileSync(fixture.paths.settingsFile, 'utf8'));
  assert.deepEqual(exactFile, {
    schema_version: 1,
    model: MODEL_IDS.pro,
    reasoning_effort: REASONING_EFFORTS.max,
    saved_at: FIXED_TIME
  });

  const restarted = createHarness({ fsAdapter: fixture.fsAdapter, paths: fixture.paths, clock: fixture.clock });
  const restored = await restarted.controller.loadPersistentState();
  assert.equal(restored.configured_settings.model, MODEL_IDS.pro);
  assert.equal(restored.configured_settings.reasoning_effort, REASONING_EFFORTS.max);

  for (const invalid of [
    { model: MODEL_IDS.pro, reasoning_effort: REASONING_EFFORTS.max, saved_at: FIXED_TIME },
    { schema_version: 2, model: MODEL_IDS.pro, reasoning_effort: REASONING_EFFORTS.max, saved_at: FIXED_TIME },
    { schema_version: 1, model: 'unknown', reasoning_effort: REASONING_EFFORTS.max, saved_at: FIXED_TIME }
  ]) {
    fs.writeFileSync(fixture.paths.settingsFile, JSON.stringify(invalid), 'utf8');
    const fallback = await loadSettingsStore({
      fsAdapter: fixture.fsAdapter,
      settingsPath: fixture.paths.settingsFile
    });
    assert.equal(fallback.status, 'invalid_defaulted');
    assert.equal(fallback.settings.model, MODEL_IDS.flash);
    assert.equal(fallback.settings.reasoning_effort, REASONING_EFFORTS.high);
    assert.equal(fallback.warnings[0].code, 'settings_invalid_defaulted');
  }
  fs.writeFileSync(fixture.paths.settingsFile, '{bad', 'utf8');
  const corrupt = await loadSettingsStore({ fsAdapter: fixture.fsAdapter, settingsPath: fixture.paths.settingsFile });
  assert.equal(corrupt.status, 'invalid_defaulted');
  assert.equal(corrupt.warnings[0].code, 'settings_invalid_defaulted');

  await saveSettingsStore({
    fsAdapter: fixture.fsAdapter,
    settingsPath: fixture.paths.settingsFile,
    model: MODEL_IDS.pro,
    reasoningEffort: REASONING_EFFORTS.max,
    clock: fixture.clock
  });
  const previousHash = sha256File(fixture.paths.settingsFile);
  const failingAdapter = Object.create(fs.promises);
  failingAdapter.rename = async () => {
    const error = new Error('injected settings rename failure');
    error.code = 'EACCES';
    throw error;
  };
  const failed = await saveSettingsStore({
    fsAdapter: failingAdapter,
    settingsPath: fixture.paths.settingsFile,
    model: MODEL_IDS.flash,
    reasoningEffort: REASONING_EFFORTS.high,
    clock: fixture.clock
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.warnings[0].code, 'settings_save_failed');
  assert.equal(sha256File(fixture.paths.settingsFile), previousHash);
});

test('V35/V36: the live ledger keeps all exchanges while restart restores only the newest five and the last copy source', async t => {
  const fixture = persistenceFixture(t, 'ledger');
  const actions = Array.from({ length: 9 }, (_, index) => providerResponse({
    content: `durable-answer-${index + 1}`,
    reasoningContent: `durable-reasoning-${index + 1}`
  }));
  const live = createHarness({
    actions,
    fsAdapter: fixture.fsAdapter,
    paths: fixture.paths,
    clock: fixture.clock
  });
  await live.controller.loadPersistentState();
  for (let index = 1; index <= 8; index++) {
    const result = await live.controller.runTurn(turnOptions(`durable-${index}`));
    assert.equal(result.status, 'completed');
  }
  const beforeNinth = live.controller.getContractSnapshot();
  assert.equal(beforeNinth.completed_exchange_count, 8);
  assert.deepEqual(beforeNinth.completed_exchange_ids, [
    'runtime-1', 'runtime-2', 'runtime-3', 'runtime-4',
    'runtime-5', 'runtime-6', 'runtime-7', 'runtime-8'
  ]);
  const persistedAfterEight = JSON.parse(fs.readFileSync(fixture.paths.historyFile, 'utf8'));
  assert.deepEqual(persistedAfterEight.exchanges.map(exchange => exchange.id), [
    'runtime-4', 'runtime-5', 'runtime-6', 'runtime-7', 'runtime-8'
  ]);
  assert.equal(persistedAfterEight.exchanges.length, DURABLE_HISTORY_EXCHANGE_LIMIT);

  const liveBeforeSelection = live.controller.getCompletedExchangeLedger();
  const durableHashBeforeSelection = sha256File(fixture.paths.historyFile);
  const selectionSystem = [{ role: 'system', content: 'selection-system' }];
  const selectionCurrent = [{ role: 'user', content: 'selection-current' }];
  const newestOnly = buildContextBudgetedV4Request({
    model: MODEL_IDS.flash,
    reasoningEffort: REASONING_EFFORTS.high,
    systemMessages: selectionSystem,
    completedExchanges: liveBeforeSelection.slice(-1),
    currentTurnMessages: selectionCurrent,
    tools: TOOLS
  });
  const prunedRequest = buildContextBudgetedV4Request({
    model: MODEL_IDS.flash,
    reasoningEffort: REASONING_EFFORTS.high,
    systemMessages: selectionSystem,
    completedExchanges: liveBeforeSelection,
    currentTurnMessages: selectionCurrent,
    tools: TOOLS,
    maxUtf8Bytes: newestOnly.body_utf8_bytes
  });
  assert.deepEqual(prunedRequest.selected_exchanges.map(exchange => exchange.id), ['runtime-8']);
  assert.equal(prunedRequest.excluded_exchanges.length, 7);
  assert.deepEqual(live.controller.getCompletedExchangeLedger(), liveBeforeSelection);
  assert.equal(sha256File(fixture.paths.historyFile), durableHashBeforeSelection);

  const result = await live.controller.runTurn(turnOptions('durable-9'));
  assert.equal(result.status, 'completed');
  const ninthMessages = live.requests[8].body.messages;
  for (let index = 1; index <= 8; index++) {
    assert.ok(ninthMessages.some(message => message.content === `question-durable-${index}`));
    assert.ok(ninthMessages.some(message => message.content === `durable-answer-${index}`));
  }
  const afterNinth = live.controller.getContractSnapshot();
  assert.equal(afterNinth.completed_exchange_count, 9);
  assert.equal(afterNinth.persistence.history.live_exchange_count, 9);
  assert.deepEqual(afterNinth.persistence.history.durable_exchange_ids, [
    'runtime-5', 'runtime-6', 'runtime-7', 'runtime-8', 'runtime-9'
  ]);

  const restarted = createHarness({
    fsAdapter: fixture.fsAdapter,
    paths: fixture.paths,
    clock: fixture.clock
  });
  const restartSnapshot = await restarted.controller.loadPersistentState();
  assert.deepEqual(restartSnapshot.completed_exchange_ids, [
    'runtime-5', 'runtime-6', 'runtime-7', 'runtime-8', 'runtime-9'
  ]);
  assert.equal(restartSnapshot.completed_exchange_count, DURABLE_HISTORY_EXCHANGE_LIMIT);
  const last = restarted.controller.getLastCompletedExchange();
  assert.equal(last.id, 'runtime-9');
  assert.equal(last.question, 'question-durable-9');
  assert.equal(last.final_answer, 'durable-answer-9');
});

test('V72 history-resource: three selected-cap parse and atomic rewrite cycles stay whole, bounded, and within thresholds', {
  skip: typeof global.gc !== 'function'
}, async t => {
  const fixture = persistenceFixture(t, 'v72');
  const requestedCap = Number(process.env.MB_V72_HISTORY_CAP_BYTES ?? MAX_HISTORY_FILE_BYTES);
  const evidencePhase = process.env.MB_V72_PHASE ?? 'step6';
  const allowedCaps = [32 * 1024 * 1024, 16 * 1024 * 1024];
  const evidence = {
    schema_version: 1,
    kind: `mother_brain_${evidencePhase}_v72_history_resource`,
    phase: evidencePhase,
    started_at: new Date().toISOString(),
    completed_at: null,
    status: 'running',
    candidate_max_history_file_bytes: requestedCap,
    production_initial_max_history_file_bytes: MAX_HISTORY_FILE_BYTES,
    thresholds: {
      cycle_wall_ms: 2000,
      heap_formula: 'baseline + 2 * file_bytes + 16 MiB',
      cycle_count: 3
    },
    baseline_heap_bytes: null,
    active_exchange_ids: [],
    active_ledger_sha256_before: null,
    active_ledger_sha256_after: null,
    initial_file_bytes: null,
    cycles: [],
    final_file_bytes: null,
    final_file_sha256: null,
    final_exchange_ids: [],
    operation_error: null
  };

  try {
    if (!allowedCaps.includes(requestedCap)) throw new Error('V72 candidate cap must be exactly 32 MiB or 16 MiB.');
    if (!['step6', 'step13'].includes(evidencePhase)) throw new Error('V72 evidence phase must be step6 or step13.');
    const resourceExchange = (index, payload) => completedExchange(
      `resource-${index}`,
      `resource-answer-${index}:${payload}`,
      `resource-question-${index}`
    );
    const emptyLedger = Array.from({ length: DURABLE_HISTORY_EXCHANGE_LIMIT }, (_, index) =>
      resourceExchange(index + 1, '')
    );
    const emptySnapshot = buildDurableHistorySnapshot({
      exchanges: emptyLedger,
      clock: fixture.clock,
      maxFileBytes: requestedCap,
      copySelections: false
    });
    const targetBytes = requestedCap - (64 * 1024);
    const payloadLength = Math.floor((targetBytes - emptySnapshot.body_utf8_bytes) / (DURABLE_HISTORY_EXCHANGE_LIMIT * 2));
    if (payloadLength <= 0) throw new Error('V72 payload calculation did not produce a positive fixture size.');
    let payload = 'R'.repeat(payloadLength);
    const activeLedger = Array.from({ length: DURABLE_HISTORY_EXCHANGE_LIMIT }, (_, index) =>
      resourceExchange(index + 1, payload)
    );
    payload = null;
    evidence.active_exchange_ids = activeLedger.map(exchange => exchange.id);
    evidence.active_ledger_sha256_before = sha256Json(activeLedger);

    let initialSave = await saveHistoryStore({
      fsAdapter: fixture.fsAdapter,
      historyPath: fixture.paths.historyFile,
      exchanges: activeLedger,
      clock: fixture.clock,
      maxFileBytes: requestedCap
    });
    if (!initialSave.ok) throw new Error(`V72 initial save failed: ${initialSave.status}`);
    if (initialSave.selected_exchange_ids.length !== DURABLE_HISTORY_EXCHANGE_LIMIT) {
      throw new Error('V72 initial save did not retain all five whole exchanges.');
    }
    evidence.initial_file_bytes = fs.statSync(fixture.paths.historyFile).size;
    if (evidence.initial_file_bytes > requestedCap) throw new Error('V72 initial file exceeded the candidate cap.');
    if (evidence.initial_file_bytes < requestedCap - (128 * 1024)) {
      throw new Error('V72 fixture was not close enough to the candidate cap.');
    }
    initialSave = null;
    global.gc();
    global.gc();
    evidence.baseline_heap_bytes = process.memoryUsage().heapUsed;

    for (let cycle = 1; cycle <= 3; cycle++) {
      const started = process.hrtime.bigint();
      let loaded = await loadHistoryStore({
        fsAdapter: fixture.fsAdapter,
        historyPath: fixture.paths.historyFile,
        clock: fixture.clock,
        maxFileBytes: requestedCap
      });
      const loadedIds = loaded.ledger.map(exchange => exchange.id);
      let saved = await saveHistoryStore({
        fsAdapter: fixture.fsAdapter,
        historyPath: fixture.paths.historyFile,
        exchanges: loaded.ledger,
        clock: fixture.clock,
        maxFileBytes: requestedCap
      });
      const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
      const fileBytes = fs.statSync(fixture.paths.historyFile).size;
      const fileSha256 = sha256File(fixture.paths.historyFile);
      const idsMatch = JSON.stringify(loadedIds) === JSON.stringify(evidence.active_exchange_ids);
      const saveWhole = saved.ok
        && JSON.stringify(saved.selected_exchange_ids) === JSON.stringify(evidence.active_exchange_ids);
      loaded = null;
      saved = null;
      global.gc();
      global.gc();
      const postGcHeapBytes = process.memoryUsage().heapUsed;
      const heapLimitBytes = evidence.baseline_heap_bytes + (2 * fileBytes) + (16 * 1024 * 1024);
      evidence.cycles.push({
        cycle,
        wall_ms: wallMs,
        post_gc_heap_bytes: postGcHeapBytes,
        heap_limit_bytes: heapLimitBytes,
        file_bytes: fileBytes,
        file_sha256: fileSha256,
        active_exchange_ids: evidence.active_exchange_ids,
        persisted_exchange_ids: loadedIds,
        ids_match: idsMatch,
        save_whole: saveWhole,
        wall_pass: wallMs <= 2000,
        heap_pass: postGcHeapBytes <= heapLimitBytes,
        byte_cap_pass: fileBytes <= requestedCap
      });
    }

    let finalDocument = JSON.parse(fs.readFileSync(fixture.paths.historyFile, 'utf8'));
    evidence.final_exchange_ids = finalDocument.exchanges.map(exchange => exchange.id);
    finalDocument = null;
    evidence.final_file_bytes = fs.statSync(fixture.paths.historyFile).size;
    evidence.final_file_sha256 = sha256File(fixture.paths.historyFile);
    evidence.active_ledger_sha256_after = sha256Json(activeLedger);
  } catch (error) {
    evidence.operation_error = {
      name: error.name,
      code: error.code ?? null,
      message: error.message
    };
  }

  const cyclesPass = evidence.cycles.length === 3 && evidence.cycles.every(cycle =>
    cycle.ids_match && cycle.save_whole && cycle.wall_pass && cycle.heap_pass && cycle.byte_cap_pass
  );
  const liveLedgerPass = evidence.active_ledger_sha256_before !== null
    && evidence.active_ledger_sha256_before === evidence.active_ledger_sha256_after;
  const finalIdsPass = JSON.stringify(evidence.final_exchange_ids) === JSON.stringify(evidence.active_exchange_ids);
  evidence.status = evidence.operation_error === null && cyclesPass && liveLedgerPass && finalIdsPass
    ? 'passed'
    : 'failed';
  evidence.completed_at = new Date().toISOString();

  const logsDirectory = path.join(REPO, 'logs');
  fs.mkdirSync(logsDirectory, { recursive: true });
  const evidenceTimestamp = evidence.completed_at.replace(/[-:.]/g, '');
  const capLabel = `${requestedCap / (1024 * 1024)}m`;
  const evidencePath = path.join(logsDirectory, `mb-v72-history-${evidencePhase}-${capLabel}-${evidenceTimestamp}.json`);
  const evidenceTempPath = `${evidencePath}.tmp`;
  fs.writeFileSync(evidenceTempPath, JSON.stringify(evidence, null, 2), 'utf8');
  fs.renameSync(evidenceTempPath, evidencePath);
  console.log(`V72_EVIDENCE_FILE=${evidencePath}`);
  assert.equal(evidence.status, 'passed', `V72 history-resource failure; inspect ${evidencePath}`);
});

test('V31: only transient failures retry once with the correct bounded delay and unchanged body', async () => {
  const cases = [
    [providerError({ code: 'ECONNRESET' }), 1000],
    [providerError({ code: 'ETIMEDOUT' }), 1000],
    [providerError({ code: 'ECONNREFUSED' }), 1000],
    [providerError({ status: 429, headers: { 'Retry-After': '45' } }), 30000],
    [providerError({ status: 429, headers: { 'Retry-After': 'Thu, 16 Jul 2026 12:00:20 GMT' } }), 20000],
    [providerError({ status: 500 }), 1000],
    [providerError({ status: 503 }), 1000]
  ];
  for (const [failure, expectedDelay] of cases) {
    const harness = createHarness({ actions: [failure, providerResponse()] });
    const result = await harness.controller.runTurn(turnOptions(`retry-${expectedDelay}`));
    assert.equal(result.status, 'completed');
    assert.equal(harness.requests.length, 2);
    assert.deepEqual(harness.requests[0].body, harness.requests[1].body);
    assert.deepEqual(harness.delays, [expectedDelay]);
    assert.equal(result.telemetry.retry_count, 1);
    assert.equal(result.telemetry.attempts, 2);
    assert.equal(result.telemetry.fallback, 'none');
  }

  for (const status of [400, 401, 402, 422]) {
    const failure = providerError({ status, code: 'ECONNRESET' });
    failure.response.data.error.message = 'context length words are not an explicit classifier';
    const harness = createHarness({ actions: [failure] });
    const result = await harness.controller.runTurn(turnOptions(`terminal-${status}`));
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, `provider_http_${status}`);
    assert.equal(harness.requests.length, 1);
    assert.deepEqual(harness.delays, []);
    assert.equal(result.telemetry.retry_count, 0);
  }
});

test('V31: the DeepSeek context classifier accepts only the exact observed explicit shape', () => {
  const fixture = {
    response: {
      status: 400,
      data: {
        error: {
          message: "This model's maximum context length is 1048565 tokens. However, you requested 4186979 tokens (4186978 in the messages, 1 in the completion). Please reduce the length of the messages or completion.",
          type: 'invalid_request_error',
          param: null,
          code: 'invalid_request_error'
        }
      }
    }
  };
  assert.equal(isObservedDeepSeekContextLengthError(fixture), true);

  const wrongStatus = clone(fixture);
  wrongStatus.response.status = 422;
  assert.equal(isObservedDeepSeekContextLengthError(wrongStatus), false);

  const genericMessage = clone(fixture);
  genericMessage.response.data.error.message = 'context length exceeded';
  assert.equal(isObservedDeepSeekContextLengthError(genericMessage), false);

  const inconsistentCounts = clone(fixture);
  inconsistentCounts.response.data.error.message =
    "This model's maximum context length is 1048565 tokens. However, you requested 4186979 tokens (4186977 in the messages, 1 in the completion). Please reduce the length of the messages or completion.";
  assert.equal(isObservedDeepSeekContextLengthError(inconsistentCounts), false);

  const alteredShape = clone(fixture);
  alteredShape.response.data.error.request_id = 'extra';
  assert.equal(isObservedDeepSeekContextLengthError(alteredShape), false);
});

test('V31 telemetry regression: attempts without a provider response report usage and cost unavailable', async () => {
  const harness = createHarness({
    actions: [
      providerError({ code: 'ECONNRESET' }),
      providerError({ code: 'ECONNRESET' })
    ]
  });
  const result = await harness.controller.runTurn(turnOptions('no-provider-response'));
  assert.equal(result.status, 'failed');
  assert.equal(result.telemetry.attempts, 2);
  assert.equal(result.telemetry.response_rounds, 0);
  assert.deepEqual(result.telemetry.usage, {
    prompt_tokens: null,
    completion_tokens: null,
    total_tokens: null,
    prompt_cache_hit_tokens: null,
    prompt_cache_miss_tokens: null,
    reasoning_tokens: null,
    prompt_identity_valid: null,
    total_identity_valid: null
  });
  assert.equal(result.telemetry.cost_available, false);
  assert.equal(result.telemetry.cost_usd, null);
});

test('active turn settings are immutable and a second developer turn is rejected while busy', async () => {
  let resolveResponse;
  const harness = createHarness({
    model: MODEL_IDS.flash,
    effort: REASONING_EFFORTS.high,
    actions: [() => new Promise(resolve => { resolveResponse = resolve; })]
  });
  const pending = harness.controller.runTurn(turnOptions('busy-first'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof resolveResponse, 'function');

  harness.controller._configuredSettings = {
    schema_version: 1,
    model: MODEL_IDS.pro,
    reasoning_effort: REASONING_EFFORTS.max
  };
  await assert.rejects(
    harness.controller.runTurn(turnOptions('busy-second')),
    error => error?.code === 'controller_busy'
  );
  resolveResponse(providerResponse({ model: MODEL_IDS.flash }));
  const result = await pending;
  assert.equal(result.status, 'completed');
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.requests[0].body.model, MODEL_IDS.flash);
  assert.equal(harness.requests[0].body.reasoning_effort, REASONING_EFFORTS.high);
  assert.equal(result.telemetry.configured_model, MODEL_IDS.flash);
  assert.equal(result.telemetry.configured_reasoning_effort, REASONING_EFFORTS.high);
});

test('a transient retry after an earlier tool round does not execute that tool again', async () => {
  const harness = createHarness({
    actions: [
      providerResponse({
        finishReason: 'tool_calls',
        content: null,
        reasoningContent: 'retry-chain-reasoning',
        toolCalls: [toolCall('retry-chain-tool')]
      }),
      providerError({ code: 'ECONNRESET' }),
      providerResponse({ content: 'retry-chain-final' })
    ],
    dispatchImpl: () => ({ toolContent: 'retry-chain-result', outcome: 'executed', gateCode: null })
  });
  const result = await harness.controller.runTurn(turnOptions('retry-chain'));
  assert.equal(result.status, 'completed');
  assert.equal(harness.dispatchCalls.length, 1);
  assert.equal(harness.requests.length, 3);
  assert.deepEqual(harness.requests[1].body, harness.requests[2].body);
  assert.deepEqual(harness.delays, [1000]);
  assert.equal(result.telemetry.retry_count, 1);
});

test('V31: explicit context recovery drops all prior exchanges, preserves the exact active chain, and never reruns tools', async () => {
  const contextError = providerError({ status: 422, contextFixture: true });
  const harness = createHarness({
    actions: [
      providerResponse({
        finishReason: 'tool_calls',
        content: null,
        reasoningContent: 'ACTIVE-ROUND-REASONING',
        toolCalls: [toolCall('context-tool')]
      }),
      contextError,
      providerResponse({ content: 'context recovered final' })
    ],
    contextClassifier: error => error.contextFixture === true,
    dispatchImpl: () => ({ toolContent: 'ACTIVE-TOOL-RESULT', outcome: 'executed', gateCode: null })
  });
  harness.controller._completedExchanges = [completedExchange('prior', 'PRIOR-ANSWER', 'PRIOR-QUESTION')];
  const options = turnOptions('context-recovery');
  const result = await harness.controller.runTurn(options);
  assert.equal(result.status, 'completed');
  assert.equal(harness.requests.length, 3);
  assert.equal(harness.dispatchCalls.length, 1);
  assert.deepEqual(harness.delays, []);
  assert.equal(result.telemetry.retry_count, 1);
  assert.equal(result.telemetry.per_round[1].context_recovery, true);
  assert.equal(result.telemetry.replay.included_exchange_count, 0);
  assert.equal(result.telemetry.replay.excluded_exchange_count, 1);
  assert.deepEqual(result.telemetry.replay.excluded_exchange_ids, ['prior']);

  const rejectedMessages = harness.requests[1].body.messages;
  const recoveredMessages = harness.requests[2].body.messages;
  assert.ok(rejectedMessages.some(message => message.content === 'PRIOR-ANSWER'));
  assert.equal(recoveredMessages.some(message => message.content === 'PRIOR-ANSWER'), false);
  const rejectedCurrent = rejectedMessages.slice(rejectedMessages.findIndex(message => message.content === options.userMessage.content));
  const recoveredCurrent = recoveredMessages.slice(recoveredMessages.findIndex(message => message.content === options.userMessage.content));
  assert.deepEqual(recoveredCurrent, rejectedCurrent);
  assert.ok(recoveredCurrent.some(message => message.reasoning_content === 'ACTIVE-ROUND-REASONING'));
  assert.ok(recoveredCurrent.some(message => message.content === 'ACTIVE-TOOL-RESULT'));

  const noHistoryError = providerError({ status: 400, contextFixture: true });
  const noHistory = createHarness({
    actions: [noHistoryError],
    contextClassifier: error => error.contextFixture === true
  });
  const noHistoryResult = await noHistory.controller.runTurn(turnOptions('context-no-history'));
  assert.equal(noHistoryResult.status, 'failed');
  assert.equal(noHistoryResult.error.code, 'provider_context_rejected');
  assert.equal(noHistory.requests.length, 1);
  assert.equal(noHistoryResult.telemetry.retry_count, 0);

  const rejectedAgain = createHarness({
    actions: [
      providerError({ status: 422, contextFixture: true }),
      providerError({ status: 422, contextFixture: true })
    ],
    contextClassifier: error => error.contextFixture === true
  });
  rejectedAgain.controller._completedExchanges = [completedExchange('still-live')];
  const before = JSON.stringify(rejectedAgain.controller._completedExchanges);
  const rejectedAgainResult = await rejectedAgain.controller.runTurn(turnOptions('context-rejected-again'));
  assert.equal(rejectedAgainResult.status, 'failed');
  assert.equal(rejectedAgainResult.error.code, 'provider_context_rejected');
  assert.equal(rejectedAgain.requests.length, 2);
  assert.equal(rejectedAgainResult.telemetry.retry_count, 1);
  assert.equal(JSON.stringify(rejectedAgain.controller._completedExchanges), before);
});

test('V31 regression: context recovery keeps prior exchanges excluded through later tool rounds', async () => {
  const harness = createHarness({
    actions: [
      providerError({ status: 422, contextFixture: true }),
      providerResponse({
        finishReason: 'tool_calls',
        content: null,
        reasoningContent: 'RECOVERY-TOOL-REASONING',
        toolCalls: [toolCall('recovery-tool-round')]
      }),
      providerResponse({ content: 'recovery-after-tool-final' })
    ],
    contextClassifier: error => error.contextFixture === true,
    dispatchImpl: () => ({ toolContent: 'RECOVERY-TOOL-RESULT', outcome: 'executed', gateCode: null })
  });
  harness.controller._completedExchanges = [
    completedExchange('recovery-prior', 'RECOVERY-PRIOR-ANSWER', 'RECOVERY-PRIOR-QUESTION')
  ];
  const result = await harness.controller.runTurn(turnOptions('recovery-tool-followup'));
  assert.equal(result.status, 'completed');
  assert.equal(harness.requests.length, 3);
  assert.equal(harness.dispatchCalls.length, 1);
  assert.equal(harness.requests[0].body.messages.some(message => message.content === 'RECOVERY-PRIOR-ANSWER'), true);
  assert.equal(harness.requests[1].body.messages.some(message => message.content === 'RECOVERY-PRIOR-ANSWER'), false);
  assert.equal(harness.requests[2].body.messages.some(message => message.content === 'RECOVERY-PRIOR-ANSWER'), false);
  assert.ok(harness.requests[2].body.messages.some(message => message.reasoning_content === 'RECOVERY-TOOL-REASONING'));
  assert.ok(harness.requests[2].body.messages.some(message => message.content === 'RECOVERY-TOOL-RESULT'));
});

test('session telemetry is additive, completed-call counting is distinct, and recent history stays at five', async () => {
  const harness = createHarness({
    actions: Array.from({ length: 6 }, (_, index) => providerResponse({
      content: `session-answer-${index + 1}`,
      responseUsage: usage({
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        prompt_cache_hit_tokens: 4,
        prompt_cache_miss_tokens: 6,
        completion_tokens_details: { reasoning_tokens: 2 }
      })
    }))
  });
  for (let index = 0; index < 6; index++) {
    const result = await harness.controller.runTurn(turnOptions(`session-${index + 1}`));
    assert.equal(result.status, 'completed');
  }
  const snapshot = harness.controller.getTelemetrySnapshot();
  assert.equal(snapshot.session.completed_calls, 6);
  assert.equal(snapshot.session.api_rounds, 6);
  assert.equal(snapshot.session.api_attempts, 6);
  assert.equal(snapshot.session.usage.prompt_tokens, 60);
  assert.equal(snapshot.session.usage.completion_tokens, 30);
  assert.equal(snapshot.session.usage.total_tokens, 90);
  assert.equal(snapshot.session.usage.reasoning_tokens, 12);
  assert.equal(snapshot.session.recent_calls.length, 5);
  assert.deepEqual(snapshot.session.recent_calls.map(call => call.call), [2, 3, 4, 5, 6]);
  assert.equal(snapshot.session.recent_calls.every(call => call.fallback === 'none'), true);
});

test('V69: importing the composition root is side-effect free and cannot boot a controller or TUI', () => {
  const script = [
    "const path=require('node:path');",
    "const fs=require('node:fs');",
    "const http=require('node:http');",
    "const https=require('node:https');",
    `const repo=${JSON.stringify(REPO)};`,
    "process.chdir(repo);",
    "const controllerModule=require('./motherbrain-controller.js');",
    "const tuiModule=require('./motherbrain-tui.js');",
    "require('axios');",
    "let controllerCreations=0,tuiCreations=0,envReads=0,networkCalls=0,timerCalls=0;",
    "const OriginalController=controllerModule.MotherBrainController;",
    "controllerModule.MotherBrainController=class ImportProbeController extends OriginalController{constructor(...args){controllerCreations++;super(...args);}};",
    "const originalCreateTui=tuiModule.createMotherBrainTui;",
    "tuiModule.createMotherBrainTui=(...args)=>{tuiCreations++;return originalCreateTui(...args);};",
    "const watched=['SIGINT','SIGTERM','SIGHUP','SIGBREAK','uncaughtException','unhandledRejection','exit'];",
    "const before=Object.fromEntries(watched.map(name=>[name,process.listenerCount(name)]));",
    "const originalRead=fs.readFileSync;",
    "fs.readFileSync=function(file,...args){if(path.resolve(String(file))===path.join(repo,'.env'))envReads++;return originalRead.call(this,file,...args);};",
    "const originalHttpGet=http.get,originalHttpRequest=http.request,originalHttpsRequest=https.request;",
    "http.get=http.request=https.request=()=>{networkCalls++;throw new Error('network during import');};",
    "const originalSetTimeout=global.setTimeout,originalSetInterval=global.setInterval;",
    "global.setTimeout=(...args)=>{timerCalls++;return originalSetTimeout(...args);};",
    "global.setInterval=(...args)=>{timerCalls++;return originalSetInterval(...args);};",
    "const imported=require('./motherbrain.js');",
    "const after=Object.fromEntries(watched.map(name=>[name,process.listenerCount(name)]));",
    "fs.readFileSync=originalRead;http.get=originalHttpGet;http.request=originalHttpRequest;https.request=originalHttpsRequest;",
    "global.setTimeout=originalSetTimeout;global.setInterval=originalSetInterval;",
    "process.stdout.write(JSON.stringify({controllerCreations,tuiCreations,envReads,networkCalls,timerCalls,before,after,mainType:typeof imported.main}));"
  ].join('\n');
  const probe = spawnSync(process.execPath, ['-e', script], {
    cwd: REPO,
    encoding: 'utf8',
    windowsHide: true
  });
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stderr, '');
  const result = JSON.parse(probe.stdout);
  assert.deepEqual(result, {
    controllerCreations: 0,
    tuiCreations: 0,
    envReads: 0,
    networkCalls: 0,
    timerCalls: 0,
    before: result.before,
    after: result.before,
    mainType: 'function'
  });
});

test('V60/V65: the active composition root has one terminal owner and no raw writer or inherited child stdio', () => {
  const source = fs.readFileSync(path.join(REPO, 'motherbrain.js'), 'utf8');
  const guard = source.indexOf('if (require.main === module)');
  assert.notEqual(guard, -1);
  const activeSource = source.slice(0, guard);
  const guardedBoot = source.slice(guard);
  assert.equal(/require\(['"]readline['"]\)|readline\.createInterface/.test(source), false);
  assert.equal(/require\(['"]terminal-kit['"]\)/.test(source), false);
  assert.equal(/process\.(?:on|once|addListener)\(/.test(activeSource), false);
  assert.equal(/stdio\s*:\s*['"]inherit['"]/.test(activeSource), false);
  assert.deepEqual(
    activeSource.match(/^[\t ]*(?:console\.(?:log|error|warn|info|debug)|process\.(?:stdout|stderr)\.write)\s*\(/gm) || [],
    []
  );
  assert.equal(
    (guardedBoot.match(/^[\t ]*process\.stderr\.write\s*\(/gm) || []).length,
    1,
    'only the guarded post-teardown startup diagnostic may write directly'
  );
  const childOutputHandlers = [...activeSource.matchAll(/_child\.(?:stdout|stderr)\.on\('data',[\s\S]*?\}\);/g)]
    .map(match => match[0]);
  assert.ok(childOutputHandlers.length >= 6);
  assert.equal(childOutputHandlers.every(line => /_(?:stdout|stderr)Activity\.push/.test(line)), true);
  assert.equal((activeSource.match(/trackOperationalChild\(/g) || []).length >= 4, true);
  assert.equal((activeSource.match(/createStructuredChildActivityCapture\(/g) || []).length >= 7, true);

  const production = loadProductionComposition();
  const emitted = [];
  const stdout = production.createStructuredChildActivityCapture(
    { prefix: 'OUT:', activityOptions: { role: 'tool' } },
    (text, options) => emitted.push({ text, options })
  );
  const stderr = production.createStructuredChildActivityCapture(
    { prefix: 'ERR:', activityOptions: { role: 'warning' } },
    (text, options) => emitted.push({ text, options })
  );
  stdout.push(Buffer.from('par'));
  stdout.push('tial\nline two\nlast');
  stderr.push('warning one\nwarning');
  stderr.push(' two\n');
  stdout.flush();
  stderr.flush();
  assert.deepEqual(emitted, [
    { text: 'OUT:partial', options: { role: 'tool' } },
    { text: 'OUT:line two', options: { role: 'tool' } },
    { text: 'ERR:warning one', options: { role: 'warning' } },
    { text: 'ERR:warning two', options: { role: 'warning' } },
    { text: 'OUT:last', options: { role: 'tool' } }
  ]);

  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = signal => { child.killedWith = signal; };
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  let childCleanupCount = 0;
  production.trackOperationalChild(child, () => { childCleanupCount += 1; });
  assert.equal(production.stopOperationalChildren(), 1);
  assert.equal(child.stdout.listenerCount('data'), 0);
  assert.equal(child.stderr.listenerCount('data'), 0);
  assert.equal(child.killedWith, 'SIGKILL');
  assert.equal(childCleanupCount, 1);
  assert.equal((source.match(/if \(require\.main === module\)/g) || []).length, 1);
});

test('V60: sustained structured async output preserves the editor and pane interaction state', () => {
  const { MotherBrainTui } = require(path.join(REPO, 'motherbrain-tui.js'));
  const tui = new MotherBrainTui({
    input: { isTTY: false },
    output: { isTTY: false, write() {} },
    scheduleFrame: callback => callback()
  });
  const draft = 'line one\nline two\nline three';
  tui.setDraft(draft, 13);
  tui._state.history.items = ['older command', 'newer command'];
  tui._state.history.index = 1;
  tui._state.history.savedDraft = draft;
  tui._state.splitRatio = 0.61;
  tui._state.panes.transcript.follow = false;
  tui._state.panes.transcript.topLogicalLine = 4;
  tui._state.panes.activity.follow = false;
  tui._state.panes.activity.topLogicalLine = 7;
  tui._state.selection = { pane: 'activity', status: 'copied', bytes: 31 };

  const before = tui.getSnapshot();
  const kinds = ['sse-turn', 'child-stdout', 'child-stderr', 'cached-context', 'diagnostic-status'];
  for (let index = 0; index < 500; index++) {
    tui.renderActivityRecord({
      id: `storm-${index}`,
      kind: kinds[index % kinds.length],
      role: index % 7 === 0 ? 'warning' : 'telemetry',
      text: `synthetic async record ${index}`
    });
    if (index % 25 === 0) {
      tui.renderHeaderOperationalState({ activity: 'busy', busy: true, engine: 'offline', sse: 'connected' });
    }
  }
  const after = tui.getSnapshot();

  assert.equal(after.draft, before.draft);
  assert.equal(after.cursorOffset, before.cursorOffset);
  assert.deepEqual(after.history, before.history);
  assert.equal(after.splitRatio, before.splitRatio);
  assert.equal(after.panes.transcript.follow, before.panes.transcript.follow);
  assert.equal(after.panes.transcript.topLogicalLine, before.panes.transcript.topLogicalLine);
  assert.equal(after.panes.activity.follow, before.panes.activity.follow);
  assert.equal(after.panes.activity.topLogicalLine, before.panes.activity.topLogicalLine);
  assert.deepEqual(after.selection, before.selection);
  assert.equal(after.panes.activity.newOutput, true);
  assert.equal(after.panes.activity.records.at(-1).text, 'synthetic async record 499');
});

test('V65: session-free run_validation syntax execution stays captured and unchanged', async () => {
  const production = loadProductionComposition();
  const result = JSON.parse(await production.executeToolCall('run_validation', { task: 'node_check_mother' }));
  assert.equal(result.task, 'node_check_mother');
  assert.equal(result.command, 'node --check motherbrain.js');
  assert.equal(result.exit_code, 0);
  assert.equal(typeof result.stdout, 'string');
  assert.equal(typeof result.stderr, 'string');
});

test('V01/V03 integration: DeepSeek transport preserves route, headers, body, and cancellation ownership', async () => {
  const { createDeepSeekHttpClient } = loadProductionComposition();
  const calls = [];
  const agent = { fixture: 'https-agent' };
  let callNumber = 0;
  const axiosClient = {
    post(url, body, options) {
      callNumber += 1;
      calls.push({ url, body: clone(body), options });
      if (callNumber === 1) return Promise.resolve({ data: { ok: true } });
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('synthetic abort')));
      });
    }
  };
  const client = createDeepSeekHttpClient({
    axiosClient,
    getApiKey: () => 'STEP10_SYNTHETIC_KEY',
    httpsAgent: agent
  });
  const body = { model: MODEL_IDS.flash, reasoning_effort: REASONING_EFFORTS.high, messages: [] };
  const response = await client({ url: 'https://api.deepseek.com/chat/completions', body });
  assert.deepEqual(response, { data: { ok: true } });
  assert.equal(calls[0].url, 'https://api.deepseek.com/chat/completions');
  assert.deepEqual(calls[0].body, body);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer STEP10_SYNTHETIC_KEY');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].options.timeout, 0);
  assert.equal(calls[0].options.httpsAgent, agent);
  assert.equal(client.getActiveRequestCount(), 0);

  const pending = client({ url: 'https://api.deepseek.com/chat/completions', body });
  assert.equal(client.getActiveRequestCount(), 1);
  assert.equal(calls[1].options.signal.aborted, false);
  client.cancelAll();
  assert.equal(calls[1].options.signal.aborted, true);
  await assert.rejects(pending, /synthetic abort/);
  assert.equal(client.getActiveRequestCount(), 0);
});

test('V51/V61: production composition appends once immediately, blocks a second turn, and snapshots busy settings', async t => {
  const firstResponse = deferred();
  const harness = await createCompositionHarness(t, {
    label: 'composition-turns',
    actions: [
      firstResponse.promise,
      providerResponse({ content: 'SECOND FINAL', reasoningContent: 'second reasoning' })
    ]
  });
  const firstSubmit = harness.runtime.submit('FIRST DEVELOPER MESSAGE');
  assert.deepEqual(
    harness.tui.records.transcript.map(record => [record.role, record.text]),
    [['developer', 'FIRST DEVELOPER MESSAGE']],
    'developer text was not appended synchronously before provider work'
  );
  await flushMicrotasks();
  assert.equal(harness.requests.length, 1);

  const blocked = await harness.runtime.submit('SECOND DRAFT MUST STAY OUT');
  assert.deepEqual(blocked, { accepted: false, code: 'controller_busy' });
  assert.equal(harness.tui.records.transcript.some(record => record.text === 'SECOND DRAFT MUST STAY OUT'), false);
  assert.ok(harness.tui.records.activity.some(record => record.kind === 'blocked-submit'));

  const command = await harness.runtime.submit('/model pro');
  assert.deepEqual(command, { accepted: true, local: true });
  assert.equal(harness.requests.length, 1, 'local command reached provider transport');
  assert.equal(harness.runtime.controller.getContractSnapshot().configured_settings.model, MODEL_IDS.pro);

  firstResponse.resolve(providerResponse({ content: 'FIRST FINAL', reasoningContent: 'first reasoning' }));
  const firstOutcome = await firstSubmit;
  assert.equal(firstOutcome.outcome.status, 'completed');
  assert.equal(harness.requests[0].body.model, MODEL_IDS.flash, 'busy command changed the active request snapshot');

  const secondOutcome = await harness.runtime.submit('NEXT TURN USES PRO');
  assert.equal(secondOutcome.outcome.status, 'completed');
  assert.equal(harness.requests[1].body.model, MODEL_IDS.pro);
  assert.deepEqual(
    harness.tui.records.transcript.filter(record => record.role === 'developer').map(record => record.text),
    ['FIRST DEVELOPER MESSAGE', '/model pro', 'NEXT TURN USES PRO']
  );
  assert.deepEqual(
    harness.tui.records.transcript.filter(record => record.role === 'final').map(record => record.text),
    ['FIRST FINAL', 'SECOND FINAL']
  );
  assert.equal(harness.tui.records.rounds.length, 2);
  assert.ok(harness.tui.records.telemetry.length >= 2);
  assert.equal(harness.tui.records.telemetry.at(-1).source.session.completed_calls, 2);
  assert.ok(harness.tui.records.commands.some(record => record.lines.some(line => line.includes('/model'))));
});

test('V58: no-session and missing-provider startup remain usable and nonfatal', async t => {
  const harness = await createCompositionHarness(t, {
    label: 'offline-nonfatal',
    actions: [],
    hasProviderCredential: () => false
  });
  const result = await harness.runtime.submit('OFFLINE QUESTION');
  assert.deepEqual(result, { accepted: true, local: false, providerCalled: false });
  assert.equal(harness.runtime.started, true);
  assert.equal(harness.requests.length, 0);
  assert.equal(harness.tui.records.fatals.length, 0);
  assert.equal(harness.tui.records.transcript.filter(record => record.text === 'OFFLINE QUESTION').length, 1);
  assert.ok(harness.tui.records.activity.some(record => record.kind === 'provider-unavailable'));
  const operational = harness.runtime.controller.getContractSnapshot().operational_state;
  assert.equal(operational.session, 'none');
  assert.equal(operational.engine, 'offline');
});

test('V57: SSE and engine states stay distinct with one reconnect timer across two lifecycles', async t => {
  const timers = createFakeTimers();
  const sse = createFakeSseHttpModule();
  const watched = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK', 'uncaughtException', 'unhandledRejection', 'exit'];
  const listenersBefore = Object.fromEntries(watched.map(name => [name, process.listenerCount(name)]));
  const runtimeOptions = {
    httpModule: sse,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout
  };

  const first = await createCompositionHarness(t, { label: 'sse-first', runtimeOptions });
  assert.deepEqual(first.runtime.controller.getContractSnapshot().operational_state, {
    engine: 'offline',
    sse: 'disconnected',
    session: 'none',
    harness: 'offline',
    game: 'inactive'
  });
  first.runtime.connectSse();
  first.runtime.handleSsePayload({ type: 'lifecycle', event: 'online', port: 3000, sessionId: 'sse-session' });
  assert.equal(sse.requests.length, 1);
  const firstResponse = sse.respond(0, 200);
  assert.deepEqual(first.runtime.controller.getContractSnapshot().operational_state, {
    engine: 'online',
    sse: 'connected',
    session: 'none',
    harness: 'offline',
    game: 'inactive'
  });
  first.runtime.handleSsePayload({
    type: 'turn',
    turn: 57,
    gameSessionId: 'attached-session',
    spatial: { depth: 0 },
    tokens: {},
    entities: { visible: [] },
    violations: []
  });
  await flushMicrotasks();
  first.runtime.handleSsePayload({ type: 'lifecycle', event: 'offline', reason: 'synthetic engine stop' });
  assert.deepEqual(first.runtime.controller.getContractSnapshot().operational_state, {
    engine: 'offline',
    sse: 'connected',
    session: 'attached',
    harness: 'offline',
    game: 'inactive'
  });

  firstResponse.emit('end');
  firstResponse.emit('error', new Error('duplicate synthetic stream error'));
  firstResponse.emit('close');
  assert.equal(timers.activeCount(), 1);
  assert.equal(first.runtime.scheduleSseReconnect(), false);
  const firstOperational = first.runtime.controller.getContractSnapshot().operational_state;
  assert.equal(firstOperational.engine, 'offline');
  assert.equal(firstOperational.sse, 'reconnecting');

  first.runtime.connectSse();
  assert.equal(sse.requests.length, 2);
  const recoveredResponse = sse.respond(1, 200);
  assert.equal(timers.activeCount(), 0, 'successful connection retained a pending reconnect timer');
  assert.equal(first.runtime.controller.getContractSnapshot().operational_state.sse, 'connected');
  await first.runtime.shutdown('first-cycle-complete');
  assert.equal(timers.activeCount(), 0);
  assert.equal(recoveredResponse.destroyed, true);
  assert.equal(recoveredResponse.listenerCount('data'), 0);
  assert.equal(recoveredResponse.listenerCount('end'), 0);
  assert.equal(recoveredResponse.listenerCount('close'), 0);

  const second = await createCompositionHarness(t, { label: 'sse-second', runtimeOptions });
  second.runtime.connectSse();
  assert.equal(sse.requests.length, 3);
  sse.requests[2].request.emit('error', new Error('second-cycle-offline'));
  sse.requests[2].request.emit('error', new Error('duplicate second-cycle-offline'));
  assert.equal(timers.activeCount(), 1);
  await second.runtime.shutdown('second-cycle-complete');
  assert.equal(timers.activeCount(), 0);
  assert.deepEqual(
    Object.fromEntries(watched.map(name => [name, process.listenerCount(name)])),
    listenersBefore,
    'composition lifecycle accumulated process handlers'
  );
});

test('V59: attached live-context failure uses labeled cached context and structured SSE records', async t => {
  const { createLiveContextProvider } = loadProductionComposition();
  let mode = 'success';
  const axiosClient = {
    async get() {
      if (mode === 'success') return { data: { context: 'CACHED STEP10 CONTEXT' } };
      throw new Error('synthetic live context failure');
    }
  };
  const provider = createLiveContextProvider({ axiosClient, httpAgent: { fixture: true } });
  const harness = await createCompositionHarness(t, {
    label: 'cached-context',
    getLiveContext: provider,
    actions: [providerResponse({ content: 'CACHED CONTEXT FINAL' })]
  });
  harness.runtime.handleSsePayload({
    type: 'turn',
    turn: 31,
    gameSessionId: 'attached-session',
    spatial: { depth: 0 },
    tokens: {},
    entities: { visible: [] },
    violations: []
  });
  await flushMicrotasks();
  mode = 'failure';
  const result = await harness.runtime.submit('CACHED CONTEXT QUESTION');
  assert.equal(result.outcome.status, 'completed');
  const capturedUserMessage = harness.requests[0].body.messages.findLast(message => message.role === 'user').content;
  assert.ok(capturedUserMessage.includes('CACHED STEP10 CONTEXT'));
  assert.ok(capturedUserMessage.includes('[NOTE: Live context fetch failed — using cached snapshot.]'));
  assert.ok(harness.tui.records.activity.some(record =>
    record.kind === 'context-source'
      && record.text === '[NOTE: Live context fetch failed — using cached snapshot.]'
  ));
  assert.ok(harness.tui.records.activity.some(record => record.kind === 'sse-turn' && record.text.includes('[T-31]')));
  const operational = harness.runtime.controller.getContractSnapshot().operational_state;
  assert.equal(operational.session, 'attached');
  assert.equal(operational.engine, 'offline');
});

test('V59/V68: shutdown aborts in-flight bootstrap and live-context requests', async t => {
  const production = loadProductionComposition();
  const calls = [];
  const axiosClient = {
    get(url, options = {}) {
      return new Promise((resolve, reject) => {
        const call = { url, signal: options.signal, resolve, reject };
        calls.push(call);
        options.signal?.addEventListener('abort', () => {
          const error = new Error('synthetic request canceled');
          error.code = 'ERR_CANCELED';
          reject(error);
        }, { once: true });
      });
    }
  };
  const provider = production.createLiveContextProvider({ axiosClient, httpAgent: { fixture: true } });
  const harness = await createCompositionHarness(t, {
    label: 'lifecycle-request-cancel',
    getLiveContext: provider,
    runtimeOptions: { axiosClient }
  });

  const contextResult = provider.prewarm('context-session').then(
    value => ({ status: 'fulfilled', value }),
    error => ({ status: 'rejected', error })
  );
  const bootstrapResult = harness.runtime.bootstrapSession();
  await flushMicrotasks();
  assert.equal(calls.length, 2);
  assert.equal(provider.getActiveRequestCount(), 1);
  assert.equal(harness.runtime.getLifecycleSnapshot().bootstrap_request_active, true);

  await harness.runtime.shutdown('cancel-active-requests');
  const contextOutcome = await contextResult;
  assert.equal(contextOutcome.status, 'rejected');
  assert.equal(contextOutcome.error.code, 'ERR_CANCELED');
  assert.equal(await bootstrapResult, false);
  assert.equal(calls.every(call => call.signal.aborted), true);
  const stopped = harness.runtime.getLifecycleSnapshot();
  assert.equal(stopped.bootstrap_request_active, false);
  assert.equal(stopped.context_requests_active, 0);
});

test('V68: controlled fatal teardown writes local and packet crash evidence with authoritative SSE turn', async t => {
  const fileWrites = [];
  const crashPackets = [];
  const teardownOrder = [];
  const crashFileSystem = {
    mkdirSync() {},
    writeFileSync(filePath, value, encoding) {
      teardownOrder.push('crash-file-written');
      fileWrites.push({ filePath, value, encoding });
    }
  };
  const crashHttpModule = {
    request(options) {
      const request = new EventEmitter();
      let body = '';
      request.write = value => { body += value; };
      request.end = () => {
        teardownOrder.push('crash-packet-sent');
        crashPackets.push({ options, body });
      };
      return request;
    }
  };
  const harness = await createCompositionHarness(t, {
    label: 'crash-turn',
    reportCrashes: true,
    runtimeOptions: { crashFileSystem, crashHttpModule }
  });
  const originalStopAcceptingInput = harness.tui.stopAcceptingInput.bind(harness.tui);
  harness.tui.stopAcceptingInput = () => {
    const changed = originalStopAcceptingInput();
    if (changed) teardownOrder.push('input-stopped');
    return changed;
  };
  const originalOnShutdown = harness.tui.options.onShutdown;
  harness.tui.options.onShutdown = result => {
    teardownOrder.push('terminal-restored');
    return originalOnShutdown(result);
  };
  harness.runtime.handleSsePayload({
    type: 'turn',
    turn: 77,
    gameSessionId: 'crash-session',
    spatial: { depth: 0 },
    tokens: {},
    entities: { visible: [] },
    violations: []
  });
  await harness.tui.shutdown('uncaughtException', { exitCode: 1, error: new Error('controlled step12 crash') });
  assert.equal(harness.runtime.state.stopped, true);
  assert.equal(harness.tui.started, false);
  assert.deepEqual(await harness.runtime.submit('must not be accepted after shutdown'), {
    accepted: false,
    code: 'runtime_stopping'
  });
  const activityCountAfterShutdown = harness.tui.records.activity.length;
  harness.runtime.controller.updateOperationalState({ sse: 'late-event-must-not-render' });
  assert.equal(harness.tui.records.activity.length, activityCountAfterShutdown);
  const requestsAfterShutdown = harness.requests.length;
  const stoppedTurn = await harness.runtime.controller.runTurn(turnOptions('late internal turn'));
  assert.equal(stoppedTurn.status, 'failed');
  assert.equal(stoppedTurn.error.details.transport_code, 'runtime_stopping');
  assert.equal(harness.requests.length, requestsAfterShutdown, 'shutdown allowed a new provider request');
  assert.equal(fileWrites.length, 1);
  assert.ok(fileWrites[0].value.includes('last turn : T-77'));
  assert.ok(fileWrites[0].value.includes('controlled step12 crash'));
  assert.equal(crashPackets.length, 1);
  assert.equal(crashPackets[0].options.path, '/diagnostics/mb-crash');
  const packet = JSON.parse(crashPackets[0].body);
  assert.equal(packet.last_turn, 77);
  assert.equal(packet.session, 'crash-session');
  assert.equal(packet.mb_version, harness.production.MB_VERSION);
  assert.deepEqual(teardownOrder, [
    'input-stopped',
    'terminal-restored',
    'crash-file-written',
    'crash-packet-sent'
  ]);
  assert.deepEqual(harness.tui.records.lifecycle, [
    'input-stopped',
    'terminal-restored',
    'runtime-finalized'
  ]);
});
