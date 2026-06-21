'use strict';

// =============================================================================
// TlsObjectOperationExecutor — P4 Dry-Run v0
// Deterministic, synchronous, read-only pre-AP executor.
// Reads tls_instruction_v1 (P2 prediction) + pre-AP ORS state.
// Validates operation eligibility, recomputes routing independently,
// predicts the ObjectHelper call that should be made, and returns
// a tls_executor_dry_run_v1 envelope.
//
// P4 is dry-run only — NEVER mutates objects, NEVER calls ObjectHelper,
// NEVER bypasses ActionProcessor, NEVER implements P5 behavior.
// =============================================================================

/**
 * Execute a TLS object operation instruction in dry-run mode.
 * Pure function — same inputs always produce the same output.
 * Does not mutate state, call ObjectHelper, or write any diagnostic surfaces.
 *
 * @param {object} state — gameState object (pre-AP, read-only)
 * @param {object|null} instruction — debug.tls_instruction_v1 (P2 prediction)
 * @param {object} options — { dryRun: true } (always true in P4)
 * @returns {object} tls_executor_dry_run_v1 envelope
 */
function executeTlsObjectInstruction(state, instruction, options) {
  const _dryRun = true; // P4 v0 always dry-run — never allow live mutation

  // ── Base envelope skeleton ──────────────────────────────────────────────
  const _base = () => ({
    schema_version: 'tls_executor_dry_run_v1',
    dry_run: _dryRun,
    instruction_valid: false,
    operation_allowed: false,
    outcome: null,
    fail_closed_reason: null,
    validation_attempted: false,
    validation: null,
    predicted_call: null,
    predicted_result: null,
    warnings: [],
    would_project: null
  });

  // ── Helper: is a value a positive finite integer? ────────────────────────
  const _isPositiveFiniteInteger = (v) =>
    typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v > 0;

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE A — Instruction validity (before any ORS access)
  // ═══════════════════════════════════════════════════════════════════════════

  // Step 1: null/undefined instruction (defensive — normal queue-loop guards prevent this)
  if (instruction == null) {
    const env = _base();
    env.schema_version = 'tls_executor_dry_run_v1'; // explicit for missing-instruction branch
    env.fail_closed_reason = 'missing_instruction';
    env.warnings.push({ code: 'missing_instruction', severity: 'advisory', message: 'Executor invoked with null/undefined instruction. Under normal queue-loop integration this should not occur — the if (debug.tls_instruction_v1) guard prevents it.' });
    return env;
  }

  // Step 2: wrong schema version
  if (instruction.schema_version !== 'tls_ors_instruction_v1') {
    const env = _base();
    env.fail_closed_reason = 'wrong_schema';
    return env;
  }

  // Step 3: unsupported operation family
  if (instruction.operation_family !== 'take') {
    const env = _base();
    env.fail_closed_reason = 'unsupported_operation';
    return env;
  }

  // Step 4: missing source (null-safe — instruction.object may be absent)
  if (instruction.object == null || instruction.object.id == null || instruction.object.id === '') {
    const env = _base();
    env.fail_closed_reason = 'missing_source';
    return env;
  }

  // Step 5-6: missing source container (null-safe)
  if (instruction.source == null ||
      instruction.source.container_type == null || instruction.source.container_type === '' ||
      instruction.source.container_id == null || instruction.source.container_id === '') {
    const env = _base();
    env.fail_closed_reason = 'missing_source';
    return env;
  }

  // Step 7: requested_quantity validity (null-safe)
  if (instruction.quantity == null) {
    const env = _base();
    env.fail_closed_reason = 'missing_quantity';
    return env;
  }
  const _reqQty = instruction.quantity.requested_quantity;
  if (_reqQty == null) {
    const env = _base();
    env.fail_closed_reason = 'missing_quantity';
    return env;
  }
  if (!_isPositiveFiniteInteger(_reqQty)) {
    const env = _base();
    env.fail_closed_reason = 'invalid_quantity';
    return env;
  }

  // Step 8: observed_available_quantity validity
  const _obsQty = instruction.quantity.observed_available_quantity;
  if (_obsQty == null) {
    const env = _base();
    env.fail_closed_reason = 'missing_quantity';
    return env;
  }
  if (!_isPositiveFiniteInteger(_obsQty)) {
    const env = _base();
    env.fail_closed_reason = 'invalid_quantity';
    return env;
  }

  // Step 9-10: destination validity (null-safe)
  if (instruction.destination == null ||
      instruction.destination.container_type == null || instruction.destination.container_type === '' ||
      instruction.destination.container_id == null || instruction.destination.container_id === '') {
    const env = _base();
    env.fail_closed_reason = 'missing_destination';
    return env;
  }

  // Phase A passed — instruction is structurally valid
  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE B — Live ORS validation
  // ═══════════════════════════════════════════════════════════════════════════

  const sourceId = instruction.object.id;

  // Step 11: object registry exists
  if (state.objects == null || typeof state.objects !== 'object') {
    const env = _base();
    env.instruction_valid = true;
    env.validation_attempted = true;
    env.outcome = 'fail_closed';
    env.fail_closed_reason = 'no_object_registry';
    env.validation = { source_exists: false, source_active: false, quantity_matches_instruction: false, container_matches_instruction: false, destination_valid: false, routing_recomputed: false };
    return env;
  }

  // Step 12: source object exists
  const record = state.objects[sourceId];
  if (record == null) {
    const env = _base();
    env.instruction_valid = true;
    env.validation_attempted = true;
    env.outcome = 'fail_closed';
    env.fail_closed_reason = 'source_not_found';
    env.validation = { source_exists: false, source_active: false, quantity_matches_instruction: false, container_matches_instruction: false, destination_valid: false, routing_recomputed: false };
    return env;
  }

  // Collect validation facts
  const sourceExists = true;

  // Step 13: source active status
  const sourceActive = record.status === 'active';
  if (!sourceActive) {
    const env = _base();
    env.instruction_valid = true;
    env.validation_attempted = true;
    env.outcome = 'fail_closed';
    env.fail_closed_reason = 'source_inactive';
    env.validation = { source_exists: sourceExists, source_active: sourceActive, quantity_matches_instruction: false, container_matches_instruction: false, destination_valid: false, routing_recomputed: false };
    return env;
  }

  // Step 14: quantity match — ORS current quantity vs v1 observed_available_quantity
  // P4 v0 requires positive finite integers for countable stacks (plan D2, D3)
  const orsQuantity = record.quantity;
  // Plan D3: do NOT replicate ObjectHelper's default-to-1 — fail closed if quantity is missing
  const quantityIsNumber = typeof orsQuantity === 'number';
  const quantityMatches = quantityIsNumber && orsQuantity === _obsQty;

  // Steps 15-16: container field match (field-level string equality only — NOT container-array ownership)
  const containerMatches =
    record.current_container_type === instruction.source.container_type &&
    record.current_container_id === instruction.source.container_id;

  // Step 17-18: destination validation — must be 'player' with valid player object_ids array
  const destValid =
    instruction.destination.container_type === 'player' &&
    state.player != null &&
    Array.isArray(state.player.object_ids);

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE C — Routing recomputation (independent of v1 routing block)
  // ═══════════════════════════════════════════════════════════════════════════

  // Only attempt routing recomputation if source exists and is active and quantity is a number
  let recomputedRouting = null;
  let recomputedMethod = null;
  let routingRecomputed = false;

  if (sourceExists && sourceActive && quantityIsNumber) {
    const effectiveAvailable = orsQuantity;
    const effectiveRequested = _reqQty;

    if (effectiveRequested < effectiveAvailable) {
      recomputedRouting = 'partial_split';
      recomputedMethod = 'splitObjectDirect';
    } else if (effectiveRequested === effectiveAvailable) {
      recomputedRouting = 'whole_transfer';
      recomputedMethod = 'transferObjectDirect';
    } else {
      // effectiveRequested > effectiveAvailable
      recomputedRouting = 'fail_closed';
      recomputedMethod = null;
    }
    routingRecomputed = true;
  }

  // Check for blocking failures before proceeding to Phase D

  // Step 14 (continued): quantity mismatch blocks operation
  if (!quantityMatches) {
    const env = _base();
    env.instruction_valid = true;
    env.validation_attempted = true;
    env.outcome = 'fail_closed';
    env.fail_closed_reason = 'quantity_changed';
    env.validation = { source_exists: sourceExists, source_active: sourceActive, quantity_matches_instruction: false, container_matches_instruction: containerMatches, destination_valid: destValid, routing_recomputed: routingRecomputed };
    if (!quantityIsNumber) {
      env.warnings.push({ code: 'quantity_not_a_number', severity: 'advisory', message: 'ObjectHelper defaults missing quantity to 1 (legacy). Executor does NOT replicate this — fail-closed on missing quantity.' });
    }
    return env;
  }

  // Steps 15-16 (continued): container mismatch blocks operation
  if (!containerMatches) {
    const env = _base();
    env.instruction_valid = true;
    env.validation_attempted = true;
    env.outcome = 'fail_closed';
    env.fail_closed_reason = 'container_changed';
    env.validation = { source_exists: sourceExists, source_active: sourceActive, quantity_matches_instruction: quantityMatches, container_matches_instruction: false, destination_valid: destValid, routing_recomputed: routingRecomputed };
    return env;
  }

  // Steps 17-18: destination validation blocks operation
  if (!destValid) {
    const env = _base();
    env.instruction_valid = true;
    env.validation_attempted = true;
    env.outcome = 'fail_closed';
    env.fail_closed_reason = instruction.destination.container_type !== 'player' ? 'unsupported_destination' : 'destination_not_found';
    env.validation = { source_exists: sourceExists, source_active: sourceActive, quantity_matches_instruction: quantityMatches, container_matches_instruction: containerMatches, destination_valid: false, routing_recomputed: routingRecomputed };
    return env;
  }

  // Over-stack: requested > available (recomputed as fail_closed)
  if (recomputedRouting === 'fail_closed') {
    const env = _base();
    env.instruction_valid = true;
    env.validation_attempted = true;
    env.operation_allowed = false;
    env.outcome = 'fail_closed';
    env.fail_closed_reason = 'over_stack';
    env.validation = { source_exists: sourceExists, source_active: sourceActive, quantity_matches_instruction: quantityMatches, container_matches_instruction: containerMatches, destination_valid: destValid, routing_recomputed: routingRecomputed };
    return env;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Routing consistency check (Step 22): compare recomputed vs v1
  // ═══════════════════════════════════════════════════════════════════════════

  const v1IntendedMutation = instruction.routing?.intended_mutation ?? null;
  const v1ExpectedMethod = instruction.executor?.expected_helper_method ?? null;

  if (recomputedRouting !== v1IntendedMutation || recomputedMethod !== v1ExpectedMethod) {
    const env = _base();
    env.instruction_valid = true;
    env.validation_attempted = true;
    env.operation_allowed = false;
    env.outcome = 'fail_closed';
    env.fail_closed_reason = 'routing_mismatch';
    env.validation = { source_exists: sourceExists, source_active: sourceActive, quantity_matches_instruction: quantityMatches, container_matches_instruction: containerMatches, destination_valid: destValid, routing_recomputed: routingRecomputed };
    return env;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE D — Prediction assembly (all guards passed)
  // ═══════════════════════════════════════════════════════════════════════════

  let predictedCall = null;
  let predictedResult = null;
  let outcome = null;

  if (recomputedRouting === 'partial_split') {
    outcome = 'partial_split';
    predictedCall = {
      method: 'splitObjectDirect',
      parameters: {
        source_object_id: sourceId,
        extract_quantity: _reqQty,
        destination_container_type: 'player',
        destination_container_id: 'player'
      }
    };
    predictedResult = {
      source_quantity_before: orsQuantity,
      source_quantity_after: orsQuantity - _reqQty,
      successor_quantity: _reqQty
    };
  } else if (recomputedRouting === 'whole_transfer') {
    outcome = 'whole_transfer';
    predictedCall = {
      method: 'transferObjectDirect',
      parameters: {
        object_id: sourceId,
        destination_container_type: 'player',
        destination_container_id: 'player'
      }
    };
    predictedResult = {
      source_quantity_before: orsQuantity,
      source_quantity_after: null,
      successor_quantity: null
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE E — Return envelope
  // ═══════════════════════════════════════════════════════════════════════════

  // Collect advisory warnings
  const warnings = [];

  // Check resolution confidence from v1 provenance (advisory only — does not block)
  const resolutionConfidence = instruction.provenance?.resolution_confidence ?? null;
  if (resolutionConfidence !== null && typeof resolutionConfidence === 'number' && resolutionConfidence < 0.5) {
    warnings.push({ code: 'low_resolution_confidence', severity: 'advisory', message: 'v1 resolution_confidence is below 0.5 (' + resolutionConfidence + '). Prediction may be based on weak evidence.' });
  }

  return {
    schema_version: 'tls_executor_dry_run_v1',
    dry_run: _dryRun,
    instruction_valid: true,
    operation_allowed: true,
    outcome: outcome,
    fail_closed_reason: null,
    validation_attempted: true,
    validation: {
      source_exists: sourceExists,
      source_active: sourceActive,
      quantity_matches_instruction: quantityMatches,
      container_matches_instruction: containerMatches,
      destination_valid: destValid,
      routing_recomputed: routingRecomputed
    },
    predicted_call: predictedCall,
    predicted_result: predictedResult,
    warnings: warnings,
    would_project: null
  };
}

module.exports = { executeTlsObjectInstruction };
