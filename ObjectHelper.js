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

    const objectId = _generateObjectId(name, container_type, container_id, temp_ref);

    // If this ID already exists (same object re-narrated on a later turn), skip silently.
    if (gameState.objects[objectId]) {
      tempRefMap[temp_ref] = objectId; // still populate map for transfer pass
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

module.exports = { run, transferObjectDirect, OH_VERSION };
