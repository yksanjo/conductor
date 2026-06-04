#!/usr/bin/env node
'use strict';

// No-mock test for the cockpit's CSRF / DNS-rebinding guard. Spawns the real server (with
// an isolated HOME so it touches nothing) and hits it with raw HTTP requests.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-srv-'));
const PORT = 7593;
let pass = 0;
function ok(name, cond) { assert.ok(cond, name); console.log('  ✓ ' + name); pass++; }

function req(method, p, headers, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: headers || {} }, (res) => {
      let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const srv = spawn('node', [path.join(__dirname, 'server.js'), '--port', String(PORT), '--no-open'],
    { env: { ...process.env, HOME: root }, stdio: 'ignore' });
  try {
    await sleep(1400);
    console.log('conductor server (CSRF guard) tests:');

    // read path is open
    const s = await req('GET', '/api/sessions?minutes=10');
    ok('GET /api/sessions allowed (200)', s.status === 200);

    // CSRF: POST with no X-Conductor header (a cross-site "simple request") is rejected
    const noHdr = await req('POST', '/api/say-all', { 'content-type': 'text/plain' }, '{"text":"pwn"}');
    ok('POST without X-Conductor → 403', noHdr.status === 403);

    // POST with a foreign Origin is rejected even if header present
    const badOrigin = await req('POST', '/api/say-all',
      { 'content-type': 'application/json', 'x-conductor': '1', origin: 'http://evil.example' }, '{"text":"pwn"}');
    ok('POST from foreign Origin → 403', badOrigin.status === 403);

    // legit same-origin POST (local + header) is accepted
    const good = await req('POST', '/api/say-all',
      { 'content-type': 'application/json', 'x-conductor': '1', origin: 'http://localhost:' + PORT }, '{"text":"hi"}');
    ok('POST with X-Conductor + local origin → 200', good.status === 200);
    ok('  …and returns a sayAll result', /"sent"/.test(good.body));

    // oversize body → 413
    const big = await req('POST', '/api/say-all',
      { 'content-type': 'application/json', 'x-conductor': '1' }, '{"text":"' + 'x'.repeat(9000) + '"}');
    ok('oversize POST → 413', big.status === 413);

    srv.kill();
    fs.rmSync(root, { recursive: true, force: true });
    console.log(`\n${pass} assertions passed.`);
  } catch (e) {
    srv.kill(); fs.rmSync(root, { recursive: true, force: true });
    console.error('FAIL:', e.message); process.exit(1);
  }
})();
