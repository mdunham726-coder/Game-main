'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const axios = require('axios');

const REPO = path.resolve(__dirname, '..');
const ActionProcessor = require(path.join(REPO, 'ActionProcessor.js'));
const CB = require(path.join(REPO, 'ContinuityBrain.js'));
const ObjectHelper = require(path.join(REPO, 'ObjectHelper.js'));

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

function makeNpc(id = 'npc_1') {
  return {
    id,
    npc_name: 'Mira',
    job_category: 'courier',
    is_learned: true,
    attributes: {},
    object_ids: [],
    worn_object_ids: [],
    object_capture_turn: null
  };
}

function baseGameState() {
  const npc = makeNpc();
  const activeLocalSpace = {
    local_space_id: 'room_1',
    name: 'Test Room',
    attributes: {},
    object_ids: [],
    _visible_npcs: [npc]
  };
  return {
    turn_history: [{ turn: 1 }],
    world: {
      position: { mx: 0, my: 0, lx: 0, ly: 0 },
      cells: {
        'LOC:0,0:0,0': { items: [], npcs: [npc], attributes: {}, object_ids: [] }
      },
      active_local_space: activeLocalSpace,
      active_site: null,
      npcs: [npc],
      mood_history: [],
      promotion_log: []
    },
    player: {
      id: 'player',
      object_ids: [],
      worn_object_ids: [],
      attributes: {},
      conditions: [],
      position: { x: 0, y: 0 },
      birth_record: {}
    },
    objects: {}
  };
}

function objectRecord(id, name, currentContainerType, currentContainerId, overrides = {}) {
  return {
    id,
    name,
    description: '',
    status: 'active',
    current_container_type: currentContainerType,
    current_container_id: currentContainerId,
    quantity: 1,
    conditions: [],
    events: [],
    ...overrides
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
    visible_objects: [],
    object_transfers: [],
    object_condition_updates: [],
    object_retirements: [],
    fission_events: [],
    extraction_events: [],
    ...overrides
  };
}

async function runPhaseBWithStub({ payload, narration = 'A quiet deterministic scene.', gameState, options = {} }) {
  const originalPost = axios.post;
  const originalApiKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'deterministic-test-key';
  axios.post = async () => ({
    data: { choices: [{ message: { content: JSON.stringify(payload) } }] }
  });
  try {
    return await CB.runPhaseB(narration, gameState, 'test input', options);
  } finally {
    axios.post = originalPost;
    if (originalApiKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalApiKey;
  }
}

function loadStateClaimHarness() {
  const source = readSource('index.js');
  const block = sourceSlice(
    source,
    '          // v1.84.75: Object-access detector + discriminated relevance gate.',
    '\n        }\n\n        // Phase 4: validate queue',
    'state-claim authority block'
  );
  const sandbox = {};
  vm.runInNewContext(
    `
      globalThis.__runStateClaim = function(args) {
        const gameState = args.gameState;
        const userInput = args.userInput;
        const inputObj = { player_intent: { action: 'state_claim' } };
        const debug = {};
        ${block}
        return { inputObj, debug };
      };
    `,
    sandbox,
    { filename: 'actor-possession-state-claim.vm.js', timeout: 1000 }
  );
  assert.equal(typeof sandbox.__runStateClaim, 'function');
  return args => clone(sandbox.__runStateClaim(clone(args)));
}

function loadNpcIntroductionHarness() {
  const source = readSource('index.js');
  const block = sourceSlice(
    source,
    '        // v1.85.28: NPC intro capture — materialize held/worn objects from entity_candidates as real ObjectRecords.',
    '        // v6.0.18: soliloquy gate',
    'NPC first-introduction capture block'
  );
  const sandbox = {};
  vm.runInNewContext(
    `
      globalThis.__captureNpcIntroduction = function(args) {
        const gameState = args.gameState;
        const turnNumber = args.turnNumber;
        const _phaseBResult = args.phaseBResult;
        const _phaseBEntityCandidates = args.entityCandidates;
        const _narActiveLS = gameState.world.active_local_space;
        const _narActiveSite = gameState.world.active_site;
        const _dropDryRunSealActive = false;
        const _throwDryRunSealActive = false;
        const _objectRealityDebug = {};
        const _turnLog = () => {};
        const _isAbsencePhrase = value => /^(none|nothing|empty|no objects?)$/i.test(String(value || '').trim());
        ${block}
        return {
          candidates: _phaseBResult.object_candidates,
          materialized: _objectRealityDebug.npc_intro_materialized,
          captureTurn: gameState.world.active_local_space._visible_npcs[0].object_capture_turn
        };
      };
    `,
    sandbox,
    { filename: 'actor-possession-npc-intro.vm.js', timeout: 1000 }
  );
  assert.equal(typeof sandbox.__captureNpcIntroduction, 'function');
  return args => clone(sandbox.__captureNpcIntroduction(clone(args)));
}

const runStateClaim = loadStateClaimHarness();
const captureNpcIntroduction = loadNpcIntroductionHarness();

test('V1, V2, V11: CB held/worn observations remain ephemeral for player and NPC', async () => {
  const state = baseGameState();
  const payload = baseCbPayload({
    entity_candidates: [
      {
        entity_ref: 'player',
        physical_attributes: ['scarred hands'],
        observable_states: ['standing alert'],
        held_objects: ['brass key'],
        worn_objects: ['linen cloak'],
        rejected_interpretations: []
      },
      {
        entity_ref: 'npc_1',
        physical_attributes: ['silver hair'],
        observable_states: ['waiting quietly'],
        held_objects: ['sealed letter'],
        worn_objects: ['riding coat'],
        rejected_interpretations: []
      }
    ]
  });

  const result = await runPhaseBWithStub({ payload, gameState: state });
  const npc = state.world.npcs[0];

  assert.equal(state.player.attributes['physical:scarred hands']?.value, 'scarred hands');
  assert.equal(state.player.attributes['state:standing alert']?.value, 'standing alert');
  assert.equal(npc.attributes['physical:silver hair']?.value, 'silver hair');
  assert.equal(npc.attributes['state:waiting quietly']?.value, 'waiting quietly');
  assert.equal(Object.values(state.player.attributes).some(attr => attr.bucket === 'object'), false);
  assert.equal(Object.values(npc.attributes).some(attr => attr.bucket === 'object'), false);
  assert.deepEqual(result.extracted.entity_candidates[0].held_objects, ['brass key']);
  assert.deepEqual(result.extracted.entity_candidates[0].worn_objects, ['linen cloak']);
  assert.deepEqual(result.extracted.entity_candidates[1].held_objects, ['sealed letter']);
  assert.deepEqual(result.extracted.entity_candidates[1].worn_objects, ['riding coat']);
  assert.deepEqual(state.objects, {}, 'unmaterialized observations must not create ObjectRecords');
});

test('V3: founding history and candidates survive without a possession attribute', async () => {
  const state = baseGameState();
  state.turn_history = [];
  const foundingCandidate = {
    temp_ref: 'founding_orb',
    name: 'crystal orb',
    description: 'a clear crystal orb',
    container_type: 'player',
    container_id: 'player',
    transfer_origin: 'player_claimed'
  };
  const payload = baseCbPayload({
    founding_premise: {
      canonical_name: 'Aldric',
      title_or_role: 'wizard',
      form: 'human',
      location_premise: 'a stone tower',
      possessions: ['crystal orb'],
      capabilities: ['cast fire'],
      status_claims: ['wizard'],
      scenario_notes: [],
      starting_npc: null
    },
    object_candidates: [foundingCandidate]
  });

  const result = await runPhaseBWithStub({ payload, gameState: state });

  assert.deepEqual(state.player.birth_record.possessions, ['crystal orb']);
  assert.equal(state.player.attributes['declared:wizard']?.value, 'wizard');
  assert.equal(state.player.attributes['declared:cast fire']?.value, 'cast fire');
  assert.equal(Object.values(state.player.attributes).some(attr => attr.bucket === 'object'), false);
  assert.deepEqual(result.object_candidates, [foundingCandidate]);
});

test('V4, V5, V6: CB prompt and continuity truth accept only consistent ORS actor records', async () => {
  const state = baseGameState();
  const npc = state.world.npcs[0];
  state.player.object_ids = ['held_ok', 'held_wrong_type'];
  state.player.worn_object_ids = ['worn_ok', 'worn_wrong_id'];
  npc.object_ids = ['npc_held_ok'];
  npc.worn_object_ids = ['npc_worn_ok'];
  Object.assign(state.objects, {
    held_ok: objectRecord('held_ok', 'valid held token', 'player', 'player'),
    held_missing_array: objectRecord('held_missing_array', 'missing array token', 'player', 'player'),
    held_wrong_type: objectRecord('held_wrong_type', 'wrong held container token', 'grid', 'player'),
    worn_ok: objectRecord('worn_ok', 'valid worn token', 'player_worn', 'player_worn'),
    worn_wrong_id: objectRecord('worn_wrong_id', 'wrong worn id token', 'player_worn', 'player'),
    npc_held_ok: objectRecord('npc_held_ok', 'valid npc held token', 'npc', npc.id),
    npc_held_missing_array: objectRecord('npc_held_missing_array', 'missing npc array token', 'npc', npc.id),
    npc_worn_ok: objectRecord('npc_worn_ok', 'valid npc worn token', 'npc_worn', npc.id),
    npc_wrong_id: objectRecord('npc_wrong_id', 'wrong npc id token', 'npc', 'npc_other'),
    actor_spatial_collision: objectRecord('actor_spatial_collision', 'actor collision token', 'npc', 'room_1'),
    spatial_ok: objectRecord('spatial_ok', 'valid spatial token', 'localspace', 'room_1')
  });
  state.player.attributes = {
    'object:ghost blade': { bucket: 'object', value: 'ghost blade', turn_set: 1 },
    'physical:scarred hands': { bucket: 'physical', value: 'scarred hands', turn_set: 1 }
  };

  const result = await runPhaseBWithStub({ payload: baseCbPayload(), gameState: state });
  const prompt = result.prompt;

  for (const expected of [
    'valid held token | container: player-held',
    'valid worn token | container: player-worn',
    `valid npc held token | container: npc-held:${npc.id}`,
    `valid npc worn token | container: npc-worn:${npc.id}`,
    'valid spatial token | container: room_1'
  ]) assert.ok(prompt.includes(expected), expected);
  for (const rejected of [
    'ghost blade',
    'missing array token',
    'wrong held container token',
    'wrong worn id token',
    'missing npc array token',
    'wrong npc id token',
    'actor collision token'
  ]) assert.equal(prompt.includes(rejected), false, rejected);
  assert.ok(prompt.includes('physical:scarred hands'));

  state.turn_history = Array.from({ length: 10 }, (_, index) => ({ turn: index + 1 }));
  state.player.attributes['state:old posture'] = { bucket: 'state', value: 'old posture', turn_set: 1 };
  state.player.attributes['state:current posture'] = { bucket: 'state', value: 'current posture', turn_set: 11 };
  npc.attributes = {
    'object:stale parcel': { bucket: 'object', value: 'stale parcel', turn_set: 10 },
    'physical:silver hair': { bucket: 'physical', value: 'silver hair', turn_set: 10 }
  };
  npc.player_recognition = { recognizes_player: true, known_identity: 'Aldric', learned_turn: 3 };
  const turnContext = {};
  const packet = CB.assembleContinuityPacket(state, turnContext);

  assert.equal(packet.includes('ghost blade'), false);
  assert.equal(packet.includes('stale parcel'), false);
  assert.equal(packet.includes('old posture'), false);
  assert.ok(packet.includes('physical:scarred hands'));
  assert.ok(packet.includes('state:current posture'));
  assert.ok(packet.includes('silver hair'));
  assert.ok(packet.includes('recognizes-player: Aldric'));
  assert.equal(turnContext.stateAttrsSuppressed, 1);
});

test('V7-V12: state claims, NPC resolution, transfer, equipment, and retirement follow ORS', async () => {
  const state = baseGameState();
  const npc = state.world.npcs[0];
  state.player.attributes['object:ghost amulet'] = { bucket: 'object', value: 'ghost amulet', turn_set: 1 };
  state.player.object_ids = ['knife'];
  state.objects.knife = objectRecord('knife', 'iron knife', 'player', 'player');

  let result = runStateClaim({ gameState: state, userInput: 'I pull out my iron knife' });
  assert.equal(result.inputObj.player_intent.action, 'established_trait_action');
  assert.deepEqual(result.inputObj.player_intent._foundingAttrs, ['object:iron knife']);
  assert.equal(Object.hasOwn(state.player.attributes, 'object:iron knife'), false);

  result = runStateClaim({ gameState: state, userInput: 'I pull out my ghost amulet' });
  assert.equal(result.inputObj.player_intent.action, 'state_claim');

  const transfer = ObjectHelper.transferObjectDirect(
    state, 'knife', 'player_worn', 'player_worn', 2, 'equip authority test'
  );
  assert.equal(transfer.success, true);
  assert.deepEqual(state.player.object_ids, []);
  assert.deepEqual(state.player.worn_object_ids, ['knife']);
  result = runStateClaim({ gameState: state, userInput: 'I use my iron knife' });
  assert.equal(result.inputObj.player_intent.action, 'established_trait_action');
  assert.deepEqual(result.inputObj.player_intent._foundingAttrs, ['object:iron knife']);

  const attributeOnlyState = baseGameState();
  attributeOnlyState.world.npcs[0].attributes['object:sealed letter'] = {
    bucket: 'object',
    value: 'sealed letter',
    turn_set: 1
  };
  assert.equal(ActionProcessor.resolveCellItemByName(attributeOnlyState, 'sealed letter'), null);

  npc.object_ids.push('npc_letter');
  state.objects.npc_letter = objectRecord('npc_letter', 'sealed letter', 'npc', npc.id);
  const resolvedNpcItem = ActionProcessor.resolveCellItemByName(state, 'sealed letter');
  assert.equal(resolvedNpcItem.objectId, 'npc_letter');
  assert.equal(resolvedNpcItem.npcId, npc.id);
  state.world.active_local_space.attributes['env:wild fern'] = {
    bucket: 'environment',
    value: 'wild fern',
    turn_set: 2
  };
  assert.equal(ActionProcessor.resolveCellItemByName(state, 'fern')?.targetType, 'environmentFeature');

  const retired = ObjectHelper.retireObject(state, 'knife', 'spent authority fixture', 3);
  assert.equal(retired.retired, true);
  assert.deepEqual(state.player.worn_object_ids, []);
  result = runStateClaim({ gameState: state, userInput: 'I use my iron knife' });
  assert.equal(result.inputObj.player_intent.action, 'state_claim');
  const cbResult = await runPhaseBWithStub({ payload: baseCbPayload(), gameState: state });
  assert.equal(cbResult.prompt.includes('iron knife'), false);
  assert.equal(CB.assembleContinuityPacket(state, {}).includes('ghost amulet'), false);
});

test('V13: NPC first-introduction observations still materialize routed, provenanced ORS records', async () => {
  const state = baseGameState();
  const npc = state.world.npcs[0];
  const entityCandidate = {
    entity_ref: npc.id,
    physical_attributes: [],
    observable_states: [],
    held_objects: ['Sealed Letter'],
    worn_objects: ['Blue Riding Coat'],
    rejected_interpretations: []
  };
  const captured = captureNpcIntroduction({
    gameState: state,
    turnNumber: 2,
    phaseBResult: { object_candidates: [] },
    entityCandidates: [entityCandidate]
  });

  assert.equal(captured.materialized, 2);
  assert.equal(captured.captureTurn, 2);
  assert.deepEqual(captured.candidates.map(candidate => candidate.container_type), ['npc', 'npc_worn']);
  assert.deepEqual(captured.candidates.map(candidate => candidate.container_id), [npc.id, npc.id]);
  assert.deepEqual(captured.candidates.map(candidate => candidate.transfer_origin), ['npc_introduction', 'npc_introduction']);
  assert.deepEqual(captured.candidates.map(candidate => candidate._source_npc_id), [npc.id, npc.id]);
  assert.deepEqual(captured.candidates.map(candidate => candidate._source_phrase), ['Sealed Letter', 'Blue Riding Coat']);

  const quarantine = captured.candidates.map(candidate => ({ action: 'promote', ...candidate }));
  const helperResult = await ObjectHelper.run(state, quarantine, 2);
  assert.equal(helperResult.promoted, 2);
  assert.equal(npc.object_ids.length, 1);
  assert.equal(npc.worn_object_ids.length, 1);
  const held = state.objects[npc.object_ids[0]];
  const worn = state.objects[npc.worn_object_ids[0]];
  assert.equal(held.status, 'active');
  assert.equal(held.current_container_type, 'npc');
  assert.equal(held.current_container_id, npc.id);
  assert.equal(worn.status, 'active');
  assert.equal(worn.current_container_type, 'npc_worn');
  assert.equal(worn.current_container_id, npc.id);
  for (const [record, phrase] of [[held, 'Sealed Letter'], [worn, 'Blue Riding Coat']]) {
    assert.equal(record.source, 'npc_introduction');
    assert.equal(record.source_npc_id, npc.id);
    assert.equal(record.source_phrase, phrase);
  }
  assert.equal(Object.values(npc.attributes).some(attr => attr.bucket === 'object'), false);
});
