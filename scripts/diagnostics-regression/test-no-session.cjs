const http = require('http');

const routes = [
  { name: 'GET /diagnostics/session',          path: '/diagnostics/session' },
  { name: 'GET /diagnostics/summary',           path: '/diagnostics/summary' },
  { name: 'GET /diagnostics/site-placement',    path: '/diagnostics/site-placement' },
  { name: 'GET /diagnostics/stream',            path: '/diagnostics/stream' },
  { name: 'GET /diagnostics/npc',               path: '/diagnostics/npc' },
  { name: 'GET /diagnostics/sites',             path: '/diagnostics/sites' },
];

let i = 0;
function next() {
  if (i >= routes.length) { console.log('DONE'); process.exit(0); return; }
  const route = routes[i++];
  const req = http.get('http://localhost:3000' + route.path, { timeout: 5000 }, (res) => {
    let body = '';
    const contentType = res.headers['content-type'] || '';
    const isSSE = contentType.includes('text/event-stream');
    if (isSSE) {
      res.once('data', () => {
        console.log(JSON.stringify({ route: route.name, status: res.statusCode, contentType, responseType: 'SSE-stream', dataReceived: true }));
        res.destroy();
        setTimeout(next, 200);
      });
      return;
    }
    res.on('data', (chunk) => body += chunk);
    res.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch(e) { parsed = { parseError: e.message, raw: body.slice(0, 200) }; }
      console.log(JSON.stringify({ route: route.name, status: res.statusCode, contentType, keys: Object.keys(parsed), data: parsed }));
      setTimeout(next, 200);
    });
  });
  req.on('error', (e) => {
    console.log(JSON.stringify({ route: route.name, error: e.message }));
    setTimeout(next, 200);
  });
  req.on('timeout', () => {
    req.destroy();
    console.log(JSON.stringify({ route: route.name, error: 'timeout' }));
    setTimeout(next, 200);
  });
}
next();
