const path = require('path');
const express = require('express');
const axios = require('axios');
const Engine = require('./Engine.js');
const WorldGen = require('./WorldGen.js');
const { createLogger } = require('./logger.js');
// Legacy import retained for compatibility
const Actions = require('./ActionProcessor.js');

const { validateAndQueueIntent, parseIntent } = require('./ActionProcessor.js');
const { normalizeUserIntent } = require('./SemanticParser.js');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Session state management
const sessionStates = new Map();

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
      logger: logger
    });
    console.log('[DIAG-3a-SERVER-GETSESSIONSTATE] New session stored in Map. Map size now:', sessionStates.size);
    logger.sessionStarted({ newSessionId });
    return { sessionId: newSessionId, ...sessionStates.get(newSessionId) };
  }
  // [DIAG-3b] Returning existing session
  console.log('[DIAG-3b-SERVER-GETSESSIONSTATE] RETURNING EXISTING SESSION for sessionId:', sessionId);
  const existing = sessionStates.get(sessionId);
  console.log('[DIAG-3b-SERVER-GETSESSIONSTATE] Existing session isFirstTurn:', existing?.isFirstTurn);
  return { sessionId, ...existing };
}

// File system helper functions for save/load system
const fs = require('fs');
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

// GET /quest/available - Get available quests for a settlement
app.get('/quest/available', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  const { settlementId } = req.query;
  
  if (!sessionId) {
    return res.status(400).json({ error: 'MISSING_SESSION_ID', message: 'Session ID is required' });
  }
  
  if (!settlementId) {
    return res.status(400).json({ error: 'MISSING_SETTLEMENT_ID', message: 'Settlement ID is required' });
  }
  
  const { gameState } = getSessionState(sessionId);
  
  try {
    // Check if quests exist for this settlement
    const availableQuests = gameState.quests.allQuestsSeeded[settlementId] || [];
    
    // Filter out quests that are already active or completed
    const activeQuestIds = new Set(gameState.quests.active.map(q => q.id));
    const completedQuestIds = new Set(gameState.quests.completed.map(q => q.id));
    
    const filteredQuests = availableQuests.filter(quest => 
      !activeQuestIds.has(quest.id) && !completedQuestIds.has(quest.id)
    );
    
    return res.json({
      success: true,
      settlementId,
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
  const { questId, settlementId } = req.body;
  
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
      message: result.success ? `✓ ${result.message}` : `❌ ${result.message}`,
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
        message: `✓ ${result.message}`,
        newState: result.gameState
      };
    } else {
      return {
        isSystemCommand: true,
        message: `❌ ${result.message}`,
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
        message: `✓ ${result.message}`,
        newState: result.gameState
      };
    } else {
      return {
        isSystemCommand: true,
        message: `❌ ${result.message}`,
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
        message: `❌ ${result.message}`,
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

// Existing narrate endpoint begins here
app.post('/narrate', async (req, res) => {
  const sessionId = req.headers['x-session-id'];
  
  // [DIAG-2] Log incoming request header
  console.log('[DIAG-2-SERVER-REQUEST-ENTRY] req.headers["x-session-id"]:', sessionId);
  console.log('[DIAG-2-SERVER-REQUEST-ENTRY] Type:', typeof sessionId);
  console.log('[DIAG-2-SERVER-REQUEST-ENTRY] Is truthy?', !!sessionId);
  
  const { sessionId: resolvedSessionId, gameState: sessionGameState, isFirstTurn: sessionIsFirstTurn } = getSessionState(sessionId);
  
  let gameState = sessionGameState;
  let isFirstTurn = sessionIsFirstTurn;
  
  const { action } = req.body;
  if (!action) {
    return res.status(400).json({ 
      sessionId: resolvedSessionId,
      error: 'action is required' 
    });
  }

  if (gameState === null) {
    const init = initializeGame();
    gameState = init.state;
    sessionStates.set(resolvedSessionId, { gameState, isFirstTurn: true });
  }

  // =========================================================================
  // SYSTEM COMMAND DETECTION (NEW INTEGRATION POINT)
  // =========================================================================
  const sysCmd = await detectSystemCommand(action, resolvedSessionId, gameState, sessionStates);
  if (sysCmd.isSystemCommand) {
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
  let parseResult = null;
  try {
    parseResult = await normalizeUserIntent(userInput, gameContext);
  } catch (e) {
    parseResult = { success: false, error: 'LLM_UNAVAILABLE', intent: null };
    console.warn('[PARSER] exception in semantic parser:', e?.message);
  }
  let debug = {
    parser: "none",
    input: userInput,
    intent: (parseResult && parseResult.intent) ? parseResult.intent : null,
    confidence: (parseResult && typeof parseResult.confidence === 'number') ? parseResult.confidence : 0,
    clarification: null
  };

  // Log player action parsing
  const session = sessionStates.get(resolvedSessionId);
  const logger = session?.logger;
  if (logger && !isFirstTurn) {
    logger.playerActionParsed(userInput, {
      success: parseResult?.success,
      confidence: parseResult?.confidence,
      action: parseResult?.intent?.primaryAction?.action,
      error: parseResult?.error
    });
  }

  // Before-turn debug info
  const beforeCells = Object.keys(gameState?.world?.cells || {}).length;
  console.log('[turn] cells_before=', beforeCells);

  // First turn: seed world using WORLD_PROMPT through Engine
  let engineOutput = null;
  if (isFirstTurn === true) {
    isFirstTurn = false;
    const session = sessionStates.get(resolvedSessionId);
    const logger = session?.logger;
    sessionStates.set(resolvedSessionId, { gameState, isFirstTurn, logger });
    const inputObj = mapActionToInput(action, "WORLD_PROMPT");
    
    if (logger) logger.worldPromptReceived(inputObj.WORLD_PROMPT);
    
    try {
      // Handle async world generation with DeepSeek biome detection
      if (inputObj.WORLD_PROMPT && !gameState?.world?.macro_biome) {
        const worldData = await WorldGen.generateWorldFromDescription(inputObj.WORLD_PROMPT, gameState.rng_seed || 0);
        if (worldData) {
          gameState.world.macro_biome = worldData.biome;
          gameState.world.world_tone = worldData.worldTone;  // NEW: Store semantic tone
          gameState.world.starting_location_type = worldData.startingLocationType;  // NEW: Store semantic starting location
          gameState.world.macro_palette = worldData.palette;
          gameState.world.seed = worldData.seed;
          gameState.world.l0_size = worldData.l0_size;
          gameState.world.cells = worldData.cells;
          if (!gameState.world.sites) gameState.world.sites = worldData.sites;
          
          // Log NPC spawning for all settlements
          if (logger && worldData.cells) {
            const settlementCells = Object.values(worldData.cells).filter(c => c.type === 'settlement');
            settlementCells.forEach(settlement => {
              if (settlement.npc_ids && settlement.npc_ids.length > 0) {
                logger.npcSpawnSucceeded(settlement.id || settlement.subtype, settlement.npc_ids);
              }
            });
          }
          
          if (logger) {
            logger.biomeDetected(worldData.biome);
            logger.toneDetected(worldData.worldTone);
            logger.locationTypeDetected(worldData.startingLocationType);
            logger.worldInitialized(worldData.seed, worldData.biome);
          }
          
          console.log('[NARRATE] First turn: Set biome to', worldData.biome, '| Tone:', worldData.worldTone, '| Starting location:', worldData.startingLocationType);
          
          // NEW: Create starting location cell with semantic location type
          const startPos = gameState.world.position || { mx: 0, my: 0, lx: 6, ly: 6 };
          const startingLocationCellKey = `L1:${startPos.mx},${startPos.my}:${startPos.lx},${startPos.ly}`;
          gameState.world.cells[startingLocationCellKey] = {
            type: "settlement",
            subtype: worldData.startingLocationType,
            biome: worldData.biome,
            mx: startPos.mx,
            my: startPos.my,
            lx: startPos.lx,
            ly: startPos.ly,
            description: "",  // Will be generated by the narration system
            is_starting_location: true  // Mark this for context
          };
          console.log('[WORLD] Created semantic starting location at', startPos.mx, startPos.my, 'type:', worldData.startingLocationType);
          
          // QA-012: PRE-REGISTER STARTING SETTLEMENT
          // Immediately register the starting settlement so summary truthfully reflects it at startup
          // enterL2FromL1 checks for duplicates, so re-entry is safe
          const startingSettlement = Engine.enterL2FromL1(gameState, gameState.world.cells[startingLocationCellKey]);
          if (startingSettlement && logger) {
            logger.settlement_registered(
              `M${startPos.mx}x${startPos.my}/L1_${startPos.lx}_${startPos.ly}_${worldData.startingLocationType}`,
              startingSettlement.name,
              startingSettlement.type || worldData.startingLocationType,
              { mx: startPos.mx, my: startPos.my }
            );
          }
          console.log('[WORLD] Pre-registered starting settlement:', startingSettlement?.name || 'unknown');
        }
      }
      
      engineOutput = Engine.buildOutput(gameState, inputObj, logger);
      if (engineOutput && engineOutput.state) {
        gameState = engineOutput.state;
        sessionStates.set(resolvedSessionId, { gameState, isFirstTurn: false, logger });
      }
    } catch (err) {
      console.error('Engine error on first turn:', err.message);
      return res.json({ 
        sessionId: resolvedSessionId,
        error: `engine_failed: ${err.message}`, 
        narrative: "The engine encountered an error initializing the world.",
        state: gameState,
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
        return res.json({
          sessionId: resolvedSessionId,
          narrative: `[CLARIFICATION] I didn't quite understand that. Did you mean to: ${parseResult.intent?.primaryAction?.action || '...'}? (yes/no/try again)`,
          state: gameState,
          debug
        });
      }

      let inputObj = null;

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

      if (parseResult && parseResult.success === true && typeof normalizedConfidence === 'number' && normalizedConfidence >= 0.5) {
        console.log('[PARSER] semantic_ok input="%s" action="%s" confidence=%s', userInput, parseResult.intent?.primaryAction?.action, parseResult.confidence);
        // [POINT-A] Log parseResult details for movement diagnosis
        console.log('[POINT-A-PARSE] parseResult:', { success: parseResult.success, confidence: parseResult.confidence, action: parseResult.intent?.primaryAction?.action, dir: parseResult.intent?.primaryAction?.dir });
        debug.parser = "semantic";
        // Phase 4: validate queue and execute sequentially
        const validation = validateAndQueueIntent(gameState, parseResult.intent);
        // [POINT-B] Log validation queue for movement diagnosis
        console.log('[POINT-B-QUEUE] validation.valid:', validation.valid, 'queue.length:', validation.queue?.length);
        if (validation.queue && validation.queue.length > 0) {
          validation.queue.forEach((qa, i) => {
            console.log(`[POINT-B-QUEUE] queue[${i}]:`, { action: qa.action, dir: qa.dir, target: qa.target });
          });
        }
        if (!validation.valid) {
          return res.json({
            sessionId: resolvedSessionId,
            success: true,
            narrative: `Action invalid: ${validation.reason}`,
            state: gameState,
            debug: { ...debug, parser: "semantic", error: "INVALID_ACTION", reason: validation.reason, validation: validation.stateValidation }
          });
        }
        const allResponses = [];
        for (const queuedAction of validation.queue) {
          const raw = [queuedAction.action, queuedAction.target].filter(Boolean).join(' ');
          const mapped = mapActionToInput(raw, getActionKind(queuedAction));
          
          // POPULATE PLAYER_INTENT FIELDS BEFORE DIAGNOSTIC LOG (data integrity fix)
          mapped.player_intent.action = queuedAction.action;
          
          if (queuedAction.action === 'move' && queuedAction.dir) {
            // Pass direction through unchanged as long-form (north/south/east/west)
            // ActionProcessor delta table is the canonical direction contract
            mapped.player_intent.dir = String(queuedAction.dir).toLowerCase();
          }
          
          // [POINT-C] Log mapped input structure for movement diagnosis (now with complete data)
          console.log('[POINT-C-MAPPED] action:', queuedAction.action, 'mapped.player_intent:', { action: mapped.player_intent?.action, dir: mapped.player_intent?.dir });
          
          const result = await Engine.buildOutput(gameState, mapped, logger);
          allResponses.push(result);
          if (result && result.state) {
            gameState = result.state;
            // [POINT-E] Log position persistence for movement diagnosis
            console.log('[POINT-E-PERSIST] Before sessionStates.set - gameState.world.position:', gameState.world.position);
            sessionStates.set(resolvedSessionId, { gameState, isFirstTurn });
            console.log('[POINT-E-PERSIST] After sessionStates.set - verified in Map');
          }
        }
        engineOutput = allResponses[allResponses.length - 1];
        debug = { ...debug, parser: "semantic", queue_length: validation.queue.length };
      } else {
        // Fallback to legacy parser
        console.log('[PARSER] fallback_legacy input="%s"', userInput);
        debug.parser = "legacy";
        const parsed = Actions.parseIntent(action);
        const inferredKind = (parsed && parsed.action === "move") ? "MOVE" : "FREEFORM";
        inputObj = mapActionToInput(action, inferredKind);
        if (parsed && parsed.action === "move" && parsed.dir) {
          inputObj.player_intent.dir = parsed.dir;
        }
      }

      if (!engineOutput) {
        engineOutput = Engine.buildOutput(gameState, inputObj, logger);
      }
      
      // Log player movement if position changed
      const oldPos = { mx: gameState.world?.position?.mx || 0, my: gameState.world?.position?.my || 0, lx: gameState.world?.position?.lx || 0, ly: gameState.world?.position?.ly || 0 };
      
      if (engineOutput && engineOutput.state) {
        gameState = engineOutput.state;
        
        const newPos = { mx: gameState.world?.position?.mx || 0, my: gameState.world?.position?.my || 0, lx: gameState.world?.position?.lx || 0, ly: gameState.world?.position?.ly || 0 };
        
        // Log if player moved
        if (logger && (oldPos.mx !== newPos.mx || oldPos.my !== newPos.my || oldPos.lx !== newPos.lx || oldPos.ly !== newPos.ly)) {
          logger.playerMoved(oldPos, newPos);
        }
        
        sessionStates.set(resolvedSessionId, { gameState, isFirstTurn, logger });
      }
    } catch (err) {
      console.error('Engine error:', err.message);
      return res.json({ 
        sessionId: resolvedSessionId,
        error: `engine_failed: ${err.message}`, 
        narrative: "The engine encountered an error processing your action.",
        state: gameState,
        debug
      });
    }
  }

  // --- Scene: current cell + nearby cells (N,S,E,W) ---
  const pos = gameState?.world?.position || {};
  const l1w = (gameState?.world?.l1_default?.w) || 12;
  const l1h = (gameState?.world?.l1_default?.h) || 12;
  const l0w = (gameState?.world?.l0_size?.w) || 8;
  const l0h = (gameState?.world?.l0_size?.h) || 8;
  function cellKey(mx,my,lx,ly){ return `L1:${mx},${my}:${lx},${ly}`; }

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
    worldLayer: gameState?.world?.current_layer || 1,
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
  const currentCellKey = `L1:${pos.mx},${pos.my}:${pos.lx},${pos.ly}`;
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

  try {
    // Build safe narration prompt with guards against undefined values
    let nearbyStr = '';
    if (scene.nearbyCells && Array.isArray(scene.nearbyCells)) {
      nearbyStr = scene.nearbyCells
        .filter(c => c && c.dir)
        .map(c => `${c.dir}: ${c.description || 'Unknown'}`)
        .join('\n');
    } else {
      nearbyStr = 'North: Unknown\nSouth: Unknown\nEast: Unknown\nWest: Unknown';
    }

    let npcsStr = '(None visible)';
    if (scene.npcs && Array.isArray(scene.npcs) && scene.npcs.length > 0) {
      npcsStr = JSON.stringify(scene.npcs.slice(0, 3));
    }

    let invStr = JSON.stringify(scene.inventory || []);

    const narrationContent = `You are narrating an interactive roguelike game. Use the world tone to guide your descriptions.

WORLD TONE & CHARACTER:
${gameState?.world?.world_tone || "A functional, atmospheric world"}

CORE INSTRUCTIONS:
- Let the world tone guide your descriptions and atmosphere
- Expand on the location description with vivid sensory details matching the tone
- React to the player's action naturally within the world
- Only describe what's present in the location or adjacently mentioned

CURRENT LOCATION:
${scene.currentCell?.description || 'An empty space'}
(Terrain: ${scene.currentCell?.type || 'void'}/${scene.currentCell?.subtype || 'unknown'})

ADJACENT AREAS:
${nearbyStr}

INVENTORY: ${invStr}
NPCs PRESENT: ${npcsStr}

Player action: "${String(action).replace(/"/g, '\\"')}"

NARRATION TASK:
- Write a vivid paragraph describing the player's current surroundings and the result of their action
- Use the world tone to determine appropriate atmosphere, decrepitude level, technology level, and mood
- Include sensory details (sights, sounds, smells, textures) that match the tone
- Do not invent landmarks, creatures, or locations not described above`;

    console.log(`[NARRATE] Built narration prompt, length: ${narrationContent.length} chars`);

    const response = await axios.post('https://api.deepseek.com/v1/chat/completions', {
      model: 'deepseek-chat',
      messages: [{
        role: 'user',
        content: narrationContent
      }],
      temperature: 0.7
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });

    // Safely extract narrative
    let narrative = "The engine processes your action.";
    try {
      if (response?.data?.choices?.[0]?.message?.content) {
        narrative = String(response.data.choices[0].message.content);
      }
    } catch (parseErr) {
      console.error('Failed to parse DeepSeek response:', parseErr.message);
    }
    
    // Log narration generation
    if (logger) {
      logger.narrationGenerated(narrative.length);
    }

    // [DIAG-1] Log before returning response
    console.log('[DIAG-1-SERVER-BEFORE-RESPONSE] resolvedSessionId:', resolvedSessionId);
    console.log('[DIAG-1-SERVER-BEFORE-RESPONSE] Type:', typeof resolvedSessionId);
    console.log('[DIAG-1-SERVER-BEFORE-RESPONSE] Will be included in response JSON');
    
    return res.json({ 
      sessionId: resolvedSessionId,
      narrative, 
      state: gameState, 
      engine_output: engineOutput, 
      scene, 
      diagnostics,
      debug 
    });
  } catch (err) {
    console.error('[NARRATE] Error:', err.message);
    if (logger) {
      logger.narrationFailed(err.message);
    }
    return res.json({ 
      sessionId: resolvedSessionId,
      narrative: "The engine encountered an error generating narration. Please try again.",
      state: gameState,
      engine_output: engineOutput,
      scene,
      diagnostics,
      error: `narration_failed: ${err.message}`,
      debug
    });
  }
});

// =============================================================================
// REMAINING ENDPOINTS AND SERVER STARTUP (UNCHANGED)
// =============================================================================

function getActionKind(a) { return (a && a.action === 'move') ? 'MOVE' : 'FREEFORM'; }

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
      world: { npcs: [], cells: {}, l2_active: null, l3_active: null, current_layer: 1, position: { mx:0, my:0, lx:6, ly:6 }, l1_default: { w: 12, h: 12 } }
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
  const currentCellKey = `L1:${pos.mx},${pos.my}:${pos.lx},${pos.ly}`;
  const currentCell = gameState.world.cells?.[currentCellKey];

  // === BASIC LEVEL ===
  context += `\n=== CURRENT LOCATION ===\n`;
  context += `Position: Macro(${pos.mx},${pos.my}) → Local(${pos.lx},${pos.ly})\n`;
  context += `Cell Type: ${currentCell?.type || "unknown"}\n`;
  context += `Cell Subtype: ${currentCell?.subtype || "unknown"}\n`;
  context += `Cell Biome: ${currentCell?.biome || "unknown"}\n`;
  context += `Description: ${(currentCell?.description || "").substring(0, 200)}${currentCell?.description?.length > 200 ? "..." : ""}\n`;

  context += `\n=== NEARBY NPCS ===\n`;
  if (gameState.world.npcs && gameState.world.npcs.length > 0) {
    gameState.world.npcs.slice(0, 3).forEach(npc => {
      context += `- ${npc.name || "Unnamed"} (${npc.archetype || "unknown"})\n`;
    });
    if (gameState.world.npcs.length > 3) {
      context += `... and ${gameState.world.npcs.length - 3} more\n`;
    }
  } else {
    context += `(None visible)\n`;
  }

  // === DETAILED LEVEL ===
  if (debugLevel === "detailed" || debugLevel === "full") {
    context += `\n=== WORLD GENERATION PARAMETERS ===\n`;
    context += `Biome: ${gameState.world.macro_biome || "not detected"}\n`;
    context += `World Tone: ${(gameState.world.world_tone || "not detected").substring(0, 150)}...\n`;
    context += `Starting Location Type: ${gameState.world.starting_location_type || "not detected"}\n`;
    context += `World Seed: ${gameState.world.seed ?? gameState.rng_seed ?? "unknown"}\n`;
    context += `Turn Counter: ${gameState.turn_counter ?? 0}\n`;

    context += `\n=== SETTLEMENTS (Summary) ===\n`;
    const settlementKeys = Object.keys(gameState.world.settlements || {});
    context += `Total Settlements: ${settlementKeys.length}\n`;
    if (settlementKeys.length > 0) {
      settlementKeys.slice(0, 3).forEach(k => {
        const settlement = gameState.world.settlements[k];
        context += `- ${settlement.name || "Unnamed"} (type: ${settlement.type || "unknown"}, ${(settlement.npcs || []).length} NPCs)\n`;
      });
      if (settlementKeys.length > 3) {
        context += `... and ${settlementKeys.length - 3} more\n`;
      }
    } else {
      context += `(No settlements created yet)\n`;
    }

    context += `\n=== VISIBLE CELLS (Sample) ===\n`;
    const cellKeys = Object.keys(gameState.world.cells || {})
      .filter(k => {
        const cell = gameState.world.cells[k];
        return cell && cell.mx === pos.mx && cell.my === pos.my;
      })
      .slice(0, 5);
    
    if (cellKeys.length > 0) {
      cellKeys.forEach(k => {
        const cell = gameState.world.cells[k];
        context += `- [${cell.lx},${cell.ly}] ${cell.type}/${cell.subtype}\n`;
      });
    } else {
      context += `(No cells in current macro)\n`;
    }
  }

  // === FULL LEVEL ===
  if (debugLevel === "full") {
    context += `\n=== WORLD STATE (Entries Summary) ===\n`;
    context += `Total Cells: ${Object.keys(gameState.world.cells || {}).length}\n`;
    context += `Total Settlements: ${Object.keys(gameState.world.settlements || {}).length}\n`;
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
        settlements_count: Object.keys(gameState.world.settlements || {}).length,
        npcs_count: (gameState.world.npcs || []).length,
        turn_counter: gameState.turn_counter,
        world_seed: gameState.world.seed || gameState.rng_seed
      };
      context += `\nMinimal JSON snapshot:\n${JSON.stringify(sample, null, 2)}\n`;
    } catch (e) {
      context += `(Could not create JSON snapshot)\n`;
    }
  }

  // Safety: never exceed 4000 chars
  if (context.length > 4000) {
    context = context.substring(0, 4000) + "\n...(truncated for size)";
  }

  return context;
}

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
    const context = buildDebugContext(gameState, debugLevel);
    
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
    context = buildDebugContext(gameState, debugLevel);
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
        content: `You are an expert game engine debugger. The user is asking questions about their AI-driven roguelike game's current state. Answer their questions based on the game context provided. Be specific about game mechanics, world generation, NPC placement, and settlement types. If something is missing or unusual, explain why it might be missing based on the generation algorithms.`
      },
      {
        role: "user",
        content: `Game State Context:\n${context}\n\nPlayer Question: "${question}"\n\nProvide a detailed, insightful answer that references specific game state details from the context above.`
      }
    ];

    console.log(`[DEEPSEEK-DEBUG] Sending request to DeepSeek API (timeout: 30s)...`);
    
    const response = await axios.post(
      "https://api.deepseek.com/v1/chat/completions",
      {
        model: "deepseek-chat",
        messages,
        temperature: 0.7,
        max_tokens: 800
      },
      {
        headers: {
          "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 30000
      }
    );

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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
