const http = require('http');

const BASE = 'http://localhost:3000';
const KEY = 'localdev';

function fetch(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'localhost',
      port: 3000,
      path,
      method,
      headers: { ...headers }
    };
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
    }
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          contentType: res.headers['content-type'] || '',
          body: data.substring(0, 200)
        });
      });
    });
    req.on('error', (e) => reject(e));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function testRoute(label, method, path, body) {
  // Case A: no auth header
  const a = await fetch(method, path, {}, body);
  const aPass = a.status === 401;
  console.log(`[${label}] (A) no auth → ${a.status} ${aPass ? 'PASS' : 'FAIL (expected 401)'}`);
  if (!aPass) console.log(`  body: ${a.body}`);

  // Case B: with x-diagnostics-key header
  const b = await fetch(method, path, { 'x-diagnostics-key': KEY }, body);
  const bPass = b.status !== 401;
  console.log(`[${label}] (B) with key → ${b.status} ${bPass ? 'PASS' : 'FAIL (expected non-401)'}`);
  if (!bPass) console.log(`  body: ${b.body}`);

  // Print response metadata for both cases
  console.log(`  (A) contentType: ${a.contentType}`);
  console.log(`  (B) contentType: ${b.contentType}`);
  console.log(`  (A) body preview: ${a.body.substring(0, 100)}`);
  console.log(`  (B) body preview: ${b.body.substring(0, 100)}`);
  console.log('');
}

(async () => {
  console.log('=== Stage 2: Protected/Keyed Routes ===\n');

  await testRoute('GET /diagnostics/source', 'GET', '/diagnostics/source?file=index.js');
  await testRoute('GET /diagnostics/source-search', 'GET', '/diagnostics/source-search?file=index.js&q=registerRoutes');
  await testRoute('GET /diagnostics/npcs', 'GET', '/diagnostics/npcs');
  await testRoute('POST /diagnostics/mb-crash', 'POST', '/diagnostics/mb-crash', { message: 'stage2-test' });

  console.log('=== Stage 2 complete ===');
})();
