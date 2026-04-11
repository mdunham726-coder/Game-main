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
    "Valid actions: move, take, drop, examine, talk, enter, exit, accept_quest, complete_quest, ask_about_quest, sit, stand, look, cast, sneak, attack, listen, wait, inventory, help",
    "",
    "Directions: north, south, east, west, up, down",
    "Only assign action='move' when the player clearly intends to travel to a new location. Do not infer movement from body-part words (e.g., 'right foot', 'left hand') or positional language used in non-travel contexts.",
    "action='move' REQUIRES a compass direction (north/south/east/west/up/down). Never set action='move' without a clear compass direction.",
    "Use action='enter' for phrases like: 'go to [place]', 'go into [X]', 'head to [X]', 'get in/inside [X]', or any phrase that targets a named location without a compass direction.",
    "Use action='exit' for phrases like: 'out of', 'go out', 'leave', 'exit', 'get out'. exit is an action, not a direction value. Never use dir='exit'.",
    "If the player's input is expressive, theatrical, or physical-performance language with no clear mechanical intent (e.g., dancing, spinning, performing, celebrating), set action to 'wait' and confidence to 0.3.",
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
  if (confidence < 0.7) {
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
    rawInput: raw
  };

  log("info", `input="${raw}" action="${primaryAction.action}" confidence=${confidence}`);

  const result = { success: true, intent, confidence };
  setToCache(cacheKey, result);
  return result;
}

module.exports = { normalizeUserIntent, resolveEnterTarget };

/**
 * Phase 2 entry resolver — constrained LLM interpretation.
 * Invoked when Phase 1 (deterministic) returns no_match.
 * Asks the model to select from the provided candidate list only.
 *
 * @param {Array}  candidates    — enterable site objects: { site_id, name, category, site_tier, identity }
 * @param {string} phrase        — lowercased, article-stripped player phrase (e.g. "town", "the inn")
 * @param {number} currentDepth  — current_depth value (used to report layer in prompt)
 * @returns {Promise<{ result: 'resolved'|'ambiguous'|'no_match', site_id?: string, ambiguous_ids?: string[], method: 'llm', error?: string }>}
 */
async function resolveEnterTarget(candidates, phrase, currentDepth) {
  const candidateList = candidates.map(s => ({
    site_id:   s.site_id,
    name:      s.name      || null,
    category:  s.category  || null,
    site_tier: s.site_tier || null,
    identity:  s.identity  || null
  }));

  const layerLabel = `L${(currentDepth || 0)}`;

  const systemPrompt =
    'You are resolving which game site a player wants to enter. ' +
    'Select from the provided list only. Return JSON only, no prose. ' +
    'Do not invent or infer sites outside the list.';

  const userPrompt =
    `Current layer: ${layerLabel}\n` +
    `Player input: "${phrase}"\n` +
    `Enterable sites:\n${JSON.stringify(candidateList)}\n\n` +
    'Respond with exactly one of:\n' +
    '{"result":"resolved","site_id":"<id from list above>"}\n' +
    '{"result":"ambiguous","ambiguous_ids":["<id>","<id>"]}\n' +
    '{"result":"no_match"}';

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user',   content: userPrompt   }
  ];

  let llmRaw;
  try {
    llmRaw = await callDeepSeek(messages);
  } catch (err) {
    return { result: 'no_match', method: 'llm', error: err?.message ?? 'callDeepSeek threw' };
  }

  if (!llmRaw.ok) {
    return { result: 'no_match', method: 'llm', error: llmRaw.error };
  }

  const parsed = safeParseJSON(llmRaw.content);
  if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null) {
    return { result: 'no_match', method: 'llm', error: 'PARSE_FAILED' };
  }

  const v = parsed.value;
  const validResults = ['resolved', 'ambiguous', 'no_match'];
  if (!validResults.includes(v.result)) {
    return { result: 'no_match', method: 'llm', error: 'INVALID_RESULT_FIELD' };
  }

  const validIds = new Set(candidates.map(s => s.site_id));

  if (v.result === 'resolved') {
    // Hallucination guard: site_id must be in candidate list
    if (typeof v.site_id !== 'string' || !validIds.has(v.site_id)) {
      return { result: 'no_match', method: 'llm', error: 'HALLUCINATED_SITE_ID' };
    }
    return { result: 'resolved', site_id: v.site_id, method: 'llm' };
  }

  if (v.result === 'ambiguous') {
    const filtered = Array.isArray(v.ambiguous_ids)
      ? v.ambiguous_ids.filter(id => typeof id === 'string' && validIds.has(id))
      : [];
    return { result: 'ambiguous', ambiguous_ids: filtered, method: 'llm' };
  }

  return { result: 'no_match', method: 'llm' };
}
