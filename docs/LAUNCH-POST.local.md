# Conductor 0.7 — launch posts (the irreversibility gate)

Lead image (every post): `docs/conductor-gate-meme.png`
Repo: https://github.com/yksanjo/conductor

---

## X / Twitter (primary — build-in-public)

**Single post (lead with the meme):**

> 10 Claude Code windows. 9 just need a "continue." 1 wants to spend 0.4 SOL.
>
> Conductor lets one orchestrator drive the whole fleet — and auto-approves nothing
> irreversible. deploy · send · delete · spend always come back to you.
>
> Auto-continue the boring. Gate the dangerous.
>
> github.com/yksanjo/conductor · zero deps · MCP + cockpit

**Alt one-liner (if the above feels long):**

> I let an agent drive my 10 Claude Code windows. It can say "continue" all day —
> but it can't deploy, send, delete, or spend without me. That line is the whole product.
> github.com/yksanjo/conductor

**Thread version (if it lands, expand):**

1/ I run ~10 Claude Code windows at once. The bottleneck isn't the work — it's me
babysitting every "ready to continue?" prompt across all of them.

2/ So Conductor reads what every window is doing (from the transcript it already
writes — no new infra) and surfaces only the ones blocked on a human. One window to
watch them all.

3/ New in 0.7: an orchestrator agent can DRIVE them — `auto_continue` sends "continue"
to keep ordinary work moving. The catch everyone worries about: won't it just approve
something dumb?

4/ No. There's a gate. deploy · send · delete · spend → it refuses to auto-reply and
bounces the question back to you. Bias is to stop when unsure: a false stop costs one
reply, a false "yes" ships a bad deploy or moves real money.

5/ Zero dependencies, runs as an MCP server (works in Claude Code / Desktop) or a local
web cockpit. Read-only by default; control is opt-in. MIT.
github.com/yksanjo/conductor

---

## Show HN

**Title:**
Show HN: Conductor – drive a fleet of Claude Code agents, but gate deploy/send/delete/spend

**Body:**

> I usually have ~10 Claude Code sessions running and lose track of which are working,
> which are done, and which are stuck waiting on me. Conductor reads each session's own
> transcript (no new infra, zero deps) and shows one view: working now / open / idle,
> plus the ones blocked on a human, with their question text.
>
> 0.7 adds end-to-end driving over MCP, so an orchestrator agent can continue windows
> for you. The part I cared about getting right is the safety: it won't auto-approve an
> irreversible action. A small classifier flags four classes — deploy, send, delete,
> spend — and the driver refuses to send on those, handing the decision back to you.
> Continuing ordinary work is automatic; approving something you can't undo is not.
> It's a guardrail that reads intent from the question, not a sandbox — and it's biased
> to stop when unsure.
>
> It's a CLI, a local web cockpit (binds 127.0.0.1 only, CSRF-guarded), and an MCP
> server. Same zero-dependency engine; Claude Code is one adapter, a trading-bot fleet
> is another. MIT, Node ≥18.
>
> https://github.com/yksanjo/conductor

---

## Notes
- Honest framing held: "guardrail not a sandbox," "biased to stop," keyword classifier
  (so it can over-gate). Don't overclaim it understands what a window will do.
- npm: `conductor-cli` is already taken (someone else's v1.0.0). Publishing scoped as
  `@yksanjo/conductor` → install hook `npx @yksanjo/conductor` (bin stays `conductor`).
  Needs your NPM_TOKEN + an npm account that owns the `yksanjo` scope. `files` allowlist
  already added so the package ships runtime only (no tests, no .local notes).
