'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const REPO = path.resolve(__dirname, '..');
const { resolveCellItemByName } = require(path.join(REPO, 'ActionProcessor.js'));

function stateWithEnvironmentFeature(value) {
  return {
    objects: {},
    player: { position: { x: 0, y: 0 } },
    world: {
      position: { mx: 0, my: 0, lx: 0, ly: 0 },
      cells: { 'LOC:0,0:0,0': { items: [], npcs: [], attributes: {} } },
      npcs: [],
      active_site: null,
      active_local_space: {
        local_space_id: 'room_1',
        attributes: {
          'env:test': { bucket: 'environment', value }
        }
      }
    }
  };
}

function resolves(value, query) {
  return resolveCellItemByName(stateWithEnvironmentFeature(value), query);
}

test('1.1 exact multi-word current feature matches', () => {
  const result = resolves('gravel path', 'gravel path');
  assert.equal(result?._found, true);
  assert.equal(result?.targetType, 'environmentFeature');
});

test('1.2 single-token-in-value behavior remains', () => {
  assert.equal(resolves('gravel path', 'path')?._found, true);
});

test('1.3 substring collision remains rejected', () => {
  assert.equal(resolves('milestone', 'stone'), null);
});

test('1.4 prefix and plural tolerance remains', () => {
  assert.equal(resolves('sparkling roses', 'sparkling rose')?._found, true);
});

test('1.5 reordered tokens deny', () => {
  assert.equal(resolves('gravel path', 'path gravel'), null);
});

test('1.6 non-contiguous tokens deny', () => {
  assert.equal(resolves('old gravel path', 'old path'), null);
});

test('1.7 contiguous run inside longer value matches', () => {
  assert.equal(resolves('old gravel path', 'gravel path')?._found, true);
});
