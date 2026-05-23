const http = require('http');

const BASE = 'http://127.0.0.1:3000';
const KEY = 'localdev';

function req(method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1',
      port: 3000,
      path,
      method,
      headers: { ...headers }
    };
    if (body) {
      const data = JSON.stringify(body);
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(data);
    }
    const r = http.request(opts, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        let json;
        try { json = JSON.parse(buf); } catch(e) { json = { parseError: buf.slice(0,200) }; }
        resolve({ status: res.statusCode, headers: res.headers, body: json });
      });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

async function main() {
  // Create a fresh session
  console.log('=== Creating session ===');
  const r1 = await req('POST', '/narrate', { action: 'I am a wandering knight standing at the entrance to a small village tavern.' });
  const sessionId = r1.body.sessionId;
  if (!sessionId) { console.log('FAIL: no sessionId'); process.exit(1); }
  console.log(`Session: ${sessionId}`);

  // Play 2 more turns
  for (let i = 0; i < 2; i++) {
    const r = await req('POST', '/narrate', { action: 'look around' }, { 'x-session-id': sessionId });
    if (r.status !== 200) { console.log(`FAIL: turn ${i+2} status ${r.status}`); process.exit(1); }
  }
  console.log('Played 3 turns total (1 founding + 2 look).');

  // Query routes
  const [sessionRes, logRes, contextRes] = await Promise.all([
    req('GET', '/diagnostics/session', null, { 'x-diagnostics-key': KEY }),
    req('GET', '/diagnostics/log', null, { 'x-diagnostics-key': KEY }),
    req('GET', '/diagnostics/context?sessionId=' + sessionId, null, { 'x-diagnostics-key': KEY })
  ]);

  const s = sessionRes.body;
  const l = logRes.body;
  const c = contextRes.body;

  let allPassed = true;

  // Check 1: sessionId from /session must match sessionId from /context
  const c1 = s.sessionId === c.sessionId;
  console.log(`\n[1] /session.sessionId (${s.sessionId}) === /context.sessionId (${c.sessionId})`);
  console.log(c1 ? '  PASS' : '  FAIL');
  if (!c1) allPassed = false;

  // Check 2: /log.total_turns must equal /session.lastTurn (both are session-scoped)
  const c2 = l.total_turns === s.lastTurn;
  console.log(`[2] /log.total_turns (${l.total_turns}) === /session.lastTurn (${s.lastTurn})`);
  console.log(c2 ? '  PASS' : '  FAIL');
  if (!c2) allPassed = false;

  // Check 3: hasTurnData must be true when lastTurn > 0
  const c3 = s.hasTurnData === true;
  console.log(`[3] /session.hasTurnData (${s.hasTurnData}) === true when lastTurn=${s.lastTurn}`);
  console.log(c3 ? '  PASS' : '  FAIL');
  if (!c3) allPassed = false;

  // Check 4: /log.turns array length must equal total_turns
  const logTurnsLen = l.turns ? l.turns.length : 0;
  const c4 = logTurnsLen === l.total_turns;
  console.log(`[4] /log.turns.length (${logTurnsLen}) === /log.total_turns (${l.total_turns})`);
  console.log(c4 ? '  PASS' : '  FAIL');
  if (!c4) allPassed = false;

  // Check 5: each turn in /log.turns must have turn_number matching its position
  let c5 = true;
  if (l.turns && l.turns.length > 0) {
    for (let i = 0; i < l.turns.length; i++) {
      if (l.turns[i].turn_number !== i + 1) {
        console.log(`[5] /log.turns[${i}].turn_number (${l.turns[i].turn_number}) !== ${i+1}`);
        c5 = false;
      }
    }
  }
  console.log(`[5] All turn_numbers sequential (1..${l.total_turns}): ${c5 ? 'PASS' : 'FAIL'}`);
  if (!c5) allPassed = false;

  console.log(`\n=== ${allPassed ? 'ALL PASSED' : 'SOME FAILED'} ===`);
  if (!allPassed) process.exit(1);
}

main().catch(e => { console.error('Unhandled:', e); process.exit(1); });
