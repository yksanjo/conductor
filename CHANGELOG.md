# Changelog

## 0.7.0

The **irreversibility gate** — the auto-approve policy that makes end-to-end driving safe.
An orchestrator can now run the loop without rubber-stamping every reply: continue ordinary
work automatically, but bounce every irreversible step back to the human.

- New module `policy.js` — a zero-dependency, pure-function classifier over four irreversible
  classes (**deploy · send · delete · spend**) plus a `gate(question, reply)` decision. Biased
  to stop when unsure; an explicit refusal ("no, don't deploy") is always safe to relay.
- New MCP tool `auto_continue` — advances ONE waiting window under the gate: sends `"continue"`
  (or your text) when the question is ordinary work; when the question or reply trips an
  irreversible class it does NOT send and returns `gated:true` with the reason + question so
  you escalate. `reply_to_session` stays the raw, ungated channel for a human-authorized reply.
- `pending_questions` now flags each waiting window with `irreversible` + `categories`, so the
  triage feed itself tells you which windows you must not auto-approve.
- **Close a window from the cockpit** — managed cards now carry an **✕ close** button next to
  **↗ open**. It kills the window's tmux session (the same thing `conductor stop <label>` does).
  Closing is irreversible (the live session and its state are lost), so it double-confirms in the
  browser and the `/api/stop` endpoint requires a confirm token (the label) on top of the CSRF
  guard — mirroring how `flatten` is gated. Only conductor-managed windows get the button; plain
  windows run in your own terminal tabs and have no handle here, so they're closed from that
  terminal (the manual now says so). Covered by `server.test.js`.
- Tests: new `policy.test.js` (22 assertions — every class, the rubber-stamp save, refusals,
  ordinary continuation); MCP suite covers `auto_continue`'s gate path with no spawn.

## 0.6.0

Conductor's engine is now a **source-agnostic supervisory core** with a pluggable adapter
interface. Built once, proven on two adapters.

- **`engine.js` + `adapters/`** — the engine (`loadAdapter`, `collect`) owns discovery
  orchestration, liveness, grouping, status ranking, and sorting; it knows no domain. Adapters
  own where trails live and how to read them (`discover` / `liveness` / `parse` / `status` /
  `project` / `statuses` / `control`). Records are normalized to a stable contract.
- **`adapters/claude-code.js`** — the original reader, ported onto the contract. Behavior is
  unchanged; the existing test suite proves it.
- **`adapters/fleet.js`** — first new adapter: a trading-bot fleet reading
  `~/.fleet/bots/*/events.jsonl`. Liveness from heartbeats; `wedged` + `drawdown` signals;
  control appends `pause|resume|flatten|set-param` to `control.jsonl`; broadcast = desk-wide
  panic flatten. `tools/fakebot.js` emits realistic trails for testing.
- **Surfaces generalized** — `--adapter` on the CLI, cockpit, and MCP. The CLI sections come
  from the adapter's status vocabulary; the cockpit renders adapter-driven cards (fleet cards
  get pause/resume/flatten + a broadcast-flatten band); the MCP read tools take an `adapter`
  arg and gain `risk_snapshot` (PnL + drawdown + wedged units).
- **Security** — destructive control (flatten) and every broadcast require an explicit confirm
  token on top of the localhost + Origin + `X-Conductor` guard; the UI double-confirms. Tagline
  is now "read-only observation, opt-in control."
- Tests: new `fleet.test.js` (29) and `server.fleet.test.js` (14) join the unchanged Claude
  suites; full suite green.

## 0.5.0

The MCP server gains a **control surface** so an MCP-aware orchestrator can drive windows
end-to-end, not just watch them — the same tmux channel the web cockpit already uses.

- New MCP tool `pending_questions` — returns ONLY the windows blocked waiting on a human
  (Claude spoke last, then went quiet), with each window's question text. The triage feed.
- New MCP control tools `reply_to_session` (reply; adopts a read-only window first),
  `send_key` (Escape / C-c / Enter to a managed window), and `run_window` (launch a new
  managed window with an optional first prompt).
- No auto-approve policy: every reply is a deliberate tool call; irreversible steps stay a
  human decision. The boot→ready drive loop (`deliverAdopted`) is now shared by the cockpit
  and the MCP, so both adopt-and-drive windows identically.
- Tests: MCP suite covers all 7 tools incl. the new triage shape and write-tool guard paths.

## 0.4.0

Conductor is a read-only situational-awareness layer over your live Claude Code windows,
plus a tmux-based control plane for the ones you launch or adopt. Three surfaces share one
zero-dependency engine: a CLI, a web cockpit, and an MCP server.

### Read
- Discovers every session from `~/.claude/projects/**/*.jsonl` (mtime-gated, subagent
  threads excluded, grouped by session).
- Liveness by **process**, not file writes — a window is "open" if a live `claude` process
  owns it, so idle-but-open windows still show.
- Cards/boxes lead with the session's plain-language title (its `ai-title`), not the
  directory; project shown only when it's a real project dir.
- CLI: boxed, sectioned table (Working now / Open / Recently active / Idle).
- Web cockpit (`conductor up`, :7591): live cards, click-for-detail, status pills,
  in-place refresh that never wipes what you're typing.
- MCP server: `list_sessions`, `summarize_session`, `whats_left`.

### Control (tmux-managed windows)
- `conductor run <label>` — launch a window born-managed (auto-answers the trust prompt).
- `conductor adopt <session>` — fork an existing session into a managed window.
- `conductor say` / cockpit reply bars / broadcast — quick replies to one or all managed
  windows. Every card has a reply bar; replying to a plain window adopts it first.
- All tmux calls use argument arrays — reply text is never shelled.

### Quality
- 51 automated assertions (engine + MCP + control plane, incl. real tmux send→capture).
- All 11 dashboard functions verified end-to-end in a real browser.
- Zero runtime dependencies. Read-only core. Control only touches windows Conductor owns.
