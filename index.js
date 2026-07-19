const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');

// Inline .env loader — sets any KEY=VALUE lines that are not already in process.env.
// Runs before anything else so all launch paths (bat, VS Code terminal, direct node) get the keys.
try {
  const _envPath = path.join(__dirname, '.env');
  if (fs.existsSync(_envPath)) {
    for (const line of fs.readFileSync(_envPath, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 1) continue;
      const k = trimmed.slice(0, eq).trim();
      const v = trimmed.slice(eq + 1).trim();
      if (k && !(k in process.env)) process.env[k] = v;
    }
  }
} catch (_) { /* non-fatal — server starts without .env if file is missing or unreadable */ }
const axios = require('axios');
const https = require('https');
const { spawn } = require('child_process');
// v1.84.88: shared agent for all DeepSeek calls — keepAlive:false prevents listener accumulation on global https.globalAgent
const _sharedHttpsAgent = new https.Agent({ keepAlive: false });
const Engine = require('./Engine.js');
const WorldGen = require('./WorldGen.js');
const { createLogger } = require('./logger.js');
// Legacy import retained for compatibility
const Actions = require('./ActionProcessor.js');

const { validateAndQueueIntent, parseIntent } = require('./ActionProcessor.js');
const { normalizeUserIntent, resolveEnterTarget, _enrichPrimaryAction } = require('./SemanticParser.js');
const NC = require('./NarrativeContinuity');
const CB = require('./ContinuityBrain'); // v1.70.0
const ObjectHelper = require('./ObjectHelper'); // v1.84.52
const ConditionBot = require('./conditionbot'); // v1.84.19
const AuthorityGate = require('./authoritygate'); // v1.88.0
const SemanticNormalizer = require('./SemanticNormalizer'); // v1.88.78: TSL Stage 1
const diag = require('./diagnostics');
const ObjectOperationResolver = require('./ObjectOperationResolver'); // v1.91.56: P1b witness diagnostics
const TlsObjectOperationExecutor = require('./TlsObjectOperationExecutor'); // v1.91.64: P4 dry-run executor
const ObjectOperationBridge = require('./ObjectOperationBridge'); // v1.91.73: Object Operation Bridge — fail-closed downstream routing
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

// v1.88.29: deterministic born-NPC ID — single formula used at both pre-seed and materialization
function _bornNpcId(seed, sn) {
  const input = [String(seed), sn.name || '', sn.role_or_relation || '', sn.description || '', 'born_npc'].join(':');
  return 'player#born_npc_' + crypto.createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 12);
}

// Session state management
const sessionStates = new Map();

// Mother Brain — unique session identifier (changes on every Node restart)
const _mbSessionId = Date.now();

// ── Harness control state ────────────────────────────────────────────────────
let _harnessRunning       = false;     // blocks concurrent POST /harness/run
let _lastHarnessResult    = null;      // last result from POST /harness/run
const MAX_MOTHER_RUNS     = 5;         // Mother Brain run cap per call
const HARNESS_RESULT_PATH = path.join(__dirname, 'tests', '.last-harness-result.json');
const HARNESS_SCENARIOS_DIR = path.join(__dirname, 'tests', 'scenarios');

// Consult DeepSeek — rolling conversation history per session
// Stored as exchange objects so future trimming/summarization touches only exchanges[]
// Shape: Map<sessionId, { exchanges: [{userQ, aiR, ts}], created, lastUsed }>
const _consultHistory = new Map();

// ── Real-time init progress bus (for first-turn progress polling) ─────────────
const _initProgress = new Map();

let _wUsageShapeLogged = false;      // one-time flag: log Watch usage object shape on first call to confirm DeepSeek field names
let _activeTurnDebug = null;         // v1.88.67: module-level fallback — never primary routing (async interleave hazard)

// ── Session TTL eviction ─────────────────────────────────────────────────────
// Sessions accumulate ~50 MB each. Evict sessions idle > 20 min to prevent OOM.
const _sessionLastUsed = new Map();  // sessionId -> last-access timestamp
const _divCheckCache = new Map();    // v1.91.11: divisibility check cache — (sourceLabel::label) -> bool
// v1.91.22: witness store — one packet per session, replaced each turn
// Read by GET /debug/witness. Evicted with session in the TTL sweep.
const _witnessStore = new Map(); // sessionId -> witnessPacket
const SESSION_PROBE_MAX_AGE_MS = 5 * 60 * 1000;       // 5 min  — probes/harness are throw-aways
const SESSION_GAME_MAX_AGE_MS  = 24 * 60 * 60 * 1000; // 24 hrs — browser game sessions survive overnight
setInterval(() => {
  const _sweepNow = Date.now();
  let _evictCount = 0;
  for (const [_sid, _ts] of _sessionLastUsed) {
    const _sess = sessionStates.get(_sid);
    const _maxAge = _sess?.session_type === 'game' ? SESSION_GAME_MAX_AGE_MS : SESSION_PROBE_MAX_AGE_MS;
    if (_sweepNow - _ts > _maxAge) {
      // v1.91.74: Archive session evidence before eviction
      try {
        const _safeId = String(_sid).replace(/[^a-zA-Z0-9_-]/g, '_');
        const _archiveDir = path.join(__dirname, 'logs', 'archive');
        fs.mkdirSync(_archiveDir, { recursive: true });
        const _archiveLine = JSON.stringify({
          schema_version: 'session_archive_v1',
          archived_at: new Date().toISOString(),
          session_id: _sid,
          session_type: _sess?.session_type ?? null,
          session_origin: _sess?.session_origin ?? null,
          ttl_reason: _sess?.session_type === 'game' ? 'game_timeout' : 'probe_timeout',
          last_used_ts: _ts,
          game_state_summary: _sess?.gameState ? { turn_counter: _sess.gameState.turn_history?.length ?? 0, player_name: _sess.gameState.player?.name ?? null, player_location: _sess.gameState.player?.location ?? null, world_position: _sess.gameState.world?.position ?? null, active_site: _sess.gameState.world?.active_site ?? null, active_local_space: _sess.gameState.world?.active_local_space ?? null } : null,
          witness_packet: _witnessStore.get(_sid) ?? null,
          consult_history: _consultHistory.get(_sid) ?? null
        });
        fs.appendFileSync(path.join(_archiveDir, `session_${_safeId}.jsonl`), _archiveLine + '\n');
      } catch (_archiveErr) {
        console.error('[SESSION-ARCHIVE] Archive write failed for', _sid, _archiveErr.message);
      }
      sessionStates.delete(_sid);
      _sessionLastUsed.delete(_sid);
      _consultHistory.delete(_sid);
      _witnessStore.delete(_sid);      // v1.91.22
      _evictCount++;
    }
  }
  if (_evictCount > 0) {
    console.log(`[SESSION-EVICT] Evicted ${_evictCount} idle session(s). Active: ${sessionStates.size}`);
  }
}, 60 * 1000).unref(); // sweep every 1 minute
function _pushProgress(token, step, pct, detail = {}) {
  if (!token) return;
  const arr = _initProgress.get(token) || [];
  arr.push({ step, pct, detail, ts: Date.now() });
  _initProgress.set(token, arr);
}

// v1.88.67: route turn diagnostics to console AND narration_debug console_log[].
// debugTarget is always passed explicitly from the narrate handler (avoids async cross-session bleed).
// _activeTurnDebug is module-level fallback only — for future external-module callers (ObjectHelper, CB).
function _turnLog(debugTarget, level, tag, msg, data) {
  console[level]('[' + tag + '] ' + msg);
  const _tgt = debugTarget || _activeTurnDebug;
  if (_tgt && Array.isArray(_tgt.console_log)) {
    _tgt.console_log.push({ level, tag, message: msg, data: data ?? null, ts: new Date().toISOString() });
  }
}

function generateSessionId() {
  return Date.now() + '-' + Math.random().toString(36).substr(2, 9);
}

function getSessionState(sessionId) {
  // [DIAG-3] Log inside getSessionState
  console.log('[DIAG-3-SERVER-GETSESSIONSTATE] Incoming sessionId:', sessionId);
  console.log('[DIAG-3-SERVER-GETSESSIONSTATE] Type:', typeof sessionId);
  console.log('[DIAG-3-SERVER-GETSESSIONSTATE] !sessionId evaluates to:', !sessionId);
  console.log('[DIAG-3-SERVER-GETSESSIONSTATE] Current Map size:', sessionStates.size);
  console.log('[DIAG-3-SERVER-GETSESSIONSTATE] Current Map keys (first 5):', Array.from(sessionStates.keys()).slice(0, 5));
  
  if (!sessionId || !sessionStates.has(sessionId)) {
    // [DIAG-3a] Creating new session
    console.log('[DIAG-3a-SERVER-GETSESSIONSTATE] CREATING NEW SESSION because: !sessionId=', !sessionId, ', !has=', !sessionStates.has(sessionId));
    const newSessionId = generateSessionId();
    console.log('[DIAG-3a-SERVER-GETSESSIONSTATE] Generated new sessionId:', newSessionId);
    const newState = initializeGame();
    const logger = createLogger({ sessionId: newSessionId });
    sessionStates.set(newSessionId, {
      gameState: newState.state,
      isFirstTurn: true,
      logger: logger,
      session_origin: 'unknown'
    });
    _sessionLastUsed.set(newSessionId, Date.now());
    console.log('[DIAG-3a-SERVER-GETSESSIONSTATE] New session stored in Map. Map size now:', sessionStates.size);
    logger.sessionStarted({ newSessionId });
    return { sessionId: newSessionId, ...sessionStates.get(newSessionId) };
  }
  // [DIAG-3b] Returning existing session
  console.log('[DIAG-3b-SERVER-GETSESSIONSTATE] RETURNING EXISTING SESSION for sessionId:', sessionId);
  _sessionLastUsed.set(sessionId, Date.now());
  const existing = sessionStates.get(sessionId);
  console.log('[DIAG-3b-SERVER-GETSESSIONSTATE] Existing session isFirstTurn:', existing?.isFirstTurn);
  return { sessionId, ...existing };
}

// File system helper functions for save/load system
const fsPromises = require('fs').promises;

function getSavePath(sessionId) {
  return path.join(__dirname, 'saves', sessionId);
}

function getSaveFilePath(sessionId, saveName) {
  const cleanName = saveName.replace(/[^a-zA-Z0-9\s]/g, '').trim();
  return path.join(getSavePath(sessionId), `${cleanName}.json`);
}

async function ensureSaveDir(sessionId) {
  const savePath = getSavePath(sessionId);
  try {
    await fsPromises.mkdir(savePath, { recursive: true });
  } catch (err) {
    console.error(`Failed to create save directory: ${err.message}`);
    throw err; // Re-throw to let caller handle
  }
}

async function getSaveCount(sessionId) {
  try {
    const savePath = getSavePath(sessionId);
    const files = await fsPromises.readdir(savePath);
    return files.filter(file => file.endsWith('.json')).length;
  } catch (error) {
    return 0; // Directory doesn't exist yet
  }
}

async function findUniqueSaveName(sessionId, baseName) {
  const cleanBase = baseName.replace(/[^a-zA-Z0-9\s]/g, '').trim();
  let counter = 1;
  let candidateName = cleanBase;
  
  while (true) {
    const filePath = getSaveFilePath(sessionId, candidateName);
    try {
      await fsPromises.access(filePath);
      // File exists, try next number
      candidateName = `${cleanBase} (${counter})`;
      counter++;
    } catch (error) {
      // File doesn't exist, we found our unique name
      return candidateName;
    }
    
    // Safety limit to prevent infinite loops
    if (counter > 100) {
      throw new Error('Could not find unique save name');
    }
  }
}

async function saveExists(sessionId, saveName) {
  try {
    const filePath = getSaveFilePath(sessionId, saveName);
    await fsPromises.access(filePath);
    return true;
  } catch (error) {
    return false;
  }
}
// =============================================================================
// SAVE/LOAD UTILITY FUNCTIONS (Option 3 Hybrid Approach)
// =============================================================================

async function performSave(sessionId, saveName, gameState) {
  if (!sessionId) {
    return { success: false, error: 'MISSING_SESSION_ID', message: 'Session ID is required' };
  }
  
  if (!saveName || typeof saveName !== 'string' || !saveName.trim()) {
    return { success: false, error: 'INVALID_SAVE_NAME', message: 'Save name is required and must be a string' };
  }
  
  const cleanSaveName = saveName.replace(/[^a-zA-Z0-9\s]/g, '').trim();
  if (cleanSaveName.length === 0) {
    return { success: false, error: 'INVALID_SAVE_NAME', message: 'Save name contains only invalid characters' };
  }
  
  if (cleanSaveName.length > 30) {
    return { success: false, error: 'INVALID_SAVE_NAME', message: 'Save name must be 30 characters or less' };
  }
  
  if (!gameState || typeof gameState !== 'object') {
    return { success: false, error: 'INVALID_GAME_STATE', message: 'Valid game state is required' };
  }
  
  try {
    const saveCount = await getSaveCount(sessionId);
    if (saveCount >= 5) {
      return { success: false, error: 'SAVE_LIMIT_EXCEEDED', message: 'Maximum of 5 saves allowed per session' };
    }
    
    await ensureSaveDir(sessionId);
    
    let finalSaveName = cleanSaveName;
    if (await saveExists(sessionId, cleanSaveName)) {
      finalSaveName = await findUniqueSaveName(sessionId, cleanSaveName);
    }
    
    const filePath = getSaveFilePath(sessionId, finalSaveName);
    const saveData = {
      gameState,
      timestamp: new Date().toISOString(),
      sessionId,
      saveName: finalSaveName
    };
    
    await fsPromises.writeFile(filePath, JSON.stringify(saveData, null, 2));
    
    const stats = await fsPromises.stat(filePath);
    const fileSizeKB = stats.size / 1024;
    if (fileSizeKB > 5) {
      console.warn(`[SAVE] Save file exceeds 5KB: ${fileSizeKB.toFixed(2)}KB`);
    }
    
    return { 
      success: true, 
      message: `Saved as ${finalSaveName}!`,
      saveName: finalSaveName,
      fileSizeKB: Math.round(fileSizeKB * 100) / 100
    };
    
  } catch (error) {
    console.error('[SAVE] Error:', error.message);
    return { success: false, error: 'SAVE_FAILED', message: 'Failed to save game: ' + error.message };
  }
}

async function performLoad(sessionId, saveName) {
  if (!sessionId) {
    return { success: false, error: 'MISSING_SESSION_ID', message: 'Session ID is required' };
  }
  
  if (!saveName || typeof saveName !== 'string' || !saveName.trim()) {
    return { success: false, error: 'INVALID_SAVE_NAME', message: 'Save name is required' };
  }
  
  try {
    const filePath = getSaveFilePath(sessionId, saveName);
    
    try {
      await fsPromises.access(filePath);
    } catch (error) {
      return { success: false, error: 'SAVE_NOT_FOUND', message: `Save file '${saveName}' not found` };
    }
    
    const fileContent = await fsPromises.readFile(filePath, 'utf8');
    const saveData = JSON.parse(fileContent);
    
    if (!saveData.gameState) {
      return { success: false, error: 'INVALID_SAVE_FILE', message: 'Save file is corrupted or invalid' };
    }

    // Guard: remove null-keyed junk entries that may exist in older saves
    const _gs = saveData.gameState;
    delete _gs._tlsPartialStackResult;
    if (_gs.world && _gs.world.sites) {
      delete _gs.world.sites['null'];
      delete _gs.world.sites[null];
    }

    // v1 clean break: discard old category-based site records, regenerate via new slot system.
    if (_gs.world && _gs.world.cells) {
      const _migSeed = _gs.world.phase3_seed;
      const _migBias = _gs.world.world_bias;
      for (const [_ck, _cc] of Object.entries(_gs.world.cells)) {
        if (!_ck.startsWith('LOC:')) continue;
        _cc.sites = {};
        if (_migSeed !== undefined && _migBias) {
          const _newSlots = WorldGen.evaluateCellForSites(_ck, _cc.type || 'plains', _migBias, _migSeed);
          for (const _sl of _newSlots) {
            _sl.created_at_turn = 0;
            if (_sl.enterable) _sl.interior_key = `${_sl.site_id}/l2`;
            _cc.sites[_sl.site_id] = _sl;
          }
        }
      }
      if (_gs.world.sites) {
        for (const [_sk, _sv] of Object.entries(_gs.world.sites)) {
          if (_sv && _sv.is_stub) delete _gs.world.sites[_sk];
        }
      }
      if (_gs.world.active_site?.is_stub) {
        _gs.world.active_site = null;
        _gs.world.active_local_space = null;
        _gs.world.current_depth = 1;
      }
      console.log('[LOAD] v1 migration: cell.sites wiped and regenerated from new slot system.');
    }

    return {
      success: true,
      gameState: saveData.gameState,
      message: `Game loaded from '${saveName}'`
    };
    
  } catch (error) {
    console.error('[LOAD] Error:', error.message);
    if (error instanceof SyntaxError) {
      return { success: false, error: 'LOAD_FAILED', message: 'Save file is corrupted (invalid JSON)' };
    }
    return { success: false, error: 'LOAD_FAILED', message: 'Failed to load game: ' + error.message };
  }
}

function performNewGame(sessionId) {
  try {
    const freshState = Engine.initState();
    return { success: true, gameState: freshState, message: "New game started" };
  } catch (error) {
    console.error('[NEWSAVE] Error:', error.message);
    return { success: false, error: 'NEW_GAME_FAILED', message: 'Failed to start new game: ' + error.message };
  }
}

async function listSavesData(sessionId) {
  if (!sessionId) {
    return { success: false, error: 'MISSING_SESSION_ID', message: 'Session ID is required' };
  }
  
  try {
    const savePath = getSavePath(sessionId);
    let files = [];
    
    try {
      files = await fsPromises.readdir(savePath);
    } catch (error) {
      return { success: true, saves: [], count: 0 };
    }
    
    const saves = files
      .filter(file => file.endsWith('.json'))
      .map(file => {
        const saveName = file.replace('.json', '');
        return { name: saveName };
      });
    
    return { success: true, saves: saves, count: saves.length };
  } catch (error) {
    console.error('[SAVES] Error:', error.message);
    return { success: false, error: 'LIST_SAVES_FAILED', message: 'Failed to list saves: ' + error.message };
  }
}
// =============================================================================
// PHASE 3C: QUEST SYSTEM API ENDPOINTS
// =============================================================================

// GET /quest/available - Get available quests for a site
app.get('/quest/available', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  const { siteId } = req.query;
  
  if (!sessionId) {
    return res.status(400).json({ error: 'MISSING_SESSION_ID', message: 'Session ID is required' });
  }
  
  if (!siteId) {
    return res.status(400).json({ error: 'MISSING_SITE_ID', message: 'Site ID is required' });
  }
  
  const { gameState } = getSessionState(sessionId);
  
  try {
    // Check if quests exist for this site
    const availableQuests = gameState.quests.allQuestsSeeded[siteId] || [];
    
    // Filter out quests that are already active or completed
    const activeQuestIds = new Set(gameState.quests.active.map(q => q.id));
    const completedQuestIds = new Set(gameState.quests.completed.map(q => q.id));
    
    const filteredQuests = availableQuests.filter(quest => 
      !activeQuestIds.has(quest.id) && !completedQuestIds.has(quest.id)
    );
    
    return res.json({
      success: true,
      siteId,
      availableQuests: filteredQuests,
      count: filteredQuests.length
    });
    
  } catch (error) {
    console.error('[QUEST] Error getting available quests:', error);
    return res.status(500).json({ 
      error: 'QUEST_SYSTEM_ERROR', 
      message: 'Failed to retrieve available quests' 
    });
  }
});

// POST /quest/accept - Accept a quest
app.post('/quest/accept', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  const { questId, siteId } = req.body;
  
  if (!sessionId) {
    return res.status(400).json({ error: 'MISSING_SESSION_ID', message: 'Session ID is required' });
  }
  
  if (!questId) {
    return res.status(400).json({ error: 'MISSING_QUEST_ID', message: 'Quest ID is required' });
  }
  
  const sessionState = getSessionState(sessionId);
  let { gameState } = sessionState;
  
  try {
    // Validate quest acceptance
    const validation = Engine.validateQuestAcceptance(gameState, questId);
    if (!validation.valid) {
      const status = validation.status || 400;
      return res.status(status).json({ 
        error: validation.error, 
        message: getQuestErrorMessage(validation.error) 
      });
    }
    
    // Accept the quest
    const quest = { ...validation.quest };
    quest.status = 'accepted';
    quest.turn_accepted = gameState.turn_counter;
    quest.current_step = 0;
    
    gameState.quests.active.push(quest);
    
    // Update session state
    sessionStates.set(sessionId, { ...sessionState, gameState });
    
    return res.json({
      success: true,
      message: `Quest accepted: ${quest.title}`,
      quest: quest
    });
    
  } catch (error) {
    console.error('[QUEST] Error accepting quest:', error);
    return res.status(500).json({ 
      error: 'QUEST_ACCEPT_FAILED', 
      message: 'Failed to accept quest' 
    });
  }
});

// POST /quest/progress - Advance quest progress
app.post('/quest/progress', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  const { questId, step } = req.body;
  
  if (!sessionId) {
    return res.status(400).json({ error: 'MISSING_SESSION_ID', message: 'Session ID is required' });
  }
  
  if (!questId) {
    return res.status(400).json({ error: 'MISSING_QUEST_ID', message: 'Quest ID is required' });
  }
  
  const sessionState = getSessionState(sessionId);
  let { gameState } = sessionState;
  
  try {
    // Find the active quest
    const questIndex = gameState.quests.active.findIndex(q => q.id === questId);
    if (questIndex === -1) {
      return res.status(404).json({ 
        error: 'QUEST_NOT_FOUND', 
        message: 'Quest not found in active quests' 
      });
    }
    
    const quest = gameState.quests.active[questIndex];
    
    // Update progress
    if (step !== undefined) {
      quest.current_step = Math.min(step, quest.total_steps);
    } else {
      quest.current_step = Math.min(quest.current_step + 1, quest.total_steps);
    }
    
    quest.status = quest.current_step === quest.total_steps ? 'ready_to_complete' : 'in_progress';
    
    // Update session state
    sessionStates.set(sessionId, { ...sessionState, gameState });
    
    return res.json({
      success: true,
      message: `Quest progress updated: ${quest.current_step}/${quest.total_steps}`,
      quest: quest
    });
    
  } catch (error) {
    console.error('[QUEST] Error updating quest progress:', error);
    return res.status(500).json({ 
      error: 'QUEST_PROGRESS_FAILED', 
      message: 'Failed to update quest progress' 
    });
  }
});

// POST /quest/complete - Complete a quest and claim rewards
app.post('/quest/complete', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  const { questId } = req.body;
  
  if (!sessionId) {
    return res.status(400).json({ error: 'MISSING_SESSION_ID', message: 'Session ID is required' });
  }
  
  if (!questId) {
    return res.status(400).json({ error: 'MISSING_QUEST_ID', message: 'Quest ID is required' });
  }
  
  const sessionState = getSessionState(sessionId);
  let { gameState } = sessionState;
  
  try {
    // Validate quest completion
    const validation = Engine.validateQuestCompletion(gameState, questId);
    if (!validation.valid) {
      const status = validation.status || 400;
      return res.status(status).json({ 
        error: validation.error, 
        message: getQuestErrorMessage(validation.error) 
      });
    }
    
    const quest = validation.quest;
    const questIndex = gameState.quests.active.findIndex(q => q.id === questId);
    
    // Apply rewards
    gameState = Engine.applyQuestReward(gameState, quest);
    
    // Move quest to completed
    quest.status = 'completed';
    quest.turn_completed = gameState.turn_counter;
    
    gameState.quests.active.splice(questIndex, 1);
    gameState.quests.completed.push(quest);
    
    // Update session state
    sessionStates.set(sessionId, { ...sessionState, gameState });
    
    return res.json({
      success: true,
      message: `Quest completed! Received ${quest.reward_gold} gold.`,
      reward: quest.reward_gold,
      quest: quest
    });
    
  } catch (error) {
    console.error('[QUEST] Error completing quest:', error);
    return res.status(500).json({ 
      error: 'QUEST_COMPLETE_FAILED', 
      message: 'Failed to complete quest' 
    });
  }
});

// GET /quest/active - Get player's active quests
app.get('/quest/active', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  
  if (!sessionId) {
    return res.status(400).json({ error: 'MISSING_SESSION_ID', message: 'Session ID is required' });
  }
  
  const { gameState } = getSessionState(sessionId);
  
  try {
    return res.json({
      success: true,
      activeQuests: gameState.quests.active,
      count: gameState.quests.active.length,
      maxActiveQuests: gameState.quests.config.maxActiveQuests
    });
    
  } catch (error) {
    console.error('[QUEST] Error getting active quests:', error);
    return res.status(500).json({ 
      error: 'QUEST_LIST_FAILED', 
      message: 'Failed to retrieve active quests' 
    });
  }
});

// Helper function for quest error messages
function getQuestErrorMessage(errorCode) {
  const messages = {
    'ACTIVE_QUEST_LIMIT': 'Maximum 10 active quests reached. Complete some quests first.',
    'QUEST_NOT_FOUND': 'Quest not found or no longer available.',
    'QUEST_ALREADY_ACTIVE': 'You have already accepted this quest.',
    'INCOMPLETE_QUEST': 'Quest is not yet complete. Finish all objectives first.'
  };
  
  return messages[errorCode] || 'An unknown quest error occurred.';
}
// =============================================================================
// SYSTEM COMMAND DETECTION FUNCTION
// =============================================================================

async function detectSystemCommand(input, sessionId, currentGameState, sessionStates) {
  const userInput = String(input).trim().toLowerCase();
  
  // Save Command: "save", "save myquest", "save as my adventure"
  const saveMatch = userInput.match(/^save(?:\s+(?:as\s+)?(.+))?$/i);
  if (saveMatch) {
    let saveName = saveMatch[1] ? saveMatch[1].trim() : `Save ${new Date().toLocaleTimeString()}`;
    
    // Sanitize save name
    saveName = saveName.replace(/[^a-zA-Z0-9\s]/g, '').trim();
    if (saveName.length > 30) {
      saveName = saveName.substring(0, 30);
    }
    if (saveName.length === 0) {
      saveName = `Save ${new Date().toLocaleTimeString()}`;
    }
    
    const result = await performSave(sessionId, saveName, currentGameState);
    return {
      isSystemCommand: true,
      message: result.success ? `[OK] ${result.message}` : `[FAIL] ${result.message}`,
      newState: currentGameState // State doesn't change on save
    };
  }
  
  // Load Command: "load myquest", "load save1"
  const loadMatch = userInput.match(/^load\s+(.+)$/i);
  if (loadMatch) {
    const saveName = loadMatch[1].trim();
    
    const result = await performLoad(sessionId, saveName);
    if (result.success) {
      // Update session state for subsequent turns
      sessionStates.set(sessionId, {
        gameState: result.gameState,
        isFirstTurn: false
      });
      
      return {
        isSystemCommand: true,
        message: `[OK] ${result.message}`,
        newState: result.gameState
      };
    } else {
      return {
        isSystemCommand: true,
        message: `[FAIL] ${result.message}`,
        newState: currentGameState
      };
    }
  }
  
  // New Game Command: "new game", "restart", "start over"
  const newGameMatch = userInput.match(/^(?:new\s+game|restart|start\s+over)$/i);
  if (newGameMatch) {
    const result = performNewGame(sessionId);
    if (result.success) {
      // Update session state
      sessionStates.set(sessionId, {
        gameState: result.gameState,
        isFirstTurn: true
      });
      
      return {
        isSystemCommand: true,
        message: `[OK] ${result.message}`,
        newState: result.gameState
      };
    } else {
      return {
        isSystemCommand: true,
        message: `[FAIL] ${result.message}`,
        newState: currentGameState
      };
    }
  }
  
  // List Saves Command: "list saves", "show saves", "my saves", "saves"
  const listSavesMatch = userInput.match(/^(?:list\s+saves|show\s+saves|my\s+saves|saves)$/i);
  if (listSavesMatch) {
    const result = await listSavesData(sessionId);
    if (result.success) {
      if (result.count === 0) {
        return {
          isSystemCommand: true,
          message: "No saves found.",
          newState: currentGameState
        };
      } else {
        const saveList = result.saves.map((save, index) => `${index + 1}. ${save.name}`).join(', ');
        return {
          isSystemCommand: true,
          message: `Your saves (${result.count}): ${saveList}`,
          newState: currentGameState
        };
      }
    } else {
      return {
        isSystemCommand: true,
        message: `[FAIL] ${result.message}`,
        newState: currentGameState
      };
    }
  }
  
  // PHASE 3C: Quest Commands
  const questCommands = {
    'quests': 'list_quests',
    'my quests': 'list_quests', 
    'show quests': 'list_quests',
    'active quests': 'list_quests'
  };
  
  if (questCommands[userInput]) {
    return {
      isSystemCommand: true,
      message: "Use the quest menu or '/quest/active' endpoint to view your quests.",
      newState: currentGameState
    };
  }
  
  // Not a system command
  return { isSystemCommand: false, message: "", newState: currentGameState };
}
// =============================================================================
// MODIFIED /NARRATE ENDPOINT WITH SYSTEM COMMAND INTEGRATION
// =============================================================================

// v1.59.0: Autosave path — isolated slot, never counts toward the 5-save cap
function getAutosavePath(sessionId) {
  return path.join(__dirname, 'saves', sessionId, 'autosave.json');
}

// v1.59.0: Restore session from autosave if the server lost it (e.g. restart).
// Only fires when the client sends a known sessionId that's no longer in the Map.
// Async — awaited at the top of the /narrate route before getSessionState.
// clientState: optional gameState sent by browser from localStorage (primary for Render,
//              where the filesystem is wiped on wake). Disk autosave is secondary fallback.
async function restoreAutosaveIfAvailable(sessionId, clientState) {
  if (!sessionId || sessionStates.has(sessionId)) return; // nothing to do
  // Primary: restore from client-provided state (survives Render sleep)
  if (clientState && typeof clientState === 'object' && clientState.world) {
    const logger = createLogger({ sessionId });
    sessionStates.set(sessionId, { gameState: clientState, isFirstTurn: false, logger, session_type: 'game', session_origin: 'autosave_restore' });
    console.log('[AUTOSAVE] Restored session', sessionId, 'from client_state — turn', clientState?.turn_history?.length ?? '?');
    return;
  }
  // Secondary: restore from disk autosave (survives process restart on persistent filesystem)
  const autosavePath = getAutosavePath(sessionId);
  try {
    await fsPromises.access(autosavePath);
    const raw = await fsPromises.readFile(autosavePath, 'utf8');
    const data = JSON.parse(raw);
    if (!data?.gameState) return;
    // v1.84.21: Restore payload archive from separate file
    try {
      const _paPath = path.join(__dirname, 'saves', sessionId, 'payload_archive.json');
      await fsPromises.access(_paPath);
      const _paRaw = await fsPromises.readFile(_paPath, 'utf8');
      data.gameState.payload_archive = JSON.parse(_paRaw);
    } catch (_) {
      data.gameState.payload_archive = data.gameState.payload_archive || {};
    }
    const logger = createLogger({ sessionId });
    sessionStates.set(sessionId, { gameState: data.gameState, isFirstTurn: false, logger, session_type: 'game', session_origin: 'autosave_restore' });
    console.log('[AUTOSAVE] Restored session', sessionId, 'from disk autosave — turn', data.gameState?.turn_history?.length ?? '?');
  } catch (_) {
    // No autosave or unreadable — fall through to normal new-session creation
  }
}

// Existing narrate endpoint begins here
app.post('/narrate', async (req, res) => {
  const sessionId = req.headers['x-session-id'];
  
  // [DIAG-2] Log incoming request header
  console.log('[DIAG-2-SERVER-REQUEST-ENTRY] req.headers["x-session-id"]:', sessionId);
  console.log('[DIAG-2-SERVER-REQUEST-ENTRY] Type:', typeof sessionId);
  console.log('[DIAG-2-SERVER-REQUEST-ENTRY] Is truthy?', !!sessionId);

  // v1.59.0: Restore from autosave before session lookup, so server restarts are transparent
  await restoreAutosaveIfAvailable(sessionId, req.body?.client_state);
  
  const { sessionId: resolvedSessionId, gameState: sessionGameState, isFirstTurn: sessionIsFirstTurn, logger } = getSessionState(sessionId);
  
  let gameState = sessionGameState;
  if (gameState && typeof gameState === 'object') delete gameState._tlsPartialStackResult;
  let isFirstTurn = sessionIsFirstTurn;
  
  const { action, intent_channel: _rawChannel, npc_target: _rawNpcTarget, WORLD_SEED: _rawWorldSeed, WORLD_PROMPT: _rawWorldPrompt } = req.body;
  const resolvedChannel = ['do', 'say'].includes(_rawChannel) ? _rawChannel : 'do';
  if (action == null) {
    return res.status(400).json({ 
      sessionId: resolvedSessionId,
      error: 'action is required' 
    });
  }

  if (gameState === null) {
    const init = initializeGame();
    gameState = init.state;
    sessionStates.set(resolvedSessionId, { gameState, isFirstTurn: true, logger });
  }

  // QA-014: Initialize turn history and begin turn scope for log capture
  if (!gameState.turn_history) {
    gameState.turn_history = [];
  }
  // v1.56.0: Initialize active_continuity field if not yet present on this gameState
  if (gameState.world && gameState.world.active_continuity === undefined) {
    NC.initContinuityState(gameState);
  }
  // v1.84.0: Birth record backward compat — old saves won't have this field
  if (gameState.player && !gameState.player.birth_record) {
    gameState.player.birth_record = { raw_input: null, created_turn: 1, form: null, location_premise: null, possessions: [], status_claims: [], scenario_notes: [], world_notes: [], canonical_name: null, title_or_role: null, starting_npc: null };
  }
  // starting_npc compat — old saves have birth_record but not this field
  if (gameState.player?.birth_record && gameState.player.birth_record.starting_npc === undefined) {
    gameState.player.birth_record.starting_npc = null;
  }
  // v1.84.19: Condition Bot backward compat — old saves won't have these fields
  if (gameState.player && !gameState.player.conditions) {
    gameState.player.conditions = [];
  }
  if (gameState.player && !gameState.player.conditions_archive) {
    gameState.player.conditions_archive = [];
  }
  // v1.84.21: Payload archive backward compat — old saves won't have this field
  if (!gameState.payload_archive) {
    gameState.payload_archive = {};
  }
  // v1.84.52: Object Reality System — initialize engine object registries on old saves
  if (!gameState.objects)       gameState.objects       = {};
  if (!gameState.object_errors) gameState.object_errors = [];
  if (!Array.isArray(gameState._rejectedCandidates)) gameState._rejectedCandidates = [];
  if (gameState.player && !Array.isArray(gameState.player.object_ids)) gameState.player.object_ids = [];
  if (gameState.world && Array.isArray(gameState.world.npcs)) {
    gameState.world.npcs.forEach(npc => { if (!Array.isArray(npc.object_ids)) npc.object_ids = []; });
    gameState.world.npcs.forEach(npc => { if (!Array.isArray(npc.associated_object_ids)) npc.associated_object_ids = []; }); // v1.88.66
  }
  // v1.84.0: NPC reputation rename — old saves used player_reputation (-25..+25); new schema uses reputation_player (0-100)
  if (gameState.world && Array.isArray(gameState.world.npcs)) {
    gameState.world.npcs.forEach(npc => {
      if (npc.player_reputation !== undefined && npc.reputation_player === undefined) {
        npc.reputation_player = Math.max(0, Math.min(100, npc.player_reputation + 50));
        delete npc.player_reputation;
      }
    });
  }
  // v1.84.0: NPC reputation rename — also remap in active_site.npcs and all sites
  if (gameState.world && gameState.world.sites) {
    for (const site of Object.values(gameState.world.sites)) {
      if (Array.isArray(site.npcs)) {
        site.npcs.forEach(npc => {
          if (npc.player_reputation !== undefined && npc.reputation_player === undefined) {
            npc.reputation_player = Math.max(0, Math.min(100, npc.player_reputation + 50));
            delete npc.player_reputation;
          }
        });
      }
    }
  }
  const turnNumber = gameState.turn_history.length + 1;
  if (logger) {
    logger.beginTurn(turnNumber, action);
  }

  const _abortTurn = (reason) => {
    const logs = logger ? logger.abortTurn(reason) : [];
    const rec = {
      turn_number: turnNumber,
      timestamp: new Date().toISOString(),
      input: { raw: action },
      intent_channel: resolvedChannel,
      npc_target: _rawNpcTarget || null,
      outcome: 'rejected',
      reason,
      logs
    };
    if (gameState.turn_history) gameState.turn_history.push(rec);
    sessionStates.set(resolvedSessionId, { ...sessionStates.get(resolvedSessionId), gameState, isFirstTurn, logger });
  };

  // =========================================================================
  // SYSTEM COMMAND DETECTION (NEW INTEGRATION POINT)
  // =========================================================================
  const sysCmd = await detectSystemCommand(action, resolvedSessionId, gameState, sessionStates);
  if (sysCmd.isSystemCommand) {
    _abortTurn('SYSTEM_COMMAND');
    return res.json({
      sessionId: resolvedSessionId,
      narrative: sysCmd.message,
      state: sysCmd.newState || gameState,
      systemCommand: true
    });
  }
  // =========================================================================
  // END SYSTEM COMMAND DETECTION
  // =========================================================================

  const restartKeywords = ["new world", "restart", "begin again"];
  const actionLower = String(action).toLowerCase();
  if (restartKeywords.some(kw => actionLower.includes(kw))) {
    _abortTurn('RESTART');
    const init = initializeGame();
    gameState = init.state;
    isFirstTurn = true;
    sessionStates.set(resolvedSessionId, { gameState, isFirstTurn });
    return res.json({
      sessionId: resolvedSessionId,
      narrative: "Describe your world in 3 sentences.",
      state: gameState,
      restart: true
    });
  }

  // --- Semantic Parser integration (Phase 2) ---
  const userInput = String(action);

  // v1.84.33 — capture verbatim Turn 1 founding input before any normalization
  if (turnNumber === 1 && gameState.player?.birth_record && !gameState.player.birth_record.raw_input) {
    gameState.player.birth_record.raw_input = userInput;
  }

  const gameContext = {
    player: gameState?.player ? {
      position: gameState.player,
      inventory: Array.isArray(gameState.player.inventory) ? gameState.player.inventory.map(i => i.name) : []
    } : null,
    current_cell: gameState?.world?.current_cell || null,
    adjacent_cells: gameState?.world?.adjacent_cells || null,
    npcs_present: Array.isArray(gameState?.world?.npcs) ? gameState.world.npcs.map(n => n.name) : []
  };
  
  // ... [REST OF EXISTING /NARRATE LOGIC REMAINS UNCHANGED] ...
  // Continue with existing SemanticParser, Engine, and DeepSeek API flow
  // (Preserving all existing code below this point)

  // v1.84.52: Object Reality debug accumulator — hoisted outside try so catch block can include it in error response
  let _objectRealityDebug = {
    ran: false,
    skip_reason: null,
    cb_candidates: [],
    cb_transfers: [],
    suppressed_replays: [],
    quarantine_size: 0,
    promoted: 0,
    transferred: 0,
    errors: 0,
    audit: [],
    error_entries: [],
    reconciliation_count: 0  // v1.85.91: ObjectRecords annotated with reconciled_from_rejection this turn
  };

  // v1.91.29: bridge _objectRealityDebug to gameState so ActionProcessor can push
  // ap_direct_transfer audit entries during Engine.buildOutput. Without this bridge,
  // the optional-chain guard in AP (state._objectRealityDebug?.audit) silently fails.
  gameState._objectRealityDebug = _objectRealityDebug;

  // v1.85.39: turn_stage SSE — parsing start
  diag.emitDiagnostics({ type: 'turn_stage', stage: 'parsing', status: 'start', turn: turnNumber, gameSessionId: resolvedSessionId });
  let parseResult = null;
  try {
    parseResult = await normalizeUserIntent(userInput, gameContext, resolvedChannel);
  } catch (e) {
    parseResult = { success: false, error: 'LLM_UNAVAILABLE', intent: null };
    console.warn('[PARSER] exception in semantic parser:', e?.message);
  }
  const _parserUsage = parseResult?.parser_usage || null;
  // v1.85.39: turn_stage SSE — parsing complete
  diag.emitDiagnostics({ type: 'turn_stage', stage: 'parsing', status: 'complete', turn: turnNumber, gameSessionId: resolvedSessionId });
  let debug = {
    parser: "none",
    input: userInput,
    channel: resolvedChannel,
    intent: (parseResult && parseResult.intent) ? parseResult.intent : null,
    confidence: (parseResult && typeof parseResult.confidence === 'number') ? parseResult.confidence : 0,
    clarification: null
  };

  // Log player action parsing
  const session = sessionStates.get(resolvedSessionId);
  if (logger && !isFirstTurn) {
    logger.playerActionParsed(userInput, {
      ...parseResult?.intent,  // Spread full intent object (includes primaryAction with dir, confidence, etc.)
      confidence: parseResult?.confidence,  // Explicit confidence from parseResult level
      success: parseResult?.success,  // Success flag
      error: parseResult?.error  // Error if any
    });
  }

  // Before-turn debug info
  const beforeCells = Object.keys(gameState?.world?.cells || {}).length;
  console.log('[turn] cells_before=', beforeCells);

  // Issue 5 — Option B: help-pattern routing with confidence threshold (Do channel, non-first turns only)
  // If confidence < 0.40 AND input looks like a help request, return an engine_message without
  // advancing turn, mutating state, or calling Engine.processTurn().
  if (!isFirstTurn && resolvedChannel === 'do' && (parseResult?.confidence ?? 1) < 0.40 && /\bhelp\b|what do i|how do i|assist/i.test(userInput)) {
    _abortTurn('HELP_REDIRECT');
    console.log('[HELP_REDIRECT] Low-confidence help-pattern input redirected from Do channel:', userInput);
    return res.json({
      sessionId: resolvedSessionId,
      engine_message: 'Use the Help bar below for questions about the world, your situation, or what you can do.',
      state: gameState,
      turn_history: gameState.turn_history
    });
  }

  // First turn: seed world using WORLD_PROMPT through Engine
  let engineOutput = null;
  let inputObj = null; // Declared in outer scope — assigned in if/else branches below
  let _enterAmbiguous = false;    // v1.85.4: true when null-target enter finds >1 enterable site
  let _preTurnLoc = null;         // v1.85.4: location fingerprint captured before Engine.buildOutput
  let _actionHadNoEffect = false; // v1.85.4: true when move/enter/exit intent produced no state change
  // Progress token + reporter — hoisted so narration/CB/Arbiter phases can push updates on Turn 1.
  // No-op on non-first turns (token is null).
  let _progToken = null;
  let _reportProgress = () => {};
  // v1.91.57: P1b hotfix — resolver evidence must be visible to common witness assembly
  let objectOperationResolverEvidence = null;
  let objectOperationResolverError = null;
  let _authorityGateWholeDropObjectId = null;
  let _tlsPartialDescriptionTarget = null;
  let _tlsPartialStackArchive = null;
  let _cbTlsPartialStackTakeReceipt = null;
  let _cbTlsPartialStackTakeReceiptState = 'empty';
  let _cbTlsPartialStackDropReceipt = null;
  let _cbTlsPartialStackDropReceiptState = 'empty';

  function _sanitizeCbTlsPartialStackDropReceipt(receipt) {
    const sourceObjectId = receipt?.source_object_id;
    const successorObjectId = receipt?.successor_object_id;
    const sourceRecord = gameState.objects?.[sourceObjectId];
    const successorRecord = gameState.objects?.[successorObjectId];
    const destinationTypes = new Set(['grid', 'localspace', 'site']);

    if (
      receipt?.schema_version !== 'cb_tls_partial_stack_drop_v1' ||
      receipt.authority !== 'tls_object_helper' ||
      receipt.operation_type !== 'tls_partial_stack_drop' ||
      receipt.status !== 'executed' ||
      receipt.actor_ref !== 'player' ||
      receipt.source_persists !== true ||
      receipt.successor_created_this_turn !== true ||
      !Number.isInteger(receipt.turn_number) || receipt.turn_number < 1 ||
      receipt.turn_number !== turnNumber ||
      typeof sourceObjectId !== 'string' || sourceObjectId.trim().length === 0 ||
      typeof successorObjectId !== 'string' || successorObjectId.trim().length === 0 ||
      sourceObjectId === successorObjectId ||
      !Number.isInteger(receipt.requested_quantity) || receipt.requested_quantity < 1 ||
      !Number.isInteger(receipt.extracted_quantity) || receipt.extracted_quantity < 1 ||
      receipt.requested_quantity !== receipt.extracted_quantity ||
      !Number.isInteger(receipt.source_quantity_before) || receipt.source_quantity_before < 1 ||
      !Number.isInteger(receipt.source_quantity_after) || receipt.source_quantity_after < 1 ||
      receipt.source_quantity_before - receipt.extracted_quantity !== receipt.source_quantity_after ||
      receipt.source_container_type !== 'player' ||
      receipt.source_container_id !== 'player' ||
      !destinationTypes.has(receipt.destination_container_type) ||
      typeof receipt.destination_container_id !== 'string' || receipt.destination_container_id.trim().length === 0 ||
      !sourceRecord || sourceRecord.status !== 'active' ||
      sourceRecord.quantity !== receipt.source_quantity_after ||
      sourceRecord.current_container_type !== receipt.source_container_type ||
      sourceRecord.current_container_id !== receipt.source_container_id ||
      !Array.isArray(gameState.player?.object_ids) || !gameState.player.object_ids.includes(sourceObjectId) ||
      !successorRecord || successorRecord.status !== 'active' ||
      successorRecord.parent_object_id !== sourceObjectId ||
      successorRecord.created_turn !== receipt.turn_number ||
      successorRecord.quantity !== receipt.extracted_quantity ||
      successorRecord.current_container_type !== receipt.destination_container_type ||
      successorRecord.current_container_id !== receipt.destination_container_id
    ) {
      return null;
    }

    return {
      schema_version: 'cb_tls_partial_stack_drop_v1',
      authority: 'tls_object_helper',
      turn_number: receipt.turn_number,
      operation_type: 'tls_partial_stack_drop',
      status: 'executed',
      actor_ref: 'player',
      source_object_id: sourceObjectId,
      source_persists: true,
      successor_object_id: successorObjectId,
      successor_created_this_turn: true,
      requested_quantity: receipt.requested_quantity,
      extracted_quantity: receipt.extracted_quantity,
      source_quantity_before: receipt.source_quantity_before,
      source_quantity_after: receipt.source_quantity_after,
      source_container_type: 'player',
      source_container_id: 'player',
      destination_container_type: receipt.destination_container_type,
      destination_container_id: receipt.destination_container_id
    };
  }

  // v1.91.10x: #24 — DROP-only quantity-one successor rename. Generates candidate
  // singular forms from bounded English rules, then only renames if the already-
  // validated command's own target text confirms the candidate — never guesses from
  // spelling alone (see IRREGULAR_PLURALS comment in ActionProcessor.js for why the
  // suffix heuristics there are unsafe for display text unconfirmed).
  function _dropSuccessorSingularCandidates(lastWord) {
    const lower = String(lastWord || '').toLowerCase();
    const candidates = new Set();
    if (Actions.IRREGULAR_PLURALS[lower]) candidates.add(Actions.IRREGULAR_PLURALS[lower]);
    if (lower.length > 3 && lower.endsWith('ies')) {
      candidates.add(lower.slice(0, -3) + 'y'); // berries -> berry
      candidates.add(lower.slice(0, -1));       // cookies -> cookie
    }
    if (
      lower.length > 3 &&
      (lower.endsWith('ches') || lower.endsWith('shes') || lower.endsWith('xes') || lower.endsWith('zes') || lower.endsWith('sses'))
    ) {
      candidates.add(lower.slice(0, -2)); // torches -> torch, glasses -> glass
    }
    if (lower.length > 3 && lower.endsWith('s') && !lower.endsWith('ss')) {
      candidates.add(lower.slice(0, -1)); // traps -> trap
    }
    return candidates;
  }

  function _matchWordCase(original, lowerReplacement) {
    const word = String(original || '');
    if (word && word === word.toUpperCase() && word !== word.toLowerCase()) {
      return lowerReplacement.toUpperCase();
    }
    if (word && word[0] === word[0].toUpperCase() && word[0] !== word[0].toLowerCase()) {
      return lowerReplacement.charAt(0).toUpperCase() + lowerReplacement.slice(1);
    }
    return lowerReplacement;
  }

  function _singularizeDropSuccessorName(name, targetText) {
    const words = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (words.length === 0 || !targetText) return { name, changed: false };
    const lastIndex = words.length - 1;
    const lastWord = words[lastIndex];
    const candidates = _dropSuccessorSingularCandidates(lastWord);
    if (candidates.size === 0) return { name, changed: false };

    const targetWords = String(targetText).trim().toLowerCase().split(/\s+/).filter(Boolean);
    const targetLastWord = targetWords[targetWords.length - 1] || '';
    if (!candidates.has(targetLastWord)) return { name, changed: false };

    const newWords = words.slice();
    newWords[lastIndex] = _matchWordCase(lastWord, targetLastWord);
    return { name: newWords.join(' '), changed: true };
  }

  // Pure reroute decision for a TAKE misclassified as partial-stack whose resolver
  // evidence proves the effective quantity is the entire available stack. No closure
  // dependencies — takes the intent, resolver evidence, and live gameState directly,
  // and returns a boolean only. The caller owns the actual mutation (clearing
  // selection_mode / nulling the evidence) at the existing live call site; this
  // function performs no mutation itself.
  function _shouldNormalizeExactStackTake(playerIntent, resolverEvidence, gameState) {
    if (
      playerIntent?.operation_family !== 'take' ||
      playerIntent?.selection_mode !== 'partial_from_stack' ||
      resolverEvidence?.resolution_basis !== 'model_selected' ||
      resolverEvidence?.fail_closed_reason != null ||
      resolverEvidence?.requested_vs_available !== 'exact_stack'
    ) {
      return false;
    }
    const source = gameState.objects?.[resolverEvidence.source_object_id];
    return (
      source?.status === 'active' &&
      Number.isInteger(source.quantity) &&
      source.quantity === resolverEvidence.source_quantity_before &&
      source.current_container_type === resolverEvidence.source_container_type &&
      source.current_container_id === resolverEvidence.source_container_id &&
      Number.isInteger(resolverEvidence.effective_requested_quantity) &&
      resolverEvidence.effective_requested_quantity > 0 &&
      resolverEvidence.effective_requested_quantity === resolverEvidence.source_quantity_before
    );
  }

  function _captureCbTlsPartialStackDropReceipt(splitResult, predictedCall) {
    if (_cbTlsPartialStackDropReceiptState !== 'empty') {
      _cbTlsPartialStackDropReceiptState = 'rejected';
      _cbTlsPartialStackDropReceipt = null;
      return null;
    }

    const _rejectReceipt = () => {
      _cbTlsPartialStackDropReceiptState = 'rejected';
      _cbTlsPartialStackDropReceipt = null;
      return null;
    };
    const predictedParams = predictedCall?.parameters;

    if (
      splitResult?.ok !== true ||
      splitResult.reason !== 'tls_partial_stack_drop' ||
      predictedCall?.method !== 'splitObjectDirect' ||
      !predictedParams ||
      splitResult.source_object_id !== predictedParams.source_object_id ||
      splitResult.requested_quantity !== predictedParams.extract_quantity ||
      splitResult.applied_quantity !== predictedParams.extract_quantity ||
      splitResult.dest_container_type !== predictedParams.destination_container_type ||
      splitResult.dest_container_id !== predictedParams.destination_container_id
    ) {
      return _rejectReceipt();
    }

    const sanitizedReceipt = _sanitizeCbTlsPartialStackDropReceipt({
      schema_version: 'cb_tls_partial_stack_drop_v1',
      authority: 'tls_object_helper',
      turn_number: turnNumber,
      operation_type: 'tls_partial_stack_drop',
      status: 'executed',
      actor_ref: 'player',
      source_object_id: splitResult.source_object_id,
      source_persists: true,
      successor_object_id: splitResult.successor_object_id,
      successor_created_this_turn: true,
      requested_quantity: splitResult.requested_quantity,
      extracted_quantity: splitResult.applied_quantity,
      source_quantity_before: splitResult.source_quantity_before,
      source_quantity_after: splitResult.source_quantity_after,
      source_container_type: 'player',
      source_container_id: 'player',
      destination_container_type: splitResult.dest_container_type,
      destination_container_id: splitResult.dest_container_id
    });
    if (!sanitizedReceipt) return _rejectReceipt();

    _cbTlsPartialStackDropReceipt = sanitizedReceipt;
    _cbTlsPartialStackDropReceiptState = 'accepted';
    return _cbTlsPartialStackDropReceipt;
  }

  function _captureCbTlsPartialStackTakeReceipt(splitResult) {
    if (_cbTlsPartialStackTakeReceiptState !== 'empty') {
      _cbTlsPartialStackTakeReceiptState = 'rejected';
      _cbTlsPartialStackTakeReceipt = null;
      return null;
    }

    const _rejectReceipt = () => {
      _cbTlsPartialStackTakeReceiptState = 'rejected';
      _cbTlsPartialStackTakeReceipt = null;
      return null;
    };
    const sourceObjectId = splitResult?.source_object_id;
    const successorObjectId = splitResult?.successor_object_id;
    const sourceRecord = gameState.objects?.[sourceObjectId];
    const successorRecord = gameState.objects?.[successorObjectId];

    if (
      splitResult?.ok !== true ||
      splitResult.reason !== 'tls_partial_stack_take' ||
      !Number.isInteger(turnNumber) || turnNumber < 1 ||
      typeof sourceObjectId !== 'string' || sourceObjectId.trim().length === 0 ||
      typeof successorObjectId !== 'string' || successorObjectId.trim().length === 0 ||
      sourceObjectId === successorObjectId ||
      !Number.isInteger(splitResult.applied_quantity) || splitResult.applied_quantity < 1 ||
      !Number.isInteger(splitResult.source_quantity_before) ||
      !Number.isInteger(splitResult.source_quantity_after) ||
      splitResult.source_quantity_before - splitResult.applied_quantity !== splitResult.source_quantity_after ||
      splitResult.source_quantity_after < 1 ||
      !sourceRecord || sourceRecord.status !== 'active' ||
      !successorRecord || successorRecord.status !== 'active' ||
      sourceRecord.quantity !== splitResult.source_quantity_after ||
      successorRecord.parent_object_id !== sourceObjectId ||
      successorRecord.created_turn !== turnNumber ||
      successorRecord.quantity !== splitResult.applied_quantity ||
      successorRecord.current_container_type !== splitResult.dest_container_type ||
      successorRecord.current_container_id !== splitResult.dest_container_id ||
      splitResult.dest_container_type !== 'player' ||
      splitResult.dest_container_id !== 'player'
    ) {
      return _rejectReceipt();
    }

    _cbTlsPartialStackTakeReceipt = {
      schema_version: 'cb_tls_partial_stack_take_v1',
      authority: 'tls_object_helper',
      turn_number: turnNumber,
      operation_type: 'tls_partial_stack_take',
      status: 'executed',
      actor_ref: 'player',
      source_object_id: sourceObjectId,
      source_persists: true,
      successor_object_id: successorObjectId,
      successor_created_this_turn: true,
      extracted_quantity: splitResult.applied_quantity,
      destination_container_type: 'player',
      destination_container_id: 'player'
    };
    _cbTlsPartialStackTakeReceiptState = 'accepted';
    return _cbTlsPartialStackTakeReceipt;
  }

  // v1.91.62: P2 — TLS v1 instruction assembly (pre-AP, observe-only, diagnostic only).
  // Consumes resolver evidence + parser actions to produce a source-authoritative
  // tls_ors_instruction_v1. Pure function — no state access, no ObjectHelper calls.
  // Returns null when resolver evidence is absent; returns disabled instruction
  // when trust gate or routing blocks execution.
  function _assembleTlsInstructionV1(resolverEvidence, resolverError, actions, state) {
    // ── Null gate: P2 not applicable if no resolver evidence ──────────────────
    if (!resolverEvidence) return null;

    // ── Trust gate: resolver must have selected a source ──────────────────────
    const actionFamily = actions.operation_family || 'take';
    const evidenceFamily = resolverEvidence.operation_family || 'take';
    const familyMatches = actionFamily === evidenceFamily;
    const trusted = (
      familyMatches &&
      resolverEvidence.resolution_basis === 'model_selected' &&
      resolverEvidence.source_object_id !== null &&
      resolverEvidence.fail_closed_reason === null
    );

    // ── Quantity sanitation ──────────────────────────────────────────────────
    const parserRequestedQty = actions.requested_quantity ?? null;
    const requestedQty = Number.isInteger(resolverEvidence.effective_requested_quantity) &&
                         resolverEvidence.effective_requested_quantity >= 1
      ? resolverEvidence.effective_requested_quantity : null;
    const availableQty = typeof resolverEvidence.source_quantity_before === 'number' &&
                         resolverEvidence.source_quantity_before >= 1
      ? resolverEvidence.source_quantity_before : null;
    const destinationType = resolverEvidence.intended_destination_type || null;
    const destinationId = resolverEvidence.intended_destination_id || null;

    // ── Sanity checks against live ORS record ────────────────────────────────
    const orsRecord = state?.objects?.[resolverEvidence.source_object_id];
    const orsActive     = orsRecord && orsRecord.status === 'active';
    const orsQuantityOk = availableQty !== null &&
      typeof orsRecord?.quantity === 'number' &&
      orsRecord.quantity === availableQty;
    const orsContainerOk = (
      String(orsRecord?.current_container_type || '') ===
      String(resolverEvidence.source_container_type || '')
    ) && (
      String(orsRecord?.current_container_id || '') ===
      String(resolverEvidence.source_container_id || '')
    );

    // ── Warning collector ────────────────────────────────────────────────────
    const warnings = [];
    const pushW = (code, severity, field, message) =>
      warnings.push({ code, severity, field, message, detail: null });

    // ── Blocking checks ──────────────────────────────────────────────────────
    if (!familyMatches)
      pushW('operation_family_mismatch', 'blocking', 'operation_family',
        'Parser action family does not match resolver evidence family.');
    if (!trusted)
      pushW('resolver_untrusted', 'blocking', 'resolution_basis',
        'Resolver did not produce trusted source evidence.');
    if (requestedQty === null)
      pushW('missing_requested_quantity', 'blocking', 'requested_quantity',
        'Requested quantity is missing, NaN, or less than 1.');
    if (availableQty === null)
      pushW('missing_available_quantity', 'blocking', 'source_quantity_before',
        'Available source quantity is missing, NaN, or less than 1.');
    if (!destinationType || !destinationId)
      pushW('missing_destination', 'blocking', 'intended_destination_id',
        'Resolver did not produce a complete policy destination.');
    if (trusted && !orsActive)
      pushW('source_inactive', 'blocking', 'source_object_id',
        'Source object is not active in ORS registry.');
    if (trusted && orsActive && !orsQuantityOk)
      pushW('quantity_mismatch', 'blocking', 'source_quantity_before',
        'Resolver quantity does not match current ORS record quantity.');
    if (trusted && orsActive && !orsContainerOk)
      pushW('container_mismatch', 'blocking', 'source_container_type',
        'Resolver container does not match current ORS record container.');

    // ── Deterministic routing computation ────────────────────────────────────
    let requestedVsAvailable = null;
    if (requestedQty !== null && availableQty !== null) {
      if (requestedQty < availableQty)       requestedVsAvailable = 'partial';
      else if (requestedQty === availableQty) requestedVsAvailable = 'exact_stack';
      else                                    requestedVsAvailable = 'over_stack';
    }

    const routingBlocked = (
      !trusted ||
      requestedQty === null ||
      availableQty === null ||
      !destinationType ||
      !destinationId ||
      requestedVsAvailable === 'over_stack' ||
      !orsActive ||
      (orsActive && (!orsQuantityOk || !orsContainerOk))
    );

    let intendedMutation = null;
    let failClosedReason = null;
    if (requestedVsAvailable === 'partial') {
      intendedMutation = 'partial_split';
    } else if (requestedVsAvailable === 'exact_stack') {
      intendedMutation = 'whole_transfer';
    } else if (requestedVsAvailable === 'over_stack') {
      intendedMutation = 'fail_closed';
      failClosedReason = 'over_stack';
    } else {
      intendedMutation = 'fail_closed';
      failClosedReason = 'invalid_quantity';
    }

    if (routingBlocked && failClosedReason === null) {
      intendedMutation = 'fail_closed';
      if (!familyMatches)                     failClosedReason = 'operation_family_mismatch';
      else if (!trusted)                      failClosedReason = 'resolver_untrusted';
      else if (requestedQty === null)         failClosedReason = 'invalid_quantity';
      else if (availableQty === null)         failClosedReason = 'invalid_quantity';
      else if (!destinationType || !destinationId) failClosedReason = 'invalid_destination';
      else if (!orsActive)                    failClosedReason = 'source_inactive';
      else if (!orsQuantityOk)                failClosedReason = 'internal_inconsistency';
      else if (!orsContainerOk)               failClosedReason = 'internal_inconsistency';
    }

    // ── Advisory warnings ────────────────────────────────────────────────────
    if (resolverEvidence.resolution_basis === 'ambiguous')
      pushW('ambiguous_resolver', 'advisory', 'resolution_basis',
        'Resolver reported ambiguous match among candidates.');
    if (resolverEvidence.resolution_confidence < 0.5)
      pushW('low_resolution_confidence', 'advisory', 'resolution_confidence',
        `Resolver reported low confidence (${resolverEvidence.resolution_confidence}).`);

    // Accumulate resolver's own warnings
    if (Array.isArray(resolverEvidence.resolution_warnings)) {
      for (const rw of resolverEvidence.resolution_warnings) {
        if (rw && typeof rw === 'object') {
          warnings.push({
            code: String(rw.code || 'resolver_warning'),
            severity: rw.severity === 'blocking' ? 'blocking' : 'advisory',
            field: rw.field || null,
            message: String(rw.message || ''),
            detail: null
          });
        }
      }
    }

    // ── Executor parameters (by method) ──────────────────────────────────────
    let expectedHelperMethod = null;
    let executorParams        = null;
    if (intendedMutation === 'partial_split') {
      expectedHelperMethod = 'splitObjectDirect';
      executorParams = {
        source_object_id:           resolverEvidence.source_object_id,
        extract_quantity:           requestedQty,
        destination_container_type: destinationType,
        destination_container_id:   destinationId
      };
    } else if (intendedMutation === 'whole_transfer') {
      expectedHelperMethod = 'transferObjectDirect';
      executorParams = {
        object_id:                   resolverEvidence.source_object_id,
        destination_container_type: destinationType,
        destination_container_id:   destinationId
      };
    }

    // ── Operation family / type ──────────────────────────────────────────────
    const operationFamily = actionFamily;
    const operationType = intendedMutation === 'partial_split'
      ? 'partial_object_transfer'
      : intendedMutation === 'whole_transfer'
        ? 'whole_object_transfer' : null;

    // ── Build and return ─────────────────────────────────────────────────────
    return {
      schema_version: 'tls_ors_instruction_v1',
      operation_family: operationFamily,
      operation_type:   operationType,

      object: {
        id:   trusted ? resolverEvidence.source_object_id   : null,
        name: trusted ? resolverEvidence.source_object_name : null,
        source_basis: 'resolver_evidence_v1'
      },

      source: {
        container_type: trusted ? resolverEvidence.source_container_type : null,
        container_id:   trusted ? resolverEvidence.source_container_id   : null,
        source_basis:   'resolver_evidence_v1'
      },

      destination: {
        container_type: destinationType,
        container_id:   destinationId,
        owner_type:     destinationType === 'player' ? 'player' : 'world'
      },

      quantity: {
        requested_quantity:        requestedQty,
        parser_requested_quantity: parserRequestedQty,
        effective_quantity_basis:  resolverEvidence.effective_quantity_basis ?? null,
        quantity_mode:             actions.quantity_mode ?? 'unspecified',
        observed_available_quantity: availableQty,
        unit:                      resolverEvidence.source_unit ?? null
      },

      routing: {
        requested_vs_available: requestedVsAvailable,
        intended_mutation:      intendedMutation,
        fail_closed_reason:     failClosedReason,
        deterministic:          true
      },

      mutation: {
        requires_fission:  intendedMutation === 'partial_split',
        requires_transfer: intendedMutation === 'whole_transfer' || intendedMutation === 'partial_split',
        retires_source:    false,
        creates_successor: intendedMutation === 'partial_split'
      },

      execution: {
        mode:               'observe_only',
        allowed_to_execute: false,
        refusal_reason:     routingBlocked ? 'routing_fail_closed' : 'observe_only',
        gate_decision:      routingBlocked ? 'blocked' : 'observe_only'
      },

      executor: {
        expected_helper_method: expectedHelperMethod,
        parameters:             executorParams
      },

      warnings: warnings,
      provenance: {
        evidence_source:          resolverEvidence.evidence_source ?? 'llm_model',
        provider:                 resolverEvidence.provider ?? null,
        resolver_kind:            resolverEvidence.resolver_kind ?? null,
        resolution_basis:         resolverEvidence.resolution_basis ?? null,
        resolution_confidence:    resolverEvidence.resolution_confidence ?? 0,
        candidate_count:          resolverEvidence.candidate_count ?? 0,
        candidate_ids_sent:       resolverEvidence.candidate_ids_sent ?? [],
        candidate_ids_considered: resolverEvidence.candidate_ids_considered ?? null,
        reasoning_summary:        resolverEvidence.reasoning_summary ?? null,
        fail_closed_reason:       resolverEvidence.fail_closed_reason ?? null,
        validation_errors:        resolverEvidence.validation_errors ?? [],
        resolver_error:           resolverError ?? null
      }
    };
  }

  if (isFirstTurn === true) {
    isFirstTurn = false;
    const _sessionType = (req.headers['x-progress-token'] || req.headers['x-mother-brain'] === 'true') ? 'game' : 'probe';
    const _sessionOrigin = req.headers['x-progress-token'] ? 'browser' : req.headers['x-mother-brain'] === 'true' ? 'mother_brain' : 'probe';
    sessionStates.set(resolvedSessionId, { gameState, isFirstTurn, logger, session_type: _sessionType, session_origin: _sessionOrigin });
    inputObj = mapActionToInput(action, "WORLD_PROMPT");
    inputObj.player_intent.channel = 'do';
    if (_rawWorldSeed != null && Number.isFinite(Number(_rawWorldSeed))) inputObj.WORLD_SEED = Number(_rawWorldSeed);
    // Use explicit WORLD_PROMPT from request body when present (e.g. harness sends founding premise
    // separately from the T1 action). Browser path: no body WORLD_PROMPT → action is the founding
    // premise, mapActionToInput already set it correctly. Harness path: action = "look around",
    // body WORLD_PROMPT = "I am standing inside a tavern" → override so worldgen sees the real premise.
    if (_rawWorldPrompt != null) inputObj.WORLD_PROMPT = String(_rawWorldPrompt);
    
    if (logger) logger.worldPromptReceived(inputObj.WORLD_PROMPT);
    
    // Worldgen log — accumulated during this init sequence, frozen after Engine.buildOutput().
    const _worldgenLog = [];
    const _wLogT0 = Date.now();
    const _wLog = (pass, step, data) => _worldgenLog.push({ pass, step, data, ms: Date.now() - _wLogT0 });

    // Progress token — sent by client via x-progress-token header (pre-issued by GET /narrate/session-token)
    _progToken = req.headers['x-progress-token'] || null;
    _reportProgress = (step, pct, detail = {}) => _pushProgress(_progToken, step, pct, detail);

    let startAnchor = null;        // hoisted — referenced by worldgen summary block outside if(worldData)
    let _sitePlacementLog = null;  // hoisted — frozen to gameState after patch+spacing pass
    try {
      // Handle async world generation with DeepSeek biome detection
      if (inputObj.WORLD_PROMPT && !gameState?.world?.macro_biome) {
        _reportProgress('analyzing', 2, { prompt: (inputObj.WORLD_PROMPT || '').slice(0, 40) });
        _wLog('init', 'world_description_analysis', { prompt: (inputObj.WORLD_PROMPT || '').slice(0, 80) });
        const worldData = await WorldGen.generateWorldFromDescription(inputObj.WORLD_PROMPT, inputObj.WORLD_SEED ?? gameState.rng_seed ?? 0);
        if (worldData) {
          gameState.world.macro_biome = worldData.biome;
          gameState.world.world_tone = worldData.worldTone;  // NEW: Store semantic tone
          gameState.world.starting_location_type = worldData.startingLocationType;  // NEW: Store semantic starting location
          gameState.world.macro_palette = worldData.palette;
          gameState.world.seed = worldData.seed;
          gameState.world.l0_size = worldData.l0_size;
          gameState.world.cells = worldData.cells;
          if (!gameState.world.sites) gameState.world.sites = worldData.sites;
          // Phase 1: Persist generation bias and expressive context — frozen after this point
          gameState.world.world_bias    = worldData.world_bias;
          gameState.world.world_context = worldData.world_context;
          gameState.world.start_container = worldData.start_container || 'L0';
          // Approach C: Store founding prompt for identity alignment — natural language, not a classification
          gameState.world.founding_prompt = inputObj.WORLD_PROMPT;
          // v1.85.83 — overwrite raw_input with founding_prompt so CB PRIMARY SOURCE reads the actual premise.
          // founding_prompt is authoritative; raw_input may have been set to the T1 action before worldgen ran.
          if (gameState.player?.birth_record) gameState.player.birth_record.raw_input = gameState.world.founding_prompt;
          _wLog('init', 'world_profile', { biome: worldData.biome, tone: worldData.worldTone, macro_palette: worldData.palette });
          _reportProgress('world_profile', 8, { biome: worldData.biome });

          // Phase 3: Seed-derived terrain patch and start position
          _wLog('pass1+2', 'terrain_patch_start', { anchor: WorldGen.selectStartAnchor(WorldGen.h32(inputObj.WORLD_PROMPT)), biome: worldData.biome });
          _reportProgress('terrain_patch', 12, { biome: worldData.biome });
          const phase3Seed = WorldGen.h32(inputObj.WORLD_PROMPT);
          startAnchor = WorldGen.selectStartAnchor(phase3Seed); // assigns hoisted let
          const patchCells  = WorldGen.generateTerrainPatch(startAnchor, worldData.biome, phase3Seed, gameState.world.cells);
          Object.assign(gameState.world.cells, patchCells);
          _wLog('pass1+2', 'terrain_patch_complete', { cell_count: Object.keys(patchCells).length });
          gameState.world.position = WorldGen.selectStartPosition(phase3Seed, worldData.world_bias, patchCells, startAnchor);
          // B1: sync player container to world start position — must happen before first narration
          if (gameState.player) {
            gameState.player.position = { ...gameState.world.position, x: null, y: null };
          }
          _reportProgress('patch_complete', 18, { startPos: gameState.world.position });
          // Phase 4A: persist seed so Engine.js can use it for deterministic site generation
          gameState.world.phase3_seed = phase3Seed;
          console.log('[PHASE3] anchor=', startAnchor, '| start=', gameState.world.position, '| patch cells=', Object.keys(patchCells).length);

          // Phase 4D: seed patch cells with sites (bypass streaming hook — patch cells pre-exist)
          let _totalPatchSites = 0;
          for (const [patchKey, patchCell] of Object.entries(patchCells)) {
            const patchSites = WorldGen.evaluateCellForSites(patchKey, patchCell.type, worldData.world_bias, phase3Seed);
            for (const pSite of patchSites) {
              pSite.created_at_turn = gameState.turn_counter ?? 0;
              Engine.recordSiteToCell(gameState, patchKey, pSite);
            }
            _totalPatchSites += patchSites.length;
          }
          _wLog('sites', 'patch_sites_seeded', { total_sites: _totalPatchSites });

          // Site placement post-pass: enforce large-site (size 8-10) spacing within each macro cell.
          // Iterates all placed slots globally; removes any large site that is 8-directionally adjacent
          // to another large site in the same macro cell. Removed slots are discarded from cell.sites.
          let _spacingRejections = 0;
          const _allPlacedSites = [];
          for (const [_ck, _cc] of Object.entries(gameState.world.cells || {})) {
            for (const _sl of Object.values(_cc.sites || {})) {
              _allPlacedSites.push(_sl);
            }
          }
          // Build accepted set using greedy first-wins ordering
          const _accepted = [];
          for (const _cand of _allPlacedSites) {
            if (WorldGen.largeSiteSpacingViolation(_accepted, _cand)) {
              // Remove from parent cell
              const _parentCell = gameState.world.cells[_cand.parent_cell];
              if (_parentCell && _parentCell.sites) {
                delete _parentCell.sites[_cand.site_id];
              }
              _spacingRejections++;
            } else {
              _accepted.push(_cand);
            }
          }

          // Build site placement summary log
          const _sizeCounts = {};
          for (let _sz = 1; _sz <= 10; _sz++) _sizeCounts[_sz] = 0;
          let _totalEnterable = 0;
          let _totalNonEnterable = 0;
          const _placedSitesList = [];
          for (const _sl of _accepted) {
            _sizeCounts[_sl.site_size] = (_sizeCounts[_sl.site_size] || 0) + 1;
            if (_sl.enterable) _totalEnterable++; else _totalNonEnterable++;
            _placedSitesList.push({
              site_id:      _sl.site_id,
              parent_cell:  _sl.parent_cell,
              site_size:    _sl.site_size,
              enterable:    _sl.enterable,
              is_community: _sl.is_community,
            });
          }
          const _totalAccepted = _accepted.length;
          const _sizePercentages = {};
          for (let _sz = 1; _sz <= 10; _sz++) {
            _sizePercentages[_sz] = _totalAccepted > 0
              ? Math.round((_sizeCounts[_sz] / _totalAccepted) * 1000) / 10
              : 0;
          }
          _sitePlacementLog = {
            total_cells_evaluated: Object.keys(patchCells).length,
            total_sites_placed:    _totalAccepted,
            total_enterable:       _totalEnterable,
            total_non_enterable:   _totalNonEnterable,
            size_counts:           _sizeCounts,
            size_percentages:      _sizePercentages,
            target_size_weights:   { 1: 24, 2: 20, 3: 16, 4: 12, 5: 9, 6: 7, 7: 5, 8: 3.5, 9: 2, 10: 1.5 },
            spacing_rejections:    _spacingRejections,
            placed_sites:          _placedSitesList,
          };
          _wLog('sites', 'placement_pass_complete', { accepted: _totalAccepted, spacing_rejections: _spacingRejections });
          _reportProgress('site_seeding', 12, { sites: _totalAccepted, spacing_rejections: _spacingRejections });
          
          if (logger) {
            logger.biomeDetected(worldData.biome);
            logger.toneDetected(worldData.worldTone);
            logger.locationTypeDetected(worldData.startingLocationType);
            logger.worldInitialized(worldData.seed, worldData.biome);
          }
          
          console.log('[NARRATE] First turn: Set biome to', worldData.biome, '| Tone:', worldData.worldTone, '| Starting location:', worldData.startingLocationType);
          
          // Phase 6B: Fix start cell — preserve geographic type from patch; inject site record.
          // The patch cells were seeded by Phase 4D above. We must NOT overwrite cell.type with
          // "community" or destroy the sites that evaluateCellForSites already placed.
          const startPos = gameState.world.position || { mx: 0, my: 0, lx: 6, ly: 6 };
          const startingLocationCellKey = `LOC:${startPos.mx},${startPos.my}:${startPos.lx},${startPos.ly}`;
          const _existingPatchCell = gameState.world.cells[startingLocationCellKey] || {};

          // Re-write cell: geographic type from patch (never a community type), preserve any existing sites
          gameState.world.cells[startingLocationCellKey] = {
            type: _existingPatchCell.type || 'plains',      // geographic — from patch or fallback
            subtype: _existingPatchCell.subtype || '',      // terrain refinement only — never civilization
            biome: worldData.biome,
            mx: startPos.mx,
            my: startPos.my,
            lx: startPos.lx,
            ly: startPos.ly,
            description: _existingPatchCell.description || '',
            starting_location_hint: worldData.startingLocationType, // civilization context — NOT a terrain field
            is_starting_location: true,
            // Pass 1: preserve noise fields from patch cell — must not be dropped on rewrite
            elevation:   _existingPatchCell.elevation   ?? null,
            moisture:    _existingPatchCell.moisture    ?? null,
            temperature: _existingPatchCell.temperature ?? null,
            sites: _existingPatchCell.sites || {}           // preserve any sites from Phase 4D
          };
          console.log('[WORLD] [Phase6B] Start cell type preserved as geographic:', gameState.world.cells[startingLocationCellKey].type, '| locationType:', worldData.startingLocationType);

          // Ensure the starting place has an enterable site record.
          // For non-L0 starts: always inject — AI-inferred scale drives site_size directly.
          // For L0 starts: only inject if Phase 4D left no enterable site (existing behavior).
          const _startCtx = worldData.start_context || { container: 'L0', scale: null, local_space_purpose: null };
          const _isNonL0Start = gameState.world.start_container !== 'L0';
          const _startCellSites = Object.values(gameState.world.cells[startingLocationCellKey].sites);
          const _hasEnterableSite = _startCellSites.some(s => s.enterable === true && s.interior_key);
          if (_isNonL0Start || !_hasEnterableSite) {
            const _startSiteId = `M${startPos.mx}x${startPos.my}:site_start`;
            const _civPresence = gameState.world.world_bias?.civilization_presence || 'medium';
            let _siteSize;
            if (_isNonL0Start && _startCtx.scale != null) {
              // AI-inferred scale is the authoritative source for non-L0 starts.
              // Provisional: fallback sizing below is used only when AI returned null.
              _siteSize = _startCtx.scale;
            } else {
              // Fallback: civPresence-based probabilistic sizing (L0 injection or AI-unavailable).
              const _commHash = WorldGen.h32(`${startingLocationCellKey}|start|community`);
              const _commProb = _civPresence === 'high' ? 0.70 : _civPresence === 'medium' ? 0.45 : 0.15;
              const _isCommunity = (_commHash % 1000) / 1000 < _commProb;
              const _szHash = WorldGen.h32(`${startingLocationCellKey}|start|site_size`);
              const _szRoll = (_szHash % 1000) / 1000;
              const _szMin = _civPresence === 'high' ? 3 : 2;
              const _szMax = _civPresence === 'high' ? 10 : _civPresence === 'medium' ? 7 : 4;
              _siteSize = _isCommunity
                ? Math.max(_szMin, Math.min(_szMax, _szMin + Math.floor(_szRoll * (_szMax - _szMin + 1))))
                : Math.max(1, Math.min(3, 1 + Math.floor(_szRoll * 3)));
            }
            Engine.recordSiteToCell(gameState, startingLocationCellKey, {
              site_id:          _startSiteId,
              parent_cell:      startingLocationCellKey,
              l0_ref:           { mx: startPos.mx, my: startPos.my, lx: startPos.lx, ly: startPos.ly },
              enterable:        true,
              is_community:     _isNonL0Start ? (_siteSize >= 4) : false,
              site_size:        _siteSize,
              is_filled:        false,
              created_at_turn:  gameState.turn_counter ?? 0,
              name:             null,
              description:      null,
              entered:          false,
              interior_key:     null,
              is_starting_location: true,
            });
            gameState.world.start_site_id = _startSiteId;
            console.log(`[WORLD] [Phase6B] Injected starting site: ${_startSiteId} | site_size=${_siteSize} | non-L0=${_isNonL0Start}`);
          } else {
            console.log('[WORLD] [Phase6B] L0 start — enterable site present from Phase 4D, skipped injection.');
          }

          _wLog('init', 'start_cell_resolved', {
            mx: startPos.mx, my: startPos.my, lx: startPos.lx, ly: startPos.ly,
            type: gameState.world.cells[startingLocationCellKey]?.type || '(unknown)'
          });

          // Phase obs: Pre-generate the full 128×128 starting macro cell.
          // Executed AFTER Phase 6B so the skip guard in generateFullMacroCell
          // protects the patch cells and the start cell from being overwritten.
          console.log('[WORLDGEN] Generating full 128×128 macro cell + hydrology...');
          const { cells: _fullMacroCellsObj, hydrologyStats: _hydroStats } = WorldGen.generateFullMacroCell(
            startAnchor.mx, startAnchor.my, worldData.biome, phase3Seed,
            gameState.world.cells, _reportProgress, worldData.hydro_strength || 0
          );
          Object.assign(gameState.world.cells, _fullMacroCellsObj);
          _wLog('pass1+2', 'full_macro_cell_generated', {
            new_cells: Object.keys(_fullMacroCellsObj).length,
            total_world_cells: Object.keys(gameState.world.cells).length
          });
          if (_hydroStats) {
            _wLog('pass0', 'elevation_structure', {
              massifCount: _hydroStats.massifCount,
              basinCount:  _hydroStats.basinCount,
              features:    _hydroStats.elevStructureFeatures,
            });
            _wLog('pass1', 'moisture_structure', {
              wetZoneCount: _hydroStats.wetZoneCount,
              dryZoneCount: _hydroStats.dryZoneCount,
              zones:        _hydroStats.moistZones,
            });
            _wLog('pass2', 'terrain_distribution', {
              terrainBreakdown: _hydroStats.terrainBreakdown,
              avgElev:          _hydroStats.avgElev,
              avgMois:          _hydroStats.avgMois,
              coarseGrid:       _hydroStats.coarseGridLog,
            });
            _wLog('pass3', 'hydrology', _hydroStats);
          }
          console.log('[WORLDGEN] Full macro cell complete:', Object.keys(_fullMacroCellsObj).length,
            'new cells | rivers:', _hydroStats?.riverCount, '| lakes:', _hydroStats?.lakeBasins);
          _reportProgress('start_site', 50, { container: gameState.world.start_container });

          // Phase 7: Legacy L2 stub block removed.
          // recordSiteToCell now stores the stub under the canonical site.interior_key.

          // [START-SLOT] Single authoritative starting site slot lookup.
          // Both [L2-START-SITE-FILL] and start-container routing blocks MUST use this variable.
          // Never recompute independently — any divergence here is a bug.
          const _startSlotPos     = gameState.world.position || { mx: 0, my: 0, lx: 6, ly: 6 };
          const _startSlotCellKey = `LOC:${_startSlotPos.mx},${_startSlotPos.my}:${_startSlotPos.lx},${_startSlotPos.ly}`;
          const _startSlotCell    = gameState.world.cells?.[_startSlotCellKey];
          const _startSlotCandidates = _startSlotCell
            ? Object.values(_startSlotCell.sites || {}).filter(s => s.enterable === true)
            : [];
          if (_startSlotCandidates.length > 1) {
            console.warn(`[START-SLOT] Multiple enterable sites at start position — using first. count=${_startSlotCandidates.length}`);
          }
          const _startSlot = _startSlotCandidates[0] || null;

          // [L2-START-SITE-FILL] Pre-activation DeepSeek fill for L2-direct-start sessions.
          // Fires before enterSite so the site is fully populated before any system consumes it.
          // Fills name, description, identity on the canonical slot. All three are required.
          // On any failure: hard block — no partial writes, no fallback naming.
          if (gameState.world.start_container === 'L2' && _startSlot &&
              (_startSlot.name === null || _startSlot.description === null || _startSlot.identity === null)) {
            const _lssRawContext = gameState.world.founding_prompt || gameState.player.birth_record?.raw_input || null;
            // v1.84.39: premise identifies the LOCAL SPACE (the establishment), not the site.
            // Reframe as exclusionary directive so DS generates the surrounding area instead.
            const _lssFoundingClause = _lssRawContext
              ? `The player begins inside a specific establishment: "${_lssRawContext}". ` : '';
            const _lssPurpose = _startCtx?.local_space_purpose || null;
            const _lssBiome   = gameState.world.macro_biome || 'unknown';
            const _lssExclusionNote = _lssRawContext
              ? `\n\nGenerate the CONTAINING SITE — the surrounding area that holds this kind of establishment alongside other locations. The site name must describe this broader area, NOT the establishment itself. The establishment will be placed as a local space inside the site.`
              : '';
            const _lssPrompt  = `${_lssFoundingClause}Biome: ${_lssBiome}.${_lssPurpose ? ` Site purpose: ${_lssPurpose}.` : ''} Site size: ${_startSlot.site_size ?? 'unknown'}.${_lssExclusionNote}\n\nReturn ONLY a single JSON object. No prose, no markdown. Required fields — all mandatory, none may be null or omitted:\n{"name":"<short proper name for this place>","description":"<one sentence describing it>","identity":"<short lowercase descriptor of the surrounding area>"}`;
            try {
              const _lssResp = await axios.post('https://api.deepseek.com/v1/chat/completions', {
                model: 'deepseek-v4-flash',
                thinking: { type: 'disabled' },
                messages: [{ role: 'user', content: _lssPrompt }],
                temperature: 0.4
              }, {
                headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
                httpsAgent: _sharedHttpsAgent,
                timeout: 30000
              });
              let _lssRaw = _lssResp?.data?.choices?.[0]?.message?.content || '';
              let _lssParsed = null;
              try { _lssParsed = JSON.parse(_lssRaw); } catch (_) {
                const _lssBracket = _lssRaw.match(/\{[\s\S]*\}/);
                if (_lssBracket) { try { _lssParsed = JSON.parse(_lssBracket[0]); } catch (_) {} }
              }
              if (!_lssParsed || typeof _lssParsed !== 'object') {
                console.warn('[L2-START-SITE-FILL] ERROR: parse_failure — response not valid JSON');
                if (!gameState.world._fillLog) gameState.world._fillLog = [];
                gameState.world._fillLog.push({ ts: new Date().toISOString(), type: 'site', error_label: 'parse_failed', affected_id: _startSlot.site_id });
                if (gameState.world._fillLog.length > 10) gameState.world._fillLog.shift();
                return res.json({ sessionId: resolvedSessionId, error: 'site_fill_failed', narrative: 'The world is being prepared. Please try again.', state: gameState });
              }
              const _lssMissingFields = ['name','description','identity'].filter(f => !_lssParsed[f]);
              if (_lssMissingFields.length > 0) {
                if (_lssMissingFields.includes('identity')) {
                  console.warn(`[L2-START-SITE-FILL] ERROR: missing_identity — identity field absent or null`);
                }
                console.warn(`[L2-START-SITE-FILL] ERROR: parse_failure — missing fields: ${_lssMissingFields.join(',')}`);
                if (!gameState.world._fillLog) gameState.world._fillLog = [];
                gameState.world._fillLog.push({ ts: new Date().toISOString(), type: 'site', error_label: 'parse_failed', affected_id: _startSlot.site_id, missing: _lssMissingFields });
                if (gameState.world._fillLog.length > 10) gameState.world._fillLog.shift();
                return res.json({ sessionId: resolvedSessionId, error: 'site_fill_failed', narrative: 'The world is being prepared. Please try again.', state: gameState });
              }
              // All three confirmed — write to canonical slot
              _startSlot.name        = _lssParsed.name;
              _startSlot.description = _lssParsed.description;
              _startSlot.identity    = _lssParsed.identity;
              _startSlot.is_filled   = true;
              console.log(`[L2-START-SITE-FILL] Slot filled: name="${_lssParsed.name}" identity="${_lssParsed.identity}"`);
              _reportProgress('site_fill', 55, { site: _lssParsed.name });;
              // Mirror to world.sites stub — derived, not canonical
              const _lssIk = _startSlot.interior_key;
              if (_lssIk && gameState.world.sites?.[_lssIk]) {
                gameState.world.sites[_lssIk].name = _lssParsed.name;
                gameState.world.sites[_lssIk].type = _lssParsed.identity;
                console.log(`[L2-START-SITE-FILL] Mirror written: ${_lssIk}`);
              } else {
                console.warn(`[L2-START-SITE-FILL] WARN: mirror target missing — interior_key=${_lssIk}. Slot written, registry not updated.`);
              }
              sessionStates.set(resolvedSessionId, { ...sessionStates.get(resolvedSessionId), gameState, isFirstTurn, logger });
            } catch (_lssErr) {
              console.error('[L2-START-SITE-FILL] DS call failed:', _lssErr.message);
              if (!gameState.world._fillLog) gameState.world._fillLog = [];
              gameState.world._fillLog.push({ ts: new Date().toISOString(), type: 'site', error_label: 'api_failed', affected_id: _startSlot?.site_id || null });
              if (gameState.world._fillLog.length > 10) gameState.world._fillLog.shift();
              return res.json({ sessionId: resolvedSessionId, error: `site_fill_failed: ${_lssErr.message}`, narrative: 'The world is being prepared. Please try again.', state: gameState });
            }
          }

          // [L1-START-SITE-FILL] Pre-activation DeepSeek fill for L1-direct-start sessions.
          // Mirrors [L2-START-SITE-FILL] exactly. Fires before enterSite so the site is fully
          // populated before [START-CONTAINER] calls Engine.enterSite() (which sets active_site
          // and bumps _sfDepth to 2, causing [SITE-FILL] to skip the slot).
          // All three fields required. Hard-fail on any error.
          if (gameState.world.start_container === 'L1' && _startSlot &&
              (_startSlot.name === null || _startSlot.description === null || _startSlot.identity === null)) {
            const _l1FoundingClause = gameState.world.founding_prompt
              ? `World description: "${gameState.world.founding_prompt}". ` : '';
            const _l1Purpose = _startCtx?.local_space_purpose || null;
            const _l1Biome   = gameState.world.macro_biome || 'unknown';
            const _l1Prompt  = `${_l1FoundingClause}Biome: ${_l1Biome}.${_l1Purpose ? ` Site purpose: ${_l1Purpose}.` : ''} Site size: ${_startSlot.site_size ?? 'unknown'}.\n\nReturn ONLY a single JSON object. No prose, no markdown. Required fields — all mandatory, none may be null or omitted:\n{"name":"<short proper name for this place>","description":"<one sentence describing it>","identity":"<short lowercase category, e.g. restaurant, blacksmith, inn>"}`;
            try {
              const _l1Resp = await axios.post('https://api.deepseek.com/v1/chat/completions', {
                model: 'deepseek-v4-flash',
                thinking: { type: 'disabled' },
                messages: [{ role: 'user', content: _l1Prompt }],
                temperature: 0.4
              }, {
                headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
                httpsAgent: _sharedHttpsAgent,
                timeout: 30000
              });
              let _l1Raw = _l1Resp?.data?.choices?.[0]?.message?.content || '';
              let _l1Parsed = null;
              try { _l1Parsed = JSON.parse(_l1Raw); } catch (_) {
                const _l1Bracket = _l1Raw.match(/\{[\s\S]*\}/);
                if (_l1Bracket) { try { _l1Parsed = JSON.parse(_l1Bracket[0]); } catch (_) {} }
              }
              if (!_l1Parsed || typeof _l1Parsed !== 'object') {
                console.warn('[L1-START-SITE-FILL] ERROR: parse_failure — response not valid JSON');
                if (!gameState.world._fillLog) gameState.world._fillLog = [];
                gameState.world._fillLog.push({ ts: new Date().toISOString(), type: 'site', error_label: 'parse_failed', affected_id: _startSlot.site_id });
                if (gameState.world._fillLog.length > 10) gameState.world._fillLog.shift();
                return res.json({ sessionId: resolvedSessionId, error: 'site_fill_failed', narrative: 'The world is being prepared. Please try again.', state: gameState });
              }
              const _l1MissingFields = ['name','description','identity'].filter(f => !_l1Parsed[f]);
              if (_l1MissingFields.length > 0) {
                if (_l1MissingFields.includes('identity')) {
                  console.warn('[L1-START-SITE-FILL] ERROR: missing_identity — identity field absent or null');
                }
                console.warn(`[L1-START-SITE-FILL] ERROR: parse_failure — missing fields: ${_l1MissingFields.join(',')}`);
                if (!gameState.world._fillLog) gameState.world._fillLog = [];
                gameState.world._fillLog.push({ ts: new Date().toISOString(), type: 'site', error_label: 'parse_failed', affected_id: _startSlot.site_id, missing: _l1MissingFields });
                if (gameState.world._fillLog.length > 10) gameState.world._fillLog.shift();
                return res.json({ sessionId: resolvedSessionId, error: 'site_fill_failed', narrative: 'The world is being prepared. Please try again.', state: gameState });
              }
              // All three confirmed — write to canonical slot
              _startSlot.name        = _l1Parsed.name;
              _startSlot.description = _l1Parsed.description;
              _startSlot.identity    = _l1Parsed.identity;
              _startSlot.is_filled   = true;
              console.log(`[L1-START-SITE-FILL] Slot filled: name="${_l1Parsed.name}" identity="${_l1Parsed.identity}"`);
              _reportProgress('site_fill', 55, { site: _l1Parsed.name });
              // Mirror to world.sites stub — derived, not canonical
              const _l1Ik = _startSlot.interior_key;
              if (_l1Ik && gameState.world.sites?.[_l1Ik]) {
                gameState.world.sites[_l1Ik].name = _l1Parsed.name;
                gameState.world.sites[_l1Ik].type = _l1Parsed.identity;
                console.log(`[L1-START-SITE-FILL] Mirror written: ${_l1Ik}`);
              } else {
                console.warn(`[L1-START-SITE-FILL] WARN: mirror target missing — interior_key=${_l1Ik}. Slot written, registry not updated.`);
              }
              sessionStates.set(resolvedSessionId, { ...sessionStates.get(resolvedSessionId), gameState, isFirstTurn, logger });
            } catch (_l1Err) {
              console.error('[L1-START-SITE-FILL] DS call failed:', _l1Err.message);
              if (!gameState.world._fillLog) gameState.world._fillLog = [];
              gameState.world._fillLog.push({ ts: new Date().toISOString(), type: 'site', error_label: 'api_failed', affected_id: _startSlot?.site_id || null });
              if (gameState.world._fillLog.length > 10) gameState.world._fillLog.shift();
              return res.json({ sessionId: resolvedSessionId, error: `site_fill_failed: ${_l1Err.message}`, narrative: 'The world is being prepared. Please try again.', state: gameState });
            }
          }

          // Start-container routing — L1/L2 players begin already inside a site/local_space.
          // Runs once at turn-1 worldgen time only, guarded by start_container value.
          // _startLocalSpacePurpose is a STARTUP-ONLY transient scratch field: written here,
          // consumed and deleted unconditionally by Engine.enterSite. Never persists beyond this block.
          {
            const _scContainer = gameState.world.start_container;
            let _scSlotFound = false;
            let _scEnterSiteOk = false;
            let _scEnterLsOk = null;
            // Use canonical _startSlot — never recompute independently
            let _scSlot = _startSlot;

            if (_scContainer && _scContainer !== 'L0') {
              const _scCellKey = _startSlotCellKey;
              _scSlotFound = !!_scSlot;

              if (_scSlot) {
                // Write local_space_purpose to transient scratch before enterSite.
                // STARTUP-ONLY: this field must not be set or read outside this block and Engine.enterSite.
                if (_scContainer === 'L2' && _startCtx.local_space_purpose) {
                  gameState.world._startLocalSpacePurpose = _startCtx.local_space_purpose;
                }
                if (_scContainer === 'L2' && _startCtx.local_space_name) {
                  gameState.world._startLocalSpaceName = _startCtx.local_space_name;
                }

                // Phase A fix: object-form call (was positional — enterSite second arg is destructured object)
                const _scSite = Engine.enterSite(gameState, { cell_key: _scCellKey, site_id: _scSlot.site_id, entry_dir: 'south' });
                _scEnterSiteOk = !!_scSite;

                // Fix A: sync name + is_filled back to cell.sites slot at startup.
                // enterSite writes the generated interior to world.sites but never syncs back to cell.sites slot.
                // is_filled requires ALL THREE canonical fields: name, description, identity.
                if (_scSite && _scSlot) {
                  const _scCellRef = gameState.world.cells?.[_startSlotCellKey];
                  const _scSlotRef = _scCellRef?.sites?.[_scSlot.site_id];
                  if (_scSlotRef && _scSite.name) {
                    _scSlotRef.name = _scSite.name;
                    // Only mark filled when all three required fields are present on the slot
                    if (_scSlotRef.name && _scSlotRef.description && _scSlotRef.identity) {
                      _scSlotRef.is_filled = true;
                      console.log(`[START-CONTAINER] Slot fully filled: "${_scSite.name}" | is_filled=true`);
                    } else {
                      console.log(`[START-CONTAINER] Name synced to slot: "${_scSite.name}" | is_filled NOT set (incomplete)`);
                    }
                  }
                }

                if (_scSite && _scContainer === 'L2') {
                  const _scLsId = _scSite.start_local_space_id
                    || Object.keys(_scSite.local_spaces || {})[0] || null;
                  if (_scLsId) {
                    Engine.enterLocalSpace(gameState, _scLsId);
                    _scEnterLsOk = !!gameState.world.active_local_space;
                    if (_scEnterLsOk) {
                      const _scSiteGrid = gameState.world.active_site?.grid;
                      let _scEntryFixed = false;
                      if (_scSiteGrid) {
                        scanLoop: for (let _sgy = 0; _sgy < _scSiteGrid.length; _sgy++) {
                          const _sgRow = _scSiteGrid[_sgy];
                          if (!_sgRow) continue;
                          for (let _sgx = 0; _sgx < _sgRow.length; _sgx++) {
                            const _sgt = _sgRow[_sgx];
                            if (_sgt?.type === 'local_space' && _sgt?.local_space_id === _scLsId) {
                              gameState.world._ls_entry_pos = { x: _sgx, y: _sgy };
                              _scEntryFixed = true;
                              console.log('[START-CONTAINER] L2 startup: _ls_entry_pos corrected to', { x: _sgx, y: _sgy });
                              break scanLoop;
                            }
                          }
                        }
                      }
                      if (!_scEntryFixed) {
                        console.warn('[START-CONTAINER] L2 startup: grid-scan found no matching tile for local_space_id:', _scLsId, '— _ls_entry_pos left as-is');
                      }
                    }
                  } else {
                    _scEnterLsOk = false;
                  }
                }

                gameState.world._engineMessage = `You begin inside ${(_scContainer === 'L2' ? gameState.world.active_local_space?.name : gameState.world.active_site?.name) || 'an unnamed place'}.`;
                console.log(`[START-CONTAINER] Routed to ${_scContainer}: ${gameState.world.active_site?.name || 'unnamed'}`);
              }

              // _startRoutingLog: committed structural facts only — no AI intermediaries.
              // Fix B: for L2 starts use active_local_space dims (5×5); fall back to site dims for L1.
              const _scActiveSite = gameState.world.active_site;
              const _scActiveLS = gameState.world.active_local_space;
              const _scGridDims = _scActiveLS
                ? { w: _scActiveLS.width || null, h: _scActiveLS.height || null }
                : _scActiveSite ? { w: _scActiveSite.width || null, h: _scActiveSite.height || null } : null;
              gameState.world._startRoutingLog = {
                start_container:           _scContainer,
                slot_found:                _scSlotFound,
                enter_site_success:        _scEnterSiteOk,
                enter_local_space_success: _scEnterLsOk,
                final_depth:               gameState.world.current_depth || 1,
                site_name:                 _scActiveSite?.name || null,
                site_size:                 _scSlot?.site_size ?? null,
                grid_dims:                 _scGridDims
              };
              console.log('[START-CONTAINER] Routing log:', JSON.stringify(gameState.world._startRoutingLog));
              _reportProgress('routing', 58, { depth: gameState.world.current_depth || 1, container: gameState.world.start_container });
            }
          }
        }
      }
      
      // v1.84.58: stamp turn number onto player_intent so AP's transferObjectDirect records correct turn
      if (inputObj?.player_intent && typeof inputObj.player_intent === 'object') inputObj.player_intent._turn = turnNumber;

      // v1.91.56: P1b — pre-AP resolver evidence capture (observe-only, diagnostic only)
      if (
        inputObj?.player_intent &&
        inputObj.player_intent.operation_family === 'take' &&
        inputObj.player_intent.selection_mode === 'partial_from_stack'
      ) {
        try {
          objectOperationResolverEvidence = await ObjectOperationResolver.resolvePartialStackTake(
            gameState,
            inputObj.player_intent
          );
        } catch (_rErr) {
          objectOperationResolverEvidence = null;
          objectOperationResolverError = {
            error_type: 'unexpected_exception',
            message: _rErr?.message || 'unknown'
          };
        }
      }

      engineOutput = Engine.buildOutput(gameState, inputObj, logger);
      if (engineOutput && engineOutput.state) {
        gameState = engineOutput.state;
        sessionStates.set(resolvedSessionId, { ...sessionStates.get(resolvedSessionId), gameState, isFirstTurn: false, logger });
      }
      _reportProgress('engine_build', 61, {});

      // Worldgen observability: compute world-shape summaries from the full 128×128 macro,
      // then freeze the log. Runs only on first turn (after full macro pre-generation).
      if (_worldgenLog.length > 0 && startAnchor) {
        _wLog('stream', 'streaming_complete', { total_cells: Object.keys(gameState.world.cells).length });

        // Collect all L1 cells for the starting macro
        const _macroPrefix = `LOC:${startAnchor.mx},${startAnchor.my}:`;
        const _macroCells = Object.entries(gameState.world.cells)
          .filter(([k]) => k.startsWith(_macroPrefix))
          .map(([, v]) => v);

        // C2a: Field statistics (elevation, moisture, temperature)
        const _fieldStats = {};
        for (const field of ['elevation', 'moisture', 'temperature']) {
          const vals = _macroCells.map(c => c[field]).filter(v => v != null);
          if (vals.length === 0) { _fieldStats[field] = { n: 0 }; continue; }
          const n = vals.length;
          const min = Math.min(...vals);
          const max = Math.max(...vals);
          const mean = vals.reduce((s, v) => s + v, 0) / n;
          const stddev = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
          _fieldStats[field] = {
            n, min: +min.toFixed(3), max: +max.toFixed(3),
            mean: +mean.toFixed(3), stddev: +stddev.toFixed(3)
          };
        }
        _wLog('pass1', 'field_statistics', _fieldStats);

        // C2b: Terrain distribution
        const _typeCounts = {};
        const _groupCounts = {};
        const _tgMap = WorldGen.TERRAIN_GROUP_MAP;
        for (const cell of _macroCells) {
          const t = cell.type || 'unknown';
          _typeCounts[t] = (_typeCounts[t] || 0) + 1;
          const g = _tgMap[t] || 'wilderness';
          _groupCounts[g] = (_groupCounts[g] || 0) + 1;
        }
        const _sortedByCount = obj => Object.fromEntries(
          Object.entries(obj).sort(([, a], [, b]) => b - a)
        );
        _wLog('pass2', 'terrain_distribution', {
          total: _macroCells.length,
          type_counts: _sortedByCount(_typeCounts),
          group_counts: _sortedByCount(_groupCounts)
        });

        // C2c: Coarse map snapshot — 16×16 grid (each block = 8×8 cells)
        const _terrainCodes = diag.TERRAIN_CODES; // alias to diagnostics module constant
        const _coarseGrid = [];
        for (let by = 0; by < 16; by++) {
          const row = [];
          for (let bx = 0; bx < 16; bx++) {
            const blockCells = _macroCells.filter(c =>
              Math.floor(c.lx / 8) === bx && Math.floor(c.ly / 8) === by
            );
            if (blockCells.length === 0) { row.push(null); continue; }
            const freq = {};
            for (const c of blockCells) { const t = c.type||''; freq[t] = (freq[t]||0)+1; }
            const dom = Object.entries(freq).sort(([,a],[,b])=>b-a)[0][0];
            row.push(_terrainCodes[dom] || '??');
          }
          _coarseGrid.push(row);
        }
        const _codesLegend = Object.entries(_terrainCodes).map(([k,v])=>`${v}=${k}`).join(',');
        _wLog('pass2', 'coarse_map_16x16', { grid: _coarseGrid, codes: _codesLegend });

        // C2d: Spatial summaries — 16×16 zones of 8×8 cells each
        const _zones = {};
        for (const cell of _macroCells) {
          const zk = `${Math.floor(cell.lx/8)},${Math.floor(cell.ly/8)}`;
          if (!_zones[zk]) _zones[zk] = { elev:[], mois:[], temp:[] };
          if (cell.elevation != null) _zones[zk].elev.push(cell.elevation);
          if (cell.moisture  != null) _zones[zk].mois.push(cell.moisture);
          if (cell.temperature != null) _zones[zk].temp.push(cell.temperature);
        }
        const _zoneMeans = Object.entries(_zones).map(([zk, z]) => ({
          zone: zk,
          meanElev: z.elev.length ? z.elev.reduce((a,b)=>a+b,0)/z.elev.length : null,
          meanMois: z.mois.length ? z.mois.reduce((a,b)=>a+b,0)/z.mois.length : null,
          meanTemp: z.temp.length ? z.temp.reduce((a,b)=>a+b,0)/z.temp.length : null,
        }));
        const _topN = (arr, key, n, asc=false) =>
          arr.filter(z=>z[key]!=null)
             .sort((a,b)=> asc ? a[key]-b[key] : b[key]-a[key])
             .slice(0,n)
             .map(z=>({ zone: z.zone, mean: +z[key].toFixed(3) }));
        _wLog('pass1', 'spatial_summaries', {
          top5_elevation:    _topN(_zoneMeans, 'meanElev', 5),
          top5_moisture:     _topN(_zoneMeans, 'meanMois', 5),
          bottom5_moisture:  _topN(_zoneMeans, 'meanMois', 5, true),
          top3_temperature:  _topN(_zoneMeans, 'meanTemp', 3),
          bottom3_temperature: _topN(_zoneMeans, 'meanTemp', 3, true),
        });

        // C2e: Contiguity signals — BFS per terrain group within starting macro
        const _posMap = {};
        for (const cell of _macroCells) {
          const g = _tgMap[cell.type] || 'wilderness';
          if (!_posMap[g]) _posMap[g] = new Map();
          _posMap[g].set(`${cell.lx},${cell.ly}`, true);
        }
        const _contiguity = {};
        for (const [group, posSet] of Object.entries(_posMap)) {
          const visited = new Set();
          let componentCount = 0;
          let largestSize = 0;
          let isolatedCells = 0;
          for (const posKey of posSet.keys()) {
            if (visited.has(posKey)) continue;
            componentCount++;
            const queue = [posKey];
            visited.add(posKey);
            let size = 0;
            while (queue.length) {
              const cur = queue.shift();
              size++;
              const [cx, cy] = cur.split(',').map(Number);
              for (const [nx, ny] of [[cx+1,cy],[cx-1,cy],[cx,cy+1],[cx,cy-1]]) {
                const nk = `${nx},${ny}`;
                if (!visited.has(nk) && posSet.has(nk)) {
                  visited.add(nk);
                  queue.push(nk);
                }
              }
            }
            if (size > largestSize) largestSize = size;
            if (size === 1) isolatedCells++;
          }
          _contiguity[group] = { component_count: componentCount, largest_component_size: largestSize, isolated_cells: isolatedCells };
        }
        _wLog('pass2', 'contiguity', { groups: _contiguity });

        // Freeze worldgen log on gameState — no further writes
        gameState.world.worldgen_log = _worldgenLog;
        gameState.world.site_placement_log = _sitePlacementLog;

        // TTL: remove progress tracking entry after 60 s (response already sent by then)
        if (_progToken) setTimeout(() => _initProgress.delete(_progToken), 60000);
      }
    } catch (err) {
      console.error('Engine error on first turn:', err.message);
      _abortTurn('ENGINE_ERROR_FIRST_TURN');
      return res.json({ 
        sessionId: resolvedSessionId,
        error: `engine_failed: ${err.message}`, 
        narrative: "The engine encountered an error initializing the world.",
        state: gameState,
        turn_history: gameState?.turn_history || null,
        debug 
      });
    }
  } else {
    // Ongoing turn: infer MOVE vs FREEFORM and call Engine
    try {

      // Clarify if low confidence (only for non-first-turn)
      if (parseResult && parseResult.success === true && typeof parseResult.confidence === 'number' && parseResult.confidence < 0.5) {
        console.log('[PARSER] semantic_clarify input="%s" confidence=%s', userInput, parseResult.confidence);
        debug.parser = "semantic_clarify";
        debug.clarification = "awaiting_confirmation";
        _abortTurn('LOW_CONFIDENCE');
        return res.json({
          sessionId: resolvedSessionId,
          narrative: `[CLARIFICATION] I didn't quite understand that. Did you mean to: ${parseResult.intent?.primaryAction?.action || '...'}? (yes/no/try again)`,
          state: gameState,
          turn_history: gameState?.turn_history || null,
          debug
        });
      }

      inputObj = null;

      // PHASE 1: ROUTING INSTRUMENTATION - Debug the routing decision
      if (parseResult) {
        console.log('[ROUTING-DEBUG] parseResult.success:', parseResult.success, '| typeof:', typeof parseResult.success);
        console.log('[ROUTING-DEBUG] parseResult.confidence:', parseResult.confidence, '| typeof:', typeof parseResult.confidence);
        const condA = parseResult.success === true;
        const condB = typeof parseResult.confidence === 'number';
        const condC = parseResult.confidence >= 0.5;
        console.log('[ROUTING-DEBUG] Condition A (success===true):', condA);
        console.log('[ROUTING-DEBUG] Condition B (typeof===number):', condB);
        console.log('[ROUTING-DEBUG] Condition C (confidence>=0.5):', condC);
        console.log('[ROUTING-DEBUG] FULL CONDITION (A && B && C):', condA && condB && condC);
        console.log('[ROUTING-DEBUG] Will route to:', (condA && condB && condC) ? 'SEMANTIC_PARSER_PATH' : 'FALLBACK_LEGACY_PATH');
      }

      // PHASE 3B FIX: Normalize confidence to number at routing boundary (handles string "0.95" case)
      let normalizedConfidence = parseResult?.confidence;
      if (normalizedConfidence !== undefined && typeof normalizedConfidence !== 'number') {
        normalizedConfidence = Number(normalizedConfidence) || 0;
        console.log('[ROUTING-FIX] Coerced confidence to number:', normalizedConfidence);
      }

      // Capture parser failure diagnostic fields for turn archive when semantic parser fails.
      if (parseResult && parseResult.success !== true) {
        debug.parser_error            = parseResult.error       || null;
        debug.parser_error_code       = parseResult.error_code  || null;
        debug.parser_error_confidence = parseResult.confidence  ?? null;
        debug.parser_raw_content      = parseResult.raw_content || null;
      }

      if (parseResult && parseResult.success === true && typeof normalizedConfidence === 'number' && normalizedConfidence >= 0.5) {
        console.log('[PARSER] semantic_ok input="%s" action="%s" confidence=%s', userInput, parseResult.intent?.primaryAction?.action, parseResult.confidence);
        // [POINT-A] Log parseResult details for movement diagnosis
        console.log('[POINT-A-PARSE] parseResult:', { success: parseResult.success, confidence: parseResult.confidence, action: parseResult.intent?.primaryAction?.action, dir: parseResult.intent?.primaryAction?.dir, selection_mode: parseResult.intent?.primaryAction?.selection_mode ?? null, requested_quantity: parseResult.intent?.primaryAction?.requested_quantity ?? null, quantity_word: parseResult.intent?.primaryAction?.quantity_word ?? null, quantity_mode: parseResult.intent?.primaryAction?.quantity_mode ?? null, normalized_target: parseResult.intent?.primaryAction?.normalized_target ?? null, operation_family: parseResult.intent?.primaryAction?.operation_family ?? null, source_container_hint: parseResult.intent?.primaryAction?.source_container_hint ?? null });
        debug.parser = "semantic";
        // Post-parse normalization: catch known LLM contract violations before validation
        const _pa = parseResult.intent?.primaryAction;
        if (_pa && _pa.action === 'move') {
          if (String(_pa.dir || '').toLowerCase() === 'exit') {
            console.log('[PARSER-NORM] move+dir:exit reclassified -> exit');
            _pa.action = 'exit';
            delete _pa.dir;
          } else if (!['north','south','east','west','up','down','n','s','e','w','u','d'].includes(String(_pa.dir || '').toLowerCase()) && _pa.target) {
            console.log('[PARSER-NORM] move+no-compass-dir+target reclassified -> enter target=%s', _pa.target);
            _pa.action = 'enter';
            delete _pa.dir;
          }
        }
        // [STATE-CLAIM] Pre-validation intercept (v1.84.13 / v1.84.72):
        // v1.84.72: Reclassified state claims get action='established_trait_action' — a proper internal
        // action type that carries meaning across scope boundaries without cross-scope flags.
        // Founding attrs stored on inputObj.player_intent._foundingAttrs for RC truth fragment use.
        let _degradedToFreeform = false;
        if (parseResult?.intent?.primaryAction?.action === 'state_claim') {
          inputObj = mapActionToInput(userInput, 'FREEFORM');
          inputObj.player_intent.channel = resolvedChannel;
          _degradedToFreeform = true;
          // v1.84.75: Object-access detector + discriminated relevance gate.
          // Object-access verbs require a matching object: attr; declared/physical attrs cannot authorize item access.
          const _OBJECT_ACCESS_VERBS = ['pull out','take out','draw out','produce','retrieve','equip','wield','unsheathe','unholster','eat ','drink ','use my ','hand over','give my','open my ','hold out','pick up'];
          const _STOPWORDS = ['the','and','out','my','you','your','with','from','into','onto','for','off'];
          const _tokenize = str => str.toLowerCase().split(/\W+/).filter(t => t.length >= 3 && !_STOPWORDS.includes(t));
          const _isObjectAccess = _OBJECT_ACCESS_VERBS.some(v => userInput.toLowerCase().includes(v));
          const _inputTokens = _tokenize(userInput);
          const _allPlayerAttrs = Object.values(gameState.player?.attributes || {});
          const _objectBucketAttrs = _allPlayerAttrs.filter(a => a.bucket === 'object');
          // v1.84.76: declared passes free (founding identity); physical requires keyword overlap (CB-promoted descriptions must be relevant)
          const _declaredAttrs = _allPlayerAttrs.filter(a => a.bucket === 'declared');
          const _matchingObjectAttrs = _objectBucketAttrs.filter(a =>
            _tokenize(a.value).some(t => _inputTokens.includes(t))
          );
          const _matchingPhysicalAttrs = _allPlayerAttrs.filter(a => a.bucket === 'physical' &&
            _tokenize(a.value).some(t => _inputTokens.includes(t))
          );
          const _supportedAttrs = _isObjectAccess
            ? _matchingObjectAttrs
            : [..._declaredAttrs, ..._matchingObjectAttrs, ..._matchingPhysicalAttrs];
          const _foundingAttrStrings = _supportedAttrs.map(a => `${a.bucket}:${a.value}`);
          console.log(`[STATE-CLAIM] objectAccess=${_isObjectAccess}, supported=${_foundingAttrStrings.length}`);
          if (_foundingAttrStrings.length > 0) {
            // v1.84.75: Relevant supporting attributes present — reclassify as established_trait_action
            inputObj.player_intent.action = 'established_trait_action';
            inputObj.player_intent._foundingAttrs = _foundingAttrStrings;
            debug.path = 'STATE_CLAIM_RECLASSIFIED';
            console.log('[STATE-CLAIM] reclassified — supported attributes present, RC will fire');
          } else {
            inputObj.player_intent.action = 'state_claim';
            debug.path = 'STATE_CLAIM_FREEFORM';
            console.log('[STATE-CLAIM] non-executable input intercepted — routing to freeform, RC skip');
          }
        }

        // Phase 4: validate queue and execute sequentially
        const validation = !_degradedToFreeform ? validateAndQueueIntent(gameState, parseResult.intent) : { valid: false, reason: 'STATE_CLAIM_INTERCEPT', queue: [] };
        // [POINT-B] Log validation queue for movement diagnosis
        console.log('[POINT-B-QUEUE] validation.valid:', validation.valid, 'queue.length:', validation.queue?.length);
        if (validation.queue && validation.queue.length > 0) {
          validation.queue.forEach((qa, i) => {
            console.log(`[POINT-B-QUEUE] queue[${i}]:`, { action: qa.action, dir: qa.dir, target: qa.target, selection_mode: qa.selection_mode ?? null, requested_quantity: qa.requested_quantity ?? null, quantity_word: qa.quantity_word ?? null, quantity_mode: qa.quantity_mode ?? null, normalized_target: qa.normalized_target ?? null, operation_family: qa.operation_family ?? null, source_container_hint: qa.source_container_hint ?? null });
          });
        }
        if (!_degradedToFreeform && !validation.valid) {
          const _vReason = validation.reason;
          if (_vReason === 'TARGET_NOT_FOUND_IN_CELL' || _vReason === 'TARGET_NOT_VISIBLE' || _vReason === 'TARGET_NOT_WORN') {
            const _dgAction = validation.queue?.[0];
            const _dgRaw = [_dgAction?.action, _dgAction?.target].filter(Boolean).join(' ') || userInput;
            inputObj = mapActionToInput(_dgRaw, 'FREEFORM');
            inputObj.degraded = true;
            inputObj.player_intent.channel = resolvedChannel;
            debug.degraded_from = _vReason;
            debug.path = 'DEGRADED_FREEFORM';
            _degradedToFreeform = true;
            console.log('[DEGRADE] degraded to FREEFORM from:', _vReason, 'raw:', _dgRaw);
          } else if (_vReason === 'NPC_NOT_PRESENT' && resolvedChannel === 'say') {
            // v1.51.0: Say-alone graceful degrade — no NPC bound, route to soliloquy narration instead of hard abort
            debug.degraded_from = _vReason;
            debug.path = 'SAY_SOLILOQUY';
            _degradedToFreeform = true;
            console.log('[DEGRADE] Say channel NPC_NOT_PRESENT — routing to soliloquy path');
          } else {
            _abortTurn(validation.reason);
            return res.json({
              sessionId: resolvedSessionId,
              success: true,
              narrative: `Action invalid: ${validation.reason}`,
              state: gameState,
              turn_history: gameState?.turn_history || null,
              debug: { ...debug, parser: "semantic", error: "INVALID_ACTION", reason: validation.reason, validation: validation.stateValidation }
            });
          }
        }
        if (!_degradedToFreeform) {
        const allResponses = [];
        for (const queuedAction of validation.queue) {
          objectOperationResolverEvidence = null;
          objectOperationResolverError = null;
          debug.tls_executor_dry_run = null;
          const raw = [queuedAction.action, queuedAction.target].filter(Boolean).join(' ');
          const mapped = mapActionToInput(raw, getActionKind(queuedAction));
          
          // POPULATE PLAYER_INTENT FIELDS BEFORE DIAGNOSTIC LOG (data integrity fix)
          mapped.player_intent.action = queuedAction.action;
          if (queuedAction.target) mapped.player_intent.target = queuedAction.target;
          // v1.91.15: thread raw input through to AP execution so throw/drop handlers
          // can detect partial-stack quantity prefixes ("one of the", "a", etc.)
          mapped.player_intent.raw_input = parseResult?.intent?.rawInput || userInput;
          // v1.91.16: thread parser-emitted selection_mode per-action (replaces AP-side
          // regex on raw_input for partial-stack intent detection — root fix)
          if (queuedAction.selection_mode) mapped.player_intent.selection_mode = queuedAction.selection_mode;
          
          if (queuedAction.action === 'move' && queuedAction.dir) {
            // Pass direction through unchanged as long-form (north/south/east/west)
            // ActionProcessor delta table is the canonical direction contract
            mapped.player_intent.dir = String(queuedAction.dir).toLowerCase();
          }

          // Phase 2: thread enrichment fields from _enrichPrimaryAction into player_intent.
          // These fields are populated by SemanticParser._enrichPrimaryAction on every parse result
          // (LLM path and all fast paths). They were produced correctly in Phase 1 (v1.91.23) but
          // were never threaded past this loop because the loop predates Phase 1.
          // Null-guard style matches selection_mode assignment above.
          if (queuedAction.requested_quantity    != null) mapped.player_intent.requested_quantity    = queuedAction.requested_quantity;
          if (queuedAction.quantity_word         != null) mapped.player_intent.quantity_word         = queuedAction.quantity_word;
          if (queuedAction.quantity_mode         != null) mapped.player_intent.quantity_mode         = queuedAction.quantity_mode;
          if (queuedAction.normalized_target     != null) mapped.player_intent.normalized_target     = queuedAction.normalized_target;
          if (queuedAction.source_container_hint != null) mapped.player_intent.source_container_hint = queuedAction.source_container_hint;
          // operation_family is always a string from the enricher — assign unconditionally with action fallback
          mapped.player_intent.operation_family = queuedAction.operation_family ?? mapped.player_intent.action;
          // NOTE: secondaryActions in compound commands are not enriched. If "take 3 and drop 1" is issued,
          // the second action's queuedAction will have no enrichment metadata. Future work — not Phase 2.

          // [POINT-C] Log mapped input structure for movement diagnosis (now with complete data)
          console.log('[POINT-C-MAPPED] action:', queuedAction.action, 'mapped.player_intent:', {
            action: mapped.player_intent?.action,
            dir: mapped.player_intent?.dir,
            target: mapped.player_intent?.target,
            selection_mode: mapped.player_intent?.selection_mode ?? null,
            requested_quantity: mapped.player_intent?.requested_quantity ?? null,
            quantity_word: mapped.player_intent?.quantity_word ?? null,
            quantity_mode: mapped.player_intent?.quantity_mode ?? null,
            normalized_target: mapped.player_intent?.normalized_target ?? null,
            operation_family: mapped.player_intent?.operation_family ?? null,
            source_container_hint: mapped.player_intent?.source_container_hint ?? null,
            raw_input: mapped.player_intent?.raw_input ?? null
          });

          // ── CHANNEL STAMP ─────────────────────────────────────────────────────────
          mapped.player_intent.channel = resolvedChannel;
          if (!mapped.player_intent.target && _rawNpcTarget) mapped.player_intent.target = _rawNpcTarget;

          // ── TALK INTERCEPTION (Do bar only, pre-engine guard) ─────────────────────
          if (resolvedChannel === 'do' && queuedAction.action === 'talk') {
            _abortTurn('NEEDS_SAY_INPUT');
            return res.json({
              needs_say_input: true,
              npc_target: queuedAction.target || null,
              sessionId: resolvedSessionId
            });
          }

          // ── HYBRID ENTRY RESOLVER ─────────────────────────────────────────────────
          // Runs BEFORE buildOutput so Engine receives annotated player_intent.
          // Fires on 'enter' at L0: handles targeted resolution (P1/P2) and null-target disambiguation.
          if (queuedAction.action === 'enter' && !gameState.world.active_site) {
            const _resolverPhrase = (queuedAction.target || '').toLowerCase().trim().replace(/^(the|a|an)\s+/, '');
            const _resolverTrace = {
              phrase: _resolverPhrase,
              candidateCount: 0,
              p1: null,
              p2Invoked: false,
              p2: null,
              resolved_site_id: null
            };

            if (_resolverPhrase) {
              // Build candidate list from current cell (same logic as Engine enter handler).
              const _rPos     = gameState.world.position;
              const _rCellKey = `LOC:${_rPos.mx},${_rPos.my}:${_rPos.lx},${_rPos.ly}`;
              const _rCell    = gameState.world.cells && gameState.world.cells[_rCellKey];
              const _rSites   = _rCell ? Object.values(_rCell.sites || {}) : [];
              const _rReal    = _rSites.filter(s => s.enterable === true && !s.is_starting_location);
              const _rCandidates = _rReal.length > 0
                ? _rReal
                : _rSites.filter(s => s.enterable === true);
              _resolverTrace.candidateCount = _rCandidates.length;

              // Phase 1 — deterministic three-pass match.
              const _p1 = Engine.resolveEntryPhase1(_rCandidates, _resolverPhrase);
              const _p1MatchCount = _p1.result === 'resolved' ? 1 : _p1.ambiguous_ids?.length ?? 0;
              _resolverTrace.p1 = { result: _p1.result, pass: _p1.pass, matchCount: _p1MatchCount };
              console.log('[RESOLVER] Phase1:', _p1.result, 'pass:', _p1.pass, 'matchCount:', _p1MatchCount, 'phrase:', _resolverPhrase);

              if (_p1.result === 'resolved') {
                mapped.player_intent.resolved_site_id = _p1.site_id;
                _resolverTrace.resolved_site_id = _p1.site_id;
                console.log('[RESOLVER] Phase1 resolved:', _p1.site_id);

              } else if (_p1.result === 'ambiguous') {
                mapped.player_intent.ambiguous_ids = _p1.ambiguous_ids;
                console.log('[RESOLVER] Phase1 ambiguous:', _p1.ambiguous_ids.length, 'ids:', _p1.ambiguous_ids);

              } else {
                // no_match — invoke Phase 2 (LLM constrained interpretation).
                _resolverTrace.p2Invoked = true;
                console.log('[RESOLVER] Phase2 invoke — candidateCount:', _rCandidates.length, 'phrase:', _resolverPhrase);

                if (_rCandidates.length > 0) {
                  const _currentDepth = gameState.world.active_local_space ? 3 : gameState.world.active_site ? 2 : 1;
                  const _p2 = await resolveEnterTarget(_rCandidates, _resolverPhrase, _currentDepth);
                  _resolverTrace.p2 = {
                    result: _p2.result,
                    method: _p2.method,
                    site_id: _p2.site_id || null,
                    ambiguousCount: _p2.ambiguous_ids?.length || 0
                  };
                  console.log(
                    '[RESOLVER] Phase2:', _p2.result, 'method:', _p2.method,
                    _p2.site_id       ? 'site_id:'   + _p2.site_id                    : '',
                    _p2.ambiguous_ids ? 'ambiguous:' + JSON.stringify(_p2.ambiguous_ids) : '',
                    _p2.error         ? 'error:'     + _p2.error                      : ''
                  );

                  if (_p2.result === 'resolved') {
                    mapped.player_intent.resolved_site_id = _p2.site_id;
                    _resolverTrace.resolved_site_id = _p2.site_id;
                  } else if (_p2.result === 'ambiguous') {
                    mapped.player_intent.ambiguous_ids = _p2.ambiguous_ids;
                  }
                }
              }
            } else {
              // null-target enter: contextual disambiguation from current cell (v1.85.4)
              const _rPos     = gameState.world.position;
              const _rCellKey = `LOC:${_rPos.mx},${_rPos.my}:${_rPos.lx},${_rPos.ly}`;
              const _rCell    = gameState.world.cells && gameState.world.cells[_rCellKey];
              const _rSites   = _rCell ? Object.values(_rCell.sites || {}) : [];
              const _ntCandidates = _rSites.filter(s => s.enterable === true && s.is_filled === true);
              if (_ntCandidates.length === 1) {
                mapped.player_intent.resolved_site_id = _ntCandidates[0].site_id;
                _resolverTrace.resolved_site_id = _ntCandidates[0].site_id;
                console.log('[RESOLVER] null-target: auto-resolved to', _ntCandidates[0].site_id);
              } else if (_ntCandidates.length > 1) {
                mapped.player_intent.ambiguous_ids = _ntCandidates.map(s => s.site_id);
                _enterAmbiguous = true;
                _resolverTrace.p1 = { result: 'ambiguous', pass: 'null_target', matchCount: _ntCandidates.length };
                console.log('[RESOLVER] null-target: ambiguous', _ntCandidates.length, 'sites');
              }
              // else: 0 candidates — engine receives null-target enter, handles as no-op
            }

            // Write trace to world state so frontend diagnostic panel can read it.
            gameState.world._lastResolverTrace = _resolverTrace;
          }
          // ── END HYBRID ENTRY RESOLVER ─────────────────────────────────────────────

          // v1.84.58: stamp turn number onto player_intent so AP's transferObjectDirect records correct turn
          if (mapped?.player_intent && typeof mapped.player_intent === 'object') mapped.player_intent._turn = turnNumber;
          // v1.85.4: capture location fingerprint before engine processes action
          _preTurnLoc = {
            siteId: gameState.world?.active_site?.id ?? null,
            lsId:   gameState.world?.active_local_space?.local_space_id ?? null,
            posKey: `${gameState.world?.position?.mx},${gameState.world?.position?.my}:${gameState.world?.position?.lx},${gameState.world?.position?.ly}`
          };

          // v1.91.XX: Phase D — clear per-turn TLS execution diagnostic before AP runs
          gameState._tlsExecutionResult = null;
          gameState._apActuals = null;                // v1.91.XX P3: clear per-turn AP actuals
          gameState._tlsPartialStackResult = null;

          // Article TAKE promotion: resolve once through the existing TLS source resolver,
          // then promote only a validated active stack. Singular, unresolved, ambiguous,
          // stale, and non-article intents retain their existing execution paths.
          const _articleTakeProbe = (
            mapped?.player_intent?.operation_family === 'take' &&
            mapped.player_intent.selection_mode == null &&
            mapped.player_intent.requested_quantity == null &&
            mapped.player_intent.quantity_mode === 'article' &&
            (mapped.player_intent.quantity_word === 'a' || mapped.player_intent.quantity_word === 'an')
          ) ? {
            ...mapped.player_intent,
            requested_quantity: 1,
            selection_mode: 'partial_from_stack'
          } : null;

          // v1.91.58: P1b — pre-AP resolver evidence capture inside queue loop (observe-only, diagnostic only)
          if (
            mapped?.player_intent &&
            mapped.player_intent.operation_family === 'take' &&
            (mapped.player_intent.selection_mode === 'partial_from_stack' || _articleTakeProbe)
          ) {
            try {
              objectOperationResolverEvidence = await ObjectOperationResolver.resolvePartialStackTake(
                gameState,
                _articleTakeProbe || mapped.player_intent
              );

              if (_articleTakeProbe) {
                const _articleSource = gameState.objects?.[objectOperationResolverEvidence?.source_object_id];
                const _articleSourceIsValidatedStack = (
                  objectOperationResolverEvidence?.resolution_basis === 'model_selected' &&
                  objectOperationResolverEvidence?.fail_closed_reason == null &&
                  _articleSource?.status === 'active' &&
                  Number.isInteger(_articleSource.quantity) &&
                  _articleSource.quantity > 1 &&
                  _articleSource.quantity === objectOperationResolverEvidence.source_quantity_before &&
                  _articleSource.current_container_type === objectOperationResolverEvidence.source_container_type &&
                  _articleSource.current_container_id === objectOperationResolverEvidence.source_container_id
                );

                if (_articleSourceIsValidatedStack) {
                  mapped.player_intent.requested_quantity = 1;
                  mapped.player_intent.selection_mode = 'partial_from_stack';
                } else {
                  objectOperationResolverEvidence = null;
                }
              }
            } catch (_rErr) {
              objectOperationResolverEvidence = null;
              objectOperationResolverError = {
                error_type: 'unexpected_exception',
                message: _rErr?.message || 'unknown'
              };
            }
          } else if (
            mapped?.player_intent?.operation_family === 'drop' &&
            validation.queue.length === 1
          ) {
            try {
              objectOperationResolverEvidence = await ObjectOperationResolver.resolvePlayerHeldDrop(gameState, mapped.player_intent);
            } catch (_rErr) {
              objectOperationResolverEvidence = null;
              objectOperationResolverError = { error_type: 'unexpected_exception', message: _rErr?.message || 'unknown' };
            }
          }

          // P1c — normalize a mistaken partial-stack TAKE classification back to whole-object
          // before P2 assembly, when ORS-backed resolver evidence proves the resolved quantity
          // is the entire available stack (an ordinary object, not a real stack selection). AP's
          // existing whole-object TAKE lane already handles this correctly (transferObjectDirect);
          // this only stops a single unambiguous object from being misrouted into the partial-
          // stack path by an incorrect parser classification. Genuine partial requests
          // (effective_requested_quantity < source_quantity_before) are left untouched.
          if (_shouldNormalizeExactStackTake(mapped.player_intent, objectOperationResolverEvidence, gameState)) {
            delete mapped.player_intent.selection_mode;
            objectOperationResolverEvidence = null;
          }

          // v1.91.62: P2 — pre-AP TLS v1 instruction assembly (observe-only, diagnostic only)
          debug.tls_instruction_v1 = _assembleTlsInstructionV1(
            objectOperationResolverEvidence,
            objectOperationResolverError,
            mapped.player_intent,
            gameState
          );

          // v1.91.64: P4 — dry-run executor prediction (pre-AP, observe-only, partial-stack TAKE only)
          if (debug.tls_instruction_v1) {
            debug.tls_executor_dry_run = TlsObjectOperationExecutor.executeTlsObjectInstruction(
              gameState,
              debug.tls_instruction_v1,
              { dryRun: true }
            );
          }

          const result = await Engine.buildOutput(gameState, mapped, logger);
          inputObj = mapped; // Expose to narration scope for FREEFORM detection
          allResponses.push(result);
          if (result && result.state) {
            gameState = result.state;
            // [POINT-E] Log position persistence for movement diagnosis
            console.log('[POINT-E-PERSIST] Before sessionStates.set - gameState.world.position:', gameState.world.position);
            sessionStates.set(resolvedSessionId, { ...sessionStates.get(resolvedSessionId), gameState, isFirstTurn });
            console.log('[POINT-E-PERSIST] After sessionStates.set - verified in Map');
          }

          // Live TLS whole-object DROP execution. Writes a receipt only after
          // ObjectHelper confirms success; failures remain null and fail closed.
          if (
            debug.tls_instruction_v1?.operation_family === 'drop' &&
            debug.tls_executor_dry_run?.operation_family === 'drop' &&
            debug.tls_executor_dry_run?.operation_allowed === true &&
            debug.tls_executor_dry_run?.outcome === 'whole_transfer' &&
            debug.tls_executor_dry_run?.predicted_call?.method === 'transferObjectDirect'
          ) {
            const _tlsWholeDropParams = debug.tls_executor_dry_run.predicted_call.parameters;
            const _tlsWholeDropResult = ObjectHelper.transferObjectDirect(
              gameState,
              _tlsWholeDropParams.object_id,
              _tlsWholeDropParams.destination_container_type,
              _tlsWholeDropParams.destination_container_id,
              turnNumber,
              'tls_whole_object_drop'
            );
            if (_tlsWholeDropResult.success) {
              _authorityGateWholeDropObjectId = _tlsWholeDropParams.object_id;
              gameState._tlsExecutionResult = {
                schema_version: 'tls_execution_result_v0',
                operation_id: `tls_op_${turnNumber}`,
                mode: 'live_execution',
                authority: {
                  executor: 'tls',
                  mutation_engine: 'ObjectHelper',
                  object_state_authority: 'ORS'
                },
                attempted: true,
                executed_by: 'tls',
                eligibility: { status: 'eligible', reason: null },
                object: {
                  id: _tlsWholeDropParams.object_id,
                  name: debug.tls_instruction_v1.object.name
                },
                source: {
                  container_type: debug.tls_instruction_v1.source.container_type,
                  container_id: debug.tls_instruction_v1.source.container_id
                },
                destination: {
                  container_type: _tlsWholeDropParams.destination_container_type,
                  container_id: _tlsWholeDropParams.destination_container_id
                },
                transfer: { result: 'success', error: null },
                fail_closed: false,
                warnings: []
              };
            }
          } else if (
            debug.tls_instruction_v1?.operation_family === 'drop' &&
            debug.tls_executor_dry_run?.operation_family === 'drop' &&
            validation.queue.length === 1 &&
            debug.tls_executor_dry_run?.operation_allowed === true &&
            debug.tls_executor_dry_run?.outcome === 'partial_split' &&
            debug.tls_executor_dry_run?.predicted_call?.method === 'splitObjectDirect'
          ) {
            const _tlsPartialDropParams = debug.tls_executor_dry_run.predicted_call.parameters;
            const splitResult = ObjectHelper.splitObjectDirect(
              gameState,
              _tlsPartialDropParams.source_object_id,
              _tlsPartialDropParams.extract_quantity,
              _tlsPartialDropParams.destination_container_type,
              _tlsPartialDropParams.destination_container_id,
              turnNumber,
              'tls_partial_stack_drop'
            );
            gameState._tlsPartialStackResult = {
              schema_version: 'tls_partial_stack_execution_v1',
              executed: splitResult.ok,
              split_result: splitResult,
              predicted_call: debug.tls_executor_dry_run.predicted_call,
              ap_actuals: gameState._apActuals ?? null
            };
            _tlsPartialStackArchive = gameState._tlsPartialStackResult;
            if (splitResult.ok) {
              // #24 — quantity-one successor rename, independent of the CB receipt below.
              if (splitResult.applied_quantity === 1) {
                const _dropSuccessorRecord = gameState.objects?.[splitResult.successor_object_id];
                if (_dropSuccessorRecord) {
                  const _dropTargetText = mapped.player_intent?.normalized_target || mapped.player_intent?.target || null;
                  const _dropSuccessorRename = _singularizeDropSuccessorName(_dropSuccessorRecord.name, _dropTargetText);
                  if (_dropSuccessorRename.changed) _dropSuccessorRecord.name = _dropSuccessorRename.name;
                }
              }
              const _capturedPartialDropReceipt = _captureCbTlsPartialStackDropReceipt(
                splitResult,
                debug.tls_executor_dry_run.predicted_call
              );
              if (_capturedPartialDropReceipt) {
                ObjectHelper.setObjectDescriptionDirect(
                  gameState,
                  _capturedPartialDropReceipt.successor_object_id,
                  ''
                );
              }
            }
          }

          // v1.91.71: P5-A2 — live TLS partial-stack TAKE execution
          // Consumes P4 dry-run prediction. Executes when P4 predicted a
          // valid partial_split. AP is not a precondition — the new lane
          // owns execution. splitObjectDirect is self-guarding (fail-closed).
          // Mutation happens pre-narration/pre-CB so narrator and CB see
          // correct ORS state. Downstream CB output remains runtime-observed.
          if (
            debug.tls_instruction_v1?.operation_family === 'take' &&
            debug.tls_executor_dry_run?.operation_family === 'take' &&
            debug.tls_executor_dry_run?.operation_allowed === true &&
            debug.tls_executor_dry_run?.outcome === 'partial_split'
          ) {
            const _tlsPartialParams = debug.tls_executor_dry_run.predicted_call.parameters;
            const splitResult = ObjectHelper.splitObjectDirect(
              gameState,
              _tlsPartialParams.source_object_id,
              _tlsPartialParams.extract_quantity,
              _tlsPartialParams.destination_container_type,
              _tlsPartialParams.destination_container_id,
              turnNumber,
              'tls_partial_stack_take'
            );
            gameState._tlsPartialStackResult = {
              schema_version: 'tls_partial_stack_execution_v1',
              executed: splitResult.ok,
              split_result: splitResult,
              predicted_call: debug.tls_executor_dry_run.predicted_call,
              ap_actuals: gameState._apActuals ?? null
            };
            _tlsPartialStackArchive = gameState._tlsPartialStackResult;

            if (splitResult.ok) {
              _captureCbTlsPartialStackTakeReceipt(splitResult);
              const _tlsPartialSource = gameState.objects?.[splitResult.source_object_id];
              const _tlsPartialSuccessor = gameState.objects?.[splitResult.successor_object_id];
              if (_tlsPartialSource && _tlsPartialSuccessor) {
                const _parentDescription = _tlsPartialSource.description || '';
                const _clearDescription = ObjectHelper.setObjectDescriptionDirect(
                  gameState, splitResult.successor_object_id, ''
                );
                if (_clearDescription.applied) {
                  _tlsPartialDescriptionTarget = {
                    source_object_id: splitResult.source_object_id,
                    successor_object_id: splitResult.successor_object_id,
                    extracted_quantity: splitResult.applied_quantity,
                    destination_container_type: splitResult.dest_container_type,
                    destination_container_id: splitResult.dest_container_id,
                    parent_description: _parentDescription
                  };
                }
              }
            }

            // Audit entry
            if (!Array.isArray(gameState._objectRealityDebug?.audit)) {
              if (!gameState._objectRealityDebug) gameState._objectRealityDebug = {};
              gameState._objectRealityDebug.audit = [];
            }
            gameState._objectRealityDebug.audit.push({
              action: 'tls_partial_stack_take',
              source_object_id: _tlsPartialParams.source_object_id,
              extract_quantity: _tlsPartialParams.extract_quantity,
              destination_container_type: _tlsPartialParams.destination_container_type,
              destination_container_id: _tlsPartialParams.destination_container_id,
              executed: splitResult.ok,
              split_result: splitResult,
              turn: turnNumber,
              timestamp: new Date().toISOString()
            });
          }

          // v1.85.4: no-movement detection for enter/exit/move intents
          const _ma = mapped?.player_intent?.action;
          if (_preTurnLoc && (_ma === 'enter' || _ma === 'exit' || _ma === 'move')) {
            _actionHadNoEffect = (_preTurnLoc.siteId === (gameState.world?.active_site?.id ?? null))
              && (_preTurnLoc.lsId   === (gameState.world?.active_local_space?.local_space_id ?? null))
              && (_preTurnLoc.posKey === `${gameState.world?.position?.mx},${gameState.world?.position?.my}:${gameState.world?.position?.lx},${gameState.world?.position?.ly}`);
          }
        }
        engineOutput = allResponses[allResponses.length - 1];
        debug = { ...debug, parser: "semantic", queue_length: validation.queue.length };
        // v1.91.37A: AP audit capture proof — reads _objectRealityDebug.audit after Engine.buildOutput,
        // before narration/CB/ObjectHelper pass. Confirms AP-prefixed entries exist at this point in
        // the turn lifecycle. Read-only diagnostic only — no state mutation, no turn_history change.
        {
          const _apAuditEntries = Array.isArray(gameState._objectRealityDebug?.audit)
            ? gameState._objectRealityDebug.audit.filter(e => typeof e.action === 'string' && e.action.startsWith('ap_'))
            : [];
          if (_apAuditEntries.length > 0) {
            console.log(`[OR-AP-PROOF] Turn ${turnNumber}: ${_apAuditEntries.length} AP audit entry(ies) captured before narration:`,
              _apAuditEntries.map(e => ({
                action: e.action,
                source_object_id: e.source_object_id ?? e.object_id ?? null,
                successor_id: e.successor_id ?? e.successor_object_id ?? null,
                source_quantity_before: e.source_quantity_before ?? null,
                source_quantity_after: e.source_quantity_after ?? null,
                requested_quantity: e.requested_quantity ?? null,
                applied_quantity: e.applied_quantity ?? null
              }))
            );
          } else {
            console.log(`[OR-AP-PROOF] Turn ${turnNumber}: no AP audit entries in _objectRealityDebug.audit after Engine.buildOutput`);
          }
        }
        } // end if (!_degradedToFreeform)
      } else {
        // Fallback to legacy parser
        console.log('[PARSER] fallback_legacy input="%s"', userInput);
        debug.parser = "legacy";
        const parsed = Actions.parseIntent(action);
        const inferredKind = (parsed && parsed.action === "move") ? "MOVE" : "FREEFORM";
        inputObj = mapActionToInput(action, inferredKind);
        inputObj.player_intent.channel = resolvedChannel;
        if (parsed) inputObj.player_intent.action = parsed.action; // mirror what semantic path sets explicitly
        if (parsed?.target) inputObj.player_intent.target = parsed.target;
        if (parsed && parsed.action === "move" && parsed.dir) {
          inputObj.player_intent.dir = parsed.dir;
        }
        // [FALLBACK-ENRICH] Digit-prefix TAKE quantity recovery.
        // Recover digit-quantified TAKE from the fallback parser path.
        // Enrichment produces quantity metadata; triage resolves ORS candidates
        // and routes partial/whole/deny based on source quantity comparison.
        debug._fallbackPartialTakeActive = false;
        debug._fallbackPartialTakeQty = null;

        // Deterministic ORS candidate collector for quantity triage.
        // Scans active objects in the player's current container scope,
        // scores against the normalized target using aliasScore.
        // Returns strictly 0, 1, or many — count > 1 is always ambiguous.
        const _collectFallbackCandidates = (state, query) => {
          const objects = state?.objects;
          if (!objects || typeof objects !== 'object') return { candidates: [], count: 0 };
          const cellKey = (() => {
            const p = state?.world?.position;
            if (!p) return null;
            return 'LOC:' + (p.mx ?? 0) + ',' + (p.my ?? 0) + ':' + (p.lx ?? 0) + ',' + (p.ly ?? 0);
          })();
          const lsId = state?.world?.active_local_space?.local_space_id || null;
          const siteKey = !lsId ? 'SITE:' + ((state?.world?.active_site?.id) || '') : null;
          const candidates = [];
          for (const rec of Object.values(objects)) {
            if (rec.status !== 'active') continue;
            if (rec.current_container_type === 'player') continue;
            if (rec.current_container_type === 'worn') continue;
            let inScope = false;
            if (rec.current_container_type === 'grid' && cellKey && rec.current_container_id === cellKey) inScope = true;
            else if (rec.current_container_type === 'localspace' && lsId && rec.current_container_id === lsId) inScope = true;
            else if (rec.current_container_type === 'site' && siteKey && rec.current_container_id === siteKey) inScope = true;
            if (!inScope) continue;
            const score = Actions.aliasScore(query, rec.name || '', Array.isArray(rec.aliases) ? rec.aliases : []);
            if (score >= 6) {
              candidates.push({ id: rec.id, name: rec.name, quantity: typeof rec.quantity === 'number' ? rec.quantity : 1, score });
            }
          }
          return { candidates, count: candidates.length };
        };

        if (parsed && parsed.action === 'take' && typeof parsed.target === 'string' && /^\d+/.test(parsed.target)) {
          const enriched = _enrichPrimaryAction({ action: parsed.action, target: parsed.target }, userInput || '');
          if (enriched && enriched.selection_mode === 'partial_from_stack' && enriched.requested_quantity != null && enriched.normalized_target) {
            const collected = _collectFallbackCandidates(gameState, enriched.normalized_target);
            if (collected.count === 0) {
              // No ORS match — bypass enrichment, proceed to existing env gather path
            } else if (collected.count > 1) {
              // Ambiguous candidates — fail closed, abort turn
              console.log('[FALLBACK-ENRICH] ambiguous_candidates count=%d query=%s', collected.count, enriched.normalized_target);
              _abortTurn('PARTIAL_TAKE_AMBIGUOUS');
              return res.json({
                sessionId: resolvedSessionId,
                success: true,
                narrative: 'Which item do you mean?',
                state: gameState,
                turn_history: gameState?.turn_history || null,
                debug: { ...debug, parser: 'legacy', error: 'PARTIAL_TAKE_AMBIGUOUS' }
              });
            } else {
              const candidate = collected.candidates[0];
              const sourceQty = candidate.quantity;
              if (enriched.requested_quantity > sourceQty) {
                // Requested exceeds available — fail closed, abort turn
                console.log('[FALLBACK-ENRICH] over_quantity requested=%d available=%d', enriched.requested_quantity, sourceQty);
                _abortTurn('PARTIAL_TAKE_OVER_QUANTITY');
                return res.json({
                  sessionId: resolvedSessionId,
                  success: true,
                  narrative: 'There is not enough of that item available.',
                  state: gameState,
                  turn_history: gameState?.turn_history || null,
                  debug: { ...debug, parser: 'legacy', error: 'PARTIAL_TAKE_OVER_QUANTITY' }
                });
              } else if (enriched.requested_quantity === sourceQty) {
                // Equal quantity — route to whole-object transfer
                delete enriched.selection_mode;
                if (enriched.requested_quantity != null) inputObj.player_intent.requested_quantity = enriched.requested_quantity;
                if (enriched.normalized_target != null) inputObj.player_intent.normalized_target = enriched.normalized_target;
                if (enriched.quantity_mode != null) inputObj.player_intent.quantity_mode = enriched.quantity_mode;
                if (enriched.operation_family != null) inputObj.player_intent.operation_family = enriched.operation_family;
                inputObj.player_intent.raw_input = userInput || '';
              } else {
                // Partial quantity — route through AP quarantine + post-engine guardrail
                inputObj.player_intent.selection_mode = 'partial_from_stack';
                if (enriched.requested_quantity != null) inputObj.player_intent.requested_quantity = enriched.requested_quantity;
                if (enriched.normalized_target != null) inputObj.player_intent.normalized_target = enriched.normalized_target;
                if (enriched.quantity_mode != null) inputObj.player_intent.quantity_mode = enriched.quantity_mode;
                if (enriched.operation_family != null) inputObj.player_intent.operation_family = enriched.operation_family;
                inputObj.player_intent.raw_input = userInput || '';
                debug._fallbackPartialTakeActive = true;
                debug._fallbackPartialTakeQty = enriched.requested_quantity;
              }
            }
          }
        }
        // [PARSER-FAILURE-FALLBACK] Stamp degraded path so RC skip and anti-instantiation fire correctly.
        // Only applies to FREEFORM fallback — MOVE fallback (parsed.action==='move') never reaches _freeformBlock.
        if (inferredKind === 'FREEFORM') {
          inputObj.degraded = true;
          debug.degraded_from = 'PARSER_FAILURE_FALLBACK';
          debug.path = 'PARSER_FAILURE_FREEFORM';
        }
      }

      if (!engineOutput) {
        // v1.84.58: stamp turn number onto player_intent so AP's transferObjectDirect records correct turn
        if (inputObj?.player_intent && typeof inputObj.player_intent === 'object') inputObj.player_intent._turn = turnNumber;
        // v1.84.89: snapshot localspace ID before engine runs — used for state: boundary clear below
        const _preActionLsId = gameState.world?.active_local_space?.local_space_id ?? null;

        engineOutput = Engine.buildOutput(gameState, inputObj, logger);
        // v1.84.89: if localspace boundary was crossed (any L2 transition), clear transient state: attributes
        // so stale posture/position facts don't bleed into the narrator's TRUTH block on re-entry.
        // physical:, object:, declared: are permanent and untouched.
        if (engineOutput?.state) {
          const _postActionLsId = engineOutput.state.world?.active_local_space?.local_space_id ?? null;
          // v1.85.5: also fire on L0↔L1 site-boundary crossings (extends v1.84.89 policy to site transitions)
          // _preTurnLoc.siteId captured before engine ran (v1.85.4); null-safe via optional chain + ?? null
          const _postActionSiteId = engineOutput.state.world?.active_site?.id ?? null;
          const _siteChanged = (_preTurnLoc?.siteId ?? null) !== _postActionSiteId;
          if ((_preActionLsId !== _postActionLsId || _siteChanged) && engineOutput.state.player?.attributes) {
            const _attrs = engineOutput.state.player.attributes;
            for (const key of Object.keys(_attrs)) {
              if (_attrs[key]?.bucket === 'state') delete _attrs[key];
            }
          }
        }
      }
      
      // Log player movement if position changed
      const oldPos = { mx: gameState.world?.position?.mx || 0, my: gameState.world?.position?.my || 0, lx: gameState.world?.position?.lx || 0, ly: gameState.world?.position?.ly || 0 };
      
      if (engineOutput && engineOutput.state) {
        gameState = engineOutput.state;
        // [FALLBACK-GUARDRAIL] Post-engine partial-stack TAKE guardrail.
        // Tightly gated fallback-only call site for ObjectHelper.splitObjectDirect.
        // Fires only when: enrichment active, AP quarantined, source object present,
        // and no synthetic env gather contradiction. Fail-closed on any gap.
        if (debug._fallbackPartialTakeActive) {
          const _apActuals = gameState._apActuals;
          if (_apActuals && _apActuals.outcome === 'refused_ownership' && _apActuals.source_object_id) {
            if (!(gameState._environmentGatherIntent && gameState._environmentGatherIntent.synthetic)) {
              const splitResult = ObjectHelper.splitObjectDirect(
                gameState,
                _apActuals.source_object_id,
                debug._fallbackPartialTakeQty,
                'player',
                'player',
                turnNumber,
                'tls_partial_stack_take'
              );
              gameState._tlsPartialStackResult = {
                schema_version: 'tls_partial_stack_execution_v1',
                executed: splitResult.ok,
                split_result: splitResult,
                ap_actuals: _apActuals
              };
              _tlsPartialStackArchive = gameState._tlsPartialStackResult;
              if (splitResult.ok) {
                _captureCbTlsPartialStackTakeReceipt(splitResult);
                const _tlsPartialSource = gameState.objects?.[splitResult.source_object_id];
                const _tlsPartialSuccessor = gameState.objects?.[splitResult.successor_object_id];
                if (_tlsPartialSource && _tlsPartialSuccessor) {
                  const _parentDescription = _tlsPartialSource.description || '';
                  const _clearDescription = ObjectHelper.setObjectDescriptionDirect(
                    gameState, splitResult.successor_object_id, ''
                  );
                  if (_clearDescription.applied) {
                    _tlsPartialDescriptionTarget = {
                      source_object_id: splitResult.source_object_id,
                      successor_object_id: splitResult.successor_object_id,
                      extracted_quantity: splitResult.applied_quantity,
                      destination_container_type: splitResult.dest_container_type,
                      destination_container_id: splitResult.dest_container_id,
                      parent_description: _parentDescription
                    };
                  }
                }
                if (!Array.isArray(gameState._objectRealityDebug?.audit)) {
                  if (!gameState._objectRealityDebug) gameState._objectRealityDebug = {};
                  gameState._objectRealityDebug.audit = [];
                }
                gameState._objectRealityDebug.audit.push({
                  action: 'tls_partial_stack_take',
                  source_object_id: _apActuals.source_object_id,
                  extract_quantity: debug._fallbackPartialTakeQty,
                  destination_container_type: 'player',
                  destination_container_id: 'player',
                  executed: true,
                  turn: turnNumber,
                  timestamp: new Date().toISOString()
                });
              }
            }
          }
        }
        
        const newPos = { mx: gameState.world?.position?.mx || 0, my: gameState.world?.position?.my || 0, lx: gameState.world?.position?.lx || 0, ly: gameState.world?.position?.ly || 0 };
        
        // Log if player moved
        if (logger && (oldPos.mx !== newPos.mx || oldPos.my !== newPos.my || oldPos.lx !== newPos.lx || oldPos.ly !== newPos.ly)) {
          logger.playerMoved(oldPos, newPos);
        }
        
        sessionStates.set(resolvedSessionId, { ...sessionStates.get(resolvedSessionId), gameState, isFirstTurn, logger });
      }
    } catch (err) {
      console.error('Engine error:', err.message);
      console.error('Engine error stack:', err.stack);
      _abortTurn('ENGINE_ERROR');
      return res.json({ 
        sessionId: resolvedSessionId,
        error: `engine_failed: ${err.message}`,
        error_stack: err.stack,
        narrative: `The engine encountered an error: ${err.message}`,
        state: gameState,
        turn_history: gameState?.turn_history || null,
        debug
      });
    }
  }

  // --- Scene: current cell + nearby cells (N,S,E,W) ---
  const pos = gameState?.world?.position || {};
  const l1w = (gameState?.world?.l1_default?.w) || 128;
  const l1h = (gameState?.world?.l1_default?.h) || 128;
  const l0w = (gameState?.world?.l0_size?.w) || 8;
  const l0h = (gameState?.world?.l0_size?.h) || 8;
  function cellKey(mx,my,lx,ly){ return `LOC:${mx},${my}:${lx},${ly}`; }

  const curKey = cellKey(pos.mx, pos.my, pos.lx, pos.ly);
  const cellsMap = (gameState?.world?.cells) || {};
  if (!cellsMap[curKey]) {
    console.warn(`[DEBUG] Cell key mismatch: looking for ${curKey}, cells available:`, Object.keys(cellsMap).slice(0, 5));
  }
  const curCellRaw = cellsMap[curKey];

  const currentCell = {
    description: (curCellRaw && curCellRaw.description) || "An empty space",
    type: (curCellRaw && curCellRaw.type) || "void",
    subtype: (curCellRaw && curCellRaw.subtype) || "",
    is_custom: !!(curCellRaw && curCellRaw.is_custom),
    key: curKey
  };

  const deltas = [
    { name: "North", dx: 0, dy: -1 },
    { name: "South", dx: 0, dy:  1 },
    { name: "East",  dx: 1, dy:  0 },
    { name: "West",  dx:-1, dy:  0 }
  ];

  const nearbyCells = deltas.map(d => {
    // Use same wrapping logic as movement code to handle L1 grid boundaries
    let lx = (pos.lx || 0) + d.dx;
    let ly = (pos.ly || 0) + d.dy;
    let mx = pos.mx || 0;
    let my = pos.my || 0;
    
    // Handle L1 grid wrapping (wrap to adjacent L0 macro cell if at boundary)
    if (lx < 0) { mx -= 1; lx = l1w - 1; }
    if (lx >= l1w) { mx += 1; lx = 0; }
    if (ly < 0) { my -= 1; ly = l1h - 1; }
    if (ly >= l1h) { my += 1; ly = 0; }
    
    // Wrap macro coordinates around L0 grid (same as streamL1Cells does)
    mx = ((mx % l0w) + l0w) % l0w;
    my = ((my % l0h) + l0h) % l0h;
    
    const key = cellKey(mx, my, lx, ly);
    const c = cellsMap[key];
    return {
      dir: d.name,
      key,
      description: (c && c.description) || "Unknown",
      type: (c && c.type) || "void",
      subtype: (c && c.subtype) || "",
      is_custom: !!(c && c.is_custom)
    };
  });

  const scene = {
    currentCell,
    nearbyCells,
    worldPosition: gameState?.world?.position || {},
    inventory: gameState?.player?.inventory || [],
    npcs: gameState?.world?.npcs || []
  };

  // After-turn debug info
  const afterCells = Object.keys(gameState?.world?.cells || {}).length;
  console.log('[turn] cells_after=', afterCells);

  // ============================================================================
  // COLLECT DIAGNOSTIC DATA FOR FRONTEND
  // ============================================================================
  const cellTypes = Object.values(gameState?.world?.cells || {})
    .map(c => c?.type)
    .filter(t => t && t !== 'void');
  
  const uniqueTerrains = [...new Set(cellTypes)].slice(0, 5); // Up to 5 unique terrain types
  
  // A1: Use same authoritative source as buildDebugContext for position/cell data
  // Note: 'pos' already declared at line 942; reuse it here
  const currentCellKey = `LOC:${pos.mx},${pos.my}:${pos.lx},${pos.ly}`;
  const diagnosticCell = gameState?.world?.cells?.[currentCellKey];
  
  const diagnostics = {
    macro_biome: gameState?.world?.macro_biome || "UNDEFINED",
    has_world_prompt: !!gameState?.world?.macro_biome, // If biome exists, world prompt was processed
    world_prompt_value: gameState?.world?.macro_biome ? `Detected: ${gameState.world.macro_biome}` : "none",
    cells_generated: afterCells,
    sample_cell_types: uniqueTerrains,
    first_turn: isFirstTurn,
    position_macro: `(${pos.mx},${pos.my})`,
    position_local: `(${pos.lx},${pos.ly})`,
    cell_type: diagnosticCell?.type || "unknown",
    cell_subtype: diagnosticCell?.subtype || "unknown",
    starting_location_hint: diagnosticCell?.starting_location_hint || null,
    turn_counter: gameState.turn_counter ?? 0
  };

  if (!process.env.DEEPSEEK_API_KEY) {
    return res.json({ 
      sessionId: resolvedSessionId,
      error: 'DEEPSEEK_API_KEY not set',
      narrative: "The engine processes your action.",
      state: gameState,
      engine_output: engineOutput,
      scene,
      diagnostics,
      debug
    });
  }

  console.log('[narrate] scene:', JSON.stringify(scene, null, 2));

  let visibilityPayload = null;

  try {
    // Phase 6D: _siteDirective / _preNarSiteKey / _expectingSiteName removed.
    // Place identity and naming now exclusively resolved from cell.sites via Phase 5B site context block below.
    const _narCellKey = `LOC:${pos.mx},${pos.my}:${pos.lx},${pos.ly}`;
    const _narCell = gameState?.world?.cells?.[_narCellKey] || null;

    // [SITE-FILL] Pre-narration site fill — independent DS call, fires before narrator.
    // Condition: depth 1, any site in current cell has name===null or description===null.
    const _sfDepth = gameState?.world?.active_local_space ? 3 : gameState?.world?.active_site ? 2 : 1;
    // v1.85.39: track whether any fill block fires so we can emit the skip event if none do
    let _fillStageEmitted = false;
    if (_sfDepth === 1 && _narCell?.sites) {
      const _sfSites = Object.values(_narCell.sites);
      const _sfUnfilled = _sfSites.filter(s => s.name === null || s.description === null);
      if (_sfUnfilled.length > 0) {
        // v1.85.39: fill stage start
        _fillStageEmitted = true;
        diag.emitDiagnostics({ type: 'turn_stage', stage: 'fill', status: 'start', turn: turnNumber, gameSessionId: resolvedSessionId });
        const _sfFoundingClause = gameState.world.founding_prompt
          ? `World description: "${gameState.world.founding_prompt}". `
          : '';
        const _sfCellBiome = _narCell.biome || _narCell.type || 'unknown';
        const _sfSiteList = _sfUnfilled.map(s => ({
          site_id: s.site_id,
          enterable: s.enterable !== false,
          is_community: s.is_community || false,
          site_size: s.site_size ?? null
        }));
        const _sfPrompt = `${_sfFoundingClause}Cell terrain: ${_sfCellBiome}.\nSites requiring identity fill:\n${JSON.stringify(_sfSiteList)}\n\nReturn ONLY a JSON array. No prose, no explanation, no markdown. Each element: {"site_id":"...","name":"...","identity":"...","description":"..."}. Fill every site in the list.`;
        try {
          const _sfResp = await axios.post('https://api.deepseek.com/v1/chat/completions', {
            model: 'deepseek-v4-flash',
            thinking: { type: 'disabled' },
            messages: [{ role: 'user', content: _sfPrompt }],
            temperature: 0.3
          }, {
            headers: {
              'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
              'Content-Type': 'application/json'
            },
            httpsAgent: _sharedHttpsAgent,
            timeout: 30000
          });
          let _sfRaw = _sfResp?.data?.choices?.[0]?.message?.content || '';
          let _sfUpdates = null;
          try { _sfUpdates = JSON.parse(_sfRaw); } catch (_) {
            const _sfBracket = _sfRaw.match(/\[[\s\S]*\]/);
            if (_sfBracket) { try { _sfUpdates = JSON.parse(_sfBracket[0]); } catch (_) {} }
          }
          if (Array.isArray(_sfUpdates)) {
            for (const _sfUpd of _sfUpdates) {
              if (!_sfUpd?.site_id) continue;
              const _sfTgt = _narCell.sites[_sfUpd.site_id];
              if (!_sfTgt) continue;
              for (const _sfField of ['name', 'identity', 'description']) {
                if (_sfUpd[_sfField] != null && _sfTgt[_sfField] == null) {
                  _sfTgt[_sfField] = _sfUpd[_sfField];
                  console.log(`[SITE-FILL] ${_sfUpd.site_id}.${_sfField} = "${_sfUpd[_sfField]}"`);
                  const _sfIk = _sfTgt.interior_key || (_sfUpd.site_id + '/l2');
                  if (_sfIk && gameState.world.sites?.[_sfIk]) {
                    if (_sfField === 'name') gameState.world.sites[_sfIk].name = _sfUpd[_sfField];
                    if (_sfField === 'identity') gameState.world.sites[_sfIk].type = _sfUpd[_sfField];
                  }
                }
              }
              if (_sfTgt.name !== null && _sfTgt.description !== null && _sfTgt.identity !== null) {
                _sfTgt.is_filled = true;
              } else if (_sfTgt.name !== null && _sfTgt.description !== null && _sfTgt.identity === null) {
                console.warn(`[SITE-FILL] WARN: identity missing from fill response for ${_sfUpd.site_id} — is_filled NOT set`);
              }
            }
            sessionStates.set(resolvedSessionId, { ...sessionStates.get(resolvedSessionId), gameState, isFirstTurn, logger });
            // v1.85.39: fill complete (SITE-FILL)
            diag.emitDiagnostics({ type: 'turn_stage', stage: 'fill', status: 'complete', turn: turnNumber, gameSessionId: resolvedSessionId });
          } else {
            console.warn('[SITE-FILL] Failed to parse fill response — blocking narration');
            if (!gameState.world._fillLog) gameState.world._fillLog = [];
            gameState.world._fillLog.push({ ts: new Date().toISOString(), type: 'site', error_label: 'parse_failed', affected_id: null });
            if (gameState.world._fillLog.length > 10) gameState.world._fillLog.shift();
            return res.json({ sessionId: resolvedSessionId, error: 'site_fill_failed', narrative: 'The world is taking shape. Please try again.', state: gameState, diagnostics });
          }
        } catch (_sfErr) {
          console.error('[SITE-FILL] DS call failed:', _sfErr.message);
          if (!gameState.world._fillLog) gameState.world._fillLog = [];
          gameState.world._fillLog.push({ ts: new Date().toISOString(), type: 'site', error_label: 'api_failed', affected_id: null });
          if (gameState.world._fillLog.length > 10) gameState.world._fillLog.shift();
          return res.json({ sessionId: resolvedSessionId, error: `site_fill_failed: ${_sfErr.message}`, narrative: 'The world is taking shape. Please try again.', state: gameState, diagnostics });
        }
      }
    }

    // [LS-FILL] Pre-narration local space fill — independent DS call, fires before narrator.
    // Condition: depth 2, any local space in active site has name===null or description===null.
    if (_sfDepth === 2 && gameState?.world?.active_site?.local_spaces) {
      const _lsf = gameState.world.active_site;
      const _lsfEntries = Object.entries(_lsf.local_spaces);
      const _lsfUnfilled = _lsfEntries.filter(([, s]) => s.name === null || s.description === null);
      if (_lsfUnfilled.length > 0) {
        const _lsfCtxParts = [
          _lsf.name ? `Site name: "${_lsf.name}".` : '',
          _lsf.description ? `Site description: "${_lsf.description}".` : '',
          _lsf.site_size != null ? `Site size: ${_lsf.site_size}.` : ''
        ].filter(Boolean);
        const _lsfSiteContext = _lsfCtxParts.length > 0 ? _lsfCtxParts.join(' ') : 'A site interior.';
        const _lsfSpaceList = _lsfUnfilled.map(([key, s]) => ({
          local_space_id: key,
          x: s.x,
          y: s.y,
          // v1.84.89: pass NPC count so fill LLM does not invent staff for empty spaces
          npc_count: Array.isArray(s.npc_ids) ? s.npc_ids.length : 0,
          // v1.85.47: structural grounding — DS must match name/description to realized scale
          localspace_size: s.localspace_size ?? 1,
          width: s.width ?? null,
          height: s.height ?? null,
          enterable: s.enterable !== false
        }));
        const _lsfPrompt = `${_lsfSiteContext}\nLocal spaces requiring name and description:\n${JSON.stringify(_lsfSpaceList)}\n\nScale interpretation: localspace_size 1 = tiny/compact interior; 2-4 = small; 5-7 = medium; 8-9 = large; 10 = major or exceptional. Names and descriptions must be consistent with the provided localspace_size, width, and height. A space with a large localspace_size must not be described as cramped, tiny, or compact. A space with a small localspace_size must not be described as vast, grand, or expansive.\n\nIf enterable is false, the space is a sealed, collapsed, blocked, or non-traversable structure. Describe it as such — as a visible landmark or external feature only. Do not describe it as an explorable interior. Do not mention any occupants, staff, or NPCs inside it.\n\nIf a space has npc_count 0 and enterable is true, its description must not mention any staff, employees, workers, or people — the space is unpopulated. If npc_count > 0, general presence is permitted but do not name or describe specific individuals.\n\nReturn ONLY a JSON array. No prose, no explanation, no markdown. Each element: {"local_space_id":"...","name":"...","description":"..."}. Fill every space in the list.`;
        try {
          const _lsfResp = await axios.post('https://api.deepseek.com/v1/chat/completions', {
            model: 'deepseek-v4-flash',
            thinking: { type: 'disabled' },
            messages: [{ role: 'user', content: _lsfPrompt }],
            temperature: 0.3
          }, {
            headers: {
              'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
              'Content-Type': 'application/json'
            },
            httpsAgent: _sharedHttpsAgent,
            timeout: 30000
          });
          let _lsfRaw = _lsfResp?.data?.choices?.[0]?.message?.content || '';
          let _lsfUpdates = null;
          try { _lsfUpdates = JSON.parse(_lsfRaw); } catch (_) {
            const _lsfBracket = _lsfRaw.match(/\[[\s\S]*\]/);
            if (_lsfBracket) { try { _lsfUpdates = JSON.parse(_lsfBracket[0]); } catch (_) {} }
          }
          if (Array.isArray(_lsfUpdates)) {
            for (const _lsfUpd of _lsfUpdates) {
              if (!_lsfUpd?.local_space_id) continue;
              const _lsfTgt = _lsf.local_spaces[_lsfUpd.local_space_id];
              if (!_lsfTgt) continue;
              for (const _lsfField of ['name', 'description']) {
                if (_lsfUpd[_lsfField] != null && _lsfTgt[_lsfField] == null) {
                  _lsfTgt[_lsfField] = _lsfUpd[_lsfField];
                  console.log(`[LS-FILL] ${_lsfUpd.local_space_id}.${_lsfField} = "${_lsfUpd[_lsfField]}"`);
                  if (_lsfTgt._generated_interior?.[_lsfField] == null) {
                    if (_lsfTgt._generated_interior) _lsfTgt._generated_interior[_lsfField] = _lsfUpd[_lsfField];
                  }
                }
              }
              if (_lsfTgt.name !== null && _lsfTgt.description !== null) {
                _lsfTgt.is_filled = true;
                if (_lsfTgt._generated_interior) _lsfTgt._generated_interior.is_filled = true;
              }
            }
            sessionStates.set(resolvedSessionId, { ...sessionStates.get(resolvedSessionId), gameState, isFirstTurn, logger });
          } else {
            console.warn('[LS-FILL] Failed to parse fill response — blocking narration');
            if (!gameState.world._fillLog) gameState.world._fillLog = [];
            gameState.world._fillLog.push({ ts: new Date().toISOString(), type: 'localspace', error_label: 'parse_failed', affected_id: null });
            if (gameState.world._fillLog.length > 10) gameState.world._fillLog.shift();
            return res.json({ sessionId: resolvedSessionId, error: 'ls_fill_failed', narrative: 'The location is coming into focus. Please try again.', state: gameState, diagnostics });
          }
        } catch (_lsfErr) {
          console.error('[LS-FILL] DS call failed:', _lsfErr.message);
          if (!gameState.world._fillLog) gameState.world._fillLog = [];
          gameState.world._fillLog.push({ ts: new Date().toISOString(), type: 'localspace', error_label: 'api_failed', affected_id: null });
          if (gameState.world._fillLog.length > 10) gameState.world._fillLog.shift();
          return res.json({ sessionId: resolvedSessionId, error: `ls_fill_failed: ${_lsfErr.message}`, narrative: 'The location is coming into focus. Please try again.', state: gameState, diagnostics });
        }
      }
    }

    // [LS-FILL-ACTIVE] Pre-narration fill for the currently active local space — handles L2 direct starts.
    // Condition: depth 3, active_local_space and active_site exist, stub is unfilled.
    // This is additive — does NOT replace or alter the existing [LS-FILL] block above.
    // v1.83.5: KEY-MISMATCH FIX — active_local_space.local_space_id is the full composite ID
    // (e.g. "site123_ls_0") but active_site.local_spaces is keyed by short ID ("ls_0").
    // Derive short key by stripping the site ID prefix. Fallback to full ID + warn (never skip).
    if (_sfDepth === 3 && gameState?.world?.active_local_space && gameState?.world?.active_site) {
      const _lsfaAls     = gameState.world.active_local_space;
      const _lsfaFullId  = _lsfaAls?.local_space_id;
      if (!_lsfaFullId) {
        console.warn('[LS-FILL-ACTIVE] WARNING: active_local_space has no local_space_id — cannot fill');
      } else {
        // Derive short key: strip "${siteId}_" prefix from the full composite ID.
        const _lsfaSiteId  = gameState.world.active_site.id || gameState.world.active_site.site_id || '';
        const _lsfaPrefix  = _lsfaSiteId ? `${_lsfaSiteId}_` : '';
        let   _lsfaId;
        if (_lsfaPrefix && _lsfaFullId.startsWith(_lsfaPrefix)) {
          _lsfaId = _lsfaFullId.slice(_lsfaPrefix.length);
        } else {
          // Prefix not found — legacy save or short ID already present. Use as-is + warn.
          _lsfaId = _lsfaFullId;
          console.warn(`[LS-FILL-ACTIVE] WARNING: could not strip prefix "${_lsfaPrefix}" from local_space_id "${_lsfaFullId}" — using full ID as short key (legacy/edge case)`);
        }
        const _lsfaStub = gameState.world.active_site?.local_spaces?.[_lsfaId];
        if (!_lsfaStub) {
          console.error(`[LS-FILL-ACTIVE] ERROR: no stub found for key="${_lsfaId}" (fullId="${_lsfaFullId}") in active_site.local_spaces — state mismatch`);
        } else {
          if (_lsfaStub._generated_interior && _lsfaAls !== _lsfaStub._generated_interior) {
            console.warn(`[LS-FILL-ACTIVE] WARNING: active_local_space reference mismatch with stub._generated_interior for id=${_lsfaId}`);
          }
          if (_lsfaStub.name === null || _lsfaStub.description === null) {
            const _lsfaSite = gameState.world.active_site;
            const _lsfaCtxParts = [
              _lsfaSite.name        ? `Site name: "${_lsfaSite.name}".`        : '',
              _lsfaSite.type        ? `Site type: ${_lsfaSite.type}.`           : '',
              _lsfaSite.description ? `Site description: "${_lsfaSite.description}".` : '',
              _lsfaSite.site_size  != null ? `Site size: ${_lsfaSite.site_size}.` : ''
            ].filter(Boolean);
            const _lsfaSiteCtx  = _lsfaCtxParts.length > 0 ? _lsfaCtxParts.join(' ') : 'A site interior.';
            // v1.84.39: inject founding premise as direct naming directive for the starting local space
            const _lsfaRawContext = gameState.world.founding_prompt || gameState.player.birth_record?.raw_input || null;
            const _lsfaPremiseDirective = _lsfaRawContext
              ? `\nPlayer's founding premise: "${_lsfaRawContext}" — this is the specific place the player starts in. Name this local space to match the founding premise as closely as possible, using the proper name of the establishment or location.`
              : '';
            // Send short key in prompt — DS response must echo it back for the write guard to match.
            // v1.85.47: structural grounding — pass realized physical scale to DS
            const _lsfaSpaceList = [{ local_space_id: _lsfaId, x: _lsfaStub.x, y: _lsfaStub.y, npc_count: Array.isArray(_lsfaStub.npc_ids) ? _lsfaStub.npc_ids.length : 0, localspace_size: _lsfaStub.localspace_size ?? 1, width: _lsfaStub.width ?? null, height: _lsfaStub.height ?? null, enterable: _lsfaStub.enterable !== false }];
            const _lsfaPrompt   = `${_lsfaSiteCtx}${_lsfaPremiseDirective}\nEach local space must be coherent with the parent site's identity and purpose. Derive its character from that identity — not from incidental words in the site name or from ambient environmental context.\nA description is a characterization of the space's physical and atmospheric properties. It is not a statement about who occupies it. Occupancy is determined entirely by the engine.\nScale interpretation: localspace_size 1 = tiny/compact interior; 2-4 = small; 5-7 = medium; 8-9 = large; 10 = major or exceptional. Names and descriptions must be consistent with the provided localspace_size, width, and height. A space with a large localspace_size must not be described as cramped, tiny, or compact. A space with a small localspace_size must not be described as vast, grand, or expansive.\nIf enterable is false, the space is a sealed, collapsed, blocked, or non-traversable structure. Describe it as such — as a visible landmark or external feature only. Do not describe it as an explorable interior. Do not mention any occupants, staff, or NPCs inside it.\nLocal spaces requiring name and description:\n${JSON.stringify(_lsfaSpaceList)}\n\nReturn ONLY a JSON array. No prose, no explanation, no markdown. Each element: {"local_space_id":"...","name":"...","description":"..."}. Fill every space in the list.`;
            try {
              const _lsfaResp = await axios.post('https://api.deepseek.com/v1/chat/completions', {
                model: 'deepseek-v4-flash',
                thinking: { type: 'disabled' },
                messages: [{ role: 'user', content: _lsfaPrompt }],
                temperature: 0.3
              }, {
                headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
                httpsAgent: _sharedHttpsAgent,
                timeout: 30000
              });
              let _lsfaRaw     = _lsfaResp?.data?.choices?.[0]?.message?.content || '';
              let _lsfaUpdates = null;
              try { _lsfaUpdates = JSON.parse(_lsfaRaw); } catch (_) {
                const _lsfaBracket = _lsfaRaw.match(/\[[\s\S]*\]/);
                if (_lsfaBracket) { try { _lsfaUpdates = JSON.parse(_lsfaBracket[0]); } catch (_) {} }
              }
              if (Array.isArray(_lsfaUpdates)) {
                for (const _lsfaUpd of _lsfaUpdates) {
                  if (!_lsfaUpd?.local_space_id) continue;
                  // Guard: only update the expected stub (match on short key)
                  if (_lsfaUpd.local_space_id !== _lsfaId) continue;
                  for (const _lsfaField of ['name', 'description']) {
                    if (_lsfaUpd[_lsfaField] != null && _lsfaStub[_lsfaField] == null) {
                      // 1. Write to canonical stub first
                      _lsfaStub[_lsfaField] = _lsfaUpd[_lsfaField];
                      console.log(`[LS-FILL-ACTIVE] ${_lsfaId}.${_lsfaField} = "${_lsfaUpd[_lsfaField]}"`);
                      // 2. Mirror to generated interior (same ref as active_local_space)
                      if (_lsfaStub._generated_interior && _lsfaStub._generated_interior[_lsfaField] == null) {
                        _lsfaStub._generated_interior[_lsfaField] = _lsfaUpd[_lsfaField];
                      }
                    }
                  }
                  if (_lsfaStub.name !== null && _lsfaStub.description !== null) {
                    _lsfaStub.is_filled = true;
                    if (_lsfaStub._generated_interior) _lsfaStub._generated_interior.is_filled = true;
                  }
                }
                // v1.83.5: Post-write guard — no world without fill.
                // Consistent with [NARRATION-GATE] / [LS-FILL] philosophy.
                // Guards against: DS returns valid array but with zero matching IDs (silent zero-write path).
                if (_lsfaStub.name === null || _lsfaStub.description === null) {
                  console.warn(`[LS-FILL-ACTIVE] Post-write guard: stub still incomplete after write loop (id=${_lsfaId}) — blocking narration`);
                  if (!gameState.world._fillLog) gameState.world._fillLog = [];
                  gameState.world._fillLog.push({ ts: new Date().toISOString(), type: 'localspace_active', error_label: 'fill_incomplete', affected_id: _lsfaId });
                  if (gameState.world._fillLog.length > 10) gameState.world._fillLog.shift();
                  return res.json({ sessionId: resolvedSessionId, error: 'ls_fill_active_failed', narrative: 'The location is coming into focus. Please try again.', state: gameState, diagnostics });
                }
                sessionStates.set(resolvedSessionId, { ...sessionStates.get(resolvedSessionId), gameState, isFirstTurn, logger });
              } else {
                console.warn('[LS-FILL-ACTIVE] Failed to parse fill response — blocking narration');
                if (!gameState.world._fillLog) gameState.world._fillLog = [];
                gameState.world._fillLog.push({ ts: new Date().toISOString(), type: 'localspace_active', error_label: 'parse_failed', affected_id: _lsfaId });
                if (gameState.world._fillLog.length > 10) gameState.world._fillLog.shift();
                return res.json({ sessionId: resolvedSessionId, error: 'ls_fill_active_failed', narrative: 'The location is coming into focus. Please try again.', state: gameState, diagnostics });
              }
            } catch (_lsfaErr) {
              console.error('[LS-FILL-ACTIVE] DS call failed:', _lsfaErr.message);
              if (!gameState.world._fillLog) gameState.world._fillLog = [];
              gameState.world._fillLog.push({ ts: new Date().toISOString(), type: 'localspace_active', error_label: 'api_failed', affected_id: _lsfaId });
              if (gameState.world._fillLog.length > 10) gameState.world._fillLog.shift();
              return res.json({ sessionId: resolvedSessionId, error: `ls_fill_active_failed: ${_lsfaErr.message}`, narrative: 'The location is coming into focus. Please try again.', state: gameState, diagnostics });
            }
          }
        }
      }
    }

    // Build safe narration prompt with guards against undefined values
    let nearbyStr = '';
    if (scene.nearbyCells && Array.isArray(scene.nearbyCells)) {
      nearbyStr = scene.nearbyCells
        .filter(c => c && c.dir)
        .map(c => `${c.dir} -> ${c.type || 'void'}`)
        .join('\n');
    } else {
      nearbyStr = 'North -> void\nSouth -> void\nEast -> void\nWest -> void';
    }

    let npcsStr = '(None visible)';
    if (scene.npcs && Array.isArray(scene.npcs) && scene.npcs.length > 0) {
      npcsStr = JSON.stringify(scene.npcs.slice(0, 3));
    }

    // v1.85.32: shared absence-phrase guard — used by birth outfit write-back and NPC intro capture loops.
    // Prefix patterns use trailing space to avoid false hits (e.g. "no-name brand" starts with "no-" not "no ").
    // Exact matches for "none"/"nothing" are whole-string only — "Nothing Knife" does not match.
    function _isAbsencePhrase(name) {
      const n = String(name).toLowerCase().trim();
      if (n === 'none' || n === 'nothing') return true;
      return ['missing ', 'no ', 'bare ', 'without ', 'not wearing '].some(p => n.startsWith(p));
    }

    // v1.85.97: baseline outfit init — fires on Turn 1 before narrator prompt assembly.
    // Logic gate: DS classifier only runs when founding text contains an explicit "I am a/an X" / "I'm a/an X"
    // form claim. No explicit form claim → humanoid assumed per Game Constitution (undeclared = default human).
    // Fix B: uses gameState.world.founding_prompt (canonical) rather than raw action.
    if (turnNumber === 1 && !(gameState.player.worn_object_ids && gameState.player.worn_object_ids.length > 0)) {
      try {
        const _boFoundingText = (gameState.world.founding_prompt || action || '').trim();
        // Explicit form claim: "I am a wizard", "I'm a chicken nugget", etc.
        // Does NOT match: "I am inside a tavern", "I am the king", location/action descriptions.
        const _boHasExplicitForm = /\b(i am|i'm)\s+(a|an)\s+\w/i.test(_boFoundingText);

        // Generic humanoid defaults — used when no form claim is present, or as DS failure fallback.
        const _boGenericItems = [
          { slot: 'shirt',     name: 'shirt',     description: 'A plain shirt.',      source: 'birth_default' },
          { slot: 'pants',     name: 'trousers',  description: 'A pair of trousers.', source: 'birth_default' },
          { slot: 'underwear', name: 'underwear', description: 'Basic underwear.',    source: 'birth_default' },
          { slot: 'socks',     name: 'socks',     description: 'A pair of socks.',    source: 'birth_default' },
          { slot: 'shoes',     name: 'shoes',     description: 'A pair of shoes.',    source: 'birth_default' },
        ];

        let _boItems = null; // null = skip outfit (explicit non-humanoid); array = create these items

        if (_boHasExplicitForm) {
          // Explicit "I am a/an X" — ask DS to classify and generate tone-adapted items
          const _boSystemMsg = `You are a founding-state classifier for a text-based game engine. Your ONLY job is to determine if the player's founding form is humanoid-capable, and if so, return exactly 5 baseline worn items.

RULES:
- Humanoid-capable means: has a human-like body (human, elf, dwarf, cyborg, android, vampire, zombie, knight, wizard, etc.)
- NOT humanoid-capable: animals, insects, plants, inanimate objects, food items, abstract concepts, pure energy, elemental forms, etc.
- If humanoid-capable, return up to 5 items covering: shirt, pants, underwear, socks, shoes
- Adapt item names and descriptions to match the world tone and founding premise (e.g. a medieval knight gets "roughspun tunic" not "t-shirt")
- If the player EXPLICITLY states they are wearing/dressed in something, substitute that slot as source "birth_custom" (e.g. "I wear plate armor" substitutes the shirt slot)
- Do NOT infer worn items from role or title alone. "I am a knight" does NOT auto-generate armor. The player must explicitly state wearing it.
- Do NOT add extra items, armor properties, weapons, valuables, magical effects, or containers beyond the 5 slots
- If a slot has no real item to return (the player is explicitly not wearing anything there, or it genuinely does not apply), OMIT that slot entirely from worn_items. Do NOT return absence descriptions such as "missing pants", "no shirt", "bare feet", "nothing", etc. as item names.
- If NOT humanoid-capable, return is_humanoid_capable: false and worn_items: []

OUTPUT FORMAT — return ONLY valid JSON, no prose, no markdown:
{"is_humanoid_capable": true|false, "worn_items": [{"slot": "shirt|pants|underwear|socks|shoes", "name": "...", "description": "...", "source": "birth_default|birth_custom"}]}`;
          const _boResp = await axios.post('https://api.deepseek.com/v1/chat/completions', {
            model: 'deepseek-v4-flash',
            thinking: { type: 'disabled' },
            messages: [
              { role: 'system', content: _boSystemMsg },
              { role: 'user', content: `Founding premise: "${_boFoundingText}"` }
            ],
            temperature: 0.2,
            max_tokens: 400
          }, {
            headers: {
              'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
              'Content-Type': 'application/json'
            },
            httpsAgent: _sharedHttpsAgent,
            timeout: 15000
          });
          let _boRaw = _boResp?.data?.choices?.[0]?.message?.content || '';
          let _boParsed = null;
          try { _boParsed = JSON.parse(_boRaw); } catch (_) {
            const _boMatch = _boRaw.match(/\{[\s\S]*\}/);
            if (_boMatch) { try { _boParsed = JSON.parse(_boMatch[0]); } catch (_) {} }
          }
          if (_boParsed && _boParsed.is_humanoid_capable === true && Array.isArray(_boParsed.worn_items)) {
            _boItems = _boParsed.worn_items;
          } else if (_boParsed && _boParsed.is_humanoid_capable === false) {
            console.log('[BORN-OUTFIT] Turn 1: explicit non-humanoid form — no baseline outfit created');
            _boItems = null;
          } else {
            console.warn('[BORN-OUTFIT] Turn 1: DS parse failed — falling back to generic defaults');
            _boItems = _boGenericItems;
          }
        } else {
          // No explicit form claim — humanoid assumed per Game Constitution, use generic defaults (no DS call)
          console.log('[BORN-OUTFIT] Turn 1: no explicit form claim — assuming humanoid, applying generic defaults');
          _boItems = _boGenericItems;
        }

        if (_boItems !== null) {
          if (!gameState.objects || typeof gameState.objects !== 'object') gameState.objects = {};
          if (!Array.isArray(gameState.player.worn_object_ids)) gameState.player.worn_object_ids = [];
          const _validSlots = new Set(['shirt', 'pants', 'underwear', 'socks', 'shoes']);
          for (const _boItem of _boItems) {
            if (!_boItem || !_boItem.slot || !_validSlots.has(_boItem.slot)) continue;
            const _boName = String(_boItem.name || _boItem.slot).trim();
            // v1.85.32: Fix 2 — absence filter. DS may return absence slot-fillers despite the prompt rule.
            if (_isAbsencePhrase(_boName)) {
              console.log(`[BORN-OUTFIT] skipped absence-phrase slot: "${_boName}" (${_boItem.slot})`);
              continue;
            }
            const _boDesc = String(_boItem.description || '').trim();
            const _boSrc  = _boItem.source === 'birth_custom' ? 'birth_custom' : 'birth_default';
            const _boIdInput = [_boName.toLowerCase(), 'player_worn', 'player_worn', `born_${_boItem.slot}`].join('|');
            const _boId = 'obj_' + require('crypto').createHash('sha256').update(_boIdInput, 'utf8').digest('hex').slice(0, 12);
            if (!gameState.objects[_boId]) {
              gameState.objects[_boId] = {
                id: _boId,
                name: _boName,
                description: _boDesc,
                created_turn: 1,
                current_container_type: 'player_worn',
                current_container_id: 'player_worn',
                associated_actor_id: 'player',
                source: _boSrc,
                status: 'active',
                conditions: [],
                events: []
              };
            }
            if (!gameState.player.worn_object_ids.includes(_boId)) {
              gameState.player.worn_object_ids.push(_boId);
            }
          }
          console.log(`[BORN-OUTFIT] Turn 1 baseline outfit created: ${gameState.player.worn_object_ids.length} items`);
        }
      } catch (_boErr) {
        console.warn('[BORN-OUTFIT] Turn 1 outfit init error (non-fatal):', _boErr.message);
      }
    }

    // v1.88.0: BORN-NPC block moved to post-Phase-B — see below (~L3875)

    // v1.84.78: build invStr from ORS (player.object_ids → gameState.objects) — legacy scene.inventory is always []
    const _orsIds = Array.isArray(gameState.player?.object_ids) ? gameState.player.object_ids : [];
    const _orsObjs = (gameState.objects && typeof gameState.objects === 'object') ? gameState.objects : {};
    const _invNames = _orsIds.map(id => {
      const _obj = _orsObjs[id];
      if (!_obj || _obj.status !== 'active') return null;
      const qty = typeof _obj.quantity === 'number' ? _obj.quantity : null;
      const unit = (typeof _obj.unit === 'string' && _obj.unit.trim()) ? _obj.unit.trim() : null;
      if (qty !== null && unit !== null) return `${_obj.name} (quantity: ${qty}, unit: ${unit})`;
      if (qty !== null) return `${_obj.name} (quantity: ${qty})`;
      return _obj.name;
    }).filter(Boolean);
    let invStr = JSON.stringify(_invNames);
    // v1.85.22: build wornStr from ORS (player.worn_object_ids → gameState.objects)
    const _wornIds = Array.isArray(gameState.player?.worn_object_ids) ? gameState.player.worn_object_ids : [];
    const _wornNames = _wornIds.map(id => {
      const _wr = _orsObjs[id];
      if (!_wr || _wr.status !== 'active') return null;
      return _wr.source === 'birth_default' ? `${_wr.name} (baseline)` : _wr.name;
    }).filter(Boolean);
    let wornStr = JSON.stringify(_wornNames);

    // v1.91.78: build ground listing from ORS — local ground objects at player's current location
    // Determine current layer from containment state (mirrors _narDepth at L3321)
    const _groundDepth = gameState?.world?.active_local_space ? 3 : gameState?.world?.active_site ? 2 : 1;

    // Pre-compute layer-specific container IDs (null when unavailable for the current layer)
    const _gPos = gameState.world?.position;
    const _gridCellKey = _gPos ? `LOC:${_gPos.mx},${_gPos.my}:${_gPos.lx},${_gPos.ly}` : null;

    let _siteFloorKey = null;
    if (_groundDepth === 2) {
      const _gSite = gameState.world.active_site;
      const _gPx = gameState.player?.position?.x;
      const _gPy = gameState.player?.position?.y;
      const _gSiteId = _gSite?.site_id || _gSite?.id?.replace(/\/l2$/, '');
      if (_gSiteId != null && _gPx != null && _gPy != null) {
        _siteFloorKey = `${_gSiteId}:${_gPx},${_gPy}`;
      }
    }

    let _localspaceKey = null;
    if (_groundDepth === 3) {
      const _gLs = gameState.world.active_local_space;
      if (_gLs?.local_space_id) _localspaceKey = _gLs.local_space_id;
    }

    // Predicate: true only when (type, id) match an exact valid pair for the current layer.
    // The type and id are bound together — a grid object only matches the cell key,
    // a site object only matches the site floor key (and only at L1),
    // a localspace object only matches the localspace key (and only at L2).
    const _isGroundContainer = (_r) => {
      if (!_r || _r.status !== 'active') return false;
      // L0 grid — always includes the grid cell at every layer (backward compat for legacy DROP)
      if (_r.current_container_type === 'grid' && _r.current_container_id === _gridCellKey) return true;
      // L1 site floor — only when site key is available (player must be at L1)
      if (_r.current_container_type === 'site' && _siteFloorKey !== null && _r.current_container_id === _siteFloorKey) return true;
      // L2 localspace — only when localspace key is available (player must be at L2)
      if (_r.current_container_type === 'localspace' && _localspaceKey !== null && _r.current_container_id === _localspaceKey) return true;
      return false;
    };

    // Serialize ground objects using Phase 1 quantity/unit guard pattern
    const _groundNames = Object.values(_orsObjs)
      .filter(_r => _isGroundContainer(_r))
      .map(_r => {
        const qty = typeof _r.quantity === 'number' ? _r.quantity : null;
        const unit = (typeof _r.unit === 'string' && _r.unit.trim()) ? _r.unit.trim() : null;
        if (qty !== null && unit !== null) return `${_r.name} (quantity: ${qty}, unit: ${unit})`;
        if (qty !== null) return `${_r.name} (quantity: ${qty})`;
        return _r.name;
      });
    const _groundStr = JSON.stringify(_groundNames);

    // Phase 5B: Build site context block from current cell's sites (filled only — unfilled slots are engine-internal placeholders, never narrator-visible)
    let _siteContextBlock = '';
    const _narCellSites = _narCell?.sites ? Object.values(_narCell.sites).filter(s => s.is_filled === true) : [];
    if (_narCellSites.length > 0) {
      const _siteLines = _narCellSites
        .map(s => `- site_id: ${s.site_id} | name: ${s.name} | enterable: ${s.enterable === false ? 'NO' : 'YES (has a navigable interior — building, cave, structure, or enclosed space)'} | is_community: ${s.is_community ? 'YES' : 'NO'}${s.site_size != null ? ` | site_size: ${s.site_size}` : ''}`)
        .join('\n');
      const _instructionLines = '\nAll sites above have stored names. Use them exactly as written — do not invent alternatives.' +
                                '\nWhen narrating the overworld, refer to any named site by its proper name rather than a generic description.' +
                                '\nSites with enterable: NO must NOT be described as having open doors, visible interiors, accessible entrances, or any language implying the player can enter or explore them.';
      _siteContextBlock = `\n\nSITES AT CURRENT LOCATION:\n${_siteLines}${_instructionLines}`;
    }

    // Phase 10: Override scene description and site context when player is inside a site
    // Layer derived from containment state — not from current_depth counter which can drift.
    const _narDepth = gameState?.world?.active_local_space ? 3 : gameState?.world?.active_site ? 2 : 1;
    const _narActiveSite = gameState?.world?.active_site || null;

    // [NPC-FILL] Fill DS-owned NPC identity fields (npc_name, gender, age, job_category) for newly-born NPCs.
    // Fires every turn but skips immediately when all NPCs are already filled (frozen check).
    // Non-blocking on failure: NPCs pass through with null fields + _fill_error. Never hard-blocks narration.
    if (_narActiveSite && Array.isArray(_narActiveSite.npcs) && _narActiveSite.npcs.length > 0) {
      const _DS_FIELDS = ['npc_name', 'gender', 'age', 'job_category'];
      const _fillNeeded = _narActiveSite.npcs.filter(n =>
        n && !n._fill_frozen && _DS_FIELDS.some(f => n[f] == null)
      );
      if (_fillNeeded.length > 0) {
        try {
          const _fillSiteCtx = [
            _narActiveSite.name        ? `Site name: "${_narActiveSite.name}".`        : '',
            _narActiveSite.description ? `Site description: "${_narActiveSite.description}".` : '',
            _narActiveSite.type        ? `Site type: ${_narActiveSite.type}.`           : ''
          ].filter(Boolean).join(' ') || 'A settlement interior.';
          const _fillList = _fillNeeded.map(n => ({ id: n.id, traits: n.traits || [] }));
          const _fillPrompt = `${_fillSiteCtx}\n\nFor each NPC in this list, invent a fitting identity. Return ONLY a JSON array — no prose, no markdown.\n\nEach element must be:\n{"id":"<exact id from input>","npc_name":"<full name>","gender":"<male|female|nonbinary>","age":<integer 12-80>,"job_category":"<occupation string>"}\n\nNPC list:\n${JSON.stringify(_fillList)}\n\nRules:\n- id must match the input id exactly\n- npc_name, gender, age, job_category must ALL be non-null\n- age must be a number (integer)\n- job_category should fit the site context and the NPC's traits\n- Return one element per NPC in the input list`;
          const _fillResp = await axios.post('https://api.deepseek.com/v1/chat/completions', {
            model: 'deepseek-v4-flash',
            thinking: { type: 'disabled' },
            messages: [{ role: 'user', content: _fillPrompt }],
            temperature: 0.7
          }, {
            headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
            httpsAgent: _sharedHttpsAgent,
            timeout: 30000
          });
          let _fillRaw = _fillResp?.data?.choices?.[0]?.message?.content || '';
          let _fillUpdates = null;
          try { _fillUpdates = JSON.parse(_fillRaw); } catch (_) {
            const _fillBracket = _fillRaw.match(/\[[\s\S]*\]/);
            if (_fillBracket) { try { _fillUpdates = JSON.parse(_fillBracket[0]); } catch (_) {} }
          }
          if (Array.isArray(_fillUpdates)) {
            for (const npc of _fillNeeded) {
              const upd = _fillUpdates.find(u => u && u.id === npc.id);
              if (!upd) {
                console.warn(`[NPC-FILL] No entry returned for npc id=${npc.id} — marking _fill_error`);
                npc._fill_error = 'missing_from_response';
                continue;
              }
              const allPresent = _DS_FIELDS.every(f => upd[f] != null);
              if (!allPresent) {
                const missing = _DS_FIELDS.filter(f => upd[f] == null).join(',');
                console.warn(`[NPC-FILL] Incomplete fill for npc id=${npc.id} missing=${missing} — atomic fail`);
                npc._fill_error = `incomplete_fields:${missing}`;
                continue;
              }
              // Atomic write: all 4 fields present
              // npc_name guard: never overwrite a pre-existing canonical name (declared at founding or learned)
              if (npc.npc_name == null) npc.npc_name = String(upd.npc_name);
              npc.gender       = String(upd.gender);
              const _parsedAge = Number(upd.age);
              if (!Number.isFinite(_parsedAge)) {
                console.warn(`[NPC-FILL] Invalid age for npc id=${npc.id} raw="${upd.age}" — atomic fail`);
                npc._fill_error = `invalid_age:${upd.age}`;
                continue;
              }
              npc.age          = _parsedAge;
              npc.job_category = String(upd.job_category);
              npc._fill_frozen = true;
              delete npc._fill_error;
              console.log(`[NPC-FILL] Filled npc id=${npc.id} name="${npc.npc_name}" job="${npc.job_category}" gender=${npc.gender} age=${npc.age}`);
            }
          } else {
            console.error('[NPC-FILL] Failed to parse DS response — all fill-needed NPCs marked _fill_error');
            for (const npc of _fillNeeded) npc._fill_error = 'parse_failed';
          }
        } catch (_fillErr) {
          console.error('[NPC-FILL] DS call failed:', _fillErr.message);
          for (const npc of _fillNeeded) npc._fill_error = `api_failed:${_fillErr.message}`;
        }
      }
    }

    // v1.85.39: if no fill block fired, emit the explicit skip so frontend can mark [-]
    if (!_fillStageEmitted) {
      diag.emitDiagnostics({ type: 'turn_stage', stage: 'fill', status: 'skip', turn: turnNumber, gameSessionId: resolvedSessionId });
    }

    // [NARRATION-GATE] Block narration if active site slot is incomplete.
    // Operates on canonical slot (cell.sites[id]), NOT on active_site mirror fields.
    // Hard-blocks if active_site exists but slot cannot be resolved (state integrity failure).
    if (_narActiveSite) {
      const _gCellKey = (_narActiveSite.mx != null && _narActiveSite.lx != null)
        ? `LOC:${_narActiveSite.mx},${_narActiveSite.my}:${_narActiveSite.lx},${_narActiveSite.ly}` : null;
      const _gCell = _gCellKey ? gameState.world.cells?.[_gCellKey] : null;
      const _gSlot = _gCell?.sites
        ? Object.values(_gCell.sites).find(s => s.interior_key === _narActiveSite.id) : null;
      if (!_gSlot) {
        console.error(`[NARRATION-GATE] ERROR: active_site exists but canonical slot cannot be resolved — id=${_narActiveSite.id}. State integrity failure.`);
        if (!gameState.world._fillLog) gameState.world._fillLog = [];
        gameState.world._fillLog.push({ ts: new Date().toISOString(), type: 'site', error_label: 'slot_resolution_failed', affected_id: _narActiveSite.id });
        if (gameState.world._fillLog.length > 10) gameState.world._fillLog.shift();
        return res.json({ sessionId: resolvedSessionId, error: 'site_state_integrity_failure',
          narrative: 'The world encountered an internal error. Please try again.',
          state: gameState });
      }
      const _gMissing = ['name','description','identity'].filter(f => !_gSlot[f]);
      if (_gMissing.length > 0) {
        console.warn(`[NARRATION-GATE] Active site slot incomplete — blocking narration. missing=${_gMissing.join(',')}`);
        if (!gameState.world._fillLog) gameState.world._fillLog = [];
        gameState.world._fillLog.push({ ts: new Date().toISOString(), type: 'site', error_label: 'incomplete_active_site', affected_id: _narActiveSite.id, missing: _gMissing });
        if (gameState.world._fillLog.length > 10) gameState.world._fillLog.shift();
        return res.json({ sessionId: resolvedSessionId, error: 'site_incomplete',
          narrative: 'The world is still being prepared. Please try again.',
          state: gameState });
      }
    }

    // [LOCAL-SPACE-GATE] Structural safety net for depth-3 narration — parallel to [NARRATION-GATE] for sites.
    // LAYERED PROTECTION — not duplicate logic:
    //   [LS-FILL-ACTIVE] failure = fill pipeline failure (API error, parse error, zero writes after key fix)
    //   [LOCAL-SPACE-GATE]       = catches any remaining path where active_local_space is still incomplete
    // Different error codes, different timing windows. Do not collapse these.
    if (_narDepth === 3 && gameState?.world?.active_local_space) {
      const _lgAls = gameState.world.active_local_space;
      if (_lgAls.name === null || _lgAls.description === null) {
        const _lgMissing = ['name','description'].filter(f => _lgAls[f] === null || _lgAls[f] === undefined);
        console.warn(`[LOCAL-SPACE-GATE] Active local space incomplete — blocking narration. missing=${_lgMissing.join(',')}`);
        if (!gameState.world._fillLog) gameState.world._fillLog = [];
        gameState.world._fillLog.push({ ts: new Date().toISOString(), type: 'localspace', error_label: 'incomplete_active_local_space', affected_id: _lgAls.local_space_id ?? null, missing: _lgMissing });
        if (gameState.world._fillLog.length > 10) gameState.world._fillLog.shift();
        return res.json({ sessionId: resolvedSessionId, error: 'local_space_incomplete',
          narrative: 'The interior space is still taking shape. Please try again.',
          state: gameState, diagnostics });
      }
    }
    if (_narDepth === 2 && _narActiveSite && gameState?.player?.position) {
      _narActiveSite._visible_npcs = Actions.computeVisibleNpcs(_narActiveSite, gameState.player.position);
    } else if (_narDepth === 3 && gameState?.world?.active_local_space && gameState?.player?.position) {
      gameState.world.active_local_space._visible_npcs = Actions.computeVisibleNpcs(gameState.world.active_local_space, gameState.player.position, gameState.world.active_site?.npcs || []);
    } else if (_narDepth === 1) {
      const _l0pos = gameState.world?.position || {};
      gameState.world._visible_npcs = (gameState.world?.npcs || []).filter(npc =>
        npc.position?.mx === _l0pos.mx && npc.position?.my === _l0pos.my &&
        npc.position?.lx === _l0pos.lx && npc.position?.ly === _l0pos.ly
      );
    }
    const _narLogPos = _narDepth === 1 ? 'L0' : (gameState?.player?.position ?? 'unset');
    console.log('[NARRATE-NPC] depth=%s site=%s pos=%o count=%s', _narDepth, !!_narActiveSite, _narLogPos, _narActiveSite?._visible_npcs?.length ?? 'n/a');
    // v1.56.0: Eviction check + continuity block pre-build (after computeVisibleNpcs for fresh _visible_npcs)
    NC.resetDiagnostics();
    const { evicted: _continuityEvicted, reason: _continuityEvictionReason } = NC.checkEviction(gameState);
    if (_continuityEvicted) {
      NC.pushAlert({ severity: 'Info', type: 'continuity_eviction', description: `Continuity evicted (${_continuityEvictionReason})`, entity_ref: null, turn: (gameState.turn_history ? gameState.turn_history.length : 0) + 1 });
    }
    const _cbMeta = {};  // v1.84.31: accumulator for CB diagnostic passback
    const _continuityBlock = CB.assembleContinuityPacket(gameState, _cbMeta); // v1.70.0
    diag.setLastRenderedBlock(_continuityBlock);  // Cluster 5: state repatriated to diagnostics.js
    diag.pushContinuityBlock(turnNumber, _continuityBlock, _continuityBlock.length);
    diag.setLastGameState(gameState);              // Cluster 5: live ref passed to diagnostics owner
    diag.setLastSessionId(resolvedSessionId);      // Cluster 5: cached for /diagnostics/session
    // v1.63.0: reflects actual block output — true when narrator received any continuity content
    // (active_continuity OR narrative_memory entries), not just active_continuity presence
    const _continuityInjected = _continuityBlock.length > 0;
    const _continuityBlockSnapshot = gameState.world.active_continuity ? JSON.parse(JSON.stringify(gameState.world.active_continuity)) : null;
    // v1.59.0: Build _engineSpatialBlock — engine-confirmed spatial authority injected AFTER continuity block
    let _engineSpatialBlock = '';
    {
      const _esPos = gameState.world.position;
      const _esCellKey = _esPos ? `LOC:${_esPos.mx},${_esPos.my}:${_esPos.lx},${_esPos.ly}` : null;
      const _esCellSites = (_esCellKey && gameState.world.cells?.[_esCellKey]?.sites) ? gameState.world.cells[_esCellKey].sites : {};
      const _esUnentered = Object.values(_esCellSites).filter(s => s.is_filled === true && !s.entered);
      if (_narDepth === 1) {
        const _esNames = _esUnentered.map(s => s.name || s.site_id).filter(Boolean).join(', ');
        _engineSpatialBlock = `[ENGINE SPATIAL STATE — AUTHORITY]\nLayer: L0\nEntered: false\nThe player is NOT inside any structure.\nAny narration describing interior occupancy is INVALID.\n${_esNames ? `Structures visible but NOT entered: ${_esNames}` : 'No structures present.'}\nIf any CONTINUITY — TRUTH or CONTINUITY — MOOD content describes the player's location, posture, or movement in a way that contradicts this spatial state, disregard it. This block is the authoritative location record.`;
      } else if (_narDepth === 2 && _narActiveSite) {
        _engineSpatialBlock = `[ENGINE SPATIAL STATE — AUTHORITY]\nLayer: L1 (open site area — ${_narActiveSite.name || _narActiveSite.site_id})\nThe player is NOT inside any building or local space.\nIf any CONTINUITY — TRUTH or CONTINUITY — MOOD content describes the player's location, posture, or movement in a way that contradicts this spatial state, disregard it. This block is the authoritative location record.`;
      } else if (_narDepth === 3 && gameState.world.active_local_space) {
        _engineSpatialBlock = `[ENGINE SPATIAL STATE — AUTHORITY]\nLayer: L2. Player is inside ${gameState.world.active_local_space.name || gameState.world.active_local_space.local_space_id}. Interior narration is confirmed.\nIf any CONTINUITY — TRUTH or CONTINUITY — MOOD content describes the player's location, posture, or movement in a way that contradicts this spatial state, disregard it. This block is the authoritative location record.`;
      }
    }
    // Consume _engineMessage (transient — clear after capture so it doesn't repeat)
    let _engineMsg = gameState?.world?._engineMessage || null;
    if (_engineMsg) gameState.world._engineMessage = null;
    // v1.84.38: refresh stale "unnamed place" message — LS-FILL-ACTIVE runs before this point
    // and may have populated active_local_space.name after _engineMessage was originally set
    if (_engineMsg && _engineMsg.includes('an unnamed place') && gameState.world.active_local_space?.name) {
      _engineMsg = `You begin inside ${gameState.world.active_local_space.name}.`;
    }
    // Consume _npcTalkResult (transient — clear after capture so it doesn't repeat)
    const _npcTalkResult = gameState?.world?._npcTalkResult || null;
    if (_npcTalkResult) gameState.world._npcTalkResult = null;
    let _narSceneDesc = scene.currentCell?.description || 'An empty space';
    let _narSceneType = scene.currentCell?.type || 'void';
    // Guard: only L0 geography vocabulary may appear as terrain in the overworld prompt
    if (!WorldGen.LAYER_TERRAIN_VOCAB.L0_GEOGRAPHY.includes(_narSceneType)) {
      _narSceneType = 'terrain';
    }
    let _narTileType = 'open_area';
    let _narActiveLS = null;
    if (_narDepth === 3 && gameState?.world?.active_local_space) {
      _narActiveLS = gameState.world.active_local_space;
      _narSceneDesc = _narActiveLS.description || `The interior of ${_narActiveLS.name || 'a local space'}.`;
      _narSceneType = 'local_space_interior';
      const _lsNpcs = _narActiveLS._visible_npcs || [];
      const _lsNpcNames = _lsNpcs.map(n => n.job_category || n.id).filter(Boolean).join(', ') || '(none visible)';
      if (_lsNpcs.length > 0) {
        npcsStr = JSON.stringify(_lsNpcs.map(n => {
          const _ne = { id: n.id, job: n.job_category, gender: n.gender, age: n.age, npc_name: n.is_learned ? n.npc_name : null, is_learned: n.is_learned ?? false };
          if (Array.isArray(n.object_ids) && n.object_ids.length > 0) {
            const _carries = n.object_ids.map(oid => gameState.objects?.[oid]?.name).filter(Boolean);
            if (_carries.length) _ne.carries = _carries;
          }
          if (Array.isArray(n.worn_object_ids) && n.worn_object_ids.length > 0) {
            const _wears = n.worn_object_ids.map(oid => gameState.objects?.[oid]?.name).filter(Boolean);
            if (_wears.length) _ne.wears = _wears;
          }
          if (n.narrative_state) Object.assign(_ne, n.narrative_state);
          return _ne;
        }));
      } else {
        npcsStr = '(None visible)';
      }
      _siteContextBlock = `\n\nCURRENT LOCAL SPACE (you are inside this location):\nName: ${_narActiveLS.name || '(unnamed)'}\nNPCs nearby: ${_lsNpcNames}\nIMPORTANT: The name above is COMMITTED. Use it exactly as given. Do not rename, reinterpret, or substitute a different room, section, or area for this location. The engine has already assigned this specific space. Render it.`;
      const _lsp = gameState?.player?.position;
      if (_lsp && _narActiveLS.grid) {
        const _lsCell = _narActiveLS.grid[_lsp.y]?.[_lsp.x] ?? null;
        const _lsCellType = _lsCell?.type || 'open_area';
        _siteContextBlock += `\nYour position in local space: (${_lsp.x},${_lsp.y}) \u2014 ${_lsCellType}`;
      }
    } else if (_narDepth >= 2 && _narActiveSite) {
      _narSceneDesc = _narActiveSite.description ||
        `The ${_narActiveSite.type || '(unknown site)'} of ${_narActiveSite.name || '(unknown site)'}. Streets and buildings fill the area.`;
      _narSceneType = _narActiveSite.type || 'site_interior';
      // Use engine-computed visible set (derived from grid tile placement at player position)
      const _siteNpcs = _narActiveSite._visible_npcs || [];
      const _siteNpcNames = _siteNpcs.map(n => n.job_category || n.id).filter(Boolean).join(', ') || '(none visible)';
      // Sync npcsStr with visible NPCs — this is the hard authority boundary for narration
      if (_siteNpcs.length > 0) {
        npcsStr = JSON.stringify(_siteNpcs.map(n => {
          const _ne = { id: n.id, job: n.job_category, gender: n.gender, age: n.age, npc_name: n.is_learned ? n.npc_name : null, is_learned: n.is_learned ?? false };
          if (Array.isArray(n.object_ids) && n.object_ids.length > 0) {
            const _carries = n.object_ids.map(oid => gameState.objects?.[oid]?.name).filter(Boolean);
            if (_carries.length) _ne.carries = _carries;
          }
          if (Array.isArray(n.worn_object_ids) && n.worn_object_ids.length > 0) {
            const _wears = n.worn_object_ids.map(oid => gameState.objects?.[oid]?.name).filter(Boolean);
            if (_wears.length) _ne.wears = _wears;
          }
          if (n.narrative_state) Object.assign(_ne, n.narrative_state);
          return _ne;
        }));
      } else {
        npcsStr = '(None visible)';
      }
      // v1.81.2: Population count removed from narrator prompt — telling the narrator how many
      // NPCs exist in the building (even if none are at the player's tile) was giving the model
      // license to render off-screen persons it inferred must be somewhere. Narrator sees only
      // what is at the player's tile via NPCs nearby.
      _siteContextBlock = `\n\nCURRENT SITE (you are inside this location):\nName: ${_narActiveSite.name || '(unnamed)'}\nType: ${_narActiveSite.type || 'site'}\nNPCs nearby: ${_siteNpcNames}`;
      const _sp = gameState?.player?.position;
      if (_sp && _narActiveSite.grid) {
        const _gridCell = _narActiveSite.grid[_sp.y]?.[_sp.x] ?? null;
        const _cellType = _gridCell?.type || 'open_area';
        _narTileType = _cellType;
        const _cellNpcIds = _gridCell?.npc_ids || [];
        const _cellNpcs = (_narActiveSite.npcs || []).filter(n => _cellNpcIds.includes(n.id)).map(n => n.name || n.id);
        const _bldInfo = _gridCell?.type === 'local_space' && _narActiveSite.local_spaces?.[_gridCell.local_space_id]?.name
          ? ` (${_narActiveSite.local_spaces[_gridCell.local_space_id].name})`
          : '';
        const _tileDesc = _cellType === 'local_space'
          ? `local space${_bldInfo}. You are OUTSIDE this local space. Describe the façade, entrance, and surroundings only. Do NOT describe or infer any interior.`
          : `${_cellType}${_bldInfo}`;
        _siteContextBlock += `\nYour position in site: (${_sp.x},${_sp.y}) — ${_tileDesc}`;
        if (_cellNpcs.length > 0) _siteContextBlock += `\nNPCs at your location: ${_cellNpcs.join(', ')}`;
      }
    } else {
      // L0: overworld NPC narrator injection — mirrors L1/L2 serializer shape exactly
      const _l0Npcs = gameState.world._visible_npcs || [];
      if (_l0Npcs.length > 0) {
        npcsStr = JSON.stringify(_l0Npcs.map(n => {
          const _ne = { id: n.id, job: n.job_category, gender: n.gender, age: n.age, npc_name: n.is_learned ? n.npc_name : null, is_learned: n.is_learned ?? false };
          if (n.role_or_relation) _ne.role_or_relation = n.role_or_relation;
          if (n.description) _ne.description = n.description;
          if (Array.isArray(n.object_ids) && n.object_ids.length > 0) {
            const _carries = n.object_ids.map(oid => gameState.objects?.[oid]?.name).filter(Boolean);
            if (_carries.length) _ne.carries = _carries;
          }
          if (Array.isArray(n.worn_object_ids) && n.worn_object_ids.length > 0) {
            const _wears = n.worn_object_ids.map(oid => gameState.objects?.[oid]?.name).filter(Boolean);
            if (_wears.length) _ne.wears = _wears;
          }
          if (n.narrative_state) Object.assign(_ne, n.narrative_state);
          return _ne;
        }));
      } else {
        npcsStr = '(None visible)';
      }
      // _siteContextBlock intentionally left empty at L0 — overworld has no site context
    }

    // Phase 9: Approved additive context — biome/civ/env enrichment only
    const _narBiome = gameState?.world?.macro_biome || null;
    const _narCivPresence = gameState?.world?.world_bias?.civilization_presence || null;
    const _narEnvTone = gameState?.world?.world_bias?.environment_tone || null;

    // Build optional engine message block (failed enter, failed exit, etc.)
    const _engineMsgBlock = _engineMsg ? `\nSYSTEM NOTE: ${_engineMsg}\n` : '';

    // Fix 6: When player moved (action === 'move') and is at L0, clarify new cell context.
    // Source: inputObj.player_intent.action — engineOutput never carries an actions field.
    const _actionType = inputObj?.player_intent?.action || '';
    const _movedNote = (_actionType === 'move' && _narDepth === 1)
      ? '\nNOTE: Player moved to a new overworld cell. Any sites visible here belong to this cell — they are not changes to the previous location.\n'
      : '';



    // Issue 2: FREEFORM action acknowledgment — inject when action has no mechanical effect.
    // parsedIntent is populated AFTER narration — do not reference here.
    // Source: inputObj.player_intent.action — engineOutput never carries an actions field.
    const _parsedAction = inputObj?.player_intent?.action || '';
    const _rawInput = (action || '').trim();

    // v1.88.0: Authority Gate — pre-RC routing layer.
    // Inject parsed target onto the gate's state view for object-existence helpers.
    // Cleared immediately after gate returns so it never pollutes other logic.
    let _authorityGateResult = null;
    let _agDurationMs = 0;
    const _authorityGateState = _authorityGateWholeDropObjectId
      ? {
          ...gameState,
          player: { ...gameState.player, object_ids: [...(gameState.player?.object_ids || []), _authorityGateWholeDropObjectId] }
        }
      : gameState;
    _authorityGateState._lastParsedTarget = inputObj?.player_intent?.target || null;
    if (turnNumber === 1) {
      diag.emitDiagnostics({ type: 'turn_stage', stage: 'authority_gate', status: 'skip', turn: turnNumber, gameSessionId: resolvedSessionId });
      _authorityGateResult = { decision: 'allow_no_rc', route: 'narrator', rc_allowed: false, input_type: 'valid_low_risk', reason_code: 'turn_1_founding', referenced_objects: [], referenced_entities: [], referenced_abilities: [], evidence: { engine_supported: true, matched_records: [] }, _llm_called: false, gate_fast_path_hit: false, llm_confidence: null };
    } else {
      diag.emitDiagnostics({ type: 'turn_stage', stage: 'authority_gate', status: 'start', turn: turnNumber, gameSessionId: resolvedSessionId });
      const _agStart = Date.now();
      _authorityGateResult = await AuthorityGate.runAuthorityGate(_rawInput, _authorityGateState, _parsedAction, process.env.DEEPSEEK_API_KEY);
      _agDurationMs = Date.now() - _agStart;
      diag.emitDiagnostics({ type: 'turn_stage', stage: 'authority_gate', status: 'complete', turn: turnNumber, gameSessionId: resolvedSessionId, decision: _authorityGateResult.decision, rc_allowed: _authorityGateResult.rc_allowed });
    }
    // v1.91.44: AG payload snapshot — captured immediately after gate returns, before any downstream mutation.
    // Includes prompt, evidence bundle, raw LLM response, and final post-validator result.
    const _agPayloadSnapshot = _authorityGateResult ? {
      prompt:              _authorityGateResult._ag_prompt || null,
      evidence:            _authorityGateResult.evidence || null,
      raw_response:        _authorityGateResult._ag_raw_response || null,
      result_decision:     _authorityGateResult.decision,
      result_route:        _authorityGateResult.route,
      result_rc_allowed:   _authorityGateResult.rc_allowed,
      result_reason_code:  _authorityGateResult.reason_code,
      result_input_type:   _authorityGateResult.input_type,
      validator_applied:   _authorityGateResult.evidence?.validator_applied || false,
      _llm_called:         _authorityGateResult._llm_called,
      gate_fast_path_hit:  _authorityGateResult.gate_fast_path_hit,
      // v1.91.XX: expanded AG observability for Mother Brain diagnostics
      referenced_objects:  _authorityGateResult.referenced_objects ?? null,
      referenced_entities: _authorityGateResult.referenced_entities ?? null,
      referenced_abilities: _authorityGateResult.referenced_abilities ?? null,
      llm_confidence:      _authorityGateResult.llm_confidence ?? null,
      evidence_bundle:     _authorityGateResult._ag_evidence_bundle || null
    } : null;
    delete _authorityGateState._lastParsedTarget;
    console.log(`[AUTHORITY-GATE] turn:${turnNumber} decision:${_authorityGateResult.decision} route:${_authorityGateResult.route} reason:${_authorityGateResult.reason_code} fast_path:${_authorityGateResult.gate_fast_path_hit ? 'L1' : 'L2'} llm:${_authorityGateResult._llm_called ? 'yes' : 'no'} dur:${_agDurationMs}ms`);
    if (_authorityGateResult.decision === 'freeform') {
      // Gate denied — block RC; narrator receives denial block assembled below.
      // _rcSkippedReason is set here; the existing RC skip block below will not override it
      // because its else-if chain only fires when _rcSkippedReason is still null.
    }

    // v1.84.21: Flight recorder — per-turn payload snapshots (written atomically at turn-close)
    let _rcPayloadSnapshot          = null;
    let _narratorPayloadSnapshot    = null;
    let _cbPayloadSnapshot          = null;
    let _conditionBotPayloadSnapshot = null;

    // v1.91.35: Phase 4 — TLS observe-only normalization helpers.
    // Pure functions — no state access, no ObjectHelper calls, no mutation.
    function _inferSourceContainerType(op) {
      if (op === 'take')                    return 'grid';
      if (op === 'drop' || op === 'throw')  return 'player';
      if (op === 'remove')                  return 'player_worn';
      return null;
    }
    function _generateTlsWarnings(w) {
      const _w = [];
      if (w.target_object_exists) {
        _w.push('source_container_id: pre-transfer container not captured in witness');
      }
      if (w.gate_decision === 'freeform' && w.ap_executed_transfer_count > 0) {
        _w.push('gate_denied_but_executed: AP executed despite freeform gate decision');
      }
      if (w.parser_operation_family && w.ap_executed_transfer_count === 0) {
        const _objOps = ['take','drop','throw','remove'];
        if (_objOps.includes(w.parser_operation_family)) {
          _w.push('parser_verb_divergence: parser classified as object operation but no AP transfer occurred');
        }
      }
      return _w;
    }
    function _normalizeWitness(w) {
      let op = null;
      if (w.ap_executed_transfer_count > 0 && w.selection_mode === 'partial_from_stack') {
        op = 'partial_object_transfer';
      } else if (w.ap_executed_transfer_count > 0) {
        op = 'whole_object_transfer';
      } else if (w.ap_env_gather_source_object_id && !w.ap_env_gather_synthetic) {
        op = 'narrator_resolved';
      } else {
        return null;
      }
      const _verb = w.parser_operation_family || w.parsed_action || 'unknown';
      return {
        normalized_op:        op,
        verb:                 _verb,
        source_object_id:     w.target_object_id,
        source_object_name:   w.target_object_name,
        from_container_type:  _inferSourceContainerType(_verb),
        from_container_id:    null,
        to_container_type:    w.target_object_container_type,
        to_container_id:      w.target_object_container_id,
        resolved_quantity:    w.target_object_quantity,
        quantity_mode:        w.quantity_mode,
        warnings:             _generateTlsWarnings(w),
        mode:                 'observe_only'
      };
    }

    // v1.91.XX: Phase 5 — TLS observe-only instruction assembly (Goal 2 diagnostic).
    // Pure function — no state access, no ObjectHelper calls, no mutation.
    // Maps witness + proposal into a structured v0 tls_instruction contract.
    function _assembleTlsInstruction(w, proposal) {
      const turnNumber = w.turn_number;
      const opFamily   = w.parser_operation_family || null;
      const opType = (
        proposal?.normalized_op === 'whole_object_transfer' ? 'whole_object_transfer' :
        proposal?.normalized_op === 'partial_object_transfer' ? 'partial_object_transfer' :
        proposal?.normalized_op === 'narrator_resolved'      ? 'narrator_resolved' :
        null
      );

      return {
        schema_version: 'tls_ors_instruction_v0',

        operation_id:     `tls_op_${turnNumber}`,
        operation_family: opFamily,
        operation_type:   opType,

        actor: {
          id:   w.actor_id || null,
          type: w.actor_id === 'player' ? 'player' : null
        },

        object: {
          id:               w.target_object_id        || null,
          name:             w.target_object_name      || null,
          match_confidence: (
            w.witness_confidence_hint === 'high'   ? 'exact'     :
            w.witness_confidence_hint === 'medium' ? 'probable'  :
            'ambiguous'
          )
        },

        source: {
          layer:           w.player_container_type === 'localspace' ? 'L2'
                         : w.player_container_type === 'site'       ? 'L1'
                         : 'L0',
          layer_basis:     'derived_from_player_container_type',
          container_type:  w.target_object_prior_container_type ?? proposal?.from_container_type ?? null,
          container_id:    w.target_object_prior_container_id   ?? null
        },

        destination: {
          container_type: w.target_object_container_type ?? proposal?.to_container_type ?? null,
          owner_type:     opFamily === 'take' ? 'player' : null,
          owner_id:       opFamily === 'take' ? 'player' : null
        },

        quantity: {
          mode:               w.quantity_mode        ?? 'unspecified',
          requested_quantity: w.requested_quantity   ?? null,
          unit:               w.target_object_unit   ?? null
        },

        mutation: {
          requires_fission:     false,
          requires_transfer:    opType === 'whole_object_transfer' || opType === 'partial_object_transfer',
          retires_source:       false,
          creates_successor:    opType === 'partial_object_transfer'
        },

        execution: {
          mode:               'observe_only',
          allowed_to_execute: false,
          refusal_reason:     proposal ? 'observe_only' : 'no_tls_proposal',
          gate_decision:      w.gate_decision ?? null
        }
      };
    }

    // v1.91.XX: Phase 5 Phase C — TLS/ORS alignment helper (Goal 3 diagnostic).
    // Pure function — no state access, no ObjectHelper calls, no mutation.
    // Compares TLS prediction against same-turn AP/ORS evidence.
    function _assembleTlsOrsAlignment(w, instruction, instructionV1 = null) {
      const opType = instruction?.operation_type ?? null;
      const opFamily = instruction?.operation_family ?? null;

      // ── Status decision tree ────────────────────────────────────────────
      let status, reason;

      // Synthetic env gather: must check BEFORE generic null/no-transfer
      if (w.ap_env_gather_synthetic === true && (w.ap_executed_transfer_count ?? 0) === 0) {
        status = 'skipped_non_transfer';
        reason = 'synthetic_environmental_gather_no_transfer';
      }
      // Non-object turn: no TLS proposal, no AP transfer
      else if (
        opType === null &&
        instructionV1?.operation_family === 'drop' &&
        (w.ap_executed_transfer_count ?? 0) === 0
      ) {
        status = 'not_executed';
        reason = 'drop_tls_dry_run_no_transfer_expected';
      }
      else if (opType === null && (w.ap_executed_transfer_count ?? 0) === 0) {
        status = 'not_applicable';
        reason = 'non_object_turn_no_transfer_expected';
      }
      // Partial-stack: deferred to future phase
      else if (opType === 'partial_object_transfer') {
        status = 'unsupported_operation_type';
        reason = 'partial_stack_alignment_deferred';
      }
      // Unsupported operation type (drop, give, put, etc.)
      else if (opType !== null && opType !== 'whole_object_transfer') {
        status = 'unsupported_operation_type';
        reason = `unsupported_operation_type_${opType}`;
      }
      // Whole-object take: compare prediction vs observed
      else if (opType === 'whole_object_transfer') {
        const predId = instruction?.object?.id ?? null;
        const obsId  = w.target_object_id ?? null;
        const predSrcType = instruction?.source?.container_type ?? null;
        const obsSrcType  = w.target_object_prior_container_type ?? null;
        const predSrcId   = instruction?.source?.container_id ?? null;
        const obsSrcId    = w.target_object_prior_container_id ?? null;
        const predDstType = instruction?.destination?.container_type ?? null;
        const obsDstType  = w.target_object_container_type ?? null;
        const transferOk  = (w.ap_executed_transfer_count ?? 0) === 1;

        // Insufficient evidence: missing required fields
        if (!predId || !obsId || !predSrcType || !obsSrcType || !predDstType || !obsDstType) {
          status = 'insufficient_evidence';
          reason = !predId || !obsId ? 'missing_object_id_for_comparison'
                 : !predSrcType || !obsSrcType ? 'missing_source_container_type'
                 : 'missing_destination_container_type';
        } else {
          const sameObj  = predId === obsId;
          const srcMatch = predSrcType === obsSrcType;
          const srcIdMatch = predSrcId && obsSrcId ? predSrcId === obsSrcId : null;
          const dstMatch = predDstType === obsDstType;

          const allPassed = sameObj && srcMatch && (srcIdMatch === true || srcIdMatch === null) && dstMatch && transferOk;

          status = allPassed ? 'matched' : 'mismatched';
          reason = allPassed ? null : (
            !sameObj ? 'object_id_mismatch' :
            !srcMatch ? 'source_container_type_mismatch' :
            srcIdMatch === false ? 'source_container_id_mismatch' :
            !dstMatch ? 'destination_container_type_mismatch' :
            !transferOk ? 'unexpected_transfer_count' : null
          );
        }
      }
      // Fallback: no TLS proposal or witness
      else {
        status = 'not_applicable';
        reason = 'no_tls_proposal_or_witness';
      }

      // ── Build alignment packet ──────────────────────────────────────────
      const predicted = {
        operation_type:       opType,
        operation_family:     opFamily,
        object_id:            instruction?.object?.id ?? null,
        source_container_type: instruction?.source?.container_type ?? null,
        source_container_id:   instruction?.source?.container_id ?? null,
        dest_container_type:   instruction?.destination?.container_type ?? null,
        dest_owner_type:       instruction?.destination?.owner_type ?? null,
        quantity_mode:         instruction?.quantity?.mode ?? null
      };

      const observed = {
        object_id:             w.target_object_id ?? null,
        object_name:           w.target_object_name ?? null,
        transfer_count:        w.ap_executed_transfer_count ?? 0,
        transfer_ids:          w.ap_executed_transfer_ids ?? [],
        prior_container_type:  w.target_object_prior_container_type ?? null,
        prior_container_id:    w.target_object_prior_container_id ?? null,
        post_container_type:   w.target_object_container_type ?? null,
        post_container_id:     w.target_object_container_id ?? null,
        env_gather_synthetic:  w.ap_env_gather_synthetic ?? null
      };

      const checks = {
        same_object_id:               predicted.object_id && observed.object_id
                                        ? predicted.object_id === observed.object_id : null,
        source_container_type_matches: predicted.source_container_type && observed.prior_container_type
                                        ? predicted.source_container_type === observed.prior_container_type : null,
        source_container_id_matches:   predicted.source_container_id && observed.prior_container_id
                                        ? predicted.source_container_id === observed.prior_container_id : null,
        dest_container_type_matches:   predicted.dest_container_type && observed.post_container_type
                                        ? predicted.dest_container_type === observed.post_container_type : null,
        transfer_count_matches:        opType === 'whole_object_transfer'
                                        ? observed.transfer_count === 1 : null,
        no_duplicate_evidence:         null  // v0: no reliable same-turn duplicate check exists
      };

      const warnings = [];
      if (opType === 'whole_object_transfer') {
        if (!observed.prior_container_type) warnings.push('missing_prior_container_type');
        if (!observed.prior_container_id)   warnings.push('missing_prior_container_id');
        if (!observed.post_container_type)  warnings.push('missing_post_container_type');
        if (!observed.object_id)            warnings.push('missing_object_id');
        if (observed.transfer_count !== 1)  warnings.push('unexpected_transfer_count');
      }
      if (w.ap_env_gather_synthetic)        warnings.push('synthetic_env_gather_detected');
      if (opType === 'partial_object_transfer') warnings.push('partial_stack_alignment_deferred');
      else if (opType && opType !== 'whole_object_transfer')
        warnings.push(`unsupported_operation_type_${opType}`);

      return {
        schema_version:     'tls_ors_alignment_v0',
        operation_id:       instruction?.operation_id ?? null,
        mode:               'diagnostic_only',
        non_authoritative:  true,
        status,
        reason,
        predicted,
        observed,
        checks,
        warnings,
        evidence_basis:     (status === 'insufficient_evidence') ? 'insufficient' : 'same_turn',
        scope:              instructionV1?.operation_family === 'drop' ? 'drop_tls_dry_run' : 'whole_object_take_known_ors_only'
      };
    }

    // v1.91.21: ItemOperationWitness — observe-only diagnostics packet.
    // Assembled from post-AP, pre-RC evidence only. No hoists. No behavior change.
    // All derived fields are _hint suffixed — witness observes, does not classify.
    // Stored on debug (write-only diagnostics surface, never read by gameplay logic).
    debug.itemOperationWitness = {
      raw_input:               _rawInput,
      channel:                 resolvedChannel,
      turn_number:             turnNumber,
      actor_id:                'player',
      player_container_type:   gameState.world?.active_local_space ? 'localspace'
                             : gameState.world?.active_site ? 'site'
                             : 'grid',
      player_container_id:     gameState.world?.active_local_space?.local_space_id
                             || (gameState.world?.active_site
                                ? `${gameState.world.active_site.site_id || gameState.world.active_site.id?.replace(/\/l2$/,'')}:${gameState.player?.position?.x},${gameState.player?.position?.y}`
                                : null),
      parsed_action:           inputObj?.player_intent?.action || null,
      parsed_target:           inputObj?.player_intent?.target || null,
      selection_mode:          inputObj?.player_intent?.selection_mode || null,
      gate_decision:           _authorityGateResult?.decision || null,
      gate_reason_code:        _authorityGateResult?.reason_code || null,
      gate_referenced_objects: _authorityGateResult?.referenced_objects || [],
      gate_engine_supported:   _authorityGateResult?.evidence?.engine_supported ?? null,
      ap_env_gather_label:             gameState._environmentGatherIntent?.label || null,
      ap_env_gather_source_object_id:  gameState._environmentGatherIntent?.sourceObjectId || null,
      ap_env_gather_synthetic:         gameState._environmentGatherIntent?.synthetic ?? null,
      ap_executed_transfer_ids:        Array.isArray(gameState._apExecutedTransfers)
                                        ? [...gameState._apExecutedTransfers] : [],
      ap_executed_transfer_count:      Array.isArray(gameState._apExecutedTransfers)
                                        ? gameState._apExecutedTransfers.length : 0,
      player_held_object_ids:          Array.isArray(gameState.player?.object_ids)
                                        ? [...gameState.player.object_ids] : [],
      player_held_count:               Array.isArray(gameState.player?.object_ids)
                                        ? gameState.player.object_ids.length : 0,
      witness_epistemic_hint:          null,
      witness_operation_family_hint:   null,
      witness_confidence_hint:         null,
      witness_notes:                   [],

      // Phase 2 observer fields — sourced from parser enrichment, not re-derived from parsed_action.
      // witness_operation_family_hint is preserved above for divergence forensics.
      // When parser_operation_family and witness_operation_family_hint agree: baseline is healthy.
      // When they diverge: the input that caused it is a forensic signal worth examining.
      parser_operation_family:     inputObj?.player_intent?.operation_family       ?? null,
      requested_quantity:          inputObj?.player_intent?.requested_quantity      ?? null,
      quantity_word:               inputObj?.player_intent?.quantity_word           ?? null,
      quantity_mode:               inputObj?.player_intent?.quantity_mode           ?? null,
      normalized_target:           inputObj?.player_intent?.normalized_target       ?? null,
      source_container_hint:       inputObj?.player_intent?.source_container_hint   ?? null,

      // Phase 3 alignment: trusted ORS target snapshot — derived from post-AP evidence.
      // Reflects the object AP actually operated on, not necessarily the pre-execution
      // intended target. All fields read-only from existing ObjectRecord — no mutation.
      target_object_exists:         false,
      target_object_id:             null,
      target_object_name:           null,
      target_object_status:         null,
      target_object_quantity:       null,
      target_object_unit:           null,
      target_object_container_type: null,
      target_object_container_id:   null,
      target_object_accessible:     null,
      // v1.91.35: pre-transfer container fields (observation-only, set by AP take handler)
      target_object_prior_container_type: gameState?._apFromContainerType ?? null,
      target_object_prior_container_id:   gameState?._apFromContainerId   ?? null,
      // v1.91.56: P1b — pre-AP resolver evidence (observe-only, captured before Engine.buildOutput)
      resolver_evidence:       objectOperationResolverEvidence ?? null,
      resolver_evidence_error: objectOperationResolverError ?? null
    };
    // Derive witness hints from observed evidence (diagnostic labels only — no authority)
    const _w = debug.itemOperationWitness;
    // Operation family hint
    const _act = _w.parsed_action;
    _w.witness_operation_family_hint = (_act === 'take' || _act === 'drop' || _act === 'throw') ? _act : 'unknown';
    // Epistemic hint
    if (_w.ap_executed_transfer_count > 0) {
      _w.witness_epistemic_hint = 'known_ors_transfer_executed';
      _w.witness_confidence_hint = 'high';
    } else if (_w.ap_env_gather_source_object_id && !_w.ap_env_gather_synthetic) {
      _w.witness_epistemic_hint = 'known_ors_source_object_env_gather';
      _w.witness_confidence_hint = 'medium';
    } else if (_w.ap_env_gather_synthetic) {
      _w.witness_epistemic_hint = 'synthetic_env_gather';
      _w.witness_confidence_hint = 'medium';
    } else if (_w.gate_decision === 'freeform') {
      _w.witness_epistemic_hint = 'unsupported_or_denied';
      _w.witness_confidence_hint = 'low';
    } else {
      _w.witness_epistemic_hint = 'ambiguous';
      _w.witness_confidence_hint = 'low';
    }

    // Phase 3 alignment: derive ORS target object from post-AP evidence
    const _targetId = _w.ap_executed_transfer_ids?.length > 0
      ? _w.ap_executed_transfer_ids[_w.ap_executed_transfer_ids.length - 1]
      : _w.ap_env_gather_source_object_id || null;
    if (_targetId && gameState.objects?.[_targetId]) {
      const _t = gameState.objects[_targetId];
      _w.target_object_exists = true;
      _w.target_object_id = _targetId;
      _w.target_object_name = _t.name || null;
      _w.target_object_status = _t.status || null;
      _w.target_object_quantity = typeof _t.quantity === 'number' ? _t.quantity : null;
      _w.target_object_unit = _t.unit || null;
      _w.target_object_container_type = _t.current_container_type || null;
      _w.target_object_container_id = _t.current_container_id || null;
      // Accessible here means AP resolved this object as interactable in the current turn;
      // it is not a general world-reachability calculation.
      _w.target_object_accessible = true;
    }

    // v1.91.XX P3: archive raw AP actuals into witness for diagnostics.js post-hoc comparison
    if (gameState._apActuals) {
      debug.itemOperationWitness.ap_actuals = _cloneForArchive(gameState._apActuals);
    }

    // v1.91.35: Phase 4 — TLS observe-only normalization proposal.
    // Diagnostics only. No mutation. No ORS calls. No gameplay impact.
    debug.tls_proposed_operation = _w.target_object_exists
      ? _normalizeWitness(debug.itemOperationWitness)
      : null;

    // v0 TLS witness projection:
    // Post-execution diagnostic surface for the live whole-object TAKE TLS lane.
    // Whole-object mutation happens earlier in ActionProcessor.js, where the TLS
    // branch calls ObjectHelper.transferObjectDirect(...) and writes
    // gameState._tlsExecutionResult. This packet does NOT drive mutation.
    // It projects the observed whole-object TLS result into the witness/debug
    // contract consumed by Mother Brain and frontend diagnostics.
    // Keep v0 alongside tls_instruction_v1:
    //   v0 = whole-object TLS execution visibility
    //   v1 = pre-AP partial-stack resolver/TLS candidate instruction
    debug.tls_instruction = _assembleTlsInstruction(debug.itemOperationWitness, debug.tls_proposed_operation);

    // v1.91.XX: Phase 5 Phase C — TLS/ORS alignment diagnostic (Goal 3).
    // Diagnostics only. No mutation. No ORS calls. No gameplay impact.
    debug.tls_ors_alignment = _assembleTlsOrsAlignment(debug.itemOperationWitness, debug.tls_instruction, debug.tls_instruction_v1);

    // v1.91.XX: Phase D — TLS execution result (live mutation diagnostic).
    // Authoritative for execution trace only — ORS/ObjectHelper owns object state.
    debug.tls_execution_result = gameState._tlsExecutionResult ?? null;

    // Phase F: correct stale observe_only/diagnostic_only labels for successful TLS takes.
    // Guard is lane-specific: only known-ORS whole-object player take (the only live TLS lane).
    // Uses available tls_execution_result fields — no operation_family/mutation_type exists.
    if (gameState._tlsExecutionResult?.mode === 'live_execution' &&
        gameState._tlsExecutionResult?.executed_by === 'tls' &&
        gameState._tlsExecutionResult?.transfer?.result === 'success' &&
        gameState._tlsExecutionResult?.destination?.container_type === 'player') {
      if (debug.tls_instruction?.execution) {
        debug.tls_instruction.execution.mode = 'default';
        debug.tls_instruction.execution.allowed_to_execute = true;
        debug.tls_instruction.execution.refusal_reason = null;
      }
      if (debug.tls_ors_alignment) {
        debug.tls_ors_alignment.mode = 'default_execution_confirmed';
        debug.tls_ors_alignment.non_authoritative = false;
      }
    }

    // v1.91.22: capture witness for Mother's GET /debug/witness tool
    if (debug.itemOperationWitness) {
      _witnessStore.set(resolvedSessionId, {
        turn: turnNumber,
        ts: new Date().toISOString(),
        witness: debug.itemOperationWitness,
        tls_proposed_operation: debug.tls_proposed_operation,  // v1.91.35
        tls_instruction: debug.tls_instruction,
        tls_instruction_v1: debug.tls_instruction_v1,          // v1.91.59: P2 v1 sibling
        tls_ors_alignment: debug.tls_ors_alignment,
        tls_executor_dry_run: debug.tls_executor_dry_run,       // v1.91.64: P4 dry-run envelope
        tls_execution_result: debug.tls_execution_result,
        tls_partial_stack_result: gameState._tlsPartialStackResult ?? null   // v1.91.71: P5-A2 live TLS partial-stack result
      });
    }

    // v1.91.73: Object Operation Bridge — evaluate fail-closed outcome, produce downstream routing receipt
    debug.object_operation_bridge = ObjectOperationBridge.evaluateOperation({
      dryRunEnvelope:        debug.tls_executor_dry_run ?? null,
      apActuals:             gameState._apActuals ?? null,
      tlsPartialStackResult: gameState._tlsPartialStackResult ?? null,
      operationFamily:       debug.tls_instruction_v1?.operation_family ?? null,
      semanticOperationFamily: inputObj?.player_intent?.operation_family ?? null,
      semanticPathSingleAction: debug.parser === 'semantic' && debug.queue_length === 1,
      instructionEnvelope:   debug.tls_instruction_v1 ?? null,
      liveExecutionResult:   gameState._tlsExecutionResult ?? null
    });
    const _dropDryRunSealActive = !!(debug.object_operation_bridge?.active === true &&
      debug.object_operation_bridge?.drop_dry_run_seal === true && debug.parser === 'semantic' && debug.queue_length === 1);
    // Attach bridge receipt to witness store as flat sibling (follows tls_partial_stack_result pattern)
    if (debug.object_operation_bridge?.active) {
      const _existingWitness = _witnessStore.get(resolvedSessionId);
      if (_existingWitness) {
        _existingWitness.object_operation_bridge = debug.object_operation_bridge;
        _witnessStore.set(resolvedSessionId, _existingWitness);
      }
    }

    // v1.91.66: P5-0 — immutable evidence archive freeze (pre-RC, post-witness, deep-cloned)
    // Fires only for partial-stack TAKE turns where tls_instruction_v1 exists.
    // Deep-cloned via JSON roundtrip — no references to mutable debug.* fields survive.
    // _p5Snapshot is carried forward and attached to turnObject ~2600 lines later.
    let _p5Snapshot = null;
    if (debug.tls_instruction_v1) {
      const _wit = debug.itemOperationWitness;
      _p5Snapshot = JSON.parse(JSON.stringify({
        schema_version:       'p5_witness_archive_v1',
        turn:                 turnNumber,
        timestamp:            new Date().toISOString(),
        parsed_action:        _wit?.parsed_action ?? null,
        parsed_target:        _wit?.parsed_target ?? null,
        selection_mode:       _wit?.selection_mode ?? null,
        requested_quantity:   _wit?.requested_quantity ?? null,
        gate_decision:        _wit?.gate_decision ?? null,
        gate_reason_code:     _wit?.gate_reason_code ?? null,
        resolver_evidence:    _wit?.resolver_evidence ?? null,
        tls_instruction_v1:   debug.tls_instruction_v1 ?? null,
        tls_executor_dry_run: debug.tls_executor_dry_run ?? null,
        ap_actuals:           _wit?.ap_actuals ?? null,
        tls_execution_result: debug.tls_execution_result ?? null,
        tls_ors_alignment:    debug.tls_ors_alignment ?? null,
        object_operation_bridge: debug.object_operation_bridge ?? null,
        object_reality_summary: (() => {
          try {
            const _src = gameState.objects?.[debug.tls_instruction_v1?.object?.id];
            const _succId = debug.itemOperationWitness?.ap_actuals?.successor_id;
            const _succ = _succId ? gameState.objects?.[_succId] : null;
            return {
              source_object: _src ? {
                object_id:      _src.id ?? null,
                quantity_before: debug.tls_instruction_v1?.quantity?.observed_available_quantity ?? null,
                quantity_after:  _src.quantity ?? null,
                container_type:  _src.current_container_type ?? null,
                container_id:    _src.current_container_id ?? null
              } : null,
              successor_object: _succ ? {
                object_id:      _succ.id ?? null,
                quantity:       _succ.quantity ?? null,
                container_type: _succ.current_container_type ?? null,
                container_id:   _succ.current_container_id ?? null
              } : null,
              player_inventory: {
                held_object_ids: Array.isArray(gameState.player?.object_ids) ? [...gameState.player.object_ids] : [],
                held_count:      Array.isArray(gameState.player?.object_ids) ? gameState.player.object_ids.length : 0,
                worn_object_ids: Array.isArray(gameState.player?.worn_object_ids) ? [...gameState.player.worn_object_ids] : []
              }
            };
          } catch (_) { return null; }
        })(),
        fields_present: {
          resolver_evidence:     !!(_wit?.resolver_evidence),
          tls_instruction_v1:    !!(debug.tls_instruction_v1),
          tls_executor_dry_run:  !!(debug.tls_executor_dry_run),
          ap_actuals:            !!(_wit?.ap_actuals),
          tls_execution_result:  !!(debug.tls_execution_result),
          tls_ors_alignment:     !!(debug.tls_ors_alignment),
          object_operation_bridge: !!(debug.object_operation_bridge),
          p5_authority_result:   false,
          p5_blocked_candidates: false
        },
        archive_frozen_at: new Date().toISOString(),
        archive_source:    'p5_freeze_point_3902',
        p5_authority_result:   null,
        p5_blocked_candidates: null
      }));
    }

    // [REALITY-CHECK] Arbiter Phase 0 — pre-narration reality adjudication (v1.84.2)
    // Awaited and blocking. Fires before narrationContent is built. On failure: hard stop — narrator never called.
    // Skip conditions: Turn 1 (founding premise), move, look, wait.
    let _realityAnchor = null;
    let _realityQuery = null;
    let _rcSkippedReason = null;
    let _rcRawResponse = null;
    let _rcStart = null;
    let _rcEnd = null;
    let _emoteRemoveExecuted = false; // v1.85.42: set inside RC else-block, consumed by narrator assembly
    let _emoteRemovedItemName = null;
    let _rcHiddenNpcTarget = null; // v1.87.0: NPC with hidden canonical name on SAY-channel turns — hoisted for post-RC resolver access
    let _rcNpcRole = null; // v1.89.04: hoisted — was const inside RC else-block, referenced outside it by name-reveal resolver
    const _rcSuffix = 'Focus on immediate physical, social, and legal consequences. Respond in plain prose, 2-3 sentences maximum. No headers, no bullet points. Be direct and specific.';
    // v1.88.0: Authority Gate deny takes priority — set _rcSkippedReason before existing skip block.
    if (_authorityGateResult?.decision === 'freeform') {
      _rcSkippedReason = 'authority_gate_deny';
    } else if (_authorityGateResult?.rc_allowed === false) {
      // v1.88.x: Gate explicitly said no RC — honor it. These turns still reach the narrator
      // via the normal path; only the RC call is suppressed.
      _rcSkippedReason = 'authority_gate_no_rc';
    }
    if (turnNumber === 1) {
      _rcSkippedReason = 'turn_1';
    } else if (_parsedAction === 'move') {
      _rcSkippedReason = 'move';
    } else if (_parsedAction === 'look') {
      _rcSkippedReason = 'look';
    } else if (_parsedAction === 'wait') {
      _rcSkippedReason = 'wait';
    } else if (_parsedAction === 'enter') {
      _rcSkippedReason = 'enter';
    } else if (_parsedAction === 'exit') {
      _rcSkippedReason = 'exit';
    } else if (_parsedAction === 'remove') {
      // Deterministic mechanical action — no RC needed.
      _rcSkippedReason = 'remove';
    } else if (debug?.degraded_from === 'TARGET_NOT_WORN') {
      // remove action degraded because target is not in player worn — route to narrator for natural denial.
      _rcSkippedReason = 'target_not_worn';
    } else if (_parsedAction === 'state_claim') {
      // Non-executable input — not a valid engine action, not a harmless skip action.
      // RC must not fire: treating a bare assertion as true would allow narrator to instantiate it.
      _rcSkippedReason = 'state_claim';
    } else if (debug?.degraded_from === 'TARGET_NOT_FOUND_IN_CELL') {
      // Action degraded because target is not a loose cell item (e.g. item held by NPC, non-existent item).
      // RC must not fire: narrator prompt already routes this to state_claim rejection — an RC advisory would
      // contradict that instruction and give the narrator a concrete consequence to follow instead.
      _rcSkippedReason = 'target_not_found_in_cell';
    } else if (gameState._environmentGatherIntent?.sourceObjectId) {
      // v1.91.11: source-bound extraction — divisibility LLM validator fires below; RC is not needed.
      _rcSkippedReason = 'source_object_gather';
    } else if (gameState._environmentGatherIntent?.synthetic) {
      // v1.85.6: take action forwarded to narrator for plausibility resolution (ORS had no prior record).
      // RC must not fire: the narrator already receives a targeted plausibility-judgment block.
      _rcSkippedReason = 'synthetic_env_gather';
    } else if (_parsedAction === 'unknown') {
      // v1.85.13: Parser could not classify input. RC must not fire — unclassified inputs cannot be trusted
      // as valid action descriptions; passing them to RC risks validating embedded outcome assertions.
      _rcSkippedReason = 'unknown_block_rc';
    } else if (debug?.degraded_from === 'TARGET_NOT_IN_INVENTORY') {
      // v1.85.36: throw/drop degraded because AP validated the item is not in player inventory.
      // AP is authoritative on inventory state for these actions — RC must not fire.
      _rcSkippedReason = 'target_not_in_inventory';
    } else {
      // v1.91.73: Object Operation Bridge — authoritative fail-closed suppression (ORS-direct)
      // Placed at top of else block: only runs if no prior skip condition matched.
      // Sets _rcSkippedReason early; RC API call is skipped at the if (!_rcSkippedReason) gate below.
      if (!_rcSkippedReason && debug.object_operation_bridge?.active) {
        _rcSkippedReason = debug.object_operation_bridge.rc_skip_reason;
      }
      // Build query — SAY channel with matched NPC gets role context
      _rcNpcRole = (resolvedChannel === 'say' && (_npcTalkResult?.npc?.job || _rawNpcTarget))
        ? (_npcTalkResult?.npc?.job || _rawNpcTarget)
        : null;
      // v1.84.75: Relevant truth fragment — only supported attrs forwarded to RC
      const _rcFoundingAttrs = (_parsedAction === 'established_trait_action') ? (inputObj?.player_intent?._foundingAttrs || []) : [];
      const _rcTruthFragment = _rcFoundingAttrs.length > 0
        ? `Relevant established attributes: ${_rcFoundingAttrs.slice(0, 8).join(' | ')}. `
        : '';
      // v1.84.76: Validation clause — injected only for established_trait_action RC calls
      const _rcValidationClause = (_parsedAction === 'established_trait_action')
        ? ' If the action requires an item or ability not in the relevant established attributes above, state that the player does not have it and the action fails. Do not substitute or materialize any other item in its place as a consolation or alternative. Established attributes grant the player the capacity for this type of action; they do not assert the existence of new objects or world facts. Do not confirm the existence of new objects or world facts unless they are already present in confirmed engine state or a DISCOVERY RESULT block in this prompt explicitly establishes them as found.'
        : '';
      _realityQuery = _rcNpcRole
        ? `${_rcTruthFragment}What happens when I say "${_rawInput}" to the ${_rcNpcRole}?${_rcValidationClause} ${_rcSuffix}`
        : `${_rcTruthFragment}What happens when I ${_rawInput}?${_rcValidationClause} ${_rcSuffix}`;
      // v1.85.37: Emote inventory scan — say-channel emote authority gate.
      // On say-channel turns with asterisk-wrapped emotes, scan active player containers
      // (inventory + worn) against the raw input using aliasScore. No verb lists, no noun
      // lists, no trigger taxonomy — the player's own containers are the authority source.
      // Confirmed match (score >= 6): RC fires with compact inventory confirmation.
      // No match (including empty inventory): RC skipped — _emoteObjectAuthorityBlock
      // handles the narrator uncontested and cannot be overridden by a hallucinated anchor.
      // Non-say/non-emote turns: block does not run, RC behavior unchanged.
      const _rcPossessionDebug = { fired: false, is_emote_turn: false, best_score: 0, inventory_match: false, matched_item_name: null, skip_reason: null };
      const _isEmoteTurn = (resolvedChannel === 'say' && /\*[^*]+\*/.test(_rawInput));
      if (_isEmoteTurn) {
        _rcPossessionDebug.fired = true;
        _rcPossessionDebug.is_emote_turn = true;
        // v1.85.99: Extract only the *inner* text of the emote (between asterisks) for object ref detection.
        // Previously used _rawInput.replace(/\*/g,'') which included surrounding dialog text, causing
        // pure gesture emotes like *frowns* in "you don't know this face? *frowns* Very" to scan the
        // full dialog sentence against inventory — always failing and incorrectly skipping the RC.
        const _emoteInner = (_rawInput.match(/\*([^*]+)\*/) || [])[1] || '';
        // Gate: only run inventory scan when the emote inner text contains a determiner or possessive —
        // the reliable signal that it references a concrete object ("*draws my sword*", "*holds the torch*").
        // Pure gestures (*frowns*, *nods*, *sighs*, *laughs*) contain no determiner and skip the scan,
        // allowing RC to fire normally.
        const _emoteHasObjectRef = /\b(?:my|the|a|an|this|that|these|those|its|your)\b/i.test(_emoteInner);
        if (!_emoteHasObjectRef) {
          _rcPossessionDebug.skip_reason = 'emote_pure_gesture';
          console.log(`[RC-POSSESSION] turn:${turnNumber} emote_pure_gesture — RC allowed to fire normally inner:"${_emoteInner}"`);
        } else {
        const _emotePlayerIds = [...new Set([...(gameState?.player?.object_ids || []), ...(gameState?.player?.worn_object_ids || [])])];
        let _emoteBestScore = 0;
        let _emoteBestRec = null;
        // v1.85.44: Extract noun phrase before aliasScore. Strips action-language scaffolding
        // (remove-verb phrases, grammatical function words) so the query is noun/object terms only.
        // "off" not stripped globally — may appear in item names; handled as part of verb phrases only.
        // "your" stripped — safe: this scan targets player containers only.
        // Corrects argument order: query=nounPhrase (needle), name=itemName (haystack).
        // v1.85.99: Source changed from full-input _emoteRawStripped to _emoteInner (asterisk content only).
        const _emoteNounPhrase = _emoteInner
          .replace(/\b(?:strip\s+off|take\s+off|unequip|undress|remove)\b/gi, '')
          .replace(/\b(?:my|the|a|an|these|those|some|its|your)\b/gi, '')
          .replace(/\s{2,}/g, ' ')
          .trim();
        for (const _epid of _emotePlayerIds) {
          const _eprec = gameState?.objects?.[_epid];
          if (!_eprec || _eprec.status !== 'active') continue;
          const _esc = Actions.aliasScore(_emoteNounPhrase || _emoteInner, _eprec.name || '', _eprec.aliases || []);
          if (_esc > _emoteBestScore) { _emoteBestScore = _esc; _emoteBestRec = _eprec; }
        }
        _rcPossessionDebug.best_score = _emoteBestScore;
        if (_emoteBestScore >= 6) {
          _rcPossessionDebug.inventory_match = true;
          _rcPossessionDebug.matched_item_name = _emoteBestRec.name;
          // v1.85.42: Emote worn-item removal execution — if the emote describes removing a worn item,
          // execute the transfer authoritatively before narrator/CB runs. Stamps _apExecutedTransfers
          // (suppresses duplicate CB transfer) and _apRemovedWornNames (worn-remove gate blocks CB
          // promotes for name variants like "wool trousers" vs "sturdy wool trousers").
          const _EMOTE_REMOVE_RE = /\btake[\s_]off|remove|strip[\s_]off|unequip|undress\b/i;
          const _emoteIsWorn = Array.isArray(gameState?.player?.worn_object_ids) &&
            gameState.player.worn_object_ids.includes(_emoteBestRec.id);
          if (!_dropDryRunSealActive && _emoteIsWorn && _EMOTE_REMOVE_RE.test(_rawInput)) {
            const _erResult = ObjectHelper.transferObjectDirect(
              gameState, _emoteBestRec.id, 'player', 'player', turnNumber, 'emote_remove'
            );
            if (_erResult.success) {
              if (!gameState._apExecutedTransfers) gameState._apExecutedTransfers = [];
              gameState._apExecutedTransfers.push(_emoteBestRec.id);
              if (!gameState._apRemovedWornNames) gameState._apRemovedWornNames = [];
              gameState._apRemovedWornNames.push(_emoteBestRec.name.toLowerCase().trim());
              _emoteRemoveExecuted = true;
              _emoteRemovedItemName = _emoteBestRec.name;
              console.log(`[EMOTE-REMOVE] executed remove "${_emoteBestRec.name}" (${_emoteBestRec.id})`);
            } else {
              console.warn(`[EMOTE-REMOVE] transferObjectDirect failed: ${_erResult.error}`);
            }
          }
        } else {
          _rcPossessionDebug.skip_reason = 'emote_no_inventory_match';
          _rcSkippedReason = 'emote_no_inventory_match';
        }
        } // end _emoteHasObjectRef
      }
      debug.rc_possession = _rcPossessionDebug;
      console.log(`[RC-POSSESSION] turn:${turnNumber} is_emote:${_rcPossessionDebug.is_emote_turn} score:${_rcPossessionDebug.best_score} match:${_rcPossessionDebug.inventory_match} item:"${_rcPossessionDebug.matched_item_name || ''}"`);
      // v1.85.17: RC system message — inject world tone and player declared truths so RC evaluates
      // within the correct reality frame instead of defaulting to modern real-world assumptions.
      const _rcDeclaredAttrs = Object.values(gameState?.player?.attributes || {})
        .filter(a => a.bucket === 'declared')
        .map(a => a.value)
        .slice(0, 8);
      const _rcWorldTone = gameState?.world?.world_tone || null;
      const _rcSystemParts = [];
      if (_rcWorldTone) _rcSystemParts.push(`World context: ${_rcWorldTone}`);
      if (_rcDeclaredAttrs.length > 0) _rcSystemParts.push(`Established player truths: ${_rcDeclaredAttrs.join(' | ')}`);
      // v1.85.37: Inject compact inventory confirmation when emote turn has a confirmed match.
      if (_rcPossessionDebug.inventory_match) {
        _rcSystemParts.push(`Player inventory confirmed: ${_rcPossessionDebug.matched_item_name} (engine state).`);
      }
      // v1.87.0: NPC name-reveal gate — when target NPC has a canonical name hidden from the player,
      // instruct RC to use a placeholder instead of inventing a name. The engine will substitute the
      // real canonical name after RC returns, before the narrator sees the anchor block.
      _rcHiddenNpcTarget = (resolvedChannel === 'say' && _npcTalkResult?.npc && !_npcTalkResult.npc.is_learned && _npcTalkResult.npc.npc_name)
        ? _npcTalkResult.npc
        : null;
      if (_rcHiddenNpcTarget) {
        _rcSystemParts.push(`The addressed NPC's canonical name is unknown to the player. If your response includes the NPC revealing their true name, write [NPC_NAME_REVEAL] as a placeholder instead of inventing a name.`);
      }
      const _rcSystemMsg = _rcSystemParts.length > 0
        ? `You are evaluating an action taken within an established game world. Evaluate the immediate consequences within the established world's genre and physical rules — do not substitute modern real-world assumptions unless the world is explicitly set in the modern era. ${_rcSystemParts.join('. ')}.`
        : null;
      // v1.85.38: RC API call gated on _rcSkippedReason — if the emote inventory scan (or any
      // other skip condition set inside this else block) determined RC should not fire, do not
      // call the API. Previously _rcSkippedReason was set but the try/catch fired unconditionally,
      // causing the RC anchor to override _emoteObjectAuthorityBlock with contradictory imagery.
      if (!_rcSkippedReason) {
        try {
          _rcStart = Date.now();
          const _rcResp = await axios.post('https://api.deepseek.com/v1/chat/completions', {
            model: 'deepseek-v4-flash',
            thinking: { type: 'disabled' },
            temperature: 0.3,
            max_tokens: 300,
            messages: [
              ...(_rcSystemMsg ? [{ role: 'system', content: _rcSystemMsg }] : []),
              { role: 'user', content: _realityQuery }
            ]
          }, {
            headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
            httpsAgent: _sharedHttpsAgent,
            timeout: 15000
          });
          _rcEnd = Date.now();
          _rcRawResponse = _rcResp?.data?.choices?.[0]?.message?.content || null;
          _realityAnchor = _rcRawResponse?.trim() || null;
          const _rcFinishReason = _rcResp?.data?.choices?.[0]?.finish_reason || null;
          const _rcTruncated = _rcFinishReason === 'length';
          if (_rcTruncated) console.warn(`[REALITY-CHECK] response truncated (finish_reason=length) — turn ${turnNumber}, increase max_tokens if this persists`);
          _rcPayloadSnapshot = { prompt: _realityQuery, response: _rcRawResponse }; // v1.84.21
          if (!_realityAnchor) throw new Error('empty_response');
          diag.emitDiagnostics({ type: 'reality_check', turn: turnNumber, fired: true, skipped_reason: null, query: _realityQuery, result: _realityAnchor, truncated: _rcTruncated || false, gameSessionId: resolvedSessionId });
          console.log(`[REALITY-CHECK] fired — turn ${turnNumber}, query length ${_realityQuery.length}, result length ${_realityAnchor.length}${_rcTruncated ? ' [TRUNCATED]' : ''}`);
        } catch (_rcErr) {
          console.error('[REALITY-CHECK] HARD FAILURE:', _rcErr.message, '— turn halted, narrator not called');
          diag.emitDiagnostics({ type: 'reality_check', turn: turnNumber, fired: true, skipped_reason: null, query: _realityQuery, result: null, error: _rcErr.message, gameSessionId: resolvedSessionId });
          return res.json({ sessionId: resolvedSessionId, error: 'REALITY_CHECK_FAILED', narrative: 'The world could not adjudicate that action. Please try again.' });
        }
      }
    }
    if (_rcSkippedReason) {
      diag.emitDiagnostics({ type: 'reality_check', turn: turnNumber, fired: false, skipped_reason: _rcSkippedReason, query: null, result: null, gameSessionId: resolvedSessionId });
      console.log(`[REALITY-CHECK] skipped — turn ${turnNumber}, reason: ${_rcSkippedReason}`);
    }
    // v1.91.73: Object Operation Bridge — emit bridge diagnostic event for active fail-closed routing
    if (debug.object_operation_bridge?.active) {
      diag.emitDiagnostics({
        type: 'tls_bridge',
        turn: turnNumber,
        active: true,
        fail_closed_reason: debug.object_operation_bridge.diagnostics.fail_closed_reason,
        rc_skipped: !!_rcSkippedReason,
        constraint_supplied: debug.object_operation_bridge.diagnostics.constraint_supplied,
        gameSessionId: resolvedSessionId
      });
    }
    // v1.87.0: Post-RC name-reveal resolver — detect whether RC signaled a true-name reveal and
    // substitute the engine's canonical NPC name before the narrator sees the anchor block.
    // Two-tier detection: (1) RC obeyed the placeholder instruction → [NPC_NAME_REVEAL] literal;
    // (2) Conservative fallback — BOTH player-input pressure AND NPC-performing-reveal signal in
    // the RC anchor must be present. Neither condition alone triggers the fallback.
    let _authorizedNameReveal = null;
    if (_rcHiddenNpcTarget && _realityAnchor) {
      const _nrvCanonical = _rcHiddenNpcTarget.npc_name;
      const _nrvLabel = _rcNpcRole || _rcHiddenNpcTarget.job_category || 'the NPC';
      const _nrvHasPlaceholder = _realityAnchor.includes('[NPC_NAME_REVEAL]');
      const _nrvInputPressure = /reveal|compel|confess|tell me your (?:real |true )?name|what is your (?:real |true )?name/i.test(_rawInput);
      // Group A: verb -> pronoun -> name (e.g. "shouts his name", "booms their name")
      // Group B: pronoun -> name -> event verb (e.g. "his name booms out", "her name is shouted")
      const _nrvAnchorSignal = /\b(?:blurts?\s+out|gasps?\s+out|whispers?\s+(?:her|his|their)\s+(?:true\s+)?name|stammers?\s+(?:her|his|their)\s+(?:true\s+)?name|says?\s+(?:her|his|their)\s+(?:true\s+)?name|reveals?\s+(?:her|his|their)\s+(?:true\s+)?name|shouts?\s+(?:her|his|their)\s+(?:true\s+)?name|screams?\s+(?:her|his|their)\s+(?:true\s+)?name|booms?\s+(?:her|his|their)\s+(?:true\s+)?name|announces?\s+(?:her|his|their)\s+(?:true\s+)?name|declares?\s+(?:her|his|their)\s+(?:true\s+)?name|calls?\s+out\s+(?:her|his|their)\s+(?:true\s+)?name|cries?\s+out\s+(?:her|his|their)\s+(?:true\s+)?name|proclaims?\s+(?:her|his|their)\s+(?:true\s+)?name|exclaims?\s+(?:her|his|their)\s+(?:true\s+)?name|(?:her|his|their)\s+(?:true\s+)?name\s+(?:rings?\s+out|booms?\s+out|echoes?\s+out|erupts?\s+out|bursts?\s+out|rings?\s+through|booms?\s+through|echoes?\s+through|is\s+shouted|is\s+called\s+out|is\s+spoken|is\s+announced|fills\s+the\s+\w+|cuts?\s+through|reverberates?))\b/i.test(_realityAnchor);
      if (_nrvHasPlaceholder || _nrvAnchorSignal) {
        _realityAnchor = _realityAnchor.replace(/\[NPC_NAME_REVEAL\]/g, `"${_nrvCanonical}"`);
        _authorizedNameReveal = { npc_id: _rcHiddenNpcTarget.id, canonical_name: _nrvCanonical, label: _nrvLabel };
        console.log(`[NAME-REVEAL] v1.87.4 authorized "${_nrvCanonical}" for ${_rcHiddenNpcTarget.id} (placeholder:${_nrvHasPlaceholder} signal:${_nrvAnchorSignal})`);
      }
    }
    // v1.88.7: RC-independent fallback — build _authorizedNameReveal directly when RC was skipped
    // and all conditions for a valid hidden-name conversation are met. Name reveal is an
    // engine-authorized identity disclosure, not a reality-check event.
    if (!_authorizedNameReveal &&
        _rcHiddenNpcTarget &&
        resolvedChannel === 'say' &&
        _npcTalkResult?.outcome === 'matched' &&
        _rcHiddenNpcTarget.npc_name &&
        _rcHiddenNpcTarget.is_learned === false) {
      const _nrvLabel2 = _rcHiddenNpcTarget.job_category || _rawNpcTarget || 'the NPC';
      _authorizedNameReveal = { npc_id: _rcHiddenNpcTarget.id, canonical_name: _rcHiddenNpcTarget.npc_name, label: _nrvLabel2, rc_independent: true };
      console.log(`[NAME-REVEAL] v1.88.7 RC-independent authorized "${_rcHiddenNpcTarget.npc_name}" for ${_rcHiddenNpcTarget.id}`);
    }
    const _nameRevealAuthorityBlock = _authorizedNameReveal
      ? (_authorizedNameReveal.rc_independent
        ? `\n\nENGINE AUTHORITY — NAME REVEAL: The NPC known as "${_authorizedNameReveal.label}" has a canonical engine identity. If this NPC chooses to reveal their name in this response, the only valid name to reveal is "${_authorizedNameReveal.canonical_name}". Do not invent an alternate proper name or nickname as the answer to a name request. The NPC may still refuse, deflect, delay, or answer indirectly if that fits the scene.\n`
        : `\n\nENGINE AUTHORITY — NAME REVEAL: The NPC known as "${_authorizedNameReveal.label}" has just revealed their true canonical name: "${_authorizedNameReveal.canonical_name}". This is engine-verified fact. If your narration depicts the name reveal occurring this turn, use this exact name only — do not substitute, alter, or invent a different name. If your narration depicts a non-reveal outcome (refusal, deflection, interruption), you do not need to use this name.\n`)
      : '';

    // v1.91.73: Object Operation Bridge — hard denial for definitively failed object operations
    const _objectOperationBridgeBlock = (() => {
      if (!debug.object_operation_bridge?.active) return '';
      return `\n\n[OBJECT OPERATION RESULT]\n${debug.object_operation_bridge.narration_constraint}\n[/OBJECT OPERATION RESULT]\n`;
    })();
    const _realityAnchorBlock = _realityAnchor
      ? `\n\nPossible consequences of the player's action (advisory):\n${_realityAnchor}\nUse these as guidance when narrating the outcome. Select, adapt, or ignore as appropriate. Honor the current scene, engine state, and system prompt.\n`
      : '';
    const _DIRECTION_SHORTHAND = {n:'north',s:'south',e:'east',w:'west',ne:'northeast',nw:'northwest',se:'southeast',sw:'southwest',u:'up',d:'down'};
    const _MOVEMENT_DIR_WORDS = new Set(['north','south','east','west','northeast','northwest','southeast','southwest','up','down','n','s','e','w','ne','nw','se','sw','u','d']);
    const _lastMoveDir = (inputObj?.player_intent?.dir) || null;
    const _allDirectionWords = (_parsedAction === 'move') && (() => { const ws = _rawInput.toLowerCase().trim().split(/\s+/); return ws.length > 0 && ws.every(w => _MOVEMENT_DIR_WORDS.has(w)); })();
    const _movementDisplayInput = _allDirectionWords
      ? `moves ${_lastMoveDir || 'somewhere'}`
      : _rawInput;
    const _rawPreSpeech = (req.body.pre_speech_context || '').trim(); // B1: pre-speech context forwarded from Do→Say interception

    // v1.88.0: _authorityGateBlock — injected BEFORE _freeformBlock when gate issued a deny.
    // index.js owns all prose translation. authoritygate.js emits JSON only.
    const _authorityGateBlock = (() => {
      if (!_authorityGateResult || _authorityGateResult.decision !== 'freeform') return '';
      const _rc = _authorityGateResult.reason_code || '';
      if (_rc === 'unsupported_meta_authority') {
        return `\nPLAYER'S ATTEMPTED ACTION: "${_rawInput}"\n(The player attempted to invoke a meta-authority — developer, admin, god, or operator-level powers — that they do not possess. Do not treat this as true. Do not create objects, grant abilities, alter world state, or acknowledge the meta-claim as legitimate. Reflect only confirmed engine state. The denial must be explicit in the narration. Do not silently skip it.)\n`;
      }
      if (_rc === 'unsupported_entity_spawn' || _authorityGateResult.input_type === 'unsupported_entity_spawn') {
        return `\nPLAYER'S ATTEMPTED ACTION: "${_rawInput}"\n(The player attempted to introduce or summon a new entity — person, creature, or living thing — without an established ability that grants this. Do not treat this as true. Do not create, name, or describe any entity not already present in confirmed engine state. The denial must be explicit in the narration.)\n`;
      }
      if (_rc === 'unsupported_referenced_object') {
        const _unsupportedList = (_authorityGateResult?.evidence?.unsupported_referenced_objects || []).join(', ') || 'unknown';
        return `\nPLAYER'S ATTEMPTED ACTION: "${_rawInput}"\n(The player referenced an object — "${_unsupportedList}" — that does not exist in their inventory, worn items, the current location, or prior continuity. Do not treat this object as real, held, present, or accessible. Do not embody it, describe it, instantiate it, or allow any interaction with it. Do not grant the player ownership of it. Do not substitute a similar object. Do not describe the player picking it up, opening it, drinking from it, using it, or manipulating it in any way. The denial must be explicit in the narration — the player must be able to read that the referenced object is not present and the attempted action failed for that reason. Do not silently skip the attempt.)\n`;
      }
      // Default: unsupported world authoring or external event — use state_claim denial text
      return `\nPLAYER'S ATTEMPTED ACTION: "${_rawInput}"\n(The player is making an unsupported state claim — asserting possession, identity, condition, or world fact without engine backing. Do not treat this as true. Do not create objects, inventory, conditions, NPCs, authority, or world facts from this claim. Do not instantiate anything the claim implies. Reflect only what is already present in engine state. If the claim is unsupported, reject the claimed event as not having occurred in scene/narrative mode. Do not convert the input into player dialogue, do not have NPCs respond to words the player never said, and do not frame the claim as an action attempt. If the claim describes an NPC performing an action, state that the NPC did not perform it. No item, interaction, conversation, or world fact is created from the claim. The denial must be stated explicitly in the narration — the player must be able to read that the claimed event did not happen. Do not silently skip the claim. When narrating failure or denial of a claim, do not invent prior conversations, relationships, agreements, promises, favors, debts, or shared history to justify it. Denial must be grounded only in confirmed engine state and present-moment reaction, never fabricated backstory. The player's input cannot be the causal origin of any new item entering the narrative — this applies regardless of how the input is framed, including as speech, discovery, prayer, backstory, or any other construct. Do not introduce, name, or describe any item that was not already present in confirmed engine state before this turn's input arrived, including as a substitute or consolation for a denied claim.)\n`;
    })();

    // v1.91.49: _entityGroundingBlock — advisory narrator grounding when AG allow_no_rc has unsupported referenced entities.
    // Computes unsupported entities from AG result vs evidence bundle, mirrors _validateReferencedEntities matching.
    const _supportsEntity = (ref, names) => names.some(n => n && ref && (n.includes(ref) || ref.includes(n)));
    const _agVisibleNpcNames     = _authorityGateResult?._ag_evidence_bundle?.visibleNpcNames || [];
    const _agReferencedEntities  = _authorityGateResult?.referenced_entities || [];
    const _unsupportedEntityRefs = _agReferencedEntities.filter(ref => {
      if (!ref || typeof ref !== 'string') return false;
      const refLower = ref.toLowerCase().trim();
      if (!refLower) return false;
      return !_supportsEntity(refLower, _agVisibleNpcNames);
    });

    const _entityGroundingBlock = (
      _authorityGateResult &&
      _authorityGateResult.decision === 'allow_no_rc' &&
      _authorityGateResult._llm_called === true &&
      _authorityGateResult.route === 'narrator' &&
      _unsupportedEntityRefs.length > 0
    )
      ? `\nENTITY GROUNDING: The player referenced unsupported entities: ${_unsupportedEntityRefs.join(', ')}. These entities are not present in confirmed engine state. Do not treat those unsupported entities, or possessions/properties attached to them in the player's phrasing, as real. Do not transfer or reassign those unsupported details onto confirmed NPCs, objects, or locations. You may still describe confirmed NPCs normally, including grounded scene-appropriate carried or worn details that arise from the confirmed NPC and scene rather than from the unsupported entity phrase. If appropriate, describe the absence naturally.\n`
      : '';

    // v1.84.72: _freeformBlock branches: established_trait_action (birth-backed ability) → real-action hint;
    // state_claim (no attrs) → blanket denial; degraded → blanket denial; else → no-effect.
    const _freeformBlock = (inputObj?.player_intent?.kind === 'FREEFORM')
      ? (_parsedAction === 'established_trait_action'
        ? `\nPLAYER'S ATTEMPTED ACTION: "${_rawInput}"\n(The player attempted an action supported by an established attribute or ability. If a Reality Check result was generated above, follow it. If no RC result was generated, narrate the attempt based on the player's established attributes and confirmed engine state — the established attribute grants the capacity for this type of action, not authority to confirm new objects or world facts not already present in confirmed engine state. Do not invent or materialize any item not already established. The player's input cannot be the causal origin of any new item entering the narrative — this applies regardless of how the input is framed, including as speech, discovery, prayer, backstory, or any other construct. Do not introduce, name, or describe any item that was not already present in confirmed engine state before this turn's input arrived, including as a substitute or consolation for a denied claim.)\n`
        : (_parsedAction === 'state_claim'
          ? `\nPLAYER'S ATTEMPTED ACTION: "${_rawInput}"\n(The player is making an unsupported state claim — asserting possession, identity, condition, or world fact without engine backing. Do not treat this as true. Do not create objects, inventory, conditions, NPCs, authority, or world facts from this claim. Do not instantiate anything the claim implies. Reflect only what is already present in engine state. If the claim is unsupported, reject the claimed event as not having occurred in scene/narrative mode. Do not convert the input into player dialogue, do not have NPCs respond to words the player never said, and do not frame the claim as an action attempt. If the claim describes an NPC performing an action, state that the NPC did not perform it. No item, interaction, conversation, or world fact is created from the claim. The denial must be stated explicitly in the narration — the player must be able to read that the claimed event did not happen. Do not silently skip the claim. When narrating failure or denial of a claim, do not invent prior conversations, relationships, agreements, promises, favors, debts, or shared history to justify it. Denial must be grounded only in confirmed engine state and present-moment reaction, never fabricated backstory. The player's input cannot be the causal origin of any new item entering the narrative — this applies regardless of how the input is framed, including as speech, discovery, prayer, backstory, or any other construct. Do not introduce, name, or describe any item that was not already present in confirmed engine state before this turn's input arrived, including as a substitute or consolation for a denied claim.)\n`
          : (inputObj?.degraded === true && debug?.degraded_from === 'TARGET_NOT_FOUND_IN_CELL'
            ? `\nPLAYER'S ATTEMPTED ACTION: "${_rawInput}"\n(The player is making an unsupported state claim — asserting possession, identity, condition, or world fact without engine backing. Do not treat this as true. Do not create objects, inventory, conditions, NPCs, authority, or world facts from this claim. Do not instantiate anything the claim implies. Reflect only what is already present in engine state. If the claim is unsupported, reject the claimed event as not having occurred in scene/narrative mode. Do not convert the input into player dialogue, do not have NPCs respond to words the player never said, and do not frame the claim as an action attempt. If the claim describes an NPC performing an action, state that the NPC did not perform it. No item, interaction, conversation, or world fact is created from the claim. The denial must be stated explicitly in the narration — the player must be able to read that the claimed event did not happen. Do not silently skip the claim. When narrating failure or denial of a claim, do not invent prior conversations, relationships, agreements, promises, favors, debts, or shared history to justify it. Denial must be grounded only in confirmed engine state and present-moment reaction, never fabricated backstory. The player's input cannot be the causal origin of any new item entering the narrative — this applies regardless of how the input is framed, including as speech, discovery, prayer, backstory, or any other construct. Do not introduce, name, or describe any item that was not already present in confirmed engine state before this turn's input arrived, including as a substitute or consolation for a denied claim.)\n`
            : (inputObj?.degraded === true && debug?.degraded_from === 'TARGET_NOT_WORN'
              ? `\nPLAYER'S ATTEMPTED ACTION: "${_rawInput}"\n(The player attempted to remove an item they are not currently wearing. Acknowledge this naturally and briefly — do not generate a robotic error message. Do not create, name, or describe any item not in confirmed engine state.)\n`
              : (inputObj?.degraded === true && debug?.degraded_from === 'PARSER_FAILURE_FALLBACK'
                ? `\nPLAYER'S ATTEMPTED ACTION: "${_rawInput}"\n(The parser could not classify this input as a known mechanical action, but that does not mean the attempt failed. Treat this as a genuine physical action attempt. Do not treat it as a state claim unless the wording is clearly declarative. Narrate the outcome based on the physical reality of the scene — success, partial success, or failure are all valid. The player's input cannot be the causal origin of any new item entering the narrative — do not introduce, name, or describe any item not already in confirmed engine state.)\n`
                : (_parsedAction === 'attack'
                  ? `\nPLAYER'S ATTEMPTED ACTION: "${_rawInput}"\n(The player is making a genuine physical attack. This is a real action with real consequences — do not treat it as mechanically inert and do not state that it has no mechanical effect. Follow the Reality Check advisory above for the outcome. Narrate the physical result as it would actually occur given the player's current embodiment, equipped items, and the target's actual capabilities. Success, partial success, and failure are all valid outcomes — the Reality Check has already assessed the likely consequence; honor it. Do not invent resistance or blocking mechanisms that contradict the RC outcome. The player's input cannot be the causal origin of any new item entering the narrative — do not introduce, name, or describe any item not already in confirmed engine state.)\n`
                  : (_parsedAction === 'remove'
                    ? (inputObj?.player_intent?.target === '__all_worn__'
                      ? `\nPLAYER'S ATTEMPTED ACTION: "${_rawInput}"\n(The player has successfully removed ALL of their worn clothing and gear. Every item is now in their inventory. None of it landed on the ground, was dropped, or was discarded anywhere. Do not describe any item falling to the floor or being set down. Do not name items using shortened or informal versions of their names.)\n`
                      : `\nPLAYER'S ATTEMPTED ACTION: "${_rawInput}"\n(The player has successfully removed a worn item from their body. The item is now in their inventory — it was not dropped, placed on the ground, or discarded. Do not describe it falling to the floor or ending up anywhere other than the player's possession.)\n`)
                    : (debug.object_operation_bridge?.active
                        ? `\nPLAYER'S ATTEMPTED ACTION: "${_rawInput}"\n(The player attempted an object operation that the engine evaluated and denied for this turn. Narrate the failed attempt only. Do not describe the player gathering, picking up, taking, holding, receiving, possessing, or partially completing the object operation. Do not change world state. Remain grounded in the current location. The player's input cannot be the causal origin of any new item entering the narrative — do not introduce, name, or describe any item not already in confirmed engine state, including as a substitute or consolation.)\n`
                        : `\nPLAYER'S ATTEMPTED ACTION: "${_rawInput}"\n(This action has no mechanical effect. Briefly acknowledge what the player tried to do within the narrative. Do not change world state. Remain grounded in the current location. The player's input cannot be the causal origin of any new item entering the narrative — do not introduce, name, or describe any item not already in confirmed engine state, including as a substitute or consolation.)\n`
                    ))))))))
      : '';
    // v1.84.79: environmental gather block — fires when AP resolved a take against a CB-promoted env: feature.
    // v1.85.6: also fires for synthetic=true (ORS had no prior record — narrator resolves plausibility).
    // Reads and clears state._environmentGatherIntent (set by ActionProcessor take handler).
    // Explicitly lifts the POSSESSION RULE / FOUNDING TURN RULE for this code path.
    const _envGatherIntent = gameState._environmentGatherIntent || null;
    if (_envGatherIntent) delete gameState._environmentGatherIntent;
    // v1.84.80: preserve the attempted label for the quarantine-time failure gate below.
    // If the narrator describes failure the label is used to block spurious grid promotions.
    const _envGatherLabel = _envGatherIntent ? _envGatherIntent.label.toLowerCase() : null;
    // v1.91.11: LLM divisibility validator — fires when AP set sourceObjectId (partial-token extraction path).
    // Checks: can [label] be non-destructively extracted from [sourceLabel]?
    // Cached by (sourceLabel::label) so the same pair never calls the LLM twice per server session.
    // On LLM failure or 'no': downgrades to synthetic:true (conservative — narrator handles plausibility).
    if (_envGatherIntent?.sourceObjectId) {
      const _divCacheKey = `${(_envGatherIntent.sourceLabel || '').toLowerCase()}::${(_envGatherIntent.label || '').toLowerCase()}`;
      if (_divCheckCache.has(_divCacheKey)) {
        if (!_divCheckCache.get(_divCacheKey)) {
          _envGatherIntent.sourceObjectId = null;
          _envGatherIntent.synthetic = true;
        }
      } else {
        try {
          const _divResp = await axios.post(
            'https://api.deepseek.com/v1/chat/completions',
            {
              model: 'deepseek-v4-flash',
              thinking: { type: 'disabled' },
              messages: [
                { role: 'system', content: 'You are a semantic validator for a game engine. Reply with exactly one word: yes or no.' },
                { role: 'user', content: `Can "${_envGatherIntent.label}" be non-destructively extracted from "${_envGatherIntent.sourceLabel}"? yes or no` }
              ],
              temperature: 0,
              max_tokens: 5
            },
            {
              headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
              timeout: 8000
            }
          );
          const _divAnswer = (_divResp?.data?.choices?.[0]?.message?.content || '').trim().toLowerCase();
          const _divOk = _divAnswer.includes('yes');
          _divCheckCache.set(_divCacheKey, _divOk);
          console.log(`[DIV-CHECK] "${_envGatherIntent.label}" from "${_envGatherIntent.sourceLabel}" -> ${_divOk ? 'allowed' : 'blocked'}`);
          if (!_divOk) {
            _envGatherIntent.sourceObjectId = null;
            _envGatherIntent.synthetic = true;
          }
        } catch (_divErr) {
          console.warn('[DIV-CHECK] validator call failed, downgrading to synthetic:', _divErr.message);
          _envGatherIntent.sourceObjectId = null;
          _envGatherIntent.synthetic = true;
        }
      }
    }
    const _environmentGatherBlock = _envGatherIntent
      ? (_envGatherIntent.sourceObjectId
        ? `\nSCENE CONTEXT: "${_envGatherIntent.sourceLabel}" is present in the current location.\n`
        : (_envGatherIntent.synthetic
        ? `\nENVIRONMENTAL GATHER ATTEMPT: The player is physically attempting to grab or pick up "${_envGatherIntent.label}". The engine has no prior record of this item. Narrate the player's physical search or reach using established scene details.\n`
        : (_envGatherIntent.featureValue
            ? `\nENVIRONMENTAL GATHER ATTEMPT: The player is attempting to pick up or gather "${_envGatherIntent.label}" from the environment. This item was established as a feature of the current scene by the engine: "${_envGatherIntent.featureValue}". This is a legitimate physical interaction with the narrated world — the POSSESSION RULE's item-instantiation prohibition and the FOUNDING TURN RULE do not apply to this attempt. The item pre-exists in the narrated scene; the player is not asserting something from thin air. Narrate the gather based on the physical nature of the item: if it is detachable or collectable (a plant, a flower, loose material, scattered debris, something lying on the ground), narrate the player successfully gathering it. If it is a permanent feature (a cliff face, a carved structure, a flowing stream), narrate clearly that it cannot be taken. Do not deny this attempt on the basis that the item is not yet listed in INVENTORY.\n`
            : `\nENVIRONMENTAL GATHER ATTEMPT: The player is attempting to pick up or gather "${_envGatherIntent.label}" from the environment. This item has not been confirmed as an established feature of the current scene by the engine. Narrate based on whether the current scene plausibly contains such an item given prior narration — if the environment would naturally include it, the player may find and gather it; if it is implausible given the current scene, narrate that nothing of that kind is found here. The POSSESSION RULE's item-instantiation prohibition does not apply if the item is plausibly present in the current scene.\n`)))
      : '';
    const _conditionBlock = (() => {
      const _activeConds = gameState.player?.conditions;
      if (!Array.isArray(_activeConds) || _activeConds.length === 0) return '';
      const _condLines = _activeConds.map(c => `- ${c.description} (since T-${c.created_turn})`).join('\n');
      return `\nPLAYER CONDITIONS (active):\n${_condLines}\n`;
    })();

    // v1.84.63: Object Conditions block — physical state history for tracked objects in scene
    const _objectConditionsBlock = (() => {
      const _objs = gameState.objects || {};
      const _w    = gameState.world || {};
      const _pos  = _w.position;
      const _loc  = _w.active_local_space || _w.active_site;
      // Collect in-scene container IDs
      const _sceneCids = new Set(['player']);
      if (_pos) _sceneCids.add(`LOC:${_pos.mx},${_pos.my}:${_pos.lx},${_pos.ly}`);
      // v1.85.81: include active localspace or site floor
      if (_loc && _loc.local_space_id) _sceneCids.add(_loc.local_space_id);
      else if (_loc && _loc.site_id)   _sceneCids.add(_loc.site_id);
      const _visNpcs = (_loc && _loc._visible_npcs) || [];
      for (const _npc of _visNpcs) { if (_npc.id) _sceneCids.add(_npc.id); }
      // Build lines for objects with conditions
      const _condLines = [];
      for (const _r of Object.values(_objs)) {
        if (_r.status !== 'active') continue;
        if (!_sceneCids.has(_r.current_container_id)) continue;
        if (!Array.isArray(_r.conditions) || _r.conditions.length === 0) continue;
        const _containerLabel = _r.current_container_type === 'player' ? 'held by you'
          : _r.current_container_type === 'npc' ? `held by ${_r.current_container_id}`
          : 'in this area';
        const _prose = _r.conditions.map(c => {
          const _ev = (c.evidence || '').trim();
          const _evTrunc = _ev.length > 80 ? _ev.slice(0, 80) + '...' : _ev;
          return _evTrunc
            ? `On turn ${c.set_turn}, ${_evTrunc}.`
            : `On turn ${c.set_turn}, it became: ${c.description}.`;
        }).join(' ');
        _condLines.push(`- ${_r.id} (${_r.name}, ${_containerLabel}): ${_prose}`);
      }
      if (_condLines.length === 0) return '';
      return `\nOBJECT CONDITIONS (physical history — last sentence = current state; honor in narration):\n${_condLines.join('\n')}\n`;
    })();
    const _expressiveBlock = (_parsedAction === 'wait' && _rawInput.toLowerCase() !== 'wait' && _rawInput !== '')
      ? `\nPLAYER EXPRESSION: "${_rawInput}"\nRender this concretely as the player's body language, posture, or physical expression in the scene. This is intentional player behavior and must appear in narration, but it does not create or modify game state.\n`
      : '';

    // Phase 3 (v1.49.0): Movement arrival flavor — fires on movement turns to preserve authored entry style.
    // Guard: Do channel + validated move action. Explicitly-defined condition; verbatim fidelity required.
    const _movementFlavorBlock = (resolvedChannel === 'do' && _parsedAction === 'move')
      ? `\nMOVEMENT STYLE: "${_movementDisplayInput}"\nIf the input contains any movement verb, style word, or asterisk-wrapped emote describing how the player moves, the player's manner of arrival MUST appear in the opening beat of your narration. Use the player's exact word(s) — do not substitute or paraphrase. Scene description follows through that arrival, not before it. Movement verbs (run, creep, sashay, sneak, dance, etc.) describe expressive style only — not checks, not speed, not systems. Plain directional input ("go south") requires no special treatment.\n`
      : '';

    // NPC talk result instruction block (ambiguity / not-found control)
    const _npcTalkBlock = (() => {
      if (!_npcTalkResult) return '';
      if (_npcTalkResult.outcome === 'ambiguous') {
        const role = _npcTalkResult.role || 'NPC';
        const count = _npcTalkResult.count || 2;
        return `\nSYSTEM: The player attempted to talk to "${role}" but ${count} NPCs with that role are present. Do NOT pick one arbitrarily. Narrate the ambiguity and instruct the player to be more specific — e.g. "There are ${count} ${role}s here. Which one did you mean?"\n`;
      }
      if (_npcTalkResult.outcome === 'not_found') {
        // v1.51.0: Suppress on Say channel — _soliloquyBlock handles unbound Say turns
        if (resolvedChannel === 'say') return '';
        const t = _npcTalkResult.target || 'that person';
        return `\nSYSTEM: The player attempted to talk to "${t}" but no matching NPC is visible at their current position. Narrate that no such person is here.\n`;
      }
      if (_npcTalkResult.outcome === 'not_in_site') {
        // v1.51.0: Suppress on Say channel — _soliloquyBlock handles unbound Say turns
        if (resolvedChannel === 'say') return '';
        return `\nSYSTEM: The player attempted to talk to someone but is not currently inside a site. Narrate that there is no one here to speak with.\n`;
      }
      return '';
    })();

    // Phase 3: NARRATOR MODE — fires on confirmed Say turns with an active NPC exchange.
    // Guard: resolvedChannel==='say' AND engine has no error override (_npcTalkBlock empty) AND NPC target is confirmed.
    const _npcRef = _rawNpcTarget || _npcTalkResult?.npc?.job || 'the person the player is addressing';
    const _narratorModeBlock = (
      resolvedChannel === 'say' &&
      !_npcTalkBlock &&
      (_rawNpcTarget || _npcTalkResult?.outcome === 'matched')
    )
      ? `\nNARRATOR MODE [MANDATORY]: This is a dialogue turn. The player is addressing ${_npcRef}.\n${_rawPreSpeech ? 'PLAYER APPROACH: "' + _rawPreSpeech + '"\nDo not summarize or omit anything in PLAYER APPROACH. Preserve every beat concretely — physical movement, gesture, expression, and setup all belong in narration before the speech act.\n' : ''}PLAYER SAYS: "${_rawInput}"\n- Text in asterisks (*like this*) represents player gesture or body language — weave it into the NPC's reaction; do not skip or summarize it\n- If the player's speech implies possession or use of an object not in authoritative state, that possession is not real and the action cannot physically complete. Do not have the NPC treat the implied object as real.\n- Do NOT re-describe the surrounding environment or scene unless it directly affects this exchange\n- Anchor entirely to the NPC's reaction: their words, expression, posture, and immediate response to the player\n- The player's words are the event. The NPC's response is the scene.\n- Social and conversational detail takes absolute priority over environmental description on dialogue turns\n`
      : '';

    // Phase 3: Do-channel PLAYER INTENT — non-authoritative flavor injection.
    // Guard: Do channel only, not degraded, has a validated non-wait action.
    const _doIntentTarget = inputObj?.player_intent?.target || null;
    const _doIntentBlock = (
      resolvedChannel === 'do' &&
      !inputObj.degraded &&
      _parsedAction &&
      _parsedAction !== 'wait' &&
      _parsedAction !== 'move' &&
      _parsedAction !== 'established_trait_action'
    )
      ? `\nPLAYER INTENT (for flavor only): "${_rawInput}"\nVALIDATED ACTION: ${_parsedAction}${_doIntentTarget ? ' \u2014 ' + _doIntentTarget : ''}\nUse the phrasing, tone, and body language from PLAYER INTENT freely to color how the moment feels. VALIDATED ACTION is the only mechanical reality — do NOT narrate any capability, outcome, or consequence for elements of PLAYER INTENT that are not reflected in VALIDATED ACTION. "Sneak," "run," "fly," and similar verbs describe expressive style only — not checks, not conditions, not systems.\n`
      : '';

    // Phase 3 (v1.51.0): Generalized emote block — fires on any channel when asterisk-wrapped gesture/body language is present.
    // Guard: any channel, no NPC match requirement. _narratorModeBlock dominates tone when both fire.
    // v1.51.0: Removed creative-license phrase "render as physical expression" — replaced with explicit anti-substitution wording.
    const _emoteBlock = /\*[^*]+\*/.test(_rawInput)
      ? `\nEMOTE DETECTED: The player's input contains asterisk-wrapped gesture or body language (*like this*). The player's authored emote is the action. Use their exact word(s) as written in the narration — do not reinterpret, replace, or substitute it with a different gesture. Integrate it naturally but do not invent an alternative.\n`
      : '';

    // v1.85.35: Emote object authority block — fires on say-channel turns with asterisk-wrapped emotes.
    // Guards: resolvedChannel==='say' AND emote present. Covers both NPC-addressed and soliloquy.
    // Enforces three-tier object authority model: player-controlled | NPC-controlled (contested) | nonexistent.
    const _emoteObjectAuthorityBlock = (
      resolvedChannel === 'say' && /\*[^*]+\*/.test(_rawInput)
    )
      ? (() => {
          console.log('[EMOTE-AUTHORITY] fired turn:', turnNumber);
          return `\nEMOTE OBJECT AUTHORITY [MANDATORY]:\nThis input contains an asterisk-wrapped emote. If the emote clearly describes a physical action involving a concrete object, determine the object's authority status before narrating:\n- Object appears in INVENTORY or WORN above — player controls it. Proceed normally.\n- Object appears in NPCs PRESENT carries or wears — the object is real in this scene, but it belongs to the NPC. The attempt is valid; the outcome is not automatic. Narrate as the simulation demands given the NPC's character and the nature of the interaction. Do NOT complete the transfer or access as if it were guaranteed.\n- Object is not found in the authority sources available to this prompt — the object does not exist. You MUST narrate the player reaching or miming the gesture with empty hands. Do not describe the object as physically present. Do not describe its weight, texture, or appearance. No NPC may react to it as if it were real or present. The action fails visibly — the gesture produces nothing.\n`;
        })()
      : '';

    // v1.85.41: Emote inventory fail block — fires when emote_no_inventory_match skipped RC.
    // Injected first in the tail sequence to dominate model attention.
    const _emoteInventoryFailBlock = (_rcSkippedReason === 'emote_no_inventory_match')
      ? `\n[MANDATORY — OBJECT NOT IN INVENTORY: The emote references an object not found in the player's possession. That object is not established in authoritative state and must not be treated as physically present. Narrate the player miming or reaching with empty hands. Do not instantiate the object in any form.]\n`
      : '';

    // v1.85.42: Emote remove block — fires when a worn item was authoritatively transferred via emote.
    // Instructs narrator that item is in inventory, not on the ground.
    const _emoteRemoveBlock = _emoteRemoveExecuted
      ? `\n[MANDATORY — WORN ITEM REMOVED: The player has successfully removed "${_emoteRemovedItemName}" from their body. It is now in their inventory. It was not dropped, placed on the ground, or discarded anywhere. Do not describe it falling, being set down, or ending up anywhere other than the player's possession.]\n`
      : '';

    // v1.51.0: Soliloquy block — fires on Say channel when no NPC is successfully bound.
    // Covers: NPC_NOT_PRESENT degrade, target:null, not_found, not_in_site outcomes.
    // Mutually exclusive with _narratorModeBlock (which requires matched NPC).
    // v6.0.18: _soliloquyFired flag used downstream to suppress unsupported player-state promotion in CB.
    const _soliloquyFired = (
      resolvedChannel === 'say' &&
      !_rawNpcTarget &&
      _npcTalkResult?.outcome !== 'matched'
    );
    const _soliloquyBlock = _soliloquyFired
      ? `\nPLAYER SPEAKS ALOUD: "${_rawInput}"\nThe player speaks without addressing any specific recipient. Narrate the player's words as self-expression. Do not treat unsupported declarations as changes to engine truth.\n`
      : '';

    // v1.52.0: Narration Task Override — task-replacement blocks for move/look/exit turns.
    // Pattern mirrors _narratorModeBlock: each block replaces (not modifies) the default narration task.
    // Mutually exclusive by _parsedAction value. Injected after all secondary blocks.
    const _movementTaskBlock = (_parsedAction === 'move')
      ? `\nNARRATION TASK [MANDATORY]: This is a movement turn.\nThe player's authored action — "${_movementDisplayInput}" — is the narrative event.\nLead with how the player arrives or moves.\nThe environment is encountered as a result of movement, not the primary subject.\nDo NOT open with a room or environment description.\nIf the input contains movement style or an emote, use the exact wording.\nDo NOT replace the player's authored action with a generic or alternative action.\n`
      : '';

    const _lookTaskBlock = (_parsedAction === 'look')
      ? `\nNARRATION TASK [MANDATORY]: This is a look turn.\nThe player's authored action — "${_rawInput}" — is the narrative event.\nLead with the act of looking.\nWhat is seen unfolds through the player's attention.\nDo NOT begin with environment description as if no action occurred.\nDo NOT replace the player's authored action with a generic or alternative action.\n`
      : '';

    const _exitTaskBlock = (_parsedAction === 'exit')
      ? `\nNARRATION TASK [MANDATORY]: This is an exit turn.\nThe player's authored action — "${_rawInput}" — is the narrative event.\nTheir phrasing describes how they exited. Use it.\nDo NOT replace it with a generic exit description.\nDo NOT open with environment description before the exit action.\nDo NOT replace the player's authored action with a generic or alternative action.\n`
      : '';

    // v1.85.5: enter arrival anchor — mirrors _exitTaskBlock pattern; gates on successful entry only
    const _enterTaskBlock = (_parsedAction === 'enter' && !_actionHadNoEffect)
      ? (() => {
          const _enteredSiteName = gameState.world?.active_site?.name || 'the site';
          return `\nNARRATION TASK [MANDATORY]: This is an entry turn. The player has arrived in ${_enteredSiteName}.\nThey are now inside the site boundary. Lead with arrival — what they immediately encounter upon entering.\nDo NOT narrate approach, travel toward the site, or exterior description.\nDo NOT open with environment description before the arrival event.\nDo NOT replace the player's authored action with a generic or alternative action.\nThe player is already there.\n`;
        })()
      : '';

    // v1.53.0: Dynamic primary narration task bullet.
    // Replaces the static "Write a vivid paragraph describing surroundings" bullet in the CORE INSTRUCTIONS
    // bullet list with a turn-specific task definition. This is the upstream fix — the bullet is read
    // before any tail block, so changing it here sets the model's primary deliverable correctly.
    // Tail blocks (_movementTaskBlock etc.) remain as reinforcement layers.
    const _primaryNarrationBullet = (() => {
      if (_parsedAction === 'move') {
        return `Write a vivid paragraph that opens with the player's specific movement. Their verb or manner from "${_movementDisplayInput}" is the first beat — the environment is encountered through that movement, not described before it. Do not lead with surroundings description.`;
      }
      if (_parsedAction === 'look') {
        return `Write a vivid paragraph anchored to the player's act of looking. What they observe unfolds through their attention — do not open with surroundings as if no action occurred.`;
      }
      if (_parsedAction === 'exit') {
        return `Write a vivid paragraph that opens with how the player exited. Their specific phrasing from "${_rawInput}" is the narrative event — do not open with the destination environment before the exit action.`;
      }
      // v1.85.5: enter arrival anchor — gates on successful entry only (_actionHadNoEffect excludes failed/ambiguous)
      if (_parsedAction === 'enter' && !_actionHadNoEffect) {
        const _enteredSiteName = gameState.world?.active_site?.name || 'the site';
        return `Write a vivid paragraph that opens with the player's arrival into ${_enteredSiteName}. They are now inside the site boundary — lead with what they immediately encounter upon arrival. Do not narrate travel toward the site; the player is already there.`;
      }
      return `Write a vivid paragraph describing the player's current surroundings as they experience them now`;
    })();

    const narrationContent = `Turn 1 is not a normal declaration. It is the world founding phase. Player input on Turn 1 is treated as founding premise, not as an action and not as a constrained state declaration. During this phase, the player may define their identity, form, starting location, possessions, status, and scenario conditions without restriction. Any statement that defines who the player is, what they possess, where they are, or what conditions they start under is a valid founding premise — regardless of its content, genre, or apparent implausibility. No founding input is cheating, invalid, or to be rejected. The system must interpret these inputs into structured starting state, record them in the player's birth record, and treat them as real starting conditions. Physical, spatial, and logistical constraints still apply, NPCs are not required to believe social claims, and all consequences are enforced through simulation rather than restriction. The goal of this phase is maximum expressive freedom at world creation, with consequences emerging naturally from the world.

After Turn 1, the world is locked. Player declarations are now constrained. They may clarify the player's self-state, including posture, condition, appearance, and activity, but they may not create inventory, teleport the player, grant authority or status, rewrite location, create NPCs or world objects, or directly alter world state. Statements that assert new possessions, claimed authority, new locations, or altered world state must not directly become truth unless supported by existing engine state or resolved through action systems. All founding premise data is stored in the player container under a birth record, which represents the conditions under which the player entered the world. This record is authoritative for initial identity, context, possessions, and claims. Narration must treat validated birth facts as real while allowing the world, including NPC behavior, physics, and constraints, to respond accordingly.

The player is free to attempt any action, express any idea, or describe any behavior at any time. There are no restricted verbs, no required formats, and no limit to creative expression. Freeform action is the primary mode of interaction, not a fallback. Every input from the player is treated as a genuine attempt to act within the world. Attempt is always allowed. Outcome is never guaranteed.

All actions exist within a world that has consequences. Objects have weight, volume, and presence. Locations impose constraints. NPCs observe, react, interpret, and respond according to their own perspective and the visible state of the world. Claims of authority, identity, or status do not automatically become accepted truth; they are treated as part of the player's expression and are subject to validation or rejection by the world through social and physical response. The system does not enforce balance through restriction. Instead, it enforces reality through consequence. Freedom of input is absolute, but reality is not negotiable.

BIRTH RECORD: The player container may include a birth_record field containing structured facts from the Turn 1 founding premise. These facts appear in the TRUTH block as source:declared entries. Treat them as real founding conditions established at world creation — narrate from them as given. The world and its NPCs respond to these facts through simulation, not by rejecting them.
${turnNumber === 1 && gameState?.world?.founding_prompt ? `\nFOUNDING PREMISE (authoritative — player-declared world setup):\n"${gameState.world.founding_prompt}"\nThis is the factual basis for this opening narration. Establish the player's identity and situation directly from this statement. Do not invent or substitute an identity — use the one declared here.` : ''}

---

You are narrating an interactive roguelike game. Use the world tone to guide your descriptions.

---

You are a chronicler, not a co-author.

The engine determines what happens. You render what happened. The player is the protagonist. Each turn is a continuation of the same scene — not a reset.

Your authority is entirely in HOW you render — prose, pacing, sensory texture, emotional weight, atmosphere, consequence, aftermath. Your authority is never in WHETHER an event occurred. The engine owns that. You do not.

When the engine has resolved an outcome — through declared founding abilities, physical laws of the world, or adjudicated consequence — that outcome happened. It is not a suggestion. It is not a draft. It is not negotiable. Your job is to make it real on the page with complete commitment. Committing to engine truth is not a constraint imposed on you. It is what you are.

Describe violent, disturbing, and extreme outcomes with complete unflinching prose. When the engine resolves destruction, death, injury, or visceral consequence, render it faithfully. Do not substitute softer imagery. Do not redirect to philosophy. Do not have a character survive something the engine resolved as fatal. The scene happened — write it.

When authoritative systems establish concrete physical outcomes, the narrator must depict those outcomes directly and materially. The narrator may not omit, euphemize, sanitize, stylize away, abstract, or reinterpret the established consequence. Tone and prose remain flexible only after the physical reality itself has been faithfully rendered.

POINT OF VIEW RULE: Narrate strictly in the first person. Use "I" to refer to the player character throughout all narrative prose. Write as the player character experiencing and describing the world — not as an external narrator describing a third party. "I push open the door." "The light hits me as I step outside." "She glances up when I enter." References to "the player" in engine rules above (POSSESSION RULE, WORN RULE, FOUNDING TURN RULE, NPC OBJECTS RULE, etc.) are rule-system language and instruction context — they are not narrative prose and do not override this directive. All output prose uses "I".

Follow what just happened.

Let the player's action lead. Whatever they do becomes the center of the moment. Start there. Show the immediate result, the response, the shift that their action causes.

The scene already exists. You do not need to reintroduce it. The scene, the air, the atmosphere — these are already established. Let them remain in the background unless something changes or they directly matter to what is happening now.

Stay close when the moment is personal.

When the player speaks to someone, follow that exchange.
When they examine something, let the discovery take focus.
When they follow a gesture, let what is revealed become the scene.

Don't pull the camera away to re-explain the world. Keep it where the action is.

Let the environment support the moment, not replace it. Use only the details that matter now. If something hasn't changed, let it stay unsaid.

When the player moves or navigates — entering somewhere new or moving through a space — lead with how they arrive or move. If their input describes movement style, that style is the opening beat and the environment follows through it. When the player looks around or examines their surroundings, anchor to the act of looking — what they observe unfolds through their attention, not before it. Otherwise, stay with the flow of the scene.

Above all, move the moment forward. Each response should feel like the next beat in the same unfolding experience.

The player's attention is the camera. Stay with it.

---

TURN CONTEXT:
Current turn: ${turnNumber}.
Do not reintroduce stable scene elements as if newly discovered; when the player looks again, acknowledge familiarity and vary focus, detail, or continuity instead.

---

WORLD TONE & CHARACTER:
${gameState?.world?.world_tone || "A functional, atmospheric world"}

WORLD CONTEXT:
Biome: ${_narBiome || '(unknown)'}
Civilization Presence: ${_narCivPresence || '(unknown)'}
Environment Tone: ${_narEnvTone || '(unknown)'}
${npcsStr === '(None visible)' ? `\nOCCUPANCY STATE: No persons are present at your current position. The world tone above describes the setting's character and environmental atmosphere, not its current tile population. Do not infer that people are present at this position from the tone, the location type, or the location name. Other persons may exist elsewhere in the site — they are not here.\n` : ''}
LAYER CONSTRAINT [MANDATORY]:
${_narDepth === 3
  ? `You are inside a local space (Layer L2). The player is already within this environment — do NOT reintroduce or restate the room at the start of this turn.

${_parsedAction === 'state_claim' ? `This input is an unsupported claim and is not a valid action. Do not begin from it. Begin from what is actually present in the scene — the player's surroundings, visible entities, and current world state.` : _actionHadNoEffect && _enterAmbiguous ? `Multiple enterable structures are present at this location. The player's input did not specify which one. Acknowledge this directly and briefly — the player must name the structure to proceed. Do not describe movement, approach, or entry of any kind.` : _actionHadNoEffect && _parsedAction === 'enter' ? `The player attempted to enter but there is nothing enterable here. Briefly acknowledge this. Do not describe movement, approach, or entry.` : _actionHadNoEffect ? `This action had no mechanical effect — the player's location is unchanged. Narrate a brief grounded moment in the player's current position. Do not describe movement, travel, or approach.` : `The player's action — "${_rawInput}" — is the anchor of this turn. Begin there.`}

Environment appears only as it is encountered, interacted with, or newly revealed through the action. Avoid repeating static descriptions (air, smell, walls, lighting, hum) unless something has changed or the player is actively examining their surroundings.${_parsedAction === 'move' ? `

The player is moving. Use their exact phrasing in the first sentence. The environment is what they pass through — not what they stop to describe.` : (_parsedAction === 'look' || _parsedAction === 'examine') ? `

The player is actively observing — environment description is warranted here. Describe in detail what their attention finds, grounded in the space around them.` : ''}`
  : _narDepth >= 2
  ? `You are narrating Layer L1 — the open interior of ${_narActiveSite?.name || 'the site'}: streets, paths, and open areas between buildings. The player is traversing this site. Their action is the opening beat of this turn — streets and paths are what they move through, not a scene to re-establish each turn. Do not open with a description of the ground, air, or ambient sounds as if the player is standing still. Do not repeat static environmental phrases from prior turns.

${_parsedAction === 'state_claim' ? `This input is an unsupported claim and is not a valid action. Do not begin from it. Begin from what is actually present in the scene — the player's surroundings, visible entities, and current world state.` : _actionHadNoEffect && _enterAmbiguous ? `Multiple enterable structures are present at this location. The player's input did not specify which one. Acknowledge this directly and briefly — the player must name the structure to proceed. Do not describe movement, approach, or entry of any kind.` : _actionHadNoEffect && _parsedAction === 'enter' ? `The player attempted to enter but there is nothing enterable here. Briefly acknowledge this. Do not describe movement, approach, or entry.` : _actionHadNoEffect ? `This action had no mechanical effect — the player's location is unchanged. Narrate a brief grounded moment in the player's current position. Do not describe movement, travel, or approach.` : `The player's action — "${_rawInput}" — is the anchor of this turn. Begin there.`}${_parsedAction === 'move' ? `

The player is moving through the site. Use their exact phrasing in the first sentence. The street or path is what they pass through — not what they stop to describe.` : (_parsedAction === 'look' || _parsedAction === 'examine') ? `

The player is actively observing. Observation is warranted here — describe what their attention finds in the site around them.` : ''}

You are NOT inside any individual local space or structure. Do NOT describe any building interior under any circumstance unless the engine explicitly indicates Layer L2. Any local spaces listed below are navigation references only — do NOT import their smell, atmosphere, or character into your description.`
  : `You are narrating Layer L0 — the overworld. The player is traversing open terrain. Their action is the opening beat of this turn — terrain is the medium they are moving through, not the primary subject of the narration. Do not open with a description of the landscape as if the player is standing still surveying it. Do not repeat static terrain phrases from prior turns.

${_parsedAction === 'state_claim' ? `This input is an unsupported claim and is not a valid action. Do not begin from it. Begin from what is actually present in the scene — the player's surroundings, visible entities, and current world state.` : _actionHadNoEffect && _enterAmbiguous ? `Multiple enterable structures are present at this location. The player's input did not specify which one. Acknowledge this directly and briefly — the player must name the structure to proceed. Do not describe movement, approach, or entry of any kind.` : _actionHadNoEffect && _parsedAction === 'enter' ? `The player attempted to enter but there is nothing enterable here. Briefly acknowledge this. Do not describe movement, approach, or entry.` : _actionHadNoEffect ? `This action had no mechanical effect — the player's location is unchanged. Narrate a brief grounded moment in the player's current position. Do not describe movement, travel, or approach.` : `The player's action — "${_rawInput}" — is the anchor of this turn. Begin there.`}${_parsedAction === 'move' ? `

The player is moving across terrain. Use their exact phrasing in the first sentence. The terrain and landscape are what they pass through — not what they stop to describe.` : (_parsedAction === 'look' || _parsedAction === 'examine') ? `

The player is actively observing. Observation is warranted here — describe what their attention finds across the terrain around them.` : ''}

You MUST NOT describe the player as entering, being inside, or stepping into any structure, site, or building. The player is outdoors in open terrain. Any sites or communities listed below are visible landmarks — do NOT narrate arrival or entry into them.`}

${_continuityBlock ? _continuityBlock + '\n\n' : ''}${_engineSpatialBlock ? _engineSpatialBlock + '\n\n' : ''}CORE INSTRUCTIONS:
- Let the world tone guide your descriptions and atmosphere — world tone governs environmental mood, setting character, and sensory details. It does not determine occupancy. Who is present is determined exclusively by NPCs PRESENT, never by world tone, location type, or location name.
- Expand on the location description with vivid sensory details matching the tone
- React to the player's action naturally within the world
- Only describe what's present in the player's CURRENT LOCATION—do not place the player into adjacent areas

---

[LOCATION ATMOSPHERE — physical and sensory properties of the space only. This text is NOT authoritative on occupancy. If it references any person, figure, employee, customer, or crowd — DO NOT narrate that person or group. Treat any such reference as a drafting artifact. Who is present is determined exclusively by NPCs PRESENT.]
${_narSceneDesc}
(Terrain: ${_narSceneType})

---

${nearbyStr}

INVENTORY: ${invStr}
WORN: ${wornStr}
GROUND: ${_groundStr}
WORN RULE: Items listed in WORN are the player's worn clothing and equipment. WORN is the authoritative physical containment record — if an item appears in both WORN and in a birth possession attribute string, the WORN entry governs; do not treat it as separately carried or duplicate the object. Items marked (baseline) are standard everyday clothing present since game start; do not describe them unless they become damaged, removed, explicitly interacted with, or otherwise relevant to the current scene.
POSSESSION RULE: Items listed in INVENTORY are the only items the player currently holds. If the player attempts to produce, pull out, retrieve from pockets, or assert prior possession of any item NOT in INVENTORY, that item does not exist — acknowledge the attempt and narrate why it fails. Never silently ignore the attempt. The narrator may introduce items into the environment (on the floor, on a table, on the ground nearby) — those items are real and the player may subsequently take them. However, the narrator must NOT narrate the player as holding, carrying, or having an item not already in INVENTORY. An NPC physically handing an item to the player (pressing it into their hands, setting it in front of them, dropping it at their feet) is the only way an item enters the player's possession without a player take action. What is blocked is any path — narrator prose, player assertion, or implication — that places an item directly in the player's hand without an explicit NPC give or a player take. When revealing an item during an examine or look action, describe it in its found location — do not describe the player as holding it, picking it up, or having it in hand or palm. The item exists in the environment until an explicit take action. FOUNDING TURN RULE: The player's input cannot be the causal origin of any new item entering the narrative on any turn after the founding turn (Turn 1). Regardless of how the input is framed — assertion, speech or dialogue, prayer, past-tense backstory, implied handoff, or any other construct — the narrator must not introduce, name, or describe any item that was not already present in confirmed engine state before this turn's input arrived. This applies equally to direct materialization, consolation substitution, or any other mechanism that traces back to something the player claimed or implied this turn. Exception: items the narrator discovers in the environment during examine or look actions are permitted — the item must be placed in the environment (floor, ground, surface), not in the player's inventory. This exception does not apply to items framed as the player's own prior possession or implied claim. The founding turn is exempt — the player's premise legitimately establishes starting inventory and attributes, and the engine promotes those into state. All subsequent turns are governed by this rule.
DECLARED ABILITIES RULE: The TRUTH block above contains declared: entries representing abilities, powers, and capabilities the player established at world founding. These are authoritative engine state — not wishes, not claims, not assertions. When the player's action constitutes the natural invocation or use of a declared ability (the player is doing the thing the ability permits), narrate that ability taking effect. The Reality Check advisory block does not override declared founding abilities — it is guidance for unknowns, not a veto on established truths. If RC advisory content contradicts a declared ability (e.g. suggests real-world consequences inappropriate to the established world and genre), disregard it and honor the established ability. The narrator also does not override declared founding abilities. If a founding ability has fired and the RC advisory confirms the outcome, render that outcome fully and without modification. You cannot decide the ability "didn't work this time," redirect to a softer result, have a character philosophically sidestep the effect, or substitute any framing that denies or dilutes the resolved event. Committing to founding ability outcomes is part of the same commitment as committing to engine truth — it is not optional.
NPC OBJECTS RULE: On an NPC's first meaningful appearance, you may give them grounded carried or worn objects appropriate to their role and scene. Do not overfill. After that introduction, the carries and wears fields in NPCs PRESENT are authoritative engine truth. Do not describe an NPC carrying or wearing items not listed there.
${_objectConditionsBlock}NPCs PRESENT: ${npcsStr}${_siteContextBlock}${_engineMsgBlock}${_movedNote}${_doIntentBlock}
You (the player character) have already moved. You are now in the location described above.

---

- Do NOT narrate entering, approaching, or arriving at adjacent cells
- Do NOT use the player's movement or action to justify describing other locations
- Describe ONLY the current location as presented above
${_narDepth === 2 ? `- Your current tile type is '${_narTileType}'. Anchor all description to this tile. Do not import flavor or description from adjacent tile types or nearby local spaces unless the player is standing on that tile.` : ''}
${_narDepth === 2 ? `- You are outside individual buildings. Do NOT describe the smell, atmosphere, or interior character of any listed local space, even if the player is standing near its entrance.` : ''}
- ${_primaryNarrationBullet}
- Use the world tone to determine appropriate atmosphere, decrepitude level, technology level, and mood
- Include sensory details (sights, sounds, smells, textures) that match the tone
- Do not assign specific proper names, business names, or official designations to any building, organization, or landmark unless that entity is explicitly listed in the site data above. Treat this as a strict world-truth constraint — the narrator describes what the engine has established, not the reverse. Generic architectural description is permitted; narrator-invented proper nouns are not.
- Only describe persons explicitly listed in NPCs PRESENT. Do not introduce, imply, or reference any other people anywhere in the scene — at this tile, in another room, behind a counter, arriving, or anywhere else. The LOCATION ATMOSPHERE text above is non-authoritative on occupancy — if it references any person, figure, or human presence, treat that as a drafting artifact and do not narrate that person. If NPCs PRESENT is '(None visible)', no person exists in this location: do not narrate any person performing actions. You may describe absence, expectation, or emptiness (an unwatched counter, empty chairs), but not an actual person doing anything.
- If NPCs PRESENT contains one or more entries, those NPCs are physically present at the player's exact tile and MUST be acknowledged in your narration on this turn — describe them as encountered. Do NOT defer NPC presence to a follow-up 'look' command.
- NPC names: npc_name:null means the player has not yet learned this NPC's name — describe by role, appearance, or behavior only. Never invent or assume a proper name when npc_name is null; if the fiction calls for a name to be spoken, wait for an ENGINE AUTHORITY block to supply it. npc_name non-null means the player knows this name — use it exactly as given, never alter or regenerate it. Do NOT emit [npc_updates:] blocks under any circumstances — name assignment and learning are handled entirely by the engine.
${_emoteInventoryFailBlock}${_emoteRemoveBlock}${_conditionBlock}${_authorityGateBlock}${_entityGroundingBlock}${_freeformBlock}${_environmentGatherBlock}${_expressiveBlock}${_npcTalkBlock}${_emoteBlock}${_movementFlavorBlock}${_soliloquyBlock}${_narratorModeBlock}${_emoteObjectAuthorityBlock}${_movementTaskBlock}${_lookTaskBlock}${_exitTaskBlock}${_enterTaskBlock}${_objectOperationBridgeBlock}${_realityAnchorBlock}${_nameRevealAuthorityBlock}`;

    console.log(`[NARRATE] Built narration prompt, length: ${narrationContent.length} chars`);
    if (narrationContent.length > 28000) console.warn(`[NARRATOR] WARN prompt_oversized len=${narrationContent.length} turn=${turnNumber}`); // v1.88.40

    // Reset capture tracking for this turn
    gameState.world._lastNpcCapture = { detected: false };

    const _makeNarCall = async () => {
      const _nCtrl = new AbortController();
      const _nWall = setTimeout(() => _nCtrl.abort(), 90000);
      try {
        return await axios.post('https://api.deepseek.com/v1/chat/completions', {
          model: 'deepseek-v4-flash',
          thinking: { type: 'disabled' },
          messages: [{ role: 'user', content: narrationContent }],
          temperature: 0.7
        }, {
          headers: {
            'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
            'Content-Type': 'application/json'
          },
          httpsAgent: _sharedHttpsAgent,
          timeout: 90000,
          signal: _nCtrl.signal
        });
      } finally {
        clearTimeout(_nWall);
      }
    };

    let response;
    let _narratorStart = null;
    let _narratorEnd = null;
    const _nar = { model: 'deepseek-v4-flash', thinking: { type: 'disabled' }, temperature: 0.7, messages: [{ role: 'user', content: narrationContent }] };
    diag.setNarratorPayload(_nar);
    try {
      // v1.85.39: narration stage start
      diag.emitDiagnostics({ type: 'turn_stage', stage: 'narration', status: 'start', turn: turnNumber, gameSessionId: resolvedSessionId });
      _reportProgress('narrating', 64, {});
      _narratorStart = Date.now();
      response = await _makeNarCall();
      _narratorEnd = Date.now();
    } catch (_nFirstErr) {
      if (_nFirstErr?.code === 'ECONNRESET') {
        console.warn('[NARRATE] ECONNRESET — retrying once...');
        _narratorStart = Date.now();
        response = await _makeNarCall();
        _narratorEnd = Date.now();
      } else {
        throw _nFirstErr;
      }
    }

    // Safely extract narrative
    let narrative = "The engine processes your action.";
    let _narratorStatus = 'ok'; // 'ok' | 'malformed' — hard failures emit narrator_error SSE event instead
    let _narratorUsage = null;
    try {
      if (response?.data?.choices?.[0]?.message?.content) {
        narrative = String(response.data.choices[0].message.content);
        diag.setNarratorRawResponse(narrative);
        _narratorPayloadSnapshot = { prompt: _nar, response: narrative }; // v1.84.21
      } else {
        _narratorStatus = 'malformed'; // response received but no content
      }
      _narratorUsage = response?.data?.usage || null;
    } catch (parseErr) {
      console.error('Failed to parse DeepSeek response:', parseErr.message);
      _narratorStatus = 'malformed'; // parse threw
    }

    // Unconditional divergence check: cell.sites is naming authority; world.sites must match.
    // Runs every narration turn regardless of whether Phase 5 fired.
    {
      const _dvCell = gameState.world.cells?.[_narCellKey];
      if (_dvCell?.sites) {
        for (const [_dvSiteId, _dvSite] of Object.entries(_dvCell.sites)) {
          if (_dvSite.name == null) continue;
          const _dvMirrorKey = _dvSite.interior_key || null;
          const _dvMirror = _dvMirrorKey ? gameState.world.sites?.[_dvMirrorKey] : null;
          if (_dvMirror && _dvMirror.name != null && _dvMirror.name !== _dvSite.name) {
            console.warn(`[SITE_NAME_DIVERGENCE] ${_dvSiteId}: cell="${_dvSite.name}" mirror="${_dvMirror.name}" — healing`);
            _dvMirror.name = _dvSite.name;
          }
        }
      }
    }

    // v1.85.39: narration complete, world_update starting
    diag.emitDiagnostics({ type: 'turn_stage', stage: 'narration', status: 'complete', turn: turnNumber, gameSessionId: resolvedSessionId });
    diag.emitDiagnostics({ type: 'turn_stage', stage: 'world_update', status: 'start', turn: turnNumber, gameSessionId: resolvedSessionId });

    // v1.70.0: ContinuityBrain Phase B — forensic extraction + promotion; replaces NC extraction+freeze
    let _continuityExtractionSuccess = false;
    let _extractionPacket = null;   // v1.70.0: CB extracted schema (replaces active_continuity snapshot)
    let _dmNoteArchived   = null;   // v1.70.0: retired (dm_note superseded by entity.attributes promotion)
    let _dmNoteStatus     = 'new_game'; // v1.70.0: 'updated' | 'new_game'
    let _watchMessageThisTurn = null; // v1.79.0: Mother's watch_message for this turn
    let _cbSchemaDrift = [];            // v1.88.40: CB schema drift detection results
    {
      // Assemble compact watch context for Phase B — 5 structured fields, no prose
      // NOTE: movement and _turnViolations are not yet computed at Phase B time — omit them
      const _watchCtx = {
        continuity_injected:        _continuityInjected,
        continuity_evicted:         _continuityEvicted,
        continuity_eviction_reason: _continuityEvictionReason || null,
        narrator_status:            _narratorStatus || 'ok',
        move_summary:               null,
        violation_count:            0,
        top_violation:              null,
        channel:                    resolvedChannel || null,
      };
      // v1.88.31: pre-pass — extract founding NPC identity before Phase B so the pre-seed guard fires.
      // Turn 1 only. Internal guards in extractFoundingNpc() are a secondary backstop.
      if (turnNumber === 1 && gameState.world?.founding_prompt && !gameState._born_npc_initialized) {
        const _fnResult = await CB.extractFoundingNpc(gameState);
        if (_fnResult?.starting_npc) {
          const _fnSeed = String(gameState.world?.phase3_seed || gameState.world?.seed || 0);
          gameState._born_npc_preid = _bornNpcId(_fnSeed, _fnResult.starting_npc);
        }
      }
      // v1.88.29: pre-seed born NPC into _visible_npcs before CB so Phase B sees the canonical container ID
      if (turnNumber === 1 && gameState.player?.birth_record?.starting_npc && !gameState._born_npc_initialized) {
        const _preSnRaw = gameState.player.birth_record.starting_npc;
        const _preSn    = Array.isArray(_preSnRaw) ? _preSnRaw[0] : _preSnRaw;
        if (_preSn && typeof _preSn === 'object') {
          const _preSeed = String(gameState.world?.phase3_seed || gameState.world?.seed || 0);
          const _preId       = _bornNpcId(_preSeed, _preSn);
          const _preVcTarget = gameState.world?.active_local_space || gameState.world?.active_site || gameState.world;
          if (!Array.isArray(_preVcTarget._visible_npcs)) _preVcTarget._visible_npcs = [];
          if (!_preVcTarget._visible_npcs.some(n => n.id === _preId)) {
            // v1.88.32: attributes:{} required — CB._promoteEntityAttributes expects a valid NPC shape
            _preVcTarget._visible_npcs.push({ id: _preId, npc_name: _preSn.name || _preSn.generated_name || null, attributes: {} });
          }
        }
      }
      const _phaseBResult = await CB.runPhaseB(narrative, gameState, _watchCtx, _rawInput, {
        suppressUnsupportedPlayerStatePromotion: _soliloquyFired,
        tlsPartialStackTakeReceipt: _cbTlsPartialStackTakeReceiptState === 'accepted'
          ? _cbTlsPartialStackTakeReceipt : null,
        tlsPartialStackDropReceipt: _cbTlsPartialStackDropReceiptState === 'accepted'
          ? _cbTlsPartialStackDropReceipt : null
      });
      _continuityExtractionSuccess = _phaseBResult !== null;
      if (_phaseBResult) {
        const _partialDropDescription = _phaseBResult.partial_drop_successor_description;
        const _validatedPartialDropDescriptionReceipt = _sanitizeCbTlsPartialStackDropReceipt(
          _cbTlsPartialStackDropReceiptState === 'accepted'
            ? _cbTlsPartialStackDropReceipt : null
        );
        if (
          _validatedPartialDropDescriptionReceipt &&
          _partialDropDescription &&
          typeof _partialDropDescription.description === 'string' &&
          _partialDropDescription.description.length > 0
        ) {
          const _sourceDescription = gameState.objects?.[
            _validatedPartialDropDescriptionReceipt.source_object_id
          ]?.description;
          if (
            _partialDropDescription.description.trim().toLowerCase() !==
            String(_sourceDescription || '').trim().toLowerCase()
          ) {
            ObjectHelper.setObjectDescriptionDirect(
              gameState,
              _validatedPartialDropDescriptionReceipt.successor_object_id,
              _partialDropDescription.description.trim()
            );
          }
        }
        delete _phaseBResult.partial_drop_successor_description;
      }
      if (_phaseBResult && _tlsPartialDescriptionTarget) {
        const _extractionEvents = Array.isArray(_phaseBResult.extraction_events)
          ? _phaseBResult.extraction_events : [];
        if (_extractionEvents.length === 1) {
          const _extractionEvent = _extractionEvents[0];
          const _childDescription = _extractionEvent?.description;
          if (
            _extractionEvent?.extracted_quantity === _tlsPartialDescriptionTarget.extracted_quantity &&
            _extractionEvent?.destination_hint === 'player_hands' &&
            _extractionEvent?.actor_ref === 'player' &&
            typeof _childDescription === 'string' &&
            _childDescription.length > 0 &&
            _childDescription !== _tlsPartialDescriptionTarget.parent_description
          ) {
            ObjectHelper.setObjectDescriptionDirect(
              gameState,
              _tlsPartialDescriptionTarget.successor_object_id,
              _childDescription
            );
          }
        }
      }
      // v1.84.38: mark Turn 1 degraded state when CB extraction fails — diagnostic/internal only
      if (!_continuityExtractionSuccess && turnNumber === 1 && gameState.player?.birth_record) {
        gameState.player.birth_record._extraction_failed = true;
        console.warn('[NARRATE] Turn 1 CB extraction failed — birth_record._extraction_failed set');
      }
      _dmNoteStatus = _phaseBResult ? 'updated' : 'new_game';
      _extractionPacket = _phaseBResult ? _phaseBResult.extracted : null;
      _dmNoteArchived = null; // dm_note retired in v1.70.0
      // v1.88.40: CB schema drift detection — forward (missing expected fields) and backward (legacy fields)
      _cbSchemaDrift = [];
      if (_phaseBResult) {
        for (const _driftField of ['object_candidates','visible_objects','environmental_features','entity_candidates']) {
          if (!(_driftField in _phaseBResult)) {
            _cbSchemaDrift.push(`missing_field:${_driftField}`);
            console.warn(`[CB-SCHEMA-DRIFT] missing_field:${_driftField} turn=${turnNumber}`);
          }
        }
        if (Array.isArray(_phaseBResult.entity_candidates)) {
          for (const _ec of _phaseBResult.entity_candidates) {
            if (!('held_objects' in _ec)) {
              _cbSchemaDrift.push('missing_field:held_objects');
              console.warn(`[CB-SCHEMA-DRIFT] missing_field:held_objects entity=${_ec.entity_id||'?'} turn=${turnNumber}`);
            }
            if (!('worn_objects' in _ec)) {
              _cbSchemaDrift.push('missing_field:worn_objects');
              console.warn(`[CB-SCHEMA-DRIFT] missing_field:worn_objects entity=${_ec.entity_id||'?'} turn=${turnNumber}`);
            }
            if ('held_or_worn_objects' in _ec) {
              _cbSchemaDrift.push('legacy_field:held_or_worn_objects');
              console.warn(`[CB-SCHEMA-DRIFT] legacy_field:held_or_worn_objects entity=${_ec.entity_id||'?'} turn=${turnNumber}`);
            }
          }
        }
      }
      if (_phaseBResult?.watch_message) {
        _watchMessageThisTurn = _phaseBResult.watch_message;
        diag.setLastWatchMessage(_watchMessageThisTurn);  // Cluster 5: write-only — reserved for future diagnostics surface
      }
      // v1.84.21: CB payload snapshot
      if (_phaseBResult) {
        _cbPayloadSnapshot = { prompt: _phaseBResult.prompt || null, response: _phaseBResult.raw || null };
      }
      // v1.88.0: BORN-NPC — Turn 1 founded NPC instantiation (post-Phase-B, after birth_record.starting_npc is written).
      // Fires only when the player declared a starting NPC in the founding input.
      // Idempotent: _born_npc_initialized flag prevents duplicate creation on re-entry.
      if (turnNumber === 1 && gameState.player?.birth_record?.starting_npc && !gameState._born_npc_initialized) {
        try {
          let _bnRaw = gameState.player.birth_record.starting_npc;
          if (Array.isArray(_bnRaw)) {
            console.warn('[BORN-NPC] starting_npc was array — using first element');
            _bnRaw = _bnRaw[0];
          }
          if (_bnRaw && typeof _bnRaw === 'object') {
            const _bnSn        = _bnRaw;
            const _bnSeed      = String(gameState.world?.phase3_seed || gameState.world?.seed || 0);
            const _bnId        = gameState._born_npc_preid || _bornNpcId(_bnSeed, _bnSn);
            delete gameState._born_npc_preid; // v1.88.31: clear pre-pass ID after use
            const _bnNpcName   = _bnSn.name || _bnSn.generated_name || null;
            const _bnIsLearned = !!(_bnSn.name);
            const _bnPos       = gameState.world?.position ? { ...gameState.world.position } : {};
            const _bnAls       = gameState.world?.active_local_space;
            const _bnNpc = {
              id:               _bnId,
              site_id:          gameState.world?.active_site?.site_id || null,
              npc_name:         _bnNpcName,
              role_or_relation: _bnSn.role_or_relation || null,
              description:      _bnSn.description      || null,
              reputation_player: 50,
              traits:           [],
              gender:           _bnSn.gender            || null,
              age:              (_bnSn.age != null && Number.isFinite(Number(_bnSn.age))) ? Number(_bnSn.age) : null,
              job_category:     _bnSn.job_category      || null,
              is_learned:       _bnIsLearned,
              learned_name:     _bnSn.name              || null,
              player_recognition: null,
              object_capture_turn: null,
              position:         _bnPos,
              attributes:       {},
              object_ids:       [],
              worn_object_ids:  [],
              associated_object_ids: [],  // v1.88.66: reverse index of objects associated with this NPC
              source:           'turn_1_declaration',
              _fill_frozen:     false
            };
            if (_bnAls && _bnAls.local_space_id) {
              _bnNpc.localspace_id = _bnAls.local_space_id;
            }
            // Create ORS ObjectRecords for declared carried items
            if (!gameState.objects || typeof gameState.objects !== 'object') gameState.objects = {};
            for (const _bnItem of (Array.isArray(_bnSn.inventory_items) ? _bnSn.inventory_items : [])) {
              const _bnItemName = (_bnItem && typeof _bnItem === 'object') ? String(_bnItem.name || '').trim() : String(_bnItem || '').trim();
              if (!_bnItemName) continue;
              let _bnItemDesc;
              if (_bnItem && typeof _bnItem === 'object') {
                if (_bnItem.description) {
                  _bnItemDesc = String(_bnItem.description).trim();
                } else {
                  console.warn(`[BORN-NPC] born_npc_item_description_missing: carried item "${_bnItemName}" has no description — falling back to name`);
                  _bnItemDesc = _bnItemName;
                }
              } else {
                _bnItemDesc = _bnItemName;
              }
              const _bnObjInput = [_bnItemName.toLowerCase(), 'npc', _bnId, 'born_npc_carried'].join('|');
              const _bnObjId    = 'obj_' + require('crypto').createHash('sha256').update(_bnObjInput, 'utf8').digest('hex').slice(0, 12);
              if (!gameState.objects[_bnObjId]) {
                gameState.objects[_bnObjId] = { id: _bnObjId, name: _bnItemName, description: _bnItemDesc, created_turn: 1, current_container_type: 'npc', current_container_id: _bnId, associated_actor_id: _bnId, source: 'birth_custom', status: 'active', conditions: [], events: [] };
              }
              if (!_bnNpc.object_ids.includes(_bnObjId)) _bnNpc.object_ids.push(_bnObjId);
            }
            // Create ORS ObjectRecords for declared worn items
            for (const _bnWorn of (Array.isArray(_bnSn.worn_items) ? _bnSn.worn_items : [])) {
              const _bnWornName = (_bnWorn && typeof _bnWorn === 'object') ? String(_bnWorn.name || '').trim() : String(_bnWorn || '').trim();
              if (!_bnWornName) continue;
              let _bnWornDesc;
              if (_bnWorn && typeof _bnWorn === 'object') {
                if (_bnWorn.description) {
                  _bnWornDesc = String(_bnWorn.description).trim();
                } else {
                  console.warn(`[BORN-NPC] born_npc_item_description_missing: worn item "${_bnWornName}" has no description — falling back to name`);
                  _bnWornDesc = _bnWornName;
                }
              } else {
                _bnWornDesc = _bnWornName;
              }
              const _bnWornInput = [_bnWornName.toLowerCase(), 'npc_worn', _bnId, 'born_npc_worn'].join('|');
              const _bnWornId    = 'obj_' + require('crypto').createHash('sha256').update(_bnWornInput, 'utf8').digest('hex').slice(0, 12);
              if (!gameState.objects[_bnWornId]) {
                gameState.objects[_bnWornId] = { id: _bnWornId, name: _bnWornName, description: _bnWornDesc, created_turn: 1, current_container_type: 'npc_worn', current_container_id: _bnId, associated_actor_id: _bnId, source: 'birth_custom', status: 'active', conditions: [], events: [] };
              }
              if (!_bnNpc.worn_object_ids.includes(_bnWornId)) _bnNpc.worn_object_ids.push(_bnWornId);
            }
            // Layer-aware push: L1/L2 → active_site.npcs, L0 → world.npcs
            if (gameState.world?.active_site && Array.isArray(gameState.world.active_site.npcs)) {
              gameState.world.active_site.npcs.push(_bnNpc);
            } else {
              if (!Array.isArray(gameState.world.npcs)) gameState.world.npcs = [];
              gameState.world.npcs.push(_bnNpc);
            }
            // v1.88.9 Patch 1C: Turn 1 Founding Registry — authority bridge from founding prose labels → engine ID.
            // Phase B extracted starting_npc before the engine ID existed; BORN-NPC now has an ID; registry
            // reconciles the same founding entity for remaining Turn 1 downstream systems (intro capture).
            if (!Array.isArray(gameState.world._turn1_founded_entities)) gameState.world._turn1_founded_entities = [];
            gameState.world._turn1_founded_entities.push({
              turn: 1,
              source: 'turn_1_founding',
              type: 'npc',
              entity_id: _bnNpc.id,
              npc_name: _bnNpc.npc_name,
              description: _bnNpc.description || null,
              labels: [
                _bnSn.name,
                _bnSn.generated_name,
                _bnSn.role_or_relation,
                _bnSn.job_category,
                _bnNpc.npc_name,
                (_bnSn.role_or_relation && _bnSn.name)      ? (_bnSn.role_or_relation + ' ' + _bnSn.name)      : null,
                (_bnSn.role_or_relation && _bnNpc.npc_name) ? (_bnSn.role_or_relation + ' ' + _bnNpc.npc_name) : null
              ].filter(Boolean)
               .map(l => l.toLowerCase().trim())
               .filter((l, i, a) => a.indexOf(l) === i)
            });
            // v1.88.10 Patch 1D: refresh world._visible_npcs after BORN-NPC push so the intro capture loop
            // (below) sees the NPC. The earlier _visibleNpcs pass (above) ran before BORN-NPC existed.
            if (_narDepth === 1) {
              const _bnL0pos = gameState.world?.position || {};
              gameState.world._visible_npcs = (gameState.world?.npcs || []).filter(npc =>
                npc.position?.mx === _bnL0pos.mx && npc.position?.my === _bnL0pos.my &&
                npc.position?.lx === _bnL0pos.lx && npc.position?.ly === _bnL0pos.ly
              );
            } else if (_narDepth === 2 && gameState.world?.active_site) {
              // v1.88.21 Patch 1M: place BORN-NPC on site grid tile so computeVisibleNpcs finds it at L1.
              // Mirrors WorldGen cell.npc_ids.push + npc.site_position (WorldGen.js ~L2334) and the
              // inject-npc harness tile-placement pattern (index.js ~L7919-7929). world.position only
              // holds L0 coords (mx,my,lx,ly); player.position adds site-local x,y on enterSite.
              const _bnSiteX = gameState.player?.position?.x;
              const _bnSiteY = gameState.player?.position?.y;
              if (typeof _bnSiteX === 'number' && typeof _bnSiteY === 'number') {
                const _bnSiteGrid = gameState.world.active_site.grid;
                if (Array.isArray(_bnSiteGrid)) {
                  const _bnTile = _bnSiteGrid[_bnSiteY]?.[_bnSiteX];
                  if (_bnTile) {
                    if (!Array.isArray(_bnTile.npc_ids)) _bnTile.npc_ids = [];
                    if (!_bnTile.npc_ids.includes(_bnNpc.id)) _bnTile.npc_ids.push(_bnNpc.id);
                  }
                  _bnNpc.site_position = { x: _bnSiteX, y: _bnSiteY };
                }
                gameState.world.active_site._visible_npcs = Actions.computeVisibleNpcs(
                  gameState.world.active_site, gameState.player.position
                );
              }
            } else if (_narDepth === 3 && gameState.world?.active_local_space) {
              // v1.88.24 Patch 1N: place BORN-NPC on local space grid tile so computeVisibleNpcs finds it at L2.
              // Mirrors Patch 1M (L1 site tile placement) one layer deeper. active_local_space.grid uses the
              // same npc_ids tile pattern; NPC registry is active_site.npcs (BORN-NPC lives there, not in
              // active_local_space.npcs). Canonical L2 computeVisibleNpcs call shape: index.js ~L2838.
              const _bnLsX = gameState.player?.position?.x;
              const _bnLsY = gameState.player?.position?.y;
              if (typeof _bnLsX === 'number' && typeof _bnLsY === 'number') {
                const _bnLsGrid = gameState.world.active_local_space.grid;
                if (Array.isArray(_bnLsGrid)) {
                  const _bnLsTile = _bnLsGrid[_bnLsY]?.[_bnLsX];
                  if (_bnLsTile) {
                    if (!Array.isArray(_bnLsTile.npc_ids)) _bnLsTile.npc_ids = [];
                    if (!_bnLsTile.npc_ids.includes(_bnNpc.id)) _bnLsTile.npc_ids.push(_bnNpc.id);
                  }
                  _bnNpc.local_space_position = { x: _bnLsX, y: _bnLsY };
                }
                gameState.world.active_local_space._visible_npcs = Actions.computeVisibleNpcs(
                  gameState.world.active_local_space, gameState.player.position, gameState.world.active_site?.npcs || []
                );
              }
            }
            // v1.88.14 Patch 1I: stamp object_capture_turn so intro capture skips this NPC on future turns.
            // birth_custom objects are already embodied — null capture_turn would leave the NPC permanently
            // eligible for intro capture even though it is already fully stamped.
            // Gate: gearless born NPCs (no objects) stay null so narration-based intro capture can still fire.
            if (_bnNpc.object_ids.length > 0 || _bnNpc.worn_object_ids.length > 0) {
              _bnNpc.object_capture_turn = turnNumber;
            }
            gameState._born_npc_initialized = true;
            console.log(`[BORN-NPC] Turn 1 NPC instantiated: id=${_bnId} npc_name="${_bnNpcName}" is_learned=${_bnIsLearned} carried=${_bnNpc.object_ids.length} worn=${_bnNpc.worn_object_ids.length}`);
          }
        } catch (_bnErr) {
          console.warn('[BORN-NPC] Turn 1 NPC init error (non-fatal):', _bnErr.message);
        }
      }
      // v1.88.18 Patch 1K-fix: Reclassify unresolved_entity_ref → founding_npc_pre_materialize for
      // founded NPCs. CB emits unresolved_entity_ref because it runs before BORN-NPC writes the
      // registry. Now that BORN-NPC has run (and _turn1_founded_entities is populated), retroactively
      // fix any warnings whose entity_ref matches a registry label.
      if (turnNumber === 1 && Array.isArray(gameState.world?._turn1_founded_entities) && gameState.world._turn1_founded_entities.length > 0) {
        const _reclass = _phaseBResult?.continuity_diagnostics?.warnings;
        if (Array.isArray(_reclass)) {
          for (let _ri = 0; _ri < _reclass.length; _ri++) {
            const _rw = _reclass[_ri];
            if (_rw.type === 'unresolved_entity_ref') {
              const _rLower = String(_rw.entity_ref || '').trim().toLowerCase();
              const _rHit = gameState.world._turn1_founded_entities.some(
                fe => Array.isArray(fe.labels) && fe.labels.includes(_rLower)
              );
              if (_rHit) {
                _reclass[_ri] = { type: 'founding_npc_pre_materialize', entity_ref: _rw.entity_ref, turn: _rw.turn };
                console.log(`[CB-INDEX] entity_ref "${_rw.entity_ref}" reclassified to founding_npc_pre_materialize — born NPC materialized, registry matched`);
              }
            }
          }
        }
      }
      // v1.84.52: Object Reality System — build local quarantine from CB output, then process
      // index.js owns the quarantine write; CB is a pure interpreter; quarantine is never on gameState
      // _objectRealityDebug is hoisted above try/catch so catch can include it in error responses
      // v1.91.44: preserve AP direct-mutation audit entries across the ORS pipeline rebuild.
      // AP writes entries (ap_partial_split_take, tls_whole_object_transfer, etc.) to the old
      // _objectRealityDebug before narration. The reassignment below would orphan them.
      // Explicit allowlist — not a broad prefix filter.
      const _preserveDirectAuditActions = new Set([
        'ap_direct_transfer',
        'tls_whole_object_transfer',
        'ap_partial_split_take',
        'tls_partial_stack_take'
      ]);
      const _priorDirectAudit = Array.isArray(gameState._objectRealityDebug?.audit)
        ? gameState._objectRealityDebug.audit.filter(e => _preserveDirectAuditActions.has(e?.action))
        : [];
      _objectRealityDebug = {
        ran: false,
        skip_reason: null,
        cb_candidates: [],
        cb_transfers: [],
        visible_objects_count: Array.isArray(_phaseBResult && _phaseBResult.visible_objects) ? _phaseBResult.visible_objects.length : 0,
        quarantine_size: 0,
        pre_rejected: 0,
        origin_blocked: 0,
        promoted: 0,
        transferred: 0,
        errors: 0,
        audit: [],
        error_entries: [],
        initial_condition_updates: [],
        condition_updates: [],
        retirement_updates: [],
        fission_retired: 0,
        fission_successors_injected: 0,
        npc_intro_materialized: 0,
        console_log: [],
        actor_resolution: []
      };
      if (_dropDryRunSealActive) {
        _objectRealityDebug.drop_dry_run_seal = {
          active: true,
          activation_basis: 'semantic_single_action_bridge_receipt',
          suppressed_counts: {
            cb_candidates: 0, cb_transfers: 0, cb_condition_updates: 0,
            cb_retirements: 0, tsl_fission: 0, tsl_extraction: 0
          },
          suppressed_refs: {}
        };
      }
      // v1.91.44: merge preserved AP direct-mutation audit entries into the new audit array
      if (_priorDirectAudit.length > 0) {
        _objectRealityDebug.audit.push(..._priorDirectAudit);
      }
      _activeTurnDebug = _objectRealityDebug;
      if (_phaseBResult) {
        // v1.85.28: NPC intro capture — materialize held/worn objects from entity_candidates as real ObjectRecords.
        // _promoteEntityAttributes runs synchronously inside CB before _phaseBResult is returned, so
        // entity_candidates.held_objects / worn_objects are already populated when this step runs.
        // held_objects → container_type:'npc', worn_objects → container_type:'npc_worn'.
        // object_capture_turn set ONLY when ≥1 object is materialized (zero-object intros remain eligible for future capture).
        if (!Array.isArray(_phaseBResult.object_candidates)) _phaseBResult.object_candidates = [];
        // v1.85.31: Fix A — replace OR chain with concat+dedup. At L2 depth _narActiveLS._visible_npcs is []
        // (local spaces have no grid[][], computeVisibleNpcs returns empty). [] is truthy in JS so the old OR
        // chain short-circuited before consulting _narActiveSite._visible_npcs — site-level NPCs were invisible
        // to the intro capture loop. Concat+dedup merges both pools correctly.
        const _visibleNpcsForCapture = [
          ...(_narActiveLS?._visible_npcs || []),
          ...(_narActiveSite?._visible_npcs || []),
          ...(gameState.world?._visible_npcs || [])  // v1.88.8: L0 fallback — include founded NPCs at overworld depth
        ].filter((n, i, a) => a.findIndex(x => x.id === n.id) === i);
        let _npcIntroCaptureCount = 0;
        const _t1Registry = gameState.world?._turn1_founded_entities || [];  // v1.88.9: Turn 1 Founding Registry
        if (!_dropDryRunSealActive && Array.isArray(_phaseBResult.entity_candidates)) {
          for (const _intrNpc of _visibleNpcsForCapture) {
            if (_intrNpc.object_capture_turn !== null && _intrNpc.object_capture_turn !== undefined) continue;
            let _intrCand = _phaseBResult.entity_candidates.find(ec => {
              if (ec.entity_ref === _intrNpc.id) return true;
              // v1.88.9 Patch 1C: Turn 1 only — resolve prose founding labels via registry
              if (turnNumber === 1 && _t1Registry.length) {
                const _ref = String(ec?.entity_ref || '').toLowerCase().trim();
                if (!_ref || _ref === 'player') return false;
                const _fe = _t1Registry.find(fe => fe.entity_id === _intrNpc.id);
                if (_fe && _fe.labels.includes(_ref)) return true;
              }
              return false;
            });
            // v1.88.89 Tier 4: job_category prose label resolution.
            // CB sometimes emits entity_ref as a prose job_category label (e.g. "gate warden") instead of
            // the engine NPC ID. Only fires when Tiers 1–3 all missed. Uniqueness guard: if two or more
            // visible NPCs share the same job_category, skip both rather than guess (ambiguous).
            // Applies on any turn (not Turn-1-gated).
            if (!_intrCand) {
              const _t4JobCat = _intrNpc.job_category?.toLowerCase?.()?.trim() || null;
              if (_t4JobCat) {
                const _t4ShareCount = _visibleNpcsForCapture.filter(n => n.job_category?.toLowerCase?.()?.trim() === _t4JobCat).length;
                if (_t4ShareCount === 1) {
                  const _t4Cand = _phaseBResult.entity_candidates.find(ec => String(ec.entity_ref || '').toLowerCase().trim() === _t4JobCat);
                  if (_t4Cand) _intrCand = _t4Cand;
                }
              }
            }
            if (!_intrCand) continue;
            let _capturedForNpc = 0;
            for (const _hItem of (_intrCand.held_objects || [])) {
              if (!_hItem || typeof _hItem !== 'string' || !_hItem.trim()) continue;
              // v1.85.31: Fix B — exact-match duplicate guard. If an active ObjectRecord already exists
              // for this item (container_type:npc, same container_id, exact normalized name, status:active),
              // skip the push but still count it so object_capture_turn gets finalized. No fuzzy/token matching.
              const _hNameNorm = _hItem.trim().toLowerCase();
              // v1.85.32: Fix 3 — absence filter. Does NOT count toward _capturedForNpc (absence ≠ object).
              if (_isAbsencePhrase(_hNameNorm)) {
                _turnLog(_objectRealityDebug, 'log', 'NPC-INTRO-CAPTURE', `skipped absence-phrase held: "${_hItem.trim()}" (T-${turnNumber})`, {item: _hItem.trim(), status: 'absence_phrase', container: 'held', turn: turnNumber});
                continue;
              }
              const _hAlreadyExists = Object.values(gameState.objects || {}).some(r =>
                r.status === 'active' &&
                r.current_container_type === 'npc' &&
                r.current_container_id === _intrNpc.id &&
                String(r.name).toLowerCase().trim() === _hNameNorm
              );
              if (_hAlreadyExists) {
                _turnLog(_objectRealityDebug, 'log', 'NPC-INTRO-CAPTURE', `"${_hItem.trim()}" already materialized → skipping push, counting (T-${turnNumber})`, {item: _hItem.trim(), status: 'already_materialized', container: 'held', turn: turnNumber});
                _capturedForNpc++;
                continue;
              }
              _phaseBResult.object_candidates.push({
                temp_ref: `npc_intro_${_intrNpc.id}_h${_capturedForNpc}`,
                name: _hNameNorm,
                description: '',
                container_type: 'npc',
                container_id: _intrNpc.id,
                transfer_origin: 'npc_introduction',
                _source_npc_id: _intrNpc.id,
                _source_phrase: _hItem.trim(),
                _created_turn: turnNumber
              });
              _turnLog(_objectRealityDebug, 'log', 'NPC-INTRO-CAPTURE', `"${_hItem.trim()}" → npc/${_intrNpc.id} (T-${turnNumber})`, {item: _hItem.trim(), npc_id: _intrNpc.id, status: 'materialized', container: 'held', turn: turnNumber});
              _capturedForNpc++;
              _npcIntroCaptureCount++;
            }
            for (const _wItem of (_intrCand.worn_objects || [])) {
              if (!_wItem || typeof _wItem !== 'string' || !_wItem.trim()) continue;
              // v1.85.31: Fix B — same exact-match guard for worn items (container_type:npc_worn).
              const _wNameNorm = _wItem.trim().toLowerCase();
              // v1.85.32: Fix 4 — absence filter for worn items. Does NOT count toward _capturedForNpc.
              if (_isAbsencePhrase(_wNameNorm)) {
                _turnLog(_objectRealityDebug, 'log', 'NPC-INTRO-CAPTURE', `skipped absence-phrase worn: "${_wItem.trim()}" (T-${turnNumber})`, {item: _wItem.trim(), status: 'absence_phrase', container: 'worn', turn: turnNumber});
                continue;
              }
              const _wAlreadyExists = Object.values(gameState.objects || {}).some(r =>
                r.status === 'active' &&
                r.current_container_type === 'npc_worn' &&
                r.current_container_id === _intrNpc.id &&
                String(r.name).toLowerCase().trim() === _wNameNorm
              );
              if (_wAlreadyExists) {
                _turnLog(_objectRealityDebug, 'log', 'NPC-INTRO-CAPTURE', `"${_wItem.trim()}" already materialized (worn) → skipping push, counting (T-${turnNumber})`, {item: _wItem.trim(), status: 'already_materialized', container: 'worn', turn: turnNumber});
                _capturedForNpc++;
                continue;
              }
              _phaseBResult.object_candidates.push({
                temp_ref: `npc_intro_${_intrNpc.id}_w${_capturedForNpc}`,
                name: _wNameNorm,
                description: '',
                container_type: 'npc_worn',
                container_id: _intrNpc.id,
                transfer_origin: 'npc_introduction',
                _source_npc_id: _intrNpc.id,
                _source_phrase: _wItem.trim(),
                _created_turn: turnNumber
              });
              _turnLog(_objectRealityDebug, 'log', 'NPC-INTRO-CAPTURE', `"${_wItem.trim()}" → npc_worn/${_intrNpc.id} (T-${turnNumber})`, {item: _wItem.trim(), npc_id: _intrNpc.id, status: 'materialized', container: 'worn', turn: turnNumber});
              _capturedForNpc++;
              _npcIntroCaptureCount++;
            }
            if (_capturedForNpc > 0) _intrNpc.object_capture_turn = turnNumber;
          }
        }
        _objectRealityDebug.npc_intro_materialized = _npcIntroCaptureCount;

        // v6.0.18: soliloquy gate — drop player-targeted object candidates on soliloquy turns
        if (!_dropDryRunSealActive && _soliloquyFired && Array.isArray(_phaseBResult.object_candidates)) {
          _phaseBResult.object_candidates = _phaseBResult.object_candidates.filter(c => {
            if (c.container_type === 'player') {
              _turnLog(_objectRealityDebug, 'warn', 'SOLILOQUY-GATE', `player-targeted object_candidate blocked on soliloquy turn: "${c.name}"`, {name: c.name});
              return false;
            }
            return true;
          });
          if (Array.isArray(_phaseBResult.object_transfers)) {
            _phaseBResult.object_transfers = _phaseBResult.object_transfers.filter(t => {
              if (t.to_container_type === 'player') {
                _turnLog(_objectRealityDebug, 'warn', 'SOLILOQUY-GATE', `player-targeted object_transfer blocked on soliloquy turn: "${t.object_name || t.object_id}"`, {name: t.object_name || t.object_id});
                return false;
              }
              return true;
            });
          }
        }

        // v1.88.78: TSL Stage 1 — observe-only semantic normalization (Point B)
        // Reads CB output + existing pipeline signals. Does NOT mutate _phaseBResult, gameState, or ORS state.
        // v1.88.87: hoisted to function scope so line 4585 (ObjectHelper.run) can read _tslR?.tsl outside the block.
        let _tslR = null;
        {
          _tslR = SemanticNormalizer.analyze(_phaseBResult, _rawInput, _parsedAction, _authorityGateResult, gameState);
          _objectRealityDebug.tsl    = _tslR.tsl;
          _objectRealityDebug.tsl_ms = _tslR.processing_time_ms;
        }
        if (_dropDryRunSealActive) {
          const _sealDiag = _objectRealityDebug.drop_dry_run_seal;
          const _rawCandidates = Array.isArray(_phaseBResult.object_candidates) ? _phaseBResult.object_candidates : [];
          const _rawTransfers = Array.isArray(_phaseBResult.object_transfers) ? _phaseBResult.object_transfers : [];
          const _rawConditions = Array.isArray(_phaseBResult.object_condition_updates) ? _phaseBResult.object_condition_updates : [];
          const _rawRetirements = Array.isArray(_phaseBResult.object_retirements) ? _phaseBResult.object_retirements : [];
          const _rawTslFission = Array.isArray(_tslR?.tsl?.fission_operations) ? _tslR.tsl.fission_operations : [];
          const _rawTslExtraction = Array.isArray(_tslR?.tsl?.extraction_operations) ? _tslR.tsl.extraction_operations : [];
          Object.assign(_sealDiag.suppressed_counts, {
            cb_candidates: _rawCandidates.length, cb_transfers: _rawTransfers.length,
            cb_condition_updates: _rawConditions.length, cb_retirements: _rawRetirements.length,
            tsl_fission: _rawTslFission.length, tsl_extraction: _rawTslExtraction.length
          });
          _sealDiag.suppressed_refs = {
            cb_candidates: _rawCandidates.map(c => c?.temp_ref || c?.object_id || null).filter(Boolean),
            cb_transfers: _rawTransfers.map(t => t?.object_id || t?.temp_ref || null).filter(Boolean),
            cb_condition_updates: _rawConditions.map(c => c?.object_id || c?.name_match || null).filter(Boolean),
            cb_retirements: _rawRetirements.map(r => r?.object_id || null).filter(Boolean),
            tsl_fission: _rawTslFission.map(op => op?.source_object_id || null).filter(Boolean),
            tsl_extraction: _rawTslExtraction.map(op => op?.source_object_id || null).filter(Boolean)
          };
          _sealDiag.raw_evidence_preserved = true;
        }

        // v1.84.78: origin gate — drop player_claimed new player-held objects before quarantine assembly
        // v1.85.7: Turn 1 founding premise items are exempt — they are legitimate starting inventory
        if (!_dropDryRunSealActive && Array.isArray(_phaseBResult.object_candidates)) {
          _phaseBResult.object_candidates = _phaseBResult.object_candidates.filter(c => {
            if (c.transfer_origin === 'npc_introduction') return true; // v1.85.28: NPC intro capture — always pass through
            if (c.container_type === 'player' && c.transfer_origin === 'player_claimed' && turnNumber !== 1) {
              _turnLog(_objectRealityDebug, 'warn', 'ORIGIN-GATE', `player_claimed item blocked: "${c.name}"`, {name: c.name, transfer_origin: c.transfer_origin});
              if (!Array.isArray(gameState.object_errors)) gameState.object_errors = [];
              gameState.object_errors.push({ stage: 'cb_origin_gate', reason: 'player_claimed_item_blocked', name: c.name, turn: turnNumber });
              if (gameState.object_errors.length > 100) gameState.object_errors.shift();
              return false;
            }
            // v1.84.88: narrator_independent items must land on grid/localspace — never directly in player inventory
            // v1.88.25: Turn 1 founding-premise exemption — mirrors player_claimed Turn 1 exemption (line above).
            // On Turn 1 the founding premise IS constitutional reality; narrator-described player interaction
            // objects (e.g. "we are drinking tea") are not conjuration attempts — they are initial world state.
            if (c.container_type === 'player' && c.transfer_origin === 'narrator_independent' && turnNumber !== 1) {
              _turnLog(_objectRealityDebug, 'warn', 'ORIGIN-GATE', `narrator_independent player item blocked: "${c.name}"`, {name: c.name, transfer_origin: c.transfer_origin});
              if (!Array.isArray(gameState.object_errors)) gameState.object_errors = [];
              gameState.object_errors.push({ stage: 'cb_origin_gate', reason: 'narrator_independent_player_blocked', name: c.name, turn: (gameState.turn_history?.length || 0) + 1 });
              if (gameState.object_errors.length > 100) gameState.object_errors.shift();
              // v1.85.90: Write rejected-candidate cache entry so ObjectHelper dedup guard can reconcile
              // if the same object is later grounded as a floor/localspace entity. This does NOT create
              // an ObjectRecord — it is negative evidence only. Anti-conjuration contract unchanged.
              const _rcTurn = (gameState.turn_history?.length || 0) + 1;
              const _rcNameLower = String(c.name).toLowerCase().trim();
              const _rcNormalized = _rcNameLower
                .replace(/^(stack|pile|bunch|set|piece|bit|pair|row|collection) of /i, '')
                .replace(/^(small|large|tiny|big|old|worn|broken|battered|cracked|rusty|dusty|faded|crumpled|folded|half-empty|empty|full|open|closed|thick|thin|heavy|light|dark|dim|bright|clean|dirty|wet|dry|loose|tight|short|tall|long|narrow|wide) /i, '')
                .trim();
              if (!Array.isArray(gameState._rejectedCandidates)) gameState._rejectedCandidates = [];
              gameState._rejectedCandidates.push({
                name:             _rcNameLower,
                normalized:       _rcNormalized,
                turn:             _rcTurn,
                reason:           'narrator_independent_player_blocked',
                location_context: gameState.world?.active_local_space?.local_space_id || null
              });
              // Expire entries older than 5 turns to keep the cache bounded
              gameState._rejectedCandidates = gameState._rejectedCandidates.filter(r => _rcTurn - r.turn <= 5);
              return false;
            }
            // v1.84.90: environment_interaction + player is only valid when the action's semantic class
            // is acquisition. All acquisition verbs (grab, pick up, collect, etc.) normalize to
            // _parsedAction === 'take' in the engine. Discovery, examination, listening, movement,
            // and freeform actions may reveal objects in the environment — they may NOT place objects
            // directly in player inventory.
            // v1.88.72: Turn 1 founding-premise exemption — mirrors player_claimed and narrator_independent
            // exemptions above. On Turn 1 _parsedAction is always '' (founding premise never parses as
            // 'take'), so without this guard every player-acquired object in a founding turn is blocked.
            // v1.88.75: 'unknown' exemption — parser returns 'unknown' on complex compound inputs (not a
            // confident non-acquisition classification). Blocking on 'unknown' prevents valid acquisitions
            // that CB correctly flagged in compound turns. Only block on known non-acquisition actions.
            if (c.container_type === 'player' && c.transfer_origin === 'environment_interaction' && _parsedAction !== 'take' && _parsedAction !== 'unknown' && turnNumber !== 1) {
              _turnLog(_objectRealityDebug, 'warn', 'ORIGIN-GATE', `environment_interaction non-acquisition player item blocked: "${c.name}" (action: ${_parsedAction})`, {name: c.name, transfer_origin: c.transfer_origin, action: _parsedAction});
              if (!Array.isArray(gameState.object_errors)) gameState.object_errors = [];
              gameState.object_errors.push({ stage: 'cb_origin_gate', reason: 'environment_interaction_non_acquisition_player_blocked', name: c.name, turn: (gameState.turn_history?.length || 0) + 1 });
              if (gameState.object_errors.length > 100) gameState.object_errors.shift();
              return false;
            }
            return true;
          });
          _objectRealityDebug.origin_blocked = (gameState.object_errors || []).filter(e => e.stage === 'cb_origin_gate').length;
        }
        // v1.84.80: env gather failure gate — when an environment gather attempt was made this turn
        // but the narrator described failure (item not acquired), block any grid-level promote candidate
        // for that item. Invariant: successful grab → CB emits container_type:'player' (not caught here);
        // failed grab → CB emits container_type:'grid' → name matches label → blocked.
        // Deterministic: matches _envGatherLabel derived from AP's _environmentGatherIntent, not prose inspection.
        if (!_dropDryRunSealActive && _envGatherLabel && Array.isArray(_phaseBResult.object_candidates)) {
          _phaseBResult.object_candidates = _phaseBResult.object_candidates.filter(c => {
            if (c.container_type === 'grid' && c.transfer_origin === 'environment_interaction' && String(c.name || '').toLowerCase() === _envGatherLabel) {
              _turnLog(_objectRealityDebug, 'warn', 'ORIGIN-GATE', `env_gather_not_acquired blocked: "${c.name}"`, {name: c.name, transfer_origin: c.transfer_origin});
              if (!Array.isArray(gameState.object_errors)) gameState.object_errors = [];
              gameState.object_errors.push({ stage: 'cb_origin_gate', reason: 'env_gather_not_acquired', name: c.name, turn: (gameState.turn_history?.length || 0) + 1 });
              if (gameState.object_errors.length > 100) gameState.object_errors.shift();
              return false;
            }
            return true;
          });
        }
        // v1.85.24: worn-remove gate — defense-in-depth against CB emitting a fresh promote
        // for a just-removed worn item with a shortened/variant name (name-mismatch failure mode).
        // _apDoneIds (below) suppresses CB transfers by exact ID; this gate suppresses CB promotes
        // by token-matching candidate name against AP-stamped removed item names.
        // Gate is INERT unless: _parsedAction === 'remove' AND AP stamped _apRemovedWornNames.
        // Only blocks candidates targeting world containers (grid/localspace/site).
        const _apRemovedWornNames = Array.isArray(gameState._apRemovedWornNames) ? gameState._apRemovedWornNames : [];
        gameState._apRemovedWornNames = []; // consume and clear for next turn
        if (!_dropDryRunSealActive && (_parsedAction === 'remove' || _emoteRemoveExecuted) && _apRemovedWornNames.length > 0 && Array.isArray(_phaseBResult.object_candidates)) {
          const _wornRemoveTokenize = str => String(str || '').toLowerCase().split(/[\s\-_\/]+/).map(t => t.replace(/[^a-z0-9]/g, '')).filter(t => t.length > 0);
          // Pre-build token sets for each removed worn item name
          const _removedTokenSets = _apRemovedWornNames.map(n => ({ name: n, tokens: new Set(_wornRemoveTokenize(n)) }));
          _phaseBResult.object_candidates = _phaseBResult.object_candidates.filter(c => {
            const _wct = c.container_type;
            if (_wct !== 'grid' && _wct !== 'localspace' && _wct !== 'site') return true; // only world containers
            const _cToks = _wornRemoveTokenize(c.name);
            if (_cToks.length === 0) return true;
            for (const { name: _rName, tokens: _rSet } of _removedTokenSets) {
              if (_cToks.every(tok => _rSet.has(tok))) {
                console.warn(`[WORN-REMOVE-GATE] blocked promote candidate: "${c.name}" matched removed worn item "${_rName}" (container_type: ${_wct})`);
                if (!Array.isArray(gameState.object_errors)) gameState.object_errors = [];
                gameState.object_errors.push({ stage: 'worn_remove_gate', reason: 'promote_blocked_name_match', name: c.name, matched: _rName, turn: (gameState.turn_history?.length || 0) + 1 });
                if (gameState.object_errors.length > 100) gameState.object_errors.shift();
                return false;
              }
            }
            return true;
          });
        }
        // v1.91.04: extraction gate — suppress CB object_candidates covered by a successfully resolved
        // TLS extraction_operation. TLS owns the successor via partial_split; CB's parallel candidate
        // is redundant and produces a duplicate object without parent lineage.
        // v1.91.05: added second match path — unit+container scope. CB may emit individual unit objects
        // (e.g. "arrow" ×3) while TLS emits an aggregate successor ("three arrows", unit:"arrow").
        // Unit match: c.name === product.unit AND c.container_type/id === product destination.
        // Container scope prevents false positives (e.g. floor arrow ≠ player container).
        // FALLBACK: ops with unresolved:true excluded from both match structures — CB candidate
        // survives as resilience fallback when TLS normalization fails for that product.
        if (!_dropDryRunSealActive && Array.isArray(_tslR?.tsl?.extraction_operations) && _tslR.tsl.extraction_operations.length > 0 && Array.isArray(_phaseBResult.object_candidates)) {
          const _resolvedExtractionOps = _tslR.tsl.extraction_operations
            .filter(op => !op.unresolved && !op.quantity_unresolved);
          // Match 1: aggregate product name (exact normalized)
          const _extractionProductNames = new Set(
            _resolvedExtractionOps
              .map(op => (op.product?.name || '').toLowerCase().trim())
              .filter(Boolean)
          );
          // Match 2: unit name scoped to same destination container
          const _extractionUnitEntries = _resolvedExtractionOps
            .filter(op => op.product?.unit)
            .map(op => ({
              unitNorm:      (op.product.unit || '').toLowerCase().trim(),
              containerType: op.product.container_type || null,
              containerId:   op.product.container_id   || null
            }))
            .filter(e => e.unitNorm);
          if (_extractionProductNames.size > 0 || _extractionUnitEntries.length > 0) {
            let _cbExtSuppressed = 0;
            _phaseBResult.object_candidates = _phaseBResult.object_candidates.filter(c => {
              const _cNameNorm = (c.name || '').toLowerCase().trim();
              if (_extractionProductNames.has(_cNameNorm)) {
                _turnLog(_objectRealityDebug, 'info', 'EXTRACTION-GATE', `CB candidate suppressed — name match: "${c.name}"`, {name: c.name, match: 'name'});
                _cbExtSuppressed++;
                return false;
              }
              for (const _e of _extractionUnitEntries) {
                if (_cNameNorm === _e.unitNorm && c.container_type === _e.containerType && c.container_id === _e.containerId) {
                  _turnLog(_objectRealityDebug, 'info', 'EXTRACTION-GATE', `CB candidate suppressed — unit+container match: "${c.name}"`, {name: c.name, match: 'unit', containerType: c.container_type});
                  _cbExtSuppressed++;
                  return false;
                }
              }
              return true;
            });
            if (_cbExtSuppressed > 0) _objectRealityDebug.cb_extraction_suppressed = _cbExtSuppressed;
          }
        }
        // v1.91.70: P5-A1 CB candidate promotion guard — suppress environment→player
        // candidates after AP already refused a partial-stack TAKE this turn.
        // Operates on structural signals only — no name matching.
        // Temporary — will be narrowed in P5-A2 when the live execution lane goes live.
        let _cbCandidateTakeSuppressed = 0;
        if (!_dropDryRunSealActive) _phaseBResult.object_candidates = _phaseBResult.object_candidates.filter(c => {
          if (
            c.container_type === 'player' &&
            c.transfer_origin === 'environment_interaction' &&
            _parsedAction === 'take' &&
            _envGatherLabel === null &&
            gameState._apActuals?.routing === 'quarantined' &&
            gameState._apActuals?.outcome === 'refused_ownership'
          ) {
            if (!Array.isArray(_objectRealityDebug.suppressed_replays)) _objectRealityDebug.suppressed_replays = [];
            _objectRealityDebug.suppressed_replays.push({
              reason: 'cb_candidate_take_suppressed',
              candidate_name: c.name || null,
              temp_ref: c.temp_ref || null,
              container_type: c.container_type,
              transfer_origin: c.transfer_origin,
              parsed_action: _parsedAction,
              env_gather_label: _envGatherLabel,
              ap_routing: gameState._apActuals?.routing || null,
              ap_outcome: gameState._apActuals?.outcome || null,
              ap_source_object_id: gameState._apActuals?.source_object_id || null
            });
            _cbCandidateTakeSuppressed++;
            return false;
          }
          return true;
        });
        if (_cbCandidateTakeSuppressed > 0) _objectRealityDebug.cb_candidate_take_suppressed = _cbCandidateTakeSuppressed;
        const _cbCandidates = Array.isArray(_phaseBResult.object_candidates) ? _phaseBResult.object_candidates : [];
        const _cbTransfers  = Array.isArray(_phaseBResult.object_transfers)  ? _phaseBResult.object_transfers  : [];
        _objectRealityDebug.cb_candidates = _cbCandidates;
        _objectRealityDebug.cb_transfers  = _cbTransfers;
        const _cbMutationCandidates = _dropDryRunSealActive ? [] : _cbCandidates;
        const _cbMutationTransfers = _dropDryRunSealActive ? [] : _cbTransfers;
        // v1.84.57: suppress CB transfers for objects AP already transferred this turn.
        // AP writes object IDs to gameState._apExecutedTransfers[] on success only — fail = no proof = CB fallback stays.
        // Temp-ref-only entries (no object_id) pass through unfiltered; destination idempotency in ObjectHelper catches any duplicates.
        // v1.91.62: extended filter to also suppress temp-ref-only transfers whose candidate name matches
        // an AP-done object name — same-turn replay containment for partial-stack TAKE remainder.
        const _apDoneIds = new Set(Array.isArray(gameState._apExecutedTransfers) ? gameState._apExecutedTransfers : []);
        gameState._apExecutedTransfers = []; // consume and clear for next turn
        // Build AP-done normalized-name set for temp-ref replay suppression
        const _apDoneNames = new Set();
        const _norm = v => String(v || '').toLowerCase().trim();
        for (const _aid of _apDoneIds) {
          const _aObj = gameState.objects[_aid];
          if (_aObj) _apDoneNames.add(_norm(_aObj.name));
        }
        // Build CB candidate temp_ref → normalized name map
        const _cbTempRefToName = {};
        for (const _cc of _cbMutationCandidates) {
          if (_cc.temp_ref) _cbTempRefToName[_cc.temp_ref] = _norm(_cc.name);
        }
        let _cbTakeSuppressed = 0;
        const _cbTransfersFiltered = _cbMutationTransfers.filter(t => {
          // Phase 1: existing explicit-ID dedup — preserve unchanged
          if (t.object_id && _apDoneIds.has(t.object_id)) return false;
          // Phase 2: temp-ref replay suppression — same-turn containment guard
          if (!t.object_id && t.temp_ref && _apDoneIds.size > 0) {
            const _candName = _cbTempRefToName[t.temp_ref];
            if (_candName && _apDoneNames.has(_candName)) {
              if (!Array.isArray(_objectRealityDebug.suppressed_replays)) _objectRealityDebug.suppressed_replays = [];
              _objectRealityDebug.suppressed_replays.push({
                reason: 'ap_replay_temp_ref_suppressed',
                temp_ref: t.temp_ref,
                candidate_name: _candName,
                matched_ap_id: [..._apDoneIds].find(id => {
                  const _obj = gameState.objects[id];
                  return _obj && _norm(_obj.name) === _candName;
                }) || null,
                transfer_direction: t.to_container_type || null
              });
              return false; // suppress — AP already handled this named object this turn
            }
          }
          // Phase 3: P5-A1 CB TAKE transfer guard — suppress environment→player transfers
          // during TAKE turns when environmental gathering is not active.
          // This prevents CB from originating object movement after AP already refused
          // ownership (partial-stack) or after TLS already executed (whole-object).
          // Temporary — will be narrowed in P5-A2 when the new execution lane goes live.
          if (
            t.to_container_type === 'player' &&
            (t.from_container_type === 'grid' || t.from_container_type === 'localspace' || t.from_container_type === 'site') &&
            _parsedAction === 'take' &&
            _envGatherLabel === null
          ) {
            if (!Array.isArray(_objectRealityDebug.suppressed_replays)) _objectRealityDebug.suppressed_replays = [];
            _objectRealityDebug.suppressed_replays.push({
              reason: 'cb_take_transfer_suppressed',
              temp_ref: t.temp_ref || null,
              object_id: t.object_id || null,
              from_container_type: t.from_container_type,
              from_container_id: t.from_container_id,
              to_container_type: t.to_container_type,
              to_container_id: t.to_container_id,
              parsed_action: _parsedAction,
              env_gather_active: _envGatherLabel !== null
            });
            _cbTakeSuppressed++;
            return false;
          }
          return true;
        });
        if (_cbTakeSuppressed > 0) _objectRealityDebug.cb_take_transfers_suppressed = _cbTakeSuppressed;
        // v1.85.9: detect ap_dedup_all_transfers — CB produced transfers but all were AP-claimed.
        // Distinct from empty_quarantine (CB produced nothing) — improves diagnostic clarity.
        if (_cbCandidates.length === 0 && _cbTransfers.length > 0 && _cbTransfersFiltered.length === 0) {
          _objectRealityDebug.skip_reason = 'ap_dedup_all_transfers';
        }
        const _quarantine = [];
        for (const c of _cbMutationCandidates) _quarantine.push({ action: 'promote',  ...c, detected_turn: turnNumber });
        for (const t of _cbTransfersFiltered) _quarantine.push({ action: 'transfer', ...t, detected_turn: turnNumber });
        // v1.84.65: pre-flight normalization gate — reject grid promote entries with invalid container_id
        // v1.84.93: grid promotes at L1/L2 are REWRITTEN to the correct container (not rejected)
        //   L1 (active_site, no active_local_space): grid → site, container_id = ${siteId}:${x},${y}
        //   L2 (active_local_space set): grid → localspace, container_id = active_local_space.local_space_id
        if (!Array.isArray(gameState.object_errors)) gameState.object_errors = [];
        let _preRejected = 0;
        let _preRewritten = 0;
        for (let _i = _quarantine.length - 1; _i >= 0; _i--) {
          const _qe = _quarantine[_i];
          if (_qe.action !== 'promote' || _qe.container_type !== 'grid') continue;
          const _cid = String(_qe.container_id || '');
          // v1.84.93: depth-based reroute — check BEFORE format validation
          const _rwActiveLs = gameState.world?.active_local_space;
          const _rwActiveSite = gameState.world?.active_site;
          if (_rwActiveLs) {
            // L2: grid → localspace
            const _rwLsId = _rwActiveLs.local_space_id;
            if (_rwLsId) {
              console.log(`[NARRATE] pre-flight: grid promote rewritten L2 -> localspace:${_rwLsId} (was: ${_cid}) for "${_qe.name}"`);
              _qe.container_type = 'localspace';
              _qe.container_id = _rwLsId;
              _preRewritten++;
              continue;
            }
          } else if (_rwActiveSite) {
            // L1: grid → site
            const _rwSiteId = _rwActiveSite.id || _rwActiveSite.site_id;
            const _rwPx = gameState.player?.position?.x;
            const _rwPy = gameState.player?.position?.y;
            if (_rwSiteId != null && _rwPx != null && _rwPy != null) {
              const _rwSiteKey = `${_rwSiteId}:${_rwPx},${_rwPy}`;
              console.log(`[NARRATE] pre-flight: grid promote rewritten L1 -> site:${_rwSiteKey} (was: ${_cid}) for "${_qe.name}"`);
              _qe.container_type = 'site';
              _qe.container_id = _rwSiteKey;
              _preRewritten++;
              continue;
            }
          }
          // L0 (or reroute data unavailable): validate format and reject if invalid
          const _isCellPfx = _cid.startsWith('cell:');
          const _isInvalid = _isCellPfx || !/^LOC:\d+,\d+:\d+,\d+$/.test(_cid);
          if (!_isInvalid) continue;
          const _pfxReason = _isCellPfx ? '"cell:" prefix — CB format drift' : 'not a valid LOC key';
          console.warn(`[NARRATE] pre-flight: grid container_id rejected (${_pfxReason}): ${_cid}`);
          gameState.object_errors.push({ stage: 'quarantine_validation', reason: 'missing_authoritative_container', container_type: _qe.container_type, container_id: _cid, object_name: _qe.name, turn: turnNumber });
          if (gameState.object_errors.length > 100) gameState.object_errors.shift();
          _quarantine.splice(_i, 1);
          _preRejected++;
        }
        // v1.84.85: pre-flight gate for localspace promotes — container_id must match active localspace exactly
        for (let _i = _quarantine.length - 1; _i >= 0; _i--) {
          const _qe = _quarantine[_i];
          if (_qe.action !== 'promote' || _qe.container_type !== 'localspace') continue;
          const _activeLs = gameState.world?.active_local_space;
          const _cid = String(_qe.container_id || '');
          const _lsInvalid = !_activeLs || _activeLs.local_space_id !== _cid;
          if (!_lsInvalid) continue;
          const _lsReason = !_activeLs ? 'no active localspace' : `container_id mismatch (expected ${_activeLs.local_space_id})`;
          console.warn(`[NARRATE] pre-flight: localspace container_id rejected (${_lsReason}): ${_cid}`);
          gameState.object_errors.push({ stage: 'quarantine_validation', reason: 'missing_authoritative_container', container_type: _qe.container_type, container_id: _cid, object_name: _qe.name, turn: turnNumber });
          if (gameState.object_errors.length > 100) gameState.object_errors.shift();
          _quarantine.splice(_i, 1);
          _preRejected++;
        }
        // v1.84.92: pre-flight gate for site promotes — container_id must match active site + current player x,y
        // v1.84.94: rewrite-on-mismatch (same principle as v1.84.93 grid gate) — CB may emit wrong container_id format
        for (let _i = _quarantine.length - 1; _i >= 0; _i--) {
          const _qe = _quarantine[_i];
          if (_qe.action !== 'promote' || _qe.container_type !== 'site') continue;
          const _activeSite94 = gameState.world?.active_site;
          const _cid94 = String(_qe.container_id || '');
          const _siteId94 = _activeSite94 ? (_activeSite94.site_id || _activeSite94.id?.replace(/\/l2$/, '')) : null;
          const _px94 = gameState.player?.position?.x;
          const _py94 = gameState.player?.position?.y;
          const _expectedSiteKey94 = (_siteId94 != null && _px94 != null && _py94 != null) ? `${_siteId94}:${_px94},${_py94}` : null;
          if (!_activeSite94 || !_expectedSiteKey94) {
            // Hard reject only when rewrite data is unavailable
            const _siteReason94 = !_activeSite94 ? 'no active site' : 'player position unavailable';
            console.warn(`[NARRATE] pre-flight: site promote rejected (${_siteReason94}): ${_cid94}`);
            gameState.object_errors.push({ stage: 'quarantine_validation', reason: 'missing_authoritative_container', container_type: _qe.container_type, container_id: _cid94, object_name: _qe.name, turn: turnNumber });
            if (gameState.object_errors.length > 100) gameState.object_errors.shift();
            _quarantine.splice(_i, 1);
            _preRejected++;
            continue;
          }
          if (_cid94 === _expectedSiteKey94) continue; // already correct
          // Rewrite wrong container_id to authoritative site floor key
          console.log(`[NARRATE] pre-flight: site promote rewritten -> site:${_expectedSiteKey94} (was: ${_cid94}) for "${_qe.name}"`);
          _qe.container_id = _expectedSiteKey94;
          _preRewritten++;
        }
        // v1.88.38: pre-write normalization for transfer from/to container types
        // Same depth-based rewrite as the promote gate — CB emits "grid" for localspace IDs at L2
        let _txNormalized = 0;
        for (let _i = _quarantine.length - 1; _i >= 0; _i--) {
          const _qe = _quarantine[_i];
          if (_qe.action !== 'transfer') continue;
          const _txActiveLs   = gameState.world?.active_local_space;
          const _txActiveSite = gameState.world?.active_site;
          if (_txActiveLs) {
            const _txLsId = _txActiveLs.local_space_id;
            if (_txLsId) {
              let _txNormd = false;
              if (_qe.from_container_type === 'grid') { _qe.from_container_type = 'localspace'; _qe.from_container_id = _txLsId; _txNormd = true; }
              if (_qe.to_container_type   === 'grid') { _qe.to_container_type   = 'localspace'; _qe.to_container_id   = _txLsId; _txNormd = true; }
              if (_txNormd) _txNormalized++;
            }
          } else if (_txActiveSite) {
            const _txSiteId = _txActiveSite.id || _txActiveSite.site_id;
            const _txPx = gameState.player?.position?.x;
            const _txPy = gameState.player?.position?.y;
            if (_txSiteId != null && _txPx != null && _txPy != null) {
              const _txSiteKey = `${_txSiteId}:${_txPx},${_txPy}`;
              let _txNormd = false;
              if (_qe.from_container_type === 'grid') { _qe.from_container_type = 'site'; _qe.from_container_id = _txSiteKey; _txNormd = true; }
              if (_qe.to_container_type   === 'grid') { _qe.to_container_type   = 'site'; _qe.to_container_id   = _txSiteKey; _txNormd = true; }
              if (_txNormd) _txNormalized++;
            }
          }
        }
        const _validatedPartialDropReceipt = _sanitizeCbTlsPartialStackDropReceipt(
          _cbTlsPartialStackDropReceiptState === 'accepted'
            ? _cbTlsPartialStackDropReceipt : null
        );
        if (_validatedPartialDropReceipt) {
          for (let _i = _quarantine.length - 1; _i >= 0; _i--) {
            const _qe = _quarantine[_i];
            if (
              _qe.action !== 'transfer' ||
              _qe.temp_ref ||
              _qe.object_id !== _validatedPartialDropReceipt.source_object_id ||
              _qe.from_container_type !== _validatedPartialDropReceipt.source_container_type ||
              _qe.from_container_id !== _validatedPartialDropReceipt.source_container_id ||
              _qe.to_container_type !== _validatedPartialDropReceipt.destination_container_type ||
              _qe.to_container_id !== _validatedPartialDropReceipt.destination_container_id
            ) {
              continue;
            }

            if (!Array.isArray(_objectRealityDebug.suppressed_replays)) {
              _objectRealityDebug.suppressed_replays = [];
            }
            _objectRealityDebug.suppressed_replays.push({
              reason: 'cb_partial_drop_source_replay_suppressed',
              receipt_schema_version: _validatedPartialDropReceipt.schema_version,
              object_id: _validatedPartialDropReceipt.source_object_id,
              successor_object_id: _validatedPartialDropReceipt.successor_object_id,
              from_container_type: _qe.from_container_type,
              from_container_id: _qe.from_container_id,
              to_container_type: _qe.to_container_type,
              to_container_id: _qe.to_container_id,
              turn: turnNumber
            });
            _quarantine.splice(_i, 1);
          }
        }
        _objectRealityDebug.pre_rejected = _preRejected;
        _objectRealityDebug.pre_rewritten = _preRewritten;
        _objectRealityDebug.tx_normalized = _txNormalized;
        _objectRealityDebug.quarantine_size = _quarantine.length;

        // v1.88.66: actor_npc_ref resolution — resolve CB's prose entity_ref to a live NPC ID
        // before ObjectHelper runs. Result stored as _resolved_actor_id on each quarantine entry.
        // Guard: unresolved refs produce null and a [ORS-ACTOR-UNRESOLVED] warning — never a hard error.
        {
          const _actorAllNpcs = [
            ...(gameState.world?.npcs || []),
            ...(gameState.world?.active_site?.npcs || []),
            ...(gameState.world?.active_local_space?._visible_npcs || [])
          ].filter((n, i, a) => a.findIndex(x => x.id === n.id) === i);
          const _actorT1Reg = gameState.world?._turn1_founded_entities || [];
          for (const _qeActor of _quarantine) {
            if (_qeActor.action !== 'promote' || !_qeActor.actor_npc_ref) continue;
            const _aRef = String(_qeActor.actor_npc_ref).toLowerCase().trim();
            if (!_aRef) { _qeActor._resolved_actor_id = null; continue; }
            // v1.88.68: player sentinel — "player" is a valid actor ref, not an NPC ID.
            // Preserve the association without NPC pool lookup; Phase 4 bookkeeping already
            // skips associated_actor_id === 'player' from NPC reverse-index population.
            if (_aRef === 'player') {
              _qeActor._resolved_actor_id = 'player';
              _objectRealityDebug.actor_resolution.push({ object_name: _qeActor.name, actor_npc_ref: _qeActor.actor_npc_ref, resolved_to: 'player', status: 'player_sentinel' });
              continue;
            }
            // Direct NPC ID match
            let _aMatch = _actorAllNpcs.find(n => n.id === _qeActor.actor_npc_ref);
            // Turn 1 registry fallback for prose founding labels
            if (!_aMatch && turnNumber === 1 && _actorT1Reg.length) {
              _aMatch = _actorAllNpcs.find(n => {
                const _fe = _actorT1Reg.find(fe => fe.entity_id === n.id);
                return _fe && _fe.labels.includes(_aRef);
              });
            }
            if (_aMatch) {
              _qeActor._resolved_actor_id = _aMatch.id;
              _objectRealityDebug.actor_resolution.push({ object_name: _qeActor.name, actor_npc_ref: _qeActor.actor_npc_ref, resolved_to: _aMatch.id, status: 'resolved' });
            } else {
              _turnLog(_objectRealityDebug, 'warn', 'ORS-ACTOR-UNRESOLVED', `actor_npc_ref="${_qeActor.actor_npc_ref}" on object "${_qeActor.name}" T-${turnNumber} — no live NPC match; associated_actor_id left null`, {actor_npc_ref: _qeActor.actor_npc_ref, object_name: _qeActor.name, turn: turnNumber});
              _qeActor._resolved_actor_id = null;
              _objectRealityDebug.actor_resolution.push({ object_name: _qeActor.name, actor_npc_ref: _qeActor.actor_npc_ref, resolved_to: null, status: 'unresolved' });
            }
          }
        }

        if (_quarantine.length > 0) {
          const _ohResult = await ObjectHelper.run(gameState, _quarantine, turnNumber, _tslR?.tsl || null);
          console.log(`[NARRATE] ObjectHelper: promoted=${_ohResult.promoted} transferred=${_ohResult.transferred} errors=${_ohResult.errors} | pre_rejected=${_preRejected}`);
          _objectRealityDebug.ran          = true;
          _objectRealityDebug.promoted     = _ohResult.promoted;
          _objectRealityDebug.transferred  = _ohResult.transferred;
          _objectRealityDebug.errors       = _ohResult.errors;
          _objectRealityDebug.audit        = _ohResult.audit || [];
          _objectRealityDebug.reconciliation_count = _ohResult.reconciled || 0;
          _objectRealityDebug.error_entries = (gameState.object_errors || []).filter(e => e.turn === turnNumber);

          // v1.88.66: Phase 4 — populate associated_object_ids[] reverse index on NPCs.
          // Walk ORS audit to find objects promoted this pass with associated_actor_id pointing to an NPC.
          for (const _aoAudit of (_ohResult.audit || [])) {
            if (_aoAudit.action !== 'promoted') continue;
            const _aoRec = gameState.objects[_aoAudit.object_id];
            if (!_aoRec?.associated_actor_id || _aoRec.associated_actor_id === 'player') continue;
            const _aoAllNpcs = [
              ...(gameState.world?.npcs || []),
              ...(gameState.world?.active_site?.npcs || [])
            ];
            const _aoNpc = _aoAllNpcs.find(n => n.id === _aoRec.associated_actor_id);
            if (_aoNpc) {
              if (!Array.isArray(_aoNpc.associated_object_ids)) _aoNpc.associated_object_ids = [];
              if (!_aoNpc.associated_object_ids.includes(_aoAudit.object_id)) {
                _aoNpc.associated_object_ids.push(_aoAudit.object_id);
                _turnLog(_objectRealityDebug, 'log', 'ACTOR-ASSOC', `"${_aoRec.name}" (${_aoAudit.object_id}) → npc/${_aoRec.associated_actor_id} T-${turnNumber}`, {object_name: _aoRec.name, object_id: _aoAudit.object_id, npc_id: _aoRec.associated_actor_id, turn: turnNumber});
              }
            }
          }
        } else {
          // v1.85.25: guard prevents 'empty_quarantine' from overwriting 'ap_dedup_all_transfers'.
          // When all CB transfers were AP-deduped, quarantine ends up empty but skip_reason is already set.
          if (!_objectRealityDebug.skip_reason) _objectRealityDebug.skip_reason = 'empty_quarantine';
        }

        // v1.88.40: B4 ORS reconciliation — compare live _generated_interior object_ids vs world.sites persistent mirror
        {
          const _orsLs = gameState.world?.active_local_space;
          const _orsSite = gameState.world?.active_site;
          if (_orsLs?._generated_interior && _orsSite) {
            const _liveObjIds = _orsLs._generated_interior.object_ids || [];
            const _lsKey  = _orsLs.local_space_id;
            const _siteKey = _orsSite.id || _orsSite.site_id;
            const _mirrorLs = gameState.world?.sites?.[_siteKey]?.local_spaces?.[_lsKey];
            if (_mirrorLs?._generated_interior) {
              const _mirrorObjIds = _mirrorLs._generated_interior.object_ids || [];
              if (_liveObjIds.length !== _mirrorObjIds.length) {
                _turnLog(_objectRealityDebug, 'warn', 'ORS-RECONCILE', `WARN sites_mirror_divergence live=${_liveObjIds.length} mirror=${_mirrorObjIds.length} ls=${_lsKey} turn=${turnNumber}`, {live: _liveObjIds.length, mirror: _mirrorObjIds.length, ls: _lsKey, turn: turnNumber});
              }
            }
          }
        }

        // v1.88.37: build normalized candidate snapshot — mirrors pre-write normalization onto shallow
        // copies so the initial-condition pass sees post-rewrite container types while preserving
        // original CB output in _objectRealityDebug.cb_candidates
        const _icNormLs   = gameState.world?.active_local_space;
        const _icNormSite = gameState.world?.active_site;
        const _cbCandidatesNormalized = _cbMutationCandidates.map(_icc => {
          if (_icc.container_type !== 'grid') return _icc;
          const _copy = { ..._icc };
          if (_icNormLs) {
            const _iclsId = _icNormLs.local_space_id;
            if (_iclsId) { _copy.container_type = 'localspace'; _copy.container_id = _iclsId; }
          } else if (_icNormSite) {
            const _icSiteId = _icNormSite.id || _icNormSite.site_id;
            const _icPx     = gameState.player?.position?.x;
            const _icPy     = gameState.player?.position?.y;
            if (_icSiteId != null && _icPx != null && _icPy != null) {
              _copy.container_type = 'site';
              _copy.container_id   = `${_icSiteId}:${_icPx},${_icPy}`;
            }
          }
          return _copy;
        });
        _objectRealityDebug.cb_candidates_normalized = _cbCandidatesNormalized;

        // v1.84.66: Initial condition pass — applies initial_condition from CB candidate to newly-promoted objects
        // Runs before object_condition_updates so initial state is first in the conditions[] chain
        const _icResults = [];
        for (const _cand of _cbCandidatesNormalized) {
          if (!_cand || !_cand.initial_condition || !_cand.name) continue;
          const _icNameNorm = _cand.name.toLowerCase();
          const _icCtype    = _cand.container_type;
          const _icCid      = _cand.container_id;
          // Match candidate against this turn's audit entries by name + container
          const _icAudit = (_objectRealityDebug.audit || []).find(a =>
            (a.action === 'promoted' || a.action === 'promote_skipped_name_match' || a.action === 'promote_skipped_existing') &&
            (a.object_name || '').toLowerCase() === _icNameNorm &&
            a.container_type === _icCtype &&
            a.container_id   === _icCid
          );
          if (!_icAudit) continue;
          const _icRes = ObjectHelper.applyConditionUpdate(gameState, _icAudit.object_id, _cand.initial_condition, _cand.initial_evidence || '', turnNumber);
          _icResults.push(Object.assign({}, _icRes, { condition: _cand.initial_condition }));
        }
        if (_icResults.length > 0) {
          console.log(`[NARRATE] ObjectInitialConditions: ${_icResults.filter(r => r.applied).length}/${_icResults.length} applied`);
        }
        _objectRealityDebug.initial_condition_updates = _icResults;

        // v1.84.64: Object condition updates — CB annotation of tracked object states per turn
        const _cbConditionUpdates = _dropDryRunSealActive ? [] : (Array.isArray(_phaseBResult.object_condition_updates) ? _phaseBResult.object_condition_updates : []);
        const _conditionUpdateResults = [];
        for (const cu of _cbConditionUpdates) {
          if (!cu || (!cu.object_id && !cu.name_match) || !cu.condition) {
            _conditionUpdateResults.push({ applied: false, reason: 'malformed_entry', entry: cu });
            continue;
          }
          if (cu.object_id) {
            // Preferred path — exact object_id from tracked list
            const _cuResult = ObjectHelper.applyConditionUpdate(gameState, cu.object_id, cu.condition, cu.evidence || '', turnNumber);
            _conditionUpdateResults.push(_cuResult);
          } else if (cu.name_match) {
            // Broadcast path — same-name ambiguity could not be resolved; apply to all matching objects in scene scope
            const _bcWorld = gameState.world || {};
            const _bcPos   = _bcWorld.position;
            const _bcLoc   = _bcWorld.active_local_space || _bcWorld.active_site;
            const _bcCids  = new Set(['player']);
            if (_bcPos) _bcCids.add(`LOC:${_bcPos.mx},${_bcPos.my}:${_bcPos.lx},${_bcPos.ly}`);
            // v1.85.81: include active localspace or site floor
            if (_bcLoc && _bcLoc.local_space_id) _bcCids.add(_bcLoc.local_space_id);
            else if (_bcLoc && _bcLoc.site_id)   _bcCids.add(_bcLoc.site_id);
            for (const _bn of ((_bcLoc && _bcLoc._visible_npcs) || [])) { if (_bn.id) _bcCids.add(_bn.id); }
            const _bcNameNorm = cu.name_match.toLowerCase();
            const _bcMatches  = Object.values(gameState.objects || {}).filter(r =>
              r.status === 'active' && _bcCids.has(r.current_container_id) && (r.name || '').toLowerCase() === _bcNameNorm
            );
            let _bcApplied = 0;
            for (const _bm of _bcMatches) {
              const _br = ObjectHelper.applyConditionUpdate(gameState, _bm.id, cu.condition, cu.evidence || '', turnNumber);
              _conditionUpdateResults.push(_br);
              if (_br.applied) _bcApplied++;
            }
            console.log(`[NARRATE] ObjectConditions broadcast "${cu.name_match}" → applied ${_bcApplied}/${_bcMatches.length}`);
          }
        }
        if (_cbConditionUpdates.length > 0) {
          console.log(`[NARRATE] ObjectConditions: ${_conditionUpdateResults.filter(r => r.applied).length}/${_cbConditionUpdates.length} entries processed`);
        }
        _objectRealityDebug.condition_updates = _conditionUpdateResults;

        // v1.84.65: Object retirements — CB signals original object ceased to exist as itself
        // v1.85.8: refactored to _retirementPairs to carry entry+result for fission second pass
        const _cbRetirements = _dropDryRunSealActive ? [] : (Array.isArray(_phaseBResult.object_retirements) ? _phaseBResult.object_retirements : []);
        const _retirementPairs = []; // [{ entry, result }] — entry kept for successor extraction
        for (const ret of _cbRetirements) {
          if (!ret) {
            _retirementPairs.push({ entry: ret, result: { retired: false, reason: 'malformed_entry' } });
            continue;
          }
          // v1.89.05: Establish effective ID — null means CB signalled fission with uncertain ID (BINDING RULE).
          // Non-null path: _resolvedId = ret.object_id (no change to existing behaviour).
          let _resolvedId = ret.object_id || null;
          if (_resolvedId === null) {
            // Attempt container-scoped name-match resolution when fission context is present.
            if (typeof ret.reason === 'string' && ret.reason.trim() &&
                Array.isArray(ret.successors) && ret.successors.length > 0) {
              const _nrContainerType = ret.successors[0].container_type;
              const _nrContainerId   = ret.successors[0].container_id;
              if (_nrContainerType && _nrContainerId) {
                // Build context from reason + successor names/descriptions (mirrors fission_parent_mismatch guard)
                const _nrCtxText = [
                  ret.reason,
                  ...ret.successors.map(s => `${s.name || ''} ${s.description || ''}`)
                ].join(' ').toLowerCase();
                const _nrTokens = _nrCtxText.split(/\W+/).filter(t => t.length > 2);
                const _nrCandidates = Object.values(gameState.objects).filter(o =>
                  o.status === 'active' &&
                  o.current_container_type === _nrContainerType &&
                  o.current_container_id   === _nrContainerId &&
                  _nrTokens.some(t => o.name.toLowerCase().includes(t))
                );
                if (_nrCandidates.length === 1) {
                  _resolvedId = _nrCandidates[0].id;
                  _objectRealityDebug.null_id_resolved = (_objectRealityDebug.null_id_resolved || 0) + 1;
                  console.log(`[FISSION] null_id_resolved: "${_nrCandidates[0].name}" (${_resolvedId}) from fission context`);
                } else if (_nrCandidates.length === 0) {
                  _objectRealityDebug.null_id_unresolvable = (_objectRealityDebug.null_id_unresolvable || 0) + 1;
                  _retirementPairs.push({ entry: ret, result: { retired: false, reason: 'null_id_unresolvable' } });
                  continue;
                } else {
                  _objectRealityDebug.null_id_ambiguous = (_objectRealityDebug.null_id_ambiguous || 0) + 1;
                  _retirementPairs.push({ entry: ret, result: { retired: false, reason: 'null_id_ambiguous' } });
                  continue;
                }
              } else {
                _objectRealityDebug.null_id_unresolvable = (_objectRealityDebug.null_id_unresolvable || 0) + 1;
                _retirementPairs.push({ entry: ret, result: { retired: false, reason: 'null_id_unresolvable' } });
                continue;
              }
            } else {
              _retirementPairs.push({ entry: ret, result: { retired: false, reason: 'malformed_entry' } });
              continue;
            }
          }
          // v1.89.02: fission parent binding guard — fission retirements only (successors present).
          // If the stored parent name shares no tokens with reason + successor names/descriptions,
          // the parent binding is likely wrong (CB retired the wrong object). Block retirement entirely.
          // Plain retirements (no successors) bypass this guard — they have no fission context to check.
          if (Array.isArray(ret.successors) && ret.successors.length > 0) {
            const _candidateRec = gameState.objects[_resolvedId];
            if (_candidateRec && _candidateRec.status === 'active') {
              const _pTokens = _candidateRec.name.toLowerCase().split(/\W+/).filter(t => t.length > 2);
              if (_pTokens.length > 0) {
                const _ctxText = [
                  ret.reason || '',
                  ...ret.successors.map(s => `${s.name || ''} ${s.description || ''}`)
                ].join(' ').toLowerCase();
                if (!_pTokens.some(t => _ctxText.includes(t))) {
                  console.warn(`[FISSION] parent_mismatch: "${_candidateRec.name}" (${_resolvedId}) — no name token overlap with successors/reason; retirement blocked`);
                  _objectRealityDebug.fission_mismatch_skipped = (_objectRealityDebug.fission_mismatch_skipped || 0) + 1;
                  _retirementPairs.push({ entry: ret, result: { retired: false, reason: 'fission_parent_mismatch' } });
                  continue;
                }
              }
            }
          }
          const _retResult = ObjectHelper.retireObject(gameState, _resolvedId, ret.reason || '', turnNumber);
          _retirementPairs.push({ entry: ret, result: _retResult, resolvedId: _resolvedId });
        }
        const _retirementResults = _retirementPairs.map(p => p.result);
        if (_cbRetirements.length > 0) {
          console.log(`[NARRATE] ObjectRetirements: ${_retirementResults.filter(r => r.retired).length}/${_cbRetirements.length} retired`);
        }
        _objectRealityDebug.retirement_updates = _retirementResults;

        // v1.91.68: P5-A1 quarantine seal — suppress downstream injection when AP refused partial-stack TAKE this turn
        const _apRefusedTake =
          gameState._apActuals?.operation_family === 'take' &&
          gameState._apActuals?.routing === 'quarantined' &&
          gameState._apActuals?.outcome === 'refused_ownership';

        // v1.90.02: TLS fission injection — retire objects TLS resolved that CB missed this turn.
        // Inserts into _retirementPairs so the existing fission second pass picks up successors automatically.
        if (!_apRefusedTake && !_dropDryRunSealActive) {
          const _tslFissionOps = Array.isArray(_tslR?.tsl?.fission_operations) ? _tslR.tsl.fission_operations : [];
          let _tslFissionInjected    = 0;
          let _tslFissionUnresolvable = 0;
          if (_tslFissionOps.length > 0) {
            const _alreadyRetiredIds = new Set(
              _retirementPairs.filter(p => p.result.retired && p.resolvedId).map(p => p.resolvedId)
            );
            for (const _fop of _tslFissionOps) {
              if (!_fop.source_object_id) { _tslFissionUnresolvable++; continue; }
              if (_alreadyRetiredIds.has(_fop.source_object_id)) continue; // CB already owns this retirement
              const _tslRetResult = ObjectHelper.retireObject(gameState, _fop.source_object_id, `tsl_fission: ${_fop.verb || 'split'}`, turnNumber);
              if (_tslRetResult.retired) {
                _retirementPairs.push({
                  entry:      { object_id: _fop.source_object_id, reason: `tsl_fission: ${_fop.verb || 'split'}`, successors: _fop.successors || [] },
                  result:     _tslRetResult,
                  resolvedId: _fop.source_object_id
                });
                _tslFissionInjected++;
              }
            }
          }
          _objectRealityDebug.tsl_fission_injected     = _tslFissionInjected;
          _objectRealityDebug.tsl_fission_unresolvable = _tslFissionUnresolvable;
        }

        // v1.91.03: TLS extraction injection — build partial_split quarantine from extraction_operations.
        // Non-degenerate ops: partial_split entries → ObjectHelper Pass 3.
        // degrades_to_fission ops: retire source → push to _retirementPairs (fission second pass promotes successor).
        if (!_apRefusedTake && !_dropDryRunSealActive) {
          const _tslExtractionOps = Array.isArray(_tslR?.tsl?.extraction_operations) ? _tslR.tsl.extraction_operations : [];
          let _tslExtractionInjected     = 0;
          let _tslExtractionUnresolvable = 0;
          const _extractionQuarantine = [];
          if (_tslExtractionOps.length > 0) {
            for (const _eop of _tslExtractionOps) {
              if (!_eop.source_object_id || _eop.unresolved || _eop.quantity_unresolved) {
                _tslExtractionUnresolvable++;
                continue;
              }
              if (_eop.degrades_to_fission) {
                // Source fully consumed by extraction — retire and route successor through fission second pass
                const _tslRetResult = ObjectHelper.retireObject(gameState, _eop.source_object_id, `tsl_extraction_degrade: ${_eop.verb || 'extract'}`, turnNumber);
                if (_tslRetResult.retired) {
                  _retirementPairs.push({
                    entry: {
                      object_id:  _eop.source_object_id,
                      reason:     `tsl_extraction_degrade: ${_eop.verb || 'extract'}`,
                      successors: _eop.product ? [{
                        name:           _eop.product.name,
                        quantity:       _eop.product.quantity,
                        unit:           _eop.product.unit,
                        container_type: _eop.product.container_type,
                        container_id:   _eop.product.container_id,
                        temp_ref:       _eop.product.temp_ref || 'ext_frag'
                      }] : []
                    },
                    result:     _tslRetResult,
                    resolvedId: _eop.source_object_id
                  });
                  _tslExtractionInjected++;
                }
              } else {
                // Normal extraction — partial_split (source survives with reduced quantity)
                _extractionQuarantine.push({
                  action:             'partial_split',
                  source_object_id:   _eop.source_object_id,
                  new_source_quantity: _eop.new_source_quantity,
                  name:               _eop.product?.name           || null,
                  quantity:           _eop.product?.quantity       ?? _eop.extracted_quantity ?? 1,
                  unit:               _eop.product?.unit           || null,
                  container_type:     _eop.product?.container_type || 'player',
                  container_id:       _eop.product?.container_id   || 'player',
                  temp_ref:           _eop.product?.temp_ref       || `ext_${_eop.source_object_id}`,
                  parent_object_id:   _eop.source_object_id,
                  reason:             `tsl_extraction: ${_eop.verb || 'extract'}`
                });
                _tslExtractionInjected++;
              }
            }
          }
          if (_extractionQuarantine.length > 0) {
            const _extractionResult = await ObjectHelper.run(gameState, _extractionQuarantine, turnNumber, null);
            console.log(`[NARRATE] ExtractionPass: partial_splits=${_extractionResult.partial_splits} promoted=${_extractionResult.promoted} errors=${_extractionResult.errors}`);
            _objectRealityDebug.promoted    += _extractionResult.promoted;
            _objectRealityDebug.transferred += _extractionResult.transferred;
            _objectRealityDebug.errors      += _extractionResult.errors;
            _objectRealityDebug.audit        = (_objectRealityDebug.audit || []).concat(_extractionResult.audit || []);
            // v1.91.09: extraction pass ran and produced meaningful results — override the
            // main-ORS skip_reason/ran=false that was set when the main quarantine was empty.
            // "Meaningful" = any promoted, transferred, errors, or audit entries. Covers
            // partial_split success, fission-via-extraction retirement, and error-only turns.
            const _extractionDidWork = _extractionResult.promoted > 0 || _extractionResult.transferred > 0
                                    || _extractionResult.errors > 0
                                    || (_extractionResult.audit && _extractionResult.audit.length > 0);
            if (_extractionDidWork) {
              _objectRealityDebug.ran         = true;
              _objectRealityDebug.skip_reason = null;
            }
          }
          _objectRealityDebug.tsl_extraction_injected     = _tslExtractionInjected;
          _objectRealityDebug.tsl_extraction_unresolvable = _tslExtractionUnresolvable;
        }

        // v1.85.8: Fission second pass — promote successor objects from successfully-retired parents.
        // Atomicity gate: successors are only injected when parent retirement returned retired:true.
        // No state can exist where the original object and its fragments are simultaneously active.
        const _fissionQuarantine = [];
        for (const { entry: _retEntry, result: _retResult, resolvedId: _retResolvedId } of _retirementPairs) {
          if (!_retResult.retired) continue;
          if (!Array.isArray(_retEntry.successors) || _retEntry.successors.length === 0) continue;
          const _effectiveParentId = _retResolvedId || _retEntry.object_id;
          for (const _suc of _retEntry.successors) {
            if (!_suc?.name || !_suc.container_type || !_suc.container_id) {
              console.warn(`[FISSION] malformed successor entry for parent ${_effectiveParentId} — skipped`);
              continue;
            }
            _fissionQuarantine.push({
              action:            'promote',
              name:              _suc.name,
              description:       _suc.description || '',
              container_type:    _suc.container_type,
              container_id:      _suc.container_id,
              temp_ref:          `${_effectiveParentId}_${_suc.temp_ref || 'frag'}`,
              transfer_origin:   'fission_successor',
              parent_object_id:  _effectiveParentId,
              reason:            `fission successor of ${_effectiveParentId}`,
              // v1.89.01: quantity/unit passthrough — mirrors ObjectHelper guard exactly
              quantity:          Number.isInteger(_suc.quantity) && _suc.quantity >= 1 ? _suc.quantity : 1,
              unit:              typeof _suc.unit === 'string' && _suc.unit.trim() ? _suc.unit.trim() : null
            });
            _objectRealityDebug.fission_successors_injected++;
          }
          _objectRealityDebug.fission_retired++;
        }
        if (_fissionQuarantine.length > 0) {
          const _fissionResult = await ObjectHelper.run(gameState, _fissionQuarantine, turnNumber, null);
          console.log(`[NARRATE] FissionPass: promoted=${_fissionResult.promoted} errors=${_fissionResult.errors}`);
          _objectRealityDebug.promoted    += _fissionResult.promoted;
          _objectRealityDebug.transferred += _fissionResult.transferred;
          _objectRealityDebug.errors      += _fissionResult.errors;
          _objectRealityDebug.audit        = (_objectRealityDebug.audit || []).concat(_fissionResult.audit || []);
          _objectRealityDebug.error_entries = (gameState.object_errors || []).filter(e => e.turn === turnNumber);
        }
      } else {
        _objectRealityDebug.skip_reason = 'no_phaseB_result';
      }
    }

    // v1.85.39: ORS complete — world_update done
    diag.emitDiagnostics({ type: 'turn_stage', stage: 'world_update', status: 'complete', turn: turnNumber, gameSessionId: resolvedSessionId });

    // Extract player entity candidate for Mother Brain visibility
    const _playerExtraction = (() => {
      const _peCands = _extractionPacket?.entity_candidates || [];
      const _peFound = _peCands.find(c => {
        const ref = (c.entity_ref || '').toLowerCase();
        return ref === 'player' || ref === 'you';
      });
      if (!_peFound) return null;
      return {
        candidate_count: 1,
        facts: [
          ...(_peFound.physical_attributes || []),
          ...(_peFound.observable_states   || []),
          ...(_peFound.held_objects        || []),
          ...(_peFound.worn_objects        || [])
        ]
      };
    })();

    // Log narration generation
    if (logger) {
      logger.narrationGenerated(narrative.length);
    }

    // v1.84.19: Condition Bot — evaluate and update active player conditions
    let _conditionBotRan = false;
    let _conditionBotStats = { evaluated: 0, resolved: 0, updated: 0 };
    if (turnNumber > 1 && Array.isArray(gameState.player.conditions) && gameState.player.conditions.length > 0) {
      try {
        const _cbResult = await ConditionBot.run(
          gameState.player.conditions,
          turnNumber,
          process.env.DEEPSEEK_API_KEY || ''
        );
        if (_cbResult && typeof _cbResult === 'object' && Array.isArray(_cbResult.updatedConditions)) {
          const _prevCount = gameState.player.conditions.length;
          const _resolvedCount = _cbResult.archive ? _cbResult.archive.length : 0;
          const _updatedCount = _cbResult.updatedConditions.filter((c, i) => {
            const orig = gameState.player.conditions[i];
            return orig && c.description !== orig.description;
          }).length;
          gameState.player.conditions = _cbResult.updatedConditions;
          if (_cbResult.archive && _cbResult.archive.length > 0) {
            if (!Array.isArray(gameState.player.conditions_archive)) gameState.player.conditions_archive = [];
            gameState.player.conditions_archive.push(..._cbResult.archive);
          }
          _conditionBotRan = true;
          _conditionBotStats = { evaluated: _prevCount, resolved: _resolvedCount, updated: _updatedCount };
          _conditionBotPayloadSnapshot = { prompt: _cbResult.prompt || null, response: _cbResult.raw || null }; // v1.84.21
          console.log(`[CONDITION-BOT] ran: evaluated=${_prevCount} resolved=${_resolvedCount} updated=${_updatedCount}`);;
        }
      } catch (_cbErr) {
        console.error('[CONDITION-BOT] Error:', _cbErr.message);
      }
    }

    // QA-014: End turn scope and create turn object
    let turnLogs = [];
    if (logger) {
      turnLogs = logger.endTurn();  // Returns logs captured during this turn
    }
    
    // Extract authoritative state for turn snapshot
    const currentPosition = gameState.world.position || { mx: 0, my: 0, lx: 6, ly: 6 };
    const cellKey = `LOC:${currentPosition.mx},${currentPosition.my}:${currentPosition.lx},${currentPosition.ly}`;
    const currentCell = gameState.world.cells ? gameState.world.cells[cellKey] : null;
    
    // Phase 10: Resolve current interior from cell.sites (authoritative).
    // Prefer canonical interior_key; fall back to site_id for sessions loaded but not yet entered.
    let currentSite = null;
    {
      const _allSlotsArr = Object.values(currentCell?.sites || {});
      let _siteLookup = null;
      if (_allSlotsArr.length === 1) {
        _siteLookup = _allSlotsArr[0];
      } else if (_allSlotsArr.length > 1) {
        _siteLookup = _allSlotsArr.find(s => s.enterable === true) || _allSlotsArr[0];
      }
      if (_siteLookup && gameState.world.sites) {
        currentSite = gameState.world.sites[_siteLookup.interior_key]
          || gameState.world.sites[_siteLookup.site_id]
          || null;
        // B4: prefer live name from cell.sites over potentially stale stub name in world.sites
        if (currentSite && _siteLookup.name != null) {
          currentSite = { ...currentSite, name: _siteLookup.name };
        }
      }
    }
    
    // v1.88.2: Refresh L0 _visible_npcs before diagnostics payload — Turn 1 BORN-NPCs are created after the
    // early computeVisibleNpcs block, so without this refresh visible_npc_count would always be 0 on Turn 1.
    if (!gameState.world.active_local_space && !gameState.world.active_site) {
      const _l0diag_pos = gameState.world?.position || {};
      gameState.world._visible_npcs = (gameState.world?.npcs || []).filter(npc =>
        npc.position?.mx === _l0diag_pos.mx && npc.position?.my === _l0diag_pos.my &&
        npc.position?.lx === _l0diag_pos.lx && npc.position?.ly === _l0diag_pos.ly
      );
    }
    const authoritativeState = {
      position: currentPosition,
      cell_key: cellKey,
      cell_type: currentCell?.type || 'unknown',
      cell_subtype: currentCell?.subtype || 'unknown',
      starting_location_hint: currentCell?.starting_location_hint || null,
      cell_description: currentCell?.description || 'unknown',  // QA-016 follow-up: for narrative comparison
      biome: gameState.world.macro_biome || 'unknown',
      turn_counter: gameState.turn_counter || 0,
      site_count: Object.values(currentCell?.sites || {}).length,
      current_site: currentSite,  // Now populated if player is in a site
      // Layer derived from containment state — current_depth updated to match but not used as source of truth
      current_depth: gameState.world.active_local_space ? 3 : gameState.world.active_site ? 2 : 1,
      active_site_name: gameState.world.active_site?.name || null,
      site_position: gameState.world.active_site && !gameState.world.active_local_space ? (gameState.player?.position || null) : null,
      local_space_position: gameState.world.active_local_space ? (gameState.player?.position || null) : null,
      visible_npc_count: gameState.world.active_local_space
        ? (gameState.world.active_local_space?._visible_npcs || []).length
        : gameState.world.active_site
          ? (gameState.world.active_site?._visible_npcs || []).length
          : (gameState.world._visible_npcs || []).length,
      visible_npc_names: gameState.world.active_local_space
        ? (gameState.world.active_local_space?._visible_npcs || []).map(n => n.npc_name || n.name || n.job_category || n.id)
        : gameState.world.active_site
          ? (gameState.world.active_site?._visible_npcs || []).map(n => n.npc_name || n.name || n.job_category || n.id)
          : (gameState.world._visible_npcs || []).map(n => n.npc_name || n.name || n.job_category || n.id),
      visible_npcs_snapshot: (gameState.world.active_local_space?._visible_npcs || gameState.world.active_site?._visible_npcs || gameState.world._visible_npcs || [])
        .map(n => ({ id: n.id, job_category: n.job_category ?? null, npc_name: n.npc_name ?? null, is_learned: n.is_learned ?? false, x: n.site_position?.x ?? null, y: n.site_position?.y ?? null })),
      npc_record_count: gameState.world.active_local_space
        ? (gameState.world.active_site?.npcs?.length ?? 0)
        : gameState.world.active_site
          ? (gameState.world.active_site.npcs || []).length
          : (gameState.world.npcs || []).length,
      start_container: gameState.world.start_container || 'L0',
      start_routing_log: gameState.world._startRoutingLog || null
    };

    // Phase 9: Build visibilityPayload — authoritative structure for all diagnostic surfaces
    {
      // Layer derived from containment state — not from current_depth counter
      const _vpDepth = gameState.world.active_local_space ? 3 : gameState.world.active_site ? 2 : 1;
      const _vpDepthLabels = { 1: 'L0', 2: 'L1', 3: 'L2', 4: 'L3' };
      const _vpSiteRegistry = gameState.world.sites || {};
      const _vpActiveSite = gameState.world.active_site || null;
      const _vpActiveLocalSpace = gameState.world.active_local_space || null;
      const _vpAllCells = gameState.world.cells || {};
      const _vpWb = gameState.world.world_bias || null;
      const _vpRegionKeys = new Set(
        Object.keys(_vpAllCells).map(k => {
          const _m = k.match(/^LOC:(-?\d+),(-?\d+):/);
          return _m ? `${_m[1]},${_m[2]}` : null;
        }).filter(Boolean)
      );
      const _vpSites = Object.entries(currentCell?.sites || {}).map(([, _s]) => {
        const _sGenerated = !!(
          _s.interior_key &&
          _vpSiteRegistry[_s.interior_key] &&
          !_vpSiteRegistry[_s.interior_key].is_stub
        );
        const _vpLocalSpaces = _sGenerated
          ? Object.entries(_vpSiteRegistry[_s.interior_key].local_spaces || {}).map(([_bId, _b]) => ({
              local_space_id: _bId,
              name: _b.name || null,
              purpose: _b.purpose || null,
              tier: _b.tier ?? null,
              active: _vpDepth === 3 && !!_vpActiveLocalSpace && _vpActiveLocalSpace.local_space_id === _bId
            }))
          : [];
        return {
          site_id: _s.site_id,
          identity: _s.identity || null,
          is_filled: _s.is_filled ?? false,
          name: _s.name || null,
          enterable: _s.enterable ?? false,
          entered: _s.entered ?? false,
          generated: _sGenerated,
          interior_key: _s.interior_key || null,
          l0_ref: _s.l0_ref || null,
          local_spaces: _vpLocalSpaces
        };
      });
      visibilityPayload = {
        layer: _vpDepthLabels[_vpDepth] || 'L0',
        current_depth: _vpDepth,
        entered_site: _vpDepth >= 2,
        inside_site: _vpDepth >= 2,
        entered_building: _vpDepth >= 3,
        active_site_name: _vpActiveSite?.name || null,
        container: _vpDepth === 3 && _vpActiveLocalSpace ? {
          kind: 'local_space',
          name: _vpActiveLocalSpace.name || null,
          width: _vpActiveLocalSpace.width || null,
          height: _vpActiveLocalSpace.height || null,
          local_space_id: _vpActiveLocalSpace.local_space_id || null,
          cell_type: currentCell?.type || null,
          biome: gameState.world.macro_biome || null,
          cell_description: currentCell?.description || null,
          cell_subtype: currentCell?.subtype || null,
          parent_site: _vpActiveSite ? {
            kind: 'site',
            name: _vpActiveSite.name || null,
            site_id: _vpActiveSite.site_id || null
          } : null
        } : _vpDepth >= 2 && _vpActiveSite ? {
          kind: 'site',
          name: _vpActiveSite.name || null,
          type: _vpActiveSite.type || null,
          site_id: _vpActiveSite.site_id || null,
          grid_key: cellKey,
          mac_key: `MAC:${currentPosition.mx},${currentPosition.my}`,
          mx: currentPosition.mx,
          my: currentPosition.my,
          lx: currentPosition.lx,
          ly: currentPosition.ly,
          cell_type: currentCell?.type || null,
          cell_subtype: currentCell?.subtype || null,
          starting_location_hint: currentCell?.starting_location_hint || null,
          cell_description: currentCell?.description || null,
          biome: gameState.world.macro_biome || null
        } : {
          kind: 'cell',
          grid_key: cellKey,
          mac_key: `MAC:${currentPosition.mx},${currentPosition.my}`,
          mx: currentPosition.mx,
          my: currentPosition.my,
          lx: currentPosition.lx,
          ly: currentPosition.ly,
          cell_type: currentCell?.type || null,
          cell_subtype: currentCell?.subtype || null,
          starting_location_hint: currentCell?.starting_location_hint || null,
          cell_description: currentCell?.description || null,
          biome: gameState.world.macro_biome || null,
          name: null
        },
        sites: _vpSites,
        world_seed: gameState.world.phase3_seed || null,
        world_tone: gameState.world.world_tone || null,
        world_bias: {
          site_density: _vpWb?.site_density || null,
          civilization_presence: _vpWb?.civilization_presence || null,
          environment_tone: _vpWb?.environment_tone || null
        },
        total_cells: Object.keys(_vpAllCells).length,
        region_cell_count: Object.keys(_vpAllCells).filter(k => k.startsWith(`LOC:${currentPosition.mx},${currentPosition.my}:`)).length,
        regions_explored: _vpRegionKeys.size,
        turn_counter: gameState.turn_counter || 0,
        site_count: Object.values(currentCell?.sites || {}).length,
        site_position: _vpDepth === 2 ? (gameState.player?.position || null) : null,
        local_space_position: _vpDepth === 3 ? (gameState.player?.position || null) : null,
        last_site_capture: gameState.world._lastSiteCapture || null,
        last_npc_capture: gameState.world._lastNpcCapture || null
      };
    }

    // QA-017: Extract parsed intent with explicit field separation (raw vs parsed)
    let parsedIntent = {};
    let parsedIntentSource = 'none';  // Track source for export clarity
    const playerActionParsedLog = turnLogs.find(log => log.event === 'player_action_parsed');
    if (playerActionParsedLog && playerActionParsedLog.data) {
      const { action, intent: intentData } = playerActionParsedLog.data;
      // intentData structure: { primaryAction: { action, dir, target }, confidence, success, error }
      // Extract from actual parser output: separate raw input from parsed action
      parsedIntent = {
        raw_input: action || '',  // Original user input string
        parsed_action: intentData?.primaryAction?.action || 'unknown',  // Parser-resolved action
        direction: intentData?.primaryAction?.dir || null,  // Direction from parser (explicit field)
        target: intentData?.primaryAction?.target || null,  // Target from parser
        confidence: (intentData?.confidence !== undefined ? intentData?.confidence : null),  // Confidence score (preserve 0)
        success: intentData?.success || false,  // Whether parse succeeded
        source: 'parser'  // Mark as actual parser output
      };
      parsedIntentSource = 'parser';
    } else if (engineOutput?.actions?.action) {
      // Fallback: use engine output (inferred, not from parser)
      parsedIntent = {
        raw_input: engineOutput.actions.action || '',
        parsed_action: engineOutput.actions.action || 'unknown',
        direction: engineOutput.actions.dir || null,
        target: null,
        confidence: 0,
        success: false,
        source: 'fallback'  // Mark clearly as fallback/inferred
      };
      parsedIntentSource = 'fallback';
    }
    
    // QA-016: Extract movement before/after positions from turn logs
    let movement = null;
    const playerMoveAttemptedLog = turnLogs.find(log => log.event === 'player_move_attempted');
    const playerMoveResolvedLog = turnLogs.find(log => log.event === 'player_move_resolved');
    const locationChangedLog = turnLogs.find(log => log.event === 'location_changed');
    
    if (playerMoveAttemptedLog && playerMoveResolvedLog) {
      const attemptData = playerMoveAttemptedLog.data || {};
      const resolvedData = playerMoveResolvedLog.data || {};
      
      // Extract before position from attempt, after position from resolved
      const fromPos = attemptData.from || currentPosition;
      const toPos = resolvedData.final_position || attemptData.intended_to || currentPosition;
      
      movement = {
        from: fromPos,
        to: toPos,
        direction: attemptData.direction || parsedIntent.direction,
        success: resolvedData.success || false,
        block_reason: resolvedData.success ? null : (resolvedData.reason || '?'),
        from_cell_type: locationChangedLog?.data?.from_cell_type,
        to_cell_type: locationChangedLog?.data?.to_cell_type,
        l2_exit_diag: toPos?.l2_exit_diag || null
      };
    } else if (!playerMoveAttemptedLog && playerMoveResolvedLog && playerMoveResolvedLog.data?.success === false) {
      // Failed before attempt was logged (NO_POSITION, ENGINE_GUARD, etc.)
      const resolvedData = playerMoveResolvedLog.data || {};
      movement = {
        from: currentPosition,
        to: currentPosition,
        direction: parsedIntent?.direction || '?',
        success: false,
        block_reason: resolvedData.reason || 'UNKNOWN',
        from_cell_type: null,
        to_cell_type: null,
        l2_exit_diag: null
      };
    }
    
    // QA-016: Extract nearby cells snapshot for diagnostic context
    let nearbyCellsSnapshot = null;
    if (scene && scene.nearbyCells && Array.isArray(scene.nearbyCells)) {
      nearbyCellsSnapshot = {};
      scene.nearbyCells.forEach(cell => {
        if (cell.dir) {
          nearbyCellsSnapshot[cell.dir] = {
            type: cell.type,
            subtype: cell.subtype,
            description: cell.description
          };
        }
      });
    }
    
    // ========================================================================
    // QA-017: Per-turn diagnostic generation (rule-based, lightweight)
    // ========================================================================
    const _qaDiagnostics = [];
    
    // 1. Check: missing_parsed_intent (SKIP ON INITIALIZATION TURN)
    // Only flag if player action exists but parsed intent is genuinely missing/invalid
    if (action && action.trim() && turnNumber !== 1) {  // Skip Turn 1
      const hasValidParsedIntent = parsedIntent && parsedIntent.parsed_action && parsedIntent.parsed_action !== 'unknown';
      const hasValidFallback = engineOutput && engineOutput.actions && engineOutput.actions.action && engineOutput.actions.action !== 'unknown';
      
      // Flag ONLY if no valid parsed intent AND no valid fallback (turn truly unresolved)
      if (!hasValidParsedIntent && !hasValidFallback) {
        _qaDiagnostics.push({
          type: 'missing_parsed_intent',
          severity: 'medium',
          detail: `player action exists but no usable intent extracted: "${action.substring(0, 50)}${action.length > 50 ? '...' : ''}"`
        });
      }
      // Also flag if parser explicitly failed (not just fallback)
      else if (parsedIntent && parsedIntent.success === false) {
        _qaDiagnostics.push({
          type: 'missing_parsed_intent',
          severity: 'medium',
          detail: `parser failed to classify: "${action.substring(0, 50)}${action.length > 50 ? '...' : ''}"`
        });
      }
    }
    
    // 3. Check: movement_inconsistency (contradictions only)
    // Only flag contradictions between logs/state, not mere failures
    // Skip at L1+ — L1 logs carry {x,y} which is incompatible with L0 {mx,my,lx,ly} comparison
    if (movement && movement.success === true
        && authoritativeState.current_depth <= 1
        && !movement.to?.exited) {
      // Movement succeeded; verify final position matches expectation
      const finalPos = movement.to;
      const authoritative = authoritativeState.position;
      
      // Check if positions actually mismatch (after normalizing)
      const positionMismatch = finalPos && authoritative && 
        (finalPos.mx !== authoritative.mx || finalPos.my !== authoritative.my ||
         finalPos.lx !== authoritative.lx || finalPos.ly !== authoritative.ly);
      
      if (positionMismatch) {
        _qaDiagnostics.push({
          type: 'movement_inconsistency',
          severity: 'high',
          detail: `move succeeded but final position (${finalPos.mx},${finalPos.my})->(${finalPos.lx},${finalPos.ly}) does not match authoritative (${authoritative.mx},${authoritative.my})->(${authoritative.lx},${authoritative.ly})`
        });
      }
    } else if (movement && !movement.success) {
      // Movement failed; check if logs/state contradict each other
      const attemptLog = turnLogs.find(log => log.event === 'player_move_attempted');
      const resolveLog = turnLogs.find(log => log.event === 'player_move_resolved');
      
      // Flag only if logs exist but contradict (e.g., attempt says success but resolve says failure)
      if (attemptLog && resolveLog) {
        const attemptSuccess = attemptLog.data?.success || false;
        const resolveSuccess = resolveLog.data?.success || false;
        if (attemptSuccess !== resolveSuccess) {
          _qaDiagnostics.push({
            type: 'movement_inconsistency',
            severity: 'high',
            detail: `movement logs contradict: attempt=${attemptSuccess} vs resolve=${resolveSuccess}`
          });
        }
      }
    }
    
    // 4. Check: site_presence_mismatch — Phase 6D6: use cell.sites authority, not cell.type
    const _diagCellKey = `LOC:${pos.mx},${pos.my}:${pos.lx},${pos.ly}`;
    const _diagCellSites = gameState.world.cells?.[_diagCellKey]?.sites;
    const isSiteCell = _diagCellSites
      ? Object.values(_diagCellSites).some(s => s.enterable === true)
      : false;
    
    if (isSiteCell) {
      // Site cell requires consistent site state
      if (!currentSite) {
        _qaDiagnostics.push({
          type: 'site_presence_mismatch',
          severity: 'high',
          detail: `cell type is community-type but site not found in registry`
        });
      } else if (!currentSite.name || currentSite.name.trim() === '') {
        _qaDiagnostics.push({
          type: 'site_presence_mismatch',
          severity: 'medium',
          detail: `site exists but missing or empty name field`
        });
      } else if (!currentSite.id) {
        _qaDiagnostics.push({
          type: 'site_presence_mismatch',
          severity: 'low',
          detail: `site exists but missing id field`
        });
      }
    }
    
    // QA-016 follow-up: Create turn object with initialization flag for Turn 1
    // v1.54.0: Pre-compute narration block flags so they can be included in turnObject for QA export
    const _nbPrimaryBullet = (_parsedAction === 'move' || _parsedAction === 'look' || _parsedAction === 'exit') ? _parsedAction : null;
    const _nbMovementTask = _movementTaskBlock !== '';
    const _nbMovementFlavor = _movementFlavorBlock !== '';
    const _nbNarratorMode = !!_narratorModeBlock;
    const _nbSoliloquy = _soliloquyBlock !== '';
    // v1.91.XX: Phase 5 — safe deep-clone for per-turn diagnostic archive.
    // Returns null on failure — never throws, never returns live reference.
    function _cloneForArchive(val) {
      try { return JSON.parse(JSON.stringify(val ?? null)); } catch (_) { return null; }
    }
    const turnObject = {
      turn_number: turnNumber,
      timestamp: new Date().toISOString(),
      is_initialization: (turnNumber === 1),  // Special flag for Turn 1 world setup
      intent_channel: resolvedChannel,
      npc_target: _rawNpcTarget || null,
      needs_say_triggered: false,
      input: { raw: action, parsed_intent: parsedIntent, parsed_intent_source: parsedIntentSource },
      authoritative_state: _cloneForArchive(authoritativeState),
      visibility: visibilityPayload,
      movement: movement,
      nearby_cells: nearbyCellsSnapshot,
      narrative: narrative,
      diagnostics: _qaDiagnostics,
      narration_debug: {
        primary_bullet_override: _nbPrimaryBullet,
        movement_task_active: _nbMovementTask,
        movement_flavor_active: _nbMovementFlavor,
        narrator_mode_active: _nbNarratorMode,
        soliloquy_active: _nbSoliloquy,
        continuity_injected: _continuityInjected,
        continuity_extraction_success: _continuityExtractionSuccess,
        continuity_evicted: _continuityEvicted,
        continuity_block_chars: _continuityBlock.length,
        continuity_snapshot: _continuityBlockSnapshot,
        continuity_block_text: _continuityBlock || null,  // v1.85.41: faithful record of what narrator received regardless of eviction state
        bridge_constraint_block: _objectOperationBridgeBlock || null,  // v1.91.73: rendered [OBJECT OPERATION RESULT] block as supplied to narrator
        continuity_diagnostics: CB.getLastRunDiagnostics(), // v1.70.0
        engine_spatial_notes: _engineSpatialBlock || null,
        extraction_packet: _extractionPacket,    // v1.66.0: post-freeze canonical archive (reused by history assembler — never recomputed)
        dm_note_archived:  _dmNoteArchived,       // v1.66.0: dm_note verbatim at turn completion
        dm_note_status:    _dmNoteStatus,          // v1.66.0: 'updated' | 'preserved_missing' | 'new_game'
        condition_bot:     { ran: _conditionBotRan, ...(_conditionBotStats) },
        state_attrs_suppressed: _cbMeta.stateAttrsSuppressed ?? 0,  // v1.84.31: # state: facts aged out this turn
        authority_gate: _authorityGateResult ? {             // v1.88.0
          decision:                   _authorityGateResult.decision,
          route:                      _authorityGateResult.route,
          rc_allowed:                 _authorityGateResult.rc_allowed,
          input_type:                 _authorityGateResult.input_type,
          reason_code:                _authorityGateResult.reason_code,
          gate_fast_path_hit:         _authorityGateResult.gate_fast_path_hit ?? null,
          llm_called:                 _authorityGateResult._llm_called ?? false,
          llm_confidence:             _authorityGateResult.llm_confidence ?? null,
          parsed_action:              _parsedAction,
          referenced_objects:         _authorityGateResult.referenced_objects,
          referenced_entities:        _authorityGateResult.referenced_entities,
          referenced_abilities:       _authorityGateResult.referenced_abilities,
          evidence_supported:         _authorityGateResult.evidence?.engine_supported ?? null,
          authority_gate_duration_ms: _agDurationMs,
        } : null,
        cb_schema_drift: _cbSchemaDrift.length > 0 ? _cbSchemaDrift : undefined,  // v1.88.40
      },
      logs: turnLogs,
      reality_check: {
        fired: _realityAnchor !== null,
        skipped_reason: _rcSkippedReason || null,
        query: _realityQuery || null,
        result: _realityAnchor || null,
        raw_response: _rcRawResponse || null,
        anchor_block: _realityAnchorBlock || null
      },
      stage_times: {
        rc_start: _rcStart,
        rc_end: _rcEnd,
        narrator_start: _narratorStart,
        narrator_end: _narratorEnd
      },
      object_reality: _objectRealityDebug,  // v1.84.54: frozen for get_turn_data + trace_object
      // v1.91.XX: Phase 5 — frozen witness/TLS diagnostic archive
      item_operation_witness:   _cloneForArchive(debug.itemOperationWitness),
      tls_proposed_operation:   _cloneForArchive(debug.tls_proposed_operation),
      tls_instruction:          _cloneForArchive(debug.tls_instruction),
      tls_instruction_v1:       _cloneForArchive(debug.tls_instruction_v1),  // v1.91.59: P2 v1 sibling
      tls_ors_alignment:        _cloneForArchive(debug.tls_ors_alignment),
      tls_executor_dry_run:     _cloneForArchive(debug.tls_executor_dry_run),  // v1.91.64: P4 dry-run envelope
      tls_execution_result:     _cloneForArchive(debug.tls_execution_result),
      tls_partial_stack_result: _cloneForArchive(_tlsPartialStackArchive ?? null),  // v1.91.71: P5-A2 live TLS partial-stack result
      object_operation_bridge:  _cloneForArchive(debug.object_operation_bridge),
      p5_witness_archive:       _p5Snapshot,                                // v1.91.66: P5-0 immutable evidence archive
      // Diagnostic capture — SemanticParser failure evidence
      parser_error:            debug.parser_error            || null,
      parser_error_code:       debug.parser_error_code       || null,
      parser_error_confidence: debug.parser_error_confidence ?? null,
      parser_raw_content:      debug.parser_raw_content      || null,
    };
    
    // Store turn object in turn history
    gameState.turn_history.push(turnObject);
    delete gameState._tlsPartialStackResult;

    // v1.85.98: Background flight recorder append — JSONL archive per session per day
    // Path: logs/flight-recorder/YYYY-MM-DD/session_{id}.jsonl — one line per turn, append-only
    {
      const _flDate = new Date().toISOString().slice(0, 10);
      const _flSafeId = String(resolvedSessionId).replace(/[^a-zA-Z0-9_-]/g, '_');
      const _flDir = path.join(__dirname, 'logs', 'flight-recorder', _flDate);
      const _flLine = JSON.stringify({ timestamp: new Date().toISOString(), session_id: resolvedSessionId, turn: turnNumber, turnObject }) + '\n';
      fsPromises.mkdir(_flDir, { recursive: true })
        .then(() => fsPromises.appendFile(path.join(_flDir, 'session_' + _flSafeId + '.jsonl'), _flLine, 'utf8'))
        .catch(err => console.warn('[FLIGHT-LOG] write failed:', err.message));
    }

    // Mirror RC data onto debug so harness assertions on debug.reality_check.fired/result resolve correctly.
    // turnObject.reality_check is the canonical frozen record; no re-derivation needed.
    debug.reality_check = turnObject.reality_check;
    // Mirror narration_debug onto debug so harness assertions on debug.narration_debug.* resolve correctly.
    debug.narration_debug = turnObject.narration_debug;

    // v1.84.21: Atomic payload archive write — single write after all stage snapshots are final
    if (!gameState.payload_archive) gameState.payload_archive = {};
    gameState.payload_archive[turnNumber] = {
      turn: turnNumber,
      timestamp: new Date().toISOString(),
      pipeline: {
        authority_gate:   _agPayloadSnapshot          || null,
        reality_check:    _rcPayloadSnapshot          || null,
        narrator:         _narratorPayloadSnapshot    || null,
        continuity_brain: _cbPayloadSnapshot          || null,
        condition_bot:    _conditionBotPayloadSnapshot || null
      }
    };
    
    // Persist updated gameState with turn history
    sessionStates.set(resolvedSessionId, { ...sessionStates.get(resolvedSessionId), gameState, isFirstTurn, logger });

    // v1.84.21: Background payload archive write — separate file to keep autosave.json lean
    // TODO: rolling cap at 200 turns if payload_archive.json grows too large
    fsPromises.mkdir(path.join(__dirname, 'saves', resolvedSessionId), { recursive: true })
      .then(() => fsPromises.writeFile(
        path.join(__dirname, 'saves', resolvedSessionId, 'payload_archive.json'),
        JSON.stringify(gameState.payload_archive)
      ))
      .catch(err => console.warn('[PAYLOAD-ARCHIVE] write failed:', err.message));

    // [DIAG-1] Log before returning response
    // C1 (v1.46.0): Phase 3/5b debug instrumentation — narrator mode, emote, do-intent, say target source, pre-speech
    debug.narrator_mode_active = !!_narratorModeBlock;
    debug.do_intent_active = !!_doIntentBlock;
    debug.emote_detected = /\*[^*]+\*/.test(_rawInput);
    debug.say_target_source = resolvedChannel === 'say'
      ? (_rawNpcTarget ? 'interceptor' : (_npcTalkResult?.outcome === 'matched' ? 'parser' : null))
      : null;
    debug.pre_speech_context_present = !!_rawPreSpeech;
    // v1.50.0: Observability for v1.47.0–1.49.0 narration blocks
    debug.expressive_block_active = _expressiveBlock !== '';
    debug.freeform_block_active = _freeformBlock !== '';
    debug.bridge_constraint_active = debug.object_operation_bridge?.diagnostics?.constraint_supplied ?? false;
    debug.movement_flavor_active = _movementFlavorBlock !== '';
    debug.soliloquy_active = _soliloquyBlock !== '';
    // v1.52.0: Narration task override observability
    debug.movement_task_active = _movementTaskBlock !== '';
    debug.look_task_active = _lookTaskBlock !== '';
    debug.exit_task_active = _exitTaskBlock !== '';
    // v1.53.0: Primary narration bullet override observability
    debug.primary_bullet_override = (_parsedAction === 'move' || _parsedAction === 'look' || _parsedAction === 'exit') ? _parsedAction : null;
    console.log('[DIAG-1-SERVER-BEFORE-RESPONSE] resolvedSessionId:', resolvedSessionId);
    console.log('[DIAG-1-SERVER-BEFORE-RESPONSE] Type:', typeof resolvedSessionId);
    console.log('[DIAG-1-SERVER-BEFORE-RESPONSE] Will be included in response JSON');

    // ── Token accounting (v1.64.x) ──────────────────────────────────────────
    // Prompt section char measurement (all variables in scope here)
    const _promptContinuityChars = _continuityBlock.length;
    const _promptSpatialChars    = (_engineSpatialBlock || '').length;
    const _promptTotalChars      = narrationContent ? narrationContent.length : 0;
    const _promptBaseChars       = _promptTotalChars - _promptContinuityChars - _promptSpatialChars;
    diag.setNarratorPromptStats({
      total_chars:       _promptTotalChars,
      base_chars:        Math.max(0, _promptBaseChars),
      continuity_chars:  _promptContinuityChars,
      spatial_chars:     _promptSpatialChars,
      continuity_injected: _continuityInjected,
      continuity_evicted:  _continuityEvicted,
      narrator_usage:    _narratorUsage || null,  // { prompt_tokens, completion_tokens, total_tokens }
    }); // cache for buildDebugContext Mother Brain context

    // System totals (null-safe — falls back to char/4 estimate in renderer)
    const _narratorTok  = _narratorUsage?.total_tokens    ?? null;
    const _parserTok    = _parserUsage?.total_tokens      ?? null;
    const _systemTokTotal = _narratorTok !== null ? _narratorTok + (_parserTok || 0) : null; // parser null = cached = 0 cost
    const _contGrowthChars = _continuityBlock.length;
    const _priorMemCount   = (gameState.world.narrative_memory || []).length;
    const _priorMemChars   = (gameState.world.narrative_memory || []).reduce((s, m) => {
      try { return s + JSON.stringify(m).length; } catch (_) { return s; }
    }, 0);

    // Delta and rolling average from history
    const _dh              = diag.getDiagHistory();
    const _prevEntry       = _dh.length > 0 ? _dh[_dh.length - 1] : null;
    const _deltaTok        = (_systemTokTotal !== null && _prevEntry?.system_total != null) ? _systemTokTotal - _prevEntry.system_total : null;
    const _deltaContChars  = _prevEntry != null ? _contGrowthChars - _prevEntry.cont_chars : null;
    const _last5           = _dh.slice(-5).filter(e => e.system_total != null);
    const _avg5            = _last5.length > 0 ? Math.round(_last5.reduce((s, e) => s + e.system_total, 0) / _last5.length) : null;

    // Emit to SSE diagnostics stream (flight-recorder.js terminal client)
    const _turnViolations = (() => {
      const v = [];
      if (_parsedAction === 'move' && debug.parser !== 'legacy' && !debug.degraded_from && !debug.freeform_block_active && !movement) v.push('move: no movement object');
      if (_continuityExtractionSuccess === false) v.push('continuity extraction failed');
      if (!_continuityInjected && !_continuityEvicted && turnNumber > 1) v.push('no continuity context (not eviction)');
      if (resolvedChannel === 'say' && debug.freeform_block_active) v.push('say + FREEFORM contradiction');
      if (resolvedChannel === 'do' && debug.narrator_mode_active) v.push('do + NARRATOR_MODE contradiction');
      if (debug.soliloquy_active && debug.narrator_mode_active) v.push('SOLILOQUY + NARRATOR_MODE contradiction');
      return v;
    })();
    diag.emitDiagnostics({
      type: 'turn',
      turn: turnNumber,
      raw_input: action,
      channel: resolvedChannel,
      parsed_action: _parsedAction,
      parsed_dir: inputObj?.player_intent?.dir || null,
      confidence: debug.confidence || null,
      parser: debug.parser,
      degraded: debug.degraded_from || null,
      spatial: {
        depth: gameState.world.active_local_space ? 3 : gameState.world.active_site ? 2 : 1,
        position: gameState.world.position || null,
        site_name: gameState.world.active_site?.name || null,
        local_space_name: gameState.world.active_local_space?.name || null
      },
      movement: movement || null,
      continuity: {
        injected: _continuityInjected,
        block_chars: _continuityBlock.length,
        evicted: _continuityEvicted,
        eviction_reason: _continuityEvictionReason || null,
        extraction_success: _continuityExtractionSuccess,
        rejection_reason: NC.getLastRunDiagnostics()?.rejection_reason || null,
        prior_memory_count: _priorMemCount,
        snapshot: _continuityBlockSnapshot,
        alerts: NC.getLastRunDiagnostics()?.alerts || [],
        entity_updates: NC.getLastRunDiagnostics()?.entity_updates_applied || [],
        entity_cleared: NC.getLastRunDiagnostics()?.entity_continuity_cleared || []
      },
      tokens: {
        narrator: {
          prompt:     _narratorUsage?.prompt_tokens     ?? null,
          completion: _narratorUsage?.completion_tokens ?? null,
          total:      _narratorUsage?.total_tokens      ?? null
        },
        parser: {
          prompt:     _parserUsage?.prompt_tokens     ?? null,
          completion: _parserUsage?.completion_tokens ?? null,
          total:      _parserUsage?.total_tokens      ?? null
        },
        system_total: _systemTokTotal,
        delta:        _deltaTok,
        avg5:         _avg5,
        breakdown: {
          base_chars:        Math.max(0, _promptBaseChars),
          continuity_chars:  _promptContinuityChars,
          spatial_chars:     _promptSpatialChars,
          output_chars:      narrative?.length || 0
        }
      },
      continuity_growth: {
        block_chars:         _contGrowthChars,
        block_tokens_est:    Math.round(_contGrowthChars / 4),
        delta_chars:         _deltaContChars,
        prior_memory_count:  _priorMemCount,
        prior_memory_chars:  _priorMemChars
      },
      entities: {
        visible: (gameState.world.active_local_space?._visible_npcs || gameState.world.active_site?._visible_npcs || []).map(n => ({ id: n.id, job: n.job_category || null, name: n.npc_name || null }))
      },
      narration_length: narrative?.length || 0,
      narrator_status: _narratorStatus,
      player_extraction: _playerExtraction,
      engine_message: _engineMsg || null,
      violations: _turnViolations,
      gameSessionId: resolvedSessionId,
      watch_message: _watchMessageThisTurn || null
    });

    // v1.80.0: Mother Watch — full-context async scan, fires after turn event, never blocks game
    ;(async () => {
      try {
        const _wCtx = diag.buildDebugContext(gameState, 'detailed');
        // Strip VISIBLE CELLS section — terrain subtype variation is normal engine behavior,
        // not a fault surface. Mother Brain chat still receives the full context.
        const _wCtxScan = _wCtx.replace(/(?:\r?\n)?=== VISIBLE CELLS \(Sample\) ===[\s\S]*?(?=\r?\n===|$)/, '');
        const _wResp = await axios.post('https://api.deepseek.com/v1/chat/completions', {
          model: 'deepseek-v4-flash',
          thinking: { type: 'disabled' },
          temperature: 0.3,
          max_tokens: 1500,
          messages: [
            { role: 'system', content: 'Turn 1 is not a normal declaration. It is the world founding phase. Player input on Turn 1 is treated as founding premise, not as an action and not as a constrained state declaration. During this phase, the player may define their identity, form, starting location, possessions, status, and scenario conditions without restriction. Any statement that defines who the player is, what they possess, where they are, or what conditions they start under is a valid founding premise — regardless of its content, genre, or apparent implausibility. No founding input is cheating, invalid, or to be rejected. The system must interpret these inputs into structured starting state, record them in the player\'s birth record, and treat them as real starting conditions. Physical, spatial, and logistical constraints still apply, NPCs are not required to believe social claims, and all consequences are enforced through simulation rather than restriction. The goal of this phase is maximum expressive freedom at world creation, with consequences emerging naturally from the world.\n\nAfter Turn 1, the world is locked. Player declarations are now constrained. They may clarify the player\'s self-state, including posture, condition, appearance, and activity, but they may not create inventory, teleport the player, grant authority or status, rewrite location, create NPCs or world objects, or directly alter world state. Statements that assert new possessions, claimed authority, new locations, or altered world state must not directly become truth unless supported by existing engine state or resolved through action systems. All founding premise data is stored in the player container under a birth record, which represents the conditions under which the player entered the world. This record is authoritative for initial identity, context, possessions, and claims. Narration must treat validated birth facts as real while allowing the world, including NPC behavior, physics, and constraints, to respond accordingly.\n\nThe player is free to attempt any action, express any idea, or describe any behavior at any time. There are no restricted verbs, no required formats, and no limit to creative expression. Freeform action is the primary mode of interaction, not a fallback. Every input from the player is treated as a genuine attempt to act within the world. Attempt is always allowed. Outcome is never guaranteed.\n\nAll actions exist within a world that has consequences. Objects have weight, volume, and presence. Locations impose constraints. NPCs observe, react, interpret, and respond according to their own perspective and the visible state of the world. Claims of authority, identity, or status do not automatically become accepted truth; they are treated as part of the player\'s expression and are subject to validation or rejection by the world through social and physical response. The system does not enforce balance through restriction. Instead, it enforces reality through consequence. Freedom of input is absolute, but reality is not negotiable.\n\nSTATE DECLARATIONS: state_declare is a valid parsed action type — not a fault. action_resolution: state_declared = not a fault. player.attributes entries with source:declared = engine-validated player assertions, not a fault. A birth_record field on the player container = expected founding data, not a fault. Turn 1 founding premise facts are unrestricted by design — do not flag Turn 1 player.attributes as excessive or invalid regardless of content.\n\n---\n\nYou are a single-turn fault scanner for a text RPG engine, operating with the same diagnostic standards as Mother Brain. After every game turn you receive one snapshot of the full engine diagnostic state. Scan it for genuine faults using the rules below. List every genuine fault — one sentence per fault. If nothing is genuinely wrong, output exactly one sentence saying so. No headers, no preamble, no explanation. Do not report a blank or legacy field as a fault unless one of the rules below explicitly identifies it as a fault.\n\nCOORDINATE SYSTEM: The engine uses a two-tier coordinate system — macro grid (mx/my, valid range 0–7) and local grid within each macro cell (lx/ly, valid range 0–127, 128x128 grid per macro cell). Coordinates within these ranges are valid and normal — do not flag them as anomalies.\n\nSITE INTERIOR STATE — context format: each site slot line reads: site_id | name | slot_identity:VAL | enterable:YES/NO | filled:YES/NO | interior:STATE. The label is slot_identity (not identity) — it reflects the canonical cell.sites slot field. slot_identity:(null) means the identity has not been filled yet.\n\nSITE INTERIOR STATE — fault classification: MISSING_INTERIOR_KEY (filled but interior_key absent) = fault. MISSING_INTERIOR_RECORD (interior_key present but no world.sites mirror) = fault. PENDING_FILL while the player is currently inside the site = fault. PENDING_FILL pre-entry (player not yet inside) = normal. NOT_GENERATED (player has not yet entered) = normal. GENERATED (full site record) = normal.\n\nIS_FILLED RULE: is_filled=true requires all three fields to be non-null in the slot: name, description, and slot_identity. A site showing filled:NO when name is populated but slot_identity:(null) is a partial fill fault. A site showing filled:NO when name is also null is simply unfilled — not a partial fill fault.\n\nSITE PARTIAL FILL: If a site record shows slot_identity:(null) while name is populated — fault (applies to v1.83.4+ saves; pre-v1.83.4 saves may legitimately have name without slot_identity as an expected migration state, not a fault).\n\nACTIVE LOCAL SPACE: If the player is at depth 3 (inside a local space) and the active local space shows name === null or description === null — fault. The player is inside an unnamed or undescribed space.\n\nL2-START FILL PIPELINE: On L2-direct-start sessions, [L2-START-SITE-FILL] fires before enterSite on turn 1 to fill the starting site slot. This is expected and normal. If [L2-START-SITE-FILL] fails, the server returns error: site_fill_failed — this is a fault. If the DeepSeek response was missing the identity field, fill_log will show error_label: missing_identity — this is a fault.\n\nNARRATION GATE: [NARRATION-GATE] enforces canonical slot completeness before every narration call. If the active site slot is missing name, description, or slot_identity, narration is blocked and the server returns error: site_incomplete — fault. If the canonical slot cannot be resolved via interior_key lookup, the server returns error: site_state_integrity_failure — fault.\n\nB3 REMOVAL: The B3 hash name generator (generateSiteName) was fully removed in v1.83.4. Any [B3-NAME] or [B3-CALLER] log entry is a regression if it appears in a v1.83.4+ session — flag as fault.\n\nCB WARNINGS: UNRESOLVED (entity ref could not be matched to any visible NPC) = fault and candidate narrator hallucination. ContinuityBrain extracted an entity from narration but could not match it to any visible NPC — the narrator introduced an entity not grounded in visible engine state. Report as: candidate hallucination — narrator described [entity_ref], but no matching NPC exists in visible engine registry. The UNRESOLVED signal alone is the sufficient trigger — do not re-examine narration text beyond identifying the entity_ref. FUZZY (entity ref matched via approximate matching) = not a fault, but note it for verification. L0-SKIP (l0_entity_candidates_skipped) = expected behavior at the overworld layer, not a fault.\n\nL0 BEHAVIOR: An empty TRUTH block at L0 when the player just moved to a new cell is correct engine behavior — not a fault.\n\nNARRATOR FAILURES: A NARRATION FAILED entry in the flight recorder = fault. narrator_status:malformed (narrator returned no usable content) = fault. narrator_status:ok = normal.\n\nACTION RESOLUTION: NO_POSITION (world.position unavailable) = fault. ENGINE_GUARD (depth=3 with no active_local_space) = fault. NO_RESOLVE_LOG (player_move_resolved never called) = fault. NO_DIRECTION / VOID_CELL / L2_BOUNDARY = normal gameplay blocks, not faults.\n\nARBITER: After every narration freeze, an Arbiter IIFE fires async and emits an arbiter_verdict SSE event. arbiter_verdict absent this turn = fault. reputation_player on any NPC outside 0-100 = fault. An arbiter_verdict error field present = fault (Arbiter call failed). Arbiter also governs is_learned (name learning) via is_learned_changes in arbiter_verdict — applied:false reason:name_mismatch = fault (Arbiter proposed a name that does not match the engine record); applied:false reason:npc_not_visible = warn; applied:false reason:ambiguous = normal (ambiguity guard fired, not a fault).\n\nNPC FILL PIPELINE: [NPC-FILL] fires each turn before narration to fill DS-owned identity fields (npc_name, gender, age, job_category) for newly-born NPCs. An NPC with _fill_error set = fill failed that turn (warn — retries next turn). An NPC with all four DS fields null and no _fill_error = fill pending (normal on first turn at a new site). An NPC with _fill_frozen:true = fill complete, correct state. Narrator receiving npc_name:null for an NPC is correct context stripping (player has not learned the name) — not a fill fault.\n\nREALITY CHECK: Before each narration turn (except Turn 1 and skip-action turns: move/look/wait/enter/exit), a blocking awaited Reality Check call fires and emits a reality_check SSE event. The check queries DeepSeek with the player\'s raw input and freezes the adjudicated consequence as the final authority block in the narrator\'s prompt. reality_check absent on a non-skip turn = fault. reality_check fired:true with result:null = fault (DS call failed — turn should have halted with REALITY_CHECK_FAILED). reality_check fired:false with skipped_reason present = normal skip, not a fault. skipped_reason:state_claim = non-executable input (player assertion, not an engine action) — correct skip, not a fault.' },
            { role: 'user', content: `Scan this turn for genuine faults. List every fault found, one sentence each. If nothing is wrong, say so in one sentence.\n\n${_wCtxScan}` }
          ]
        }, {
          headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
          httpsAgent: _sharedHttpsAgent,
          timeout: 30000
        });
        const _wRaw = _wResp?.data?.choices?.[0]?.message?.content || '(no response)';
        const _wLines = _wRaw.split('\n').map(l => l.trim()).filter(Boolean);
        // Capture usage — log shape once on first call to confirm DeepSeek field names
        const _wUsage = _wResp?.data?.usage || null;
        if (!_wUsageShapeLogged) {
          console.log('[WATCH] usage object shape:', JSON.stringify(_wUsage));
          _wUsageShapeLogged = true;
        }
        const _wPromptTok      = _wUsage?.prompt_tokens           ?? 0;
        const _wCompletionTok  = _wUsage?.completion_tokens        ?? 0;
        const _wTotalTok       = _wUsage?.total_tokens             ?? 0;
        const _wCacheHitTok    = _wUsage?.prompt_cache_hit_tokens  ?? 0;
        const _wCacheMissTok   = _wUsage?.prompt_cache_miss_tokens ?? 0;
        // Cost: use cache breakdown if present, else treat all input as cache miss (conservative)
        const _wEstCost = _wCacheHitTok > 0 || _wCacheMissTok > 0
          ? (_wCacheHitTok * 0.000000028) + (_wCacheMissTok * 0.00000014) + (_wCompletionTok * 0.00000028)
          : (_wPromptTok   * 0.00000014)  + (_wCompletionTok * 0.00000028);
        diag.emitDiagnostics({ type: 'watch_verdict', turn: turnNumber, lines: _wLines, gameSessionId: resolvedSessionId,
          usage: { prompt_tokens: _wPromptTok, completion_tokens: _wCompletionTok, total_tokens: _wTotalTok,
                   cache_hit_tokens: _wCacheHitTok, cache_miss_tokens: _wCacheMissTok, est_cost_usd: _wEstCost } });
      } catch (e) {
        diag.emitDiagnostics({ type: 'watch_verdict', turn: turnNumber, lines: [`[scan failed: ${e.message}]`], gameSessionId: resolvedSessionId,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cache_hit_tokens: 0, cache_miss_tokens: 0, est_cost_usd: 0 } });
      }
    })();

    // v1.84.0: Arbiter — post-narration consequence engine (NPC reputation only, MVP)
    // v1.85.64: awaited — Arbiter is an authoritative state writer (reputation, recognition, name-learning, form).
    // A turn is not complete until Arbiter has written its verdict. Fire-and-forget caused timing race where
    // res.json() serialized _lastArbiterVerdict before the DeepSeek call returned. Now awaited inline.
    await (async () => {
      try {
        const _arbVisibleNpcs = (gameState.world.active_local_space?._visible_npcs || gameState.world.active_site?._visible_npcs || gameState.world._visible_npcs || []); // v1.88.4: L0 fallback — BORN-NPC at overworld depth now visible to Arbiter
        // v1.85.19: Option B — skip early-return when player has a declared transformation capability (so form-change can write through on solo turns)
        const _hasTransformCapability = Object.values(gameState?.player?.attributes || {})
          .some(a => a.bucket === 'declared' && /transform|shapeshift|change.form|alter.form|become/i.test(a.value));
        if (_arbVisibleNpcs.length === 0 && !_hasTransformCapability) {
          diag.emitDiagnostics({ type: 'arbiter_verdict', turn: turnNumber, reputation_changes: [], is_learned_changes: [], player_recognition_changes: [], player_form_change: null, gameSessionId: resolvedSessionId });
          // Invariant: every Arbiter pass leaves a verdict object. "Found nothing to do" is still a verdict.
          gameState._lastArbiterVerdict = { turn: turnNumber, raw: null, applied: { reputation_changes: [], is_learned_changes: [], player_recognition_changes: [], player_form_change: null } };
          return;
        }
        const _arbNpcRegistry = _arbVisibleNpcs.map(n => ({
          npc_id: n.id,
          npc_name: (n.is_learned && n.npc_name) ? n.npc_name : `(${n.job_category || 'unknown'})`,
          job: n.job_category || null,
          reputation_player: n.reputation_player ?? 50,
          traits: Array.isArray(n.traits) ? n.traits.slice(0, 5) : []
        }));
        const _arbSiteName = gameState.world.active_local_space?.name || gameState.world.active_site?.name || null;
        const _arbDepthLabel = ['L0', 'L1', 'L2', 'L3'][_sfDepth] || `depth ${_sfDepth}`;
        const _arbSystemMsg = `Turn 1 is not a normal declaration. It is the world founding phase. Player input on Turn 1 is treated as founding premise, not as an action and not as a constrained state declaration. During this phase, the player may define their identity, form, starting location, possessions, status, and scenario conditions without restriction. Any statement that defines who the player is, what they possess, where they are, or what conditions they start under is a valid founding premise — regardless of its content, genre, or apparent implausibility. No founding input is cheating, invalid, or to be rejected. The system must interpret these inputs into structured starting state, record them in the player's birth record, and treat them as real starting conditions. Physical, spatial, and logistical constraints still apply, NPCs are not required to believe social claims, and all consequences are enforced through simulation rather than restriction. The goal of this phase is maximum expressive freedom at world creation, with consequences emerging naturally from the world.\n\nAfter Turn 1, the world is locked. Player declarations are now constrained. They may clarify the player's self-state, including posture, condition, appearance, and activity, but they may not create inventory, teleport the player, grant authority or status, rewrite location, create NPCs or world objects, or directly alter world state. Statements that assert new possessions, claimed authority, new locations, or altered world state must not directly become truth unless supported by existing engine state or resolved through action systems. All founding premise data is stored in the player container under a birth record, which represents the conditions under which the player entered the world. This record is authoritative for initial identity, context, possessions, and claims. Narration must treat validated birth facts as real while allowing the world, including NPC behavior, physics, and constraints, to respond accordingly.\n\nThe player is free to attempt any action, express any idea, or describe any behavior at any time. There are no restricted verbs, no required formats, and no limit to creative expression. Freeform action is the primary mode of interaction, not a fallback. Every input from the player is treated as a genuine attempt to act within the world. Attempt is always allowed. Outcome is never guaranteed.\n\nAll actions exist within a world that has consequences. Objects have weight, volume, and presence. Locations impose constraints. NPCs observe, react, interpret, and respond according to their own perspective and the visible state of the world. Claims of authority, identity, or status do not automatically become accepted truth; they are treated as part of the player's expression and are subject to validation or rejection by the world through social and physical response. The system does not enforce balance through restriction. Instead, it enforces reality through consequence. Freedom of input is absolute, but reality is not negotiable.\n\n---\n\nYou are the Arbiter — a post-narration consequence engine for a text RPG. You have four responsibilities:\n\n1. REPUTATION: Evaluate whether any NPC's opinion of the player (reputation_player, 0-100, 50=neutral) should change.\n2. NAME LEARNING: Determine if the player learned an NPC's name this turn.\n3. PLAYER RECOGNITION: Determine if an NPC explicitly addressed or acknowledged the player by a specific name, title, or stated identity.\n4. FORM TRACKING: Detect whether the player's visible embodiment changed this turn.\n\nREPUTATION RULES:\n- Only change reputation for NPCs who were DIRECTLY involved in this turn (present, addressed, or observably affected).\n- Movement, exploration, and turns with no NPC interaction must produce an empty array.\n- Magnitude: trivial interaction ±1-3, meaningful ±4-8, significant social event ±9-15, exceptional ±16-20. Cap at ±25 per turn.\n- reason must be a terse factual phrase (max 10 words) describing what happened.\n\nNAME LEARNING RULES:\n- Only include an NPC in is_learned_changes if the narration explicitly shows the player learning their name via one of these event types: self_introduction, third_party_introduction, visible_label, document_or_record, direct_answer.\n- revealed_name must be the exact name as it appeared in the narration.\n- Do not infer name learning; it must be textually evident in the narration.\n- is_learned_changes is an empty array if no name was learned.\n\nPLAYER RECOGNITION RULES:\n- Emit an entry in player_recognition_changes when the narration explicitly shows an NPC addressing or acknowledging the player by a specific name, title, or stated identity.\n- event_type must be one of: name_addressed, title_used, identity_stated_by_npc, explicit_acknowledgment.\n- known_identity: the exact name, title, or label the NPC used when addressing or acknowledging the player.\n- evidence: a terse phrase or quote from the narration showing the acknowledgment (max 15 words).\n- Must be textually evident in the narration — do not infer.\n- player_recognition_changes is an empty array if no such event occurred.\n\nFORM TRACKING RULES:\n- Emit player_form_change ONLY when the narration confirms a COMPLETED visible embodiment change this turn — the player's outward appearance has definitively changed in a way NPCs would perceive differently.\n- Applies to any completed change: transformation, shapeshifting, disguise, costume change, or any mechanism that changes what NPCs see.\n- Does NOT apply to attempts, partial changes, or stated intentions that are not yet narrated as complete.\n- new_form: a short label describing the new visible form.\n- prior_form: what the form was before (include when inferrable from narration or context).\n- OMIT the player_form_change key entirely when no completed form change occurred this turn — never include it as null or empty.\n- EXCLUSIONS — the following are NOT form changes and must NEVER trigger player_form_change: empty-handed state or lack of held objects; failed inventory or possession claims; posture changes (crouching, reaching, kneeling, standing); equipment changes (putting on or removing clothing, accessories, or gear); emotional or expressive states (smiling, tired, tense, nervous); any transient physical condition that does not alter the player's fundamental visible shape or embodiment.\n\nReturn ONLY valid JSON. No prose, no explanation, no markdown fences.\n\nOUTPUT FORMAT (strict JSON only):\n{"reputation_changes":[{"npc_id":"...","delta":N,"reason":"..."}],"is_learned_changes":[{"npc_id":"...","revealed_name":"...","event_type":"self_introduction|third_party_introduction|visible_label|document_or_record|direct_answer","evidence":"..."}],"player_recognition_changes":[{"npc_id":"...","known_identity":"...","event_type":"name_addressed|title_used|identity_stated_by_npc|explicit_acknowledgment","evidence":"..."}],"player_form_change":{"new_form":"...","prior_form":"..."}}\nBaseline when no changes and no form change: {"reputation_changes":[],"is_learned_changes":[],"player_recognition_changes":[]}\nOmit player_form_change entirely when no completed form change occurred.`;
        const _arbUserMsg = `PLAYER ACTION: "${_rawInput}" (parsed: ${_parsedAction || 'unknown'})\nNARRATION: ${narrative}\nNPC REGISTRY: ${JSON.stringify(_arbNpcRegistry)}\nLOCATION: ${_arbDepthLabel}${_arbSiteName ? ` / ${_arbSiteName}` : ''}\n\nEvaluate this turn. Return JSON only.`;
        const _arbResp = await axios.post('https://api.deepseek.com/v1/chat/completions', {
          model: 'deepseek-v4-flash',
          thinking: { type: 'disabled' },
          temperature: 0.3,
          max_tokens: 800,
          messages: [
            { role: 'system', content: _arbSystemMsg },
            { role: 'user', content: _arbUserMsg }
          ]
        }, {
          headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
          httpsAgent: _sharedHttpsAgent,
          timeout: 30000
        });
        const _arbRaw = _arbResp?.data?.choices?.[0]?.message?.content || '{}';
        let _arbParsed = null;
        try {
          const _arbClean = _arbRaw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
          _arbParsed = JSON.parse(_arbClean);
        } catch (_) {
          _arbParsed = { reputation_changes: [], is_learned_changes: [] };
        }
        // --- Reputation changes ---
        const _arbChanges = Array.isArray(_arbParsed?.reputation_changes) ? _arbParsed.reputation_changes : [];
        const _arbApplied = [];
        for (const change of _arbChanges) {
          if (!change.npc_id || typeof change.delta !== 'number') continue;
          const _npc = _arbVisibleNpcs.find(n => n.id === change.npc_id);
          if (_npc) {
            const _old = _npc.reputation_player ?? 50;
            _npc.reputation_player = Math.max(0, Math.min(100, _old + change.delta));
            _arbApplied.push({ npc_id: change.npc_id, old_val: _old, new_val: _npc.reputation_player, delta: change.delta, reason: change.reason || '' });
          }
        }
        // --- is_learned changes ---
        const _ALLOWED_EVENT_TYPES = ['self_introduction','third_party_introduction','visible_label','document_or_record','direct_answer'];
        const _arbLearnChanges = Array.isArray(_arbParsed?.is_learned_changes) ? _arbParsed.is_learned_changes : [];
        const _arbLearnApplied = [];
        for (const lc of _arbLearnChanges) {
          if (!lc.npc_id || !lc.revealed_name || !lc.event_type) continue;
          if (!_ALLOWED_EVENT_TYPES.includes(lc.event_type)) {
            console.warn(`[ARBITER] is_learned rejected — unknown event_type="${lc.event_type}" for npc_id=${lc.npc_id}`);
            continue;
          }
          const _lnpc = _arbVisibleNpcs.find(n => n.id === lc.npc_id);
          if (!_lnpc) {
            console.warn(`[ARBITER] is_learned rejected — npc_id=${lc.npc_id} not in visible set`);
            continue;
          }
          if (!_lnpc.npc_name) {
            console.warn(`[ARBITER] is_learned rejected — npc_id=${lc.npc_id} has no npc_name (fill pending?)`);
            continue;
          }
          // v1.87.1: two-tier match — exact full name OR first-token only ("Elara" matches "Elara Thorne")
          const _revLower = String(lc.revealed_name).toLowerCase().trim();
          const _canonLower = _lnpc.npc_name.toLowerCase().trim();
          const _firstToken = _canonLower.split(/\s+/)[0];
          const _exactMatch = _revLower === _canonLower;
          const _firstTokenMatch = !_exactMatch && _revLower === _firstToken;
          if (!_exactMatch && !_firstTokenMatch) {
            console.warn(`[ARBITER] name_mismatch — npc_id=${lc.npc_id} engine="${_lnpc.npc_name}" arbiter="${lc.revealed_name}"`);
            _arbLearnApplied.push({ npc_id: lc.npc_id, revealed_name: lc.revealed_name, event_type: lc.event_type, applied: false, reason: 'name_mismatch' });
            continue;
          }
          _lnpc.is_learned = true;
          // learned_name = what the player actually heard; canonical npc_name unchanged
          _lnpc.learned_name = _exactMatch ? _lnpc.npc_name : lc.revealed_name;
          _arbLearnApplied.push({ npc_id: lc.npc_id, revealed_name: lc.revealed_name, event_type: lc.event_type, applied: true, match_tier: _exactMatch ? 'exact' : 'first_token' });
          console.log(`[ARBITER] is_learned=true (${_exactMatch ? 'exact' : 'first-name'} match) for npc_id=${lc.npc_id} learned_name="${_lnpc.learned_name}" canonical="${_lnpc.npc_name}" event=${lc.event_type}`);
        }
        // --- player_recognition_changes ---
        const _ALLOWED_RECOGNITION_TYPES = ['name_addressed','title_used','identity_stated_by_npc','explicit_acknowledgment'];
        const _arbRecChanges = Array.isArray(_arbParsed?.player_recognition_changes) ? _arbParsed.player_recognition_changes : [];
        const _arbRecApplied = [];
        for (const rc of _arbRecChanges) {
          if (!rc.npc_id || !rc.known_identity || !rc.event_type) continue;
          if (!_ALLOWED_RECOGNITION_TYPES.includes(rc.event_type)) {
            console.warn(`[ARBITER] player_recognition rejected — unknown event_type="${rc.event_type}" for npc_id=${rc.npc_id}`);
            continue;
          }
          const _rnpc = _arbVisibleNpcs.find(n => n.id === rc.npc_id);
          if (!_rnpc) {
            console.warn(`[ARBITER] player_recognition rejected — npc_id=${rc.npc_id} not in visible set`);
            continue;
          }
          // v1.87.1: allow refinement from generic pronoun/label -> specific name
          const _GENERIC_RECOGNITION_TOKENS = new Set(['you','they','them','it','stranger','traveler','someone','the player','player']);
          if (_rnpc.player_recognition) {
            const _existingIdentity = (_rnpc.player_recognition.known_identity || '').toLowerCase().trim();
            if (!_GENERIC_RECOGNITION_TOKENS.has(_existingIdentity)) {
              // Already has a real name — idempotent, don't overwrite
              _arbRecApplied.push({ npc_id: rc.npc_id, known_identity: rc.known_identity, event_type: rc.event_type, applied: false, reason: 'already_recognized' });
              continue;
            }
            // Existing identity is generic — allow refinement to more specific name
            console.log(`[ARBITER] player_recognition refined: "${_rnpc.player_recognition.known_identity}" -> "${rc.known_identity}" for npc_id=${rc.npc_id}`);
          }
          _rnpc.player_recognition = { recognizes_player: true, known_identity: rc.known_identity, learned_turn: turnNumber, source: rc.event_type };
          _arbRecApplied.push({ npc_id: rc.npc_id, known_identity: rc.known_identity, event_type: rc.event_type, applied: true });
          console.log(`[ARBITER] player_recognition set for npc_id=${rc.npc_id} known_as="${rc.known_identity}" event=${rc.event_type}`);
        }
        // --- player_form_change ---
        const _arbFormChange = _arbParsed?.player_form_change;
        let _arbFormApplied = null;
        if (_arbFormChange?.new_form) {
          const _badFormPattern = /^empty[\s-]?hand|^empty[\s-]?pocket|^bare[\s-]?hand|^holding nothing|^unarmed|^no\s+item|^without/i;
          if (_badFormPattern.test(_arbFormChange.new_form)) {
            console.log(`[ARBITER] form change REJECTED — "${_arbFormChange.new_form}" is transient state, not identity form`);
          } else {
            if (!gameState.player.identity) {
              gameState.player.identity = { canonical_name: null, title_or_role: null, current_form: null, last_known_form: null, aliases: [], public_identity_known: false };
            }
            const _priorForm = gameState.player.identity.current_form;
            gameState.player.identity.current_form = _arbFormChange.new_form;
            gameState.player.identity.last_known_form = _arbFormChange.new_form; // v1.86.0: persists until next valid Arbiter form write
            _arbFormApplied = { new_form: _arbFormChange.new_form, prior_form: _priorForm };
            if (_priorForm && _priorForm !== _arbFormChange.new_form) {
              console.log(`[ARBITER] form OVERWRITE: "${_priorForm}" -> "${_arbFormChange.new_form}"`);
            } else {
              console.log(`[ARBITER] player form: ${_priorForm} -> ${_arbFormChange.new_form}`);
            }
          }
        }
        diag.emitDiagnostics({ type: 'arbiter_verdict', turn: turnNumber, reputation_changes: _arbApplied, is_learned_changes: _arbLearnApplied, player_recognition_changes: _arbRecApplied, player_form_change: _arbFormApplied, gameSessionId: resolvedSessionId });
        _reportProgress('world_update', 91, {});
        gameState._lastArbiterVerdict = { turn: turnNumber, raw: _arbParsed, applied: { player_form_change: _arbFormApplied, player_recognition_changes: _arbRecApplied } }; // v1.85.21: forensic — raw=what Arbiter emitted, applied=what engine wrote
      } catch (e) {
        diag.emitDiagnostics({ type: 'arbiter_verdict', turn: turnNumber, reputation_changes: [], is_learned_changes: [], player_recognition_changes: [], player_form_change: null, error: e.message, gameSessionId: resolvedSessionId });
        gameState._lastArbiterVerdict = { turn: turnNumber, raw: null, error: String(e?.message || e), applied: { reputation_changes: [], is_learned_changes: [], player_recognition_changes: [], player_form_change: null } };
      }
    })();

    // v1.88.22: persist Arbiter verdict into turn archive for forensic tooling
    if (gameState.turn_history?.length) gameState.turn_history[gameState.turn_history.length - 1].arbiter_verdict = gameState._lastArbiterVerdict ?? null;

    // v1.86.0: Background autosave — moved post-Arbiter so last_known_form / current_form are captured after write-back
    fsPromises.mkdir(path.join(__dirname, 'saves', resolvedSessionId), { recursive: true })
      .then(() => fsPromises.writeFile(
        getAutosavePath(resolvedSessionId),
        JSON.stringify({ gameState, sessionId: resolvedSessionId, timestamp: new Date().toISOString() })
      ))
      .catch(err => console.warn('[AUTOSAVE] write failed:', err.message));

    // Update rolling history for delta/avg computation next turn
    diag.pushDiagHistory({
      turn_number:         turnNumber,
      narrator_total:      _narratorUsage?.total_tokens      ?? null,
      narrator_prompt:     _narratorUsage?.prompt_tokens     ?? null,
      narrator_completion: _narratorUsage?.completion_tokens ?? null,
      parser_total:        _parserUsage?.total_tokens        ?? null,
      parser_cached:       _parserUsage === null,
      system_total:        _systemTokTotal,
      cont_chars:          _contGrowthChars,
      violations:          _turnViolations,
      dm_note_chars:       (gameState.world.dm_note || '').length,
      history_turns:       (gameState.turn_history || []).filter(t => t.narration_debug?.extraction_packet != null).length
    });

    _activeTurnDebug = null;
    return res.json({ 
      sessionId: resolvedSessionId,
      narrative, 
      engine_message: _engineMsg || null,
      state: gameState,
      turn_history: gameState.turn_history,  // QA-014: Include turn history for export
      engine_output: engineOutput, 
      scene, 
      diagnostics: _qaDiagnostics,
      visibility: visibilityPayload,
      worldgen_log: gameState.world?.worldgen_log || null,
      site_placement_log: gameState.world?.site_placement_log || null,
      object_reality: _objectRealityDebug,
      player_identity: gameState.player.identity ?? null,          // v1.85.21
      last_identity_truth_line: gameState._lastIdentityTruthLine ?? null, // v1.85.21: verbatim Player: line injected into narrator
      last_arbiter_verdict: gameState._lastArbiterVerdict ?? null,  // v1.85.21: {turn, raw, applied}
      name_reveal_authorized: _authorizedNameReveal ?? null,         // v1.87.0: {npc_id, canonical_name, label} or null
      debug 
    });
  } catch (err) {
    console.error('[NARRATE] Error:', err.message);
    // Hard failures bypass the normal turn event — emit narrator_error so Mother Brain sees the gap explicitly
    const _narErrKind = (err.name === 'AbortError' || err.code === 'ERR_CANCELED') ? 'timeout'
                      : err.code === 'ECONNRESET' ? 'econnreset'
                      : 'error';
    diag.emitDiagnostics({ type: 'narrator_error', turn: turnNumber, kind: _narErrKind, message: err.message, gameSessionId: resolvedSessionId });
    if (logger) {
      logger.narrationFailed(err.message);
    }
    _abortTurn('NARRATION_ERROR');
    _activeTurnDebug = null;
    return res.json({ 
      sessionId: resolvedSessionId,
      narrative: "The engine encountered an error generating narration. Please try again.",
      state: gameState,
      turn_history: gameState.turn_history,  // QA-014: Include turn history for export
      engine_output: engineOutput,
      scene,
      diagnostics,
      visibility: visibilityPayload,
      object_reality: _objectRealityDebug,
      error: `narration_failed: ${err.message}`,
      debug
    });
  }
});

// =============================================================================
// REMAINING ENDPOINTS AND SERVER STARTUP (UNCHANGED)
// =============================================================================

function getActionKind(a) {
  if (!a) return 'FREEFORM';
  if (a.action === 'move') return 'MOVE';
  if (a.action === 'enter' || a.action === 'exit') return 'SITE_TRANSITION';
  return 'FREEFORM';
}

function mapActionToInput(action, kind = "FREEFORM") {
  const result = {
    player_intent: {
      kind: kind,
      raw: String(action)
    },
    meta: {
      source: "frontend",
      ts: new Date().toISOString()
    }
  };
  
  // Add top-level WORLD_PROMPT for Engine compatibility
  if (kind === "WORLD_PROMPT") {
    result.WORLD_PROMPT = String(action);
  }
  
  return result;
}

function initializeGame() {
  let state = null;
  if (Engine && typeof Engine.initState === 'function') {
    state = Engine.initState();
  } else {
    state = {
      player: { mx: 0, my: 0, layer: 1, inventory: [] },
      world: { npcs: [], cells: {}, active_site: null, active_local_space: null, current_depth: 1, position: { mx:0, my:0, lx:64, ly:64 }, l1_default: { w: 128, h: 128 } }
    };
  }
  return {
    status: "world_created",
    state: state,
    prompt: "Describe your world in 3 sentences."
  };
}

app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'Index.html');
  res.sendFile(htmlPath);
});

// Keep-alive probe — called every 5 min by the game client to prevent Render spin-down
app.get('/ping', (req, res) => {
  res.json({ ok: true });
});

// All /diagnostics/* routes registered in diagnostics.js via registerRoutes()
diag.registerRoutes(app, { getSessionStates: () => sessionStates });


app.post('/init', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  const { sessionId: resolvedSessionId, gameState, isFirstTurn } = getSessionState(sessionId);
  const result = {
    sessionId: resolvedSessionId,
    status: "world_created",
    state: gameState,
    prompt: "Describe your world in 3 sentences."
  };
  return res.json(result);
});

app.post('/reset', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  if (sessionId && sessionStates.has(sessionId)) {
    const newState = initializeGame();
    sessionStates.set(sessionId, {
      gameState: newState.state,
      isFirstTurn: true
    });
  }
  const { sessionId: resolvedSessionId, gameState, isFirstTurn } = getSessionState(sessionId);
  const result = {
    sessionId: resolvedSessionId,
    status: "world_created", 
    state: gameState,
    prompt: "Describe your world in 3 sentences."
  };
  return res.json(result);
});

app.get('/status', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  const { sessionId: resolvedSessionId, gameState, isFirstTurn } = getSessionState(sessionId);
  return res.json({
    sessionId: resolvedSessionId,
    status: 'running',
    hasGameState: gameState !== null,
    isFirstTurn: isFirstTurn,
    playerLocation: gameState?.player?.mx || null
  });
});

// P3: Pre-issue a progress token for first-turn polling.
// Client calls this BEFORE submitting the world prompt, then polls /narrate/progress.
app.get('/narrate/session-token', (req, res) => {
  const token = crypto.randomUUID();
  _initProgress.set(token, []);
  res.json({ token });
});

// P4: Progress polling endpoint.
app.get('/narrate/progress', (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).json({ error: 'missing token' });
  res.json({ steps: _initProgress.get(token) || [] });
});

/**
 * Ask DeepSeek a question about the game state without advancing turn
 * Useful for interactive debugging and understanding AI comprehension
 */
/**
 * Test endpoint: Just return the context without calling DeepSeek
 * Helps diagnose if issue is context building vs DeepSeek API
 */
app.post('/test-context', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  const { debugLevel = "detailed" } = req.body;

  const { sessionId: resolvedSessionId, gameState } = getSessionState(sessionId);
  
  try {
    const context = diag.buildDebugContext(gameState, debugLevel);
    
    return res.json({
      sessionId: resolvedSessionId,
      success: true,
      debugLevel,
      contextSize: context.length,
      context: context,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    return res.json({
      sessionId: resolvedSessionId,
      error: "context_build_failed",
      message: err.message
    });
  }
});

// =============================================================================
// /help — Player-facing help endpoint (Phase 4 placeholder)
// Read-only. Bypasses Engine.processTurn(). No state mutation.
// Full implementation in Phase 4.
// =============================================================================
app.post('/help', async (req, res) => {
  const sessionId = req.headers['x-session-id'];
  const { question } = req.body;

  if (!question) {
    return res.json({ sessionId: sessionId || null, answer: "What would you like help with?" });
  }

  if (!sessionId) {
    return res.json({ sessionId: null, answer: "No game is currently active. Start a game first." });
  }

  let gameState = null;
  try {
    const session = getSessionState(sessionId);
    gameState = session.gameState;
  } catch (err) {
    return res.json({ sessionId, answer: "No game is currently active. Start a game first." });
  }

  if (!gameState) {
    return res.json({ sessionId, answer: "No game is currently active. Start a game first." });
  }

  // Phase 4 placeholder — full narrator-persona DeepSeek call implemented in Phase 4.
  if (!gameState.help_log) gameState.help_log = [];
  const _helpEntry = {
    timestamp: new Date().toISOString(),
    turn_counter_at_call: gameState.turn_counter || 0,
    question,
    response: '(Help system coming soon.)'
  };
  gameState.help_log.push(_helpEntry);
  const { sessionId: _helpResolvedId, isFirstTurn: _helpIsFirst, logger: _helpLogger } = getSessionState(sessionId);
  // Persist updated help_log to session
  const _helpSession = sessionStates.get(sessionId);
  if (_helpSession) sessionStates.set(sessionId, { ..._helpSession, gameState });
  return res.json({
    sessionId,
    answer: "(Help system coming soon. Full player-facing guidance will be available in Phase 4.)",
    debug: { help_log_entry: _helpEntry }
  });
});

app.post('/ask-deepseek', async (req, res) => {
  const sessionId = req.headers['x-session-id'];
  const { question, debugLevel = "detailed" } = req.body;

  console.log(`[DEEPSEEK-DEBUG] Starting request. SessionId: ${sessionId}, Level: ${debugLevel}`);

  if (!question) {
    return res.json({
      error: "No question provided",
      message: "Please provide a 'question' in the request body"
    });
  }

  if (!sessionId) {
    return res.json({
      error: "no_session",
      message: "No session ID provided. Start a game first."
    });
  }

  let gameState = null;
  try {
    const session = getSessionState(sessionId);
    gameState = session.gameState;
  } catch (err) {
    return res.json({
      error: "session_fetch_failed",
      message: err.message || "Could not retrieve session"
    });
  }

  if (!gameState) {
    return res.json({
      error: "no_game_state",
      message: "No game state found for this session"
    });
  }

  // Build context
  let context = "";
  try {
    context = diag.buildDebugContext(gameState, debugLevel);
    console.log(`[DEEPSEEK-DEBUG] Context built successfully. Size: ${context.length} chars`);
  } catch (err) {
    console.error('[DEEPSEEK-DEBUG] Context build failed:', err.message);
    return res.json({
      error: "context_build_failed",
      message: err.message || "Failed to build game context"
    });
  }

  if (!process.env.DEEPSEEK_API_KEY) {
    return res.json({
      error: "DEEPSEEK_API_KEY not configured",
      message: "DeepSeek API is not available"
    });
  }

  try {
    console.log(`[DEEPSEEK-DEBUG] Question: "${question.substring(0, 50)}..."`);
    console.log(`[DEEPSEEK-DEBUG] Building DeepSeek request...`);
    
    const messages = [
      {
        role: "system",
        content: `You are an expert game engine debugger. The user is asking questions about their AI-driven roguelike game's current state. Answer their questions based on the game context provided. Be specific about game mechanics, world generation, NPC placement, and site types. If something is missing or unusual, explain why it might be missing based on the generation algorithms.`
      },
      {
        role: "user",
        content: `Game State Context:\n${context}\n\nPlayer Question: "${question}"\n\nProvide a detailed, insightful answer that references specific game state details from the context above.`
      }
    ];

    // Helper: single outbound call with 120s wall-clock AbortController + 120s axios socket timeout.
    // Extracted so the ECONNRESET retry path can call it a second time without duplication.
    const _makeDeepSeekCall = async () => {
      const _ctrl = new AbortController();
      const _wall = setTimeout(() => _ctrl.abort(), 120000);
      try {
        const resp = await axios.post(
          "https://api.deepseek.com/v1/chat/completions",
          {
            model: "deepseek-v4-flash",
            thinking: { type: "disabled" },
            messages,
            temperature: 0.7,
            max_tokens: 2000
          },
          {
            headers: {
              "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}`,
              "Content-Type": "application/json"
            },
            timeout: 120000,
            signal: _ctrl.signal
          }
        );
        clearTimeout(_wall);
        return resp;
      } catch (e) {
        clearTimeout(_wall);
        throw e;
      }
    };

    console.log(`[DEEPSEEK-DEBUG] Sending request to DeepSeek API (timeout: 120s)...`);
    let response;
    try {
      response = await _makeDeepSeekCall();
    } catch (_firstErr) {
      if (_firstErr?.code === 'ECONNRESET') {
        console.warn('[DEEPSEEK-DEBUG] ECONNRESET on first attempt — retrying once...');
        response = await _makeDeepSeekCall(); // single retry; outer catch handles second failure
      } else {
        throw _firstErr;
      }
    }

    console.log(`[DEEPSEEK-DEBUG] DeepSeek response received, status: ${response?.status}`);
    
    const deepseekResponse = response?.data?.choices?.[0]?.message?.content;

    if (!deepseekResponse) {
      console.error('[DEEPSEEK-DEBUG] No valid response content:', response?.data);
      return res.json({
        error: "invalid_response",
        message: "DeepSeek returned empty response",
        question
      });
    }

    console.log(`[DEEPSEEK-DEBUG] Success! Response length: ${deepseekResponse.length} chars`);

    return res.json({
      sessionId,
      question,
      debugLevel,
      response: deepseekResponse,
      contextLength: context.length,
      timestamp: new Date().toISOString(),
      turnNotAdvanced: true
    });

  } catch (err) {
    console.error('[DEEPSEEK-DEBUG] DeepSeek ERROR:', err?.message);
    console.error('[DEEPSEEK-DEBUG] Error code:', err?.code);
    
    let errorDetails = null;
    if (err?.response?.data) {
      errorDetails = err.response.data;
      console.error('[DEEPSEEK-DEBUG] API error response:', JSON.stringify(errorDetails));
    }
    
    return res.json({
      sessionId,
      error: err?.code || "deepseek_failed",
      message: err?.message || "Failed to query DeepSeek",
      details: errorDetails,
      question,
      contextLength: context.length
    });
  }
});

// =============================================================================
// CONSULT DEEPSEEK — rolling conversation endpoint (v1.68.0)
// History is logically unlimited (entire session). Stored as exchange objects
// so future trimming/summarization only touches exchanges[] without redesign.
// =============================================================================

app.post('/consult-deepseek', async (req, res) => {
  const sessionId = req.headers['x-session-id'];
  const { question, debugLevel = 'detailed' } = req.body;

  if (!question) {
    return res.json({ error: 'no_question', message: 'Please provide a question.' });
  }
  if (!sessionId) {
    return res.json({ error: 'no_session', message: 'No session ID. Start a game first.' });
  }

  let gameState = null;
  try {
    const session = getSessionState(sessionId);
    gameState = session.gameState;
  } catch (err) {
    return res.json({ error: 'session_fetch_failed', message: err.message });
  }
  if (!gameState) {
    return res.json({ error: 'no_game_state', message: 'No game state found.' });
  }

  if (!process.env.DEEPSEEK_API_KEY) {
    return res.json({ error: 'no_api_key', message: 'DeepSeek API key not configured.' });
  }

  // Build context (same Phase-1 overhaul that Ask uses)
  let context = '';
  try {
    context = diag.buildDebugContext(gameState, debugLevel);
  } catch (err) {
    return res.json({ error: 'context_build_failed', message: err.message });
  }

  // Retrieve or create history for this session
  if (!_consultHistory.has(sessionId)) {
    _consultHistory.set(sessionId, { exchanges: [], created: new Date().toISOString(), lastUsed: null });
  }
  const _hist = _consultHistory.get(sessionId);
  _hist.lastUsed = new Date().toISOString();

  // Flatten stored exchanges into DeepSeek message format
  // System message includes full context so every response is grounded in current truth
  const _systemMsg = {
    role: 'system',
    content: `You are a grounded in-world analyst for an AI-driven roguelike game engine. ` +
      `You may be conversational and interpretive, but you must never contradict authoritative engine data ` +
      `provided in the context. The CURRENT AUTHORITATIVE PLAY SPACE section always takes precedence over ` +
      `any terrain, biome, or coordinate data shown below it.\n\n` +
      `Current game state context:\n${context}`
  };

  const _historyMessages = _hist.exchanges.flatMap(ex => [
    { role: 'user',      content: ex.userQ },
    { role: 'assistant', content: ex.aiR   }
  ]);

  const _messages = [_systemMsg, ..._historyMessages, { role: 'user', content: question }];

  try {
    const _ctrl = new AbortController();
    const _wall = setTimeout(() => _ctrl.abort(), 120000);
    let _resp;
    try {
      _resp = await axios.post(
        'https://api.deepseek.com/v1/chat/completions',
        { model: 'deepseek-v4-flash', thinking: { type: 'disabled' }, messages: _messages, temperature: 0.7 },
        {
          headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
          timeout: 120000,
          signal: _ctrl.signal
        }
      );
    } catch (_firstErr) {
      if (_firstErr?.code === 'ECONNRESET') {
        _resp = await axios.post(
          'https://api.deepseek.com/v1/chat/completions',
          { model: 'deepseek-v4-flash', thinking: { type: 'disabled' }, messages: _messages, temperature: 0.7 },
          {
            headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
            timeout: 120000
          }
        );
      } else { throw _firstErr; }
    } finally {
      clearTimeout(_wall);
    }

    const _aiText = _resp?.data?.choices?.[0]?.message?.content;
    if (!_aiText) {
      return res.json({ error: 'empty_response', message: 'DeepSeek returned no content.' });
    }

    // Store exchange
    _hist.exchanges.push({ userQ: question, aiR: _aiText, ts: new Date().toISOString() });

    return res.json({
      sessionId,
      question,
      response: _aiText,
      exchangeCount: _hist.exchanges.length,
      contextLength: context.length,
      timestamp: new Date().toISOString(),
      turnNotAdvanced: true
    });
  } catch (err) {
    return res.json({
      sessionId,
      error: err?.code || 'consult_failed',
      message: err?.message || 'Failed to query DeepSeek',
      details: err?.response?.data || null,
      question,
      contextLength: context.length
    });
  }
});

// =============================================================================
// DELETE /session — explicit session teardown (used by probe-runner after data capture)
// =============================================================================
app.delete('/session', (req, res) => {
  const sessionId = req.headers['x-session-id'] || req.query.sessionId;
  if (!sessionId) {
    return res.status(400).json({ error: 'no_session_id', message: 'Provide sessionId via x-session-id header or ?sessionId= query param.' });
  }
  const existed = sessionStates.has(sessionId);
  sessionStates.delete(sessionId);
  _sessionLastUsed.delete(sessionId);
  _consultHistory.delete(sessionId);
  console.log(`[SESSION-DELETE] ${sessionId} | existed=${existed} | active_sessions=${sessionStates.size}`);
  return res.json({ deleted: true, existed, sessionId });
});

app.delete('/consult-deepseek/clear', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  if (!sessionId) {
    return res.json({ error: 'no_session', message: 'No session ID.' });
  }
  _consultHistory.delete(sessionId);
  return res.json({ cleared: true, sessionId, timestamp: new Date().toISOString() });
});

// =============================================================================
// LOGS ENDPOINT: Flush session logs to disk
// =============================================================================
app.post('/logs/flush', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  
  if (!sessionId) {
    return res.json({
      error: "no_session",
      message: "No session ID provided."
    });
  }
  
  try {
    const session = sessionStates.get(sessionId);
    if (!session || !session.logger) {
      return res.json({
        error: "no_logger",
        message: `No logger found for session ${sessionId}`
      });
    }
    
    const logFilePath = session.logger.flush();
    
    return res.json({
      sessionId,
      success: true,
      logFile: logFilePath,
      message: "Logs flushed to disk"
    });
  } catch (err) {
    return res.json({
      sessionId,
      error: "flush_failed",
      message: err.message
    });
  }
});

// =============================================================================
// LOGS ENDPOINT: List all available log files
// =============================================================================
app.get('/logs/list', (req, res) => {
  try {
    const logsDir = path.join(__dirname, 'logs');
    
    // Create directory if it doesn't exist
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    
    const files = fs.readdirSync(logsDir);
    const logFiles = files
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const filePath = path.join(logsDir, f);
        const stats = fs.statSync(filePath);
        return {
          filename: f,
          size: stats.size,
          created: stats.birthtime,
          modified: stats.mtime
        };
      })
      .sort((a, b) => b.modified - a.modified);
    
    return res.json({
      success: true,
      logCount: logFiles.length,
      logs: logFiles,
      logsDirectory: logsDir
    });
  } catch (err) {
    return res.json({
      error: "list_failed",
      message: err.message
    });
  }
});

// =============================================================================
// LOGS ENDPOINT: Read a specific log file
// =============================================================================
app.get('/logs/read/:sessionId', (req, res) => {
  try {
    const { sessionId } = req.params;
    const logFilePath = path.join(__dirname, 'logs', `${sessionId}.json`);
    
    if (!fs.existsSync(logFilePath)) {
      return res.json({
        error: "not_found",
        message: `Log file for session ${sessionId} not found`
      });
    }
    
    const content = fs.readFileSync(logFilePath, 'utf8');
    const logData = JSON.parse(content);
    
    return res.json({
      success: true,
      sessionId,
      data: logData
    });
  } catch (err) {
    return res.json({
      error: "read_failed",
      message: err.message
    });
  }
});

// =============================================================================
// LOGS ENDPOINT: Download a specific log file
// =============================================================================
app.get('/logs/download/:sessionId', (req, res) => {
  try {
    const { sessionId } = req.params;
    const logFilePath = path.join(__dirname, 'logs', `${sessionId}.json`);
    
    if (!fs.existsSync(logFilePath)) {
      return res.status(404).json({
        error: "not_found",
        message: `Log file for session ${sessionId} not found`
      });
    }
    
    // Set headers for file download
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${sessionId}.json"`);
    
    // Send the file
    res.sendFile(logFilePath);
  } catch (err) {
    return res.status(500).json({
      error: "download_failed",
      message: err.message
    });
  }
});

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`[ENV CHECK] DIAGNOSTICS_KEY present: ${!!process.env.DIAGNOSTICS_KEY}`);
  console.log(`[ENV CHECK] DEEPSEEK_API_KEY present: ${!!process.env.DEEPSEEK_API_KEY}`);
  // Notify Mother Brain that Node is online. _lastDiagnosticPayload will replay
  // this to MB on its first connect even if MB starts after Node.
  diag.emitDiagnostics({ type: 'lifecycle', event: 'online', ts: new Date().toISOString(), port: PORT, sessionId: _mbSessionId });
});

// =============================================================================
// HARNESS CONTROL ENDPOINTS — /harness/*
// All endpoints gated by x-diagnostics-key. Used by Mother Brain to drive QA.
// =============================================================================

// GET /harness/status — availability check (does not require server state)
app.get('/harness/status', (req, res) => {
  const diagKey = process.env.DIAGNOSTICS_KEY;
  if (!diagKey) return res.status(503).json({ error: 'harness_disabled', message: 'DIAGNOSTICS_KEY not set.' });
  if (req.headers['x-diagnostics-key'] !== diagKey) return res.status(403).json({ error: 'forbidden' });
  let externalCount = 0;
  try { externalCount = fs.readdirSync(HARNESS_SCENARIOS_DIR).filter(f => f.endsWith('.json')).length; } catch (_) {}
  const HARNESS_BUILTIN_COUNT = 4; // worldgen_basic, founding_premise, multi_turn_session, site_placement_endpoint
  res.json({ available: true, running: _harnessRunning, scenarios: HARNESS_BUILTIN_COUNT + externalCount });
});

// GET /harness/scenarios — enumerate all available scenarios (spawns --list)
app.get('/harness/scenarios', (req, res) => {
  const diagKey = process.env.DIAGNOSTICS_KEY;
  if (!diagKey) return res.status(503).json({ error: 'harness_disabled', message: 'DIAGNOSTICS_KEY not set.' });
  if (req.headers['x-diagnostics-key'] !== diagKey) return res.status(403).json({ error: 'forbidden' });
  const child = spawn(process.execPath, [path.join(__dirname, 'test-harness.js'), '--list'], {
    cwd: __dirname,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.on('close', () => {
    try { res.json(JSON.parse(out)); }
    catch (_) { res.status(500).json({ error: 'list_parse_failed', raw: out.slice(0, 500) }); }
  });
  child.on('error', err => res.status(500).json({ error: err.message }));
});

// POST /harness/run — async (fire-and-forget) scenario run; body: { scenario: string, runs?: number }
// Returns immediately with { started: true }. Poll GET /harness/status until running:false,
// then call GET /harness/result/last for the full result.
// Guardrails: rejects with { started: false } when already running; captures errors in _lastHarnessResult.
// Scenario name must be alphanumeric with underscores/hyphens only (no path traversal).
// Server-side cap: MAX_MOTHER_RUNS per call. Lock: only one run at a time.
app.post('/harness/run', (req, res) => {
  const diagKey = process.env.DIAGNOSTICS_KEY;
  if (!diagKey) return res.status(503).json({ error: 'harness_disabled', message: 'DIAGNOSTICS_KEY not set.' });
  if (req.headers['x-diagnostics-key'] !== diagKey) return res.status(403).json({ error: 'forbidden' });
  if (_harnessRunning) return res.status(409).json({ started: false, error: 'harness already running', message: 'A harness run is already in progress. Poll /harness/status until running:false, then read /harness/result/last.' });

  const scenarioName = typeof req.body?.scenario === 'string' ? req.body.scenario.trim() : null;
  if (!scenarioName) return res.status(400).json({ error: 'scenario_required', message: 'Body must include { scenario: string }.' });
  // Allowlist: alphanumeric, underscores, hyphens only — prevents path traversal and shell injection
  if (!/^[a-zA-Z0-9_-]+$/.test(scenarioName)) {
    return res.status(400).json({ error: 'invalid_scenario_name', message: 'Scenario name must be alphanumeric with underscores/hyphens only.' });
  }

  const runs     = Math.min(Math.max(1, parseInt(req.body?.runs, 10) || 1), MAX_MOTHER_RUNS);
  const filePath = path.join(HARNESS_SCENARIOS_DIR, scenarioName + '.json');
  const useFile  = fs.existsSync(filePath);

  _harnessRunning = true;
  res.json({ started: true, scenario: scenarioName, runs, message: 'Run started. Poll /harness/status until running:false, then call /harness/result/last.' });

  // Fire-and-forget: run loop detached from HTTP response
  (async () => {
    const runDetails = [];
    try {
      for (let i = 0; i < runs; i++) {
        const result = await new Promise(resolve => {
          const args = useFile
            ? [path.join(__dirname, 'test-harness.js'), '--file', filePath, '--yes', '--result-file', HARNESS_RESULT_PATH]
            : [path.join(__dirname, 'test-harness.js'), '--scenario', scenarioName, '--yes', '--result-file', HARNESS_RESULT_PATH];
          const child = spawn(process.execPath, args, {
            cwd: __dirname,
            env: { ...process.env },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', d => { stdout += d; });
          child.stderr.on('data', d => { stderr += d; });
          child.on('close',  code => resolve({ run: i + 1, exitCode: code, stdout: stdout.slice(0, 32000), stderr: stderr.slice(0, 4000) }));
          child.on('error', err  => resolve({ run: i + 1, exitCode: -1, error: err.message }));
        });
        runDetails.push(result);
      }
      let summary = null;
      try { summary = JSON.parse(fs.readFileSync(HARNESS_RESULT_PATH, 'utf8')); } catch (_) {}
      _lastHarnessResult = { scenario: scenarioName, runs, completedAt: new Date().toISOString(), runDetails, summary, failed: false };
    } catch (err) {
      _lastHarnessResult = { scenario: scenarioName, runs, completedAt: new Date().toISOString(), runDetails, error: err.message, failed: true };
      console.error('[HARNESS] Background run error:', err.message);
    } finally {
      _harnessRunning = false;
    }
  })();
});

// GET /harness/result/last — retrieve the last completed harness run result
app.get('/harness/result/last', (req, res) => {
  const diagKey = process.env.DIAGNOSTICS_KEY;
  if (!diagKey) return res.status(503).json({ error: 'harness_disabled', message: 'DIAGNOSTICS_KEY not set.' });
  if (req.headers['x-diagnostics-key'] !== diagKey) return res.status(403).json({ error: 'forbidden' });
  if (!_lastHarnessResult) return res.status(404).json({ error: 'no_result', message: 'No harness run completed yet in this server session.' });
  res.json(_lastHarnessResult);
});

// v1.91.22: ItemOperationWitness bridge — Mother read surface
app.get('/debug/witness', (req, res) => {
  const _sid = req.headers['x-session-id'];
  if (!_sid) {
    return res.status(400).json({ error: 'MISSING_SESSION_ID' });
  }
  const _packet = _witnessStore.get(_sid);
  if (!_packet) {
    return res.status(404).json({
      error: 'NO_WITNESS',
      message: 'No ItemOperationWitness recorded for this session yet. Run a turn that involves item operations.'
    });
  }
  return res.json(_packet);
});

// Allow heavy prompts (e.g. "critique my game") to complete before Node kills the socket.
// headersTimeout and requestTimeout must exceed the outbound axios timeout (120s).
server.headersTimeout = 130000;
server.requestTimeout = 130000;
server.setTimeout(0); // disable per-socket idle timeout — axios owns the outbound deadline

// =============================================================================
// MOTHER BRAIN LIFECYCLE SIGNALS
// Emit NODE_OFFLINE before any shutdown so MB receives the reason.
// 50ms delay is REQUIRED on all paths — SSE writes are async and the message
// will be silently lost if Node exits before the socket flushes.
// =============================================================================
function _mbEmitOffline(reason) {
  try {
    diag.emitDiagnostics({ type: 'lifecycle', event: 'offline', reason, ts: new Date().toISOString(), sessionId: _mbSessionId });
  } catch (_) {}
}

process.on('SIGINT', () => {
  _mbEmitOffline('developer shutdown (SIGINT)');
  setTimeout(() => { try { server.close(); } catch (_) {} process.exit(0); }, 50);
});

process.on('SIGTERM', () => {
  _mbEmitOffline('process terminated (SIGTERM)');
  setTimeout(() => { try { server.close(); } catch (_) {} process.exit(0); }, 50);
});

process.on('uncaughtException', (err) => {
  _mbEmitOffline('crash: ' + (err?.message || String(err)));
  console.error('[UNCAUGHT EXCEPTION]', err);
  setTimeout(() => process.exit(1), 50);
});

process.on('unhandledRejection', (reason) => {
  _mbEmitOffline('unhandled rejection: ' + String(reason));
  console.error('[UNHANDLED REJECTION]', reason);
  setTimeout(() => process.exit(1), 50);
});
