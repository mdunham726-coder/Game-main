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

module.exports = {
  TERRAIN_CODES:          _TERRAIN_CODES,
  getSiteInteriorState:   _getSiteInteriorState,
  findSiteRecord:         _findSiteRecord,
  readTurnFromDisk:       _readTurnFromDisk,
};
