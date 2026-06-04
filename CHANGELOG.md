# Changelog

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
