# 🎼 Conductor

**Supervisory awareness across a fleet of semi-autonomous workers — starting with your live
Claude Code sessions.**

Conductor is a source-agnostic supervisory core with a pluggable **adapter** interface. The
engine owns grouping, status ranking, sectioning, and the three surfaces (CLI table, web
cockpit, MCP server); an adapter owns where the trails live and how to read them. Claude Code is
one adapter; a [trading-bot fleet](#the-fleet-adapter) is another. Same engine, proven twice.
**Read-only observation, opt-in control.**

![The Conductor cockpit — your live Claude Code windows grouped by status](docs/cockpit.png)

You've got 10 terminals running Claude Code. You lose track of what each one is doing.
Open a fresh window and ask Conductor to sort them out:

```
🎼 Conductor — 3 windows · last 1h
   cockpit: conductor up   ·   control: conductor run <label> / conductor say <label> yes

WORKING NOW ───────────────────────────────────────────────────────────
┌─ 1d177c35 ──────────────────────────────────────────────────────────┐
│ ● Build SOAG Agent trading grid with character art  conv-fix · 4s ago │
│ SOAG · Grid                                                          │
│ › Read: src/characters.js                                            │
└──────────────────────────────────────────────────────────────────────┘

OPEN ──────────────────────────────────────────────────────────────────
┌─ ede6faa0 ──────────────────────────────────────────────────────────┐
│ ● Tech week NYC schedule planning                      main · 17h ago │
│ Good Rooms                                                           │
│ › Done. Here's what I built…                                         │
└──────────────────────────────────────────────────────────────────────┘
```

Each window is a box that **leads with what it's actually about** (the session's own
summary), grouped into **Working now / Open / Recently active / Idle**. Open the visual
version with `conductor up`.

No new infrastructure. Conductor reads the trail each worker **already writes** (for Claude
Code, the transcript under `~/.claude/projects/`). **Read-only observation, opt-in control**:
watching is always-on and free; control (replies, launch, flatten) is opt-in and only where a
real command channel exists. Zero dependencies. The server binds to `127.0.0.1` only, and
state-changing requests require a local origin + an `X-Conductor` header (CSRF / DNS-rebinding
guard); destructive control (flatten / broadcast) additionally requires a confirm token.

## How it works

Every Claude Code window logs a live `.jsonl` transcript under
`~/.claude/projects/<dir>/<session-id>.jsonl`. Conductor:

1. Lists those transcripts and **filters by modification time** (folders hold thousands
   of historical sessions — only recently-touched ones are candidates).
2. **Excludes subagent threads** (`/subagents/`, sidechains) so each window counts once.
3. **Groups by session id** and streams each file (never loads 8MB into memory),
   pulling each session's `ai-title`, latest prompt, recent tool calls, and last action.
4. Reports one row per window.

## 🗺 The whole thing on one page

![Conductor architecture — your windows write transcripts and run as processes; the zero-dep engine reads them; three surfaces (CLI, web cockpit, MCP); a tmux control plane for windows you launch or adopt](docs/spec.png)

## Install

```bash
git clone <repo> ~/conductor && cd ~/conductor && npm link
```

`npm link` puts a global `conductor` command on your PATH. No build, no dependencies.

## Usage

One command, three modes:

```bash
conductor              # glance: table of your live windows
conductor up           # launch the visual web cockpit (opens your browser)
conductor mcp          # run the MCP server (for agent integration)
conductor help         # all options
```

### Table options

```bash
conductor --minutes 60   # widen the time window
conductor ls --all       # every session, ignore the filter
conductor ls --json      # structured JSON
```

### Web cockpit (the visual)

A live, glanceable dashboard. Big friendly label per window, color-coded status
(🟢 working now · 🟡 idle), click a card for full detail (goal, last action, recent
timeline). Auto-refreshes every 4s (read-only observation).

```bash
conductor up                # starts on :7591 and opens your browser
conductor up --port 8080    # custom port
conductor up --no-open      # don't auto-open
```

Tap **📖** in the header for a one-page quick manual (also at `/manual`, or as a
printable [PDF](docs/manual.pdf)).

### Custom labels (the "key")

The big label on each card comes from the working directory, auto-prettified. To give a
project a human name, edit `~/.conductor/labels.json` — a flat map of
`<dir-basename>` → `<friendly name>`:

```json
{
  "agentsoag": "SOAG · Website",
  "inmusic-pitch": "inMusic · Pitch",
  "survivors": "DegenScreener"
}
```

Changes are picked up live (no restart). Unmapped projects fall back to a prettified
directory name.

### As a Claude Code skill (recommended)

Install the skill so any window can summarize the others in natural language:

```bash
mkdir -p ~/.claude/skills/conductor
cp skill/SKILL.md ~/.claude/skills/conductor/SKILL.md
```

Then in any Claude Code session: **"sort out my windows"** / **`/conductor`**. Claude
runs the scanner and renders a *doing-now / done / what's-left* summary per window.

### As an MCP server (use it inside any agent)

Conductor speaks the Model Context Protocol over stdio, so any MCP-aware agent can call
it natively — to **watch** its windows and to **drive** them.

Read tools: `list_sessions`, `summarize_session`, `whats_left`, and `pending_questions`
(only the windows blocked waiting on a human, with the question text — the triage feed).

Control tools (write, via the same tmux channel as the cockpit): `reply_to_session`
(reply to a window, adopting a read-only one first), `send_key` (Escape / C-c / Enter to a
managed window), and `run_window` (launch a new managed window with an optional first prompt).

This is what lets an orchestrator agent run windows end-to-end: poll `pending_questions`,
read each with `summarize_session`, and `reply_to_session` to continue them. There is **no
auto-approve policy** baked in — each reply is a deliberate tool call, and irreversible steps
(deploy, send, delete, spend) stay a human decision.

Add it to Claude Code (user scope = available everywhere):

```bash
claude mcp add conductor --scope user -- node ~/conductor/mcp.js
```

Or add it by hand to a client config (e.g. Claude Desktop `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "conductor": { "command": "node", "args": ["/Users/you/conductor/mcp.js"] }
  }
}
```

Then in any session: *"use conductor to list my sessions"* / *"what's left across my windows?"*

To run an agent that drives your windows end-to-end (triage → continue the safe stuff →
stop and ask you for irreversible steps), paste the orchestrator prompt in
[`docs/orchestrator-prompt.md`](docs/orchestrator-prompt.md) into a window that has this MCP.

## Control — reply to managed windows

Conductor can also *steer* windows, not just watch them. Because a plain-terminal Claude
TUI can't have input injected, control works on **managed** windows — ones you launch
through Conductor into a [tmux](https://github.com/tmux/tmux) session:

```bash
conductor run soag            # launch a managed Claude window labelled "soag" (in tmux)
conductor adopt <id> soag      # take an EXISTING session under management (see below)
conductor say soag yes         # send a quick reply
conductor say soag "review and test it before deploying"
conductor attach soag          # drop into the window to type longer commands
conductor managed              # list managed windows
conductor stop soag            # close it
```

In the **cockpit**, managed windows get a `MANAGED` badge and a reply bar — one-tap
**Yes / No / Continue / Review / Re-iterate / Test+deploy** plus a free-text box. Clicks
send keystrokes straight into the live window.

Quick replies are short by design. For long, complex instructions, `conductor attach` and
type in the window directly. Requires `tmux` (`brew install tmux`).

### Adopting an existing window

A Claude window you opened yourself (in a plain terminal) can't be controlled — the OS
won't let anything inject input into it. `conductor adopt` works around this by **forking
the session into a managed tmux window**, keeping the full history:

```bash
conductor ls                  # find the session (note its 8-char id or label)
conductor adopt 1a2b3c4d work  # re-open it (forked) as managed window "work"
# ...then close the original tab; control "work" from CLI + cockpit
```

It runs \`claude --resume <id> --fork-session\` in the session's own project directory.
Forking means no collision with the still-open original — but you should close that tab and
continue in the managed window.

## Honest limits (v1)

- **Control is managed-only.** Conductor can reply to windows you launched via
  `conductor run` (tmux). Plain terminal windows you opened yourself stay read-only —
  there's no reliable way to inject input into them.
- **"What's left" is inferred** from the transcript, not a real todo list. Treat it as
  best-effort.
- **"Live" = recently touched.** A window that's been open but idle for hours may not
  appear (widen with `--minutes`). Per-row time shows *true* last activity.
- **Claude Code only**, local machine only.
- It only reads **your own** `~/.claude` — never another user's transcripts.
- **The "open" signal needs `lsof`** (and a `claude`-named process) — primarily macOS. If
  `lsof` is missing/unavailable, liveness falls back to recent file writes (nothing shows
  as "open", just "recent"/"idle").
- **Control = a control plane, not read-only.** The cockpit's POST endpoints inject
  keystrokes into managed windows. They're guarded (localhost bind + origin + `X-Conductor`
  header) so a stray web page can't reach them, but treat the cockpit as something you run
  for yourself, not a public service.

## The abstraction

Conductor is **supervisory awareness over a fleet of semi-autonomous workers that already emit an
append-only activity trail, where the operator's scarce resource is attention.** Observation is
always-on and free; control is a separate, opt-in plane added only where a real command channel
exists.

A worker fits Conductor when four things hold:

1. **Many autonomous-ish units** — you're outnumbered.
2. **Each already emits a readable trail** — no instrumentation to add.
3. **Each is pursuing a task with intent** — so "doing now / done / what's left" is meaningful.
4. **You supervise by exception** — surface the one that's stuck, ignore the 19 that are fine.

Claude Code windows fit (transcripts + intent + you-have-10-open). Trading bots fit (event logs +
a mandate + you-can't-watch-all-day). So do CI runners, scrapers, data pipelines — anything that
narrates itself to disk.

### The engine / adapter split

```
                  ┌────────────────────── engine.js ──────────────────────┐
   adapter   ───▶ │ discover → liveness → parse → group → status → sort   │ ───▶ rows
 (the trail)      └───────────────────────────────────────────────────────┘        │
                              owns: grouping, ranking, sectioning           ┌───────┴───────┐
                                                                         CLI · cockpit · MCP
```

The **engine** (`engine.js`) is domain-blind: `loadAdapter(name)` resolves `adapters/<name>.js`,
`collect(adapter, opts)` runs the pipeline and returns sorted public rows. The three surfaces
(`scan.js`, `server.js`, `mcp.js`) render those rows and are adapter-selectable with `--adapter`.

## Adapters

| Adapter | Reads | Liveness | Control |
|---|---|---|---|
| `claude-code` (default) | `~/.claude/projects/**/*.jsonl` transcripts | a live `claude` process (`lsof`) | tmux send-keys (managed windows) |
| `fleet` | `~/.fleet/bots/*/events.jsonl` event logs | newest heartbeat freshness | append commands to `control.jsonl` |

```bash
conductor                       # claude-code (default)
conductor --adapter fleet       # the trading-bot fleet
conductor up --adapter fleet    # the cockpit, fleet mode
```

### The fleet adapter

A convention-over-config trading desk. Each bot appends to `~/.fleet/bots/<bot>/events.jsonl`,
one JSON record per line — `{ ts, type, ... }` where `type ∈ signal | order | fill | pnl |
heartbeat | error` — and an optional `~/.fleet/bots/<bot>/meta.json` gives
`{ strategy, mandate, venue, symbol }`. The adapter derives:

- **liveness** from heartbeat freshness;
- a **`wedged`** signal — an order/signal stuck with no fill past a threshold;
- a **`drawdown`** signal — equity off its running peak;
- position, session PnL, and venue as context chips.

Units are sectioned **WEDGED → DRAWDOWN → TRADING → IDLE** (problems first — supervise by
exception). Control appends `pause | resume | flatten | set-param` to the bot's `control.jsonl`,
which the bot polls; the cockpit's **broadcast-flatten** is the desk-wide panic button (confirm
token + double-confirm). Try it without a venue:

```bash
node tools/fakebot.js alpha --scenario healthy
node tools/fakebot.js beta  --scenario wedged
node tools/fakebot.js gamma --scenario drawdown
conductor --adapter fleet
```

The MCP server adds **`risk_snapshot`** (total PnL + worst drawdowns + wedged units) for an
orchestrator agent driving the desk.

## Writing a new adapter

Drop a file at `adapters/<name>.js` exporting the contract below, and every surface works with
`--adapter <name>` — no engine changes.

```js
module.exports = {
  // REQUIRED
  discover(opts)          { /* → array of trail handles (file paths, dirs, cursors) */ },
  parse(handle, opts)     { /* → a normalized record (below), or null to drop it */ },

  // OPTIONAL
  liveness(handles, opts) { /* → Set of handles live right now; else engine falls back to recency */ },
  status(record, { live, now }) { /* → a status key string from record.statusInputs */ },
  project(baseRow)        { /* → the public row shape for this domain (add domain fields) */ },
  statuses: [ { key, title, word, color } ],   // ordered vocabulary → sections + sort order
  control: {                                    // opt-in command plane
    capabilities: ['pause', 'flatten', /* … */],
    send(target, command)  { /* one unit */ },
    broadcast(command)     { /* all units */ },
  },
};
```

**The normalized record** (the stable contract the engine depends on):

```js
{
  id,                 // stable unique id for the unit
  shortId,            // display id
  label,              // friendly name (project / bot / agent)
  title,              // plain-language "what this unit is about"
  intent,             // its goal / mandate
  context,            // array of chips, e.g. ["feat-branch"] or ["Hyperliquid", "+2.3%"]
  recent: [ { actor, kind, summary, ts } ],  // ring-buffered recent events
  lastAction,         // one-line "doing now"
  lastActivityTs,     // ms epoch of true last activity
  statusInputs: { … } // adapter-specific signals the engine maps to a status
}
```

Notes: the engine groups records by `id` (freshest wins), applies `liveness`, computes `status`,
sorts by your `statuses` order then recency, and runs `project` to produce the public row.
`adapters/claude-code.js` and `adapters/fleet.js` are the two worked examples. Stream large trails
(don't load them whole); bound any wide scan's concurrency. Zero runtime dependencies, Node ≥18.

## License

MIT
