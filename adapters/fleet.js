'use strict';

// Conductor adapter: trading-bot fleet.
//
// The first new use case beyond Claude Code — proof that the engine is genuinely
// source-agnostic. Convention-over-config, mirroring Conductor's "read a trail that already
// exists" ethos: each bot writes an append-only event log at
//   ~/.fleet/bots/<bot>/events.jsonl
// one JSON record per line: { ts, type, ... } where type ∈
//   signal | order | fill | pnl | heartbeat | error
// An optional ~/.fleet/bots/<bot>/meta.json gives { strategy, mandate, venue, symbol }.
//
// Observation is read-only. Control is opt-in: commands are appended to
//   ~/.fleet/bots/<bot>/control.jsonl
// which the bot itself polls. Capabilities: pause | resume | flatten | set-param.
// broadcast('flatten') is the desk-wide panic flatten.
//
// The fleet root is ~/.fleet, overridable with FLEET_DIR (used by the tests).

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { clip, prettify } = require('../util');

const LIVE_MINUTES = 2;       // a bot is "live" if it emitted anything within this window
const WEDGE_MINUTES = 5;      // an order/signal with no fill older than this = wedged
const DRAWDOWN_PCT = 0.1;     // equity off its peak by this fraction = drawdown signal
const RING = 12;              // recent non-heartbeat events surfaced per bot

function fleetRoot() { return process.env.FLEET_DIR || path.join(os.homedir(), '.fleet'); }
function botsDir() { return path.join(fleetRoot(), 'bots'); }
function botName(handle) { return path.basename(path.dirname(handle)); }
function safeBot(name) { return /^[A-Za-z0-9_.-]+$/.test(String(name)); }

// ---------------------------------------------------------------------------
// Reading trails
// ---------------------------------------------------------------------------

// Read just the tail of a file (last `bytes`) and return the parsed complete JSON lines. Used by
// liveness so we never stream a whole large log just to learn its newest timestamp.
function tailRecords(file, bytes = 8192) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    let text = buf.toString('utf8');
    if (len < size) text = text.slice(text.indexOf('\n') + 1); // drop the partial first line
    const out = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip */ }
    }
    return out;
  } catch { return []; }
  finally { if (fd != null) try { fs.closeSync(fd); } catch { /* ignore */ } }
}

function readMeta(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); }
  catch { return {}; }
}

function tsOf(r) {
  if (r == null) return NaN;
  if (typeof r.ts === 'number') return r.ts;
  const t = Date.parse(r.ts);
  return isNaN(t) ? NaN : t;
}

function sideSign(side) {
  const s = String(side || '').toLowerCase();
  if (s === 'buy' || s === 'long' || s === 'b' || s === 'bid') return 1;
  if (s === 'sell' || s === 'short' || s === 's' || s === 'ask') return -1;
  return 0;
}

function fmtSigned(n) {
  if (n == null || isNaN(n)) return '0';
  const r = Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 100) / 100;
  return (r >= 0 ? '+' : '') + r;
}

function describe(ev) {
  const px = ev.price != null ? ' @ ' + ev.price : '';
  switch (ev.type) {
    case 'signal': return clip(`signal ${ev.side || ''} ${ev.reason || ''}`.trim(), 80);
    case 'order': return clip(`order ${ev.side || ''} ${ev.qty != null ? ev.qty : ''}${px}`.trim(), 80);
    case 'fill': return clip(`filled ${ev.side || ''} ${ev.qty != null ? ev.qty : ''}${px}`.trim(), 80);
    case 'pnl': return `pnl ${fmtSigned(ev.pnl != null ? ev.pnl : (ev.realized || 0) + (ev.unrealized || 0))}`;
    case 'error': return clip('error: ' + (ev.message || 'unknown'), 80);
    case 'heartbeat': return 'heartbeat';
    default: return clip(ev.type || 'event', 80);
  }
}

// ---------------------------------------------------------------------------
// Adapter contract
// ---------------------------------------------------------------------------

function listBots() {
  let entries;
  try { entries = fs.readdirSync(botsDir(), { withFileTypes: true }); }
  catch { return []; }
  return entries.filter((e) => e.isDirectory() && safeBot(e.name)).map((e) => e.name);
}

function discover() {
  const out = [];
  for (const bot of listBots()) {
    const file = path.join(botsDir(), bot, 'events.jsonl');
    if (fs.existsSync(file)) out.push(file);
  }
  return out;
}

function liveness(handles, opts = {}) {
  const liveMs = (opts.liveMinutes || LIVE_MINUTES) * 60000;
  const now = Date.now();
  const live = new Set();
  for (const h of handles) {
    const tail = tailRecords(h);
    let newest = 0;
    for (const r of tail) { const t = tsOf(r); if (!isNaN(t) && t > newest) newest = t; }
    if (newest && (now - newest) <= liveMs) live.add(h);
  }
  return live;
}

async function parse(handle, opts = {}) {
  const dir = path.dirname(handle);
  const bot = botName(handle);
  if (!safeBot(bot)) return null;
  const meta = readMeta(dir);

  const s = {
    lastTs: 0, lastFillTs: 0, lastOrderSignalTs: 0,
    position: 0, sessionPnl: null, equity: null, peakEquity: null,
    recent: [], lastMeaningful: null, lastOrderSignal: null,
  };

  await new Promise((resolve) => {
    let stream;
    try { stream = fs.createReadStream(handle, { encoding: 'utf8' }); }
    catch { return resolve(); }
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let ev; try { ev = JSON.parse(line); } catch { return; }
      if (!ev || typeof ev !== 'object') return;
      const t = tsOf(ev);
      if (!isNaN(t) && t > s.lastTs) s.lastTs = t;
      switch (ev.type) {
        case 'fill': {
          s.position += sideSign(ev.side) * (Number(ev.qty) || 0);
          if (!isNaN(t)) s.lastFillTs = Math.max(s.lastFillTs, t);
          break;
        }
        case 'order':
        case 'signal':
          if (!isNaN(t) && t >= s.lastOrderSignalTs) { s.lastOrderSignalTs = t; s.lastOrderSignal = ev; }
          break;
        case 'pnl': {
          s.sessionPnl = ev.pnl != null ? ev.pnl : (ev.realized || 0) + (ev.unrealized || 0);
          if (ev.equity != null) {
            s.equity = ev.equity;
            s.peakEquity = s.peakEquity == null ? ev.equity : Math.max(s.peakEquity, ev.equity);
          }
          break;
        }
        case 'heartbeat': break;
        case 'error': break;
        default: break;
      }
      if (ev.type !== 'heartbeat') {
        s.lastMeaningful = ev;
        s.recent.push({ actor: 'bot', kind: ev.type, summary: describe(ev), ts: isNaN(t) ? 0 : t });
        if (s.recent.length > RING) s.recent.shift();
      }
    });
    rl.on('error', resolve);
    rl.on('close', resolve);
  });

  if (!s.lastTs && !s.recent.length) return null; // empty trail

  const now = Date.now();
  const wedgeMs = (opts.wedgeMinutes || WEDGE_MINUTES) * 60000;
  const ddThresh = opts.drawdownPct || DRAWDOWN_PCT;
  // wedged: an order/signal with no fill after it, older than the threshold.
  const wedged = s.lastOrderSignalTs > 0 && s.lastOrderSignalTs > s.lastFillTs
    && (now - s.lastOrderSignalTs) > wedgeMs;
  const drawdownPct = (s.peakEquity && s.peakEquity > 0 && s.equity != null)
    ? Math.max(0, (s.peakEquity - s.equity) / s.peakEquity) : 0;
  const drawdown = drawdownPct >= ddThresh;

  const venue = meta.venue || null;
  const posStr = s.position === 0 ? 'flat' : `pos ${fmtSigned(s.position)}${meta.symbol ? ' ' + meta.symbol : ''}`;
  const context = [
    venue,
    posStr,
    s.sessionPnl != null ? `PnL ${fmtSigned(s.sessionPnl)}` : null,
    drawdown ? `DD ${(drawdownPct * 100).toFixed(0)}%` : null,
  ].filter(Boolean);

  const lastAction = wedged && s.lastOrderSignal
    ? `⚠ ${describe(s.lastOrderSignal)} — awaiting fill`
    : (s.lastMeaningful ? describe(s.lastMeaningful) : 'idle');

  return {
    id: bot,
    shortId: bot.length > 12 ? bot.slice(0, 12) : bot,
    label: meta.name || prettify(bot),
    title: meta.strategy || prettify(bot),
    intent: meta.mandate || null,
    context,
    recent: s.recent.slice(-RING),
    lastAction,
    lastActivityTs: s.lastTs,
    statusInputs: { lastActivityTs: s.lastTs, wedged, drawdown, drawdownPct, sessionPnl: s.sessionPnl, position: s.position },
    // --- fleet passthrough (surfaces + risk_snapshot) ---
    bot, venue, position: s.position, sessionPnl: s.sessionPnl,
    equity: s.equity, drawdownPct, wedged, drawdown,
  };
}

function status(rec, ctx) {
  const si = rec.statusInputs || {};
  if (si.wedged) return 'wedged';
  if (si.drawdown) return 'drawdown';
  if (ctx && ctx.live) return 'active';
  return 'idle';
}

const statuses = [
  { key: 'wedged', title: 'WEDGED', word: 'wedged', color: 'red' },
  { key: 'drawdown', title: 'DRAWDOWN', word: 'drawdown', color: 'amber' },
  { key: 'active', title: 'TRADING', word: 'live', color: 'green' },
  { key: 'idle', title: 'IDLE', word: 'idle', color: 'dim' },
];

// ---------------------------------------------------------------------------
// Control — append commands the bot polls. Bot names are validated (no traversal); commands are
// written as structured JSON, never interpolated into a shell.
// ---------------------------------------------------------------------------
const CAPS = ['pause', 'resume', 'flatten', 'set-param'];

function writeControl(bot, command = {}) {
  if (!safeBot(bot)) return { ok: false, error: `invalid bot name "${bot}"` };
  const cmd = command.cmd;
  if (!CAPS.includes(cmd)) return { ok: false, error: `unknown command "${cmd}" (capabilities: ${CAPS.join(', ')})` };
  const dir = path.join(botsDir(), bot);
  if (!fs.existsSync(dir)) return { ok: false, error: `no such bot "${bot}"` };
  const rec = { ts: Date.now(), ...command };
  try {
    fs.appendFileSync(path.join(dir, 'control.jsonl'), JSON.stringify(rec) + '\n');
    return { ok: true, bot, command: rec };
  } catch (e) { return { ok: false, error: e.message }; }
}

const control = {
  capabilities: CAPS,
  send(target, command) { return writeControl(target, command); },
  broadcast(command) {
    const bots = listBots();
    let sent = 0; const errors = [];
    for (const b of bots) { const r = writeControl(b, command); if (r.ok) sent++; else errors.push(b); }
    return { ok: true, sent, total: bots.length, errors };
  },
};

module.exports = { discover, liveness, parse, status, statuses, control, listBots, fleetRoot };
