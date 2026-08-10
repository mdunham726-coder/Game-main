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

const helperSource = sourceSlice(
  'const _clearTransientPlayerStateOnBoundary =',
  '// Progress token + reporter'
);

function loadCleanup() {
  const sandbox = {};
  vm.runInNewContext(
    `${helperSource}\n` +
      'globalThis.__cleanup = _clearTransientPlayerStateOnBoundary;',
    sandbox,
    { filename: 'state-boundary-cleanup.vm.js', timeout: 1000 }
  );
  return sandbox.__cleanup;
}

function stateAt(siteId, localSpaceId) {
  return {
    world: {
      active_site: siteId === null ? null : {
        id: siteId,
        attributes: {
          'env:brick wall': { bucket: 'environment', value: 'brick wall' }
        },
        _visible_npcs: [{
          id: 'npc_1',
          attributes: {
            'state:watching': { bucket: 'state', value: 'watching' }
          }
        }]
      },
      active_local_space: localSpaceId === null ? null : {
        local_space_id: localSpaceId,
        attributes: {
          'env:wood floor': { bucket: 'environment', value: 'wood floor' }
        }
      }
    },
    player: {
      attributes: {
        'state:crouching': { bucket: 'state', value: 'crouching', turn_set: 2 },
        'state:looking around': { bucket: 'state', value: 'looking around', turn_set: 3 },
        'physical:scarred': { bucket: 'physical', value: 'scarred', turn_set: 1 },
        'declared:can swim': { bucket: 'declared', value: 'can swim', turn_set: 1 },
        'object:legacy token': { bucket: 'object', value: 'legacy token', turn_set: 1 }
      }
    },
    objects: {
      object_1: {
        id: 'object_1',
        status: 'active',
        current_container_type: 'player',
        current_container_id: 'player'
      }
    }
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('production wiring applies the same cleanup after semantic and fallback Engine results', () => {
  assert.match(
    source,
    /const result = await Engine\.buildOutput\([^\n]+\);\n\s+_clearTransientPlayerStateOnBoundary\(_preTurnLoc, result\?\.state\);/
  );
  assert.match(
    source,
    /engineOutput = Engine\.buildOutput\(gameState, inputObj, logger\);\n\s+_clearTransientPlayerStateOnBoundary\(_preTurnLoc, engineOutput\?\.state\);/
  );
  assert.doesNotMatch(source, /const _siteChanged =/);
  assert.doesNotMatch(source, /const _preActionLsId =/);
});

test('stationary fallback inside an active site preserves player state', () => {
  const cleanup = loadCleanup();
  const nextState = stateAt('site_a', null);
  const before = clone(nextState);

  cleanup({ siteId: 'site_a', lsId: null }, nextState);

  assert.deepEqual(nextState, before);
});

test('genuine semantic site boundary crossing clears only player state attributes', () => {
  const cleanup = loadCleanup();
  const nextState = stateAt(null, null);
  const objectsBefore = clone(nextState.objects);

  cleanup({ siteId: 'site_a', lsId: null }, nextState);

  assert.deepEqual(Object.keys(nextState.player.attributes).sort(), [
    'declared:can swim',
    'object:legacy token',
    'physical:scarred'
  ]);
  assert.deepEqual(nextState.objects, objectsBefore);
});

test('genuine semantic local-space boundary crossing clears player state', () => {
  const cleanup = loadCleanup();
  const nextState = stateAt('site_a', 'room_b');

  cleanup({ siteId: 'site_a', lsId: 'room_a' }, nextState);

  assert.equal(Object.values(nextState.player.attributes).some(attr => attr.bucket === 'state'), false);
});

test('stationary L0 fallback remains unchanged', () => {
  const cleanup = loadCleanup();
  const nextState = stateAt(null, null);
  const before = clone(nextState);

  cleanup({ siteId: null, lsId: null }, nextState);

  assert.deepEqual(nextState, before);
});

test('boundary cleanup leaves NPC and location attributes unaffected', () => {
  const cleanup = loadCleanup();
  const nextState = stateAt('site_a', 'room_b');
  const siteAttrsBefore = clone(nextState.world.active_site.attributes);
  const npcAttrsBefore = clone(nextState.world.active_site._visible_npcs[0].attributes);
  const localAttrsBefore = clone(nextState.world.active_local_space.attributes);

  cleanup({ siteId: 'site_a', lsId: 'room_a' }, nextState);

  assert.deepEqual(nextState.world.active_site.attributes, siteAttrsBefore);
  assert.deepEqual(nextState.world.active_site._visible_npcs[0].attributes, npcAttrsBefore);
  assert.deepEqual(nextState.world.active_local_space.attributes, localAttrsBefore);
});
