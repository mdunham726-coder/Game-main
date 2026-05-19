const fs = require('fs');
const content = fs.readFileSync('ContinuityBrain.js', 'utf8');
const idx = content.indexOf('const locAttrs = Object.values(locRecord.attributes)');
if (idx === -1) {
  console.log('NOT FOUND');
  process.exit(1);
}
// Show the 200 chars starting at idx, with visible whitespace
const snippet = content.slice(idx, idx + 200);
console.log(JSON.stringify(snippet));
console.log('---');
// Show hex of first 20 chars
for (let i = 0; i < Math.min(20, snippet.length); i++) {
  console.log(i, snippet.charCodeAt(i), snippet[i]);
}
