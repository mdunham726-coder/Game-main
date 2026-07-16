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
    "Only assign action='move' when the player clearly intends to travel to a new location. Do not infer movement from body-part words (e.g., 'right foot', 'left hand') or positional language used in non-travel contexts. Climbing verbs (climb, scale, ascend, clamber) only classify as move when an explicit direction or traversal path is present alongside them (e.g. 'climb up', 'climb down into the cellar', 'climb north over the ridge'). 'Climb [object or terrain target]' with no explicit direction word is a physical interaction, not travel — classify as freeform.",
    "action='move' REQUIRES a compass direction (north/south/east/west/up/down). Never set action='move' without a clear compass direction.",
    "Use action='enter' for phrases like: 'go to [place]', 'go into [X]', 'head to [X]', 'get in/inside [X]', 'enter', 'go in', 'go inside', or any phrase that implies entry. If the player names a structure, capture it in target. If the player's phrasing implies entry without naming a structure (e.g. bare 'enter', 'go in', 'go inside'), set target to null — the engine resolves contextually. If a named target is present, it must be captured in target; do not return target: null when a location is named. If the target is a person or NPC, use action='talk' instead; if the target is an object, use 'examine' or 'take'.",
    "Use action='talk' for phrases like: 'talk to [person]', 'speak with [person]', 'walk over and talk to [X]', or any phrase directed at an NPC or person. The target should be the person or NPC name/role.",
    "Use action='throw' for phrases like: 'throw [item]', 'toss [item]', 'hurl [item]', 'fling [item]', 'chuck [item]', 'lob [item]', 'pitch [item]', or any phrase where the player propels, launches, or forcefully releases an item away from themselves through the air. Target should be the base item name only. When the player uses a quantity prefix to select from a held stack ('one of the', 'some of the', 'a', 'the'), strip the prefix — return only the core object name, AND set selection_mode to \"partial_from_stack\" on that specific action object to indicate partial-stack intent. For all other throw actions, leave selection_mode as null. Do NOT use throw for smash/slam/bash/crush/pound/ram patterns.",
    "Use action='drop' for phrases like: 'drop [item]', 'put down [item]', 'set down [item]', 'place [item] on the ground', or any phrase where the player releases a held item to the floor. Target should be the base item name only. When the player uses a quantity prefix to select from a held stack ('one of the', 'some of the', 'a', 'the'), strip the prefix — return only the core object name, AND set selection_mode to \"partial_from_stack\" on that specific action object to indicate partial-stack intent. For all other drop actions, leave selection_mode as null.",
    "Use action='smash' for phrases like: 'smash [item] on/against [target]', 'slam [item] against [target]', 'bash [item] on [target]', 'crush [item] against [target]', 'pound [item] on/against [target]', 'ram [item] into [target]', or any phrase where the player drives, strikes, or impacts an object against a surface or target with destructive/impact intent. Also captures the reverse frame: 'smash the apple with a rock' where the named target is the object being acted upon and the instrument is specified. Key distinction: throw = item leaves hand and travels through the air; smash = item or target is struck with impact intent, item does not necessarily leave the player's hand. Target should be the primary object being smashed or struck.",
    "Use action='exit' for phrases like: 'out of', 'go out', 'leave', 'exit', 'get out'. exit is an action, not a direction value. Never use dir='exit'.",
    "Use action='remove' for phrases like: 'take off [item]', 'remove [item]', 'unequip [item]', 'strip off [item]'. Applies when the player is removing clothing or equipment from their own body. Target should be the worn item name. For aggregate phrases that mean removing ALL worn items at once ('take off everything', 'take off all my clothes', 'undress', 'strip naked', 'strip down', 'get undressed', 'get naked'), set target to '__all_worn__' (the literal string).",
    "For action='take': when the player specifies a quantity or unit of a sub-part (e.g. 'take 5 slices of bread', 'take some milk', 'take a piece of cake', 'take three cups of water'), preserve the FULL noun phrase including quantity, unit, and object name in target — do NOT reduce to just the base object name. When the player names a whole discrete object with no unit word (e.g. 'take the loaf', 'take the knife', 'take a loaf of bread'), return the canonical object name without leading article (e.g. target='loaf of bread', target='knife'). When the player uses a quantity prefix to select from a known stack ('one of the', 'two of the', 'some of the', 'a few of the'), strip the prefix — return only the core object name, AND set selection_mode to \"partial_from_stack\" on the primaryAction to indicate partial-stack intent. For all other take actions, leave selection_mode as null.",
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
    '  "primaryAction": { "action": "...", "target": "...", "dir": "...", "selection_mode": null },',
    '  "secondaryActions": [{ "action": "...", "target": "...", "selection_mode": null }, ...],',
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
        model: "deepseek-v4-flash",
        thinking: { type: "disabled" },
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

// v1.91.23: deterministic parser enrichment — adds structured metadata to primaryAction
// before return. Pure function: returns enriched copy, never mutates input. All fields
// are hints only — no mechanical interpretation, no object-operation authority.
// Quantity extraction is target-scoped. rawInput used only for source_container_hint.
function _enrichPrimaryAction(primaryAction, rawInput) {
  if (!primaryAction || typeof primaryAction !== 'object') return primaryAction;

  const enriched = { ...primaryAction };
  const target = typeof enriched.target === 'string' ? enriched.target.trim() : '';
  const raw    = typeof rawInput === 'string' ? rawInput.trim() : '';

  // ── Phase 3.5A: extract object phrase from rawInput (verb-stripped) ──────
  // rawInput is authoritative for player wording — target is canonicalized by
  // the LLM and fast paths, which strip articles/quantity words before enrichment
  // ever sees them. Extracting from rawInput recovers what canonicalization lost.
  // v1.91.32: strip known multi-word verbs first, then fall back to single-token.
  const _multiWordMatch = raw.match(/^(pick up|put down|set down)\s+/i);
  const _body = _multiWordMatch
    ? raw.replace(_multiWordMatch[0], '').trim()
    : raw.replace(/^\S+\s+/, '').trim();

  // ── requested_quantity: integer from leading digits in object phrase ──────
  const _qtyMatch = _body.match(/^(\d+)\s+/);
  enriched.requested_quantity = _qtyMatch ? parseInt(_qtyMatch[1], 10) : null;

  // ── quantity_word: leading quantity-signal word in object phrase ──────────
  // v1.91.32: added word-number recognition (one-ten) with requested_quantity mapping.
  // "a few" is checked before bare "a" to prevent "a few" from being classified as article.
  let _qWord;
  if (/^a few\s+/i.test(_body)) {
    _qWord = 'a few';
  } else {
    const _wordMatch = _body.match(/^(a|an|some|all|every|one|two|three|four|five|six|seven|eight|nine|ten)\s+/i);
    _qWord = _wordMatch ? _wordMatch[1].toLowerCase() : null;
  }
  enriched.quantity_word = _qWord;

  // Map word-number quantity_word to requested_quantity (digits handled above)
  if (enriched.quantity_word && enriched.requested_quantity === null) {
    const _wordNumMap = { one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10 };
    if (_wordNumMap[enriched.quantity_word] !== undefined) {
      enriched.requested_quantity = _wordNumMap[enriched.quantity_word];
    }
  }

  // ── quantity_mode: controlled classification ─────────────────────────────
  if (enriched.requested_quantity !== null && enriched.quantity_word === 'all') {
    enriched.quantity_mode = 'all';            // "all 15 tortillas"
  } else if (enriched.requested_quantity !== null) {
    enriched.quantity_mode = 'exact';          // "5 arrows"
  } else if (enriched.quantity_word === 'all' || enriched.quantity_word === 'every') {
    enriched.quantity_mode = 'all';            // "all tortillas" / "every arrow"
  } else if (enriched.quantity_word === 'some' || enriched.quantity_word === 'a few') {
    enriched.quantity_mode = 'some';           // "some arrows" / "a few coins"
  } else if (enriched.quantity_word === 'a' || enriched.quantity_word === 'an') {
    enriched.quantity_mode = 'article';        // "a sword"
  } else {
    enriched.quantity_mode = 'unspecified';
  }

  // ── v1.91.32: deterministic selection_mode fill for stack-selection take ──
  // Recovers partial-stack intent from rawInput when LLM omits it. Only fills
  // for 'take' action family. Does NOT override LLM-emitted selection_mode.
  // Article-safety: "take an apple" / "take the apple" are NOT partial-stack.
  // v1.91.36: bare quantity fallback — digit or word-number prefix on take is partial-stack intent
  // when requested_quantity is explicit (quantity_mode === 'exact'). "all" and article
  // forms are excluded by the quantity_mode guard.
  if (!enriched.selection_mode && enriched.action === 'take') {
    const _bodyLower = _body.toLowerCase();
    if (/\b(one|two|three|four|five|six|seven|eight|nine|ten|some|a few)\s+of\s+the\b/i.test(_bodyLower)) {
      enriched.selection_mode = 'partial_from_stack';
    } else if (enriched.requested_quantity !== null && enriched.quantity_mode === 'exact') {
      enriched.selection_mode = 'partial_from_stack';
    }
  }

  // ── normalized_target: strip quantity/ determiner prefix ──────────────────
  // v1.91.53: added word-number, "more", and source-preposition stripping for
  // resolver-only normalization. Strips leading quantity, modifier, and
  // source-preposition tokens for resolver targeting only — does not change
  // quantity signals or execution behavior.
  if (target) {
    let _norm = target
      .replace(/^(all\s+\d+)\s+/i, '')     // "all 15 tortillas" → "tortillas"
      .replace(/^(all)\s+/i, '')            // "all tortillas" → "tortillas"
      .replace(/^(\d+)\s+/, '')             // "5 arrows" → "arrows"
      .replace(/^(a|an|the|some|my|every)\s+/i, '') // "a sword" → "sword"
      .replace(/^(one|two|three|four|five|six|seven|eight|nine|ten)\s+/i, '') // "two pinecones" → "pinecones"
      .replace(/^more\s+/i, '')             // "more pinecones" → "pinecones"
      .replace(/^(?:of|from|off)\s+(?:the\s+)?/i, '') // "of the pinecones" → "pinecones"
      .trim();
    enriched.normalized_target = _norm || target; // fallback to original if stripped empty
  } else {
    enriched.normalized_target = null;
  }

  // ── operation_family: deterministic action→family mapping ─────────────────
  const _familyMap = {
    take:'take', drop:'drop', throw:'throw', remove:'remove',
    enter:'enter', exit:'exit', move:'move', examine:'examine',
    talk:'talk', smash:'smash', attack:'attack', cast:'cast'
  };
  enriched.operation_family = _familyMap[enriched.action] || enriched.action || null;

  // ── source_container_hint: "from X" pattern in rawInput ──────────────────
  if (raw) {
    const _fromMatch = raw.match(/\bfrom\s+(?:the\s+)?(\S+(?:\s+\S+){0,2})\s*$/i);
    enriched.source_container_hint = _fromMatch ? _fromMatch[1].replace(/[,.!?;:'"]+$/g, '').trim().toLowerCase() : null;
  } else {
    enriched.source_container_hint = null;
  }

  // ── selection_mode: preserve LLM-emitted value, do not overwrite ──────────
  // (already preserved via spread — no action needed)

  return enriched;
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
    return { success: false, error: "EMPTY_INPUT", error_code: "EMPTY_INPUT", raw_content: null };
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
        const _pa = _enrichPrimaryAction({ action: 'take', target: _targetRaw, dir: null }, raw);
        const _fastResult = {
          success: true,
          intent: { primaryAction: _pa, secondaryActions: [], compound: false },
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
      const _paEnter = _enrichPrimaryAction({ action: 'enter', target: null, dir: null }, raw);
      const _bareEntryResult = {
        success: true,
        intent: { primaryAction: _paEnter, secondaryActions: [], compound: false },
        confidence: 0.97
      };
      const _bareEntryKey = hashKey(`${channel}|${raw}|fast_path`);
      setToCache(_bareEntryKey, _bareEntryResult);
      return _bareEntryResult;
    }
    // v1.85.24: aggregate remove fast-path — must come BEFORE single-item path.
    // Phrases: "take off all", "take off everything", "undress", "strip naked", "strip down",
    // "get undressed", "get naked", "remove everything", "unequip everything", etc.
    // Bare "strip" intentionally excluded (too ambiguous — routes to LLM).
    if (/^(?:take\s+off|remove|unequip|strip\s+off)\s+(?:all|everything)(?:\s.*)?$|^(?:undress|strip(?:\s+naked)?|strip\s+down|get\s+(?:undressed|naked))$/i.test(raw)) {
      log('fast_path', `aggregate remove -> action=remove target=__all_worn__`);
      const _paAggRemove = _enrichPrimaryAction({ action: 'remove', target: '__all_worn__', dir: null }, raw);
      const _aggRemoveResult = {
        success: true,
        intent: { primaryAction: _paAggRemove, secondaryActions: [], compound: false },
        confidence: 0.97
      };
      const _aggRemoveKey = hashKey(`${channel}|${raw}|fast_path`);
      setToCache(_aggRemoveKey, _aggRemoveResult);
      return _aggRemoveResult;
    }
    // v1.85.23: remove fast-path — "take off X", "remove X", "unequip X", "strip off X"
    // Always means: remove a worn item from player body. Target required after article-strip.
    const _removeFastMatch = _rawLower.match(/^(?:take\s+off|remove|unequip|strip\s+off)\s+(.+)$/);
    if (_removeFastMatch) {
      const _removeTargetRaw = _removeFastMatch[1].replace(/^(a|an|the|my)\s+/i, '').trim();
      if (_removeTargetRaw.length > 0) {
        log('fast_path', `remove verb -> action=remove target="${_removeTargetRaw}"`);
        const _paRemove = _enrichPrimaryAction({ action: 'remove', target: _removeTargetRaw, dir: null }, raw);
        const _removeResult = {
          success: true,
          intent: { primaryAction: _paRemove, secondaryActions: [], compound: false },
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
    const _errorCode = (llm.error === "PARSE_FAILED") ? "EMPTY_CONTENT" : llm.error;
    const out = { success: false, error: llm.error, error_code: _errorCode, raw_content: null, intent: null };
    setToCache(cacheKey, out);
    return out;
  }

  const parsed = safeParseJSON(llm.content);
  if (!parsed.ok || typeof parsed.value !== "object" || parsed.value === null) {
    const out = { success: false, error: "PARSE_FAILED", error_code: "INVALID_JSON", raw_content: llm.content?.substring(0, 500) || null, intent: null };
    setToCache(cacheKey, out);
    return out;
  }

  const v = parsed.value;
  const confidence = (typeof v.confidence === "number") ? v.confidence : NaN;
  if (!Number.isFinite(confidence)) {
    const out = { success: false, error: "PARSE_FAILED", error_code: "NON_FINITE_CONFIDENCE", raw_content: llm.content?.substring(0, 500) || null, intent: null };
    setToCache(cacheKey, out);
    return out;
  }
  if (confidence < 0.7) {
    log("warn", `error=LOW_CONFIDENCE input="${raw}" confidence=${confidence}`);
    const out = { success: false, error: "LOW_CONFIDENCE", error_code: "LOW_CONFIDENCE", raw_content: llm.content?.substring(0, 500) || null, intent: null, confidence };
    setToCache(cacheKey, out);
    return out;
  }

  const primaryAction = v.primaryAction && typeof v.primaryAction === "object" ? v.primaryAction : null;
  if (!primaryAction || typeof primaryAction.action !== "string" || primaryAction.action.length === 0) {
    const out = { success: false, error: "PARSE_FAILED", error_code: "MISSING_PRIMARY_ACTION", raw_content: llm.content?.substring(0, 500) || null, intent: null };
    setToCache(cacheKey, out);
    return out;
  }

  // v1.91.23: enrich with structured metadata before building intent
  const enrichedPrimary = _enrichPrimaryAction(primaryAction, raw);

  const intent = {
    primaryAction: enrichedPrimary,
    secondaryActions: Array.isArray(v.secondaryActions) ? v.secondaryActions : undefined,
    compound: Boolean(v.compound),
    rawInput: raw
  };

  log("info", `input="${raw}" action="${primaryAction.action}" confidence=${confidence}`);

  const result = { success: true, intent, confidence, parser_usage: llm.usage || null };
  setToCache(cacheKey, result);
  return result;
}

module.exports = { normalizeUserIntent, resolveEnterTarget, _enrichPrimaryAction };

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
