/**
 * Structured event logging system for game engine
 * Phase A: Console output + file persistence (JSON)
 * Phase B (future): SQLite persistence + query endpoints
 */

const fs = require('fs');
const path = require('path');

// Ensure logs directory exists
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// ANSI color codes for console output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  
  // Foreground colors
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  
  // Background colors
  bgBlack: '\x1b[40m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
};

const categoryColors = {
  SESSION: colors.cyan,
  WORLD_GEN: colors.green,
  BIOME: colors.magenta,
  LOCATION: colors.yellow,
  ENGINE: colors.blue,
  MOVEMENT: colors.cyan,
  NPC: colors.green,
  SETTLEMENT: colors.yellow,
  NARRATION: colors.magenta,
  ERROR: colors.red,
};

const levelColors = {
  INFO: colors.white,
  WARN: colors.yellow,
  ERROR: colors.red,
  DEBUG: colors.dim + colors.white,
};

/**
 * Core event logger
 * @param {object} config - Configuration (sessionId, etc)
 */
function createLogger(config = {}) {
  const sessionId = config.sessionId || `session_${Date.now()}`;
  const logFilePath = path.join(logsDir, `${sessionId}.json`);
  const eventBuffer = [];
  
  /**
   * Emit a structured event
   * @param {string} category - Event category (SESSION, WORLD_GEN, NPC, etc)
   * @param {string} event - Event name (biome_detected, npc_spawn_failed, etc)
   * @param {object} data - Event data
   * @param {object} options - Options (level, context)
   */
  function emit(category, event, data = {}, options = {}) {
    const level = options.level || 'INFO';
    const context = options.context || {};
    const timestamp = new Date().toISOString();
    
    const logEntry = {
      timestamp,
      sessionId,
      level,
      category,
      event,
      data,
      context
    };
    
    // Add to buffer
    eventBuffer.push(logEntry);
    
    // Colored console output
    const catColor = categoryColors[category] || colors.white;
    const levelColor = levelColors[level] || colors.white;
    
    const prefix = `${timestamp} ${catColor}[${category}]${colors.reset} ${levelColor}${event}${colors.reset}`;
    
    // Format data for display
    let dataStr = '';
    if (Object.keys(data).length > 0) {
      const parts = [];
      for (const [key, val] of Object.entries(data)) {
        if (typeof val === 'object') {
          parts.push(`${key}: ${JSON.stringify(val).substring(0, 50)}`);
        } else {
          parts.push(`${key}: ${val}`);
        }
      }
      dataStr = ` | ${parts.join(' | ')}`;
    }
    
    console.log(`${prefix}${dataStr}`);
    
    return logEntry;
  }
  
  /**
   * Flush events to file
   * Called typically at session end or periodically
   */
  function flush() {
    try {
      const output = {
        sessionId,
        generatedAt: new Date().toISOString(),
        eventCount: eventBuffer.length,
        events: eventBuffer
      };
      
      fs.writeFileSync(logFilePath, JSON.stringify(output, null, 2), 'utf8');
      console.log(`\n${colors.cyan}[LOG] ✓ Session log saved to: ${logFilePath}${colors.reset}\n`);
      return logFilePath;
    } catch (err) {
      console.error(`[ERROR] Failed to write log file: ${err.message}`);
      return null;
    }
  }
  
  /**
   * Convenience methods for common event categories
   */
  return {
    emit,
    flush,
    sessionId,
    logFilePath,
    
    // Session lifecycle
    sessionStarted: (data) => emit('SESSION', 'session_started', data),
    worldPromptReceived: (prompt) => emit('SESSION', 'world_prompt_received', { prompt }),
    playerActionParsed: (action, intent) => emit('SESSION', 'player_action_parsed', { action, intent }),
    
    // World generation
    biomeDetected: (biome) => emit('BIOME', 'biome_detected', { biome }),
    toneDetected: (tone) => emit('WORLD_GEN', 'tone_detected', { tone: tone?.substring(0, 100) }),
    locationTypeDetected: (locationType) => emit('LOCATION', 'starting_location_detected', { locationType }),
    worldInitialized: (seed, biome) => emit('WORLD_GEN', 'world_initialized', { seed, biome }),
    
    // Engine / Movement
    playerMoved: (from, to, direction) => emit('MOVEMENT', 'player_moved', { from, to, direction }),
    cellsGenerated: (count, biome) => emit('ENGINE', 'cells_generated', { count, biome }),
    scenesResolved: (cellCount) => emit('ENGINE', 'scene_resolved', { cellCount }),
    
    // Settlements
    settlementCreated: (name, type, location) => emit('SETTLEMENT', 'settlement_created', { name, type, location }),
    
    // NPCs
    npcSpawnAttempted: (settlementId, count) => emit('NPC', 'npc_spawn_attempted', { settlementId, count }),
    npcSpawnSucceeded: (settlementId, npcs) => emit('NPC', 'npc_spawn_succeeded', { settlementId, count: npcs.length }),
    npcSpawnFailed: (settlementId, reason) => emit('NPC', 'npc_spawn_failed', { settlementId, reason }, { level: 'WARN' }),
    
    // Narration
    narrationGenerated: (length) => emit('NARRATION', 'narration_generated', { length }),
    narrationFailed: (error) => emit('NARRATION', 'narration_failed', { error }, { level: 'ERROR' }),
    
    // Errors
    error: (category, message, data) => emit(category, 'error', { message, ...data }, { level: 'ERROR' }),
    warn: (category, message, data) => emit(category, 'warning', { message, ...data }, { level: 'WARN' }),
  };
}

module.exports = { createLogger };
