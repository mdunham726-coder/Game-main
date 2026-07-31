'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const REPO = path.resolve(__dirname, '..');
const { aliasScore } = require(path.join(REPO, 'ActionProcessor.js'));
const source = fs.readFileSync(path.join(REPO, 'authoritygate.js'), 'utf8').replace(/\r\n/g, '\n');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sourceSlice(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `start marker must exist: ${startMarker}`);
  assert.notEqual(end, -1, `end marker must exist: ${endMarker}`);
  assert.ok(end > start, 'source markers must be ordered');
  return source.slice(start, end);
}

const helperSandbox = { aliasScore };
vm.runInNewContext(
  `
    ${sourceSlice('function _historicalObjectNameMatches(', '// ── Post-LLM evidence validator')}
    globalThis.__resolveHistoricalObjectReceipt = _resolveHistoricalObjectReceipt;
  `,
  helperSandbox,
  { filename: 'authoritygate-historical-receipts.vm.js', timeout: 1000 }
);

function resolve(reference, state) {
  return clone(helperSandbox.__resolveHistoricalObjectReceipt(reference, state));
}

function baseState() {
  return {
    objects: {},
    player: {
      object_ids: [],
      worn_object_ids: [],
      position: { x: 2, y: 3 }
    },
    world: {
      current_depth: 1,
      position: { mx: 0, my: 0, lx: 0, ly: 0 },
      active_site: null,
      active_local_space: null,
      _visible_npcs: []
    },
    turn_history: []
  };
}

function objectRecord(id, type = 'player', containerId = 'player', status = 'active') {
  return {
    id,
    name: 'silver key',
    status,
    current_container_type: type,
    current_container_id: containerId
  };
}

function auditedEntry(action, id, name = 'silver key', tempRef = 'tmp_1') {
  const entry = {
    action,
    object_name: name,
    temp_ref: tempRef
  };
  if (action === 'promote_skipped_resolved_name_match') {
    entry.existing_object_id = id;
    entry.existing_object_name = name;
  } else {
    entry.object_id = id;
  }
  return entry;
}

function auditTurn(turnNumber, entry, options = {}) {
  const packetCandidates = options.packetCandidates ?? [];
  const visibleObjects = options.visibleObjects ?? [];
  const cbCandidates = options.cbCandidates ?? [];
  return {
    turn_number: turnNumber,
    narration_debug: {
      extraction_packet: {
        object_candidates: packetCandidates,
        visible_objects: visibleObjects
      }
    },
    object_reality: {
      cb_candidates: cbCandidates,
      audit: entry ? [entry] : []
    }
  };
}

function stateWithAuditedObject({
  id = 'obj_1',
  name = 'silver key',
  action = 'promoted',
  type = 'player',
  containerId = 'player',
  status = 'active',
  membership = true,
  turnNumber = 2
} = {}) {
  const state = baseState();
  state.objects[id] = { ...objectRecord(id, type, containerId, status), name };
  if (membership && type === 'player') state.player.object_ids.push(id);
  if (membership && type === 'player_worn') state.player.worn_object_ids.push(id);
  state.turn_history = [auditTurn(turnNumber, auditedEntry(action, id, name))];
  return state;
}

test('3.1 every eligible audit action resolves its documented ID field', () => {
  const actions = [
    'promote_suppressed_transfer_conflict',
    'promote_suppressed_transfer_name_collision',
    'promote_skipped_name_match',
    'promote_skipped_soft_match',
    'promote_skipped_token_subset',
    'promote_skipped_tsl_dedup',
    'promote_skipped_existing',
    'promote_skipped_resolved_name_match',
    'promoted'
  ];

  for (const [index, action] of actions.entries()) {
    const id = `obj_${index}`;
    const state = baseState();
    state.objects[id] = objectRecord(id);
    state.player.object_ids.push(id);
    const entry = auditedEntry(action, id, 'different audit label', 'shared_ref');
    state.turn_history = [auditTurn(2, entry, {
      packetCandidates: [{ name: 'silver key', temp_ref: 'shared_ref' }]
    })];
    const receipt = resolve('silver key', state);
    assert.equal(receipt.object_id, id, action);
    assert.deepEqual(receipt.candidate_object_ids, [id], action);
    assert.equal(receipt.outcome, 'resolved_available', action);
  }
});

test('3.2 repeated history for one ID is not ambiguous', () => {
  const state = stateWithAuditedObject({ id: 'obj_same' });
  state.turn_history.push(auditTurn(4, auditedEntry('promote_skipped_existing', 'obj_same')));
  const receipt = resolve('silver key', state);
  assert.equal(receipt.outcome, 'resolved_available');
  assert.deepEqual(receipt.candidate_object_ids, ['obj_same']);
  assert.deepEqual(receipt.matched_turns, [2, 4]);
});

test('3.3 competing identities fail closed as ambiguous', () => {
  const state = baseState();
  state.turn_history = [
    auditTurn(8, auditedEntry('promoted', 'obj_z')),
    auditTurn(3, auditedEntry('promoted', 'obj_a'))
  ];
  const receipt = resolve('silver key', state);
  assert.equal(receipt.outcome, 'ambiguous');
  assert.equal(receipt.reason_code, 'multiple_audited_object_ids');
  assert.deepEqual(receipt.candidate_object_ids, ['obj_a', 'obj_z']);
});

test('3.4 raw candidate without audit is unresolved', () => {
  const state = baseState();
  state.turn_history = [auditTurn(6, null, {
    packetCandidates: [{ name: 'silver key', temp_ref: 'raw_only' }]
  })];
  const receipt = resolve('silver key', state);
  assert.equal(receipt.outcome, 'unresolved');
  assert.equal(receipt.reason_code, 'historical_match_without_audited_identity');
  assert.deepEqual(receipt.matched_turns, [6]);
});

test('3.5 visible-only history is unresolved', () => {
  const state = baseState();
  state.turn_history = [auditTurn(5, null, {
    visibleObjects: [{ name: 'silver key' }]
  })];
  const receipt = resolve('silver key', state);
  assert.equal(receipt.outcome, 'unresolved');
  assert.deepEqual(receipt.candidate_object_ids, []);
});

test('3.6 no historical match is not_found', () => {
  const state = baseState();
  state.turn_history = [auditTurn(2, null, {
    packetCandidates: [{ name: 'bronze coin', temp_ref: 'other' }]
  })];
  const receipt = resolve('silver key', state);
  assert.equal(receipt.outcome, 'not_found');
  assert.equal(receipt.reason_code, 'no_historical_match');
  assert.deepEqual(receipt.matched_turns, []);
});

test('3.7 non-whitelisted audit action cannot bridge identity', () => {
  const state = baseState();
  state.turn_history = [auditTurn(2, {
    action: 'transferred',
    object_id: 'obj_1',
    object_name: 'silver key',
    temp_ref: 'tmp_1'
  })];
  const receipt = resolve('silver key', state);
  assert.equal(receipt.object_id, null);
  assert.deepEqual(receipt.candidate_object_ids, []);
});

test('3.8 substring collision cannot create identity', () => {
  const state = stateWithAuditedObject({ id: 'spring_1', name: 'spring' });
  const receipt = resolve('ring', state);
  assert.equal(receipt.outcome, 'not_found');
  assert.deepEqual(receipt.candidate_object_ids, []);
});

test('3.9 genuine token containment can identify from an audit-bearing turn', () => {
  const state = stateWithAuditedObject({ id: 'ring_1', name: 'gold ring' });
  const receipt = resolve('ring', state);
  assert.equal(receipt.object_id, 'ring_1');
  assert.equal(receipt.outcome, 'resolved_available');
});

test('3.10 missing ORS record is resolved_unavailable', () => {
  const state = baseState();
  state.turn_history = [auditTurn(2, auditedEntry('promoted', 'missing_1'))];
  const receipt = resolve('silver key', state);
  assert.equal(receipt.outcome, 'resolved_unavailable');
  assert.equal(receipt.reason_code, 'ors_record_missing');
  assert.equal(receipt.object_id, 'missing_1');
});

test('3.11 inactive ORS record is resolved_unavailable', () => {
  const state = stateWithAuditedObject({ status: 'retired' });
  const receipt = resolve('silver key', state);
  assert.equal(receipt.outcome, 'resolved_unavailable');
  assert.equal(receipt.reason_code, 'ors_record_inactive');
  assert.equal(receipt.current_status, 'retired');
});

test('3.12 player and worn scopes require exact membership and container pairs', () => {
  const inventoryValid = stateWithAuditedObject();
  assert.equal(resolve('silver key', inventoryValid).current_scope, 'player_inventory');

  const inventoryMissingMembership = stateWithAuditedObject({ membership: false });
  assert.equal(resolve('silver key', inventoryMissingMembership).outcome, 'resolved_unavailable');

  const inventoryWrongPair = stateWithAuditedObject({ containerId: 'wrong_player' });
  assert.equal(resolve('silver key', inventoryWrongPair).outcome, 'resolved_unavailable');

  const wornValid = stateWithAuditedObject({ type: 'player_worn', containerId: 'player_worn' });
  assert.equal(resolve('silver key', wornValid).current_scope, 'player_worn');

  const wornMissingMembership = stateWithAuditedObject({
    type: 'player_worn',
    containerId: 'player_worn',
    membership: false
  });
  assert.equal(resolve('silver key', wornMissingMembership).outcome, 'resolved_unavailable');

  const wornWrongPair = stateWithAuditedObject({ type: 'player_worn', containerId: 'wrong_worn' });
  assert.equal(resolve('silver key', wornWrongPair).outcome, 'resolved_unavailable');
});

test('3.13 current-ground scope is layer exact', () => {
  const l0 = stateWithAuditedObject({ type: 'grid', containerId: 'LOC:0,0:0,0', membership: false });
  assert.equal(resolve('silver key', l0).current_scope, 'current_ground');
  l0.objects.obj_1.current_container_id = 'LOC:9,9:9,9';
  assert.equal(resolve('silver key', l0).outcome, 'resolved_unavailable');

  const l1 = stateWithAuditedObject({ type: 'site', containerId: 'site_1:2,3', membership: false });
  l1.world.current_depth = 2;
  l1.world.active_site = { site_id: 'site_1', _visible_npcs: [] };
  assert.equal(resolve('silver key', l1).current_scope, 'current_ground');
  l1.objects.obj_1.current_container_type = 'grid';
  l1.objects.obj_1.current_container_id = 'LOC:0,0:0,0';
  assert.equal(resolve('silver key', l1).outcome, 'resolved_unavailable');

  const l2 = stateWithAuditedObject({ type: 'localspace', containerId: 'room_1', membership: false });
  l2.world.current_depth = 3;
  l2.world.active_site = { site_id: 'site_1', _visible_npcs: [] };
  l2.world.active_local_space = { local_space_id: 'room_1', _visible_npcs: [] };
  assert.equal(resolve('silver key', l2).current_scope, 'current_ground');
  l2.objects.obj_1.current_container_type = 'site';
  l2.objects.obj_1.current_container_id = 'site_1:2,3';
  assert.equal(resolve('silver key', l2).outcome, 'resolved_unavailable');
});

test('3.14 NPC-held scope requires current visibility and reverse membership', () => {
  const visibleMember = stateWithAuditedObject({
    type: 'npc',
    containerId: 'npc_1',
    membership: false
  });
  visibleMember.world._visible_npcs = [{ id: 'npc_1', object_ids: ['obj_1'] }];
  assert.equal(resolve('silver key', visibleMember).current_scope, 'visible_npc_held');

  const invisible = clone(visibleMember);
  invisible.world._visible_npcs = [];
  assert.equal(resolve('silver key', invisible).outcome, 'resolved_unavailable');

  const missingMembership = clone(visibleMember);
  missingMembership.world._visible_npcs[0].object_ids = [];
  assert.equal(resolve('silver key', missingMembership).outcome, 'resolved_unavailable');
});

test('3.15 npc_worn is not authorized', () => {
  const state = stateWithAuditedObject({
    type: 'npc_worn',
    containerId: 'npc_1',
    membership: false
  });
  state.world._visible_npcs = [{ id: 'npc_1', worn_object_ids: ['obj_1'] }];
  assert.equal(resolve('silver key', state).outcome, 'resolved_unavailable');
});

test('3.16 resolver is read-only for every outcome class', () => {
  const notFound = baseState();
  const unresolved = baseState();
  unresolved.turn_history = [auditTurn(2, null, {
    packetCandidates: [{ name: 'silver key', temp_ref: 'raw' }]
  })];
  const ambiguous = baseState();
  ambiguous.turn_history = [
    auditTurn(2, auditedEntry('promoted', 'obj_a')),
    auditTurn(3, auditedEntry('promoted', 'obj_b'))
  ];
  const unavailable = baseState();
  unavailable.turn_history = [auditTurn(2, auditedEntry('promoted', 'missing'))];
  const available = stateWithAuditedObject();

  for (const state of [notFound, unresolved, ambiguous, unavailable, available]) {
    const before = clone(state);
    resolve('silver key', state);
    assert.deepEqual(state, before);
  }
});

test('3.17 receipt schema and sorted arrays are exact and deterministic', () => {
  const state = baseState();
  state.turn_history = [
    auditTurn(5, auditedEntry('promoted', 'obj_z')),
    auditTurn(2, auditedEntry('promoted', 'obj_a')),
    auditTurn(5, auditedEntry('promote_skipped_existing', 'obj_z'))
  ];
  const receipt = resolve('Silver Key', state);
  assert.deepEqual(Object.keys(receipt), [
    'schema_version',
    'reference',
    'outcome',
    'reason_code',
    'object_id',
    'candidate_object_ids',
    'matched_turns',
    'current_status',
    'current_container_type',
    'current_container_id',
    'current_scope'
  ]);
  assert.equal(receipt.reference, 'Silver Key');
  assert.deepEqual(receipt.candidate_object_ids, ['obj_a', 'obj_z']);
  assert.deepEqual(receipt.matched_turns, [2, 5]);
});

const validatorSandbox = {
  aliasScore,
  console: { warn() {} },
  _hasCellMatch(gameState, target) {
    return Array.isArray(gameState?.__cellMatches) && gameState.__cellMatches.includes(target);
  }
};
vm.runInNewContext(
  `
    ${sourceSlice('function _historicalObjectNameMatches(', '// ── Post-LLM entity evidence validator')}
    globalThis.__validateReferencedObjects = _validateReferencedObjects;
  `,
  validatorSandbox,
  { filename: 'authoritygate-historical-validator.vm.js', timeout: 1000 }
);

function validate({
  references,
  state,
  inventoryNames = [],
  wornNames = [],
  parsedAction = 'examine'
}) {
  const result = {
    _llm_called: true,
    decision: 'allow_rc',
    route: 'reality_check',
    rc_allowed: true,
    input_type: 'player_attempt',
    reason_code: 'valid_player_action',
    referenced_objects: references,
    evidence: {}
  };
  return clone(validatorSandbox.__validateReferencedObjects(
    result,
    { inventoryNames, wornNames },
    state,
    parsedAction
  ));
}

test('4.1 resolved_available receipt preserves allow and is stored', () => {
  const result = validate({
    references: ['silver key'],
    state: stateWithAuditedObject()
  });
  assert.equal(result.decision, 'allow_rc');
  assert.deepEqual(result.evidence.supported_referenced_objects, []);
  assert.deepEqual(result.evidence.continuity_backed_objects, ['silver key']);
  assert.equal(result.evidence.historical_object_receipts.length, 1);
  assert.equal(result.evidence.historical_object_receipts[0].outcome, 'resolved_available');
});

test('4.2 every non-positive receipt outcome denies through the existing route', () => {
  const notFound = baseState();
  const unresolved = baseState();
  unresolved.turn_history = [auditTurn(2, null, {
    packetCandidates: [{ name: 'silver key', temp_ref: 'raw' }]
  })];
  const ambiguous = baseState();
  ambiguous.turn_history = [
    auditTurn(2, auditedEntry('promoted', 'obj_a')),
    auditTurn(3, auditedEntry('promoted', 'obj_b'))
  ];
  const unavailable = baseState();
  unavailable.turn_history = [auditTurn(2, auditedEntry('promoted', 'missing'))];

  for (const [expectedOutcome, state] of [
    ['not_found', notFound],
    ['unresolved', unresolved],
    ['ambiguous', ambiguous],
    ['resolved_unavailable', unavailable]
  ]) {
    const result = validate({ references: ['silver key'], state });
    assert.equal(result.decision, 'freeform', expectedOutcome);
    assert.equal(result.route, 'freeform', expectedOutcome);
    assert.equal(result.rc_allowed, false, expectedOutcome);
    assert.equal(result.input_type, 'unsupported_world_authoring', expectedOutcome);
    assert.equal(result.reason_code, 'unsupported_referenced_object', expectedOutcome);
    assert.deepEqual(result.evidence.unsupported_referenced_objects, ['silver key'], expectedOutcome);
    assert.equal(result.evidence.historical_object_receipts[0].outcome, expectedOutcome);
  }
});

test('4.3 one non-positive reference denies a mixed-reference turn', () => {
  const result = validate({
    references: ['silver key', 'ghost orb'],
    state: stateWithAuditedObject()
  });
  assert.equal(result.decision, 'freeform');
  assert.deepEqual(result.evidence.continuity_backed_objects, ['silver key']);
  assert.deepEqual(result.evidence.unsupported_referenced_objects, ['ghost orb']);
  assert.deepEqual(
    result.evidence.historical_object_receipts.map(receipt => receipt.outcome),
    ['resolved_available', 'not_found']
  );
});

test('4.4 Tier 1 precedence prevents historical resolver invocation for that reference', () => {
  const state = baseState();
  state.turn_history = [
    auditTurn(2, auditedEntry('promoted', 'obj_a')),
    auditTurn(3, auditedEntry('promoted', 'obj_b'))
  ];
  const result = validate({
    references: ['silver key'],
    state,
    inventoryNames: ['silver key']
  });
  assert.equal(result.decision, 'allow_rc');
  assert.deepEqual(result.evidence.supported_referenced_objects, ['silver key']);
  assert.deepEqual(result.evidence.historical_object_receipts, []);
});

test('4.5 take exemption preserves behavior and initializes receipts empty', () => {
  const state = stateWithAuditedObject();
  state._lastParsedTarget = 'silver key';
  const result = validate({
    references: ['silver key'],
    state,
    parsedAction: 'take'
  });
  assert.equal(result.decision, 'allow_rc');
  assert.equal(result.evidence.take_exemption_applied, true);
  assert.deepEqual(result.evidence.historical_object_receipts, []);
  assert.equal(
    result.evidence.referenced_object_support_basis,
    'deterministic_post_llm_check__tiered_v4_historical_receipts'
  );
});

test('4.6 internal resolver error fails closed with resolver_error receipt', () => {
  const state = baseState();
  Object.defineProperty(state, 'turn_history', {
    configurable: true,
    get() {
      throw new Error('forced history read failure');
    }
  });
  const result = validate({ references: ['silver key'], state });
  assert.equal(result.decision, 'freeform');
  assert.equal(result.evidence.historical_object_receipts[0].outcome, 'unresolved');
  assert.equal(result.evidence.historical_object_receipts[0].reason_code, 'resolver_error');
});

test('4.7 raw Tier-2 archive authorization loop is absent from the validator', () => {
  const validatorSource = sourceSlice(
    'function _validateReferencedObjects(',
    '// ── Post-LLM entity evidence validator'
  );
  assert.equal(validatorSource.includes('let tier2'), false);
  assert.equal(validatorSource.includes('packet.object_candidates'), false);
  assert.equal(validatorSource.includes('packet.visible_objects'), false);
  assert.equal(validatorSource.includes('packet.environmental_features'), false);
  assert.equal(
    (validatorSource.match(/_resolveHistoricalObjectReceipt\(ref, gameState\)/g) || []).length,
    1
  );
});
