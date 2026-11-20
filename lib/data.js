// Reads Claude Code transcripts, read-only:
// ~/.claude/projects/<project>/<session>.jsonl, <session>/subagents/agent-*.jsonl and their *.meta.json.
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(os.homedir(), '.claude', 'projects');
/** Written by the Claude Code Notification hook in ~/.claude/settings.json. */
const EVENTS = path.join(os.homedir(), '.claude', 'claude-viz', 'events.jsonl');
/** A transcript with a line timestamped within this window counts as running. */
const ACTIVE_MS = 60_000;
/** A tool call still waiting for its result keeps its session listed this long (builds, test runs). */
const PENDING_MS = 30 * 60_000;
/** Gaps between transcript lines shorter than this count as active time. */
const IDLE_GAP_MS = 5 * 60_000;
/** Width of the per-session timeline. */
const TIMELINE_MS = 15 * 60_000;
const TAIL_BYTES = 400_000;
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/** Commands that run a test suite; a failing run followed by a passing one counts as "tests green again". */
const TEST_RE = /\b(?:npm|pnpm|yarn|bun|npx)\s+(?:run\s+)?(?:test|vitest|jest)\b|\bvitest\b|\bjest\b|\bpytest\b|\bgo\s+test\b|\bcargo\s+test\b|\bgradlew?\s+test\b|\bmvn\s+test\b/;
const COMMIT_RE = /\bgit\s+(?:(?:-C|-c|--git-dir|--work-tree)\s+\S+\s+|--?[\w-]+(?:=\S+)?\s+)*commit\b/;
/** True when a tool_result line was released by the user answering a permission prompt. */
const userApproved = (j) => !!j.permissionDecision && String(j.permissionDecision.source || '').startsWith('user');

function readRange(file, start, len) {
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  const n = fs.readSync(fd, buf, 0, len, start);
  fs.closeSync(fd);
  return buf.toString('utf8', 0, n);
}

const lines = (text) => text.split('\n').flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });

const textOf = (c) => typeof c === 'string' ? c : Array.isArray(c) ? (c.find((p) => p.type === 'text')?.text || '') : '';

/** The user's own words in a transcript line, skipping system-injected text. */
function promptText(j) {
  if (j.type !== 'user' || j.isMeta) return '';
  const c = j.message?.content;
  const t = typeof c === 'string' ? c : Array.isArray(c) ? c.find((p) => p.type === 'text' && !p.text.startsWith('<'))?.text : '';
  return t && !t.startsWith('<') ? t.trim() : '';
}

const heads = new Map();
/** First prompt and start time, read once from the start of the file (the tail may not reach them). */
function head(file) {
  const hit = heads.get(file);
  if (hit?.label) return hit;
  const info = { label: '', start: 0 };
  for (const j of lines(readRange(file, 0, 65_536))) {
    if (!info.start && j.timestamp) info.start = Date.parse(j.timestamp);
    if (!info.label) info.label = promptText(j);
    if (info.label && info.start) break;
  }
  heads.set(file, info);
  return info;
}

const lastPrompts = new Map(); // file -> latest prompt text, kept once it scrolls out of the tail

/** Text of a message the user typed: a normal prompt, or one queued while Claude was working. */
function userText(j) {
  // Queued text is either a message the user typed mid-turn or a system notification (<task-notification>…).
  if (j.type === 'queue-operation' && typeof j.content === 'string' && j.content.trim() && !j.content.trim().startsWith('<')) return j.content.trim();
  return promptText(j);
}

/** Finds the latest prompt further back than the tail, once per transcript. */
function deepLastPrompt(file, size) {
  const len = Math.min(3_000_000, size);
  let text = readRange(file, size - len, len);
  if (len < size) text = text.slice(text.indexOf('\n') + 1);
  let found = '';
  for (const j of lines(text)) { const t = userText(j); if (t && !t.startsWith('[Request interrupted')) found = t; }
  return found;
}

const metas = new Map();
/** Subagent metadata Claude Code writes beside its transcript (type, task, worktree). */
function meta(file) {
  if (!metas.has(file)) {
    try { metas.set(file, JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'))); } catch { metas.set(file, {}); }
  }
  return metas.get(file);
}

function describe(input = {}) {
  const file = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : '';
  const raw = input.description || (file && path.basename(file)) || input.command || input.pattern || input.query || input.url || input.skill || input.prompt || '';
  return { hint: String(raw).replace(/\s+/g, ' ').slice(0, 100), file };
}

const jsonl = (dir) => {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ f: path.join(dir, f), m: fs.statSync(path.join(dir, f)).mtimeMs }));
  } catch { return []; }
};

/** Why a run looks stuck, or '' — repeated failures, the same call over and over, or one call running very long. */
function stuckReason(tools, pending, now) {
  let fails = 0;
  for (let i = tools.length - 1; i >= 0 && tools[i].ok === false; i--) fails++;
  if (fails >= 3) return `${fails} failed tool calls in a row`;
  const counts = new Map();
  for (const t of tools.slice(-10)) { const k = t.name + '\u0000' + t.hint; counts.set(k, (counts.get(k) || 0) + 1); }
  for (const [k, n] of counts) if (n >= 4) { const [name, hint] = k.split('\u0000'); return `Repeated ${n}× in the last 10 calls: ${name}${hint ? ' ' + hint : ''}`; }
  if (pending && pending.name !== 'Agent' && now - pending.ts > 15 * 60_000) return `${pending.name} has been running for over 15 minutes`;
  return '';
}

/** Summarises one transcript's tail for the live view. */
function parse(file) {
  const { size, mtimeMs } = fs.statSync(file);
  const len = Math.min(TAIL_BYTES, size);
  let text = readRange(file, size - len, len);
  if (len < size) text = text.slice(text.indexOf('\n') + 1);

  const tools = [];
  const byId = new Map();
  const files = new Map();
  let title = '', model = '', context = 0, cache = 0, said = '', branch = '', cwd = '', last = '', lastTs = 0;
  let lastPrompt = '', turnStart = 0, promptId = '', entrypoint = '', cost = 0, apiErr = '', apiTs = 0, think = 0;
  const thinks = [], compactions = [], spawned = [];
  const resp = []; // per model response: ts, read, write, input, oneHour
  for (const j of lines(text)) {
    if (j.aiTitle) title = j.aiTitle;
    if (j.gitBranch) branch = j.gitBranch;
    if (j.cwd) cwd = j.cwd;
    if (j.entrypoint) entrypoint = j.entrypoint;
    if (j.type === 'cost-state' && typeof j.totalCostUSD === 'number') cost = j.totalCostUSD;
    const ts = j.timestamp ? Date.parse(j.timestamp) : 0;
    if (ts) lastTs = ts;
    if (ts && j.promptId && j.promptId !== promptId) { promptId = j.promptId; turnStart = ts; }
    { const pt = promptText(j); if (pt) { const intr = pt.startsWith('[Request interrupted'); last = intr ? 'interrupted' : 'prompt'; if (!intr) lastPrompt = pt; } }
    if (j.type === 'queue-operation') { const qt = userText(j); if (qt) lastPrompt = qt; }
    if (j.subtype === 'compact_boundary' && j.compactMetadata) compactions.push({ ts, trigger: j.compactMetadata.trigger || '', pre: j.compactMetadata.preTokens || 0, post: j.compactMetadata.postTokens || 0 });
    if (j.type === 'assistant' && j.thinkingDurationMs > 0) { think += j.thinkingDurationMs; thinks.push({ ts: ts - j.thinkingDurationMs, ms: j.thinkingDurationMs }); }
    const msg = j.message;
    if (j.isApiErrorMessage) { apiErr = textOf(msg?.content).slice(0, 200); apiTs = ts; continue; }
    if (j.type === 'assistant' && msg?.model && msg.model !== '<synthetic>') {
      model = msg.model;
      if (ts > apiTs) apiErr = '';
      const u = msg.usage || {};
      const read = u.cache_read_input_tokens || 0;
      context = (u.input_tokens || 0) + read + (u.cache_creation_input_tokens || 0);
      const mid = msg.id || j.requestId || '';
      if (mid && (!resp.length || resp[resp.length - 1].id !== mid)) {
        const cc = u.cache_creation || {};
        resp.push({ id: mid, ts, read, write: u.cache_creation_input_tokens || 0, input: u.input_tokens || 0, oneHour: (cc.ephemeral_1h_input_tokens || 0) > 0 });
      }
      if (context) cache = read / context;
    }
    if (!Array.isArray(msg?.content)) continue;
    for (const p of msg.content) {
      if (j.type === 'assistant' && p.type === 'tool_use') {
        const t = { id: p.id, name: p.name, ...describe(p.input), cmd: p.name === 'Bash' && typeof p.input?.command === 'string' ? p.input.command.slice(0, 300) : '', ts, ok: null, ms: 0, waited: 0 };
        tools.push(t);
        byId.set(p.id, t);
        if (p.name === 'Agent' || p.name === 'Task') spawned.push(p.id);
        if (FILE_TOOLS.has(p.name) && t.file) files.set(t.file, { n: (files.get(t.file)?.n || 0) + 1, ts });
        last = 'tool';
      } else if (j.type === 'assistant' && p.type === 'text' && p.text.trim()) {
        said = p.text;
        last = 'text';
      } else if (p.type === 'tool_result') {
        const t = byId.get(p.tool_use_id);
        if (t) {
          t.ok = !p.is_error; t.ms = ts && t.ts ? ts - t.ts : 0;
          if (userApproved(j)) t.waited = t.ms;
          if (t.ok && COMMIT_RE.test(t.cmd) && !/--dry-run/.test(t.cmd)) t.commit = true;
        }
        last = 'result';
      }
    }
  }

  const now = Date.now();
  const pending = [...tools].reverse().find((t) => t.ok === null && now - t.ts < PENDING_MS) || null;
  const fresh = now - (lastTs || mtimeMs) < ACTIVE_MS;
  // After a prompt or a tool result Claude still owes a reply; long thinking writes nothing until it ends,
  // so such a transcript counts as thinking for up to PENDING_MS even when it has gone quiet.
  // A subagent ends by handing its result back (SubagentHandback); after that it owes nothing.
  const lastTool = tools[tools.length - 1];
  const handedBack = !!lastTool && lastTool.name === 'SubagentHandback' && lastTool.ok !== null;
  const owed = !handedBack && (last === 'prompt' || last === 'result') && now - lastTs < PENDING_MS;
  const state = pending ? 'tool' : handedBack ? (fresh ? 'replied' : 'idle') : owed ? 'thinking' : !fresh ? 'idle' : last === 'text' ? 'replied' : last === 'interrupted' ? 'idle' : 'thinking';
  const spark = new Array(20).fill(0); // tool calls per 30 s over the last 10 min
  for (const t of tools) {
    const bin = 19 - Math.floor((now - t.ts) / 30_000);
    if (bin >= 0 && bin < 20) spark[bin]++;
  }
  // Commits that landed, and test runs that went green after a red one, in the recent tail.
  const commits = tools.filter((t) => t.commit).map((t) => ({ id: t.id, ts: t.ts, hint: t.hint }));
  const greens = [];
  let red = false;
  for (const t of tools) {
    if (!TEST_RE.test(t.cmd) || t.ok === null) continue;
    if (!t.ok) red = true;
    else if (red) { greens.push({ id: t.id, ts: t.ts, hint: t.hint }); red = false; }
  }
  // Last 30 minutes split into working, blocked on the user, failing.
  const since30 = now - 30 * 60_000;
  const flow = { work: 0, blocked: 0, failing: 0 };
  for (const t of tools) {
    if (t.ts < since30) continue;
    if (t.ok === null) { flow[pending === t && needsHint(file) ? 'blocked' : 'work'] += now - t.ts; continue; }
    flow.blocked += t.waited;
    flow[t.ok ? 'work' : 'failing'] += Math.max(0, t.ms - t.waited);
  }
  for (const t of thinks) if (t.ts >= since30) flow.work += t.ms;

  // Prompt cache: hit rate over recent replies, misses with their likely cause, and how long it stays warm.
  const ttl = resp.slice(-5).some((r) => r.oneHour) ? 3_600_000 : 300_000;
  const recent = resp.slice(-20);
  const tot = recent.reduce((a, r) => a + r.read + r.write + r.input, 0);
  const misses = [];
  for (let i = 1; i < resp.length; i++) {
    const r = resp[i], all = r.read + r.write + r.input;
    if (all > 20_000 && r.write > all * 0.5) {
      const gap = r.ts - resp[i - 1].ts;
      misses.push({ ts: r.ts, tokens: r.write, cause: gap > ttl ? 'break' : 'changed' , gap });
    }
  }
  const lastResp = resp[resp.length - 1];
  const cacheInfo = {
    hit: tot ? recent.reduce((a, r) => a + r.read, 0) / tot : 0,
    ttl, warmLeft: lastResp ? Math.max(0, ttl - (now - lastResp.ts)) : 0,
    misses: misses.slice(-5), missCount: misses.length,
  };

  const h = head(file);
  return {
    cacheInfo,
    commits, greens, flow,
    lastPrompt: (() => {
      if (lastPrompt) lastPrompts.set(file, lastPrompt);
      else if (!lastPrompts.has(file) && size > len) lastPrompts.set(file, deepLastPrompt(file, size));
      return (lastPrompts.get(file) || '').slice(0, 12_000);
    })(),
    title, prompt: h.label, start: h.start, model: model.replace(/^claude-/, ''), context, cache, cost, branch, cwd, entrypoint,
    state, running: state !== 'idle', lastTs, turnStart, rateLimit: apiErr,
    said: said.trim().slice(0, 12_000),
    current: pending && { name: pending.name, hint: pending.hint, ts: pending.ts },
    tools: tools.slice(-10),
    timeline: tools.filter((t) => t.ts > now - TIMELINE_MS).slice(-150)
      .map((t) => ({ id: t.id, n: t.name, h: t.hint, ts: t.ts, ms: t.ok === null ? now - t.ts : t.ms, ok: t.ok, c: t.commit ? 1 : 0 })),
    files: [...files].sort((a, b) => b[1].ts - a[1].ts).slice(0, 20).map(([p, v]) => ({ path: p, name: path.basename(p), n: v.n, ts: v.ts })),
    total: tools.length, errors: tools.filter((t) => t.ok === false).length, spark,
    stuck: stuckReason(tools, pending, now),
    think, spawned,
    thinking: thinks.filter((t) => t.ts + t.ms > now - TIMELINE_MS),
    compactions: compactions.slice(-5),
  };
}

/** Running sessions in any project (oldest first so cards don't jump), each with its running subagents. */
let needsNow = new Set();
const needsHint = (file) => needsNow.has(path.basename(file, '.jsonl'));

function snapshot(needs = new Map(), contextWindow = 1_000_000, pinned = new Set()) {
  needsNow = new Set(needs.keys());
  let dirs = [];
  try { dirs = fs.readdirSync(ROOT).map((d) => path.join(ROOT, d)); } catch { return { sessions: [] }; }
  const now = Date.now();
  const cutoff = now - PENDING_MS;
  const recent = []; // finished within the window: shown as one-line rows, not cards
  const found = new Set();
  const candidates = dirs.flatMap((d) => jsonl(d).filter((x) => x.m > cutoff).map((x) => { found.add(path.basename(x.f, '.jsonl')); return { d, f: x.f }; }));
  for (const id of pinned) {
    if (found.has(id) || !/^[\w-]{8,64}$/.test(id)) continue;
    for (const d of dirs) { const f = path.join(d, id + '.jsonl'); if (fs.existsSync(f)) { candidates.push({ d, f }); break; } }
  }
  const sessions = candidates
    .map(({ d, f }) => {
      const id = path.basename(f, '.jsonl');
      const s = parse(f);
      const need = needs.get(id);
      if (need && s.lastTs > need.ts + 1000) needs.delete(id); // work resumed
      s.needs = needs.get(id)?.msg || '';
      // Finished sessions become compact cards, unless pinned: a pinned session always gets its full card.
      // Claude Code keeps appending untimestamped metadata to idle transcripts, so the file's mtime is not
      // activity: a session counts as recently finished only if its last timestamped line is within the window.
      if (!s.running && !s.needs && !pinned.has(id)) { if (now - s.lastTs > PENDING_MS) return null; recent.push({ ...s, id, file: f, project: path.basename(s.cwd || d), subs: [], contextPct: s.context / contextWindow }); return null; }
      const subs = jsonl(path.join(d, id, 'subagents')).filter((x) => x.m > cutoff)
        .map((x) => {
          const a = parse(x.f);
          if (!a.running) return null;
          const m = meta(x.f);
          return { ...a, file: x.f, id: path.basename(x.f, '.jsonl').replace('agent-', ''), name: m.description || a.prompt.slice(0, 90), type: m.agentType || 'agent', worktree: m.worktreeBranch || '', parentTool: m.toolUseId || '', fork: !!m.isFork };
        })
        .filter(Boolean).sort((a, b) => a.start - b.start).slice(0, 12);
      // Family tree: a subagent's parent is whichever agent made the tool call that spawned it.
      const byTool = new Map();
      for (const t of s.spawned) byTool.set(t, null);
      for (const a of subs) for (const t of a.spawned) byTool.set(t, a);
      for (const a of subs) { const p = byTool.get(a.parentTool); a.parent = p ? p.name || p.id : ''; a.parentId = p ? p.id : ''; }
      const ordered = [];
      const walk = (parentId, depth) => { for (const a of subs.filter((x) => x.parentId === parentId && !ordered.includes(x))) { a.depth = depth; ordered.push(a); walk(a.id, depth + 1); } };
      walk('', 0);
      for (const a of subs) if (!ordered.includes(a)) { a.depth = 0; ordered.push(a); }
      return { ...s, id, file: f, project: path.basename(s.cwd || d), subs: ordered, contextPct: s.context / contextWindow };
    })
    .filter(Boolean).sort((a, b) => a.start - b.start).slice(0, 8);

  // A file edited in the last 30 minutes by more than one running agent is flagged on every side.
  const owners = new Map();
  const agents = sessions.flatMap((s) => [{ key: s.id, files: s.files }, ...s.subs.map((a) => ({ key: s.id + '/' + a.id, files: a.files }))]);
  for (const a of agents) for (const f of a.files) if (now - f.ts < 30 * 60_000) owners.set(f.path, (owners.get(f.path) || new Set()).add(a.key));
  for (const a of agents) for (const f of a.files) f.conflict = (owners.get(f.path)?.size || 0) > 1;
  return { sessions, recent: recent.filter((r) => r.lastTs).sort((a, b) => b.lastTs - a.lastTs).slice(0, 6) };
}

// ---- Week statistics: incremental, async, so the shared extension host is never blocked for long ----

const week = { start: 0, files: new Map() };
const rates = new Map(); // model -> USD per weighted token, learned from cost-state lines

/** Weighted token count of one response's usage (API field names). */
function wtok(u = {}) {
  const cc = u.cache_creation || {};
  const c5 = cc.ephemeral_5m_input_tokens || 0, c1 = cc.ephemeral_1h_input_tokens || 0;
  const write = c5 || c1 ? 1.25 * c5 + 2 * c1 : 1.25 * (u.cache_creation_input_tokens || 0);
  return (u.input_tokens || 0) + 5 * (u.output_tokens || 0) + 0.1 * (u.cache_read_input_tokens || 0) + write;
}

/** Learns $/weighted token per model from a cost-state line's modelUsage. */
function learnRates(modelUsage = {}) {
  for (const [model, m] of Object.entries(modelUsage)) {
    if (!(m?.costUSD > 0)) continue;
    const c5 = m.cacheCreationEphemeral5mInputTokens || 0, c1 = m.cacheCreationEphemeral1hInputTokens || 0;
    const write = c5 || c1 ? 1.25 * c5 + 2 * c1 : 1.25 * (m.cacheCreationInputTokens || 0);
    const w = (m.inputTokens || 0) + 5 * (m.outputTokens || 0) + 0.1 * (m.cacheReadInputTokens || 0) + write;
    if (w > 1000) { const k = model.replace(/\[.*\]$/, ''), arr = rates.get(k) || []; arr.push(m.costUSD / w); if (arr.length > 60) arr.shift(); rates.set(k, arr); }
  }
}
/** Median learned price for a model, so one odd cost record does not skew every estimate. */
const rateOf = (model) => { const a = rates.get(String(model).replace(/\[.*\]$/, '')); if (!a?.length) return 0; const v = [...a].sort((x, y) => x - y); return v[Math.floor(v.length / 2)]; };
const BUCKET_MS = 5 * 60_000;
const FIVE_H = 5 * 3_600_000;
const dayKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** Masks secret-shaped text before an error message is shown or exported. */
const redact = (t) => String(t).replace(/(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+/-]+=*|eyJ[A-Za-z0-9._-]{20,}|\b[A-Fa-f0-9]{32,}\b|\b(?:token|key|secret|password|pwd)=\S+)/gi, '[redacted]');

/** Relative usage weight of one model response (uncached input 1, cache write 1.25, cache read 0.1, output 5). */
const units = (u = {}) => (u.input_tokens || 0) + 1.25 * (u.cache_creation_input_tokens || 0) + 0.1 * (u.cache_read_input_tokens || 0) + 5 * (u.output_tokens || 0);

/** Reads only bytes appended since the last call, whole lines only; a huge file's first read keeps its last 20 MB. */
async function readNew(file, st) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const { size } = await fh.stat();
    if (size < st.offset) st.offset = 0;
    if (size === st.offset) return [];
    const start = Math.max(st.offset, size - 20_000_000);
    if (start > st.offset) st.truncated = true;
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const end = buf.lastIndexOf(0x0a);
    if (end < 0) return [];
    st.offset = start + end + 1;
    return lines(buf.toString('utf8', 0, end));
  } finally { await fh.close(); }
}

const newDay = () => ({ units: 0, estMain: 0, estSub: 0, cacheMiss: 0, missCost: 0, mcp: {}, skills: {}, toolChars: {}, est: 0, active: 0, tools: 0, errors: 0, cost: 0, wait: 0, approvals: 0, denied: 0, commits: 0, think: 0, work: 0, blocked: 0, failMs: 0, greens: 0, bestRun: 0, hits: 0, hours: new Array(24).fill(0), files: new Set() });

async function track(file, project, main) {
  const st = week.files.get(file) || { prevResp: 0, ttl: 300_000, weekHits: [], seenMsg: new Set(), estTotal: 0, recorded: 0, failing: false, testRed: false, run: 0, appr: [], prompts: [], title: '', entrypoint: '', lastTs: 0, offset: 0, project, main, cwd: '', prev: 0, lastCost: 0, truncated: false, days: new Map(), pend: new Map(), usage: new Map(), fails: [], slow: [], hooks: [], hits: [] };
  week.files.set(file, st);
  for (const j of await readNew(file, st)) {
    const ts = j.timestamp ? Date.parse(j.timestamp) : st.prev;
    if (j.cwd) { st.cwd = j.cwd; if (!st.project) st.project = path.basename(j.cwd); }
    if (main) {
      if (j.aiTitle) st.title = j.aiTitle;
      if (j.entrypoint) st.entrypoint = j.entrypoint;
      if (j.timestamp) st.lastTs = Math.max(st.lastTs, ts);
      const pt = promptText(j);
      if (pt) { st.prompts.push({ ts, text: pt.slice(0, 400) }); if (st.prompts.length > 200) st.prompts.shift(); }
    }
    const isCost = main && j.type === 'cost-state' && typeof j.totalCostUSD === 'number';
    if (j.type === 'cost-state') { learnRates(j.modelUsage); if (typeof j.totalCostUSD === 'number') st.recorded = j.totalCostUSD; }
    // A response is written as one line per content block, each repeating the same usage: count it once.
    const mid = j.type === 'assistant' && j.message?.usage ? (j.message.id || j.requestId || '') : '';
    const firstOfMsg = !!mid && !st.seenMsg.has(mid);
    if (firstOfMsg) { st.seenMsg.add(mid); if (st.seenMsg.size > 20000) st.seenMsg.clear(); }
    const usageCost = firstOfMsg && j.message.model && j.message.model !== '<synthetic>' ? wtok(j.message.usage) * rateOf(j.message.model) : 0;
    st.estTotal += usageCost;
    if (!ts || ts < week.start) {
      if (j.timestamp) st.prev = ts;
      if (isCost) st.lastCost = j.totalCostUSD;
      continue;
    }
    const k = dayKey(ts);
    const day = st.days.get(k) || newDay();
    st.days.set(k, day);
    if (j.timestamp) {
      // Agent time between two lines: blocked if the user had to approve the call that just returned,
      // otherwise working or failing (after a failed call, until one succeeds). Long gaps are idle.
      const gap = st.prev ? ts - st.prev : 0;
      if (gap > 0) {
        if (userApproved(j)) day.blocked += Math.min(gap, 2 * 3_600_000);
        else if (gap < IDLE_GAP_MS) { if (st.failing) day.failMs += gap; else day.work += gap; }
        if (main) {
          if (gap < IDLE_GAP_MS) { day.active += gap; day.hours[new Date(ts).getHours()] += gap; st.run += gap; day.bestRun = Math.max(day.bestRun, st.run); }
          else st.run = 0;
        }
      }
      st.prev = ts;
    }
    if (isCost) {
      // totalCostUSD is a running total per session; count the increase. Without a baseline (truncated
      // first read) the first value only sets one, so a huge old session is not billed to today.
      if (st.truncated && !st.lastCost) st.lastCost = j.totalCostUSD;
      else day.cost += j.totalCostUSD >= st.lastCost ? j.totalCostUSD - st.lastCost : j.totalCostUSD;
      st.lastCost = j.totalCostUSD;
    }
    day.est += usageCost;
    if (main) day.estMain += usageCost; else day.estSub += usageCost;
    if (firstOfMsg && j.message.model !== '<synthetic>') {
      const u = j.message.usage, cc = u.cache_creation || {};
      if ((cc.ephemeral_1h_input_tokens || 0) > 0) st.ttl = 3_600_000;
      const w = u.cache_creation_input_tokens || 0, all = w + (u.cache_read_input_tokens || 0) + (u.input_tokens || 0);
      // A cache miss: most of the prompt had to be written to the cache again. Writes cost 1.25x input, reads 0.1x.
      if (st.prevResp && all > 20_000 && w > all * 0.5) { day.cacheMiss++; day.missCost += 1.15 * w * rateOf(j.message.model); }
      st.prevResp = ts;
      day.units += units(u);
    }
    if (j.type === 'assistant' && j.thinkingDurationMs > 0) day.think += j.thinkingDurationMs;
    if (firstOfMsg && j.message.model && j.message.model !== '<synthetic>') {
      const b = Math.floor(ts / BUCKET_MS);
      st.usage.set(b, (st.usage.get(b) || 0) + units(j.message.usage));
    }
    // A usage-limit hit: the rejection record, or the notice Claude Code shows.
    const q = j.quotaLimits;
    if ((q && q.status === 'rejected' && q.rateLimitType === 'five_hour') || (j.isApiErrorMessage && /5-hour limit/i.test(textOf(j.message?.content)))) st.hits.push(ts);
    if ((q && q.status === 'rejected' && q.rateLimitType === 'seven_day') || (j.isApiErrorMessage && /weekly limit/i.test(textOf(j.message?.content)))) st.weekHits.push(ts);
    if (Array.isArray(j.hookErrors) && j.hookErrors.length)
      for (const e of j.hookErrors) st.hooks.push({ ts, project: st.project, text: redact(typeof e === 'string' ? e : JSON.stringify(e)).slice(0, 300) });
    if (j.toolDenialKind) day.denied++;
    for (const p of Array.isArray(j.message?.content) ? j.message.content : []) {
      if (p.type === 'tool_use') {
        day.tools++;
        const cmd = p.name === 'Bash' && typeof p.input?.command === 'string' ? p.input.command : '';
        st.pend.set(p.id, { name: p.name, ts, cmd, url: typeof p.input?.url === 'string' ? p.input.url : '', skill: typeof p.input?.skill === 'string' ? p.input.skill : '', ...describe(p.input) });
        if (FILE_TOOLS.has(p.name) && typeof (p.input?.file_path || p.input?.notebook_path) === 'string') day.files.add(p.input.file_path || p.input.notebook_path);
      } else if (p.type === 'tool_result') {
        const t = st.pend.get(p.tool_use_id);
        st.pend.delete(p.tool_use_id);
        if (p.is_error) day.errors++;
        st.failing = !!p.is_error;
        if (!t) continue;
        {
          // Result size: a tool result is re-sent to the model on every later step, so big results cost repeatedly.
          const chars = typeof p.content === 'string' ? p.content.length : Array.isArray(p.content) ? p.content.reduce((a, c) => a + (c.text ? c.text.length : 0), 0) : 0;
          day.toolChars[t.name] = (day.toolChars[t.name] || 0) + chars;
          if (t.name.startsWith('mcp__')) { const srv = t.name.split('__')[1] || 'mcp'; const m = day.mcp[srv] || (day.mcp[srv] = { calls: 0, chars: 0 }); m.calls++; m.chars += chars; }
          if (t.name === 'Skill' && t.skill) { const k = day.skills[t.skill] || (day.skills[t.skill] = { calls: 0, chars: 0 }); k.calls++; k.chars += chars; }
        }
        const ms = ts - t.ts;
        const pd = j.permissionDecision;
        if (pd && String(pd.source || '').startsWith('user')) {
          day.approvals++; if (ms > 0) day.wait += ms;
          st.appr.push({ ts, name: t.name, cmd: t.cmd.slice(0, 300), url: t.url, cwd: st.cwd, project: st.project, wait: Math.max(0, ms) });
          if (st.appr.length > 300) st.appr.shift();
        }
        if (TEST_RE.test(t.cmd)) { if (p.is_error) st.testRed = true; else if (st.testRed) { day.greens++; st.testRed = false; } }
        if (!p.is_error && COMMIT_RE.test(t.cmd) && !/--dry-run/.test(t.cmd)) day.commits++;
        // Subagent runs (Agent/Task) are not tools, and an approval wait is not tool time.
        if (ms > 1000 && t.name !== 'Agent' && t.name !== 'Task' && !(pd && String(pd.source || '').startsWith('user'))) {
          st.slow.push({ ts, ms, name: t.name, hint: t.hint, project: st.project });
          if (st.slow.length > 40) { st.slow.sort((a, b) => b.ms - a.ms); st.slow.length = 20; }
        }
        if (p.is_error) {
          const body = typeof p.content === 'string' ? p.content : Array.isArray(p.content) ? p.content.map((c) => c.text || '').join(' ') : '';
          st.fails.push({ ts, name: t.name, hint: t.hint, cmd: t.cmd.split(/\s+/).slice(0, 2).join(' '), project: st.project, text: redact(body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 240) });
          if (st.fails.length > 60) st.fails.splice(0, st.fails.length - 60);
        }
      }
    }
  }
  return st;
}

/** Usage in the last 5 hours and last hour, and a limit estimate from past 5-hour-limit hits. */
function forecast() {
  const all = new Map();
  for (const st of week.files.values()) for (const [b, u] of st.usage) all.set(b, (all.get(b) || 0) + u);
  const sum = (from, to) => { let n = 0; for (const [b, u] of all) { const t = b * BUCKET_MS; if (t >= from && t < to) n += u; } return n; };
  const hits = [...week.files.values()].flatMap((st) => st.hits).sort((a, b) => a - b);
  const firsts = hits.filter((t, i) => i === 0 || t - hits[i - 1] > 30 * 60_000); // one per limit episode
  const caps = firsts.map((t) => sum(t - FIVE_H, t)).filter((n) => n > 0).sort((a, b) => a - b);
  const now = Date.now();
  const used = sum(now - FIVE_H, now + 1), lastHour = sum(now - 3_600_000, now + 1);
  const cap = caps.length ? caps[Math.floor(caps.length / 2)] : 0;
  const etaMs = cap && lastHour > 0 && used < cap ? ((cap - used) / lastHour) * 3_600_000 : 0;
  const series = Array.from({ length: 30 }, (_, i) => sum(now - (30 - i) * 10 * 60_000, now - (29 - i) * 10 * 60_000)); // last 5 h in 10-min steps
  // The 5-hour window: it opens with the first use after the previous one closed. Walk forward to now.
  const buckets = [...all.keys()].filter((b) => all.get(b) > 0).map((b) => b * BUCKET_MS).sort((a, b) => a - b).filter((t) => t > now - 2 * FIVE_H);
  let wStart = 0;
  for (const t of buckets) if (!wStart || t >= wStart + FIVE_H) wStart = t;
  const open = wStart && now < wStart + FIVE_H;
  let pace = null;
  if (open) {
    const inWin = sum(wStart, now + 1);
    const points = [];
    for (let t = wStart, cum = 0; t <= now; t += 10 * 60_000) { cum += sum(t, Math.min(t + 10 * 60_000, now + 1)); points.push([t - wStart, cum]); }
    const hitIn = cap && lastHour > 0 ? ((cap - inWin) / lastHour) * 3_600_000 : 0;
    pace = { start: wStart, end: wStart + FIVE_H, used: inWin, points, even: cap ? (cap * (now - wStart)) / FIVE_H : 0, hitAt: hitIn > 0 && now + hitIn < wStart + FIVE_H ? now + hitIn : 0 };
  }
  return { used, lastHour, cap, samples: caps.length, pct: cap ? used / cap : 0, etaMs, past: cap > 0 && used >= cap, series, lastHit: firsts.at(-1) || 0, firsts, pace };
}

/** Last 7 days of activity plus today's waits, failures, slow calls, hook errors and the usage forecast. */
async function stats() {
  const d0 = new Date(); d0.setHours(0, 0, 0, 0); d0.setDate(d0.getDate() - 13);
  if (week.start !== d0.getTime()) { week.start = d0.getTime(); week.files.clear(); }
  let dirs = [];
  try { dirs = (await fs.promises.readdir(ROOT)).map((d) => path.join(ROOT, d)); } catch { return null; }
  for (const d of dirs) {
    for (const { f } of jsonl(d).filter((x) => x.m >= week.start)) {
      const st = await track(f, '', true);
      for (const x of jsonl(path.join(d, path.basename(f, '.jsonl'), 'subagents')).filter((x) => x.m >= week.start))
        await track(x.f, st.project || path.basename(d), false);
      await new Promise((r) => setImmediate(r));
    }
  }
  const keys = Array.from({ length: 14 }, (_, i) => { const d = new Date(week.start); d.setDate(d.getDate() + i); return d; });
  const days = keys.map((d) => ({ key: dayKey(d.getTime()), label: d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' }), ...newDay(), mcp: {}, skills: {}, toolChars: {}, files: 0 }));
  const idx = new Map(days.map((d, i) => [d.key, i]));
  const todayKey = days[days.length - 1].key;
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const by = new Map();
  const files = [...week.files.values()];
  for (const st of files) {
    for (const [k, v] of st.days) {
      const d = days[idx.get(k)];
      if (!d) continue;
      for (const f of ['units', 'estMain', 'estSub', 'cacheMiss', 'missCost', 'est', 'active', 'tools', 'errors', 'cost', 'wait', 'approvals', 'denied', 'commits', 'think', 'work', 'blocked', 'failMs', 'greens']) d[f] += v[f];
      for (const [k, m] of Object.entries(v.mcp)) { const x = d.mcp[k] || (d.mcp[k] = { calls: 0, chars: 0 }); x.calls += m.calls; x.chars += m.chars; }
      for (const [k, m] of Object.entries(v.skills)) { const x = d.skills[k] || (d.skills[k] = { calls: 0, chars: 0 }); x.calls += m.calls; x.chars += m.chars; }
      for (const [k, c] of Object.entries(v.toolChars)) d.toolChars[k] = (d.toolChars[k] || 0) + c;
      d.bestRun = Math.max(d.bestRun, v.bestRun);
      d.files += v.files.size;
      v.hours.forEach((ms, h) => { d.hours[h] += ms; });
      if (k !== todayKey) continue;
      const p = st.project || 'unknown';
      const t = by.get(p) || { project: p, sessions: 0, active: 0, tools: 0, errors: 0, cost: 0, est: 0, commits: 0, wait: 0, files: new Set() };
      if (st.main) t.sessions++;
      for (const f of ['active', 'tools', 'errors', 'cost', 'est', 'commits', 'wait']) t[f] += v[f];
      v.files.forEach((x) => t.files.add(x));
      by.set(p, t);
    }
  }
  const today = [...by.values()].sort((a, b) => b.active - a.active).map((t) => ({ ...t, files: [...t.files].slice(0, 40), fileCount: t.files.size }));

  // Failures in the last 7 days, grouped by tool and command so a recurring one stands out.
  const groups = new Map();
  for (const f of files.flatMap((st) => st.fails)) {
    const key = f.name + ' ' + (f.cmd || f.hint.slice(0, 40));
    const g = groups.get(key) || { key, name: f.name, label: f.cmd || f.hint, count: 0, last: 0, text: '', projects: new Set() };
    g.count++; g.projects.add(f.project);
    if (f.ts > g.last) { g.last = f.ts; g.text = f.text; }
    groups.set(key, g);
  }
  const failures = [...groups.values()].sort((a, b) => b.count - a.count || b.last - a.last).slice(0, 25).map((g) => ({ ...g, projects: [...g.projects] }));
  const slow = files.flatMap((st) => st.slow).sort((a, b) => b.ms - a.ms);
  const hooks = files.flatMap((st) => st.hooks).filter((h) => h.ts > Date.now() - 86_400_000).sort((a, b) => b.ts - a.ts).slice(0, 20);
  const cwds = [...new Set(files.map((st) => st.cwd).filter(Boolean))];
  const fc = forecast();
  for (const t of fc.firsts) { const d = days[idx.get(dayKey(t))]; if (d) d.hits++; }
  // Sessions active today with their estimated cost (main transcript + all its subagents).
  const midnightTs = midnight.getTime();
  const sessionsToday = [];
  for (const [file, st] of week.files) {
    if (!st.main || st.lastTs < midnightTs) continue;
    const subDir = file.replace(/\.jsonl$/, '') + path.sep + 'subagents' + path.sep;
    let subs = 0, subEst = 0, subToday = 0;
    for (const [f2, s2] of week.files) if (f2.startsWith(subDir)) { subs++; subEst += s2.estTotal; subToday += s2.days.get(todayKey)?.est || 0; }
    const t = st.days.get(todayKey);
    const said = st.prompts.find((p2) => p2.text.length >= 15) || st.prompts[st.prompts.length - 1];
    sessionsToday.push({ id: path.basename(file, '.jsonl'), title: st.title || said?.text || 'Untitled session', project: st.project, cwd: st.cwd, entrypoint: st.entrypoint,
      lastTs: st.lastTs, active: t ? t.active : 0, est: (t?.est || 0) + subToday, lifetime: st.estTotal + subEst, subs, recorded: st.recorded, partial: st.truncated });
  }
  sessionsToday.sort((a, b) => b.est - a.est);
  const weekHits = files.flatMap((st) => st.weekHits).sort((a, b) => a - b).filter((t, i, a) => i === 0 || t - a[i - 1] > 6 * 3_600_000);
  const approvals = files.flatMap((st) => st.appr).filter((a) => a.ts >= Date.now() - 7 * 86_400_000);
  return {
    days, today, failures, hooks, cwds, approvals, weekHits, forecast: fc, sessionsToday,
    slowToday: slow.filter((x) => x.ts >= midnight.getTime()).slice(0, 10),
    slowWeek: slow.slice(0, 10),
  };
}

/** Sessions from the last 7 days whose title, project or prompts contain every word of `q`. */
function search(q) {
  const words = String(q).toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  if (!words.length) return [];
  const out = [];
  for (const [file, st] of week.files) {
    if (!st.main || !st.lastTs) continue;
    const hay = [st.title, st.project, ...st.prompts.map((p) => p.text)].join('\n').toLowerCase();
    if (!words.every((w) => hay.includes(w))) continue;
    const hit = [...st.prompts].reverse().find((p) => words.some((w) => p.text.toLowerCase().includes(w)));
    out.push({ id: path.basename(file, '.jsonl'), title: st.title || st.prompts[0]?.text || 'Untitled session', project: st.project, cwd: st.cwd, entrypoint: st.entrypoint, lastTs: st.lastTs, snippet: hit ? hit.text.slice(0, 160) : '' });
  }
  return out.sort((a, b) => b.lastTs - a.lastTs).slice(0, 20);
}

const clip = (v, n) => { const t = typeof v === 'string' ? v : JSON.stringify(v, null, 2); return redact(t.length > n ? t.slice(0, n) + '\n…' : t); };

/** One tool call's input and result, read from the end of its transcript. */
function detail(file, toolId) {
  const { size } = fs.statSync(file);
  const len = Math.min(4_000_000, size);
  let call = null;
  for (const j of lines(readRange(file, size - len, len))) {
    for (const p of Array.isArray(j.message?.content) ? j.message.content : []) {
      if (p.type === 'tool_use' && p.id === toolId) call = { name: p.name, input: clip(p.input ?? {}, 4000), ts: Date.parse(j.timestamp) || 0, ok: null, ms: 0, output: '' };
      else if (call && p.type === 'tool_result' && p.tool_use_id === toolId) {
        const body = typeof p.content === 'string' ? p.content : Array.isArray(p.content) ? p.content.map((c) => c.text || (c.type === 'image' ? '[image]' : '')).join('\n') : '';
        call.ok = !p.is_error;
        call.ms = (Date.parse(j.timestamp) || call.ts) - call.ts;
        call.output = clip(body, 6000);
      }
    }
  }
  return call;
}

/** Estimated cost of a session (its transcript plus every subagent under it), from what the index has read. */
function sessionCost(file) {
  const st = week.files.get(file);
  if (!st) return null;
  const subDir = file.replace(/\.jsonl$/, '') + path.sep + 'subagents' + path.sep;
  let est = st.estTotal, subs = 0;
  for (const [f2, s2] of week.files) if (f2.startsWith(subDir)) { est += s2.estTotal; subs++; }
  return { est, recorded: st.recorded, subs, partial: st.truncated };
}

const listCache = new Map(); // file -> { size, info }

/** One-line facts about a session, read from the start and end of its transcript; cached until it grows. */
function sessionInfo(file) {
  const { size, mtimeMs } = fs.statSync(file);
  const hit = listCache.get(file);
  if (hit && hit.size === size) return hit.info;
  let cwd = '', start = 0, first = '', firstGood = '', entrypoint = '', branch = '', title = '';
  for (const j of lines(readRange(file, 0, Math.min(size, 131_072)))) {
    if (!start && j.timestamp) start = Date.parse(j.timestamp);
    if (!cwd && j.cwd) cwd = j.cwd;
    if (!entrypoint && j.entrypoint) entrypoint = j.entrypoint;
    if (!branch && j.gitBranch && j.gitBranch !== 'HEAD') branch = j.gitBranch;
    if (j.aiTitle) title = j.aiTitle;
    const t = userText(j);
    if (t && !t.startsWith('[Request interrupted')) { if (!first) first = t; if (!firstGood && t.length >= 15) firstGood = t; }
  }
  let lastPrompt = '', lastTs = 0;
  const len = Math.min(size, 262_144);
  let tail = readRange(file, size - len, len);
  if (len < size) tail = tail.slice(tail.indexOf('\n') + 1);
  for (const j of lines(tail)) {
    if (j.aiTitle) title = j.aiTitle;
    if (!cwd && j.cwd) cwd = j.cwd;
    if (j.timestamp) lastTs = Math.max(lastTs, Date.parse(j.timestamp) || 0);
    const t = userText(j);
    if (t && !t.startsWith('[Request interrupted')) lastPrompt = t;
  }
  let subs = 0;
  try { subs = fs.readdirSync(file.replace(/\.jsonl$/, '') + path.sep + 'subagents').filter((f) => f.endsWith('.jsonl')).length; } catch { /* none */ }
  const info = {
    // Without a recorded folder, tidy the encoded folder name: '-Users-me-Desktop-acme-api' -> 'acme-api'.
    id: path.basename(file, '.jsonl'), project: cwd ? path.basename(cwd) : path.basename(path.dirname(file)).replace(/^-Users-[^-]+-/, '').replace(/^Desktop-/, '') || 'unknown', cwd, entrypoint, branch,
    start, lastTs: lastTs || mtimeMs, title: title || firstGood || first || 'Untitled session',
    firstPrompt: (firstGood || first).slice(0, 200), lastPrompt: lastPrompt.slice(0, 200), sizeMb: size / 1e6, subs,
  };
  listCache.set(file, { size, info });
  return info;
}

/** Every session on this machine, newest first, with an estimated cost where one is known. */
async function listSessions(knownCosts = new Map()) {
  let dirs = [];
  try { dirs = fs.readdirSync(ROOT).map((d) => path.join(ROOT, d)); } catch { return []; }
  const out = [];
  let n = 0;
  for (const d of dirs) {
    for (const { f } of jsonl(d)) {
      try {
        const info = sessionInfo(f);
        const c = sessionCost(f);
        out.push({ ...info, est: knownCosts.has(info.id) ? knownCosts.get(info.id) : c ? c.est : null, estPartial: c ? c.partial : false });
      } catch { /* unreadable transcript: skip it */ }
      if (++n % 10 === 0) await new Promise((r) => setImmediate(r));
    }
  }
  return out.sort((a, b) => b.lastTs - a.lastTs);
}

module.exports = { listSessionInfo: sessionInfo, dayKey, listSessions, EVENTS, ROOT, snapshot, stats, search, detail, sessionCost, lines, readRange, wtok, rateOf, learnRates, promptText, userText, describe, redact, meta, COMMIT_RE, TEST_RE, FILE_TOOLS, userApproved, textOf };
