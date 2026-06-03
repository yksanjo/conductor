#!/usr/bin/env node
'use strict';

// Conductor MCP server — exposes your live Claude Code sessions as MCP tools so ANY
// MCP-aware agent (Claude Code, Claude Desktop, etc.) can ask "what are my windows doing?"
// natively. Read-only. Zero dependencies. Speaks MCP over stdio (newline-delimited
// JSON-RPC 2.0).
//
// Tools:
//   list_sessions     — one line per live window: label, status, task, branch, age
//   summarize_session — full detail for one window (by sessionId, shortId, or label)
//   whats_left        — goal + last action per window, for the agent to triage next steps

const { collectSessions } = require('./lib');

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'conductor', version: '0.3.0' };

const TOOLS = [
  {
    name: 'list_sessions',
    description: 'List the user\'s live Claude Code sessions (windows). Returns one entry per session with a friendly project label, status (active/recent/idle), what it\'s working on, git branch, and how long since real activity. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        minutes: { type: 'number', description: 'Only sessions touched in the last N minutes (default 60).' },
        all: { type: 'boolean', description: 'Ignore the time filter and list every session.' },
      },
    },
  },
  {
    name: 'summarize_session',
    description: 'Full detail for ONE session: its goal, what it is doing now, and a recent event timeline. Identify it by sessionId, the 8-char shortId, or its friendly label (case-insensitive).',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'sessionId, shortId, or friendly label of the window.' },
        minutes: { type: 'number', description: 'Search window in minutes (default 1440).' },
      },
      required: ['session'],
    },
  },
  {
    name: 'whats_left',
    description: 'For each live session, return its goal and last action so you can infer what each window still needs to do. "What\'s left" is inference from the transcript, not a confirmed todo list.',
    inputSchema: {
      type: 'object',
      properties: {
        minutes: { type: 'number', description: 'Only sessions touched in the last N minutes (default 60).' },
      },
    },
  },
];

function textResult(obj) {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
  return { content: [{ type: 'text', text }] };
}

async function callTool(name, args) {
  args = args || {};
  if (name === 'list_sessions') {
    const rows = await collectSessions({ minutes: args.minutes || 60, all: !!args.all });
    return textResult({
      count: rows.length,
      sessions: rows.map((s) => ({
        sessionId: s.sessionId, shortId: s.shortId, label: s.label,
        status: s.status, task: s.task, branch: s.gitBranch,
        lastActive: s.lastActiveRel, cwd: s.cwd,
      })),
    });
  }
  if (name === 'summarize_session') {
    const key = String(args.session || '').toLowerCase();
    const rows = await collectSessions({ minutes: args.minutes || 1440, all: false });
    const s = rows.find((r) =>
      r.sessionId.toLowerCase() === key ||
      r.shortId.toLowerCase() === key ||
      (r.label || '').toLowerCase() === key);
    if (!s) return textResult(`No live session matched "${args.session}". Try list_sessions first, or widen 'minutes'.`);
    return textResult({
      label: s.label, sessionId: s.sessionId, cwd: s.cwd, branch: s.gitBranch,
      status: s.status, lastActive: s.lastActiveRel,
      goal: s.intent || s.task, doingNow: s.lastAction,
      recent: s.recent.map((e) => `${e.role === 'assistant' ? 'Claude' : 'you'}: ${e.summary}`),
    });
  }
  if (name === 'whats_left') {
    const rows = await collectSessions({ minutes: args.minutes || 60, all: false });
    return textResult({
      note: '"what\'s left" is inferred from each transcript, not a confirmed todo list.',
      windows: rows.map((s) => ({
        label: s.label, status: s.status, lastActive: s.lastActiveRel,
        goal: s.intent || s.task, lastAction: s.lastAction,
      })),
    });
  }
  throw new Error(`unknown tool: ${name}`);
}

// --- JSON-RPC / MCP plumbing over stdio ------------------------------------
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function fail(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: (params && params.protocolVersion) || PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      return;
    case 'notifications/initialized':
    case 'initialized':
      return; // notification, no reply
    case 'ping':
      if (!isNotification) reply(id, {});
      return;
    case 'tools/list':
      reply(id, { tools: TOOLS });
      return;
    case 'tools/call': {
      const tname = params && params.name;
      try {
        const result = await callTool(tname, params && params.arguments);
        reply(id, result);
      } catch (e) {
        // MCP convention: tool errors surface as isError content, not protocol errors.
        reply(id, { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true });
      }
      return;
    }
    default:
      if (!isNotification) fail(id, -32601, `method not found: ${method}`);
  }
}

function main() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      handle(msg).catch((e) => process.stderr.write('conductor-mcp error: ' + e.message + '\n'));
    }
  });
  process.stdin.on('end', () => process.exit(0));
  process.stderr.write('conductor-mcp ready (stdio)\n');
}

main();
