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

const sandbox = { aliasScore };
vm.runInNewContext(
  `
    ${sourceSlice('function _buildEvidence(', 'function _hasInventoryMatch(')}
    globalThis.__buildEvidence = _buildEvidence;
    globalThis.__hasWornMatch = _hasWornMatch;
  `,
  sandbox,
  { filename: 'authoritygate-evidence-container-consistency.vm.js', timeout: 1000 }
);

function makeState(record, listKey) {
  return {
    objects: { [record.id]: record },
    player: {
      attributes: {},
      object_ids: listKey === 'object_ids' ? [record.id] : [],
      worn_object_ids: listKey === 'worn_object_ids' ? [record.id] : []
    },
    world: { current_depth: 1, _visible_npcs: [] }
  };
}

function record(id, name, type, containerId) {
  return {
    id,
    name,
    aliases: [],
    status: 'active',
    current_container_type: type,
    current_container_id: containerId
  };
}

test('2A.1 inventory container mismatch excludes listed active record', () => {
  const state = makeState(record('inv_wrong', 'iron key', 'grid', 'LOC:0,0:0,0'), 'object_ids');
  const evidence = sandbox.__buildEvidence(state, '', 'examine', 2);
  assert.deepEqual([...evidence.inventoryNames], []);
});

test('2A.2 genuine inventory remains in evidence', () => {
  const state = makeState(record('inv_good', 'iron key', 'player', 'player'), 'object_ids');
  const evidence = sandbox.__buildEvidence(state, '', 'examine', 2);
  assert.deepEqual([...evidence.inventoryNames], ['iron key']);
});

test('2A.3 worn container mismatch excludes evidence and fast-path match', () => {
  const state = makeState(record('worn_wrong', 'wool cloak', 'player', 'player'), 'worn_object_ids');
  const evidence = sandbox.__buildEvidence(state, '', 'remove', 2);
  assert.deepEqual([...evidence.wornNames], []);
  assert.equal(sandbox.__hasWornMatch(state, 'wool cloak'), false);
});

test('2A.4 genuine worn record remains in evidence and fast-path match', () => {
  const state = makeState(record('worn_good', 'wool cloak', 'player_worn', 'player_worn'), 'worn_object_ids');
  const evidence = sandbox.__buildEvidence(state, '', 'remove', 2);
  assert.deepEqual([...evidence.wornNames], ['wool cloak']);
  assert.equal(sandbox.__hasWornMatch(state, 'wool cloak'), true);
});
