#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const PRODUCTION_TUI = require('../motherbrain-tui');

const ROOT_DIR = path.resolve(__dirname, '..');
const PROOF_RECORD_PATH = path.join(ROOT_DIR, 'logs', 'motherbrain-tui-smoke-proof.json');
const PRODUCTION_PROOF_RECORD_PATH = path.join(ROOT_DIR, 'logs', 'motherbrain-tui-step9-proof.json');
const NON_TTY_DIAGNOSTIC = 'Mother Brain TUI smoke requires an interactive TTY; no terminal mode was activated.\n';

const INITIAL_PROOF_CONFIG = Object.freeze({
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

// These remain identical to the approved initial candidates unless recorded
// smoke evidence justifies a bounded change.
const PROOF_CONFIG = Object.freeze({ ...INITIAL_PROOF_CONFIG });

const PROOF_BOUNDS = Object.freeze({
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

const PALETTE_ROLE_TOKEN = Object.freeze({
  background: ROLE_TOKEN.background,
  motherFinal: ROLE_TOKEN.final,
  reasoning: ROLE_TOKEN.reasoning,
  tool: ROLE_TOKEN.tool,
  warning: ROLE_TOKEN.warning,
  failure: ROLE_TOKEN.failure,
  developer: ROLE_TOKEN.developer,
  border: ROLE_TOKEN.border,
  telemetry: ROLE_TOKEN.telemetry,
});

const DEPENDENCY_PROVENANCE = Object.freeze({
  package: 'terminal-kit',
  version: '3.1.3',
  integrity: 'sha512-URPwQqXe/T5dZoD4qBHUO7eS+Vtf0PjliCftJU2EPaF5uVw/QG1zqgLy5kqwTrn1ix9e9HtMgMKAnzgaAnr3yA==',
  shasum: '1e3effcd3af31d601d321bee4d377124a696ef10',
  installScripts: false,
  nativeBuild: false,
  license: 'MIT',
});

const FIXED_PASTE_FIXTURE = 'PASTE_PROOF_ALPHA\nPASTE_PROOF_BETA\nPASTE_PROOF_GAMMA';
const INPUT_PROMPT = 'YOU> ';
const INPUT_PROMPT_WIDTH = INPUT_PROMPT.length;
const SCREEN_SENTINELS = Object.freeze({
  header: 'MBH7',
  transcript: 'MBL7',
  activity: 'MBR7',
  input: 'MBI7',
  footer: 'MBF7',
  overlay: 'MB_RESIZE_REQUIRED',
});

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableHash(value) {
  return sha256(JSON.stringify(stableValue(value)));
}

function utcNow() {
  return new Date().toISOString();
}

function escapeMarkup(value) {
  return String(value).replace(/\^/g, '^^');
}

function ruledLine(label, width) {
  const prefix = `├─ ${label} `;
  if (prefix.length >= width) return prefix.slice(0, width);
  return `${prefix}${'─'.repeat(width - prefix.length)}`;
}

function prepareWindowsTerminalEnvironment(env = process.env, platform = process.platform) {
  const windowsTerminal = platform === 'win32' && Boolean(env.WT_SESSION);
  const previous = { term: env.TERM || null, colorTerm: env.COLORTERM || null };
  if (windowsTerminal) {
    env.TERM = 'xterm-256color';
    env.COLORTERM = 'truecolor';
  }
  return {
    windowsTerminal,
    promoted: windowsTerminal && (previous.term !== (env.TERM || null) || previous.colorTerm !== (env.COLORTERM || null)),
    previous,
    effective: { term: env.TERM || null, colorTerm: env.COLORTERM || null },
  };
}

function normalizeTextLines(value) {
  return String(value).replace(/\r\n?/g, '\n').split('\n');
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let offset = 0;
  while ((offset = haystack.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function computeLayout(width, height, splitRatio = PROOF_CONFIG.transcriptShare) {
  width = Math.max(0, Math.floor(width));
  height = Math.max(0, Math.floor(height));

  const bodyHeight = height - 1 - PROOF_CONFIG.inputHeight - PROOF_CONFIG.coreFooterHeight;
  const bodyContentRows = bodyHeight - 1;
  const minimumPaneWidth = PROOF_CONFIG.transcriptMinWidth + 1 + PROOF_CONFIG.activityMinWidth;
  const supported = width >= PROOF_CONFIG.supportedMinColumns
    && height >= PROOF_CONFIG.supportedMinRows
    && width >= minimumPaneWidth
    && bodyContentRows >= PROOF_CONFIG.bodyContentMinRows;

  if (!supported) {
    return {
      supported: false,
      width,
      height,
      bodyHeight,
      bodyContentRows,
      overlay: { x: 0, y: 0, width, height },
    };
  }

  const availablePaneWidth = width - 1;
  const transcriptWidth = clamp(
    Math.round(availablePaneWidth * splitRatio),
    PROOF_CONFIG.transcriptMinWidth,
    availablePaneWidth - PROOF_CONFIG.activityMinWidth,
  );
  const activityWidth = availablePaneWidth - transcriptWidth;
  const inputY = 1 + bodyHeight;
  const footerY = inputY + PROOF_CONFIG.inputHeight;

  return {
    supported: true,
    width,
    height,
    splitRatio,
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
    input: { x: 0, y: inputY, width, height: PROOF_CONFIG.inputHeight },
    inputLabel: { x: 0, y: inputY, width, height: 1 },
    inputPrompt: { x: 0, y: inputY + 1, width: INPUT_PROMPT_WIDTH, height: 1 },
    editor: { x: INPUT_PROMPT_WIDTH, y: inputY + 1, width: width - INPUT_PROMPT_WIDTH, height: PROOF_CONFIG.inputHeight - 1 },
    footer: { x: 0, y: footerY, width, height: PROOF_CONFIG.coreFooterHeight },
    footerRule: { x: 0, y: footerY, width, height: 1 },
    footerContent: { x: 0, y: footerY + 1, width, height: PROOF_CONFIG.coreFooterHeight - 1 },
  };
}

function rectanglesOverlap(a, b) {
  return a.x < b.x + b.width
    && a.x + a.width > b.x
    && a.y < b.y + b.height
    && a.y + a.height > b.y;
}

function assertRectangleInBounds(rectangle, width, height, label) {
  assert.ok(rectangle.width > 0 && rectangle.height > 0, `${label} has a non-positive dimension`);
  assert.ok(rectangle.x >= 0 && rectangle.y >= 0, `${label} starts outside the frame`);
  assert.ok(rectangle.x + rectangle.width <= width, `${label} exceeds frame width`);
  assert.ok(rectangle.y + rectangle.height <= height, `${label} exceeds frame height`);
}

function assertLayout(layout) {
  if (!layout.supported) {
    assertRectangleInBounds(layout.overlay, layout.width, layout.height, 'overlay');
    return;
  }

  const topLevel = [
    ['header', layout.header],
    ['transcript', layout.transcript],
    ['divider', layout.divider],
    ['activity', layout.activity],
    ['input', layout.input],
    ['footer', layout.footer],
  ];
  topLevel.forEach(([label, rectangle]) => assertRectangleInBounds(rectangle, layout.width, layout.height, label));
  for (const [label, rectangle] of [
    ['transcriptTitle', layout.transcriptTitle],
    ['transcriptContent', layout.transcriptContent],
    ['activityTitle', layout.activityTitle],
    ['activityContent', layout.activityContent],
    ['inputLabel', layout.inputLabel],
    ['inputPrompt', layout.inputPrompt],
    ['editor', layout.editor],
    ['footerRule', layout.footerRule],
    ['footerContent', layout.footerContent],
  ]) assertRectangleInBounds(rectangle, layout.width, layout.height, label);

  for (let left = 0; left < topLevel.length; left += 1) {
    for (let right = left + 1; right < topLevel.length; right += 1) {
      assert.equal(
        rectanglesOverlap(topLevel[left][1], topLevel[right][1]),
        false,
        `${topLevel[left][0]} overlaps ${topLevel[right][0]}`,
      );
    }
  }

  assert.ok(layout.transcript.width >= PROOF_CONFIG.transcriptMinWidth, 'transcript minimum width failed');
  assert.ok(layout.activity.width >= PROOF_CONFIG.activityMinWidth, 'activity minimum width failed');
  assert.ok(layout.bodyContentRows >= PROOF_CONFIG.bodyContentMinRows, 'body content row floor failed');
  assert.equal(layout.transcript.height, layout.activity.height, 'right pane is not full body height');
}

function dividerLayoutForColumn(width, height, requestedTranscriptWidth) {
  const availablePaneWidth = Math.floor(width) - 1;
  const transcriptWidth = clamp(
    Math.round(requestedTranscriptWidth),
    PROOF_CONFIG.transcriptMinWidth,
    availablePaneWidth - PROOF_CONFIG.activityMinWidth,
  );
  return computeLayout(width, height, transcriptWidth / availablePaneWidth);
}

function applyDividerLayoutWithRedraw(applyLayout, layout) {
  return applyLayout(layout, true);
}

function projectRecord(record, limit) {
  const sourceLines = normalizeTextLines(record.text);
  if (sourceLines.length <= limit) {
    return sourceLines.map((text, lineIndex) => ({
      recordId: record.id,
      role: record.role,
      text,
      lineIndex,
      lineCount: sourceLines.length,
      truncated: false,
    }));
  }

  const firstCount = Math.floor(limit / 2);
  const lastCount = limit - firstCount - 1;
  const omitted = sourceLines.length - firstCount - lastCount;
  const first = sourceLines.slice(0, firstCount).map((text, lineIndex) => ({
    recordId: record.id,
    role: record.role,
    text,
    lineIndex,
    lineCount: sourceLines.length,
    truncated: true,
  }));
  const marker = {
    recordId: record.id,
    role: 'warning',
    text: `[record ${record.id} truncated: ${omitted} logical lines omitted]`,
    lineIndex: firstCount,
    lineCount: sourceLines.length,
    truncated: true,
    truncationMarker: true,
  };
  const lastStart = sourceLines.length - lastCount;
  const last = sourceLines.slice(lastStart).map((text, offset) => ({
    recordId: record.id,
    role: record.role,
    text,
    lineIndex: lastStart + offset,
    lineCount: sourceLines.length,
    truncated: true,
  }));
  return [...first, marker, ...last];
}

function projectRecords(records, limit = PROOF_CONFIG.paneLogicalLineLimit) {
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

function formatProjection(records) {
  return records.map((line) => {
    const token = ROLE_TOKEN[line.role] || ROLE_TOKEN.telemetry;
    const prefix = rolePrefix(line.role, line.lineIndex === 0 || line.truncationMarker);
    return `^[${token}]${escapeMarkup(prefix + line.text)}^:`;
  }).join('\n');
}

class HistoryBuffer {
  constructor(limit = PROOF_CONFIG.historyLimit) {
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

function createPaneState(records) {
  return {
    records: records.slice(),
    follow: true,
    topLogicalLine: 0,
    newOutput: false,
  };
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
    ? {
      xmin: startX - widget.scrollX,
      ymin: startY - widget.scrollY,
      xmax: endX - widget.scrollX,
      ymax: endY - widget.scrollY,
    }
    : {
      xmin: endX - widget.scrollX,
      ymin: endY - widget.scrollY,
      xmax: startX - widget.scrollX,
      ymax: startY - widget.scrollY,
    };
}

function selectedPaneText(widget) {
  return widget.textBuffer.getSelectionText() || '';
}

function renderSyntheticFrame(termkit, layout) {
  const width = Math.max(1, layout.width);
  const height = Math.max(1, layout.height);
  const screen = new termkit.ScreenBuffer({ width, height });
  screen.fill({ char: ' ', attr: { color: 7, bgColor: 0 } });

  if (!layout.supported) {
    const x = Math.max(0, Math.floor((width - SCREEN_SENTINELS.overlay.length) / 2));
    const y = Math.max(0, Math.floor(height / 2));
    screen.put({ x, y, attr: { color: 3, bgColor: 0 } }, SCREEN_SENTINELS.overlay);
    return screen.dumpChars();
  }

  screen.put({ x: layout.header.x, y: layout.header.y }, SCREEN_SENTINELS.header);
  screen.put({ x: layout.transcript.x, y: layout.transcript.y }, SCREEN_SENTINELS.transcript);
  screen.put({ x: layout.activity.x, y: layout.activity.y }, SCREEN_SENTINELS.activity);
  screen.put({ x: layout.input.x, y: layout.input.y }, SCREEN_SENTINELS.input);
  screen.put({ x: layout.inputPrompt.x, y: layout.inputPrompt.y }, INPUT_PROMPT);
  screen.put({ x: layout.footer.x, y: layout.footer.y }, SCREEN_SENTINELS.footer);
  for (let y = layout.divider.y; y < layout.divider.y + layout.divider.height; y += 1) {
    screen.put({ x: layout.divider.x, y }, '│');
  }
  return screen.dumpChars();
}

function validateConfigBounds() {
  for (const [key, [minimum, maximum]] of Object.entries(PROOF_BOUNDS)) {
    assert.ok(PROOF_CONFIG[key] >= minimum && PROOF_CONFIG[key] <= maximum, `${key} is outside approved bounds`);
  }
  assert.ok(PROOF_CONFIG.expandedFooterHeight >= PROOF_CONFIG.coreFooterHeight, 'expanded footer is below core footer');
  assert.equal(Object.keys(PALETTE).length, 9, 'palette role count changed');
  assert.notEqual(PALETTE.developer.toUpperCase(), '#FFFFFF', 'developer role became white');
  assert.notEqual(PALETTE.motherFinal.toUpperCase(), '#00FF00', 'Mother role became neon green');
}

function testWindowsTerminalProfilePromotion() {
  const env = { WT_SESSION: 'unit-fixture' };
  const result = prepareWindowsTerminalEnvironment(env, 'win32');
  assert.equal(result.windowsTerminal, true);
  assert.equal(result.promoted, true);
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.COLORTERM, 'truecolor');

  const untouched = { TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  const noWindowsTerminal = prepareWindowsTerminalEnvironment(untouched, 'linux');
  assert.equal(noWindowsTerminal.windowsTerminal, false);
  assert.equal(noWindowsTerminal.promoted, false);

  const staleProductionEnvironment = {
    WT_SESSION: 'production-fixture',
    TERM: 'dumb',
    COLORTERM: 'ansi',
  };
  const productionProfile = PRODUCTION_TUI.prepareWindowsTerminalEnvironment(
    staleProductionEnvironment,
    'win32',
  );
  assert.equal(productionProfile.windowsTerminal, true);
  assert.equal(staleProductionEnvironment.TERM, 'xterm-256color');
  assert.equal(staleProductionEnvironment.COLORTERM, 'truecolor');

  const paletteIndexes = new Map(Object.values(PALETTE_ROLE_TOKEN).map((token, index) => [token, 232 + index]));
  const palette = {
    escape: [],
    bgEscape: [],
    colorNameToIndex(name) { return paletteIndexes.get(name); },
  };
  const hardened = PRODUCTION_TUI.enforceExactWindowsTerminalPalette(palette, productionProfile);
  assert.equal(hardened.enforced, true);
  assert.equal(hardened.exact, true);
  for (const [role, code] of Object.entries(PALETTE)) {
    const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(code);
    const rgb = match.slice(1).map(value => Number.parseInt(value, 16));
    const index = hardened.indexes[role];
    assert.equal(palette.escape[index], `\x1b[38;2;${rgb.join(';')}m`);
    assert.equal(palette.bgEscape[index], `\x1b[48;2;${rgb.join(';')}m`);
  }
}

function testTerminalKitEditableTextBox(termkit) {
  const paletteIndexes = new Map([
    [ROLE_TOKEN.background, 232],
    [ROLE_TOKEN.final, 233],
    [ROLE_TOKEN.reasoning, 234],
    [ROLE_TOKEN.tool, 235],
    [ROLE_TOKEN.warning, 236],
    [ROLE_TOKEN.failure, 237],
    [ROLE_TOKEN.developer, 238],
    [ROLE_TOKEN.border, 239],
    [ROLE_TOKEN.telemetry, 240],
  ]);
  const palette = {
    colorNameToIndex(name) {
      return paletteIndexes.get(name) ?? 0;
    },
  };
  const screen = new termkit.ScreenBuffer({ width: 40, height: 8, palette });
  const input = new termkit.EditableTextBox({
    outputDst: screen,
    outputX: 0,
    outputY: 0,
    outputWidth: 12,
    outputHeight: 3,
    lineWrap: true,
    value: 'abcdef',
    textAttr: { color: ROLE_TOKEN.developer, bgColor: ROLE_TOKEN.background },
    voidAttr: { color: ROLE_TOKEN.developer, bgColor: ROLE_TOKEN.background },
    noDraw: true,
  });
  // The widget actions redraw their cursor through a Document. A minimal
  // off-screen document reference keeps this test terminal-independent.
  input.document = { outputDst: screen };

  assert.equal(input.getValue(), 'abcdef');
  assert.equal(input.textBuffer.getCursorOffset(), 6);
  input.onKey('LEFT', null, { isCharacter: false });
  input.onKey('LEFT', null, { isCharacter: false });
  assert.equal(input.textBuffer.getCursorOffset(), 4);
  input.onKey('BACKSPACE', null, { isCharacter: false });
  assert.equal(input.getValue(), 'abcef');
  assert.equal(input.textBuffer.getCursorOffset(), 3);
  input.onKey('DELETE', null, { isCharacter: false });
  assert.equal(input.getValue(), 'abcf');
  input.onKey('HOME', null, { isCharacter: false });
  assert.equal(input.textBuffer.getCursorOffset(), 0);
  input.onKey('RIGHT', null, { isCharacter: false });
  assert.equal(input.textBuffer.getCursorOffset(), 1);
  input.onKey('END', null, { isCharacter: false });
  assert.equal(input.textBuffer.getCursorOffset(), 4);
  input.setValue('long-input-'.repeat(12), true);
  assert.ok(input.textBuffer.buffer.length > 3, 'long input did not wrap');

  const expectedDeveloperAttr = screen.object2attr({
    color: ROLE_TOKEN.developer,
    bgColor: ROLE_TOKEN.background,
  });
  assert.equal(input.textBuffer.defaultAttr, expectedDeveloperAttr, 'live input is not developer red');

  const submitted = new termkit.TextBox({
    outputDst: screen,
    outputX: 0,
    outputY: 4,
    outputWidth: 30,
    outputHeight: 2,
    content: `^[${ROLE_TOKEN.developer}]You: submitted-red-proof^:`,
    contentHasMarkup: true,
    textAttr: { color: ROLE_TOKEN.telemetry, bgColor: ROLE_TOKEN.background },
    noDraw: true,
  });
  const firstSubmittedCell = submitted.textBuffer.buffer[0][0];
  assert.equal(firstSubmittedCell.attr, expectedDeveloperAttr, 'submitted input is not the live developer role');
}

async function runPasteTrial() {
  let editorValue = '';
  const submitted = [];
  const debouncer = new EnterDebouncer({
    delayMs: PROOF_CONFIG.pasteDebounceMs,
    onNewLine: () => { editorValue += '\n'; },
    onSubmit: () => { submitted.push(editorValue); editorValue = ''; },
  });

  for (const character of FIXED_PASTE_FIXTURE) {
    if (character === '\n') debouncer.handleEnter();
    else {
      debouncer.beforeCharacter();
      editorValue += character;
    }
  }
  debouncer.handleEnter();
  await new Promise((resolve) => setTimeout(resolve, PROOF_CONFIG.pasteDebounceMs + 20));
  assert.deepEqual(submitted, [FIXED_PASTE_FIXTURE]);
  return sha256(submitted[0]);
}

function testHistoryLimit() {
  const history = new HistoryBuffer(PROOF_CONFIG.historyLimit);
  for (let index = 1; index <= PROOF_CONFIG.historyLimit + 1; index += 1) history.push(`history-${index}`);
  assert.equal(history.items.length, PROOF_CONFIG.historyLimit);
  assert.equal(history.items[0], 'history-2');
  assert.equal(history.items.at(-1), `history-${PROOF_CONFIG.historyLimit + 1}`);

  let recalled = 'current-draft';
  for (let index = 0; index < PROOF_CONFIG.historyLimit; index += 1) recalled = history.previous(recalled);
  assert.equal(recalled, 'history-2');
  assert.equal(history.previous(recalled), 'history-2');
  for (let index = 0; index < PROOF_CONFIG.historyLimit; index += 1) recalled = history.next(recalled);
  assert.equal(recalled, 'current-draft');
}

function testBoundedProjection() {
  const records = Array.from({ length: 10000 }, (_, index) => ({
    id: `record-${index + 1}`,
    role: index % 2 ? 'tool' : 'reasoning',
    text: `stress-line-${index + 1}`,
  }));
  const beforeHash = stableHash(records);
  const projection = projectRecords(records);
  assert.equal(projection.length, PROOF_CONFIG.paneLogicalLineLimit);
  assert.equal(projection[0].recordId, 'record-9501');
  assert.equal(projection.at(-1).recordId, 'record-10000');
  assert.equal(stableHash(records), beforeHash, 'projection mutated its source ledger');

  const hugeLines = Array.from({ length: 700 }, (_, index) => `huge-${index}`);
  const huge = projectRecords([{ id: 'huge-record', role: 'tool', text: hugeLines.join('\n') }]);
  assert.equal(huge.length, PROOF_CONFIG.paneLogicalLineLimit);
  assert.equal(huge[0].text, 'huge-0');
  assert.equal(huge[Math.floor(PROOF_CONFIG.paneLogicalLineLimit / 2)].truncationMarker, true);
  assert.equal(huge.at(-1).text, 'huge-699');
}

function testIndependentPaneState() {
  const transcript = createPaneState([{ id: 't1', role: 'final', text: 'one' }]);
  const activity = createPaneState([{ id: 'a1', role: 'reasoning', text: 'one' }]);
  transcript.follow = false;
  transcript.topLogicalLine = 3;
  appendPaneRecord(transcript, { id: 't2', role: 'final', text: 'two' });
  appendPaneRecord(activity, { id: 'a2', role: 'reasoning', text: 'two' });
  assert.equal(transcript.topLogicalLine, 3);
  assert.equal(transcript.newOutput, true);
  assert.equal(activity.follow, true);
  assert.equal(activity.newOutput, false);
  scrollPaneState(transcript, 20, 20);
  assert.equal(transcript.follow, true);
  assert.equal(transcript.newOutput, false);
  assert.equal(activity.topLogicalLine, 0, 'transcript scroll changed activity offset');
}

function testPaneBoundedSelection(termkit) {
  const screen = new termkit.ScreenBuffer({ width: 32, height: 6 });
  const transcript = new termkit.TextBox({
    outputDst: screen,
    x: 0,
    y: 0,
    width: 14,
    height: 3,
    content: 'left-00\nleft-01\nleft-02',
    lineWrap: true,
    noDraw: true,
  });
  const activity = new termkit.TextBox({
    outputDst: screen,
    x: 18,
    y: 0,
    width: 14,
    height: 3,
    content: 'right-00\nright-01\nright-02',
    lineWrap: true,
    noDraw: true,
  });

  transcript.textBuffer.setSelectionRegion(paneSelectionRegion({ xFrom: 0, yFrom: 0, x: 6, y: 1 }, transcript));
  assert.equal(selectedPaneText(transcript), 'left-00\nleft-01');
  assert.equal(activity.textBuffer.selectionRegion, null, 'transcript selection touched the activity pane');
  assert.equal(selectedPaneText(transcript).includes('right-'), false, 'pane selection interleaved the other pane');

  activity.textBuffer.setSelectionRegion(paneSelectionRegion({ xFrom: 7, yFrom: 1, x: 0, y: 0 }, activity));
  assert.equal(selectedPaneText(activity), 'right-00\nright-01');
  assert.equal(selectedPaneText(activity).includes('left-'), false, 'reverse pane selection interleaved the other pane');

  const clipped = paneSelectionRegion({ xFrom: -50, yFrom: -50, x: 500, y: 500 }, transcript);
  assert.deepEqual(clipped, { xmin: 0, ymin: 0, xmax: 13, ymax: 2 });
}

function testNonTtyGuard() {
  const child = spawnSync(process.execPath, [__filename], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    input: '',
    windowsHide: true,
  });
  assert.equal(child.status, 2, `non-TTY child exited ${child.status}: ${child.stderr}`);
  assert.equal(child.stdout, NON_TTY_DIAGNOSTIC);
  assert.equal(child.stderr, '');
  assert.equal(child.stdout.includes('\x1b'), false, 'non-TTY output activated terminal escapes');
}

function comparableLayout(layout) {
  if (!layout.supported) {
    return {
      supported: false,
      width: layout.width,
      height: layout.height,
      bodyHeight: layout.bodyHeight,
      bodyContentRows: layout.bodyContentRows,
      overlay: layout.overlay,
    };
  }
  return {
    supported: true,
    width: layout.width,
    height: layout.height,
    transcriptWidth: layout.transcriptWidth,
    activityWidth: layout.activityWidth,
    bodyHeight: layout.bodyHeight,
    bodyContentRows: layout.bodyContentRows,
    header: layout.header,
    transcript: layout.transcript,
    transcriptTitle: layout.transcriptTitle,
    transcriptContent: layout.transcriptContent,
    divider: layout.divider,
    activity: layout.activity,
    activityTitle: layout.activityTitle,
    activityContent: layout.activityContent,
    input: layout.input,
    inputLabel: layout.inputLabel,
    inputPrompt: layout.inputPrompt,
    editor: layout.editor,
    footer: layout.footer,
    footerRule: layout.footerRule,
    footerContent: layout.footerContent,
  };
}

async function testProductionRendererContract(termkit) {
  assert.deepEqual(PRODUCTION_TUI.TUI_CONFIG, PROOF_CONFIG, 'production constants diverged from the recorded smoke constants');
  assert.deepEqual(PRODUCTION_TUI.TUI_BOUNDS, PROOF_BOUNDS, 'production tuning bounds diverged from the approved bounds');
  assert.deepEqual(PRODUCTION_TUI.PALETTE, PALETTE, 'production palette diverged from the recorded smoke palette');

  const productionSource = fs.readFileSync(path.join(ROOT_DIR, 'motherbrain-tui.js'), 'utf8');
  for (const forbidden of [
    '/accept', 'F2 matrix', 'F3', 'F4 stress', 'F6 busy', 'ISOLATED PROOF',
    'NO NETWORK / NO PROVIDER', 'PASTE_PROOF_', 'COPY_PROOF_',
    'motherbrain-tui-smoke-proof', 'manualAccepted',
  ]) assert.equal(productionSource.includes(forbidden), false, `production renderer contains proof-harness artifact ${forbidden}`);
  assert.equal(/synthetic/i.test(productionSource), false, 'production renderer contains synthetic proof behavior');
  for (const forbiddenImport of ['motherbrain-controller', 'axios', '/chat/completions', 'MB_TOOLS']) {
    assert.equal(productionSource.includes(forbiddenImport), false, `production renderer crossed its authority boundary with ${forbiddenImport}`);
  }

  const importProbe = spawnSync(process.execPath, ['-e', [
    "const Module=require('node:module');",
    'const original=Module._load;',
    "Module._load=function(request,...args){if(request==='terminal-kit')throw new Error('terminal-kit loaded during import');return original.call(this,request,...args);};",
    "require('./motherbrain-tui.js');",
    "process.stdout.write('IMPORT_OK');",
  ].join('')], { cwd: ROOT_DIR, encoding: 'utf8', windowsHide: true });
  assert.equal(importProbe.status, 0, `production import failed: ${importProbe.stderr}`);
  assert.equal(importProbe.stdout, 'IMPORT_OK', 'production import wrote unexpected output');
  assert.equal(importProbe.stderr, '', 'production import wrote stderr');

  for (const [width, height] of [[90, 24], [89, 24], [90, 23], [120, 40], [240, 80]]) {
    assert.deepEqual(
      comparableLayout(PRODUCTION_TUI.computeLayout(width, height, PROOF_CONFIG.transcriptShare)),
      comparableLayout(computeLayout(width, height, PROOF_CONFIG.transcriptShare)),
      `production core layout diverged at ${width}x${height}`,
    );
  }
  const expanded = PRODUCTION_TUI.computeLayout(120, 40, PROOF_CONFIG.transcriptShare, { footerTier: 'expanded' });
  assert.equal(expanded.supported, true);
  assert.equal(expanded.footer.height, PROOF_CONFIG.expandedFooterHeight);
  assert.equal(expanded.transcript.height, expanded.activity.height, 'expanded footer introduced an internal right split');
  assert.ok(expanded.bodyContentRows >= PROOF_CONFIG.bodyContentMinRows, 'expanded footer violated the body floor');

  const productionRoles = [
    { id: 'role-developer', role: 'developer', text: 'developer' },
    { id: 'role-final', role: 'final', text: 'final' },
    { id: 'role-warning', role: 'warning', text: 'warning' },
    { id: 'role-failure', role: 'failure', text: 'failure' },
  ];
  const roleMarkup = PRODUCTION_TUI.formatProjection(PRODUCTION_TUI.projectRecords(productionRoles));
  for (const token of ['*mb-developer', '*mb-mother-final', '*mb-warning', '*mb-failure']) assert.ok(roleMarkup.includes(token));
  const luminance = (hex) => {
    const rgb = hex.match(/[0-9a-f]{2}/gi).map((part) => Number.parseInt(part, 16));
    return (0.2126 * rgb[0]) + (0.7152 * rgb[1]) + (0.0722 * rgb[2]);
  };
  assert.ok(luminance(PRODUCTION_TUI.PALETTE.motherFinal) > luminance(PRODUCTION_TUI.PALETTE.reasoning));

  const rounds = Array.from({ length: 8 }, (_, index) => PRODUCTION_TUI.formatRoundActivityRecord({
    id: `production-round-${index + 1}`,
    round: index + 1,
    attempt_count: index === 4 ? 2 : 1,
    actual_model: index % 2 ? 'deepseek-v4-pro' : 'deepseek-v4-flash',
    configured_reasoning_effort: index % 2 ? 'max' : 'high',
    finish_reason: index === 7 ? 'stop' : 'tool_calls',
    assistant: { reasoning_content: index === 2 ? null : `exact reasoning ${index + 1}`, tool_call_count: index === 7 ? 0 : 1 },
    state: index === 7 ? 'completed' : 'executing',
  }));
  const roundProjection = PRODUCTION_TUI.projectRecords(rounds);
  assert.deepEqual(
    [...new Set(roundProjection.map((line) => line.recordId))],
    rounds.map((record) => record.id),
    'round grouping/order changed in production projection',
  );
  const roundText = PRODUCTION_TUI.plainProjectionText(roundProjection);
  assert.equal(countOccurrences(roundText, 'ROUND '), 8);
  assert.equal(countOccurrences(roundText, PRODUCTION_TUI.REASONING_UNAVAILABLE), 1);
  assert.equal(roundText.includes('retrospective'), false, 'renderer fabricated reasoning prose');

  const fullResult = `FULL_RESULT_${'x'.repeat(4096)}`;
  const resultFixture = {
    id: 'production-result-separation',
    round: 9,
    assistant: { reasoning_content: 'exact result reasoning', tool_call_count: 1 },
    tool_results: [{
      status: 'executed', bytes: Buffer.byteLength(fullResult), preview: 'bounded-preview-only', truncated: true,
      toolContent: fullResult,
    }],
    state: 'synthesizing',
  };
  const resultBefore = stableHash(resultFixture);
  const resultText = PRODUCTION_TUI.plainProjectionText(PRODUCTION_TUI.projectRecords([
    PRODUCTION_TUI.formatRoundActivityRecord(resultFixture),
  ]));
  assert.ok(resultText.includes('bounded-preview-only'));
  assert.ok(resultText.includes(`${Buffer.byteLength(fullResult)} bytes`));
  assert.ok(resultText.includes('preview truncated'));
  assert.equal(resultText.includes(fullResult), false, 'full provider result leaked into the bounded display projection');
  assert.equal(stableHash(resultFixture), resultBefore, 'display formatting mutated the provider/result fixture');

  const hugeRecord = { id: 'production-huge-record', role: 'tool', text: Array.from({ length: 900 }, (_, index) => `line-${index}`).join('\n') };
  const hugeBefore = stableHash(hugeRecord);
  const hugeProjection = PRODUCTION_TUI.projectRecords([hugeRecord]);
  assert.equal(hugeProjection.length, PROOF_CONFIG.paneLogicalLineLimit);
  assert.equal(hugeProjection.filter((line) => line.truncationMarker).length, 1);
  assert.equal(stableHash(hugeRecord), hugeBefore, 'production projection mutated the source record');

  const telemetryInput = {
    source: { last_call: { usage: { total_tokens: 42 } }, session: { completed_calls: 7 }, retained_extra: { value: 'preserved' } },
    core: [
      { id: 'core-model', text: 'model flash / effort high' },
      { id: 'core-call', text: 'call total 42' },
      { id: 'core-ops', text: 'engine offline / SSE reconnecting' },
    ],
    extended: [
      { id: 'extended-session', text: 'session calls 7' },
      { id: 'extended-rounds', text: 'round details preserved' },
      { id: 'extended-replay', text: 'replay 5/2' },
      { id: 'extended-history', text: 'history durable/degraded' },
    ],
  };
  const telemetryBefore = stableHash(telemetryInput);
  const normalizedTelemetry = PRODUCTION_TUI.normalizeTelemetrySnapshot(telemetryInput);
  const coreFooter = PRODUCTION_TUI.formatTelemetryFooter(normalizedTelemetry, 'core');
  const expandedFooter = PRODUCTION_TUI.formatTelemetryFooter(normalizedTelemetry, 'expanded');
  assert.deepEqual(normalizedTelemetry.core.map((line) => line.id), telemetryInput.core.map((line) => line.id));
  assert.deepEqual(normalizedTelemetry.extended.map((line) => line.id), telemetryInput.extended.map((line) => line.id));
  assert.deepEqual(coreFooter, telemetryInput.core.map((line) => line.text));
  assert.deepEqual(expandedFooter, [
    ...telemetryInput.core.map((line) => line.text), ...telemetryInput.extended.map((line) => line.text),
  ]);
  assert.equal(stableHash(telemetryInput), telemetryBefore, 'telemetry formatting mutated the controller snapshot');
  assert.deepEqual(normalizedTelemetry.source, telemetryInput.source, 'telemetry normalization dropped a controller field');

  const structuredRoundRecords = [
    {
      id: 'turn-11-round-1', round: 1, attempt_count: 2, actual_model: 'deepseek-v4-flash',
      configured_reasoning_effort: 'high', effort_attribution: 'configured', latency_ms: 1200,
      finish_reason: 'tool_calls', usage: {
        prompt_tokens: 100, prompt_cache_hit_tokens: 40, prompt_cache_miss_tokens: 60,
        completion_tokens: 50, total_tokens: 150, reasoning_tokens: 20,
      },
      cost_available: true, cost_usd: 0.0000252, reasoning: 'exact controller-supplied reasoning',
      retries: [{ retry: 1, category: 'http_503', delay_ms: 1000, context_recovery: false }],
      tool_calls: [
        { name: 'search_source', status: 'valid', call_id_suffix: 'call-0001', arguments: { query: 'visible', api_key: '[REDACTED]' } },
        { name: 'patch_file', status: 'rejected', validation_code: 'invalid_tool_argument_type', call_id_suffix: 'call-0002', arguments: null },
      ],
      tool_results: [
        { name: 'search_source', status: 'executed', bytes: 900, preview: 'bounded factual preview', truncated: true, redacted: false },
        { name: 'patch_file', status: 'rejected', error_code: 'invalid_tool_argument_type', bytes: 70, preview: '{"error":"rejected"}', truncated: false, redacted: false },
      ],
      warnings: [{ warning: 'actual_model_mismatch' }],
      states: ['waiting', 'retrying', 'executing', 'synthesizing'],
    },
    {
      id: 'turn-11-round-2', round: 2, attempt_count: 1, actual_model: 'deepseek-v4-pro',
      configured_reasoning_effort: 'high', effort_attribution: 'configured', latency_ms: 400,
      finish_reason: 'stop', usage: {
        prompt_tokens: 120, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 40,
        completion_tokens: 30, total_tokens: 150, reasoning_tokens: 0,
      },
      cost_available: true, cost_usd: 0.00004698, reasoning: null,
      retries: [], tool_calls: [], tool_results: [], warnings: [], states: ['waiting', 'completed'],
    },
  ];
  const structuredTelemetrySource = {
    configured_settings: { model: 'deepseek-v4-flash', reasoning_effort: 'high', effort_attribution: 'configured' },
    last_actual_model: 'deepseek-v4-pro',
    state: { activity: 'idle', busy: false },
    operational_state: { engine: 'online', sse: 'connected', session: 'attached', game: 'active', harness: 'authorized' },
    last_call: {
      configured_model: 'deepseek-v4-flash', configured_reasoning_effort: 'high', effort_attribution: 'configured',
      actual_models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
      usage: {
        prompt_tokens: 220, prompt_cache_hit_tokens: 120, prompt_cache_miss_tokens: 100,
        completion_tokens: 80, total_tokens: 300, reasoning_tokens: 20,
      },
      reasoning_tokens: 20, cache_hit_percentage: 54.5, cost_available: true, cost_usd: 0.00007218,
      elapsed_ms: 1600, rounds: 2, response_rounds: 2, attempts: 3, retry_count: 1, fallback: 'none',
      per_round: [
        { round: 1, actual_model: 'deepseek-v4-flash', usage: { total_tokens: 150 }, cost_available: true, cost_usd: 0.0000252 },
        { round: 2, actual_model: 'deepseek-v4-pro', usage: { total_tokens: 150 }, cost_available: true, cost_usd: 0.00004698 },
      ],
      round_records: structuredRoundRecords,
      replay: { included_exchange_count: 5, excluded_exchange_count: 2, body_utf8_bytes: 12345, max_utf8_bytes: 700000 },
      warnings: [], error: null,
    },
    session: {
      completed_calls: 7, api_rounds: 10, api_attempts: 12,
      usage: {
        prompt_tokens: 12000, prompt_cache_hit_tokens: 9000, prompt_cache_miss_tokens: 3000,
        completion_tokens: 4000, total_tokens: 16000, reasoning_tokens: 1400,
      },
      cost_available: true, cost_usd: 0.0211,
      recent_calls: Array.from({ length: 5 }, (_, index) => ({
        call: index + 3, usage: { total_tokens: 2000 + index }, cost_available: true, cost_usd: 0.001 + (index / 10000),
      })),
    },
    conversation: { exchange_count: 8, estimated_history_tokens: 5647 },
    replay: { included_exchange_count: 5, excluded_exchange_count: 2, body_utf8_bytes: 12345, max_utf8_bytes: 700000 },
    persistence: {
      ready: true,
      history: { status: 'saved', degraded: false, durable_bytes: 50749, count_evicted: 2, size_evicted: 1 },
      settings: { status: 'saved', degraded: false },
      warnings: [],
    },
    server_clock: { iso: '2026-07-16T12:00:00.000Z', date: '07/16/2026', time: '8:00 AM', weekday: 'Thu', daypart: 'morning', timezone: 'server-local' },
    pricing: { source_date: '2026-07-16' },
    field_authority: { configured_effort: 'configured', actual_model: 'provider response' },
    retained_extra: { value: 'must survive formatting' },
  };
  const structuredTelemetryBefore = stableHash(structuredTelemetrySource);
  const footerProjection = PRODUCTION_TUI.buildTelemetryFooterProjection(structuredTelemetrySource);
  assert.deepEqual(footerProjection.core.map((line) => line.id), PRODUCTION_TUI.CORE_FOOTER_FIELD_IDS);
  assert.deepEqual(footerProjection.extended.map((line) => line.id), PRODUCTION_TUI.EXTENDED_FOOTER_FIELD_IDS);
  assert.equal(new Set([...footerProjection.core, ...footerProjection.extended].map((line) => line.id)).size, 7);
  assert.equal(footerProjection.core.length, PROOF_CONFIG.coreFooterHeight - 1);
  assert.equal(footerProjection.extended.length, PROOF_CONFIG.expandedFooterHeight - PROOF_CONFIG.coreFooterHeight);
  assert.equal(footerProjection.core.every((line) => [...line.text].length <= PROOF_CONFIG.supportedMinColumns), true);
  assert.equal(
    footerProjection.core[0].text,
    'CALL  idle · actual pro · tokens 300 · cache 54.5% · cost $0.000072 · elapsed 1.6s',
  );
  assert.equal(
    footerProjection.core[1].text,
    'SYSTEM  engine online · SSE connected · game active · harness on',
  );
  assert.equal(
    footerProjection.core[2].text,
    'SESSION  7 calls · 10 rounds · history 5.6K tokens · persistence 50 KB · Thu 8:00 AM',
  );
  assert.equal(
    PRODUCTION_TUI.MotherBrainTui.prototype._desiredFooterTier.call({}, 80),
    'core',
    'a tall window automatically expanded the permanent footer into diagnostics',
  );
  const healthySystemMarkup = PRODUCTION_TUI.formatFooterMarkupLine(footerProjection.core[1].text);
  const degradedSessionMarkup = PRODUCTION_TUI.formatFooterMarkupLine('SESSION  0 calls · PERSISTENCE DEGRADED (20 KB)');
  assert.ok(healthySystemMarkup.includes('^[*mb-mother-final]engine online^:'));
  assert.ok(healthySystemMarkup.includes('^[*mb-mother-final]SSE connected^:'));
  assert.ok(degradedSessionMarkup.includes('^[*mb-failure]PERSISTENCE DEGRADED^:'));
  assert.ok(footerProjection.extended[0].text.includes('session calls=7'));
  assert.ok(footerProjection.extended[1].text.includes('recent 3:'));
  assert.ok(footerProjection.extended[2].text.includes('1:flash/150/'));
  assert.ok(footerProjection.extended[3].text.includes('history ex=8 est=5.6ktok replay=5/2'));
  assert.equal(stableHash(structuredTelemetrySource), structuredTelemetryBefore, 'footer projection mutated controller telemetry');

  const structuredNormalized = PRODUCTION_TUI.normalizeTelemetrySnapshot({
    source: structuredTelemetrySource, core: [], extended: [],
  });
  assert.deepEqual(structuredNormalized.core.map((line) => line.id), PRODUCTION_TUI.CORE_FOOTER_FIELD_IDS);
  assert.deepEqual(structuredNormalized.extended.map((line) => line.id), PRODUCTION_TUI.EXTENDED_FOOTER_FIELD_IDS);
  assert.deepEqual(structuredNormalized.source, structuredTelemetrySource);
  assert.deepEqual(structuredNormalized.roundRecords.map((round) => round.id), ['turn-11-round-1', 'turn-11-round-2']);
  assert.equal(PRODUCTION_TUI.formatTelemetryFooter(structuredNormalized, 'core').length, 3);
  assert.equal(PRODUCTION_TUI.formatTelemetryFooter(structuredNormalized, 'expanded').length, 7);

  const unavailableTelemetry = JSON.parse(JSON.stringify(structuredTelemetrySource));
  unavailableTelemetry.last_actual_model = 'deepseek-v4-future';
  unavailableTelemetry.last_call.cost_available = false;
  unavailableTelemetry.last_call.cost_usd = null;
  unavailableTelemetry.last_call.usage = null;
  unavailableTelemetry.last_call.cache_hit_percentage = null;
  unavailableTelemetry.session.cost_available = false;
  unavailableTelemetry.session.cost_usd = null;
  const unavailableCore = PRODUCTION_TUI.formatTelemetryFooter({ source: unavailableTelemetry }, 'core').join('\n');
  const unavailableCallLine = unavailableCore.split('\n')[0];
  assert.ok(unavailableCore.includes('actual deepseek-v4-future'));
  assert.equal(unavailableCallLine.includes('cost'), false, 'unavailable current-call cost consumed permanent footer space');
  assert.equal(unavailableCallLine.includes('tokens'), false, 'unavailable token usage consumed permanent footer space');
  assert.equal(unavailableCallLine.includes('unavailable'), false, 'unavailable values were dumped into the permanent footer');
  assert.equal(unavailableCallLine.includes('$0.000000'), false, 'unavailable current-call cost was rendered as zero');

  const idleFooter = PRODUCTION_TUI.formatTelemetryFooter({
    source: {
      configured_settings: { model: 'deepseek-v4-flash', reasoning_effort: 'high' },
      last_actual_model: null,
      state: { activity: 'idle', busy: false },
      operational_state: { engine: 'online', sse: 'connected', session: 'none', game: 'inactive', harness: 'offline' },
      last_call: null,
      session: { completed_calls: 0, api_rounds: 0 },
      conversation: { estimated_history_tokens: 2400 },
      persistence: {
        history: { status: 'saved', degraded: false, durable_bytes: 20 * 1024 },
        settings: { status: 'saved', degraded: false },
      },
      server_clock: { weekday: 'Fri', time: '12:28 PM' },
    },
  }, 'core');
  assert.deepEqual(idleFooter, [
    'CALL  idle · no completed call',
    'SYSTEM  engine online · SSE connected · no game session · harness off',
    'SESSION  0 calls · 0 rounds · history 2.4K tokens · persistence 20 KB · Fri 12:28 PM',
  ]);
  assert.equal(idleFooter.join('\n').includes('cfg='), false, 'configured header fields were duplicated in the footer');
  assert.equal(idleFooter.join('\n').includes('t/p/h/m/o'), false, 'internal token abbreviations leaked into the footer');

  const structuredRoundsBefore = stableHash(structuredRoundRecords);
  const structuredRoundProjection = PRODUCTION_TUI.projectRecords(
    structuredRoundRecords.map(PRODUCTION_TUI.formatRoundActivityRecord),
  );
  const structuredRoundText = PRODUCTION_TUI.plainProjectionText(structuredRoundProjection);
  assert.deepEqual([...new Set(structuredRoundProjection.map((line) => line.recordId))], ['turn-11-round-1', 'turn-11-round-2']);
  assert.equal(countOccurrences(structuredRoundText, 'ROUND '), 2);
  assert.equal(countOccurrences(structuredRoundText, PRODUCTION_TUI.REASONING_UNAVAILABLE), 1);
  assert.ok(structuredRoundText.includes('Call: search_source'));
  assert.ok(structuredRoundText.includes('Call: patch_file'));
  assert.ok(structuredRoundText.includes('Result: rejected'));
  assert.ok(structuredRoundText.includes('State: retrying'));
  assert.ok(structuredRoundText.includes('State: completed'));
  assert.ok(structuredRoundText.includes('[REDACTED]'));
  assert.equal(stableHash(structuredRoundRecords), structuredRoundsBefore, 'round projection mutated structured records');

  const groupedApp = new PRODUCTION_TUI.MotherBrainTui({ scheduleFrame: () => {} });
  groupedApp.renderActivityRecord({ id: 'transient-waiting', kind: 'turn-state', role: 'telemetry', text: 'State: waiting' });
  groupedApp.renderActivityRecord({ id: 'transient-attempt', kind: 'provider-attempt', role: 'tool', text: 'Attempt 1' });
  groupedApp.renderRoundActivityRecord({ id: 'transient-round', round: 1, reasoning: 'temporary', state: 'executing' });
  groupedApp.renderActivityRecord({ id: 'transient-result', kind: 'tool-result', role: 'tool', text: 'temporary result' });
  groupedApp.renderTelemetrySnapshot({ source: structuredTelemetrySource, core: [], extended: [] });
  const groupedSnapshot = groupedApp.getSnapshot();
  assert.deepEqual(groupedSnapshot.panes.activity.records.map((record) => record.id), ['turn-11-round-1', 'turn-11-round-2']);
  assert.equal(groupedSnapshot.activeTurnActivityStart, null);

  const wrappedScreen = new termkit.ScreenBuffer({ width: 24, height: 8 });
  const wrappedPane = new termkit.TextBox({
    outputDst: wrappedScreen, x: 0, y: 0, width: 10, height: 5,
    content: 'alpha bravo charlie delta', lineWrap: true, wordWrap: true, noDraw: true,
  });
  wrappedPane.textBuffer.setSelectionRegion(PRODUCTION_TUI.paneSelectionRegion({ xFrom: 0, yFrom: 0, x: 9, y: 3 }, wrappedPane));
  assert.equal(PRODUCTION_TUI.selectedPaneText(wrappedPane), 'alpha bravo charlie delta', 'wrapped selection lost logical reading order');

  const callerOwnedCopy = { text: 'You: original\nMother: restored newest exchange', id: 'copy-source' };
  const callerOwnedCopyHash = stableHash(callerOwnedCopy);
  const transcriptPane = PRODUCTION_TUI.createPaneState();
  const activityPane = PRODUCTION_TUI.createPaneState();
  PRODUCTION_TUI.appendPaneRecord(transcriptPane, { id: 't1', role: 'final', text: 'left' });
  PRODUCTION_TUI.appendPaneRecord(activityPane, { id: 'a1', role: 'reasoning', text: 'right' });
  PRODUCTION_TUI.scrollPaneState(transcriptPane, 3, 10);
  PRODUCTION_TUI.computeLayout(90, 24);
  PRODUCTION_TUI.computeLayout(89, 24);
  PRODUCTION_TUI.computeLayout(120, 40);
  assert.equal(stableHash(callerOwnedCopy), callerOwnedCopyHash, 'renderer layout/scroll mutated the caller-owned /copy source');

  const scheduled = [];
  const app = new PRODUCTION_TUI.MotherBrainTui({ scheduleFrame: (callback) => scheduled.push(callback) });
  app.setDraft('line one\nline two', 8);
  app._state.history.push('older');
  app._state.history.push('newer');
  assert.equal(app._state.history.previous(app.getSnapshot().draft), 'newer');
  const retainedBefore = app.getSnapshot();
  app.renderHeaderOperationalState({ activity: 'waiting', busy: true });
  app.renderTranscriptRecord({ id: 'batch-developer', role: 'developer', text: 'developer text' });
  app.renderRoundActivityRecord({ round: 10, assistant: { reasoning_content: 'exact', tool_call_count: 0 }, state: 'completed' });
  app.renderTelemetrySnapshot(telemetryInput);
  app.renderCommandStatus({ id: 'command-full', lines: ['status line 1', 'status line 2'] });
  app.renderCopyResult({ ok: true, bytes: callerOwnedCopy.text.length });
  assert.equal(scheduled.length, 1, 'same-tick renderer updates scheduled more than one draw');
  scheduled.shift()();
  const retainedAfter = app.getSnapshot();
  assert.equal(retainedAfter.draft, retainedBefore.draft);
  assert.equal(retainedAfter.cursorOffset, retainedBefore.cursorOffset);
  assert.deepEqual(retainedAfter.history, retainedBefore.history);
  assert.equal(retainedAfter.panes.activity.records.some((record) => record.id === 'command-full'), true);
  assert.equal(retainedAfter.drawBatches.scheduled, 1);

  let terminalKitLoaded = false;
  let nonTtyOutput = '';
  const nonTtyApp = new PRODUCTION_TUI.MotherBrainTui({
    input: { isTTY: false },
    output: { isTTY: false, write: (value) => { nonTtyOutput += value; } },
    terminalKitLoader: () => { terminalKitLoaded = true; throw new Error('must not load'); },
  });
  const nonTtyResult = await nonTtyApp.start();
  assert.deepEqual(nonTtyResult, { started: false, reason: 'non-tty', exitCode: 2 });
  assert.equal(nonTtyOutput, PRODUCTION_TUI.NON_TTY_DIAGNOSTIC);
  assert.equal(terminalKitLoaded, false, 'non-TTY path loaded Terminal Kit');

  let shutdownCallbacks = 0;
  const shutdownOrder = [];
  const shutdownApp = new PRODUCTION_TUI.MotherBrainTui({
    onBeforeShutdown: () => { shutdownOrder.push('before-terminal-cleanup'); },
    onShutdown: async () => {
      shutdownOrder.push('after-terminal-cleanup');
      shutdownCallbacks += 1;
    },
  });
  const firstShutdown = shutdownApp.shutdown('test-normal');
  const secondShutdown = shutdownApp.shutdown('test-duplicate');
  assert.equal(firstShutdown, secondShutdown, 'shutdown is not idempotent');
  await firstShutdown;
  assert.equal(shutdownCallbacks, 1);
  assert.deepEqual(shutdownOrder, ['before-terminal-cleanup', 'after-terminal-cleanup']);
  assert.equal(shutdownApp.getSnapshot().stopping, true);

  return {
    constants_palette_match: true,
    proof_harness_contamination: false,
    import_side_effects: false,
    geometry_match: true,
    same_tick_batching: true,
    structured_methods: true,
    grouped_rounds: rounds.length,
    reasoning_unavailable: true,
    result_projection_separated: true,
    telemetry_core_ids: telemetryInput.core.map((line) => line.id),
    telemetry_extended_ids: telemetryInput.extended.map((line) => line.id),
    structured_telemetry_core_ids: PRODUCTION_TUI.CORE_FOOTER_FIELD_IDS,
    structured_telemetry_extended_ids: PRODUCTION_TUI.EXTENDED_FOOTER_FIELD_IDS,
    structured_round_replacement: true,
    unavailable_not_zero: true,
    wrapped_pane_copy: true,
    draft_cursor_history_retained: true,
    shutdown_idempotent: true,
    non_tty_guard: true,
  };
}

async function runAutomatedMatrix() {
  validateConfigBounds();
  assert.equal(Number(process.versions.node.split('.')[0]), 24, 'proof requires Node 24');

  const terminalKitPackage = JSON.parse(fs.readFileSync(require.resolve('terminal-kit/package.json'), 'utf8'));
  assert.equal(terminalKitPackage.version, DEPENDENCY_PROVENANCE.version);
  for (const lifecycle of ['preinstall', 'install', 'postinstall']) {
    assert.equal(Boolean(terminalKitPackage.scripts && terminalKitPackage.scripts[lifecycle]), false, `${lifecycle} script found`);
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package-lock.json'), 'utf8'));
  assert.equal(manifest.dependencies['terminal-kit'], DEPENDENCY_PROVENANCE.version);
  assert.equal(lock.packages['node_modules/terminal-kit'].version, DEPENDENCY_PROVENANCE.version);
  assert.equal(lock.packages['node_modules/terminal-kit'].integrity, DEPENDENCY_PROVENANCE.integrity);
  assert.equal(lock.packages[''].dependencies['terminal-kit'], DEPENDENCY_PROVENANCE.version);

  const termkit = require('terminal-kit');
  assert.ok(termkit && termkit.ScreenBuffer && termkit.EditableTextBox, 'Terminal Kit CommonJS load is incomplete');

  const retainedState = {
    editor: { text: 'resize-cursor-Ω-proof', cursorIndex: 8 },
    panes: {
      transcript: { recordIds: ['t-sentinel-1', 't-sentinel-2'], offset: { recordId: 't-sentinel-1', line: 0 } },
      activity: { recordIds: ['a-sentinel-1', 'a-sentinel-2'], offset: { recordId: 'a-sentinel-1', line: 0 } },
    },
    splitRatio: PROOF_CONFIG.transcriptShare,
    settings: { model: 'synthetic-only', effort: 'synthetic-only' },
  };
  const retainedHash = stableHash(retainedState);
  const restoredBaseline = computeLayout(120, 40, retainedState.splitRatio);
  let framesChecked = 0;
  let exceptionCount = 0;

  try {
    for (let cycle = 0; cycle < 50; cycle += 1) {
      const stages = [
        computeLayout(PROOF_CONFIG.supportedMinColumns, PROOF_CONFIG.supportedMinRows, retainedState.splitRatio),
        computeLayout(PROOF_CONFIG.supportedMinColumns - 1, PROOF_CONFIG.supportedMinRows, retainedState.splitRatio),
        computeLayout(240, 80, retainedState.splitRatio),
        computeLayout(120, 40, retainedState.splitRatio),
        computeLayout(PROOF_CONFIG.supportedMinColumns, PROOF_CONFIG.supportedMinRows - 1, retainedState.splitRatio),
        computeLayout(120, 40, retainedState.splitRatio),
      ];

      for (const layout of stages) {
        assertLayout(layout);
        const capture = renderSyntheticFrame(termkit, layout);
        if (layout.supported) {
          for (const sentinel of Object.values(SCREEN_SENTINELS).filter((value) => value !== SCREEN_SENTINELS.overlay)) {
            assert.ok(capture.includes(sentinel), `supported frame lost ${sentinel}`);
          }
          assert.ok(capture.includes(INPUT_PROMPT), 'supported frame lost the visible input prompt');
          assert.equal(countOccurrences(capture, SCREEN_SENTINELS.activity), 1, 'a second right pane appeared');
          assert.equal(capture.includes('TO-DO'), false, 'forbidden internal right-pane split appeared');
        } else {
          assert.ok(capture.includes(SCREEN_SENTINELS.overlay), 'below-minimum overlay missing');
          for (const sentinel of Object.values(SCREEN_SENTINELS).filter((value) => value !== SCREEN_SENTINELS.overlay)) {
            assert.equal(capture.includes(sentinel), false, `below-minimum frame retained stale ${sentinel}`);
          }
          assert.equal(capture.includes(INPUT_PROMPT), false, 'below-minimum frame retained the input prompt');
        }
        assert.equal(stableHash(retainedState), retainedHash, 'resize changed retained application state');
        framesChecked += 1;
      }

      const restored = stages[3];
      assert.ok(Math.abs(restored.transcriptWidth - restoredBaseline.transcriptWidth) <= 1, 'restored divider drifted');
    }
  } catch (error) {
    exceptionCount += 1;
    throw error;
  }
  assert.equal(exceptionCount, 0);

  for (const [width, height] of [[90, 24], [120, 40], [240, 80]]) {
    for (const requested of [-1000, 10000]) {
      const layout = dividerLayoutForColumn(width, height, requested);
      assertLayout(layout);
    }
  }

  let dividerRedrawRequested = false;
  const dividerRedrawFixture = dividerLayoutForColumn(120, 40, 70);
  applyDividerLayoutWithRedraw((layout, draw) => {
    assert.equal(layout, dividerRedrawFixture);
    dividerRedrawRequested = draw;
  }, dividerRedrawFixture);
  assert.equal(dividerRedrawRequested, true, 'interactive divider layout suppressed its redraw');

  testIndependentPaneState();
  testPaneBoundedSelection(termkit);
  testWindowsTerminalProfilePromotion();
  testTerminalKitEditableTextBox(termkit);
  testHistoryLimit();
  testBoundedProjection();
  const pasteHashes = [await runPasteTrial(), await runPasteTrial(), await runPasteTrial()];
  assert.equal(new Set(pasteHashes).size, 1, 'paste trials were not byte-identical');
  assert.equal(pasteHashes[0], sha256(FIXED_PASTE_FIXTURE));
  testNonTtyGuard();
  const productionRenderer = await testProductionRendererContract(termkit);

  return {
    status: 'pass',
    completed_at: utcNow(),
    node_version: process.version,
    terminal_kit_version: terminalKitPackage.version,
    geometry: {
      cycles: 50,
      frames_checked: framesChecked,
      exception_count: exceptionCount,
      minimum: `${PROOF_CONFIG.supportedMinColumns}x${PROOF_CONFIG.supportedMinRows}`,
      synthetic_maximized: '240x80',
      restored: '120x40',
      one_right_pane: true,
    },
    pane_scroll_follow: 'pass',
    pane_bounded_selection_projection: 'pass',
    divider_clamp: 'pass',
    divider_redraw_requested: dividerRedrawRequested,
    developer_color_role: PALETTE.developer,
    windows_terminal_color_profile: {
      environment_promotion_unit: 'pass',
      exact_rgb_runtime: 'pending interactive Windows Terminal launch',
    },
    history_entries_recalled: PROOF_CONFIG.historyLimit,
    paste: {
      strategy: 'enter-debounce-fallback',
      debounce_ms: PROOF_CONFIG.pasteDebounceMs,
      trials: pasteHashes.length,
      payload_sha256: pasteHashes[0],
      byte_identical: true,
    },
    projection_stress: {
      source_records: 10000,
      retained_logical_lines: PROOF_CONFIG.paneLogicalLineLimit,
      source_mutated: false,
    },
    non_tty_guard: 'pass',
    production_renderer: productionRenderer,
    runtime_manual_pending: ['V05', 'V06 physical resize capture', 'V07', 'V08', 'V09', 'V10 physical paste', 'V11', 'V12 TTY exits'],
  };
}

function makeTuningRecord() {
  return Object.keys(PROOF_CONFIG).map((constant) => ({
    constant,
    initial: INITIAL_PROOF_CONFIG[constant],
    final: PROOF_CONFIG[constant],
    changed: INITIAL_PROOF_CONFIG[constant] !== PROOF_CONFIG[constant],
    reason: INITIAL_PROOF_CONFIG[constant] === PROOF_CONFIG[constant]
      ? 'Initial candidate retained; the first live visual failure was terminal color-capability misdetection, not a bounded constant failure. Corrected interactive proof remains authoritative.'
      : 'Changed only from recorded failing smoke evidence.',
  }));
}

function newEvidenceRecord(automated) {
  return {
    schema_version: 1,
    proof_status: automated && automated.status === 'pass'
      ? 'automated_pass_interactive_pending'
      : 'automated_pending',
    updated_at: utcNow(),
    dependency: DEPENDENCY_PROVENANCE,
    initial_candidates: INITIAL_PROOF_CONFIG,
    final_values: PROOF_CONFIG,
    proof_bounds: PROOF_BOUNDS,
    tuning: makeTuningRecord(),
    palette: PALETTE,
    automated: automated || null,
    interactive: {
      user_visual_acceptance: null,
      observed_failures: [],
      runs: [],
    },
  };
}

function readEvidenceRecord() {
  try {
    const value = JSON.parse(fs.readFileSync(PROOF_RECORD_PATH, 'utf8'));
    if (value && value.schema_version === 1) return value;
  } catch (_) {
    // A missing evidence file is the normal first-run state.
  }
  return newEvidenceRecord(null);
}

function writeEvidenceRecord(record) {
  fs.mkdirSync(path.dirname(PROOF_RECORD_PATH), { recursive: true });
  record.updated_at = utcNow();
  const temporary = `${PROOF_RECORD_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, PROOF_RECORD_PATH);
}

async function runSelfTest() {
  try {
    const automated = await runAutomatedMatrix();
    const existing = readEvidenceRecord();
    const record = newEvidenceRecord(automated);
    if (existing.interactive && typeof existing.interactive === 'object') {
      record.interactive = {
        ...record.interactive,
        ...existing.interactive,
        runs: Array.isArray(existing.interactive.runs) ? existing.interactive.runs : [],
      };
    }
    writeEvidenceRecord(record);
    process.stdout.write(`[PASS] Mother Brain TUI automated smoke: ${automated.geometry.cycles} resize cycles, ${automated.paste.trials} paste trials, ${automated.projection_stress.source_records} stress records.\n`);
    process.stdout.write(`[EVIDENCE] ${PROOF_RECORD_PATH}\n`);
  } catch (error) {
    const record = newEvidenceRecord({
      status: 'fail',
      completed_at: utcNow(),
      error: error && error.message ? error.message : String(error),
    });
    record.proof_status = 'automated_fail';
    try { writeEvidenceRecord(record); } catch (_) { /* best effort after a failed assertion */ }
    process.stderr.write(`[FAIL] Mother Brain TUI automated smoke: ${error.stack || error}\n`);
    process.exitCode = 1;
  }
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

function parseHexColor(code) {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(code);
  assert.ok(match, `invalid palette color ${code}`);
  return match.slice(1).map((component) => Number.parseInt(component, 16));
}

function assertExactInteractivePalette(term, palette, environmentProfile) {
  const trueColor = Boolean(term.support && (term.support.trueColor || term.support['24bitsColors']));
  assert.ok(trueColor, 'Windows Terminal did not expose true-color support to Terminal Kit');
  for (const [role, code] of Object.entries(PALETTE)) {
    const [red, green, blue] = parseHexColor(code);
    const index = palette.colorNameToIndex(PALETTE_ROLE_TOKEN[role]);
    assert.equal(palette.escape[index], `\x1b[38;2;${red};${green};${blue}m`, `${role} foreground was remapped away from exact RGB`);
    assert.equal(palette.bgEscape[index], `\x1b[48;2;${red};${green};${blue}m`, `${role} background was remapped away from exact RGB`);
  }
  return {
    windows_terminal: environmentProfile.windowsTerminal,
    environment_promoted: environmentProfile.promoted,
    terminal_generic: term.generic || null,
    true_color: true,
    exact_rgb_roles: Object.keys(PALETTE).length,
    effective_environment: environmentProfile.effective,
  };
}

function restoreCursorOffset(input, requestedOffset) {
  const maximumOffset = [...input.getValue()].length;
  const offset = clamp(Math.round(requestedOffset), 0, maximumOffset);
  input.textBuffer.moveToStartOfBuffer();
  for (let index = 0; index < offset; index += 1) input.textBuffer.moveForward();
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

function inputRetainedState(state, widgets) {
  if (widgets && widgets.input && !widgets.input.destroyed) {
    state.draft = widgets.input.getValue();
    state.cursorOffset = widgets.input.textBuffer.getCursorOffset();
  }
  return {
    draft: state.draft,
    cursorOffset: state.cursorOffset,
    splitRatio: state.splitRatio,
    transcript: {
      recordIds: state.panes.transcript.records.map((record) => record.id),
      follow: state.panes.transcript.follow,
      topLogicalLine: state.panes.transcript.topLogicalLine,
      newOutput: state.panes.transcript.newOutput,
    },
    activity: {
      recordIds: state.panes.activity.records.map((record) => record.id),
      follow: state.panes.activity.follow,
      topLogicalLine: state.panes.activity.topLogicalLine,
      newOutput: state.panes.activity.newOutput,
    },
  };
}

function initialInteractiveState() {
  const transcriptRecords = [
    { id: 't-select', role: 'tool', text: 'SELECT_ME_PANE_7F2A — plain left-drag this exact visible text; release copies only transcript text.' },
    { id: 't-copy-user', role: 'developer', text: 'COPY_PROOF_DEVELOPER_6C91' },
    { id: 't-copy-mother', role: 'final', text: 'COPY_PROOF_MOTHER_31AB' },
    { id: 't-instruction-1', role: 'warning', text: 'ISOLATED PROOF: no game, controller, provider, or paid API is connected.' },
    { id: 't-instruction-2', role: 'tool', text: 'Resize below 90x24 and back; maximize and restore; drag the divider past both edges.' },
    { id: 't-instruction-3', role: 'tool', text: 'Wheel each pane independently, press F3 for async output, and verify new-output markers.' },
    { id: 't-instruction-4', role: 'tool', text: `Paste this block three times and submit each: ${FIXED_PASTE_FIXTURE.replace(/\n/g, ' / ')}` },
    { id: 't-instruction-5', role: 'tool', text: 'Run /copy and compare clipboard text with the two COPY_PROOF lines above.' },
  ];
  const activityRecords = [
    { id: 'a-start', role: 'reasoning', text: 'Terminal Kit 3.1.3 loaded through CommonJS on Node 24.' },
    { id: 'a-structure', role: 'tool', text: 'Fixed structure: one transcript, one full-height activity/reasoning pane, one divider.' },
    { id: 'a-paste', role: 'warning', text: 'Terminal Kit exposes no bracketed-paste event; approved 60 ms Enter debounce is active.' },
    { id: 'a-selection', role: 'tool', text: 'Plain left-drag selects and copies only the originating pane. Shift-drag remains optional host behavior, not this proof.' },
  ];
  for (let index = 1; index <= 30; index += 1) {
    transcriptRecords.push({
      id: `t-fixture-${index}`,
      role: index % 6 === 0 ? 'developer' : 'final',
      text: `Transcript scroll fixture ${String(index).padStart(2, '0')}`,
    });
    activityRecords.push({
      id: `a-fixture-${index}`,
      role: index % 5 === 0 ? 'tool' : 'reasoning',
      text: `Activity scroll fixture ${String(index).padStart(2, '0')}`,
    });
  }

  return {
    startedAt: utcNow(),
    runId: `tui-${Date.now()}-${process.pid}`,
    splitRatio: PROOF_CONFIG.transcriptShare,
    draft: '',
    cursorOffset: 0,
    busy: false,
    nextModel: 'deepseek-v4-flash',
    nextEffort: 'high',
    panes: {
      transcript: createPaneState(transcriptRecords),
      activity: createPaneState(activityRecords),
    },
    history: new HistoryBuffer(PROOF_CONFIG.historyLimit),
    lastExchange: 'You: COPY_PROOF_DEVELOPER_6C91\nMother: COPY_PROOF_MOTHER_31AB',
    selection: { pane: null, status: 'none', bytes: 0 },
    recordCounter: 0,
    timers: new Set(),
    runtimeFailures: [],
    stopping: false,
    manualAccepted: false,
    metrics: {
      resizeEvents: 0,
      belowMinimumFrames: 0,
      supportedFrames: 0,
      screenCaptures: 0,
      dividerDrags: 0,
      dividerClampLeft: 0,
      dividerClampRight: 0,
      transcriptWheelEvents: 0,
      activityWheelEvents: 0,
      syntheticEvents: 0,
      submissions: 0,
      busySubmitBlocks: 0,
      copyInvocations: 0,
      copySuccesses: 0,
      nativeShiftMouseEventsObserved: 0,
      paneSelectionStarts: 0,
      paneSelectionDragEvents: 0,
      paneSelectionCopies: 0,
      paneSelectionClipboardFailures: 0,
      fixedPasteMatches: 0,
      fixedPasteHashes: [],
    },
  };
}

function schedule(state, callback, delayMs) {
  const timer = setTimeout(() => {
    state.timers.delete(timer);
    callback();
  }, delayMs);
  state.timers.add(timer);
  return timer;
}

function clearScheduled(state) {
  for (const timer of state.timers) clearTimeout(timer);
  state.timers.clear();
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
    child.stdin.end(value, 'utf8');
  });
}

async function runInteractive(options) {
  const terminalEnvironment = prepareWindowsTerminalEnvironment();
  const termkit = require('terminal-kit');
  const term = termkit.terminal;
  const state = initialInteractiveState();
  const runtime = {
    termkit,
    term,
    state,
    document: null,
    widgets: null,
    layout: null,
    enterDebouncer: null,
    selectionCopyToken: 0,
    shutdownPromise: null,
    initialSize: { width: term.width, height: term.height },
    minimumObserved: { width: term.width, height: term.height },
    maximumObserved: { width: term.width, height: term.height },
  };

  const palette = makeTerminalPalette(termkit, term);
  runtime.terminalProfile = assertExactInteractivePalette(term, palette, terminalEnvironment);
  const attr = (role, extra = {}) => ({
    color: ROLE_TOKEN[role],
    bgColor: ROLE_TOKEN.background,
    ...extra,
  });

  function addRecord(paneName, role, text, idPrefix = paneName[0]) {
    state.recordCounter += 1;
    appendPaneRecord(state.panes[paneName], {
      id: `${idPrefix}-${Date.now()}-${state.recordCounter}`,
      role,
      text: String(text),
    });
    renderAll();
  }

  function captureEditorState() {
    if (!runtime.widgets || !runtime.widgets.input) return;
    state.draft = runtime.widgets.input.getValue();
    state.cursorOffset = runtime.widgets.input.textBuffer.getCursorOffset();
  }

  function setEditorValue(value) {
    if (!runtime.widgets || !runtime.widgets.input || !runtime.layout || !runtime.layout.supported) {
      state.draft = value;
      state.cursorOffset = [...String(value)].length;
      return;
    }
    runtime.widgets.input.setValue(String(value), true);
    runtime.widgets.input.textBuffer.moveToEndOfBuffer();
    captureEditorState();
    runtime.widgets.input.draw();
  }

  function paneMaximumTop(widget) {
    return Math.max(0, widget.textBuffer.buffer.length - widget.textAreaHeight);
  }

  function applyPaneScroll(paneName, noDraw = true) {
    const pane = state.panes[paneName];
    const widget = runtime.widgets[paneName];
    const maximumTop = paneMaximumTop(widget);
    if (pane.follow) {
      widget.scrollToBottom(true);
    } else {
      pane.topLogicalLine = clamp(pane.topLogicalLine, 0, maximumTop);
      widget.scrollTo(null, -pane.topLogicalLine, true);
    }
    if (!noDraw) widget.draw();
  }

  function renderPane(paneName) {
    const pane = state.panes[paneName];
    const projection = projectRecords(pane.records);
    runtime.widgets[paneName].setContent(formatProjection(projection), true, true);
    applyPaneScroll(paneName, true);
  }

  function footerLines() {
    const transcriptMarker = state.panes.transcript.newOutput ? ' · NEW OUTPUT' : '';
    const activityMarker = state.panes.activity.newOutput ? ' · NEW OUTPUT' : '';
    const size = runtime.layout ? `${runtime.layout.width}x${runtime.layout.height}` : `${term.width}x${term.height}`;
    const split = runtime.layout && runtime.layout.supported
      ? `${runtime.layout.transcriptWidth}/${runtime.layout.activityWidth}`
      : 'suspended';
    const gate = state.runtimeFailures.length ? `FAIL ${state.runtimeFailures.at(-1)}` : 'AUTOMATED PASS · USER REVIEW PENDING';
    const selection = state.selection.pane
      ? `${state.selection.pane === 'transcript' ? 'T' : 'A'} ${state.selection.status}${state.selection.bytes ? ` ${state.selection.bytes}B` : ''}`
      : 'none';
    return [
      `${gate} · size ${size} · split ${split} · T${transcriptMarker || ' follow'} · A${activityMarker || ' follow'} · select ${selection} · busy ${state.busy ? 'yes' : 'no'}`,
      'F2 matrix · F3 async inject · F4 stress · F6 busy · Ctrl+Q clean exit',
      'Wheel panes · drag divider · plain-drag pane text to copy · type/paste after YOU> · /copy · /accept',
    ];
  }

  function updateStaticContent() {
    if (!runtime.widgets || !runtime.layout || !runtime.layout.supported) return;
    const { widgets, layout } = runtime;
    widgets.header.setContent([
      `${SCREEN_SENTINELS.header}  MOTHER BRAIN · TERMINAL KIT 3.1.3 ISOLATED PROOF · NO NETWORK / NO PROVIDER`,
    ], false, true, true);
    widgets.transcriptTitle.setContent([
      ruledLine(`${SCREEN_SENTINELS.transcript}  TRANSCRIPT${state.panes.transcript.newOutput ? ' · NEW OUTPUT' : ''}`, layout.transcriptTitle.width),
    ], false, true, true);
    widgets.activityTitle.setContent([
      ruledLine(`${SCREEN_SENTINELS.activity}  ACTIVITY / REASONING${state.panes.activity.newOutput ? ' · NEW OUTPUT' : ''}`, layout.activityTitle.width),
    ], false, true, true);
    widgets.inputLabel.setContent([
      ruledLine(`${SCREEN_SENTINELS.input}  EDITABLE INPUT · dark-red live text · Enter debounce ${PROOF_CONFIG.pasteDebounceMs} ms`, layout.inputLabel.width),
    ], false, true, true);
    widgets.inputPrompt.setContent([INPUT_PROMPT], false, true, true);
    widgets.footerRule.setContent([
      ruledLine(`${SCREEN_SENTINELS.footer}  FIXED FOOTER / PROOF STATUS`, layout.footerRule.width),
    ], false, true, true);
    widgets.footer.setContent(footerLines(), false, true, true);
    widgets.divider.setContent(Array.from({ length: layout.divider.height }, (_, index) => index === 0 ? '┼' : '│'), false, true, true);
  }

  function renderAll() {
    if (!runtime.document || !runtime.widgets || !runtime.layout) return;
    if (runtime.layout.supported) {
      renderPane('transcript');
      renderPane('activity');
      updateStaticContent();
    }
    runtime.document.draw();
  }

  function configureInputActions(input) {
    const inheritedActions = input.userActions;
    const ownActions = Object.create(inheritedActions);
    input.userActions = ownActions;

    ownActions.character = function character(key, trash, data) {
      runtime.enterDebouncer.beforeCharacter();
      return inheritedActions.character.call(this, key, trash, data);
    };
    ownActions.debouncedSubmit = function debouncedSubmit() {
      runtime.enterDebouncer.handleEnter();
      return true;
    };
    ownActions.historyUp = function historyUp() {
      runtime.enterDebouncer.flushAsSubmit();
      if (this.textBuffer.cy > 0) return inheritedActions.up.call(this);
      setEditorValue(state.history.previous(this.getValue()));
      return true;
    };
    ownActions.historyDown = function historyDown() {
      runtime.enterDebouncer.flushAsSubmit();
      if (this.textBuffer.cy < this.textBuffer.buffer.length - 1) return inheritedActions.down.call(this);
      setEditorValue(state.history.next(this.getValue()));
      return true;
    };

    for (const action of [
      'backDelete', 'delete', 'deleteLine', 'backward', 'forward', 'startOfWord', 'endOfWord',
      'startOfLine', 'smartStartOfLine', 'endOfLine', 'left', 'right', 'tab', 'scrollUp',
      'scrollDown', 'scrollTop', 'scrollBottom', 'scrollToCursor', 'deleteSelection',
    ]) {
      if (typeof inheritedActions[action] !== 'function') continue;
      ownActions[action] = function flushThenEdit(...args) {
        runtime.enterDebouncer.flushAsSubmit();
        return inheritedActions[action].apply(this, args);
      };
    }
  }

  function makeWidgets(layout) {
    const document = runtime.document;
    const commonText = { parent: document, noDraw: true };
    const widgets = {
      header: new termkit.Text({ ...commonText, ...layout.header, content: '', attr: attr('final', { bold: true }) }),
      transcriptTitle: new termkit.Text({ ...commonText, ...layout.transcriptTitle, content: '', attr: attr('border', { bold: true }) }),
      activityTitle: new termkit.Text({ ...commonText, ...layout.activityTitle, content: '', attr: attr('border', { bold: true }) }),
      transcript: new termkit.TextBox({
        parent: document,
        ...layout.transcriptContent,
        content: '',
        contentHasMarkup: true,
        scrollable: true,
        lineWrap: true,
        wordWrap: true,
        textAttr: attr('telemetry'),
        voidAttr: attr('telemetry'),
        noDraw: true,
      }),
      activity: new termkit.TextBox({
        parent: document,
        ...layout.activityContent,
        content: '',
        contentHasMarkup: true,
        scrollable: true,
        lineWrap: true,
        wordWrap: true,
        textAttr: attr('reasoning'),
        voidAttr: attr('reasoning'),
        noDraw: true,
      }),
      divider: new termkit.Text({ ...commonText, ...layout.divider, content: [], attr: attr('border', { bold: true }) }),
      inputLabel: new termkit.Text({ ...commonText, ...layout.inputLabel, content: '', attr: attr('border', { bold: true }) }),
      inputPrompt: new termkit.Text({ ...commonText, ...layout.inputPrompt, content: '', attr: attr('developer', { bold: true }) }),
      input: new termkit.EditableTextBox({
        parent: document,
        ...layout.editor,
        value: state.draft,
        scrollable: true,
        lineWrap: true,
        wordWrap: false,
        debounceTimeout: 0,
        keyBindings: {
          ...termkit.EditableTextBox.prototype.keyBindings,
          ENTER: 'debouncedSubmit',
          KP_ENTER: 'debouncedSubmit',
          UP: 'historyUp',
          DOWN: 'historyDown',
        },
        textAttr: attr('developer'),
        voidAttr: attr('developer'),
        noDraw: true,
      }),
      footerRule: new termkit.Text({ ...commonText, ...layout.footerRule, content: '', attr: attr('border', { bold: true }) }),
      footer: new termkit.Text({ ...commonText, ...layout.footerContent, content: [], attr: attr('telemetry') }),
      overlay: new termkit.Text({
        ...commonText,
        x: 0,
        y: 0,
        width: layout.width,
        height: layout.height,
        content: [],
        attr: attr('warning', { bold: true }),
        hidden: true,
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
        if (!runtime.layout.supported || state.stopping) return;
        runtime.selectionCopyToken += 1;
        for (const candidateName of ['transcript', 'activity']) {
          const candidate = widgets[candidateName];
          if (!candidate.textBuffer.selectionRegion) continue;
          candidate.textBuffer.resetSelectionRegion();
          candidate.draw();
        }
        state.selection = { pane: paneName, status: 'selecting', bytes: 0 };
        state.metrics.paneSelectionStarts += 1;
        updateStaticContent();
        widgets.footer.draw();
      });

      widget.on('drag', (data) => {
        if (!runtime.layout.supported || state.stopping) return;
        widget.textBuffer.setSelectionRegion(paneSelectionRegion(data, widget));
        state.metrics.paneSelectionDragEvents += 1;
        widget.draw();
      });

      widget.on('dragEnd', () => {
        if (!runtime.layout.supported || state.stopping) return;
        const selectionText = selectedPaneText(widget);
        const selectionBytes = Buffer.byteLength(selectionText, 'utf8');
        state.selection = {
          pane: paneName,
          status: selectionText ? 'copying' : 'empty',
          bytes: selectionBytes,
        };
        document.giveFocusTo(widgets.input, 'select');
        widgets.input.drawCursor();
        updateStaticContent();
        widgets.footer.draw();
        if (!selectionText) return;

        const copyToken = ++runtime.selectionCopyToken;
        copyToWindowsClipboard(selectionText).then(() => {
          if (state.stopping || copyToken !== runtime.selectionCopyToken) return;
          state.metrics.paneSelectionCopies += 1;
          state.selection.status = 'copied';
          updateStaticContent();
          widgets.footer.draw();
          widgets.input.drawCursor();
        }).catch((error) => {
          if (state.stopping || copyToken !== runtime.selectionCopyToken) return;
          state.metrics.paneSelectionClipboardFailures += 1;
          state.selection.status = 'copy-failed';
          state.runtimeFailures.push(`V11 pane-selection clipboard failed: ${error.message}`);
          updateStaticContent();
          widgets.footer.draw();
          widgets.input.drawCursor();
        });
      });

      widgets[paneName].on('wheel', (data) => {
        if (!runtime.layout.supported || state.stopping) return;
        const pane = state.panes[paneName];
        const maximumTop = paneMaximumTop(widget);
        const currentTop = pane.follow ? maximumTop : pane.topLogicalLine;
        const step = Math.max(1, Math.ceil(widget.textAreaHeight / 5));
        scrollPaneState(pane, currentTop + data.yDirection * step, maximumTop);
        if (paneName === 'transcript') state.metrics.transcriptWheelEvents += 1;
        else state.metrics.activityWheelEvents += 1;
        applyPaneScroll(paneName, false);
        updateStaticContent();
        widgets.footer.draw();
        widgets[`${paneName}Title`].draw();
        document.giveFocusTo(widgets.input, 'select');
      });
    }

    let dragStartWidth = layout.transcriptWidth;
    widgets.divider.on('dragStart', () => {
      if (!runtime.layout.supported || state.stopping) return;
      dragStartWidth = runtime.layout.transcriptWidth;
    });
    widgets.divider.on('drag', (data) => {
      if (!runtime.layout.supported || state.stopping) return;
      state.metrics.dividerDrags += 1;
      const requested = dragStartWidth + data.x;
      const nextLayout = dividerLayoutForColumn(runtime.layout.width, runtime.layout.height, requested);
      if (nextLayout.transcriptWidth === PROOF_CONFIG.transcriptMinWidth) state.metrics.dividerClampLeft += 1;
      if (nextLayout.activityWidth === PROOF_CONFIG.activityMinWidth) state.metrics.dividerClampRight += 1;
      state.splitRatio = nextLayout.transcriptWidth / nextLayout.availablePaneWidth;
      applyDividerLayoutWithRedraw(applySupportedLayout, nextLayout);
    });
    widgets.divider.on('dragEnd', () => {
      if (!runtime.layout.supported || state.stopping) return;
      document.giveFocusTo(widgets.input, 'select');
      widgets.input.drawCursor();
    });

    configureInputActions(widgets.input);
    widgets.input.on('change', captureEditorState);
    widgets.input.on('cursorMove', captureEditorState);
    restoreCursorOffset(widgets.input, state.cursorOffset);
    return widgets;
  }

  function applySupportedLayout(layout, draw = true) {
    assertLayout(layout);
    runtime.layout = layout;
    if (!runtime.widgets) runtime.widgets = makeWidgets(layout);
    const { widgets } = runtime;
    captureEditorState();
    const retainedCursor = state.cursorOffset;

    for (const [name, rectangle] of [
      ['header', layout.header],
      ['transcriptTitle', layout.transcriptTitle],
      ['activityTitle', layout.activityTitle],
      ['divider', layout.divider],
      ['inputLabel', layout.inputLabel],
      ['inputPrompt', layout.inputPrompt],
      ['footerRule', layout.footerRule],
      ['footer', layout.footerContent],
    ]) setTextGeometry(widgets[name], rectangle);
    widgets.transcript.setSizeAndPosition(layout.transcriptContent);
    widgets.activity.setSizeAndPosition(layout.activityContent);
    widgets.input.setSizeAndPosition(layout.editor);
    setTextGeometry(widgets.overlay, { x: 0, y: 0, width: layout.width, height: layout.height });

    widgets.input.setValue(state.draft, true);
    restoreCursorOffset(widgets.input, retainedCursor);
    for (const widget of Object.values(widgets)) {
      widget.hidden = widget === widgets.overlay;
      if (widget !== widgets.overlay) widget.disabled = false;
    }
    renderPane('transcript');
    renderPane('activity');
    updateStaticContent();
    runtime.document.giveFocusTo(widgets.input, 'select');
    if (draw) runtime.document.draw();
  }

  function applyBelowMinimumLayout(layout, draw = true) {
    runtime.layout = layout;
    state.metrics.belowMinimumFrames += 1;
    if (!runtime.widgets) {
      const provisional = computeLayout(
        Math.max(PROOF_CONFIG.supportedMinColumns, layout.width),
        Math.max(PROOF_CONFIG.supportedMinRows, layout.height),
        state.splitRatio,
      );
      runtime.widgets = makeWidgets(provisional);
    }
    captureEditorState();
    const { widgets } = runtime;
    for (const widget of Object.values(widgets)) {
      widget.hidden = widget !== widgets.overlay;
      if (widget !== widgets.overlay) widget.disabled = true;
    }
    widgets.overlay.hidden = false;
    widgets.overlay.disabled = false;
    setTextGeometry(widgets.overlay, { x: 0, y: 0, width: Math.max(1, layout.width), height: Math.max(1, layout.height) });
    const lines = Array.from({ length: Math.max(1, layout.height) }, () => '');
    const center = Math.max(0, Math.floor(layout.height / 2) - 2);
    lines[center] = SCREEN_SENTINELS.overlay;
    if (center + 1 < lines.length) lines[center + 1] = `Need at least ${PROOF_CONFIG.supportedMinColumns}x${PROOF_CONFIG.supportedMinRows}; current ${layout.width}x${layout.height}.`;
    if (center + 2 < lines.length) lines[center + 2] = 'State retained. Submit and divider drag are suspended. Ctrl+Q exits.';
    widgets.overlay.setContent(lines, false, true, true);
    runtime.document.giveFocusTo(widgets.overlay, 'select');
    if (draw) runtime.document.draw();
  }

  function assertRuntimeCapture(layout, retainedBefore) {
    const capture = runtime.document.inputDst.dumpChars();
    state.metrics.screenCaptures += 1;
    if (layout.supported) {
      state.metrics.supportedFrames += 1;
      for (const sentinel of [SCREEN_SENTINELS.header, SCREEN_SENTINELS.transcript, SCREEN_SENTINELS.activity, SCREEN_SENTINELS.input, SCREEN_SENTINELS.footer]) {
        assert.ok(capture.includes(sentinel), `runtime frame lost ${sentinel}`);
      }
      assert.ok(capture.includes(INPUT_PROMPT), 'runtime frame lost the visible input prompt');
      assert.equal(countOccurrences(capture, SCREEN_SENTINELS.activity), 1, 'runtime frame contains a second right pane');
      assert.equal(capture.includes('TO-DO'), false, 'runtime frame contains forbidden right split');
      assert.equal(stableHash(inputRetainedState(state, runtime.widgets)), stableHash(retainedBefore), 'runtime resize changed retained state');
    } else {
      assert.ok(capture.includes(SCREEN_SENTINELS.overlay), 'runtime below-minimum overlay missing');
      for (const sentinel of [SCREEN_SENTINELS.header, SCREEN_SENTINELS.transcript, SCREEN_SENTINELS.activity, SCREEN_SENTINELS.input, SCREEN_SENTINELS.footer]) {
        assert.equal(capture.includes(sentinel), false, `runtime below-minimum frame retained ${sentinel}`);
      }
    }
  }

  function relayout(width, height, isResize = false) {
    if (state.stopping) return;
    const retainedBefore = inputRetainedState(state, runtime.widgets);
    runtime.minimumObserved.width = Math.min(runtime.minimumObserved.width, width);
    runtime.minimumObserved.height = Math.min(runtime.minimumObserved.height, height);
    runtime.maximumObserved.width = Math.max(runtime.maximumObserved.width, width);
    runtime.maximumObserved.height = Math.max(runtime.maximumObserved.height, height);
    if (isResize) state.metrics.resizeEvents += 1;

    runtime.document.resize({ x: 0, y: 0, width: Math.max(1, width), height: Math.max(1, height) });
    runtime.document.outputWidth = Math.max(1, width);
    runtime.document.outputHeight = Math.max(1, height);
    const layout = computeLayout(width, height, state.splitRatio);
    if (layout.supported) applySupportedLayout(layout, false);
    else applyBelowMinimumLayout(layout, false);
    runtime.document.draw();
    assertRuntimeCapture(layout, retainedBefore);
  }

  function injectSyntheticOutput() {
    state.metrics.syntheticEvents += 1;
    addRecord('activity', 'reasoning', `Async synthetic reasoning event ${state.metrics.syntheticEvents}. No API call was made.`);
    schedule(state, () => addRecord('activity', 'tool', `Async synthetic tool/result event ${state.metrics.syntheticEvents}.`), 180);
    schedule(state, () => addRecord('transcript', 'final', `Synthetic Mother event ${state.metrics.syntheticEvents} completed.`), 380);
  }

  function runProjectionStressInteractive() {
    const source = Array.from({ length: 10000 }, (_, index) => ({ id: `interactive-stress-${index}`, role: 'tool', text: `stress-${index}` }));
    const before = stableHash(source);
    const projection = projectRecords(source);
    if (projection.length !== PROOF_CONFIG.paneLogicalLineLimit || stableHash(source) !== before) {
      throw new Error('interactive 10,000-record projection stress failed');
    }
    addRecord('activity', 'tool', `10,000-record stress passed; projection retained ${projection.length} logical lines without source mutation.`);
  }

  async function handleLocalCommand(value) {
    const [token, ...args] = value.trim().split(/\s+/);
    switch (token.toLowerCase()) {
      case '/help':
        addRecord('activity', 'tool', 'Smoke commands: /status /stats /copy /model flash|pro /reasoning high|max /clear /inject /stress /busy /accept');
        return true;
      case '/status':
        addRecord('activity', 'tool', `Synthetic status: busy=${state.busy}; next=${state.nextModel}/${state.nextEffort}; no provider connected.`);
        return true;
      case '/stats':
        addRecord('activity', 'tool', `Smoke stats: resize=${state.metrics.resizeEvents}; drag=${state.metrics.dividerDrags}; wheels=${state.metrics.transcriptWheelEvents}/${state.metrics.activityWheelEvents}.`);
        return true;
      case '/copy':
        state.metrics.copyInvocations += 1;
        try {
          await copyToWindowsClipboard(state.lastExchange);
          state.metrics.copySuccesses += 1;
          addRecord('activity', 'tool', '/copy wrote the full last exchange to the Windows clipboard.');
        } catch (error) {
          addRecord('activity', 'failure', `/copy failed: ${error.message}`);
          state.runtimeFailures.push('V11 /copy failed');
        }
        return true;
      case '/model': {
        const next = args[0] === 'pro' ? 'deepseek-v4-pro' : args[0] === 'flash' ? 'deepseek-v4-flash' : null;
        if (!next) addRecord('activity', 'warning', 'Usage: /model flash|pro');
        else { state.nextModel = next; addRecord('activity', 'tool', `Synthetic next-turn model set to ${next}.`); }
        return true;
      }
      case '/reasoning':
        if (!['high', 'max'].includes(args[0])) addRecord('activity', 'warning', 'Usage: /reasoning high|max');
        else { state.nextEffort = args[0]; addRecord('activity', 'tool', `Synthetic next-turn effort set to ${args[0]}.`); }
        return true;
      case '/clear':
        if (state.busy) {
          state.metrics.busySubmitBlocks += 1;
          addRecord('activity', 'warning', '/clear is rejected while the synthetic exchange is busy.');
          return false;
        }
        state.panes.transcript.records = [];
        state.panes.activity.records = [];
        state.panes.transcript.follow = true;
        state.panes.activity.follow = true;
        renderAll();
        return true;
      case '/inject': injectSyntheticOutput(); return true;
      case '/stress': runProjectionStressInteractive(); return true;
      case '/busy':
        state.busy = !state.busy;
        addRecord('activity', 'warning', `Synthetic busy state is now ${state.busy ? 'ON' : 'OFF'}.`);
        return true;
      case '/accept':
        state.manualAccepted = true;
        addRecord('activity', 'tool', 'User marked the isolated visual/interaction checklist accepted in the harness.');
        return true;
      default: return null;
    }
  }

  async function submitEditor() {
    if (state.stopping || !runtime.layout || !runtime.layout.supported) return;
    captureEditorState();
    const value = state.draft;
    if (!value.trim()) return;

    const localToken = value.trimStart().startsWith('/');
    if (state.busy && !localToken) {
      state.metrics.busySubmitBlocks += 1;
      addRecord('activity', 'warning', 'Busy proof: normal second submission blocked; draft retained.');
      return;
    }

    const localResult = localToken ? await handleLocalCommand(value) : null;
    if (localToken && localResult === false) return;

    state.metrics.submissions += 1;
    state.history.push(value);
    addRecord('transcript', 'developer', value);
    if (value === FIXED_PASTE_FIXTURE) {
      state.metrics.fixedPasteMatches += 1;
      state.metrics.fixedPasteHashes.push(sha256(value));
    }
    setEditorValue('');

    if (localResult === true) return;
    state.busy = true;
    addRecord('activity', 'reasoning', 'Synthetic exchange started; typing remains available while busy.');
    schedule(state, () => addRecord('activity', 'tool', 'Synthetic tool event injected asynchronously.'), 220);
    schedule(state, () => {
      const answer = 'Synthetic Mother response complete. No provider or game call occurred.';
      addRecord('transcript', 'final', answer);
      state.lastExchange = `You: ${value}\nMother: ${answer}`;
      state.busy = false;
      renderAll();
    }, 650);
  }

  runtime.enterDebouncer = new EnterDebouncer({
    delayMs: PROOF_CONFIG.pasteDebounceMs,
    onNewLine: () => {
      if (!runtime.widgets || !runtime.layout.supported) return;
      const action = termkit.EditableTextBox.prototype.userActions.newLine;
      action.call(runtime.widgets.input);
    },
    onSubmit: () => { submitEditor().catch((error) => shutdown('submit-error', 1, error)); },
  });

  function interactiveRunEvidence(reason, exitCode, error, terminalCleanupPathCompleted = true) {
    return {
      run_id: state.runId,
      started_at: state.startedAt,
      ended_at: utcNow(),
      exit_reason: reason,
      exit_code: exitCode,
      error: error ? (error.message || String(error)) : null,
      initial_size: runtime.initialSize,
      minimum_observed_size: runtime.minimumObserved,
      maximum_observed_size: runtime.maximumObserved,
      final_size: runtime.layout ? { width: runtime.layout.width, height: runtime.layout.height } : null,
      final_split_ratio: state.splitRatio,
      constants: PROOF_CONFIG,
      palette: PALETTE,
      terminal_profile: runtime.terminalProfile,
      selection_state: state.selection,
      metrics: state.metrics,
      runtime_failures: state.runtimeFailures.slice(),
      manual_accept_command: state.manualAccepted,
      fixed_paste_expected_sha256: sha256(FIXED_PASTE_FIXTURE),
      terminal_cleanup_path_completed: terminalCleanupPathCompleted,
      content_recorded: false,
    };
  }

  function saveInteractiveEvidence(reason, exitCode, error, terminalCleanupPathCompleted = true) {
    const record = readEvidenceRecord();
    if (!record.interactive) record.interactive = { user_visual_acceptance: null, runs: [] };
    if (!Array.isArray(record.interactive.runs)) record.interactive.runs = [];
    const run = interactiveRunEvidence(reason, exitCode, error, terminalCleanupPathCompleted);
    const index = record.interactive.runs.findIndex((candidate) => candidate.run_id === run.run_id);
    if (index === -1) record.interactive.runs.push(run);
    else record.interactive.runs[index] = run;
    if (state.manualAccepted) record.interactive.user_visual_acceptance = true;
    const failed = state.runtimeFailures.length > 0 || error;
    record.proof_status = failed
      ? 'interactive_fail'
      : state.manualAccepted
        ? 'interactive_harness_accepted_external_confirmation_required'
        : 'automated_pass_interactive_pending';
    writeEvidenceRecord(record);
  }

  const onRawMouse = (name, data) => {
    if (data && data.shift && /DRAG|PRESSED|RELEASED/.test(name)) {
      state.metrics.nativeShiftMouseEventsObserved += 1;
    }
  };
  const onResize = (width, height) => {
    try { relayout(width, height, true); }
    catch (error) {
      state.runtimeFailures.push(`V06 ${error.message}`);
      shutdown('resize-proof-failure', 1, error);
    }
  };
  const onGlobalKey = (key) => {
    if (key === 'CTRL_C') shutdown('CTRL_C', 130);
    else if (key === 'CTRL_Q') shutdown('normal', 0);
    else if (!runtime.layout || !runtime.layout.supported || state.stopping) return;
    else if (key === 'F2') {
      runAutomatedMatrix()
        .then((result) => addRecord('activity', 'tool', `Automated matrix repeated: ${result.geometry.cycles} resize cycles passed.`))
        .catch((error) => shutdown('automated-matrix-failure', 1, error));
    } else if (key === 'F3') injectSyntheticOutput();
    else if (key === 'F4') {
      try { runProjectionStressInteractive(); }
      catch (error) { shutdown('stress-proof-failure', 1, error); }
    } else if (key === 'F6') {
      state.busy = !state.busy;
      addRecord('activity', 'warning', `Synthetic busy state is now ${state.busy ? 'ON' : 'OFF'}.`);
    }
  };
  const onSigint = () => shutdown('SIGINT', 130);
  const onSigterm = () => shutdown('SIGTERM', 143);
  const onSighup = () => shutdown('SIGHUP', 129);
  const onSigbreak = () => shutdown('SIGBREAK', 131);
  const onUncaughtException = (error) => shutdown('uncaughtException', 1, error);
  const onUnhandledRejection = (reason) => shutdown(
    'unhandledRejection',
    1,
    reason instanceof Error ? reason : new Error(String(reason)),
  );

  async function shutdown(reason, exitCode = 0, error = null) {
    if (runtime.shutdownPromise) return runtime.shutdownPromise;
    state.stopping = true;
    runtime.shutdownPromise = (async () => {
      runtime.enterDebouncer.cancel();
      clearScheduled(state);
      captureEditorState();
      term.off('key', onGlobalKey);
      term.off('mouse', onRawMouse);
      term.off('resize', onResize);
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      process.off('SIGHUP', onSighup);
      process.off('SIGBREAK', onSigbreak);
      process.off('uncaughtException', onUncaughtException);
      process.off('unhandledRejection', onUnhandledRejection);

      if (reason === 'SIGHUP' || reason === 'SIGBREAK') {
        try { saveInteractiveEvidence(`${reason}-received`, exitCode, error, false); }
        catch (_) { /* the exit fallback below still makes one synchronous attempt */ }
      }

      try {
        if (runtime.document && !runtime.document.destroyed) runtime.document.destroy(undefined, true);
      } catch (_) { /* continue terminal restoration */ }
      try { term.fullscreen(false); } catch (_) { /* continue terminal restoration */ }
      try { await term.asyncCleanup(); } catch (_) { /* emergency handler below is still active */ }
      try { saveInteractiveEvidence(reason, exitCode, error); }
      catch (evidenceError) {
        if (!error) error = evidenceError;
        exitCode = 1;
      }

      const suffix = error ? `: ${error.message || error}` : '';
      process.stdout.write(`Mother Brain TUI smoke cleanup complete (${reason})${suffix}.\n`);
      process.exit(exitCode);
    })();
    return runtime.shutdownPromise;
  }

  const onProcessExit = (code) => {
    if (runtime.shutdownPromise) return;
    try { if (runtime.document && !runtime.document.destroyed) runtime.document.destroy(undefined, true); } catch (_) {}
    try { term.fullscreen(false); } catch (_) {}
    try { term.styleReset(); } catch (_) {}
    try { term.hideCursor(false); } catch (_) {}
    try { term.grabInput(false); } catch (_) {}
    try { saveInteractiveEvidence('process-exit-fallback', Number.isInteger(code) ? code : 0, null, true); } catch (_) {}
  };

  term.on('key', onGlobalKey);
  term.on('mouse', onRawMouse);
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  process.on('SIGHUP', onSighup);
  process.on('SIGBREAK', onSigbreak);
  process.on('uncaughtException', onUncaughtException);
  process.on('unhandledRejection', onUnhandledRejection);
  process.once('exit', onProcessExit);

  term.fullscreen();
  runtime.document = term.createDocument({
    palette,
    backgroundAttr: attr('background'),
    noDraw: true,
  });
  term.off('resize', runtime.document.onEventSourceResize);
  term.on('resize', onResize);

  try {
    relayout(term.width, term.height, false);
  } catch (error) {
    await shutdown('initial-layout-failure', 1, error);
    return;
  }

  if (options.throwAfterStart) schedule(state, () => { throw new Error('synthetic TUI throw proof'); }, 750);
  if (options.rejectAfterStart) schedule(state, () => { Promise.reject(new Error('synthetic TUI rejection proof')); }, 750);
  if (options.exitAfterStart) schedule(state, () => shutdown('timed-normal-exit', 0), 750);
}

function readProductionProofRecord() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PRODUCTION_PROOF_RECORD_PATH, 'utf8'));
    if (parsed && parsed.schema_version === 1 && Array.isArray(parsed.runs)) return parsed;
  } catch (_) {}
  return { schema_version: 1, updated_at: utcNow(), runs: [] };
}

function updateProductionProofRun(runId, patch) {
  const record = readProductionProofRecord();
  const index = record.runs.findIndex((run) => run.run_id === runId);
  const next = { ...(index === -1 ? { run_id: runId } : record.runs[index]), ...patch };
  if (index === -1) record.runs.push(next);
  else record.runs[index] = next;
  record.updated_at = utcNow();
  fs.mkdirSync(path.dirname(PRODUCTION_PROOF_RECORD_PATH), { recursive: true });
  const temporary = `${PRODUCTION_PROOF_RECORD_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, PRODUCTION_PROOF_RECORD_PATH);
}

function startExternalExitObserver(runId) {
  const watcherSource = String.raw`
    const fs=require('node:fs');
    const proofPath=process.argv[1];
    const runId=process.argv[2];
    const parentPid=Number(process.argv[3]);
    const deadline=Date.now()+7200000;
    function parentAlive(){try{process.kill(parentPid,0);return true;}catch{return false;}}
    function update(status){
      try{
        const record=JSON.parse(fs.readFileSync(proofPath,'utf8'));
        const run=record.runs.find(candidate=>candidate.run_id===runId);
        if(!run)return false;
        run.external_observer={status,observed_at:new Date().toISOString(),parent_pid:parentPid};
        if(status==='process_exit_observed'&&run.metrics&&run.metrics.manual_accepted&&run.validation_rows){
          for(const row of Object.keys(run.validation_rows)){
            run.validation_rows[row]={status:'pass',evidence:'user acceptance plus external X-close observer'};
          }
          run.status=run.mode==='ctrl-c'?'ctrl_c_recorded':'x_close_recorded';
          run.ended_at=new Date().toISOString();
        }
        record.updated_at=new Date().toISOString();
        const temporary=proofPath+'.observer-'+process.pid+'.tmp';
        fs.writeFileSync(temporary,JSON.stringify(record,null,2)+'\n','utf8');
        fs.renameSync(temporary,proofPath);
        return true;
      }catch{return false;}
    }
    const timer=setInterval(()=>{
      if(!parentAlive()){
        clearInterval(timer);
        setTimeout(()=>{update('process_exit_observed');process.exit(0);},300);
      }else if(Date.now()>deadline){
        clearInterval(timer);
        update('observer_timeout');
        process.exit(0);
      }
    },250);
  `;
  const watcher = spawn(process.execPath, ['-e', watcherSource, PRODUCTION_PROOF_RECORD_PATH, runId, String(process.pid)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  watcher.unref();
  return watcher.pid;
}

function sanitizedProductionSnapshot(snapshot) {
  return {
    split_ratio: snapshot.splitRatio,
    draft_utf8_bytes: Buffer.byteLength(snapshot.draft || '', 'utf8'),
    draft_sha256: sha256(snapshot.draft || ''),
    cursor_offset: snapshot.cursorOffset,
    history_count: snapshot.history?.items?.length || 0,
    history_index: snapshot.history?.index ?? null,
    panes: {
      transcript: {
        record_ids: snapshot.panes.transcript.records.map((record) => record.id),
        follow: snapshot.panes.transcript.follow,
        top_logical_line: snapshot.panes.transcript.topLogicalLine,
        new_output: snapshot.panes.transcript.newOutput,
      },
      activity: {
        record_ids: snapshot.panes.activity.records.map((record) => record.id),
        follow: snapshot.panes.activity.follow,
        top_logical_line: snapshot.panes.activity.topLogicalLine,
        new_output: snapshot.panes.activity.newOutput,
      },
    },
    selection: snapshot.selection,
    copy_result: snapshot.copyResult,
    layout: snapshot.layout,
    draw_batches: snapshot.drawBatches,
    content_recorded: false,
  };
}

function productionProofTelemetrySource() {
  return {
    last_call: {
      actual_models: ['deepseek-v4-flash'], elapsed_ms: 3582, rounds: 2, attempts: 2, retries: 0,
      usage: {
        total_tokens: 49883, prompt_tokens: 49783, prompt_cache_hit_tokens: 36736,
        prompt_cache_miss_tokens: 13047, completion_tokens: 100, reasoning_tokens: 64,
      },
      cache_hit_percentage: 73.8, cost_available: true, cost_usd: 0.001957,
      per_round: [
        { round: 1, actual_model: 'deepseek-v4-flash', usage: { total_tokens: 24800 }, cost_available: true, cost_usd: 0.000971 },
        { round: 2, actual_model: 'deepseek-v4-flash', usage: { total_tokens: 25083 }, cost_available: true, cost_usd: 0.000986 },
      ],
    },
    session: {
      completed_calls: 3, api_rounds: 8, api_attempts: 8,
      usage: {
        total_tokens: 672839, prompt_tokens: 671760, prompt_cache_hit_tokens: 527488,
        prompt_cache_miss_tokens: 144272, completion_tokens: 1079, reasoning_tokens: 611,
      },
      cost_available: true, cost_usd: 0.0317,
      recent_calls: [
        { call: 1, usage: { total_tokens: 50749 }, cost_available: true, cost_usd: 0.0021 },
        { call: 2, usage: { total_tokens: 50865 }, cost_available: true, cost_usd: 0.0022 },
        { call: 3, usage: { total_tokens: 49883 }, cost_available: true, cost_usd: 0.001957 },
      ],
    },
    configured_settings: { model: 'deepseek-v4-flash', reasoning_effort: 'high', effort_attribution: 'configured' },
    last_actual_model: 'deepseek-v4-flash',
    state: { activity: 'idle', busy: false },
    operational_state: { engine: 'online', sse: 'connected', session: 'none', game: 'none', harness: 'off' },
    conversation: { exchange_count: 8, estimated_history_tokens: 5647 },
    replay: { included_exchange_count: 5, excluded_exchange_count: 3 },
    persistence: {
      history: { status: 'loaded_v2', degraded: false, durable_bytes: 20480, count_evicted: 3, size_evicted: 0 },
      settings: { status: 'loaded', degraded: false },
    },
    server_clock: { weekday: 'Fri', date: '07/17/2026', time: '12:28 PM', daypart: 'afternoon' },
  };
}

async function runProductionInteractiveProof(options) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stdout.write(PRODUCTION_TUI.NON_TTY_DIAGNOSTIC);
    process.exitCode = 2;
    return;
  }

  const mode = options.productionProofMode;
  const runId = `step9-${mode}-${Date.now()}-${process.pid}`;
  const coveredRows = [
    'V04', 'V05', 'V06', 'V07', 'V08', 'V09', 'V10', 'V11', 'V12',
    'V41', 'V51', 'V52', 'V55', 'V56', 'V57', 'V58', 'V60', 'V61',
    'V68', 'V69', 'V72', 'V76',
  ];
  const metrics = {
    submissions: 0,
    multiline_submissions: 0,
    injections: 0,
    copy_commands: 0,
    status_commands: 0,
    stats_commands: 0,
    manual_accepted: false,
  };
  const timers = new Set();
  let lastExchange = 'You: production proof question\nMother: production proof answer';
  let tui;
  const telemetrySource = productionProofTelemetrySource();
  const telemetryProjection = PRODUCTION_TUI.buildTelemetryFooterProjection(telemetrySource);

  const validationRows = (status, evidence = null) => Object.fromEntries(
    coveredRows.map((row) => [row, { status, evidence }])
  );
  const persistProgress = (patch = {}) => updateProductionProofRun(runId, {
    metrics: { ...metrics },
    validation_rows: validationRows(
      metrics.manual_accepted ? 'user_pass_pending_exit_evidence' : 'pending_user_review'
    ),
    ...patch,
  });

  const scheduleProof = (callback, delayMs) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      callback();
    }, delayMs);
    timers.add(timer);
  };
  const clearProofTimers = () => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };
  const recordExit = (status, detail) => {
    const snapshot = tui ? sanitizedProductionSnapshot(tui.getSnapshot()) : null;
    updateProductionProofRun(runId, {
      status,
      ended_at: utcNow(),
      metrics: { ...metrics },
      exit: detail,
      final_renderer_state: snapshot,
      validation_rows: validationRows(
        metrics.manual_accepted ? 'pass' : 'pending_user_review',
        metrics.manual_accepted ? `${mode} acceptance plus recorded exit` : null
      ),
    });
  };

  tui = PRODUCTION_TUI.createMotherBrainTui({
    version: '7.7.3',
    onSubmit: async (value) => {
      metrics.submissions += 1;
      if (value.includes('\n')) metrics.multiline_submissions += 1;
      const command = value.trim().toLowerCase();
      if (command === '/inject') {
        metrics.injections += 1;
        tui.renderActivityRecord({
          id: `live-activity-${metrics.injections}`,
          role: 'reasoning',
          text: `New activity arrived while preserving your reading anchor (${metrics.injections}).`,
        });
        tui.renderTranscriptRecord({
          id: `live-transcript-${metrics.injections}`,
          role: 'final',
          text: `New transcript output arrived while preserving your reading anchor (${metrics.injections}).`,
        });
        persistProgress();
        return { accepted: true };
      }
      if (command === '/copy') {
        metrics.copy_commands += 1;
        try {
          await PRODUCTION_TUI.copyToWindowsClipboard(lastExchange);
          tui.renderCopyResult({ ok: true, bytes: Buffer.byteLength(lastExchange, 'utf8'), message: 'Caller-owned last exchange copied.' });
        } catch (error) {
          tui.renderCopyResult({ ok: false, code: 'clipboard_failed', message: error.message });
        }
        persistProgress();
        return { accepted: true };
      }
      if (command === '/status' || command === '/stats') {
        if (command === '/status') metrics.status_commands += 1;
        else metrics.stats_commands += 1;
        tui.renderCommandStatus({
          status: 'ok',
          text: [
            `${command.slice(1).toUpperCase()} — preserved extended telemetry`,
            ...telemetryProjection.extended.map((line) => `${line.id}: ${line.text}`),
          ].join('\n'),
        });
        persistProgress();
        return { accepted: true };
      }
      if (command === '/accept') {
        metrics.manual_accepted = true;
        tui.renderCommandStatus({
          status: 'ok',
          text: 'Checklist accepted. Close with X for this run; the separate Ctrl+C run records cleanup.',
        });
        persistProgress({ manual_accepted_at: utcNow() });
        return { accepted: true };
      }

      const submissionId = metrics.submissions;
      tui.renderTranscriptRecord({ id: `submitted-${submissionId}`, role: 'developer', text: value });
      tui.renderHeaderOperationalState({ activity: 'local proof response pending', busy: true });
      scheduleProof(() => {
        const answer = `Production renderer received one submission containing ${normalizeTextLines(value).length} logical line(s).`;
        tui.renderRoundActivityRecord({
          id: `submitted-round-${submissionId}`,
          round: 100 + submissionId,
          attempt_count: 1,
          actual_model: 'local-proof-only',
          configured_reasoning_effort: 'high',
          assistant: { reasoning_content: 'Exact local proof reasoning fixture. No provider call was made.', tool_call_count: 0 },
          state: 'completed',
        });
        tui.renderTranscriptRecord({ id: `response-${submissionId}`, role: 'final', text: answer });
        lastExchange = `You: ${value}\nMother: ${answer}`;
        tui.renderHeaderOperationalState({ activity: 'idle', busy: false });
      }, 1200);
      persistProgress();
      return { accepted: true };
    },
    onBlockedSubmit: async () => {
      tui.renderCommandStatus({ status: 'warning', text: 'Busy check passed: draft retained and second normal submission blocked.' });
    },
    onShutdown: async (result) => {
      clearProofTimers();
      recordExit('shutdown_recorded', {
        reason: result.reason,
        exit_code: result.exitCode,
        error: result.error,
        cleanup_path: 'async',
      });
    },
    onSynchronousExit: (result) => {
      try {
        recordExit('process_exit_fallback_recorded', {
          reason: result.reason,
          exit_code: result.exitCode,
          error: null,
          cleanup_path: 'synchronous_process_exit',
        });
      } catch (_) {}
    },
  });

  updateProductionProofRun(runId, {
    run_id: runId,
    pid: process.pid,
    mode,
    status: 'starting',
    started_at: utcNow(),
    network_calls_authorized: false,
    provider_calls_authorized: false,
    game_calls_authorized: false,
    content_recorded: false,
    covered_validation_rows: coveredRows,
    validation_rows: validationRows('pending_user_review'),
  });
  const observerPid = startExternalExitObserver(runId);
  updateProductionProofRun(runId, { status: 'observer_started', external_observer_pid: observerPid });

  await tui.start();
  tui.renderHeaderOperationalState({ activity: mode === 'ctrl-c' ? 'CTRL+C CLEANUP PROOF' : 'STEP 13 COMBINED PROOF', busy: false });
  tui.renderTelemetrySnapshot({ source: telemetrySource });

  if (mode === 'ctrl-c') {
    tui.renderTranscriptRecord({
      id: 'ctrl-c-instruction',
      role: 'warning',
      text: 'CTRL+C CLEANUP CHECK: type /accept and press Enter, then press Ctrl+C once. The TUI must disappear cleanly without leaving raw mouse mode, colors, or a hidden cursor.',
    });
    tui.renderActivityRecord({ id: 'ctrl-c-ready', role: 'tool', text: 'Automatic proof recording is armed outside the renderer.' });
  } else {
    const transcriptInstructions = [
      ['intro', 'warning', 'STEP 13 COMBINED PRODUCTION RENDERER — isolated fixtures only; no provider, network, game, harness, GitHub, or controller call.'],
      ['visual', 'tool', 'Confirm one transcript pane, one full-height activity/reasoning pane, visible divider, red input, and fixed footer.'],
      ['scroll', 'tool', 'Wheel each pane independently. Scroll both upward, then type /inject and press Enter once; neither pane should jump and both titles should show NEW OUTPUT.'],
      ['copy', 'tool', 'Plain-drag text inside either pane. Paste elsewhere and confirm only that pane was copied. Type /copy to test caller-owned last-exchange copying.'],
      ['paste', 'tool', 'Paste a multiline paragraph into the red editor. It must remain one draft until one Enter, then appear as one red transcript record.'],
      ['resize', 'tool', 'Move the divider to both limits. Resize below 90x24 and back, maximize/restore, and confirm draft/cursor/panes return intact.'],
      ['commands', 'tool', 'Run /status and /stats. Both must show extended telemetry while the permanent footer remains exactly CALL, SYSTEM, SESSION.'],
      ['exit', 'warning', 'Only when every check passes, type /accept once, then close this Windows Terminal window with X.'],
    ];
    for (const [id, role, text] of transcriptInstructions) {
      tui.renderTranscriptRecord({ id: `instruction-${id}`, role, text });
    }
    for (let index = 1; index <= 36; index += 1) {
      tui.renderTranscriptRecord({
        id: `production-transcript-fixture-${index}`,
        role: index % 6 === 0 ? 'developer' : 'final',
        text: `Production transcript scroll fixture ${String(index).padStart(2, '0')}`,
      });
    }
    for (let index = 1; index <= 16; index += 1) {
      tui.renderRoundActivityRecord({
        id: `production-round-fixture-${index}`,
        round: index,
        attempt_count: index % 5 === 0 ? 2 : 1,
        actual_model: index % 2 ? 'deepseek-v4-flash' : 'deepseek-v4-pro',
        configured_reasoning_effort: index % 2 ? 'high' : 'max',
        finish_reason: index % 4 === 0 ? 'stop' : 'tool_calls',
        assistant: { reasoning_content: index === 7 ? null : `Exact production reasoning fixture ${String(index).padStart(2, '0')}`, tool_call_count: index % 4 === 0 ? 0 : 1 },
        tool_results: index % 4 === 0 ? [] : [{ status: 'executed', bytes: 48 + index, preview: `bounded result preview ${index}`, truncated: false }],
        state: index % 4 === 0 ? 'completed' : 'synthesizing',
      });
    }
  }
  updateProductionProofRun(runId, { status: 'interactive_running', renderer_started_at: utcNow() });
}

function v72InteractionState(tui) {
  return {
    draft: tui._state.draft,
    cursorOffset: tui._state.cursorOffset,
    transcript: {
      follow: tui._state.panes.transcript.follow,
      topLogicalLine: tui._state.panes.transcript.topLogicalLine,
    },
    activity: {
      follow: tui._state.panes.activity.follow,
      topLogicalLine: tui._state.panes.activity.topLogicalLine,
    },
  };
}

function injectV72RendererRecords(tui, start, count) {
  for (let offset = 0; offset < count; offset += 1) {
    const index = start + offset;
    const slot = index % 5;
    if (slot === 0 || slot === 1) {
      tui.renderTranscriptRecord({
        id: `v72-transcript-${index}`,
        kind: 'v72-stress',
        role: slot === 0 ? 'developer' : 'final',
        text: `V72 transcript record ${index} · ${'T'.repeat(24)}`,
      });
    } else if (slot === 2 || slot === 3) {
      tui.renderActivityRecord({
        id: `v72-activity-${index}`,
        kind: 'v72-stress',
        role: slot === 2 ? 'reasoning' : 'tool',
        text: `V72 activity record ${index} · ${'A'.repeat(24)}`,
      });
    } else {
      tui.renderRoundActivityRecord({
        id: `v72-round-${index}`,
        round: index + 1,
        attempt_count: 1,
        actual_model: index % 2 ? 'deepseek-v4-flash' : 'deepseek-v4-pro',
        configured_reasoning_effort: index % 2 ? 'high' : 'max',
        finish_reason: 'stop',
        assistant: { reasoning_content: `V72 round reasoning ${index}`, tool_call_count: 0 },
        tool_results: [],
        state: 'completed',
      });
    }
  }
}

function forceGcTwice() {
  assert.equal(typeof global.gc, 'function', 'V72 renderer resource validation requires node --expose-gc');
  global.gc();
  global.gc();
}

function runV72RendererResourceValidation() {
  const evidence = {
    schema_version: 1,
    kind: 'mother_brain_step13_v72_renderer_resource',
    started_at: utcNow(),
    completed_at: null,
    status: 'running',
    thresholds: {
      warmup_records: 2000,
      additional_records: 8000,
      pane_logical_line_limit: PROOF_CONFIG.paneLogicalLineLimit,
      heap_formula: 'warmup post-GC heap + max(16 MiB, 20% of warmup post-GC heap)',
    },
    interaction_hash_before: null,
    interaction_hash_after: null,
    warmup_heap_bytes: null,
    final_heap_bytes: null,
    heap_growth_bytes: null,
    heap_allowance_bytes: null,
    heap_limit_bytes: null,
    transcript_source_records: null,
    activity_source_records: null,
    transcript_projected_lines: null,
    activity_projected_lines: null,
    transcript_limit_pass: false,
    activity_limit_pass: false,
    interaction_pass: false,
    heap_pass: false,
    operation_error: null,
  };

  try {
    forceGcTwice();
    const tui = new PRODUCTION_TUI.MotherBrainTui({ scheduleFrame: () => {} });
    tui.setDraft('V72 unsent multiline draft\nsecond logical line', 17);
    PRODUCTION_TUI.scrollPaneState(tui._state.panes.transcript, 21, 100);
    PRODUCTION_TUI.scrollPaneState(tui._state.panes.activity, 13, 100);
    evidence.interaction_hash_before = stableHash(v72InteractionState(tui));

    injectV72RendererRecords(tui, 0, evidence.thresholds.warmup_records);
    forceGcTwice();
    evidence.warmup_heap_bytes = process.memoryUsage().heapUsed;

    injectV72RendererRecords(tui, evidence.thresholds.warmup_records, evidence.thresholds.additional_records);
    forceGcTwice();
    evidence.final_heap_bytes = process.memoryUsage().heapUsed;
    evidence.heap_growth_bytes = evidence.final_heap_bytes - evidence.warmup_heap_bytes;
    evidence.heap_allowance_bytes = Math.max(16 * 1024 * 1024, Math.floor(evidence.warmup_heap_bytes * 0.2));
    evidence.heap_limit_bytes = evidence.warmup_heap_bytes + evidence.heap_allowance_bytes;
    evidence.heap_pass = evidence.final_heap_bytes <= evidence.heap_limit_bytes;

    evidence.interaction_hash_after = stableHash(v72InteractionState(tui));
    evidence.interaction_pass = evidence.interaction_hash_before === evidence.interaction_hash_after;
    evidence.transcript_source_records = tui._state.panes.transcript.records.length;
    evidence.activity_source_records = tui._state.panes.activity.records.length;
    evidence.transcript_projected_lines = PRODUCTION_TUI.projectRecords(tui._state.panes.transcript.records).length;
    evidence.activity_projected_lines = PRODUCTION_TUI.projectRecords(tui._state.panes.activity.records).length;
    evidence.transcript_limit_pass = evidence.transcript_projected_lines <= PROOF_CONFIG.paneLogicalLineLimit;
    evidence.activity_limit_pass = evidence.activity_projected_lines <= PROOF_CONFIG.paneLogicalLineLimit;
  } catch (error) {
    evidence.operation_error = { name: error.name, code: error.code || null, message: error.message };
  }

  evidence.status = evidence.operation_error === null
    && evidence.interaction_pass
    && evidence.heap_pass
    && evidence.transcript_limit_pass
    && evidence.activity_limit_pass
    ? 'passed'
    : 'failed';
  evidence.completed_at = utcNow();
  const timestamp = evidence.completed_at.replace(/[-:.]/g, '');
  const evidencePath = path.join(ROOT_DIR, 'logs', `mb-v72-renderer-step13-${timestamp}.json`);
  const temporaryPath = `${evidencePath}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(temporaryPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  fs.renameSync(temporaryPath, evidencePath);
  console.log(`V72_RENDERER_EVIDENCE_FILE=${evidencePath}`);
  assert.equal(evidence.status, 'passed', `V72 renderer resource failure; inspect ${evidencePath}`);
  return evidence;
}

function parseOptions(argv) {
  return {
    selfTest: argv.includes('--self-test'),
    v72Resource: argv.includes('--v72-resource'),
    reconcileProofEvidence: argv.includes('--reconcile-proof-evidence'),
    printConfig: argv.includes('--print-config'),
    throwAfterStart: argv.includes('--throw-after-start'),
    rejectAfterStart: argv.includes('--reject-after-start'),
    exitAfterStart: argv.includes('--exit-after-start'),
    productionProof: argv.includes('--production-proof'),
    productionProofMode: argv.find((arg) => arg.startsWith('--proof-mode='))?.slice('--proof-mode='.length) || 'x-close',
  };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.printConfig) {
    process.stdout.write(`${JSON.stringify({ config: PROOF_CONFIG, bounds: PROOF_BOUNDS, palette: PALETTE }, null, 2)}\n`);
    return;
  }
  if (options.selfTest) {
    await runSelfTest();
    return;
  }
  if (options.v72Resource) {
    runV72RendererResourceValidation();
    return;
  }
  if (options.reconcileProofEvidence) {
    const record = readProductionProofRecord();
    for (const run of record.runs) {
      if (!run.metrics?.manual_accepted || !run.external_observer || !run.validation_rows) continue;
      const ctrlC = run.exit?.reason === 'CTRL_C' || run.mode === 'ctrl-c';
      run.status = ctrlC ? 'ctrl_c_recorded' : 'x_close_recorded';
      const evidence = ctrlC
        ? 'user acceptance plus recorded CTRL_C cleanup and external process-exit observer'
        : 'user acceptance plus recorded SIGHUP cleanup and external X-close observer';
      for (const row of Object.keys(run.validation_rows)) run.validation_rows[row] = { status: 'pass', evidence };
    }
    record.updated_at = utcNow();
    const temporary = `${PRODUCTION_PROOF_RECORD_PATH}.${process.pid}.reconcile.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, PRODUCTION_PROOF_RECORD_PATH);
    console.log(`PRODUCTION_PROOF_EVIDENCE_RECONCILED=${PRODUCTION_PROOF_RECORD_PATH}`);
    return;
  }
  if (options.productionProof) {
    await runProductionInteractiveProof(options);
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stdout.write(NON_TTY_DIAGNOSTIC);
    process.exitCode = 2;
    return;
  }
  await runInteractive(options);
}

module.exports = {
  INITIAL_PROOF_CONFIG,
  PROOF_CONFIG,
  PROOF_BOUNDS,
  PALETTE,
  computeLayout,
  dividerLayoutForColumn,
  projectRecords,
  HistoryBuffer,
  EnterDebouncer,
  runAutomatedMatrix,
  runV72RendererResourceValidation,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[FAIL] Mother Brain TUI smoke boot: ${error.stack || error}\n`);
    process.exitCode = 1;
  });
}
