#!/usr/bin/env node
'use strict';

const http = require('http');
const BASE = 'http://localhost:3000';

function req(method, path, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE);
    if (opts.query) u.search = new URLSearchParams(opts.query).toString();
    const headers = { ...opts.headers, 'Content-Type': 'application/json' };
    const body = opts.body ? JSON.stringify(opts.body) : undefined;
    const r = http.request(u, { method, headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (e) { parsed = { _raw: data.slice(0, 300) }; }
        resolve({
          status: res.statusCode,
          contentType: res.headers['content-type'] || '',
          body: parsed,
          raw: data.slice(0, 200)
        });
      });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

async function main() {
  console.log('=== STAGE 3: LIVE SESSION ROUTES ===\n');

  // Step 1: Create a fresh session via POST /narrate with a founding premise
  console.log('--- Step 1: Create session (Turn 1) ---');
  const createRes = await req('POST', '/narrate', {
    body: { action: 'I am a wandering knight standing at the entrance to a small village tavern.' }
  });
  const sessionId = createRes.body?.sessionId;
  console.log('Status:', createRes.status);
  console.log('Session ID:', sessionId || '(none)');
  if (!sessionId) {
    console.log('FAIL: no sessionId returned');
    process.exit(1);
  }
  if (createRes.body?.narrative) {
    console.log('Narrative (first 120 chars):', createRes.body.narrative.slice(0, 120));
  }
  console.log('');

  // Step 2: Take a second turn
  console.log('--- Step 2: Take Turn 2 ---');
  const turn2Res = await req('POST', '/narrate', {
    headers: { 'x-session-id': sessionId },
    body: { action: 'look around' }
  });
  console.log('Status:', turn2Res.status);
  if (turn2Res.body?.narrative) {
    console.log('Narrative (first 120 chars):', turn2Res.body.narrative.slice(0, 120));
  }
  console.log('');

  // Step 3: Test five session-scoped diagnostic routes
  const KEY = { 'x-diagnostics-key': 'localdev' };
  const routes = [
    { name: 'GET /diagnostics/session', method: 'GET', path: '/diagnostics/session' },
    { name: 'GET /diagnostics/summary', method: 'GET', path: '/diagnostics/summary' },
    { name: 'GET /diagnostics/npc',    method: 'GET', path: `/diagnostics/npc?sessionId=${sessionId}` },
    { name: 'GET /diagnostics/context', method: 'GET', path: `/diagnostics/context?sessionId=${sessionId}` },
    { name: 'GET /diagnostics/log', method: 'GET', path: `/diagnostics/log?sessionId=${sessionId}` },
  ];

  let allPassed = true;
  for (const route of routes) {
    const res = await req(route.method, route.path, { headers: KEY });
    const hasData = res.status === 200 && res.body && !res.body.error;
    const pass = hasData;
    if (!pass) allPassed = false;

    // Show key fields
    let keyFields = '';
    if (res.body && typeof res.body === 'object') {
      const keys = Object.keys(res.body);
      const nonNullKeys = keys.filter(k => res.body[k] !== null && res.body[k] !== undefined &&
        !(Array.isArray(res.body[k]) && res.body[k].length === 0) &&
        res.body[k] !== 0);
      keyFields = ` | keys with data: [${nonNullKeys.join(', ')}]`;
    }

    console.log(`${pass ? 'PASS' : 'FAIL'} ${route.name} → ${res.status}${keyFields}`);
    if (!pass) {
      console.log(`  body: ${JSON.stringify(res.body).slice(0, 150)}`);
    }
  }

  console.log(`\n=== ${allPassed ? 'ALL PASSED' : 'SOME FAILED'} ===`);
  process.exit(allPassed ? 0 : 1);
}

main().catch(e => { console.error('CRASH:', e); process.exit(1); });
