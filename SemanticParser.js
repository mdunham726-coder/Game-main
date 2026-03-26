"use strict";
/**
 * SemanticParser.js
 * Phase 1 — LLM-driven user intent normalization
 * Phase 3C — Quest action parsing support
 * Exports: async function normalizeUserIntent(userInput, gameContext)
 */

const crypto = require("crypto");

let axios = null;
try {
  axios = require("axios");
} catch (e) {
  // axios will be validated at call-time
}

const CACHE_TTL_MS = 30_000; // 30 seconds
const CONTEXT_MAX_LEN = 8192; // cap context string length to avoid prompt bloat

// In-memory cache: key -> { value, expiresAt }
const _cache = new Map();

function _now() { return Date.now(); }

function log(level, msg, extra) {
  if (extra !== undefined) {
    console.log(`[PARSER] ${level} ${msg}`, extra);
  } else {
    console.log(`[PARSER] ${level} ${msg}`);
  }
}

function serializeContext(ctx) {
  try {
    const s = JSON.stringify(ctx ?? {}, null, 0);
    if (s.length > CONTEXT_MAX_LEN) {
      return s.slice(0, CONTEXT_MAX_LEN) + "...";
    }
    return s;
  } catch {
    return "{}";
  }
}

function hashKey(inputStr) {
  return crypto.createHash("sha256").update(String(inputStr), "utf8").digest("hex");
}

function getFromCache(key) {
  const e = _cache.get(key);
  if (!e) return null;
  if (_now() > e.expiresAt) {
    _cache.delete(key);
    return null;
  }
  log("cache_hit", `input hash=${key.slice(0,8)}`);
  return e.value;
}

function setToCache(key, value, ttlMs = CACHE_TTL_MS) {
  _cache.set(key, { value, expiresAt: _now() + ttlMs });
}

function buildPrompt(userInput, contextStr) {
  const SYSTEM_TEXT = "You are a text adventure game parser. Convert player intent to JSON.";
  const USER_TEXT = [
    contextStr,
    "",
    // === PHASE 3C: Quest actions added to valid actions list ===
    "Valid actions: move, take, drop, examine, talk, accept_quest, complete_quest, ask_about_quest, sit, stand, look, cast, sneak, attack, listen, wait, inventory, help",
    "",
    "Directions: north, south, east, west, up, down",
    "",
    // === PHASE 3C: Quest-specific parsing context ===
    "Quest actions:",
    "- accept_quest: Player accepts quest from NPC (e.g., 'accept quest from guard', 'take the quest', 'yes I'll help')",
    "- complete_quest: Player completes quest with NPC (e.g., 'complete quest with guard', 'turn in quest', 'report back')",
    "- ask_about_quest: Player inquires about quest from NPC (e.g., 'ask guard about quest', 'what quests do you have', 'any work available')",
    "For quest actions, 'target' should be the NPC name/identifier.",
    "",
    "Modifiers: carefully, sneakily, gently, forcefully, angrily, etc.",
    "",
    `Player input: "${String(userInput)}"`,
    "",
    "Respond with ONLY valid JSON in this format:",
    "{",
    '  "primaryAction": { "action": "...", "target": "...", "dir": "..." },',
    '  "secondaryActions": [...],',
    '  "compound": false,',
    '  "confidence": 0.95',
    "}"
  ].join("\n");

  return [
    { role: "system", content: SYSTEM_TEXT },
    { role: "user", content: USER_TEXT }
  ];
}

async function callDeepSeek(messages) {
  if (!process.env.DEEPSEEK_API_KEY) {
    log("error", "error=NO_API_KEY");
    return { ok: false, error: "NO_API_KEY", content: null };
  }
  if (!axios) {
    log("error", "error=AXIOS_MISSING");
    return { ok: false, error: "AXIOS_MISSING", content: null };
  }
  try {
    const resp = await axios.post(
      "https://api.deepseek.com/v1/chat/completions",
      {
        model: "deepseek-chat",
        messages,
        temperature: 0,
        max_tokens: 256
      },
      {
        headers: {
          "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 15000
      }
    );
    const content = resp?.data?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length === 0) {
      return { ok: false, error: "PARSE_FAILED", content: null };
    }
    return { ok: true, error: null, content };
  } catch (err) {
    log("error", `error=LLM_UNAVAILABLE detail=${err?.message ?? "unknown"}`);
    return { ok: false, error: "LLM_UNAVAILABLE", content: null };
  }
}

function safeParseJSON(text) {
  try {
    // Strict parse only. If fenced/codewrapped, this will fail intentionally.
    const obj = JSON.parse(text);
    return { ok: true, value: obj };
  } catch {
    return { ok: false, value: null };
  }
}

/**
 * Normalize free-form user input into structured intent.
 * @param {string} userInput
 * @param {object} gameContext
 * @returns {Promise<{success:boolean, intent?:object|null, error?:string, confidence?:number}>}
 */
async function normalizeUserIntent(userInput, gameContext) {
  const raw = (typeof userInput === "string") ? userInput.trim() : "";
  if (!raw) {
    return { success: false, error: "EMPTY_INPUT" };
  }

  const contextStr = serializeContext(gameContext);
  const cacheKey = hashKey(`${raw}|${contextStr}`);

  const cached = getFromCache(cacheKey);
  if (cached) return cached;

  const messages = buildPrompt(raw, contextStr);
  const llm = await callDeepSeek(messages);
  if (!llm.ok) {
    const out = { success: false, error: llm.error, intent: null };
    setToCache(cacheKey, out);
    return out;
  }

  const parsed = safeParseJSON(llm.content);
  if (!parsed.ok || typeof parsed.value !== "object" || parsed.value === null) {
    const out = { success: false, error: "PARSE_FAILED", intent: null };
    setToCache(cacheKey, out);
    return out;
  }

  const v = parsed.value;
  const confidence = (typeof v.confidence === "number") ? v.confidence : NaN;
  if (!Number.isFinite(confidence)) {
    const out = { success: false, error: "PARSE_FAILED", intent: null };
    setToCache(cacheKey, out);
    return out;
  }
  if (confidence < 0.5) {
    log("warn", `error=LOW_CONFIDENCE input="${raw}" confidence=${confidence}`);
    const out = { success: false, error: "LOW_CONFIDENCE", intent: null, confidence };
    setToCache(cacheKey, out);
    return out;
  }

  const primaryAction = v.primaryAction && typeof v.primaryAction === "object" ? v.primaryAction : null;
  if (!primaryAction || typeof primaryAction.action !== "string" || primaryAction.action.length === 0) {
    const out = { success: false, error: "PARSE_FAILED", intent: null };
    setToCache(cacheKey, out);
    return out;
  }

  const intent = {
    primaryAction,
    secondaryActions: Array.isArray(v.secondaryActions) ? v.secondaryActions : undefined,
    compound: Boolean(v.compound),
    rawInput: raw,
    confidence
  };

  log("info", `input="${raw}" action="${primaryAction.action}" confidence=${confidence}`);

  const result = { success: true, intent };
  setToCache(cacheKey, result);
  return result;
}

module.exports = { normalizeUserIntent };
