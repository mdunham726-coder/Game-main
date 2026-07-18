#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const axios = require('axios');

const controller = require('../motherbrain-controller.js');
const {
  DEEPSEEK_CHAT_COMPLETIONS_URL,
  MAX_REQUEST_UTF8_BYTES,
  MODEL_IDS,
  PRICE_TABLE,
  PRICE_TABLE_SOURCE_DATE,
  REASONING_EFFORTS,
  buildV4RequestBody,
  captureAssistantMessage,
  classifyProviderRequestError,
  retryDelayMilliseconds,
  serializedBodyUtf8Bytes
} = controller;

const SPIKE_OUTPUT_TOKENS = 8192;
const OVERSIZE_OUTPUT_TOKENS = 1;
const OVERSIZE_PAIR_COUNT = 1_050_000;
const MAX_HTTP_REQUESTS = 10;
const PLANNED_HTTP_REQUESTS = 7;
const HTTP_TIMEOUT_MS = 600000;
const EVIDENCE_SCHEMA_VERSION = 1;
const REPO = path.resolve(__dirname, '..');
const LOG_DIR = path.join(REPO, 'logs');

const ECHO_TOOL = Object.freeze({
  type: 'function',
  function: {
    name: 'echo_nonce',
    description: 'Return the supplied synthetic nonce unchanged. This inert smoke tool has no external effects.',
    parameters: {
      type: 'object',
      properties: {
        nonce: { type: 'string', description: 'Synthetic proof nonce to echo unchanged.' }
      },
      required: ['nonce']
    }
  }
});

const SYSTEM_PROMPT = [
  'This is an inert DeepSeek V4 tool-protocol proof.',
  'For the first user request, call echo_nonce exactly once with the exact supplied nonce.',
  'Do not answer from memory and do not call any other tool.',
  'After the linked tool result arrives, give a short final answer containing the exact nonce.'
].join(' ');

class SpikeFailure extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'SpikeFailure';
    this.code = code;
    this.details = details;
  }
}

function requireGate(condition, code, details = {}) {
  if (!condition) throw new SpikeFailure(code, details);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sha256(value) {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return crypto.createHash('sha256').update(input).digest('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function buildSpikeBody({ model, messages, maxTokens = SPIKE_OUTPUT_TOKENS }) {
  const body = buildV4RequestBody({
    model,
    reasoningEffort: REASONING_EFFORTS.high,
    messages,
    tools: [ECHO_TOOL],
    expectedToolCount: 1
  });
  body.max_tokens = maxTokens;
  requireGate(!Object.hasOwn(body, 'tool_choice'), 'tool_choice_present');
  requireGate(!Object.hasOwn(body, 'stream'), 'stream_present');
  return body;
}

function buildInitialMessages(nonce) {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Call echo_nonce with this exact nonce: ${nonce}` }
  ];
}

function buildOversizeContent() {
  const chunkPairs = 1024;
  const chunk = Array.from(
    { length: chunkPairs },
    (_, index) => `${String.fromCharCode(0x3400 + index)}\n`
  ).join('');
  return chunk.repeat(Math.ceil(OVERSIZE_PAIR_COUNT / chunkPairs)).slice(0, OVERSIZE_PAIR_COUNT * 2);
}

function buildOversizeBody() {
  return buildSpikeBody({
    model: MODEL_IDS.flash,
    maxTokens: OVERSIZE_OUTPUT_TOKENS,
    messages: [
      { role: 'system', content: 'Return a single period. This request contains only synthetic Unicode data.' },
      { role: 'user', content: buildOversizeContent() }
    ]
  });
}

function requestBodyEvidence(label, body) {
  const copy = clone(body);
  if (label !== 'context_oversize') return copy;
  const userMessage = copy.messages.find(message => message.role === 'user');
  const original = body.messages.find(message => message.role === 'user').content;
  userMessage.content = `[OMITTED SYNTHETIC OVERSIZE CONTENT: chars=${original.length}, sha256=${sha256(original)}]`;
  return copy;
}

function safeHeaders(headers) {
  if (!headers) return {};
  const result = {};
  for (const name of ['x-request-id', 'request-id', 'x-ds-request-id', 'date']) {
    const value = typeof headers.get === 'function' ? headers.get(name) : headers[name];
    if (value !== undefined && value !== null) result[name] = String(value);
  }
  return result;
}

function makeEvidencePath() {
  const stamp = nowIso().replace(/[-:.]/g, '');
  return path.join(LOG_DIR, `mb-v4-smoke-${stamp}.json`);
}

function writeEvidence(evidencePath, evidence) {
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  const temporary = `${evidencePath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, evidencePath);
}

function actualUsageCost(model, usage) {
  const prices = PRICE_TABLE[model];
  if (!prices) return null;
  const hit = usage.prompt_cache_hit_tokens;
  const miss = usage.prompt_cache_miss_tokens;
  const output = usage.completion_tokens;
  if (![hit, miss, output].every(value => Number.isInteger(value) && value >= 0)) return null;
  return (
    hit * prices.cache_hit_per_million_usd
    + miss * prices.cache_miss_per_million_usd
    + output * prices.output_per_million_usd
  ) / 1000000;
}

function estimateWorstCase() {
  const oversizeBody = buildOversizeBody();
  const oversizeBytes = serializedBodyUtf8Bytes(oversizeBody);
  const flash = PRICE_TABLE[MODEL_IDS.flash];
  const pro = PRICE_TABLE[MODEL_IDS.pro];
  const normalInput = (
    3 * MAX_REQUEST_UTF8_BYTES * flash.cache_miss_per_million_usd
    + 3 * MAX_REQUEST_UTF8_BYTES * pro.cache_miss_per_million_usd
  ) / 1000000;
  const normalOutput = (
    3 * SPIKE_OUTPUT_TOKENS * flash.output_per_million_usd
    + 3 * SPIKE_OUTPUT_TOKENS * pro.output_per_million_usd
  ) / 1000000;
  const oversize = (
    oversizeBytes * flash.cache_miss_per_million_usd
    + OVERSIZE_OUTPUT_TOKENS * flash.output_per_million_usd
  ) / 1000000;
  return {
    logical_requests: PLANNED_HTTP_REQUESTS,
    hard_request_ceiling: MAX_HTTP_REQUESTS,
    retry_slots: MAX_HTTP_REQUESTS - PLANNED_HTTP_REQUESTS,
    ordinary_requests: { flash: 3, pro: 3, max_output_tokens_each: SPIKE_OUTPUT_TOKENS },
    oversize_request: {
      model: MODEL_IDS.flash,
      max_output_tokens: OVERSIZE_OUTPUT_TOKENS,
      synthetic_pairs: OVERSIZE_PAIR_COUNT,
      body_utf8_bytes: oversizeBytes
    },
    input_proxy: 'one serialized UTF-8 byte counted as one cache-miss input token',
    estimated_worst_case_usd: normalInput + normalOutput + oversize,
    price_source_date: PRICE_TABLE_SOURCE_DATE
  };
}

function printPlan(plan) {
  console.log('MOTHER_BRAIN_V4_STEP5_PAID_SPIKE');
  console.log(`PLANNED_HTTP_REQUESTS=${plan.logical_requests}`);
  console.log(`HARD_HTTP_REQUEST_CEILING=${plan.hard_request_ceiling}`);
  console.log(`RESERVED_RETRY_SLOTS=${plan.retry_slots}`);
  console.log(`ORDINARY_OUTPUT_CEILING=${SPIKE_OUTPUT_TOKENS}`);
  console.log(`OVERSIZE_OUTPUT_CEILING=${OVERSIZE_OUTPUT_TOKENS}`);
  console.log(`OVERSIZE_BODY_UTF8_BYTES=${plan.oversize_request.body_utf8_bytes}`);
  console.log(`ESTIMATED_WORST_CASE_USD=${plan.estimated_worst_case_usd.toFixed(6)}`);
  console.log('NETWORK_EFFECT=DeepSeek API only; inert echo tool; no production backend or game call');
  console.log('CONFIRMATION=requires --confirm-paid for --run or --resume-evidence');
}

function createEvidence(plan, evidencePath) {
  return {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    kind: 'motherbrain_v4_step5_smoke',
    started_at: nowIso(),
    completed_at: null,
    status: 'running',
    evidence_file: path.relative(REPO, evidencePath).replace(/\\/g, '/'),
    authorization: { paid_network_confirmed: true, production_backends_authorized: false },
    limits: {
      hard_http_request_ceiling: MAX_HTTP_REQUESTS,
      planned_http_requests: PLANNED_HTTP_REQUESTS,
      spike_output_tokens: SPIKE_OUTPUT_TOKENS,
      oversize_output_tokens: OVERSIZE_OUTPUT_TOKENS
    },
    estimate: plan,
    request_count: 0,
    dispatch_count: 0,
    requests: [],
    flows: [],
    usage_observations: [],
    actual_cost_usd: 0,
    calibration: null,
    context_rejection: null,
    classifier_verification: null,
    failure: null
  };
}

function summarizeUsage(label, requestBytes, envelope, evidence) {
  const usage = envelope.usage;
  requireGate(isPlainObject(usage), 'missing_usage', { label });
  for (const field of [
    'prompt_tokens', 'completion_tokens', 'total_tokens',
    'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens'
  ]) {
    requireGate(Number.isInteger(usage[field]) && usage[field] >= 0, 'invalid_usage_field', { label, field });
  }
  requireGate(
    usage.prompt_tokens === usage.prompt_cache_hit_tokens + usage.prompt_cache_miss_tokens,
    'prompt_usage_identity_failed',
    { label }
  );
  requireGate(
    usage.total_tokens === usage.prompt_tokens + usage.completion_tokens,
    'total_usage_identity_failed',
    { label }
  );
  const cost = actualUsageCost(envelope.model, usage);
  requireGate(cost !== null, 'usage_cost_unavailable', { label, model: envelope.model });
  const observation = {
    label,
    actual_model: envelope.model,
    request_body_utf8_bytes: requestBytes,
    prompt_tokens: usage.prompt_tokens,
    prompt_tokens_per_body_byte: usage.prompt_tokens / requestBytes,
    usage: clone(usage),
    cost_usd: cost
  };
  evidence.usage_observations.push(observation);
  evidence.actual_cost_usd += cost;
  return observation;
}

function parseSuccessfulEnvelope(label, result, expectedModel, evidence) {
  requireGate(result.ok, 'paid_request_failed', {
    label,
    status: result.status,
    error_code: result.classification?.code ?? null
  });
  const envelope = result.data;
  requireGate(isPlainObject(envelope), 'invalid_live_response', { label });
  requireGate(envelope.model === expectedModel, 'actual_model_mismatch', {
    label,
    expected: expectedModel,
    actual: envelope.model ?? null
  });
  requireGate(Array.isArray(envelope.choices) && envelope.choices.length === 1, 'invalid_live_choices', { label });
  const choice = envelope.choices[0];
  requireGate(isPlainObject(choice) && isPlainObject(choice.message), 'invalid_live_choice', { label });
  requireGate(choice.message.role === 'assistant', 'invalid_live_assistant', { label });
  summarizeUsage(label, result.requestBytes, envelope, evidence);
  return { envelope, choice, message: choice.message };
}

function rawContentState(message) {
  if (!Object.hasOwn(message, 'content')) return 'absent';
  if (message.content === null) return 'null';
  if (message.content === '') return 'empty_string';
  return 'nonempty';
}

function parseToolRound(label, result, expectedModel, nonce, evidence) {
  const parsed = parseSuccessfulEnvelope(label, result, expectedModel, evidence);
  requireGate(parsed.choice.finish_reason === 'tool_calls', 'expected_tool_round', {
    label,
    finish_reason: parsed.choice.finish_reason ?? null
  });
  requireGate(
    typeof parsed.message.reasoning_content === 'string' && parsed.message.reasoning_content.length > 0,
    'missing_live_reasoning',
    { label }
  );
  requireGate(Array.isArray(parsed.message.tool_calls) && parsed.message.tool_calls.length === 1, 'invalid_live_tool_calls', { label });
  const call = parsed.message.tool_calls[0];
  requireGate(typeof call.id === 'string' && call.id.length > 0, 'invalid_live_tool_id', { label });
  requireGate(call.type === 'function' && call.function?.name === 'echo_nonce', 'unexpected_live_tool', { label });
  requireGate(typeof call.function.arguments === 'string', 'invalid_live_tool_arguments', { label });
  let args;
  try {
    args = JSON.parse(call.function.arguments);
  } catch (_) {
    throw new SpikeFailure('unparseable_live_tool_arguments', { label });
  }
  requireGate(isPlainObject(args) && Object.keys(args).length === 1 && args.nonce === nonce, 'live_nonce_mismatch', { label });

  const contentState = rawContentState(parsed.message);
  requireGate(['null', 'absent', 'empty_string'].includes(contentState), 'raw_tool_content_invalid', {
    label,
    content_state: contentState
  });
  const captured = captureAssistantMessage(parsed.message);
  requireGate(rawContentState(captured.raw) === contentState, 'raw_content_state_changed', { label });
  requireGate(captured.replay.content === '', 'replay_content_not_empty_string', { label });
  requireGate(captured.replay.reasoning_content === captured.raw.reasoning_content, 'reasoning_replay_changed', { label });
  requireGate(JSON.stringify(captured.replay.tool_calls) === JSON.stringify(captured.raw.tool_calls), 'tool_call_replay_changed', { label });

  return { captured, call: clone(call), args, contentState };
}

function localEchoResult(toolRound, evidence) {
  evidence.dispatch_count++;
  return {
    role: 'tool',
    tool_call_id: toolRound.call.id,
    content: JSON.stringify({ ok: true, nonce: toolRound.args.nonce })
  };
}

function calculateCalibration(observations) {
  requireGate(observations.length > 0, 'missing_calibration_observations');
  const maximumRatio = Math.max(...observations.map(item => item.prompt_tokens_per_body_byte));
  const calibrated = Math.min(
    MAX_REQUEST_UTF8_BYTES,
    Math.floor(MAX_REQUEST_UTF8_BYTES / Math.max(1, 1.25 * maximumRatio))
  );
  return {
    formula: 'min(700000, floor(700000 / max(1, 1.25 * max(prompt_tokens / full_body_utf8_bytes))))',
    maximum_prompt_tokens_per_body_byte: maximumRatio,
    initial_max_request_utf8_bytes: MAX_REQUEST_UTF8_BYTES,
    calibrated_max_request_utf8_bytes: calibrated,
    downward_adjustment_required: calibrated < MAX_REQUEST_UTF8_BYTES
  };
}

async function requestDeepSeek(label, body, apiKey, evidence, evidencePath) {
  const requestBytes = serializedBodyUtf8Bytes(body);
  const bodyJson = JSON.stringify(body);
  const requestRecord = {
    label,
    requested_model: body.model,
    max_tokens: body.max_tokens,
    tool_choice_omitted: !Object.hasOwn(body, 'tool_choice'),
    body_utf8_bytes: requestBytes,
    body_sha256: sha256(bodyJson),
    body: requestBodyEvidence(label, body),
    attempts: []
  };
  evidence.requests.push(requestRecord);

  for (let attempt = 1; attempt <= 2; attempt++) {
    requireGate(evidence.request_count < MAX_HTTP_REQUESTS, 'http_request_ceiling_reached', {
      request_count: evidence.request_count,
      label
    });
    evidence.request_count++;
    try {
      const response = await axios.post(DEEPSEEK_CHAT_COMPLETIONS_URL, body, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: HTTP_TIMEOUT_MS,
        maxBodyLength: Infinity,
        maxContentLength: Infinity
      });
      const attemptRecord = {
        attempt,
        ok: true,
        status: response.status,
        headers: safeHeaders(response.headers),
        response: clone(response.data)
      };
      requestRecord.attempts.push(attemptRecord);
      writeEvidence(evidencePath, evidence);
      return { ok: true, status: response.status, data: response.data, requestBytes, requestRecord };
    } catch (error) {
      const classification = classifyProviderRequestError(error);
      const attemptRecord = {
        attempt,
        ok: false,
        status: classification.status,
        transport_code: classification.transport_code,
        classification: clone(classification),
        headers: safeHeaders(error.response?.headers),
        response: error.response?.data === undefined ? null : clone(error.response.data)
      };
      requestRecord.attempts.push(attemptRecord);
      writeEvidence(evidencePath, evidence);
      if (attempt === 1 && classification.retryable && evidence.request_count < MAX_HTTP_REQUESTS) {
        const delayMs = retryDelayMilliseconds(error, () => new Date());
        attemptRecord.retry_delay_ms = delayMs;
        writeEvidence(evidencePath, evidence);
        await delay(delayMs);
        continue;
      }
      return {
        ok: false,
        status: classification.status,
        data: error.response?.data ?? null,
        classification,
        requestBytes,
        requestRecord
      };
    }
  }
  throw new SpikeFailure('unreachable_request_state', { label });
}

async function captureOrigin(originModel, nonce, apiKey, evidence, evidencePath) {
  const originLabel = `${originModel}_tool_origin`;
  const initialMessages = buildInitialMessages(nonce);
  const initialBody = buildSpikeBody({ model: originModel, messages: initialMessages });
  const result = await requestDeepSeek(originLabel, initialBody, apiKey, evidence, evidencePath);
  const toolRound = parseToolRound(originLabel, result, originModel, nonce, evidence);
  const toolMessage = localEchoResult(toolRound, evidence);
  const flow = {
    origin_model: originModel,
    nonce,
    raw_content_state: toolRound.contentState,
    reasoning_sha256: sha256(toolRound.captured.raw.reasoning_content),
    tool_call_id: toolRound.call.id,
    tool_arguments: clone(toolRound.args),
    linked_tool_result: clone(toolMessage),
    continuations: []
  };
  evidence.flows.push(flow);
  writeEvidence(evidencePath, evidence);
  return { initialMessages, toolRound, toolMessage, flow };
}

function restoreFlashOrigin(evidence, evidencePath) {
  requireGate(evidence.status === 'failed', 'resume_evidence_not_failed');
  requireGate(evidence.failure?.code === 'raw_tool_content_not_null_or_absent', 'resume_failure_not_eligible');
  requireGate(evidence.request_count === 1 && evidence.requests.length === 1, 'resume_request_count_mismatch');
  const requestRecord = evidence.requests[0];
  requireGate(requestRecord.label === `${MODEL_IDS.flash}_tool_origin`, 'resume_origin_mismatch');
  const successfulAttempt = requestRecord.attempts.find(attempt => attempt.ok === true);
  requireGate(successfulAttempt && successfulAttempt.status === 200, 'resume_origin_response_missing');

  evidence.status = 'running';
  evidence.completed_at = null;
  evidence.failure = null;
  evidence.dispatch_count = 0;
  evidence.flows = [];
  evidence.usage_observations = [];
  evidence.actual_cost_usd = 0;
  evidence.calibration = null;
  evidence.context_rejection = null;
  evidence.classifier_verification = null;

  const nonce = 'MBV4_FLASH_20260716_A';
  const result = {
    ok: true,
    status: successfulAttempt.status,
    data: clone(successfulAttempt.response),
    requestBytes: requestRecord.body_utf8_bytes,
    requestRecord
  };
  const toolRound = parseToolRound(requestRecord.label, result, MODEL_IDS.flash, nonce, evidence);
  const toolMessage = localEchoResult(toolRound, evidence);
  const flow = {
    origin_model: MODEL_IDS.flash,
    nonce,
    raw_content_state: toolRound.contentState,
    reasoning_sha256: sha256(toolRound.captured.raw.reasoning_content),
    tool_call_id: toolRound.call.id,
    tool_arguments: clone(toolRound.args),
    linked_tool_result: clone(toolMessage),
    continuations: []
  };
  evidence.flows.push(flow);
  writeEvidence(evidencePath, evidence);
  return {
    initialMessages: clone(requestRecord.body.messages),
    toolRound,
    toolMessage,
    flow
  };
}

async function continueOrigin(origin, targetModel, apiKey, evidence, evidencePath) {
  const label = `${origin.flow.origin_model}_to_${targetModel}`;
  const messages = [
    ...clone(origin.initialMessages),
    clone(origin.toolRound.captured.replay),
    clone(origin.toolMessage)
  ];
  requireGate(messages[2].content === '', 'continuation_replay_content_not_empty', { label });
  requireGate(
    messages[2].reasoning_content === origin.toolRound.captured.raw.reasoning_content,
    'continuation_reasoning_not_exact',
    { label }
  );
  const body = buildSpikeBody({ model: targetModel, messages });
  const result = await requestDeepSeek(label, body, apiKey, evidence, evidencePath);
  const parsed = parseSuccessfulEnvelope(label, result, targetModel, evidence);
  requireGate(parsed.choice.finish_reason === 'stop', 'continuation_not_final', {
    label,
    finish_reason: parsed.choice.finish_reason ?? null
  });
  requireGate(
    typeof parsed.message.content === 'string' && parsed.message.content.includes(origin.flow.nonce),
    'continuation_missing_nonce',
    { label }
  );
  origin.flow.continuations.push({
    target_model: targetModel,
    same_model_control: targetModel === origin.flow.origin_model,
    finish_reason: parsed.choice.finish_reason,
    final_content_sha256: sha256(parsed.message.content),
    nonce_present: true
  });
  writeEvidence(evidencePath, evidence);
}

async function captureContextRejection(apiKey, evidence, evidencePath) {
  const body = buildOversizeBody();
  const result = await requestDeepSeek('context_oversize', body, apiKey, evidence, evidencePath);
  requireGate(!result.ok, 'oversize_request_unexpectedly_succeeded', { status: result.status });
  const providerError = result.data?.error;
  const explicitShape = (
    (result.status === 400 || result.status === 422)
    && isPlainObject(providerError)
    && typeof providerError.code === 'string'
    && providerError.code.length > 0
    && typeof providerError.message === 'string'
    && providerError.message.length > 0
  );
  evidence.context_rejection = {
    status: result.status,
    request_body_utf8_bytes: result.requestBytes,
    request_body_sha256: result.requestRecord.body_sha256,
    response: result.data === null ? null : clone(result.data),
    error_object_keys: isPlainObject(providerError) ? Object.keys(providerError).sort() : [],
    explicit_shape_candidate: explicitShape
  };
  writeEvidence(evidencePath, evidence);
  requireGate(explicitShape, 'context_rejection_shape_not_explicit', {
    status: result.status,
    error_object_keys: evidence.context_rejection.error_object_keys
  });
}

async function runLiveSpike(apiKey, evidence, evidencePath, { resumeFlashOrigin = false } = {}) {
  const flashOrigin = resumeFlashOrigin
    ? restoreFlashOrigin(evidence, evidencePath)
    : await captureOrigin(
        MODEL_IDS.flash,
        'MBV4_FLASH_20260716_A',
        apiKey,
        evidence,
        evidencePath
      );
  await continueOrigin(flashOrigin, MODEL_IDS.flash, apiKey, evidence, evidencePath);
  await continueOrigin(flashOrigin, MODEL_IDS.pro, apiKey, evidence, evidencePath);

  const proOrigin = await captureOrigin(
    MODEL_IDS.pro,
    'MBV4_PRO_20260716_B',
    apiKey,
    evidence,
    evidencePath
  );
  await continueOrigin(proOrigin, MODEL_IDS.pro, apiKey, evidence, evidencePath);
  await continueOrigin(proOrigin, MODEL_IDS.flash, apiKey, evidence, evidencePath);

  await captureContextRejection(apiKey, evidence, evidencePath);
  evidence.calibration = calculateCalibration(evidence.usage_observations);
  requireGate(evidence.request_count <= MAX_HTTP_REQUESTS, 'http_request_ceiling_exceeded', {
    request_count: evidence.request_count
  });
  requireGate(evidence.dispatch_count === 2, 'unexpected_dispatch_count', {
    dispatch_count: evidence.dispatch_count
  });
  evidence.status = 'protocol_passed_context_fixture_captured';
  evidence.completed_at = nowIso();
  writeEvidence(evidencePath, evidence);
}

function verifyEvidence(evidenceArgument) {
  const evidencePath = path.resolve(REPO, evidenceArgument);
  const relative = path.relative(LOG_DIR, evidencePath);
  requireGate(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'evidence_path_outside_logs');
  requireGate(path.basename(evidencePath).startsWith('mb-v4-smoke-'), 'invalid_evidence_filename');
  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  requireGate(evidence.status === 'protocol_passed_context_fixture_captured', 'evidence_not_ready_for_classifier');
  requireGate(typeof controller.isObservedDeepSeekContextLengthError === 'function', 'observed_classifier_not_exported');
  const fixture = {
    response: {
      status: evidence.context_rejection.status,
      data: clone(evidence.context_rejection.response)
    }
  };
  requireGate(controller.isObservedDeepSeekContextLengthError(fixture) === true, 'observed_classifier_rejected_fixture');
  const wrongStatus = clone(fixture);
  wrongStatus.response.status = 401;
  requireGate(controller.isObservedDeepSeekContextLengthError(wrongStatus) === false, 'observed_classifier_accepted_wrong_status');
  const genericBody = clone(fixture);
  genericBody.response.data.error.message = 'generic invalid request';
  requireGate(controller.isObservedDeepSeekContextLengthError(genericBody) === false, 'observed_classifier_accepted_generic_error');
  evidence.classifier_verification = {
    export: 'isObservedDeepSeekContextLengthError',
    captured_fixture: true,
    wrong_status_rejected: true,
    generic_message_rejected: true,
    verified_at: nowIso()
  };
  evidence.status = 'passed';
  writeEvidence(evidencePath, evidence);
  console.log('EVIDENCE_VERIFICATION=PASS');
  console.log(`EVIDENCE_FILE=${evidencePath}`);
}

function selfTest() {
  const message = {
    role: 'assistant',
    content: null,
    reasoning_content: 'synthetic reasoning',
    tool_calls: [{
      id: 'call-self-test',
      type: 'function',
      function: { name: 'echo_nonce', arguments: '{"nonce":"SELF_TEST"}' }
    }]
  };
  const captured = captureAssistantMessage(message);
  assert.equal(captured.raw.content, null);
  assert.equal(captured.replay.content, '');
  assert.equal(captured.replay.reasoning_content, captured.raw.reasoning_content);
  const emptyCaptured = captureAssistantMessage({ ...message, content: '' });
  assert.equal(emptyCaptured.raw.content, '');
  assert.equal(emptyCaptured.replay.content, '');
  const body = buildSpikeBody({
    model: MODEL_IDS.flash,
    messages: [
      ...buildInitialMessages('SELF_TEST'),
      captured.replay,
      { role: 'tool', tool_call_id: 'call-self-test', content: '{"ok":true,"nonce":"SELF_TEST"}' }
    ]
  });
  assert.equal(body.max_tokens, SPIKE_OUTPUT_TOKENS);
  assert.equal(Object.hasOwn(body, 'tool_choice'), false);
  assert.ok(serializedBodyUtf8Bytes(body) > 0);
  const calibration = calculateCalibration([{ prompt_tokens_per_body_byte: 0.25 }]);
  assert.equal(calibration.calibrated_max_request_utf8_bytes, MAX_REQUEST_UTF8_BYTES);
  assert.ok(estimateWorstCase().estimated_worst_case_usd > 0);
  console.log('SELF_TEST=PASS');
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--self-test')) {
    selfTest();
    return;
  }
  const verifyIndex = process.argv.indexOf('--verify-evidence');
  if (verifyIndex !== -1) {
    requireGate(typeof process.argv[verifyIndex + 1] === 'string', 'missing_evidence_path');
    verifyEvidence(process.argv[verifyIndex + 1]);
    return;
  }

  const plan = estimateWorstCase();
  printPlan(plan);
  const resumeIndex = process.argv.indexOf('--resume-evidence');
  if (resumeIndex !== -1) {
    requireGate(args.has('--confirm-paid'), 'paid_confirmation_missing');
    requireGate(typeof process.argv[resumeIndex + 1] === 'string', 'missing_evidence_path');
    const apiKey = process.env.DEEPSEEK_API_KEY;
    requireGate(typeof apiKey === 'string' && apiKey.trim().length > 0, 'deepseek_api_key_missing');
    const evidencePath = path.resolve(REPO, process.argv[resumeIndex + 1]);
    const relative = path.relative(LOG_DIR, evidencePath);
    requireGate(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'evidence_path_outside_logs');
    requireGate(path.basename(evidencePath).startsWith('mb-v4-smoke-'), 'invalid_evidence_filename');
    const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    try {
      await runLiveSpike(apiKey, evidence, evidencePath, { resumeFlashOrigin: true });
      console.log('PROTOCOL_FLOWS=PASS');
      console.log('CONTEXT_FIXTURE=CAPTURED');
      console.log(`HTTP_REQUESTS=${evidence.request_count}`);
      console.log(`ACTUAL_COST_USD=${evidence.actual_cost_usd.toFixed(6)}`);
      console.log(`CALIBRATED_MAX_REQUEST_UTF8_BYTES=${evidence.calibration.calibrated_max_request_utf8_bytes}`);
      console.log(`EVIDENCE_FILE=${evidencePath}`);
    } catch (error) {
      evidence.status = 'failed';
      evidence.completed_at = nowIso();
      evidence.failure = {
        code: error instanceof SpikeFailure ? error.code : 'unexpected_smoke_failure',
        details: error instanceof SpikeFailure ? clone(error.details) : {}
      };
      writeEvidence(evidencePath, evidence);
      console.error(`STEP5_FAILURE=${evidence.failure.code}`);
      console.error(`HTTP_REQUESTS=${evidence.request_count}`);
      console.error(`EVIDENCE_FILE=${evidencePath}`);
      process.exitCode = 1;
    }
    return;
  }
  if (args.has('--plan') && !args.has('--run')) return;
  requireGate(args.has('--run') && args.has('--confirm-paid'), 'paid_confirmation_missing');
  const apiKey = process.env.DEEPSEEK_API_KEY;
  requireGate(typeof apiKey === 'string' && apiKey.trim().length > 0, 'deepseek_api_key_missing');

  const evidencePath = makeEvidencePath();
  const evidence = createEvidence(plan, evidencePath);
  writeEvidence(evidencePath, evidence);
  try {
    await runLiveSpike(apiKey, evidence, evidencePath);
    console.log('PROTOCOL_FLOWS=PASS');
    console.log('CONTEXT_FIXTURE=CAPTURED');
    console.log(`HTTP_REQUESTS=${evidence.request_count}`);
    console.log(`ACTUAL_COST_USD=${evidence.actual_cost_usd.toFixed(6)}`);
    console.log(`CALIBRATED_MAX_REQUEST_UTF8_BYTES=${evidence.calibration.calibrated_max_request_utf8_bytes}`);
    console.log(`EVIDENCE_FILE=${evidencePath}`);
  } catch (error) {
    evidence.status = 'failed';
    evidence.completed_at = nowIso();
    evidence.failure = {
      code: error instanceof SpikeFailure ? error.code : 'unexpected_smoke_failure',
      details: error instanceof SpikeFailure ? clone(error.details) : {}
    };
    writeEvidence(evidencePath, evidence);
    console.error(`STEP5_FAILURE=${evidence.failure.code}`);
    console.error(`HTTP_REQUESTS=${evidence.request_count}`);
    console.error(`EVIDENCE_FILE=${evidencePath}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(`STEP5_FATAL=${error instanceof SpikeFailure ? error.code : 'unexpected_fatal'}`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildOversizeBody,
  buildSpikeBody,
  calculateCalibration,
  estimateWorstCase,
  rawContentState
};
