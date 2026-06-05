'use strict';

// Conductor core — shared by the CLI (scan.js) and the daemon (server.js).
// Read-only. Streams Claude Code session transcripts and returns one row per live
// session. Zero dependencies.

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { execSync } = require('child_process');

const HOME = os.homedir();
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const LABELS_FILE = path.join(HOME, '.conductor', 'labels.json');

const RING = 40; // keep last N message-bearing records per session

// ---------------------------------------------------------------------------
// Friendly project labels — the "key" shown big on each card.
// Auto-derived from the working directory, overridable via ~/.conductor/labels.json
// (a flat { "<cwd-basename>": "Friendly Name" } map). Falls back to a prettified dir.
// ---------------------------------------------------------------------------
let _labelCache = null;
let _labelMtime = 0;
function loadLabels() {
  try {
    const st = fs.statSync(LABELS_FILE);
    if (_labelCache && st.mtimeMs === _labelMtime) return _labelCache;
    _labelCache = JSON.parse(fs.readFileSync(LABELS_FILE, 'utf8'));
    _labelMtime = st.mtimeMs;
  } catch {
    _labelCache = {};
  }
  return _labelCache;
}

function prettify(name) {
  if (!name) return '(unknown)';
  return name
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function labelFor(cwd) {
  if (!cwd) return '(unknown)';
  const base = path.basename(cwd);
  const map = loadLabels();
  return map[base] || prettify(base);
}

// ---------------------------------------------------------------------------
// Transcript discovery + parsing
// ---------------------------------------------------------------------------
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

function clip(str, n) {
  if (str == null) return '';
  str = String(str).replace(/\s+/g, ' ').trim();
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

function summarizeUser(r) {
  const c = r.message && r.message.content;
  if (typeof c === 'string') return { kind: 'prompt', userText: c, summary: clip(c, 100) };
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

function readSession(file) {
  return new Promise((resolve) => {
    const s = {
      file, sessionId: null, cwd: null, gitBranch: null, slug: null,
      aiTitle: null, lastPrompt: null, lastUserText: null,
      lastActivityTs: 0, isSidechain: false, recent: [],
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
      if (r.cwd && !s.cwd) s.cwd = r.cwd;   // FIRST cwd = launch dir = the session's project (where --resume finds it)
      if (r.gitBranch) s.gitBranch = r.gitBranch;
      if (r.slug) s.slug = r.slug;
      if (r.isSidechain === true) s.isSidechain = true;
      const ts = r.timestamp ? Date.parse(r.timestamp) : NaN;
      if (!isNaN(ts) && ts > s.lastActivityTs) s.lastActivityTs = ts;
      switch (r.type) {
        case 'ai-title': if (r.aiTitle) s.aiTitle = r.aiTitle; return;
        case 'last-prompt': if (r.lastPrompt != null) s.lastPrompt = String(r.lastPrompt); return;
        case 'user': {
          const item = summarizeUser(r);
          if (item) {
            if (item.userText) s.lastUserText = item.userText;
            push(s, { role: 'user', ts, kind: item.kind, summary: item.summary });
          }
          return;
        }
        case 'assistant': {
          const item = summarizeAssistant(r);
          if (item) push(s, { role: 'assistant', ts, kind: item.kind, summary: item.summary });
          return;
        }
        default: return;
      }
    });
    rl.on('error', () => resolve(s));
    rl.on('close', () => resolve(s));
  });
}

function push(s, item) {
  s.recent.push(item);
  if (s.recent.length > RING) s.recent.shift();
}

// Run `fn` over items with at most `limit` in flight — bounds concurrent file streams so a
// huge ~/.claude/projects (or --all) can't exhaust file descriptors.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
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

// "Needs you": a LIVE window where Claude has spoken last and then gone quiet — i.e. it's
// sitting at the prompt waiting for your reply (or blocked on a question). We key off a live
// process so closed/idle transcripts (whose last line is also assistant text) don't nag, and
// require a few seconds of quiet so we don't flag a response that's still streaming. The last
// event being a tool_use/thinking/user means Claude is still working → not waiting.
function waitingForYou(s, isOpen) {
  if (!isOpen || !s.recent.length) return false;
  const last = s.recent[s.recent.length - 1];
  const quietSec = (Date.now() - s.lastActivityTs) / 1000;
  return last.role === 'assistant' && last.kind === 'text' && quietSec >= 15;
}

// status: how alive is this window.
//   active = open process AND wrote in last 5 min (working right now)
//   open   = a live `claude` process exists for it, but it's been quiet
//   recent = no detected process, but wrote within the hour
//   idle   = quiet and no process (likely closed; only shown via a wide time window)
function statusOf(lastActivityTs, isOpen) {
  const min = (Date.now() - lastActivityTs) / 60000;
  if (isOpen) return min < 5 ? 'active' : 'open';
  if (min < 5) return 'active';
  if (min < 60) return 'recent';
  return 'idle';
}
const STATUS_RANK = { active: 0, open: 1, recent: 2, idle: 3 };

// Detect actually-open windows by their running `claude` process. The transcript file
// isn't held open, so process presence (not file mtime) is the real "this window is open"
// signal. Many windows can share one cwd, so for a cwd with K live processes we treat the
// K most-recently-used transcripts in that folder as those windows (best-effort heuristic).
function listOpenWindows() {
  const result = { files: new Set(), count: 0 };
  let out;
  try {
    out = execSync('lsof -a -c claude -d cwd -nP -Fpn', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 });
  } catch { return result; }

  const cwdCounts = new Map();
  for (const line of out.split('\n')) {
    if (line[0] === 'n') {
      const cwd = line.slice(1);
      cwdCounts.set(cwd, (cwdCounts.get(cwd) || 0) + 1);
    }
  }
  for (const [cwd, k] of cwdCounts) {
    const dir = path.join(PROJECTS_DIR, cwd.replace(/\//g, '-'));
    let names;
    try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); }
    catch { continue; }
    const newest = names
      .map((f) => { const p = path.join(dir, f); let m = 0; try { m = fs.statSync(p).mtimeMs; } catch { } return { p, m }; })
      .sort((a, b) => b.m - a.m)
      .slice(0, k);
    for (const { p } of newest) result.files.add(p);
    result.count += newest.length;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Public: collect one row per live session.
// ---------------------------------------------------------------------------
async function collectSessions(opts = {}) {
  const minutes = opts.minutes || 10;
  const all = !!opts.all;
  const limit = opts.limit || 0;

  const files = findTranscripts(PROJECTS_DIR, []);
  const cutoff = Date.now() - minutes * 60 * 1000;
  const open = opts.detectOpen === false ? { files: new Set() } : listOpenWindows();

  // Candidate files = open windows (always) ∪ recently-touched (time filter).
  const fresh = [];
  for (const f of files) {
    try {
      if (open.files.has(f)) { fresh.push(f); continue; }
      const st = fs.statSync(f);
      if (all || st.mtimeMs >= cutoff) fresh.push(f);
    } catch { /* ignore */ }
  }

  const parsed = await mapLimit(fresh, 24, readSession);   // cap open file streams (--all can be huge)

  const bySession = new Map();
  for (const s of parsed) {
    if (s.isSidechain || !s.sessionId) continue;
    const prev = bySession.get(s.sessionId);
    if (!prev || s.lastActivityTs > prev.lastActivityTs) bySession.set(s.sessionId, s);
  }

  let sessions = [...bySession.values()].sort((a, b) => {
    const ra = STATUS_RANK[statusOf(a.lastActivityTs, open.files.has(a.file))];
    const rb = STATUS_RANK[statusOf(b.lastActivityTs, open.files.has(b.file))];
    return ra - rb || b.lastActivityTs - a.lastActivityTs;
  });
  if (limit > 0) sessions = sessions.slice(0, limit);

  const homeBase = path.basename(HOME);
  return sessions.map((s) => ({
    open: open.files.has(s.file),
    waiting: waitingForYou(s, open.files.has(s.file)),
    sessionId: s.sessionId,
    shortId: s.sessionId ? s.sessionId.slice(0, 8) : '????????',
    label: labelFor(s.cwd),                 // friendly project name (used for managed naming)
    // "place" = project context shown as a chip, but ONLY when it's a real project dir
    // (blank for home/scratch sessions, where the dir says nothing about the work).
    place: s.cwd && path.basename(s.cwd) !== homeBase ? labelFor(s.cwd) : '',
    project: s.cwd ? path.basename(s.cwd) : '(unknown)',
    cwd: s.cwd,
    gitBranch: s.gitBranch || null,
    title: s.aiTitle || null,                // plain-language "what this window is about"
    task: s.aiTitle || s.slug || null,       // (kept for back-compat)
    intent: s.lastPrompt || s.lastUserText || null,
    lastAction: lastAction(s),
    recent: s.recent.slice(-12),
    status: statusOf(s.lastActivityTs, open.files.has(s.file)),
    lastActiveTs: s.lastActivityTs,
    lastActiveRel: relTime(s.lastActivityTs),
    file: s.file,
  }));
}

module.exports = { collectSessions, labelFor, prettify, relTime, clip, PROJECTS_DIR, LABELS_FILE };
