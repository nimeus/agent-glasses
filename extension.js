// Agent Glasses — extension host: polls Claude Code transcripts, feeds the sidebar view and the editor panel,
// raises alerts. Everything it reads is local and read-only, except the Notification-hook log it trims.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const data = require('./lib/data');
const { machine } = require('./lib/system');
const worktrees = require('./lib/worktrees');
const insights = require('./lib/insights');
const sessionInsight = require('./lib/session-insight');
const archive = require('./lib/archive');
const search = require('./lib/search');
const exporter = require('./lib/export');
const git = require('./lib/git');
const phone = require('./lib/phone');

const WIN = process.platform === 'win32';
/** Paths compare case-insensitively on Windows (drive letters, folders). */
const norm = (p) => { const n = path.normalize(String(p || '')); return WIN ? n.toLowerCase() : n; };
/** True when `cwd` is inside one of this window's workspace folders. */
const inThisWindow = (cwd) => (vscode.workspace.workspaceFolders || []).some((f) => { const a = norm(cwd), b = norm(f.uri.fsPath); return a === b || a.startsWith(b + path.sep); });

/** POSIX single-quoting: safe to paste into a shell whatever the text contains. */
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const ID_RE = /^[\w-]{8,64}$/;
/** `cd <dir> && claude --resume <id>`, or null when the id is not a plain session id. */
/** PowerShell single-quoting (a quote is doubled). */
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;
/** `cd <dir> && claude --resume <id>` for the platform's default shell, or null when the id is not a plain session id. */
const resumeCommand = (cwd, id) => (!ID_RE.test(id) ? null : WIN ? (cwd ? `cd ${psq(cwd)}; ` : '') + `claude --resume ${id}` : (cwd ? `cd ${shq(cwd)} && ` : '') + `claude --resume ${id}`);

/**
 * Reveals a session. One started in this window's VS Code extension opens (or focuses) its Claude tab via
 * the extension's own command. Anything else only brings its folder's window to the front: resuming a
 * terminal session here would run a second process on the same transcript, and opening the current
 * folder again reloads the window, restarting Claude Code.
 */
function showSession(s) {
  const here = inThisWindow(s.cwd);
  if (here && /vscode/i.test(s.entrypoint)) {
    vscode.commands.executeCommand('claude-vscode.primaryEditor.open', s.id)
      .then(undefined, (e) => vscode.window.showWarningMessage(`Could not open the session: ${e?.message || e}`));
    return;
  }
  if (here) { vscode.window.showInformationMessage(`This session runs in a terminal (${s.entrypoint || 'CLI'}), not in a Claude tab.`); return; }
  // Another folder: open it (VS Code focuses the window that already has it). Never for this window's own folder,
  // which would reload the window and restart Claude Code.
  if (s.cwd && fs.existsSync(s.cwd)) vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(s.cwd), { forceNewWindow: true });
}

/** Opens the file's change against git when the git extension can, else the file itself. */
function openChange(file) {
  const uri = vscode.Uri.file(file);
  vscode.commands.executeCommand('git.openChange', uri)
    .then(undefined, () => vscode.window.showTextDocument(uri, { preview: true, viewColumn: vscode.ViewColumn.One }));
}

const hm = (ms) => { const m = Math.round(ms / 60000); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };
const money = (v) => (v > 0 ? `$${v.toFixed(2)}` : '–');

/** Today's work as Markdown, opened as an unsaved document (nothing is written to disk). */
function summaryMarkdown(stats, wt) {
  const t = stats.days[stats.days.length - 1];
  const out = [`# Claude Code: ${new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`, '',
    `- Active: **${hm(t.active)}**, thinking ${hm(t.think)}`,
    `- Tool calls: ${t.tools} (${t.errors} failed), commits: ${t.commits}, files edited: ${t.files}`,
    `- Waiting on you: ${hm(t.wait)} over ${t.approvals} approval(s), ${t.denied} denied`,
    `- Cost recorded by Claude Code: ${money(t.cost)} (API prices; not every session records it)`, '',
    '## Per project', '', '| Project | Sessions | Active | Tool calls | Failed | Commits | Files | Cost |', '|---|---:|---:|---:|---:|---:|---:|---:|',
    ...stats.today.map((r) => `| ${r.project} | ${r.sessions} | ${hm(r.active)} | ${r.tools} | ${r.errors} | ${r.commits} | ${r.fileCount} | ${money(r.cost)} |`), ''];
  for (const r of stats.today.filter((x) => x.files.length)) {
    out.push(`### Files edited in ${r.project}`, '', ...r.files.slice(0, 25).map((f) => `- \`${f}\``), r.fileCount > 25 ? `- …and ${r.fileCount - 25} more` : '', '');
  }
  if (stats.slowToday.length) out.push('## Slowest tool calls', '', ...stats.slowToday.map((x) => `- ${hm(x.ms)}: ${x.name} ${x.hint} (${x.project})`), '');
  const fails = stats.failures.filter((g) => g.last >= new Date().setHours(0, 0, 0, 0));
  if (fails.length) out.push('## Recurring failures', '', ...fails.slice(0, 10).map((g) => `- ${g.count}× ${g.name} \`${g.label}\`: ${g.text.slice(0, 140)}`), '');
  const free = (wt?.repos || []).flatMap((r) => r.trees).filter((x) => x.removable);
  if (free.length) out.push('## Worktrees safe to remove', '', ...free.map((x) => `- ${x.path} (${x.gb.toFixed(2)} GB, merged into ${x.mergedInto})`), '');
  return out.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
}

function html(webview, extUri) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const media = (f) => webview.asWebviewUri(vscode.Uri.joinPath(extUri, 'media', f));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${media('view.css')}"><title>Agent Glasses</title></head><body>
<div id="top"><nav id="tabs" role="tablist" aria-label="Views"></nav><div id="alerts" aria-live="polite"></div><div id="search"><input id="q" type="search" placeholder="Filter running sessions, search the last 7 days" aria-label="Filter running sessions and search past ones"></div></div><main id="view" role="tabpanel"></main>
<script nonce="${nonce}" src="${media('view.js')}"></script></body></html>`;
}

function activate(ctx) {
  // One-time move of the pre-rename data folder (~/.claude/claude-viz → ~/.claude/agent-glasses), before
  // anything reads or writes it. A failure leaves the old folder untouched.
  const mig = require('./lib/paths').migrate();
  if (mig.error) vscode.window.showWarningMessage(`Agent Glasses could not move ~/.claude/claude-viz to ~/.claude/agent-glasses (${mig.error}). Your data is still in the old folder.`);
  else if (mig.kept.length) console.warn('[agent-glasses] left in ~/.claude/claude-viz because the new folder already has them:', mig.kept.join(', '));
  // Settings live under agentGlasses.*; a value still set under the old name (claudeViz.*, before the
  // rename) is honoured until the user sets the new one.
  const cfg = () => {
    const now = vscode.workspace.getConfiguration('agentGlasses'), old = vscode.workspace.getConfiguration('claudeViz');
    const isSet = (c, k) => { const i = c.inspect(k); return !!i && [i.globalValue, i.workspaceValue, i.workspaceFolderValue].some((v) => v !== undefined); };
    return { get: (k, d) => (!isSet(now, k) && isSet(old, k) ? old.get(k, d) : now.get(k, d)) };
  };
  const views = new Set();
  const needs = new Map();
  const prev = new Map();
  let last = { sessions: [] };
  let allowed = new Set();
  let stats = null;
  let sys = null;
  let evOffset = -1;
  let wt = { at: 0, repos: [], scanning: false };
  const pinned = new Set(ctx.globalState.get('pinned', []));
  const muted = new Set(ctx.globalState.get('muted', []));
  // Hidden finished sessions: id -> time hidden; forgotten after 7 days.
  const hidden = new Map(Object.entries(ctx.globalState.get('hidden', {})).filter(([, t]) => Date.now() - t < 7 * 86_400_000));
  // The user's own card order on Live (session ids); unknown ids keep their default place after these.
  let order = ctx.globalState.get('order', []).filter((x) => typeof x === 'string').slice(0, 200);
  const persist = () => { ctx.globalState.update('order', order); ctx.globalState.update('pinned', [...pinned]); ctx.globalState.update('muted', [...muted]); ctx.globalState.update('hidden', Object.fromEntries(hidden)); };
  const log = []; // { ts, kind, id, project, title, text }
  const note = (kind, s, text) => { log.push({ ts: Date.now(), kind, id: s.id, project: s.project, title: s.title || s.prompt || 'Untitled session', text }); if (log.length > 200) log.shift(); };
  let awaySince = 0;
  let away = null; // the card shown after the window regains focus
  const stuckSeen = new Map();
  let lastResults = [];
  const analyzed = new Map(); // session id -> { cwd, entrypoint } from its insight analysis
  const analyzedCost = new Map(); // session id -> full estimated cost, once its insights were opened
  const insightFiles = new Set(); // files listed on an insight page, openable from it
  const insightData = new Map(); // session id -> last analysis, for exports and the git view
  const gitRoots = new Map(); // session id -> git root from its git view
  let derived = null; // coach, achievements, recap: recomputed when stats change
  // Celebrations fire once per outcome; the first pass only learns what already happened.
  const celebrated = new Set();
  let primed = false;
  const dayKey = () => new Date().toDateString();
  const celebrate = (kind, text) => {
    if (!cfg().get('celebrate', true)) return;
    for (const w of views) w.postMessage({ type: 'celebrate', kind, text });
    vscode.window.setStatusBarMessage(`$(sparkle) ${text}`, 6000);
  };

  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  bar.command = 'agentGlasses.sidebar.focus';
  bar.show();
  ctx.subscriptions.push(bar);

  /** A short system sound on each platform; silently skipped where no player exists. */
  const ding = () => {
    if (!cfg().get('sound', true)) return;
    const quiet = () => {};
    if (process.platform === 'darwin') execFile('afplay', ['/System/Library/Sounds/Glass.aiff'], quiet);
    else if (WIN) execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[System.Media.SystemSounds]::Asterisk.Play()'], { windowsHide: true }, quiet);
    else execFile('paplay', ['/usr/share/sounds/freedesktop/stereo/bell.oga'], (err) => { if (err) execFile('canberra-gtk-play', ['-i', 'bell'], quiet); });
  };

  /** New Notification-hook events since the last tick; events from before startup are skipped. */
  const readEvents = () => {
    let size;
    try { size = fs.statSync(data.EVENTS).size; } catch { return []; }
    if (evOffset < 0 || size < evOffset) { evOffset = size; return []; }
    if (size === evOffset) return [];
    const out = data.lines(data.readRange(data.EVENTS, evOffset, size - evOffset));
    evOffset = size;
    if (size > 1_000_000) { try { fs.truncateSync(data.EVENTS, 0); evOffset = 0; } catch { /* keep going */ } }
    return out;
  };

  let phoneSvc = null; // created further down, once the state readers it serves exist
  let statsVersion = 0; // bumps when history-based data changes, so views that only show it redraw only then
  const post = () => { const msg = { ...last, phone: phoneSvc ? { ...phoneSvc.status(), devices: phoneSvc.devices(), port: cfg().get('phone.port', 7843) } : null, statsVersion, system: sys, stats, worktrees: wt, pinned: [...pinned], muted: [...muted], hidden: [...hidden.keys()], away, derived, account: insights.account() }; for (const w of views) w.postMessage(msg); };

  const tick = () => {
    for (const e of readEvents()) {
      if (e.hook_event_name !== 'Notification' || typeof e.session_id !== 'string') continue;
      const msg = String(e.message || 'Claude needs your input').slice(0, 200);
      needs.set(e.session_id, { msg, ts: Date.now() });
      const known = last.sessions.find((x) => x.id === e.session_id);
      note('needs', known || { id: e.session_id, project: '', title: '' }, msg);
      if (muted.has(e.session_id)) continue;
      ding();
      vscode.window.showWarningMessage(`Claude: ${msg}`, 'Show').then((a) => a && vscode.commands.executeCommand('agentGlasses.sidebar.focus'));
    }
    try { last = data.snapshot(needs, cfg().get('contextWindow', 1_000_000), pinned); } catch { /* transcript mid-write; next tick */ }
    const pos = (id) => { const i = order.indexOf(id); return i < 0 ? Infinity : i; };
    last.sessions.sort((a, b) => (pinned.has(b.id) ? 1 : 0) - (pinned.has(a.id) ? 1 : 0) || pos(a.id) - pos(b.id) || a.start - b.start);
    let unhid = false;
    for (const s of last.sessions) if (s.running && hidden.has(s.id)) { hidden.delete(s.id); unhid = true; }
    if (unhid) persist();
    for (const s of last.recent || []) {
      const c = data.sessionCost(s.file);
      s.costEst = c ? c.est : null; s.costPartial = c ? c.partial : false; s.costSubs = c ? c.subs : 0;
    }
    for (const s of last.sessions) {
      const c = data.sessionCost(s.file);
      s.costEst = c ? c.est : null;
      s.costPartial = c ? c.partial : false;
      s.costSubs = c ? c.subs : 0;
      s.runCost = insights.runCost(s.id);
      for (const a of [s, ...s.subs]) {
        const who = a === s ? s.project : `${a.name || 'Subagent'} (${s.project})`;
        for (const c2 of a.commits) if (!celebrated.has('c' + c2.id)) { celebrated.add('c' + c2.id); if (primed && !muted.has(s.id)) celebrate('commit', `Commit landed in ${who}`); }
        for (const g of a.greens) if (!celebrated.has('g' + g.id)) { celebrated.add('g' + g.id); if (primed && !muted.has(s.id)) celebrate('green', `Tests green again in ${who}`); }
      }
      for (const a of s.subs) {
        const k = 'f' + a.id;
        if (a.state === 'replied' && !a.errors && !celebrated.has(k)) { celebrated.add(k); if (primed && !muted.has(s.id)) celebrate('sub', `${a.name || 'Subagent'} finished cleanly`); }
      }
    }
    primed = true;

    for (const s of last.sessions) {
      const was = prev.get(s.id);
      const finished = (was === 'tool' || was === 'thinking') && s.state === 'replied';
      if (finished) note('finished', s, s.said.slice(0, 160));
      if (s.stuck && stuckSeen.get(s.id) !== s.stuck) note('stuck', s, s.stuck);
      stuckSeen.set(s.id, s.stuck);
      if (s.rateLimit && prev.get(s.id + ':rl') !== s.rateLimit) note('limit', s, s.rateLimit);
      prev.set(s.id + ':rl', s.rateLimit);
      if (finished && !muted.has(s.id) && cfg().get('notifyOnFinish', true))
        vscode.window.showInformationMessage(`Claude finished in ${s.project}: ${s.title || s.prompt}`.slice(0, 160), 'Show').then((a) => a && showSession(s));
      prev.set(s.id, s.state);
    }
    allowed = new Set(last.sessions.flatMap((s) => [s, ...s.subs]).flatMap((a) => [...a.tools.map((t) => t.file), ...a.files.map((f) => f.path)]).filter(Boolean));

    const waiting = last.sessions.filter((s) => s.needs);
    const subs = last.sessions.reduce((n, s) => n + s.subs.length, 0);
    const running = last.sessions.filter((s) => s.running).length;
    if (waiting.length) {
      bar.text = `$(bell) Claude needs you · ${waiting[0].project}`;
      bar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else if (sys?.level === 'bad') {
      bar.text = `$(warning) Claude · machine under pressure`;
      bar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else {
      bar.text = running ? `$(pulse) Claude · ${running} running · ${subs} subagent(s)` : '$(circle-outline) Claude idle';
      bar.backgroundColor = undefined;
    }
    bar.tooltip = [...last.sessions.map((s) => `${s.project}: ${s.title || s.prompt}`),
      sys && `Agents ${sys.agents}/${sys.cap} · CPU ${Math.round((sys.cpuPct ?? 0) * 100)}% · memory ${sys.memUsedGb.toFixed(1)}/${Math.round(sys.memTotalGb)} GB · disk ${Math.round(sys.diskFreeGb ?? 0)} GB free`].filter(Boolean).join('\n') || 'No Claude Code session is running';
    post();
  };

  let busy = false;
  const slow = async () => {
    if (busy) return;
    busy = true;
    try {
      stats = await data.stats();
      statsVersion++;
      if (stats) {
        try { archive.saveDays(stats.days); } catch { /* archive is best effort */ }
        const before = derived?.achievements || [];
        const arch = archive.allDays();
        const wk = insights.weekly(stats.days, arch, stats.weekHits);
        // The estimate is only shown when it is plausible: well past "100%" without a hit means a bad calibration.
        wk.valid = wk.cap > 0 && wk.pct <= 1.2;
        const bud = insights.budget(stats.days, arch, cfg().get('budget.dailyUsd', 0), cfg().get('budget.monthlyUsd', 0));
        derived = { coach: insights.coach(stats.approvals), achievements: insights.achievements(stats.days, wt), recap: insights.recap(stats.days),
          attribution: insights.attribution(stats.days, stats.cwds), budget: bud, weekly: wk };
        // Budget alerts at 80% and 100%, once per day / month.
        const said = ctx.globalState.get('budgetAlerts', {});
        const day = new Date().toDateString(), month = new Date().toISOString().slice(0, 7);
        for (const [kind, p, key, cap] of [['daily', bud.dailyPct, day, bud.daily], ['monthly', bud.monthlyPct, month, bud.monthly]]) {
          if (!cap) continue;
          for (const level of [1, 0.8]) if (p >= level && !said[`${kind}:${key}:${level}`]) {
            said[`${kind}:${key}:${level}`] = 1;
            vscode.window.showWarningMessage(`Agent Glasses: ${level === 1 ? 'over' : '80% of'} your ${kind} budget ($${cap}): ≈$${(kind === 'daily' ? bud.today : bud.month).toFixed(2)} at API prices.`);
            break;
          }
        }
        ctx.globalState.update('budgetAlerts', said);
        const seen = ctx.globalState.get('badges', {});
        for (const b of derived.achievements) {
          const k = `${dayKey()}:${b.id}`;
          if (b.earned && !seen[k] && before.length) { seen[k] = 1; celebrate('badge', `Achievement: ${b.name}`); }
          else if (b.earned) seen[k] = 1;
        }
        for (const k of Object.keys(seen)) if (!k.startsWith(dayKey())) delete seen[k];
        ctx.globalState.update('badges', seen);
      }
      if (stats && !wt.scanning && Date.now() - wt.at > 10 * 60_000) scanTrees();
    } catch { /* next round */ } finally { busy = false; }
  };

  const scanTrees = async () => {
    if (wt.scanning || !stats) return;
    wt = { ...wt, scanning: true }; post();
    try {
      const cwds = [...new Set([...stats.cwds, ...last.sessions.map((s) => s.cwd)].filter(Boolean))];
      wt = { ...(await worktrees.scan(cwds)), scanning: false };
    } catch { wt = { ...wt, scanning: false }; }
    post();
  };

  /** Asks first (modal), then lets lib/worktrees re-check and remove without force. */
  const dropTree = async (p) => {
    const t = wt.repos.flatMap((r) => r.trees).find((x) => x.path === p && x.removable);
    if (!t) return;
    const ok = await vscode.window.showWarningMessage(`Remove the worktree ${t.path}?`, { modal: true, detail: `${t.gb.toFixed(2)} GB, clean, merged into ${t.mergedInto}. Git deletes the folder (no --force); the branch ${t.branch} is kept.` }, 'Remove');
    if (ok !== 'Remove') return;
    const r = await worktrees.remove(p);
    if (r.ok) vscode.window.showInformationMessage(`Removed ${path.basename(p)}. Branch ${r.branch} is kept.`);
    else vscode.window.showErrorMessage(`Could not remove the worktree: ${r.err}`);
    wt.at = 0; scanTrees();
  };

  /** Adds one coach suggestion to settings after a modal confirmation naming the exact rule and file. */
  const addAllowRule = async (item, scope) => {
    const file = scope === 'user' ? '~/.claude/settings.json' : path.join(item.cwd, '.claude', 'settings.local.json');
    const ok = await vscode.window.showWarningMessage(`Allow ${item.rule} without asking?`, { modal: true, detail: `Adds it to permissions.allow in ${file} (a backup is kept beside it). Claude Code then runs matching commands without a prompt${scope === 'user' ? ' in every project' : ' in this project'}. Seen ${item.count} times; last: ${item.example}` }, 'Allow');
    if (ok !== 'Allow') return;
    try {
      const r = insights.addRule(item.rule, scope, item.cwd);
      if (r.ok) { vscode.window.showInformationMessage(`Allowed ${item.rule} in ${r.file}.`); derived.coach = insights.coach(stats.approvals); post(); }
      else vscode.window.showErrorMessage(r.err);
    } catch (e) { vscode.window.showErrorMessage(`Could not update settings: ${e.message}`); }
  };

  const openSummary = async () => {
    if (!stats) { vscode.window.showInformationMessage("Agent Glasses is still reading today's activity. Try again in a moment."); return; }
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: summaryMarkdown(stats, wt) });
    vscode.window.showTextDocument(doc, { preview: false });
  };
  ctx.subscriptions.push(vscode.commands.registerCommand('agentGlasses.summary', openSummary));

  ctx.subscriptions.push(vscode.window.onDidChangeWindowState((w) => {
    if (!w.focused) { awaySince = Date.now(); return; }
    const since = awaySince; awaySince = 0;
    if (!since || Date.now() - since < 3 * 60_000) return;
    const items = log.filter((e) => e.ts >= since);
    if (!items.length) return;
    away = { since, items };
    const count = (k) => items.filter((e) => e.kind === k).length;
    const parts = [count('finished') && `${count('finished')} finished`, count('needs') && `${count('needs')} need you`, count('stuck') && `${count('stuck')} may be stuck`, count('limit') && 'usage limit hit'].filter(Boolean);
    vscode.window.showInformationMessage(`While you were away: ${parts.join(', ')}.`, 'Show').then((a) => a && vscode.commands.executeCommand('agentGlasses.sidebar.focus'));
    post();
  }));

  // Machine readings every 5 s, with ~3 minutes of CPU and memory history for the sparklines.
  const hist = { cpu: [], mem: [] };
  let sampling = false;
  const sample = async () => {
    if (sampling) return;
    sampling = true;
    try {
      const agents = last.sessions.reduce((n, s) => n + s.subs.length, 0);
      const before = sys?.level;
      sys = await machine(agents, cfg().get('diskWarnGb', 30));
      if (sys.cpuPct != null) hist.cpu.push(sys.cpuPct);
      hist.mem.push(sys.memUsedGb / sys.memTotalGb);
      for (const k of ['cpu', 'mem']) if (hist[k].length > 36) hist[k].shift();
      sys.hist = hist;
      if (sys.level === 'bad' && before !== 'bad') vscode.window.showWarningMessage(`Agent Glasses: machine under pressure (agents ${sys.agents}/${sys.cap}, disk ${Math.round(sys.diskFreeGb ?? 0)} GB free, swap ${(sys.swapUsedGb ?? 0).toFixed(1)} GB, memory ${sys.memFreePct ?? '?'}% available).`);
    } catch { /* next sample */ } finally { sampling = false; }
  };
  const sampler = setInterval(sample, 5000);
  ctx.subscriptions.push({ dispose: () => clearInterval(sampler) });
  sample();

  // ---------- phone access (read-only, paired devices only) ----------
  const trim = (t, n) => (t || '').length > n ? t.slice(0, n) + '…' : t || '';
  const lvl = (x) => (x === 'ok' ? '' : x);
  const phoneState = () => {
    const a = insights.account();
    const limits = [];
    if (a && a.fiveHour) limits.push({ name: '5-hour', pct: a.fiveHour.pct, resetsAt: a.fiveHour.resetsAt });
    if (a && a.sevenDay) limits.push({ name: 'Week', pct: a.sevenDay.pct, resetsAt: a.sevenDay.resetsAt });
    if (!limits.length && stats?.forecast?.cap) limits.push({ name: '5-hour', pct: stats.forecast.pct, resetsAt: stats.forecast.pace?.end || 0, est: true });
    const doing = (x) => x.needs || (x.state === 'tool' ? `${x.current.name}${x.current.hint ? ': ' + x.current.hint : ''}` : x.state === 'thinking' ? 'Thinking' : x.state === 'replied' ? 'Finished, waiting for you' : 'Finished');
    const oneLine = (t) => String(t || '').replace(/\s+/g, ' ').trim();
    const sess = (x) => ({ id: x.id, title: oneLine(x.title || x.prompt || 'Untitled session').slice(0, 160), project: x.project, branch: x.branch, model: x.model, state: x.state, running: x.running, needs: x.needs || '',
      doing: doing(x), doingTs: x.state === 'tool' && x.current ? x.current.ts : x.lastTs, lastPrompt: trim(x.lastPrompt || x.prompt, 4000), said: trim(x.said, 4000),
      cost: x.costEst ?? null, ctxPct: x.contextPct || 0, context: x.context || 0, cache: x.cacheInfo?.hit ? (x.cacheInfo.warmLeft ? 'warm' : 'cold') : '',
      cacheHit: x.cacheInfo?.hit || 0, warmUntil: x.cacheInfo?.warmLeft ? Date.now() + x.cacheInfo.warmLeft : 0,
      turnStart: x.turnStart || 0, lastTs: x.lastTs || 0, think: x.think || 0, compactions: (x.compactions || []).length, total: x.total || 0, errors: x.errors || 0,
      stuck: x.stuck || '', rateLimit: x.rateLimit || '', spark: x.spark || [],
      // What the extension's card shows: recent tool calls, a 15-minute timeline and the files edited.
      tools: (x.tools || []).slice(-10).map((t) => ({ name: t.name, hint: oneLine(t.hint).slice(0, 120), ok: t.ok, ms: t.ms, ts: t.ts })),
      timeline: (x.timeline || []).slice(-80).map((t) => ({ n: t.n, ts: t.ts, ms: t.ms, ok: t.ok, c: t.c })),
      files: (x.files || []).slice(0, 15).map((f) => ({ name: f.name, n: f.n, ts: f.ts })),
      subs: (x.subs || []).map((s) => ({ name: oneLine(s.name || s.id).slice(0, 120), type: s.type || '', running: s.running, state: s.state, doing: oneLine(doing(s)).slice(0, 160), total: s.total || 0, errors: s.errors || 0, start: s.start || 0, worktree: s.worktree || '', timeline: (s.timeline || []).slice(-40).map((t) => ({ n: t.n, ts: t.ts, ms: t.ms, ok: t.ok })) })) });
    const t = stats?.days?.[stats.days.length - 1];
    const alerts = [];
    for (const x of last.sessions) if (x.needs) alerts.push({ kind: '', text: `${x.title || x.project}: ${x.needs}` });
    if (sys?.level === 'bad') alerts.push({ kind: 'bad', text: 'Machine under pressure: check disk, memory and agents.' });
    return {
      at: Date.now(), sessions: last.sessions.map(sess), recent: (last.recent || []).map((r) => ({ id: r.id, title: oneLine(r.title || r.prompt || 'Untitled session').slice(0, 160), project: r.project, lastTs: r.lastTs, lastPrompt: trim(oneLine(r.lastPrompt), 200) })),
      system: sys ? { cpu: sys.cpuPct ?? sys.load, cpuLevel: lvl(sys.cpu), memUsed: sys.memUsedGb, memLevel: lvl(sys.mem), disk: sys.diskFreeGb ?? 0, diskLevel: lvl(sys.disk), swap: sys.swapUsedGb ?? 0, swapLevel: lvl(sys.swap), agents: sys.agents, cap: sys.cap, agLevel: lvl(sys.ag), claude: sys.procs.claude.n } : null,
      limits, alerts,
      today: t ? { work: t.work, blocked: t.blocked, failing: t.failMs, active: t.active, est: t.est, commits: t.commits, projects: stats.today.map((r) => ({ project: r.project, est: r.est, active: r.active, tools: r.tools })) } : null,
    };
  };
  const phoneHistory = async () => {
    const list = await data.listSessions(analyzedCost);
    const gone = archive.goneSessions().map((x) => ({ ...x, gone: true }));
    return [...list, ...gone].sort((a, b) => b.lastTs - a.lastTs).slice(0, 200).map((x) => ({ id: x.id, title: String(x.title || 'Untitled session').replace(/\s+/g, ' ').trim().slice(0, 140), project: x.project, lastTs: x.lastTs, est: x.est ?? null, gone: !!x.gone }));
  };
  const phoneSession = async (id) => {
    const f = sessionInsight.locate(id);
    if (!f) return null;
    const d = await sessionInsight.analyze(f);
    return { title: d.title, project: d.project, cost: d.cost, active: d.active, calls: d.calls, failed: d.failed, models: d.models.map((m) => m.model),
      prompts: d.turns.filter((x) => x.text).length,
      turns: d.turns.filter((x) => x.text).sort((a, b) => b.ts - a.ts).slice(0, 40).map((x) => ({ ts: x.ts, dur: x.dur, tools: x.tools, cost: x.total, text: trim(x.text, 600) })),
      tools: d.tools.slice(0, 12).map((x) => ({ name: x.name, calls: x.calls, failed: x.failed })), subagents: d.subagents.slice(0, 20).map((a) => ({ name: a.name, type: a.type, calls: a.calls, cost: a.cost })) };
  };
  const phoneLog = vscode.window.createOutputChannel('Agent Glasses Phone');
  ctx.subscriptions.push(phoneLog);
  const phoneBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  phoneBar.command = 'agentGlasses.phone.toggle';
  ctx.subscriptions.push(phoneBar);
  phoneSvc = phone.create({
    mediaDir: path.join(ctx.extensionPath, 'media'), state: phoneState, history: phoneHistory, session: phoneSession,
    log: (line) => phoneLog.appendLine(`${new Date().toLocaleTimeString()}  ${line}`),
    onChange: () => {
      const st = phoneSvc ? phoneSvc.status() : { on: false };
      if (st.on) { phoneBar.text = '$(device-mobile) Phone on'; phoneBar.tooltip = `Phone access is on until ${new Date(st.until).toLocaleTimeString()}. Click to turn it off.`; phoneBar.show(); } else phoneBar.hide();
      post();
    },
  });
  ctx.subscriptions.push({ dispose: () => { phoneSvc.stop(false); } });
  const phoneOn = () => phoneSvc.start(cfg().get('phone.port', 7843), Math.max(0.25, Math.min(24, cfg().get('phone.autoOffHours', 4)))).then((st) => { if (st.error) vscode.window.showWarningMessage('Phone access: ' + st.error); });
  ctx.subscriptions.push(vscode.commands.registerCommand('agentGlasses.phone.toggle', () => (phoneSvc.status().on ? phoneSvc.stop(true) : phoneOn())));

  /** Remote Control: a terminal running Claude Code so the session also appears in the Claude phone app. */
  const remoteTerminal = (cwd, args, name) => {
    if (!cwd || !fs.existsSync(cwd)) { vscode.window.showWarningMessage('The session folder no longer exists.'); return; }
    const term = vscode.window.createTerminal({ name: `Claude on phone · ${name}`.slice(0, 60), cwd });
    term.show();
    // Every argument is a session id or a name limited to [\w .-], so plain double quotes are safe in bash, zsh,
    // PowerShell and cmd alike; the folder is the terminal's cwd, never part of the command line.
    if (!args.every((a) => /^[\w .-]+$/.test(a))) return;
    term.sendText(['claude', ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' '));
  };

  const fast = setInterval(tick, 2000);
  const slower = setInterval(slow, 30_000);
  ctx.subscriptions.push({ dispose: () => { clearInterval(fast); clearInterval(slower); } });

  /** Wires a webview (sidebar or panel) to the shared data. Messages from it are checked against what is on screen. */
  const setup = (webview) => {
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media')] };
    webview.html = html(webview, ctx.extensionUri);
    views.add(webview);
    const sub = webview.onDidReceiveMessage((m) => {
      if (m?.ready) post();
      const s = typeof m?.show === 'string' && (last.sessions.find((x) => x.id === m.show) || (last.recent || []).find((x) => x.id === m.show));
      if (s) showSession(s);
      if (typeof m?.file === 'string' && (allowed.has(m.file) || insightFiles.has(m.file)) && fs.existsSync(m.file)) openChange(m.file);
      if (m?.summary) openSummary();
      const sess = typeof m?.sid === 'string' && (last.sessions.find((x) => x.id === m.sid) || (last.recent || []).find((x) => x.id === m.sid));
      if (sess && m.act === 'pin') { pinned.has(sess.id) ? pinned.delete(sess.id) : pinned.add(sess.id); persist(); tick(); }
      if (sess && m.act === 'hide' && !sess.running) { hidden.set(sess.id, Date.now()); pinned.delete(sess.id); persist(); tick(); }
      if (typeof m?.sid === 'string' && m.act === 'unhide') { hidden.delete(m.sid); persist(); post(); }
      if (m?.hideAll) { for (const r of last.recent || []) hidden.set(r.id, Date.now()); persist(); post(); }
      if (sess && m.act === 'mute') { muted.has(sess.id) ? muted.delete(sess.id) : muted.add(sess.id); persist(); post(); }
      if (sess && m.act === 'resume') { const cmd = resumeCommand(sess.cwd, sess.id); if (cmd) { vscode.env.clipboard.writeText(cmd); vscode.window.setStatusBarMessage('Resume command copied', 3000); } }
      if (sess && m.act === 'transcript') vscode.window.showTextDocument(vscode.Uri.file(sess.file), { preview: true });
      if (sess && typeof m.tool === 'string') {
        const agent = m.aid ? sess.subs.find((a) => a.id === m.aid) : sess;
        let det = null;
        try { det = agent && data.detail(agent.file, m.tool); } catch { /* unreadable */ }
        webview.postMessage({ type: 'detail', detail: det ? { ...det, agent: m.aid ? agent.name || agent.id : 'Main agent', session: sess.title || sess.prompt } : null });
      }
      if (typeof m?.search === 'string') { lastResults = m.search.trim().length >= 3 ? data.search(m.search) : []; webview.postMessage({ type: 'results', q: m.search, results: lastResults }); }
      if (typeof m?.past === 'string') {
        const r = lastResults.find((x) => x.id === m.past);
        if (r) showSession(r);
      }
      if (m?.dismissAway) { away = null; post(); }
      if (Array.isArray(m?.order)) {
        const ids = m.order.filter((x) => typeof x === 'string' && /^[\w-]{8,64}$/.test(x)).slice(0, 200);
        order = [...ids, ...order.filter((x) => !ids.includes(x))].slice(0, 200);
        persist(); tick();
      }
      if (typeof m?.insight === 'string') {
        const file = sessionInsight.locate(m.insight); // id is validated there; only files under ~/.claude/projects
        if (!file) webview.postMessage({ type: 'insight', id: m.insight, error: 'Transcript not found.' });
        else sessionInsight.analyze(file)
          .then((d) => { analyzed.set(d.id, { cwd: d.cwd, entrypoint: d.entrypoint }); analyzedCost.set(d.id, d.cost); insightData.set(d.id, d); for (const f of d.files) insightFiles.add(f.path); webview.postMessage({ type: 'insight', id: m.insight, data: d }); })
          .catch((e) => webview.postMessage({ type: 'insight', id: m.insight, error: String(e?.message || e) }));
      }
      if (m?.history) data.listSessions(analyzedCost).then((list) => {
        try { archive.saveSessions(list); } catch { /* best effort */ }
        const gone = archive.goneSessions().map((x) => ({ ...x, gone: true, sizeMb: 0, estPartial: false }));
        webview.postMessage({ type: 'history', list: [...list, ...gone] });
      }).catch(() => webview.postMessage({ type: 'history', list: [] }));
      // ---- full-text search, exports, git, replies, memory files ----
      if (typeof m?.fulltext === 'string' && m.fulltext.length <= 200) {
        search.fullText(m.fulltext).then((r) => { for (const x of r.results) if (x.cwd) analyzed.set(x.id, { cwd: x.cwd, entrypoint: x.entrypoint }); webview.postMessage({ type: 'fulltext', ...r }); })
          .catch((e) => webview.postMessage({ type: 'fulltext', q: m.fulltext, results: [], note: String(e?.message || e) }));
      }
      if (typeof m?.exportId === 'string' && insightData.has(m.exportId)) {
        const d = insightData.get(m.exportId);
        const openDoc = (content, language) => vscode.workspace.openTextDocument({ content, language }).then((doc) => vscode.window.showTextDocument(doc, { preview: false }));
        if (m.kind === 'report') openDoc(exporter.report(d), 'markdown');
        else if (m.kind === 'csv') openDoc(exporter.csv(d), 'csv');
        else if (m.kind === 'json') openDoc(JSON.stringify(d, null, 2), 'json');
        else if (m.kind === 'conversation') exporter.conversation(d.file, d.title).then((t) => openDoc(t, 'markdown'));
      }
      if (typeof m?.gitOf === 'string' && insightData.has(m.gitOf)) {
        const d = insightData.get(m.gitOf);
        git.sessionGit(d.cwd, d.start, d.end).then((g) => { if (g.ok) gitRoots.set(d.id, { root: g.root, branch: g.branch, host: g.host }); webview.postMessage({ type: 'git', id: d.id, data: g }); });
      }
      if (typeof m?.prOf === 'string' && gitRoots.has(m.prOf)) {
        const g = gitRoots.get(m.prOf);
        git.pullRequest(g.root, g.branch, g.host).then((r) => webview.postMessage({ type: 'pr', id: m.prOf, data: r }));
      }
      if (typeof m?.commitOf === 'string' && typeof m.sha === 'string' && gitRoots.has(m.commitOf)) {
        git.show(gitRoots.get(m.commitOf).root, m.sha).then((t) => t && vscode.workspace.openTextDocument({ content: t, language: 'diff' }).then((doc) => vscode.window.showTextDocument(doc, { preview: true })));
      }
      if (typeof m?.openUrl === 'string' && /^https:\/\/(github\.com|dev\.azure\.com|[\w-]+\.visualstudio\.com)\//.test(m.openUrl)) vscode.env.openExternal(vscode.Uri.parse(m.openUrl));
      if (typeof m?.reply === 'string' && typeof m.text === 'string' && m.text.trim() && m.text.length <= 8000) {
        const target = last.sessions.find((x) => x.id === m.reply) || (last.recent || []).find((x) => x.id === m.reply);
        const here = target && inThisWindow(target.cwd);
        // Claude only fills in text for a session whose tab is not open yet ("Session is already open…"), so the
        // reply is always on the clipboard as well: paste it if Claude did not.
        vscode.env.clipboard.writeText(m.text);
        if (target && here && /vscode/i.test(target.entrypoint)) {
          // Claude deliberately ignores a prompt for a session whose tab is already open, so for an open tab we only
          // focus it (passing the prompt would just show Claude's "not applied" notice) and the user pastes.
          const title = (target.title || '').trim();
          const claudeTabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputWebview && /claude/i.test(t.input.viewType));
          const tabOpen = !!title && claudeTabs.some((t) => { const l = t.label.replace(/…$/, '').trim(); return l && (l === title || title.startsWith(l) || l.startsWith(title)); });
          vscode.commands.executeCommand('claude-vscode.primaryEditor.open', target.id, tabOpen ? undefined : m.text).then(undefined, () => {});
          if (tabOpen) vscode.window.showInformationMessage('Your reply is copied. Claude cannot fill in a tab that is already open: click its input, paste (' + (process.platform === 'darwin' ? '⌘V' : 'Ctrl+V') + '), then Enter.');
          else vscode.window.setStatusBarMessage('$(clippy) Reply filled in (also copied): press Enter in Claude to send', 6000);
        }
        else { vscode.env.clipboard.writeText(m.text); vscode.window.showInformationMessage('That session runs elsewhere; your reply is copied. Paste it there.'); if (target) showSession(target); }
      }
      if (typeof m?.newPrompt === 'string' && m.newPrompt.trim() && m.newPrompt.length <= 8000) vscode.commands.executeCommand('claude-vscode.primaryEditor.open', undefined, m.newPrompt).then(undefined, () => vscode.window.showWarningMessage('Could not open a new Claude session.'));
      if (typeof m?.openMemory === 'string' && derived?.attribution?.memory.some((x) => x.path === m.openMemory)) vscode.window.showTextDocument(vscode.Uri.file(m.openMemory), { preview: true });
      if (typeof m?.openLink === 'string' && /^https?:\/\/[^\s]+$/.test(m.openLink) && m.openLink.length < 2000) vscode.env.openExternal(vscode.Uri.parse(m.openLink));
      if (m?.phoneOn) phoneOn();
      if (m?.phoneOff) phoneSvc.stop(true);
      if (m?.phonePair) { const p = phoneSvc.newPairing(); if (p) webview.postMessage({ type: 'pairing', ...p }); }
      if (typeof m?.phoneRevoke === 'string') phoneSvc.revoke(m.phoneRevoke);
      if (m?.remoteNew) {
        const folder = (vscode.workspace.workspaceFolders || [])[0];
        if (folder) remoteTerminal(folder.uri.fsPath, ['--remote-control', path.basename(folder.uri.fsPath).replace(/[^\w .-]/g, '').slice(0, 40) || 'session'], path.basename(folder.uri.fsPath));
      }
      if (sess && m.act === 'remote') {
        if (sess.running) vscode.window.showWarningMessage('This session is still working. Continue it on the phone after it finishes, so two Claude processes do not write the same conversation.');
        else remoteTerminal(sess.cwd, ['--resume', sess.id, '--remote-control', (sess.title || sess.project || 'session').replace(/[^\w .-]/g, '').slice(0, 40) || 'session'], sess.title || sess.project);
      }
      if (m?.budgetSettings) vscode.commands.executeCommand('workbench.action.openSettings', 'agentGlasses.budget');
      if (typeof m?.openFileOf === 'string') { const f = sessionInsight.locate(m.openFileOf); if (f) vscode.window.showTextDocument(vscode.Uri.file(f), { preview: true }); }
      // Folder and entrypoint come from the analysis, never from the message.
      const known = typeof m?.copyResume === 'string' ? analyzed.get(m.copyResume) : typeof m?.showById === 'string' ? analyzed.get(m.showById) : null;
      if (known && m.copyResume) { const cmd = resumeCommand(known.cwd, m.copyResume); if (cmd) { vscode.env.clipboard.writeText(cmd); vscode.window.setStatusBarMessage('Resume command copied', 3000); } }
      if (known && m.showById) showSession({ id: m.showById, cwd: known.cwd || '', entrypoint: known.entrypoint || '' });
      if (typeof m?.rule === 'string') {
        const item = derived?.coach.items.find((g) => g.rule === m.rule);
        if (item && m.scope === 'copy') { vscode.env.clipboard.writeText(item.rule); vscode.window.setStatusBarMessage(`Copied ${item.rule}`, 3000); }
        else if (item && !item.risky && (m.scope === 'user' || (m.scope === 'project' && item.cwd))) addAllowRule(item, m.scope);
      }
      if (typeof m?.openToday === 'string') { const r = stats?.sessionsToday.find((x) => x.id === m.openToday); if (r) showSession(r); }
      if (m?.scanWorktrees) { wt.at = 0; scanTrees(); }
      if (typeof m?.removeWorktree === 'string') dropTree(m.removeWorktree);
    });
    return () => { views.delete(webview); sub.dispose(); };
  };

  ctx.subscriptions.push(vscode.window.registerWebviewViewProvider('agentGlasses.sidebar', {
    resolveWebviewView(view) { const done = setup(view.webview); view.onDidDispose(done); },
  }, { webviewOptions: { retainContextWhenHidden: true } }));

  let panel;
  ctx.subscriptions.push(vscode.commands.registerCommand('agentGlasses.open', () => {
    if (panel) return panel.reveal();
    panel = vscode.window.createWebviewPanel('agentGlasses', 'Agent Glasses', vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
    const done = setup(panel.webview);
    panel.onDidDispose(() => { done(); panel = undefined; });
  }));

  tick();
  setTimeout(slow, 3000);
}

module.exports = { activate, deactivate() {} };
