# Changelog

## Unreleased

## 0.10.0

- **Windows and Linux support:** memory, swap (Linux), processes and disk readings; alert sounds; resume
  commands quoted for PowerShell on Windows; full-text search and worktree sizes without `grep`/`du`;
  Windows path matching is case-insensitive.
- **Phone access:** the certificate is now made in Node, with no `openssl` needed; virtual, VPN and
  container adapters are skipped on all platforms; reopening a used pairing link goes to the main page
  instead of "code not valid".
- **Security:** copied `claude --resume` commands are shell-quoted and accept only plain session ids; the
  unblock coach treats command runners (`env`, `xargs`, `find`, `npm run`, `make`…) as copy-only;
  automatic `git` calls disable fsmonitor and hooks.
- Notification hook script (`scripts/notify-hook.mjs`) that works on every platform.
- Tests (`npm test`), a source check (`npm run check`), CI on macOS, Windows and Linux, releases with the
  `.vsix` attached, and contributing guidelines.

## 0.9.4

First public release.

- **Live:** running sessions and subagents (family tree), current tool with timer, last prompt and reply
  with Markdown, cost, prompt cache, context, 15-minute timeline, tool details drawer, files edited,
  pin/mute/hide/reorder, recently finished sessions, machine strip, while-you-were-away card.
- **Today:** agent-time flow ring, 5-hour limit pacing, budgets with alerts, projects, sessions by cost,
  7-day heatmap, Markdown day summary.
- **History:** every session with range/project filters, sort by cost, full-text search across
  transcripts, archive that survives Claude Code's 30-day cleanup.
- **Session insights:** costs by model/agent/turn, tokens, tools, prompts, subagents, cache misses,
  activity, git commits and pull requests, exports (Markdown, CSV, JSON, conversation).
- **Insights:** where usage goes (memory files, MCP servers, subagents, tool output), unblock coach,
  achievements, week-over-week recap, failures, slowest tools.
- **System:** machine details, top memory users, git worktree cleaner, hook errors.
- **Phone access:** read-only HTTPS page on the local network with QR pairing and per-device keys;
  Remote Control launcher for sending prompts from the Claude mobile app.
