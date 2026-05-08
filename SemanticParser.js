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

function buildPrompt(userInput, contextStr, channel = 'do') {
  const SYSTEM_TEXT = "You are a text adventure game parser. Convert player intent to JSON.";

  // === PHASE 5b: Channel-aware instruction sets ===
  // Do channel: unchanged from pre-5b behavior
  const _doInstructions = [
    // === PHASE 3C: Quest actions added to valid actions list ===
    // NOTE: 'help' removed — Help channel bypasses parser entirely (Phase 1/5a)
    "Valid actions: move, take, drop, throw, smash, examine, talk, enter, exit, accept_quest, complete_quest, ask_about_quest, sit, stand, look, cast, sneak, attack, listen, wait, inventory, state_claim, remove",
    "state_claim: State claims are declarative assertions of already-true possession, identity, condition, or world fact. Imperative action attempts must not be classified as state claims merely because success would change possession or world state. The parser classifies intent — the engine determines whether the object or condition exists. Use state_claim only when the input's primary structure is a declarative assertion (e.g. 'I have X', 'I am X', 'there is X here') with no imperative acquisition or interaction verb driving it. Physical acquisition verbs (grab, snatch, take, get, pick up, lift, collect, pluck, retrieve, etc.) must be classified as action='take' — never state_claim. A state_claim must never create, modify, or confirm any fact by itself; it only routes the input toward bounded narration that acknowledges the claim, checks it against engine truth, and refuses to promote unsupported reality. When input combines an action verb with a discovery result in the same clause, apply this test: does the input leave the outcome open for the engine to determine, or does it assert the outcome as already true? An attempt leaves the outcome open — the player is trying, not declaring. A declaration asserts the result as fact. Classify as state_claim when the player's input declares a found object or condition as an existing fact, regardless of whether an action verb precedes it.",
    "",
    "Directions: north, south, east, west, up, down",
    "Only assign action='move' when the player clearly intends to travel to a new location. Do not infer movement from body-part words (e.g., 'right foot', 'left hand') or positional language used in non-travel contexts.",
    "action='move' REQUIRES a compass direction (north/south/east/west/up/down). Never set action='move' without a clear compass direction.",
    "Use action='enter' for phrases like: 'go to [place]', 'go into [X]', 'head to [X]', 'get in/inside [X]', 'enter', 'go in', 'go inside', or any phrase that implies entry. If the player names a structure, capture it in target. If the player's phrasing implies entry without naming a structure (e.g. bare 'enter', 'go in', 'go inside'), set target to null — the engine resolves contextually. If a named target is present, it must be captured in target; do not return target: null when a location is named. If the target is a person or NPC, use action='talk' instead; if the target is an object, use 'examine' or 'take'.",
    "Use action='talk' for phrases like: 'talk to [person]', 'speak with [person]', 'walk over and talk to [X]', or any phrase directed at an NPC or person. The target should be the person or NPC name/role.",
    "Use action='throw' for phrases like: 'throw [item]', 'toss [item]', 'hurl [item]', 'fling [item]', 'chuck [item]', 'lob [item]', 'pitch [item]', or any phrase where the player propels, launches, or forcefully releases an item away from themselves through the air. Target should be the item name. Do NOT use throw for smash/slam/bash/crush/pound/ram patterns.",
    "Use action='smash' for phrases like: 'smash [item] on/against [target]', 'slam [item] against [target]', 'bash [item] on [target]', 'crush [item] against [target]', 'pound [item] on/against [target]', 'ram [item] into [target]', or any phrase where the player drives, strikes, or impacts an object against a surface or target with destructive/impact intent. Also captures the reverse frame: 'smash the apple with a rock' where the named target is the object being acted upon and the instrument is specified. Key distinction: throw = item leaves hand and travels through the air; smash = item or target is struck with impact intent, item does not necessarily leave the player's hand. Target should be the primary object being smashed or struck.",
    "Use action='exit' for phrases like: 'out of', 'go out', 'leave', 'exit', 'get out'. exit is an action, not a direction value. Never use dir='exit'.",
    "Use action='remove' for phrases like: 'take off [item]', 'remove [item]', 'unequip [item]', 'strip off [item]'. Applies when the player is removing clothing or equipment from their own body. Target should be the worn item name.",
    "If the player's input is expressive, theatrical, or physical-performance language with no clear mechanical intent (e.g., dancing, spinning, performing, celebrating), set action to 'wait' and confidence to 0.3.",
    "",
    // === PHASE 3C: Quest-specific parsing context ===
    "Quest actions:",
    "- accept_quest: Player accepts quest from NPC (e.g., 'accept quest from guard', 'take the quest', 'yes I\'ll help')",
    "- complete_quest: Player completes quest with NPC (e.g., 'complete quest with guard', 'turn in quest', 'report back')",
    "- ask_about_quest: Player inquires about quest from NPC (e.g., 'ask guard about quest', 'what quests do you have', 'any work available')",
    "For quest actions, 'target' should be the NPC name/identifier.",
    "",
    "Modifiers: carefully, sneakily, gently, forcefully, angrily, etc.",
  ];

  // Say channel: social-only instruction set (Phase 5b)
  const _sayInstructions = [
    "SAY CHANNEL — The player is directing speech at an NPC. This is a dialogue or social turn, not a mechanical action.",
    "",
    "Valid actions for SAY channel: talk, accept_quest, complete_quest, ask_about_quest, wait",
    "NEVER classify SAY channel input as: move, take, drop, examine, enter, exit, attack, sneak, cast, or any physical/mechanical action.",
    "",
    "Determine the social action that best fits the player's words:",
    "- talk: any conversational speech, greeting, statement, question, threat, plea, or general NPC interaction",
    "- accept_quest: player clearly agrees to take a task (e.g., 'I\'ll do it', 'yes I\'ll help', 'count me in')",
    "- complete_quest: player reports task completion (e.g., 'it\'s done', 'I found them', 'here\'s what you asked for')",
    "- ask_about_quest: player asks about available work or tasks (e.g., 'any jobs?', 'what do you need?', 'do you have work?')",
    "- wait: use ONLY when the input cannot be interpreted as social interaction at all",
    "",
    "Default to action='talk' when in doubt. Set confidence 0.95 for talk and quest actions; 0.3 for wait.",
    "Target should be the NPC being addressed if identifiable from context; otherwise null.",
    "Text wrapped in asterisks (*like this*) indicates player gesture or body language — this is still action='talk'. Include the full raw input as-is in your interpretation.",
  ];

  const USER_TEXT = [
    contextStr,
    "",
    ...(channel === 'say' ? _sayInstructions : _doInstructions),
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
      return { ok: false, error: "PARSE_FAILED", content: null, usage: null };
    }
    const usage = resp?.data?.usage || null;
    return { ok: true, error: null, content, usage };
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
async function normalizeUserIntent(userInput, gameContext, channel = 'do') {
  const raw = (typeof userInput === "string") ? userInput.trim() : "";
  if (!raw) {
    return { success: false, error: "EMPTY_INPUT" };
  }

  // v1.84.99: Pre-LLM fast path for unambiguously imperative acquisition verbs.
  // "grab" and "snatch" have no false-positive risk in text adventure context —
  // they always mean take. Parser classifies intent; engine validates existence.
  // Do channel only; target text required after article-strip.
  if (channel === 'do') {
    const _rawLower = raw.toLowerCase();
    const _fastMatch = _rawLower.match(/^(grab|snatch)\s+(.+)$/);
    if (_fastMatch) {
      const _verb = _fastMatch[1];
      const _targetRaw = _fastMatch[2].replace(/^(a|an|the)\s+/i, '').trim();
      if (_targetRaw.length > 0) {
        log('fast_path', `verb="${_verb}" -> action=take target="${_targetRaw}"`);
        const _fastResult = {
          success: true,
          intent: { primaryAction: { action: 'take', target: _targetRaw, dir: null }, secondaryActions: [], compound: false },
          confidence: 0.97
        };
        const _fastKey = hashKey(`${channel}|${raw}|fast_path`);
        setToCache(_fastKey, _fastResult);
        return _fastResult;
      }
    }
    // v1.85.4: bare-entry fast-path — strictly end-anchored, do channel only.
    // Matches complete bare entry phrases with no named target.
    // Targeted enters (e.g. "enter the tavern") fall through to LLM path.
    if (/^(enter|go in|go inside|go back in|head inside|head back in|get inside)$/i.test(raw)) {
      log('fast_path', `bare_entry raw="${raw}" -> action=enter target=null`);
      const _bareEntryResult = {
        success: true,
        intent: { primaryAction: { action: 'enter', target: null, dir: null }, secondaryActions: [], compound: false },
        confidence: 0.97
      };
      const _bareEntryKey = hashKey(`${channel}|${raw}|fast_path`);
      setToCache(_bareEntryKey, _bareEntryResult);
      return _bareEntryResult;
    }
    // v1.85.23: remove fast-path — "take off X", "remove X", "unequip X", "strip off X"
    // Always means: remove a worn item from player body. Target required after article-strip.
    const _removeFastMatch = _rawLower.match(/^(?:take\s+off|remove|unequip|strip\s+off)\s+(.+)$/);
    if (_removeFastMatch) {
      const _removeTargetRaw = _removeFastMatch[1].replace(/^(a|an|the|my)\s+/i, '').trim();
      if (_removeTargetRaw.length > 0) {
        log('fast_path', `remove verb -> action=remove target="${_removeTargetRaw}"`);
        const _removeResult = {
          success: true,
          intent: { primaryAction: { action: 'remove', target: _removeTargetRaw, dir: null }, secondaryActions: [], compound: false },
          confidence: 0.97
        };
        const _removeKey = hashKey(`${channel}|${raw}|fast_path`);
        setToCache(_removeKey, _removeResult);
        return _removeResult;
      }
    }
  }

  const contextStr = serializeContext(gameContext);
  const cacheKey = hashKey(`${channel}|${raw}|${contextStr}`);

  const cached = getFromCache(cacheKey);
  if (cached) return cached;

  const messages = buildPrompt(raw, contextStr, channel);
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

  const result = { success: true, intent, confidence, parser_usage: llm.usage || null };
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
    site_id:  s.site_id,
    name:     s.name     || null,
    identity: s.identity || null
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
