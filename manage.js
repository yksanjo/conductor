'use strict';

// Conductor control plane — launch and steer Claude Code windows that run inside tmux.
// A plain-terminal Claude TUI can't have input injected (macOS removed TIOCSTI), so the
// only reliable channel is tmux send-keys. Conductor therefore "manages" windows it
// launches into a dedicated tmux session ("conductor"), one window per label. It records
// each window's transcript sessionId so the cockpit can attach reply buttons to the right
// card. All tmux calls use arg arrays (no shell), so reply text is never interpolated.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const HOME = os.homedir();
const REG_FILE = path.join(HOME, '.conductor', 'managed.json');
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const SESSION = 'conductor'; // tmux session that holds all managed windows

function tmux(args, opts = {}) {
  const r = spawnSync('tmux', args, { encoding: 'utf8', ...opts });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
function hasTmux() { return spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status === 0; }

function sanitize(label) {
  return String(label).trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'window';
}
function target(label) { return `${SESSION}:${sanitize(label)}`; }

function loadReg() {
  try { return JSON.parse(fs.readFileSync(REG_FILE, 'utf8')); } catch { return { windows: {} }; }
}
function saveReg(reg) {
  fs.mkdirSync(path.dirname(REG_FILE), { recursive: true });
  fs.writeFileSync(REG_FILE, JSON.stringify(reg, null, 2));
}

function folderFor(cwd) { return path.join(PROJECTS_DIR, cwd.replace(/\//g, '-')); }
function jsonlSet(cwd) {
  try { return new Set(fs.readdirSync(folderFor(cwd)).filter((f) => f.endsWith('.jsonl'))); }
  catch { return new Set(); }
}

function sessionExists() { return tmux(['has-session', '-t', SESSION]).code === 0; }
function windowAlive(label) {
  const r = tmux(['list-windows', '-t', SESSION, '-F', '#{window_name}']);
  if (r.code !== 0) return false;
  return r.out.split('\n').includes(sanitize(label));
}

// Launch a new managed window running `claude` in tmux, capture its sessionId.
function run(label, claudeArgs, cwd) {
  if (!hasTmux()) return { ok: false, error: 'tmux is not installed (brew install tmux).' };
  const name = sanitize(label);
  cwd = cwd || process.cwd();
  if (windowAlive(name)) return { ok: false, error: `a managed window "${name}" already exists. Use a different label or: conductor stop ${name}` };

  const before = jsonlSet(cwd);

  if (!sessionExists()) {
    const r = tmux(['new-session', '-d', '-s', SESSION, '-n', name, '-c', cwd]);
    if (r.code !== 0) return { ok: false, error: 'tmux new-session failed: ' + r.err };
  } else {
    const r = tmux(['new-window', '-t', SESSION, '-n', name, '-c', cwd]);
    if (r.code !== 0) return { ok: false, error: 'tmux new-window failed: ' + r.err };
  }

  // Start claude inside the pane (typed into the shell so it stays visible / re-runnable).
  const cmd = ['claude', ...(claudeArgs || [])].join(' ');
  tmux(['send-keys', '-t', target(name), '-l', '--', cmd]);
  tmux(['send-keys', '-t', target(name), 'Enter']);

  // Capture the new transcript sessionId (claude writes a fresh .jsonl on start).
  let sessionId = null;
  for (let i = 0; i < 16; i++) {                 // poll up to ~8s
    const now = jsonlSet(cwd);
    const fresh = [...now].filter((f) => !before.has(f));
    if (fresh.length) { sessionId = fresh[0].replace(/\.jsonl$/, ''); break; }
    spawnSync('sleep', ['0.5']);
  }

  const reg = loadReg();
  reg.windows[name] = { label: name, target: target(name), cwd, created: Date.now(), sessionId };
  saveReg(reg);
  return { ok: true, label: name, target: target(name), sessionId, attach: attachCommand(name) };
}

// Send a short reply (literal text + Enter). Reply text is passed as an arg, never shelled.
function say(label, text) {
  if (!hasTmux()) return { ok: false, error: 'tmux not installed' };
  const name = sanitize(label);
  if (!windowAlive(name)) return { ok: false, error: `no live managed window "${name}"` };
  tmux(['send-keys', '-t', target(name), '-l', '--', String(text)]);
  const r = tmux(['send-keys', '-t', target(name), 'Enter']);
  return r.code === 0 ? { ok: true, sent: text, label: name } : { ok: false, error: r.err };
}

// Send a named key (Escape, C-c, etc.) — for "stop"/interrupt.
function key(label, k) {
  if (!hasTmux()) return { ok: false, error: 'tmux not installed' };
  const name = sanitize(label);
  if (!windowAlive(name)) return { ok: false, error: `no live managed window "${name}"` };
  const r = tmux(['send-keys', '-t', target(name), k]);
  return r.code === 0 ? { ok: true, sent: k, label: name } : { ok: false, error: r.err };
}

function attachCommand(label) {
  const name = sanitize(label);
  return `tmux attach -t ${SESSION} \\; select-window -t ${name}`;
}

function stop(label) {
  const name = sanitize(label);
  const r = tmux(['kill-window', '-t', target(name)]);
  const reg = loadReg();
  delete reg.windows[name];
  saveReg(reg);
  return { ok: r.code === 0, label: name };
}

// Late-bind a window's sessionId: claude only writes a transcript once you send the first
// prompt (not at launch / trust prompt), so run()'s capture often misses it. Find the
// newest .jsonl in the window's cwd created at/after launch.
function resolveSession(w) {
  if (w.sessionId) return w.sessionId;
  try {
    const dir = folderFor(w.cwd);
    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .filter((x) => x.m >= (w.created || 0) - 1500)
      .sort((a, b) => b.m - a.m);
    if (files.length) return files[0].f.replace(/\.jsonl$/, '');
  } catch { /* ignore */ }
  return null;
}

// All managed windows, with liveness. Prunes dead ones; late-binds missing sessionIds.
function listManaged() {
  const reg = loadReg();
  const out = [];
  let changed = false;
  for (const name of Object.keys(reg.windows)) {
    const w = reg.windows[name];
    if (!windowAlive(name)) { delete reg.windows[name]; changed = true; continue; }
    if (!w.sessionId) { const sid = resolveSession(w); if (sid) { w.sessionId = sid; changed = true; } }
    out.push({ ...w, alive: true });
  }
  if (changed) saveReg(reg);
  return out;
}

// sessionId -> managed window, for the cockpit to flag/control the right card.
function managedBySession() {
  const map = {};
  for (const w of listManaged()) if (w.sessionId) map[w.sessionId] = w;
  return map;
}

module.exports = { run, say, key, stop, listManaged, managedBySession, attachCommand, sanitize, hasTmux, SESSION, REG_FILE };
