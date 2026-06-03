#!/usr/bin/env node
'use strict';

// conductor — one entry point. Dispatches to the table view, the web cockpit, or the
// MCP server. Read-only. Zero dependencies.

const path = require('path');
const { spawn } = require('child_process');

const args = process.argv.slice(2);
const cmd = (args[0] || '').toLowerCase();
const rest = args.slice(1);
const HERE = __dirname;

const HELP = `🎼 conductor — situational awareness across your live Claude Code windows

usage
  conductor                list your live windows (table)
  conductor ls [opts]        same; opts: --minutes N  --all  --json  --limit N
  conductor up [opts]        launch the web cockpit, opens your browser
                             opts: --port N (default 7591)  --no-open
  conductor mcp              run the MCP server (stdio; for agent integration)
  conductor help             show this

examples
  conductor                  # quick glance, terminal table
  conductor up               # open the visual cockpit
  conductor ls --all         # every session, not just live ones

labels    edit ~/.conductor/labels.json to name your projects (live-reloads)
read-only it never touches or interrupts a running window`;

function run(script, a) {
  const child = spawn(process.execPath, [path.join(HERE, script), ...a], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code == null ? 0 : code));
  child.on('error', (e) => { console.error('conductor: ' + e.message); process.exit(1); });
}

if (['help', '-h', '--help'].includes(cmd)) {
  console.log(HELP);
} else if (cmd === '' || cmd.startsWith('-')) {
  run('scan.js', args);                 // bare `conductor` or `conductor --minutes 60`
} else if (['ls', 'list', 'table'].includes(cmd)) {
  run('scan.js', rest);
} else if (['up', 'cockpit', 'serve', 'web'].includes(cmd)) {
  run('server.js', rest);
} else if (cmd === 'mcp') {
  run('mcp.js', rest);
} else {
  console.error(`conductor: unknown command "${cmd}"\n`);
  console.log(HELP);
  process.exit(1);
}
