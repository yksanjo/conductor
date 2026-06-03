#!/usr/bin/env node
'use strict';

// Conductor — read-only situational awareness across your live Claude Code sessions.
//
// Scans ~/.claude/projects/**/*.jsonl, selects the sessions that were active recently,
// and reports what each one is doing / last did. Zero dependencies. Read-only: it never
// touches, writes to, or interrupts a running session — it only reads transcript files
// the user already owns.
//
// Usage:
//   node scan.js                 pretty table of live sessions
//   node scan.js --json          structured JSON (for the /conductor skill to summarize)
//   node scan.js --minutes 30    change the "live" window (default 10 min)
//   node scan.js --all           ignore the time filter, show every session (debug)

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const HOME = os.homedir();
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');

function parseArgs(argv) {
  const a = { json: false, minutes: 10, all: false, limit: 0 };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--json') a.json = true;
    else if (v === '--all') a.all = true;
    else if (v === '--minutes') a.minutes = parseInt(argv[++i], 10) || 10;
    else if (v === '--limit') a.limit = parseInt(argv[++i], 10) || 0;
    else if (v === '-h' || v === '--help') a.help = true;
  }
  return a;
}

// Recursively find *.jsonl under PROJECTS_DIR, excluding subagent threads.
function findTranscripts(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'subagents') continue; // exclude subagent sub-threads
      findTranscripts(full, out);
    } else if (e.isFile() && e.name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
  return out;
}

// Stream a transcript, keeping only what we need: latest metadata, latest aiTitle /
// lastPrompt, and a small ring buffer of recent message/tool records. Never loads the
// whole (potentially 8MB+) file into memory. Tolerates malformed lines and unknown types.
const RING = 40; // keep last N message-bearing records

function readSession(file) {
  return new Promise((resolve) => {
    const s = {
      file,
      sessionId: null,
      cwd: null,
      gitBranch: null,
      slug: null,
      aiTitle: null,
      lastPrompt: null,
      lastUserText: null,
      lastActivityTs: 0,
      isSidechain: false,
      recent: [], // {role, ts, kind, summary}
    };
    let stream;
    try { stream = fs.createReadStream(file, { encoding: 'utf8' }); }
    catch { return resolve(s); }
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      if (!line) return;
      let r;
      try { r = JSON.parse(line); } catch { return; }
      if (!r || typeof r !== 'object') return;

      if (r.sessionId) s.sessionId = r.sessionId;
      if (r.cwd) s.cwd = r.cwd;
      if (r.gitBranch) s.gitBranch = r.gitBranch;
      if (r.slug) s.slug = r.slug;
      if (r.isSidechain === true) s.isSidechain = true;

      const ts = r.timestamp ? Date.parse(r.timestamp) : NaN;
      if (!isNaN(ts) && ts > s.lastActivityTs) s.lastActivityTs = ts;

      switch (r.type) {
        case 'ai-title':
          if (r.aiTitle) s.aiTitle = r.aiTitle;
          return;
        case 'last-prompt':
          if (r.lastPrompt != null) s.lastPrompt = String(r.lastPrompt);
          return;
        case 'user': {
          const item = summarizeUser(r);
          if (item) {
            if (item.userText) s.lastUserText = item.userText;
            pushRecent(s, { role: 'user', ts, kind: item.kind, summary: item.summary });
          }
          return;
        }
        case 'assistant': {
          const item = summarizeAssistant(r);
          if (item) pushRecent(s, { role: 'assistant', ts, kind: item.kind, summary: item.summary });
          return;
        }
        default:
          return; // permission-mode, mode, attachment, queue-operation, system, snapshots, unknown — ignore
      }
    });
    rl.on('error', () => resolve(s));
    rl.on('close', () => resolve(s));
  });
}

function pushRecent(s, item) {
  s.recent.push(item);
  if (s.recent.length > RING) s.recent.shift();
}

function clip(str, n) {
  if (str == null) return '';
  str = String(str).replace(/\s+/g, ' ').trim();
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

function summarizeUser(r) {
  const c = r.message && r.message.content;
  if (typeof c === 'string') {
    return { kind: 'prompt', userText: c, summary: clip(c, 100) };
  }
  if (Array.isArray(c)) {
    const types = c.map((x) => x && x.type);
    if (types.includes('tool_result')) return { kind: 'tool_result', summary: 'tool result' };
    const textItem = c.find((x) => x && x.type === 'text');
    if (textItem) return { kind: 'prompt', userText: textItem.text, summary: clip(textItem.text, 100) };
  }
  return null;
}

function summarizeAssistant(r) {
  const c = r.message && r.message.content;
  if (typeof c === 'string') return { kind: 'text', summary: clip(c, 100) };
  if (Array.isArray(c)) {
    const tool = c.find((x) => x && x.type === 'tool_use');
    if (tool) {
      let hint = '';
      const inp = tool.input || {};
      if (inp.command) hint = clip(inp.command, 50);
      else if (inp.file_path) hint = clip(inp.file_path, 50);
      else if (inp.pattern) hint = clip(inp.pattern, 50);
      else if (inp.description) hint = clip(inp.description, 50);
      return { kind: 'tool_use', summary: hint ? `${tool.name}: ${hint}` : tool.name };
    }
    const txt = c.find((x) => x && x.type === 'text');
    if (txt) return { kind: 'text', summary: clip(txt.text, 100) };
    if (c.some((x) => x && x.type === 'thinking')) return { kind: 'thinking', summary: '(thinking)' };
  }
  return null;
}

function relTime(ts) {
  if (!ts) return 'unknown';
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function lastAction(s) {
  for (let i = s.recent.length - 1; i >= 0; i--) {
    const r = s.recent[i];
    if (r.kind === 'tool_use') return '🔧 ' + r.summary;
    if (r.kind === 'text' && r.role === 'assistant') return '💬 ' + r.summary;
  }
  return s.recent.length ? s.recent[s.recent.length - 1].summary : '—';
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('conductor — situational awareness across your live Claude Code sessions\n');
    console.log('Usage: conductor [--json] [--minutes N] [--all] [--limit N]');
    return;
  }

  const files = findTranscripts(PROJECTS_DIR, []);
  const cutoff = Date.now() - args.minutes * 60 * 1000;

  // mtime filter BEFORE parsing (folders hold thousands of historical transcripts).
  const fresh = [];
  for (const f of files) {
    try {
      const st = fs.statSync(f);
      if (args.all || st.mtimeMs >= cutoff) fresh.push({ file: f, mtimeMs: st.mtimeMs });
    } catch { /* ignore */ }
  }
  fresh.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const parsed = await Promise.all(fresh.map((x) => readSession(x.file)));

  // Group by sessionId; keep the most-recently-active record per session. Drop sidechains.
  const bySession = new Map();
  for (const s of parsed) {
    if (s.isSidechain) continue;
    if (!s.sessionId) continue;
    const prev = bySession.get(s.sessionId);
    if (!prev || s.lastActivityTs > prev.lastActivityTs) bySession.set(s.sessionId, s);
  }

  let sessions = [...bySession.values()].sort((a, b) => b.lastActivityTs - a.lastActivityTs);
  if (args.limit > 0) sessions = sessions.slice(0, args.limit);

  const rows = sessions.map((s) => ({
    sessionId: s.sessionId,
    shortId: s.sessionId ? s.sessionId.slice(0, 8) : '????????',
    project: s.cwd ? path.basename(s.cwd) : '(unknown)',
    cwd: s.cwd,
    gitBranch: s.gitBranch || null,
    title: s.aiTitle || s.slug || null,
    intent: s.lastPrompt || s.lastUserText || null,
    lastAction: lastAction(s),
    recent: s.recent.slice(-12),
    lastActiveTs: s.lastActivityTs,
    lastActiveRel: relTime(s.lastActivityTs),
    file: s.file,
  }));

  if (args.json) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), windowMinutes: args.minutes, count: rows.length, sessions: rows }, null, 2));
    return;
  }

  // Pretty table (standalone, no Claude needed).
  if (!rows.length) {
    console.log(`No Claude Code sessions active in the last ${args.minutes} min. (Try --minutes 60 or --all.)`);
    return;
  }
  console.log(`\n🎼 Conductor — ${rows.length} session${rows.length > 1 ? 's' : ''} touched in last ${args.minutes} min (newest activity first)\n`);
  for (const r of rows) {
    const loc = r.gitBranch ? `${r.project} @ ${r.gitBranch}` : r.project;
    console.log(`● ${r.shortId}  ${loc}  · ${r.lastActiveRel}`);
    if (r.title) console.log(`    ▸ ${clip(r.title, 88)}`);
    if (r.intent) console.log(`    goal: ${clip(r.intent, 88)}`);
    console.log(`    last: ${clip(r.lastAction, 88)}`);
    console.log('');
  }
}

main().catch((e) => { console.error('conductor error:', e.message); process.exit(1); });
