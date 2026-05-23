#!/usr/bin/env node
/**
 * Stage 5: inject-npc mutation testing
 *
 * Tests:
 * (1) No-auth POST returns 401 (protection test)
 * (2) Create a fresh session via POST /narrate, play one turn
 * (3) Read GET /diagnostics/npc for pre-injection state
 * (4) POST /diagnostics/inject-npc with valid body
 * (5) Read GET /diagnostics/npc again and verify the injected NPC appears
 */

const http = require('http');
const BASE = 'http://localhost:3000';

function request(method, path, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const headers = { ...opts.headers };
    let bodyData = null;
    if (opts.body) {
      bodyData = JSON.stringify(opts.body);
      headers['Content-Type'] = 'application/json';
    }
    const req = http.request(
      url,
      { method, headers, timeout: 60000 },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(data); } catch (_) { parsed = data; }
          resolve({
            status: res.statusCode,
            contentType: res.headers['content-type'] || '',
            body: parsed,
            raw: data,
          });
        });
      }
    );
    req.on('error', (err) => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (bodyData) req.write(bodyData);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const results = [];

  // ── Step 1: No-auth protection test ──────────────────────────────────
  console.log('── Step 1: No-auth POST to inject-npc ──');
  const r1 = await request('POST', '/diagnostics/inject-npc', {
    body: { sessionId: 'dummy', npc_name: 'test', job_category: 'test' },
  });
  const step1Pass = r1.status === 401;
  console.log(`  Status: ${r1.status} (expected 401) → ${step1Pass ? 'PASS' : 'FAIL'}`);
  if (!step1Pass) {
    console.log(`  Body: ${JSON.stringify(r1.body).slice(0, 200)}`);
  }
  results.push({ step: 1, name: 'no-auth protection', pass: step1Pass, detail: `status=${r1.status}` });

  // ── Step 2: Create a fresh session ──────────────────────────────────
  console.log('\n── Step 2: Create session via POST /narrate ──');
  const r2 = await request('POST', '/narrate', {
    body: { action: 'I am a wandering knight standing at the entrance to a small village tavern.' },
  });
  let sessionId = null;
  let step2Pass = false;
  if (r2.status === 200 && r2.body && r2.body.sessionId) {
    sessionId = r2.body.sessionId;
    step2Pass = true;
    console.log(`  Session created: ${sessionId}`);
    console.log(`  Status: ${r2.status}`);
  } else {
    console.log(`  Status: ${r2.status}`);
    console.log(`  Body: ${JSON.stringify(r2.body).slice(0, 300)}`);
  }
  results.push({ step: 2, name: 'create session', pass: step2Pass, detail: `sessionId=${sessionId || 'null'}` });
  if (!sessionId) {
    console.log('\n❌ Cannot continue without a session. Aborting.');
    printSummary(results);
    process.exit(1);
  }

  // ── Step 2b: Play one additional turn (enter the tavern) ──────────
  console.log('\n── Step 2b: Play Turn 2 ──');
  const r2b = await request('POST', '/narrate', {
    body: { action: 'look around' },
    headers: { 'x-session-id': sessionId },
  });
  const step2bPass = r2b.status === 200 && !r2b.body?.error;
  console.log(`  Status: ${r2b.status} → ${step2bPass ? 'PASS' : 'FAIL'}`);
  if (!step2bPass) {
    console.log(`  Error: ${r2b.body?.error || 'none'}`);
  }
  results.push({ step: '2b', name: 'play turn 2', pass: step2bPass, detail: `status=${r2b.status}` });

  // Allow server to settle
  await sleep(500);

  // ── Step 3: Read NPC state before injection ──────────────────────────
  console.log('\n── Step 3: Pre-injection NPC state ──');
  const r3 = await request('GET', '/diagnostics/npc', {
    headers: { 'x-diagnostics-key': 'localdev' },
  });
  const preNpcs = Array.isArray(r3.body?.npcs) ? r3.body.npcs : [];
  const preCount = preNpcs.length;
  const preNames = preNpcs.map((n) => n.npc_name || n.name || '(unnamed)');
  console.log(`  Status: ${r3.status}`);
  console.log(`  NPC count: ${preCount}`);
  console.log(`  NPC names: ${JSON.stringify(preNames)}`);
  const step3Pass = r3.status === 200;
  results.push({ step: 3, name: 'pre-injection NPC read', pass: step3Pass, detail: `count=${preCount}` });

  // ── Step 4: Inject an NPC ────────────────────────────────────────────
  console.log('\n── Step 4: POST inject-npc ──');
  const r4 = await request('POST', '/diagnostics/inject-npc', {
    body: { sessionId, npc_name: 'Old Man Jenkins', job_category: 'mysterious hermit' },
    headers: { 'x-diagnostics-key': 'localdev' },
  });
  const step4Pass = r4.status === 200;
  console.log(`  Status: ${r4.status} (expected 200) → ${step4Pass ? 'PASS' : 'FAIL'}`);
  if (!step4Pass) {
    console.log(`  Body: ${JSON.stringify(r4.body).slice(0, 300)}`);
  } else {
    console.log(`  Response: ${JSON.stringify(r4.body).slice(0, 200)}`);
  }
  results.push({ step: 4, name: 'inject NPC', pass: step4Pass, detail: `status=${r4.status}` });

  await sleep(300);

  // ── Step 5: Read NPC state after injection ───────────────────────────
  console.log('\n── Step 5: Post-injection NPC state ──');
  const r5 = await request('GET', '/diagnostics/npc', {
    headers: { 'x-diagnostics-key': 'localdev' },
  });
  const postNpcs = Array.isArray(r5.body?.npcs) ? r5.body.npcs : [];
  const postCount = postNpcs.length;
  const postNames = postNpcs.map((n) => n.npc_name || n.name || '(unnamed)');
  console.log(`  Status: ${r5.status}`);
  console.log(`  NPC count: ${postCount}`);
  console.log(`  NPC names: ${JSON.stringify(postNames)}`);

  // Verify the injected NPC appears
  const foundJenkins = postNames.some((n) => n === 'Old Man Jenkins');
  const step5Pass = r5.status === 200 && foundJenkins && postCount > preCount;
  console.log(`  Injected NPC found: ${foundJenkins}`);
  console.log(`  Count increased: ${postCount} > ${preCount} → ${postCount > preCount ? 'YES' : 'NO'}`);
  console.log(`  → ${step5Pass ? 'PASS' : 'FAIL'}`);
  results.push({ step: 5, name: 'verify injection', pass: step5Pass, detail: `pre=${preCount} post=${postCount} found=${foundJenkins}` });

  // ── Summary ──────────────────────────────────────────────────────────
  printSummary(results);
}

function printSummary(results) {
  console.log('\n═══════════════════════════════════════════');
  console.log('STAGE 5 RESULTS');
  console.log('═══════════════════════════════════════════');
  for (const r of results) {
    console.log(`  Step ${r.step} (${r.name}): ${r.pass ? 'PASS' : 'FAIL'} — ${r.detail}`);
  }
  const allPassed = results.every((r) => r.pass);
  console.log(`\n  OVERALL: ${allPassed ? 'ALL PASSED ✅' : 'SOME FAILED ❌'}`);
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
