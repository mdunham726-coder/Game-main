'use strict';

const fs         = require('fs');
const path       = require('path');
const fsPromises = fs.promises;

// =============================================================================
// DIAGNOSTICS MODULE
// Backend diagnostics logic extracted from index.js.
// index.js does: const diag = require('./diagnostics')
// =============================================================================

// Terrain type → 2-char code map (used by buildDebugContext world map 5x5 grid)
const _TERRAIN_CODES = {
  plains_grassland:'PG', plains_wildflower:'PW', meadow:'ME',
  forest_deciduous:'FD', forest_mixed:'FM', forest_coniferous:'FC',
  hills_rolling:'HR', hills_rocky:'HK', rocky_terrain:'RT', scree:'SC',
  mountain_slopes:'MS', mountain_peak:'MP', mountain_pass:'MA',
  desert_sand:'DS', desert_dunes:'DD', desert_rocky:'DR',
  scrubland:'SB', badlands:'BL', canyon:'CY', mesa:'MZ',
  tundra:'TU', snowfield:'SF', ice_sheet:'IS', permafrost:'PF', alpine:'AL',
  swamp:'SW', marsh:'MR', wetland:'WL', bog:'BG',
  beach_sand:'BS', beach_pebble:'BP', cliffs_coastal:'CC', tidepools:'TP', dunes_coastal:'DC',
  river_crossing:'RC', stream:'ST', lake_shore:'LS', waterfall:'WF', spring:'SP'
};

// Interior state helper — shared by buildDebugContext() and /diagnostics/sites routes
// Returns one of six codes describing the generation state of an enterable site slot.
function _getSiteInteriorState(s, sites) {
  if (s.enterable === false) return 'NOT_APPLICABLE';
  if (!s.is_filled)          return 'PENDING_FILL';
  if (!s.interior_key)       return 'MISSING_INTERIOR_KEY';
  const mirror = sites?.[s.interior_key];
  if (!mirror)               return 'MISSING_INTERIOR_RECORD';
  // v1.81.1: !mirror.is_stub covers false (new saves) and undefined (old saves). is_stub:true = stub only.
  if (!mirror.is_stub)       return 'GENERATED';
  return 'NOT_GENERATED';
}

// Find a site record in world.sites by site_id (bare or /l2 form).
// Returns { site, interior_key } or null.
const _findSiteRecord = (gs, site_id) => {
  const clean = (site_id || '').replace(/\/l2$/, '');
  for (const [interior_key, s] of Object.entries(gs.world.sites || {})) {
    const sId = (s.site_id ?? s.id ?? '').replace(/\/l2$/, '');
    if (sId === clean) return { site: s, interior_key };
  }
  return null;
};

// Disk fallback for turn archive reads — consults flight-recorder JSONL when in-memory session is gone.
// turnNum: numeric → return that specific turn's turnObject; null → return the highest-turn turnObject found.
// Never throws. Returns null on any error, missing directory, missing file, or malformed line.
async function _readTurnFromDisk(sessionId, turnNum) {
  try {
    const safeId = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_');
    const flRoot = path.join(__dirname, 'logs', 'flight-recorder');
    let dateDirs;
    try {
      dateDirs = await fsPromises.readdir(flRoot);
    } catch (e) {
      return null; // flight-recorder root does not exist yet
    }
    // Sort descending — most recent date checked first (early exit for recent sessions)
    dateDirs.sort((a, b) => b.localeCompare(a));
    for (const dateDir of dateDirs) {
      const filePath = path.join(flRoot, dateDir, 'session_' + safeId + '.jsonl');
      let raw;
      try {
        raw = await fsPromises.readFile(filePath, 'utf8');
      } catch (e) {
        if (e.code === 'ENOENT') continue;
        continue; // skip unreadable files without throwing
      }
      let bestParsed = null;
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed;
        try { parsed = JSON.parse(trimmed); } catch (e) { continue; }
        if (!parsed || !parsed.turnObject) continue;
        if (turnNum !== null) {
          if (parsed.turn === turnNum) return parsed.turnObject;
        } else {
          if (!bestParsed || (parsed.turn || 0) > (bestParsed.turn || 0)) bestParsed = parsed;
        }
      }
      if (turnNum === null && bestParsed) return bestParsed.turnObject;
    }
    return null;
  } catch (e) {
    return null;
  }
}

// =============================================================================
// PASSIVE DIAGNOSTIC CACHES
// Owned here; written by index.js via setters; read by buildDebugContext directly.
// =============================================================================

let _continuityBlockHistory  = []; // rolling last-3 continuity packets sent to narrator
let _lastNarratorPromptStats = null; // narrator prompt structure from last turn
let _lastNarratorPayload     = null; // full messages payload sent to narrator
let _lastNarratorRawResponse = null; // raw narrator response string

// Setters called by index.js turn handler -----------------------------------

// Appends to rolling window; evicts oldest when length exceeds 3.
function pushContinuityBlock(turn, block, chars) {
  _continuityBlockHistory.push({ turn, block, chars });
  if (_continuityBlockHistory.length > 3) _continuityBlockHistory.shift();
}

function setNarratorPromptStats(obj)  { _lastNarratorPromptStats = obj; }
function setNarratorPayload(obj)      { _lastNarratorPayload     = obj; }
function setNarratorRawResponse(str)  { _lastNarratorRawResponse = str; }

/**
 * Build game state context for DeepSeek debugging queries
 * @param {object} gameState - Current game state
 * @param {string} debugLevel - "basic" | "detailed" | "full"
 * @returns {string} Formatted context string
 */
function buildDebugContext(gameState, debugLevel = "detailed") {
  let context = "";
  
  if (!gameState || !gameState.world) {
    return "No game state available.";
  }

  const pos = gameState.world.position || { mx: 0, my: 0, lx: 6, ly: 6 };
  const currentCellKey = `LOC:${pos.mx},${pos.my}:${pos.lx},${pos.ly}`;
  const currentCell = gameState.world.cells?.[currentCellKey];

  // =========================================================================
  // AUTHORITATIVE PLAY SPACE — always first, always highest priority
  // =========================================================================
  {
    const _aDepth = gameState.world.current_depth ?? 1;
    const _aSite  = gameState.world.active_site || null;
    const _aLS    = gameState.world.active_local_space || null;

    let _aLayerLabel, _aContainer, _aPosStr;
    if (_aDepth >= 3 && _aLS) {
      _aLayerLabel = 'L2 (building interior)';
      _aContainer  = _aLS.name || '(unnamed local space)';
      _aPosStr     = `(${gameState.player?.position?.x ?? '?'}, ${gameState.player?.position?.y ?? '?'}) — site-local coords`;
    } else if (_aDepth >= 2 && _aSite) {
      _aLayerLabel = 'L1 (site)';
      _aContainer  = _aSite.name || '(unnamed site)';
      _aPosStr     = `(${gameState.player?.position?.x ?? '?'}, ${gameState.player?.position?.y ?? '?'}) — site-local coords`;
    } else {
      _aLayerLabel = 'L0 (overworld)';
      _aContainer  = `Macro(${pos.mx},${pos.my}) cell`;
      _aPosStr     = `Local(${pos.lx},${pos.ly}) — world grid coords`;
    }

    // Visible NPCs with name when learned
    const _aVisibleSrc = _aDepth >= 3 && _aLS ? (_aLS._visible_npcs || [])
                       : _aDepth >= 2 && _aSite ? (_aSite._visible_npcs || [])
                       : [];
    const _aVisibleLines = _aVisibleSrc.map(npc => {
      const _namePart = npc.is_learned && npc.npc_name ? ` name:"${npc.npc_name}"` : '';
      return `  - ${npc.job_category || npc.id || 'unknown'}${_namePart} [age:${npc.age ?? '?'}, gender:${npc.gender ?? '?'}, is_learned:${npc.is_learned ?? false}, rep_player:${npc.reputation_player ?? '?'}]`;
    });

    context += `\n=== CURRENT AUTHORITATIVE PLAY SPACE ===\n`;
    context += `!! Active layer/container and visible entities below override any biome, terrain, macro, or\n`;
    context += `!! flattened coordinate data shown later for debugging/reference.\n`;
    context += `Active Layer : ${_aLayerLabel}\n`;
    context += `Container    : ${_aContainer}\n`;
    context += `Position     : ${_aPosStr}\n`;
    context += `Visible NPCs : ${_aVisibleLines.length > 0 ? _aVisibleLines.length + ' visible\n' + _aVisibleLines.join('\n') : '(none at current tile)'}\n`;
  }

  // === BASIC LEVEL ===
  context += `\n=== CURRENT LOCATION ===\n`;
  context += `Position: Macro(${pos.mx},${pos.my}) -> Local(${pos.lx},${pos.ly})\n`;
  context += `Cell Type: ${currentCell?.type || "unknown"}\n`;
  context += `Cell Biome: ${currentCell?.biome || "unknown"}\n`;
  context += `Description: ${currentCell?.description || ""}\n`;
  const _ctxDepth = gameState.world.current_depth ?? 1;
  const _ctxLayer = { 1: 'L0 (overworld)', 2: 'L1 (site)', 3: 'L2 (building)', 4: 'L3 (subspace)' }[_ctxDepth] || `L? (depth ${_ctxDepth})`;
  context += `Current Layer   : ${_ctxLayer}\n`;
  console.log('[DEBUG-CTX] layer=%s depth=%s site=%s pos=%o', _ctxLayer, _ctxDepth, !!(gameState.world.active_site), gameState.player?.position);

  context += `\n=== NEARBY NPCS ===\n`;
  const _dbgDepth = gameState.world.current_depth ?? 1;
  const _dbgActiveSite = gameState.world.active_site || null;

  if (_dbgDepth === 3 && gameState.world.active_local_space) {
    const _dbgLS = gameState.world.active_local_space;
    if (gameState.player?.position) {
      const Actions = require('./ActionProcessor.js');
      _dbgLS._visible_npcs = Actions.computeVisibleNpcs(_dbgLS, gameState.player.position, gameState.world.active_site?.npcs || []);
    }
    const _dbgVisible = _dbgLS._visible_npcs || [];
    context += `\n=== ACTIVE LOCAL SPACE (L2) ===\n`;
    context += `Name: ${_dbgLS.name || '(unfilled)'}\n`;
    context += `Description: ${_dbgLS.description || '(unfilled)'}\n`;
    // v1.81.3: local_space.npcs is always [] (never populated — dead field removed from WorldGen).
    // Correct sources: npc_ids = IDs assigned to this space; _dbgVisible = resolved NPCs at player tile.
    context += `NPCs in space: ${(_dbgLS.npc_ids || []).length}\n`;
    context += `NPCs at your tile: ${_dbgVisible.length}\n`;
    context += `Player Position (L2): (${gameState.player?.position?.x ?? '?'},${gameState.player?.position?.y ?? '?'})\n`;
    context += `\n=== NEARBY NPCS ===\n`;
    if (_dbgVisible.length > 0) {
      _dbgVisible.forEach(npc => {
        const _npcNamePart = npc.is_learned && npc.npc_name ? ` name:"${npc.npc_name}"` : '';
        context += `- ${npc.job_category || npc.id || 'Unknown'}${_npcNamePart} [age:${npc.age ?? '?'}, gender:${npc.gender || '?'}, is_learned:${npc.is_learned ?? false}, rep_player:${npc.reputation_player ?? '?'}]\n`;
      });
    } else {
      context += `(None visible at current tile)\n`;
    }
  } else if (_dbgActiveSite) {
    // L1: recompute _visible_npcs fresh (freshness guarantee — never stale)
    if (gameState.player?.position) {
      const Actions = require('./ActionProcessor.js');
      _dbgActiveSite._visible_npcs = Actions.computeVisibleNpcs(_dbgActiveSite, gameState.player.position);
    }
    const _dbgVisible = _dbgActiveSite._visible_npcs || [];

    context += `\n=== ACTIVE SITE (L1) ===\n`;
    context += `Name: ${_dbgActiveSite.name || '(unnamed)'}\n`;
    context += `Type: ${_dbgActiveSite.type || '(unknown)'}\n`;
    context += `NPC Records: ${(_dbgActiveSite.npcs || []).length}\n`;
    context += `Player Position: (${gameState.player?.position?.x ?? '?'},${gameState.player?.position?.y ?? '?'})\n`;
    context += `\n=== NEARBY NPCS ===\n`;

    // L1: use visible NPCs only — no overworld fallback
    if (_dbgVisible.length > 0) {
      _dbgVisible.forEach(npc => {
        const _npcNamePart = npc.is_learned && npc.npc_name ? ` name:"${npc.npc_name}"` : '';
        context += `- ${npc.job_category || npc.id || 'Unknown'}${_npcNamePart} [age:${npc.age ?? '?'}, gender:${npc.gender || '?'}, is_learned:${npc.is_learned ?? false}, rep_player:${npc.reputation_player ?? '?'}]\n`;
      });
    } else {
      context += `(None visible at current tile)\n`;
    }
  } else {
    // L0: use world-level npcs
    if (gameState.world.npcs && gameState.world.npcs.length > 0) {
      gameState.world.npcs.slice(0, 3).forEach(npc => {
        context += `- ${npc.npc_name || npc.name || "Unnamed"} (${npc.job_category || npc.archetype || "unknown"})\n`;
      });
      if (gameState.world.npcs.length > 3) {
        context += `... and ${gameState.world.npcs.length - 3} more\n`;
      }
    } else {
      context += `(None visible)\n`;
    }
  }

  // === DETAILED LEVEL ===
  if (debugLevel === "detailed" || debugLevel === "full") {
    context += `\n=== WORLD GENERATION PARAMETERS ===\n`;
    context += `Biome               : ${gameState.world.macro_biome || "not detected"}\n`;
    context += `World Tone          : ${gameState.world.world_tone || "not detected"}\n`;
    context += `Starting Loc Type   : ${gameState.world.starting_location_type || "not detected"}\n`;
    context += `World Seed          : ${gameState.world.phase3_seed ?? "(not set)"}\n`;
    context += `Turn Counter        : ${gameState.turn_counter ?? 0}\n`;

    const _spl = gameState.world.site_placement_log;
    if (_spl) {
      context += `\n=== SITE PLACEMENT ===\n`;
      context += `Cells Evaluated     : ${_spl.total_cells_evaluated}\n`;
      context += `Sites Placed        : ${_spl.total_sites_placed}\n`;
      context += `Enterable           : ${_spl.total_enterable} / Non-Enterable: ${_spl.total_non_enterable}\n`;
      context += `Spacing Rejections  : ${_spl.spacing_rejections}\n`;
      const _szLine = Object.entries(_spl.size_counts)
        .map(([sz, ct]) => `${sz}:${ct}(${_spl.size_percentages[sz]}%)`)
        .join('  ');
      context += `Size Counts         : ${_szLine}\n`;
    }

    context += `\n=== CURRENT CELL SITES (authoritative) ===\n`;
    const _dbgSites = currentCell?.sites ? Object.values(currentCell.sites) : [];
    context += `Site Count : ${_dbgSites.length}\n`;
    if (_dbgSites.length > 0) {
      _dbgSites.forEach(s => {
        context += `- ${s.site_id} | identity: ${s.identity ?? '(unfilled)'} | name: ${s.name ?? '(unnamed)'} | is_filled: ${s.is_filled ? 'YES' : 'NO'}\n`;
        if (s.description != null) context += `  desc      : ${s.description}\n`;
      });
    } else {
      context += `  - none\n`;
    }



    context += `\n=== SITE INTERIOR REGISTRY ===\n`;
    const siteKeys = Object.keys(gameState.world.sites || {});
    const _filledSites = siteKeys.filter(k => !gameState.world.sites[k].is_stub);
    const _stubSites = siteKeys.filter(k => !!gameState.world.sites[k].is_stub);
    context += `Total entries: ${_filledSites.length} filled\n`;
    if (_filledSites.length > 0) {
      context += `-- Filled sites --\n`;
      _filledSites.slice(0, 5).forEach(k => {
        const _sr = gameState.world.sites[k];
        const _srCell = (_sr.mx !== undefined && _sr.lx !== undefined)
          ? `LOC:${_sr.mx},${_sr.my}:${_sr.lx},${_sr.ly}` : '(unknown)';
        const _srActive = gameState.world.active_site === k;
        context += `  ${k}\n`;
        context += `    identity: ${_sr.type || '(unfilled)'}  |  name: ${_sr.name || '(unnamed)'}  |  NPCs: ${(_sr.npcs || []).length}  |  cell: ${_srCell}${_srActive ? '  [ACTIVE]' : ''}\n`;
      });
      if (_filledSites.length > 5) context += `  ... and ${_filledSites.length - 5} more filled\n`;
    }
    if (_filledSites.length === 0) {
      context += `(none)\n`;
    }

    context += `\n=== COORDINATE SYSTEM ===\n`;
    context += `Macro grid: 8x8  (mx: 0-7, my: 0-7)\n`;
    context += `Local grid per macro cell: 128x128  (lx: 0-127, ly: 0-127)\n`;
    context += `Cell key format: LOC:mx,my:lx,ly\n`;
    context += `Position format: L0 cell(mx,my:lx,ly) at overworld | site-local (x,y) @ cell(mx,my:lx,ly) inside a site\n`;
    context += `lx/ly values of 0-127 are fully valid — do NOT treat them as anomalies.\n`;

    context += `\n=== VISIBLE CELLS (Sample) ===\n`;
    context += `Macro cell (${pos.mx},${pos.my}) — sample of up to 5 other local cells within this macro cell (player cell excluded):\n`;
    const _playerCellKey = `LOC:${pos.mx},${pos.my}:${pos.lx},${pos.ly}`;
    const cellKeys = Object.keys(gameState.world.cells || {})
      .filter(k => {
        const cell = gameState.world.cells[k];
        return cell && cell.mx === pos.mx && cell.my === pos.my && k !== _playerCellKey;
      })
      .slice(0, 5);
    
    if (cellKeys.length > 0) {
      cellKeys.forEach(k => {
        const cell = gameState.world.cells[k];
        context += `- cell(${pos.mx},${pos.my}:${cell.lx},${cell.ly}) ${cell.type}/${cell.subtype}\n`;
      });
    } else {
      context += `(No other loaded cells in current macro)\n`;
    }

    // === PLAYER STATE (v1.73.0) ===
    const _ctxPlayer = gameState.player;
    context += `\n=== PLAYER STATE ===\n`;
    if (!_ctxPlayer) {
      context += `(no player record)\n`;
    } else {
      const _pp = _ctxPlayer.position || {};
      const _posStr = _pp.x != null
        ? `site-local (${_pp.x},${_pp.y}) @ cell(${_pp.mx},${_pp.my}:${_pp.lx},${_pp.ly})`
        : (_pp.mx != null ? `L0 cell(${_pp.mx},${_pp.my}:${_pp.lx},${_pp.ly})` : 'no position');
      context += `position: ${_posStr}\n`;
      const _pAttrCount = _ctxPlayer.attributes ? Object.keys(_ctxPlayer.attributes).length : 0;
      context += `attributes: ${_pAttrCount} fact(s)`;
      if (_pAttrCount > 0) {
        const _pAttrStr = Object.values(_ctxPlayer.attributes).map(a => `${a.bucket ? a.bucket + ':' : ''}${a.value}${a.turn_set != null ? ` (T-${a.turn_set})` : ''}`).join(' | ');
        context += ` — ${_pAttrStr}`;
      }
      context += `\n`;
      // v1.84.31: state: decay summary — show how many are active vs suppressed in narrator
      if (_pAttrCount > 0) {
        const _allAttrs = Object.values(_ctxPlayer.attributes);
        const _curTurnDbg = (gameState.turn_history?.length || 0) + 1;
        const _stateAttrs = _allAttrs.filter(a => a.bucket === 'state');
        const _activeStateAttrs = _stateAttrs.filter(a => a.turn_set == null || a.turn_set >= _curTurnDbg - 5);
        const _suppressedState = _stateAttrs.length - _activeStateAttrs.length;
        const _nonStateAttrs = _allAttrs.filter(a => a.bucket !== 'state').length;
        context += `state attrs in narrator: ${_activeStateAttrs.length + _nonStateAttrs} active / ${_pAttrCount} total`;
        if (_suppressedState > 0) context += ` (${_suppressedState} state: suppressed, window=5)`;
        context += `\n`;
      }
      const _brec = _ctxPlayer.birth_record;
      if (!_brec) {
        context += `birth_record: (none)\n`;
      } else {
        context += `birth_record:\n`;
        context += `  raw_input: ${_brec.raw_input != null ? `"${String(_brec.raw_input).slice(0, 120)}${String(_brec.raw_input).length > 120 ? '...' : ''}"` : '(null)'}\n`;
        context += `  form: ${_brec.form != null ? _brec.form : '(null)'}\n`;
        context += `  location_premise: ${_brec.location_premise != null ? _brec.location_premise : '(null)'}\n`;
        if (Array.isArray(_brec.possessions) && _brec.possessions.length > 0)
          context += `  possessions: ${_brec.possessions.slice(0, 5).join(', ')}${_brec.possessions.length > 5 ? ` (+${_brec.possessions.length - 5} more)` : ''}\n`;
        if (Array.isArray(_brec.status_claims) && _brec.status_claims.length > 0)
          context += `  status_claims: ${_brec.status_claims.slice(0, 5).join(', ')}${_brec.status_claims.length > 5 ? ` (+${_brec.status_claims.length - 5} more)` : ''}\n`;
        if (Array.isArray(_brec.scenario_notes) && _brec.scenario_notes.length > 0)
          context += `  scenario_notes: ${_brec.scenario_notes.slice(0, 5).join(', ')}${_brec.scenario_notes.length > 5 ? ` (+${_brec.scenario_notes.length - 5} more)` : ''}\n`;
      }
      // === PLAYER CONDITIONS ===
      const _ctxConds = _ctxPlayer.conditions;
      const _ctxCondsArchive = _ctxPlayer.conditions_archive;
      context += `\n=== PLAYER CONDITIONS ===\n`;
      if (!Array.isArray(_ctxConds) || _ctxConds.length === 0) {
        context += `(no active conditions)\n`;
      } else {
        for (const _cond of _ctxConds) {
          context += `[${_cond.condition_id}] (since T-${_cond.created_turn})\n`;
          context += `  description: ${_cond.description}\n`;
          const _recentLog = (_cond.turn_log || []).slice(-5);
          if (_recentLog.length > 0) {
            context += `  turn_log (last ${_recentLog.length}):\n`;
            for (const _le of _recentLog) context += `    ${_le}\n`;
          }
          if (Array.isArray(_cond.notes) && _cond.notes.length > 0) {
            context += `  notes: ${_cond.notes.join(' | ')}\n`;
          }
        }
      }
      if (Array.isArray(_ctxCondsArchive) && _ctxCondsArchive.length > 0) {
        context += `archived conditions: ${_ctxCondsArchive.length}\n`;
      }
    } // end PLAYER STATE else block

    // === OBJECT REALITY STATE (v1.84.54) ===
    context += `\n=== OBJECT REALITY STATE ===\n`;
    const _lastTurnOr = (gameState.turn_history || []).slice(-1)[0]?.object_reality ?? null;
    if (!_lastTurnOr) {
      context += `Last turn: no data\n`;
    } else if (_lastTurnOr.ran) {
      context += `Last turn: ran:YES | promoted:${_lastTurnOr.promoted}  transferred:${_lastTurnOr.transferred}  errors:${_lastTurnOr.errors}  origin_blocked:${_lastTurnOr.origin_blocked || 0}\n`;
      if ((_lastTurnOr.errors > 0 || (_lastTurnOr.origin_blocked || 0) > 0) && Array.isArray(_lastTurnOr.error_entries)) {
        for (const _orErr of _lastTurnOr.error_entries.slice(0, 3)) {
          context += `  ERROR: ${_orErr.action || _orErr.stage || '?'} | "${_orErr.object_name || _orErr.name || '?'}" | ${_orErr.reason || '?'} -> use trace_object\n`;
        }
      }
    } else {
      context += `Last turn: skipped (${_lastTurnOr.skip_reason || 'no_data'})\n`;
    }
    const _orPlayerIds = Array.isArray(gameState.player?.object_ids) ? gameState.player.object_ids : [];
    const _orObjects   = (gameState.objects && typeof gameState.objects === 'object') ? gameState.objects : {};
    if (_orPlayerIds.length === 0) {
      context += `Player: (none)\n`;
    } else {
      const _orInvLines = _orPlayerIds.map(id => {
        const rec = _orObjects[id];
        return rec ? `"${rec.name}" [${id}]` : `[unresolved: ${id}]`;
      });
      context += `Player: ${_orInvLines.join(', ')}\n`;
    }
    // v1.85.22: show player worn items
    const _orWornIds = Array.isArray(gameState.player?.worn_object_ids) ? gameState.player.worn_object_ids : [];
    if (_orWornIds.length === 0) {
      context += `Player (worn): (none)\n`;
    } else {
      const _orWornLines = _orWornIds.map(id => {
        const rec = _orObjects[id];
        return rec ? `"${rec.name}" [${id}]${rec.source === 'birth_default' ? ' (baseline)' : ''}` : `[unresolved: ${id}]`;
      });
      context += `Player (worn): ${_orWornLines.join(', ')}\n`;
    }
    // v1.84.86: show localspace floor objects when player is at L2 depth
    const _orActiveLs = gameState.world?.active_local_space;
    if (_orActiveLs) {
      const _orLsId   = _orActiveLs.local_space_id;
      const _orLsName = _orActiveLs.name || _orLsId;
      const _orLsFloor = Object.values(_orObjects).filter(o => (o.status || 'active') === 'active' && o.current_container_type === 'localspace' && o.current_container_id === _orLsId);
      if (_orLsFloor.length === 0) {
        context += `Floor (${_orLsName}): (none)\n`;
      } else {
        context += `Floor (${_orLsName}): ${_orLsFloor.map(o => `"${o.name}" [${o.id}]`).join(', ')}\n`;
      }
    } else if (gameState.world?.active_site) {
      // v1.84.97: show site floor objects when player is at L1 depth
      const _orSite97   = gameState.world.active_site;
      const _orSiteId97 = _orSite97.site_id || _orSite97.id?.replace(/\/l2$/, '');
      const _orSiteName = _orSite97.name || _orSiteId97;
      const _orPx97 = gameState.player?.position?.x;
      const _orPy97 = gameState.player?.position?.y;
      if (_orSiteId97 != null && _orPx97 != null && _orPy97 != null) {
        const _orSiteKey97 = `${_orSiteId97}:${_orPx97},${_orPy97}`;
        const _orSiteFloor = Object.values(_orObjects).filter(o => (o.status || 'active') === 'active' && o.current_container_type === 'site' && o.current_container_id === _orSiteKey97);
        if (_orSiteFloor.length === 0) {
          context += `Floor (${_orSiteName}): (none)\n`;
        } else {
          context += `Floor (${_orSiteName}): ${_orSiteFloor.map(o => `"${o.name}" [${o.id}]`).join(', ')}\n`;
        }
      } else {
        context += `Floor (${_orSiteName}): (position unavailable)\n`;
      }
    } else {
      // v1.85.5: L0 ground objects — expose grid-container objects at current cell to narrator
      // Fires only when active_local_space and active_site are both null (L0 only, structurally watertight)
      const _orL0Pos = gameState.world?.position;
      if (_orL0Pos) {
        const _orL0Key = `LOC:${_orL0Pos.mx},${_orL0Pos.my}:${_orL0Pos.lx},${_orL0Pos.ly}`;
        const _orL0Floor = Object.values(_orObjects).filter(o =>
          (o.status || 'active') === 'active' &&
          o.current_container_type === 'grid' &&
          o.current_container_id === _orL0Key
        );
        if (_orL0Floor.length === 0) {
          context += `Ground (overworld): (none)\n`;
        } else {
          context += `Ground (overworld): ${_orL0Floor.map(o => `"${o.name}" [${o.id}]`).join(', ')}\n`;
        }
      }
    }

    // === ENTITY ATTRIBUTES (v1.70.0 — ContinuityBrain promoted facts) ===
    const _ctxLoc = gameState.world.active_local_space || gameState.world.active_site || (() => {
      const _pos = gameState.world.position;
      if (!_pos) return null;
      return gameState.world.cells?.[`LOC:${_pos.mx},${_pos.my}:${_pos.lx},${_pos.ly}`] || null;
    })();
    const _ctxVisible = (_ctxLoc?._visible_npcs || []);
    context += `\n=== ENTITY ATTRIBUTES (promoted by ContinuityBrain) ===\n`;
    if (_ctxVisible.length === 0) {
      context += `(no visible entities at current position)\n`;
    } else {
      for (const npc of _ctxVisible) {
        const label = (npc.is_learned && npc.npc_name) ? `${npc.npc_name} (${npc.id})` : `${npc.job_category || npc.id}`;
        const attrs = npc.attributes ? Object.values(npc.attributes) : [];
        if (attrs.length === 0) {
          context += `- ${label}: (no promoted facts yet)\n`;
        } else {
          const attrStr = attrs.map(a => `${a.bucket}:${a.value}${a.turn_set != null ? ` (T-${a.turn_set})` : ''}`).join(' | ');
          context += `- ${label}: ${attrStr}\n`;
        }
      }
    }
    if (_ctxLoc?.attributes && Object.keys(_ctxLoc.attributes).length > 0) {
      const _pos = gameState.world.position;
      const locLabel = _ctxLoc.name || (_pos ? `cell(${_pos.mx},${_pos.my}:${_pos.lx},${_pos.ly})` : 'location');
      const locAttrs = Object.values(_ctxLoc.attributes).map(a => `${a.bucket ? a.bucket + ':' : ''}${a.value}${a.turn_set != null ? ` (T-${a.turn_set})` : ''}`).join(' | ');
      context += `[${locLabel}]: ${locAttrs}\n`;
    }

    // === RECENT PROMOTIONS (last 10 entries from world.promotion_log) ===
    const _ctxPromoLog = (gameState.world.promotion_log || []).slice(-10);
    context += `\n=== RECENT PROMOTIONS (last ${_ctxPromoLog.length}) ===\n`;
    if (_ctxPromoLog.length === 0) {
      context += `(no promotions yet)\n`;
    } else {
      for (const e of _ctxPromoLog) {
        if (e.action === 'create') {
          context += `[T-${e.turn}] ${e.entity_type}:${e.entity_name || e.entity_id} → ${e.attribute} = "${e.new_value}"\n`;
        } else if (e.action === 'rejected_filter') {
          context += `[T-${e.turn}] FILTERED ${e.entity_id} ${e.bucket}:"${e.value}" (${e.reason})\n`;
        } else if (e.action === 'duplicate_silenced_summary') {
          const _bkts = Object.entries(e.count_by_bucket || {}).map(([b, c]) => `${b}:${c}`).join(', ');
          context += `[T-${e.turn}] DUP-SILENCED ${e.entity_type}:${e.entity_name || e.entity_id} total:${e.total} (${_bkts})\n`;
        }
      }
    }

    // === MOOD TRAJECTORY (last 3 entries from world.mood_history) ===
    const _ctxMoods = (gameState.world.mood_history || []).slice(-3);
    context += `\n=== MOOD TRAJECTORY (last ${_ctxMoods.length}) ===\n`;
    if (_ctxMoods.length === 0) {
      context += `(no mood data yet)\n`;
    } else {
      for (const m of _ctxMoods) {
        context += `[T-${m.turn}] tone:${m.tone || '—'} tension:${m.tension_level || '—'}(${m.tension_direction || '—'}) focus:${m.scene_focus || '—'} → ${m.delta_note || '—'}\n`;
      }
    }

    // === LAST NARRATIONS (last 5 turns — labeled for Mother Brain citation) ===
    const _ctxNarrations = (gameState.turn_history || []).slice(-5);
    context += `\n=== LAST NARRATIONS ===\n`;
    if (_ctxNarrations.length === 0) {
      context += `(no narrations yet)\n`;
    } else {
      for (const _nt of _ctxNarrations) {
        const _nText  = (_nt.narrative || '').slice(0, 3000);
        const _nExtra = (_nt.narrative || '').length > 3000 ? '…' : '';
        context += `Narrator output (T-${_nt.turn_number}): ${_nText}${_nExtra}\n`;
      }
    }

    // === CB EXTRACTION (last turn) — compact summary for Mother Brain ===
    const _cbLastTurnNd = (gameState.turn_history || []).slice(-1)[0]?.narration_debug || {};
    const _cbExtract    = _cbLastTurnNd.extraction_packet || null;
    const _cbDiag       = _cbLastTurnNd.continuity_diagnostics || null;
    context += `\n=== CB EXTRACTION (last turn) ===\n`;
    if (!_cbExtract) {
      context += `(no extraction data yet)\n`;
    } else {
      const _cbCandidates = _cbExtract.entity_candidates || [];
      const _cbEnv        = _cbExtract.environmental_features || [];
      const _cbSpatial    = _cbExtract.spatial_relations || [];
      const _cbTopReject  = _cbExtract.rejected_interpretations || [];
      const _cbEnvCount   = _cbEnv.reduce((s, b) => s + (b.features || []).length, 0);
      context += `candidates:${_cbCandidates.length}  env_features:${_cbEnvCount}  spatial:${_cbSpatial.length}  top_rejected:${_cbTopReject.length}\n`;
      for (const _cand of _cbCandidates) {
        const _ref  = _cand.entity_ref || '?';
        const _pa   = (_cand.physical_attributes || []).join(', ') || '—';
        const _os   = (_cand.observable_states   || []).join(', ') || '—';
        const _held = (_cand.held_objects        || []).join(', ') || '—';
        const _worn = (_cand.worn_objects        || []).join(', ') || '—';
        const _rejList = (_cand.rejected_interpretations || []).slice(0, 3);
        context += `  ${_ref}: phys[${_pa}] state[${_os}] held[${_held}] worn[${_worn}]\n`;
        if (_rejList.length > 0) {
          context += `    rejected: ${_rejList.join(' | ')}\n`;
        }
      }
      if (_cbTopReject.length > 0) {
        context += `  top-reject: ${_cbTopReject.slice(0, 3).join(' | ')}\n`;
      }
      if (_cbSpatial.length > 0) {
        context += `  spatial: ${_cbSpatial.slice(0, 3).join(' | ')}\n`;
      }
    }

    // === CB WARNINGS (last turn) — entity resolution failures ===
    const _cbWarnings = _cbDiag?.warnings || [];
    context += `\n=== CB WARNINGS (last turn) ===\n`;
    if (_cbWarnings.length === 0) {
      context += `(none)\n`;
    } else {
      for (const _w of _cbWarnings) {
        if (_w.type === 'unresolved_entity_ref') {
          context += `UNRESOLVED: "${_w.entity_ref}" — no visible NPC matched, fact NOT promoted\n`;
        } else if (_w.type === 'fuzzy_entity_ref') {
          context += `FUZZY: "${_w.entity_ref}" → resolved to "${_w.resolved_to}" via fuzzy match — verify correctness\n`;
        } else if (_w.type === 'l0_entity_candidates_skipped') {
          context += `L0-SKIP: ${_w.count} entity candidate(s) skipped — no NPC registry at overworld (L0). Entities: ${(_w.entities || []).join(', ')}\n`;
        } else {
          context += `${_w.type}: ${JSON.stringify(_w)}\n`;
        }
      }
    }
  }

  // === TSL SEMANTIC LAYER (last turn) — Stage 1 observe-only ===
  {
    const _tslOr  = (gameState.turn_history || []).slice(-1)[0]?.object_reality ?? null;
    const _tslData = _tslOr?.tsl ?? null;
    if (_tslData) {
      const _tslMs   = _tslOr?.tsl_ms ?? null;
      const _aliases = Array.isArray(_tslData.alias_candidates)    ? _tslData.alias_candidates    : [];
      const _acqs    = Array.isArray(_tslData.acquisition_signals)  ? _tslData.acquisition_signals  : [];
      const _xfers   = Array.isArray(_tslData.transfer_signals)     ? _tslData.transfer_signals     : [];
      const _warns   = Array.isArray(_tslData.warnings)             ? _tslData.warnings             : [];
      context += `\n=== TSL SEMANTIC LAYER (last turn, observe-only) ===\n`;
      if (_tslMs != null) context += `processing: ${_tslMs}ms\n`;
      if (_aliases.length === 0) {
        context += `aliases: (none)\n`;
      } else {
        for (const a of _aliases) {
          const amb = a.unresolved_ambiguity ? ` [!${a.unresolved_ambiguity}]` : '';
          context += `  alias: "${a.raw_name}" → ${a.resolved_object_id} ("${a.resolved_name}") via ${a.match_method} conf:${(a.confidence||0).toFixed(2)}${amb}\n`;
        }
      }
      if (_acqs.length > 0) {
        for (const q of _acqs) {
          const amb = q.unresolved_ambiguity ? ` [!${q.unresolved_ambiguity}]` : '';
          context += `  acq: "${q.object_name}" actor:${q.actor} conf:${(q.confidence||0).toFixed(2)} signals:[${(q.source_signals||[]).join(',')}]${amb}\n`;
        }
      }
      if (_xfers.length > 0) {
        for (const x of _xfers) {
          const amb = x.unresolved_ambiguity ? ` [!${x.unresolved_ambiguity}]` : '';
          context += `  xfer: "${x.object_name}" ${x.from_actor}→${x.to_actor} conf:${(x.confidence||0).toFixed(2)} signals:[${(x.source_signals||[]).join(',')}]${amb}\n`;
        }
      }
      if (_warns.length > 0) {
        for (const w of _warns) context += `  warn: ${w.type} — ${w.detail}\n`;
      }
    }
  }

  // === FULL LEVEL ===
  if (debugLevel === "full") {
    context += `\n=== WORLD STATE (Entries Summary) ===\n`;
    context += `Total Cells: ${Object.keys(gameState.world.cells || {}).length}\n`;
    context += `Total Sites: ${Object.keys(gameState.world.sites || {}).length}\n`;
    context += `Total NPCs: ${(gameState.world.npcs || []).length}\n`;
    context += `Total Quests: ${(gameState.quests?.active || []).length} active\n`;
    
    // Sample minimal JSON for full level
    try {
      const sample = {
        player: { 
          mx: gameState.player?.mx, 
          my: gameState.player?.my,
          inventory_count: (gameState.player?.inventory || []).length
        },
        world_position: pos,
        current_cell: currentCell ? { type: currentCell.type, subtype: currentCell.subtype } : null,
        sites_count: Object.keys(gameState.world.sites || {}).length,
        npcs_count: (gameState.world.npcs || []).length,
        turn_counter: gameState.turn_counter,
        world_seed: gameState.world.seed || gameState.rng_seed
      };
      context += `\nMinimal JSON snapshot:\n${JSON.stringify(sample, null, 2)}\n`;
    } catch (e) {
      context += `(Could not create JSON snapshot)\n`;
    }
  }

  // === CONTINUITY PACKET (exact text sent to narrator, last 3 turns newest-first) ===
  if (_continuityBlockHistory.length > 0) {
    for (let _ci = _continuityBlockHistory.length - 1; _ci >= 0; _ci--) {
      const _ch = _continuityBlockHistory[_ci];
      context += `\n=== CONTINUITY PACKET (T-${_ch.turn}) ===\n`;
      context += _ch.block + '\n';
    }
  }

  // === NARRATOR PROMPT STRUCTURE (last turn) ===
  if (_lastNarratorPromptStats) {
    const s = _lastNarratorPromptStats;
    context += `\n=== NARRATOR PROMPT STRUCTURE (last turn) ===\n`;
    // Always-on one-liner summary
    context += `payload_messages: 1 | prompt_chars: ${s.total_chars} | continuity: ${s.continuity_chars} | spatial: ${s.spatial_chars} | base: ${s.base_chars}\n`;
    context += `  base (instructions + world state): ${s.base_chars} chars\n`;
    context += `  continuity block: ${s.continuity_chars} chars${s.continuity_injected ? '' : s.continuity_evicted ? ' [EVICTED]' : ' [NOT INJECTED]'}\n`;
    context += `  spatial block: ${s.spatial_chars} chars\n`;
    context += `continuity_injected: ${s.continuity_injected}\n`;
    context += `continuity_evicted: ${s.continuity_evicted}\n`;
    if (s.narrator_usage) {
      const u = s.narrator_usage;
      context += `prompt_tokens: ${u.prompt_tokens ?? '—'}  completion_tokens: ${u.completion_tokens ?? '—'}  total_tokens: ${u.total_tokens ?? '—'}\n`;
    } else {
      context += `prompt_tokens: —  completion_tokens: —  total_tokens: — (no usage data)\n`;
    }
    context += `model: deepseek-chat | max_tokens: not set (model cap: 8,192 output / 64K context window)\n`;
  }

  // === SPATIAL BLOCK (last turn) ===
  {
    const _lastTurnNd = (gameState.turn_history || []).slice(-1)[0]?.narration_debug || {};
    const _spatialBlock = _lastTurnNd.engine_spatial_notes;
    context += `\n=== SPATIAL BLOCK (last turn) ===\n`;
    if (_spatialBlock) {
      context += _spatialBlock + '\n';
    } else {
      context += `(no spatial block for last turn)\n`;
    }
  }

  // === SITE INTERIOR STATE (current cell) ===
  {
    const _pos = gameState.world.position;
    context += `\n=== SITE INTERIOR STATE (current cell) ===\n`;
    if (!_pos) {
      context += `(no position)\n`;
    } else {
      const _cellKey = `LOC:${_pos.mx},${_pos.my}:${_pos.lx},${_pos.ly}`;
      const _cell = gameState.world.cells?.[_cellKey];
      // cell.sites is an object dictionary keyed by site_id — not an array.
      // If it is unexpectedly an array, surface the shape error; do not normalize silently.
      if (Array.isArray(_cell?.sites)) {
        context += `(WARNING: cell.sites unexpected shape — expected object dict, got array)\n`;
      } else {
        const _cellSiteObjs = Object.values(_cell?.sites || {});
        if (_cellSiteObjs.length === 0) {
          context += `(no sites at current cell)\n`;
        } else {
          for (const _s of _cellSiteObjs) {
            const _sid       = _s.site_id || '(unknown_id)';
            const _sName     = _s.name || '(unnamed)';
            const _sIdentity = _s.identity !== null && _s.identity !== undefined ? _s.identity : '(null)';
            const _enterable = _s.enterable === false ? 'NO' : 'YES';
            const _filled    = _s.is_filled ? 'YES' : 'NO';
            const _interior  = _getSiteInteriorState(_s, gameState.world.sites);
            context += `${_sid} | ${_sName} | slot_identity:${_sIdentity} | enterable:${_enterable} | filled:${_filled} | interior:${_interior}\n`;
          }
        }
      }
    }
  }

  // === WORLD SITES SUMMARY (loaded cells only) ===
  {
    const _wsPos   = gameState.world.position;
    const _wsW     = gameState.world.l0_grid?.width  || 8;
    const _wsH     = gameState.world.l0_grid?.height || 8;
    context += `\n=== WORLD SITES SUMMARY (loaded cells only) ===\n`;
    context += `Note: reflects sites in currently generated/visited cells only — unvisited areas may have undiscovered sites.\n`;

    // Collect all filled site slots across all loaded cells
    const _wsSites = [];
    for (const _wsCell of Object.values(gameState.world.cells || {})) {
      if (!_wsCell || Array.isArray(_wsCell.sites)) continue;
      for (const _wsSite of Object.values(_wsCell.sites || {})) {
        if (!_wsSite || !_wsSite.is_filled) continue;
        _wsSites.push({
          site_id:  _wsSite.site_id  || '(unknown)',
          name:     _wsSite.name     || '(unnamed)',
          mx: _wsCell.mx, my: _wsCell.my,
          lx: _wsCell.lx, ly: _wsCell.ly,
          enterable: _wsSite.enterable !== false,
          interior: _getSiteInteriorState(_wsSite, gameState.world.sites)
        });
      }
    }

    if (_wsSites.length === 0) {
      context += `(no filled sites in any loaded cell — unvisited areas may have undiscovered sites)\n`;
    } else {
      context += `total_filled_sites: ${_wsSites.length}\n`;

      // by_macro_cell — cap at 20
      const _wsMacroMap = {};
      for (const _ws of _wsSites) {
        const _mk = `(${_ws.mx},${_ws.my})`;
        _wsMacroMap[_mk] = (_wsMacroMap[_mk] || 0) + 1;
      }
      const _wsMacroEntries = Object.entries(_wsMacroMap).sort(([a],[b]) => a.localeCompare(b));
      const _playerMacroKey = _wsPos ? `(${_wsPos.mx},${_wsPos.my})` : null;
      context += `by_macro_cell (loaded):\n`;
      if (_playerMacroKey && !_wsMacroMap[_playerMacroKey]) {
        context += `  player ${_playerMacroKey}: 0 sites\n`;
      }
      let _wsMacroShown = 0;
      for (const [_mk, _cnt] of _wsMacroEntries) {
        if (_wsMacroShown >= 20) { context += `  ...${_wsMacroEntries.length - 20} more macro cells not shown\n`; break; }
        const _label = (_playerMacroKey && _mk === _playerMacroKey) ? `player ${_mk}` : _mk;
        context += `  ${_label}: ${_cnt} site${_cnt !== 1 ? 's' : ''}\n`;
        _wsMacroShown++;
      }

      // nearest_filled_sites — top 3 by toroidal Manhattan distance
      if (_wsPos) {
        const _wsDist = (s) => {
          const dMx = ((s.mx - _wsPos.mx + Math.floor(_wsW/2)) % _wsW + _wsW) % _wsW - Math.floor(_wsW/2);
          const dMy = ((s.my - _wsPos.my + Math.floor(_wsH/2)) % _wsH + _wsH) % _wsH - Math.floor(_wsH/2);
          return Math.abs(dMx * 128 + (s.lx - _wsPos.lx)) + Math.abs(dMy * 128 + (s.ly - _wsPos.ly));
        };
        const _wsNearest = _wsSites.slice().sort((a,b) => _wsDist(a) - _wsDist(b)).slice(0, 3);
        context += `nearest_filled_sites (loaded):\n`;
        for (const _ws of _wsNearest) {
          context += `  ${_ws.site_id} | ${_ws.name} | cell(${_ws.mx},${_ws.my}:${_ws.lx},${_ws.ly}) | ~${_wsDist(_ws)} cells away | enterable:${_ws.enterable ? 'YES' : 'NO'}\n`;
        }
      }
      context += `Use get_sites(radius=N) for filtered queries. Unvisited areas may have undiscovered sites.\n`;
    }
  }

  // === WORLD MAP 5x5 (player-centered, toroidal) ===
  {
    const _wPos = gameState.world.position;
    const _macroW = gameState.world.l0_grid?.width  || 8;
    const _macroH = gameState.world.l0_grid?.height || 8;
    context += `\n=== WORLD MAP 5x5 (player macro-cell, radius 2) ===\n`;
    if (!_wPos) {
      context += `(no position)\n`;
    } else {
      const _pMx = _wPos.mx;
      const _pMy = _wPos.my;
      const _appearingCodes = new Set();
      const _gridRows = [];
      for (let dy = -2; dy <= 2; dy++) {
        const row = [];
        for (let dx = -2; dx <= 2; dx++) {
          // Toroidal wrap on macro grid
          const _mx = ((_pMx + dx) % _macroW + _macroW) % _macroW;
          const _my = ((_pMy + dy) % _macroH + _macroH) % _macroH;
          const _isPlayer = (dx === 0 && dy === 0);
          // Find dominant terrain for this macro cell
          const _macroCells = Object.values(gameState.world.cells || {}).filter(c => c && c.mx === _mx && c.my === _my);
          let _code = '??';
          if (_macroCells.length > 0) {
            const _freq = {};
            for (const _c of _macroCells) { const _t = _c.type || ''; _freq[_t] = (_freq[_t] || 0) + 1; }
            const _dom = Object.entries(_freq).sort(([,a],[,b]) => b - a)[0][0];
            _code = _TERRAIN_CODES[_dom] || '??';
          }
          // Check if cell has any enterable site
          const _hasSite = Object.values(gameState.world.sites || {}).some(s => s && s.mx === _mx && s.my === _my && s.enterable !== false && !s.is_stub);
          const _isUnknown = (_macroCells.length === 0);
          let _label;
          if (_isPlayer)   { _label = '[*]'; }
          else if (_hasSite) { _label = '[S]'; _appearingCodes.add(`S=site`); }
          else if (_isUnknown) { _label = '[ ]'; }
          else { _label = `[${_code}]`; _appearingCodes.add(`${_code}=${Object.entries(_TERRAIN_CODES).find(([k,v])=>v===_code)?.[0]||_code}`); }
          row.push(_label);
        }
        _gridRows.push(row.join(' '));
      }
      context += _gridRows.join('\n') + '\n';
      if (_appearingCodes.size > 0) {
        context += `legend: [*]=player  ` + [..._appearingCodes].join('  ') + '\n';
      }
    }
  }

  // === ACTION RESOLUTION (last turn) ===
  {
    const _lastTurn = (gameState.turn_history || []).slice(-1)[0];
    context += `\n=== ACTION RESOLUTION (last turn) ===\n`;
    if (!_lastTurn) {
      context += `(no turns yet)\n`;
    } else {
      const _mv = _lastTurn.movement;
      const _act = _lastTurn.action;
      context += `input: "${String(_lastTurn.raw_input || _act || '—').slice(0, 80)}"\n`;
      context += `parsed_action: ${_lastTurn.parsed_action || '—'}\n`;
      if (_mv) {
        if (_mv.success) {
          context += `move: SUCCESS  direction:${_mv.direction || '—'}  from:${JSON.stringify(_mv.from || {})}  to:${JSON.stringify(_mv.to || {})}\n`;
          if (_mv.from_cell_type || _mv.to_cell_type) {
            context += `cell_types: ${_mv.from_cell_type || '—'} -> ${_mv.to_cell_type || '—'}\n`;
          }
        } else {
          context += `move: BLOCKED  block_reason:${_mv.block_reason || '?'}  direction:${_mv.direction || '—'}\n`;
        }
      } else if (_lastTurn.parsed_action === 'move') {
        context += `move: NO_RESOLVE_LOG (player_move_resolved was never called)\n`;
      } else {
        context += `(no move this turn)\n`;
      }
    }
  }

  // === REALITY CHECK (last turn) — narrator input mirror ===
  {
    const _rcLastTurn = (gameState.turn_history || []).slice(-1)[0];
    const _rc = _rcLastTurn?.reality_check || null;
    const _st = _rcLastTurn?.stage_times || null;
    context += `\n=== REALITY CHECK (last turn) ===\n`;
    if (!_rc) {
      context += `(no RC data yet)\n`;
    } else if (!_rc.fired) {
      context += `fired: false\n`;
      context += `skipped_reason: ${_rc.skipped_reason || '(none)'}\n`;
    } else {
      context += `fired: true\n`;
      context += `query: "${String(_rc.query || '').slice(0, 120)}"\n`;
      context += `\nraw_response (verbatim DS):\n${_rc.raw_response || '(none)'}\n`;
      context += `\nanchor_block (injected into narrator):\n${_rc.anchor_block || '(none)'}\n`;
      if (_st) {
        const _rcDur  = (_st.rc_end  && _st.rc_start)       ? `${_st.rc_end  - _st.rc_start}ms`       : '—';
        const _narDur = (_st.narrator_end && _st.narrator_start) ? `${_st.narrator_end - _st.narrator_start}ms` : '—';
        const _order  = (_st.rc_end && _st.narrator_start)
          ? (_st.rc_end <= _st.narrator_start ? 'YES -- rc_end <= narrator_start' : 'NO -- rc_end > narrator_start')
          : '(n/a)';
        context += `\nstage_times: rc:${_rcDur}  narrator:${_narDur}  order_confirmed:${_order}\n`;
      }
    }
  }

  // === NARRATOR I/O (last turn) — gated: only with level=narrator_io ===
  if (debugLevel === 'narrator_io') {
    context += `\n=== NARRATOR I/O (last turn) ===\n`;
    context += `-- MESSAGES PAYLOAD --\n`;
    if (_lastNarratorPayload?.messages?.[0]) {
      context += `[message 0] role: ${_lastNarratorPayload.messages[0].role}\n`;
      context += _lastNarratorPayload.messages[0].content + '\n';
    } else {
      context += `(no payload captured yet)\n`;
    }
    context += `\n-- RAW RESPONSE --\n`;
    if (_lastNarratorRawResponse) {
      context += _lastNarratorRawResponse + '\n';
    } else {
      context += `(no response captured yet)\n`;
    }
  }

  return context;
}

// =============================================================================
// SSE INFRASTRUCTURE
// =============================================================================
const _sseClients = new Set();
let _lastDiagnosticPayload = null; // replayed to new connections so they show current state immediately

function emitDiagnostics(payload) {
  let data;
  try {
    data = `data: ${JSON.stringify(payload)}\n\n`;
  } catch (err) {
    console.error('[EMIT_DIAG] JSON.stringify failed:', err.message);
    return;
  }
  _lastDiagnosticPayload = payload; // cache for replay on reconnect
  console.log(`[EMIT_DIAG] turn=${payload.turn} clients=${_sseClients.size}`);
  for (const client of _sseClients) {
    if (client.writableEnded || client.destroyed) {
      _sseClients.delete(client);
      continue;
    }
    try {
      client.write(data);
      if (client.socket) client.socket.uncork();
    } catch (err) {
      console.error('[EMIT_DIAG] write failed:', err.message);
      _sseClients.delete(client);
    }
  }
}

// Handler for app.get('/diagnostics/stream', diag.registerStreamHandler)
function registerStreamHandler(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();
  req.socket.setTimeout(0);
  req.socket.setNoDelay(true); // disable Nagle — flush every write immediately
  res.write('data: {"type":"connected"}\n\n');
  // Replay last turn immediately so reconnects don't show stale data
  if (_lastDiagnosticPayload) {
    try { res.write(`data: ${JSON.stringify(_lastDiagnosticPayload)}\n\n`); } catch (_) {}
  }
  _sseClients.add(res);
  const keepalive = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      clearInterval(keepalive);
      _sseClients.delete(res);
      return;
    }
    try { res.write(': keepalive\n\n'); } catch (_) {
      clearInterval(keepalive);
      _sseClients.delete(res);
    }
  }, 15000);
  req.on('close', () => {
    clearInterval(keepalive);
    _sseClients.delete(res);
  });
}

// =============================================================================
// DIAG HISTORY STATE (Cluster 3)
// Rolling per-turn cost/token history — max 200 entries, written each turn.
// =============================================================================
let _diagHistory = [];

function pushDiagHistory(entry) {
  _diagHistory.push(entry);
  if (_diagHistory.length > 200) _diagHistory.shift();
}

function getDiagHistory() {
  return _diagHistory;
}

// =============================================================================
// LAST GAME STATE CACHE (Cluster 5)
// Live references written by index.js turn handler; read by Cluster 5–7 routes.
// Reference semantics preserved intentionally — no clone, no serialize.
// _lastWatchMessage is write-only / reserved for future diagnostics surface.
// =============================================================================
let _lastGameState     = null; // most-recent gameState — live reference, not snapshot
let _lastRenderedBlock = null; // exact continuity text injected into narrator each turn
let _lastSessionId     = null; // most-recent resolved session ID (used by /diagnostics/session)
let _lastWatchMessage  = null; // Mother's last watch_message — write-only / reserved for future diagnostics surface

function setLastGameState(gs)        { _lastGameState    = gs; }
function setLastRenderedBlock(block) { _lastRenderedBlock = block; }
function setLastSessionId(id)        { _lastSessionId    = id; }
function setLastWatchMessage(msg)    { _lastWatchMessage  = msg; }  // write-only — no route reads this yet
function getLastGameState()          { return _lastGameState; }
function getLastSessionId()          { return _lastSessionId; }

// =============================================================================
// SOURCE ALLOWLIST (Cluster 2)
// =============================================================================
const _SOURCE_ALLOWLIST = new Set([
  'index.js', 'Engine.js', 'ActionProcessor.js', 'NPCs.js', 'WorldGen.js',
  'NarrativeContinuity.js', 'ContinuityBrain.js', 'SemanticParser.js',
  'continuity.js', 'QuestSystem.js', 'logger.js', 'logging.js',
  'flight-recorder.js', 'motherbrain.js', 'conditionbot.js', 'ObjectHelper.js',  // v1.84.54
  'cbpanel.js', 'npcpanel.js', 'sitelens.js', 'motherwatch.js',              // v1.85.1
  'summary.js', 'dmletter.js', 'Index.html', 'Map.html',                     // v1.85.1
  'test-harness.js',                                                           // v1.85.53
  'scripts/probe-runner.js', 'scripts/probe-metrics.js',                      // v1.85.75
  'diagnostics.js'                                                             // v1.88.56
]);
// Allow any file in the Set OR any scenario JSON: tests/scenarios/<name>.json
// OR any probe spec: tests/probes/<name>.probe.json
function _isSourceAllowed(file) {
  if (_SOURCE_ALLOWLIST.has(file)) return true;
  if (/^tests\/scenarios\/[a-z0-9_-]+\.json$/i.test(file)) return true;
  if (/^tests\/probes\/[a-z0-9_-]+\.probe\.json$/i.test(file)) return true;
  return false;
}

// =============================================================================
// ROUTE REGISTRATION
// Called once at startup: diag.registerRoutes(app, opts)
// opts accepted keys (interface frozen after Cluster 7):
//   getSessionStates {Function} — () => sessionStates Map (required for Cluster 4+)
// Cluster 5–7 routes read module-private state directly (_lastGameState, _lastSessionId etc.).
//   No new opts keys added in Clusters 5–7.
// =============================================================================
function registerRoutes(app, opts = {}) {
  // --- Cluster 1: crash reporter -------------------------------------------
  // Mother Brain crash reporter — logs crash to server console
  app.post('/diagnostics/mb-crash', (req, res) => {
    const diagKey = process.env.DIAGNOSTICS_KEY;
    if (!diagKey) return res.status(503).json({ error: 'diagnostics_disabled' });
    if (req.headers['x-diagnostics-key'] !== diagKey) return res.status(403).json({ error: 'forbidden' });
    const { type, message, where, stack, mb_version, session, last_turn } = req.body || {};
    console.error(`\n[MOTHER BRAIN CRASHED] ${type} -- v${mb_version} -- session=${session} turn=${last_turn}`);
    console.error(`[MOTHER BRAIN CRASHED] ${message}`);
    if (stack) {
      const appLines = stack.split('\n')
        .filter(l => l.includes('    at ') && l.includes('Game-main') && !l.includes('node_modules'));
      const printLines = appLines.length ? appLines : stack.split('\n').slice(0, 8);
      printLines.forEach(l => console.error(`[MOTHER BRAIN CRASHED]   ${l.trim()}`));
    }
    res.json({ logged: true });
  });

  // --- Cluster 3: session summary ------------------------------------------
  // On-demand session summary — GET /diagnostics/summary
  // Returns aggregate stats over _diagHistory (since last server restart).
  app.get('/diagnostics/summary', (req, res) => {
    const valid        = _diagHistory.filter(e => e.system_total != null);
    const turns        = _diagHistory.length;
    const avgSystem    = valid.length ? Math.round(valid.reduce((s, e) => s + e.system_total, 0) / valid.length) : null;
    const avgNarrator  = valid.length ? Math.round(valid.reduce((s, e) => s + (e.narrator_total || 0), 0) / valid.length) : null;
    const avgParser    = valid.length ? Math.round(valid.reduce((s, e) => s + (e.parser_total  || 0), 0) / valid.length) : null;
    const totalSpent   = valid.reduce((s, e) => s + e.system_total, 0);
    const peakEntry    = valid.reduce((m, e) => (e.system_total > (m?.system_total || 0) ? e : m), null);
    const cachedTurns  = _diagHistory.filter(e => e.parser_cached).length;
    const violationCounts = {};
    _diagHistory.forEach(e => (e.violations || []).forEach(v => { violationCounts[v] = (violationCounts[v] || 0) + 1; }));
    res.json({
      turns,
      avg_system:        avgSystem,
      avg_narrator:      avgNarrator,
      avg_parser:        avgParser,
      total_spent:       totalSpent,
      peak_entry:        peakEntry,
      cached_turns:      cachedTurns,
      cont_chars_first:  _diagHistory[0]?.cont_chars ?? null,
      cont_chars_last:   _diagHistory[_diagHistory.length - 1]?.cont_chars ?? null,
      violation_counts:  violationCounts
    });
  });

  // --- Cluster 2: source reader + source search ---------------------------
  // Params: ?file= (required, filename only), ?from= (1-based line, default 1), ?to= (default from+199, hard cap from+299)
  app.get('/diagnostics/source', (req, res) => {
    const diagKey = process.env.DIAGNOSTICS_KEY;
    if (!diagKey) {
      return res.status(503).json({ error: 'source_access_disabled', message: 'DIAGNOSTICS_KEY env var is not set.' });
    }
    if (req.headers['x-diagnostics-key'] !== diagKey) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const file = req.query.file;
    if (!file || path.isAbsolute(file) || file.includes('\\') || file.includes('..')) {
      return res.status(400).json({ error: 'invalid_file', message: 'file param must be a relative path with no backslashes, drive letters, or ..' });
    }
    if (!_isSourceAllowed(file)) {
      return res.status(403).json({ error: 'not_allowed', message: `${file} is not in the source allowlist.` });
    }
    const fromLine = Math.max(1, parseInt(req.query.from, 10) || 1);
    const maxTo    = fromLine + 299;
    const toLine   = Math.min(maxTo, Math.max(fromLine, parseInt(req.query.to, 10) || (fromLine + 199)));
    try {
      const filePath  = path.join(__dirname, file);
      if (!filePath.startsWith(path.resolve(__dirname) + path.sep)) {
        return res.status(403).json({ error: 'path_escape', message: 'Resolved path is outside the project directory.' });
      }
      const allLines  = fs.readFileSync(filePath, 'utf8').split('\n');
      const total     = allLines.length;
      const sliceFrom = Math.min(fromLine, total);
      const sliceTo   = Math.min(toLine, total);
      const lines     = allLines.slice(sliceFrom - 1, sliceTo).join('\n');
      return res.json({ file, from: sliceFrom, to: sliceTo, total_lines: total, lines });
    } catch (err) {
      return res.status(500).json({ error: 'read_failed', message: err.message });
    }
  });

  // Source search — GET /diagnostics/source-search
  // Used by Mother Brain search_source tool for code discovery before get_source_slice verification.
  // Auth: same DIAGNOSTICS_KEY pattern as /diagnostics/source.
  // Params: ?query= (required, min 3 chars, literal string), ?file= (optional, scope to one file)
  app.get('/diagnostics/source-search', (req, res) => {
    const diagKey = process.env.DIAGNOSTICS_KEY;
    if (!diagKey) {
      return res.status(503).json({ error: 'source_search_disabled', message: 'DIAGNOSTICS_KEY env var is not set.' });
    }
    if (req.headers['x-diagnostics-key'] !== diagKey) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const query = req.query.query;
    if (!query || query.length < 3) {
      return res.status(400).json({ error: 'invalid_query_too_short', message: 'query must be at least 3 characters.' });
    }
    const fileParam = req.query.file;
    if (fileParam) {
      if (!fileParam || path.isAbsolute(fileParam) || fileParam.includes('\\') || fileParam.includes('..')) {
        return res.status(400).json({ error: 'invalid_file', message: 'file param must be a relative path with no backslashes, drive letters, or ..' });
      }
      if (!_isSourceAllowed(fileParam)) {
        return res.status(403).json({ error: 'not_allowed', message: `${fileParam} is not in the source allowlist.` });
      }
    }
    const filesToSearch = fileParam ? [fileParam] : (() => {
      const list = [..._SOURCE_ALLOWLIST];
      // Also enumerate tests/scenarios/*.json and tests/probes/*.probe.json for global sweeps
      for (const dir of ['tests/scenarios', 'tests/probes']) {
        try {
          const dirPath = path.join(__dirname, dir);
          for (const f of fs.readdirSync(dirPath)) {
            if (/^[a-z0-9_-]+\.(?:probe\.)?json$/i.test(f)) {
              list.push(`${dir}/${f}`);
            }
          }
        } catch (_e) { /* dir may not exist */ }
      }
      return list;
    })();
    const fileScope     = fileParam || 'all';
    const results       = [];
    const MAX_RESULTS   = 20;
    outer: for (const fname of filesToSearch) {
      try {
        const fPath    = path.join(__dirname, fname);
        const allLines = fs.readFileSync(fPath, 'utf8').split('\n');
        for (let i = 0; i < allLines.length; i++) {
          if (allLines[i].includes(query)) {
            results.push({
              file:           fname,
              line_number:    i + 1,
              line:           allLines[i].trim(),
              context_before: i > 0 ? allLines[i - 1].trim() : null,
              context_after:  i < allLines.length - 1 ? allLines[i + 1].trim() : null
            });
            if (results.length >= MAX_RESULTS) break outer;
          }
        }
      } catch (_e) {
        // skip unreadable files silently
      }
    }
    console.log('[search_source]', JSON.stringify(query), fileScope, results.length);
    return res.json({
      query,
      file_scope:             fileScope,
      total_matches_returned: results.length,
      capped:                 results.length >= MAX_RESULTS,
      results
    });
  });

  // --- Cluster 4: session-scoped turn/payload/object routes ----------------
  // All routes in this cluster read live session state via opts.getSessionStates().

  // Turn archive — GET /diagnostics/turn/:sessionId/:turn
  app.get('/diagnostics/turn/:sessionId/:turn', async (req, res) => {
    const { sessionId, turn } = req.params;
    const turnNum = parseInt(turn, 10);
    if (!sessionId || isNaN(turnNum)) {
      return res.status(400).json({ error: 'sessionId and numeric turn are required' });
    }
    const session = opts.getSessionStates().get(sessionId);
    const history = session?.gameState?.turn_history || [];
    let turnObj = history.find(t => t.turn_number === turnNum);
    if (!turnObj) {
      turnObj = await _readTurnFromDisk(sessionId, turnNum);
    }
    if (!turnObj) {
      if (!session) {
        return res.status(404).json({ error: 'session_not_found' });
      }
      return res.status(404).json({ error: 'turn_not_found', turn: turnNum, total_turns: history.length });
    }
    const fieldsParam = req.query.fields;
    if (!fieldsParam) {
      return res.json(turnObj);
    }
    const FIELD_MAP = {
      narrative:           'narrative',
      extraction_packet:   'narration_debug.extraction_packet',
      continuity_snapshot: 'narration_debug.continuity_snapshot',
      authoritative_state: 'authoritative_state',
      input:               'input',
      stage_times:         'stage_times',
      reality_check:       'reality_check',
      narration_debug:     'narration_debug',
      logs:                'logs',
      object_reality:      'object_reality',
      arbiter_verdict:     'arbiter_verdict'
    };
    const requested = fieldsParam.split(',').map(f => f.trim()).filter(Boolean);
    const result = { turn_number: turnObj.turn_number, timestamp: turnObj.timestamp };
    for (const field of requested) {
      if (field in FIELD_MAP) {
        const key = FIELD_MAP[field];
        if (key.includes('.')) {
          const [top, sub] = key.split('.');
          result[field] = turnObj[top]?.[sub] ?? null;
        } else {
          result[field] = turnObj[key] ?? null;
        }
      }
    }
    return res.json(result);
  });

  // Latest turn — GET /diagnostics/turn/latest?sessionId=X
  app.get('/diagnostics/turn/latest', async (req, res) => {
    const { sessionId } = req.query;
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId query param is required' });
    }
    const session = opts.getSessionStates().get(sessionId);
    const history = session?.gameState?.turn_history || [];
    let latest = history.length > 0
      ? history.slice().sort((a, b) => (b.turn_number || 0) - (a.turn_number || 0))[0]
      : null;
    if (!latest) {
      latest = await _readTurnFromDisk(sessionId, null);
    }
    if (!latest) {
      if (!session) {
        return res.status(404).json({ error: 'session_not_found' });
      }
      return res.status(404).json({ error: 'no_turns' });
    }
    return res.json(latest);
  });

  // Payload archive — GET /diagnostics/payload/:sessionId/:turn
  app.get('/diagnostics/payload/:sessionId/:turn', (req, res) => {
    const { sessionId, turn } = req.params;
    const turnNum = parseInt(turn, 10);
    if (!sessionId || isNaN(turnNum)) {
      return res.status(400).json({ error: 'sessionId and numeric turn are required' });
    }
    const session = opts.getSessionStates().get(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'session_not_found' });
    }
    const archive = session.gameState?.payload_archive || {};
    const entry = archive[turnNum];
    if (!entry) {
      return res.status(404).json({ error: 'payload_not_found', turn: turnNum });
    }
    const stage = req.query.stage;
    const part  = req.query.part;
    if (!stage) {
      return res.json(entry);
    }
    const VALID_STAGES = ['reality_check', 'narrator', 'continuity_brain', 'condition_bot'];
    if (!VALID_STAGES.includes(stage)) {
      return res.status(400).json({ error: 'invalid_stage', valid: VALID_STAGES });
    }
    const stageData = entry.pipeline?.[stage] ?? null;
    if (!part) {
      return res.json({ turn: turnNum, stage, data: stageData });
    }
    if (part !== 'prompt' && part !== 'response') {
      return res.status(400).json({ error: 'invalid_part', valid: ['prompt', 'response'] });
    }
    return res.json({ turn: turnNum, stage, part, data: stageData?.[part] ?? null });
  });

  // Object registry query — GET /diagnostics/objects
  app.get('/diagnostics/objects', (req, res) => {
    const { sessionId, container_type, container_id, status: statusFilter = 'active', include_events } = req.query;
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
    const session = opts.getSessionStates().get(sessionId);
    if (!session) return res.status(404).json({ error: 'session_not_found' });
    const gs = session.gameState;
    const includeEvents = include_events === 'true';
    const allObjects = (gs.objects && typeof gs.objects === 'object') ? gs.objects : {};
    let filtered = Object.values(allObjects);
    if (statusFilter !== 'all') filtered = filtered.filter(o => (o.status || 'active') === statusFilter);
    if (container_type) filtered = filtered.filter(o => o.current_container_type === container_type);
    if (container_id)   filtered = filtered.filter(o => o.current_container_id   === container_id);
    const by_container = { player: [], npc: {}, cell: {}, localspace: {}, site: {} };
    for (const obj of Object.values(allObjects)) {
      if (statusFilter !== 'all' && (obj.status || 'active') !== statusFilter) continue;
      const ct = obj.current_container_type;
      const ci = obj.current_container_id;
      if (ct === 'player') {
        by_container.player.push(obj.id);
      } else if (ct === 'npc') {
        if (!by_container.npc[ci]) by_container.npc[ci] = [];
        by_container.npc[ci].push(obj.id);
      } else if (ct === 'cell' || ct === 'grid') {
        if (!by_container.cell[ci]) by_container.cell[ci] = [];
        by_container.cell[ci].push(obj.id);
      } else if (ct === 'localspace') {
        if (!by_container.localspace[ci]) by_container.localspace[ci] = [];
        by_container.localspace[ci].push(obj.id);
      } else if (ct === 'site') {
        if (!by_container.site[ci]) by_container.site[ci] = [];
        by_container.site[ci].push(obj.id);
      }
    }
    const result = filtered.map(o => {
      const rec = { id: o.id, name: o.name, description: o.description, status: o.status || 'active',
                    created_turn: o.created_turn, current_container_type: o.current_container_type,
                    current_container_id: o.current_container_id,
                    associated_actor_id: o.associated_actor_id ?? null };  // v1.88.66
      if (includeEvents) rec.events = o.events || [];
      return rec;
    });
    return res.json({
      total: result.length,
      status_filter: statusFilter,
      objects: result,
      by_container,
      object_errors: (gs.object_errors || []).slice(-20)
    });
  });

  // Entity inspector — GET /diagnostics/entity
  app.get('/diagnostics/entity', (req, res) => {
    const { sessionId, entity_type, entity_id } = req.query;
    if (!sessionId)   return res.status(400).json({ error: 'sessionId required' });
    if (!entity_type) return res.status(400).json({ error: 'entity_type required (object/npc/player/cell)' });
    const session = opts.getSessionStates().get(sessionId);
    if (!session) return res.status(404).json({ error: 'session_not_found' });
    const gs = session.gameState;
    if (entity_type === 'object') {
      if (!entity_id) return res.status(400).json({ error: 'entity_id required for entity_type=object' });
      const record = gs.objects?.[entity_id];
      if (!record) return res.status(404).json({ error: 'object_not_found', entity_id });
      return res.json(record);
    }
    if (entity_type === 'player') {
      return res.json(gs.player || {});
    }
    if (entity_type === 'npc') {
      if (!entity_id) return res.status(400).json({ error: 'entity_id required for entity_type=npc' });
      const allNpcs = [
        ...(Array.isArray(gs.world?.npcs) ? gs.world.npcs : []),
        ...(Array.isArray(gs.world?.active_site?.npcs) ? gs.world.active_site.npcs : [])
      ];
      const npc = allNpcs.find(n => (n.npc_id || n.id) === entity_id);
      if (!npc) return res.status(404).json({ error: 'npc_not_found', entity_id });
      return res.json(npc);
    }
    if (entity_type === 'cell') {
      if (!entity_id) return res.status(400).json({ error: 'entity_id required for entity_type=cell' });
      const cell = gs.world?.cells?.[entity_id];
      if (!cell) return res.status(404).json({ error: 'cell_not_found', entity_id });
      return res.json(cell);
    }
    return res.status(400).json({ error: 'invalid_entity_type', valid: ['object', 'npc', 'player', 'cell'] });
  });

  // Object lifecycle trace — GET /diagnostics/objects/trace
  app.get('/diagnostics/objects/trace', (req, res) => {
    const { sessionId, object_id } = req.query;
    if (!sessionId)  return res.status(400).json({ error: 'sessionId required' });
    if (!object_id)  return res.status(400).json({ error: 'object_id required' });
    const session = opts.getSessionStates().get(sessionId);
    if (!session) return res.status(404).json({ error: 'session_not_found' });
    const gs = session.gameState;
    const currentRecord = gs.objects?.[object_id] ?? null;
    const turnHistory   = gs.turn_history || [];
    const turnsWithData = turnHistory.filter(t => t.object_reality && Array.isArray(t.object_reality.audit)).length;
    const timeline = [];
    for (const turn of turnHistory) {
      if (!turn.object_reality?.audit) continue;
      for (const entry of turn.object_reality.audit) {
        if (entry.object_id === object_id) {
          timeline.push({ turn: turn.turn_number, ...entry });
        }
      }
    }
    const errors = (gs.object_errors || []).filter(e => e.object_id === object_id);
    return res.json({
      object_id,
      found_in_registry: !!currentRecord,
      current_record: currentRecord,
      timeline,
      errors,
      turns_with_data: turnsWithData
    });
  });

  // --- Subcluster A: continuity / history / context readers ----------------
  // All routes read module-private _lastGameState (+ _lastRenderedBlock for
  // /diagnostics/continuity). State owned by diagnostics.js from Cluster 5 onward.

  // GET /diagnostics/continuity?turns=N
  app.get('/diagnostics/continuity', (req, res) => {
    if (!_lastGameState || _lastRenderedBlock === null) {
      return res.json({ no_data: true, reason: 'No turns played yet — start the game and take at least one action.' });
    }
    const history   = _lastGameState.turn_history || [];
    const total     = history.length;
    const lastTurn  = history[history.length - 1] || null;
    const lastDebug = lastTurn?.narration_debug || {};

    const w   = _lastGameState.world || {};
    const loc = w.active_local_space || w.active_site || (() => {
      const _p = w.position;
      if (!_p) return null;
      return w.cells?.[`LOC:${_p.mx},${_p.my}:${_p.lx},${_p.ly}`] || null;
    })();
    const visibleNpcs = (loc?._visible_npcs || []);
    const visible_npc_attributes = {};
    for (const npc of visibleNpcs) {
      const label = npc.npc_name ? `${npc.npc_name} (${npc.id})` : `${npc.job_category || 'person'} (${npc.id})`;
      visible_npc_attributes[npc.id] = { label, attributes: npc.attributes || {} };
    }

    const _diagPos = w.position;
    const site_attributes = {
      name: loc?.name || (_diagPos ? `cell(${_diagPos.mx},${_diagPos.my}:${_diagPos.lx},${_diagPos.ly})` : null),
      attributes: loc?.attributes || {}
    };
    const mood_history = w.mood_history || [];
    const promoLog = w.promotion_log || [];
    const promotion_log_recent = promoLog.slice(-20);
    const cb_diagnostics = lastDebug.continuity_diagnostics || null;
    const extraction_packet = lastDebug.extraction_packet || null;

    const turnsParam = req.query.turns;
    let count = turnsParam === 'all' ? total : (parseInt(turnsParam, 10) || 3);
    if (!Number.isFinite(count) || count < 1) count = 3;
    const last_narrations = history.slice(-count).map(t => ({
      turn_number:            t.turn_number,
      narrative:              t.narrative,
      continuity_block_chars: t.narration_debug?.continuity_block_chars ?? null
    }));

    const _diagPlayer = _lastGameState.player;
    const player_attributes = _diagPlayer ? {
      id:         _diagPlayer.id,
      is_player:  _diagPlayer.is_player || false,
      position:   _diagPlayer.position || null,
      attributes: _diagPlayer.attributes || {}
    } : null;

    res.json({
      turn:                    total,
      rendered_block:          _lastRenderedBlock,
      extraction_packet,
      cb_diagnostics,
      player_attributes,
      visible_npc_attributes,
      site_attributes,
      mood_history,
      promotion_log_recent,
      narrative_archive_total: total,
      last_narrations
    });
  });

  // GET /diagnostics/log?from=N&to=M
  app.get('/diagnostics/log', (req, res) => {
    if (!_lastGameState) {
      return res.json({ no_data: true, reason: 'No turns played yet.' });
    }
    const history = _lastGameState.turn_history || [];
    if (history.length === 0) {
      return res.json({ no_data: true, reason: 'No turns in history yet.' });
    }

    const fromParam = req.query.from !== undefined ? parseInt(req.query.from, 10) : null;
    const toParam   = req.query.to   !== undefined ? parseInt(req.query.to,   10) : null;

    const filtered = history.filter(t => {
      const n = t.turn_number;
      if (fromParam !== null && n < fromParam) return false;
      if (toParam   !== null && n > toParam)   return false;
      return true;
    });

    const turns = filtered.map(t => {
      const nd = t.narration_debug || {};
      const cd = nd.continuity_diagnostics || {};
      return {
        turn_number:          t.turn_number,
        timestamp:            t.timestamp,
        channel:              t.intent_channel,
        raw_input:            t.input?.raw ?? null,
        parsed_action:        t.input?.parsed_intent?.action ?? null,
        parsed_dir:           t.input?.parsed_intent?.dir ?? null,
        parsed_intent_source: t.input?.parsed_intent_source ?? null,
        spatial: {
          depth:            t.authoritative_state?.current_depth ?? null,
          position:         t.authoritative_state?.position ?? null,
          site_name:        t.authoritative_state?.active_site_name ?? null,
          local_space_name: t.authoritative_state?.local_space_name ?? null,
        },
        movement: t.movement ?? null,
        continuity: {
          injected:                  nd.continuity_injected ?? null,
          block_chars:               nd.continuity_block_chars ?? null,
          evicted:                   nd.continuity_evicted ?? null,
          extraction_success:        nd.continuity_extraction_success ?? null,
          rejection_reason:          cd.rejection_reason ?? null,
          prior_memory_count:        null,
          alerts:                    cd.alerts ?? [],
          entity_updates:            cd.entity_updates_applied ?? [],
          entity_cleared:            cd.entity_continuity_cleared ?? [],
          extraction_packet_present: nd.extraction_packet != null,
        },
        dm_note_archived:     nd.dm_note_archived  ?? null,
        dm_note_status:       nd.dm_note_status    ?? null,
        narrative:            t.narrative ?? null,
        engine_message:       null,
        entities_visible:     t.authoritative_state?.visible_npcs_snapshot ?? [],
        violations:           t.diagnostics?.filter(d => d?.type === 'violation').map(d => d.message) ?? [],
        engine_spatial_notes: nd.engine_spatial_notes ?? null,
      };
    });

    res.json({ turns, total_turns: history.length });
  });

  // GET /diagnostics/context?sessionId=X&level=detailed
  app.get('/diagnostics/context', (req, res) => {
    const { sessionId, level = 'detailed' } = req.query;
    if (!sessionId) {
      return res.status(400).json({ error: 'no_session', message: 'sessionId query param required.' });
    }
    if (!_lastGameState) {
      return res.status(404).json({ error: 'no_data', message: 'No turns played yet.' });
    }
    let context;
    try {
      context = buildDebugContext(_lastGameState, level);
    } catch (err) {
      return res.status(500).json({ error: 'context_build_failed', message: err.message });
    }
    res.json({ context, sessionId, level, contextLength: context.length });
  });

  // --- Subcluster B: world / site topology readers -------------------------
  // All routes read _lastGameState. Module-private helpers _getSiteInteriorState
  // and _findSiteRecord used directly (no diag. prefix within same module).

  // GET /diagnostics/sites
  app.get('/diagnostics/sites', (req, res) => {
    if (!_lastGameState) {
      return res.status(404).json({ error: 'no_data', message: 'No turns played yet.' });
    }
    const gs      = _lastGameState;
    const pos     = gs.world.position;
    const depth   = gs.world.active_local_space ? 3 : gs.world.active_site ? 2 : 1;
    const cellKey = pos ? `LOC:${pos.mx},${pos.my}:${pos.lx},${pos.ly}` : null;
    const cell    = cellKey ? gs.world.cells?.[cellKey] : null;

    let cellSites = [];
    if (cell?.sites && !Array.isArray(cell.sites)) {
      cellSites = Object.values(cell.sites).map(s => {
        const interiorState = _getSiteInteriorState(s, gs.world.sites);
        const mirror = s.interior_key ? gs.world.sites?.[s.interior_key] : null;
        return {
          site_id:        s.site_id ?? null,
          name:           s.name ?? null,
          description:    s.description ?? null,
          identity:       s.identity ?? null,
          is_filled:      s.is_filled ?? false,
          enterable:      s.enterable !== false,
          interior_key:   s.interior_key ?? null,
          interior_state: interiorState,
          grid_w:         mirror?.width  ?? null,
          grid_h:         mirror?.height ?? null,
          npc_count:      Array.isArray(mirror?.npcs) ? mirror.npcs.length : 0
        };
      });
    }

    let activeSite = null;
    if (gs.world.active_site) {
      const as = gs.world.active_site;
      const lsEntries = Object.entries(as.local_spaces || {}).map(([key, s]) => {
        const gen = s._generated_interior || null;
        return {
          local_space_id:          key,
          parent_site_id:          s.parent_site_id ?? as.site_id ?? null,
          name:                    s.name ?? null,
          description:             s.description ?? null,
          is_filled:               s.is_filled ?? false,
          enterable:               s.enterable !== false,
          localspace_size:         s.localspace_size ?? null,
          x:                       s.x ?? null,
          y:                       s.y ?? null,
          width:                   s.width ?? gen?.width  ?? null,
          height:                  s.height ?? gen?.height ?? null,
          npc_ids:                 Array.isArray(s.npc_ids) ? [...s.npc_ids] : [],
          npc_count:               Array.isArray(s.npc_ids) ? s.npc_ids.length : 0,
          has_generated_interior:  Array.isArray(s._generated_interior?.grid)
        };
      });
      const activeSiteCleanId = (as.site_id || '').replace(/\/l2$/, '');
      const activeCellSlot = cellSites.find(cs => cs.site_id === activeSiteCleanId);
      activeSite = {
        site_id:             as.site_id ?? null,
        name:                as.name ?? null,
        description:         as.description ?? activeCellSlot?.description ?? null,
        is_filled:           as.is_filled ?? false,
        enterable:           as.enterable !== false,
        site_size:           as.site_size ?? null,
        ls_pct:              as.ls_pct ?? null,
        eligible_tile_count: as.eligible_tile_count ?? null,
        local_spaces:        lsEntries
      };
    }

    let activeLocalSpace = null;
    if (gs.world.active_local_space) {
      const als = gs.world.active_local_space;
      activeLocalSpace = {
        local_space_id: als.local_space_id ?? null,
        parent_site_id: als.parent_site_id ?? null,
        name:           als.name ?? null,
        description:    als.description ?? null,
        is_filled:      als.is_filled ?? false,
        enterable:      als.enterable !== false,
        width:          als.width  ?? null,
        height:         als.height ?? null,
        npc_count:      Array.isArray(als.npc_ids) ? als.npc_ids.length : 0
      };
    }

    res.json({
      depth,
      cell_key:           cellKey,
      cell_sites:         cellSites,
      active_site:        activeSite,
      active_local_space: activeLocalSpace,
      fill_log:           Array.isArray(gs.world._fillLog) ? gs.world._fillLog : []
    });
  });

  // GET /diagnostics/sites-query
  app.get('/diagnostics/sites-query', (req, res) => {
    if (!_lastGameState) {
      return res.status(404).json({ error: 'no_data', message: 'No turns played yet.' });
    }
    const gs        = _lastGameState;
    const pos       = gs.world.position;
    const macroW    = gs.world.l0_grid?.width  || 8;
    const macroH    = gs.world.l0_grid?.height || 8;
    const filledOnly = req.query.filled_only !== 'false';
    const filterMx  = req.query.mx !== undefined ? parseInt(req.query.mx, 10) : null;
    const filterMy  = req.query.my !== undefined ? parseInt(req.query.my, 10) : null;
    const radius    = req.query.radius !== undefined ? parseInt(req.query.radius, 10) : null;

    const results = [];
    for (const cell of Object.values(gs.world.cells || {})) {
      if (!cell || Array.isArray(cell.sites)) continue;
      if (filterMx !== null && filterMy !== null) {
        if (cell.mx !== filterMx || cell.my !== filterMy) continue;
      }
      if (radius !== null && pos) {
        const dMx = ((cell.mx - pos.mx + Math.floor(macroW/2)) % macroW + macroW) % macroW - Math.floor(macroW/2);
        const dMy = ((cell.my - pos.my + Math.floor(macroH/2)) % macroH + macroH) % macroH - Math.floor(macroH/2);
        if (Math.abs(dMx) > radius || Math.abs(dMy) > radius) continue;
      }
      for (const s of Object.values(cell.sites || {})) {
        if (!s) continue;
        if (filledOnly && !s.is_filled) continue;
        const distCells = pos
          ? (() => {
              const dMx = ((cell.mx - pos.mx + Math.floor(macroW/2)) % macroW + macroW) % macroW - Math.floor(macroW/2);
              const dMy = ((cell.my - pos.my + Math.floor(macroH/2)) % macroH + macroH) % macroH - Math.floor(macroH/2);
              return Math.abs(dMx * 128 + (cell.lx - pos.lx)) + Math.abs(dMy * 128 + (cell.ly - pos.ly));
            })()
          : null;
        results.push({
          site_id:              s.site_id   ?? null,
          name:                 s.name      ?? null,
          description:          s.description ?? null,
          identity:             s.identity  ?? null,
          mx: cell.mx, my: cell.my, lx: cell.lx, ly: cell.ly,
          enterable:            s.enterable !== false,
          is_filled:            s.is_filled ?? false,
          interior_state:       _getSiteInteriorState(s, gs.world.sites),
          distance_from_player: distCells
        });
      }
    }

    results.sort((a, b) => {
      if (a.distance_from_player === null) return 1;
      if (b.distance_from_player === null) return -1;
      return a.distance_from_player - b.distance_from_player;
    });

    res.json({
      loaded_cells_only: true,
      note: 'Only covers currently loaded/generated cells. Unvisited areas may have undiscovered sites.',
      total: results.length,
      sites: results
    });
  });

  // GET /diagnostics/site-placement
  app.get('/diagnostics/site-placement', (req, res) => {
    if (!_lastGameState) return res.status(404).json({ error: 'no_data', message: 'No turns played yet.' });
    const log = _lastGameState.world?.site_placement_log || null;
    if (!log) return res.status(404).json({ error: 'no_placement_log', message: 'No site placement log on current world state.' });
    return res.json(log);
  });

  // GET /diagnostics/site?site_id=...
  app.get('/diagnostics/site', (req, res) => {
    if (!_lastGameState) return res.status(404).json({ error: 'no_data', message: 'No turns played yet.' });
    const { site_id } = req.query;
    if (!site_id) return res.status(400).json({ error: 'site_id required' });

    const gs    = _lastGameState;
    const found = _findSiteRecord(gs, site_id);
    if (!found) return res.status(404).json({ error: 'site_not_found', site_id,
      message: 'Site not found in loaded/generated world.sites. May not exist or may be in an unloaded region.' });

    const { site: s, interior_key } = found;
    const cleanId  = (site_id || '').replace(/\/l2$/, '');
    const cellKey  = s._source_cell_key || (s.mx != null ? `LOC:${s.mx},${s.my}:${s.lx},${s.ly}` : null);
    const cellSlot = cellKey ? (gs.world.cells?.[cellKey]?.sites?.[cleanId] ?? null) : null;

    const floorObjIds = [];
    for (const pos of Object.values(s.floor_positions || {})) {
      if (Array.isArray(pos.object_ids)) floorObjIds.push(...pos.object_ids);
    }
    const localspaceIds = Object.keys(s.local_spaces || {});

    res.json({
      site_id:            cleanId,
      interior_key,
      name:               s.name      ?? null,
      description:        s.description ?? cellSlot?.description ?? null,
      identity:           cellSlot?.identity ?? null,
      enterable:          cellSlot ? (cellSlot.enterable !== false) : true,
      is_filled:          cellSlot?.is_filled ?? s.is_filled ?? false,
      interior_state:     !s.is_stub ? 'GENERATED' : 'NOT_GENERATED',
      site_size:          s.site_size  ?? null,
      width:              s.width      ?? null,
      height:             s.height     ?? null,
      population:         s.population ?? null,
      is_stub:            s.is_stub    ?? false,
      created_at:         s.created_at ?? null,
      coords: {
        mx:       s.mx ?? null,
        my:       s.my ?? null,
        lx:       s.lx ?? null,
        ly:       s.ly ?? null,
        cell_key: cellKey
      },
      localspace_count:   localspaceIds.length,
      localspace_ids:     localspaceIds,
      ...(() => {
        const allNpcIds      = (s.npcs || []).map(n => n.id).filter(Boolean);
        const lsNpcIds       = new Set(Object.values(s.local_spaces || {}).flatMap(ls => ls.npc_ids || []));
        const floorNpcIds    = allNpcIds.filter(id => !lsNpcIds.has(id));
        const lsNpcIdArr     = [...lsNpcIds];
        return {
          npc_count:            allNpcIds.length,
          npc_count_total:      allNpcIds.length,
          npc_floor_count:      floorNpcIds.length,
          npc_floor_ids:        floorNpcIds,
          npc_localspace_count: lsNpcIds.size,
          npc_localspace_ids:   lsNpcIdArr,
        };
      })(),
      floor_object_count: floorObjIds.length,
      floor_object_ids:   floorObjIds
    });
  });

  // GET /diagnostics/localspaces?site_id=...
  app.get('/diagnostics/localspaces', (req, res) => {
    if (!_lastGameState) return res.status(404).json({ error: 'no_data', message: 'No turns played yet.' });
    const { site_id } = req.query;
    if (!site_id) return res.status(400).json({ error: 'site_id required' });

    const gs    = _lastGameState;
    const found = _findSiteRecord(gs, site_id);
    if (!found) return res.status(404).json({ error: 'site_not_found', site_id,
      message: 'Site not found in loaded/generated world.sites. May not exist or may be in an unloaded region.' });

    const { site: s } = found;
    const localspaces = Object.entries(s.local_spaces || {}).map(([lsKey, ls]) => {
      const gen = ls._generated_interior ?? null;
      return {
        localspace_id:          lsKey,
        parent_site_id:         ls.parent_site_id ?? null,
        name:                   ls.name           ?? null,
        description:            ls.description    ?? null,
        enterable:              ls.enterable      ?? true,
        is_filled:              ls.is_filled       ?? false,
        localspace_size:        ls.localspace_size ?? null,
        x:                      ls.x              ?? null,
        y:                      ls.y              ?? null,
        width:                  ls.width          ?? null,
        height:                 ls.height         ?? null,
        npc_count:              (ls.npc_ids || []).length,
        npc_ids:                ls.npc_ids         ?? [],
        object_count:           gen?.object_ids?.length ?? 0,
        has_generated_interior: Array.isArray(gen?.grid)
      };
    });

    localspaces.sort((a, b) => a.localspace_id.localeCompare(b.localspace_id));

    res.json({
      site_id,
      site_name:        s.name ?? null,
      localspace_count: localspaces.length,
      note: 'Localspaces whose interiors have not been generated return has_generated_interior: false and null/empty grid_summary.',
      localspaces
    });
  });

  // GET /diagnostics/localspace?localspace_id=...&site_id=...
  app.get('/diagnostics/localspace', (req, res) => {
    if (!_lastGameState) return res.status(404).json({ error: 'no_data', message: 'No turns played yet.' });
    const { localspace_id, site_id, include_grid } = req.query;
    if (!localspace_id) return res.status(400).json({ error: 'localspace_id required' });

    const gs          = _lastGameState;
    const includeGrid = include_grid === 'true';

    let ls           = null;
    let parentSiteId = null;

    if (site_id) {
      const found = _findSiteRecord(gs, site_id);
      if (found) {
        ls = found.site.local_spaces?.[localspace_id] ?? null;
        if (ls) parentSiteId = found.interior_key;
      }
    } else {
      for (const [interior_key, s] of Object.entries(gs.world.sites || {})) {
        const candidate = s.local_spaces?.[localspace_id];
        if (candidate) {
          ls = candidate;
          parentSiteId = interior_key;
          break;
        }
      }
    }

    if (!ls) return res.status(404).json({ error: 'localspace_not_found', localspace_id,
      message: 'Localspace not found in loaded/generated world state. May not exist or its parent site may be in an unloaded region.' });

    const gen     = ls._generated_interior ?? null;
    const hasGrid = Array.isArray(gen?.grid);

    let gridSummary = null;
    if (hasGrid) {
      let floorTiles = 0;
      let npcTiles   = 0;
      for (const row of gen.grid) {
        for (const tile of (row || [])) {
          if (tile && tile.type !== 'wall') floorTiles++;
          if (tile && tile.npc_id)         npcTiles++;
        }
      }
      gridSummary = {
        rows:        gen.grid.length,
        cols:        gen.grid[0]?.length ?? 0,
        floor_tiles: floorTiles,
        npc_tiles:   npcTiles
      };
    }

    const record = {
      localspace_id,
      parent_site_id:         parentSiteId ?? ls.parent_site_id ?? null,
      name:                   ls.name           ?? null,
      description:            ls.description    ?? null,
      enterable:              ls.enterable      ?? true,
      is_filled:              ls.is_filled       ?? false,
      localspace_size:        ls.localspace_size ?? null,
      x:                      ls.x              ?? null,
      y:                      ls.y              ?? null,
      width:                  ls.width          ?? null,
      height:                 ls.height         ?? null,
      npc_count:              (ls.npc_ids || []).length,
      npc_ids:                ls.npc_ids         ?? [],
      object_count:           gen?.object_ids?.length ?? 0,
      object_ids:             gen?.object_ids     ?? [],
      has_generated_interior: hasGrid,
      grid_summary:           gridSummary
    };

    if (includeGrid && hasGrid) record.grid = gen.grid;

    res.json(record);
  });

  // ===========================================================================
  // CLUSTER 6: NPC DIAGNOSTIC ROUTES
  // ===========================================================================

  // NPC diagnostics endpoint — NPC truth surface for panel and QA
  // Returns visible NPCs at the player's current tile with field-level checks.
  // No sessionId required. computeVisibleNpcs is called fresh on every request.
  app.get('/diagnostics/npc', (req, res) => {
    const gs = _lastGameState;
    if (!gs) {
      return res.json({ location: null, npcs: [], site_npc_count: 0 });
    }
    const Actions = require('./ActionProcessor.js');
    const depth = gs.world?.active_local_space ? 3 : gs.world?.active_site ? 2 : 1;
    const activeSite = gs.world?.active_site || null;
    const activeLS   = gs.world?.active_local_space || null;
    const playerPos  = gs.player?.position || null;

    let visibleNpcs = [];
    let locationLabel = 'L0';
    let siteNpcCount = 0;

    if (depth === 3 && activeLS && playerPos) {
      visibleNpcs = Actions.computeVisibleNpcs(activeLS, playerPos, activeSite?.npcs || []);
      locationLabel = `L2:${activeLS.local_space_id || '?'} inside ${activeSite?.name || '?'}`;
      siteNpcCount = (activeSite?.npcs || []).length;
    } else if (depth >= 2 && activeSite && playerPos) {
      visibleNpcs = Actions.computeVisibleNpcs(activeSite, playerPos);
      locationLabel = `L1:${activeSite.name || activeSite.id || '?'} pos(${playerPos.x ?? '?'},${playerPos.y ?? '?'})`;
      siteNpcCount = (activeSite?.npcs || []).length;
    } else {
      // L0: overworld — visible NPCs share the player's exact world tile
      locationLabel = 'L0:overworld';
      siteNpcCount = (gs.world?.npcs || []).length;
      const _worldPos = gs.world?.position || null;
      if (_worldPos) {
        visibleNpcs = (gs.world?.npcs || []).filter(npc =>
          npc.position?.mx === _worldPos.mx &&
          npc.position?.my === _worldPos.my &&
          npc.position?.lx === _worldPos.lx &&
          npc.position?.ly === _worldPos.ly
        );
      }
    }

    const npcData = visibleNpcs.map(npc => {
      // _location_check: compare npc.position (world coords) vs player tile placement
      let _location_check = 'UNKNOWN';
      if (npc.site_id && activeSite) {
        if (npc.site_id === activeSite.id) {
          if (playerPos && npc.position) {
            const _posMismatch = (npc.position.mx !== (playerPos.mx ?? 0)) ||
                                 (npc.position.my !== (playerPos.my ?? 0));
            _location_check = _posMismatch ? 'POSITION MISMATCH' : 'OK';
          } else {
            _location_check = 'OK';
          }
        } else {
          _location_check = 'OTHER SITE';
        }
      }
      return { ...npc, _location_check };
    });

    res.json({ location: locationLabel, npcs: npcData, site_npc_count: siteNpcCount });
  });

  // NPC bulk enumeration endpoint — authoritative NPC list for Mother Brain diagnostics
  // Returns all world.npcs and active_site.npcs with full diagnostic fields including visible status.
  // Gated by DIAGNOSTICS_KEY (x-diagnostics-key header).
  app.get('/diagnostics/npcs', (req, res) => {
    const diagKey = process.env.DIAGNOSTICS_KEY;
    if (!diagKey) return res.status(503).json({ error: 'diagnostics_disabled' });
    if (req.headers['x-diagnostics-key'] !== diagKey) return res.status(403).json({ error: 'forbidden' });

    const gs = _lastGameState;
    if (!gs) {
      return res.json({ layer: 'unknown', world_npcs: [], site_npcs: [], total: 0 });
    }

    const Actions = require('./ActionProcessor.js');
    const depth = gs.world?.active_local_space ? 3 : gs.world?.active_site ? 2 : 1;
    const layerLabel = depth === 3 ? 'L2' : depth === 2 ? 'L1' : 'L0';
    const worldPos  = gs.world?.position || null;
    const activeSite = gs.world?.active_site || null;
    const activeLS   = gs.world?.active_local_space || null;
    const playerPos  = gs.player?.position || null;

    // sameTile: exact 4-field overworld position match
    function sameTile(a, b) {
      if (!a || !b) return false;
      return a.mx === b.mx && a.my === b.my && a.lx === b.lx && a.ly === b.ly;
    }

    // Compute visible site NPC id set via existing computeVisibleNpcs logic
    const _visibleSiteIds = new Set();
    if (depth === 3 && activeLS && playerPos) {
      const vis = Actions.computeVisibleNpcs(activeLS, playerPos, activeSite?.npcs || []);
      vis.forEach(n => _visibleSiteIds.add(n.npc_id || n.id));
    } else if (depth === 2 && activeSite && playerPos) {
      const vis = Actions.computeVisibleNpcs(activeSite, playerPos);
      vis.forEach(n => _visibleSiteIds.add(n.npc_id || n.id));
    }

    function mapNpc(npc, scope, layer) {
      const npcId = npc.npc_id || npc.id || null;
      return {
        id: npcId,
        npc_name: npc.npc_name || null,
        is_learned: npc.is_learned ?? false,
        job_category: npc.job_category || null,
        role_or_relation: npc.role_or_relation || null,
        position: npc.position || null,
        source: npc.source || null,
        _fill_frozen: npc._fill_frozen ?? false,
        scope,
        layer,
        object_ids: npc.object_ids || [],
        worn_object_ids: npc.worn_object_ids || [],
        object_ids_count: (npc.object_ids || []).length,
        worn_object_ids_count: (npc.worn_object_ids || []).length,
        visible: scope === 'world'
          ? sameTile(npc.position, worldPos)
          : _visibleSiteIds.has(npcId)
      };
    }

    const siteLayer = layerLabel === 'L0' ? 'L1' : layerLabel;
    const world_npcs = (gs.world?.npcs || []).map(n => mapNpc(n, 'world', 'L0'));
    const site_npcs  = (activeSite?.npcs || []).map(n => mapNpc(n, 'active_site', siteLayer));

    res.json({
      layer: layerLabel,
      world_npcs,
      site_npcs,
      total: world_npcs.length + site_npcs.length
    });
  });

  // ===========================================================================
  // CLUSTER 7: STREAM + INJECT-NPC + SESSION NEXUS
  // ===========================================================================

  // SSE stream — delegates to module-private registerStreamHandler
  app.get('/diagnostics/stream', registerStreamHandler);

  // Harness NPC fixture injector — POST /diagnostics/inject-npc
  // Injects a synthetic NPC directly onto the player's current tile. For QA harness use only.
  // Auth: x-diagnostics-key header. Body: { sessionId, npc_name, job_category }.
  // The injected NPC is marked source:"harness_fixture" and fixture:true for forensic identification.
  app.post('/diagnostics/inject-npc', (req, res) => {
    const diagKey = process.env.DIAGNOSTICS_KEY;
    if (!diagKey) return res.status(503).json({ error: 'inject_npc_disabled', message: 'DIAGNOSTICS_KEY not set.' });
    if (req.headers['x-diagnostics-key'] !== diagKey) return res.status(401).json({ error: 'unauthorized' });

    const { sessionId, npc_name, job_category } = req.body || {};
    if (!sessionId)    return res.status(400).json({ error: 'sessionId required' });
    if (!npc_name)     return res.status(400).json({ error: 'npc_name required' });
    if (!job_category) return res.status(400).json({ error: 'job_category required' });

    const session = opts.getSessionStates().get(sessionId);
    if (!session) return res.status(404).json({ error: 'session_not_found' });
    const gs = session.gameState;

    const site = gs.world?.active_local_space || gs.world?.active_site;
    if (!site) return res.status(400).json({ error: 'no_active_site', message: 'No active site or localspace in this session.' });

    const pos = gs.player?.position;
    if (!pos) return res.status(400).json({ error: 'no_player_position', message: 'Player position not set.' });

    const Actions = require('./ActionProcessor.js');

    // Build synthetic NPC record — pre-filled, fixture-marked
    const npc_id = `fixture#npc_${Date.now()}`;
    const npc = {
      id: npc_id,
      site_id: site.site_id || site.id || 'unknown',
      npc_name,
      job_category,
      gender: null, age: null,
      _fill_frozen: true,        // skip NPC-FILL pipeline — already filled
      is_learned: true,          // narrator receives real name, not null
      player_recognition: null,
      reputation_player: 50,
      traits: [],
      attributes: {},
      object_capture_turn: null,
      position: { mx: 0, my: 0, lx: pos.x, ly: pos.y },
      source: 'harness_fixture', // forensic marker — injected by QA harness, not worldgen
      fixture: true
    };

    // Add to site NPC registry
    if (!Array.isArray(site.npcs)) site.npcs = [];
    site.npcs.push(npc);

    // computeVisibleNpcs for localspaces resolves npc ids against active_site.npcs, not active_local_space.npcs.
    // When injecting at depth 3 (site === active_local_space), also register in active_site so the resolver finds the id.
    const _injectActiveSite = gs.world?.active_site;
    if (_injectActiveSite && _injectActiveSite !== site) {
      if (!Array.isArray(_injectActiveSite.npcs)) _injectActiveSite.npcs = [];
      _injectActiveSite.npcs.push(npc);
    }

    // Add NPC id to player's exact tile so computeVisibleNpcs picks it up
    const grid = site.grid;
    if (Array.isArray(grid) && grid[pos.y] && grid[pos.y][pos.x]) {
      const tile = grid[pos.y][pos.x];
      if (!Array.isArray(tile.npc_ids)) tile.npc_ids = [];
      tile.npc_ids.push(npc_id);
    } else {
      // Grid missing or tile uninitialized — still added to registry; visibility depends on grid structure
      console.warn(`[INJECT-NPC] grid tile at (${pos.x},${pos.y}) not found — NPC added to registry only`);
    }

    // Recompute _visible_npcs so the Arbiter sees the injected NPC without requiring player movement.
    // _visible_npcs is normally only computed on entry or movement; injection bypasses both.
    const _injectLS = gs.world?.active_local_space;
    if (_injectLS && _injectLS.grid) {
      _injectLS._visible_npcs = Actions.computeVisibleNpcs(_injectLS, pos, gs.world.active_site?.npcs || []);
    } else if (gs.world?.active_site?.grid) {
      gs.world.active_site._visible_npcs = Actions.computeVisibleNpcs(gs.world.active_site, pos);
    }

    return res.json({ injected: true, npc_id, npc_name, job_category, tile: { x: pos.x, y: pos.y } });
  });

  // Session bootstrap probe for Mother Brain — GET /diagnostics/session
  // Returns the last known session ID and turn count so MB can self-initialize without waiting for an SSE turn.
  // v1.87.3: also returns sessions[] — all active sessions sorted by total_turns desc, so attach_session can pick
  // the real game session instead of the last probe/harness session that happened to POST /narrate most recently.
  app.get('/diagnostics/session', (req, res) => {
    const sessions = [];
    for (const [sid, sess] of opts.getSessionStates().entries()) {
      const gs = sess.gameState;
      const total_turns = gs?.turn_history?.length ?? 0;
      const depth = gs?.world?.active_local_space ? 3 : gs?.world?.active_site ? 2 : gs?.world?.position ? 1 : 0;
      sessions.push({ session_id: sid, total_turns, depth });
    }
    sessions.sort((a, b) => b.total_turns - a.total_turns);
    if (!_lastSessionId || !_lastGameState) {
      return res.json({ sessionId: null, hasTurnData: false, lastTurn: null, sessions });
    }
    const _dh = getDiagHistory();
    const lastEntry = _dh.length > 0 ? _dh[_dh.length - 1] : null;
    res.json({
      sessionId:   _lastSessionId,
      hasTurnData: _dh.length > 0,
      lastTurn:    lastEntry?.turn_number ?? null,
      sessions
    });
  });
}

module.exports = {
  TERRAIN_CODES:              _TERRAIN_CODES,
  getSiteInteriorState:       _getSiteInteriorState,
  findSiteRecord:             _findSiteRecord,
  readTurnFromDisk:           _readTurnFromDisk,
  // cache setters
  pushContinuityBlock,
  setNarratorPromptStats,
  setNarratorPayload,
  setNarratorRawResponse,
  // primary API
  buildDebugContext,
  // SSE infrastructure
  emitDiagnostics,
  registerStreamHandler,
  // diag history (Cluster 3)
  pushDiagHistory,
  getDiagHistory,
  // Cluster 5 state setters + getters
  setLastGameState,
  setLastRenderedBlock,
  setLastSessionId,
  setLastWatchMessage,
  getLastGameState,
  getLastSessionId,
  // route registration
  registerRoutes,
};
