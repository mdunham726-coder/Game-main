'use strict';

// =============================================================================
// ObjectOperationBridge — Fail-Closed Downstream Routing
// Deterministic, synchronous, read-only post-AP bridge.
// Reads P4 dry-run envelope (authoritative), classifies supported
// fail-closed outcomes, and returns a routing receipt. Does NOT
// execute downstream effects — index.js owns setting _rcSkippedReason,
// injecting narrator constraints, and emitting diagnostics.
//
// Activated cases: partial-stack TAKE over-stack; single-action semantic TAKE
// with no matching resolver candidate (Phase-A P4 envelope, no-mutation proven
// via absent AP/TLS execution evidence); plus supported single-action semantic
// DROP turns whose AP refusal and lack of live execution are confirmed.
// All other fail-closed reasons pass through inactive.
//
// Read-only guarantee: NEVER mutates gameState, debug, passed objects,
// P5-0 snapshot, or any durable state. NEVER calls ObjectHelper.
// NEVER calls diag.emitDiagnostics. NEVER imports index.js.
// =============================================================================

/**
 * @param {Object} params
 * @param {Object|null} params.dryRunEnvelope         — debug.tls_executor_dry_run (required, authoritative)
 * @param {Object|null} params.apActuals               — gameState._apActuals (optional, corroboration)
 * @param {Object|null} params.tlsPartialStackResult   — gameState._tlsPartialStackResult (optional, corroboration)
 * @param {string|null} params.operationFamily         — e.g. 'take' (optional, defensive guard)
 * @param {string|null} params.semanticOperationFamily — parser family independent of TLS instruction presence
 * @param {boolean} params.semanticPathSingleAction    — true only for the supported semantic single-action path
 * @param {Object|null} params.instructionEnvelope     — current TLS v1 instruction, when produced
 * @param {Object|null} params.liveExecutionResult     — current-turn live execution receipt, when produced
 * @param {Object|null} params.resolverEvidence        — current-turn resolver_evidence_v1, when produced (optional, no-candidates TAKE only)
 * @param {Array|null}  params.apExecutedTransfers     — gameState._apExecutedTransfers, when produced (optional, no-candidates TAKE only)
 * @returns {Object} receipt — { active, rc_skip_reason, narration_constraint, drop_dry_run_seal, diagnostics }
 */
function evaluateOperation(params = {}) {
  const {
    dryRunEnvelope,
    apActuals,
    tlsPartialStackResult,
    operationFamily,
    semanticOperationFamily,
    semanticPathSingleAction,
    instructionEnvelope,
    liveExecutionResult,
    resolverEvidence,
    apExecutedTransfers
  } = params;

  // ── Null/missing guard ──────────────────────────────────────────────
  if (semanticOperationFamily === 'drop' && semanticPathSingleAction === true) {
    const apKeys = apActuals && typeof apActuals === 'object' ? Object.keys(apActuals) : [];
    const ap_refusal_confirmed = !!(
      apKeys.length === 4 &&
      apActuals.operation_family === 'drop' &&
      apActuals.routing === 'quarantined' &&
      apActuals.helper_method === null &&
      apActuals.outcome === 'refused_ownership'
    );
    const dryRunPrediction = dryRunEnvelope?.predicted_call;
    const dryRunPredictionParams = dryRunPrediction?.parameters;
    const dryRunPredictedResult = dryRunEnvelope?.predicted_result;
    const partialReceiptPrediction = tlsPartialStackResult?.predicted_call;
    const partialReceiptParams = partialReceiptPrediction?.parameters;
    const partialSplitResult = tlsPartialStackResult?.split_result;
    const partialSourceId = partialSplitResult?.source_object_id;
    const partialSuccessorId = partialSplitResult?.successor_object_id;
    const partial_drop_execution_confirmed = !!(
      instructionEnvelope?.operation_family === 'drop' &&
      instructionEnvelope?.routing?.intended_mutation === 'partial_split' &&
      instructionEnvelope?.executor?.expected_helper_method === 'splitObjectDirect' &&
      dryRunEnvelope?.operation_family === 'drop' &&
      dryRunEnvelope?.operation_allowed === true &&
      dryRunEnvelope?.outcome === 'partial_split' &&
      dryRunPrediction?.method === 'splitObjectDirect' &&
      tlsPartialStackResult?.schema_version === 'tls_partial_stack_execution_v1' &&
      tlsPartialStackResult?.executed === true &&
      partialSplitResult?.ok === true &&
      partialSplitResult?.reason === 'tls_partial_stack_drop' &&
      typeof partialSourceId === 'string' && partialSourceId.trim().length > 0 &&
      typeof partialSuccessorId === 'string' && partialSuccessorId.trim().length > 0 &&
      partialSourceId !== partialSuccessorId &&
      partialReceiptPrediction?.method === dryRunPrediction.method &&
      partialReceiptParams?.source_object_id === dryRunPredictionParams?.source_object_id &&
      partialReceiptParams?.extract_quantity === dryRunPredictionParams?.extract_quantity &&
      partialReceiptParams?.destination_container_type === dryRunPredictionParams?.destination_container_type &&
      partialReceiptParams?.destination_container_id === dryRunPredictionParams?.destination_container_id &&
      partialSplitResult.source_object_id === dryRunPredictionParams?.source_object_id &&
      partialSplitResult.requested_quantity === dryRunPredictionParams?.extract_quantity &&
      partialSplitResult.applied_quantity === dryRunPredictionParams?.extract_quantity &&
      partialSplitResult.dest_container_type === dryRunPredictionParams?.destination_container_type &&
      partialSplitResult.dest_container_id === dryRunPredictionParams?.destination_container_id &&
      partialSplitResult.source_quantity_before === dryRunPredictedResult?.source_quantity_before &&
      partialSplitResult.source_quantity_after === dryRunPredictedResult?.source_quantity_after &&
      Number.isInteger(partialSplitResult.source_quantity_before) &&
      Number.isInteger(partialSplitResult.applied_quantity) &&
      Number.isInteger(partialSplitResult.source_quantity_after) &&
      partialSplitResult.source_quantity_before - partialSplitResult.applied_quantity === partialSplitResult.source_quantity_after &&
      partialSplitResult.source_quantity_after > 0
    );
    const live_drop_execution_absent =
      (liveExecutionResult === null || liveExecutionResult === undefined) &&
      !partial_drop_execution_confirmed;

    if (ap_refusal_confirmed && live_drop_execution_absent) {
      const instruction_present = instructionEnvelope !== null && instructionEnvelope !== undefined;
      const dry_run_present = dryRunEnvelope !== null && dryRunEnvelope !== undefined;
      const dryRunOutcome = dryRunEnvelope?.outcome ?? null;
      const failReason = dryRunEnvelope?.fail_closed_reason
        ?? instructionEnvelope?.routing?.fail_closed_reason
        ?? instructionEnvelope?.provenance?.fail_closed_reason
        ?? null;
      const validPrediction = dryRunEnvelope?.operation_allowed === true &&
        (dryRunOutcome === 'partial_split' || dryRunOutcome === 'whole_transfer');
      const requestedQuantity = instructionEnvelope?.quantity?.requested_quantity;
      const availableQuantity = instructionEnvelope?.quantity?.observed_available_quantity;
      const overStackQuantityExplanation = Number.isInteger(requestedQuantity) && Number.isInteger(availableQuantity)
        ? `The player requested quantity ${requestedQuantity}, but only quantity ${availableQuantity} is currently available in their possession.`
        : 'The player requested a greater quantity than they currently possess.';
      const narration_constraint = validPrediction
        ? 'The player attempted a DROP object operation. TLS evaluated an authoritative dry-run prediction, but DROP execution is disabled in this phase. No object moved, split, transferred, appeared, disappeared, or changed. Narrate the attempt as not executed and do not describe success or partial success.'
        : failReason === 'over_stack'
          ? `${overStackQuantityExplanation} The requested quantity is unavailable, so the DROP operation failed completely. No object moved, split, transferred, appeared, disappeared, or changed. Narrate the quantity shortfall clearly. Do not invent an environmental, spatial, physical, or motivational reason for the failure, and do not describe success or partial success.`
        : failReason
          ? `The player attempted a DROP object operation, but it failed closed (${failReason}). No object moved, split, transferred, appeared, disappeared, or changed. Narrate the failed attempt only and do not describe success or partial success.`
          : 'The player attempted a DROP object operation, but no authoritative executable DROP result was produced and DROP execution is disabled in this phase. No object moved, split, transferred, appeared, disappeared, or changed. Narrate the attempt as not executed.';

      return {
        active: true,
        rc_skip_reason: 'tls_drop_dry_run',
        narration_constraint,
        drop_dry_run_seal: true,
        diagnostics: {
          fail_closed_reason: failReason,
          operation_family: 'drop',
          p4_outcome: dryRunOutcome,
          p4_operation_allowed: dryRunEnvelope?.operation_allowed ?? null,
          ap_quarantine_confirmed: true,
          p5a2_absent_confirmed: null,
          instruction_present,
          dry_run_present,
          ap_refusal_confirmed,
          live_drop_execution_absent,
          drop_dry_run_seal: true,
          constraint_supplied: true
        }
      };
    }

    return {
      active: false,
      rc_skip_reason: null,
      narration_constraint: '',
      drop_dry_run_seal: false,
      diagnostics: {
        fail_closed_reason: null,
        operation_family: 'drop',
        p4_outcome: dryRunEnvelope?.outcome ?? null,
        p4_operation_allowed: dryRunEnvelope?.operation_allowed ?? null,
        ap_quarantine_confirmed: ap_refusal_confirmed,
        p5a2_absent_confirmed: null,
        instruction_present: instructionEnvelope !== null && instructionEnvelope !== undefined,
        dry_run_present: dryRunEnvelope !== null && dryRunEnvelope !== undefined,
        ap_refusal_confirmed,
        live_drop_execution_absent,
        drop_dry_run_seal: false,
        constraint_supplied: false
      }
    };
  }

  if (dryRunEnvelope == null) {
    return {
      active: false,
      rc_skip_reason: null,
      narration_constraint: '',
      diagnostics: {
        fail_closed_reason: null,
        operation_family: operationFamily ?? null,
        p4_outcome: null,
        p4_operation_allowed: null,
        ap_quarantine_confirmed: false,
        p5a2_absent_confirmed: false,
        constraint_supplied: false
      }
    };
  }

  // ── Supported case: single-action TAKE with no matching resolver candidate ──
  // These are Phase-A P4 failures (TlsObjectOperationExecutor validates the
  // instruction's own shape before touching ORS), so P4 leaves outcome:null —
  // they never reach the generic outcome==='fail_closed' gate below. A real
  // object can still exist while P4 reports missing_source/missing_quantity/
  // invalid_quantity for unrelated reasons, so P4's mechanical reason alone is
  // not sufficient evidence; the resolver's own no_candidates result is what
  // proves nothing existed to take. No-candidate TAKEs bypass AP's quarantine
  // receipt entirely (AP only writes it when resolveCellItemByName finds a
  // match first) and fall into AP's environmental-gather branch instead, so
  // apActuals is deliberately not required here — absence of AP/TLS execution
  // evidence is proven directly via apExecutedTransfers/tlsPartialStackResult/
  // liveExecutionResult instead. dryRunEnvelope.operation_family is checked
  // directly (not just the semantic layer) so a malformed envelope cannot
  // borrow TAKE containment merely because the outer classification said TAKE.
  const _PHASE_A_NO_CANDIDATE_COMPATIBLE_REASONS = new Set(['missing_source', 'missing_quantity', 'invalid_quantity']);
  if (
    semanticOperationFamily === 'take' &&
    semanticPathSingleAction === true &&
    resolverEvidence?.fail_closed_reason === 'no_candidates' &&
    dryRunEnvelope.operation_family === 'take' &&
    dryRunEnvelope.operation_allowed === false &&
    dryRunEnvelope.outcome === null &&
    _PHASE_A_NO_CANDIDATE_COMPATIBLE_REASONS.has(dryRunEnvelope.fail_closed_reason) &&
    (apExecutedTransfers == null || apExecutedTransfers.length === 0) &&
    tlsPartialStackResult == null &&
    liveExecutionResult == null
  ) {
    const narration_constraint =
      'No tracked item matching the request was available to take from the current location. ' +
      'This action definitively failed — no items were moved, transferred, taken, or added to ' +
      'the player\'s inventory. Do not describe the player obtaining, holding, or possessing any ' +
      'items as a result of this action, and do not invent an item, an item count, or a location ' +
      'for one. Do not describe partial success or partial transfer — this object operation had ' +
      'no effect. Honor the attempt, but describe the failure.';

    return {
      active: true,
      rc_skip_reason: 'tls_no_candidates',
      narration_constraint,
      diagnostics: {
        fail_closed_reason: 'no_candidates',
        resolver_fail_closed_reason: resolverEvidence.fail_closed_reason,
        p4_fail_closed_reason: dryRunEnvelope.fail_closed_reason,
        operation_family: operationFamily ?? null,
        p4_outcome: dryRunEnvelope.outcome,
        p4_operation_allowed: dryRunEnvelope.operation_allowed,
        ap_transfer_absent: true,
        partial_stack_result_absent: true,
        live_execution_absent: true,
        constraint_supplied: true
      }
    };
  }

  // ── Pass-through: non-fail-closed or operation_allowed !== false ────
  if (dryRunEnvelope.operation_allowed !== false || dryRunEnvelope.outcome !== 'fail_closed') {
    return {
      active: false,
      rc_skip_reason: null,
      narration_constraint: '',
      diagnostics: {
        fail_closed_reason: dryRunEnvelope.fail_closed_reason ?? null,
        operation_family: operationFamily ?? null,
        p4_outcome: dryRunEnvelope.outcome ?? null,
        p4_operation_allowed: dryRunEnvelope.operation_allowed ?? null,
        ap_quarantine_confirmed: false,
        p5a2_absent_confirmed: false,
        constraint_supplied: false
      }
    };
  }

  // ── Supported case: over-stack TAKE ─────────────────────────────────
  if (dryRunEnvelope.fail_closed_reason === 'over_stack') {
    // Defensive guard: over-stack on non-take operation family is logically
    // impossible per current executor (over-stack requires requested_quantity,
    // which only exists in partial-stack instructions), but guard anyway.
    if (operationFamily !== undefined && operationFamily !== null && operationFamily !== 'take') {
      return {
        active: false,
        rc_skip_reason: null,
        narration_constraint: '',
        diagnostics: {
          fail_closed_reason: 'over_stack',
          operation_family: operationFamily,
          p4_outcome: 'fail_closed',
          p4_operation_allowed: false,
          ap_quarantine_confirmed: false,
          p5a2_absent_confirmed: false,
          constraint_supplied: false
        }
      };
    }

    // Corroboration checks (diagnostic, not decision)
    const ap_quarantine_confirmed = !!(
      apActuals &&
      apActuals.outcome === 'refused_ownership' &&
      apActuals.routing === 'quarantined'
    );
    const p5a2_absent_confirmed = tlsPartialStackResult === null || tlsPartialStackResult === undefined;

    // Constraint prose — exact text per plan, must not be paraphrased.
    const narration_constraint =
      'The player attempted to take more items from a stack than exist. ' +
      'This action definitively failed — no items were moved, transferred, taken, ' +
      'or added to the player\'s inventory. Do not describe the player obtaining, ' +
      'holding, or possessing any items as a result of this action. Do not describe ' +
      'partial success, partial transfer, or compromise — this object operation had ' +
      'no effect. Honor the attempt, but describe the failure.';

    return {
      active: true,
      rc_skip_reason: 'tls_over_stack',
      narration_constraint,
      diagnostics: {
        fail_closed_reason: 'over_stack',
        operation_family: operationFamily ?? null,
        p4_outcome: 'fail_closed',
        p4_operation_allowed: false,
        ap_quarantine_confirmed,
        p5a2_absent_confirmed,
        constraint_supplied: true
      }
    };
  }

  // ── Unsupported fail-closed catch-all ───────────────────────────────
  return {
    active: false,
    rc_skip_reason: null,
    narration_constraint: '',
    diagnostics: {
      fail_closed_reason: dryRunEnvelope.fail_closed_reason ?? null,
      operation_family: operationFamily ?? null,
      p4_outcome: dryRunEnvelope.outcome ?? null,
      p4_operation_allowed: dryRunEnvelope.operation_allowed ?? null,
      ap_quarantine_confirmed: false,
      p5a2_absent_confirmed: false,
      constraint_supplied: false
    }
  };
}

module.exports = { evaluateOperation };
