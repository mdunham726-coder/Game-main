'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const REPO = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(REPO, 'index.js'), 'utf8').replace(/\r\n/g, '\n');

function sourceSlice(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `start marker must exist: ${startMarker}`);
  assert.notEqual(end, -1, `end marker must exist: ${endMarker}`);
  assert.ok(end > start, 'source markers must be ordered');
  return source.slice(start, end);
}

const authoritySource = sourceSlice(
  'const _agDeniedObjectReference =',
  '// v1.91.49: _entityGroundingBlock'
);

function renderAuthorityBlock(result, rawInput = 'interact with the referenced object') {
  const sandbox = {
    _authorityGateResult: result,
    _rawInput: rawInput
  };
  vm.runInNewContext(
    `${authoritySource}\n` +
      'globalThis.__authorityGateBlock = _authorityGateBlock;\n' +
      'globalThis.__agDeniedObjectReference = _agDeniedObjectReference;',
    sandbox,
    { filename: 'authoritygate-narrator-translation.vm.js', timeout: 1000 }
  );
  return {
    block: sandbox.__authorityGateBlock,
    deniedObjectReference: sandbox.__agDeniedObjectReference
  };
}

function receipt(reference, outcome, reasonCode, overrides = {}) {
  return {
    schema_version: 1,
    reference,
    outcome,
    reason_code: reasonCode,
    object_id: 'internal_object_identifier',
    candidate_object_ids: ['internal_candidate_identifier'],
    matched_turns: [2],
    current_status: 'active',
    current_container_type: 'localspace',
    current_container_id: 'internal_container_identifier',
    current_scope: null,
    ...overrides
  };
}

function unsupportedResult(references, receipts) {
  return {
    decision: 'freeform',
    route: 'freeform',
    rc_allowed: false,
    input_type: 'unsupported_world_authoring',
    reason_code: 'unsupported_referenced_object',
    evidence: {
      unsupported_referenced_objects: references,
      historical_object_receipts: receipts
    }
  };
}

test('V10 active-elsewhere translation preserves reality but denies current access', () => {
  const { block, deniedObjectReference } = renderAuthorityBlock(unsupportedResult(
    ['field instrument'],
    [receipt('field instrument', 'resolved_unavailable', 'ors_object_outside_current_scope')]
  ));
  assert.equal(deniedObjectReference, true);
  assert.match(block, /authoritative active object exists outside the current scope/i);
  assert.match(block, /Do not present it as here, held, accessible, physically interactable, or currently sensed/i);
  assert.match(block, /Recollection or discussion may refer to it as elsewhere/i);
  assert.doesNotMatch(block, /does not exist.*prior continuity/i);
});

test('V11 inactive translation permits only past reference and prohibits resurrection', () => {
  const { block } = renderAuthorityBlock(unsupportedResult(
    ['archived token'],
    [receipt('archived token', 'resolved_unavailable', 'ors_record_inactive', {
      current_status: 'retired'
    })]
  ));
  assert.match(block, /historical authoritative record exists but is inactive/i);
  assert.match(block, /Past reference is permitted/i);
  assert.match(block, /present existence, access, interaction, or resurrection is prohibited/i);
  assert.doesNotMatch(block, /active object exists outside/i);
});

test('V12 missing-record translation permits audited past context without current invention', () => {
  const { block } = renderAuthorityBlock(unsupportedResult(
    ['old marker'],
    [receipt('old marker', 'resolved_unavailable', 'ors_record_missing', {
      current_status: null,
      current_container_type: null,
      current_container_id: null
    })]
  ));
  assert.match(block, /audited historical identity has no current authoritative object record/i);
  assert.match(block, /Historical reference is permitted only as past context/i);
  assert.match(block, /do not assert current existence, location, access, recreation, or interaction/i);
  assert.doesNotMatch(block, /active object exists outside/i);
});

test('V13 ambiguous translation cannot select, merge, or expose an identity', () => {
  const { block } = renderAuthorityBlock(unsupportedResult(
    ['matched keepsake'],
    [receipt('matched keepsake', 'ambiguous', 'multiple_audited_object_ids', {
      object_id: null,
      candidate_object_ids: ['hidden_identity_a', 'hidden_identity_b']
    })]
  ));
  assert.match(block, /Multiple audited identities match/i);
  assert.match(block, /Do not select, merge, instantiate, possess, or physically interact/i);
  assert.match(block, /Historical discussion may remain nonspecific only/i);
  assert.doesNotMatch(block, /hidden_identity_a|hidden_identity_b/i);
});

test('V14 unresolved translations preserve uncertainty and resolver errors fail closed', () => {
  const historicalMatch = renderAuthorityBlock(unsupportedResult(
    ['uncertain relic'],
    [receipt('uncertain relic', 'unresolved', 'historical_match_without_audited_identity', {
      object_id: null,
      candidate_object_ids: []
    })]
  )).block;
  assert.match(historicalMatch, /does not establish an authoritative identity/i);
  assert.match(historicalMatch, /memory or uncertainty/i);
  assert.match(historicalMatch, /do not confirm existence, identity, location, possession, sensory contact, or current interaction/i);

  const resolverError = renderAuthorityBlock(unsupportedResult(
    ['failed reference'],
    [receipt('failed reference', 'unresolved', 'resolver_error', {
      object_id: null,
      candidate_object_ids: []
    })]
  )).block;
  assert.match(resolverError, /Deterministic resolution failed closed/i);
  assert.match(resolverError, /Do not confirm present or historical object facts/i);
  assert.match(resolverError, /do not instantiate, possess, sense, or permit interaction/i);
});

test('V15 not-found translation prohibits establishment, substitution, and interaction', () => {
  const { block } = renderAuthorityBlock(unsupportedResult(
    ['unsupported implement'],
    [receipt('unsupported implement', 'not_found', 'no_historical_match', {
      object_id: null,
      candidate_object_ids: [],
      matched_turns: []
    })]
  ));
  assert.match(block, /No current or historical authority supports this reference/i);
  assert.match(block, /Do not treat it as established, present, held, accessible, physically interactable, or currently sensed/i);
  assert.match(block, /do not instantiate or substitute it/i);
});

test('V16 missing, malformed, and unrecognized receipts use the fail-closed fallback', () => {
  for (const receipts of [
    [],
    [{ reference: 'fallback item', outcome: null, reason_code: null }],
    [receipt('fallback item', 'unexpected_outcome', 'unexpected_reason')]
  ]) {
    const { block } = renderAuthorityBlock(unsupportedResult(['fallback item'], receipts));
    assert.match(block, /Fail closed/i);
    assert.match(block, /do not confirm existence, identity, presence, possession, accessibility, sensory contact, or interaction/i);
    assert.match(block, /do not claim that prior continuity was searched successfully/i);
  }
});

test('V17 mixed receipt categories retain unsupported-list order and hide internal fields', () => {
  const { block } = renderAuthorityBlock(unsupportedResult(
    ['first reference', 'second reference', 'third reference'],
    [
      receipt('third reference', 'not_found', 'no_historical_match'),
      receipt('first reference', 'resolved_unavailable', 'ors_object_outside_current_scope'),
      receipt('second reference', 'resolved_unavailable', 'ors_record_inactive')
    ]
  ));
  assert.ok(block.indexOf('"first reference"') < block.indexOf('"second reference"'));
  assert.ok(block.indexOf('"second reference"') < block.indexOf('"third reference"'));
  assert.doesNotMatch(block, /internal_object_identifier|internal_candidate_identifier|internal_container_identifier/i);
});

const doIntentSource = sourceSlice(
  'const _doIntentTarget =',
  '// Phase 3 (v1.51.0): Generalized emote block'
);

function renderDoIntentBlock(deniedObjectReference) {
  const sandbox = {
    inputObj: { degraded: false, player_intent: { target: 'known target' } },
    resolvedChannel: 'do',
    _parsedAction: 'examine',
    _rawInput: 'examine the known target',
    debug: { object_operation_bridge: { active: false } },
    _agDeniedObjectReference: deniedObjectReference
  };
  vm.runInNewContext(
    `${doIntentSource}\nglobalThis.__doIntentBlock = _doIntentBlock;`,
    sandbox,
    { filename: 'authoritygate-do-intent.vm.js', timeout: 1000 }
  );
  return sandbox.__doIntentBlock;
}

test('V18 object-denied Do turns are not labeled as validated actions', () => {
  const block = renderDoIntentBlock(true);
  assert.equal(block, '');
  assert.doesNotMatch(block, /VALIDATED ACTION/);
});

test('V19 supported Do turns retain the existing validated-action block', () => {
  const block = renderDoIntentBlock(false);
  assert.match(block, /PLAYER INTENT \(for flavor only\)/);
  assert.match(block, /VALIDATED ACTION: examine — known target/);
});

test('V20 all three depth branches put the object-denial directive first', () => {
  const anchorSource = sourceSlice(
    'LAYER CONSTRAINT [MANDATORY]:',
    "${_continuityBlock ? _continuityBlock + '\\n\\n' : ''}"
  );
  const denialCase = '${_agDeniedObjectReference ? `Authority Gate denied the current object premise.';
  assert.equal((anchorSource.match(/\$\{_agDeniedObjectReference \?/g) || []).length, 3);
  assert.equal((anchorSource.match(/Authority Gate denied the current object premise\./g) || []).length, 3);
  assert.equal((anchorSource.match(/Do not present the attempted interaction as performed or validated\./g) || []).length, 3);
  for (const branch of anchorSource.split(denialCase).slice(1)) {
    const stateClaimIndex = branch.indexOf("_parsedAction === 'state_claim'");
    const genericAnchorIndex = branch.indexOf("The player's action —");
    assert.ok(stateClaimIndex > 0, 'state-claim fallback must follow denial-first branch');
    assert.ok(genericAnchorIndex > stateClaimIndex, 'generic action anchor must remain an else-case');
  }
});

test('V21 only the scoped unsupported-object denial suppresses Do and anchor behavior', () => {
  const otherDenial = renderAuthorityBlock({
    decision: 'freeform',
    reason_code: 'unsupported_meta_authority'
  });
  assert.equal(otherDenial.deniedObjectReference, false);
  assert.match(renderDoIntentBlock(otherDenial.deniedObjectReference), /VALIDATED ACTION/);

  const allowed = renderAuthorityBlock({
    decision: 'allow_no_rc',
    reason_code: 'valid_player_action'
  });
  assert.equal(allowed.deniedObjectReference, false);
  assert.equal(allowed.block, '');
});

test('V22 authority translation retains its prompt-tail ordering', () => {
  const doIntentIndex = source.indexOf('const _doIntentBlock =');
  const tailSequence = '${_authorityGateBlock}${_entityGroundingBlock}${_freeformBlock}';
  const tailIndex = source.indexOf(tailSequence);
  assert.ok(doIntentIndex >= 0);
  assert.ok(tailIndex > doIntentIndex);
  assert.equal((source.match(/\$\{_authorityGateBlock\}\$\{_entityGroundingBlock\}\$\{_freeformBlock\}/g) || []).length, 1);
});

test('V23 narrator translation consumes only Authority Gate receipt evidence', () => {
  assert.doesNotMatch(authoritySource, /ObjectHelper|ActionProcessor|_resolveHistoricalObjectReceipt|_hasCellMatch/);
  assert.doesNotMatch(authoritySource, /gameState\s*\.\s*objects|gameState\s*\?\.\s*objects/);
  assert.match(authoritySource, /unsupported_referenced_objects/);
  assert.match(authoritySource, /historical_object_receipts/);
});
