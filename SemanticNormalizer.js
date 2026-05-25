'use strict';

/**
 * SemanticNormalizer — TSL Stage 1 (observe-only)
 *
 * Semantic orchestration + normalization layer between narration and authoritative ORS mutation.
 * Stage 1: read-only diagnostics only. No mutations to _phaseBResult, gameState, or ORS state.
 *
 * Inputs (all read-only):
 *   phaseBResult  — CB.runPhaseB() return value
 *   rawInput      — player's raw input string
 *   parsedAction  — SemanticParser action enum string or 'unknown'
 *   gateResult    — authoritygate result object
 *   gameState     — full engine state
 *
 * Returns: { tsl: Object|null, processing_time_ms: Number }
 *
 * Every emitted signal includes: normalized claim, source_signals[], confidence,
 * unresolved_ambiguity, and related CB candidate/transfer + ORS object ID references.
 */

const ENABLED = true;

// Words in a proposed_name that imply the candidate is a distinct/new/state-changed object.
// Any match vetoes a recommend_suppress_promote recommendation. Veto-only — never asserts truth.
const SUPPRESSION_BLOCKLIST = [
  'another', 'second', 'new', 'fresh', 'other', 'extra',
  'sliced', 'broken', 'empty', 'half', 'torn', 'used', 'remaining'
];

// ── Scene-continuity proximity helpers ───────────────────────────────────────────────
// v1.88.88: conservative floor-object proximity detection.
// grid-to-grid: same mx,my prefix in LOC:mx,my:lx,ly format.
// localspace-to-localspace: exact container_id match only.
// site-to-site: exact container_id match only.
// No mixed-type matching — avoids treating unrelated spaces as nearby.

function _extractMacroLocation(containerId) {
  const _m = String(containerId || '').match(/^LOC:(-?\d+),(-?\d+):/);
  return _m ? `${_m[1]},${_m[2]}` : null;
}

function _isFloorContainer(containerType) {
  return containerType === 'grid' || containerType === 'localspace' || containerType === 'site';
}

function _sameSceneContext(cType, cId, existingType, existingId) {
  if (!_isFloorContainer(cType) || !_isFloorContainer(existingType)) return false;
  if (cType !== existingType) return false; // no mixed-type matching
  if (cType === 'grid') {
    const _cMacro = _extractMacroLocation(cId);
    const _eMacro = _extractMacroLocation(existingId);
    return _cMacro !== null && _eMacro !== null && _cMacro === _eMacro;
  }
  // localspace or site: exact ID match only
  return String(cId) === String(existingId);
}

function analyze(phaseBResult, rawInput, parsedAction, gateResult, gameState) {
  if (!ENABLED || !phaseBResult) {
    return { tsl: null, processing_time_ms: 0 };
  }

  const t0 = Date.now();

  const candidates = Array.isArray(phaseBResult.object_candidates) ? phaseBResult.object_candidates : [];
  const transfers  = Array.isArray(phaseBResult.object_transfers)  ? phaseBResult.object_transfers  : [];
  const gateRefs   = Array.isArray(gateResult?.referenced_objects)
    ? gateResult.referenced_objects.map(s => String(s).toLowerCase().trim()).filter(Boolean)
    : [];
  const inputType  = gateResult?.input_type || null;
  const apStampIds = Array.isArray(gameState?._apExecutedTransfers) ? gameState._apExecutedTransfers : [];

  // Index active tracked ObjectRecords for alias resolution
  const activeObjects = _getActiveObjects(gameState);

  const alias_candidates    = [];
  const acquisition_signals = [];
  const transfer_signals    = [];
  const warnings            = [];
  const dedup_candidates    = [];

  // ── Alias resolution: CB candidates ──────────────────────────────────────
  // For each CB candidate name, attempt to match to an existing active ObjectRecord.
  for (const c of candidates) {
    if (!c.name) continue;
    const actorRef = c.actor_npc_ref || c.actor || null;
    const matches  = _resolveAlias(c.name, actorRef, activeObjects, gateRefs, apStampIds);
    for (const m of matches) {
      alias_candidates.push({
        raw_name:             c.name,
        resolved_object_id:   m.object_id,
        resolved_name:        m.resolved_name,
        match_method:         m.method,
        source_signals:       m.source_signals,
        confidence:           m.confidence,
        unresolved_ambiguity: m.ambiguity,
        related_cb_candidate: c.name,
        related_cb_transfer:  null
      });
    }
  }

  // ── Alias resolution: CB transfers ───────────────────────────────────────
  // For each CB transfer, attempt to alias-resolve the referenced object.
  for (const t of transfers) {
    const tName  = t.object_name || null;
    const tObjId = t.object_id   || null;
    if (!tName && !tObjId) continue;

    // Direct object_id reference — strongest possible match
    if (tObjId && gameState?.objects?.[tObjId]) {
      const rec = gameState.objects[tObjId];
      if (rec.status === 'active') {
        const nameMismatch = tName && tName.toLowerCase() !== rec.name.toLowerCase()
          ? `name_mismatch:cb="${tName}" record="${rec.name}"`
          : null;
        alias_candidates.push({
          raw_name:             tName || tObjId,
          resolved_object_id:   tObjId,
          resolved_name:        rec.name,
          match_method:         'object_id_direct',
          source_signals:       ['cb_transfer_object_id'],
          confidence:           1.0,
          unresolved_ambiguity: nameMismatch,
          related_cb_candidate: null,
          related_cb_transfer:  tName || tObjId
        });
        continue;
      }
    }

    // Fallback: name-based alias resolution
    if (tName) {
      const matches = _resolveAlias(tName, null, activeObjects, gateRefs, apStampIds);
      for (const m of matches) {
        alias_candidates.push({
          raw_name:             tName,
          resolved_object_id:   m.object_id,
          resolved_name:        m.resolved_name,
          match_method:         m.method,
          source_signals:       m.source_signals,
          confidence:           m.confidence,
          unresolved_ambiguity: m.ambiguity,
          related_cb_candidate: null,
          related_cb_transfer:  tName
        });
      }
    }
  }

  // ── Acquisition signals ───────────────────────────────────────────────────
  // For each CB candidate targeting player container, classify acquisition intent.
  for (const c of candidates) {
    if (c.container_type !== 'player') continue;
    if (!c.name) continue;

    const signals       = [];
    const evidence_parts = [];

    if (parsedAction === 'take') {
      signals.push('parser.action=take');
      evidence_parts.push('parser:take');
    }
    if (inputType === 'player_attempt') {
      signals.push('gate.input_type=player_attempt');
    }
    if (gateRefs.some(r =>
      _tokenContains(r, c.name.toLowerCase()) || _tokenContains(c.name.toLowerCase(), r)
    )) {
      signals.push('gate.referenced_objects');
      evidence_parts.push(`gate_ref:"${c.name}"`);
    }
    const apMatch = activeObjects.find(o =>
      apStampIds.includes(o.id) &&
      (_tokenContains(o.name.toLowerCase(), c.name.toLowerCase()) ||
       _tokenContains(c.name.toLowerCase(), o.name.toLowerCase()))
    );
    if (apMatch) {
      signals.push('ap_executed_transfer');
      evidence_parts.push(`ap_stamp:${apMatch.id}`);
    }
    if (c.transfer_origin === 'environment_interaction') {
      signals.push('cb.transfer_origin=environment_interaction');
    }

    let ambiguity = null;
    if (signals.length === 0) {
      ambiguity = 'no_source_signal_for_player_acquisition';
      warnings.push({
        type:                 'acquisition_ungrounded',
        detail:               `No upstream signal supports player acquisition of "${c.name}" (transfer_origin:${c.transfer_origin || 'none'})`,
        related_cb_candidate: c.name
      });
    }

    // Note if an existing record for this name lives in a different container
    const existingId  = _findExistingObjectId(c.name, activeObjects);
    if (existingId) {
      const existingCt = gameState?.objects?.[existingId]?.current_container_type;
      if (existingCt && existingCt !== 'player') {
        const note = `object_exists_in_${existingCt}`;
        ambiguity  = ambiguity ? `${ambiguity}; ${note}` : note;
      }
    }

    acquisition_signals.push({
      object_name:          c.name,
      actor:                'player',
      source_signals:       signals,
      evidence:             evidence_parts.join('; ') || String(rawInput).slice(0, 80),
      confidence:           _acquisitionConfidence(signals),
      unresolved_ambiguity: ambiguity,
      related_cb_candidate: c.name,
      related_object_id:    existingId
    });
  }

  // ── Transfer signals ──────────────────────────────────────────────────────
  // For each CB transfer, classify intent with provenance evidence.
  for (const t of transfers) {
    const tName  = t.object_name || t.object_id || null;
    const tObjId = t.object_id   || null;
    if (!tName) continue;

    const signals        = [];
    const evidence_parts = [];

    // Direct AP stamp match
    if (tObjId && apStampIds.includes(tObjId)) {
      signals.push('ap_executed_transfer');
      evidence_parts.push(`ap_stamp:${tObjId}`);
    }
    // Name-based AP stamp match
    if (!signals.includes('ap_executed_transfer')) {
      const apNameMatch = activeObjects.find(o =>
        apStampIds.includes(o.id) &&
        (_tokenContains(o.name.toLowerCase(), tName.toLowerCase()) ||
         _tokenContains(tName.toLowerCase(), o.name.toLowerCase()))
      );
      if (apNameMatch) {
        signals.push('ap_executed_transfer');
        evidence_parts.push(`ap_stamp_name:${apNameMatch.id}`);
      }
    }
    if (gateRefs.some(r =>
      _tokenContains(r, tName.toLowerCase()) || _tokenContains(tName.toLowerCase(), r)
    )) {
      signals.push('gate.referenced_objects');
    }
    if (parsedAction === 'drop' || parsedAction === 'throw') {
      signals.push(`parser.action=${parsedAction}`);
      evidence_parts.push(`parser:${parsedAction}`);
    } else if (parsedAction === 'take') {
      signals.push('parser.action=take');
    }

    const resolvedId = (tObjId && gameState?.objects?.[tObjId]?.status === 'active')
      ? tObjId
      : _findExistingObjectId(tName, activeObjects);
    const fromActor = t.from_container_type === 'player'
      ? 'player'
      : (t.from_container_id || t.from_container_type || 'unknown');
    const toActor   = t.to_container_type   === 'player'
      ? 'player'
      : (t.to_container_id   || t.to_container_type   || 'unknown');

    transfer_signals.push({
      object_name:          tName,
      from_actor:           fromActor,
      to_actor:             toActor,
      source_signals:       signals,
      evidence:             evidence_parts.join('; ') || String(rawInput).slice(0, 80),
      confidence:           signals.length > 0 ? Math.min(1.0, 0.5 + signals.length * 0.15) : 0.3,
      unresolved_ambiguity: signals.length === 0 ? 'no_corroborating_signal' : null,
      related_cb_transfer:  tName,
      related_object_id:    resolvedId
    });
  }

  // ── Dedup candidates ─────────────────────────────────────────────────────
  // For each CB candidate, identify whether it probably refers to an existing
  // active ObjectRecord under the same or similar name.
  // Observe-only: does not influence ObjectHelper or ORS. Diagnostic surface only.
  // gate_reference never emits an entry on its own — it only boosts confidence
  // for an already-found exact/token_subset match.
  for (const c of candidates) {
    if (!c.name) continue;
    const cNameLower = c.name.toLowerCase().trim();
    const matches    = [];

    for (const obj of activeObjects) {
      const objNameLower = obj.name.toLowerCase().trim();
      let match_method       = null;
      let base_confidence    = 0;
      let relationship_type  = null;
      const source_signals   = [];

      if (cNameLower === objNameLower) {
        match_method      = 'exact';
        base_confidence   = 0.95;
        relationship_type = 'exact_name_match';
        source_signals.push('exact_name_match');
      } else if (_tokenContains(cNameLower, objNameLower) || _tokenContains(objNameLower, cNameLower)) {
        match_method      = 'token_subset';
        base_confidence   = 0.65;
        relationship_type = 'token_subset_match';
        source_signals.push('token_subset_match');
      }

      if (!match_method) continue;

      let confidence = base_confidence;

      // gate_reference boost — only if match already found
      const candidateInGate = gateRefs.some(r =>
        r === cNameLower ||
        _tokenContains(r, cNameLower) ||
        _tokenContains(cNameLower, r)
      );
      if (candidateInGate && gateRefs.some(r =>
        r === objNameLower ||
        _tokenContains(r, objNameLower) ||
        _tokenContains(objNameLower, r)
      )) {
        source_signals.push('gate.referenced_objects');
        confidence        = Math.min(1.0, confidence + 0.10);
        relationship_type = 'possible_same_object';
      }

      // AP stamp boost — only if match already found
      if (apStampIds.includes(obj.id)) {
        source_signals.push('ap_executed_transfer');
        confidence        = Math.min(1.0, confidence + 0.05);
        relationship_type = 'possible_same_object';
      }

      matches.push({
        proposed_name:            c.name,
        cb_candidate_ref:         c.temp_ref || null,
        probable_existing_id:     obj.id,
        existing_name:            obj.name,
        existing_container_type:  obj.current_container_type,
        existing_container_id:    obj.current_container_id,
        match_method,
        confidence,
        relationship_type,
        source_signals,
        unresolved_ambiguity:     null
      });
    }

    if (matches.length === 0) continue;

    // Sort by confidence desc, cap at 3
    matches.sort((a, b) => b.confidence - a.confidence);
    const top = matches.slice(0, 3);

    // If multiple matches, mark all as ambiguous
    if (top.length > 1) {
      const ids = top.map(m => m.probable_existing_id).join(',');
      for (const m of top) {
        m.relationship_type   = 'ambiguous_match';
        m.unresolved_ambiguity = `multiple_matches:[${ids}]`;
      }
    }

    // v1.88.88: inject scene_continuity signal for single unambiguous exact-match floor-object candidates.
    // Fires when candidate and existing object share the same scene context (grid macro-location,
    // or exact same localspace/site container). Multi-match entries skip this — ambiguous_match
    // veto in _computeRecommendation fires first regardless.
    const cContainerType = c.container_type || null;
    if (top.length === 1) {
      const _sc = top[0];
      if (_sameSceneContext(c.container_type, c.container_id, _sc.existing_container_type, _sc.existing_container_id)) {
        if (!_sc.source_signals.includes('scene_continuity')) {
          _sc.source_signals.push('scene_continuity');
        }
      }
    }

    // Attach suppression recommendation to each entry (observe-only — ObjectHelper does not consume until v1.88.86)
    for (const m of top) {
      const rec = _computeRecommendation(m, cContainerType);
      m.action_recommendation = rec.action_recommendation;
      m.veto_reasons          = rec.veto_reasons;
    }

    for (const m of top) dedup_candidates.push(m);
  }

  // v1.90.01: TLS fission normalization — convert CB fission_events[] to ORS-compatible fission_operations[]
  const _fissionEvts = Array.isArray(phaseBResult.fission_events) ? phaseBResult.fission_events : [];
  const fission_operations = _normalizeFissionEvents(_fissionEvts, activeObjects, gateRefs, apStampIds, gameState);

  // v1.91.01: TLS extraction normalization — convert CB extraction_events[] to extraction_operations[]
  const _extractionEvts = Array.isArray(phaseBResult.extraction_events) ? phaseBResult.extraction_events : [];
  const extraction_operations = _normalizeExtractionEvents(_extractionEvts, activeObjects, gateRefs, apStampIds, gameState);

  return {
    tsl: {
      version:              '1.0',
      stage:                'observe',
      alias_candidates,
      acquisition_signals,
      transfer_signals,
      warnings,
      dedup_candidates,
      fission_operations,
      extraction_operations
    },
    processing_time_ms: Date.now() - t0
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns a flat array of active ObjectRecord summaries from gameState.objects. */
function _getActiveObjects(gameState) {
  const objs = gameState?.objects;
  if (!objs || typeof objs !== 'object') return [];
  return Object.values(objs)
    .filter(o => o && o.status === 'active' && o.id && o.name)
    .map(o => ({
      id:                     o.id,
      name:                   o.name,
      current_container_type: o.current_container_type,
      current_container_id:   o.current_container_id,
      associated_actor_id:    o.associated_actor_id || null
    }));
}

/**
 * Attempt to match a candidate name to active ObjectRecords via multiple methods.
 * Returns an array of match objects (empty if no match found).
 * Caps at 2 non-exact matches to limit noise.
 */
function _resolveAlias(rawName, actorRef, activeObjects, gateRefs, apStampIds) {
  const results   = [];
  const nameLower = String(rawName).toLowerCase().trim();
  if (!nameLower) return results;

  for (const obj of activeObjects) {
    const objNameLower  = String(obj.name).toLowerCase().trim();
    const source_signals = [];
    let method     = null;
    let confidence = 0;

    if (nameLower === objNameLower) {
      method     = 'exact';
      confidence = 1.0;
      source_signals.push('exact_name_match');
    } else if (_tokenContains(nameLower, objNameLower) || _tokenContains(objNameLower, nameLower)) {
      method     = 'token_subset';
      confidence = 0.72;
      source_signals.push('token_subset_match');
    } else {
      const candidateInGate = gateRefs.some(r =>
        r === nameLower ||
        _tokenContains(r, nameLower) ||
        _tokenContains(nameLower, r)
      );
      if (candidateInGate) {
        const gateMatch = gateRefs.some(r =>
          r === objNameLower ||
          _tokenContains(r, objNameLower) ||
          _tokenContains(objNameLower, r)
        );
        if (gateMatch) {
          method     = 'gate_reference';
          confidence = 0.60;
          source_signals.push('gate.referenced_objects');
        }
      }
    }

    if (!method) continue;

    if (apStampIds.includes(obj.id)) {
      source_signals.push('ap_executed_transfer');
      confidence = Math.min(1.0, confidence + 0.15);
    }
    if (actorRef && obj.associated_actor_id) {
      const aLow = String(actorRef).toLowerCase();
      const bLow = String(obj.associated_actor_id).toLowerCase();
      if (aLow === bLow || aLow.includes(bLow) || bLow.includes(aLow)) {
        source_signals.push('actor_association');
        confidence = Math.min(1.0, confidence + 0.10);
      }
    }

    results.push({ object_id: obj.id, resolved_name: obj.name, method, source_signals, confidence, ambiguity: null });
  }

  if (results.length > 1) {
    const ids = results.map(r => r.object_id).join(',');
    for (const r of results) r.ambiguity = `multiple_candidates:[${ids}]`;
    results.sort((a, b) => b.confidence - a.confidence);
    return results.slice(0, 2);
  }
  return results;
}

/** True if every token in needle appears as a whole token in haystack. */
function _tokenContains(haystack, needle) {
  if (!haystack || !needle) return false;
  const hSet    = new Set(String(haystack).split(/\s+/).filter(Boolean));
  const nTokens = String(needle).split(/\s+/).filter(Boolean);
  return nTokens.length > 0 && nTokens.every(nt => hSet.has(nt));
}

/** Find the object_id of the first active record with an exact name match. */
function _findExistingObjectId(name, activeObjects) {
  const nameLower = String(name).toLowerCase().trim();
  const match = activeObjects.find(o => String(o.name).toLowerCase().trim() === nameLower);
  return match ? match.id : null;
}

/**
 * Compute action_recommendation + veto_reasons for a dedup_candidates entry.
 * Green zone → recommend_suppress_promote (all six conditions met).
 * Any red-line veto → do_not_suppress.
 * Everything else → warn_only.
 */
function _computeRecommendation(entry, candidateContainerType) {
  const veto_reasons = [];

  // Red-line: ambiguous match (multiple candidates — cannot pick one)
  if (entry.relationship_type === 'ambiguous_match') {
    veto_reasons.push('ambiguous_match');
  }

  // Red-line: token_subset only (too loose — state-change objects look identical)
  if (entry.match_method !== 'exact') {
    veto_reasons.push('token_subset_match');
  }

  // Red-line: no provenance signal beyond bare name match.
  // scene_continuity is a weaker floor-object proximity signal (v1.88.88) — it exits the
  // do_not_suppress path but does not reach the green zone; handled below as warn_only.
  const hasProvenance      = entry.source_signals.includes('ap_executed_transfer') ||
                             entry.source_signals.includes('gate.referenced_objects');
  const hasSceneContinuity = entry.source_signals.includes('scene_continuity');
  if (!hasProvenance && !hasSceneContinuity) {
    veto_reasons.push('no_provenance_signal');
  }

  // Red-line: blocklist word in proposed_name (implies distinct/new/state-changed object)
  const nameTokens = new Set(String(entry.proposed_name).toLowerCase().split(/\s+/).filter(Boolean));
  for (const word of SUPPRESSION_BLOCKLIST) {
    if (nameTokens.has(word)) {
      veto_reasons.push(`blocklist_word:${word}`);
      break;
    }
  }

  // Red-line: container mismatch with no AP provenance
  // AP provenance overrides stale containers in both take and drop directions.
  const apProvenance = entry.source_signals.includes('ap_executed_transfer');
  if (!apProvenance &&
      candidateContainerType &&
      entry.existing_container_type &&
      candidateContainerType !== entry.existing_container_type) {
    veto_reasons.push('container_mismatch_no_ap_provenance');
  }

  if (veto_reasons.length > 0) {
    return { action_recommendation: 'do_not_suppress', veto_reasons };
  }

  // scene_continuity without hard provenance (AP/gate) → warn_only.
  // Observe-only until MB audits false-positive rate; does not bridge to ObjectHelper.
  if (!hasProvenance && hasSceneContinuity) {
    return { action_recommendation: 'warn_only', veto_reasons: ['scene_continuity_only'] };
  }

  // Soft threshold: confidence below green zone minimum
  if (entry.confidence < 0.9) {
    return { action_recommendation: 'warn_only', veto_reasons: ['confidence_below_threshold'] };
  }

  // All conditions met → green zone
  return { action_recommendation: 'recommend_suppress_promote', veto_reasons: [] };
}

/** Weighted confidence score for player acquisition intent. */
function _acquisitionConfidence(signals) {
  let score = 0.25;
  if (signals.includes('parser.action=take'))                         score += 0.30;
  if (signals.includes('gate.input_type=player_attempt'))             score += 0.15;
  if (signals.includes('gate.referenced_objects'))                    score += 0.10;
  if (signals.includes('ap_executed_transfer'))                       score += 0.20;
  if (signals.includes('cb.transfer_origin=environment_interaction')) score += 0.05;
  return Math.min(1.0, score);
}

// ── Fission normalization helpers (v1.90.01) ─────────────────────────────────

/**
 * Normalize CB fission_events[] into ORS-compatible fission_operations[].
 * Each entry resolves source_ref → object_id via existing alias logic and builds
 * typed successor shapes from products[] + destination_hint.
 * confidence is always emitted (0 for unresolved) to support future ambiguity handling.
 */
function _normalizeFissionEvents(fissionEvents, activeObjects, gateRefs, apStampIds, gameState) {
  const operations = [];
  if (!Array.isArray(fissionEvents) || fissionEvents.length === 0) return operations;

  for (const evt of fissionEvents) {
    if (!evt || !evt.source_ref) continue;

    const matches         = _resolveAlias(evt.source_ref, null, activeObjects, gateRefs, apStampIds);
    const bestMatch       = matches.length > 0 ? matches[0] : null;
    const source_object_id = bestMatch ? bestMatch.object_id : null;
    const confidence      = bestMatch ? bestMatch.confidence : 0;
    const unresolved      = source_object_id === null;
    const ambiguous       = matches.length > 1;

    const products   = Array.isArray(evt.products) ? evt.products : [];
    const successors = [];
    for (let i = 0; i < products.length; i++) {
      const prod = products[i];
      // Structured product object: {name, destination_hint} — v1.90.05
      // Backward compat: plain string falls through to evt.destination_hint
      let prodName, prodDestHint;
      if (prod && typeof prod === 'object' && typeof prod.name === 'string' && prod.name.trim()) {
        prodName     = prod.name.trim();
        prodDestHint = typeof prod.destination_hint === 'string' ? prod.destination_hint : evt.destination_hint;
      } else if (typeof prod === 'string' && prod.trim()) {
        prodName     = prod.trim();
        prodDestHint = evt.destination_hint;
      } else {
        continue;
      }
      const dest = _resolveDestinationHint(prodDestHint, gameState);
      successors.push({
        name:           prodName,
        quantity:       1,
        unit:           null,
        container_type: dest.container_type,
        container_id:   dest.container_id,
        temp_ref:       `tsl_fission_${i}`
      });
    }

    operations.push({
      source_ref:       evt.source_ref,
      source_object_id,
      retire_source:    true,
      successors,
      verb:             evt.verb      || null,
      actor_ref:        evt.actor_ref || null,
      evidence:         evt.evidence  || null,
      confidence,
      unresolved,
      ambiguous
    });
  }
  return operations;
}

/**
 * Resolve CB destination_hint to a container_type/container_id pair.
 * Kept minimal — provenance needs to mature before adding more destinations.
 */
function _resolveDestinationHint(hint, gameState) {
  if (hint === 'player_hands') {
    return { container_type: 'player', container_id: 'player' };
  }
  if (hint === 'table' || hint === 'ground') {
    const ls   = gameState?.world?.active_local_space;
    const site = gameState?.world?.active_site;
    if (ls?.local_space_id) {
      return { container_type: 'localspace', container_id: ls.local_space_id };
    }
    if (site) {
      const siteId = site.id || site.site_id;
      const px     = gameState?.player?.position?.x;
      const py     = gameState?.player?.position?.y;
      if (siteId != null && px != null && py != null) {
        return { container_type: 'site', container_id: `${siteId}:${px},${py}` };
      }
    }
  }
  // 'unknown' or unrecognized — default: pieces in player hands
  return { container_type: 'player', container_id: 'player' };
}

/**
 * v1.91.01: Normalize CB extraction_events[] into ORS-compatible extraction_operations[].
 * Extraction = source persists with reduced quantity; only the delta portion becomes a new object.
 * Fires when CB witnesses a partial split where the source object survives.
 */
function _normalizeExtractionEvents(extractionEvents, activeObjects, gateRefs, apStampIds, gameState) {
  const operations = [];
  if (!Array.isArray(extractionEvents) || extractionEvents.length === 0) return operations;

  for (const evt of extractionEvents) {
    if (!evt || !evt.source_ref) continue;

    const opIndex          = operations.length;
    const matches          = _resolveAlias(evt.source_ref, null, activeObjects, gateRefs, apStampIds);
    const bestMatch        = matches.length > 0 ? matches[0] : null;
    const source_object_id = bestMatch ? bestMatch.object_id : null;
    const confidence       = bestMatch ? bestMatch.confidence : 0;
    const unresolved       = source_object_id === null;
    const ambiguous        = matches.length > 1;

    // Read current source quantity from gameState (must be a positive integer)
    const _sourceRec       = source_object_id ? (gameState?.objects?.[source_object_id] ?? null) : null;
    const current_quantity = (_sourceRec && Number.isInteger(_sourceRec.quantity) && _sourceRec.quantity >= 1)
                             ? _sourceRec.quantity : null;

    // extracted_quantity: only valid when CB emits an explicit positive integer
    const extracted_quantity = (Number.isInteger(evt.extracted_quantity) && evt.extracted_quantity >= 1)
                               ? evt.extracted_quantity : null;
    const quantity_unresolved = extracted_quantity === null;

    // Compute new source quantity; degrade to fission if result <= 0
    let new_source_quantity = null;
    let degrades_to_fission = false;
    if (!quantity_unresolved && current_quantity !== null) {
      new_source_quantity = current_quantity - extracted_quantity;
      if (new_source_quantity <= 0) {
        degrades_to_fission = true;
        new_source_quantity = 0;
      }
      // v1.91.08: uncalibrated-quantity guard — quantity:1 + unit:null is the ORS default
      // for any unquantified object (loaf, jar, cake). It does NOT mean "exactly one
      // indivisible unit". Do not retire the source; route through partial_split instead.
      // Bridge state: source survives at quantity:1 until calibrated divisible capacity
      // arc assigns explicit serving counts. Distinct from quantity:1 + unit!==null (e.g.
      // "one apple"), which correctly degrades to fission.
      if (degrades_to_fission && current_quantity === 1 && !_sourceRec.unit) {
        degrades_to_fission = false;
        new_source_quantity = 1;
      }
    }

    const dest        = _resolveDestinationHint(evt.destination_hint, gameState);
    const prodName    = (typeof evt.product_name === 'string' && evt.product_name.trim())
                        ? evt.product_name.trim() : evt.source_ref;
    const prodUnit    = (typeof evt.extracted_unit === 'string' && evt.extracted_unit.trim())
                        ? evt.extracted_unit.trim() : null;

    operations.push({
      source_ref:          evt.source_ref,
      source_object_id,
      current_quantity,
      extracted_quantity,
      extracted_unit:      prodUnit,
      new_source_quantity,
      degrades_to_fission,
      quantity_unresolved,
      product: {
        name:           prodName,
        quantity:       extracted_quantity ?? 1,
        unit:           prodUnit,
        container_type: dest.container_type,
        container_id:   dest.container_id,
        temp_ref:       `tsl_extraction_${opIndex}`
      },
      verb:       evt.verb      || null,
      actor_ref:  evt.actor_ref || null,
      evidence:   evt.evidence  || null,
      confidence,
      unresolved: unresolved || quantity_unresolved,
      ambiguous
    });
  }
  return operations;
}

module.exports = { analyze };
