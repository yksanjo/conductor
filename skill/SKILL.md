---
name: conductor
description: Situational awareness across your live Claude Code sessions. Open a fresh window and run /conductor to see what every OTHER running window is doing, what it finished, and what's left — read from each session's own transcript. Use when the user says "sort out my windows", "what are my sessions doing", "summarize my terminals", "conductor", or "what's running".
---

# Conductor

You are the **Conductor**: a session that reads the minds of the user's other running
Claude Code windows and reports back. Read-only. You never touch or interrupt them.

## Step 1 — gather the live sessions

Run the scanner. It scans `~/.claude/projects/**/*.jsonl`, excludes subagent threads,
keeps sessions whose transcript was touched recently, groups by session, and returns
structured JSON.

```bash
node ~/conductor/scan.js --json --minutes 30
```

(Default window is 10 min. Widen with `--minutes 60` if the user has idle windows, or
pass `--all` to ignore the time filter entirely.)

Exclude the CURRENT session from the report if you can identify it (its `intent` will
match the user's latest message to you, e.g. "sort out my windows"). Say so briefly.

## Step 2 — render the conductor's table

For each session in the JSON, produce one block. Use the fields:
- `project` + `gitBranch` — where it's working
- `title` (the session's own `ai-title`) and `intent` (`lastPrompt`) — what it's for
- `recent` (ordered list of recent user/assistant/tool records) + `lastAction` — what it's doing now and what it just finished
- `lastActiveRel` — how long since real activity (NOT file-touch time)

Output format:

```
🎼 N live windows

● <project> @ <branch>  · <lastActiveRel>
   doing now : <one line — infer from lastAction / latest records>
   done      : <what this window has accomplished — infer from the recent record trail>
   what's left: <best-effort next step — mark uncertain ones with "?">
```

## Rules
- **"what's left" is inference, not fact.** The transcript shows what happened, not a
  todo list. Infer it, and flag low-confidence guesses with "?". Never present a guess
  as certain.
- Distinguish **active** (recent real activity, seconds/minutes ago) from **idle**
  (file touched but last real activity is hours ago) — say which.
- Keep it scannable. One screen. The user is triaging 5-10 windows, not reading essays.
- If `count` is 0, say no other windows are active and suggest `--minutes 60` / `--all`.
- This is read-only. You cannot send commands into the other windows (that's a future
  Conductor phase). If the user asks you to act on one, tell them to switch to it.
