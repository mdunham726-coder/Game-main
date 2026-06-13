"use strict";

/**
 * ObjectOperationResolver.js — P1a: Resolver Evidence (Observe-Only)
 *
 * LLM-backed evidence resolver for partial-stack TAKE.
 * Three layers:
 *   1. Candidate Enumeration — deterministic JS
 *   2. LLM Evidence Analysis — model call
 *   3. ORS Fact Validation — deterministic JS
 *
 * Exports:
 *   async function resolvePartialStackTake(state, actions) → resolver_evidence_v1
 *
 * No mutation. No AP helpers. No deterministic English matching.
 */

// ── Dependencies ────────────────────────────────────────────────────────────────
let _axios = null;
try {
  _axios = require("axios");
} catch (_) {
  // validated at call-time
}

// ── Constants ───────────────────────────────────────────────────────────────────
const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";
const DEEPSEEK_MODEL = "deepseek-chat";
const DEEPSEEK_TEMPERATURE = 0;
const DEEPSEEK_MAX_TOKENS = 512;
const DEEPSEEK_TIMEOUT_MS = 15000;

const EVIDENCE_SCHEMA_VERSION = "resolver_evidence_v1";
const RESOLVER_KIND = "resolvePartialStackTake";

// ── Layer 1: Candidate Enumeration ──────────────────────────────────────────────

/**
 * Build a container key for the player's current grid cell.
 * Replicates existing project pattern: LOC:{mx},{my}:{lx},{ly}
 */
function _buildCellKey(state) {
  const pos = state?.world?.position;
  if (!pos) return null;
  return `LOC:${pos.mx},${pos.my}:${pos.lx},${pos.ly}`;
}

/**
 * Build a container key for a site floor position.
 * Pattern: {site_id}:{x},{y}
 */
function _buildSiteKey(state) {
  const site = state?.world?.active_site;
  const px = state?.player?.position?.x;
  const py = state?.player?.position?.y;
  if (!site || px == null || py == null) return null;
  const siteId = site.site_id || (site.id ? site.id.replace(/\/l2$/, "") : null);
  if (!siteId) return null;
  return `${siteId}:${px},${py}`;
}

/**
 * Enumerate accessible ORS candidate objects for TAKE source.
 * Excludes: inactive, player-held, worn, non-current-container.
 * Scopes: grid cell → localspace → site floor.
 *
 * @param {object} state
 * @returns {object[]} candidate_objects
 */
function _enumerateCandidates(state) {
  const objects = state?.objects;
  if (!objects || typeof objects !== "object") return [];

  const cellKey = _buildCellKey(state);
  const lsId = state?.world?.active_local_space?.local_space_id || null;
  const siteKey = (!lsId) ? _buildSiteKey(state) : null;

  const candidates = [];

  for (const record of Object.values(objects)) {
    // Exclusion: inactive
    if (record.status !== "active") continue;
    // Exclusion: player-held
    if (record.current_container_type === "player") continue;
    // Exclusion: worn
    if (record.current_container_type === "worn") continue;

    // Scope check: grid, localspace, or site — must be current container
    const cType = record.current_container_type;
    const cId = record.current_container_id;

    let inScope = false;
    if (cType === "grid" && cellKey && cId === cellKey) {
      inScope = true;
    } else if (cType === "localspace" && lsId && cId === lsId) {
      inScope = true;
    } else if (cType === "site" && siteKey && cId === siteKey) {
      inScope = true;
    }

    if (!inScope) continue;

    candidates.push({
      candidate_id:           record.id,
      candidate_name:         record.name || "",
      candidate_aliases:      Array.isArray(record.aliases) ? record.aliases : [],
      candidate_quantity:     typeof record.quantity === "number" ? record.quantity : 1,
      candidate_unit:         record.unit || null,
      candidate_container:    cType,
      candidate_container_id: cId,
      candidate_status:       record.status
    });
  }

  return candidates;
}

// ── Layer 2: LLM Evidence Analysis ──────────────────────────────────────────────

/**
 * Build the prompt payload sent to the model.
 * Follows plan.md v3 §5 — abstract patterns only, no hardcoded examples.
 *
 * @param {object} actions - Enriched parser actions
 * @param {object} state
 * @param {object[]} candidates
 * @returns {Array<{role:string, content:string}>} messages array
 */
function _buildPromptMessages(actions, state, candidates) {
  const normalizedTarget = typeof actions.normalized_target === "string"
    ? actions.normalized_target : null;
  const rawTarget = typeof actions.target === "string" ? actions.target : null;
  const requestedQuantity = actions.requested_quantity ?? null;
  const quantityMode = actions.quantity_mode ?? null;
  const selectionMode = actions.selection_mode ?? null;
  const operationFamily = actions.operation_family ?? null;
  const sourceContainerHint = actions.source_container_hint ?? null;

  const cellKey = _buildCellKey(state);
  const lsId = state?.world?.active_local_space?.local_space_id || "none";
  const siteId = state?.world?.active_site?.site_id
    || (state?.world?.active_site?.id ? state.world.active_site.id.replace(/\/l2$/, "") : null)
    || "none";

  const candidateListJson = JSON.stringify(candidates, null, 0);

  const systemText = "You are an object-reference resolver for a text adventure game. "
    + "Given a player command, parser-enriched fields, and a list of accessible candidate objects, "
    + "determine which source object the player intends to interact with. "
    + "Return ONLY valid JSON matching the required schema. No markdown, no commentary outside JSON.";

  const userText = [
    "## OPERATION CONTEXT",
    `operation_family: ${operationFamily || "unknown"}`,
    `selection_mode: ${selectionMode || "none"}`,
    `raw_player_command: ${rawTarget || "(not provided)"}`,
    `normalized_target: ${normalizedTarget || "(not provided)"}`,
    `requested_quantity: ${requestedQuantity !== null ? requestedQuantity : "(not specified)"}`,
    `quantity_mode: ${quantityMode || "unspecified"}`,
    `source_container_hint: ${sourceContainerHint || "none"}`,
    "",
    "## PLAYER LOCATION",
    `Current cell key: ${cellKey || "unknown"}`,
    `Active localspace: ${lsId}`,
    `Active site: ${siteId}`,
    "",
    "## ACCESSIBLE CANDIDATE OBJECTS",
    candidateListJson,
    "",
    "## INSTRUCTIONS",
    "Choose ONLY from the candidate IDs listed above. Do not invent objects.",
    "The candidate names and aliases are provided as evidence for your reasoning. "
      + "You must select a candidate by its ID or return ambiguous/unresolved.",
    "If multiple candidates could plausibly match, return ambiguous.",
    "If no candidate plausibly matches, return unresolved.",
    "Determine: is the source a stack (quantity > 1)? "
      + "Is the requested amount partial, the exact whole stack, or more than available?",
    "The destination is always the player inventory for a take operation.",
    "Provide reasoning_summary in 1-2 sentences explaining which candidate was selected and why, "
      + "or why the result is ambiguous/unresolved.",
    "",
    "## REQUIRED JSON RESPONSE SCHEMA",
    "Return ONLY this JSON shape (no markdown fences, no extra text):",
    "{",
    '  "source_object_id": "string or null",',
    '  "source_object_name": "string or null",',
    '  "source_container_type": "string or null",',
    '  "source_container_id": "string or null",',
    '  "source_quantity_before": number or null,',
    '  "source_unit": "string or null",',
    '  "requested_quantity": number or null,',
    '  "requested_vs_available": "partial" or "exact_stack" or "over_stack" or "unknown",',
    '  "is_stack": true or false,',
    '  "intended_destination_type": "player",',
    '  "intended_destination_id": "player",',
    '  "resolution_basis": "model_selected" or "ambiguous" or "unresolved",',
    '  "resolution_confidence": 0.0 to 1.0,',
    '  "reasoning_summary": "1-2 sentence explanation",',
    '  "candidate_ids_considered": ["id1", "id2"],',
    '  "warnings": []',
    "}"
  ].join("\n");

  return [
    { role: "system", content: systemText },
    { role: "user", content: userText }
  ];
}

/**
 * Call DeepSeek for the resolver.
 * Follows the established callDeepSeek pattern from SemanticParser.js.
 *
 * @param {Array<{role:string, content:string}>} messages
 * @returns {Promise<{ok:boolean, error:string|null, content:string|null, usage:object|null}>}
 */
async function _callResolverModel(messages) {
  if (!process.env.DEEPSEEK_API_KEY) {
    console.log("[ObjectOperationResolver] error=NO_API_KEY");
    return { ok: false, error: "NO_API_KEY", content: null, usage: null };
  }
  if (!_axios) {
    console.log("[ObjectOperationResolver] error=AXIOS_MISSING");
    return { ok: false, error: "AXIOS_MISSING", content: null, usage: null };
  }

  const _makeCall = async () => {
    const resp = await _axios.post(
      DEEPSEEK_URL,
      {
        model: DEEPSEEK_MODEL,
        messages,
        temperature: DEEPSEEK_TEMPERATURE,
        max_tokens: DEEPSEEK_MAX_TOKENS
      },
      {
        headers: {
          "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: DEEPSEEK_TIMEOUT_MS
      }
    );
    return resp;
  };

  try {
    let resp;
    try {
      resp = await _makeCall();
    } catch (_firstErr) {
      if (_firstErr?.code === "ECONNRESET") {
        console.warn("[ObjectOperationResolver] ECONNRESET — retrying once...");
        resp = await _makeCall();
      } else {
        throw _firstErr;
      }
    }

    const content = resp?.data?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length === 0) {
      return { ok: false, error: "PARSE_FAILED", content: null, usage: null };
    }
    const usage = resp?.data?.usage || null;
    return { ok: true, error: null, content, usage };
  } catch (err) {
    console.log(`[ObjectOperationResolver] error=LLM_UNAVAILABLE detail=${err?.message ?? "unknown"}`);
    return { ok: false, error: "LLM_UNAVAILABLE", content: null, usage: null };
  }
}

// ── Layer 3: ORS Fact Validation ────────────────────────────────────────────────

/**
 * Validate model JSON response against ORS facts and schema.
 * Returns { valid, evidencePatch, warnings, validationErrors }
 *
 * @param {object|null} modelJson - Parsed model response
 * @param {object[]} candidates - Enumerated candidate objects
 * @param {object} state - Full gameState for ORS validation
 * @param {object} actions - Parser actions for field cross-reference
 * @returns {object}
 */
function _validateModelResponse(modelJson, candidates, state, actions) {
  const result = {
    valid: true,
    evidencePatch: {},
    warnings: [],
    validationErrors: []
  };

  // ── V1: Response is valid JSON ─────────────────────────────────────────────
  if (!modelJson || typeof modelJson !== "object") {
    result.valid = false;
    result.evidencePatch.resolution_basis = "invalid_model_output";
    result.evidencePatch.fail_closed_reason = "invalid_model_output";
    result.warnings.push({
      code: "invalid_json",
      severity: "blocking",
      field: null,
      message: "Model response is not valid JSON or is null.",
      candidate_ids: null
    });
    return result;
  }

  // ── V2: Required schema fields present ─────────────────────────────────────
  const requiredFields = [
    "source_object_id", "source_object_name", "source_container_type",
    "source_container_id", "source_quantity_before", "source_unit",
    "requested_quantity", "requested_vs_available", "is_stack",
    "intended_destination_type", "intended_destination_id",
    "resolution_basis", "resolution_confidence", "reasoning_summary",
    "candidate_ids_considered", "warnings"
  ];
  const missingFields = requiredFields.filter(f => !(f in modelJson));
  if (missingFields.length > 0) {
    result.valid = false;
    result.evidencePatch.resolution_basis = "invalid_model_output";
    result.evidencePatch.fail_closed_reason = "invalid_model_output";
    result.warnings.push({
      code: "invalid_schema",
      severity: "blocking",
      field: null,
      message: `Missing required fields: ${missingFields.join(", ")}`,
      candidate_ids: null
    });
    return result;
  }

  // ── Extract model values ───────────────────────────────────────────────────
  const modelBasis = String(modelJson.resolution_basis || "");
  const sourceId = modelJson.source_object_id || null;

  // ── V3: If model_selected, source_object_id must be non-null ────────────────
  if (modelBasis === "model_selected" && !sourceId) {
    result.valid = false;
    result.evidencePatch.resolution_basis = "invalid_model_output";
    result.evidencePatch.fail_closed_reason = "invalid_model_output";
    result.evidencePatch.source_object_id = null;
    result.warnings.push({
      code: "invalid_schema",
      severity: "blocking",
      field: "source_object_id",
      message: "resolution_basis is 'model_selected' but source_object_id is null.",
      candidate_ids: null
    });
    return result;
  }

  // ── If ambiguous or unresolved from model, pass through without ORS validation
  if (modelBasis === "ambiguous" || modelBasis === "unresolved") {
    result.evidencePatch.source_object_id = null;
    result.evidencePatch.resolution_basis = modelBasis;
    result.evidencePatch.fail_closed_reason = modelBasis;
    if (modelBasis === "ambiguous") {
      result.warnings.push({
        code: "model_ambiguous",
        severity: "blocking",
        field: "resolution_basis",
        message: "Model reported ambiguous match among candidates.",
        candidate_ids: Array.isArray(modelJson.candidate_ids_considered)
          ? modelJson.candidate_ids_considered : null
      });
    }
    if (modelBasis === "unresolved") {
      result.warnings.push({
        code: "model_unresolved",
        severity: "blocking",
        field: "resolution_basis",
        message: "Model could not resolve source object.",
        candidate_ids: null
      });
    }
    return result; // valid=false for source selection, but evidence is complete
  }

  // ── V4: source_object_id exists in candidate set (using Array.includes for ID validation only)
  const candidateIds = candidates.map(c => c.candidate_id);
  if (sourceId && !candidateIds.includes(sourceId)) {
    result.valid = false;
    result.evidencePatch.resolution_basis = "validation_failed";
    result.evidencePatch.source_object_id = null;
    result.evidencePatch.fail_closed_reason = "validation_failed";
    result.warnings.push({
      code: "non_candidate_object_id",
      severity: "blocking",
      field: "source_object_id",
      message: `Model returned ID "${sourceId}" which is not in the enumerated candidate set.`,
      candidate_ids: sourceId ? [sourceId] : null
    });
    return result;
  }

  // ── V5-V8: ORS fact validation ─────────────────────────────────────────────
  const objects = state?.objects;
  const orsRecord = objects ? objects[sourceId] : null;

  // V5: source is active
  if (!orsRecord || orsRecord.status !== "active") {
    result.valid = false;
    result.evidencePatch.resolution_basis = "validation_failed";
    result.evidencePatch.source_object_id = null;
    result.evidencePatch.fail_closed_reason = "validation_failed";
    result.warnings.push({
      code: "source_inactive",
      severity: "blocking",
      field: "status",
      message: `Source object "${sourceId}" is not active (status: ${orsRecord?.status || "not_found"}).`,
      candidate_ids: sourceId ? [sourceId] : null
    });
    return result;
  }

  // V6-V7: container matches ORS
  const modelContainerType = String(modelJson.source_container_type || "");
  const modelContainerId = String(modelJson.source_container_id || "");
  const orsContainerType = String(orsRecord.current_container_type || "");
  const orsContainerId = String(orsRecord.current_container_id || "");

  if (modelContainerType !== orsContainerType || modelContainerId !== orsContainerId) {
    result.valid = false;
    result.evidencePatch.resolution_basis = "validation_failed";
    result.evidencePatch.source_object_id = null;
    result.evidencePatch.fail_closed_reason = "validation_failed";
    result.warnings.push({
      code: "source_container_mismatch",
      severity: "blocking",
      field: "source_container_type",
      message: `Model container (${modelContainerType}/${modelContainerId}) does not match ORS (${orsContainerType}/${orsContainerId}).`,
      candidate_ids: sourceId ? [sourceId] : null
    });
    return result;
  }

  // V8: quantity matches ORS (allow null→1 normalization for single objects)
  const orsQuantity = typeof orsRecord.quantity === "number" ? orsRecord.quantity : 1;
  const modelQuantity = typeof modelJson.source_quantity_before === "number"
    ? modelJson.source_quantity_before
    : null;

  if (modelQuantity !== null && modelQuantity !== orsQuantity) {
    result.valid = false;
    result.evidencePatch.resolution_basis = "validation_failed";
    result.evidencePatch.source_object_id = null;
    result.evidencePatch.fail_closed_reason = "validation_failed";
    result.warnings.push({
      code: "source_quantity_mismatch",
      severity: "blocking",
      field: "source_quantity_before",
      message: `Model quantity (${modelQuantity}) does not match ORS quantity (${orsQuantity}).`,
      candidate_ids: sourceId ? [sourceId] : null
    });
    return result;
  }

  // ── V9: Multiple candidate IDs check ───────────────────────────────────────
  // If model selected but returned multiple IDs, treat as ambiguous
  const consideredIds = Array.isArray(modelJson.candidate_ids_considered)
    ? modelJson.candidate_ids_considered : [];
  // Multiple candidate IDs considered but only one was selected — that's normal.
  // The model's resolution_basis already tells us if it was ambiguous.
  // No additional check needed beyond what the model already reported.

  // ── Validation passed ──────────────────────────────────────────────────────
  result.evidencePatch.source_object_id = sourceId;
  result.evidencePatch.source_object_name = orsRecord.name || modelJson.source_object_name || null;
  result.evidencePatch.source_container_type = orsContainerType;
  result.evidencePatch.source_container_id = orsContainerId;
  result.evidencePatch.source_quantity_before = orsQuantity;
  result.evidencePatch.source_unit = orsRecord.unit || modelJson.source_unit || null;

  // Check for over-stack / exact-stack advisory warnings
  const requestedVsAvailable = String(modelJson.requested_vs_available || "");
  if (requestedVsAvailable === "over_stack") {
    result.warnings.push({
      code: "over_stack",
      severity: "advisory",
      field: "requested_vs_available",
      message: `Requested quantity exceeds available (requested: ${modelJson.requested_quantity ?? "?"}, available: ${orsQuantity}).`,
      candidate_ids: sourceId ? [sourceId] : null
    });
  }
  if (requestedVsAvailable === "exact_stack") {
    result.warnings.push({
      code: "exact_stack",
      severity: "advisory",
      field: "requested_vs_available",
      message: "Requested quantity equals available — routing note for whole transfer.",
      candidate_ids: sourceId ? [sourceId] : null
    });
  }

  // Low model confidence advisory
  const modelConf = typeof modelJson.resolution_confidence === "number"
    ? modelJson.resolution_confidence : 1.0;
  if (modelConf < 0.5) {
    result.warnings.push({
      code: "low_model_confidence",
      severity: "advisory",
      field: "resolution_confidence",
      message: `Model reported low confidence (${modelConf}).`,
      candidate_ids: sourceId ? [sourceId] : null
    });
  }

  // Include model warnings if any
  if (Array.isArray(modelJson.warnings)) {
    for (const w of modelJson.warnings) {
      if (w && typeof w === "object") {
        result.warnings.push({
          code: String(w.code || "model_warning"),
          severity: w.severity === "blocking" ? "blocking" : "advisory",
          field: w.field || null,
          message: String(w.message || ""),
          candidate_ids: Array.isArray(w.candidate_ids) ? w.candidate_ids : null
        });
      }
    }
  }

  return result;
}

// ── Public API ──────────────────────────────────────────────────────────────────

/**
 * Resolve the source object for a partial-stack TAKE operation.
 *
 * Observe-only — mutates nothing, calls no ObjectHelper, writes no AP fields.
 *
 * @param {object} state - Full gameState
 * @param {object} actions - Enriched parser actions:
 *   .normalized_target, .target, .requested_quantity, .quantity_mode,
 *   .selection_mode, .operation_family, .source_container_hint
 * @returns {Promise<object>} resolver_evidence_v1
 */
async function resolvePartialStackTake(state, actions) {
  // ── Initialize evidence packet ─────────────────────────────────────────────
  const evidence = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    resolver_kind: RESOLVER_KIND,
    evidence_source: "llm_model",
    provider: DEEPSEEK_MODEL,

    source_object_id: null,
    source_object_name: null,
    source_container_type: null,
    source_container_id: null,
    source_quantity_before: null,
    source_unit: null,

    requested_quantity: actions?.requested_quantity ?? null,
    quantity_mode: actions?.quantity_mode ?? null,
    normalized_target: actions?.normalized_target ?? null,
    requested_vs_available: null,
    is_stack: null,

    intended_destination_type: "player",
    intended_destination_id: "player",

    resolution_basis: "unresolved",
    resolution_confidence: 0,

    candidate_count: 0,
    candidate_ids_sent: [],

    reasoning_summary: null,
    candidate_ids_considered: null,

    resolution_warnings: [],
    fail_closed_reason: null,

    raw_target: actions?.target ?? null,
    model_raw_response: null,
    validation_errors: []
  };

  // ── Layer 1: Candidate Enumeration ────────────────────────────────────────
  const candidates = _enumerateCandidates(state);
  evidence.candidate_count = candidates.length;
  evidence.candidate_ids_sent = candidates.map(c => c.candidate_id);

  if (candidates.length === 0) {
    evidence.resolution_basis = "unresolved";
    evidence.resolution_confidence = 0;
    evidence.fail_closed_reason = "no_candidates";
    evidence.resolution_warnings.push({
      code: "no_candidates",
      severity: "blocking",
      field: "candidates",
      message: "No eligible ORS candidate objects found in accessible containers.",
      candidate_ids: null
    });
    return evidence;
  }

  // ── Layer 2: LLM Evidence Analysis ─────────────────────────────────────────
  const messages = _buildPromptMessages(actions || {}, state, candidates);

  const llmResult = await _callResolverModel(messages);

  if (!llmResult.ok) {
    evidence.resolution_basis = "provider_unavailable";
    evidence.resolution_confidence = 0;
    evidence.fail_closed_reason = "provider_unavailable";
    evidence.resolution_warnings.push({
      code: "provider_unavailable",
      severity: "blocking",
      field: null,
      message: `LLM provider call failed: ${llmResult.error || "unknown error"}`,
      candidate_ids: null
    });
    return evidence;
  }

  evidence.model_raw_response = llmResult.content;

  // Parse model JSON
  let modelJson = null;
  let parseError = null;
  try {
    // JSON hygiene only — allowed exception.
    // Never use startsWith/endsWith/indexOf for target/name/alias matching.
    // Strip possible markdown code fences from model output.
    let rawContent = String(llmResult.content || "").trim();
    if (rawContent.startsWith("```")) {
      const fenceEnd = rawContent.indexOf("\n");
      if (fenceEnd !== -1) {
        rawContent = rawContent.slice(fenceEnd + 1);
      }
      if (rawContent.endsWith("```")) {
        rawContent = rawContent.slice(0, -3).trim();
      }
    }
    modelJson = JSON.parse(rawContent);
  } catch (err) {
    parseError = err.message;
  }

  if (!modelJson) {
    evidence.resolution_basis = "invalid_model_output";
    evidence.resolution_confidence = 0;
    evidence.fail_closed_reason = "invalid_model_output";
    evidence.resolution_warnings.push({
      code: "invalid_json",
      severity: "blocking",
      field: null,
      message: `Failed to parse model response as JSON: ${parseError || "unknown parse error"}`,
      candidate_ids: null
    });
    evidence.validation_errors.push(parseError || "JSON parse failed");
    return evidence;
  }

  // ── Layer 3: ORS Fact Validation ──────────────────────────────────────────
  const validation = _validateModelResponse(modelJson, candidates, state, actions || {});

  // Merge model fields into evidence
  evidence.requested_quantity = modelJson.requested_quantity ?? evidence.requested_quantity;
  evidence.requested_vs_available = modelJson.requested_vs_available ?? null;
  evidence.is_stack = typeof modelJson.is_stack === "boolean" ? modelJson.is_stack : null;
  evidence.reasoning_summary = modelJson.reasoning_summary ?? null;
  evidence.candidate_ids_considered = Array.isArray(modelJson.candidate_ids_considered)
    ? modelJson.candidate_ids_considered : null;
  evidence.resolution_confidence = typeof modelJson.resolution_confidence === "number"
    ? modelJson.resolution_confidence : 0;

  // Merge validation results
  if (validation.evidencePatch.resolution_basis) {
    evidence.resolution_basis = validation.evidencePatch.resolution_basis;
  } else {
    evidence.resolution_basis = modelJson.resolution_basis || "unresolved";
  }

  if (validation.evidencePatch.source_object_id !== undefined) {
    evidence.source_object_id = validation.evidencePatch.source_object_id;
  } else if (modelJson.source_object_id) {
    evidence.source_object_id = modelJson.source_object_id;
  }

  if (validation.evidencePatch.source_object_name !== undefined) {
    evidence.source_object_name = validation.evidencePatch.source_object_name;
  } else {
    evidence.source_object_name = modelJson.source_object_name || null;
  }

  if (validation.evidencePatch.source_container_type !== undefined) {
    evidence.source_container_type = validation.evidencePatch.source_container_type;
  } else {
    evidence.source_container_type = modelJson.source_container_type || null;
  }

  if (validation.evidencePatch.source_container_id !== undefined) {
    evidence.source_container_id = validation.evidencePatch.source_container_id;
  } else {
    evidence.source_container_id = modelJson.source_container_id || null;
  }

  if (validation.evidencePatch.source_quantity_before !== undefined) {
    evidence.source_quantity_before = validation.evidencePatch.source_quantity_before;
  } else {
    evidence.source_quantity_before = modelJson.source_quantity_before ?? null;
  }

  if (validation.evidencePatch.source_unit !== undefined) {
    evidence.source_unit = validation.evidencePatch.source_unit;
  } else {
    evidence.source_unit = modelJson.source_unit ?? null;
  }

  if (validation.evidencePatch.fail_closed_reason) {
    evidence.fail_closed_reason = validation.evidencePatch.fail_closed_reason;
  }

  // Merge warnings and validation errors
  evidence.resolution_warnings = [
    ...evidence.resolution_warnings,
    ...validation.warnings
  ];
  evidence.validation_errors = validation.validationErrors;

  return evidence;
}

// ── Exports ──────────────────────────────────────────────────────────────────────
module.exports = { resolvePartialStackTake };
