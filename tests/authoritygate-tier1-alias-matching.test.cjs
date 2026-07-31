'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const REPO = path.resolve(__dirname, '..');
const { aliasScore } = require(path.join(REPO, 'ActionProcessor.js'));
const source = fs.readFileSync(path.join(REPO, 'authoritygate.js'), 'utf8').replace(/\r\n/g, '\n');

function sourceSlice(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `start marker must exist: ${startMarker}`);
  assert.notEqual(end, -1, `end marker must exist: ${endMarker}`);
  assert.ok(end > start, 'source markers must be ordered');
  return source.slice(start, end);
}

const sandbox = {
  aliasScore,
  console: { warn() {} },
  _hasCellMatch() { return false; },
  _resolveHistoricalObjectReceipt(reference) {
    return {
      schema_version: 'ag_historical_object_receipt_v1',
      reference,
      outcome: 'not_found',
      reason_code: 'no_historical_match',
      object_id: null,
      candidate_object_ids: [],
      matched_turns: [],
      current_status: null,
      current_container_type: null,
      current_container_id: null,
      current_scope: null
    };
  }
};
vm.runInNewContext(
  `
    ${sourceSlice('function _validateReferencedObjects(', '// ── Post-LLM entity evidence validator')}
    globalThis.__validateReferencedObjects = _validateReferencedObjects;
  `,
  sandbox,
  { filename: 'authoritygate-tier1-alias-matching.vm.js', timeout: 1000 }
);

function validate(reference, inventoryNames = [], wornNames = []) {
  const result = {
    _llm_called: true,
    decision: 'allow_rc',
    route: 'reality_check',
    rc_allowed: true,
    input_type: 'player_attempt',
    reason_code: 'valid_player_action',
    referenced_objects: [reference],
    evidence: {}
  };
  return sandbox.__validateReferencedObjects(
    result,
    { inventoryNames, wornNames },
    { player: {}, objects: {}, turn_history: [] },
    'examine'
  );
}

test('5.1 stored spring does not support ring by raw substring', () => {
  const result = validate('ring', ['spring']);
  assert.equal(result.decision, 'freeform');
  assert.deepEqual([...result.evidence.supported_referenced_objects], []);
});

test('5.2 stored monkey wrench does not support key by reverse substring', () => {
  const result = validate('key', ['monkey wrench']);
  assert.equal(result.decision, 'freeform');
  assert.deepEqual([...result.evidence.supported_referenced_objects], []);
});

test('5.3 genuine token containment remains supported', () => {
  const result = validate('ring', ['gold ring']);
  assert.equal(result.decision, 'allow_rc');
  assert.deepEqual([...result.evidence.supported_referenced_objects], ['ring']);
});

test('5.4 unaliased embellished reference is denied', () => {
  const result = validate('gold ring', ['ring']);
  assert.equal(result.decision, 'freeform');
  assert.deepEqual([...result.evidence.supported_referenced_objects], []);
});

test('5.5 inventory and worn branches both reject substring collisions', () => {
  const inventoryResult = validate('ring', ['spring'], []);
  const wornResult = validate('ring', [], ['spring']);
  assert.equal(inventoryResult.decision, 'freeform');
  assert.equal(wornResult.decision, 'freeform');
});
