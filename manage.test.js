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
ok('uniqueLabel returns the base label when nothing clashes', m.uniqueLabel('Home / scratch', 'abc123') === 'Home-scratch');

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

  // --- deliver() GATES on readiness: a plain cat/shell pane is not a ready Claude prompt, so
  //     the prompt must NOT be typed in blind (the bug being fixed) — it comes back skipped. ---
  const gmark = 'gate_' + process.pid;
  const gres = m.deliver(RL, gmark);
  ok('deliver() skips a non-ready pane (does not type blind)', gres.ok === false && gres.status === 'skipped');
  spawnSync('sleep', ['0.3']);
  const gpane = spawnSync('tmux', ['capture-pane', '-p', '-t', 'conductor:' + RL], { encoding: 'utf8' }).stdout || '';
  ok('deliver() left the non-ready pane untouched (marker absent)', !gpane.includes(gmark));

  // --- deliver() into a pane that LOOKS ready (inject a Claude footer so paneStage→ready) lands ---
  spawnSync('tmux', ['send-keys', '-t', 'conductor:' + RL, '-l', '--', '? for shortcuts']);
  spawnSync('tmux', ['send-keys', '-t', 'conductor:' + RL, 'Enter']); spawnSync('sleep', ['0.3']);
  ok('paneStage sees the injected footer as ready', m.paneStage(RL) === 'ready');
  const dmark = 'deliver_' + process.pid;
  const dres = m.deliver(RL, dmark);
  ok('deliver() into a ready pane reports ok with a status', dres.ok === true && !!dres.status);
  spawnSync('sleep', ['0.3']);
  const dpane = spawnSync('tmux', ['capture-pane', '-p', '-t', 'conductor:' + RL], { encoding: 'utf8' }).stdout || '';
  ok('deliver() into a ready pane actually sends the text', dpane.includes(dmark));

  // --- sayAll returns a per-window breakdown (the cockpit renders it as chips) ---
  const ball = m.sayAll({ text: 'bcast_' + process.pid });
  ok('sayAll returns per-window results + counts', ball.ok && Array.isArray(ball.results)
     && ball.results.length === ball.total && (ball.started + ball.skipped) <= ball.total);

  // --- adopt() launches `--resume <id> --fork-session` (cmd:'echo' lets us read the args) ---
  const AL = 'atest' + process.pid;
  m.adopt(AL, 'SID123', os.tmpdir(), { cmd: 'echo', capture: false });
  spawnSync('sleep', ['0.5']);
  const apane = spawnSync('tmux', ['capture-pane', '-p', '-t', 'conductor:' + AL], { encoding: 'utf8' }).stdout || '';
  ok('adopt() forks via --resume <id> --fork-session', /--resume SID123 --fork-session/.test(apane));

  // adopt() records the original session id so the clicked card flips to managed (the fork
  // gets a fresh id). managedBySession() must map that adopted-from id back to the window.
  ok('managedBySession maps the adopted-from session', m.managedBySession().SID123 && m.managedBySession().SID123.label === AL);
  // a DIFFERENT session in the same label space must not collide onto AL's window
  ok('uniqueLabel keeps the base for the same session', m.uniqueLabel(AL, 'SID123') === AL);
  ok('uniqueLabel suffixes for a different session', m.uniqueLabel(AL, 'OTHERSID') === m.sanitize(AL + '-OTHERSID'));

  // --- paneStage classifies the startup menus by what's on screen (drive a `cat` pane) ---
  const SL = 'stest' + process.pid;
  m.run(SL, [], os.tmpdir(), { cmd: 'cat', capture: false });
  spawnSync('sleep', ['0.3']);
  spawnSync('tmux', ['send-keys', '-t', 'conductor:' + SL, '-l', '--', 'Quick safety check: Is this a project you trust this folder']);
  spawnSync('tmux', ['send-keys', '-t', 'conductor:' + SL, 'Enter']); spawnSync('sleep', ['0.3']);
  ok('paneStage detects the trust prompt', m.paneStage(SL) === 'trust');
  m.stop(SL);
  // fresh pane for the resume picker (the trust text above mustn't linger on screen)
  const SL2 = 'stest2' + process.pid;
  m.run(SL2, [], os.tmpdir(), { cmd: 'cat', capture: false });
  spawnSync('sleep', ['0.3']);
  spawnSync('tmux', ['send-keys', '-t', 'conductor:' + SL2, '-l', '--', 'We recommend resuming from a summary. Resume from summary Resume full session as-is']);
  spawnSync('tmux', ['send-keys', '-t', 'conductor:' + SL2, 'Enter']); spawnSync('sleep', ['0.3']);
  ok('paneStage detects the resume picker', m.paneStage(SL2) === 'resume');
  m.stop(SL2);

  // --- trustPromptShowing is false for a normal shell pane (no false positives) ---
  ok('trustPromptShowing false on a plain pane', m.trustPromptShowing(RL) === false);

  // cleanup
  m.stop(RL); m.stop(AL);
  m.stop(LBL);
  ok('stop() removes it from the registry', !m.listManaged().some((w) => w.label === LBL));
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} assertions passed.`);
