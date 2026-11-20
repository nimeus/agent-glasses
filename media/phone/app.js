// Agent Glasses phone page: read-only. Polls the paired computer every 3 s while visible; builds the DOM with
// createElement/textContent only, so transcript text can never run as code here.
(() => {
  const $ = (id) => document.getElementById(id);
  const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
  const dur = (ms) => { ms = Math.max(0, ms); const s = Math.floor(ms / 1000); if (s < 60) return s + 's'; const m = Math.floor(s / 60); if (m < 60) return m + 'm ' + String(s % 60).padStart(2, '0') + 's'; return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm'; };
  const short = (ms) => { const m = Math.round(Math.max(0, ms) / 60000); return m < 60 ? m + 'm' : Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm'; };
  const ago = (ts) => (ts ? dur(Date.now() - ts) + ' ago' : '');
  const money = (v) => (v >= 100 ? '$' + Math.round(v) : '$' + (v || 0).toFixed(2));
  const pct = (v) => Math.round((v || 0) * 100) + '%';
  const kt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n || 0));
  let tab = 'live', state = null, history = null, timer = 0, sheetId = null, sheetData = null;
  const expanded = new Set(); // "ask:<id>" / "said:<id>" / "more:<id>" opened by the user

  async function get(path) {
    const r = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
    if (r.status === 401) { location.reload(); throw new Error('unpaired'); }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  function bar(p) { const b = el('div', 'bar'), i = el('i'); i.style.width = Math.min(100, Math.max(0, p * 100)) + '%'; b.append(i); return b; }
  function stat(label, value, level) { const s = el('div', 'stat ' + (level || '')); s.append(el('span', 'l', label), el('b', 'num', value)); return s; }
  const ticker = (cls, ts, prefix) => { const e = el('span', cls); e.dataset.since = ts; e.dataset.prefix = prefix || ''; e.textContent = (prefix || '') + dur(Date.now() - ts); return e; };
  setInterval(() => document.querySelectorAll('[data-since]').forEach((e) => { e.textContent = e.dataset.prefix + dur(Date.now() - Number(e.dataset.since)); }), 1000);

  // ---------- Markdown as DOM (never innerHTML) ----------
  function inline(parent, text) {
    const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\((https?:\/\/[^)\s]+)\))|(\*[^*\s\n][^*\n]*\*)|(https?:\/\/[^\s<>()]+[^\s<>().,;:])/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.append(document.createTextNode(text.slice(last, m.index)));
      if (m[1]) parent.append(el('code', null, m[1].slice(1, -1)));
      else if (m[2]) parent.append(el('strong', null, m[2].slice(2, -2)));
      else if (m[3]) { const a = el('a', null, m[3].slice(1, m[3].indexOf(']('))); a.href = m[4]; a.target = '_blank'; a.rel = 'noopener noreferrer'; parent.append(a); }
      else if (m[5]) parent.append(el('em', null, m[5].slice(1, -1)));
      else if (m[6]) { const a = el('a', null, m[6]); a.href = m[6]; a.target = '_blank'; a.rel = 'noopener noreferrer'; parent.append(a); }
      last = re.lastIndex;
    }
    if (last < text.length) parent.append(document.createTextNode(text.slice(last)));
  }
  function md(text) {
    const root = el('div', 'md'), lines = String(text).replace(/\r/g, '').split('\n');
    let i = 0;
    const isTable = (l) => /^\s*\|.*\|\s*$/.test(l);
    while (i < lines.length) {
      const l = lines[i];
      if (/^\s*```/.test(l)) { const buf = []; i++; while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]); i++; const pre = el('pre'); pre.append(el('code', null, buf.join('\n'))); root.append(pre); continue; }
      if (/^#{1,6}\s/.test(l)) { const h = el('div', 'mh'); inline(h, l.replace(/^#+\s*/, '')); root.append(h); i++; continue; }
      if (/^\s*>/.test(l)) { const q = el('blockquote'); const buf = []; while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, '')); q.append(md(buf.join('\n'))); root.append(q); continue; }
      if (isTable(l) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
        const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((x) => x.trim());
        const t = el('table'), hr = el('tr'); for (const c of cells(l)) { const th = el('th'); inline(th, c); hr.append(th); } t.append(hr); i += 2;
        while (i < lines.length && isTable(lines[i])) { const tr = el('tr'); for (const c of cells(lines[i])) { const td = el('td'); inline(td, c); tr.append(td); } t.append(tr); i++; }
        const w = el('div', 'tablewrap'); w.append(t); root.append(w); continue;
      }
      if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
        const list = el(/^\s*\d/.test(l) ? 'ol' : 'ul');
        while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) { const li = el('li'); inline(li, lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, '')); list.append(li); i++; }
        root.append(list); continue;
      }
      if (!l.trim()) { i++; continue; }
      const p = el('p'), buf = [];
      while (i < lines.length && lines[i].trim() && !/^\s*(```|#{1,6}\s|>|([-*+]|\d+[.)])\s+)/.test(lines[i]) && !isTable(lines[i])) buf.push(lines[i++]);
      inline(p, buf.join(' ')); root.append(p);
    }
    return root;
  }
  const plain = (t) => String(t).replace(/```[\s\S]*?```/g, ' [code] ').replace(/[#>*_`|]/g, ' ').replace(/\s+/g, ' ').trim();
  /** "You asked" / "Claude said": three lines, tap "Show all" for the full text as Markdown. */
  function message(kind, label, text, key) {
    const open = expanded.has(key), box = el('div', 'q ' + kind + (open ? ' open' : ''));
    const head = el('div', 'qh'); head.append(el('span', 'l', label));
    const tog = el('button', 'tog', open ? 'Show less' : 'Show all'); tog.onclick = (e) => { e.stopPropagation(); open ? expanded.delete(key) : expanded.add(key); render(); };
    head.append(tog); box.append(head);
    box.append(open ? md(text) : el('div', 'qp', plain(text)));
    return box;
  }

  // ---------- small charts ----------
  function lanes(s) {
    const W = 15 * 60000, now = Date.now(), ns = 'http://www.w3.org/2000/svg';
    const rows = [{ name: 'Main', items: s.timeline }, ...s.subs.map((a) => ({ name: a.name, items: a.timeline || [] }))].filter((r) => r.items.length);
    if (!rows.length) return null;
    const box = el('div', 'lanes');
    for (const r of rows) {
      const lane = el('div', 'lane'); lane.append(el('span', 'ln', r.name));
      const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', '0 0 1000 10'); svg.setAttribute('preserveAspectRatio', 'none');
      for (const t of r.items) {
        const x = (t.ts - (now - W)) / W * 1000, w = Math.max(4, t.ms / W * 1000); if (x + w < 0) continue;
        const rc = document.createElementNS(ns, 'rect'); rc.setAttribute('x', Math.max(0, x)); rc.setAttribute('y', 0); rc.setAttribute('width', w); rc.setAttribute('height', 10);
        rc.setAttribute('class', t.ok === null ? 'run' : t.ok ? 'ok' : 'bad'); svg.append(rc);
      }
      lane.append(svg); box.append(lane);
    }
    const ax = el('div', 'axis'); ['15m', '10m', '5m', 'now'].forEach((x) => ax.append(el('span', null, x))); box.append(ax);
    return box;
  }
  function ring(work, blocked, failing) {
    const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg'), tot = work + blocked + failing;
    svg.setAttribute('viewBox', '0 0 36 36'); svg.setAttribute('class', 'ring');
    const arc = (cls, len, off) => { const c = document.createElementNS(ns, 'circle'); c.setAttribute('cx', 18); c.setAttribute('cy', 18); c.setAttribute('r', 15.9155); c.setAttribute('class', cls); c.setAttribute('stroke-dasharray', len + ' ' + (100 - len)); c.setAttribute('stroke-dashoffset', 25 - off); svg.append(c); };
    arc('t', 100, 0); let off = 0;
    for (const [cls, v] of [['w', work], ['b', blocked], ['f', failing]]) { if (tot && v) { const len = v / tot * 100; arc(cls, len, off); off += len; } }
    const t = document.createElementNS(ns, 'text'); t.setAttribute('x', 18); t.setAttribute('y', 21); t.textContent = tot ? pct(work / tot) : '–'; svg.append(t);
    return svg;
  }

  // ---------- views ----------
  function alerts() {
    const box = $('alerts'); box.replaceChildren();
    for (const a of (state && state.alerts) || []) box.append(el('div', 'alert ' + (a.kind || ''), a.text));
  }
  function machine() {
    const s = state.system; if (!s) return null;
    const c = el('section', 'card'); c.append(el('h2', null, 'Machine'));
    const g = el('div', 'strip');
    g.append(stat('CPU', pct(s.cpu), s.cpuLevel), stat('Memory', s.memUsed.toFixed(1) + ' GB', s.memLevel), stat('Disk free', Math.round(s.disk) + ' GB', s.diskLevel), stat('Swap', s.swap.toFixed(1) + ' GB', s.swapLevel), stat('Agents', s.agents + ' / ' + s.cap, s.agLevel), stat('Claude', s.claude + ' procs'));
    c.append(g);
    return c;
  }
  function limits() {
    const L = state.limits || []; if (!L.length) return null;
    const c = el('section', 'card'); c.append(el('h2', null, 'Usage limits'));
    for (const x of L) { const r = el('div', 'lim ' + (x.pct > 0.9 ? 'bad' : x.pct > 0.7 ? 'warn' : '')); r.append(el('span', null, x.name), bar(x.pct), el('b', 'num', pct(x.pct) + (x.est ? ' est.' : ''))); c.append(r); if (x.resetsAt) c.append(el('div', 'dim small', 'resets in ' + short(x.resetsAt - Date.now()))); }
    return c;
  }
  function toolList(tools) {
    const ul = el('ul', 'tools');
    for (const t of tools.slice().reverse()) {
      const li = el('li'); li.append(el('span', 'st ' + (t.ok === null ? 'run' : t.ok ? 'ok' : 'bad')), el('b', null, t.name), el('span', 'h', t.hint), t.ok === null ? ticker('d num', t.ts) : el('span', 'd num', t.ms ? dur(t.ms) : ''));
      ul.append(li);
    }
    return ul;
  }
  /** Everything the extension's card shows, for one live session. */
  function liveDetail(s, inSheet) {
    const box = el('div', 'detail');
    const now = el('div', 'now'); now.append(el('span', null, s.doing), ticker('num', s.doingTs)); box.append(now);
    if (s.stuck) box.append(el('div', 'alert', 'May be stuck: ' + s.stuck));
    if (s.rateLimit) box.append(el('div', 'alert bad', s.rateLimit));
    if (s.lastPrompt) box.append(message('you', 'You asked', s.lastPrompt, 'ask:' + s.id));
    if (s.said) box.append(message('claude', 'Claude said', s.said, 'said:' + s.id));
    const k = el('div', 'kpis');
    if (s.turnStart) { const x = el('div', 'stat'); x.append(el('span', 'l', s.running ? 'This turn' : 'Last turn took')); x.append(s.running ? ticker('num big', s.turnStart) : el('b', 'num', dur(Math.max(0, s.lastTs - s.turnStart)))); k.append(x); }
    if (s.cost != null) k.append(stat('Session cost', '≈' + money(s.cost)));
    if (s.cache) k.append(stat('Cache', s.warmUntil > Date.now() ? 'warm ' + short(s.warmUntil - Date.now()) : 'cold', s.warmUntil > Date.now() ? '' : 'warn'));
    if (s.ctxPct) { const x = stat('Context', pct(s.ctxPct), s.ctxPct > 0.9 ? 'bad' : s.ctxPct > 0.7 ? 'warn' : ''); x.append(bar(s.ctxPct)); k.append(x); }
    box.append(k);
    const tl = lanes(s); if (tl) box.append(tl);
    if (s.subs.length) {
      const sb = el('div', 'subs'); sb.append(el('div', 'l', s.subs.length + ' subagent' + (s.subs.length > 1 ? 's' : '')));
      for (const a of s.subs) { const r = el('div', 'sub'); const top = el('div', 'st2'); top.append(el('span', 'dot' + (a.running ? ' on' : '')), el('b', null, a.name), el('span', 'chip', a.type || 'agent')); r.append(top, el('div', 'dim small', a.doing + ' · ' + a.total + ' tool calls' + (a.errors ? ', ' + a.errors + ' failed' : '') + (a.worktree ? ' · ' + a.worktree : ''))); sb.append(r); }
      box.append(sb);
    }
    const moreKey = 'more:' + s.id, open = inSheet || expanded.has(moreKey);
    if (!inSheet) { const t = el('button', 'tog more', open ? 'Hide tool calls' : 'Tool calls and files'); t.onclick = (e) => { e.stopPropagation(); open ? expanded.delete(moreKey) : expanded.add(moreKey); render(); }; box.append(t); }
    if (open) {
      const facts = el('div', 'kpis');
      facts.append(stat('Tool calls', s.total + (s.errors ? ' (' + s.errors + ' ✕)' : '')));
      if (s.cacheHit) facts.append(stat('From cache', pct(s.cacheHit)));
      if (s.think) facts.append(stat('Thinking', dur(s.think)));
      if (s.compactions) facts.append(stat('Compacted', s.compactions + '×'));
      box.append(facts);
      if (s.tools.length) { box.append(el('div', 'l sect', 'Recent tool calls')); box.append(toolList(s.tools)); }
      if (s.files.length) { box.append(el('div', 'l sect', 'Files edited')); const ul = el('ul', 'tools files'); for (const f of s.files) { const li = el('li'); li.append(el('b', null, f.name), el('span', 'd num', f.n + '× · ' + ago(f.ts))); ul.append(li); } box.append(ul); }
    }
    return box;
  }
  function sessionCard(s) {
    const c = el('article', 'sess ' + (s.needs ? 'needs' : s.state));
    const head = el('button', 'sh'); head.onclick = () => openSession(s.id);
    head.append(el('h3', null, s.title), el('span', 'chev', '›'));
    c.append(head);
    const m = el('div', 'meta'); [s.project, s.branch && '⎇ ' + s.branch, s.model].filter(Boolean).forEach((x) => m.append(el('span', null, x))); c.append(m);
    c.append(liveDetail(s, false));
    return c;
  }
  function renderLive(v) {
    const parts = [limits()];
    if (!state.sessions.some((s) => s.running || s.needs)) parts.push(el('p', 'empty', 'Nothing running right now.'));
    parts.push(...state.sessions.map(sessionCard));
    if (state.recent.length) { const c = el('section', 'card'); c.append(el('h2', null, 'Recently finished')); for (const r of state.recent) { const row = el('button', 'row'); row.onclick = () => openSession(r.id); const t = el('div', 'r'); t.append(el('b', null, r.title), el('span', 'dim num', ago(r.lastTs))); row.append(t, el('div', 'dim', r.project + (r.lastPrompt ? ': ' + r.lastPrompt : ''))); c.append(row); } parts.push(c); }
    parts.push(machine());
    v.append(...parts.filter(Boolean));
  }
  function renderToday(v) {
    const t = state.today; if (!t) { v.append(el('p', 'empty', 'Reading today’s activity…')); return; }
    const c = el('section', 'card'); c.append(el('h2', null, 'Agent time today'));
    const f = el('div', 'flow'); const lg = el('div', 'strip');
    lg.append(stat('Working', short(t.work)), stat('Blocked on you', short(t.blocked), t.blocked > 600000 ? 'warn' : ''), stat('Failing', short(t.failing), t.failing > 600000 ? 'bad' : ''));
    f.append(ring(t.work, t.blocked, t.failing), lg); c.append(f);
    const k = el('div', 'strip'); k.style.marginTop = '12px';
    k.append(stat('Your active time', short(t.active)), stat('Est. cost', '≈' + money(t.est)), stat('Commits', String(t.commits)));
    c.append(k);
    v.append(c);
    if (t.projects.length) { const p = el('section', 'card'); p.append(el('h2', null, 'Projects')); for (const r of t.projects) { const row = el('div', 'row'); const top = el('div', 'r'); top.append(el('b', null, r.project), el('span', 'num', '≈' + money(r.est))); row.append(top, el('div', 'dim', short(r.active) + ' active, ' + r.tools + ' tool calls')); p.append(row); } v.append(p); }
    const lm = limits(); if (lm) v.append(lm);
  }
  function renderHistory(v) {
    if (!history) { v.append(el('p', 'empty', 'Loading history…')); get('/api/history').then((h) => { history = h; render(); }).catch(() => {}); return; }
    const c = el('section', 'card'); c.append(el('h2', null, history.length + ' sessions'));
    for (const x of history.slice(0, 120)) {
      const row = el(x.gone ? 'div' : 'button', 'row'); if (!x.gone) row.onclick = () => openSession(x.id);
      const top = el('div', 'r'); top.append(el('b', null, x.title), el('span', 'num', x.est != null ? '≈' + money(x.est) : '–'));
      row.append(top, el('div', 'dim', x.project + ' · ' + (x.gone ? 'transcript deleted' : ago(x.lastTs))));
      c.append(row);
    }
    v.append(c);
  }

  // ---------- session sheet: live details on top, history of the session below ----------
  async function openSession(id) {
    sheetId = id; sheetData = null;
    const sh = $('sheet'); sh.hidden = false; renderSheet();
    try { sheetData = await get('/api/session?id=' + encodeURIComponent(id)); } catch { sheetData = { error: true }; }
    if (sheetId === id) renderSheet();
  }
  function renderSheet() {
    const sh = $('sheet'); if (sh.hidden || !sheetId) return;
    const y = sh.scrollTop;
    const back = el('button', 'back', '‹ Back'); back.onclick = () => { sh.hidden = true; sheetId = null; };
    const live = state && state.sessions.find((s) => s.id === sheetId);
    const d = sheetData;
    const parts = [back, el('h1', null, (live && live.title) || (d && d.title) || 'Session')];
    if (live) {
      const m = el('div', 'meta'); [live.project, live.branch && '⎇ ' + live.branch, live.model].filter(Boolean).forEach((x) => m.append(el('span', null, x))); parts.push(m);
      const c = el('section', 'card'); c.append(liveDetail(live, true)); parts.push(c);
    }
    if (!d) parts.push(el('p', 'empty', 'Reading the session…'));
    else if (d.error) parts.push(el('p', 'empty', 'Could not read this session.'));
    else {
      const k = el('div', 'strip'); k.style.margin = '12px 0'; k.append(stat('Est. cost', '≈' + money(d.cost)), stat('Prompts', String(d.prompts)), stat('Tool calls', d.calls + (d.failed ? ' (' + d.failed + ' ✕)' : '')), stat('Active', short(d.active))); parts.push(k);
      const t = el('section', 'card'); t.append(el('h2', null, 'Prompts, newest first'));
      for (const x of d.turns) { const r = el('div', 'turn'); const top = el('div', 'r'); top.append(el('span', 'num', new Date(x.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' · ' + dur(x.dur) + ' · ' + x.tools + ' tools'), el('b', 'num', '≈' + money(x.cost))); r.append(top, el('p', null, x.text)); t.append(r); }
      parts.push(t);
      if (d.tools.length) { const c = el('section', 'card'); c.append(el('h2', null, 'Tools')); for (const x of d.tools) { const r = el('div', 'row'); const top = el('div', 'r'); top.append(el('b', null, x.name), el('span', 'num', x.calls + '×' + (x.failed ? ', ' + x.failed + ' failed' : ''))); r.append(top); c.append(r); } parts.push(c); }
      if (d.subagents.length) { const c = el('section', 'card'); c.append(el('h2', null, 'Subagents')); for (const a of d.subagents) { const r = el('div', 'row'); const top = el('div', 'r'); top.append(el('b', null, a.name || a.type), el('span', 'num', '≈' + money(a.cost))); r.append(top, el('div', 'dim', a.type + ', ' + a.calls + ' calls')); c.append(r); } parts.push(c); }
    }
    sh.replaceChildren(...parts);
    sh.scrollTop = y;
  }

  function render() {
    if (!state) return;
    $('dev').textContent = state.device || '';
    alerts();
    const v = $('view'), fresh = document.createElement('div');
    ({ live: renderLive, today: renderToday, history: renderHistory }[tab])(fresh);
    v.replaceChildren(...fresh.childNodes);
    renderSheet();
  }
  async function poll() {
    clearTimeout(timer);
    // Hold the redraw while text is selected, so reading and copying is not interrupted.
    const sel = window.getSelection ? String(window.getSelection()) : '';
    if (document.visibilityState === 'visible' && !sel) { try { state = await get('/api/state'); render(); } catch { /* next poll */ } }
    timer = setTimeout(poll, 3000);
  }
  for (const b of document.querySelectorAll('.tabs button')) b.onclick = () => {
    tab = b.dataset.tab; if (tab === 'history') history = null;
    for (const x of document.querySelectorAll('.tabs button')) x.setAttribute('aria-selected', String(x === b));
    render(); window.scrollTo(0, 0);
  };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') poll(); });
  poll();
})();
