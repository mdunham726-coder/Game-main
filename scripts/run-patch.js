const fs = require('fs');
const path = require('path');
const filePath = path.join(__dirname, '..', 'ContinuityBrain.js');
let content = fs.readFileSync(filePath, 'utf8');
if (content.includes('totalEnvFacts')) { console.log('ALREADY PATCHED'); process.exit(0); }
const search = 'const locAttrs = Object.values(locRecord.attributes)';
const lineIdx = content.indexOf(search);
if (lineIdx === -1) { console.error('NOT FOUND'); process.exit(1); }
const before = content.slice(0, lineIdx);
const after = content.slice(lineIdx + search.length);
const insert = '    const locAll = Object.values(locRecord.attributes);\r\n    // v1.86.0: diagnostic passback — total env facts before window cap\r\n    if (turnContext) turnContext.totalEnvFacts = locAll.length;\r\n    const locAttrs = locAll';
fs.writeFileSync(filePath, before + insert + after, 'utf8');
console.log('PATCHED');
