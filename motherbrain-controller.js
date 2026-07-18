'use strict';

const path = require('node:path');

/**
 * Terminal-independent Mother Brain controller contract.
 *
 * Steps 3-7 establish the importable boundary, pure protocol helpers,
 * dependency seams, mockable DeepSeek V4 request loop, and bounded
 * persistence, and registry-driven local commands. Production composition
 * and canonical invalid-tool dispatch remain behind their later-step boundaries.
 */

class ControllerContractError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'ControllerContractError';
    this.code = code;
    this.details = details;
  }
}

class StepBoundaryError extends ControllerContractError {
  constructor(step, capability) {
    super(
      `step_${step}_required`,
      `${capability} requires Step ${step} and is outside the implemented controller boundary.`,
      { step, capability }
    );
    this.name = 'StepBoundaryError';
  }
}

function deepFreeze(value) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype === null || prototype === Object.prototype) return true;
  return Object.getPrototypeOf(prototype) === null
    && Object.prototype.toString.call(value) === '[object Object]';
}

function cloneJsonValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function contractAssert(condition, code, message, details = null) {
  if (!condition) throw new ControllerContractError(code, message, details);
}

const CONTROLLER_CONTRACT_VERSION = 1;
const SETTINGS_SCHEMA_VERSION = 1;
const HISTORY_SCHEMA_VERSION = 2;
const EXPECTED_PRODUCTION_TOOL_COUNT = 38;
const DURABLE_HISTORY_EXCHANGE_LIMIT = 5;
const MAX_HISTORY_FILE_BYTES = 32 * 1024 * 1024;
const HISTORY_V1_BACKUP_BASENAME = 'mb-history.v1.backup.json';
const COPYFILE_EXCLUSIVE = 1;
let atomicWriteSequence = 1;

const MODEL_IDS = deepFreeze({
  flash: 'deepseek-v4-flash',
  pro: 'deepseek-v4-pro'
});
const MODEL_COMMAND_ARGUMENTS = deepFreeze(Object.keys(MODEL_IDS));
const SUPPORTED_MODELS = deepFreeze(Object.values(MODEL_IDS));

const REASONING_EFFORTS = deepFreeze({
  high: 'high',
  max: 'max'
});
const SUPPORTED_REASONING_EFFORTS = deepFreeze(Object.values(REASONING_EFFORTS));

const DEFAULT_SETTINGS = deepFreeze({
  schema_version: SETTINGS_SCHEMA_VERSION,
  model: MODEL_IDS.flash,
  reasoning_effort: REASONING_EFFORTS.high
});

const DEEPSEEK_CHAT_COMPLETIONS_URL = 'https://api.deepseek.com/chat/completions';
const MAX_OUTPUT_TOKENS = 128000;
const MAX_REQUEST_UTF8_BYTES = 700000;
const THINKING_MODE = deepFreeze({ type: 'enabled' });
const REASONING_UNAVAILABLE_TEXT = 'Reasoning unavailable - provider returned none';

const PRICE_TABLE_SOURCE_DATE = '2026-07-16';
const PRICE_TABLE = deepFreeze({
  [MODEL_IDS.flash]: {
    cache_hit_per_million_usd: 0.0028,
    cache_miss_per_million_usd: 0.14,
    output_per_million_usd: 0.28
  },
  [MODEL_IDS.pro]: {
    cache_hit_per_million_usd: 0.003625,
    cache_miss_per_million_usd: 0.435,
    output_per_million_usd: 0.87
  }
});

const TOOL_RESULT_PREVIEW_CHAR_LIMIT = 256;
const REDACTED_DISPLAY_VALUE = '[REDACTED]';
const TELEMETRY_FIELD_AUTHORITY = deepFreeze({
  configured_model: 'configured_settings.model',
  configured_effort: 'configured_settings.reasoning_effort (configured)',
  actual_model: 'provider response model; last_actual_model when idle',
  developer_calls: 'session.completed_calls',
  api_rounds: 'session.api_rounds',
  api_attempts: 'session.api_attempts',
  current_call: 'last_call',
  session_totals: 'session',
  provider_usage: 'last_call.usage and last_call.per_round[].usage',
  estimated_history_tokens: 'conversation.estimated_history_tokens (local estimate)',
  retry_count: 'last_call.retry_count',
  fallback: 'last_call.fallback',
  unavailable: 'null or cost_available=false; never coerced to zero',
  genuine_zero: 'numeric zero reported or accumulated by the owning field'
});

const CONTEXT_CONTRACT = deepFreeze({
  endpoint: DEEPSEEK_CHAT_COMPLETIONS_URL,
  max_output_tokens: MAX_OUTPUT_TOKENS,
  initial_max_request_utf8_bytes: MAX_REQUEST_UTF8_BYTES,
  thinking: THINKING_MODE,
  streaming: false
});

const COMMAND_BUSY_RULES = deepFreeze({
  allowed: 'allowed_while_busy',
  nextTurn: 'allowed_while_busy_next_turn',
  idleOnly: 'idle_only'
});

function parseNoArguments(raw) {
  const text = String(raw ?? '').trim();
  if (text) return { ok: false, code: 'unexpected_argument', value: null };
  return { ok: true, value: null };
}

function parseOptionalEnum(raw, values, aliases = null) {
  const text = String(raw ?? '').trim().toLowerCase();
  if (!text) return { ok: true, value: null };
  if (/\s/.test(text)) return { ok: false, code: 'too_many_arguments', value: null };
  if (aliases) {
    if (!Object.hasOwn(aliases, text)) return { ok: false, code: 'invalid_argument', value: null };
    return { ok: true, value: aliases[text] };
  }
  const value = text;
  if (!values.includes(value)) return { ok: false, code: 'invalid_argument', value: null };
  return { ok: true, value };
}

function parseOptionalCommand(raw) {
  const text = String(raw ?? '').trim().toLowerCase();
  if (!text) return { ok: true, value: null };
  if (/\s/.test(text)) return { ok: false, code: 'too_many_arguments', value: null };
  const token = text.startsWith('/') ? text : `/${text}`;
  const known = COMMAND_REGISTRY.some(entry => entry.token === token);
  if (!known) return { ok: false, code: 'unknown_command', value: null };
  return { ok: true, value: token };
}

function delegateCommand(methodName) {
  return function registeredCommandHandler(controller, parsedArgument) {
    contractAssert(
      controller && typeof controller[methodName] === 'function',
      'invalid_command_controller',
      `The registered handler ${methodName} requires a MotherBrainController instance.`
    );
    return controller[methodName](parsedArgument);
  };
}

const COMMAND_REGISTRY = deepFreeze([
  {
    token: '/help',
    syntax: '/help [command]',
    description: 'Show every registered command or one command entry locally.',
    argument_enum: null,
    parse_argument: parseOptionalCommand,
    busy_rule: COMMAND_BUSY_RULES.allowed,
    handler: delegateCommand('_commandHelp')
  },
  {
    token: '/model',
    syntax: '/model [flash|pro]',
    description: 'Show or persist the model used by the next developer turn.',
    argument_enum: MODEL_COMMAND_ARGUMENTS,
    parse_argument: raw => parseOptionalEnum(raw, MODEL_COMMAND_ARGUMENTS, MODEL_IDS),
    busy_rule: COMMAND_BUSY_RULES.nextTurn,
    handler: delegateCommand('_commandModel')
  },
  {
    token: '/reasoning',
    syntax: '/reasoning [high|max]',
    description: 'Show or persist the configured reasoning effort for the next turn.',
    argument_enum: SUPPORTED_REASONING_EFFORTS,
    parse_argument: raw => parseOptionalEnum(raw, SUPPORTED_REASONING_EFFORTS),
    busy_rule: COMMAND_BUSY_RULES.nextTurn,
    handler: delegateCommand('_commandReasoning')
  },
  {
    token: '/status',
    syntax: '/status',
    description: 'Show configuration, operational, replay, and durability state locally.',
    argument_enum: deepFreeze([]),
    parse_argument: parseNoArguments,
    busy_rule: COMMAND_BUSY_RULES.allowed,
    handler: delegateCommand('_commandStatus')
  },
  {
    token: '/stats',
    syntax: '/stats',
    description: 'Show session, call, round, token, cost, replay, and history statistics locally.',
    argument_enum: deepFreeze([]),
    parse_argument: parseNoArguments,
    busy_rule: COMMAND_BUSY_RULES.allowed,
    handler: delegateCommand('_commandStats')
  },
  {
    token: '/clear',
    syntax: '/clear',
    description: 'Clear completed conversation exchanges and last-copy state while idle.',
    argument_enum: deepFreeze([]),
    parse_argument: parseNoArguments,
    busy_rule: COMMAND_BUSY_RULES.idleOnly,
    handler: delegateCommand('_commandClear')
  },
  {
    token: '/copy',
    syntax: '/copy',
    description: 'Copy the most recent complete exchange through the Windows clipboard adapter.',
    argument_enum: deepFreeze([]),
    parse_argument: parseNoArguments,
    busy_rule: COMMAND_BUSY_RULES.allowed,
    handler: delegateCommand('_commandCopy')
  }
]);

function buildCommandPromptBlock(registry = COMMAND_REGISTRY) {
  contractAssert(Array.isArray(registry), 'invalid_command_registry', 'Command registry must be an array.');
  const entries = registry.map(entry => `${entry.syntax} - ${entry.description}`);
  return [
    'LOCAL MOTHER BRAIN COMMANDS',
    'These commands are handled locally and are never provider tool calls:',
    ...entries,
    'Do not invent or claim support for commands outside this registry.'
  ].join('\n');
}

function commandHelpEntry(entry) {
  return {
    token: entry.token,
    syntax: entry.syntax,
    description: entry.description,
    argument_enum: cloneJsonValue(entry.argument_enum),
    busy_rule: entry.busy_rule
  };
}

function appendCommandPromptSuffix(systemMessages, registry = COMMAND_REGISTRY) {
  contractAssert(
    Array.isArray(systemMessages) && systemMessages.length > 0,
    'invalid_system_messages',
    'systemMessages must contain at least one system message.'
  );
  const messages = cloneJsonValue(systemMessages);
  const lastIndex = messages.length - 1;
  messages[lastIndex] = {
    ...messages[lastIndex],
    content: `${messages[lastIndex].content}\n\n${buildCommandPromptBlock(registry)}`
  };
  return messages;
}

const OBSERVED_TOOL_PARAMETER_TYPES = deepFreeze(['string', 'integer', 'boolean', 'object']);
const TOOL_PARAMETER_SCHEMA_KEYS = deepFreeze(['type', 'description', 'enum']);
const TOOL_ROOT_SCHEMA_KEYS = deepFreeze(['type', 'properties', 'required']);

function createObservedToolSchemaIndex(
  tools,
  { expectedToolCount = EXPECTED_PRODUCTION_TOOL_COUNT } = {}
) {
  contractAssert(Array.isArray(tools), 'invalid_tool_catalogue', 'Tool catalogue must be an array.');
  if (expectedToolCount !== null) {
    contractAssert(
      tools.length === expectedToolCount,
      'tool_count_mismatch',
      `Expected ${expectedToolCount} tools but received ${tools.length}.`,
      { expected: expectedToolCount, actual: tools.length }
    );
  }

  const index = new Map();
  for (const tool of tools) {
    contractAssert(isPlainObject(tool), 'unsupported_tool_definition', 'Each tool definition must be a plain object.');
    contractAssert(tool.type === 'function', 'unsupported_tool_type', 'Every tool definition must use type function.');
    contractAssert(isPlainObject(tool.function), 'unsupported_tool_function', 'Tool function metadata must be a plain object.');

    const name = tool.function.name;
    contractAssert(typeof name === 'string' && name.trim(), 'invalid_tool_name', 'Every tool requires a nonempty name.');
    contractAssert(!index.has(name), 'duplicate_tool_name', `Duplicate tool definition: ${name}.`);

    const schema = tool.function.parameters;
    contractAssert(isPlainObject(schema), 'unsupported_tool_schema', `Tool ${name} requires a plain parameter schema.`);
    const unsupportedRootKeys = Object.keys(schema).filter(key => !TOOL_ROOT_SCHEMA_KEYS.includes(key));
    contractAssert(
      unsupportedRootKeys.length === 0,
      'unsupported_tool_schema_feature',
      `Tool ${name} uses unsupported root schema features: ${unsupportedRootKeys.join(', ')}.`,
      { tool: name, features: unsupportedRootKeys }
    );
    contractAssert(schema.type === 'object', 'unsupported_tool_schema_type', `Tool ${name} parameters must be an object.`);

    const properties = schema.properties ?? {};
    const required = schema.required ?? [];
    contractAssert(isPlainObject(properties), 'unsupported_tool_properties', `Tool ${name} properties must be a plain object.`);
    contractAssert(Array.isArray(required), 'unsupported_required_schema', `Tool ${name} required must be an array.`);

    const requiredSet = new Set();
    for (const propertyName of required) {
      contractAssert(
        typeof propertyName === 'string' && propertyName,
        'unsupported_required_schema',
        `Tool ${name} has an invalid required property name.`
      );
      contractAssert(!requiredSet.has(propertyName), 'duplicate_required_property', `Tool ${name} repeats required property ${propertyName}.`);
      contractAssert(Object.hasOwn(properties, propertyName), 'unknown_required_property', `Tool ${name} requires undeclared property ${propertyName}.`);
      requiredSet.add(propertyName);
    }

    for (const [propertyName, propertySchema] of Object.entries(properties)) {
      contractAssert(
        isPlainObject(propertySchema),
        'unsupported_tool_property_schema',
        `Tool ${name}.${propertyName} must use a plain schema object.`
      );
      const unsupportedPropertyKeys = Object.keys(propertySchema).filter(key => !TOOL_PARAMETER_SCHEMA_KEYS.includes(key));
      contractAssert(
        unsupportedPropertyKeys.length === 0,
        'unsupported_tool_schema_feature',
        `Tool ${name}.${propertyName} uses unsupported schema features: ${unsupportedPropertyKeys.join(', ')}.`,
        { tool: name, property: propertyName, features: unsupportedPropertyKeys }
      );
      contractAssert(
        OBSERVED_TOOL_PARAMETER_TYPES.includes(propertySchema.type),
        'unsupported_tool_property_type',
        `Tool ${name}.${propertyName} uses unsupported type ${String(propertySchema.type)}.`
      );

      if (Object.hasOwn(propertySchema, 'enum')) {
        contractAssert(propertySchema.type === 'string', 'unsupported_tool_enum', `Tool ${name}.${propertyName} enum must constrain a string.`);
        contractAssert(
          Array.isArray(propertySchema.enum) && propertySchema.enum.length > 0 && propertySchema.enum.every(value => typeof value === 'string'),
          'unsupported_tool_enum',
          `Tool ${name}.${propertyName} enum must be a nonempty string array.`
        );
        contractAssert(
          new Set(propertySchema.enum).size === propertySchema.enum.length,
          'duplicate_tool_enum_value',
          `Tool ${name}.${propertyName} enum values must be unique.`
        );
      }

      if (propertySchema.type === 'object') {
        contractAssert(
          !Object.hasOwn(propertySchema, 'enum'),
          'unsupported_tool_schema_feature',
          `Opaque object ${name}.${propertyName} cannot declare an enum.`
        );
      }
    }

    index.set(name, { definition: tool, schema, properties, required: requiredSet });
  }
  return index;
}

function toolCallError(code, detail) {
  return { code, detail };
}

function deterministicToolValidationResult(error) {
  return JSON.stringify({
    error: 'invalid_tool_call',
    code: error.code,
    detail: error.detail
  });
}

function providerAssistantViewProjection(assistantMessage) {
  return {
    role: assistantMessage.role,
    content: assistantMessage.content,
    reasoning_content: assistantMessage.reasoning_content,
    tool_call_count: Array.isArray(assistantMessage.tool_calls)
      ? assistantMessage.tool_calls.length
      : 0
  };
}

function isSensitiveDisplayKey(key) {
  const normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
  return [
    'authorization',
    'proxyauthorization',
    'cookie',
    'setcookie',
    'password',
    'passwd',
    'secret',
    'clientsecret',
    'privatekey',
    'apikey',
    'accesskey',
    'accesstoken',
    'refreshtoken',
    'idtoken',
    'githubpat',
    'diagnosticskey',
    'deepseekkey',
    'credential'
  ].includes(normalized);
}

function environmentSecretValues(environment = process.env) {
  if (!environment || typeof environment !== 'object') return [];
  const sensitiveName = /(authorization|cookie|credential|password|passwd|private|secret|token|api[_-]?key|access[_-]?key|github[_-]?pat|diagnostics[_-]?key)/i;
  return [...new Set(Object.entries(environment)
    .filter(([key, value]) => (isSensitiveDisplayKey(key) || sensitiveName.test(key))
      && typeof value === 'string' && value.length >= 4)
    .map(([, value]) => value))];
}

function redactSensitiveText(value, secretValues = []) {
  let text = String(value);
  for (const secret of secretValues) {
    const literal = String(secret ?? '');
    if (literal.length >= 4) text = text.split(literal).join(REDACTED_DISPLAY_VALUE);
  }
  text = text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{4,}/gi, `Bearer ${REDACTED_DISPLAY_VALUE}`)
    .replace(/\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{8,}\b/g, REDACTED_DISPLAY_VALUE)
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, REDACTED_DISPLAY_VALUE)
    .replace(/\b[A-Z0-9_]*(?:SECRET|TOKEN|KEY)[A-Z0-9_]*_SENTINEL[A-Z0-9_]*\b/g, REDACTED_DISPLAY_VALUE)
    .replace(
      /\b(authorization|proxy-authorization|x-diagnostics-key|api[_-]?key|github[_-]?pat|password|secret|private[_-]?key)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
      (_, key, separator) => `${key}${separator}${REDACTED_DISPLAY_VALUE}`
    );
  return text;
}

function redactDisplayValue(value, { secretValues = [] } = {}) {
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return redactSensitiveText(value, secretValues);
  if (Array.isArray(value)) return value.map(item => redactDisplayValue(item, { secretValues }));
  if (!isPlainObject(value)) return REDACTED_DISPLAY_VALUE;
  const redacted = {};
  for (const [key, child] of Object.entries(value)) {
    redacted[key] = isSensitiveDisplayKey(key)
      ? REDACTED_DISPLAY_VALUE
      : redactDisplayValue(child, { secretValues });
  }
  return redacted;
}

function boundedToolResultPreview(toolContent, {
  maxChars = TOOL_RESULT_PREVIEW_CHAR_LIMIT,
  secretValues = []
} = {}) {
  contractAssert(typeof toolContent === 'string', 'invalid_tool_preview_content', 'Tool preview content must be a string.');
  contractAssert(Number.isInteger(maxChars) && maxChars > 0, 'invalid_tool_preview_limit', 'Tool preview limit must be positive.');
  let source = toolContent;
  try { source = JSON.parse(toolContent); } catch (_) {}
  const redactedValue = redactDisplayValue(source, { secretValues });
  const rendered = (typeof redactedValue === 'string' ? redactedValue : JSON.stringify(redactedValue))
    .replace(/\r\n?/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
  const characters = [...rendered];
  const truncated = characters.length > maxChars;
  return {
    preview: truncated ? `${characters.slice(0, maxChars - 1).join('')}…` : rendered,
    truncated,
    redacted: rendered !== String(toolContent).replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim()
  };
}

function createRoundViewRecord(turnId, round, settings) {
  return {
    id: `${turnId}-round-${round}`,
    round,
    attempt_count: 0,
    actual_model: null,
    configured_reasoning_effort: settings.reasoning_effort,
    effort_attribution: 'configured',
    latency_ms: null,
    finish_reason: null,
    usage: null,
    cost_available: false,
    cost_usd: null,
    reasoning: null,
    retries: [],
    tool_calls: [],
    tool_results: [],
    states: ['waiting'],
    warnings: [],
    error_code: null
  };
}

function appendRoundViewState(roundView, state) {
  if (!roundView.states.includes(state)) roundView.states.push(state);
}

function projectValidatedToolCallForView(call, secretValues = environmentSecretValues()) {
  return {
    name: call.name || 'unknown tool',
    status: call.status,
    validation_code: call.status === 'valid' ? null : call.error?.code ?? 'invalid_tool_call',
    call_id_suffix: typeof call.id === 'string' ? call.id.slice(-8) : null,
    arguments: isPlainObject(call.args) ? redactDisplayValue(call.args, { secretValues }) : null
  };
}

function validateLinkableToolCall(toolCall, schemaIndex) {
  const id = toolCall.id;
  if (toolCall.type !== 'function') {
    const error = toolCallError('invalid_tool_call_type', 'Tool call type must be function.');
    return { status: 'rejected', linkable: true, id, error, toolContent: deterministicToolValidationResult(error) };
  }
  if (!isPlainObject(toolCall.function)) {
    const error = toolCallError('invalid_tool_function', 'Tool call function must be a plain object.');
    return { status: 'rejected', linkable: true, id, error, toolContent: deterministicToolValidationResult(error) };
  }

  const name = toolCall.function.name;
  if (typeof name !== 'string' || !name.trim()) {
    const error = toolCallError('invalid_tool_name', 'Tool call name must be a nonempty string.');
    return { status: 'rejected', linkable: true, id, error, toolContent: deterministicToolValidationResult(error) };
  }
  const entry = schemaIndex.get(name);
  if (!entry) {
    const error = toolCallError('unknown_tool', `Unknown tool: ${name}.`);
    return { status: 'rejected', linkable: true, id, name, error, toolContent: deterministicToolValidationResult(error) };
  }

  const rawArguments = toolCall.function.arguments;
  if (typeof rawArguments !== 'string') {
    const error = toolCallError('invalid_tool_arguments_type', 'Tool arguments must be a JSON string.');
    return { status: 'rejected', linkable: true, id, name, error, toolContent: deterministicToolValidationResult(error) };
  }

  let args;
  try {
    args = JSON.parse(rawArguments);
  } catch (_) {
    const error = toolCallError('invalid_tool_arguments_json', 'Tool arguments must contain valid JSON.');
    return { status: 'rejected', linkable: true, id, name, error, toolContent: deterministicToolValidationResult(error) };
  }
  if (!isPlainObject(args)) {
    const error = toolCallError('invalid_tool_arguments_object', 'Tool arguments must decode to a plain object.');
    return { status: 'rejected', linkable: true, id, name, error, toolContent: deterministicToolValidationResult(error) };
  }

  for (const requiredName of entry.required) {
    if (!Object.hasOwn(args, requiredName)) {
      const error = toolCallError('missing_tool_argument', `Missing required argument: ${requiredName}.`);
      return { status: 'rejected', linkable: true, id, name, error, toolContent: deterministicToolValidationResult(error) };
    }
  }

  const unexpectedNames = Object.keys(args).filter(key => !Object.hasOwn(entry.properties, key)).sort();
  if (unexpectedNames.length) {
    const error = toolCallError('unexpected_tool_argument', `Unexpected argument: ${unexpectedNames[0]}.`);
    return { status: 'rejected', linkable: true, id, name, error, toolContent: deterministicToolValidationResult(error) };
  }

  for (const [propertyName, value] of Object.entries(args)) {
    const propertySchema = entry.properties[propertyName];
    let validType = false;
    if (propertySchema.type === 'string') validType = typeof value === 'string';
    if (propertySchema.type === 'integer') validType = Number.isInteger(value);
    if (propertySchema.type === 'boolean') validType = typeof value === 'boolean';
    if (propertySchema.type === 'object') validType = isPlainObject(value);
    if (!validType) {
      const error = toolCallError('invalid_tool_argument_type', `Argument ${propertyName} must be ${propertySchema.type}.`);
      return { status: 'rejected', linkable: true, id, name, error, toolContent: deterministicToolValidationResult(error) };
    }
    if (propertySchema.enum && !propertySchema.enum.includes(value)) {
      const error = toolCallError('invalid_tool_argument_enum', `Argument ${propertyName} is outside its declared enum.`);
      return { status: 'rejected', linkable: true, id, name, error, toolContent: deterministicToolValidationResult(error) };
    }
  }

  return {
    status: 'valid',
    linkable: true,
    id,
    name,
    rawArguments,
    args
  };
}

function validateToolCallBatch(
  toolCalls,
  toolsOrSchemaIndex,
  { expectedToolCount = EXPECTED_PRODUCTION_TOOL_COUNT } = {}
) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return {
      abort: true,
      error: toolCallError('invalid_tool_calls_envelope', 'tool_calls must be a nonempty array.'),
      calls: []
    };
  }

  const schemaIndex = toolsOrSchemaIndex instanceof Map
    ? toolsOrSchemaIndex
    : createObservedToolSchemaIndex(toolsOrSchemaIndex, { expectedToolCount });

  const seenIds = new Set();
  for (const toolCall of toolCalls) {
    if (!isPlainObject(toolCall)) {
      return { abort: true, error: toolCallError('invalid_tool_call_envelope', 'Each tool call must be a plain object.'), calls: [] };
    }
    if (typeof toolCall.id !== 'string' || !toolCall.id.trim()) {
      return { abort: true, error: toolCallError('missing_tool_call_id', 'Every tool call requires a nonempty string ID.'), calls: [] };
    }
    if (seenIds.has(toolCall.id)) {
      return { abort: true, error: toolCallError('duplicate_tool_call_id', `Duplicate tool call ID: ${toolCall.id}.`), calls: [] };
    }
    if (toolCall.type !== 'function') {
      return { abort: true, error: toolCallError('invalid_tool_call_type', 'Every tool call envelope must use type function.'), calls: [] };
    }
    if (!isPlainObject(toolCall.function)) {
      return { abort: true, error: toolCallError('invalid_tool_function', 'Every tool call envelope requires function metadata.'), calls: [] };
    }
    if (typeof toolCall.function.name !== 'string' || !toolCall.function.name.trim()) {
      return { abort: true, error: toolCallError('invalid_tool_name', 'Every tool call envelope requires a nonempty function name.'), calls: [] };
    }
    seenIds.add(toolCall.id);
  }

  return {
    abort: false,
    error: null,
    calls: toolCalls.map(toolCall => validateLinkableToolCall(toolCall, schemaIndex))
  };
}

function assertSupportedModel(model) {
  contractAssert(SUPPORTED_MODELS.includes(model), 'unsupported_model', `Unsupported model: ${String(model)}.`);
  return model;
}

function assertSupportedReasoningEffort(reasoningEffort) {
  contractAssert(
    SUPPORTED_REASONING_EFFORTS.includes(reasoningEffort),
    'unsupported_reasoning_effort',
    `Unsupported reasoning effort: ${String(reasoningEffort)}.`
  );
  return reasoningEffort;
}

function buildV4RequestBody({
  model,
  reasoningEffort,
  messages,
  tools,
  expectedToolCount = EXPECTED_PRODUCTION_TOOL_COUNT
}) {
  assertSupportedModel(model);
  assertSupportedReasoningEffort(reasoningEffort);
  contractAssert(Array.isArray(messages), 'invalid_request_messages', 'Request messages must be an array.');
  createObservedToolSchemaIndex(tools, { expectedToolCount });
  return {
    model,
    thinking: { ...THINKING_MODE },
    reasoning_effort: reasoningEffort,
    max_tokens: MAX_OUTPUT_TOKENS,
    messages: cloneJsonValue(messages),
    tools: cloneJsonValue(tools)
  };
}

function serializedBodyUtf8Bytes(body) {
  contractAssert(isPlainObject(body), 'invalid_request_body', 'Request body must be a plain object.');
  return Buffer.byteLength(JSON.stringify(body), 'utf8');
}

function displayTokenEstimate(value) {
  return Math.ceil(JSON.stringify(value).length / 4);
}

function estimateConversationHistoryTokens(exchanges) {
  if (!Array.isArray(exchanges) || exchanges.length === 0) return 0;
  return displayTokenEstimate(exchanges.map(exchange => exchange.provider_messages));
}

function buildV4Request(options) {
  const body = buildV4RequestBody(options);
  return {
    url: DEEPSEEK_CHAT_COMPLETIONS_URL,
    body,
    body_utf8_bytes: serializedBodyUtf8Bytes(body)
  };
}

function captureAssistantMessage(message) {
  contractAssert(isPlainObject(message), 'invalid_assistant_message', 'Assistant message must be a plain object.');
  contractAssert(message.role === 'assistant', 'invalid_assistant_role', 'Captured provider message must have assistant role.');
  const raw = cloneJsonValue(message);
  const replay = cloneJsonValue(message);
  if (Array.isArray(replay.tool_calls) && replay.tool_calls.length > 0 && replay.content == null) {
    replay.content = '';
  }
  return { raw, replay };
}

function toProviderReplayMessage(message) {
  if (message?.role !== 'assistant') return cloneJsonValue(message);
  return captureAssistantMessage(message).replay;
}

function providerReplayMessagesForExchange(exchange) {
  contractAssert(isPlainObject(exchange), 'invalid_exchange', 'Exchange must be a plain object.');
  contractAssert(exchange.status === 'completed', 'incomplete_exchange', 'Only completed exchanges may enter replay.');
  contractAssert(Array.isArray(exchange.provider_messages), 'invalid_provider_messages', 'Exchange provider_messages must be an array.');
  return exchange.provider_messages.map(toProviderReplayMessage);
}

function flattenProviderReplay(exchanges) {
  contractAssert(Array.isArray(exchanges), 'invalid_exchange_ledger', 'Exchange ledger must be an array.');
  return exchanges.flatMap(providerReplayMessagesForExchange);
}

function selectNewestReplaySuffix({
  exchanges,
  buildCandidateBody,
  maxUtf8Bytes = MAX_REQUEST_UTF8_BYTES
}) {
  contractAssert(Array.isArray(exchanges), 'invalid_exchange_ledger', 'Exchange ledger must be an array.');
  contractAssert(typeof buildCandidateBody === 'function', 'invalid_body_builder', 'buildCandidateBody must be a function.');
  contractAssert(Number.isInteger(maxUtf8Bytes) && maxUtf8Bytes > 0, 'invalid_context_limit', 'maxUtf8Bytes must be a positive integer.');
  for (const exchange of exchanges) {
    contractAssert(exchange?.status === 'completed', 'incomplete_exchange', 'Replay selection accepts completed exchanges only.');
  }

  let selected = [];
  let body = buildCandidateBody([]);
  let bodyBytes = serializedBodyUtf8Bytes(body);
  if (bodyBytes > maxUtf8Bytes) {
    return {
      fits: false,
      failure: 'context_too_large_preflight',
      selected_exchanges: [],
      excluded_exchanges: cloneJsonValue(exchanges),
      body: cloneJsonValue(body),
      body_utf8_bytes: bodyBytes,
      max_utf8_bytes: maxUtf8Bytes
    };
  }

  for (let index = exchanges.length - 1; index >= 0; index--) {
    const candidate = [exchanges[index], ...selected];
    const candidateBody = buildCandidateBody(cloneJsonValue(candidate));
    const candidateBytes = serializedBodyUtf8Bytes(candidateBody);
    if (candidateBytes > maxUtf8Bytes) break;
    selected = candidate;
    body = candidateBody;
    bodyBytes = candidateBytes;
  }

  const excludedCount = exchanges.length - selected.length;
  return {
    fits: true,
    failure: null,
    selected_exchanges: cloneJsonValue(selected),
    excluded_exchanges: cloneJsonValue(exchanges.slice(0, excludedCount)),
    body: cloneJsonValue(body),
    body_utf8_bytes: bodyBytes,
    max_utf8_bytes: maxUtf8Bytes
  };
}

function clockIso(clock) {
  contractAssert(typeof clock === 'function', 'invalid_clock', 'clock must be a function.');
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  contractAssert(!Number.isNaN(date.getTime()), 'invalid_clock_value', 'clock must return a valid date value.');
  return date.toISOString();
}

function migrateLegacyHistory(legacyMessages, { clock, createExchangeId } = {}) {
  contractAssert(Array.isArray(legacyMessages), 'invalid_legacy_history', 'Legacy history must be an array.');
  contractAssert(typeof createExchangeId === 'function', 'missing_exchange_id_factory', 'createExchangeId must be injected.');

  const savedAt = clockIso(clock);
  const exchanges = [];
  const ids = new Set();
  const completeLength = legacyMessages.length - (legacyMessages.length % 2);

  for (let index = 0; index < completeLength; index += 2) {
    const user = legacyMessages[index];
    const assistant = legacyMessages[index + 1];
    contractAssert(
      isPlainObject(user) && user.role === 'user' && typeof user.content === 'string',
      'invalid_legacy_pair',
      `Legacy entry ${index} is not a user message.`
    );
    contractAssert(
      isPlainObject(assistant) && assistant.role === 'assistant' && typeof assistant.content === 'string',
      'invalid_legacy_pair',
      `Legacy entry ${index + 1} is not an assistant message.`
    );

    const id = createExchangeId({
      pair_index: index / 2,
      question: user.content,
      answer: assistant.content
    });
    contractAssert(typeof id === 'string' && id.trim(), 'invalid_exchange_id', 'Migrated exchange ID must be a nonempty string.');
    contractAssert(!ids.has(id), 'duplicate_exchange_id', `Migrated exchange ID is not unique: ${id}.`);
    ids.add(id);

    exchanges.push({
      id,
      question: user.content,
      completed_at: null,
      request_snapshot: { model: null, reasoning_effort: null },
      actual_models: [],
      provider_messages: [
        { role: 'user', content: user.content },
        { role: 'assistant', content: assistant.content }
      ],
      round_summaries: [],
      final_answer: assistant.content,
      status: 'completed'
    });
  }

  return {
    schema_version: HISTORY_SCHEMA_VERSION,
    saved_at: savedAt,
    exchanges
  };
}

function isExactIsoTimestamp(value) {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function hasExactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function validateCompletedExchange(exchange, { clone = true } = {}) {
  contractAssert(
    hasExactKeys(exchange, [
      'id',
      'question',
      'completed_at',
      'request_snapshot',
      'actual_models',
      'provider_messages',
      'round_summaries',
      'final_answer',
      'status'
    ]),
    'invalid_history_exchange_shape',
    'History exchanges must contain exactly the v2 exchange fields.'
  );
  contractAssert(typeof exchange.id === 'string' && exchange.id.trim(), 'invalid_history_exchange_id', 'Exchange ID must be nonempty.');
  contractAssert(typeof exchange.question === 'string', 'invalid_history_question', 'Exchange question must be a string.');
  contractAssert(
    exchange.completed_at === null || isExactIsoTimestamp(exchange.completed_at),
    'invalid_history_completed_at',
    'Exchange completed_at must be an exact ISO timestamp or null for migrated v1 data.'
  );
  contractAssert(
    hasExactKeys(exchange.request_snapshot, ['model', 'reasoning_effort']),
    'invalid_history_request_snapshot',
    'Exchange request_snapshot must contain exactly model and reasoning_effort.'
  );
  contractAssert(
    exchange.request_snapshot.model === null || SUPPORTED_MODELS.includes(exchange.request_snapshot.model),
    'invalid_history_model',
    'Exchange request model must be supported or null for migrated v1 data.'
  );
  contractAssert(
    exchange.request_snapshot.reasoning_effort === null
      || SUPPORTED_REASONING_EFFORTS.includes(exchange.request_snapshot.reasoning_effort),
    'invalid_history_reasoning_effort',
    'Exchange reasoning effort must be supported or null for migrated v1 data.'
  );
  contractAssert(Array.isArray(exchange.actual_models), 'invalid_history_actual_models', 'Exchange actual_models must be an array.');
  contractAssert(
    exchange.actual_models.every(model => typeof model === 'string' && model.trim()),
    'invalid_history_actual_model',
    'Every actual model must be a nonempty string.'
  );
  contractAssert(
    Array.isArray(exchange.provider_messages) && exchange.provider_messages.length >= 2,
    'invalid_history_provider_messages',
    'Exchange provider_messages must contain at least user and assistant messages.'
  );
  contractAssert(exchange.provider_messages[0]?.role === 'user', 'invalid_history_first_message', 'Exchange replay must begin with user.');
  for (const message of exchange.provider_messages) {
    contractAssert(isPlainObject(message), 'invalid_history_provider_message', 'Every provider message must be a plain object.');
    contractAssert(['user', 'assistant', 'tool'].includes(message.role), 'invalid_history_provider_role', 'Provider role is invalid.');
    if (message.role === 'user') {
      contractAssert(typeof message.content === 'string', 'invalid_history_user_content', 'Stored user content must be a string.');
    }
    if (message.role === 'tool') {
      contractAssert(typeof message.tool_call_id === 'string' && message.tool_call_id, 'invalid_history_tool_link', 'Stored tool results require a call ID.');
      contractAssert(typeof message.content === 'string', 'invalid_history_tool_content', 'Stored tool result content must be a string.');
    }
  }
  const finalMessage = exchange.provider_messages[exchange.provider_messages.length - 1];
  contractAssert(
    finalMessage.role === 'assistant' && typeof finalMessage.content === 'string',
    'invalid_history_final_message',
    'Completed exchanges must end with a final assistant string.'
  );
  contractAssert(Array.isArray(exchange.round_summaries), 'invalid_history_round_summaries', 'Exchange round_summaries must be an array.');
  contractAssert(exchange.round_summaries.every(isPlainObject), 'invalid_history_round_summary', 'Every round summary must be a plain object.');
  contractAssert(typeof exchange.final_answer === 'string', 'invalid_history_final_answer', 'Exchange final_answer must be a string.');
  contractAssert(finalMessage.content === exchange.final_answer, 'history_final_answer_mismatch', 'Final answer must match the final replay message.');
  contractAssert(exchange.status === 'completed', 'incomplete_history_exchange', 'Only completed exchanges may be persisted.');
  return clone ? cloneJsonValue(exchange) : exchange;
}

function validateHistoryDocument(document, { maxExchanges = DURABLE_HISTORY_EXCHANGE_LIMIT } = {}) {
  contractAssert(
    hasExactKeys(document, ['schema_version', 'saved_at', 'exchanges']),
    'invalid_history_root_shape',
    'History root must contain exactly schema_version, saved_at, and exchanges.'
  );
  contractAssert(document.schema_version === HISTORY_SCHEMA_VERSION, 'invalid_history_schema', 'History schema version must be 2.');
  contractAssert(isExactIsoTimestamp(document.saved_at), 'invalid_history_saved_at', 'History saved_at must be an exact ISO timestamp.');
  contractAssert(Array.isArray(document.exchanges), 'invalid_history_exchanges', 'History exchanges must be an array.');
  contractAssert(
    Number.isInteger(maxExchanges) && maxExchanges > 0,
    'invalid_history_exchange_limit',
    'History exchange limit must be a positive integer.'
  );
  contractAssert(
    document.exchanges.length <= maxExchanges,
    'history_exchange_limit_exceeded',
    'Durable history contains more exchanges than the configured restart limit.'
  );
  const ids = new Set();
  const exchanges = document.exchanges.map(exchange => {
    const validated = validateCompletedExchange(exchange);
    contractAssert(!ids.has(validated.id), 'duplicate_history_exchange_id', `Duplicate history exchange ID: ${validated.id}.`);
    ids.add(validated.id);
    return validated;
  });
  return {
    schema_version: HISTORY_SCHEMA_VERSION,
    saved_at: document.saved_at,
    exchanges
  };
}

function validateSettingsDocument(document) {
  contractAssert(
    hasExactKeys(document, ['schema_version', 'model', 'reasoning_effort', 'saved_at']),
    'invalid_settings_shape',
    'Settings must contain exactly schema_version, model, reasoning_effort, and saved_at.'
  );
  contractAssert(document.schema_version === SETTINGS_SCHEMA_VERSION, 'invalid_settings_schema', 'Settings schema version must be 1.');
  contractAssert(SUPPORTED_MODELS.includes(document.model), 'invalid_settings_model', 'Settings model is unsupported.');
  contractAssert(
    SUPPORTED_REASONING_EFFORTS.includes(document.reasoning_effort),
    'invalid_settings_reasoning_effort',
    'Settings reasoning effort is unsupported.'
  );
  contractAssert(isExactIsoTimestamp(document.saved_at), 'invalid_settings_saved_at', 'Settings saved_at must be an exact ISO timestamp.');
  return cloneJsonValue(document);
}

function buildDurableHistorySnapshot({
  exchanges,
  clock,
  maxFileBytes = MAX_HISTORY_FILE_BYTES,
  maxExchanges = DURABLE_HISTORY_EXCHANGE_LIMIT,
  copySelections = true
}) {
  contractAssert(Array.isArray(exchanges), 'invalid_exchange_ledger', 'Current-process ledger must be an array.');
  contractAssert(Number.isInteger(maxFileBytes) && maxFileBytes > 0, 'invalid_history_byte_limit', 'History byte limit must be positive.');
  contractAssert(Number.isInteger(maxExchanges) && maxExchanges > 0, 'invalid_history_exchange_limit', 'History count limit must be positive.');
  const source = exchanges;
  for (const exchange of source) validateCompletedExchange(exchange, { clone: false });
  const savedAt = clockIso(clock);
  const rootPrefix = `{"schema_version":${HISTORY_SCHEMA_VERSION},"saved_at":${JSON.stringify(savedAt)},"exchanges":[`;
  const rootSuffix = ']}';
  let selected = [];
  let selectedSerialized = [];
  let document = { schema_version: HISTORY_SCHEMA_VERSION, saved_at: savedAt, exchanges: [] };
  let serialized = `${rootPrefix}${rootSuffix}`;
  let bodyBytes = Buffer.byteLength(serialized, 'utf8');
  if (bodyBytes > maxFileBytes) {
    return {
      fits: false,
      failure: 'history_root_oversize',
      selected_exchanges: [],
      excluded_exchanges: copySelections ? cloneJsonValue(source) : source,
      document,
      serialized,
      body_utf8_bytes: bodyBytes,
      max_file_bytes: maxFileBytes,
      count_evicted: Math.max(0, source.length - maxExchanges),
      size_evicted: Math.min(source.length, maxExchanges),
      newest_candidate_utf8_bytes: null
    };
  }

  let newestCandidateBytes = null;
  while (selected.length < maxExchanges && selected.length < source.length) {
    const index = source.length - selected.length - 1;
    const exchangeSerialized = JSON.stringify(source[index]);
    const candidateBytes = bodyBytes
      + Buffer.byteLength(exchangeSerialized, 'utf8')
      + (selected.length > 0 ? 1 : 0);
    if (selected.length === 0) newestCandidateBytes = candidateBytes;
    if (candidateBytes > maxFileBytes) break;
    selected = [source[index], ...selected];
    selectedSerialized = [exchangeSerialized, ...selectedSerialized];
    bodyBytes = candidateBytes;
  }

  serialized = `${rootPrefix}${selectedSerialized.join(',')}${rootSuffix}`;
  const selectedForResult = copySelections ? cloneJsonValue(selected) : selected;
  document = {
    schema_version: HISTORY_SCHEMA_VERSION,
    saved_at: savedAt,
    exchanges: selectedForResult
  };

  const excludedCount = source.length - selected.length;
  const countEvicted = Math.max(0, source.length - maxExchanges);
  const sizeEvicted = Math.max(0, excludedCount - countEvicted);
  if (source.length > 0 && selected.length === 0) {
    return {
      fits: false,
      failure: 'newest_exchange_oversize',
      selected_exchanges: [],
      excluded_exchanges: copySelections ? cloneJsonValue(source) : source,
      document,
      serialized,
      body_utf8_bytes: bodyBytes,
      max_file_bytes: maxFileBytes,
      count_evicted: countEvicted,
      size_evicted: sizeEvicted,
      newest_candidate_utf8_bytes: newestCandidateBytes
    };
  }

  return {
    fits: true,
    failure: null,
    selected_exchanges: selectedForResult,
    excluded_exchanges: copySelections ? cloneJsonValue(source.slice(0, excludedCount)) : source.slice(0, excludedCount),
    document,
    serialized,
    body_utf8_bytes: bodyBytes,
    max_file_bytes: maxFileBytes,
    count_evicted: countEvicted,
    size_evicted: sizeEvicted,
    newest_candidate_utf8_bytes: newestCandidateBytes
  };
}

function isMissingFileError(error) {
  return error?.code === 'ENOENT';
}

function filesystemErrorCode(error) {
  return typeof error?.code === 'string' ? error.code : 'filesystem_error';
}

function requireFilesystemMethods(fsAdapter, methods) {
  contractAssert(fsAdapter && typeof fsAdapter === 'object', 'invalid_fs_adapter', 'Filesystem adapter must be an object.');
  for (const method of methods) {
    contractAssert(typeof fsAdapter[method] === 'function', 'missing_fs_method', `Filesystem adapter is missing ${method}.`, { method });
  }
}

function filesystemSafeTimestamp(clock) {
  return clockIso(clock).replace(/[-:.]/g, '');
}

function historyBackupPath(historyPath) {
  return path.join(path.dirname(historyPath), HISTORY_V1_BACKUP_BASENAME);
}

function historyQuarantinePath(historyPath, reason, clock) {
  return path.join(path.dirname(historyPath), `mb-history.${reason}.${filesystemSafeTimestamp(clock)}.json`);
}

async function atomicWriteText({ fsAdapter, filePath, text, clock }) {
  requireFilesystemMethods(fsAdapter, ['mkdir', 'writeFile', 'rename', 'unlink']);
  contractAssert(typeof filePath === 'string' && filePath, 'invalid_persistence_path', 'Persistence path must be nonempty.');
  contractAssert(typeof text === 'string', 'invalid_persistence_text', 'Atomic write content must be a string.');
  await fsAdapter.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp.${filesystemSafeTimestamp(clock)}.${atomicWriteSequence++}`;
  try {
    await fsAdapter.writeFile(tempPath, text, { encoding: 'utf8', flag: 'wx' });
    await fsAdapter.rename(tempPath, filePath);
    return { temp_path: tempPath, bytes: Buffer.byteLength(text, 'utf8') };
  } catch (error) {
    try {
      await fsAdapter.unlink(tempPath);
    } catch (cleanupError) {
      if (!isMissingFileError(cleanupError)) error.cleanup_code = filesystemErrorCode(cleanupError);
    }
    throw error;
  }
}

async function saveHistoryStore({
  fsAdapter,
  historyPath,
  exchanges,
  clock,
  maxFileBytes = MAX_HISTORY_FILE_BYTES,
  maxExchanges = DURABLE_HISTORY_EXCHANGE_LIMIT
}) {
  const selection = buildDurableHistorySnapshot({
    exchanges,
    clock,
    maxFileBytes,
    maxExchanges,
    copySelections: false
  });
  if (!selection.fits) {
    return {
      ok: false,
      status: 'memory_only_oversize',
      warning: {
        code: 'history_memory_only_oversize',
        newest_candidate_utf8_bytes: selection.newest_candidate_utf8_bytes,
        max_file_bytes: maxFileBytes,
        live_exchange_count: exchanges.length
      },
      selected_exchange_ids: [],
      excluded_exchange_ids: exchanges.map(exchange => exchange.id),
      body_utf8_bytes: selection.newest_candidate_utf8_bytes,
      max_file_bytes: maxFileBytes,
      count_evicted: selection.count_evicted,
      size_evicted: selection.size_evicted
    };
  }

  try {
    await atomicWriteText({ fsAdapter, filePath: historyPath, text: selection.serialized, clock });
  } catch (error) {
    return {
      ok: false,
      status: 'save_failed',
      warning: {
        code: 'history_save_failed',
        filesystem_code: filesystemErrorCode(error),
        cleanup_code: error.cleanup_code ?? null
      },
      selected_exchange_ids: selection.selected_exchanges.map(exchange => exchange.id),
      excluded_exchange_ids: selection.excluded_exchanges.map(exchange => exchange.id),
      body_utf8_bytes: selection.body_utf8_bytes,
      max_file_bytes: maxFileBytes,
      count_evicted: selection.count_evicted,
      size_evicted: selection.size_evicted
    };
  }

  const warning = selection.size_evicted > 0
    ? {
        code: 'history_size_eviction',
        evicted_exchange_count: selection.size_evicted,
        persisted_exchange_count: selection.selected_exchanges.length,
        body_utf8_bytes: selection.body_utf8_bytes,
        max_file_bytes: maxFileBytes
      }
    : null;
  return {
    ok: true,
    status: warning ? 'saved_with_size_eviction' : 'saved',
    warning,
    selected_exchange_ids: selection.selected_exchanges.map(exchange => exchange.id),
    excluded_exchange_ids: selection.excluded_exchanges.map(exchange => exchange.id),
    body_utf8_bytes: selection.body_utf8_bytes,
    max_file_bytes: maxFileBytes,
    count_evicted: selection.count_evicted,
    size_evicted: selection.size_evicted
  };
}

async function quarantineHistoryFile({ fsAdapter, historyPath, reason, clock }) {
  requireFilesystemMethods(fsAdapter, ['rename']);
  const quarantinePath = historyQuarantinePath(historyPath, reason, clock);
  try {
    await fsAdapter.rename(historyPath, quarantinePath);
    return { ok: true, quarantine_path: quarantinePath, filesystem_code: null };
  } catch (error) {
    return { ok: false, quarantine_path: null, filesystem_code: filesystemErrorCode(error) };
  }
}

async function loadHistoryStore({
  fsAdapter,
  historyPath,
  clock,
  maxFileBytes = MAX_HISTORY_FILE_BYTES,
  maxExchanges = DURABLE_HISTORY_EXCHANGE_LIMIT,
  createExchangeId = ({ pair_index: pairIndex }) => `legacy-${pairIndex + 1}`
}) {
  requireFilesystemMethods(fsAdapter, ['stat', 'readFile', 'rename']);
  contractAssert(typeof historyPath === 'string' && historyPath, 'invalid_history_path', 'History path must be nonempty.');
  let stat;
  try {
    stat = await fsAdapter.stat(historyPath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return {
        status: 'missing',
        ledger: [],
        last_exchange: null,
        durable_exchange_ids: [],
        durable_bytes: 0,
        warnings: [],
        write_blocked: false,
        migration: null,
        quarantine_path: null
      };
    }
    return {
      status: 'read_failed',
      ledger: [],
      last_exchange: null,
      durable_exchange_ids: [],
      durable_bytes: null,
      warnings: [{ code: 'history_read_failed', filesystem_code: filesystemErrorCode(error) }],
      write_blocked: true,
      migration: null,
      quarantine_path: null
    };
  }

  if (!Number.isInteger(stat.size) || stat.size > maxFileBytes) {
    const quarantine = await quarantineHistoryFile({ fsAdapter, historyPath, reason: 'oversize', clock });
    return {
      status: quarantine.ok ? 'oversize_quarantined' : 'oversize_quarantine_failed',
      ledger: [],
      last_exchange: null,
      durable_exchange_ids: [],
      durable_bytes: 0,
      warnings: [{
        code: quarantine.ok ? 'history_oversize_quarantined' : 'history_oversize_quarantine_failed',
        source_bytes: stat.size,
        max_file_bytes: maxFileBytes,
        quarantine_path: quarantine.quarantine_path,
        filesystem_code: quarantine.filesystem_code
      }],
      write_blocked: !quarantine.ok,
      migration: null,
      quarantine_path: quarantine.quarantine_path
    };
  }

  let raw;
  try {
    raw = await fsAdapter.readFile(historyPath, 'utf8');
  } catch (error) {
    return {
      status: 'read_failed',
      ledger: [],
      last_exchange: null,
      durable_exchange_ids: [],
      durable_bytes: stat.size,
      warnings: [{ code: 'history_read_failed', filesystem_code: filesystemErrorCode(error) }],
      write_blocked: true,
      migration: null,
      quarantine_path: null
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) parsed = validateHistoryDocument(parsed, { maxExchanges });
  } catch (error) {
    const quarantine = await quarantineHistoryFile({ fsAdapter, historyPath, reason: 'corrupt', clock });
    return {
      status: quarantine.ok ? 'corrupt_quarantined' : 'corrupt_quarantine_failed',
      ledger: [],
      last_exchange: null,
      durable_exchange_ids: [],
      durable_bytes: 0,
      warnings: [{
        code: quarantine.ok ? 'history_corrupt_quarantined' : 'history_corrupt_quarantine_failed',
        quarantine_path: quarantine.quarantine_path,
        validation_code: error.code ?? 'invalid_json',
        filesystem_code: quarantine.filesystem_code
      }],
      write_blocked: !quarantine.ok,
      migration: null,
      quarantine_path: quarantine.quarantine_path
    };
  }

  if (!Array.isArray(parsed)) {
    const ledger = parsed.exchanges;
    return {
      status: 'loaded_v2',
      ledger,
      last_exchange: ledger.length > 0 ? cloneJsonValue(ledger[ledger.length - 1]) : null,
      durable_exchange_ids: ledger.map(exchange => exchange.id),
      durable_bytes: stat.size,
      warnings: [],
      write_blocked: false,
      migration: null,
      quarantine_path: null
    };
  }

  let migrated;
  try {
    migrated = migrateLegacyHistory(parsed, { clock, createExchangeId });
  } catch (error) {
    const quarantine = await quarantineHistoryFile({ fsAdapter, historyPath, reason: 'corrupt', clock });
    return {
      status: quarantine.ok ? 'corrupt_quarantined' : 'corrupt_quarantine_failed',
      ledger: [],
      last_exchange: null,
      durable_exchange_ids: [],
      durable_bytes: 0,
      warnings: [{
        code: quarantine.ok ? 'history_corrupt_quarantined' : 'history_corrupt_quarantine_failed',
        quarantine_path: quarantine.quarantine_path,
        validation_code: error.code ?? 'invalid_legacy_history',
        filesystem_code: quarantine.filesystem_code
      }],
      write_blocked: !quarantine.ok,
      migration: null,
      quarantine_path: quarantine.quarantine_path
    };
  }

  const warnings = [];
  if (parsed.length % 2 !== 0) {
    warnings.push({
      code: 'history_v1_incomplete_tail_ignored',
      complete_pair_count: migrated.exchanges.length,
      source_message_count: parsed.length
    });
  }
  const backupPath = historyBackupPath(historyPath);
  requireFilesystemMethods(fsAdapter, ['copyFile']);
  try {
    await fsAdapter.copyFile(historyPath, backupPath, COPYFILE_EXCLUSIVE);
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      warnings.push({ code: 'history_v1_backup_failed', filesystem_code: filesystemErrorCode(error) });
      const ledger = cloneJsonValue(migrated.exchanges);
      return {
        status: 'migration_backup_failed',
        ledger,
        last_exchange: ledger.length > 0 ? cloneJsonValue(ledger[ledger.length - 1]) : null,
        durable_exchange_ids: [],
        durable_bytes: stat.size,
        warnings,
        write_blocked: true,
        migration: { source_schema: 1, target_schema: 2, backup_path: null },
        quarantine_path: null
      };
    }
  }

  const save = await saveHistoryStore({
    fsAdapter,
    historyPath,
    exchanges: migrated.exchanges,
    clock,
    maxFileBytes,
    maxExchanges
  });
  if (save.warning) warnings.push(save.warning);
  const ledger = cloneJsonValue(migrated.exchanges);
  return {
    status: save.ok ? 'migrated_v1_to_v2' : `migration_${save.status}`,
    ledger,
    last_exchange: ledger.length > 0 ? cloneJsonValue(ledger[ledger.length - 1]) : null,
    durable_exchange_ids: save.ok ? cloneJsonValue(save.selected_exchange_ids) : [],
    durable_bytes: save.ok ? save.body_utf8_bytes : stat.size,
    warnings,
    write_blocked: false,
    migration: { source_schema: 1, target_schema: 2, backup_path: backupPath },
    quarantine_path: null
  };
}

async function loadSettingsStore({ fsAdapter, settingsPath }) {
  requireFilesystemMethods(fsAdapter, ['readFile']);
  contractAssert(typeof settingsPath === 'string' && settingsPath, 'invalid_settings_path', 'Settings path must be nonempty.');
  let raw;
  try {
    raw = await fsAdapter.readFile(settingsPath, 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) {
      return { status: 'missing_defaulted', settings: { ...DEFAULT_SETTINGS }, warnings: [] };
    }
    return {
      status: 'read_failed_defaulted',
      settings: { ...DEFAULT_SETTINGS },
      warnings: [{ code: 'settings_read_failed_defaulted', filesystem_code: filesystemErrorCode(error) }]
    };
  }
  try {
    const settings = validateSettingsDocument(JSON.parse(raw));
    return { status: 'loaded', settings, warnings: [] };
  } catch (error) {
    return {
      status: 'invalid_defaulted',
      settings: { ...DEFAULT_SETTINGS },
      warnings: [{ code: 'settings_invalid_defaulted', validation_code: error.code ?? 'invalid_json' }]
    };
  }
}

async function saveSettingsStore({ fsAdapter, settingsPath, model, reasoningEffort, clock }) {
  contractAssert(SUPPORTED_MODELS.includes(model), 'unsupported_model', `Unsupported model: ${model}.`);
  contractAssert(SUPPORTED_REASONING_EFFORTS.includes(reasoningEffort), 'unsupported_reasoning_effort', `Unsupported reasoning effort: ${reasoningEffort}.`);
  const document = validateSettingsDocument({
    schema_version: SETTINGS_SCHEMA_VERSION,
    model,
    reasoning_effort: reasoningEffort,
    saved_at: clockIso(clock)
  });
  try {
    await atomicWriteText({ fsAdapter, filePath: settingsPath, text: JSON.stringify(document), clock });
    return { ok: true, status: 'saved', settings: document, warnings: [] };
  } catch (error) {
    return {
      ok: false,
      status: 'save_failed',
      settings: null,
      warnings: [{
        code: 'settings_save_failed',
        filesystem_code: filesystemErrorCode(error),
        cleanup_code: error.cleanup_code ?? null
      }]
    };
  }
}

function readOptionalUsageInteger(source, key) {
  if (!isPlainObject(source) || !Object.hasOwn(source, key)) return null;
  const value = source[key];
  if (value === null) return null;
  contractAssert(
    Number.isInteger(value) && value >= 0,
    'invalid_usage_value',
    `Usage field ${key} must be a nonnegative integer.`,
    { field: key, value }
  );
  return value;
}

function normalizeUsage(usage) {
  if (usage == null) {
    return {
      prompt_tokens: null,
      completion_tokens: null,
      total_tokens: null,
      prompt_cache_hit_tokens: null,
      prompt_cache_miss_tokens: null,
      reasoning_tokens: null,
      prompt_identity_valid: null,
      total_identity_valid: null
    };
  }
  contractAssert(isPlainObject(usage), 'invalid_usage', 'Usage must be a plain object when present.');

  const promptTokens = readOptionalUsageInteger(usage, 'prompt_tokens');
  const completionTokens = readOptionalUsageInteger(usage, 'completion_tokens');
  const totalTokens = readOptionalUsageInteger(usage, 'total_tokens');
  const cacheHitTokens = readOptionalUsageInteger(usage, 'prompt_cache_hit_tokens');
  const cacheMissTokens = readOptionalUsageInteger(usage, 'prompt_cache_miss_tokens');
  const completionDetails = usage.completion_tokens_details;
  if (completionDetails != null) {
    contractAssert(isPlainObject(completionDetails), 'invalid_completion_token_details', 'completion_tokens_details must be a plain object.');
  }
  const reasoningTokens = Object.hasOwn(usage, 'reasoning_tokens')
    ? readOptionalUsageInteger(usage, 'reasoning_tokens')
    : readOptionalUsageInteger(completionDetails, 'reasoning_tokens');

  const computedPromptIdentity = [promptTokens, cacheHitTokens, cacheMissTokens].every(value => value !== null)
    ? promptTokens === cacheHitTokens + cacheMissTokens
    : null;
  const computedTotalIdentity = [promptTokens, completionTokens, totalTokens].every(value => value !== null)
    ? totalTokens === promptTokens + completionTokens
    : null;
  const promptIdentityValid = usage.prompt_identity_valid === false ? false : computedPromptIdentity;
  const totalIdentityValid = usage.total_identity_valid === false ? false : computedTotalIdentity;

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    prompt_cache_hit_tokens: cacheHitTokens,
    prompt_cache_miss_tokens: cacheMissTokens,
    reasoning_tokens: reasoningTokens,
    prompt_identity_valid: promptIdentityValid,
    total_identity_valid: totalIdentityValid
  };
}

function calculateRoundCost(actualModel, usage, priceTable = PRICE_TABLE) {
  const normalized = normalizeUsage(usage);
  const prices = priceTable[actualModel];
  if (!prices) {
    return {
      actual_model: actualModel,
      available: false,
      cost_usd: null,
      warning: 'unknown_actual_model',
      usage: normalized
    };
  }

  const required = [
    normalized.prompt_cache_hit_tokens,
    normalized.prompt_cache_miss_tokens,
    normalized.completion_tokens
  ];
  if (required.some(value => value === null)) {
    return {
      actual_model: actualModel,
      available: false,
      cost_usd: null,
      warning: 'usage_unavailable',
      usage: normalized
    };
  }

  const cost = (
    normalized.prompt_cache_hit_tokens * prices.cache_hit_per_million_usd
    + normalized.prompt_cache_miss_tokens * prices.cache_miss_per_million_usd
    + normalized.completion_tokens * prices.output_per_million_usd
  ) / 1000000;

  return {
    actual_model: actualModel,
    available: true,
    cost_usd: cost,
    warning: null,
    usage: normalized
  };
}

const USAGE_TOTAL_FIELDS = deepFreeze([
  'prompt_tokens',
  'completion_tokens',
  'total_tokens',
  'prompt_cache_hit_tokens',
  'prompt_cache_miss_tokens',
  'reasoning_tokens'
]);

function aggregateUsage(usages) {
  contractAssert(Array.isArray(usages), 'invalid_usage_list', 'Usage list must be an array.');
  if (usages.length === 0) return normalizeUsage(null);
  const normalized = usages.map(normalizeUsage);
  const totals = {};
  for (const field of USAGE_TOTAL_FIELDS) {
    totals[field] = normalized.every(item => item[field] !== null)
      ? normalized.reduce((sum, item) => sum + item[field], 0)
      : null;
  }
  totals.prompt_identity_valid = normalized.some(item => item.prompt_identity_valid === false)
    ? false
    : (normalized.length > 0 && normalized.every(item => item.prompt_identity_valid === true) ? true : null);
  totals.total_identity_valid = normalized.some(item => item.total_identity_valid === false)
    ? false
    : (normalized.length > 0 && normalized.every(item => item.total_identity_valid === true) ? true : null);
  return totals;
}

function aggregateRoundTelemetry(rounds, priceTable = PRICE_TABLE) {
  contractAssert(Array.isArray(rounds), 'invalid_rounds', 'Rounds must be an array.');
  const perRound = rounds.map((round, index) => {
    contractAssert(isPlainObject(round), 'invalid_round', `Round ${index + 1} must be a plain object.`);
    const actualModel = round.actual_model ?? round.actualModel ?? round.model ?? null;
    return {
      round: round.round ?? index + 1,
      ...calculateRoundCost(actualModel, round.usage, priceTable)
    };
  });
  const aggregateCostAvailable = perRound.length > 0 && perRound.every(round => round.available);
  return {
    actual_models: perRound.map(round => round.actual_model),
    usage: aggregateUsage(rounds.map(round => round.usage)),
    cost_available: aggregateCostAvailable,
    cost_usd: aggregateCostAvailable ? perRound.reduce((sum, round) => sum + round.cost_usd, 0) : null,
    warnings: perRound.filter(round => round.warning).map(round => ({ round: round.round, warning: round.warning })),
    per_round: perRound
  };
}

const RETRYABLE_HTTP_STATUSES = deepFreeze([429, 500, 503]);
const TERMINAL_CLIENT_HTTP_STATUSES = deepFreeze([400, 401, 402, 422]);
const TRANSIENT_TRANSPORT_CODES = deepFreeze([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ERR_NETWORK',
  'ERR_SOCKET_CLOSED',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET'
]);
const DEFAULT_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30000;

function clockMilliseconds(clock) {
  contractAssert(typeof clock === 'function', 'invalid_clock', 'clock must be a function.');
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  contractAssert(!Number.isNaN(date.getTime()), 'invalid_clock_value', 'clock must return a valid date value.');
  return date.getTime();
}

function buildServerClockSnapshot(clock) {
  contractAssert(typeof clock === 'function', 'invalid_clock', 'clock must be a function.');
  const value = clock();
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  contractAssert(!Number.isNaN(date.getTime()), 'invalid_clock_value', 'clock must return a valid date value.');
  const hour = date.getHours();
  const hour12 = hour % 12 || 12;
  const minute = String(date.getMinutes()).padStart(2, '0');
  const meridiem = hour < 12 ? 'AM' : 'PM';
  const daypart = hour < 6 ? 'night' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : hour < 21 ? 'evening' : 'night';
  return {
    iso: date.toISOString(),
    date: `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}/${date.getFullYear()}`,
    time: `${hour12}:${minute} ${meridiem}`,
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()],
    daypart,
    timezone: 'server-local'
  };
}

function classifyProviderFinish(finishReason, assistantMessage) {
  contractAssert(isPlainObject(assistantMessage), 'invalid_assistant_message', 'Assistant message must be a plain object.');
  const content = assistantMessage.content;
  const partialContent = typeof content === 'string' && content.length > 0 ? content : null;

  if (finishReason === 'tool_calls') {
    if (Array.isArray(assistantMessage.tool_calls) && assistantMessage.tool_calls.length > 0) {
      return { state: 'tool_round', code: null, partial_content: partialContent };
    }
    return { state: 'incomplete', code: 'missing_tool_calls', partial_content: partialContent };
  }
  if (finishReason === 'stop') {
    if (partialContent !== null) return { state: 'completed', code: null, partial_content: null };
    return { state: 'incomplete', code: 'missing_final_content', partial_content: null };
  }
  if (finishReason === 'length') {
    return { state: 'incomplete', code: 'output_length_reached', partial_content: partialContent };
  }
  if (finishReason === 'content_filter') {
    return { state: 'incomplete', code: 'content_filtered', partial_content: partialContent };
  }
  if (finishReason === 'insufficient_system_resource') {
    return { state: 'failed', code: 'insufficient_system_resource', partial_content: partialContent };
  }
  return { state: 'failed', code: 'unknown_finish_reason', partial_content: partialContent };
}

function parseProviderRoundResponse(response) {
  const envelope = response && typeof response === 'object' && !Array.isArray(response)
    && Object.hasOwn(response, 'data')
    ? response.data
    : response;
  contractAssert(isPlainObject(envelope), 'invalid_provider_response', 'Provider response must be a plain object.');
  contractAssert(
    Array.isArray(envelope.choices) && envelope.choices.length === 1,
    'invalid_provider_choices',
    'Provider response must contain exactly one choice.'
  );
  const choice = envelope.choices[0];
  contractAssert(isPlainObject(choice), 'invalid_provider_choice', 'Provider choice must be a plain object.');
  contractAssert(
    isPlainObject(choice.message) && choice.message.role === 'assistant',
    'invalid_provider_assistant',
    'Provider choice must contain one assistant message.'
  );
  contractAssert(
    typeof envelope.model === 'string' && envelope.model.trim(),
    'missing_actual_model',
    'Provider response model must be a nonempty string.'
  );

  const captured = captureAssistantMessage(choice.message);
  const finish = classifyProviderFinish(choice.finish_reason, captured.raw);
  return {
    envelope: cloneJsonValue(envelope),
    actual_model: envelope.model,
    finish_reason: choice.finish_reason ?? null,
    finish,
    raw_assistant: captured.raw,
    replay_assistant: captured.replay,
    usage: normalizeUsage(envelope.usage ?? null)
  };
}

function httpStatusFromError(error) {
  const value = error?.response?.status ?? error?.status ?? null;
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isInteger(numeric) ? numeric : null;
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') {
    const value = headers.get(name);
    if (value !== undefined && value !== null) return value;
  }
  if (typeof headers !== 'object') return null;
  const match = Object.keys(headers).find(key => key.toLowerCase() === name.toLowerCase());
  return match ? headers[match] : null;
}

function retryDelayMilliseconds(error, clock) {
  const headers = error?.response?.headers ?? error?.headers ?? null;
  const raw = headerValue(headers, 'retry-after');
  if (raw === null || raw === undefined) return DEFAULT_RETRY_DELAY_MS;
  const text = String(Array.isArray(raw) ? raw[0] : raw).trim();
  if (/^\d+$/.test(text)) {
    return Math.min(Number(text) * 1000, MAX_RETRY_DELAY_MS);
  }
  const retryAt = Date.parse(text);
  if (Number.isNaN(retryAt)) return DEFAULT_RETRY_DELAY_MS;
  return Math.min(Math.max(0, retryAt - clockMilliseconds(clock)), MAX_RETRY_DELAY_MS);
}

function classifyProviderRequestError(error, { explicitContextRejection = false } = {}) {
  const status = httpStatusFromError(error);
  const transportCode = typeof error?.code === 'string' ? error.code : null;
  if (explicitContextRejection && (status === 400 || status === 422)) {
    return {
      code: 'provider_context_rejected',
      category: 'context_length',
      status,
      transport_code: transportCode,
      retryable: true,
      context_rejection: true
    };
  }
  if (RETRYABLE_HTTP_STATUSES.includes(status)) {
    return {
      code: `provider_http_${status}`,
      category: status === 429 ? 'rate_limit' : 'server',
      status,
      transport_code: transportCode,
      retryable: true,
      context_rejection: false
    };
  }
  if (status === null && TRANSIENT_TRANSPORT_CODES.includes(transportCode)) {
    return {
      code: 'provider_transport_failure',
      category: 'transport',
      status,
      transport_code: transportCode,
      retryable: true,
      context_rejection: false
    };
  }
  return {
    code: status === null ? 'provider_request_failed' : `provider_http_${status}`,
    category: TERMINAL_CLIENT_HTTP_STATUSES.includes(status) ? 'client' : 'request',
    status,
    transport_code: transportCode,
    retryable: false,
    context_rejection: false
  };
}

const OBSERVED_DEEPSEEK_CONTEXT_LENGTH_MESSAGE =
  /^This model's maximum context length is ([1-9]\d*) tokens\. However, you requested ([1-9]\d*) tokens \(([1-9]\d*) in the messages, ([1-9]\d*) in the completion\)\. Please reduce the length of the messages or completion\.$/;

function isObservedDeepSeekContextLengthError(error) {
  if (httpStatusFromError(error) !== 400) return false;
  const body = error?.response?.data;
  const providerError = body?.error;
  if (!isPlainObject(body) || !isPlainObject(providerError)) return false;
  if (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'error')) return false;
  if (Object.keys(providerError).sort().join(',') !== 'code,message,param,type') return false;
  if (
    providerError.code !== 'invalid_request_error' ||
    providerError.type !== 'invalid_request_error' ||
    providerError.param !== null ||
    typeof providerError.message !== 'string'
  ) {
    return false;
  }
  const match = OBSERVED_DEEPSEEK_CONTEXT_LENGTH_MESSAGE.exec(providerError.message);
  if (!match) return false;
  const [maximum, requested, messages, completion] = match.slice(1).map(Number);
  if (![maximum, requested, messages, completion].every(Number.isSafeInteger)) return false;
  return requested > maximum && requested === messages + completion;
}

function isExplicitContextRejection(httpClient, error) {
  const status = httpStatusFromError(error);
  if (status !== 400 && status !== 422) return false;
  const classifier = httpClient?.isContextLengthError;
  if (typeof classifier !== 'function') return false;
  return classifier.call(httpClient, error) === true;
}

async function invokeHttpClient(httpClient, request) {
  const requestCopy = {
    method: 'POST',
    url: request.url,
    body: cloneJsonValue(request.body)
  };
  if (typeof httpClient === 'function') return httpClient(requestCopy);
  if (typeof httpClient.request === 'function') return httpClient.request(requestCopy);
  return httpClient.post(requestCopy.url, requestCopy.body);
}

function buildContextBudgetedV4Request({
  model,
  reasoningEffort,
  systemMessages,
  completedExchanges,
  currentTurnMessages,
  tools,
  maxUtf8Bytes = MAX_REQUEST_UTF8_BYTES
}) {
  contractAssert(Array.isArray(systemMessages), 'invalid_system_messages', 'systemMessages must be an array.');
  contractAssert(Array.isArray(completedExchanges), 'invalid_exchange_ledger', 'completedExchanges must be an array.');
  contractAssert(Array.isArray(currentTurnMessages), 'invalid_current_turn_messages', 'currentTurnMessages must be an array.');
  const selection = selectNewestReplaySuffix({
    exchanges: completedExchanges,
    maxUtf8Bytes,
    buildCandidateBody: selectedExchanges => buildV4RequestBody({
      model,
      reasoningEffort,
      messages: [
        ...cloneJsonValue(systemMessages),
        ...flattenProviderReplay(selectedExchanges),
        ...cloneJsonValue(currentTurnMessages)
      ],
      tools
    })
  });
  return {
    ...selection,
    url: DEEPSEEK_CHAT_COMPLETIONS_URL
  };
}

function cacheHitPercentage(usage) {
  const hit = usage?.prompt_cache_hit_tokens;
  const miss = usage?.prompt_cache_miss_tokens;
  if (hit === null || hit === undefined || miss === null || miss === undefined || hit + miss === 0) return null;
  return (hit / (hit + miss)) * 100;
}

function buildTurnTelemetry(state, outcome, clock) {
  const pricedRounds = state.round_summaries.map(summary => ({
    round: summary.round,
    actual_model: summary.actual_model,
    usage: summary.usage
  }));
  const aggregate = aggregateRoundTelemetry(pricedRounds);
  const warnings = [
    ...state.warnings,
    ...aggregate.warnings
  ];
  const lastReplay = state.last_replay ?? {
    included_exchange_count: 0,
    excluded_exchange_count: state.prior_exchanges.length,
    body_utf8_bytes: null,
    max_utf8_bytes: MAX_REQUEST_UTF8_BYTES
  };
  return {
    status: outcome.status,
    configured_model: state.settings.model,
    configured_reasoning_effort: state.settings.reasoning_effort,
    effort_attribution: 'configured',
    actual_models: aggregate.actual_models,
    usage: aggregate.usage,
    reasoning_tokens: aggregate.usage.reasoning_tokens,
    cache_hit_percentage: cacheHitPercentage(aggregate.usage),
    cost_available: aggregate.cost_available,
    cost_usd: aggregate.cost_usd,
    rounds: state.rounds_started,
    response_rounds: state.round_summaries.length,
    attempts: state.attempts,
    retry_count: state.retries,
    fallback: 'none',
    elapsed_ms: Math.max(0, clockMilliseconds(clock) - state.started_at_ms),
    replay: cloneJsonValue(lastReplay),
    per_round: cloneJsonValue(state.round_summaries),
    round_records: cloneJsonValue(state.view_rounds),
    warnings: cloneJsonValue(warnings),
    error: outcome.error ? cloneJsonValue(outcome.error) : null
  };
}

function mergeUsageTotals(current, next) {
  if (current === null) return cloneJsonValue(next);
  return aggregateUsage([current, next]);
}

function createEmptySessionTelemetry() {
  return {
    completed_calls: 0,
    api_rounds: 0,
    api_attempts: 0,
    usage: null,
    cost_available: true,
    cost_usd: 0,
    recent_calls: []
  };
}

const CONTROLLER_DEPENDENCY_KEYS = deepFreeze([
  'httpClient',
  'tools',
  'dispatchToolCall',
  'getLiveContext',
  'clock',
  'fsAdapter',
  'paths',
  'delay',
  'viewSink',
  'writeClipboard'
]);

const TEST_INJECTION_POINTS = deepFreeze({
  http: 'httpClient',
  context_rejection_classifier: 'httpClient.isContextLengthError',
  tool_catalogue: 'tools',
  canonical_tool_dispatch: 'dispatchToolCall',
  live_context: 'getLiveContext',
  time: 'clock',
  filesystem: 'fsAdapter',
  filesystem_paths: 'paths',
  retry_delay: 'delay',
  structured_view: 'viewSink',
  windows_clipboard: 'writeClipboard'
});

function assertControllerDependencies(dependencies) {
  contractAssert(isPlainObject(dependencies), 'invalid_dependencies', 'Controller dependencies must be a plain object.');
  contractAssert(
    !Object.hasOwn(dependencies, 'machineAuthorityChecker'),
    'duplicate_machine_authority',
    'A separate machine-authority checker is forbidden; use dispatchToolCall as the sole machine authority.'
  );
  for (const key of CONTROLLER_DEPENDENCY_KEYS) {
    contractAssert(Object.hasOwn(dependencies, key), 'missing_dependency', `Missing controller dependency: ${key}.`, { key });
  }

  const httpClient = dependencies.httpClient;
  contractAssert(
    typeof httpClient === 'function'
      || (httpClient && typeof httpClient === 'object'
        && (typeof httpClient.request === 'function' || typeof httpClient.post === 'function')),
    'invalid_http_client',
    'httpClient must be a request function or an object exposing request/post.'
  );
  contractAssert(typeof dependencies.dispatchToolCall === 'function', 'invalid_tool_dispatch', 'dispatchToolCall must be a function.');
  contractAssert(typeof dependencies.getLiveContext === 'function', 'invalid_live_context', 'getLiveContext must be a function.');
  contractAssert(typeof dependencies.clock === 'function', 'invalid_clock', 'clock must be a function.');
  contractAssert(dependencies.fsAdapter && typeof dependencies.fsAdapter === 'object', 'invalid_fs_adapter', 'fsAdapter must be an object.');
  contractAssert(isPlainObject(dependencies.paths), 'invalid_paths', 'paths must be a plain object.');
  contractAssert(typeof dependencies.delay === 'function', 'invalid_delay', 'delay must be a function.');
  contractAssert(
    typeof dependencies.writeClipboard === 'function',
    'invalid_clipboard_adapter',
    'writeClipboard must be a function.'
  );
  contractAssert(
    typeof dependencies.viewSink === 'function'
      || (dependencies.viewSink && typeof dependencies.viewSink.emit === 'function'),
    'invalid_view_sink',
    'viewSink must be a function or expose emit(event).'
  );
}

function resolvePersistencePaths(paths) {
  contractAssert(
    typeof paths?.historyFile === 'string' && paths.historyFile,
    'missing_history_path',
    'paths.historyFile must be a nonempty string before loading persistence.'
  );
  contractAssert(
    typeof paths?.settingsFile === 'string' && paths.settingsFile,
    'missing_settings_path',
    'paths.settingsFile must be a nonempty string before loading persistence.'
  );
  return { historyFile: paths.historyFile, settingsFile: paths.settingsFile };
}

class MotherBrainController {
  constructor(dependencies) {
    assertControllerDependencies(dependencies);
    this._toolSchemaIndex = createObservedToolSchemaIndex(dependencies.tools);
    this._dependencies = { ...dependencies };
    this._configuredSettings = { ...DEFAULT_SETTINGS };
    this._busy = false;
    this._activity = 'idle';
    this._completedExchanges = [];
    this._lastExchange = null;
    this._operationalState = {};
    this._lastActualModel = null;
    this._lastCallTelemetry = null;
    this._sessionTelemetry = createEmptySessionTelemetry();
    this._nextRuntimeExchangeSequence = 1;
    this._nextViewTurnSequence = 1;
    this._persistenceReady = false;
    this._historyWritesBlocked = false;
    this._persistenceState = {
      ready: false,
      history: {
        status: 'not_loaded',
        degraded: false,
        live_exchange_count: 0,
        durable_exchange_ids: [],
        durable_bytes: null,
        max_file_bytes: MAX_HISTORY_FILE_BYTES,
        write_blocked: false,
        migration: null,
        quarantine_path: null
      },
      settings: { status: 'not_loaded', degraded: false, saved_at: null },
      warnings: []
    };
  }

  getContractSnapshot() {
    return {
      contract_version: CONTROLLER_CONTRACT_VERSION,
      configured_settings: { ...this._configuredSettings },
      busy: this._busy,
      activity: this._activity,
      completed_exchange_count: this._completedExchanges.length,
      completed_exchange_ids: this._completedExchanges.map(exchange => exchange.id),
      last_exchange_id: this._lastExchange?.id ?? null,
      last_actual_model: this._lastActualModel,
      operational_state: cloneJsonValue(this._operationalState),
      persistence: cloneJsonValue(this._persistenceState),
      tool_count: this._toolSchemaIndex.size,
      fallback: 'none',
      telemetry: this.getTelemetrySnapshot()
    };
  }

  getTelemetrySnapshot() {
    const lastCall = cloneJsonValue(this._lastCallTelemetry);
    return {
      last_call: lastCall,
      session: cloneJsonValue(this._sessionTelemetry),
      configured_settings: {
        ...this._configuredSettings,
        effort_attribution: 'configured'
      },
      last_actual_model: this._lastActualModel,
      state: {
        activity: this._activity,
        busy: this._busy
      },
      operational_state: cloneJsonValue(this._operationalState),
      conversation: {
        exchange_count: this._completedExchanges.length,
        estimated_history_tokens: estimateConversationHistoryTokens(this._completedExchanges)
      },
      replay: cloneJsonValue(lastCall?.replay ?? null),
      persistence: cloneJsonValue(this._persistenceState),
      server_clock: buildServerClockSnapshot(this._dependencies.clock),
      pricing: {
        source_date: PRICE_TABLE_SOURCE_DATE
      },
      field_authority: cloneJsonValue(TELEMETRY_FIELD_AUTHORITY)
    };
  }

  getCompletedExchangeLedger() {
    return cloneJsonValue(this._completedExchanges);
  }

  getLastCompletedExchange() {
    return cloneJsonValue(this._lastExchange);
  }

  snapshotTurnSettings() {
    return deepFreeze({
      model: this._configuredSettings.model,
      reasoning_effort: this._configuredSettings.reasoning_effort,
      effort_attribution: 'configured'
    });
  }

  buildRoundRequest({ model, reasoningEffort, messages }) {
    return buildV4Request({
      model,
      reasoningEffort,
      messages,
      tools: this._dependencies.tools
    });
  }

  validateToolCalls(toolCalls) {
    return validateToolCallBatch(toolCalls, this._toolSchemaIndex);
  }

  emit(type, payload = {}) {
    contractAssert(typeof type === 'string' && type.trim(), 'invalid_view_event', 'View event type must be a nonempty string.');
    contractAssert(isPlainObject(payload), 'invalid_view_payload', 'View event payload must be a plain object.');
    const event = {
      type,
      at: clockIso(this._dependencies.clock),
      payload: cloneJsonValue(payload)
    };
    if (typeof this._dependencies.viewSink === 'function') this._dependencies.viewSink(event);
    else this._dependencies.viewSink.emit(event);
    return event;
  }

  updateOperationalState(patch) {
    contractAssert(isPlainObject(patch), 'invalid_operational_state', 'Operational state update must be a plain object.');
    this._operationalState = { ...this._operationalState, ...cloneJsonValue(patch) };
    const event = this.emit('operational_state', { state: this._operationalState });
    if (!this._busy) this.emit('telemetry', { snapshot: this.getTelemetrySnapshot() });
    return event;
  }

  async handleLocalCommand(input) {
    contractAssert(typeof input === 'string', 'invalid_command_input', 'Local command input must be a string.');
    const trimmed = input.trim();
    if (!trimmed.startsWith('/')) return { handled: false };

    const separator = trimmed.search(/\s/);
    const token = (separator === -1 ? trimmed : trimmed.slice(0, separator)).toLowerCase();
    const rawArgument = separator === -1 ? '' : trimmed.slice(separator + 1);
    const entry = COMMAND_REGISTRY.find(candidate => candidate.token === token);
    if (!entry) {
      return this._finishLocalCommand({
        handled: true,
        ok: false,
        command: token,
        code: 'unknown_command',
        data: { help_hint: 'Use /help to list supported local commands.' }
      });
    }

    const parsed = entry.parse_argument(rawArgument);
    if (!parsed.ok) {
      return this._finishLocalCommand({
        handled: true,
        ok: false,
        command: entry.token,
        code: parsed.code,
        data: { syntax: entry.syntax, help_hint: `Use ${entry.syntax}.` }
      });
    }
    if (this._busy && entry.busy_rule === COMMAND_BUSY_RULES.idleOnly) {
      return this._finishLocalCommand({
        handled: true,
        ok: false,
        command: entry.token,
        code: 'command_requires_idle',
        data: { busy_rule: entry.busy_rule }
      });
    }

    try {
      const handled = await entry.handler(this, parsed.value);
      contractAssert(isPlainObject(handled), 'invalid_command_result', `${entry.token} returned an invalid command result.`);
      return this._finishLocalCommand({
        handled: true,
        ok: handled.ok !== false,
        command: entry.token,
        code: handled.code ?? (handled.ok === false ? 'command_failed' : 'command_ok'),
        data: cloneJsonValue(handled.data ?? {})
      });
    } catch (error) {
      return this._finishLocalCommand({
        handled: true,
        ok: false,
        command: entry.token,
        code: error instanceof ControllerContractError ? error.code : 'command_failed',
        data: {
          help_hint: `Use /help ${entry.token.slice(1)} for command syntax.`
        }
      });
    }
  }

  _finishLocalCommand(result) {
    this.emit('command_result', result);
    this.emit('telemetry', { snapshot: this.getTelemetrySnapshot() });
    return cloneJsonValue(result);
  }

  async runTurn(options) {
    contractAssert(isPlainObject(options), 'invalid_turn_options', 'runTurn options must be a plain object.');
    const { question, systemMessages, userMessage } = options;
    contractAssert(typeof question === 'string' && question.trim(), 'invalid_question', 'question must be a nonempty string.');
    contractAssert(
      !question.trimStart().startsWith('/'),
      'slash_command_requires_local_dispatch',
      'Slash commands must be handled locally and may never reach provider transport.'
    );
    contractAssert(
      Array.isArray(systemMessages) && systemMessages.length > 0,
      'invalid_system_messages',
      'systemMessages must contain at least one system message.'
    );
    for (const message of systemMessages) {
      contractAssert(
        isPlainObject(message) && message.role === 'system' && typeof message.content === 'string',
        'invalid_system_message',
        'Every system message must be a plain role=system message with string content.'
      );
    }
    contractAssert(
      isPlainObject(userMessage) && userMessage.role === 'user' && typeof userMessage.content === 'string',
      'invalid_user_message',
      'userMessage must be the exact plain role=user developer/live-context message.'
    );
    contractAssert(!this._busy, 'controller_busy', 'Only one developer/API exchange may run at once.');

    const state = {
      question,
      view_turn_id: `turn-${this._nextViewTurnSequence++}`,
      settings: this.snapshotTurnSettings(),
      system_messages: appendCommandPromptSuffix(systemMessages),
      prior_exchanges: cloneJsonValue(this._completedExchanges),
      request_prior_exchanges: cloneJsonValue(this._completedExchanges),
      prior_history_rejected: false,
      raw_turn_messages: [cloneJsonValue(userMessage)],
      wire_turn_messages: [cloneJsonValue(userMessage)],
      round_summaries: [],
      view_rounds: [],
      rounds_started: 0,
      attempts: 0,
      retries: 0,
      warnings: [],
      last_replay: null,
      used_tools: false,
      processed_tool_call_ids: new Set(),
      partial_content: null,
      started_at_ms: clockMilliseconds(this._dependencies.clock)
    };

    this._busy = true;
    this._activity = 'waiting';
    let outcome;
    try {
      this.emit('turn_state', {
        state: 'waiting',
        configured_model: state.settings.model,
        configured_reasoning_effort: state.settings.reasoning_effort,
        effort_attribution: 'configured'
      });
      outcome = await this._runProviderTurn(state);
    } catch (error) {
      const isContractFailure = error instanceof ControllerContractError;
      outcome = {
        status: 'failed',
        error: {
          code: isContractFailure ? error.code : 'controller_turn_failed',
          category: 'controller',
          detail: isContractFailure ? error.message : 'The controller turn failed unexpectedly.'
        },
        partial_content: state.partial_content
      };
    }

    if (outcome.status === 'completed') {
      const committedExchange = cloneJsonValue(outcome.exchange);
      this._completedExchanges.push(committedExchange);
      this._lastExchange = cloneJsonValue(committedExchange);
      if (this._persistenceReady) {
        await this._persistHistorySnapshot(state);
      }
    }

    const terminalRoundView = state.view_rounds.at(-1);
    if (terminalRoundView) {
      appendRoundViewState(terminalRoundView, outcome.status);
      terminalRoundView.error_code = outcome.error?.code ?? null;
    }

    const telemetry = buildTurnTelemetry(state, outcome, this._dependencies.clock);
    outcome.telemetry = telemetry;
    this._lastCallTelemetry = cloneJsonValue(telemetry);
    this._recordSessionTelemetry(telemetry, outcome.status === 'completed');

    this._activity = outcome.status;
    try {
      this.emit(outcome.status === 'completed' ? 'turn_completed' : 'turn_terminal', {
        status: outcome.status,
        exchange_id: outcome.exchange?.id ?? null,
        final_answer: outcome.status === 'completed' ? outcome.final_answer : null,
        error: outcome.error ?? null,
        telemetry
      });
      this.emit('telemetry', { snapshot: this.getTelemetrySnapshot() });
      return cloneJsonValue(outcome);
    } finally {
      this._busy = false;
      this._activity = 'idle';
      this.emit('turn_state', { state: 'idle' });
    }
  }

  async _runProviderTurn(state) {
    let roundNumber = 0;
    while (true) {
      roundNumber++;
      const roundView = createRoundViewRecord(state.view_turn_id, roundNumber, state.settings);
      state.view_rounds.push(roundView);
      const roundStartedAt = clockMilliseconds(this._dependencies.clock);
      let request = buildContextBudgetedV4Request({
        model: state.settings.model,
        reasoningEffort: state.settings.reasoning_effort,
        systemMessages: state.system_messages,
        completedExchanges: state.request_prior_exchanges,
        currentTurnMessages: state.wire_turn_messages,
        tools: this._dependencies.tools
      });
      if (state.prior_history_rejected) {
        request = {
          ...request,
          excluded_exchanges: cloneJsonValue(state.prior_exchanges)
        };
      }
      this._recordReplaySelection(state, request);
      if (!request.fits) {
        return this._turnFailure('failed', 'context_too_large_preflight', 'context', {
          round: roundNumber,
          body_utf8_bytes: request.body_utf8_bytes,
          max_utf8_bytes: request.max_utf8_bytes
        });
      }
      state.rounds_started++;

      let attemptsThisRound = 0;
      let contextRecovery = false;
      let response;
      while (true) {
        attemptsThisRound++;
        state.attempts++;
        roundView.attempt_count = attemptsThisRound;
        this.emit('provider_attempt', {
          round: roundNumber,
          attempt: attemptsThisRound,
          body_utf8_bytes: request.body_utf8_bytes,
          replay_included: request.selected_exchanges.length,
          replay_excluded: request.excluded_exchanges.length,
          context_recovery: contextRecovery
        });
        try {
          response = await invokeHttpClient(this._dependencies.httpClient, {
            url: request.url,
            body: request.body
          });
          break;
        } catch (error) {
          const explicitContextRejection = isExplicitContextRejection(this._dependencies.httpClient, error);
          const failure = classifyProviderRequestError(error, { explicitContextRejection });
          const canRetry = attemptsThisRound === 1 && failure.retryable;

          if (canRetry && failure.context_rejection) {
            if (request.selected_exchanges.length === 0) {
              return this._turnFailure('failed', 'provider_context_rejected', 'context_length', {
                round: roundNumber,
                attempt: attemptsThisRound,
                status: failure.status,
                prior_exchange_count: 0
              });
            }
            const recovered = buildContextBudgetedV4Request({
              model: state.settings.model,
              reasoningEffort: state.settings.reasoning_effort,
              systemMessages: state.system_messages,
              completedExchanges: [],
              currentTurnMessages: state.wire_turn_messages,
              tools: this._dependencies.tools
            });
            if (!recovered.fits) {
              return this._turnFailure('failed', 'context_too_large_preflight', 'context', {
                round: roundNumber,
                body_utf8_bytes: recovered.body_utf8_bytes,
                max_utf8_bytes: recovered.max_utf8_bytes
              });
            }
            state.request_prior_exchanges = [];
            state.prior_history_rejected = true;
            state.retries++;
            contextRecovery = true;
            request = {
              ...recovered,
              excluded_exchanges: cloneJsonValue(state.prior_exchanges)
            };
            this._recordReplaySelection(state, request);
            roundView.retries.push({
              retry: state.retries,
              category: 'context_length',
              delay_ms: 0,
              context_recovery: true
            });
            appendRoundViewState(roundView, 'retrying');
            this.emit('provider_retry', {
              round: roundNumber,
              retry: state.retries,
              category: 'context_length',
              delay_ms: 0,
              dropped_prior_exchange_count: state.prior_exchanges.length,
              current_turn_preserved: true
            });
            continue;
          }

          if (canRetry) {
            const delayMs = retryDelayMilliseconds(error, this._dependencies.clock);
            state.retries++;
            roundView.retries.push({
              retry: state.retries,
              category: failure.category,
              delay_ms: delayMs,
              context_recovery: false
            });
            appendRoundViewState(roundView, 'retrying');
            this.emit('provider_retry', {
              round: roundNumber,
              retry: state.retries,
              category: failure.category,
              status: failure.status,
              transport_code: failure.transport_code,
              delay_ms: delayMs,
              body_unchanged: true
            });
            await this._dependencies.delay(delayMs);
            continue;
          }

          return this._turnFailure(
            'failed',
            failure.context_rejection ? 'provider_context_rejected' : failure.code,
            failure.category,
            {
              round: roundNumber,
              attempt: attemptsThisRound,
              status: failure.status,
              transport_code: failure.transport_code,
              retry_exhausted: attemptsThisRound > 1
            }
          );
        }
      }

      const parsed = parseProviderRoundResponse(response);
      this._lastActualModel = parsed.actual_model;
      const pricing = calculateRoundCost(parsed.actual_model, parsed.usage);
      const roundWarnings = [];
      if (parsed.actual_model !== state.settings.model) {
        const warning = {
          round: roundNumber,
          warning: 'actual_model_mismatch',
          configured_model: state.settings.model,
          actual_model: parsed.actual_model
        };
        roundWarnings.push(warning);
        state.warnings.push(warning);
      }
      if (pricing.warning) roundWarnings.push({ round: roundNumber, warning: pricing.warning });

      const roundSummary = {
        round: roundNumber,
        attempts: attemptsThisRound,
        actual_model: parsed.actual_model,
        configured_model: state.settings.model,
        configured_reasoning_effort: state.settings.reasoning_effort,
        effort_attribution: 'configured',
        latency_ms: Math.max(0, clockMilliseconds(this._dependencies.clock) - roundStartedAt),
        finish_reason: parsed.finish_reason,
        state: parsed.finish.state,
        usage: pricing.usage,
        cost_available: pricing.available,
        cost_usd: pricing.cost_usd,
        warnings: roundWarnings,
        request_body_utf8_bytes: request.body_utf8_bytes,
        replay_included_exchange_count: request.selected_exchanges.length,
        replay_excluded_exchange_count: request.excluded_exchanges.length,
        context_recovery: contextRecovery,
        tool_results: []
      };
      state.round_summaries.push(roundSummary);

      Object.assign(roundView, {
        attempt_count: attemptsThisRound,
        actual_model: parsed.actual_model,
        latency_ms: roundSummary.latency_ms,
        finish_reason: parsed.finish_reason,
        usage: cloneJsonValue(pricing.usage),
        cost_available: pricing.available,
        cost_usd: pricing.cost_usd,
        reasoning: typeof parsed.raw_assistant.reasoning_content === 'string'
          ? parsed.raw_assistant.reasoning_content
          : null,
        warnings: cloneJsonValue(roundWarnings)
      });

      this.emit('provider_round', {
        id: roundView.id,
        round: roundNumber,
        attempt_count: attemptsThisRound,
        actual_model: parsed.actual_model,
        configured_reasoning_effort: state.settings.reasoning_effort,
        effort_attribution: 'configured',
        latency_ms: roundSummary.latency_ms,
        finish_reason: parsed.finish_reason,
        assistant: providerAssistantViewProjection(parsed.raw_assistant),
        usage: pricing.usage,
        cost_available: pricing.available,
        cost_usd: pricing.cost_usd,
        retries: cloneJsonValue(roundView.retries),
        state: parsed.finish.state === 'tool_round' ? 'executing' : parsed.finish.state,
        warnings: roundWarnings
      });

      state.raw_turn_messages.push(parsed.raw_assistant);
      if (parsed.finish.state === 'completed') {
        appendRoundViewState(roundView, 'completed');
        const exchange = this._createCompletedExchange(state, parsed.raw_assistant.content);
        return {
          status: 'completed',
          final_answer: parsed.raw_assistant.content,
          exchange,
          error: null,
          partial_content: null
        };
      }
      if (parsed.finish.state === 'incomplete' || parsed.finish.state === 'failed') {
        appendRoundViewState(roundView, parsed.finish.state);
        state.partial_content = parsed.finish.partial_content;
        return this._turnFailure(
          parsed.finish.state,
          parsed.finish.code,
          'provider_finish',
          { round: roundNumber, finish_reason: parsed.finish_reason },
          parsed.finish.partial_content
        );
      }

      state.used_tools = true;
      appendRoundViewState(roundView, 'executing');
      state.wire_turn_messages.push(parsed.replay_assistant);
      const validation = this.validateToolCalls(parsed.raw_assistant.tool_calls);
      roundView.tool_calls = validation.calls.map(call => projectValidatedToolCallForView(call));
      if (validation.abort) {
        roundView.error_code = validation.error.code;
        return this._turnFailure('failed', validation.error.code, 'tool_envelope', {
          round: roundNumber,
          detail: validation.error.detail
        });
      }
      const execution = await this.executeValidatedToolBatch({
        calls: validation.calls,
        round: roundNumber,
        state,
        roundSummary,
        roundView
      });
      if (!execution.ok) return execution.failure;
      roundSummary.state = 'synthesizing';
      appendRoundViewState(roundView, 'synthesizing');
      this._activity = 'synthesizing';
    }
  }

  _recordReplaySelection(state, request) {
    state.last_replay = {
      included_exchange_count: request.selected_exchanges.length,
      excluded_exchange_count: request.excluded_exchanges.length,
      included_exchange_ids: request.selected_exchanges.map(exchange => exchange.id),
      excluded_exchange_ids: request.excluded_exchanges.map(exchange => exchange.id),
      body_utf8_bytes: request.body_utf8_bytes,
      max_utf8_bytes: request.max_utf8_bytes
    };
  }

  _turnFailure(status, code, category, details = {}, partialContent = null) {
    return {
      status,
      error: { code, category, details: cloneJsonValue(details) },
      partial_content: partialContent
    };
  }

  _createCompletedExchange(state, finalAnswer) {
    const finalAssistant = state.raw_turn_messages[state.raw_turn_messages.length - 1];
    const providerMessages = state.used_tools
      ? cloneJsonValue(state.raw_turn_messages)
      : [
          { role: 'user', content: state.question },
          cloneJsonValue(finalAssistant)
        ];
    const sequence = this._nextRuntimeExchangeSequence++;
    return {
      id: `runtime-${sequence}`,
      question: state.question,
      completed_at: clockIso(this._dependencies.clock),
      request_snapshot: {
        model: state.settings.model,
        reasoning_effort: state.settings.reasoning_effort
      },
      actual_models: state.round_summaries.map(summary => summary.actual_model),
      provider_messages: providerMessages,
      round_summaries: cloneJsonValue(state.round_summaries),
      final_answer: finalAnswer,
      status: 'completed'
    };
  }

  _recordSessionTelemetry(telemetry, completed) {
    const session = this._sessionTelemetry;
    session.api_rounds += telemetry.rounds;
    session.api_attempts += telemetry.attempts;
    if (telemetry.response_rounds > 0) {
      session.usage = mergeUsageTotals(session.usage, telemetry.usage);
      if (session.cost_available && telemetry.cost_available) {
        session.cost_usd += telemetry.cost_usd;
      } else {
        session.cost_available = false;
        session.cost_usd = null;
      }
    }
    if (!completed) return;

    session.completed_calls++;
    session.recent_calls.push({
      call: session.completed_calls,
      actual_models: cloneJsonValue(telemetry.actual_models),
      usage: cloneJsonValue(telemetry.usage),
      reasoning_tokens: telemetry.reasoning_tokens,
      cost_available: telemetry.cost_available,
      cost_usd: telemetry.cost_usd,
      rounds: telemetry.rounds,
      attempts: telemetry.attempts,
      fallback: 'none'
    });
    if (session.recent_calls.length > 5) session.recent_calls.shift();
  }

  _recordPersistenceWarnings(warnings, turnState = null) {
    for (const warning of warnings.filter(Boolean)) {
      const recorded = cloneJsonValue(warning);
      this._persistenceState.warnings.push(recorded);
      if (turnState) turnState.warnings.push({ category: 'persistence', ...cloneJsonValue(recorded) });
      this.emit('persistence_warning', recorded);
    }
  }

  async _persistHistorySnapshot(turnState = null) {
    const current = this._persistenceState.history;
    if (this._historyWritesBlocked) {
      const warning = { code: 'history_write_blocked', reason: 'startup_source_not_safely_preserved' };
      this._persistenceState.history = {
        ...current,
        status: 'write_blocked',
        degraded: true,
        live_exchange_count: this._completedExchanges.length,
        write_blocked: true
      };
      this._recordPersistenceWarnings([warning], turnState);
      return { ok: false, status: 'write_blocked', warning };
    }

    const { historyFile } = resolvePersistencePaths(this._dependencies.paths);
    const result = await saveHistoryStore({
      fsAdapter: this._dependencies.fsAdapter,
      historyPath: historyFile,
      exchanges: this._completedExchanges,
      clock: this._dependencies.clock,
      maxFileBytes: MAX_HISTORY_FILE_BYTES,
      maxExchanges: DURABLE_HISTORY_EXCHANGE_LIMIT
    });
    this._persistenceState.history = {
      ...current,
      status: result.status,
      degraded: !result.ok,
      live_exchange_count: this._completedExchanges.length,
      durable_exchange_ids: result.ok
        ? cloneJsonValue(result.selected_exchange_ids)
        : cloneJsonValue(current.durable_exchange_ids),
      durable_bytes: result.ok ? result.body_utf8_bytes : current.durable_bytes,
      max_file_bytes: result.max_file_bytes,
      write_blocked: false,
      excluded_exchange_ids: cloneJsonValue(result.excluded_exchange_ids),
      count_evicted: result.count_evicted,
      size_evicted: result.size_evicted
    };
    this._recordPersistenceWarnings(result.warning ? [result.warning] : [], turnState);
    return cloneJsonValue(result);
  }

  async persistCompletedHistory() {
    contractAssert(this._persistenceReady, 'persistence_not_loaded', 'Persistent state must be loaded before saving history.');
    contractAssert(!this._busy, 'controller_busy', 'History cannot be explicitly persisted during an active turn.');
    return this._persistHistorySnapshot();
  }

  async setConfiguredSettings({ model, reasoningEffort }) {
    contractAssert(this._persistenceReady, 'persistence_not_loaded', 'Persistent state must be loaded before saving settings.');
    const { settingsFile } = resolvePersistencePaths(this._dependencies.paths);
    const result = await saveSettingsStore({
      fsAdapter: this._dependencies.fsAdapter,
      settingsPath: settingsFile,
      model,
      reasoningEffort,
      clock: this._dependencies.clock
    });
    if (result.ok) {
      this._configuredSettings = {
        schema_version: SETTINGS_SCHEMA_VERSION,
        model: result.settings.model,
        reasoning_effort: result.settings.reasoning_effort
      };
      this._persistenceState.settings = {
        status: 'saved',
        degraded: false,
        saved_at: result.settings.saved_at
      };
    } else {
      this._persistenceState.settings = {
        ...this._persistenceState.settings,
        status: result.status,
        degraded: true
      };
      this._recordPersistenceWarnings(result.warnings);
    }
    return cloneJsonValue(result);
  }

  async loadPersistentState() {
    contractAssert(!this._busy, 'controller_busy', 'Persistent state may only load while idle.');
    contractAssert(!this._persistenceReady, 'persistence_already_loaded', 'Persistent state may seed the live ledger only once.');
    contractAssert(this._completedExchanges.length === 0, 'live_ledger_not_empty', 'Persistence cannot replace a nonempty live ledger.');
    const { historyFile, settingsFile } = resolvePersistencePaths(this._dependencies.paths);
    const history = await loadHistoryStore({
      fsAdapter: this._dependencies.fsAdapter,
      historyPath: historyFile,
      clock: this._dependencies.clock,
      maxFileBytes: MAX_HISTORY_FILE_BYTES,
      maxExchanges: DURABLE_HISTORY_EXCHANGE_LIMIT
    });
    const settings = await loadSettingsStore({
      fsAdapter: this._dependencies.fsAdapter,
      settingsPath: settingsFile
    });

    this._completedExchanges = cloneJsonValue(history.ledger);
    this._lastExchange = cloneJsonValue(history.last_exchange);
    let highestRuntimeSequence = 0;
    for (const exchange of this._completedExchanges) {
      const match = /^runtime-(\d+)$/.exec(exchange.id);
      if (match) highestRuntimeSequence = Math.max(highestRuntimeSequence, Number(match[1]));
    }
    this._nextRuntimeExchangeSequence = highestRuntimeSequence + 1;
    this._configuredSettings = {
      schema_version: SETTINGS_SCHEMA_VERSION,
      model: settings.settings.model,
      reasoning_effort: settings.settings.reasoning_effort
    };
    this._historyWritesBlocked = history.write_blocked;
    this._persistenceReady = true;
    this._persistenceState = {
      ready: true,
      history: {
        status: history.status,
        degraded: history.warnings.length > 0,
        live_exchange_count: this._completedExchanges.length,
        durable_exchange_ids: cloneJsonValue(history.durable_exchange_ids),
        durable_bytes: history.durable_bytes,
        max_file_bytes: MAX_HISTORY_FILE_BYTES,
        write_blocked: history.write_blocked,
        migration: cloneJsonValue(history.migration),
        quarantine_path: history.quarantine_path
      },
      settings: {
        status: settings.status,
        degraded: settings.warnings.length > 0,
        saved_at: settings.settings.saved_at ?? null
      },
      warnings: []
    };
    this._recordPersistenceWarnings([...history.warnings, ...settings.warnings]);
    return this.getContractSnapshot();
  }

  async _commandHelp(commandToken) {
    const entries = commandToken === null
      ? COMMAND_REGISTRY
      : COMMAND_REGISTRY.filter(entry => entry.token === commandToken);
    return {
      ok: true,
      code: 'help',
      data: { commands: entries.map(commandHelpEntry) }
    };
  }

  async _commandModel(model) {
    if (model === null) {
      return {
        ok: true,
        code: 'model_status',
        data: {
          configured_model: this._configuredSettings.model,
          applies_to: 'next_turn'
        }
      };
    }
    const saved = await this.setConfiguredSettings({
      model,
      reasoningEffort: this._configuredSettings.reasoning_effort
    });
    if (!saved.ok) {
      return { ok: false, code: saved.status, data: { configured_settings: { ...this._configuredSettings } } };
    }
    return {
      ok: true,
      code: 'model_saved',
      data: { configured_model: this._configuredSettings.model, applies_to: 'next_turn' }
    };
  }

  async _commandReasoning(reasoningEffort) {
    if (reasoningEffort === null) {
      return {
        ok: true,
        code: 'reasoning_status',
        data: {
          configured_reasoning_effort: this._configuredSettings.reasoning_effort,
          attribution: 'configured',
          applies_to: 'next_turn'
        }
      };
    }
    const saved = await this.setConfiguredSettings({
      model: this._configuredSettings.model,
      reasoningEffort
    });
    if (!saved.ok) {
      return { ok: false, code: saved.status, data: { configured_settings: { ...this._configuredSettings } } };
    }
    return {
      ok: true,
      code: 'reasoning_saved',
      data: {
        configured_reasoning_effort: this._configuredSettings.reasoning_effort,
        attribution: 'configured',
        applies_to: 'next_turn'
      }
    };
  }

  async _commandStatus() {
    const snapshot = this.getContractSnapshot();
    return {
      ok: true,
      code: 'status',
      data: {
        ...snapshot,
        attribution: {
          configured_model: 'next_turn_setting',
          configured_reasoning_effort: 'configured',
          last_actual_model: snapshot.last_actual_model === null ? 'unavailable' : 'provider_response'
        },
        replay: cloneJsonValue(snapshot.telemetry.last_call?.replay ?? null),
        retry: {
          attempts: snapshot.telemetry.last_call?.attempts ?? 0,
          retry_count: snapshot.telemetry.last_call?.retry_count ?? 0
        }
      }
    };
  }

  async _commandStats() {
    const telemetry = this.getTelemetrySnapshot();
    const history = this._persistenceState.history;
    return {
      ok: true,
      code: 'stats',
      data: {
        session: telemetry.session,
        last_call: telemetry.last_call,
        live_history: {
          exchange_count: this._completedExchanges.length,
          exchange_ids: this._completedExchanges.map(exchange => exchange.id)
        },
        durable_history: {
          status: history.status,
          degraded: history.degraded,
          exchange_ids: cloneJsonValue(history.durable_exchange_ids),
          bytes: history.durable_bytes,
          max_file_bytes: history.max_file_bytes,
          count_evicted: history.count_evicted ?? 0,
          size_evicted: history.size_evicted ?? 0
        },
        replay: cloneJsonValue(telemetry.last_call?.replay ?? null)
      }
    };
  }

  async _commandClear() {
    if (!this._persistenceReady) {
      return { ok: false, code: 'persistence_not_loaded', data: {} };
    }
    if (this._historyWritesBlocked) {
      return {
        ok: false,
        code: 'history_write_blocked',
        data: { live_exchange_count: this._completedExchanges.length }
      };
    }

    const current = this._persistenceState.history;
    const { historyFile } = resolvePersistencePaths(this._dependencies.paths);
    const result = await saveHistoryStore({
      fsAdapter: this._dependencies.fsAdapter,
      historyPath: historyFile,
      exchanges: [],
      clock: this._dependencies.clock,
      maxFileBytes: MAX_HISTORY_FILE_BYTES,
      maxExchanges: DURABLE_HISTORY_EXCHANGE_LIMIT
    });
    if (!result.ok) {
      this._persistenceState.history = {
        ...current,
        status: result.status,
        degraded: true,
        live_exchange_count: this._completedExchanges.length
      };
      this._recordPersistenceWarnings(result.warning ? [result.warning] : []);
      return {
        ok: false,
        code: result.status,
        data: {
          live_exchange_count: this._completedExchanges.length,
          durable_exchange_ids: cloneJsonValue(current.durable_exchange_ids)
        }
      };
    }

    const clearedExchangeCount = this._completedExchanges.length;
    this._completedExchanges = [];
    this._lastExchange = null;
    this._persistenceState.history = {
      ...current,
      status: result.status,
      degraded: false,
      live_exchange_count: 0,
      durable_exchange_ids: [],
      durable_bytes: result.body_utf8_bytes,
      max_file_bytes: result.max_file_bytes,
      write_blocked: false,
      excluded_exchange_ids: [],
      count_evicted: result.count_evicted,
      size_evicted: result.size_evicted
    };
    return {
      ok: true,
      code: 'history_cleared',
      data: { cleared_exchange_count: clearedExchangeCount }
    };
  }

  async _commandCopy() {
    const exchange = this._lastExchange;
    if (!exchange) return { ok: false, code: 'no_completed_exchange', data: {} };
    const text = `You: ${exchange.question}\n\nMother Brain:\n${exchange.final_answer}\n`;
    try {
      await this._dependencies.writeClipboard(text);
    } catch {
      return { ok: false, code: 'clipboard_write_failed', data: { exchange_id: exchange.id } };
    }
    return {
      ok: true,
      code: 'exchange_copied',
      data: {
        exchange_id: exchange.id,
        utf8_bytes: Buffer.byteLength(text, 'utf8')
      }
    };
  }

  async executeValidatedToolBatch({ calls, round, state, roundSummary, roundView }) {
    contractAssert(Array.isArray(calls), 'invalid_validated_tool_batch', 'Validated tool calls must be an array.');
    contractAssert(Number.isInteger(round) && round > 0, 'invalid_tool_round', 'Tool round must be a positive integer.');
    contractAssert(isPlainObject(state), 'invalid_tool_turn_state', 'Tool execution requires the active turn state.');
    contractAssert(isPlainObject(roundSummary), 'invalid_tool_round_summary', 'Tool execution requires a round summary.');
    contractAssert(isPlainObject(roundView), 'invalid_tool_round_view', 'Tool execution requires a round view record.');
    contractAssert(
      state.processed_tool_call_ids instanceof Set,
      'invalid_tool_call_ledger',
      'Tool execution requires a turn-scoped processed-call ledger.'
    );

    const preparedCalls = calls.map(call => {
      if (!state.processed_tool_call_ids.has(call.id)) return call;
      const error = toolCallError(
        'replayed_tool_call_id',
        'This tool call ID was already resolved during the active turn.'
      );
      return {
        ...call,
        status: 'rejected',
        error,
        toolContent: deterministicToolValidationResult(error)
      };
    });
    const displaySecrets = environmentSecretValues();
    roundView.tool_calls = preparedCalls.map(call => projectValidatedToolCallForView(call, displaySecrets));

    for (const call of preparedCalls) {
      state.processed_tool_call_ids.add(call.id);
      this.emit('tool_call', {
        round,
        tool_call_id: call.id,
        name: call.name,
        status: call.status,
        validation_code: call.status === 'valid' ? null : call.error.code,
        argument_keys: isPlainObject(call.args) ? Object.keys(call.args).sort() : []
      });

      let dispatched;
      if (call.status === 'valid') {
        try {
          dispatched = await this._dependencies.dispatchToolCall({
            id: call.id,
            name: call.name,
            args: cloneJsonValue(call.args),
            rawArguments: call.rawArguments
          });
        } catch (_) {
          return {
            ok: false,
            failure: this._turnFailure('failed', 'tool_dispatch_failed', 'tool', {
              round,
              tool_call_id: call.id,
              name: call.name
            })
          };
        }
      } else {
        dispatched = {
          toolContent: call.toolContent,
          outcome: 'rejected',
          gateCode: call.error.code
        };
      }

      const safeMetadataCode = value => (
        typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value)
      );
      if (!isPlainObject(dispatched) || typeof dispatched.toolContent !== 'string'
        || !safeMetadataCode(dispatched.outcome)
        || !(dispatched.gateCode === null || safeMetadataCode(dispatched.gateCode))) {
        return {
          ok: false,
          failure: this._turnFailure('failed', 'invalid_tool_dispatch_result', 'tool', {
            round,
            tool_call_id: call.id,
            name: call.name
          })
        };
      }

      const toolMessage = {
        role: 'tool',
        tool_call_id: call.id,
        content: dispatched.toolContent
      };
      state.raw_turn_messages.push(toolMessage);
      state.wire_turn_messages.push(cloneJsonValue(toolMessage));
      const resultSummary = {
        tool_call_id: call.id,
        name: call.name,
        outcome: dispatched.outcome,
        gate_code: dispatched.gateCode,
        bytes: Buffer.byteLength(dispatched.toolContent, 'utf8')
      };
      roundSummary.tool_results.push(resultSummary);
      const preview = boundedToolResultPreview(dispatched.toolContent, { secretValues: displaySecrets });
      roundView.tool_results.push({
        tool_call_id_suffix: call.id.slice(-8),
        name: call.name,
        status: dispatched.outcome,
        error_code: dispatched.gateCode,
        bytes: resultSummary.bytes,
        preview: preview.preview,
        truncated: preview.truncated,
        redacted: preview.redacted
      });
      this.emit('tool_result', { round, ...resultSummary });
    }
    return { ok: true };
  }
}

module.exports = {
  MotherBrainController,
  ControllerContractError,
  StepBoundaryError,
  CONTROLLER_CONTRACT_VERSION,
  SETTINGS_SCHEMA_VERSION,
  HISTORY_SCHEMA_VERSION,
  EXPECTED_PRODUCTION_TOOL_COUNT,
  DURABLE_HISTORY_EXCHANGE_LIMIT,
  MAX_HISTORY_FILE_BYTES,
  HISTORY_V1_BACKUP_BASENAME,
  MODEL_IDS,
  SUPPORTED_MODELS,
  REASONING_EFFORTS,
  SUPPORTED_REASONING_EFFORTS,
  DEFAULT_SETTINGS,
  DEEPSEEK_CHAT_COMPLETIONS_URL,
  MAX_OUTPUT_TOKENS,
  MAX_REQUEST_UTF8_BYTES,
  THINKING_MODE,
  REASONING_UNAVAILABLE_TEXT,
  PRICE_TABLE_SOURCE_DATE,
  PRICE_TABLE,
  TOOL_RESULT_PREVIEW_CHAR_LIMIT,
  REDACTED_DISPLAY_VALUE,
  TELEMETRY_FIELD_AUTHORITY,
  CONTEXT_CONTRACT,
  COMMAND_BUSY_RULES,
  COMMAND_REGISTRY,
  buildCommandPromptBlock,
  appendCommandPromptSuffix,
  parseNoArguments,
  parseOptionalEnum,
  parseOptionalCommand,
  OBSERVED_TOOL_PARAMETER_TYPES,
  createObservedToolSchemaIndex,
  deterministicToolValidationResult,
  validateToolCallBatch,
  environmentSecretValues,
  redactDisplayValue,
  boundedToolResultPreview,
  buildV4RequestBody,
  buildV4Request,
  serializedBodyUtf8Bytes,
  displayTokenEstimate,
  estimateConversationHistoryTokens,
  captureAssistantMessage,
  toProviderReplayMessage,
  providerReplayMessagesForExchange,
  flattenProviderReplay,
  selectNewestReplaySuffix,
  migrateLegacyHistory,
  validateCompletedExchange,
  validateHistoryDocument,
  validateSettingsDocument,
  buildDurableHistorySnapshot,
  saveHistoryStore,
  loadHistoryStore,
  loadSettingsStore,
  saveSettingsStore,
  normalizeUsage,
  calculateRoundCost,
  aggregateUsage,
  aggregateRoundTelemetry,
  RETRYABLE_HTTP_STATUSES,
  TERMINAL_CLIENT_HTTP_STATUSES,
  TRANSIENT_TRANSPORT_CODES,
  DEFAULT_RETRY_DELAY_MS,
  MAX_RETRY_DELAY_MS,
  classifyProviderFinish,
  parseProviderRoundResponse,
  httpStatusFromError,
  retryDelayMilliseconds,
  classifyProviderRequestError,
  isObservedDeepSeekContextLengthError,
  isExplicitContextRejection,
  buildContextBudgetedV4Request,
  buildServerClockSnapshot,
  buildTurnTelemetry,
  CONTROLLER_DEPENDENCY_KEYS,
  TEST_INJECTION_POINTS,
  isPlainObject
};
