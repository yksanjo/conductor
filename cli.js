#!/usr/bin/env node
'use strict';

// conductor — one entry point. Read view: table / cockpit / mcp. Control: run / say /
// attach / managed / stop (tmux-managed windows). Zero dependencies.

const path = require('path');
const { spawn } = require('child_process');

const args = process.argv.slice(2);
const cmd = (args[0] || '').toLowerCase();
const rest = args.slice(1);
const HERE = __dirname;

const HELP = `🎼 conductor — situational awareness + control across your Claude Code windows

read
  conductor                list your live windows (table)
  conductor ls [opts]        opts: --minutes N  --all  --json  --limit N
  conductor up [opts]        launch the web cockpit  (--port N, --no-open)
  conductor mcp              run the MCP server (stdio)

control (tmux-managed windows)
  conductor run <label> [-- claude args]   launch a managed window in tmux
  conductor adopt <session> [label]        re-open an existing session in tmux (forked),
                                           so you can control it; then close the old tab
  conductor say <label> <text...>          send a reply into that window
  conductor attach <label>                 attach your terminal to it (type long commands)
  conductor managed                        list managed windows
  conductor stop <label>                   close a managed window

examples
  conductor run soag                       # start a managed window labelled "soag"
  conductor say soag yes                    # answer its prompt
  conductor say soag "review and test it before deploying"
  conductor up                              # cockpit with reply buttons on managed cards

labels    edit ~/.conductor/labels.json to name your projects (live-reloads)
read view is read-only; control only touches windows you launched via "conductor run"`;

function run(script, a) {
  const child = spawn(process.execPath, [path.join(HERE, script), ...a], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code == null ? 0 : code));
  child.on('error', (e) => { console.error('conductor: ' + e.message); process.exit(1); });
}

async function manageCmd() {
  const m = require('./manage');
  if (cmd === 'adopt') {
    const ref = rest[0];
    if (!ref) { console.error('usage: conductor adopt <session|shortId|label> [newlabel]'); process.exit(1); }
    const { collectSessions } = require('./lib');
    const rows = await collectSessions({ minutes: 4320 });   // last ~3 days
    const k = ref.toLowerCase();
    const s = rows.find((r) => r.sessionId.toLowerCase() === k || r.shortId.toLowerCase() === k || (r.label || '').toLowerCase() === k);
    if (!s) { console.error(`conductor: no live session matched "${ref}". See: conductor ls --all`); process.exit(1); }
    const label = rest[1] || m.sanitize(s.label) || s.shortId;
    const res = m.adopt(label, s.sessionId, s.cwd);
    if (!res.ok) { console.error('conductor: ' + res.error); process.exit(1); }
    console.log(`🎼 adopting ${s.shortId} (${s.label}) → managed window "${res.label}" — forked, full history kept.`);
    console.log(`   ⚠ close the original tab to avoid two live copies of this session.`);
    console.log(`   reply:  conductor say ${res.label} "yes"`);
    console.log(`   attach: ${res.attach}`);
    return;
  }
  if (cmd === 'run') {
    const label = rest[0];
    if (!label) { console.error('usage: conductor run <label> [-- claude args]'); process.exit(1); }
    const sep = rest.indexOf('--');
    const claudeArgs = sep >= 0 ? rest.slice(sep + 1) : [];
    const res = m.run(label, claudeArgs, process.cwd());
    if (!res.ok) { console.error('conductor: ' + res.error); process.exit(1); }
    console.log(`🎼 managed window "${res.label}" started in tmux${res.sessionId ? '' : ' (sessionId not captured yet)'}.`);
    console.log(`   reply:  conductor say ${res.label} "yes"`);
    console.log(`   attach: ${res.attach}`);
    return;
  }
  if (cmd === 'say') {
    const label = rest[0];
    const text = rest.slice(1).join(' ');
    if (!label || !text) { console.error('usage: conductor say <label> <text...>'); process.exit(1); }
    const res = m.say(label, text);
    if (!res.ok) { console.error('conductor: ' + res.error); process.exit(1); }
    console.log(`→ sent to ${res.label}: ${res.sent}`);
    return;
  }
  if (cmd === 'attach') {
    const label = m.sanitize(rest[0] || '');
    if (!rest[0]) { console.error('usage: conductor attach <label>'); process.exit(1); }
    const child = spawn('tmux', ['attach', '-t', m.SESSION, ';', 'select-window', '-t', label], { stdio: 'inherit' });
    child.on('exit', (c) => process.exit(c == null ? 0 : c));
    child.on('error', (e) => { console.error('conductor: ' + e.message); process.exit(1); });
    return;
  }
  if (cmd === 'managed') {
    const list = m.listManaged();
    if (!list.length) { console.log('no managed windows. start one: conductor run <label>'); return; }
    console.log('🎼 managed windows:');
    for (const w of list) console.log(`  ● ${w.label}  (${w.target})  cwd:${w.cwd}${w.sessionId ? '' : '  [no sessionId]'}`);
    return;
  }
  if (cmd === 'stop') {
    if (!rest[0]) { console.error('usage: conductor stop <label>'); process.exit(1); }
    const res = m.stop(rest[0]);
    console.log(res.ok ? `stopped ${res.label}` : `conductor: could not stop ${res.label}`);
    return;
  }
}

if (['help', '-h', '--help'].includes(cmd)) {
  console.log(HELP);
} else if (['run', 'adopt', 'say', 'attach', 'managed', 'stop'].includes(cmd)) {
  manageCmd().catch((e) => { console.error('conductor: ' + e.message); process.exit(1); });
} else if (cmd === '' || cmd.startsWith('-')) {
  run('scan.js', args);
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
