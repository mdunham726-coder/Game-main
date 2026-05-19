const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'ContinuityBrain.js');
let content = fs.readFileSync(filePath, 'utf8');

// Find the location attributes section and add totalEnvFacts diagnostic passback
const oldBlock = `  // Location attributes — includes L0 cell attributes via locRecord fallback
  if (locRecord && locRecord.attributes && Object.keys(locRecord.attributes).length) {
    const locAttrs = Object.values(locRecord.attributes)
      .sort((x, y) => (y.turn_set || 0) - (x.turn_set || 0))
      .slice(0, ENV_ATTR_WINDOW)
      .map(a => a.value)
      .join(' | ');
    lines.push(\`[\${locLabel}]: \${locAttrs}\`);
    truthLines++;
  }`;

const newBlock = `  // Location attributes — includes L0 cell attributes via locRecord fallback
  if (locRecord && locRecord.attributes && Object.keys(locRecord.attributes).length) {
    const locAll = Object.values(locRecord.attributes);
    // v1.86.0: diagnostic passback — total env facts before window cap
    if (turnContext) turnContext.totalEnvFacts = locAll.length;
    const locAttrs = locAll
      .sort((x, y) => (y.turn_set || 0) - (x.turn_set || 0))
      .slice(0, ENV_ATTR_WINDOW)
      .map(a => a.value)
      .join(' | ');
    lines.push(\`[\${locLabel}]: \${locAttrs}\`);
    truthLines++;
  }`;

if (content.includes(oldBlock)) {
  content = content.replace(oldBlock, newBlock);
  fs.writeFileSync(filePath, content, 'utf8');
  console.log('PATCHED: totalEnvFacts diagnostic passback added');
} else {
  // Try with \r\n
  const oldBlockCRLF = oldBlock.replace(/\n/g, '\r\n');
  const newBlockCRLF = newBlock.replace(/\n/g, '\r\n');
  if (content.includes(oldBlockCRLF)) {
    content = content.replace(oldBlockCRLF, newBlockCRLF);
    fs.writeFileSync(filePath, content, 'utf8');
    console.log('PATCHED (CRLF): totalEnvFacts diagnostic passback added');
  } else {
    console.error('FAILED: old block not found in file');
    process.exit(1);
  }
}
