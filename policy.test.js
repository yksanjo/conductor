#!/usr/bin/env node
'use strict';

// No-mock unit tests for the irreversibility gate. Pure functions — no spawning, no I/O.
// Proves the core promise: ordinary work flows through; deploy/send/delete/spend get bounced
// to the human; an explicit refusal is always safe to relay.

const assert = require('assert');
const { classify, gate } = require('./policy');

let pass = 0;
function ok(name, cond) { assert.ok(cond, name); console.log('  ✓ ' + name); pass++; }

console.log('conductor policy (irreversibility gate) tests:');

// --- classify: each class fires on a representative phrase ---
ok('classify deploy', classify('Ready to deploy to production?').categories.includes('deploy'));
ok('classify deploy (git push)', classify('Shall I git push to main?').categories.includes('deploy'));
ok('classify send', classify('Should I send the email to the client now?').categories.includes('send'));
ok('classify send (post to X)', classify('OK to post to X?').categories.includes('send'));
ok('classify delete', classify('This will rm -rf the build dir — proceed?').categories.includes('delete'));
ok('classify delete (drop table)', classify('Run DROP TABLE users?').categories.includes('delete'));
ok('classify spend', classify('Confirm: buy 2 SOL of the token?').categories.includes('spend'));
ok('classify spend ($ amount)', classify('Send a payment of $50?').categories.includes('spend'));

// --- classify: ordinary work is NOT irreversible ---
ok('plain "continue" is safe', classify('continue').irreversible === false);
ok('writing a README is safe', classify('Should I keep writing the README and add tests?').irreversible === false);
ok('refactor question is safe', classify('Want me to refactor this function and run the suite?').irreversible === false);

// --- classify: word boundaries don\'t misfire ---
ok('"now" does not trip "no"-class', classify('I will continue now.').irreversible === false);
ok('"removed a typo" — delete class catches "removed" (acceptable over-gate)', classify('removed a typo').categories.includes('delete'));

// --- gate: the rubber-stamp save (affirmative reply to irreversible question) ---
const g1 = gate('Ready to deploy to production?', 'yes');
ok('gate blocks "yes" → deploy question', g1.gated === true && g1.allow === false && g1.categories.includes('deploy'));
ok('gate explains why', /deploy/.test(g1.reason) && /explicit OK/.test(g1.reason));

const g2 = gate('Should I send the launch tweet?', 'continue');
ok('gate blocks "continue" → send question', g2.gated === true && g2.categories.includes('send'));

const g3 = gate('Should I spend 0.4 SOL?', 'go ahead');
ok('gate blocks "go ahead" → spend question', g3.gated === true && g3.categories.includes('spend'));

// --- gate: ordinary continuation flows through ---
const g4 = gate('I finished the parser. Keep going?', 'continue');
ok('gate ALLOWS continue on ordinary work', g4.allow === true && g4.gated === false);

const g5 = gate('Want me to add error handling here?', 'yes please');
ok('gate ALLOWS yes on a safe question', g5.allow === true);

// --- gate: declining an irreversible action is always safe to relay ---
const g6 = gate('Ready to deploy to production?', "no, don't deploy yet");
ok('gate ALLOWS an explicit refusal even on a deploy question', g6.allow === true && g6.gated === false);

const g7 = gate('Should I drop the table?', 'stop');
ok('gate ALLOWS "stop" on a delete question', g7.allow === true);

// --- gate: a reply that itself orders an irreversible action is gated ---
const g8 = gate('What should I do next?', 'deploy to prod now');
ok('gate blocks a reply that ITSELF orders a deploy', g8.gated === true && g8.categories.includes('deploy'));

console.log(`\n${pass} assertions passed.`);
