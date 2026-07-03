'use strict';

// =============================================================================
// ObjectOperationBridge — Fail-Closed Downstream Routing
// Deterministic, synchronous, read-only post-AP bridge.
// Reads P4 dry-run envelope (authoritative), classifies supported
// fail-closed outcomes, and returns a routing receipt. Does NOT
// execute downstream effects — index.js owns setting _rcSkippedReason,
// injecting narrator constraints, and emitting diagnostics.
//
// Activated case (v1.91.73): partial-stack TAKE over-stack.
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
 * @returns {Object} receipt — { active, rc_skip_reason, narration_constraint, diagnostics }
 */
function evaluateOperation(params = {}) {
  const { dryRunEnvelope, apActuals, tlsPartialStackResult, operationFamily } = params;

  // ── Null/missing guard ──────────────────────────────────────────────
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
