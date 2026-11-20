// Derived views over the transcript statistics: today's flow, the unblock coach, achievements and the
// weekly recap. Pure functions apart from reading permission allow-lists and the status-line files.
const fs = require('fs');
const os = require('os');
const path = require('path');

const MIN = 60_000;
const VIZ = path.join(os.homedir(), '.claude', 'claude-viz');
const USER_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const allowList = (f) => { const s = readJson(f); return Array.isArray(s?.permissions?.allow) ? s.permissions.allow : []; };
const flowOf = (d) => { const t = d.work + d.blocked + d.failMs; return t ? d.work / t : 0; };

// Commands whose allow rule would hand over too much: never offered as a one-click rule, only copied.
const RISKY = /^(rm|rmdir|sudo|chmod|chown|dd|mkfs|kill|pkill|killall|launchctl|curl|wget|ssh|scp|rsync|docker|az|gh|security|osascript|open|eval|exec|psql|sqlcmd|mysql|git push|git reset|git clean|git checkout|git rebase|git restore|git branch|git tag|git worktree|npm publish|pnpm publish|yarn publish|pnpm dlx|env|xargs|find|awk|gawk|sed|make|nohup|time|nice|timeout|watch|exec|command|builtin|parallel|git config|git -c|git -C|npm run|npm exec|npm x|pnpm run|pnpm exec|yarn run|yarn exec|yarn dlx|bun run|bun x|cargo run|go run|uv run|uvx|pipx run|deno run|dotnet run|gradle|gradlew|mvn exec)\b/;
// An interpreter on its own runs anything; with a named package or script it is narrower.
const INTERPRETER = /^(bash|sh|zsh|node|python3?|ruby|perl|npx|bunx|deno|tsx)$/;
// Tools that ask the user something but are not permission prompts.
const NOT_PERMISSIONS = new Set(['AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode']);
const TWO_WORD = /^(git|npm|pnpm|yarn|bun|npx|az|gh|docker|cargo|go|dotnet|mvn|gradle|brew|pip3?|uv)$/;

/** The allow rule that would have skipped this approval, in the `Tool(prefix:*)` form the settings use. */
/** Rule for one simple command (no chaining), or null when it cannot be expressed as a prefix. */
function bashRule(part) {
  const toks = part.trim().split(/\s+/).filter(Boolean);
  while (toks.length && /^\w+=/.test(toks[0])) toks.shift(); // leading VAR=value assignments
  // Shell syntax and scaffolding are not the work being approved (`.`/`source` would run any script).
  if (!toks.length || /^(cd|set|export|true|false|echo|printf|:|for|do|done|while|until|if|then|elif|else|fi|case|esac|in|\{|\}|\.|source|sleep|wait)$/.test(toks[0])) return null;
  const prefix = toks.slice(0, TWO_WORD.test(toks[0]) && toks[1] && !toks[1].startsWith('-') ? 2 : 1).join(' ');
  if (/[|;&<>$`(){}"'\\]/.test(prefix)) return null;
  return { rule: `Bash(${prefix}:*)`, label: prefix, risky: RISKY.test(prefix) || INTERPRETER.test(prefix) };
}

/**
 * Rules for an approval. Claude Code checks a chained command part by part, so a chain yields one rule per
 * part: once every part is allowed, the whole chain runs without a prompt. Heredoc bodies are ignored.
 */
function rulesFor(a) {
  if (a.name === 'Bash') {
    const first = a.cmd.split('\n')[0].replace(/\d?>&\d|&>\s*\S+|\d?>>?\s*\S+|<<-?\s*'?\w+'?/g, ' '); // redirections, heredoc markers
    const parts = first.split(/\s*(?:&&|\|\||;|\|)\s*/).filter((p) => p.trim());
    const rules = parts.map(bashRule).filter(Boolean);
    return { rules, chained: parts.length > 1 };
  }
  if (a.name === 'WebFetch' && a.url) {
    try { const h = new URL(a.url).hostname; return { rules: [{ rule: `WebFetch(domain:${h})`, label: h, risky: false }] }; } catch { return { rules: [] }; }
  }
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(a.name)) return { rules: [{ rule: '', label: 'File edits', risky: false, note: 'Switch the session to accept-edits mode instead of adding a rule.' }] };
  if (a.name.startsWith('mcp__')) return { rules: [{ rule: a.name, label: a.name.replace(/^mcp__/, '').replace('__', ': '), risky: /delete|remove|send|push|pay|drop|revoke|cancel/i.test(a.name) }] };
  return { rules: [{ rule: a.name, label: a.name, risky: false }] };
}

/** Repeated approvals grouped by the rule that would remove them, biggest time sink first. */
function coach(approvals) {
  const user = new Set(allowList(USER_SETTINGS));
  const groups = new Map();
  let total = 0, chained = 0, wait = 0;
  for (const a of approvals) {
    if (NOT_PERMISSIONS.has(a.name)) continue;
    const { rules, chained: isChain } = rulesFor(a);
    total++; wait += a.wait; if (isChain) chained++;
    for (const r of rules) {
      const key = r.rule || r.label;
      const g = groups.get(key) || { ...r, count: 0, wait: 0, last: 0, example: '', cwd: '', projects: new Set() };
      g.count++; g.wait += a.wait; g.projects.add(a.project);
      if (a.ts > g.last) { g.last = a.ts; g.example = (a.cmd || a.url || a.name).split('\n')[0].slice(0, 160); g.cwd = a.cwd; }
      groups.set(key, g);
    }
  }
  const items = [...groups.values()]
    .filter((g) => g.count >= 2)
    .map((g) => {
      const local = g.cwd ? allowList(path.join(g.cwd, '.claude', 'settings.local.json')) : [];
      return { ...g, projects: [...g.projects], allowed: !!g.rule && (user.has(g.rule) || local.includes(g.rule)) };
    })
    .filter((g) => !g.allowed)
    .sort((a, b) => b.count - a.count || b.wait - a.wait)
    .slice(0, 12);
  return { total, chained, wait, items };
}

const BADGES = [
  { id: 'nowall', name: 'No wall', need: 'Finish a working day without hitting the 5-hour limit', test: (d) => d.active >= 30 * MIN && d.hits === 0 },
  { id: 'unblocked', name: 'Zero blocked minutes', need: 'Agents never wait more than a minute for your approval', test: (d) => d.work >= 30 * MIN && d.blocked < MIN },
  { id: 'flow', name: 'Flow ≥ 90%', need: 'Agents spend 90% of their time working, not blocked or failing', test: (d) => d.work >= 30 * MIN && flowOf(d) >= 0.9 },
];

/** Today's badges (earned or what is still needed) and how often each was earned in the last 7 days. */
function achievements(days, wt) {
  const today = days[days.length - 1], week = days.slice(-7);
  const out = BADGES.map((b) => ({ id: b.id, name: b.name, need: b.need, earned: b.test(today), week: week.filter(b.test).length }));
  const trees = (wt?.repos || []).flatMap((r) => r.trees);
  out.push({ id: 'clean', name: 'Clean slate', need: 'No merged, clean agent worktrees left behind', earned: !!wt?.at && !trees.some((t) => t.removable), week: null });
  return out;
}

const totals = (arr) => {
  const s = arr.reduce((a, d) => { for (const k of ['active', 'work', 'blocked', 'failMs', 'tools', 'errors', 'commits', 'greens', 'hits', 'est']) a[k] = (a[k] || 0) + d[k]; return a; }, {});
  return { ...s, flow: flowOf(s), failRate: s.tools ? s.errors / s.tools : 0 };
};

/** This week against last week, plus personal bests over the 14 days read. */
function recap(days) {
  const now = totals(days.slice(-7)), before = totals(days.slice(0, 7));
  const worked = days.filter((d) => d.work >= 30 * MIN);
  const best = (f, pick) => worked.length ? worked.reduce((a, d) => (pick(d) > pick(a) ? d : a)) : null;
  const bf = best('flow', flowOf), bc = best('commits', (d) => d.commits), br = best('run', (d) => d.bestRun);
  return {
    now, before,
    bests: [
      bf && { label: 'Best flow day', value: `${Math.round(flowOf(bf) * 100)}%`, day: bf.label },
      bc && bc.commits && { label: 'Most commits', value: String(bc.commits), day: bc.label },
      br && br.bestRun && { label: 'Longest focused run', value: `${Math.round(br.bestRun / MIN)} min`, day: br.label },
    ].filter(Boolean),
  };
}

/** Plan limits saved by the status line; a window is dropped once its reset time has passed. */
function account() {
  const j = readJson(path.join(VIZ, 'limits.json'));
  if (!j?.rate_limits) return null;
  const now = Date.now() / 1000;
  const win = (w) => (w && typeof w.used_percentage === 'number' && (!w.resets_at || w.resets_at > now) ? { pct: w.used_percentage / 100, resetsAt: w.resets_at ? w.resets_at * 1000 : 0 } : null);
  const out = { at: j.at || 0, fiveHour: win(j.rate_limits.five_hour), sevenDay: win(j.rate_limits.seven_day) };
  return out.fiveHour || out.sevenDay ? out : null;
}

/** Cost Claude Code reported to the status line for this run of a session, if any. */
function runCost(sessionId) {
  if (!/^[\w-]{8,64}$/.test(sessionId)) return null;
  const j = readJson(path.join(VIZ, 'sessions', `${sessionId}.json`));
  return typeof j?.cost?.total_cost_usd === 'number' ? j.cost.total_cost_usd : null;
}

/**
 * Adds one allow rule to the user's or the project's settings. Reads and re-writes the JSON (refusing to
 * touch a file it cannot parse), keeps a backup beside it, and never adds a rule twice.
 */
function addRule(rule, scope, cwd) {
  if (typeof rule !== 'string' || !/^[\w.:-]+(\(.{1,200}\))?$/.test(rule)) return { ok: false, err: 'Not a valid rule.' };
  const file = scope === 'user' ? USER_SETTINGS : path.join(cwd, '.claude', 'settings.local.json');
  let s = {};
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8');
    try { s = JSON.parse(raw); } catch { return { ok: false, err: `${file} is not valid JSON; not changed.` }; }
    fs.writeFileSync(`${file}.bak-agent-glasses`, raw);
  } else fs.mkdirSync(path.dirname(file), { recursive: true });
  s.permissions = s.permissions || {};
  s.permissions.allow = Array.isArray(s.permissions.allow) ? s.permissions.allow : [];
  if (!s.permissions.allow.includes(rule)) s.permissions.allow.push(rule);
  fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n');
  return { ok: true, file };
}

// ---------- where usage goes ----------
const approxTokens = (chars) => Math.round(chars / 3.6);

/**
 * Memory files Claude Code sends with every request in a project: the user and project CLAUDE.md files,
 * their @imports (one level deep per file), and the project's auto-memory MEMORY.md.
 */
function memoryFiles(cwds) {
  const home = os.homedir(), seen = new Map();
  const add = (file, project) => {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
    const e = seen.get(file) || { path: file, name: file.replace(home, '~'), tokens: approxTokens(text.length), projects: new Set() };
    if (project) e.projects.add(project);
    const isNew = !seen.has(file);
    seen.set(file, e);
    if (!isNew) return;
    for (const m of text.matchAll(/^@(\S+)\s*$/gm)) {
      const target = m[1].startsWith('~') ? path.join(home, m[1].slice(1)) : path.resolve(path.dirname(file), m[1]);
      add(target, project);
    }
  };
  for (const cwd of cwds) {
    const project = path.basename(cwd);
    add(path.join(home, '.claude', 'CLAUDE.md'), project);
    for (const f of ['CLAUDE.md', 'CLAUDE.local.md', path.join('.claude', 'CLAUDE.md')]) add(path.join(cwd, f), project);
    add(path.join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), 'memory', 'MEMORY.md'), project);
  }
  return [...seen.values()].map((e) => ({ ...e, projects: [...e.projects] })).sort((a, b) => b.tokens - a.tokens);
}

/** The last 7 days' cost split, heavy MCP servers / skills / tools, cache misses and memory files, with suggestions. */
function attribution(days, cwds) {
  const week = days.slice(-7);
  const sum = (f) => week.reduce((a, d) => a + (d[f] || 0), 0);
  const merge = (f) => {
    const out = {};
    for (const d of week) for (const [k, v] of Object.entries(d[f] || {})) {
      const x = out[k] || (out[k] = { calls: 0, chars: 0 });
      if (typeof v === 'number') x.chars += v; else { x.calls += v.calls; x.chars += v.chars; }
    }
    return Object.entries(out).map(([name, v]) => ({ name, ...v, tokens: approxTokens(v.chars) })).sort((a, b) => b.chars - a.chars);
  };
  const estMain = sum('estMain'), estSub = sum('estSub'), total = estMain + estSub;
  const mcp = merge('mcp'), skills = merge('skills'), tools = merge('toolChars').slice(0, 8);
  const memory = memoryFiles(cwds).slice(0, 10);
  const cacheMiss = sum('cacheMiss'), missCost = sum('missCost');
  const tips = [];
  for (const m of memory.filter((x) => x.tokens >= 8000).slice(0, 2))
    tips.push({ kind: 'memory', text: `${m.name} adds about ${Math.round(m.tokens / 1000)}k tokens to every request${m.projects.length > 1 ? ' in ' + m.projects.length + ' projects' : ''}. Moving rarely needed sections out (or into a skill) shrinks every turn.`, file: m.path });
  if (total > 0 && estSub / total > 0.4) tips.push({ kind: 'subagents', text: `Subagents used ${Math.round((estSub / total) * 100)}% of this week's cost (≈$${estSub.toFixed(0)}). Fewer or more focused subagents, or a cheaper model for them, cuts that most.` });
  for (const m of mcp.filter((x) => x.chars > 200_000).slice(0, 2)) tips.push({ kind: 'mcp', text: `MCP server ${m.name} returned about ${Math.round(m.tokens / 1000)}k tokens in ${m.calls} calls. Results are re-sent on every later step; asking it for less (filters, limits, fewer fields) saves the most.` });
  for (const t of tools.filter((x) => x.chars > 500_000 && !x.name.startsWith('mcp__')).slice(0, 2)) tips.push({ kind: 'tool', text: `${t.name} results came to about ${Math.round(t.tokens / 1000)}k tokens this week. Large results are re-sent on every later step of a turn.` });
  if (missCost > 3) tips.push({ kind: 'cache', text: `${cacheMiss} cache misses cost about $${missCost.toFixed(2)}. After a break longer than the cache lifetime, the next reply re-reads the whole conversation at full price.` });
  return { estMain, estSub, total, mcp, skills, tools, memory, cacheMiss, missCost, tips };
}

// ---------- budgets ----------
const localKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** Today's and this month's estimated cost against the configured budgets, with a month-end projection. */
function budget(days, archived, daily, monthly) {
  const now = new Date(), month = localKey(now).slice(0, 7);
  const byKey = new Map(archived.map((d) => [d.key, d.est || 0]));
  for (const d of days) byKey.set(d.key, Math.max(byKey.get(d.key) || 0, d.est || 0));
  const mtd = [...byKey.entries()].filter(([k]) => k.startsWith(month)).reduce((a, [, v]) => a + v, 0);
  const today = days[days.length - 1]?.est || 0;
  const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const elapsed = now.getDate() - 1 + (now.getHours() * 60 + now.getMinutes()) / 1440;
  return { today, month: mtd, projected: elapsed > 0.25 ? (mtd / elapsed) * dim : 0, daily, monthly, dailyPct: daily ? today / daily : 0, monthlyPct: monthly ? mtd / monthly : 0 };
}

// ---------- weekly limit estimate ----------
/** 7-day usage against the median usage seen in the 7 days before past weekly-limit hits (an estimate). */
function weekly(days, archived, hits) {
  const units = new Map(archived.map((d) => [d.key, d.units || 0]));
  for (const d of days) units.set(d.key, Math.max(units.get(d.key) || 0, d.units || 0));
  const sevenBefore = (t) => { let n = 0, covered = 0; for (let i = 0; i < 7; i++) { const k = localKey(t - i * 86_400_000); if (units.has(k)) { n += units.get(k); covered++; } } return { n, covered }; };
  const caps = hits.map(sevenBefore).filter((x) => x.covered >= 6).map((x) => x.n).sort((a, b) => a - b);
  const used = sevenBefore(Date.now()).n;
  const cap = caps.length ? caps[Math.floor(caps.length / 2)] : 0;
  return { used, cap, pct: cap ? used / cap : 0, samples: caps.length, lastHit: hits[hits.length - 1] || 0 };
}

module.exports = { coach, achievements, recap, account, runCost, addRule, flowOf, attribution, memoryFiles, budget, weekly };
