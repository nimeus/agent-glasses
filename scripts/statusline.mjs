#!/usr/bin/env node
// Agent Glasses status line. Claude Code pipes its status JSON here on each update. This saves the plan
// limits (rate_limits) and the session's cost for the VS Code extension, then prints a short line.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dir = path.join(os.homedir(), '.claude', 'agent-glasses');
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
let j = {};
try { j = JSON.parse(raw); } catch { /* print a plain line below */ }

/** Writes through a temp file and a rename, so the extension never reads half a file. */
const save = (file, value) => {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
};
try {
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  const at = Date.now();
  if (j.rate_limits) save(path.join(dir, 'limits.json'), { at, rate_limits: j.rate_limits });
  // session_id becomes a file name: accept only plain ids
  if (typeof j.session_id === 'string' && /^[\w-]{8,64}$/.test(j.session_id))
    save(path.join(dir, 'sessions', `${j.session_id}.json`), { at, cost: j.cost ?? null, model: j.model?.display_name ?? null });
} catch { /* the status line must never fail */ }

const rl = j.rate_limits || {};
const pct = (w) => (w && typeof w.used_percentage === 'number' ? `${Math.round(w.used_percentage)}%` : '–');
const cost = typeof j.cost?.total_cost_usd === 'number' ? ` · $${j.cost.total_cost_usd.toFixed(2)}` : '';
process.stdout.write(`${j.model?.display_name || 'Claude'} · 5h ${pct(rl.five_hour)} · week ${pct(rl.seven_day)}${cost}`);
