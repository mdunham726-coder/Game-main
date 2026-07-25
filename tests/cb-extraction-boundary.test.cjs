'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const axios = require('axios');

const REPO = path.resolve(__dirname, '..');
const CB = require(path.join(REPO, 'ContinuityBrain.js'));
const ObjectHelper = require(path.join(REPO, 'ObjectHelper.js'));
const SemanticNormalizer = require(path.join(REPO, 'SemanticNormalizer.js'));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function readSource(relativePath) {
  return fs.readFileSync(path.join(REPO, relativePath), 'utf8').replace(/\r\n/g, '\n');
}

function sourceSlice(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `${label} start marker must exist`);
  assert.notEqual(end, -1, `${label} end marker must exist`);
  assert.ok(end > start, `${label} markers must be ordered`);
  return source.slice(start, end);
}

function baseGameState() {
  return {
    turn_history: [{ turn: 1 }],
    world: {
      position: { mx: 0, my: 0, lx: 0, ly: 0 },
      active_local_space: {
        local_space_id: 'room_1',
        name: 'Test Room',
        attributes: {},
        _visible_npcs: []
      },
      active_site: null,
      mood_history: [],
      promotion_log: []
    },
    player: {
      id: 'player',
      object_ids: [],
      attributes: {},
      conditions: [],
      position: { x: 0, y: 0 }
    },
    objects: {}
  };
}

function baseCbPayload(overrides = {}) {
  return {
    entity_candidates: [],
    environmental_features: [],
    spatial_relations: [],
    rejected_interpretations: [],
    mood_snapshot: null,
    condition_events: [],
    object_candidates: [],
    object_transfers: [],
    object_condition_updates: [],
    object_retirements: [],
    fission_events: [],
    extraction_events: [],
    ...overrides
  };
}

function extractionEvent(overrides = {}) {
  return {
    source_ref: 'cloth roll',
    verb: 'tear from',
    extracted_quantity: 1,
    extracted_unit: 'strip',
    product_name: 'cloth strip',
    description: 'a narrow red cloth strip',
    destination_hint: 'player_hands',
    actor_ref: 'player',
    evidence: 'I tear a narrow red strip from the cloth roll',
    ...overrides
  };
}

function addDropThrowReceiptObjects(gameState) {
  Object.assign(gameState.objects, {
    drop_source: {
      id: 'drop_source',
      name: 'bronze tokens',
      description: 'three dull bronze tokens',
      status: 'active',
      quantity: 2,
      unit: 'token',
      current_container_type: 'player',
      current_container_id: 'player'
    },
    drop_successor: {
      id: 'drop_successor',
      name: 'bronze token',
      description: '',
      status: 'active',
      quantity: 1,
      unit: 'token',
      parent_object_id: 'drop_source',
      created_turn: 2,
      current_container_type: 'localspace',
      current_container_id: 'room_1'
    },
    throw_source: {
      id: 'throw_source',
      name: 'chalk pieces',
      description: 'three square chalk pieces',
      status: 'active',
      quantity: 2,
      unit: 'piece',
      current_container_type: 'player',
      current_container_id: 'player'
    },
    throw_successor: {
      id: 'throw_successor',
      name: 'chalk piece',
      description: '',
      status: 'active',
      quantity: 1,
      unit: 'piece',
      parent_object_id: 'throw_source',
      created_turn: 2,
      current_container_type: 'localspace',
      current_container_id: 'room_1'
    }
  });
  gameState.player.object_ids.push('drop_source', 'throw_source');
}

function receipt(family) {
  const isDrop = family === 'drop';
  return {
    schema_version: `cb_tls_partial_stack_${family}_v1`,
    authority: 'tls_object_helper',
    turn_number: 2,
    operation_type: `tls_partial_stack_${family}`,
    status: 'executed',
    actor_ref: 'player',
    source_object_id: isDrop ? 'drop_source' : 'throw_source',
    source_persists: true,
    successor_object_id: isDrop ? 'drop_successor' : 'throw_successor',
    successor_created_this_turn: true,
    requested_quantity: 1,
    extracted_quantity: 1,
    source_quantity_before: 3,
    source_quantity_after: 2,
    source_container_type: 'player',
    source_container_id: 'player',
    destination_container_type: 'localspace',
    destination_container_id: 'room_1'
  };
}

function addTakeReceiptObjects(gameState) {
  Object.assign(gameState.objects, {
    take_source: {
      id: 'take_source',
      name: 'cloth strips',
      description: 'three folded red cloth strips',
      status: 'active',
      quantity: 2,
      unit: 'strip',
      current_container_type: 'localspace',
      current_container_id: 'room_1'
    },
    take_successor: {
      id: 'take_successor',
      name: 'cloth strip',
      description: '',
      status: 'active',
      quantity: 1,
      unit: 'strip',
      parent_object_id: 'take_source',
      created_turn: 2,
      current_container_type: 'player',
      current_container_id: 'player'
    },
    take_decoy: {
      id: 'take_decoy',
      name: 'cloth strip',
      description: 'an unrelated blue cloth strip',
      status: 'active',
      quantity: 1,
      unit: 'strip',
      parent_object_id: 'other_source',
      created_turn: 2,
      current_container_type: 'player',
      current_container_id: 'player'
    }
  });
  gameState.player.object_ids.push('take_successor', 'take_decoy');
}

function takeReceipt(overrides = {}) {
  return {
    schema_version: 'cb_tls_partial_stack_take_v1',
    authority: 'tls_object_helper',
    turn_number: 2,
    operation_type: 'tls_partial_stack_take',
    status: 'executed',
    actor_ref: 'player',
    source_object_id: 'take_source',
    source_persists: true,
    successor_object_id: 'take_successor',
    successor_created_this_turn: true,
    extracted_quantity: 1,
    destination_container_type: 'player',
    destination_container_id: 'player',
    ...overrides
  };
}

function takeMetadata(overrides = {}) {
  return {
    description: 'a narrow red cloth strip with a frayed edge',
    evidence: 'narrow red cloth strip with a frayed edge',
    ...overrides
  };
}

async function runPhaseBWithStub({ payload, narration, gameState, options = {} }) {
  const calls = [];
  const originalPost = axios.post;
  const originalApiKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'deterministic-test-key';
  axios.post = async (url, body, config) => {
    calls.push(clone({ url, body, config }));
    return {
      data: {
        choices: [{ message: { content: JSON.stringify(payload) } }]
      }
    };
  };

  try {
    const result = await CB.runPhaseB(narration, gameState, 'test input', options);
    return { calls, result };
  } finally {
    axios.post = originalPost;
    if (originalApiKey === undefined) {
      delete process.env.DEEPSEEK_API_KEY;
    } else {
      process.env.DEEPSEEK_API_KEY = originalApiKey;
    }
  }
}

function correlationCandidate(overrides = {}) {
  return {
    name: 'cloth strip',
    container_type: 'player',
    container_id: 'player',
    reason: 'I tear a narrow red strip from the cloth roll',
    ...overrides
  };
}

function extractionOperation(overrides = {}) {
  const productOverrides = overrides.product || {};
  const withoutProduct = { ...overrides };
  delete withoutProduct.product;
  return {
    product: {
      name: 'cloth strip',
      unit: 'strip',
      container_type: 'player',
      container_id: 'player',
      ...productOverrides
    },
    evidence: 'I tear a narrow red strip from the cloth roll',
    unresolved: false,
    quantity_unresolved: false,
    ...withoutProduct
  };
}

function loadTakeConsumerHarness() {
  const source = readSource('index.js');
  const sanitizer = sourceSlice(
    source,
    '  function _sanitizeCbTlsPartialStackTakeReceipt(receipt) {',
    '\n\n  function _sanitizeCbTlsPartialStackDropReceipt(receipt) {',
    'partial-TAKE receipt sanitizer'
  );
  const consumer = sourceSlice(
    source,
    '      // Receipt-bound partial-TAKE successor-description consumption.',
    '      // #17 — surviving-source description normalization.',
    'partial-TAKE metadata consumer'
  );
  const sandbox = {};
  vm.runInNewContext(
    `
      globalThis.__consumeTakeDescription = function(args) {
        const gameState = args.gameState;
        const turnNumber = args.turnNumber;
        const ObjectHelper = args.ObjectHelper;
        const _phaseBResult = args.phaseBResult;
        const _cbTlsPartialStackTakeReceipt = args.receipt;
        const _cbTlsPartialStackTakeReceiptState = args.receiptState;
        ${sanitizer}
        ${consumer}
        return { gameState, phaseBResult: _phaseBResult };
      };
    `,
    sandbox,
    { filename: 'cb-partial-take-consumer.vm.js', timeout: 1000 }
  );
  assert.equal(typeof sandbox.__consumeTakeDescription, 'function');
  return sandbox.__consumeTakeDescription;
}

function descriptionObjectHelper(writes) {
  return {
    setObjectDescriptionDirect(gameState, objectId, description) {
      const record = gameState.objects?.[objectId];
      writes.push({ objectId, description });
      if (!record) return { applied: false, object_id: objectId, reason: 'object_not_found' };
      record.description = description;
      return { applied: true, object_id: objectId, reason: 'updated' };
    }
  };
}

function runExtractionCandidateGate({ candidates, operations, dropDryRun = false, throwDryRun = false }) {
  const source = readSource('index.js');
  const gate = sourceSlice(
    source,
    '        // Extraction candidate denial guard:',
    '        // v1.91.70: P5-A1 CB candidate promotion guard',
    'extraction candidate correlation gate'
  );
  const sandbox = {};
  vm.runInNewContext(
    `
      globalThis.__runExtractionCandidateGate = function(args) {
        const _phaseBResult = { object_candidates: args.candidates };
        const _tslR = { tsl: { extraction_operations: args.operations } };
        const _dropDryRunSealActive = args.dropDryRun;
        const _throwDryRunSealActive = args.throwDryRun;
        const _objectRealityDebug = {};
        const logs = [];
        const _turnLog = (_debug, level, stage, message, details) => {
          logs.push({ level, stage, message, details });
        };
        ${gate}
        return {
          candidates: _phaseBResult.object_candidates,
          operations: _tslR.tsl.extraction_operations,
          debug: _objectRealityDebug,
          logs
        };
      };
    `,
    sandbox,
    { filename: 'cb-extraction-candidate-gate.vm.js', timeout: 1000 }
  );
  assert.equal(typeof sandbox.__runExtractionCandidateGate, 'function');
  return clone(sandbox.__runExtractionCandidateGate({
    candidates: clone(candidates),
    operations: clone(operations),
    dropDryRun,
    throwDryRun
  }));
}

async function runExtractionObservationBlock({
  gameState,
  operations,
  debug,
  retirementPairs = [],
  apRefusedTake = false,
  dropDryRun = false,
  throwDryRun = false
}) {
  const source = readSource('index.js');
  const block = sourceSlice(
    source,
    '        // v1.91.03: TLS extraction ',
    '        // v1.85.8: Fission second pass',
    'extraction observation block'
  );
  const calls = [];
  const objectHelper = {
    retireObject(state, objectId, reason) {
      calls.push({ method: 'retireObject', objectId, reason });
      const record = state.objects?.[objectId];
      if (!record) return { retired: false, reason: 'object_not_found' };
      record.status = 'retired';
      return { retired: true, reason: 'retired' };
    },
    async run(state, quarantine) {
      calls.push({ method: 'run', quarantine: clone(quarantine) });
      const audit = [];
      for (const entry of quarantine) {
        if (entry.action !== 'partial_split') continue;
        const sourceRecord = state.objects?.[entry.source_object_id];
        if (sourceRecord) sourceRecord.quantity = entry.new_source_quantity;
        const objectId = entry.temp_ref || `test_product_${audit.length}`;
        state.objects[objectId] = {
          id: objectId,
          name: entry.name,
          status: 'active',
          quantity: entry.quantity,
          unit: entry.unit,
          current_container_type: entry.container_type,
          current_container_id: entry.container_id,
          parent_object_id: entry.parent_object_id
        };
        if (entry.container_type === 'player') {
          state.player.object_ids.push(objectId);
        }
        audit.push({ action: 'partial_split', object_id: objectId });
      }
      return {
        partial_splits: audit.length,
        promoted: audit.length,
        transferred: audit.length,
        errors: 0,
        audit
      };
    }
  };
  const sandbox = {};
  vm.runInNewContext(
    `
      globalThis.__runExtractionObservationBlock = async function(args) {
        const gameState = args.gameState;
        const _tslR = { tsl: { extraction_operations: args.operations } };
        const _objectRealityDebug = args.debug;
        const _retirementPairs = args.retirementPairs;
        const _apRefusedTake = args.apRefusedTake;
        const _dropDryRunSealActive = args.dropDryRun;
        const _throwDryRunSealActive = args.throwDryRun;
        const ObjectHelper = args.objectHelper;
        const turnNumber = 2;
        const console = { log() {}, warn() {}, error() {} };
        ${block}
        return {
          gameState,
          operations: _tslR.tsl.extraction_operations,
          debug: _objectRealityDebug,
          retirementPairs: _retirementPairs
        };
      };
    `,
    sandbox,
    { filename: 'cb-extraction-observation.vm.js', timeout: 1000 }
  );
  assert.equal(typeof sandbox.__runExtractionObservationBlock, 'function');
  const result = await sandbox.__runExtractionObservationBlock({
    gameState: clone(gameState),
    operations: clone(operations),
    debug: clone(debug),
    retirementPairs: clone(retirementPairs),
    apRefusedTake,
    dropDryRun,
    throwDryRun,
    objectHelper
  });
  return { ...clone(result), calls: clone(calls) };
}

function extractionExecutorState() {
  const gameState = baseGameState();
  gameState.objects.extraction_source = {
    id: 'extraction_source',
    name: 'cloth roll',
    description: 'a thick roll of red cloth',
    status: 'active',
    quantity: 4,
    unit: 'strip',
    current_container_type: 'player',
    current_container_id: 'player'
  };
  gameState.player.object_ids.push('extraction_source');
  return gameState;
}

function extractionObservationDebug(operations) {
  return {
    ran: false,
    skip_reason: 'empty_quarantine',
    promoted: 0,
    transferred: 0,
    errors: 0,
    audit: [{ action: 'existing_audit' }],
    tsl: { extraction_operations: clone(operations) }
  };
}

function renderObjectRealityLog(objectReality, state = {}) {
  const source = readSource('Index.html');
  const renderer = sourceSlice(
    source,
    '    function appendObjectRealityLog(data, turnNumber) {',
    '    // ========== v1.58.0: NARRATIVE CONTINUITY OBSERVABILITY ==========',
    'object reality renderer'
  );
  const sandbox = {};
  vm.runInNewContext(
    `
      const _orLogBuffer = [];
      const _orDom = {
        children: [],
        firstChild: null,
        insertBefore(block) {
          this.children.unshift(block);
          this.firstChild = this.children[0] || null;
        },
        removeChild(block) {
          const index = this.children.indexOf(block);
          if (index >= 0) this.children.splice(index, 1);
          this.firstChild = this.children[0] || null;
        }
      };
      const document = {
        getElementById(id) {
          return id === 'object-reality-log' ? _orDom : null;
        },
        createElement() {
          return { style: {}, textContent: '' };
        }
      };
      ${renderer}
      globalThis.__renderObjectRealityLog = function(args) {
        appendObjectRealityLog({
          object_reality: args.objectReality,
          state: args.state
        }, 2);
        return {
          entry: _orLogBuffer[0],
          textContent: _orDom.firstChild?.textContent || ''
        };
      };
    `,
    sandbox,
    { filename: 'cb-extraction-diagnostics.vm.js', timeout: 1000 }
  );
  assert.equal(typeof sandbox.__renderObjectRealityLog, 'function');
  return clone(sandbox.__renderObjectRealityLog({
    objectReality: clone(objectReality),
    state: clone(state)
  }));
}

test('V2 baseline: generic extraction events survive runPhaseB and remain in the general packet', async () => {
  const event = extractionEvent();
  const gameState = baseGameState();
  const { calls, result } = await runPhaseBWithStub({
    payload: baseCbPayload({ extraction_events: [event] }),
    narration: event.evidence,
    gameState
  });

  assert.equal(calls.length, 1, 'the deterministic stub must satisfy the only CB HTTP call');
  assert.equal(calls[0].url, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(calls[0].body.messages.length, 1);
  assert.ok(calls[0].body.messages[0].content.includes('EXTRACTION EVENTS (optional)'));
  assert.deepEqual(result.extraction_events, [event]);
  assert.deepEqual(result.extracted.extraction_events, [event]);
  assert.equal(result.prompt, calls[0].body.messages[0].content);
});

test('V17: a noncompliant receipt-TAKE extraction event remains diagnostic and nonauthoritative', async () => {
  const gameState = baseGameState();
  addTakeReceiptObjects(gameState);
  const event = extractionEvent({
    source_ref: 'cloth strips',
    evidence: 'I take one cloth strip from the cloth strips'
  });
  const { result } = await runPhaseBWithStub({
    payload: baseCbPayload({ extraction_events: [event] }),
    narration: event.evidence,
    gameState,
    options: { tlsPartialStackTakeReceipt: takeReceipt() }
  });

  assert.deepEqual(result.extraction_events, [event]);
  assert.deepEqual(result.extracted.extraction_events, [event]);
  assert.equal(result.partial_take_successor_description, null);

  const writes = [];
  loadTakeConsumerHarness()({
    gameState,
    turnNumber: 2,
    ObjectHelper: descriptionObjectHelper(writes),
    phaseBResult: result,
    receipt: takeReceipt(),
    receiptState: 'accepted'
  });
  assert.deepEqual(writes, [], 'generic extraction evidence must not select the receipt successor description target');

  const normalized = SemanticNormalizer.analyze(
    result,
    event.evidence,
    'take',
    { referenced_objects: ['cloth strips'], input_type: 'action' },
    gameState
  );
  assert.equal(normalized.tsl.extraction_operations.length, 1);
  assert.equal(normalized.tsl.extraction_operations[0].source_object_id, 'take_source');

  const beforeState = clone(gameState);
  const observation = await runExtractionObservationBlock({
    gameState,
    operations: normalized.tsl.extraction_operations,
    debug: extractionObservationDebug(normalized.tsl.extraction_operations)
  });

  assert.deepEqual(observation.calls, []);
  assert.deepEqual(observation.gameState, beforeState);
  assert.deepEqual(observation.operations, normalized.tsl.extraction_operations);
  assert.equal(observation.debug.tsl_extraction_observed, 1);
  assert.equal(observation.debug.tsl_extraction_injected ?? 0, 0);
});

test('V18: the bounded extraction block contains observation accounting and no mutation or audit path', () => {
  const source = readSource('index.js');
  const extractionBlock = sourceSlice(
    source,
    '        // v1.91.03: TLS extraction ',
    '        // v1.85.8: Fission second pass',
    'extraction observation block'
  );

  for (const forbidden of [
    'ObjectHelper.run',
    'ObjectHelper.retireObject',
    '_retirementPairs',
    "'partial_split'",
    '_objectRealityDebug.promoted',
    '_objectRealityDebug.transferred',
    '_objectRealityDebug.errors',
    '_objectRealityDebug.audit',
    '_objectRealityDebug.ran',
    '_objectRealityDebug.skip_reason'
  ]) {
    assert.equal(extractionBlock.includes(forbidden), false, `${forbidden} must be absent`);
  }
  assert.ok(extractionBlock.includes('_objectRealityDebug.tsl_extraction_observed'));
  assert.ok(extractionBlock.includes('_objectRealityDebug.tsl_extraction_unresolvable'));
  assert.ok(extractionBlock.includes('_objectRealityDebug.tsl_extraction_injected'));
});

test('V19: resolved, unresolved, and degrade-projected extraction observations leave ORS unchanged', async () => {
  const cases = [
    {
      label: 'resolved',
      operation: extractionOperation({
        source_object_id: 'extraction_source',
        current_quantity: 4,
        extracted_quantity: 1,
        new_source_quantity: 3,
        degrades_to_fission: false,
        product: { temp_ref: 'resolved_product' }
      }),
      unresolvable: 0
    },
    {
      label: 'unresolved',
      operation: extractionOperation({
        source_object_id: null,
        current_quantity: null,
        new_source_quantity: null,
        unresolved: true,
        product: { temp_ref: 'unresolved_product' }
      }),
      unresolvable: 1
    },
    {
      label: 'degrade-projected',
      operation: extractionOperation({
        source_object_id: 'extraction_source',
        current_quantity: 1,
        extracted_quantity: 1,
        new_source_quantity: 0,
        degrades_to_fission: true,
        product: { temp_ref: 'degrade_product' }
      }),
      unresolvable: 0
    }
  ];

  for (const fixture of cases) {
    const gameState = extractionExecutorState();
    if (fixture.label === 'degrade-projected') {
      gameState.objects.extraction_source.quantity = 1;
    }
    const debug = extractionObservationDebug([fixture.operation]);
    const beforeState = clone(gameState);
    const beforeAudit = clone(debug.audit);
    const observation = await runExtractionObservationBlock({
      gameState,
      operations: [fixture.operation],
      debug
    });

    assert.deepEqual(observation.calls, [], `${fixture.label}: no mutation API may be called`);
    assert.deepEqual(observation.gameState, beforeState, `${fixture.label}: objects and container indexes must not change`);
    assert.deepEqual(observation.retirementPairs, [], `${fixture.label}: no fission retirement may be queued`);
    assert.deepEqual(observation.debug.audit, beforeAudit, `${fixture.label}: execution audit must not change`);
    assert.equal(observation.debug.ran, false, `${fixture.label}: execution state must not be overridden`);
    assert.equal(observation.debug.skip_reason, 'empty_quarantine', `${fixture.label}: skip state must not be overridden`);
    assert.equal(observation.debug.promoted, 0, `${fixture.label}: promoted total must not change`);
    assert.equal(observation.debug.transferred, 0, `${fixture.label}: transferred total must not change`);
    assert.equal(observation.debug.errors, 0, `${fixture.label}: error total must not change`);
    assert.equal(observation.debug.tsl_extraction_observed, 1, `${fixture.label}: witness must be counted`);
    assert.equal(observation.debug.tsl_extraction_unresolvable, fixture.unresolvable);
    assert.equal(observation.debug.tsl_extraction_injected ?? 0, 0);
  }
});

test('V20: the preceding fission injection and following fission second pass retain their mutation paths', () => {
  const source = readSource('index.js');
  const fissionInjection = sourceSlice(
    source,
    '        // v1.90.02: TLS fission injection',
    '        // v1.91.03: TLS extraction ',
    'preceding fission injection'
  );
  const fissionSecondPass = sourceSlice(
    source,
    '        // v1.85.8: Fission second pass',
    '\n      } else {\n        _objectRealityDebug.skip_reason = \'no_phaseB_result\';',
    'following fission second pass'
  );

  assert.ok(fissionInjection.includes('_tslR?.tsl?.fission_operations'));
  assert.ok(fissionInjection.includes('ObjectHelper.retireObject'));
  assert.ok(fissionInjection.includes('_retirementPairs.push'));
  assert.ok(fissionInjection.includes('_objectRealityDebug.tsl_fission_injected'));
  assert.ok(fissionInjection.includes('_objectRealityDebug.tsl_fission_unresolvable'));

  assert.ok(fissionSecondPass.includes('const _fissionQuarantine = [];'));
  assert.ok(fissionSecondPass.includes("transfer_origin:   'fission_successor'"));
  assert.ok(fissionSecondPass.includes('await ObjectHelper.run'));
  assert.ok(fissionSecondPass.includes('_objectRealityDebug.fission_successors_injected++'));
  assert.ok(fissionSecondPass.includes('_objectRealityDebug.fission_retired++'));
  assert.ok(fissionSecondPass.includes('_objectRealityDebug.audit'));
  assert.ok(fissionSecondPass.includes('[NARRATE] FissionPass:'));
});

test('V21: raw and normalized extraction witnesses remain visible with observation counts', async () => {
  const gameState = extractionExecutorState();
  const event = extractionEvent();
  const { result } = await runPhaseBWithStub({
    payload: baseCbPayload({ extraction_events: [event] }),
    narration: event.evidence,
    gameState
  });

  assert.deepEqual(result.extraction_events, [event]);
  assert.deepEqual(result.extracted.extraction_events, [event]);

  const normalized = SemanticNormalizer.analyze(
    result,
    event.evidence,
    'take',
    { referenced_objects: ['cloth roll'], input_type: 'action' },
    gameState
  );
  assert.equal(normalized.tsl.extraction_operations.length, 1);
  const operation = normalized.tsl.extraction_operations[0];
  assert.equal(operation.source_object_id, 'extraction_source');
  assert.equal(operation.evidence, event.evidence);
  assert.equal(operation.unresolved, false);
  assert.equal(operation.ambiguous, false);
  assert.equal(operation.product.name, event.product_name);
  assert.equal(operation.product.container_type, 'player');
  assert.equal(operation.product.container_id, 'player');

  const beforeOperations = clone(normalized.tsl.extraction_operations);
  const observation = await runExtractionObservationBlock({
    gameState,
    operations: normalized.tsl.extraction_operations,
    debug: extractionObservationDebug(normalized.tsl.extraction_operations)
  });

  assert.deepEqual(observation.calls, []);
  assert.deepEqual(observation.operations, beforeOperations);
  assert.deepEqual(observation.debug.tsl.extraction_operations, beforeOperations);
  assert.equal(observation.debug.tsl_extraction_observed, beforeOperations.length);
  assert.equal(observation.debug.tsl_extraction_unresolvable, 0);
  assert.equal(observation.debug.tsl_extraction_injected ?? 0, 0);
});

test('V22: extraction renderer source prefers observations and contains an explicit legacy fallback', () => {
  const source = readSource('Index.html');
  const extractionRenderer = sourceSlice(
    source,
    '      // ── 2. TLS section',
    '      // partial_split successor ID set',
    'TLS extraction renderer'
  );

  assert.ok(extractionRenderer.includes('tsl_extraction_observed'));
  assert.ok(extractionRenderer.includes("Object.hasOwn(or, 'tsl_extraction_observed')"));
  assert.ok(extractionRenderer.includes('tsl_extraction_injected'));
  assert.ok(extractionRenderer.includes('extraction-legacy-injected'));
  assert.ok(extractionRenderer.includes('[witness/analysis]'));
  assert.ok(extractionRenderer.includes('op.unresolved'));
  assert.ok(extractionRenderer.includes('op.ambiguous'));
  assert.ok(extractionRenderer.includes('op.quantity_unresolved'));
  assert.equal(extractionRenderer.includes("op.degrades_to_fission ? '[fission]' : '[partial_split]'"), false);
});

test('V22: current extraction diagnostics render witnesses with unresolved and ambiguity markers', () => {
  const operations = [
    extractionOperation({
      source_ref: 'cloth roll',
      source_object_id: 'extraction_source',
      current_quantity: 4,
      extracted_quantity: 1,
      extracted_unit: 'strip',
      new_source_quantity: 3,
      degrades_to_fission: false
    }),
    extractionOperation({
      source_ref: 'mystery roll',
      source_object_id: null,
      current_quantity: null,
      extracted_quantity: null,
      extracted_unit: null,
      new_source_quantity: null,
      unresolved: true,
      ambiguous: true,
      quantity_unresolved: true,
      product: {
        name: 'mystery strip',
        quantity: 1,
        unit: null,
        container_type: 'player',
        container_id: 'player'
      }
    })
  ];
  const rendered = renderObjectRealityLog({
    cb_candidates: [],
    cb_transfers: [],
    audit: [],
    error_entries: [],
    tsl_extraction_observed: 2,
    tsl_extraction_unresolvable: 1,
    tsl_extraction_injected: 0,
    tsl_fission_injected: 1,
    tsl_fission_unresolvable: 0,
    tsl: { extraction_operations: operations },
    ran: false,
    skip_reason: 'empty_quarantine',
    fission_retired: 0
  });

  assert.ok(rendered.entry.includes('TLS: extraction-witnesses:2 unresolvable:1 | fission:1'));
  assert.equal((rendered.entry.match(/\[witness\/analysis\]/g) || []).length, 2);
  assert.ok(rendered.entry.includes('[unresolved]'));
  assert.ok(rendered.entry.includes('[ambiguous]'));
  assert.ok(rendered.entry.includes('[qty-unresolved]'));
  assert.equal(rendered.entry.includes('[partial_split]'), false);
  assert.equal(rendered.entry.includes('accounted'), false);
  assert.equal(rendered.entry.includes('unsupported'), false);
  assert.equal(rendered.textContent, rendered.entry);
});

test('V22: archived injection-only diagnostics use a legacy label while fission rendering is unchanged', () => {
  const rendered = renderObjectRealityLog({
    cb_candidates: [],
    cb_transfers: [],
    audit: [{
      action: 'promoted',
      object_id: 'fission_child',
      object_name: 'cloth halves',
      parent_object_id: 'fission_parent',
      container_type: 'localspace',
      container_id: 'room_1'
    }],
    error_entries: [],
    tsl_extraction_injected: 2,
    tsl_extraction_unresolvable: 1,
    tsl_fission_injected: 1,
    tsl_fission_unresolvable: 0,
    tsl: {
      extraction_operations: [extractionOperation({
        source_ref: 'cloth roll',
        source_object_id: 'extraction_source',
        current_quantity: 4,
        extracted_quantity: 1,
        extracted_unit: 'strip',
        new_source_quantity: 3
      })]
    },
    ran: false,
    skip_reason: 'empty_quarantine',
    fission_retired: 1,
    fission_successors_injected: 1
  });

  assert.ok(rendered.entry.includes('TLS: extraction-legacy-injected:2 unresolvable:1 | fission:1'));
  assert.ok(rendered.entry.includes('[legacy extraction]'));
  assert.ok(rendered.entry.includes('Fission: retired:1  successors:1'));
  assert.ok(rendered.entry.includes(
    '[fission] [fission_child] "cloth halves" promoted -> localspace:room_1  (parent:fission_parent)'
  ));
});

test('V2 baseline: DROP and THROW metadata are receipt-gated, sanitized, and removed from extracted', async () => {
  const gameState = baseGameState();
  addDropThrowReceiptObjects(gameState);
  const narration = 'The dull token lands face-up. The chalk piece shows a powdery chipped edge.';
  const independentEvent = extractionEvent({
    evidence: 'A separate cloth strip is torn from the cloth roll'
  });
  const payload = baseCbPayload({
    extraction_events: [independentEvent],
    partial_drop_successor_description: {
      description: 'a dull bronze token lying face-up',
      evidence: 'dull token lands face-up'
    },
    partial_throw_successor_description: {
      description: 'a chalk piece with a powdery chipped edge',
      evidence: 'chalk piece shows a powdery chipped edge'
    }
  });

  const accepted = await runPhaseBWithStub({
    payload,
    narration,
    gameState,
    options: {
      tlsPartialStackDropReceipt: receipt('drop'),
      tlsPartialStackThrowReceipt: receipt('throw')
    }
  });

  assert.deepEqual(accepted.result.partial_drop_successor_description, payload.partial_drop_successor_description);
  assert.deepEqual(accepted.result.partial_throw_successor_description, payload.partial_throw_successor_description);
  assert.equal(Object.hasOwn(accepted.result.extracted, 'partial_drop_successor_description'), false);
  assert.equal(Object.hasOwn(accepted.result.extracted, 'partial_throw_successor_description'), false);
  assert.deepEqual(accepted.result.extraction_events, [independentEvent]);
  assert.ok(accepted.result.prompt.includes('"partial_drop_successor_description"'));
  assert.ok(accepted.result.prompt.includes('"partial_throw_successor_description"'));
  assert.ok(accepted.result.prompt.includes('PARTIAL DROP RECEIPT PRECEDENCE'));
  assert.ok(accepted.result.prompt.includes('PARTIAL THROW RECEIPT PRECEDENCE'));

  const noReceiptState = baseGameState();
  const rejected = await runPhaseBWithStub({
    payload,
    narration,
    gameState: noReceiptState
  });

  assert.equal(rejected.result.partial_drop_successor_description, null);
  assert.equal(rejected.result.partial_throw_successor_description, null);
  assert.equal(Object.hasOwn(rejected.result.extracted, 'partial_drop_successor_description'), false);
  assert.equal(Object.hasOwn(rejected.result.extracted, 'partial_throw_successor_description'), false);
  assert.deepEqual(rejected.result.extraction_events, [independentEvent]);
  assert.equal(rejected.result.prompt.includes('"partial_drop_successor_description"'), false);
  assert.equal(rejected.result.prompt.includes('"partial_throw_successor_description"'), false);
});

test('V2 baseline: candidate reason and normalized extraction evidence are available for later correlation', () => {
  const gameState = baseGameState();
  gameState.objects.cloth_roll = {
    id: 'cloth_roll',
    name: 'cloth roll',
    description: 'a thick roll of red cloth',
    status: 'active',
    quantity: 4,
    unit: 'strip',
    current_container_type: 'player',
    current_container_id: 'player'
  };
  gameState.player.object_ids.push('cloth_roll');

  const candidate = correlationCandidate();
  const event = extractionEvent();
  const phaseBResult = baseCbPayload({
    object_candidates: [candidate],
    extraction_events: [event]
  });
  const normalized = SemanticNormalizer.analyze(
    phaseBResult,
    'tear a strip from the cloth roll',
    'take',
    { referenced_objects: ['cloth roll'], input_type: 'action' },
    gameState
  );

  assert.equal(phaseBResult.object_candidates[0].reason, candidate.reason);
  assert.equal(normalized.tsl.stage, 'observe');
  assert.equal(normalized.tsl.extraction_operations.length, 1);
  assert.equal(normalized.tsl.extraction_operations[0].evidence, event.evidence);
  assert.equal(normalized.tsl.extraction_operations[0].product.name, event.product_name);
  assert.equal(normalized.tsl.extraction_operations[0].product.container_type, 'player');
  assert.equal(normalized.tsl.extraction_operations[0].product.container_id, 'player');
});

test('V2 scaffolding: adversarial fixtures independently vary evidence, container, and completeness', () => {
  const operation = extractionOperation();
  const exactCandidate = correlationCandidate();
  const differentEvidence = correlationCandidate({ reason: 'A second cloth strip was already in my hand' });
  const differentContainer = correlationCandidate({
    container_type: 'localspace',
    container_id: 'room_1'
  });
  const missingEvidence = correlationCandidate({ reason: '' });
  const indistinguishable = correlationCandidate({ temp_ref: 'duplicate_signal_tuple' });

  assert.equal(exactCandidate.name, operation.product.name);
  assert.equal(exactCandidate.container_type, operation.product.container_type);
  assert.equal(exactCandidate.container_id, operation.product.container_id);
  assert.equal(exactCandidate.reason, operation.evidence);
  assert.notEqual(differentEvidence.reason, operation.evidence);
  assert.notEqual(differentContainer.container_type, operation.product.container_type);
  assert.equal(missingEvidence.reason, '');
  assert.equal(indistinguishable.name, exactCandidate.name);
  assert.equal(indistinguishable.container_type, exactCandidate.container_type);
  assert.equal(indistinguishable.container_id, exactCandidate.container_id);
  assert.equal(indistinguishable.reason, exactCandidate.reason);
});

test('V2 source boundary: TAKE description lifecycle and candidate fallback anchors remain bounded', () => {
  const source = readSource('index.js');
  const takeDescriptionLifecycle = sourceSlice(
    source,
    '      const _phaseBResult = await CB.runPhaseB',
    '      // #17 — surviving-source description normalization.',
    'TAKE description lifecycle'
  );
  const candidateGate = sourceSlice(
    source,
    '        // Extraction candidate denial guard:',
    '        // v1.91.70: P5-A1 CB candidate promotion guard',
    'extraction candidate gate'
  );

  assert.ok(takeDescriptionLifecycle.includes('tlsPartialStackTakeReceipt'));
  assert.ok(takeDescriptionLifecycle.includes('ObjectHelper.setObjectDescriptionDirect'));
  assert.ok(source.includes('_normalizePartialSplitSourceDescription(gameState, _tlsPartialDescriptionTarget)'));
  assert.ok(candidateGate.includes('_isExtractionWitnessCorrelatedCandidate'));
  assert.ok(candidateGate.includes('candidate?.reason'));
  assert.ok(candidateGate.includes('candidate?.container_type'));
  assert.ok(candidateGate.includes('_objectRealityDebug.cb_extraction_suppressed'));
  assert.ok(candidateGate.includes('_dropDryRunSealActive'));
});

test('V2 source boundary: extraction observation accounting is isolated between unchanged fission anchors', () => {
  const source = readSource('index.js');
  const fissionInjectionStart = source.indexOf('        // v1.90.02: TLS fission injection');
  const extractionStart = source.indexOf('        // v1.91.03: TLS extraction observation accounting.');
  const fissionSecondPassStart = source.indexOf('        // v1.85.8: Fission second pass', extractionStart);
  assert.notEqual(fissionInjectionStart, -1, 'preceding fission injection anchor must exist');
  assert.notEqual(extractionStart, -1, 'extraction observation anchor must exist');
  assert.notEqual(fissionSecondPassStart, -1, 'following fission second-pass anchor must exist');
  assert.ok(fissionInjectionStart < extractionStart);
  assert.ok(extractionStart < fissionSecondPassStart);

  const extractionBlock = source.slice(extractionStart, fissionSecondPassStart);
  assert.ok(extractionBlock.includes('_objectRealityDebug.tsl_extraction_observed'));
  assert.ok(extractionBlock.includes('_objectRealityDebug.tsl_extraction_injected'));
  assert.ok(extractionBlock.includes('_objectRealityDebug.tsl_extraction_unresolvable'));
  assert.equal(extractionBlock.includes('ObjectHelper.'), false);
  assert.equal(extractionBlock.includes('_retirementPairs'), false);
  assert.equal(extractionBlock.includes("'partial_split'"), false);

  const continuitySource = readSource('ContinuityBrain.js');
  assert.ok(continuitySource.includes('PARTIAL DROP SUCCESSOR DESCRIPTION'));
  assert.ok(continuitySource.includes('PARTIAL THROW SUCCESSOR DESCRIPTION'));
  assert.ok(continuitySource.includes('When a portion of a tracked object is removed while the SOURCE PERSISTS'));
});

test('V3: accepted TAKE receipt prompt uses dedicated metadata and forbids replay channels', async () => {
  const gameState = baseGameState();
  addTakeReceiptObjects(gameState);
  const narration = 'I take a narrow red cloth strip with a frayed edge.';
  const { result } = await runPhaseBWithStub({
    payload: baseCbPayload({ partial_take_successor_description: takeMetadata() }),
    narration,
    gameState,
    options: { tlsPartialStackTakeReceipt: takeReceipt() }
  });

  assert.ok(result.prompt.includes('"partial_take_successor_description"'));
  assert.ok(result.prompt.includes('PARTIAL TAKE SUCCESSOR DESCRIPTION'));
  assert.ok(result.prompt.includes('Emit no `object_candidates`, `object_transfers`, `extraction_events`, `fission_events`, or `object_retirements` for that operation.'));
  assert.ok(result.prompt.includes('The only permitted receipt-governed output is `partial_take_successor_description`'));
  assert.equal(result.prompt.includes('Emit exactly one `extraction_events` entry for that operation'), false);
  assert.ok(result.prompt.includes('When a portion of a tracked object is removed while the SOURCE PERSISTS'));
});

test('V4: valid TAKE metadata sanitizes separately and preserves unrelated extraction evidence', async () => {
  const gameState = baseGameState();
  addTakeReceiptObjects(gameState);
  const narration = 'I take a narrow red cloth strip with a frayed edge while another strip is torn from a canvas roll.';
  const metadata = takeMetadata({
    description: '  a narrow red cloth strip with a frayed edge  ',
    evidence: '  narrow red cloth strip with a frayed edge  '
  });
  const unrelatedEvent = extractionEvent({
    source_ref: 'canvas roll',
    product_name: 'canvas strip',
    evidence: 'another strip is torn from a canvas roll'
  });
  const { result } = await runPhaseBWithStub({
    payload: baseCbPayload({
      extraction_events: [unrelatedEvent],
      partial_take_successor_description: metadata
    }),
    narration,
    gameState,
    options: { tlsPartialStackTakeReceipt: takeReceipt() }
  });

  assert.deepEqual(result.partial_take_successor_description, {
    description: metadata.description.trim(),
    evidence: metadata.evidence.trim()
  });
  assert.equal(Object.hasOwn(result.extracted, 'partial_take_successor_description'), false);
  assert.deepEqual(result.extraction_events, [unrelatedEvent]);
  assert.deepEqual(result.extracted.extraction_events, [unrelatedEvent]);
});

test('V5: invalid TAKE metadata is inert at producer and consumer boundaries', async () => {
  const invalidCases = [
    { label: 'missing receipt', options: {}, metadata: takeMetadata() },
    { label: 'empty description', options: { tlsPartialStackTakeReceipt: takeReceipt() }, metadata: takeMetadata({ description: '  ' }) },
    { label: 'empty evidence', options: { tlsPartialStackTakeReceipt: takeReceipt() }, metadata: takeMetadata({ evidence: '  ' }) },
    { label: 'non-verbatim evidence', options: { tlsPartialStackTakeReceipt: takeReceipt() }, metadata: takeMetadata({ evidence: 'words absent from narration' }) },
    { label: 'parent-equal description', options: { tlsPartialStackTakeReceipt: takeReceipt() }, metadata: takeMetadata({ description: '  THREE FOLDED RED CLOTH STRIPS  ' }) }
  ];

  for (const fixture of invalidCases) {
    const gameState = baseGameState();
    addTakeReceiptObjects(gameState);
    const { result } = await runPhaseBWithStub({
      payload: baseCbPayload({ partial_take_successor_description: fixture.metadata }),
      narration: 'I take a narrow red cloth strip with a frayed edge.',
      gameState,
      options: fixture.options
    });
    assert.equal(result.partial_take_successor_description, null, fixture.label);
    assert.equal(Object.hasOwn(result.extracted, 'partial_take_successor_description'), false, fixture.label);
    assert.equal(gameState.objects.take_successor.description, '', fixture.label);
  }

  const consume = loadTakeConsumerHarness();
  const gameState = baseGameState();
  addTakeReceiptObjects(gameState);
  const writes = [];
  const phaseBResult = { partial_take_successor_description: takeMetadata() };
  consume({
    gameState,
    turnNumber: 2,
    ObjectHelper: descriptionObjectHelper(writes),
    phaseBResult,
    receipt: takeReceipt({ turn_number: 1 }),
    receiptState: 'accepted'
  });
  assert.deepEqual(writes, []);
  assert.equal(gameState.objects.take_successor.description, '');
  assert.equal(Object.hasOwn(phaseBResult, 'partial_take_successor_description'), false);
});

test('V6: TAKE metadata consumer writes only the exact live receipt successor', () => {
  const consume = loadTakeConsumerHarness();
  const gameState = baseGameState();
  addTakeReceiptObjects(gameState);
  const sourceBefore = gameState.objects.take_source.description;
  const decoyBefore = gameState.objects.take_decoy.description;
  const writes = [];
  const phaseBResult = { partial_take_successor_description: takeMetadata() };

  consume({
    gameState,
    turnNumber: 2,
    ObjectHelper: descriptionObjectHelper(writes),
    phaseBResult,
    receipt: takeReceipt(),
    receiptState: 'accepted'
  });

  assert.deepEqual(writes, [{
    objectId: 'take_successor',
    description: takeMetadata().description
  }]);
  assert.equal(gameState.objects.take_successor.description, takeMetadata().description);
  assert.equal(gameState.objects.take_source.description, sourceBefore);
  assert.equal(gameState.objects.take_decoy.description, decoyBefore);
  assert.equal(Object.hasOwn(phaseBResult, 'partial_take_successor_description'), false);
});

test('V7: authoritative partial-TAKE split semantics and source-normalization anchors remain unchanged', () => {
  const gameState = {
    turn_history: [{ turn: 1 }],
    world: {},
    player: { object_ids: [] },
    objects: {
      split_source: {
        id: 'split_source',
        name: 'cloth strips',
        description: 'three folded red cloth strips',
        status: 'active',
        quantity: 3,
        unit: 'strip',
        current_container_type: 'localspace',
        current_container_id: 'room_1',
        events: []
      }
    }
  };

  const split = ObjectHelper.splitObjectDirect(
    gameState,
    'split_source',
    1,
    'player',
    'player',
    2,
    'tls_partial_stack_take'
  );
  assert.equal(split.ok, true);
  assert.equal(split.source_object_id, 'split_source');
  assert.equal(split.applied_quantity, 1);
  assert.equal(split.source_quantity_before, 3);
  assert.equal(split.source_quantity_after, 2);
  assert.equal(split.dest_container_type, 'player');
  assert.equal(split.dest_container_id, 'player');

  const source = gameState.objects.split_source;
  const successor = gameState.objects[split.successor_object_id];
  assert.equal(source.quantity, 2);
  assert.equal(source.status, 'active');
  assert.equal(source.current_container_type, 'localspace');
  assert.equal(source.current_container_id, 'room_1');
  assert.equal(successor.parent_object_id, 'split_source');
  assert.equal(successor.quantity, 1);
  assert.equal(successor.status, 'active');
  assert.equal(successor.current_container_type, 'player');
  assert.equal(successor.current_container_id, 'player');
  assert.ok(gameState.player.object_ids.includes(split.successor_object_id));

  const indexSource = readSource('index.js');
  assert.ok(indexSource.includes('_normalizePartialSplitSourceDescription(gameState, _tlsPartialDescriptionTarget)'));
  assert.ok(indexSource.includes('_normalizePartialSplitSourceDescription(gameState, _tlsPartialStackDropDescriptionTarget)'));
  assert.ok(indexSource.includes('_normalizePartialSplitSourceDescription(gameState, _tlsPartialStackThrowDescriptionTarget)'));
});

test('V8: resolved derived candidate is suppressed only by normalized three-signal correlation', () => {
  const operation = extractionOperation();
  const derived = correlationCandidate({
    temp_ref: 'derived',
    name: '  CLOTH   STRIP  ',
    reason: '  I   TEAR a narrow red strip from the cloth roll  '
  });
  const unrelated = correlationCandidate({
    temp_ref: 'unrelated',
    name: 'canvas scrap',
    reason: 'A canvas scrap lies beside the roll'
  });

  const result = runExtractionCandidateGate({
    candidates: [derived, unrelated],
    operations: [operation]
  });

  assert.deepEqual(result.candidates.map(candidate => candidate.temp_ref), ['unrelated']);
  assert.equal(result.debug.cb_extraction_suppressed, 1);
  assert.equal(result.logs.length, 1);
  assert.equal(result.logs[0].details.match, 'identity+container+evidence');
  assert.equal(/tls will|tls executes|successor/i.test(result.logs[0].message), false);

  const sealed = runExtractionCandidateGate({
    candidates: [derived],
    operations: [operation],
    dropDryRun: true
  });
  assert.deepEqual(sealed.candidates.map(candidate => candidate.temp_ref), ['derived']);
  assert.equal(sealed.debug.cb_extraction_suppressed ?? 0, 0);
});

test('V9: unresolved-source derived candidate cannot survive as a promotion fallback', () => {
  const operation = extractionOperation({ unresolved: true });
  const derived = correlationCandidate({
    temp_ref: 'unresolved_source_derived',
    name: 'strip'
  });

  const result = runExtractionCandidateGate({
    candidates: [derived],
    operations: [operation]
  });

  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.operations, [operation]);
  assert.equal(result.debug.cb_extraction_suppressed, 1);
});

test('V10: unresolved quantity and projected destination suppress only the same depicted event', () => {
  const operation = extractionOperation({
    unresolved: true,
    quantity_unresolved: true,
    product: {
      container_type: 'player',
      container_id: 'player'
    }
  });
  const derived = correlationCandidate({ temp_ref: 'derived' });
  const differentEvidence = correlationCandidate({
    temp_ref: 'different_evidence',
    reason: 'A cloth strip was already folded in my pocket'
  });
  const differentContainer = correlationCandidate({
    temp_ref: 'different_container',
    container_type: 'localspace',
    container_id: 'room_1'
  });

  const result = runExtractionCandidateGate({
    candidates: [derived, differentEvidence, differentContainer],
    operations: [operation]
  });

  assert.deepEqual(
    result.candidates.map(candidate => candidate.temp_ref),
    ['different_evidence', 'different_container']
  );
  assert.equal(result.debug.cb_extraction_suppressed, 1);
});

test('V11: same name and container with different evidence remains independent', () => {
  const independent = correlationCandidate({
    temp_ref: 'independent',
    reason: 'A separate cloth strip was already draped over my wrist'
  });

  const result = runExtractionCandidateGate({
    candidates: [independent],
    operations: [extractionOperation()]
  });

  assert.deepEqual(result.candidates.map(candidate => candidate.temp_ref), ['independent']);
  assert.equal(result.debug.cb_extraction_suppressed ?? 0, 0);
  assert.deepEqual(result.logs, []);
});

test('V12: same name and evidence in a different container remains independent', () => {
  const independent = correlationCandidate({
    temp_ref: 'different_container',
    container_type: 'localspace',
    container_id: 'room_1'
  });

  const result = runExtractionCandidateGate({
    candidates: [independent],
    operations: [extractionOperation()]
  });

  assert.deepEqual(result.candidates.map(candidate => candidate.temp_ref), ['different_container']);
  assert.equal(result.debug.cb_extraction_suppressed ?? 0, 0);
  assert.deepEqual(result.logs, []);
});

test('V13: distinguishable witnesses correlate without cross-event candidate collisions', () => {
  const firstOperation = extractionOperation({
    evidence: 'I tear a narrow red strip from the cloth roll'
  });
  const secondOperation = extractionOperation({
    evidence: 'I tear a broad blue strip from the canvas roll',
    product: {
      container_type: 'localspace',
      container_id: 'room_2'
    }
  });
  const firstDerived = correlationCandidate({ temp_ref: 'first_derived' });
  const secondDerived = correlationCandidate({
    temp_ref: 'second_derived',
    container_type: 'localspace',
    container_id: 'room_2',
    reason: secondOperation.evidence
  });
  const firstContainerSecondEvidence = correlationCandidate({
    temp_ref: 'first_container_second_evidence',
    reason: secondOperation.evidence
  });
  const secondContainerFirstEvidence = correlationCandidate({
    temp_ref: 'second_container_first_evidence',
    container_type: 'localspace',
    container_id: 'room_2',
    reason: firstOperation.evidence
  });

  const result = runExtractionCandidateGate({
    candidates: [
      firstDerived,
      secondDerived,
      firstContainerSecondEvidence,
      secondContainerFirstEvidence
    ],
    operations: [firstOperation, secondOperation]
  });

  assert.deepEqual(
    result.candidates.map(candidate => candidate.temp_ref),
    ['first_container_second_evidence', 'second_container_first_evidence']
  );
  assert.equal(result.debug.cb_extraction_suppressed, 2);
  assert.equal(result.logs.length, 2);
});

test('V14: missing candidate or operation evidence never authorizes suppression', () => {
  const missingCandidateEvidence = runExtractionCandidateGate({
    candidates: [correlationCandidate({ temp_ref: 'missing_candidate_evidence', reason: '   ' })],
    operations: [extractionOperation()]
  });
  assert.deepEqual(
    missingCandidateEvidence.candidates.map(candidate => candidate.temp_ref),
    ['missing_candidate_evidence']
  );
  assert.equal(missingCandidateEvidence.debug.cb_extraction_suppressed ?? 0, 0);

  const missingOperationEvidence = runExtractionCandidateGate({
    candidates: [correlationCandidate({ temp_ref: 'missing_operation_evidence' })],
    operations: [extractionOperation({ evidence: '   ' })]
  });
  assert.deepEqual(
    missingOperationEvidence.candidates.map(candidate => candidate.temp_ref),
    ['missing_operation_evidence']
  );
  assert.equal(missingOperationEvidence.debug.cb_extraction_suppressed ?? 0, 0);
});

test('V15: prompt routes source-surviving separation only to nonauthoritative extraction witnessing', async () => {
  const { result } = await runPhaseBWithStub({
    payload: baseCbPayload(),
    narration: 'I tear a narrow strip from the tracked cloth roll.',
    gameState: baseGameState()
  });

  assert.ok(result.prompt.includes('SOURCE-SURVIVING SEPARATION EXCLUSION:'));
  assert.ok(result.prompt.includes(
    'When a product\'s asserted existence depends on removal from a tracked source that persists'
  ));
  assert.match(
    result.prompt,
    /Report the depicted removal\s+only through `extraction_events` as a nonauthoritative witness\./
  );
  assert.ok(result.prompt.includes(
    'A validated authoritative partial-operation receipt overrides this generic witness route'
  ));
  assert.equal(
    result.prompt.includes('Exception: a named portion or sub-unit physically separated from a tracked divisible object this turn'),
    false
  );
  assert.equal(result.prompt.includes('The separated-subunit candidate exception does not apply'), false);
  assert.equal(result.prompt.includes('GROUP EXTRACTION RULE:'), false);
  assert.equal(result.prompt.includes('PROMOTE the extracted individual item as a new object'), false);
  assert.ok(result.prompt.includes('EXTRACTION EVENTS (optional)'));
  assert.ok(result.prompt.includes(
    'When a portion of a tracked object is removed while the SOURCE PERSISTS with altered quantity or state, emit an entry in extraction_events. This is a witness report only'
  ));
});

test('V16: ordinary candidates, founding, NPC objects, fission, transfers, and generic witnesses remain intact', async () => {
  const foundingState = baseGameState();
  foundingState.turn_history = [];
  const { result } = await runPhaseBWithStub({
    payload: baseCbPayload(),
    narration: 'A courier arrives with a satchel while a brass key rests on the table.',
    gameState: foundingState
  });

  const prompt = result.prompt;
  assert.ok(prompt.includes('OBJECT CANDIDATES (optional)'));
  assert.match(
    prompt,
    /A named object's passive presence in\s+the narration is sufficient reason to emit a candidate\./
  );
  assert.ok(prompt.includes('narrator_independent'));
  assert.ok(prompt.includes('FOUNDING TURN EXCEPTION:'));
  assert.ok(prompt.includes('FOUNDING TURN OVERRIDE:'));
  assert.ok(prompt.includes('inventory_items — array of objects for items the NPC is explicitly described as carrying.'));
  assert.ok(prompt.includes('worn_items      — array of objects for items the NPC is explicitly described as wearing.'));
  assert.ok(prompt.includes('FISSION EXCEPTION: Do not emit object_candidates for pieces, portions, fragments, or halves'));
  assert.ok(prompt.includes('FISSION EVENTS (optional)'));
  assert.ok(prompt.includes('OBJECT TRANSFERS (optional)'));
  assert.ok(prompt.includes('Identify objects that clearly changed hands or location in this narration.'));
  assert.ok(prompt.includes('words like "another", "new", "second", "fresh", or "different" signal a genuinely new object'));
  assert.ok(prompt.includes('EXTRACTION EVENTS (optional)'));
  assert.ok(prompt.includes('This is a witness report only — do not attempt to resolve object IDs.'));
});
