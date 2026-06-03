#!/usr/bin/env node
'use strict';

// Conductor CLI — pretty table / JSON of your live Claude Code sessions.
// Read-only. See lib.js for the engine. Zero dependencies.
//
//   conductor                 pretty table, active in last 10 min
//   conductor --minutes 60    widen the window
//   conductor --all           every session, ignore time filter
//   conductor --json          structured JSON (for the /conductor skill)
//   conductor --limit N       cap rows

const { collectSessions, clip } = require('./lib');

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

const DOT = { active: '🟢', open: '🟢', recent: '🟡', idle: '⚪' };

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('conductor — situational awareness across your live Claude Code sessions\n');
    console.log('Usage: conductor [--json] [--minutes N] [--all] [--limit N]');
    return;
  }
  const rows = await collectSessions(args);

  if (args.json) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), windowMinutes: args.minutes, count: rows.length, sessions: rows }, null, 2));
    return;
  }
  if (!rows.length) {
    console.log(`No Claude Code sessions touched in the last ${args.minutes} min. (Try --minutes 60 or --all.)`);
    return;
  }
  console.log(`\n🎼 Conductor — ${rows.length} session${rows.length > 1 ? 's' : ''} touched in last ${args.minutes} min (newest activity first)\n`);
  for (const r of rows) {
    const loc = r.gitBranch ? `${r.label} · ${r.gitBranch}` : r.label;
    console.log(`${DOT[r.status] || '⚪'} ${r.shortId}  ${loc}  · ${r.lastActiveRel}`);
    if (r.task) console.log(`    ▸ ${clip(r.task, 88)}`);
    console.log(`    last: ${clip(r.lastAction, 88)}`);
    console.log('');
  }
}

main().catch((e) => { console.error('conductor error:', e.message); process.exit(1); });
