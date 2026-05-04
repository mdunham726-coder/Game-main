'use strict';

/**
 * ObjectHelper.js — v1.0.0
 *
 * Object Reality System — POC processor.
 *
 * Accepts a quarantine array produced by index.js from CB output and promotes or
 * transfers objects into gameState.objects. Does NOT read or write gameState.object_quarantine
 * — that field is the pipeline owner's (index.js) responsibility.
 *
 * Design constraints:
 *   - Two-pass: all promotions before all transfers
 *   - IDs are deterministic: sha256(name|container_type|container_id|temp_ref)
 *   - Transfers resolve via temp_ref map (same-turn) or explicit object_id — never by name
 *   - Fail-closed: violations go to gameState.object_errors; state stays last-known-good
 *   - NPC resolution: world.npcs only (no _visible_npcs fallback)
 *   - Grid resolution: world.cells existing keys only (no implicit cell creation)
 *   - object_errors is a rolling window capped at 100 entries
 *
 * Known POC limitations (by design):
 *   - Liveness: fail-closed can freeze objects in edge cases; no auto-repair in v1
 *   - Narrative divergence: engine wins; divergence logged, not reconciled
 *   - CB temp_ref contract: enforced by prompt spec; LLM drift produces errors, not corruption
 *   - State fragility: cascading failures after prior inconsistency; fail-closed is the guard
 */

const crypto = require('crypto');

const OH_VERSION = '1.0.0';

// ── ID generation ─────────────────────────────────────────────────────────────
// Deterministic, ordering-insensitive (uses temp_ref not seq).
// Same narrated object with same temp_ref produces same ID.
// CB is expected to reuse temp_refs across turns to re-identify known objects.
function _generateObjectId(name, containerType, containerId, tempRef) {
  const input = [
    String(name          || '').toLowerCase().trim(),
    String(containerType || ''),
    String(containerId   || ''),
    String(tempRef       || '')
  ].join('|');
  return 'obj_' + crypto.createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 12);
}

// ── Container resolution ──────────────────────────────────────────────────────
// Returns the object_ids array for a given container, or null if unresolvable.
// Mutates container in place to add object_ids[] if absent (player only).
// NPC: world.npcs canonical array only. Grid: world.cells existing keys only.
function _resolveContainerIds(gameState, containerType, containerId) {
  if (containerType === 'player') {
    if (!Array.isArray(gameState.player.object_ids)) gameState.player.object_ids = [];
    return gameState.player.object_ids;
  }
  if (containerType === 'npc') {
    const npcs = (gameState.world && Array.isArray(gameState.world.npcs)) ? gameState.world.npcs : [];
    const npc = npcs.find(n => n.id === containerId || n._id === containerId);
    if (!npc) return null;
    if (!Array.isArray(npc.object_ids)) npc.object_ids = [];
    return npc.object_ids;
  }
  if (containerType === 'grid') {
    const cells = (gameState.world && gameState.world.cells) ? gameState.world.cells : {};
    if (!cells[containerId]) return null; // no implicit cell creation
    if (!Array.isArray(cells[containerId].object_ids)) cells[containerId].object_ids = [];
    return cells[containerId].object_ids;
  }
  if (containerType === 'localspace') {
    // v1.84.85: localspace floor container. containerId must match bld._generated_interior.local_space_id exactly.
    const _lsMap = (gameState.world?.active_site?.local_spaces) || {};
    for (const _shortKey of Object.keys(_lsMap)) {
      const _gen = _lsMap[_shortKey]?._generated_interior;
      if (_gen && _gen.local_space_id === containerId) {
        if (!Array.isArray(_gen.object_ids)) _gen.object_ids = [];
        return _gen.object_ids;
      }
    }
    return null;
  }
  if (containerType === 'site') {
    // v1.84.92: site floor container. containerId format: ${site_id}:${x},${y}
    const _activeSite = gameState.world?.active_site;
    if (!_activeSite) return null;
    const _siteIdExpected = _activeSite.id || _activeSite.site_id;
    const _siteMatch = containerId.match(/^(.+):(-?\d+),(-?\d+)$/);
    if (!_siteMatch || _siteMatch[1] !== _siteIdExpected) return null;
    const _coordKey = `${_siteMatch[2]},${_siteMatch[3]}`;
    if (!_activeSite.floor_positions) _activeSite.floor_positions = {};
    if (!_activeSite.floor_positions[_coordKey]) _activeSite.floor_positions[_coordKey] = { object_ids: [] };
    if (!Array.isArray(_activeSite.floor_positions[_coordKey].object_ids)) _activeSite.floor_positions[_coordKey].object_ids = [];
    return _activeSite.floor_positions[_coordKey].object_ids;
  }
  return null;
}

// ── One-container enforcement ─────────────────────────────────────────────────
// Returns an array of {containerType, containerId} entries where objectId is found.
// Checks player, all world.npcs, and all world.cells.
function _findAllContainers(gameState, objectId) {
  const found = [];
  if (Array.isArray(gameState.player?.object_ids) && gameState.player.object_ids.includes(objectId)) {
    found.push({ containerType: 'player', containerId: 'player' });
  }
  const npcs = (gameState.world && Array.isArray(gameState.world.npcs)) ? gameState.world.npcs : [];
  for (const npc of npcs) {
    if (Array.isArray(npc.object_ids) && npc.object_ids.includes(objectId)) {
      found.push({ containerType: 'npc', containerId: npc.id || npc._id });
    }
  }
  const cells = (gameState.world && gameState.world.cells) ? gameState.world.cells : {};
  for (const [key, cell] of Object.entries(cells)) {
    if (Array.isArray(cell.object_ids) && cell.object_ids.includes(objectId)) {
      found.push({ containerType: 'grid', containerId: key });
    }
  }
  // v1.84.85: scan localspace floors
  const _lsMap2 = (gameState.world?.active_site?.local_spaces) || {};
  for (const _shortKey2 of Object.keys(_lsMap2)) {
    const _gen2 = _lsMap2[_shortKey2]?._generated_interior;
    if (_gen2 && Array.isArray(_gen2.object_ids) && _gen2.object_ids.includes(objectId)) {
      found.push({ containerType: 'localspace', containerId: _gen2.local_space_id });
    }
  }
  // v1.84.92: scan site floor_positions
  const _siteFloor = gameState.world?.active_site?.floor_positions || {};
  for (const [_fpKey, _fp] of Object.entries(_siteFloor)) {
    if (Array.isArray(_fp.object_ids) && _fp.object_ids.includes(objectId)) {
      const _siteId = gameState.world.active_site.id || gameState.world.active_site.site_id;
      found.push({ containerType: 'site', containerId: `${_siteId}:${_fpKey}` });
    }
  }
  return found;
}

// ── Error bucketing ───────────────────────────────────────────────────────────
// Rolling window of 100 entries — oldest evicted first.
const OBJECT_ERRORS_CAP = 100;
function _pushError(gameState, entry) {
  if (!Array.isArray(gameState.object_errors)) gameState.object_errors = [];
  gameState.object_errors.push(entry);
  if (gameState.object_errors.length > OBJECT_ERRORS_CAP) {
    gameState.object_errors.shift();
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * run(gameState, quarantine, turnNumber)
 *
 * Processes a quarantine array (built by index.js from CB result fields) in two passes:
 *   Pass 1 — promotions ('promote' action)
 *   Pass 2 — transfers ('transfer' action)
 *
 * Returns { promoted, transferred, errors, audit }.
 * Does NOT modify the quarantine array or gameState.object_quarantine.
 */
async function run(gameState, quarantine, turnNumber) {
  if (!Array.isArray(quarantine) || quarantine.length === 0) {
    return { promoted: 0, transferred: 0, errors: 0, audit: [] };
  }

  const audit       = [];
  const tempRefMap  = {};  // temp_ref → object_id (built during pass 1, consumed in pass 2)
  let promoted      = 0;
  let transferred   = 0;
  let errors        = 0;
  const ts          = new Date().toISOString();

  // ── Pass 1: Promotions ────────────────────────────────────────────────────
  // v1.84.83: pre-pass — detect promote+transfer same-temp_ref collisions.
  // When CB emits both a promote and a transfer for the same temp_ref, and an active
  // object with the same normalized name already exists in scene containers, the promote
  // is spurious (CB re-promoted an already-tracked object). Suppress the promote and bind
  // tempRefMap[temp_ref] to the existing object so Pass 2 transfer moves the original.
  // Newborn case: same-temp_ref collision but no existing name match → promote runs normally.
  const _transferTempRefs = new Set(
    quarantine.filter(e => e.action === 'transfer' && e.temp_ref).map(e => e.temp_ref)
  );
  const _w   = gameState.world || {};
  const _pos = _w.position;
  const _loc = _w.active_local_space || _w.active_site;
  const _sceneContainerIds = new Set(['player']);
  if (_pos) _sceneContainerIds.add(`LOC:${_pos.mx},${_pos.my}:${_pos.lx},${_pos.ly}`);
  // v1.84.86: include active localspace container so v1.84.83 dedup can see floor objects
  if (_w.active_local_space?.local_space_id) _sceneContainerIds.add(_w.active_local_space.local_space_id);
  // v1.84.92: include active site floor position so dedup can see site-floor objects
  if (_w.active_site && !_w.active_local_space) {
    const _siteId92 = _w.active_site.id || _w.active_site.site_id;
    const _px92 = gameState.player?.position?.x;
    const _py92 = gameState.player?.position?.y;
    if (_siteId92 != null && _px92 != null && _py92 != null) {
      _sceneContainerIds.add(`${_siteId92}:${_px92},${_py92}`);
    }
  }
  for (const _sn of ((_loc && _loc._visible_npcs) || [])) { if (_sn.id) _sceneContainerIds.add(_sn.id); }

  // v1.84.61: track which existing object IDs have already been claimed this pass
  // so that two same-named objects in the same container each claim a distinct slot.
  const _claimedObjectIds = new Set();

  for (const entry of quarantine) {
    if (entry.action !== 'promote') continue;

    const { name, description, container_type, container_id, temp_ref, reason } = entry;

    if (!name || !container_type || !container_id || !temp_ref) {
      _pushError(gameState, {
        turn: turnNumber, action: 'promote', reason: 'missing_required_fields',
        entry, ts
      });
      errors++;
      continue;
    }

    // v1.84.83: promote+transfer same-temp_ref collision check.
    // If this temp_ref is also used in a transfer entry, check whether an active object
    // with the same name already exists anywhere in scene containers. If so, the promote
    // is spurious — CB re-promoted an already-tracked object. Suppress and bind tempRefMap
    // to the existing object so Pass 2 transfer resolves against the original.
    if (_transferTempRefs.has(temp_ref)) {
      const _nameLower83 = String(name).toLowerCase().trim();
      let _sceneMatch = null;
      for (const [_oid83, _orec83] of Object.entries(gameState.objects)) {
        if (
          _orec83.status === 'active' &&
          _sceneContainerIds.has(_orec83.current_container_id) &&
          String(_orec83.name).toLowerCase().trim() === _nameLower83 &&
          !_claimedObjectIds.has(_oid83)
        ) {
          _sceneMatch = _orec83;
          break;
        }
      }
      if (_sceneMatch) {
        tempRefMap[temp_ref] = _sceneMatch.id;
        _claimedObjectIds.add(_sceneMatch.id);
        audit.push({ turn: turnNumber, action: 'promote_suppressed_transfer_conflict', object_id: _sceneMatch.id, object_name: name, container_type, container_id, temp_ref, ts });
        continue;
      }
      // No existing scene match → newborn object being created and moved same turn; fall through to normal promote.
    }

    // v1.84.61: name-match dedup guard — if an active object with the same name already
    // occupies this container, reuse its ID instead of creating a phantom duplicate.
    // CB re-emits promote candidates for existing objects every turn (it has no memory
    // of prior temp_refs), so without this guard a throw/drop followed by a re-narration
    // of the held item creates a ghost copy in the player's object_ids array.
    const _nameLower = String(name).toLowerCase().trim();
    let _existingMatch = null;
    for (const [_oid, _orec] of Object.entries(gameState.objects)) {
      if (
        _orec.status === 'active' &&
        _orec.current_container_type === container_type &&
        _orec.current_container_id   === container_id &&
        String(_orec.name).toLowerCase().trim() === _nameLower &&
        !_claimedObjectIds.has(_oid)
      ) {
        _existingMatch = _orec;
        break;
      }
    }
    if (_existingMatch) {
      tempRefMap[temp_ref] = _existingMatch.id;
      _claimedObjectIds.add(_existingMatch.id);
      audit.push({ turn: turnNumber, action: 'promote_skipped_name_match', object_id: _existingMatch.id, object_name: name, container_type, container_id, temp_ref, ts });
      continue;
    }

    const objectId = _generateObjectId(name, container_type, container_id, temp_ref);

    // If this ID already exists (same object re-narrated on a later turn), skip silently.
    if (gameState.objects[objectId]) {
      tempRefMap[temp_ref] = objectId; // still populate map for transfer pass
      _claimedObjectIds.add(objectId);
      audit.push({ turn: turnNumber, action: 'promote_skipped_existing', object_id: objectId, object_name: name, temp_ref, ts });
      continue;
    }

    // Resolve container
    const containerIds = _resolveContainerIds(gameState, container_type, container_id);
    if (!containerIds) {
      _pushError(gameState, {
        turn: turnNumber, action: 'promote', object_name: name, temp_ref,
        reason: 'container_not_found', container_type, container_id, ts
      });
      errors++;
      continue;
    }

    // Write object record
    const record = {
      id:                     objectId,
      name:                   String(name).trim(),
      description:            String(description || '').trim(),
      created_turn:           turnNumber,
      current_container_type: container_type,
      current_container_id:   container_id,
      owner_id:               null,
      source:                 'continuity_brain',
      status:                 'active',
      conditions:             [],
      events:                 []
    };
    gameState.objects[objectId] = record;
    containerIds.push(objectId);

    // One-container enforcement
    const allContainers = _findAllContainers(gameState, objectId);
    if (allContainers.length > 1) {
      // Violation: undo the push, remove from record, push to errors
      containerIds.pop();
      delete gameState.objects[objectId];
      _pushError(gameState, {
        turn: turnNumber, action: 'promote', object_name: name, temp_ref, object_id: objectId,
        reason: 'one_container_violation', found_in: allContainers, ts
      });
      errors++;
      continue;
    }

    // Append event to record
    record.events.push({ turn: turnNumber, action: 'promoted', container_type, container_id, reason: reason || null, ts });
    if (record.events.length > 10) record.events.shift();

    tempRefMap[temp_ref] = objectId;
    _claimedObjectIds.add(objectId);
    promoted++;
    audit.push({ turn: turnNumber, action: 'promoted', object_id: objectId, object_name: name, container_type, container_id, temp_ref, ts });
    console.log(`[ObjectHelper] Promoted: ${objectId} (${name}) → ${container_type}/${container_id}`);
  }

  // ── Pass 2: Transfers ─────────────────────────────────────────────────────
  for (const entry of quarantine) {
    if (entry.action !== 'transfer') continue;

    const { temp_ref, object_id: explicitId, from_container_type, from_container_id, to_container_type, to_container_id, reason } = entry;

    // Resolve object_id — temp_ref map takes priority (same-turn object); else explicit id
    const objectId = (temp_ref && tempRefMap[temp_ref]) ? tempRefMap[temp_ref] : (explicitId || null);
    if (!objectId) {
      _pushError(gameState, {
        turn: turnNumber, action: 'transfer', reason: 'unresolvable_object_ref',
        temp_ref, explicit_id: explicitId, entry, ts
      });
      errors++;
      continue;
    }

    const record = gameState.objects[objectId];
    if (!record) {
      _pushError(gameState, {
        turn: turnNumber, action: 'transfer', object_id: objectId,
        reason: 'object_not_found_in_registry', temp_ref, ts
      });
      errors++;
      continue;
    }

    // v1.84.65: status guard — consumed/retired objects cannot be transferred
    if (record.status !== 'active') {
      _pushError(gameState, { turn: turnNumber, action: 'transfer', object_id: objectId, object_name: record.name, reason: 'transfer_of_inactive_object', status: record.status, ts });
      errors++;
      continue;
    }

    // v1.84.57: destination idempotency — already there, no-op (not an error)
    if (record.current_container_type === to_container_type && record.current_container_id === to_container_id) {
      audit.push({ turn: turnNumber, action: 'transfer_skipped_already_at_destination', object_id: objectId, object_name: record.name, to_container_type, to_container_id, ts });
      transferred++;
      continue;
    }

    if (!from_container_type || !from_container_id || !to_container_type || !to_container_id) {
      _pushError(gameState, {
        turn: turnNumber, action: 'transfer', object_id: objectId, object_name: record.name,
        reason: 'missing_container_fields', entry, ts
      });
      errors++;
      continue;
    }

    // Validate from_container owns this object
    const fromIds = _resolveContainerIds(gameState, from_container_type, from_container_id);
    if (!fromIds || !fromIds.includes(objectId)) {
      _pushError(gameState, {
        turn: turnNumber, action: 'transfer', object_id: objectId, object_name: record.name,
        reason: 'from_container_does_not_own_object', from_container_type, from_container_id, ts
      });
      errors++;
      continue;
    }

    // Resolve destination
    const toIds = _resolveContainerIds(gameState, to_container_type, to_container_id);
    if (!toIds) {
      _pushError(gameState, {
        turn: turnNumber, action: 'transfer', object_id: objectId, object_name: record.name,
        reason: 'to_container_not_found', to_container_type, to_container_id, ts
      });
      errors++;
      continue;
    }

    // Perform transfer
    const fromIdx = fromIds.indexOf(objectId);
    fromIds.splice(fromIdx, 1);
    toIds.push(objectId);

    // One-container enforcement
    const allContainers = _findAllContainers(gameState, objectId);
    if (allContainers.length > 1) {
      // Undo transfer, restore to from_container
      toIds.pop();
      fromIds.push(objectId);
      _pushError(gameState, {
        turn: turnNumber, action: 'transfer', object_id: objectId, object_name: record.name,
        reason: 'one_container_violation_after_transfer', found_in: allContainers, ts
      });
      errors++;
      continue;
    }

    // Update record
    const prevType = record.current_container_type;
    const prevId   = record.current_container_id;
    record.current_container_type = to_container_type;
    record.current_container_id   = to_container_id;
    record.events.push({ turn: turnNumber, action: 'transferred', from_container_type: prevType, from_container_id: prevId, to_container_type, to_container_id, reason: reason || null, ts });
    if (record.events.length > 10) record.events.shift();

    transferred++;
    audit.push({ turn: turnNumber, action: 'transferred', object_id: objectId, object_name: record.name, from_container_type: prevType, from_container_id: prevId, to_container_type, to_container_id, ts });
    console.log(`[ObjectHelper] Transferred: ${objectId} (${record.name}) ${prevType}/${prevId} → ${to_container_type}/${to_container_id}`);
  }

  console.log(`[ObjectHelper] Turn ${turnNumber}: promoted=${promoted} transferred=${transferred} errors=${errors}`);
  return { promoted, transferred, errors, audit };
}

// ── transferObjectDirect ──────────────────────────────────────────────────────
// Synchronous, engine-authoritative transfer for a single known object.
// Used by ActionProcessor (drop, take) so AP never mutates object state directly.
// ObjectHelper remains sole mutation authority.
//
// Returns { success: true } or { success: false, error: string }.
// On failure, a structured entry is pushed to gameState.object_errors and the
// object's state is left unchanged (fail-closed).
function transferObjectDirect(gameState, objectId, toContainerType, toContainerId, turnNumber, reason) {
  const ts = new Date().toISOString();

  if (!objectId || !toContainerType || !toContainerId) {
    return { success: false, error: 'missing_required_args' };
  }
  if (!gameState.objects || typeof gameState.objects !== 'object') {
    return { success: false, error: 'no_object_registry' };
  }

  const record = gameState.objects[objectId];
  if (!record) {
    _pushError(gameState, { turn: turnNumber, action: 'transfer_direct', object_id: objectId, reason: 'object_not_found_in_registry', ts });
    return { success: false, error: 'object_not_found_in_registry' };
  }

  // v1.84.65: status guard — consumed/retired objects cannot be transferred
  if (record.status !== 'active') {
    _pushError(gameState, { turn: turnNumber, action: 'transfer_direct', object_id: objectId, object_name: record.name, reason: 'transfer_of_inactive_object', status: record.status, ts });
    return { success: false, error: 'transfer_of_inactive_object' };
  }

  const fromContainerType = record.current_container_type;
  const fromContainerId   = record.current_container_id;

  const fromIds = _resolveContainerIds(gameState, fromContainerType, fromContainerId);
  if (!fromIds || !fromIds.includes(objectId)) {
    _pushError(gameState, { turn: turnNumber, action: 'transfer_direct', object_id: objectId, object_name: record.name, reason: 'from_container_does_not_own_object', from_container_type: fromContainerType, from_container_id: fromContainerId, ts });
    return { success: false, error: 'from_container_does_not_own_object' };
  }

  const toIds = _resolveContainerIds(gameState, toContainerType, toContainerId);
  if (!toIds) {
    _pushError(gameState, { turn: turnNumber, action: 'transfer_direct', object_id: objectId, object_name: record.name, reason: 'to_container_not_found', to_container_type: toContainerType, to_container_id: toContainerId, ts });
    return { success: false, error: 'to_container_not_found' };
  }

  // Perform transfer
  const fromIdx = fromIds.indexOf(objectId);
  fromIds.splice(fromIdx, 1);
  toIds.push(objectId);

  // One-container enforcement
  const allContainers = _findAllContainers(gameState, objectId);
  if (allContainers.length > 1) {
    // Undo transfer, restore to from_container
    toIds.pop();
    fromIds.push(objectId);
    _pushError(gameState, { turn: turnNumber, action: 'transfer_direct', object_id: objectId, object_name: record.name, reason: 'one_container_violation_after_transfer', found_in: allContainers, ts });
    return { success: false, error: 'one_container_violation_after_transfer' };
  }

  // Update record
  record.current_container_type = toContainerType;
  record.current_container_id   = toContainerId;
  record.events.push({ turn: turnNumber, action: 'transferred', from_container_type: fromContainerType, from_container_id: fromContainerId, to_container_type: toContainerType, to_container_id: toContainerId, reason: reason || null, ts });
  if (record.events.length > 10) record.events.shift();

  console.log(`[ObjectHelper] transferDirect: ${objectId} (${record.name}) ${fromContainerType}/${fromContainerId} → ${toContainerType}/${toContainerId}`);
  return { success: true };
}

// ── applyConditionUpdate ─────────────────────────────────────────────────────
// Writes a condition entry to an ObjectRecord. Deduplicates by description
// (case-insensitive). Caps at 10 entries FIFO. Safe to call multiple times per
// turn — only genuinely new states are appended.
function applyConditionUpdate(gameState, objectId, conditionDesc, evidence, turnNumber) {
  if (!gameState.objects || !gameState.objects[objectId]) {
    return { applied: false, objectId, reason: 'object_not_found' };
  }
  const record = gameState.objects[objectId];
  if (record.status !== 'active') {
    return { applied: false, objectId, reason: 'object_not_active' };
  }
  const desc = String(conditionDesc || '').trim();
  if (!desc) return { applied: false, objectId, reason: 'empty_condition' };

  // Ensure conditions array exists (backcompat for records created before v1.84.63)
  if (!Array.isArray(record.conditions)) record.conditions = [];

  // Dedup — skip if same description already recorded
  const normalised = desc.toLowerCase();
  if (record.conditions.some(c => c.description.toLowerCase() === normalised)) {
    return { applied: false, objectId, reason: 'duplicate' };
  }

  // Append, cap at 10 (FIFO)
  record.conditions.push({ description: desc, set_turn: turnNumber, evidence: String(evidence || '').trim() });
  if (record.conditions.length > 10) record.conditions.shift();

  console.log(`[ObjectHelper] conditionUpdate: ${objectId} (${record.name}) += "${desc}"`);
  return { applied: true, objectId, reason: 'appended' };
}

// ── retireObject ──────────────────────────────────────────────────────────────────
// Marks an object as consumed — removes from its container's object_ids[] and
// sets status:'consumed'. Record is preserved in gameState.objects for audit history.
//
// Returns { retired: bool, objectId, reason }.
// On failure, returns without modifying state.
function retireObject(gameState, objectId, reason, turnNumber) {
  const ts = new Date().toISOString();

  if (!gameState.objects || !gameState.objects[objectId]) {
    return { retired: false, objectId, reason: 'object_not_found' };
  }

  const record = gameState.objects[objectId];
  if (record.status !== 'active') {
    return { retired: false, objectId, reason: 'not_active' };
  }

  // Remove from container's object_ids[]
  const containerIds = _resolveContainerIds(gameState, record.current_container_type, record.current_container_id);
  if (containerIds) {
    const idx = containerIds.indexOf(objectId);
    if (idx !== -1) containerIds.splice(idx, 1);
  }

  // Set consumed status
  record.status = 'consumed';

  // Append event (FIFO cap 10)
  if (!Array.isArray(record.events)) record.events = [];
  record.events.push({ turn: turnNumber, action: 'retired', reason: String(reason || '').trim(), ts });
  if (record.events.length > 10) record.events.shift();

  console.log(`[ObjectHelper] retired: ${objectId} (${record.name}) — ${reason}`);
  return { retired: true, objectId, reason: 'consumed' };
}

module.exports = { run, transferObjectDirect, applyConditionUpdate, retireObject, OH_VERSION };
