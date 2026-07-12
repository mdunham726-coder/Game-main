'use strict';

// =============================================================================
// ObjectOperationBridge — Fail-Closed Downstream Routing
// Deterministic, synchronous, read-only post-AP bridge.
// Reads P4 dry-run envelope (authoritative), classifies supported
// fail-closed outcomes, and returns a routing receipt. Does NOT
// execute downstream effects — index.js owns setting _rcSkippedReason,
// injecting narrator constraints, and emitting diagnostics.
//
// Activated cases: partial-stack TAKE over-stack, plus supported single-action
// semantic DROP turns whose AP refusal and lack of live execution are confirmed.
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
    liveExecutionResult
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
    const live_drop_execution_absent = liveExecutionResult === null || liveExecutionResult === undefined;

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
      const narration_constraint = validPrediction
        ? 'The player attempted a DROP object operation. TLS evaluated an authoritative dry-run prediction, but DROP execution is disabled in this phase. No object moved, split, transferred, appeared, disappeared, or changed. Narrate the attempt as not executed and do not describe success or partial success.'
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
