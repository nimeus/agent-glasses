// Full analysis of one session: streams its whole transcript and every subagent transcript, line by line,
// so even a 50 MB file never sits in memory at once. Results are cached until the file grows.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const data = require('./data');

const IDLE_GAP_MS = 5 * 60_000;
const cache = new Map(); // file -> { size, result }

async function eachLine(file, fn) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  let n = 0;
  for await (const l of rl) {
    if (!l) continue;
    let j;
    try { j = JSON.parse(l); } catch { continue; }
    fn(j);
    if (++n % 2000 === 0) await new Promise((r) => setImmediate(r)); // keep the shared extension host responsive
  }
}

const bodyText = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text || (x.type === 'image' ? '[image]' : '')).join(' ') : '';

/** One transcript → totals, per-model and per-tool figures, turns (when asked), errors and a cost timeline. */
async function analyzeFile(file, withTurns) {
  const r = {
    start: 0, end: 0, active: 0, title: '', branch: '', cwd: '', entrypoint: '', recorded: 0,
    cost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, models: {}, tools: {},
    approvals: 0, wait: 0, denied: 0, commits: 0, greens: 0, think: 0, compactions: [], files: {}, errors: [], slow: [],
    points: [], turns: [], spawns: {}, calls: 0, failed: 0,
    version: '', modes: {}, effort: '', branches: {}, mcp: {}, skills: {}, webSearches: 0, webFetches: 0,
    interrupts: 0, apiErrors: 0, retries: 0, limitHits: 0, images: 0, queued: 0, ctxPeak: 0, ctxLast: 0,
  };
  const seen = new Set();
  const pend = new Map();
  let prev = 0, turn = null, testRed = false, prevResp = 0, ttl = 300_000;
  r.cacheMisses = []; r.missCost = 0; r.cacheReadTok = 0;
  const turnFor = (j, ts) => {
    if (!withTurns) return null;
    if (j.promptId && (!turn || turn.id !== j.promptId)) {
      turn = r.turns.find((t) => t.id === j.promptId) || null;
      if (!turn) { turn = { id: j.promptId, ts, end: ts, text: '', tools: 0, failed: 0, cost: 0, output: 0, subagents: 0, subCost: 0 }; r.turns.push(turn); }
    }
    return turn;
  };

  await eachLine(file, (j) => {
    const ts = j.timestamp ? Date.parse(j.timestamp) : 0;
    if (ts) { if (!r.start) r.start = ts; r.end = Math.max(r.end, ts); if (prev && ts - prev < IDLE_GAP_MS && ts > prev) r.active += ts - prev; prev = ts; }
    if (j.aiTitle) r.title = j.aiTitle;
    if (j.gitBranch && j.gitBranch !== 'HEAD') r.branch = j.gitBranch;
    if (j.cwd) r.cwd = j.cwd;
    if (j.entrypoint) r.entrypoint = j.entrypoint;
    if (j.type === 'cost-state') { data.learnRates(j.modelUsage); if (typeof j.totalCostUSD === 'number') r.recorded = j.totalCostUSD; }
    if (j.subtype === 'compact_boundary' && j.compactMetadata) r.compactions.push({ ts, trigger: j.compactMetadata.trigger || '', pre: j.compactMetadata.preTokens || 0, post: j.compactMetadata.postTokens || 0 });
    if (j.toolDenialKind) r.denied++;
    if (j.version) r.version = j.version;
    if (j.permissionMode) r.modes[j.permissionMode] = (r.modes[j.permissionMode] || 0) + 1;
    if (typeof j.effort === 'string') r.effort = j.effort;
    if (j.gitBranch && j.gitBranch !== 'HEAD') r.branches[j.gitBranch] = 1;
    if (j.isApiErrorMessage) { r.apiErrors++; if (/limit/i.test(data.textOf(j.message?.content))) r.limitHits++; }
    if (typeof j.retryAttempt === 'number' && j.retryAttempt > 0) r.retries++;
    // Messages typed while Claude was working (system notifications are queued too, as <tagged> text).
    if (j.type === 'queue-operation' && j.operation === 'enqueue' && typeof j.content === 'string' && !j.content.trim().startsWith('<')) r.queued++;
    if (j.type === 'user' && Array.isArray(j.message?.content)) for (const c of j.message.content) if (c.type === 'image') r.images++;
    const t = turnFor(j, ts);
    if (t && ts) t.end = Math.max(t.end, ts);
    const pt = data.userText(j);
    if (pt && pt.startsWith('[Request interrupted')) r.interrupts++;
    if (t && pt && !t.text && !pt.startsWith('[Request interrupted')) t.text = pt.slice(0, 600);

    const msg = j.message;
    if (j.type === 'assistant' && j.thinkingDurationMs > 0) r.think += j.thinkingDurationMs;
    if (j.type === 'assistant' && msg?.usage && msg.model && msg.model !== '<synthetic>') {
      const id = msg.id || j.requestId || '';
      if (id && !seen.has(id)) {
        seen.add(id);
        const u = msg.usage, cc = u.cache_creation || {};
        const write = (cc.ephemeral_5m_input_tokens || 0) + (cc.ephemeral_1h_input_tokens || 0) || (u.cache_creation_input_tokens || 0);
        const cost = data.wtok(u) * data.rateOf(msg.model);
        const m = r.models[msg.model] || (r.models[msg.model] = { calls: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
        m.calls++; m.cost += cost; m.input += u.input_tokens || 0; m.output += u.output_tokens || 0; m.cacheRead += u.cache_read_input_tokens || 0; m.cacheWrite += write;
        r.tokens.input += u.input_tokens || 0; r.tokens.output += u.output_tokens || 0; r.tokens.cacheRead += u.cache_read_input_tokens || 0; r.tokens.cacheWrite += write;
        r.cost += cost;
        const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + write;
        if ((cc.ephemeral_1h_input_tokens || 0) > 0) ttl = 3_600_000;
        // A miss: most of the prompt was written to the cache again (writes 1.25x input, reads 0.1x).
        if (prevResp && ctx > 20_000 && write > ctx * 0.5) {
          const gap = ts - prevResp, extra = 1.15 * write * data.rateOf(msg.model);
          r.missCost += extra;
          r.cacheMisses.push({ ts, tokens: write, gap, cause: gap > ttl ? 'break' : 'changed', cost: extra });
          if (r.cacheMisses.length > 60) r.cacheMisses.shift();
        }
        if (ts) prevResp = ts;
        r.ctxPeak = Math.max(r.ctxPeak, ctx); r.ctxLast = ctx;
        r.webSearches += u.server_tool_use?.web_search_requests || 0; r.webFetches += u.server_tool_use?.web_fetch_requests || 0;
        if (ts) r.points.push([ts, cost]);
        if (t) { t.cost += cost; t.output += u.output_tokens || 0; }
      }
    }
    if (!Array.isArray(msg?.content)) return;
    for (const p of msg.content) {
      if (j.type === 'assistant' && p.type === 'tool_use') {
        r.calls++;
        const d = data.describe(p.input);
        const cmd = p.name === 'Bash' && typeof p.input?.command === 'string' ? p.input.command : '';
        pend.set(p.id, { name: p.name, ts, hint: d.hint, cmd, turn: t });
        const tool = r.tools[p.name] || (r.tools[p.name] = { calls: 0, failed: 0, ms: 0 });
        tool.calls++;
        if (t) t.tools++;
        if (data.FILE_TOOLS.has(p.name) && d.file) r.files[d.file] = (r.files[d.file] || 0) + 1;
        if (p.name === 'Agent' || p.name === 'Task') r.spawns[p.id] = t ? t.id : '';
        if (p.name.startsWith('mcp__')) { const srv = p.name.split('__')[1] || 'mcp'; r.mcp[srv] = (r.mcp[srv] || 0) + 1; }
        if (p.name === 'Skill' && typeof p.input?.skill === 'string') r.skills[p.input.skill] = (r.skills[p.input.skill] || 0) + 1;
      } else if (p.type === 'tool_result') {
        const c = pend.get(p.tool_use_id);
        pend.delete(p.tool_use_id);
        if (!c) continue;
        const ms = ts && c.ts ? Math.max(0, ts - c.ts) : 0;
        const tool = r.tools[c.name];
        const approved = data.userApproved(j);
        if (approved) { r.approvals++; r.wait += ms; }
        if (tool && !approved) tool.ms += ms;
        if (p.is_error) {
          r.failed++; if (tool) tool.failed++; if (c.turn) c.turn.failed++;
          r.errors.push({ ts, name: c.name, hint: c.hint, text: data.redact(bodyText(p.content).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 300) });
          if (r.errors.length > 40) r.errors.shift();
        } else if (data.COMMIT_RE.test(c.cmd) && !/--dry-run/.test(c.cmd)) r.commits++;
        if (data.TEST_RE.test(c.cmd)) { if (p.is_error) testRed = true; else if (testRed) { r.greens++; testRed = false; } }
        if (ms > 1000 && !approved && c.name !== 'Agent' && c.name !== 'Task') { r.slow.push({ ms, name: c.name, hint: c.hint, ts: c.ts }); if (r.slow.length > 30) { r.slow.sort((a, b) => b.ms - a.ms); r.slow.length = 12; } }
      }
    }
  });
  r.slow.sort((a, b) => b.ms - a.ms); r.slow.length = Math.min(r.slow.length, 10);
  return r;
}

/** Spreads cost over at most `n` buckets between start and end, for a bar chart. */
function timeline(points, start, end, n = 40) {
  const span = Math.max(60_000, end - start), size = Math.max(60_000, Math.ceil(span / n / 60_000) * 60_000);
  const count = Math.max(1, Math.ceil(span / size));
  const bins = new Array(count).fill(0);
  for (const [ts, c] of points) bins[Math.min(count - 1, Math.floor((ts - start) / size))] += c;
  return { size, bins };
}

/** Everything about one session: the main transcript plus each subagent, cached until a file grows. */
async function analyze(file) {
  const subDir = file.replace(/\.jsonl$/, '') + path.sep + 'subagents';
  let subFiles = [];
  try { subFiles = fs.readdirSync(subDir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(subDir, f)); } catch { /* none */ }
  const sizeKey = [file, ...subFiles].map((f) => { try { return fs.statSync(f).size; } catch { return 0; } }).join(',');
  const hit = cache.get(file);
  if (hit && hit.key === sizeKey) return hit.result;

  const main = await analyzeFile(file, true);
  const subs = [];
  for (const f of subFiles) {
    const a = await analyzeFile(f, false);
    const m = data.meta(f);
    subs.push({ id: path.basename(f, '.jsonl').replace('agent-', ''), type: m.agentType || 'agent', name: m.description || '', fork: !!m.isFork, worktree: m.worktreeBranch || '',
      start: a.start, end: a.end, active: a.active, calls: a.calls, failed: a.failed, cost: a.cost, tokens: a.tokens, models: a.models, tools: a.tools, toolUseId: m.toolUseId || '' });
    // Subagent cost belongs to the turn that started it.
    const turnId = main.spawns[m.toolUseId];
    const t = turnId && main.turns.find((x) => x.id === turnId);
    if (t) { t.subagents++; t.subCost += a.cost; }
    for (const [ts, c] of a.points) main.points.push([ts, c]);
    for (const [name, v] of Object.entries(a.tools)) { const tl = main.tools[name] || (main.tools[name] = { calls: 0, failed: 0, ms: 0 }); tl.calls += v.calls; tl.failed += v.failed; tl.ms += v.ms; }
    for (const [model, v] of Object.entries(a.models)) { const mm = main.models[model] || (main.models[model] = { calls: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }); for (const k of Object.keys(mm)) mm[k] += v[k]; }
    for (const k of Object.keys(main.tokens)) main.tokens[k] += a.tokens[k];
    for (const [k, v] of Object.entries(a.mcp)) main.mcp[k] = (main.mcp[k] || 0) + v;
    for (const [k, v] of Object.entries(a.skills)) main.skills[k] = (main.skills[k] || 0) + v;
    main.webSearches += a.webSearches; main.webFetches += a.webFetches; main.apiErrors += a.apiErrors; main.retries += a.retries; main.limitHits += a.limitHits;
    main.missCost += a.missCost;
    main.commits += a.commits; main.greens += a.greens; main.think += a.think; main.approvals += a.approvals; main.wait += a.wait; main.denied += a.denied;
    for (const [fp, n] of Object.entries(a.files)) main.files[fp] = (main.files[fp] || 0) + n;
    main.errors.push(...a.errors.map((e) => ({ ...e, agent: m.description || 'subagent' })));
    main.slow.push(...a.slow.map((x) => ({ ...x, agent: m.description || 'subagent' })));
  }
  const subCost = subs.reduce((s, a) => s + a.cost, 0);
  const id = path.basename(file, '.jsonl');
  const prompts = main.turns.filter((t) => t.text);
  const result = {
    id, file, title: main.title || prompts.find((t) => t.text.length >= 15)?.text.slice(0, 120) || prompts[0]?.text.slice(0, 120) || 'Untitled session',
    project: path.basename(main.cwd || path.dirname(file)), cwd: main.cwd, branch: main.branch, entrypoint: main.entrypoint,
    start: main.start, end: main.end, active: main.active, recorded: main.recorded,
    cost: main.cost + subCost, mainCost: main.cost, subCost, tokens: main.tokens,
    models: Object.entries(main.models).map(([model, v]) => ({ model: model.replace(/^claude-/, ''), ...v })).sort((a, b) => b.cost - a.cost),
    tools: Object.entries(main.tools).map(([name, v]) => ({ name, ...v })).sort((a, b) => b.calls - a.calls),
    calls: main.calls + subs.reduce((s, a) => s + a.calls, 0), failed: main.failed + subs.reduce((s, a) => s + a.failed, 0),
    approvals: main.approvals, wait: main.wait, denied: main.denied, commits: main.commits, greens: main.greens, think: main.think,
    compactions: main.compactions, files: Object.entries(main.files).map(([p, n]) => ({ path: p, name: path.basename(p), n })).sort((a, b) => b.n - a.n).slice(0, 30), fileCount: Object.keys(main.files).length,
    errors: main.errors.sort((a, b) => b.ts - a.ts).slice(0, 20), slow: main.slow.sort((a, b) => b.ms - a.ms).slice(0, 10),
    turns: main.turns.filter((t) => t.text || t.tools || t.cost).map((t) => ({ ...t, total: t.cost + t.subCost, dur: t.end - t.ts })),
    subagents: subs.sort((a, b) => b.cost - a.cost),
    timeline: timeline(main.points, main.start, Math.max(main.end, ...subs.map((a) => a.end || 0))),
    version: main.version, modes: Object.keys(main.modes), effort: main.effort, branches: Object.keys(main.branches),
    mcp: Object.entries(main.mcp).map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n),
    skills: Object.entries(main.skills).map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n),
    webSearches: main.webSearches, webFetches: main.webFetches, interrupts: main.interrupts, apiErrors: main.apiErrors, retries: main.retries, limitHits: main.limitHits,
    images: main.images, queued: main.queued, ctxPeak: main.ctxPeak, ctxLast: main.ctxLast,
    cacheMisses: main.cacheMisses.slice(-20).reverse(), missCount: main.cacheMisses.length, missCost: main.missCost,
    subTypes: Object.entries(subs.reduce((m, a) => { m[a.type] = (m[a.type] || 0) + 1; return m; }, {})).map(([type, n]) => ({ type, n })),
    partial: false, analyzedAt: Date.now(),
  };
  cache.set(file, { key: sizeKey, result });
  return result;
}

/** Finds a session transcript by id under ~/.claude/projects. */
function locate(id) {
  if (!/^[\w-]{8,64}$/.test(id)) return null;
  try {
    for (const d of fs.readdirSync(data.ROOT)) { const f = path.join(data.ROOT, d, id + '.jsonl'); if (fs.existsSync(f)) return f; }
  } catch { /* none */ }
  return null;
}

module.exports = { analyze, locate };
