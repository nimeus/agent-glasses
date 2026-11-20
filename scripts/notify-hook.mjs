#!/usr/bin/env node
// Agent Glasses Notification hook. Claude Code pipes each notification (permission prompt, waiting for input)
// here as JSON; this appends it as one line to ~/.claude/agent-glasses/events.jsonl, which the extension watches.
// Pure Node, so it works the same on macOS, Linux and Windows.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
try {
  const line = JSON.stringify(JSON.parse(raw)); // one line, and only valid JSON is written
  const dir = path.join(os.homedir(), '.claude', 'agent-glasses');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'events.jsonl'), line + '\n');
} catch { /* a hook must never fail the session */ }
