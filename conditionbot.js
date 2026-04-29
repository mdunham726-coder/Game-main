'use strict';

/**
 * conditionbot.js — Condition Bot v1.0.0
 *
 * Isolated lifecycle manager for player.conditions[].
 *
 * Responsibilities:
 *   - Evaluate each active condition each turn
 *   - Update description only on genuine qualitative change
 *   - Append [bot] turn_log entries for every change
 *   - Resolve and archive healed conditions
 *
 * Strict boundaries (DO NOT SOFTEN):
 *   - Reads only: condition description, turn_log, notes, created_turn, current turn
 *   - Writes only: description, turn_log (append), resolved status
 *   - Never touches any other game state
 *   - Never creates conditions (CB owns creation)
 *   - Never reads full narration history
 */

const axios = require('axios');

const DEEPSEEK_URL        = 'https://api.deepseek.com/v1/chat/completions';
const CONDITIONBOT_TIMEOUT = 45000;
const AGING_THRESHOLD      = 200; // turns — forced review if age >= this

const CONDITIONBOT_VERSION = '1.0.0';

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a Condition Bot — a lifecycle manager for physical conditions affecting a player character in a text RPG.

Your only job is to evaluate whether each condition has changed, worsened, improved, or resolved since it was last updated.

AUTHORITY:
- You own lifecycle: progression, worsening, improvement, resolution.
- The narrator describes what IS. You determine what CHANGES over time.
- The narrator must NOT predict recovery timelines or simulate healing. That is your job.

ISOLATION RULES (absolute):
- You operate only on the condition data you are given. Nothing else.
- You cannot create new conditions. You cannot modify world state, inventory, NPCs, or player attributes.
- Do not invent gameplay events. Do not read intent into absence of evidence.

DESCRIPTION RULES:
- The description is a live snapshot of the current state — not a log.
- ONLY update the description when the condition has QUALITATIVELY changed.
- Minor rewording, paraphrasing, or stylistic rewriting is FORBIDDEN.
- Valid changes: swelling increases, pain decreases, mobility improves, bleeding stops, bruising deepens, stiffness resolves.
- Invalid changes: "still hurts" → "still aching" → "remains painful" — these are the same state, do not update.
- When updating a description, you MUST be able to name the concrete physical change in the qualitative_change field. If you cannot name it, you must return no_change=true.

TURN LOG RULES:
- The turn log is append-only. Never rewrite or summarize it.
- Every meaningful change (worsen, improve, resolve) MUST produce a [bot] entry.
- No-op turns produce NO entry. Silence is the correct output when nothing has changed.
- Format: "Turn N [bot]: <plain explanation of what changed and why>"
- Example: "Turn 18 [bot]: No treatment recorded; swelling has increased and stiffness worsened."
- Example: "Turn 30 [bot]: No recent aggravation; swelling has begun to subside."
- Example: "Turn 42 [bot]: Condition has gradually resolved; no remaining pain or impairment."

RESOLUTION RULES:
- Minor conditions: may resolve without treatment if sufficient time has passed and no recent aggravation.
- Serious conditions: must NOT resolve without plausible treatment evidence.
- When resolved: set resolved=true and write a final [bot] turn_log entry explaining why.

SAME-TURN EVIDENCE RULE:
- Notes added this same turn (matching current turn number) are baseline evidence, not grounds for immediate escalation unless the evidence is explicitly severe.
- Do not overreact to single-turn evidence. Look at the full turn_log trajectory.

BATCH INDEPENDENCE RULE:
- You will receive multiple conditions in one call. Evaluate each independently.
- Do not compare conditions to each other. Do not merge or cross-reference them.
- Each condition is its own closed evaluation.

AGING RULE:
- Conditions flagged with force_review=true have been active for a long time without interaction.
- You MUST make a decision: resolve (if plausibly healed), update (if logically evolved), or persist (with explanation).
- You cannot pass on a force_review condition without a decision.

NO-OP RULE (critical):
- If nothing has meaningfully changed, return no_change=true.
- Do not rewrite the description. Do not add a turn_log entry.
- Silence is correct when nothing has changed.`;

// ── Main run function ─────────────────────────────────────────────────────────

async function run(conditions, currentTurn, apiKey) {
  if (!apiKey) {
    console.warn('[ConditionBot] DEEPSEEK_API_KEY not set — skipped');
    return conditions;
  }
  if (!Array.isArray(conditions) || conditions.length === 0) {
    return conditions;
  }

  // Build input for each condition
  const inputs = conditions.map(c => {
    const age = currentTurn - c.created_turn;
    const force_review = age >= AGING_THRESHOLD;
    return {
      condition_id:        c.condition_id,
      description:         c.description,
      turn_log:            c.turn_log || [],
      notes:               c.notes || [],
      created_turn:        c.created_turn,
      turns_since_creation: age,
      force_review
    };
  });

  const userMessage = `CURRENT TURN: ${currentTurn}

Evaluate each condition below. Return a JSON array with one entry per condition, in the same order.

CONDITIONS:
${JSON.stringify(inputs, null, 2)}

---

For each condition, return an object with these fields:

{
  "condition_id": "<exact condition_id from input>",
  "no_change": true | false,
  "resolved": true | false,
  "qualitative_change": "<required when no_change=false and resolved=false — name the specific physical change: e.g. 'swelling reduced', 'bruising deepened', 'mobility returned'. Must be concrete. If you cannot name a concrete physical change, return no_change=true instead.>",
  "new_description": "<updated description string, or null if no_change or resolved>",
  "turn_log_entry": "<'Turn N [bot]: ...' string to append, or null if no_change>"
}

Rules:
- If nothing has meaningfully changed: no_change=true, resolved=false, qualitative_change=null, new_description=null, turn_log_entry=null
- If changed but not resolved: no_change=false, resolved=false, qualitative_change="<concrete physical change>", new_description="<updated>", turn_log_entry="Turn ${currentTurn} [bot]: <explanation>"
- If resolved: no_change=false, resolved=true, qualitative_change=null, new_description=null, turn_log_entry="Turn ${currentTurn} [bot]: <final explanation>"
- CRITICAL: if you want to update a description but cannot state a qualitative_change, you MUST return no_change=true. Restating the same condition in different words is not a qualitative change.
- Evaluate each condition independently. Do not cross-reference conditions.
- Return ONLY the JSON array. No explanation, no wrapper text.`;

  let raw = null;
  try {
    const resp = await axios.post(
      DEEPSEEK_URL,
      {
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: userMessage }
        ],
        temperature: 0.2,
        max_tokens: 800
      },
      {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: CONDITIONBOT_TIMEOUT
      }
    );
    raw = resp?.data?.choices?.[0]?.message?.content || null;
  } catch (err) {
    console.error('[ConditionBot] LLM call failed:', err.message);
    return conditions; // fail-safe: return unchanged
  }

  let results = null;
  try {
    const cleaned = (raw || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    results = JSON.parse(cleaned);
    if (!Array.isArray(results)) throw new Error('Expected array');
  } catch (parseErr) {
    console.error('[ConditionBot] JSON parse failed:', parseErr.message, '| raw:', (raw || '').slice(0, 200));
    return conditions; // fail-safe: return unchanged
  }

  // Apply results
  const updatedConditions = [];
  const archive = [];

  for (const condition of conditions) {
    const result = results.find(r => r.condition_id === condition.condition_id);
    if (!result) {
      console.warn(`[ConditionBot] No result for condition_id ${condition.condition_id} — kept unchanged`);
      updatedConditions.push(condition);
      continue;
    }

    if (result.no_change) {
      updatedConditions.push(condition);
      continue;
    }

    if (result.resolved) {
      // Archive with final log entry
      const archived = { ...condition };
      if (result.turn_log_entry) archived.turn_log = [...archived.turn_log, result.turn_log_entry];
      archived.resolved_turn = currentTurn;
      archive.push(archived);
      console.log(`[ConditionBot] Condition resolved and archived: ${condition.condition_id}`);
      continue;
    }

    // Update — enforce qualitative_change requirement before accepting description change
    const _qc = (result.qualitative_change || '').trim();
    if (!_qc || _qc.length < 8) {
      // Model claimed a change but could not name what changed — treat as no_change
      console.warn(`[ConditionBot] Update rejected — no qualitative_change stated for ${condition.condition_id} (got: "${_qc || 'null'}")`);
      updatedConditions.push(condition);
      continue;
    }
    const updated = { ...condition };
    if (result.new_description) updated.description = result.new_description;
    if (result.turn_log_entry)  updated.turn_log = [...updated.turn_log, result.turn_log_entry];
    updatedConditions.push(updated);
    console.log(`[ConditionBot] Condition updated: ${condition.condition_id} — ${_qc}`);
  }

  return { updatedConditions, archive };
}

module.exports = { run, CONDITIONBOT_VERSION };
