# Phase A: Structured Event Logging Architecture

**Date Created:** March 26-27, 2026  
**Status:** Phase A Complete (Core Infrastructure)  
**Next Phase:** Phase B (SQLite Persistence + Query Endpoints)

---

## Table of Contents

1. [The Problem We Solved](#the-problem-we-solved)
2. [Solution Overview](#solution-overview)
3. [Architecture](#architecture)
4. [Components](#components)
5. [How to Use Logs](#how-to-use-logs)
6. [Technical Details](#technical-details)
7. [Future Work (Phase B)](#future-work-phase-b)

---

## The Problem We Solved

### The Epistemological Crisis

During development, we encountered a fundamental problem: **How do we know anything is actually happening in the game?**

- **Narrative text alone is unverifiable.** DeepSeek could fabricate information (e.g., claiming a 10x10 grid when the actual grid is 8x8)
- **Code claims are unverified.** Saying "NPCs are spawning" in code doesn't mean they're actually being created correctly
- **No ground truth layer existed.** Without structured events, we had no way to audit what actually happened

### The Insight

The solution wasn't a database or API—it was **structured events at state transitions**. Instead of narrative fiction, emit objective facts:
- "What changed?"
- "When did it change?"
- "What data do I have to prove it?"

This became the foundation for **auditable, debuggable, verifiable game state**.

---

## Solution Overview

We built **Phase A: Event Streaming & File Persistence**

A structured logging system that:
1. **Emits events** at every critical state transition (session start, biome detection, player movement, narration, etc.)
2. **Outputs to console** in real-time with colored formatting for visibility
3. **Buffers in memory** during gameplay
4. **Persists to JSON files** when flushed
5. **Provides UI controls** to manage and inspect logs

**Key Philosophy:** Log state transitions, not implementation noise. Only record "what changed" not "what function ran."

---

## Architecture

### High-Level Data Flow

```
┌─────────────────────────────────────────────────────────────┐
│                     Game Session Starts                      │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
        ┌──────────────────────────────────────┐
        │   Logger Instance Created            │
        │   (per session, with sessionId)      │
        └──────────────┬───────────────────────┘
                       │
     ┌─────────────────┴──────────────────┐
     │                                    │
     ▼                                    ▼
┌──────────────────┐          ┌──────────────────┐
│ Event Emissions  │          │ Event Buffer     │
│ (In-Memory)      │          │ (JSON Array)     │
│                  │          │                  │
│ sessionStarted   │          │ Each event has:  │
│ biomeDetected    │          │ - timestamp      │
│ playerMoved      │          │ - category       │
│ npcSpawnSuccess  │          │ - event name     │
│ narrationGenerated          │ - data           │
│ etc.             │          │ - context        │
└────────┬─────────┘          └────────┬─────────┘
         │                             │
         │                    Real-time Console Log
         │                    (Colored ANSI output)
         │                             │
         └──────────────┬──────────────┘
                        │
                        │ (User clicks "Flush Logs")
                        ▼
              ┌──────────────────────┐
              │  Write to Disk (FS)  │
              │  logs/session_X.json │
              └──────────┬───────────┘
                         │
          ┌──────────────┴──────────────┐
          │                             │
          ▼                             ▼
   ┌───────────────────┐      ┌──────────────────┐
   │ View in Browser   │      │ Download to PC   │
   │ ("View Session")  │      │ (⬇️ Download btn)|
   └───────────────────┘      └──────────────────┘
```

### Event Categories

Events are organized into categories for easy filtering and identification:

| Category | Purpose | Events |
|----------|---------|--------|
| **SESSION** | Game lifecycle | `session_started`, `world_prompt_received`, `player_action_parsed` |
| **WORLD_GEN** | World generation | `tone_detected`, `world_initialized` |
| **BIOME** | Biome detection | `biome_detected` |
| **LOCATION** | Starting location | `starting_location_detected` |
| **ENGINE** | Engine operations | `cells_generated`, `scene_resolved` |
| **MOVEMENT** | Player movement | `player_moved` |
| **NPC** | NPC spawning | `npc_spawn_attempted`, `npc_spawn_succeeded`, `npc_spawn_failed` |
| **SETTLEMENT** | Settlements | `settlement_created` |
| **NARRATION** | Narration generation | `narration_generated`, `narration_failed` |
| **ERROR** | Errors/warnings | `error`, `warning` |

---

## Components

### 1. logger.js (150+ lines)

**Purpose:** Core event logging module  
**Exports:** `createLogger(config)`

#### Key Features

```javascript
// Create logger instance (per session)
const logger = createLogger({ sessionId: 'session_1234567890' });

// Emit events
logger.sessionStarted({ newSessionId: '...' });
logger.biomeDetected('forest');
logger.playerMoved({ mx: 0, my: 0, lx: 6, ly: 6 }, { mx: 0, my: 1, lx: 0, ly: 0 });
logger.npcSpawnSucceeded('settlement_1', npcs);

// Flush to disk
logger.flush(); // Writes to logs/session_[id].json
```

#### Internal Structure

**Event Entry Format:**
```json
{
  "timestamp": "2026-03-27T14:32:45.123Z",
  "sessionId": "session_1234567890",
  "level": "INFO",
  "category": "WORLD_GEN",
  "event": "biome_detected",
  "data": {
    "biome": "forest"
  },
  "context": null
}
```

**Flush Output Format:**
```json
{
  "sessionId": "session_1234567890",
  "generatedAt": "2026-03-27T14:35:12.456Z",
  "eventCount": 42,
  "events": [
    { /* event 1 */ },
    { /* event 2 */ },
    ... (all events in order)
  ]
}
```

#### Console Output

Events are printed in real-time with ANSI color codes:

```
2026-03-27T14:32:45.123Z [SESSION] session_started | sessionId: session_1234567890
2026-03-27T14:32:46.234Z [BIOME] biome_detected | biome: forest
2026-03-27T14:32:47.345Z [WORLD_GEN] world_initialized | seed: 12345, biome: forest
2026-03-27T14:32:48.456Z [NPC] npc_spawn_succeeded | settlementId: settlement_1, count: 15
2026-03-27T14:32:49.567Z [MOVEMENT] player_moved | from: {mx:0,my:0,lx:6,ly:6}, to: {mx:0,my:1,lx:0,ly:0}
2026-03-27T14:32:50.678Z [NARRATION] narration_generated | length: 487
```

**Color Mapping:**
- SESSION: Cyan
- WORLD_GEN: Green
- BIOME: Magenta
- LOCATION: Yellow
- ENGINE: Blue
- MOVEMENT: Cyan
- NPC: Green
- SETTLEMENT: Yellow
- NARRATION: Magenta
- ERROR: Red

---

### 2. index.js Integration

**File:** Main server file (Express.js)  
**Changes Made:** Logger integration at critical points

#### Session Creation (Lines ~24-37)

When a new session starts:

```javascript
function getSessionState(sessionId) {
  if (!sessionStates.has(sessionId)) {
    const newSessionId = generateSessionId();
    const gameState = initializeGame().state;
    const logger = createLogger({ sessionId: newSessionId });
    
    logger.sessionStarted({ newSessionId });
    
    sessionStates.set(newSessionId, { 
      gameState, 
      isFirstTurn: true, 
      logger  // Stored for entire session
    });
    
    return { sessionId: newSessionId, ... };
  }
  return { sessionId, ...sessionStates.get(sessionId) };
}
```

#### First Turn: World Generation (Lines ~740-770)

When world is generated:

```javascript
if (logger) {
  logger.worldPromptReceived(inputObj.WORLD_PROMPT);
}

// ... world generation happens ...

if (logger && worldData) {
  // Log settlement NPC spawns
  const settlementCells = Object.values(worldData.cells)
    .filter(c => c.type === 'settlement');
  settlementCells.forEach(settlement => {
    if (settlement.npc_ids?.length > 0) {
      logger.npcSpawnSucceeded(settlement.id, settlement.npc_ids);
    }
  });
  
  // Log biome, tone, location, world init
  logger.biomeDetected(worldData.biome);
  logger.toneDetected(worldData.worldTone);
  logger.locationTypeDetected(worldData.startingLocationType);
  logger.worldInitialized(worldData.seed, worldData.biome);
}
```

#### Action Parsing (Lines ~710-730)

When player input is parsed:

```javascript
if (logger && !isFirstTurn) {
  logger.playerActionParsed(userInput, {
    success: parseResult?.success,
    confidence: parseResult?.confidence,
    action: parseResult?.intent?.primaryAction?.action,
    error: parseResult?.error
  });
}
```

#### Movement Tracking (Lines ~845-875)

When player moves:

```javascript
const oldPos = { 
  mx: gameState.world?.position?.mx || 0,
  my: gameState.world?.position?.my || 0,
  lx: gameState.world?.position?.lx || 0,
  ly: gameState.world?.position?.ly || 0
};

// ... engine processes movement ...

const newPos = { 
  mx: gameState.world?.position?.mx || 0,
  my: gameState.world?.position?.my || 0,
  lx: gameState.world?.position?.lx || 0,
  ly: gameState.world?.position?.ly || 0
};

if (logger && (oldPos.mx !== newPos.mx || /* ... */)) {
  logger.playerMoved(oldPos, newPos);
}
```

#### Narration (Lines ~1070-1090)

When narration is generated:

```javascript
let narrative = "The engine processes your action.";
try {
  if (response?.data?.choices?.[0]?.message?.content) {
    narrative = String(response.data.choices[0].message.content);
  }
} catch (parseErr) {
  console.error('Failed to parse DeepSeek response:', parseErr.message);
}

// Log narration success
if (logger) {
  logger.narrationGenerated(narrative.length);
}
```

On error:

```javascript
} catch (err) {
  if (logger) {
    logger.narrationFailed(err.message);
  }
  return res.json({ /* ... */ });
}
```

---

### 3. Log Management Endpoints

Three new REST endpoints for log management:

#### POST `/logs/flush`

**Purpose:** Flush current session's buffered events to disk  
**Headers:** `x-session-id` (required)  
**Response:**
```json
{
  "sessionId": "session_1234567890",
  "success": true,
  "logFile": "/path/to/game-main/logs/session_1234567890.json",
  "message": "Logs flushed to disk"
}
```

#### GET `/logs/list`

**Purpose:** List all saved log files  
**Response:**
```json
{
  "success": true,
  "logCount": 5,
  "logsDirectory": "/path/to/logs",
  "logs": [
    {
      "filename": "session_1234567890.json",
      "size": 15234,
      "created": "2026-03-27T14:32:45.000Z",
      "modified": "2026-03-27T14:35:12.000Z"
    },
    // ... more logs
  ]
}
```

#### GET `/logs/read/:sessionId`

**Purpose:** Read a specific session's log file  
**Response:**
```json
{
  "success": true,
  "sessionId": "session_1234567890",
  "data": {
    "sessionId": "session_1234567890",
    "generatedAt": "2026-03-27T14:35:12.456Z",
    "eventCount": 42,
    "events": [ /* ... all events ... */ ]
  }
}
```

#### GET `/logs/download/:sessionId`

**Purpose:** Download log file as attachment (for browser download)  
**Response:** Binary file stream with headers:
```
Content-Type: application/json
Content-Disposition: attachment; filename="session_1234567890.json"
```

---

### 4. Frontend UI (Index.html)

**New Section:** SESSION LOGS Panel

#### Buttons

| Button | Action | Result |
|--------|--------|--------|
| 💾 Flush | POST `/logs/flush` | Saves current session to disk, shows confirmation |
| ⬇️ Download | GET `/logs/download/:sessionId` | Downloads JSON file to browser (Downloads folder) |
| 📂 List | GET `/logs/list` | Displays all saved log files with metadata |
| 👁️ View | GET `/logs/read/:sessionId` | Displays current session's events in formatted table |

#### Display Format

When "View" is clicked, events display as:

```
📋 Session Log: session_1234567890
Generated: 2026-03-27T14:35:12.456Z
Total Events: 42

======================================================================
EVENT TIMELINE:
======================================================================

[1] 2026-03-27T14:32:45.123Z
    Category: SESSION | Event: session_started | Level: INFO
    Data: {"newSessionId":"session_1234567890"}

[2] 2026-03-27T14:32:46.234Z
    Category: WORLD_GEN | Event: world_prompt_received | Level: INFO
    Data: {"prompt":"A dark forest under constant twilight..."}

[3] 2026-03-27T14:32:47.345Z
    Category: BIOME | Event: biome_detected | Level: INFO
    Data: {"biome":"forest"}

... (continues for all events)
```

---

## How to Use Logs

### Typical Workflow

#### Step 1: Play the Game
- Visit game URL (game-69kj.onrender.com)
- Describe your world (first turn)
- Take actions (subsequent turns)
- Events are buffered in memory and printed to console

#### Step 2: Flush Logs
- Click **💾 Flush** button
- Events written to Render's `/logs/` directory
- Button confirms: "✅ Logs flushed successfully!"

#### Step 3: View or Download

**Option A: View in Browser**
- Click **👁️ View This Session**
- See formatted event timeline
- Scroll through event history

**Option B: Download**
- Click **⬇️ Download**
- File saved to Downloads folder
- Can move to local `/logs/` directory or share

#### Step 4: Share with AI Assistant
- Copy/paste the log content from browser
- Or upload downloaded JSON file
- Assistant reads and analyzes events

### Example: Debugging an Issue

**Scenario:** "Why are there no NPCs in settlements?"

1. Play a session (several turns)
2. Click **💾 Flush** → saves logs
3. Click **👁️ View** → shows event timeline
4. Look for `npc_spawn_attempted` and `npc_spawn_succeeded` events
5. If `npc_spawn_attempted` exists but succeeded is missing → NPCs didn't spawn
6. Share the logs with AI → AI analyzes and identifies root cause

---

## Technical Details

### Event Emission Points (Currently Active)

| Location | Event | Data |
|----------|-------|------|
| getSessionState() | `session_started` | sessionId |
| /narrate first turn | `world_prompt_received` | prompt text |
| /narrate first turn | `biome_detected` | biome name |
| /narrate first turn | `tone_detected` | world tone |
| /narrate first turn | `starting_location_detected` | location type |
| /narrate first turn | `world_initialized` | seed, biome |
| /narrate first turn | `npc_spawn_succeeded` | settlementId, npc array |
| /narrate any turn | `player_action_parsed` | action, confidence, error |
| /narrate any turn | `player_moved` | from position, to position |
| /narrate any turn | `narration_generated` | narration length |
| /narrate error | `narration_failed` | error message |

### File Structure

```
game-main/
├── logger.js              # Core logging module
├── index.js              # Server with logger integration
├── Index.html            # Frontend with log UI buttons
├── logs/                 # Created automatically on first run
│   ├── session_1234567890.json
│   ├── session_1234567891.json
│   └── session_1234567892.json
└── [other files unchanged]
```

### Session ID Format

Sessions use Unix timestamps:
```javascript
const newSessionId = generateSessionId();
// Returns: 1711545165234 (milliseconds since epoch)
// Log file: logs/1711545165234.json
```

This ensures:
- ✅ Unique per session
- ✅ Chronologically sortable
- ✅ Human-readable (can convert to date)
- ✅ No conflicts across deploys

---

## Future Work (Phase B)

### What's Coming

#### 1. SQLite Persistence

Move from JSON files to a relational database:

```sql
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  sessionId TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  level TEXT,
  category TEXT,
  event TEXT,
  data JSON,
  context JSON,
  FOREIGN KEY(sessionId) REFERENCES sessions(id)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  createdAt TEXT,
  endedAt TEXT,
  eventCount INTEGER
);
```

**Benefits:**
- Queryable events
- Persistent across restarts
- Aggregations (stats, summaries)
- Filtering by category/level/time

#### 2. Query Endpoints

New REST APIs for interrogating logs:

```javascript
// Get events for a session
GET /logs/query?sessionId=...&category=MOVEMENT

// Get events in time range
GET /logs/query?from=2026-03-27T14:00Z&to=2026-03-27T15:00Z

// Get summary statistics
GET /logs/summary?sessionId=...

// Get all movements in a session
GET /logs/movements?sessionId=...
```

#### 3. Event Analysis Tools

Backend utilities to understand logs:

```javascript
// What happened in this session?
logger.summarizeSession(sessionId)
// Returns: { eventCount, categories, errors, timestamps }

// Did this action succeed?
logger.findEventsByAction(sessionId, 'move_north')

// What errors occurred?
logger.getErrors(sessionId)
// Returns: [ { timestamp, message }, ... ]
```

#### 4. Frontend Enhancements

- Event filtering (by category, level, time)
- Event search (keyword)
- Session comparison (what changed between sessions?)
- Event graph visualization

---

## Summary

### What We Built

A **structured event logging system** that:
1. ✅ Emits events at every critical state transition
2. ✅ Outputs to console in real-time (colored for visibility)
3. ✅ Buffers events in memory during session
4. ✅ Persists to disk (JSON) when flushed
5. ✅ Provides browser UI for management
6. ✅ Supports download to local machine
7. ✅ Enables AI assistant to read and analyze logs

### Why It Matters

**Solves the epistemological problem:**
- Before: "Trust me, the engine is working"
- After: "Here's proof—the structured event log showing exactly what happened"

**Enables debugging:**
- No more guessing or narrative fiction
- Objective audit trail of game state
- AI can read logs and identify issues

**Foundation for Phase B:**
- SQLite will make logs queryable
- Query endpoints will enable dashboards
- Event analysis tools will provide insights

---

## Quick Reference

### Logging API

```javascript
logger.sessionStarted(data)
logger.worldPromptReceived(prompt)
logger.playerActionParsed(action, intent)
logger.biomeDetected(biome)
logger.toneDetected(tone)
logger.locationTypeDetected(locationType)
logger.worldInitialized(seed, biome)
logger.playerMoved(from, to)
logger.npcSpawnSucceeded(settlementId, npcs)
logger.npcSpawnFailed(settlementId, reason)
logger.narrationGenerated(length)
logger.narrationFailed(error)
logger.flush()  // Writes to disk
```

### Endpoints

```
POST   /logs/flush              # Flush current session
GET    /logs/list               # List all log files
GET    /logs/read/:sessionId    # Read specific session
GET    /logs/download/:sessionId # Download as file
```

### UI Buttons

```
💾 Flush      → POST /logs/flush
⬇️ Download   → GET /logs/download/:sessionId
📂 List       → GET /logs/list
👁️ View      → GET /logs/read/:sessionId
```

---

**Documentation Created:** March 27, 2026  
**Next Review:** After Phase B implementation
