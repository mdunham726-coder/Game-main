'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const REPO = path.resolve(__dirname, '..');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalize(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadAlignmentAssembler() {
  const source = fs.readFileSync(path.join(REPO, 'index.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf('function _assembleTlsOrsAlignment(');
  const end = source.indexOf('\n    // v1.91.21: ItemOperationWitness', start);
  assert.notEqual(start, -1, 'alignment assembler declaration must exist');
  assert.notEqual(end, -1, 'alignment assembler end marker must exist');

  const sandbox = {};
  vm.runInNewContext(
    `${source.slice(start, end)}\nglobalThis.__ALIGN = _assembleTlsOrsAlignment;`,
    sandbox,
    { filename: 'tls-ors-alignment-contract.vm.js', timeout: 1000 }
  );
  assert.equal(typeof sandbox.__ALIGN, 'function');
  return sandbox.__ALIGN;
}

const assemble = loadAlignmentAssembler();

function baseWitness(overrides = {}) {
  return {
    ap_env_gather_synthetic: null,
    ap_env_gather_source_object_id: null,
    ap_executed_transfer_count: 0,
    ap_executed_transfer_ids: [],
    target_object_id: null,
    target_object_name: null,
    target_object_status: null,
    target_object_prior_container_type: null,
    target_object_prior_container_id: null,
    target_object_container_type: null,
    target_object_container_id: null,
    ...overrides
  };
}

function baseV0(family = 'drop') {
  return {
    operation_id: 'tls_op_2',
    operation_family: family,
    operation_type: null,
    object: { id: null },
    source: { container_type: null, container_id: null },
    destination: { container_type: null, owner_type: null },
    quantity: { mode: 'unspecified' }
  };
}

function baseV1(family = 'drop') {
  return {
    operation_family: family,
    operation_type: 'whole_object_transfer',
    object: { id: 'obj_1', name: 'token' },
    source: { container_type: 'player', container_id: 'player' },
    destination: { container_type: 'grid', container_id: 'cell_1', owner_type: 'world' },
    quantity: { quantity_mode: 'exact' }
  };
}

function baseReceipt() {
  return {
    operation_id: 'tls_op_2',
    mode: 'live_execution',
    executed_by: 'tls',
    object: { id: 'obj_1', name: 'token' },
    source: { container_type: 'player', container_id: 'player' },
    destination: { container_type: 'grid', container_id: 'cell_1' },
    transfer: { result: 'success', error: null }
  };
}

function basePostObject() {
  return {
    id: 'obj_1',
    name: 'token',
    status: 'active',
    current_container_type: 'grid',
    current_container_id: 'cell_1'
  };
}

function runReceiptLane({ family = 'drop', mutateV1, mutateReceipt, mutatePost, postOverride } = {}) {
  const witness = baseWitness();
  const v0 = baseV0(family);
  const v1 = baseV1(family);
  const receipt = baseReceipt();
  let post = basePostObject();
  if (mutateV1) mutateV1(v1);
  if (mutateReceipt) mutateReceipt(receipt);
  if (postOverride !== undefined) post = postOverride;
  if (mutatePost && post) mutatePost(post);
  return {
    inputs: { witness, v0, v1, receipt, post },
    result: normalize(assemble(witness, v0, v1, receipt, post))
  };
}

for (const family of ['drop', 'throw']) {
  test(`successful whole ${family.toUpperCase()} uses receipt-backed matched alignment`, () => {
    const { result } = runReceiptLane({ family });
    assert.equal(result.status, 'matched');
    assert.equal(result.reason, null);
    assert.equal(result.scope, `${family}_tls_live_execution`);
    assert.equal(result.mode, 'diagnostic_only');
    assert.equal(result.non_authoritative, true);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.predicted, {
      operation_type: 'whole_object_transfer',
      operation_family: family,
      object_id: 'obj_1',
      source_container_type: 'player',
      source_container_id: 'player',
      dest_container_type: 'grid',
      dest_container_id: 'cell_1',
      dest_owner_type: 'world',
      quantity_mode: 'exact'
    });
    assert.deepEqual(result.observed, {
      object_id: 'obj_1',
      object_name: 'token',
      transfer_count: 1,
      transfer_ids: ['obj_1'],
      prior_container_type: 'player',
      prior_container_id: 'player',
      post_container_type: 'grid',
      post_container_id: 'cell_1',
      env_gather_synthetic: null,
      execution_evidence_source: 'tls_execution_result',
      ap_transfer_count: 0,
      ap_transfer_ids: [],
      post_object_status: 'active'
    });
    assert.deepEqual(result.checks, {
      same_object_id: true,
      source_container_type_matches: true,
      source_container_id_matches: true,
      dest_container_type_matches: true,
      dest_container_id_matches: true,
      transfer_count_matches: true,
      post_object_active: true,
      no_duplicate_evidence: null
    });
  });
}

for (const family of ['drop', 'throw']) {
  test(`observe-only ${family.toUpperCase()} preserves family dry-run label`, () => {
    const result = normalize(assemble(baseWitness(), baseV0(family), baseV1(family), null, null));
    assert.equal(result.status, 'not_executed');
    assert.equal(result.reason, `${family}_tls_dry_run_no_transfer_expected`);
    assert.equal(result.scope, `${family}_tls_dry_run`);
    assert.equal(result.observed.execution_evidence_source, null);
    assert.equal(result.checks.dest_container_id_matches, null);
    assert.equal(result.checks.post_object_active, null);
  });
}

const missingEvidenceCases = [
  {
    name: 'predicted object id', reason: 'missing_predicted_object_id', check: 'same_object_id',
    change: args => { delete args.v1.object.id; }
  },
  {
    name: 'receipt object id', reason: 'missing_receipt_object_id', check: 'same_object_id',
    change: args => { delete args.receipt.object.id; }
  },
  {
    name: 'post-execution object', reason: 'missing_post_execution_object', check: 'same_object_id',
    change: args => { args.post = null; }
  },
  {
    name: 'post object id', reason: 'missing_post_object_id', check: 'same_object_id',
    change: args => { delete args.post.id; }
  },
  {
    name: 'predicted source container type', reason: 'missing_predicted_source_container_type', check: 'source_container_type_matches',
    change: args => { delete args.v1.source.container_type; }
  },
  {
    name: 'receipt source container type', reason: 'missing_receipt_source_container_type', check: 'source_container_type_matches',
    change: args => { delete args.receipt.source.container_type; }
  },
  {
    name: 'predicted source container id', reason: 'missing_predicted_source_container_id', check: 'source_container_id_matches',
    change: args => { delete args.v1.source.container_id; }
  },
  {
    name: 'receipt source container id', reason: 'missing_receipt_source_container_id', check: 'source_container_id_matches',
    change: args => { delete args.receipt.source.container_id; }
  },
  {
    name: 'predicted destination container type', reason: 'missing_predicted_destination_container_type', check: 'dest_container_type_matches',
    change: args => { delete args.v1.destination.container_type; }
  },
  {
    name: 'receipt destination container type', reason: 'missing_receipt_destination_container_type', check: 'dest_container_type_matches',
    change: args => { delete args.receipt.destination.container_type; }
  },
  {
    name: 'post destination container type', reason: 'missing_post_container_type', check: 'dest_container_type_matches',
    change: args => { delete args.post.current_container_type; }
  },
  {
    name: 'predicted destination container id', reason: 'missing_predicted_destination_container_id', check: 'dest_container_id_matches',
    change: args => { delete args.v1.destination.container_id; }
  },
  {
    name: 'receipt destination container id', reason: 'missing_receipt_destination_container_id', check: 'dest_container_id_matches',
    change: args => { delete args.receipt.destination.container_id; }
  },
  {
    name: 'post destination container id', reason: 'missing_post_container_id', check: 'dest_container_id_matches',
    change: args => { delete args.post.current_container_id; }
  },
  {
    name: 'post object status', reason: 'missing_post_object_status', check: 'post_object_active',
    change: args => { delete args.post.status; }
  }
];

for (const fixture of missingEvidenceCases) {
  test(`missing ${fixture.name} returns ${fixture.reason}`, () => {
    const args = {
      witness: baseWitness(),
      v0: baseV0(),
      v1: baseV1(),
      receipt: baseReceipt(),
      post: basePostObject()
    };
    fixture.change(args);
    const result = normalize(assemble(args.witness, args.v0, args.v1, args.receipt, args.post));
    assert.equal(result.status, 'insufficient_evidence');
    assert.equal(result.reason, fixture.reason);
    assert.equal(result.evidence_basis, 'insufficient');
    assert.equal(result.checks[fixture.check], null);
    assert.deepEqual(result.warnings, [fixture.reason]);
  });
}

const mismatchCases = [
  {
    name: 'object identity', reason: 'object_id_mismatch', check: 'same_object_id',
    change: args => { args.receipt.object.id = 'obj_2'; args.post.id = 'obj_2'; }
  },
  {
    name: 'source container type', reason: 'source_container_type_mismatch', check: 'source_container_type_matches',
    change: args => { args.receipt.source.container_type = 'worn'; }
  },
  {
    name: 'source container id', reason: 'source_container_id_mismatch', check: 'source_container_id_matches',
    change: args => { args.receipt.source.container_id = 'other_player'; }
  },
  {
    name: 'destination container type', reason: 'destination_container_type_mismatch', check: 'dest_container_type_matches',
    change: args => { args.receipt.destination.container_type = 'site'; args.post.current_container_type = 'site'; }
  },
  {
    name: 'destination container id', reason: 'destination_container_id_mismatch', check: 'dest_container_id_matches',
    change: args => { args.receipt.destination.container_id = 'cell_2'; args.post.current_container_id = 'cell_2'; }
  },
  {
    name: 'post object active state', reason: 'post_execution_object_not_active', check: 'post_object_active',
    change: args => { args.post.status = 'retired'; }
  }
];

for (const fixture of mismatchCases) {
  test(`${fixture.name} mismatch returns ${fixture.reason}`, () => {
    const args = {
      witness: baseWitness(),
      v0: baseV0(),
      v1: baseV1(),
      receipt: baseReceipt(),
      post: basePostObject()
    };
    fixture.change(args);
    const result = normalize(assemble(args.witness, args.v0, args.v1, args.receipt, args.post));
    assert.equal(result.status, 'mismatched');
    assert.equal(result.reason, fixture.reason);
    assert.equal(result.evidence_basis, 'same_turn');
    assert.equal(result.checks[fixture.check], false);
    assert.deepEqual(result.warnings, [fixture.reason]);
  });
}

test('missing evidence outranks present mismatches', () => {
  const args = {
    witness: baseWitness(),
    v0: baseV0(),
    v1: baseV1(),
    receipt: baseReceipt(),
    post: basePostObject()
  };
  delete args.v1.source.container_type;
  args.receipt.object.id = 'obj_2';
  args.post.id = 'obj_2';
  const result = normalize(assemble(args.witness, args.v0, args.v1, args.receipt, args.post));
  assert.equal(result.status, 'insufficient_evidence');
  assert.equal(result.reason, 'missing_predicted_source_container_type');
});

test('earlier object mismatch outranks later destination mismatch', () => {
  const args = {
    witness: baseWitness(),
    v0: baseV0(),
    v1: baseV1(),
    receipt: baseReceipt(),
    post: basePostObject()
  };
  args.receipt.object.id = 'obj_2';
  args.post.id = 'obj_2';
  args.receipt.destination.container_id = 'cell_2';
  args.post.current_container_id = 'cell_2';
  const result = normalize(assemble(args.witness, args.v0, args.v1, args.receipt, args.post));
  assert.equal(result.status, 'mismatched');
  assert.equal(result.reason, 'object_id_mismatch');
});

test('AP-backed whole TAKE preserves existing behavior and uses AP provenance', () => {
  const witness = baseWitness({
    ap_executed_transfer_count: 1,
    ap_executed_transfer_ids: ['obj_take'],
    target_object_id: 'obj_take',
    target_object_name: 'sample',
    target_object_status: 'active',
    target_object_prior_container_type: 'grid',
    target_object_prior_container_id: 'cell_1',
    target_object_container_type: 'player',
    target_object_container_id: 'player'
  });
  const v0 = {
    operation_id: 'tls_op_3',
    operation_family: 'take',
    operation_type: 'whole_object_transfer',
    object: { id: 'obj_take' },
    source: { container_type: 'grid', container_id: 'cell_1' },
    destination: { container_type: 'player', owner_type: 'player' },
    quantity: { mode: 'unspecified' }
  };
  const result = normalize(assemble(witness, v0, null, null, null));
  assert.equal(result.status, 'matched');
  assert.equal(result.reason, null);
  assert.equal(result.scope, 'whole_object_take_known_ors_only');
  assert.deepEqual(result.warnings, []);
  assert.equal(result.observed.execution_evidence_source, 'ap_executed_transfers');
  assert.equal(result.observed.ap_transfer_count, 1);
  assert.deepEqual(result.observed.ap_transfer_ids, ['obj_take']);
  assert.equal(result.observed.post_object_status, 'active');
  assert.equal(result.predicted.dest_container_id, null);
  assert.equal(result.checks.dest_container_id_matches, null);
  assert.equal(result.checks.post_object_active, null);
});

test('generic non-object and synthetic gather branches are unchanged', () => {
  const generic = normalize(assemble(baseWitness(), baseV0('look'), null, null, null));
  assert.equal(generic.status, 'not_applicable');
  assert.equal(generic.reason, 'non_object_turn_no_transfer_expected');

  const synthetic = normalize(assemble(
    baseWitness({ ap_env_gather_synthetic: true }),
    baseV0('take'),
    null,
    null,
    null
  ));
  assert.equal(synthetic.status, 'skipped_non_transfer');
  assert.equal(synthetic.reason, 'synthetic_environmental_gather_no_transfer');
  assert.deepEqual(synthetic.warnings, ['synthetic_env_gather_detected']);
});

for (const family of ['drop', 'throw']) {
  test(`partial ${family.toUpperCase()} remains on existing non-live diagnostic path`, () => {
    const v1 = baseV1(family);
    v1.operation_type = 'partial_object_transfer';
    const result = normalize(assemble(baseWitness(), baseV0(family), v1, null, null));
    assert.equal(result.status, 'not_executed');
    assert.equal(result.reason, `${family}_tls_dry_run_no_transfer_expected`);
    assert.equal(result.scope, `${family}_tls_dry_run`);
  });
}

test('alignment assembler does not mutate any input', () => {
  const witness = baseWitness();
  const v0 = baseV0();
  const v1 = baseV1();
  const receipt = baseReceipt();
  const post = basePostObject();
  const before = clone({ witness, v0, v1, receipt, post });
  assemble(witness, v0, v1, receipt, post);
  assert.deepEqual({ witness, v0, v1, receipt, post }, before);
});

test('additive output schema contains only the approved fields', () => {
  const { result: receiptResult } = runReceiptLane();
  const witness = baseWitness({
    ap_executed_transfer_count: 1,
    ap_executed_transfer_ids: ['obj_1'],
    target_object_id: 'obj_1',
    target_object_name: 'token',
    target_object_status: 'active',
    target_object_prior_container_type: 'grid',
    target_object_prior_container_id: 'cell_1',
    target_object_container_type: 'player',
    target_object_container_id: 'player'
  });
  const takeV0 = {
    operation_id: 'tls_op_2', operation_family: 'take', operation_type: 'whole_object_transfer',
    object: { id: 'obj_1' },
    source: { container_type: 'grid', container_id: 'cell_1' },
    destination: { container_type: 'player', owner_type: 'player' },
    quantity: { mode: 'unspecified' }
  };
  const apResult = normalize(assemble(witness, takeV0, null, null, null));

  const predictedKeys = [
    'operation_type', 'operation_family', 'object_id', 'source_container_type',
    'source_container_id', 'dest_container_type', 'dest_container_id',
    'dest_owner_type', 'quantity_mode'
  ].sort();
  const observedKeys = [
    'object_id', 'object_name', 'transfer_count', 'transfer_ids',
    'prior_container_type', 'prior_container_id', 'post_container_type',
    'post_container_id', 'env_gather_synthetic', 'execution_evidence_source',
    'ap_transfer_count', 'ap_transfer_ids', 'post_object_status'
  ].sort();
  const checkKeys = [
    'same_object_id', 'source_container_type_matches', 'source_container_id_matches',
    'dest_container_type_matches', 'dest_container_id_matches',
    'transfer_count_matches', 'post_object_active', 'no_duplicate_evidence'
  ].sort();

  for (const result of [receiptResult, apResult]) {
    assert.deepEqual(Object.keys(result.predicted).sort(), predictedKeys);
    assert.deepEqual(Object.keys(result.observed).sort(), observedKeys);
    assert.deepEqual(Object.keys(result.checks).sort(), checkKeys);
  }
});
