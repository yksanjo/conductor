#!/usr/bin/env node
'use strict';

// No-mock MCP test: spawn the real mcp.js server, speak newline-delimited JSON-RPC to it
// over stdio, and assert the handshake + each tool responds correctly. Builds a fake
// ~/.claude/projects tree so list_sessions has real data to return. Zero dependencies.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

let pass = 0;
function ok(name, cond) { assert.ok(cond, name); console.log('  ✓ ' + name); pass++; }

// fake HOME with one live session
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-mcp-'));
const proj = path.join(root, '.claude', 'projects', '-Users-test-gamma');
fs.mkdirSync(proj, { recursive: true });
const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const iso = (ms) => new Date(Date.now() - ms).toISOString();
fs.writeFileSync(path.join(proj, sid + '.jsonl'),
  [
    { type: 'ai-title', sessionId: sid, aiTitle: 'Ship the MCP server' },
    { type: 'last-prompt', sessionId: sid, lastPrompt: 'build conductor C' },
    { type: 'assistant', sessionId: sid, cwd: '/Users/test/gamma', gitBranch: 'main', timestamp: iso(3000), message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'mcp.js' } }] } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');

// --- spawn the server -------------------------------------------------------
const srv = spawn('node', [path.join(__dirname, 'mcp.js')], {
  env: { ...process.env, HOME: root },
  stdio: ['pipe', 'pipe', 'inherit'],
});

const pending = new Map();
let outbuf = '';
srv.stdout.setEncoding('utf8');
srv.stdout.on('data', (chunk) => {
  outbuf += chunk;
  let nl;
  while ((nl = outbuf.indexOf('\n')) >= 0) {
    const line = outbuf.slice(0, nl).trim();
    outbuf = outbuf.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});

let nextId = 1;
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout: ' + method)); } }, 5000);
  });
}
function notify(method, params) { srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); }

(async () => {
  console.log('conductor MCP tests:');

  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  ok('initialize returns serverInfo.name = conductor', init.result.serverInfo.name === 'conductor');
  ok('initialize advertises tools capability', !!init.result.capabilities.tools);
  notify('notifications/initialized');

  const list = await rpc('tools/list', {});
  const names = list.result.tools.map((t) => t.name);
  ok('tools/list returns the 3 read tools', names.includes('list_sessions') && names.includes('summarize_session') && names.includes('whats_left'));
  ok('tools/list returns the 4 control/triage tools', ['pending_questions', 'reply_to_session', 'send_key', 'run_window'].every((n) => names.includes(n)));
  ok('tools have inputSchema', list.result.tools.every((t) => t.inputSchema && t.inputSchema.type === 'object'));

  const ls = await rpc('tools/call', { name: 'list_sessions', arguments: { minutes: 60 } });
  const lsData = JSON.parse(ls.result.content[0].text);
  ok('list_sessions finds the fake session', lsData.count === 1 && lsData.sessions[0].sessionId === sid);
  ok('list_sessions label prettified (Gamma)', lsData.sessions[0].label === 'Gamma');
  ok('list_sessions reports task', lsData.sessions[0].task === 'Ship the MCP server');

  const sum = await rpc('tools/call', { name: 'summarize_session', arguments: { session: 'Gamma' } });
  const sumData = JSON.parse(sum.result.content[0].text);
  ok('summarize_session by label resolves', sumData.sessionId === sid);
  ok('summarize_session goal = lastPrompt', sumData.goal === 'build conductor C');
  ok('summarize_session doingNow is the Write tool', /Write/.test(sumData.doingNow));

  const wl = await rpc('tools/call', { name: 'whats_left', arguments: {} });
  const wlData = JSON.parse(wl.result.content[0].text);
  ok('whats_left returns the window with goal + lastAction', wlData.windows.length === 1 && /build conductor C/.test(wlData.windows[0].goal));

  // pending_questions: the fake session isn't an OPEN window (no live `claude` proc in the
  // temp HOME), so it's correctly NOT "waiting on you" → empty, with the triage shape intact.
  const pq = await rpc('tools/call', { name: 'pending_questions', arguments: {} });
  const pqData = JSON.parse(pq.result.content[0].text);
  ok('pending_questions returns the triage shape (0 here — no live process)', pqData.count === 0 && Array.isArray(pqData.windows) && /blocked on a human/.test(pqData.note));

  // Control tools: exercise only the guard/error paths so the test never spawns a real window.
  const rNo = await rpc('tools/call', { name: 'reply_to_session', arguments: { session: 'does-not-exist', text: 'hi' } });
  const rNoData = JSON.parse(rNo.result.content[0].text);
  ok('reply_to_session on an unknown session fails cleanly', rNoData.ok === false);

  const kNo = await rpc('tools/call', { name: 'send_key', arguments: { session: 'does-not-exist', key: 'Escape' } });
  const kNoData = JSON.parse(kNo.result.content[0].text);
  ok('send_key on a non-managed window fails cleanly', kNoData.ok === false && /not a managed window|tmux/.test(kNoData.error));

  const runMissing = await rpc('tools/call', { name: 'run_window', arguments: {} });
  ok('run_window without a label returns isError (no spawn)', runMissing.result.isError === true);

  const bad = await rpc('tools/call', { name: 'nope', arguments: {} });
  ok('unknown tool returns isError (not a crash)', bad.result.isError === true);

  const missing = await rpc('tools/call', { name: 'summarize_session', arguments: { session: 'does-not-exist' } });
  ok('summarize_session unknown id returns a helpful message', /No live session matched/.test(missing.result.content[0].text));

  srv.kill();
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${pass} assertions passed.`);
})().catch((e) => { console.error('FAIL:', e.message); srv.kill(); fs.rmSync(root, { recursive: true, force: true }); process.exit(1); });
