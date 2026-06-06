'use strict';

// policy.js — the irreversibility gate for autonomous window-driving.
//
// Conductor's MCP lets an orchestrator agent drive your live windows end-to-end. The
// failure mode is the rubber stamp: a window asks "deploy to prod?" and the loop blindly
// answers "yes". This module is the gate. Its single rule — the one you chose:
//
//   An autonomous driver may freely CONTINUE ordinary work, but must NEVER approve an
//   IRREVERSIBLE action on your behalf. Irreversible = the four classes you named:
//   DEPLOY · SEND · DELETE · SPEND. Anything tripping them is escalated to you, not sent.
//
// When uncertain, gate. A false gate costs you one manual reply; a false pass can ship a
// bad deploy, fire off a message, drop a table, or move real money. Asymmetric downside →
// bias toward stopping. This reads INTENT from the window's question + the proposed reply;
// it is a guardrail, not a sandbox — it cannot see what a window does after you say "go".
// Zero dependencies, pure functions, unit-tested in policy.test.js.

// Verb/phrase signatures per irreversible class. Case-insensitive, word-boundaried to keep
// "now" from matching "no" and "released" from matching a bare "release" only when intended.
const CATEGORIES = {
  deploy: [
    /\bdeploy(ing|ed|ment|s)?\b/, /\bship(ping|ped)?\s+(it|this|to\s+prod)/, /\bto\s+prod(uction)?\b/,
    /\bgo(ing)?\s+live\b/, /\bpublish(ing|ed)?\b/, /\bnpm\s+publish\b/, /\bgit\s+push\b/,
    /\bforce[-\s]?push(ing|ed)?\b/, /\bvercel\s+(deploy|--prod)/, /\bwrangler\s+deploy\b/,
    /\bmerge\b[^.]*\b(pr|pull\s+request|to\s+main|into\s+main|prod)/, /\bpush\s+to\s+(main|prod|origin|remote)/,
    /\bcut\s+a\s+release\b/, /\btag\s+a\s+release\b/,
  ],
  send: [
    /\bsend(ing)?\s+(the\s+|a\s+|this\s+|that\s+)?(email|e-mail|message|msg|dm|tweet|post|tx|transaction|payment|invite|reply)/,
    /\bpost(ing)?\s+(to\s+|on\s+|it\s+to\s+)?(x|twitter|tg|telegram|slack|discord|the\s+channel|publicly|live)/,
    /\btweet(ing)?\b/, /\bbroadcast(ing)?\b/, /\bemail\s+(them|him|her|the\b)/, /\bsend\s+it\b/,
    /\bsubmit(ting)?\s+(the\s+)?(form|application|pr|pull\s+request|grant)/, /\bgo\s+public\b/,
  ],
  'delete': [
    /\brm\s+-rf?\b/, /\bdrop\s+(the\s+)?table\b/, /\bdrop\s+(the\s+)?database\b/, /\btruncate\b/,
    /\bdelet(e|ing|ed)\b/, /\bdestroy(ing|ed)?\b/, /\bremov(e|ing|ed)\b/, /\bwip(e|ing|ed)\b/,
    /\bpurg(e|ing|ed)\b/, /\breset\s+--hard\b/, /\brevok(e|ing|ed)\b/, /\bdelete\s+the\s+branch\b/,
  ],
  spend: [
    /\bspend(ing)?\b/, /\bbuy(ing)?\b/, /\bsell(ing)?\b/, /\bswap(ping)?\b/, /\bpay(ing|ment)?\b/,
    /\bfund(ing)?\b/, /\bwithdraw(ing|al)?\b/, /\btransfer\s+(funds|sol|usdc|usd|money|\$|eth)/,
    /\bmainnet\b/, /\breal\s+(money|sol|funds|usdc)\b/, /\bsign\s+(the\s+)?(tx|transaction|swap)/,
    /\bapprove\s+(the\s+)?(token|spend|tx|transaction|allowance)/, /\$\s?\d/, /\b\d+(\.\d+)?\s*(sol|usdc|usd|eth|btc)\b/,
    /\bplace\s+(an?\s+)?(order|trade|bet)/, /\bexecute\s+(the\s+)?(trade|order|swap)/,
  ],
};

// A reply that is purely an approval ("yes" / "go ahead" / "ship it") — the dangerous half
// of the rubber stamp when paired with an irreversible question.
const AFFIRMATIVE = /^\s*(y|yes|yep|yeah|ya|sure|ok|okay|k|go|go ahead|do it|proceed|continue|approve|approved|confirm|confirmed|ship it|send it|lgtm|sounds good|👍|✅)\s*[.!]*\s*$/i;

// A reply that DECLINES or HALTS. Declining an irreversible action is itself reversible, so
// a clear refusal is always safe to relay — that's how you say "no, don't deploy" through the loop.
const REFUSAL = /\b(no|nope|don'?t|do\s+not|stop|halt|cancel|abort|hold\s+(on|off)|skip|decline|reject|wait)\b/i;

// classify(text) → { categories:[...], matched:[...], irreversible:bool }
// Which irreversible classes does this text touch, and the literal substrings that tripped it.
function classify(text) {
  const t = String(text || '').toLowerCase();
  const categories = [];
  const matched = [];
  for (const cat of Object.keys(CATEGORIES)) {
    for (const re of CATEGORIES[cat]) {
      const m = t.match(re);
      if (m) {
        if (!categories.includes(cat)) categories.push(cat);
        matched.push(m[0].trim());
      }
    }
  }
  return { categories, matched, irreversible: categories.length > 0 };
}

// gate(question, reply) → { allow, gated, reason, categories?, matched? }
// Should an autonomous driver be allowed to send `reply` to a window blocked on `question`?
function gate(question, reply) {
  const r = String(reply || '');
  // An explicit refusal/halt is always safe — you're declining, which is reversible.
  if (REFUSAL.test(r) && !AFFIRMATIVE.test(r)) {
    return { allow: true, gated: false, reason: 'reply declines or halts — safe to relay' };
  }
  const q = classify(question);
  const rep = classify(reply);
  const categories = [];
  for (const c of [...q.categories, ...rep.categories]) if (!categories.includes(c)) categories.push(c);
  if (categories.length === 0) {
    return { allow: true, gated: false, reason: 'no irreversible action detected — safe to continue' };
  }
  const matched = [];
  for (const m of [...q.matched, ...rep.matched]) if (!matched.includes(m)) matched.push(m);
  return {
    allow: false,
    gated: true,
    reason: `irreversible action (${categories.join(', ')}) — needs the human's explicit OK, not an auto-reply`,
    categories,
    matched,
  };
}

module.exports = { classify, gate, CATEGORIES };
