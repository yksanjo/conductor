#!/usr/bin/env node
'use strict';

// No-mock tests for the control plane. Registry is isolated to a temp HOME so the real
// ~/.conductor/managed.json is never touched. tmux parts run a real send-keys → capture-pane
// roundtrip in a throwaway window, and are skipped cleanly if tmux is unavailable.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-manage-'));
process.env.HOME = root; // isolate REG_FILE + PROJECTS_DIR before requiring the module
const m = require('./manage');

let pass = 0;
function ok(name, cond) { assert.ok(cond, name); console.log('  ✓ ' + name); pass++; }
function tmuxOk() { try { return spawnSync('tmux', ['-V']).status === 0; } catch { return false; } }

console.log('conductor control-plane tests:');

// pure helpers (no tmux)
ok('sanitize strips unsafe chars', m.sanitize('SOAG · Grid!') === 'SOAG-Grid');
ok('sanitize collapses + trims', m.sanitize('  a // b  ') === 'a-b');
ok('sanitize falls back for empty', m.sanitize('!!!') === 'window');
ok('attachCommand references tmux + session', /tmux attach -t conductor/.test(m.attachCommand('x')));
ok('listManaged empty on fresh registry', m.listManaged().length === 0);

if (!tmuxOk()) {
  console.log('  ⚠ tmux not found — skipping live send/capture tests');
} else {
  const LBL = 'ctest' + process.pid;
  const tgt = 'conductor:' + LBL;
  // make a real throwaway window (running a shell) in the conductor session
  const has = spawnSync('tmux', ['has-session', '-t', 'conductor']).status === 0;
  if (has) spawnSync('tmux', ['new-window', '-t', 'conductor', '-n', LBL]);
  else spawnSync('tmux', ['new-session', '-d', '-s', 'conductor', '-n', LBL]);

  // register it (as if conductor run had captured it) in the isolated registry
  fs.mkdirSync(path.dirname(m.REG_FILE), { recursive: true });
  fs.writeFileSync(m.REG_FILE, JSON.stringify({ windows: { [LBL]: { label: LBL, target: tgt, cwd: '/x', created: 1, sessionId: 'sess-' + LBL } } }));

  ok('listManaged sees the live window', m.listManaged().some((w) => w.label === LBL));
  ok('managedBySession maps sessionId -> window', m.managedBySession()['sess-' + LBL] && m.managedBySession()['sess-' + LBL].label === LBL);

  // send a reply; the shell echoes it back -> prove it landed via capture-pane
  const marker = 'conductor_marker_' + process.pid;
  const r = m.say(LBL, 'echo ' + marker);
  ok('say() reports ok', r.ok === true);
  spawnSync('sleep', ['0.5']);
  const pane = spawnSync('tmux', ['capture-pane', '-p', '-t', tgt], { encoding: 'utf8' }).stdout || '';
  ok('reply text actually reached the window (capture-pane)', pane.includes(marker));

  ok('key() sends a named key', m.key(LBL, 'C-c').ok === true);
  ok('say to unknown window fails gracefully', m.say('no-such-window-xyz', 'hi').ok === false);

  // --- run() launch + say into a run-created window (cmd:'cat' avoids spawning real claude;
  //     cat keeps the pane alive and echoes whatever we send) ---
  const RL = 'rtest' + process.pid;
  const rr = m.run(RL, [], os.tmpdir(), { cmd: 'cat', capture: false });
  ok('run() launches a managed window', rr.ok && rr.target === 'conductor:' + RL);
  spawnSync('sleep', ['0.4']);
  ok('run() registered it', m.listManaged().some((w) => w.label === RL));
  const rmark = 'run_marker_' + process.pid;
  m.say(RL, rmark);
  spawnSync('sleep', ['0.4']);
  const rpane = spawnSync('tmux', ['capture-pane', '-p', '-t', 'conductor:' + RL], { encoding: 'utf8' }).stdout || '';
  ok('say into a run-created window lands', rpane.includes(rmark));

  // --- sayAll broadcasts to every managed window (LBL + RL are both live) ---
  const bmark = 'bcast_' + process.pid;
  const ball = m.sayAll({ text: bmark });
  ok('sayAll hits all managed (sent === total ≥ 2)', ball.ok && ball.total >= 2 && ball.sent === ball.total);
  spawnSync('sleep', ['0.4']);
  const rpane2 = spawnSync('tmux', ['capture-pane', '-p', '-t', 'conductor:' + RL], { encoding: 'utf8' }).stdout || '';
  ok('sayAll reached the run window', rpane2.includes(bmark));

  // --- adopt() launches `--resume <id> --fork-session` (cmd:'echo' lets us read the args) ---
  const AL = 'atest' + process.pid;
  m.adopt(AL, 'SID123', os.tmpdir(), { cmd: 'echo', capture: false });
  spawnSync('sleep', ['0.5']);
  const apane = spawnSync('tmux', ['capture-pane', '-p', '-t', 'conductor:' + AL], { encoding: 'utf8' }).stdout || '';
  ok('adopt() forks via --resume <id> --fork-session', /--resume SID123 --fork-session/.test(apane));

  // --- trustPromptShowing is false for a normal shell pane (no false positives) ---
  ok('trustPromptShowing false on a plain pane', m.trustPromptShowing(RL) === false);

  // cleanup
  m.stop(RL); m.stop(AL);
  m.stop(LBL);
  ok('stop() removes it from the registry', !m.listManaged().some((w) => w.label === LBL));
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} assertions passed.`);
