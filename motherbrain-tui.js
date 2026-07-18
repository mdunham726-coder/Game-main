'use strict';

const { spawn } = require('node:child_process');

const TUI_CONFIG = Object.freeze({
  transcriptShare: 0.72,
  transcriptMinWidth: 48,
  activityMinWidth: 32,
  inputHeight: 3,
  supportedMinColumns: 90,
  supportedMinRows: 24,
  coreFooterHeight: 4,
  expandedFooterHeight: 8,
  bodyContentMinRows: 8,
  historyLimit: 100,
  pasteDebounceMs: 60,
  paneLogicalLineLimit: 500,
});

const TUI_BOUNDS = Object.freeze({
  transcriptShare: Object.freeze([0.68, 0.75]),
  transcriptMinWidth: Object.freeze([44, 52]),
  activityMinWidth: Object.freeze([28, 36]),
  inputHeight: Object.freeze([2, 4]),
  supportedMinColumns: Object.freeze([88, 100]),
  supportedMinRows: Object.freeze([22, 28]),
  coreFooterHeight: Object.freeze([3, 5]),
  expandedFooterHeight: Object.freeze([3, 8]),
  historyLimit: Object.freeze([50, 200]),
  pasteDebounceMs: Object.freeze([30, 100]),
  paneLogicalLineLimit: Object.freeze([400, 1000]),
});

const PALETTE = Object.freeze({
  background: '#080B09',
  motherFinal: '#6FAE78',
  reasoning: '#4F7657',
  tool: '#9A927F',
  warning: '#C89B3C',
  failure: '#C65353',
  developer: '#B44747',
  border: '#405047',
  telemetry: '#737A74',
});

const ROLE_TOKEN = Object.freeze({
  background: '*mb-background',
  final: '*mb-mother-final',
  reasoning: '*mb-reasoning',
  tool: '*mb-tool',
  warning: '*mb-warning',
  failure: '*mb-failure',
  developer: '*mb-developer',
  border: '*mb-border',
  telemetry: '*mb-telemetry',
});

const INPUT_PROMPT = 'YOU> ';
const INPUT_PROMPT_WIDTH = INPUT_PROMPT.length;
const REASONING_UNAVAILABLE = 'Reasoning unavailable - provider returned none';
const NON_TTY_DIAGNOSTIC = 'Mother Brain TUI requires an interactive TTY; no terminal mode was activated.\n';
const DISPLAY_ROLES = new Set(['final', 'reasoning', 'tool', 'warning', 'failure', 'developer', 'telemetry']);
const CORE_FOOTER_FIELD_IDS = Object.freeze([
  'core-model-state',
  'core-call',
  'core-operations-time',
]);
const EXTENDED_FOOTER_FIELD_IDS = Object.freeze([
  'extended-session',
  'extended-recent',
  'extended-rounds',
  'extended-history',
]);

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain object.`);
}

function cloneValue(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function normalizeTextLines(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').split('\n');
}

function escapeMarkup(value) {
  return String(value).replace(/\^/g, '^^');
}

function ruledLine(label, width) {
  const prefix = `├─ ${label} `;
  if (prefix.length >= width) return prefix.slice(0, Math.max(0, width));
  return `${prefix}${'─'.repeat(width - prefix.length)}`;
}

function rolePrefix(role, firstLine) {
  if (!firstLine) return '  ';
  switch (role) {
    case 'developer': return 'You: ';
    case 'final': return 'Mother: ';
    case 'reasoning': return 'Reasoning: ';
    case 'tool': return 'Tool: ';
    case 'warning': return 'Warning: ';
    case 'failure': return 'Failure: ';
    default: return '';
  }
}

function normalizeRole(role, fallback = 'telemetry') {
  return DISPLAY_ROLES.has(role) ? role : fallback;
}

function footerHeightForTier(tier) {
  return tier === 'expanded' ? TUI_CONFIG.expandedFooterHeight : TUI_CONFIG.coreFooterHeight;
}

function computeLayout(width, height, splitRatio = TUI_CONFIG.transcriptShare, options = {}) {
  width = Math.max(0, Math.floor(width));
  height = Math.max(0, Math.floor(height));
  const footerTier = options.footerTier === 'expanded' ? 'expanded' : 'core';
  const footerHeight = footerHeightForTier(footerTier);
  const bodyHeight = height - 1 - TUI_CONFIG.inputHeight - footerHeight;
  const bodyContentRows = bodyHeight - 1;
  const minimumPaneWidth = TUI_CONFIG.transcriptMinWidth + 1 + TUI_CONFIG.activityMinWidth;
  const supported = width >= TUI_CONFIG.supportedMinColumns
    && height >= TUI_CONFIG.supportedMinRows
    && width >= minimumPaneWidth
    && bodyContentRows >= TUI_CONFIG.bodyContentMinRows;

  if (!supported) {
    return {
      supported: false,
      width,
      height,
      bodyHeight,
      bodyContentRows,
      footerTier,
      footerHeight,
      overlay: { x: 0, y: 0, width, height },
    };
  }

  const availablePaneWidth = width - 1;
  const transcriptWidth = clamp(
    Math.round(availablePaneWidth * splitRatio),
    TUI_CONFIG.transcriptMinWidth,
    availablePaneWidth - TUI_CONFIG.activityMinWidth,
  );
  const activityWidth = availablePaneWidth - transcriptWidth;
  const inputY = 1 + bodyHeight;
  const footerY = inputY + TUI_CONFIG.inputHeight;

  return {
    supported: true,
    width,
    height,
    splitRatio,
    footerTier,
    footerHeight,
    availablePaneWidth,
    transcriptWidth,
    activityWidth,
    bodyHeight,
    bodyContentRows,
    header: { x: 0, y: 0, width, height: 1 },
    transcript: { x: 0, y: 1, width: transcriptWidth, height: bodyHeight },
    transcriptTitle: { x: 0, y: 1, width: transcriptWidth, height: 1 },
    transcriptContent: { x: 0, y: 2, width: transcriptWidth, height: bodyHeight - 1 },
    divider: { x: transcriptWidth, y: 1, width: 1, height: bodyHeight },
    activity: { x: transcriptWidth + 1, y: 1, width: activityWidth, height: bodyHeight },
    activityTitle: { x: transcriptWidth + 1, y: 1, width: activityWidth, height: 1 },
    activityContent: { x: transcriptWidth + 1, y: 2, width: activityWidth, height: bodyHeight - 1 },
    input: { x: 0, y: inputY, width, height: TUI_CONFIG.inputHeight },
    inputLabel: { x: 0, y: inputY, width, height: 1 },
    inputPrompt: { x: 0, y: inputY + 1, width: INPUT_PROMPT_WIDTH, height: 1 },
    editor: { x: INPUT_PROMPT_WIDTH, y: inputY + 1, width: width - INPUT_PROMPT_WIDTH, height: TUI_CONFIG.inputHeight - 1 },
    footer: { x: 0, y: footerY, width, height: footerHeight },
    footerRule: { x: 0, y: footerY, width, height: 1 },
    footerContent: { x: 0, y: footerY + 1, width, height: footerHeight - 1 },
  };
}

function dividerLayoutForColumn(width, height, requestedTranscriptWidth, options = {}) {
  const availablePaneWidth = Math.floor(width) - 1;
  const transcriptWidth = clamp(
    Math.round(requestedTranscriptWidth),
    TUI_CONFIG.transcriptMinWidth,
    availablePaneWidth - TUI_CONFIG.activityMinWidth,
  );
  return computeLayout(width, height, transcriptWidth / availablePaneWidth, options);
}

function normalizeDisplaySegment(segment, fallbackRole) {
  assertPlainObject(segment, 'Display segment');
  const role = normalizeRole(segment.role, fallbackRole);
  return {
    role,
    prefix: segment.prefix === undefined ? rolePrefix(role, true) : String(segment.prefix),
    text: String(segment.text ?? ''),
  };
}

function normalizeDisplayRecord(record, fallbackRole = 'telemetry') {
  assertPlainObject(record, 'Display record');
  if (typeof record.id !== 'string' || !record.id) throw new TypeError('Display record id must be a nonempty string.');
  const role = normalizeRole(record.role, fallbackRole);
  if (Array.isArray(record.lines)) {
    if (record.lines.length === 0) throw new TypeError('Structured display record lines must not be empty.');
    return {
      id: record.id,
      kind: String(record.kind || 'structured'),
      lines: record.lines.map((line) => normalizeDisplaySegment(line, role)),
    };
  }
  return {
    id: record.id,
    kind: String(record.kind || 'text'),
    role,
    text: String(record.text ?? ''),
  };
}

function recordLogicalLines(record) {
  const normalized = normalizeDisplayRecord(record);
  const lines = [];
  if (normalized.lines) {
    for (const segment of normalized.lines) {
      const textLines = normalizeTextLines(segment.text);
      textLines.forEach((text, index) => {
        lines.push({
          recordId: normalized.id,
          recordKind: normalized.kind,
          role: segment.role,
          text,
          displayText: `${index === 0 ? segment.prefix : '  '}${text}`,
        });
      });
    }
  } else {
    const textLines = normalizeTextLines(normalized.text);
    textLines.forEach((text, index) => {
      lines.push({
        recordId: normalized.id,
        recordKind: normalized.kind,
        role: normalized.role,
        text,
        displayText: `${rolePrefix(normalized.role, index === 0)}${text}`,
      });
    });
  }
  return lines.map((line, lineIndex) => ({ ...line, lineIndex, lineCount: lines.length }));
}

function projectRecord(record, limit) {
  const sourceLines = recordLogicalLines(record);
  if (sourceLines.length <= limit) return sourceLines.map((line) => ({ ...line, truncated: false }));

  const firstCount = Math.floor(limit / 2);
  const lastCount = limit - firstCount - 1;
  const omitted = sourceLines.length - firstCount - lastCount;
  const first = sourceLines.slice(0, firstCount).map((line) => ({ ...line, truncated: true }));
  const marker = {
    recordId: record.id,
    recordKind: record.kind || 'text',
    role: 'warning',
    text: `[record ${record.id} truncated: ${omitted} logical lines omitted]`,
    displayText: `[record ${record.id} truncated: ${omitted} logical lines omitted]`,
    lineIndex: firstCount,
    lineCount: sourceLines.length,
    truncated: true,
    truncationMarker: true,
  };
  const last = sourceLines.slice(sourceLines.length - lastCount).map((line) => ({ ...line, truncated: true }));
  return [...first, marker, ...last];
}

function projectRecords(records, limit = TUI_CONFIG.paneLogicalLineLimit) {
  if (!Array.isArray(records)) throw new TypeError('Display records must be an array.');
  const projectedNewestFirst = [];
  let remaining = limit;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const projected = projectRecord(records[index], limit);
    if (projected.length > remaining) break;
    projectedNewestFirst.push(projected);
    remaining -= projected.length;
  }
  return projectedNewestFirst.reverse().flat();
}

function formatProjection(projected) {
  return projected.map((line) => {
    const token = ROLE_TOKEN[line.role] || ROLE_TOKEN.telemetry;
    return `^[${token}]${escapeMarkup(line.displayText)}^:`;
  }).join('\n');
}

function plainProjectionText(projected) {
  return projected.map((line) => line.displayText).join('\n');
}

function formatUsageSummary(usage) {
  if (!isPlainObject(usage)) return null;
  const fields = [
    ['prompt', usage.prompt_tokens],
    ['hit', usage.prompt_cache_hit_tokens],
    ['miss', usage.prompt_cache_miss_tokens],
    ['output', usage.completion_tokens],
    ['total', usage.total_tokens],
  ].filter(([, value]) => value !== null && value !== undefined);
  return fields.length ? fields.map(([label, value]) => `${label} ${value}`).join(' · ') : null;
}

function formatBoundedJson(value, limit = 256) {
  const text = JSON.stringify(value);
  if (typeof text !== 'string') return 'unavailable';
  const characters = [...text];
  return characters.length > limit ? `${characters.slice(0, limit - 1).join('')}…` : text;
}

function formatRoundActivityRecord(roundRecord) {
  assertPlainObject(roundRecord, 'Round activity record');
  const round = roundRecord.round;
  if (!Number.isInteger(round) || round < 1) throw new TypeError('Round activity record round must be a positive integer.');
  const id = typeof roundRecord.id === 'string' && roundRecord.id ? roundRecord.id : `round-${round}`;
  const headerParts = [`ROUND ${round}`];
  if (roundRecord.attempt_count !== null && roundRecord.attempt_count !== undefined) headerParts.push(`attempts ${roundRecord.attempt_count}`);
  if (roundRecord.actual_model) headerParts.push(`actual ${roundRecord.actual_model}`);
  if (roundRecord.configured_reasoning_effort) headerParts.push(`effort ${roundRecord.configured_reasoning_effort} (configured)`);
  if (roundRecord.latency_ms !== null && roundRecord.latency_ms !== undefined) headerParts.push(`${roundRecord.latency_ms} ms`);
  if (roundRecord.finish_reason) headerParts.push(`finish ${roundRecord.finish_reason}`);
  const usageSummary = formatUsageSummary(roundRecord.usage);
  if (usageSummary) headerParts.push(usageSummary);
  if (roundRecord.cost_available === false) headerParts.push('cost unavailable');
  else if (roundRecord.cost_usd !== null && roundRecord.cost_usd !== undefined) headerParts.push(`cost $${Number(roundRecord.cost_usd).toFixed(6)}`);

  const reasoning = typeof roundRecord.reasoning === 'string'
    ? roundRecord.reasoning
    : typeof roundRecord.assistant?.reasoning_content === 'string'
      ? roundRecord.assistant.reasoning_content
      : '';
  const lines = [
    { role: 'tool', prefix: '', text: headerParts.join(' · ') },
    { role: 'reasoning', prefix: 'Reasoning: ', text: reasoning.trim() ? reasoning : REASONING_UNAVAILABLE },
  ];

  if (Array.isArray(roundRecord.retries)) {
    for (const retry of roundRecord.retries) {
      if (!isPlainObject(retry)) continue;
      const parts = ['Retry'];
      if (retry.category) parts.push(String(retry.category));
      if (retry.delay_ms !== null && retry.delay_ms !== undefined) parts.push(`${retry.delay_ms} ms`);
      lines.push({ role: 'warning', prefix: 'State: ', text: parts.join(' · ') });
    }
  }

  if (Array.isArray(roundRecord.tool_calls)) {
    for (const call of roundRecord.tool_calls) {
      if (!isPlainObject(call)) continue;
      const parts = [String(call.name || 'unknown tool')];
      if (call.call_id_suffix) parts.push(`id …${call.call_id_suffix}`);
      if (isPlainObject(call.arguments)) parts.push(`args ${formatBoundedJson(call.arguments)}`);
      else if (call.status === 'rejected') parts.push('args unavailable after validation rejection');
      if (call.validation_code) parts.push(`code ${call.validation_code}`);
      lines.push({ role: 'tool', prefix: 'Call: ', text: parts.join(' · ') });
    }
  } else if (Number.isInteger(roundRecord.assistant?.tool_call_count) && roundRecord.assistant.tool_call_count > 0) {
    lines.push({ role: 'tool', prefix: 'Call: ', text: `${roundRecord.assistant.tool_call_count} provider tool call(s)` });
  }

  if (Array.isArray(roundRecord.tool_results)) {
    for (const result of roundRecord.tool_results) {
      if (!isPlainObject(result)) continue;
      const status = result.status || result.outcome || 'status unavailable';
      const parts = [String(status)];
      if (result.bytes !== null && result.bytes !== undefined) parts.push(`${result.bytes} bytes`);
      if (result.error_code || result.gate_code) parts.push(`code ${result.error_code || result.gate_code}`);
      if (result.truncated) parts.push('preview truncated');
      if (result.preview !== null && result.preview !== undefined) parts.push(String(result.preview));
      const role = status === 'rejected' || status === 'error' || status === 'invalid_result' ? 'failure' : 'tool';
      lines.push({ role, prefix: 'Result: ', text: parts.join(' · ') });
    }
  }

  if (Array.isArray(roundRecord.warnings)) {
    for (const warning of roundRecord.warnings) {
      if (!isPlainObject(warning)) continue;
      lines.push({
        role: 'warning',
        prefix: 'Warning: ',
        text: String(warning.warning || warning.code || 'provider warning'),
      });
    }
  }

  if (roundRecord.error_code) {
    lines.push({ role: 'failure', prefix: 'Failure: ', text: String(roundRecord.error_code) });
  }

  const states = Array.isArray(roundRecord.states)
    ? roundRecord.states
    : roundRecord.state
      ? [roundRecord.state]
      : [];
  for (const state of states) lines.push({ role: 'telemetry', prefix: 'State: ', text: String(state) });

  return normalizeDisplayRecord({ id, kind: 'round', role: 'tool', lines }, 'tool');
}

function normalizeTelemetryLine(line, index, tier) {
  if (typeof line === 'string') return { id: `${tier}-${index + 1}`, text: line };
  assertPlainObject(line, `Telemetry ${tier} line`);
  const id = typeof line.id === 'string' && line.id ? line.id : `${tier}-${index + 1}`;
  return { id, text: String(line.text ?? '') };
}

function footerValue(value, unavailable = '-') {
  return value === null || value === undefined || value === '' ? unavailable : String(value);
}

function compactMetric(value) {
  if (!Number.isFinite(value)) return '-';
  const absolute = Math.abs(value);
  if (absolute < 1000) return String(value);
  if (absolute < 1000000) return `${(value / 1000).toFixed(absolute < 10000 ? 1 : 0)}k`;
  if (absolute < 1000000000) return `${(value / 1000000).toFixed(absolute < 10000000 ? 1 : 0)}M`;
  return `${(value / 1000000000).toFixed(1)}B`;
}

function footerModel(value) {
  if (value === 'deepseek-v4-flash') return 'flash';
  if (value === 'deepseek-v4-pro') return 'pro';
  const text = footerValue(value, 'unavailable');
  return text.length > 24 ? `${text.slice(0, 23)}…` : text;
}

function footerCost(available, value, compact = false) {
  if (available === false || value === null || value === undefined || !Number.isFinite(Number(value))) return '?';
  return `$${Number(value).toFixed(compact ? 3 : 6)}`;
}

function footerDuration(value) {
  if (!Number.isFinite(value)) return '-';
  return value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(1)}s`;
}

function compactFooterMetric(value) {
  const compact = compactMetric(value);
  return compact === '-' ? null : compact.replace('k', 'K');
}

function compactFooterBytes(value) {
  if (!Number.isFinite(value)) return null;
  const absolute = Math.abs(value);
  if (absolute < 1024) return `${Math.round(value)} B`;
  if (absolute < 1024 ** 2) return `${(value / 1024).toFixed(absolute < 10 * 1024 ? 1 : 0)} KB`;
  if (absolute < 1024 ** 3) return `${(value / (1024 ** 2)).toFixed(absolute < 10 * (1024 ** 2) ? 1 : 0)} MB`;
  return `${(value / (1024 ** 3)).toFixed(1)} GB`;
}

function footerCount(value, singular, plural = `${singular}s`) {
  if (!Number.isFinite(value)) return null;
  return `${compactFooterMetric(value)} ${value === 1 ? singular : plural}`;
}

function compactFooterRow(label, segments, maximumWidth = TUI_CONFIG.supportedMinColumns) {
  const visible = segments
    .filter(segment => segment && segment.text)
    .map(segment => ({ text: String(segment.text), priority: Number(segment.priority) || 0 }));
  if (!visible.length) visible.push({ text: 'status unavailable', priority: 0 });
  const render = () => `${label}  ${visible.map(segment => segment.text).join(' · ')}`;
  while ([...render()].length > maximumWidth) {
    const removablePriority = Math.max(...visible.map(segment => segment.priority));
    if (removablePriority <= 0) break;
    const index = visible.findLastIndex(segment => segment.priority === removablePriority);
    visible.splice(index, 1);
  }
  const rendered = render();
  return [...rendered].length <= maximumWidth
    ? rendered
    : `${[...rendered].slice(0, Math.max(0, maximumWidth - 1)).join('')}…`;
}

function footerOperationalPhrase(value, kind) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).toLowerCase();
  const maps = {
    engine: { online: 'engine online', offline: 'engine offline' },
    sse: {
      connected: 'SSE connected',
      connecting: 'SSE connecting',
      reconnecting: 'SSE reconnecting',
      disconnected: 'SSE disconnected',
      offline: 'SSE disconnected',
    },
    harness: { authorized: 'harness on', offline: 'harness off' },
  };
  if (maps[kind]?.[text]) return maps[kind][text];
  const bounded = text.length > 18 ? `${text.slice(0, 17)}…` : text;
  return `${kind === 'sse' ? 'SSE' : kind} ${bounded}`;
}

function footerGamePhrase(sessionState, gameState) {
  const session = String(sessionState ?? '').toLowerCase();
  const game = String(gameState ?? '').toLowerCase();
  if (game === 'active') return 'game active';
  if (session === 'attached') return 'game session attached';
  if (session === 'none' || game === 'inactive') return 'no game session';
  return null;
}

function formatFooterMarkupLine(line) {
  const text = String(line ?? '');
  const match = /^([A-Z]+)  (.*)$/.exec(text);
  if (!match) return `^[${ROLE_TOKEN.telemetry}]${escapeMarkup(text)}^:`;
  const emphasis = /(PERSISTENCE DEGRADED|engine online|engine offline|SSE connected|SSE connecting|SSE reconnecting|SSE disconnected|game active|harness on)/gi;
  let body = '';
  let offset = 0;
  for (const token of match[2].matchAll(emphasis)) {
    body += escapeMarkup(match[2].slice(offset, token.index));
    const phrase = token[0];
    const lowered = phrase.toLowerCase();
    const role = lowered.includes('degraded') || lowered.includes('offline')
      ? ROLE_TOKEN.failure
      : lowered.includes('connecting') || lowered.includes('reconnecting') || lowered.includes('disconnected')
        ? ROLE_TOKEN.warning
        : ROLE_TOKEN.final;
    body += `^[${role}]${escapeMarkup(phrase)}^:`;
    offset = token.index + phrase.length;
  }
  body += escapeMarkup(match[2].slice(offset));
  return `^[${ROLE_TOKEN.final}]${match[1]}^:  ${body}`;
}

function buildTelemetryFooterProjection(source) {
  if (!isPlainObject(source) || !isPlainObject(source.configured_settings)) return { core: [], extended: [] };
  const lastCall = isPlainObject(source.last_call) ? source.last_call : null;
  const session = isPlainObject(source.session) ? source.session : {};
  const usage = isPlainObject(lastCall?.usage) ? lastCall.usage : {};
  const state = isPlainObject(source.state) ? source.state : {};
  const operational = isPlainObject(source.operational_state) ? source.operational_state : {};
  const clock = isPlainObject(source.server_clock) ? source.server_clock : {};
  const replay = isPlainObject(source.replay) ? source.replay : {};
  const conversation = isPlainObject(source.conversation) ? source.conversation : {};
  const persistence = isPlainObject(source.persistence) ? source.persistence : {};
  const history = isPlainObject(persistence.history) ? persistence.history : {};
  const settings = isPlainObject(persistence.settings) ? persistence.settings : {};
  const persistenceDegraded = Boolean(history.degraded || settings.degraded);
  const actualModels = Array.isArray(lastCall?.actual_models) ? lastCall.actual_models : [];
  const actualModel = source.last_actual_model || actualModels.at(-1) || null;
  const callState = state.busy
    ? String(state.activity && state.activity !== 'idle' ? state.activity : 'busy')
    : String(state.activity || 'idle');
  const hasCompletedCall = Boolean(lastCall && (
    actualModel
    || Number.isFinite(usage.total_tokens)
    || Number.isFinite(lastCall.elapsed_ms)
    || Number.isFinite(lastCall.rounds)
  ));
  const callSegments = [{ text: callState, priority: 0 }];
  if (!hasCompletedCall && !state.busy) callSegments.push({ text: 'no completed call', priority: 0 });
  if (actualModel) callSegments.push({ text: `actual ${footerModel(actualModel)}`, priority: 1 });
  if (Number.isFinite(usage.total_tokens)) callSegments.push({ text: `tokens ${compactFooterMetric(usage.total_tokens)}`, priority: 1 });
  if (Number.isFinite(lastCall?.cache_hit_percentage)) callSegments.push({ text: `cache ${lastCall.cache_hit_percentage.toFixed(1)}%`, priority: 2 });
  if (lastCall && lastCall.cost_available !== false && Number.isFinite(Number(lastCall.cost_usd))) {
    callSegments.push({ text: `cost ${footerCost(true, lastCall.cost_usd)}`, priority: 1 });
  }
  if (Number.isFinite(lastCall?.elapsed_ms)) callSegments.push({ text: `elapsed ${footerDuration(lastCall.elapsed_ms)}`, priority: 2 });

  const systemSegments = [
    { text: footerOperationalPhrase(operational.engine, 'engine'), priority: 0 },
    { text: footerOperationalPhrase(operational.sse, 'sse'), priority: 0 },
    { text: footerGamePhrase(operational.session, operational.game), priority: 1 },
    { text: footerOperationalPhrase(operational.harness, 'harness'), priority: 2 },
  ];

  const persistenceBytes = compactFooterBytes(history.durable_bytes);
  const persistenceText = persistenceDegraded
    ? `PERSISTENCE DEGRADED${persistenceBytes ? ` (${persistenceBytes})` : ''}`
    : persistenceBytes
      ? `persistence ${persistenceBytes}`
      : history.status && history.status !== 'none'
        ? `persistence ${history.status}`
        : null;
  const historyTokens = compactFooterMetric(conversation.estimated_history_tokens);
  const clockText = [clock.weekday, clock.time]
    .filter(value => value !== null && value !== undefined && value !== '')
    .join(' ') || footerValue(clock.date, '');
  const sessionSegments = [
    { text: footerCount(session.completed_calls, 'call'), priority: 0 },
    { text: footerCount(session.api_rounds, 'round'), priority: 2 },
    { text: historyTokens ? `history ${historyTokens} tokens` : null, priority: 1 },
    { text: persistenceText, priority: persistenceDegraded ? 0 : 1 },
    { text: clockText || null, priority: 2 },
  ];
  const core = [
    {
      id: CORE_FOOTER_FIELD_IDS[0],
      text: compactFooterRow('CALL', callSegments),
    },
    {
      id: CORE_FOOTER_FIELD_IDS[1],
      text: compactFooterRow('SYSTEM', systemSegments),
    },
    {
      id: CORE_FOOTER_FIELD_IDS[2],
      text: compactFooterRow('SESSION', sessionSegments),
    },
  ];

  const sessionUsage = isPlainObject(session.usage) ? session.usage : {};
  const recentCalls = Array.isArray(session.recent_calls) ? session.recent_calls : [];
  const perRound = Array.isArray(lastCall?.per_round) ? lastCall.per_round : [];
  const persistenceState = history.degraded || settings.degraded
    ? 'DEGRADED'
    : footerValue(history.status);
  const extended = [
    {
      id: EXTENDED_FOOTER_FIELD_IDS[0],
      text: `session calls=${footerValue(session.completed_calls)} t/p/h/m/o=${[sessionUsage.total_tokens, sessionUsage.prompt_tokens, sessionUsage.prompt_cache_hit_tokens, sessionUsage.prompt_cache_miss_tokens, sessionUsage.completion_tokens].map(compactMetric).join('/')} cost=${footerCost(session.cost_available, session.cost_usd, true)} reason=${compactMetric(sessionUsage.reasoning_tokens)}`,
    },
    {
      id: EXTENDED_FOOTER_FIELD_IDS[1],
      text: `recent ${recentCalls.length ? recentCalls.map(call => `${call.call}:${compactMetric(call.usage?.total_tokens)}/${footerCost(call.cost_available, call.cost_usd, true)}`).join(' ') : 'none'}`,
    },
    {
      id: EXTENDED_FOOTER_FIELD_IDS[2],
      text: `rounds ${perRound.length ? perRound.map(round => `${round.round}:${footerModel(round.actual_model)}/${compactMetric(round.usage?.total_tokens)}/${footerCost(round.cost_available, round.cost_usd, true)}`).join(' ') : 'none'}`,
    },
    {
      id: EXTENDED_FOOTER_FIELD_IDS[3],
      text: `history ex=${footerValue(conversation.exchange_count)} est=${compactMetric(conversation.estimated_history_tokens)}tok replay=${footerValue(replay.included_exchange_count)}/${footerValue(replay.excluded_exchange_count)} durable=${compactMetric(history.durable_bytes)}B evict=${footerValue(history.count_evicted)}/${footerValue(history.size_evicted)} ${persistenceState}`,
    },
  ];
  return { core, extended };
}

function telemetryWithDisplayOverrides(source, header, busy) {
  const projected = cloneValue(source);
  if (!isPlainObject(projected) || !isPlainObject(projected.configured_settings)) return projected;
  if (header.configured_model) projected.configured_settings.model = header.configured_model;
  if (header.configured_reasoning_effort) projected.configured_settings.reasoning_effort = header.configured_reasoning_effort;
  if (header.actual_model) projected.last_actual_model = header.actual_model;
  projected.state = {
    ...(isPlainObject(projected.state) ? projected.state : {}),
    ...(header.activity ? { activity: header.activity } : {}),
    busy: Boolean(busy),
  };
  projected.operational_state = {
    ...(isPlainObject(projected.operational_state) ? projected.operational_state : {}),
  };
  for (const key of ['engine', 'sse', 'session', 'game', 'harness']) {
    if (header[key] !== undefined) projected.operational_state[key] = header[key];
  }
  return projected;
}

function normalizeTelemetrySnapshot(snapshot) {
  assertPlainObject(snapshot, 'Telemetry snapshot');
  const source = cloneValue(snapshot.source === undefined ? snapshot : snapshot.source);
  const projected = buildTelemetryFooterProjection(source);
  const coreInput = Array.isArray(snapshot.core) && snapshot.core.length > 0 ? snapshot.core : projected.core;
  const extendedInput = Array.isArray(snapshot.extended) && snapshot.extended.length > 0
    ? snapshot.extended
    : projected.extended;
  const core = coreInput.map((line, index) => normalizeTelemetryLine(line, index, 'core'));
  const extended = extendedInput.map((line, index) => normalizeTelemetryLine(line, index, 'extended'));
  const roundRecords = Array.isArray(snapshot.round_records)
    ? cloneValue(snapshot.round_records)
    : Array.isArray(source?.last_call?.round_records)
      ? cloneValue(source.last_call.round_records)
      : [];
  return {
    source,
    core,
    extended,
    roundRecords,
  };
}

function formatTelemetryFooter(snapshot, tier = 'core') {
  const normalized = normalizeTelemetrySnapshot(snapshot || {});
  const lines = [...normalized.core];
  if (tier === 'expanded') lines.push(...normalized.extended);
  return lines.map((line) => line.text);
}

class HistoryBuffer {
  constructor(limit = TUI_CONFIG.historyLimit) {
    this.limit = limit;
    this.items = [];
    this.index = null;
    this.savedDraft = '';
  }

  push(value) {
    if (!String(value).trim()) return;
    this.items.push(String(value));
    if (this.items.length > this.limit) this.items.splice(0, this.items.length - this.limit);
    this.resetNavigation();
  }

  resetNavigation() {
    this.index = null;
    this.savedDraft = '';
  }

  previous(currentDraft) {
    if (!this.items.length) return currentDraft;
    if (this.index === null) {
      this.savedDraft = currentDraft;
      this.index = this.items.length;
    }
    if (this.index > 0) this.index -= 1;
    return this.items[this.index];
  }

  next(currentDraft) {
    if (this.index === null) return currentDraft;
    if (this.index < this.items.length - 1) {
      this.index += 1;
      return this.items[this.index];
    }
    this.index = null;
    return this.savedDraft;
  }

  snapshot() {
    return { limit: this.limit, items: this.items.slice(), index: this.index, savedDraft: this.savedDraft };
  }
}

class EnterDebouncer {
  constructor({ delayMs, onNewLine, onSubmit }) {
    this.delayMs = delayMs;
    this.onNewLine = onNewLine;
    this.onSubmit = onSubmit;
    this.pending = false;
    this.timer = null;
  }

  handleEnter() {
    if (this.pending) {
      this.clearTimer();
      this.pending = false;
      this.onNewLine();
    }
    this.pending = true;
    this.timer = setTimeout(() => {
      this.pending = false;
      this.timer = null;
      this.onSubmit();
    }, this.delayMs);
  }

  beforeCharacter() {
    if (!this.pending) return;
    this.clearTimer();
    this.pending = false;
    this.onNewLine();
  }

  flushAsSubmit() {
    if (!this.pending) return;
    this.clearTimer();
    this.pending = false;
    this.onSubmit();
  }

  clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  cancel() {
    this.clearTimer();
    this.pending = false;
  }
}

function createPaneState() {
  return { records: [], follow: true, topLogicalLine: 0, newOutput: false };
}

function appendPaneRecord(pane, record) {
  pane.records.push(record);
  if (!pane.follow) pane.newOutput = true;
}

function scrollPaneState(pane, requestedTop, maximumTop) {
  const top = clamp(Math.round(requestedTop), 0, Math.max(0, maximumTop));
  pane.follow = top >= maximumTop;
  pane.topLogicalLine = pane.follow ? 0 : top;
  if (pane.follow) pane.newOutput = false;
}

function paneSelectionRegion(data, widget) {
  const maximumX = Math.max(0, widget.textAreaWidth - 1);
  const maximumY = Math.max(0, widget.textAreaHeight - 1);
  const startX = clamp(Math.round(data.xFrom), 0, maximumX);
  const startY = clamp(Math.round(data.yFrom), 0, maximumY);
  const endX = clamp(Math.round(data.x), 0, maximumX);
  const endY = clamp(Math.round(data.y), 0, maximumY);
  const forward = startY < endY || (startY === endY && startX <= endX);
  return forward
    ? { xmin: startX - widget.scrollX, ymin: startY - widget.scrollY, xmax: endX - widget.scrollX, ymax: endY - widget.scrollY }
    : { xmin: endX - widget.scrollX, ymin: endY - widget.scrollY, xmax: startX - widget.scrollX, ymax: startY - widget.scrollY };
}

function selectedPaneText(widget) {
  return widget.textBuffer.getSelectionText() || '';
}

function copyToWindowsClipboard(value) {
  return new Promise((resolve, reject) => {
    const child = spawn('clip.exe', [], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    let errorText = '';
    child.stderr.on('data', (chunk) => { errorText += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(errorText.trim() || `clip.exe exited ${code}`));
    });
    child.stdin.end(String(value), 'utf8');
  });
}

function prepareWindowsTerminalEnvironment(env = process.env, platform = process.platform) {
  const windowsTerminal = platform === 'win32' && Boolean(env.WT_SESSION);
  const previous = { term: env.TERM || null, colorTerm: env.COLORTERM || null };
  if (windowsTerminal) {
    // Windows Terminal supports the xterm mouse protocol and exact RGB colors.
    // Do not let a stale parent-shell TERM value select Terminal Kit's generic
    // 16-color profile: that profile collapses the palette and disables the
    // mouse-motion events used by the divider and pane selection.
    env.TERM = 'xterm-256color';
    env.COLORTERM = 'truecolor';
  }
  return {
    windowsTerminal,
    promoted: windowsTerminal
      && (previous.term !== (env.TERM || null) || previous.colorTerm !== (env.COLORTERM || null)),
    previous,
    effective: { term: env.TERM || null, colorTerm: env.COLORTERM || null },
  };
}

function makeTerminalPalette(termkit, term) {
  const names = {
    background: 'mb-background',
    motherFinal: 'mb-mother-final',
    reasoning: 'mb-reasoning',
    tool: 'mb-tool',
    warning: 'mb-warning',
    failure: 'mb-failure',
    developer: 'mb-developer',
    border: 'mb-border',
    telemetry: 'mb-telemetry',
  };
  const extraPaletteDef = Object.entries(PALETTE).map(([role, code]) => ({ names: [names[role]], code }));
  return new termkit.Palette({ term, extraPaletteDef });
}

function enforceExactWindowsTerminalPalette(palette, environmentProfile) {
  if (!environmentProfile?.windowsTerminal) return { enforced: false, exact: null };
  const tokenByRole = {
    background: ROLE_TOKEN.background,
    motherFinal: ROLE_TOKEN.final,
    reasoning: ROLE_TOKEN.reasoning,
    tool: ROLE_TOKEN.tool,
    warning: ROLE_TOKEN.warning,
    failure: ROLE_TOKEN.failure,
    developer: ROLE_TOKEN.developer,
    border: ROLE_TOKEN.border,
    telemetry: ROLE_TOKEN.telemetry,
  };
  const indexes = {};
  for (const [role, code] of Object.entries(PALETTE)) {
    const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(code);
    if (!match) throw new Error(`Invalid Mother Brain palette color: ${code}`);
    const red = Number.parseInt(match[1], 16);
    const green = Number.parseInt(match[2], 16);
    const blue = Number.parseInt(match[3], 16);
    const index = palette.colorNameToIndex(tokenByRole[role]);
    palette.escape[index] = `\x1b[38;2;${red};${green};${blue}m`;
    palette.bgEscape[index] = `\x1b[48;2;${red};${green};${blue}m`;
    indexes[role] = index;
  }
  return { enforced: true, exact: true, indexes };
}

function setTextGeometry(element, rectangle) {
  element.outputX = rectangle.x;
  element.outputY = rectangle.y;
  element.outputWidth = rectangle.width;
  element.outputHeight = rectangle.height;
  element.inputX = rectangle.x;
  element.inputY = rectangle.y;
  element.inputWidth = rectangle.width;
  element.inputHeight = rectangle.height;
}

function restoreCursorOffset(input, requestedOffset) {
  const maximumOffset = [...input.getValue()].length;
  const offset = clamp(Math.round(requestedOffset), 0, maximumOffset);
  input.textBuffer.moveToStartOfBuffer();
  for (let index = 0; index < offset; index += 1) input.textBuffer.moveForward();
}

class MotherBrainTui {
  constructor(options = {}) {
    assertPlainObject(options, 'MotherBrainTui options');
    this._options = {
      version: options.version === undefined ? null : String(options.version),
      input: options.input || process.stdin,
      output: options.output || process.stdout,
      env: options.env || process.env,
      platform: options.platform || process.platform,
      terminalKitLoader: options.terminalKitLoader || (() => require('terminal-kit')),
      clipboardWriter: options.clipboardWriter || copyToWindowsClipboard,
      scheduleFrame: options.scheduleFrame || queueMicrotask,
      onSubmit: typeof options.onSubmit === 'function' ? options.onSubmit : async () => ({ accepted: true }),
      onBlockedSubmit: typeof options.onBlockedSubmit === 'function' ? options.onBlockedSubmit : null,
      onBeforeShutdown: typeof options.onBeforeShutdown === 'function' ? options.onBeforeShutdown : null,
      onShutdown: typeof options.onShutdown === 'function' ? options.onShutdown : async () => {},
      onSynchronousExit: typeof options.onSynchronousExit === 'function' ? options.onSynchronousExit : null,
    };
    this._state = {
      header: {},
      splitRatio: TUI_CONFIG.transcriptShare,
      draft: '',
      cursorOffset: 0,
      busy: false,
      panes: { transcript: createPaneState(), activity: createPaneState() },
      history: new HistoryBuffer(TUI_CONFIG.historyLimit),
      telemetry: normalizeTelemetrySnapshot({ core: [], extended: [], source: {} }),
      selection: { pane: null, status: 'none', bytes: 0 },
      copyResult: null,
      fatal: null,
      resizeOverlay: { active: false, title: null, detail: null },
      stopping: false,
      recordCounter: 0,
      activeTurnActivityStart: null,
      exchangeActivityStart: null,
      lastExchangeRange: null,
    };
    this._runtime = {
      termkit: null,
      term: null,
      document: null,
      widgets: null,
      layout: null,
      palette: null,
      terminalProfile: null,
      enterDebouncer: null,
      selectionCopyToken: 0,
      pendingDraw: false,
      needsRelayout: false,
      scheduledDraws: 0,
      completedDraws: 0,
      shutdownPromise: null,
      handlers: null,
      started: false,
    };
  }

  get started() {
    return this._runtime.started;
  }

  getSnapshot() {
    this._captureEditorState();
    return cloneValue({
      started: this._runtime.started,
      stopping: this._state.stopping,
      header: this._state.header,
      splitRatio: this._state.splitRatio,
      draft: this._state.draft,
      cursorOffset: this._state.cursorOffset,
      history: this._state.history.snapshot(),
      panes: {
        transcript: {
          records: this._state.panes.transcript.records,
          follow: this._state.panes.transcript.follow,
          topLogicalLine: this._state.panes.transcript.topLogicalLine,
          newOutput: this._state.panes.transcript.newOutput,
        },
        activity: {
          records: this._state.panes.activity.records,
          follow: this._state.panes.activity.follow,
          topLogicalLine: this._state.panes.activity.topLogicalLine,
          newOutput: this._state.panes.activity.newOutput,
        },
      },
      telemetry: this._state.telemetry,
      selection: this._state.selection,
      copyResult: this._state.copyResult,
      activeTurnActivityStart: this._state.activeTurnActivityStart,
      exchangeActivityStart: this._state.exchangeActivityStart,
      lastExchangeRange: this._state.lastExchangeRange,
      fatal: this._state.fatal,
      resizeOverlay: this._state.resizeOverlay,
      layout: this._runtime.layout,
      drawBatches: { scheduled: this._runtime.scheduledDraws, completed: this._runtime.completedDraws },
    });
  }

  renderHeaderOperationalState(state) {
    assertPlainObject(state, 'Header operational state');
    this._state.header = cloneValue(state);
    if (typeof state.busy === 'boolean') this._state.busy = state.busy;
    this._requestDraw();
  }

  renderTranscriptRecord(record) {
    const normalized = normalizeDisplayRecord(record, 'final');
    appendPaneRecord(this._state.panes.transcript, normalized);
    this._requestDraw();
    return cloneValue(normalized);
  }

  renderRoundActivityRecord(record) {
    const normalized = formatRoundActivityRecord(record);
    appendPaneRecord(this._state.panes.activity, normalized);
    this._requestDraw();
    return cloneValue(normalized);
  }

  renderActivityRecord(record) {
    const normalized = normalizeDisplayRecord(record, 'tool');
    const pane = this._state.panes.activity;
    if (normalized.kind === 'turn-state' && normalized.text === 'State: waiting') {
      this._state.activeTurnActivityStart = pane.records.length;
      if (this._state.exchangeActivityStart === null) {
        this._state.exchangeActivityStart = pane.records.length;
      }
    }
    appendPaneRecord(pane, normalized);
    if (
      (normalized.kind === 'turn-completed' || normalized.kind === 'turn-terminal')
      && this._state.exchangeActivityStart !== null
    ) {
      this._state.lastExchangeRange = {
        start: clamp(this._state.exchangeActivityStart, 0, pane.records.length),
        end: pane.records.length,
      };
      this._state.exchangeActivityStart = null;
    }
    this._requestDraw();
    return cloneValue(normalized);
  }

  renderTelemetrySnapshot(snapshot) {
    const normalized = normalizeTelemetrySnapshot(snapshot);
    this._state.telemetry = normalized;
    if (this._state.activeTurnActivityStart !== null && normalized.roundRecords.length > 0) {
      const pane = this._state.panes.activity;
      const start = clamp(this._state.activeTurnActivityStart, 0, pane.records.length);
      const grouped = normalized.roundRecords.map(formatRoundActivityRecord);
      pane.records.splice(start, pane.records.length - start, ...grouped);
      if (!pane.follow) pane.newOutput = true;
      this._state.activeTurnActivityStart = null;
    }
    this._requestDraw();
    return cloneValue(this._state.telemetry);
  }

  renderCommandStatus(record) {
    assertPlainObject(record, 'Command/status record');
    const role = record.role || (record.status === 'error' || record.status === 'rejected'
      ? 'failure'
      : record.status === 'warning'
        ? 'warning'
        : 'tool');
    const text = Array.isArray(record.lines) ? record.lines.map(String).join('\n') : String(record.text ?? '');
    return this.renderActivityRecord({
      id: record.id || this._nextRecordId('command'),
      role,
      kind: 'command-status',
      text,
    });
  }

  renderResizeOverlay(state) {
    assertPlainObject(state, 'Resize overlay state');
    this._state.resizeOverlay = {
      active: Boolean(state.active),
      title: state.title === null || state.title === undefined ? null : String(state.title),
      detail: state.detail === null || state.detail === undefined ? null : String(state.detail),
    };
    this._runtime.needsRelayout = true;
    this._requestDraw();
  }

  renderCopyResult(result) {
    assertPlainObject(result, 'Copy result');
    const normalized = {
      ok: Boolean(result.ok),
      bytes: result.bytes === null || result.bytes === undefined ? null : Number(result.bytes),
      code: result.code === null || result.code === undefined ? null : String(result.code),
      message: result.message === null || result.message === undefined ? null : String(result.message),
    };
    this._state.copyResult = normalized;
    const parts = [normalized.message || (normalized.ok ? 'Copy completed.' : 'Copy failed.')];
    if (normalized.bytes !== null) parts.push(`${normalized.bytes} bytes`);
    if (normalized.code) parts.push(`code ${normalized.code}`);
    this.renderActivityRecord({
      id: this._nextRecordId('copy'),
      kind: 'copy-result',
      role: normalized.ok ? 'tool' : 'failure',
      text: parts.join(' · '),
    });
    return cloneValue(normalized);
  }

  renderFatal(fatal) {
    const normalized = fatal instanceof Error
      ? { code: fatal.code || 'fatal', message: fatal.message }
      : (() => {
        assertPlainObject(fatal, 'Fatal state');
        return { code: String(fatal.code || 'fatal'), message: String(fatal.message || 'Fatal error') };
      })();
    this._state.fatal = normalized;
    this.renderActivityRecord({
      id: this._nextRecordId('fatal'),
      kind: 'fatal',
      role: 'failure',
      text: `${normalized.code}: ${normalized.message}`,
    });
    return cloneValue(normalized);
  }

  clearDisplay() {
    this._state.panes.transcript = createPaneState();
    this._state.panes.activity = createPaneState();
    this._state.selection = { pane: null, status: 'none', bytes: 0 };
    this._state.activeTurnActivityStart = null;
    this._state.exchangeActivityStart = null;
    this._state.lastExchangeRange = null;
    this._requestDraw();
  }

  setDraft(value, cursorOffset = [...String(value)].length) {
    this._setEditorValue(String(value), cursorOffset);
    this._requestDraw();
  }

  emit(event) {
    assertPlainObject(event, 'TUI event');
    assertPlainObject(event.payload || {}, 'TUI event payload');
    const payload = event.payload || {};
    switch (event.type) {
      case 'header': return this.renderHeaderOperationalState(payload);
      case 'transcript': return this.renderTranscriptRecord(payload);
      case 'round_activity': return this.renderRoundActivityRecord(payload);
      case 'activity': return this.renderActivityRecord(payload);
      case 'telemetry': return this.renderTelemetrySnapshot(payload.snapshot || payload);
      case 'command_status': return this.renderCommandStatus(payload);
      case 'resize_overlay': return this.renderResizeOverlay(payload);
      case 'copy_result': return this.renderCopyResult(payload);
      case 'fatal': return this.renderFatal(payload);
      case 'shutdown': return this.shutdown(payload.reason || 'normal', payload);
      default: throw new Error(`Unsupported TUI event type: ${event.type}`);
    }
  }

  async start() {
    if (this._runtime.started) return { started: true, layout: cloneValue(this._runtime.layout) };
    if (!this._options.input.isTTY || !this._options.output.isTTY) {
      this._options.output.write(NON_TTY_DIAGNOSTIC);
      return { started: false, reason: 'non-tty', exitCode: 2 };
    }

    const environmentProfile = prepareWindowsTerminalEnvironment(this._options.env, this._options.platform);
    const termkit = this._options.terminalKitLoader();
    const term = termkit.terminal;
    this._runtime.termkit = termkit;
    this._runtime.term = term;
    this._runtime.palette = makeTerminalPalette(termkit, term);
    this._runtime.terminalProfile = {
      environment: environmentProfile,
      palette: enforceExactWindowsTerminalPalette(this._runtime.palette, environmentProfile),
    };
    this._runtime.enterDebouncer = new EnterDebouncer({
      delayMs: TUI_CONFIG.pasteDebounceMs,
      onNewLine: () => {
        if (!this._runtime.widgets || !this._runtime.layout?.supported) return;
        termkit.EditableTextBox.prototype.userActions.newLine.call(this._runtime.widgets.input);
      },
      onSubmit: () => { this._submitEditor().catch((error) => this._handleFatalShutdown('submit-error', error)); },
    });

    try {
      term.fullscreen();
      this._runtime.document = term.createDocument({
        palette: this._runtime.palette,
        backgroundAttr: this._attr('background'),
        noDraw: true,
      });
      if (this._runtime.document.onEventSourceResize) term.off('resize', this._runtime.document.onEventSourceResize);
      this._installProcessHandlers();
      this._runtime.started = true;
      if (this._options.version && typeof term.windowTitle === 'function') term.windowTitle(`MOTHER BRAIN v${this._options.version}`);
      this._relayout(term.width, term.height, true);
      return { started: true, layout: cloneValue(this._runtime.layout) };
    } catch (error) {
      await this.shutdown('initial-layout-failure', { exitCode: 1, error });
      throw error;
    }
  }

  stopAcceptingInput() {
    const changed = !this._state.stopping;
    this._state.stopping = true;
    if (this._runtime.enterDebouncer) this._runtime.enterDebouncer.cancel();
    return changed;
  }

  shutdown(reason = 'normal', options = {}) {
    if (this._runtime.shutdownPromise) return this._runtime.shutdownPromise;
    this.stopAcceptingInput();
    const exitCode = Number.isInteger(options.exitCode) ? options.exitCode : 0;
    const error = options.error instanceof Error ? options.error : null;
    if (this._options.onBeforeShutdown) {
      try { this._options.onBeforeShutdown({ reason: String(reason), exitCode, error }); } catch (_) {}
    }
    this._runtime.shutdownPromise = (async () => {
      this._removeProcessHandlers();
      this._captureEditorState();
      const { document, term } = this._runtime;
      try { if (document && !document.destroyed) document.destroy(undefined, true); } catch (_) {}
      try { if (term) term.fullscreen(false); } catch (_) {}
      try { if (term) await term.asyncCleanup(); } catch (_) {}
      this._runtime.started = false;
      const result = {
        reason: String(reason),
        exitCode,
        error: error ? { name: error.name, message: error.message, code: error.code || null } : null,
        retainedState: this.getSnapshot(),
      };
      await this._options.onShutdown(cloneValue(result));
      if (exitCode) process.exitCode = exitCode;
      return result;
    })();
    return this._runtime.shutdownPromise;
  }

  _nextRecordId(prefix) {
    this._state.recordCounter += 1;
    return `${prefix}-${Date.now()}-${this._state.recordCounter}`;
  }

  _attr(role, extra = {}) {
    return { color: ROLE_TOKEN[role], bgColor: ROLE_TOKEN.background, ...extra };
  }

  _captureEditorState() {
    const input = this._runtime.widgets?.input;
    if (!input || input.destroyed) return;
    this._state.draft = input.getValue();
    this._state.cursorOffset = input.textBuffer.getCursorOffset();
  }

  _setEditorValue(value, cursorOffset = [...String(value)].length) {
    this._state.draft = String(value);
    this._state.cursorOffset = clamp(Math.round(cursorOffset), 0, [...this._state.draft].length);
    const input = this._runtime.widgets?.input;
    if (!input || input.destroyed || !this._runtime.layout?.supported) return;
    input.setValue(this._state.draft, true);
    restoreCursorOffset(input, this._state.cursorOffset);
    this._captureEditorState();
  }

  _desiredFooterTier() {
    // The permanent footer is deliberately three operational rows. Detailed
    // counters remain available through /status and /stats instead of growing
    // into a seven-line diagnostic dump merely because the window is tall.
    return 'core';
  }

  _requestDraw() {
    if (this._state.stopping || this._runtime.pendingDraw) return;
    this._runtime.pendingDraw = true;
    this._runtime.scheduledDraws += 1;
    this._options.scheduleFrame(() => {
      this._runtime.pendingDraw = false;
      if (!this._runtime.started || this._state.stopping) return;
      try {
        const term = this._runtime.term;
        const tier = this._desiredFooterTier(term.height);
        if (this._runtime.needsRelayout
          || !this._runtime.layout
          || this._runtime.layout.width !== term.width
          || this._runtime.layout.height !== term.height
          || this._runtime.layout.footerTier !== tier) {
          this._relayout(term.width, term.height, false);
        } else {
          this._renderNow();
        }
      } catch (error) {
        this._handleFatalShutdown('render-error', error);
      }
    });
  }

  _renderNow() {
    if (!this._runtime.document || !this._runtime.widgets || !this._runtime.layout) return;
    if (this._runtime.layout.supported && !this._state.resizeOverlay.active) {
      this._renderPane('transcript');
      this._renderPane('activity');
      this._updateStaticContent();
    } else {
      this._updateOverlayContent();
    }
    this._runtime.document.draw();
    this._runtime.completedDraws += 1;
  }

  _paneMaximumTop(widget) {
    return Math.max(0, widget.textBuffer.buffer.length - widget.textAreaHeight);
  }

  _applyPaneScroll(paneName, noDraw = true) {
    const pane = this._state.panes[paneName];
    const widget = this._runtime.widgets[paneName];
    const maximumTop = this._paneMaximumTop(widget);
    if (pane.follow) widget.scrollToBottom(true);
    else {
      pane.topLogicalLine = clamp(pane.topLogicalLine, 0, maximumTop);
      widget.scrollTo(null, -pane.topLogicalLine, true);
    }
    if (!noDraw) widget.draw();
  }

  _renderPane(paneName) {
    const pane = this._state.panes[paneName];
    const projection = projectRecords(pane.records);
    this._runtime.widgets[paneName].setContent(formatProjection(projection), true, true);
    this._applyPaneScroll(paneName, true);
  }

  _headerLine() {
    const header = this._state.header;
    const parts = ['MOTHER BRAIN'];
    if (this._options.version) parts[0] += ` v${this._options.version}`;
    if (header.activity) parts.push(String(header.activity));
    if (header.configured_model) parts.push(String(header.configured_model));
    if (header.configured_reasoning_effort) parts.push(`${header.configured_reasoning_effort} configured`);
    if (header.actual_model) parts.push(`actual ${header.actual_model}`);
    if (this._state.busy) parts.push('BUSY');
    return parts.join(' · ');
  }

  _footerLines() {
    const layout = this._runtime.layout;
    const capacity = Math.max(0, layout.footerContent.height);
    const displaySource = telemetryWithDisplayOverrides(
      this._state.telemetry.source,
      this._state.header,
      this._state.busy,
    );
    const telemetry = isPlainObject(displaySource?.configured_settings)
      ? formatTelemetryFooter({ source: displaySource, core: [], extended: [] }, layout.footerTier)
      : formatTelemetryFooter(this._state.telemetry, layout.footerTier);
    return telemetry.slice(0, capacity).map(formatFooterMarkupLine);
  }

  _updateStaticContent() {
    if (!this._runtime.widgets || !this._runtime.layout?.supported) return;
    const { widgets, layout } = this._runtime;
    widgets.header.setContent([this._headerLine()], false, true, true);
    widgets.transcriptTitle.setContent([
      ruledLine(`TRANSCRIPT${this._state.panes.transcript.newOutput ? ' · NEW OUTPUT' : ''}`, layout.transcriptTitle.width),
    ], false, true, true);
    widgets.activityTitle.setContent([
      ruledLine(`ACTIVITY / REASONING${this._state.panes.activity.newOutput ? ' · NEW OUTPUT' : ''}`, layout.activityTitle.width),
    ], false, true, true);
    widgets.inputLabel.setContent([
      ruledLine(`INPUT · Enter submits · multiline debounce ${TUI_CONFIG.pasteDebounceMs} ms`, layout.inputLabel.width),
    ], false, true, true);
    widgets.inputPrompt.setContent([INPUT_PROMPT], false, true, true);
    widgets.footerRule.setContent([ruledLine('STATUS', layout.footerRule.width)], false, true, true);
    widgets.footer.setContent(this._footerLines(), true, true, true);
    widgets.divider.setContent(Array.from({ length: layout.divider.height }, (_, index) => index === 0 ? '┼' : '│'), false, true, true);
  }

  _updateOverlayContent() {
    const { widgets, layout } = this._runtime;
    if (!widgets || !layout) return;
    const lines = Array.from({ length: Math.max(1, layout.height) }, () => '');
    const center = Math.max(0, Math.floor(layout.height / 2) - 2);
    const title = this._state.resizeOverlay.title || 'MOTHER BRAIN NEEDS MORE ROOM';
    const detail = this._state.resizeOverlay.detail
      || `Need at least ${TUI_CONFIG.supportedMinColumns}x${TUI_CONFIG.supportedMinRows}; current ${layout.width}x${layout.height}.`;
    lines[center] = title;
    if (center + 1 < lines.length) lines[center + 1] = detail;
    if (center + 2 < lines.length) lines[center + 2] = 'Draft, pane positions, and divider state are retained. Input and drag are paused.';
    widgets.overlay.setContent(lines, false, true, true);
  }

  _configureInputActions(input) {
    const inheritedActions = input.userActions;
    const ownActions = Object.create(inheritedActions);
    input.userActions = ownActions;
    ownActions.character = (key, trash, data) => {
      this._runtime.enterDebouncer.beforeCharacter();
      return inheritedActions.character.call(input, key, trash, data);
    };
    ownActions.debouncedSubmit = () => {
      this._runtime.enterDebouncer.handleEnter();
      return true;
    };
    ownActions.historyUp = () => {
      this._runtime.enterDebouncer.flushAsSubmit();
      if (input.textBuffer.cy > 0) return inheritedActions.up.call(input);
      this._setEditorValue(this._state.history.previous(input.getValue()));
      return true;
    };
    ownActions.historyDown = () => {
      this._runtime.enterDebouncer.flushAsSubmit();
      if (input.textBuffer.cy < input.textBuffer.buffer.length - 1) return inheritedActions.down.call(input);
      this._setEditorValue(this._state.history.next(input.getValue()));
      return true;
    };
    for (const action of [
      'backDelete', 'delete', 'deleteLine', 'backward', 'forward', 'startOfWord', 'endOfWord',
      'startOfLine', 'smartStartOfLine', 'endOfLine', 'left', 'right', 'tab', 'scrollUp',
      'scrollDown', 'scrollTop', 'scrollBottom', 'scrollToCursor', 'deleteSelection',
    ]) {
      if (typeof inheritedActions[action] !== 'function') continue;
      ownActions[action] = (...args) => {
        this._runtime.enterDebouncer.flushAsSubmit();
        return inheritedActions[action].apply(input, args);
      };
    }
  }

  _makeWidgets(layout) {
    const termkit = this._runtime.termkit;
    const document = this._runtime.document;
    const commonText = { parent: document, noDraw: true };
    const widgets = {
      header: new termkit.Text({ ...commonText, ...layout.header, content: '', attr: this._attr('final', { bold: true }) }),
      transcriptTitle: new termkit.Text({ ...commonText, ...layout.transcriptTitle, content: '', attr: this._attr('border', { bold: true }) }),
      activityTitle: new termkit.Text({ ...commonText, ...layout.activityTitle, content: '', attr: this._attr('border', { bold: true }) }),
      transcript: new termkit.TextBox({
        parent: document, ...layout.transcriptContent, content: '', contentHasMarkup: true, scrollable: true,
        lineWrap: true, wordWrap: true, textAttr: this._attr('telemetry'), voidAttr: this._attr('telemetry'), noDraw: true,
      }),
      activity: new termkit.TextBox({
        parent: document, ...layout.activityContent, content: '', contentHasMarkup: true, scrollable: true,
        lineWrap: true, wordWrap: true, textAttr: this._attr('reasoning'), voidAttr: this._attr('reasoning'), noDraw: true,
      }),
      divider: new termkit.Text({ ...commonText, ...layout.divider, content: [], attr: this._attr('border', { bold: true }) }),
      inputLabel: new termkit.Text({ ...commonText, ...layout.inputLabel, content: '', attr: this._attr('border', { bold: true }) }),
      inputPrompt: new termkit.Text({ ...commonText, ...layout.inputPrompt, content: '', attr: this._attr('developer', { bold: true }) }),
      input: new termkit.EditableTextBox({
        parent: document, ...layout.editor, value: this._state.draft, scrollable: true, lineWrap: true, wordWrap: false,
        debounceTimeout: 0,
        keyBindings: {
          ...termkit.EditableTextBox.prototype.keyBindings,
          ENTER: 'debouncedSubmit', KP_ENTER: 'debouncedSubmit', UP: 'historyUp', DOWN: 'historyDown',
        },
        textAttr: this._attr('developer'), voidAttr: this._attr('developer'), noDraw: true,
      }),
      footerRule: new termkit.Text({ ...commonText, ...layout.footerRule, content: '', attr: this._attr('border', { bold: true }) }),
      footer: new termkit.Text({
        ...commonText, ...layout.footerContent, content: [], contentHasMarkup: true, attr: this._attr('telemetry'),
      }),
      overlay: new termkit.Text({
        ...commonText, x: 0, y: 0, width: layout.width, height: layout.height, content: [],
        attr: this._attr('warning', { bold: true }), hidden: true,
      }),
    };

    widgets.divider.outerDrag = true;
    widgets.transcript.off('wheel', widgets.transcript.onWheel);
    widgets.transcript.off('click', widgets.transcript.onClick);
    widgets.transcript.off('drag', widgets.transcript.onDrag);
    widgets.activity.off('wheel', widgets.activity.onWheel);
    widgets.activity.off('click', widgets.activity.onClick);
    widgets.activity.off('drag', widgets.activity.onDrag);
    widgets.input.off('wheel', widgets.input.onWheel);
    widgets.input.off('drag', widgets.input.onDrag);
    widgets.input.off('dragEnd', widgets.input.onDragEnd);
    widgets.input.off('middleClick', widgets.input.onMiddleClick);

    for (const paneName of ['transcript', 'activity']) {
      const widget = widgets[paneName];
      widget.on('dragStart', () => {
        if (!this._runtime.layout?.supported || this._state.stopping) return;
        this._runtime.selectionCopyToken += 1;
        for (const candidateName of ['transcript', 'activity']) {
          const candidate = widgets[candidateName];
          if (!candidate.textBuffer.selectionRegion) continue;
          candidate.textBuffer.resetSelectionRegion();
          candidate.draw();
        }
        this._state.selection = { pane: paneName, status: 'selecting', bytes: 0 };
        this._updateStaticContent();
        widgets.footer.draw();
      });
      widget.on('drag', (data) => {
        if (!this._runtime.layout?.supported || this._state.stopping) return;
        widget.textBuffer.setSelectionRegion(paneSelectionRegion(data, widget));
        widget.draw();
      });
      widget.on('dragEnd', () => {
        if (!this._runtime.layout?.supported || this._state.stopping) return;
        const selectionText = selectedPaneText(widget);
        this._state.selection = {
          pane: paneName,
          status: selectionText ? 'copying' : 'empty',
          bytes: Buffer.byteLength(selectionText, 'utf8'),
        };
        document.giveFocusTo(widgets.input, 'select');
        widgets.input.drawCursor();
        this._updateStaticContent();
        widgets.footer.draw();
        if (!selectionText) return;
        const token = ++this._runtime.selectionCopyToken;
        Promise.resolve(this._options.clipboardWriter(selectionText)).then(() => {
          if (this._state.stopping || token !== this._runtime.selectionCopyToken) return;
          this._state.selection.status = 'copied';
          this._requestDraw();
        }).catch((error) => {
          if (this._state.stopping || token !== this._runtime.selectionCopyToken) return;
          this._state.selection.status = 'copy-failed';
          this.renderCommandStatus({ status: 'error', text: `Pane copy failed: ${error.message}` });
        });
      });
      widget.on('wheel', (data) => {
        if (!this._runtime.layout?.supported || this._state.stopping) return;
        const pane = this._state.panes[paneName];
        const maximumTop = this._paneMaximumTop(widget);
        const currentTop = pane.follow ? maximumTop : pane.topLogicalLine;
        const step = Math.max(1, Math.ceil(widget.textAreaHeight / 5));
        scrollPaneState(pane, currentTop + data.yDirection * step, maximumTop);
        this._applyPaneScroll(paneName, false);
        this._updateStaticContent();
        widgets.footer.draw();
        widgets[`${paneName}Title`].draw();
        document.giveFocusTo(widgets.input, 'select');
      });
    }

    let dragStartWidth = layout.transcriptWidth;
    widgets.divider.on('dragStart', () => {
      if (!this._runtime.layout?.supported || this._state.stopping) return;
      dragStartWidth = this._runtime.layout.transcriptWidth;
    });
    widgets.divider.on('drag', (data) => {
      if (!this._runtime.layout?.supported || this._state.stopping) return;
      const nextLayout = dividerLayoutForColumn(
        this._runtime.layout.width,
        this._runtime.layout.height,
        dragStartWidth + data.x,
        { footerTier: this._runtime.layout.footerTier },
      );
      this._state.splitRatio = nextLayout.transcriptWidth / nextLayout.availablePaneWidth;
      this._applySupportedLayout(nextLayout, true);
    });
    widgets.divider.on('dragEnd', () => {
      if (!this._runtime.layout?.supported || this._state.stopping) return;
      document.giveFocusTo(widgets.input, 'select');
      widgets.input.drawCursor();
    });

    this._configureInputActions(widgets.input);
    widgets.input.on('change', () => this._captureEditorState());
    widgets.input.on('cursorMove', () => this._captureEditorState());
    restoreCursorOffset(widgets.input, this._state.cursorOffset);
    return widgets;
  }

  _applySupportedLayout(layout, draw = false) {
    this._runtime.layout = layout;
    if (!this._runtime.widgets) this._runtime.widgets = this._makeWidgets(layout);
    const widgets = this._runtime.widgets;
    this._captureEditorState();
    const retainedCursor = this._state.cursorOffset;
    for (const [name, rectangle] of [
      ['header', layout.header], ['transcriptTitle', layout.transcriptTitle], ['activityTitle', layout.activityTitle],
      ['divider', layout.divider], ['inputLabel', layout.inputLabel], ['inputPrompt', layout.inputPrompt],
      ['footerRule', layout.footerRule], ['footer', layout.footerContent],
    ]) setTextGeometry(widgets[name], rectangle);
    widgets.transcript.setSizeAndPosition(layout.transcriptContent);
    widgets.activity.setSizeAndPosition(layout.activityContent);
    widgets.input.setSizeAndPosition(layout.editor);
    setTextGeometry(widgets.overlay, { x: 0, y: 0, width: layout.width, height: layout.height });
    widgets.input.setValue(this._state.draft, true);
    restoreCursorOffset(widgets.input, retainedCursor);
    for (const widget of Object.values(widgets)) {
      widget.hidden = widget === widgets.overlay;
      if (widget !== widgets.overlay) widget.disabled = false;
    }
    this._renderPane('transcript');
    this._renderPane('activity');
    this._updateStaticContent();
    this._runtime.document.giveFocusTo(widgets.input, 'select');
    if (draw) {
      this._runtime.document.draw();
      this._runtime.completedDraws += 1;
    }
  }

  _applyOverlayLayout(layout, draw = false) {
    this._runtime.layout = layout;
    if (!this._runtime.widgets) {
      const provisional = computeLayout(
        Math.max(TUI_CONFIG.supportedMinColumns, layout.width),
        Math.max(TUI_CONFIG.supportedMinRows, layout.height),
        this._state.splitRatio,
        { footerTier: 'core' },
      );
      this._runtime.widgets = this._makeWidgets(provisional);
    }
    this._captureEditorState();
    const widgets = this._runtime.widgets;
    for (const widget of Object.values(widgets)) {
      widget.hidden = widget !== widgets.overlay;
      if (widget !== widgets.overlay) widget.disabled = true;
    }
    widgets.overlay.hidden = false;
    widgets.overlay.disabled = false;
    setTextGeometry(widgets.overlay, { x: 0, y: 0, width: Math.max(1, layout.width), height: Math.max(1, layout.height) });
    this._updateOverlayContent();
    this._runtime.document.giveFocusTo(widgets.overlay, 'select');
    if (draw) {
      this._runtime.document.draw();
      this._runtime.completedDraws += 1;
    }
  }

  _relayout(width, height, draw = true) {
    if (this._state.stopping) return;
    const document = this._runtime.document;
    document.resize({ x: 0, y: 0, width: Math.max(1, width), height: Math.max(1, height) });
    document.outputWidth = Math.max(1, width);
    document.outputHeight = Math.max(1, height);
    const layout = computeLayout(width, height, this._state.splitRatio, { footerTier: this._desiredFooterTier(height) });
    if (layout.supported && !this._state.resizeOverlay.active) this._applySupportedLayout(layout, false);
    else this._applyOverlayLayout(layout, false);
    this._runtime.needsRelayout = false;
    if (draw) {
      document.draw();
      this._runtime.completedDraws += 1;
    }
  }

  async _submitEditor() {
    if (this._state.stopping || !this._runtime.layout?.supported || this._state.resizeOverlay.active) return;
    this._captureEditorState();
    const value = this._state.draft;
    if (!value.trim()) return;
    const localCommand = value.trimStart().startsWith('/');
    if (localCommand && value.trim().toLowerCase() === '/copycot') {
      let result;
      const range = this._state.lastExchangeRange;
      if (!range) {
        result = { ok: false, bytes: null, code: 'no_completed_exchange', message: 'No completed exchange to copy.' };
      } else {
        try {
          const records = this._state.panes.activity.records.slice(range.start, range.end);
          const text = plainProjectionText(projectRecords(records));
          await this._options.clipboardWriter(text);
          result = { ok: true, bytes: Buffer.byteLength(text, 'utf8'), code: 'exchange_copied', message: 'Copied last exchange.' };
        } catch (error) {
          result = { ok: false, bytes: null, code: 'clipboard_write_failed', message: `Copy failed: ${error.message}` };
        }
      }
      this.renderCopyResult(result);
      this._state.history.push(value);
      this._setEditorValue('', 0);
      this._requestDraw();
      return;
    }
    if (this._state.busy && !localCommand) {
      if (this._options.onBlockedSubmit) await this._options.onBlockedSubmit(value);
      return;
    }
    const result = await this._options.onSubmit(value);
    const accepted = result !== false && result?.accepted !== false;
    if (!accepted) return;
    this._state.history.push(value);
    this._setEditorValue('', 0);
    this._requestDraw();
  }

  _installProcessHandlers() {
    const term = this._runtime.term;
    const onResize = (width, height) => {
      try { this._relayout(width, height, true); }
      catch (error) { this._handleFatalShutdown('resize-error', error); }
    };
    const onKey = (key) => {
      if (key === 'CTRL_C') this.shutdown('CTRL_C', { exitCode: 130 });
    };
    const onSigint = () => this.shutdown('SIGINT', { exitCode: 130 });
    const onSigterm = () => this.shutdown('SIGTERM', { exitCode: 143 });
    const onSighup = () => this.shutdown('SIGHUP', { exitCode: 129 });
    const onSigbreak = () => this.shutdown('SIGBREAK', { exitCode: 131 });
    const onUncaughtException = (error) => this._handleFatalShutdown('uncaughtException', error);
    const onUnhandledRejection = (reason) => this._handleFatalShutdown(
      'unhandledRejection',
      reason instanceof Error ? reason : new Error(String(reason)),
    );
    const onProcessExit = (code) => {
      if (this._runtime.shutdownPromise) return;
      const exitCode = Number.isInteger(code) ? code : 0;
      this.stopAcceptingInput();
      if (this._options.onBeforeShutdown) {
        try { this._options.onBeforeShutdown({ reason: 'process-exit-fallback', exitCode, error: null }); } catch (_) {}
      }
      try { if (this._runtime.document && !this._runtime.document.destroyed) this._runtime.document.destroy(undefined, true); } catch (_) {}
      try { term.fullscreen(false); } catch (_) {}
      try { term.styleReset(); } catch (_) {}
      try { term.hideCursor(false); } catch (_) {}
      try { term.grabInput(false); } catch (_) {}
      if (this._options.onSynchronousExit) {
        try { this._options.onSynchronousExit({ reason: 'process-exit-fallback', exitCode }); } catch (_) {}
      }
    };
    this._runtime.handlers = {
      onResize, onKey, onSigint, onSigterm, onSighup, onSigbreak,
      onUncaughtException, onUnhandledRejection, onProcessExit,
    };
    term.on('resize', onResize);
    term.on('key', onKey);
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    process.on('SIGHUP', onSighup);
    process.on('SIGBREAK', onSigbreak);
    process.on('uncaughtException', onUncaughtException);
    process.on('unhandledRejection', onUnhandledRejection);
    process.once('exit', onProcessExit);
  }

  _removeProcessHandlers() {
    const handlers = this._runtime.handlers;
    if (!handlers) return;
    const term = this._runtime.term;
    term.off('resize', handlers.onResize);
    term.off('key', handlers.onKey);
    process.off('SIGINT', handlers.onSigint);
    process.off('SIGTERM', handlers.onSigterm);
    process.off('SIGHUP', handlers.onSighup);
    process.off('SIGBREAK', handlers.onSigbreak);
    process.off('uncaughtException', handlers.onUncaughtException);
    process.off('unhandledRejection', handlers.onUnhandledRejection);
    process.off('exit', handlers.onProcessExit);
    this._runtime.handlers = null;
  }

  _handleFatalShutdown(reason, error) {
    this.shutdown(reason, { exitCode: 1, error }).catch(() => {});
  }
}

function createMotherBrainTui(options) {
  return new MotherBrainTui(options);
}

module.exports = {
  TUI_CONFIG,
  TUI_BOUNDS,
  PALETTE,
  ROLE_TOKEN,
  INPUT_PROMPT,
  REASONING_UNAVAILABLE,
  NON_TTY_DIAGNOSTIC,
  CORE_FOOTER_FIELD_IDS,
  EXTENDED_FOOTER_FIELD_IDS,
  computeLayout,
  dividerLayoutForColumn,
  normalizeDisplayRecord,
  recordLogicalLines,
  projectRecords,
  formatProjection,
  plainProjectionText,
  formatRoundActivityRecord,
  buildTelemetryFooterProjection,
  formatFooterMarkupLine,
  telemetryWithDisplayOverrides,
  normalizeTelemetrySnapshot,
  formatTelemetryFooter,
  HistoryBuffer,
  EnterDebouncer,
  createPaneState,
  appendPaneRecord,
  scrollPaneState,
  paneSelectionRegion,
  selectedPaneText,
  copyToWindowsClipboard,
  prepareWindowsTerminalEnvironment,
  makeTerminalPalette,
  enforceExactWindowsTerminalPalette,
  MotherBrainTui,
  createMotherBrainTui,
};
