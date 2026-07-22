'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { _enrichPrimaryAction } = require('../SemanticParser.js');

function enrich(action, rawInput, target = 'tokens') {
  return _enrichPrimaryAction({ action, target, selection_mode: null }, rawInput);
}

function quantityMetadata(action) {
  return {
    requested_quantity: action.requested_quantity,
    quantity_word: action.quantity_word,
    quantity_mode: action.quantity_mode,
    selection_mode: action.selection_mode ?? null
  };
}

test('standalone I preserves numeric quantity metadata for TAKE, DROP, and THROW', () => {
  const cases = [
    { action: 'take', verbFirst: 'take 3 tokens', firstPerson: 'I take 3 tokens', selectionMode: 'partial_from_stack' },
    { action: 'drop', verbFirst: 'drop 5 tokens', firstPerson: 'I drop 5 tokens', selectionMode: null },
    { action: 'throw', verbFirst: 'throw 4 tokens', firstPerson: 'I throw 4 tokens', selectionMode: null }
  ];

  for (const entry of cases) {
    const verbFirst = quantityMetadata(enrich(entry.action, entry.verbFirst));
    const firstPerson = quantityMetadata(enrich(entry.action, entry.firstPerson));

    assert.deepEqual(firstPerson, verbFirst, entry.firstPerson);
    assert.deepEqual(firstPerson, {
      requested_quantity: Number(entry.firstPerson.match(/\d+/)[0]),
      quantity_word: null,
      quantity_mode: 'exact',
      selection_mode: entry.selectionMode
    });
  }
});

test('standalone I preserves existing word-quantity classifications across action families', () => {
  const signals = [
    { phrase: 'three tokens', requested: 3, word: 'three', mode: 'exact' },
    { phrase: 'all tokens', requested: null, word: 'all', mode: 'all' },
    { phrase: 'a few tokens', requested: null, word: 'a few', mode: 'some' }
  ];

  for (const action of ['take', 'drop', 'throw']) {
    for (const signal of signals) {
      const verbFirst = quantityMetadata(enrich(action, `${action} ${signal.phrase}`));
      const firstPerson = quantityMetadata(enrich(action, `I ${action} ${signal.phrase}`));

      assert.deepEqual(firstPerson, verbFirst, `I ${action} ${signal.phrase}`);
      assert.equal(firstPerson.requested_quantity, signal.requested);
      assert.equal(firstPerson.quantity_word, signal.word);
      assert.equal(firstPerson.quantity_mode, signal.mode);
    }
  }
});

test('standalone I preserves recognized multi-word verb extraction', () => {
  const cases = [
    { action: 'take', verbFirst: 'pick up 2 tokens', firstPerson: 'I pick up 2 tokens' },
    { action: 'drop', verbFirst: 'put down 3 tokens', firstPerson: 'I put down 3 tokens' },
    { action: 'drop', verbFirst: 'set down four tokens', firstPerson: 'I set down four tokens' }
  ];

  for (const entry of cases) {
    assert.deepEqual(
      quantityMetadata(enrich(entry.action, entry.firstPerson)),
      quantityMetadata(enrich(entry.action, entry.verbFirst)),
      entry.firstPerson
    );
  }
});

test('only a standalone I prefix is skipped', () => {
  const joinedPrefix = quantityMetadata(enrich('take', 'Ipick up 3 tokens'));
  assert.deepEqual(joinedPrefix, {
    requested_quantity: null,
    quantity_word: null,
    quantity_mode: 'unspecified',
    selection_mode: null
  });

  assert.equal(enrich('throw', 'I carefully throw 3 tokens').quantity_mode, 'unspecified');
  assert.equal(enrich('throw', "I'll throw 3 tokens").quantity_mode, 'unspecified');
  assert.equal(enrich('throw', 'I throw tokens').quantity_mode, 'unspecified');
});

test('enrichment remains pure and preserves unrelated metadata behavior', () => {
  const primaryAction = { action: 'throw', target: '3 tokens', selection_mode: null };
  const original = { ...primaryAction };

  const enriched = _enrichPrimaryAction(primaryAction, 'I throw 3 tokens from satchel');

  assert.notStrictEqual(enriched, primaryAction);
  assert.deepEqual(primaryAction, original);
  assert.equal(enriched.normalized_target, 'tokens');
  assert.equal(enriched.operation_family, 'throw');
  assert.equal(enriched.source_container_hint, 'satchel');
});
