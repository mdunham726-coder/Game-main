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
};
