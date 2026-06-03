# 🎼 Conductor

**Situational awareness across your live Claude Code sessions.**

You've got 10 terminals running Claude Code. You lose track of what each one is doing.
Open a fresh window and ask Conductor to sort them out:

```
🎼 Conductor — 4 sessions touched in last 30 min (newest activity first)

● 1d177c35  conductor @ conv-fix  · 2s ago
    ▸ CLI communication with other CLOs
    goal: lets do it all!
    last: 🔧 Bash: cd ~/conductor && node test.js

● ede6faa0  agent-org @ conv-fix  · 17h ago
    ▸ Tech week NYC schedule planning
    last: 💬 Done. Here's what I built...

● 5e6f0a17  survivors @ conv-fix  · 17h ago
    ▸ Build breakout radar tool
    last: 💬 dropped the 100k SOAG gate...
```

No new infrastructure. Conductor reads the transcript that every Claude Code session
**already writes** to `~/.claude/projects/`. It's **read-only** — it never touches,
writes to, or interrupts a running session. Zero dependencies.

## How it works

Every Claude Code window logs a live `.jsonl` transcript under
`~/.claude/projects/<dir>/<session-id>.jsonl`. Conductor:

1. Lists those transcripts and **filters by modification time** (folders hold thousands
   of historical sessions — only recently-touched ones are candidates).
2. **Excludes subagent threads** (`/subagents/`, sidechains) so each window counts once.
3. **Groups by session id** and streams each file (never loads 8MB into memory),
   pulling each session's `ai-title`, latest prompt, recent tool calls, and last action.
4. Reports one row per window.

## Usage

### Standalone CLI

```bash
node scan.js                 # pretty table, sessions active in last 10 min
node scan.js --minutes 60    # widen the window
node scan.js --all           # every session, ignore the time filter
node scan.js --json          # structured JSON
```

Or install the bin:

```bash
npm link        # then: conductor --minutes 30
```

### As a Claude Code skill (recommended)

Install the skill so any window can summarize the others in natural language:

```bash
mkdir -p ~/.claude/skills/conductor
cp skill/SKILL.md ~/.claude/skills/conductor/SKILL.md
```

Then in any Claude Code session: **"sort out my windows"** / **`/conductor`**. Claude
runs the scanner and renders a *doing-now / done / what's-left* summary per window.

## Honest limits (v1)

- **Read-only.** Conductor observes; it can't send commands into other windows yet.
  (That's a planned later phase and is genuinely harder.)
- **"What's left" is inferred** from the transcript, not a real todo list. Treat it as
  best-effort.
- **"Live" = recently touched.** A window that's been open but idle for hours may not
  appear (widen with `--minutes`). Per-row time shows *true* last activity.
- **Claude Code only**, local machine only.
- It only reads **your own** `~/.claude` — never another user's transcripts.

## License

MIT
