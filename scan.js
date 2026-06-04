#!/usr/bin/env node
'use strict';

// Conductor CLI — boxed, sectioned table (or JSON) of your live Claude Code sessions.
// Read-only. Engine in lib.js. Zero dependencies.
//
//   conductor                 boxed table, active in last 10 min
//   conductor --minutes 60    widen the window
//   conductor --all           every session, ignore time filter
//   conductor --json          structured JSON (for the /conductor skill)
//   conductor --limit N       cap rows

const { collectSessions } = require('./lib');

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

const TTY = process.stdout.isTTY;
const C = TTY
  ? { g:'\x1b[32m', t:'\x1b[36m', a:'\x1b[33m', d:'\x1b[90m', b:'\x1b[1m', dim:'\x1b[2m', r:'\x1b[0m' }
  : { g:'', t:'', a:'', d:'', b:'', dim:'', r:'' };
const STATUS = {
  active: { word:'working', col:C.g },
  open:   { word:'open',    col:C.t },
  recent: { word:'recent',  col:C.a },
  idle:   { word:'idle',    col:C.d },
};
const SECTIONS = [['active','WORKING NOW'],['open','OPEN'],['recent','RECENTLY ACTIVE'],['idle','IDLE']];

// strip emoji / wide chars so fixed-width box math stays correct (keep box-drawing + ·, …, ▸)
function plain(s) {
  return String(s == null ? '' : s)
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}️]/gu, '')
    .replace(/\s+/g, ' ').trim();
}
function fit(s, w) { s = plain(s); return s.length > w ? s.slice(0, w - 1) + '…' : s.padEnd(w); }

function box(W, r) {
  const inner = W - 4;                       // content width between "│ " and " │"
  const lines = [];
  // top border carries the short id like a window tab: ┌─ 1a2b3c4d ───┐
  const tab = `─ ${r.shortId} `;
  lines.push(C.d + '┌' + tab + '─'.repeat(Math.max(0, W - 2 - tab.length)) + '┐' + C.r);

  // header row: ● <what it's about> .................... <branch · age>
  const st = STATUS[r.status] || STATUS.idle;
  const right = (r.gitBranch ? r.gitBranch + ' · ' : '') + r.lastActiveRel;
  const leftW = Math.max(4, inner - right.length - 3);   // ● + two spaces = 3 cells
  const heading = fit(r.title || r.label, leftW);        // lead with the plain-language title
  const head = `${st.col}●${C.r} ${C.b}${heading}${C.r} ${C.d}${right}${C.r}`;
  lines.push(`${C.d}│${C.r} ${head} ${C.d}│${C.r}`);

  // context line (project, if a real project dir) + last action
  const ctx = r.place || '—';
  lines.push(`${C.d}│${C.r} ${C.dim}${fit(ctx, inner)}${C.r} ${C.d}│${C.r}`);
  lines.push(`${C.d}│${C.r} ${fit('› ' + plain(r.lastAction), inner)} ${C.d}│${C.r}`);

  lines.push(C.d + '└' + '─'.repeat(W - 2) + '┘' + C.r);
  return lines.join('\n');
}

function render(rows, args) {
  if (!rows.length) {
    console.log(`\nNo Claude Code sessions in the last ${args.minutes} min. Try: conductor --all\n`);
    return;
  }
  const W = Math.min((process.stdout.columns || 80) - 1, 86);
  console.log('');
  console.log(`${C.b}🎼 Conductor${C.r} — ${rows.length} window${rows.length > 1 ? 's' : ''} ${C.d}· last ${args.all ? 'all' : args.minutes + ' min'}${C.r}`);
  console.log(`${C.d}   cockpit: ${C.r}conductor up${C.d}   ·   control: ${C.r}conductor run <label>${C.d} / conductor say <label> yes${C.r}`);

  for (const [k, title] of SECTIONS) {
    const items = rows.filter((r) => r.status === k);
    if (!items.length) continue;
    const st = STATUS[k];
    console.log(`\n${st.col}${C.b}${title}${C.r} ${C.d}${'─'.repeat(Math.max(0, W - title.length - 1))}${C.r}`);
    for (const r of items) console.log(box(W, r));
  }
  console.log('');
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('conductor — situational awareness across your live Claude Code sessions\n');
    console.log('Usage: conductor [--json] [--minutes N] [--all] [--limit N]');
    console.log('       conductor up        # open the web control panel');
    console.log('       conductor help      # full command list');
    return;
  }
  const rows = await collectSessions(args);
  if (args.json) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), windowMinutes: args.minutes, count: rows.length, sessions: rows }, null, 2));
    return;
  }
  render(rows, args);
}

main().catch((e) => { console.error('conductor error:', e.message); process.exit(1); });
