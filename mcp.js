#!/usr/bin/env node
'use strict';

// Conductor MCP server — exposes your live Claude Code sessions as MCP tools so ANY
// MCP-aware agent (Claude Code, Claude Desktop, etc.) can ask "what are my windows doing?"
// AND drive them natively. Zero dependencies. Speaks MCP over stdio (newline-delimited
// JSON-RPC 2.0). The control tools route through manage.js (tmux send-keys) — the same
// channel the web cockpit uses — so an orchestrator agent can review and continue windows
// end-to-end.
//
// The auto-approve policy (policy.js) is the gate that makes end-to-end driving safe: an
// autonomous driver may CONTINUE ordinary work freely, but DEPLOY / SEND / DELETE / SPEND
// always bounce back to you. reply_to_session stays the raw, human-authorized channel (no
// gate — you decided); auto_continue is the gated driver for the loop. The loop is:
//   pending_questions  →  auto_continue per window  →  (gated ones surfaced to you)
//
// Read tools:
//   list_sessions      — one line per live window: label, status, task, branch, age
//   summarize_session  — full detail for one window (by sessionId, shortId, or label)
//   whats_left         — goal + last action per unit, for the agent to triage next steps
//   pending_questions  — ONLY the windows blocked waiting on a human, each flagged irreversible?
//   risk_snapshot      — fleet-wide PnL + drawdowns + wedged units (adapter:"fleet")
// The read tools take an optional `adapter` ("claude-code" default, or "fleet").
// Control tools (write — drive a window via tmux):
//   reply_to_session   — send a reply to a window (adopts an unmanaged window first); ungated
//   auto_continue      — advance a window UNDER the gate; refuses to auto-approve irreversible steps
//   send_key           — send a key (Escape / C-c / Enter) to a managed window
//   run_window         — launch a new managed window, optionally with a first prompt

const { collectSessions } = require('./lib');
const engine = require('./engine');
const manage = require('./manage');
const pkg = require('./package.json');
const policy = require('./policy');

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'conductor', version: pkg.version };   // kept in sync with package.json

// Collect rows for any adapter. claude-code keeps its exact legacy path (and the tmux control
// tools); other adapters (e.g. fleet) route through the generic engine.
async function collectFor(adapterName, opts) {
  if (!adapterName || adapterName === 'claude-code') return collectSessions(opts);
  return engine.collect(engine.loadAdapter(adapterName), opts);
}

// Find one session row by sessionId, 8-char shortId, or friendly label (case-insensitive).
async function findSession(ref, minutes = 4320) {
  const key = String(ref || '').toLowerCase();
  const rows = await collectSessions({ minutes, all: false });
  return rows.find((r) =>
    r.sessionId.toLowerCase() === key ||
    r.shortId.toLowerCase() === key ||
    (r.label || '').toLowerCase() === key ||
    (r.mlabel || '').toLowerCase() === key);
}

// The "question" a window is blocked on = its last assistant TEXT (the thing it's waiting on
// you for). Falls back to its last action if it ended on a tool call.
function lastAssistantText(s) {
  for (let i = (s.recent || []).length - 1; i >= 0; i--) {
    const r = s.recent[i];
    if (r.actor === 'assistant' && r.kind === 'text') return r.summary;
  }
  return s.lastAction;
}

// Deliver a reply to a window: if it's already managed, send straight to its tmux window;
// otherwise adopt it (fork into tmux) and drive it from boot to ready, then deliver. Mirrors
// the cockpit's /api/adopt-say so the MCP and the UI behave identically.
async function replyToSession(ref, text) {
  if (!manage.hasTmux()) return { ok: false, error: 'tmux is not installed (brew install tmux).' };
  const managedBySession = manage.managedBySession();
  const s = await findSession(ref);
  // Already managed (by sessionId, adoptedFrom, or label)?
  const existing = (s && managedBySession[s.sessionId])
    || manage.listManaged().find((w) => w.label === manage.sanitize(ref));
  if (existing) {
    const r = manage.say(existing.label, text);
    return r.ok ? { ok: true, label: existing.label, adopted: false } : r;
  }
  if (!s) return { ok: false, error: `no session matched "${ref}" — try list_sessions or widen the time window.` };
  const label = manage.uniqueLabel(s.label || s.shortId, s.sessionId);
  const r = manage.adopt(label, s.sessionId, s.cwd, { capture: false });
  if (r.ok) {
    manage.deliverAdopted(label, text);   // accept trust/resume prompts, then deliver once ready
    return { ok: true, label, adopted: true, note: 'adopted into tmux; the reply lands once the fork is ready (~a few s).' };
  }
  // adopt failed (usually a managed copy already exists) → try sending to that label
  const sr = manage.say(label, text);
  return sr.ok ? { ok: true, label, adopted: false } : { ok: false, error: r.error || sr.error };
}

const TOOLS = [
  {
    name: 'list_sessions',
    description: 'List the user\'s live units (Claude Code windows by default; trading bots with adapter:"fleet"). Returns one entry per unit with a friendly label, status, what it\'s working on, and how long since real activity. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        adapter: { type: 'string', description: 'Which fleet to read: "claude-code" (default) or "fleet".' },
        minutes: { type: 'number', description: 'Only units touched in the last N minutes (default 60).' },
        all: { type: 'boolean', description: 'Ignore the time filter and list every unit.' },
      },
    },
  },
  {
    name: 'summarize_session',
    description: 'Full detail for ONE unit: its goal, what it is doing now, and a recent event timeline. Identify it by id, the short id, or its friendly label (case-insensitive).',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'id, shortId, or friendly label of the unit.' },
        adapter: { type: 'string', description: 'Which fleet to read: "claude-code" (default) or "fleet".' },
        minutes: { type: 'number', description: 'Search window in minutes (default 1440).' },
      },
      required: ['session'],
    },
  },
  {
    name: 'whats_left',
    description: 'For each live unit, return its goal and last action so you can infer what each one still needs to do. "What\'s left" is inference from the trail, not a confirmed todo list.',
    inputSchema: {
      type: 'object',
      properties: {
        adapter: { type: 'string', description: 'Which fleet to read: "claude-code" (default) or "fleet".' },
        minutes: { type: 'number', description: 'Only units touched in the last N minutes (default 60).' },
      },
    },
  },
  {
    name: 'risk_snapshot',
    description: 'Fleet risk view: total session PnL, the worst drawdowns, and any WEDGED units (an order/signal stuck with no fill) across a trading-bot fleet. Defaults to adapter "fleet". The supervise-by-exception feed for a desk — read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        adapter: { type: 'string', description: 'Fleet adapter to read (default "fleet").' },
        minutes: { type: 'number', description: 'Only bots active in the last N minutes (default 1440).' },
      },
    },
  },
  {
    name: 'pending_questions',
    description: 'List ONLY the live windows that are blocked waiting on a human — Claude spoke last and went quiet at the prompt. Returns the question text (its last message) plus label/branch/cwd so an orchestrator can decide what to answer. This is the triage feed for end-to-end driving: a window NOT here is busy working or done. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        minutes: { type: 'number', description: 'Only sessions touched in the last N minutes (default 60).' },
      },
    },
  },
  {
    name: 'reply_to_session',
    description: 'Send a reply to one window, advancing it. If the window is already managed (running in conductor\'s tmux) the text is delivered immediately; if it is a plain read-only window it is first adopted (forked into tmux) and the reply lands once the fork is ready. WRITE action — this makes a live agent act. Use after reading the window (summarize_session / pending_questions). Do NOT use to approve irreversible steps (deploy, send, delete, spend) without the human\'s explicit say-so.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'sessionId, 8-char shortId, or friendly label of the window to reply to.' },
        text: { type: 'string', description: 'The reply text to send (e.g. "continue", "yes", or a full instruction).' },
      },
      required: ['session', 'text'],
    },
  },
  {
    name: 'auto_continue',
    description: 'Autonomously advance ONE waiting window UNDER THE IRREVERSIBILITY GATE — the safe way to run the driving loop. Reads the window\'s pending question; if it is ordinary work, sends `text` (default "continue") to keep it moving; if the question OR the reply involves an IRREVERSIBLE action (deploy / send / delete / spend) it does NOT send — it returns gated:true with the reason and the question so YOU escalate to the human. Pair with pending_questions: triage the list, auto_continue the safe ones, hand the gated ones to the human. WRITE action only when not gated. Use this (not raw reply_to_session) whenever you are driving without a human approving each step.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'sessionId, 8-char shortId, or friendly label of the window to advance.' },
        text: { type: 'string', description: 'The reply to send if the gate allows it (default "continue").' },
      },
      required: ['session'],
    },
  },
  {
    name: 'send_key',
    description: 'Send a single named key to a MANAGED window — e.g. "Escape" to dismiss a menu, "C-c" to interrupt, "Enter" to confirm. Only works on windows already running in conductor\'s tmux (adopt first via reply_to_session if needed). WRITE action.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'sessionId, shortId, or managed label of the window.' },
        key: { type: 'string', description: 'tmux key name: Escape, Enter, C-c, Up, Down, etc.' },
      },
      required: ['session', 'key'],
    },
  },
  {
    name: 'run_window',
    description: 'Launch a NEW managed Claude window in conductor\'s tmux, optionally with a first prompt to start its task. WRITE action — spawns a real agent session. Returns the label you can then drive with reply_to_session / send_key.',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Short name for the window (a-z, 0-9, -, _).' },
        cwd: { type: 'string', description: 'Working directory to start in (default: home). "~" is expanded.' },
        prompt: { type: 'string', description: 'Optional first instruction to send once the window is ready.' },
      },
      required: ['label'],
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
    const rows = await collectFor(args.adapter, { minutes: args.minutes || 60, all: !!args.all });
    if (args.adapter && args.adapter !== 'claude-code') {
      return textResult({
        adapter: args.adapter, count: rows.length,
        units: rows.map((s) => ({
          id: s.id, shortId: s.shortId, label: s.label, title: s.title,
          status: s.status, context: s.context, lastActive: s.lastActiveRel,
        })),
      });
    }
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
    const rows = await collectFor(args.adapter, { minutes: args.minutes || 1440, all: false });
    const s = rows.find((r) =>
      String(r.id || r.sessionId || '').toLowerCase() === key ||
      (r.shortId || '').toLowerCase() === key ||
      (r.label || '').toLowerCase() === key);
    if (!s) return textResult(`No live session matched "${args.session}". Try list_sessions first, or widen 'minutes'.`);
    return textResult({
      label: s.label, sessionId: s.sessionId || s.id, cwd: s.cwd, branch: s.gitBranch,
      context: s.context, status: s.status, lastActive: s.lastActiveRel,
      goal: s.intent || s.task || s.title, doingNow: s.lastAction,
      recent: (s.recent || []).map((e) => `${e.actor === 'assistant' ? 'Claude' : (e.actor || 'you')}: ${e.summary}`),
    });
  }
  if (name === 'whats_left') {
    const rows = await collectFor(args.adapter, { minutes: args.minutes || 60, all: false });
    return textResult({
      note: '"what\'s left" is inferred from each trail, not a confirmed todo list.',
      windows: rows.map((s) => ({
        label: s.label, status: s.status, lastActive: s.lastActiveRel,
        goal: s.intent || s.task || s.title, lastAction: s.lastAction,
      })),
    });
  }
  if (name === 'risk_snapshot') {
    const adapterName = args.adapter || 'fleet';
    const rows = await collectFor(adapterName, { minutes: args.minutes || 1440, all: false });
    const num = (n) => (typeof n === 'number' ? n : 0);
    const totalPnl = rows.reduce((a, s) => a + num(s.sessionPnl), 0);
    const wedged = rows.filter((s) => s.status === 'wedged' || (s.statusInputs && s.statusInputs.wedged));
    const drawdowns = rows.filter((s) => num(s.drawdownPct) > 0)
      .sort((a, b) => num(b.drawdownPct) - num(a.drawdownPct));
    return textResult({
      adapter: adapterName,
      note: 'Supervise by exception: wedged units and the deepest drawdowns are where attention is owed.',
      bots: rows.length,
      totalSessionPnl: Math.round(totalPnl * 100) / 100,
      wedged: wedged.map((s) => ({ bot: s.id, venue: s.venue, lastAction: s.lastAction, lastActive: s.lastActiveRel })),
      worstDrawdowns: drawdowns.slice(0, 5).map((s) => ({ bot: s.id, drawdownPct: Math.round(num(s.drawdownPct) * 1000) / 10, pnl: s.sessionPnl, status: s.status })),
      units: rows.map((s) => ({ bot: s.id, status: s.status, pnl: s.sessionPnl, position: s.position, venue: s.venue, lastActive: s.lastActiveRel })),
    });
  }
  if (name === 'pending_questions') {
    const rows = await collectSessions({ minutes: args.minutes || 60, all: false });
    const mgd = manage.managedBySession();
    const waiting = rows.filter((s) => s.waiting);
    return textResult({
      note: 'Each window here has Claude speaking last then going quiet — it is blocked on a human. Drive safe ones with auto_continue (it sends "continue" when the question is ordinary work). Windows flagged irreversible touch deploy/send/delete/spend — do NOT auto-approve; surface them to the human.',
      count: waiting.length,
      windows: waiting.map((s) => {
        const waitingFor = lastAssistantText(s);
        const c = policy.classify(waitingFor);
        return {
          label: s.label, sessionId: s.sessionId, shortId: s.shortId,
          managed: !!mgd[s.sessionId], branch: s.gitBranch, cwd: s.cwd,
          waitingFor, lastActive: s.lastActiveRel,
          irreversible: c.irreversible, categories: c.categories,
        };
      }),
    });
  }
  if (name === 'auto_continue') {
    if (!args.session) throw new Error('session is required');
    const reply = (args.text && String(args.text)) || 'continue';
    const s = await findSession(args.session);
    if (!s) return textResult({ ok: false, error: `no session matched "${args.session}" — try pending_questions or list_sessions.` });
    const question = lastAssistantText(s);
    const decision = policy.gate(question, reply);
    if (!decision.allow) {
      return textResult({
        ok: false, gated: true, sent: false, session: s.label,
        reason: decision.reason, categories: decision.categories, matched: decision.matched,
        question, proposedReply: reply,
        note: 'NOT sent — this is an irreversible step. Surface the question to the human; relay their decision with reply_to_session once they choose.',
      });
    }
    const r = await replyToSession(args.session, reply);
    return textResult({ ...r, gated: false, sent: !!r.ok, sentText: reply, reason: decision.reason, question });
  }
  if (name === 'reply_to_session') {
    if (!args.session) throw new Error('session is required');
    const r = await replyToSession(args.session, args.text || '');
    return textResult(r);
  }
  if (name === 'send_key') {
    if (!args.session || !args.key) throw new Error('session and key are required');
    const managedBySession = manage.managedBySession();
    const s = await findSession(args.session);
    const w = (s && managedBySession[s.sessionId])
      || manage.listManaged().find((x) => x.label === manage.sanitize(args.session));
    if (!w) return textResult({ ok: false, error: `"${args.session}" is not a managed window — reply_to_session adopts it first, then send_key works.` });
    return textResult(manage.key(w.label, args.key));
  }
  if (name === 'run_window') {
    if (!args.label) throw new Error('label is required');
    if (!manage.hasTmux()) return textResult({ ok: false, error: 'tmux is not installed (brew install tmux).' });
    let cwd = (args.cwd || '').trim();
    cwd = cwd ? cwd.replace(/^~(?=$|\/)/, require('os').homedir()) : require('os').homedir();
    const r = manage.run(args.label, [], cwd, { capture: false });
    if (r.ok) manage.deliverAdopted(r.label, args.prompt || '');   // accept startup prompts; deliver first prompt if any
    return textResult(r.ok
      ? { ok: true, label: r.label, cwd, prompt: args.prompt || null, note: 'launched; drive it with reply_to_session / send_key.' }
      : r);
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
