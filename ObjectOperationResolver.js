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
const DEEPSEEK_MODEL = "deepseek-v4-flash";
const DEEPSEEK_TEMPERATURE = 0;
const DEEPSEEK_MAX_TOKENS = 512;
const DEEPSEEK_TIMEOUT_MS = 15000;

const EVIDENCE_SCHEMA_VERSION = "resolver_evidence_v1";
const TAKE_RESOLVER_KIND = "resolvePartialStackTake";
const DROP_RESOLVER_KIND = "resolvePlayerHeldDrop";

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
 * Resolve the player's authoritative current Ground container without mutation.
 * Priority and accepted container shapes mirror ObjectHelper's DROP destination
 * contract: localspace first, then site floor, otherwise the current grid cell.
 */
function resolveCurrentGround(state) {
  const activeLocalSpace = state?.world?.active_local_space || null;
  if (activeLocalSpace) {
    const localSpaceId = activeLocalSpace.local_space_id || null;
    if (!localSpaceId) {
      return { ok: false, container_type: null, container_id: null, fail_closed_reason: "missing_localspace_id" };
    }
    const localSpaces = state?.world?.active_site?.local_spaces;
    const resolvable = localSpaces && typeof localSpaces === "object" &&
      Object.values(localSpaces).some(entry => entry?._generated_interior?.local_space_id === localSpaceId);
    if (!resolvable) {
      return { ok: false, container_type: null, container_id: null, fail_closed_reason: "localspace_not_resolvable" };
    }
    return { ok: true, container_type: "localspace", container_id: localSpaceId, fail_closed_reason: null };
  }

  if (state?.world?.active_site) {
    const siteX = state?.player?.position?.x;
    const siteY = state?.player?.position?.y;
    const siteKey = _buildSiteKey(state);
    if (!siteKey || !Number.isInteger(siteX) || !Number.isInteger(siteY)) {
      return { ok: false, container_type: null, container_id: null, fail_closed_reason: "site_ground_not_resolvable" };
    }
    return { ok: true, container_type: "site", container_id: siteKey, fail_closed_reason: null };
  }

  const pos = state?.world?.position;
  if (!pos || ![pos.mx, pos.my, pos.lx, pos.ly].every(Number.isFinite)) {
    return { ok: false, container_type: null, container_id: null, fail_closed_reason: "grid_position_missing" };
  }
  const cellKey = _buildCellKey(state);
  if (!cellKey || !state?.world?.cells?.[cellKey]) {
    return { ok: false, container_type: null, container_id: null, fail_closed_reason: "grid_cell_not_resolvable" };
  }
  return { ok: true, container_type: "grid", container_id: cellKey, fail_closed_reason: null };
}

/**
 * Enumerate accessible ORS candidate objects for TAKE source.
 * Excludes: inactive, player-held, worn, non-current-container.
 * Scopes: grid cell → localspace → site floor.
 *
 * @param {object} state
 * @returns {object[]} candidate_objects
 */
function _enumerateTakeCandidates(state) {
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

/**
 * Enumerate authoritative player-held ORS candidates for DROP in membership
 * order. Worn and legacy-only inventory entries are intentionally excluded.
 */
function _enumerateDropCandidates(state) {
  const objects = state?.objects;
  const playerIds = state?.player?.object_ids;
  if (!objects || typeof objects !== "object" || !Array.isArray(playerIds)) return [];

  const candidates = [];
  const seen = new Set();
  for (const objectId of playerIds) {
    if (typeof objectId !== "string" || objectId.length === 0 || seen.has(objectId)) continue;
    seen.add(objectId);
    const record = objects[objectId];
    if (!record || record.status !== "active") continue;
    if (record.current_container_type !== "player" || record.current_container_id !== "player") continue;
    candidates.push({
      candidate_id:           objectId,
      candidate_name:         record.name || "",
      candidate_aliases:      Array.isArray(record.aliases) ? record.aliases : [],
      candidate_quantity:     typeof record.quantity === "number" ? record.quantity : null,
      candidate_unit:         record.unit || null,
      candidate_container:    "player",
      candidate_container_id: "player",
      candidate_status:       record.status
    });
  }
  return candidates;
}

function _takePolicy() {
  return {
    operationFamily: "take",
    resolverKind: TAKE_RESOLVER_KIND,
    enumerateCandidates: _enumerateTakeCandidates,
    destination: { ok: true, container_type: "player", container_id: "player", fail_closed_reason: null },
    strictDestinationValidation: false,
    strictPlayerSourceValidation: false,
    deterministicDuplicateAmbiguity: false
  };
}

function _dropPolicy(state) {
  return {
    operationFamily: "drop",
    resolverKind: DROP_RESOLVER_KIND,
    enumerateCandidates: _enumerateDropCandidates,
    destination: resolveCurrentGround(state),
    strictDestinationValidation: true,
    strictPlayerSourceValidation: true,
    deterministicDuplicateAmbiguity: true
  };
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
function _buildPromptMessages(actions, state, candidates, policy = _takePolicy()) {
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
  const destinationType = policy.destination?.container_type || null;
  const destinationId = policy.destination?.container_id || null;

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
    policy.operationFamily === "take"
      ? "The destination is always the player inventory for a take operation."
      : `The destination must be the authoritative ${destinationType || "unresolved"}/${destinationId || "unresolved"} Ground container supplied by policy.`,
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
    `  "intended_destination_type": ${JSON.stringify(destinationType)},`,
    `  "intended_destination_id": ${JSON.stringify(destinationId)},`,
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
        thinking: { type: "disabled" },
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

function _normalizeIdentityPart(value) {
  return String(value ?? "").trim().toLowerCase();
}

function _candidateIdentitySignature(candidate) {
  const aliases = Array.isArray(candidate?.candidate_aliases)
    ? candidate.candidate_aliases.map(_normalizeIdentityPart).filter(Boolean).sort()
    : [];
  return JSON.stringify([
    _normalizeIdentityPart(candidate?.candidate_name),
    aliases,
    candidate?.candidate_quantity ?? null,
    _normalizeIdentityPart(candidate?.candidate_unit),
    _normalizeIdentityPart(candidate?.candidate_container),
    _normalizeIdentityPart(candidate?.candidate_container_id)
  ]);
}

// TAKE's "unspecified" case deliberately does NOT mirror DROP's default-to-1 —
// a bare "take X" against a stack means "resolve intent", not "assume one".
// "article" ("take a coin") always means exactly one regardless of stack size —
// distinct from "unspecified", where the correct quantity depends on how many
// exist. When ORS ground truth shows only one unit available, "unspecified"
// resolves to it directly (no model judgment needed — there's nothing else it
// could mean); for a genuine multi-item stack it falls back to the resolver's
// own model-resolved quantity, bounds-checked against ORS truth rather than
// trusted blindly. Explicit quantities still come from the parser, unchanged,
// including over-availability values — requested_vs_available classifies those.
function _deriveTakeEffectiveQuantity(actions, modelJson, availableQuantity) {
  const requested = actions?.requested_quantity ?? null;
  const quantityMode = actions?.quantity_mode ?? null;

  if (quantityMode === "exact") {
    if (Number.isInteger(requested) && requested > 0) {
      return { ok: true, quantity: requested, basis: "parser_explicit", reason: null };
    }
    return { ok: false, quantity: null, basis: null, reason: "invalid_quantity" };
  }
  if (quantityMode === "article") {
    if (requested !== null && requested !== 1) {
      return { ok: false, quantity: null, basis: null, reason: "contradictory_quantity_metadata" };
    }
    return { ok: true, quantity: 1, basis: "take_article_single", reason: null };
  }
  if (quantityMode === "unspecified") {
    if (requested !== null) {
      return { ok: false, quantity: null, basis: null, reason: "contradictory_quantity_metadata" };
    }
    if (availableQuantity === 1) {
      return { ok: true, quantity: 1, basis: "take_only_available_unit", reason: null };
    }
    const modelQty = modelJson?.requested_quantity;
    if (Number.isInteger(modelQty) && modelQty > 0 && modelQty <= availableQuantity) {
      return { ok: true, quantity: modelQty, basis: "take_model_resolved", reason: null };
    }
    return { ok: false, quantity: null, basis: null, reason: "invalid_quantity" };
  }
  return { ok: false, quantity: null, basis: null, reason: "unsupported_quantity_mode" };
}

function _deriveDropEffectiveQuantity(actions, availableQuantity) {
  const requested = actions?.requested_quantity ?? null;
  const quantityMode = actions?.quantity_mode ?? null;
  const selectionMode = actions?.selection_mode ?? null;

  if (quantityMode === "all") {
    if (requested !== null || selectionMode !== "all_from_stack") {
      return { ok: false, quantity: null, basis: null, reason: "contradictory_quantity_metadata" };
    }
    return { ok: true, quantity: availableQuantity, basis: "drop_all_available", reason: null };
  }
  if (quantityMode === "some") {
    return { ok: false, quantity: null, basis: null, reason: "unsupported_quantity_mode" };
  }
  if (quantityMode === "unspecified" || quantityMode === "article") {
    if (requested !== null) {
      return { ok: false, quantity: null, basis: null, reason: "contradictory_quantity_metadata" };
    }
    return { ok: true, quantity: 1, basis: "drop_default_one", reason: null };
  }
  if (quantityMode === "exact") {
    if (Number.isInteger(requested) && requested > 0) {
      return { ok: true, quantity: requested, basis: "parser_explicit", reason: null };
    }
    return { ok: false, quantity: null, basis: null, reason: "invalid_quantity" };
  }
  return { ok: false, quantity: null, basis: null, reason: "unsupported_quantity_mode" };
}

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
function _validateModelResponse(modelJson, candidates, state, actions, policy = _takePolicy()) {
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

  if (policy.strictPlayerSourceValidation) {
    const playerMembership = Array.isArray(state?.player?.object_ids) && state.player.object_ids.includes(sourceId);
    if (orsContainerType !== "player" || orsContainerId !== "player" || !playerMembership) {
      result.valid = false;
      result.evidencePatch.resolution_basis = "validation_failed";
      result.evidencePatch.source_object_id = null;
      result.evidencePatch.fail_closed_reason = "source_not_player_held";
      result.warnings.push({
        code: "source_not_player_held",
        severity: "blocking",
        field: "source_container_type",
        message: `DROP source "${sourceId}" is not an active player/player membership record.`,
        candidate_ids: sourceId ? [sourceId] : null
      });
      return result;
    }
  }

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
  const orsQuantity = policy.operationFamily === "drop"
    ? (Number.isInteger(orsRecord.quantity) && orsRecord.quantity > 0 ? orsRecord.quantity : null)
    : (typeof orsRecord.quantity === "number" ? orsRecord.quantity : 1);
  const modelQuantity = typeof modelJson.source_quantity_before === "number"
    ? modelJson.source_quantity_before
    : null;

  if (policy.operationFamily === "drop" && orsQuantity === null) {
    result.valid = false;
    result.evidencePatch.resolution_basis = "validation_failed";
    result.evidencePatch.source_object_id = null;
    result.evidencePatch.fail_closed_reason = "invalid_source_quantity";
    result.warnings.push({
      code: "invalid_source_quantity",
      severity: "blocking",
      field: "source_quantity_before",
      message: `DROP source "${sourceId}" does not have a positive integer authoritative quantity.`,
      candidate_ids: sourceId ? [sourceId] : null
    });
    return result;
  }

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

  if (policy.strictDestinationValidation) {
    const expectedDestinationType = String(policy.destination?.container_type || "");
    const expectedDestinationId = String(policy.destination?.container_id || "");
    const modelDestinationType = String(modelJson.intended_destination_type || "");
    const modelDestinationId = String(modelJson.intended_destination_id || "");
    if (modelDestinationType !== expectedDestinationType || modelDestinationId !== expectedDestinationId) {
      result.valid = false;
      result.evidencePatch.resolution_basis = "validation_failed";
      result.evidencePatch.source_object_id = null;
      result.evidencePatch.fail_closed_reason = "destination_mismatch";
      result.warnings.push({
        code: "destination_mismatch",
        severity: "blocking",
        field: "intended_destination_type",
        message: `Model destination (${modelDestinationType}/${modelDestinationId}) does not match policy (${expectedDestinationType}/${expectedDestinationId}).`,
        candidate_ids: sourceId ? [sourceId] : null
      });
      return result;
    }
  }

  if (policy.deterministicDuplicateAmbiguity) {
    const selectedCandidate = candidates.find(candidate => candidate.candidate_id === sourceId);
    const selectedSignature = _candidateIdentitySignature(selectedCandidate);
    const collidingIds = candidates
      .filter(candidate => _candidateIdentitySignature(candidate) === selectedSignature)
      .map(candidate => candidate.candidate_id);
    result.evidencePatch.candidate_identity_signature = {
      signature: selectedSignature,
      unique: collidingIds.length === 1,
      colliding_candidate_ids: collidingIds
    };
    if (collidingIds.length > 1) {
      result.valid = false;
      result.evidencePatch.resolution_basis = "ambiguous";
      result.evidencePatch.source_object_id = null;
      result.evidencePatch.source_object_name = null;
      result.evidencePatch.source_container_type = null;
      result.evidencePatch.source_container_id = null;
      result.evidencePatch.source_quantity_before = null;
      result.evidencePatch.source_unit = null;
      result.evidencePatch.effective_requested_quantity = null;
      result.evidencePatch.effective_quantity_basis = null;
      result.evidencePatch.fail_closed_reason = "ambiguous";
      result.warnings.push({
        code: "indistinguishable_candidate_signature",
        severity: "blocking",
        field: "source_object_id",
        message: "Multiple DROP candidates expose the same model-visible identity signature.",
        candidate_ids: collidingIds
      });
      return result;
    }
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

  if (policy.operationFamily === "drop") {
    const effectiveQuantity = _deriveDropEffectiveQuantity(actions, orsQuantity);
    result.evidencePatch.intended_destination_type = policy.destination.container_type;
    result.evidencePatch.intended_destination_id = policy.destination.container_id;
    result.evidencePatch.effective_requested_quantity = effectiveQuantity.quantity;
    result.evidencePatch.effective_quantity_basis = effectiveQuantity.basis;
    if (!effectiveQuantity.ok) {
      result.valid = false;
      result.evidencePatch.fail_closed_reason = effectiveQuantity.reason;
      result.warnings.push({
        code: effectiveQuantity.reason,
        severity: "blocking",
        field: "requested_quantity",
        message: "DROP quantity metadata cannot be mapped to an approved effective quantity.",
        candidate_ids: sourceId ? [sourceId] : null
      });
      return result;
    }
    result.evidencePatch.requested_vs_available = effectiveQuantity.quantity < orsQuantity
      ? "partial"
      : effectiveQuantity.quantity === orsQuantity ? "exact_stack" : "over_stack";
    result.evidencePatch.is_stack = orsQuantity > 1;
  } else if (policy.operationFamily === "take") {
    const effectiveQuantity = _deriveTakeEffectiveQuantity(actions, modelJson, orsQuantity);
    result.evidencePatch.effective_requested_quantity = effectiveQuantity.quantity;
    result.evidencePatch.effective_quantity_basis = effectiveQuantity.basis;
    if (!effectiveQuantity.ok) {
      result.valid = false;
      result.evidencePatch.fail_closed_reason = effectiveQuantity.reason;
      result.warnings.push({
        code: effectiveQuantity.reason,
        severity: "blocking",
        field: "requested_quantity",
        message: "TAKE quantity metadata cannot be mapped to an approved effective quantity.",
        candidate_ids: sourceId ? [sourceId] : null
      });
      return result;
    }
    result.evidencePatch.requested_vs_available = effectiveQuantity.quantity < orsQuantity
      ? "partial"
      : effectiveQuantity.quantity === orsQuantity ? "exact_stack" : "over_stack";
    result.evidencePatch.is_stack = orsQuantity > 1;
  }

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
async function _resolveWithPolicy(state, actions, policy) {
  // ── Initialize evidence packet ─────────────────────────────────────────────
  const evidence = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    resolver_kind: policy.resolverKind,
    operation_family: policy.operationFamily,
    evidence_source: "llm_model",
    provider: DEEPSEEK_MODEL,

    source_object_id: null,
    source_object_name: null,
    source_container_type: null,
    source_container_id: null,
    source_quantity_before: null,
    source_unit: null,

    requested_quantity: actions?.requested_quantity ?? null,
    parser_requested_quantity: actions?.requested_quantity ?? null,
    quantity_mode: actions?.quantity_mode ?? null,
    selection_mode: actions?.selection_mode ?? null,
    effective_requested_quantity: policy.operationFamily === "take"
      ? (actions?.requested_quantity ?? null) : null,
    effective_quantity_basis: policy.operationFamily === "take" ? "take_existing" : null,
    normalized_target: actions?.normalized_target ?? null,
    requested_vs_available: null,
    is_stack: null,

    intended_destination_type: policy.destination?.container_type ?? null,
    intended_destination_id: policy.destination?.container_id ?? null,

    resolution_basis: "unresolved",
    resolution_confidence: 0,

    candidate_count: 0,
    candidate_ids_sent: [],

    reasoning_summary: null,
    candidate_ids_considered: null,
    candidate_identity_signature: null,

    resolution_warnings: [],
    fail_closed_reason: null,

    raw_target: actions?.target ?? null,
    model_raw_response: null,
    validation_errors: []
  };

  // ── Layer 1: Candidate Enumeration ────────────────────────────────────────
  const candidates = policy.enumerateCandidates(state);
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

  if (policy.destination?.ok !== true) {
    evidence.resolution_basis = "validation_failed";
    evidence.resolution_confidence = 0;
    evidence.fail_closed_reason = policy.destination?.fail_closed_reason || "destination_not_resolvable";
    evidence.resolution_warnings.push({
      code: evidence.fail_closed_reason,
      severity: "blocking",
      field: "intended_destination_id",
      message: "The authoritative destination container could not be resolved without mutation.",
      candidate_ids: null
    });
    return evidence;
  }

  // ── Layer 2: LLM Evidence Analysis ─────────────────────────────────────────
  const messages = _buildPromptMessages(actions || {}, state, candidates, policy);

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
  const validation = _validateModelResponse(modelJson, candidates, state, actions || {}, policy);

  // Merge model fields into evidence
  if (policy.operationFamily === "take") {
    evidence.requested_quantity = modelJson.requested_quantity ?? evidence.requested_quantity;
  }
  evidence.requested_vs_available = validation.evidencePatch.requested_vs_available
    ?? modelJson.requested_vs_available ?? null;
  evidence.is_stack = typeof validation.evidencePatch.is_stack === "boolean"
    ? validation.evidencePatch.is_stack
    : (typeof modelJson.is_stack === "boolean" ? modelJson.is_stack : null);
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

  if (validation.evidencePatch.intended_destination_type !== undefined) {
    evidence.intended_destination_type = validation.evidencePatch.intended_destination_type;
  }
  if (validation.evidencePatch.intended_destination_id !== undefined) {
    evidence.intended_destination_id = validation.evidencePatch.intended_destination_id;
  }
  if (validation.evidencePatch.effective_requested_quantity !== undefined) {
    evidence.effective_requested_quantity = validation.evidencePatch.effective_requested_quantity;
  }
  if (validation.evidencePatch.effective_quantity_basis !== undefined) {
    evidence.effective_quantity_basis = validation.evidencePatch.effective_quantity_basis;
  }
  if (validation.evidencePatch.candidate_identity_signature !== undefined) {
    evidence.candidate_identity_signature = validation.evidencePatch.candidate_identity_signature;
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
async function resolvePartialStackTake(state, actions) {
  return _resolveWithPolicy(state, actions, _takePolicy());
}

async function resolvePlayerHeldDrop(state, actions) {
  return _resolveWithPolicy(state, actions, _dropPolicy(state));
}

module.exports = { resolvePartialStackTake, resolvePlayerHeldDrop, resolveCurrentGround };
