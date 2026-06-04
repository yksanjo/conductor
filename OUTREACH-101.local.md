# Conductor — Outreach 101

> The product is built and public. Distribution is the only gate now.
> Goal of this doc: get the first 50 real users who run >1 Claude Code window.

---

## 0. The one sentence (memorize this)

**"A fresh Claude window that watches what your OTHER Claude Code windows are doing — and lets you steer them from one cockpit."**

If you can't say it in one breath, the post won't land. Lead with the *pain*, not the architecture:

> "I had 6 Claude Code windows open and no idea which one was stuck. So I built a cockpit that reads all of them."

That sentence IS the hook. Everything below is just delivery.

---

## 1. Who actually wants this (target the niche, not "developers")

Conductor only matters to people who run **2+ Claude Code sessions at once**. That's a small, findable group. Don't broadcast — snipe.

| Segment | Where they are | Why they care |
|---|---|---|
| Claude Code power users | X (search "Claude Code" + "windows/sessions"), Anthropic Discord | They already feel the multi-window pain |
| Agent-fleet / parallel-agent people | r/ClaudeAI, "AI agents" X circles | They run swarms and lose track |
| Indie hackers shipping fast | Indie Hackers, build-in-public X | Many tabs, no overview |
| Your warm network | Pitch & Run NYC, NYC tech-week crowd, past collaborators | Warm = highest conversion |

**Rule:** one person who already has 4 windows open beats 100 cold "devs."

---

## 2. The artifact comes FIRST (no naked links)

Per your own rule — **lead with a meme/demo, data and links go behind it.** Nobody clicks a bare GitHub link.

The killer artifact for Conductor is a **15-sec screen recording**:
1. Show 4–5 chaotic Claude windows
2. Open Conductor cockpit → all of them in one board, status each
3. Type a reply in the cockpit → it lands in window #3
4. Cut.

Caption: *"stop alt-tabbing between Claude windows."*

That GIF is your whole campaign. Make it once, reuse everywhere. (I can help script/capture it with the browse tool + screen capture.)

Backup artifact = a meme: "POV: you have 6 Claude Code windows open" / drowning-in-tabs format.

---

## 3. Channels, in priority order

### A. X / Twitter (build-in-public) — your main channel
- **Format:** GIF + one-line hook + repo link in *reply*, not the main tweet (X throttles link tweets).
- Post the story, not the feature: "I kept losing track of my Claude windows so I built X. It's open source. Here's a 15s demo 👇"
- Tag/reply into threads where people complain about juggling agents.
- Post 3x in week 1 from different angles (the pain / a feature / a user reaction).

### B. Show HN
- Title: **"Show HN: Conductor – a cockpit to watch and steer your parallel Claude Code sessions"**
- First comment = you, explaining *why you built it* (the 6-windows story) + the honest limits (macOS/tmux, what it can't do yet).
- Post Tue–Thu, ~8–10am ET. Reply to every comment fast for the first 2 hours — that's the whole game on HN.

### C. Reddit r/ClaudeAI (and r/Anthropic)
- These people LIVE the pain. Title as a story/question, not an ad:
  "I built a tool to manage multiple Claude Code windows — looking for people who run more than 2 to try it."
- Drop the GIF. Be present in comments.

### D. Anthropic / Claude Discord & community Slacks
- Don't drop-and-run. Find the threads where people ask "how do you manage many sessions?" and answer with the tool.

### E. Direct DMs (highest conversion, do this daily)
- 5 DMs/day to people you've seen post about Claude Code or agent fleets.
- Template below. Warm > cold every time — start with Pitch & Run / tech-week people who already know you.

---

## 4. Copy-paste templates

**X main tweet:**
> I kept having 6 Claude Code windows open and no clue which one was stuck.
>
> So I built Conductor — one cockpit that reads what every window is doing and lets you steer them.
>
> Open source. 15s demo 👇

**X reply (with link):**
> Repo + install: github.com/yksanjo/conductor — `npx`/clone, runs on :7591. Feedback very welcome, I'm actively building it.

**Show HN first comment:**
> I run a lot of parallel Claude Code sessions and kept losing track — which one finished, which is waiting on me, which went off the rails. Conductor opens a fresh window that reads each session's own transcript + live process and shows them in one board. You can reply/steer from there (it forks the window into tmux because macOS won't let you inject input otherwise). It's early — works on macOS, needs tmux. Would love to know how it breaks for you.

**Cold/warm DM:**
> hey [name] — saw you running a bunch of Claude Code sessions. I built a little open-source cockpit that shows all your windows in one place + lets you steer them. Mind giving it a 2-min try? Genuinely want to know if it's useful or not: github.com/yksanjo/conductor

---

## 5. 7-day plan (1 distribution action/day — don't build more)

- **Day 1:** Record the 15s GIF + make the meme. (Artifact day.)
- **Day 2:** X build-in-public post (GIF). Reply to 5 relevant threads.
- **Day 3:** Show HN (morning ET). Camp the comments all day.
- **Day 4:** r/ClaudeAI post. 5 DMs.
- **Day 5:** Post #2 on X (different angle / a user quote if you have one). 5 DMs.
- **Day 6:** Share in 2 Discords/Slacks in the right threads. 5 DMs to warm network (Pitch & Run).
- **Day 7:** Retro — count: stars, installs, who replied. Double down on whichever channel gave the most *real* tries.

**The gate is reps, not features.** Resist adding a 4th feature. Ship the GIF and post.

---

## 6. What "working" looks like (be honest)

- Vanity: GitHub stars, likes.
- **Real:** someone you didn't pay says "I use this every day" / files an issue / asks for a feature. That's product-market pull. One of those > 100 stars.
- If after ~30 real tries nobody comes back → the pain isn't sharp enough or the install is too hard. That's a *signal*, not a failure — fix install friction first (it's the usual killer).

---

## 7. Lower the install friction (do this before posting wide)

The #1 reason people bounce: setup. Before the campaign, make sure the very first command in the README gets someone to the cockpit in <60s. If it's `clone → npm install → node server.js`, consider a single `npx conductor-cockpit`. Friction kills distribution faster than a bad pitch.

---

*Made for Conductor — github.com/yksanjo/conductor. Distribution is the only gate now.*
