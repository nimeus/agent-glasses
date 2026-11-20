# Claude Viz

A VS Code extension that shows what [Claude Code](https://code.claude.com) is doing, live: every running
session and subagent, what each one is working on, what it costs, how close you are to your usage limits,
and where your time and tokens go. It also has a read-only phone page for checking on sessions from
another device on your Wi-Fi.

> Unofficial. Not affiliated with or endorsed by Anthropic.

Claude Viz reads the files Claude Code already writes on your Mac (`~/.claude/projects/**`). It sends
nothing anywhere: no telemetry, no network calls, except the optional phone page, which serves your own
devices on your own network.

## Contents

- [What you get](#what-you-get)
- [Install](#install)
- [Optional setup](#optional-setup)
- [Phone access](#phone-access)
- [Settings and commands](#settings-and-commands)
- [How the numbers are worked out](#how-the-numbers-are-worked-out)
- [Privacy and security](#privacy-and-security)
- [Limitations](#limitations)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [License](#license)

## What you get

Claude Viz adds an icon to the Activity Bar. Its panel has five tabs, an alert strip above them, and a
status-bar item that turns yellow when a session needs you.

### Live

- **Machine strip:** CPU, memory, swap, free disk, Claude Code processes, and running subagents against
  your cap, with short history sparklines.
- **Usage limits:** your 5-hour and weekly plan usage with reset countdowns (needs the
  [status line](#plan-usage-status-line)), or an estimate when the real figure is not available.
- **One card per running session:**
  - what it is doing now (current tool and a live timer), your last prompt and Claude's last reply,
    each expandable to the full text rendered as Markdown;
  - this turn's duration, the session's estimated cost, whether the prompt cache is still warm, and how
    full the context window is;
  - a 15-minute timeline per agent (tool calls, thinking, compactions; click a bar for that call's input
    and output);
  - its subagents as a family tree (who started whom), with type, task and worktree;
  - recent tool calls, files edited (click to open the git change) and more figures under **More**.
- **Card actions** (⋯ menu): session insights, pin to top, mute alerts, hide, move up/down (or drag),
  copy a `claude --resume` command, open the raw transcript, and **Continue on phone** (Remote Control).
- **Recently finished** sessions as compact cards, and a **Start a new session** box.
- **While you were away:** when VS Code regains focus after a few minutes, a card lists what finished,
  what needs you, what got stuck and any limit hit.

### Today

- **Agent time:** a flow ring of working, blocked on you (approvals) and failing, across all agents.
- **5-hour limit pacing:** usage in the current window against an even pace, with a projection.
- **Budget:** today's and this month's estimated cost against optional caps, with a month-end projection.
- Projects, sessions by cost (today and lifetime), a 7-day activity heatmap, and a Markdown day summary.

### History

Every session on the machine, filterable by time range and project, sortable by recency or cost, with
full-text search across all transcripts (prompts, replies and tool output). Summaries are archived, so
sessions stay listed after Claude Code's transcript cleanup deletes them (by default after 30 days).

### Session insights

For any session, from the whole transcript and every subagent transcript:
cost over time, by model and by agent; tokens (input, cache writes, cache reads, output); every tool with
calls, failures and time; **every prompt as a turn** with duration, tools and cost (subagent cost counted
in the turn that started it), sortable; subagents; prompt-cache misses and their cause; approvals,
denials, commits, tests that turned green, thinking time, compactions, interruptions, API errors,
MCP servers and skills used; files edited; slowest calls; errors; the git commits made during the
session with an optional pull-request check (GitHub `gh` or Azure DevOps `az`); and export to Markdown,
CSV or JSON.

### Insights

- **Where usage goes:** main sessions vs subagents, memory files sent with every request
  (`CLAUDE.md` and its `@imports`), heavy MCP servers, skills and tool outputs, cache misses, with tips.
- **Unblock coach:** finds commands you approve again and again and suggests the allow rule
  (`Bash(npx vitest:*)`), with one-click add (after a confirmation, with a backup of the settings file).
- Achievements, a week-over-week recap, failures grouped by command, and the slowest tool calls.

### System

Machine details and the biggest memory users, a git worktree cleaner (removes only clean, merged agent
worktrees, never with `--force`), hook errors, and [phone access](#phone-access).

## Install

Requirements: macOS, VS Code 1.90+, Claude Code (CLI or the VS Code extension), Node.js 20+ to build.

```bash
git clone https://github.com/nimeus/claude-viz.git
cd claude-viz
npm ci
npx @vscode/vsce package --allow-missing-repository
code --install-extension claude-viz-*.vsix
```

Reload VS Code (**Developer: Reload Window**). The Claude Viz icon appears in the Activity Bar.

Live sessions, Today, History and insights work right away from the transcripts. Two optional pieces add
more.

## Optional setup

Both go in `~/.claude/settings.json`. Back the file up first.

### Needs-you alerts (Notification hook)

Lets Claude Viz alert you (notification, sound, yellow status bar) when a session asks for permission or
waits for input. Add a `Notification` hook that appends each event to a file Claude Viz watches:

```json
{
  "hooks": {
    "Notification": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "mkdir -p ~/.claude/claude-viz && { cat; echo; } >> ~/.claude/claude-viz/events.jsonl"
          }
        ]
      }
    ]
  }
}
```

Hooks are read when a session starts, so new sessions pick it up.

### Plan usage (status line)

Claude Code passes your plan's 5-hour and weekly usage (`rate_limits`) to its status-line command. That
is the only documented way to read it. Copy the included script and register it:

```bash
mkdir -p ~/.claude/claude-viz
cp scripts/statusline.mjs ~/.claude/claude-viz/statusline.mjs
```

```json
{
  "statusLine": { "type": "command", "command": "node ~/.claude/claude-viz/statusline.mjs" }
}
```

The script saves the figures to `~/.claude/claude-viz/limits.json` and prints a short line such as
`Opus · 5h 23% · week 41% · $1.23`. It replaces any status line you already have; to keep yours, call
this script from it and pass the same input through. Plan usage is reported only for subscription plans.

## Phone access

A read-only copy of the panel for your phone, served by the extension on your Wi-Fi.

1. In **System → Phone access**, press **Turn on** (or run **Claude Viz: Turn Phone Access On/Off**).
2. Press **Pair a device** and scan the QR code with your phone's camera.
3. Your phone warns that the certificate is not trusted, because it is a self-made certificate for this
   Mac. Check that its fingerprint matches the one shown in VS Code, then continue.
4. Tap **Pair this phone**. The phone now has its own key and can open the page until you revoke it.

The phone shows Live (with the same detail as the panel), Today and History, and each session's
prompts, tools and subagents. It refreshes every 3 seconds while open.

How it is protected (details in [docs/SECURITY.md](docs/SECURITY.md)):

- Off by default; turns itself off after 4 hours (`claudeViz.phone.autoOffHours`).
- Listens only on your Mac's private Wi-Fi/Ethernet addresses: not on localhost, a VPN tunnel or
  `0.0.0.0`.
- HTTPS with a certificate made on your Mac.
- Pairing codes work once and expire after 10 minutes. Each paired device gets its own random key; only
  its hash is stored. Devices can be revoked one by one.
- Read-only: no endpoint can change anything. Failed attempts are rate-limited.

### Sending prompts from the phone

The page itself cannot send prompts: the Claude VS Code extension only fills in text and leaves sending
to you. To reply from the phone, use Claude Code's **Remote Control**: **Continue on phone** in a finished
session's ⋯ menu opens a terminal running `claude --resume <id> --remote-control`, and **Start a phone
session** starts a new one. The session then appears in the Claude mobile app, where you can send prompts
and approve tools.

## Settings and commands

| Setting | Default | What it does |
|---|---|---|
| `claudeViz.notifyOnFinish` | `true` | Notify when a session finishes its turn. |
| `claudeViz.sound` | `true` | Play a sound (macOS) when a session needs you. |
| `claudeViz.celebrate` | `true` | Brief message when a commit lands, tests turn green again, a subagent finishes cleanly or you earn an achievement. |
| `claudeViz.contextWindow` | `1000000` | Context window size the context gauge measures against. |
| `claudeViz.diskWarnGb` | `30` | Warn below this much free disk (red below two thirds of it). |
| `claudeViz.budget.dailyUsd` | `0` (off) | Daily budget at API prices; warns at 80% and 100%. |
| `claudeViz.budget.monthlyUsd` | `0` (off) | Monthly budget at API prices; warns at 80% and 100%. |
| `claudeViz.phone.port` | `7843` | Port for phone access. |
| `claudeViz.phone.autoOffHours` | `4` | Phone access turns itself off after this many hours. |

| Command | |
|---|---|
| **Claude Viz: Open in Editor** | Opens the panel in an editor tab instead of the sidebar. |
| **Claude Viz: Open Today's Summary** | Today's work as an unsaved Markdown document. |
| **Claude Viz: Turn Phone Access On/Off** | Starts or stops the phone page. |

## How the numbers are worked out

- **Cost** is an estimate at API prices, not your bill. Each reply's token counts are priced per model.
  The price per model is learned from the cost records Claude Code itself writes into transcripts
  (`cost-state` lines), using its median, so no price list is built in. Token classes are weighted relative
  to uncached input: output 5×, cache writes 1.25× (5-minute) or 2× (1-hour), cache reads 0.1×. On a
  subscription you are not billed these amounts.
- **Agent time** adds up every agent: five subagents working for an hour count as five hours. *Blocked*
  is time a tool call waited for your approval; *failing* is time after a failed call until one
  succeeds. *Your active time* is wall-clock time with a main session active (gaps under five minutes).
- **Running** means a tool call is in progress, or Claude still owes a reply (the last entry is your prompt
  or a tool result), or the transcript changed in the last minute.
- **Cache misses:** a reply where most of the prompt had to be written to the cache again. A gap longer
  than the cache lifetime before it is reported as "after a break".
- **5-hour limit estimate** (only when the status line is not set up): usage is weighted from token counts
  and compared with the median usage before your past limit hits.
- **Memory files** are estimated at about 3.6 characters per token.

## Privacy and security

- Everything stays on your machine. Claude Viz reads `~/.claude/projects/**`, `~/.claude/settings.json`
  and its own folder `~/.claude/claude-viz/`, and runs local commands such as `git`, `ps`, `vm_stat` and
  `sysctl`.
- It writes only to `~/.claude/claude-viz/` (archive, phone keys, events), and to Claude Code settings
  when you confirm an allow rule from the Unblock coach (a backup is kept beside the file).
- The panel renders transcript text as text, never as HTML. Secret-looking strings (API keys, bearer
  tokens, JWTs, long hex) are masked in error messages, exports and search snippets.
- The phone page is covered in [docs/SECURITY.md](docs/SECURITY.md).

## Limitations

- macOS only for now (process, memory and swap readings use macOS tools; the rest is portable).
- The panel cannot type into a Claude tab that is already open, and cannot approve permission prompts:
  Claude Code exposes no API for either.
- Very long transcripts (over 20 MB) are read from their last 20 MB for daily statistics, so older days
  can be undercounted. Session insights always read the whole file.
- Costs are estimates. Weekly limits come only from the status line.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Panel looks unchanged after an update | Reload the window; if it persists, quit VS Code (⌘Q) and reopen. |
| Limits say "est." | Set up the [status line](#plan-usage-status-line) and start a new Claude Code session. |
| No needs-you alerts | Add the [Notification hook](#needs-you-alerts-notification-hook); it applies to new sessions. |
| Phone: "Pairing code not valid" | Press **New code** in VS Code and scan again. The reason is logged in **Output → Claude Viz Phone**. |
| Phone access won't start | Connect to Wi-Fi or Ethernet; if the port is taken, change `claudeViz.phone.port`. |

## Development

```
extension.js            VS Code wiring: panels, status bar, alerts, messages from the webview
lib/data.js             transcript reading: live snapshot, 14-day statistics, search, history
lib/session-insight.js  full analysis of one session (streamed)
lib/insights.js         unblock coach, achievements, recap, attribution, budget, weekly estimate
lib/system.js           machine readings
lib/worktrees.js        git worktree scan and safe removal
lib/git.js              commits during a session, pull request lookup
lib/search.js           full-text search across transcripts
lib/export.js           Markdown/CSV/JSON exports
lib/archive.js          summaries kept after transcript cleanup
lib/phone.js            phone access server (HTTPS, pairing, devices)
media/view.js, .css     the panel (plain DOM, no framework)
media/phone/            the phone page
scripts/statusline.mjs  status-line script for plan usage
```

There is no build step and one runtime dependency (`qrcode-generator`). After a change, package and
reinstall as in [Install](#install), bumping the version in `package.json` each time so VS Code loads
the new copy. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how data flows.

## License

[MIT](LICENSE)
