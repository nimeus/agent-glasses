// Claude Viz webview. Renders what the extension host posts; never reads files itself.
// Layout: an alert strip above four tabs — Live (running work), Today (time, cost, pacing),
// Insights (coach, achievements, recap, failures) and System (machine, worktrees, hooks).
(() => {
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  const open = new Map(Object.entries(saved.open || {}));
  let q = saved.q || '';
  let tab = saved.tab || 'live';
  let snap = null;
  let results = null;
  let pairing = null; // { url, expires, matrix, fingerprint } while a pairing code is shown
  const drafts = new Map(); // unsent text in reply/new-session boxes, kept across redraws
  let dragging = null; // a card being dragged: Live does not redraw under the pointer
  let fullText = null, fullBusy = false, gitData = null, prData = null, prBusy = false;
  let history = null, histRange = saved.histRange || '7d', histProject = saved.histProject || '';
  let insightId = saved.insightId || null, insight = null, insightErr = '', turnSort = saved.turnSort || 'new';
  let histSort = saved.histSort || 'recent';
  const save = () => vscode.setState({ open: Object.fromEntries(open), q, tab, insightId, histRange, histProject, turnSort, histSort });
  const $ = (id) => document.getElementById(id);

  // ---------- small helpers ----------
  const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
  const dur = (ms) => { ms = Math.max(0, ms); const s = Math.floor(ms / 1000); if (s < 60) return s + 's'; const m = Math.floor(s / 60); if (m < 60) return m + 'm ' + String(s % 60).padStart(2, '0') + 's'; return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm'; };
  const hm = (ms) => { const m = Math.round(Math.max(0, ms) / 60000); return m < 60 ? m + 'm' : Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm'; };
  const kt = (n) => n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n);
  const money = (v) => v >= 100 ? '$' + Math.round(v) : '$' + (v || 0).toFixed(2);
  const ago = (ts) => dur(Date.now() - ts) + ' ago';
  /** Long spans read as days: a session resumed over weeks is '24d 16h', not '592h'. */
  const span = (ms) => ms >= 48 * 3600000 ? Math.floor(ms / 86400000) + 'd ' + Math.round((ms % 86400000) / 3600000) + 'h' : hm(ms);
  const until = (ts) => { const ms = ts - Date.now(); return ms <= 0 ? 'now' : hm(ms); };
  const pct = (v) => Math.round(v * 100) + '%';
  const tickOne = (e) => { e.textContent = e.dataset.prefix + dur(Date.now() - Number(e.dataset.since)); };
  const since = (cls, ts, prefix) => { const e = el('span', cls); e.dataset.since = ts; e.dataset.prefix = prefix || ''; tickOne(e); return e; };
  setInterval(() => { document.querySelectorAll('[data-since]').forEach(tickOne); document.querySelectorAll('[data-until]').forEach((e) => { const ms = Number(e.dataset.until) - Date.now(); e.textContent = e.dataset.kind === 'expires' ? (ms > 0 ? 'Expires in ' + dur(ms) : 'Expired: press New code') : ms > 0 ? 'warm ' + hm(ms) : 'cold'; }); }, 1000);

  function bar(p, cls) { const i = el('i', 'bar' + (cls ? ' ' + cls : '')); const s = el('span'); s.style.width = Math.max(0, Math.min(100, p * 100)) + '%'; i.append(s); return i; }
  function button(label, cls, title, onClick) { const b = el('button', cls, label); if (title) b.title = title; b.onclick = onClick; return b; }
  function disclose(key, def, cls) {
    const d = el('details', cls);
    d.open = open.has(key) ? open.get(key) : def;
    d.addEventListener('toggle', () => { open.set(key, d.open); save(); });
    return d;
  }
  /** A titled card. `meta` is a short right-aligned note; `id` lets other views jump to it. */
  function card(title, meta, id) {
    const c = el('section', 'card'); if (id) c.id = 'card-' + id;
    const h = el('header'); h.append(el('h2', null, title)); if (meta) h.append(el('span', 'cm', meta));
    c.append(h); return c;
  }
  /** Shows the first `n` items and a "Show all" toggle for the rest. */
  function limited(key, items, n, render) {
    const box = el('div');
    const all = open.get('all:' + key);
    for (const it of all ? items : items.slice(0, n)) box.append(render(it));
    if (items.length > n) box.append(button(all ? 'Show fewer' : 'Show all ' + items.length, 'more-btn', null, () => { open.set('all:' + key, !all); save(); render0(); }));
    return box;
  }
  function donut(parts, size, label, sub) {
    const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg'), r = 15.9155, total = parts.reduce((a, p) => a + p.v, 0);
    svg.setAttribute('viewBox', '0 0 36 36'); svg.setAttribute('width', size); svg.setAttribute('height', size); svg.setAttribute('class', 'donut'); svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', parts.map((p) => p.cls + ' ' + Math.round(total ? p.v / total * 100 : 0) + '%').join(', '));
    const ring = (cls, len, off) => { const c = document.createElementNS(ns, 'circle'); c.setAttribute('cx', 18); c.setAttribute('cy', 18); c.setAttribute('r', r); c.setAttribute('class', cls); c.setAttribute('stroke-dasharray', len + ' ' + (100 - len)); c.setAttribute('stroke-dashoffset', 25 - off); return c; };
    svg.append(ring('track', 100, 0));
    let off = 0;
    if (total) for (const p of parts) { const len = p.v / total * 100; if (len > 0.3) svg.append(ring(p.cls, len, off)); off += len; }
    const text = (cls, y, s) => { const t = document.createElementNS(ns, 'text'); t.setAttribute('x', 18); t.setAttribute('y', y); t.setAttribute('class', cls); t.textContent = s; svg.append(t); };
    if (label != null) text('dl', sub ? 18.5 : 20.5, label);
    if (sub) text('ds', 24, sub);
    return svg;
  }
  function spark(bins) {
    const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg'), max = Math.max(1, ...bins);
    svg.setAttribute('class', 'spark'); svg.setAttribute('width', '60'); svg.setAttribute('height', '16'); svg.setAttribute('aria-label', 'Tool calls, last 10 minutes');
    bins.forEach((v, i) => { const r = document.createElementNS(ns, 'rect'), h = v ? Math.max(2, Math.round(v / max * 16)) : 1; r.setAttribute('x', i * 3); r.setAttribute('y', 16 - h); r.setAttribute('width', 2); r.setAttribute('height', h); r.setAttribute('opacity', v ? 1 : 0.25); svg.append(r); });
    return svg;
  }
  function doing(a) {
    if (a.needs) return a.needs;
    if (a.state === 'tool') return a.current.name + (a.current.hint ? ': ' + a.current.hint : '');
    if (a.state === 'thinking') return 'Thinking';
    if (a.state === 'replied') return 'Finished, waiting for you';
    return 'Finished';
  }
  const stateTs = (a) => (a.state === 'tool' && a.current ? a.current.ts : a.lastTs);

  // ---------- tool details drawer ----------
  let lastFocus = null;
  function askDetail(sid, aid, tool) { if (!tool) return; showDrawer({ loading: true }); vscode.postMessage({ sid, aid, tool }); }
  function showDrawer(d) {
    let dr = $('drawer');
    if (!dr) { dr = el('aside'); dr.id = 'drawer'; dr.setAttribute('role', 'dialog'); dr.setAttribute('aria-label', 'Tool call details'); document.body.append(dr); }
    if (d.loading) lastFocus = document.activeElement;
    dr.hidden = false; dr.replaceChildren();
    const head = el('div', 'dh'), close = button('Close', 'btn', null, hideDrawer);
    if (d.loading) { head.append(el('b', null, 'Loading…'), close); dr.append(head); close.focus(); return; }
    if (!d.detail) { head.append(el('b', null, 'This call is no longer in the recent part of the transcript.'), close); dr.append(head); close.focus(); return; }
    const x = d.detail;
    head.append(el('span', 'st ' + (x.ok === null ? 'run' : x.ok ? 'ok' : 'bad')), el('b', 'mono', x.name), el('span', 'dim', x.agent + ', ' + (x.ok === null ? 'running' : dur(x.ms))), close);
    dr.append(head, el('h3', null, 'Input'), el('pre', null, x.input), el('h3', null, x.ok === false ? 'Error' : 'Output'), el('pre', x.ok === false ? 'err' : null, x.output || (x.ok === null ? 'Still running.' : '(empty)')));
    close.focus();
  }
  function hideDrawer() { const dr = $('drawer'); if (dr && !dr.hidden) { dr.hidden = true; if (lastFocus && lastFocus.focus) lastFocus.focus(); } }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { hideDrawer(); document.querySelectorAll('details.menu[open]').forEach((m) => { m.open = false; }); } });

  // ---------- celebrations: one quiet message at a time ----------
  const cheers = [];
  let cheering = false;
  function cheer(c) {
    cheers.push(c);
    if (cheering) return;
    const next = () => {
      const x = cheers.shift();
      if (!x) { cheering = false; return; }
      cheering = true;
      let t = $('cheer');
      if (!t) { t = el('div'); t.id = 'cheer'; t.setAttribute('role', 'status'); t.setAttribute('aria-live', 'polite'); document.body.append(t); }
      t.className = 'k-' + x.kind;
      t.replaceChildren(el('span', 'ico', { commit: '✓', green: '●', sub: '◆', badge: '★' }[x.kind] || '✓'), el('span', null, x.text));
      if (!matchMedia('(prefers-reduced-motion: reduce)').matches) for (let i = 0; i < 12; i++) { const sp = el('i', 'spark'); sp.style.setProperty('--a', (i / 12 * 360) + 'deg'); sp.style.setProperty('--d', (22 + (i % 3) * 10) + 'px'); t.append(sp); }
      t.hidden = false;
      setTimeout(() => { t.hidden = true; setTimeout(next, 250); }, 3200);
    };
    next();
  }

  // ---------- tabs and alerts ----------
  const TABS = [['live', 'Live'], ['today', 'Today'], ['history', 'History'], ['insights', 'Insights'], ['system', 'System']];
  function tabs() {
    const nav = $('tabs'); nav.replaceChildren();
    const running = snap ? snap.sessions.filter((s) => s.running).length : 0;
    const sys = snap && snap.system;
    const free = snap && snap.worktrees ? (snap.worktrees.repos || []).flatMap((r) => r.trees).filter((t) => t.removable).length : 0;
    const badge = { live: running ? String(running) : '', system: (sys && sys.level !== 'ok') || free ? '!' : '' };
    for (const [id, label] of TABS) {
      const b = el('button', 'tab', label); b.setAttribute('role', 'tab'); b.id = 'tab-' + id;
      b.setAttribute('aria-selected', String(id === tab && !insightId)); b.tabIndex = id === tab ? 0 : -1;
      if (badge[id]) b.append(el('span', 'tb' + (badge[id] === '!' ? ' warn' : ''), badge[id]));
      b.onclick = () => { tab = id; insightId = null; save(); if (id === 'history') vscode.postMessage({ history: true }); render0(); window.scrollTo(0, 0); };
      b.onkeydown = (e) => {
        const i = TABS.findIndex((t) => t[0] === tab);
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { tab = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length][0]; save(); render0(); $('tab-' + tab).focus(); }
      };
      nav.append(b);
    }
  }
  /** Only what needs attention now; everything else lives in its tab. */
  function alerts() {
    const box = $('alerts'); box.replaceChildren();
    if (!snap) return;
    const add = (kind, text, action, go) => { const a = el('div', 'alert ' + kind); a.append(el('span', null, text)); if (action) a.append(button(action, 'btn small', null, go)); box.append(a); };
    for (const s of snap.sessions) if (s.needs) add('warn', (s.title || s.project) + ': ' + s.needs, 'Show', () => vscode.postMessage({ show: s.id }));
    const rl = snap.sessions.find((s) => s.rateLimit);
    if (rl) add('bad', rl.rateLimit);
    const sys = snap.system;
    if (sys && sys.level === 'bad') add('bad', 'Machine under pressure: ' + [sys.ag === 'bad' && 'too many agents', sys.disk === 'bad' && 'disk almost full', sys.mem === 'bad' && 'memory low', sys.swap === 'bad' && 'heavy swap use', sys.cpu === 'bad' && 'CPU overloaded'].filter(Boolean).join(', '), 'Details', () => { tab = 'system'; save(); render0(); });
    for (const s of snap.sessions) for (const a of [s, ...s.subs]) if (a.stuck) add('warn', (a.name || a.title || s.project) + ' may be stuck: ' + a.stuck, 'Show', () => { tab = 'live'; save(); render0(); const e = $('sess-' + s.id); if (e) e.scrollIntoView({ block: 'start' }); });
  }

  // ---------- machine ----------
  function line(values, cls) {
    const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg'), w = 48, h = 14;
    svg.setAttribute('class', 'mini ' + (cls || '')); svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('aria-hidden', 'true');
    if (values && values.length > 1) {
      const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - Math.max(0, Math.min(1, v)) * (h - 2) - 1]);
      const area = document.createElementNS(ns, 'polygon'); area.setAttribute('points', '0,' + h + ' ' + pts.map((p2) => p2.join(',')).join(' ') + ' ' + w + ',' + h); area.setAttribute('class', 'area'); svg.append(area);
      const pl = document.createElementNS(ns, 'polyline'); pl.setAttribute('points', pts.map((p2) => p2.join(',')).join(' ')); svg.append(pl);
    }
    return svg;
  }
  const gb = (v) => (v >= 10 ? Math.round(v) : v.toFixed(1)) + ' GB';
  /** Six small tiles at the top of Live; the whole strip opens the System tab. */
  function machineStrip() {
    const s = snap.system;
    if (!s) return null;
    const strip = el('button', 'mstrip ' + s.level); strip.title = 'Machine details'; strip.onclick = () => { tab = 'system'; save(); render0(); };
    const tile = (label, value, sub, level, graph, title) => { const t = el('div', 'mt ' + level); t.title = title || ''; t.append(el('span', 'kl', label), el('b', 'num', value)); t.append(graph || el('span', 'ms', sub || '\u00a0')); return t; };
    strip.append(
      tile('CPU', s.cpuPct != null ? pct(s.cpuPct) : pct(s.load), null, s.cpu, line(s.hist && s.hist.cpu, s.cpu), s.cores + ' cores; load average ' + s.load.toFixed(2) + ' per core'),
      tile('Memory', gb(s.memUsedGb), null, s.mem, line(s.hist && s.hist.mem, s.mem), gb(s.memUsedGb) + ' of ' + Math.round(s.memTotalGb) + ' GB used' + (s.compressedGb ? ', ' + gb(s.compressedGb) + ' compressed' : '') + (s.memFreePct != null ? '. ' + s.memFreePct + '% available.' : '')),
      tile('Swap', s.swapUsedGb != null ? gb(s.swapUsedGb) : '–', s.swapTotalGb ? 'of ' + gb(s.swapTotalGb) : '', s.swap, null, 'Swap grows when memory runs short; with a nearly full disk it can hang the machine.'),
      tile('Disk free', s.diskFreeGb != null ? gb(s.diskFreeGb) : '–', s.diskTotalGb ? 'of ' + gb(s.diskTotalGb) : '', s.disk, null, 'Keep at least ' + s.diskWarnGb + ' GB free'),
      tile('Claude', s.procs.claude.n + ' procs', gb(s.procs.claude.gb), 'ok', null, s.procs.claude.n + ' Claude Code processes using ' + gb(s.procs.claude.gb) + '; ' + s.procs.node.n + ' Node processes using ' + gb(s.procs.node.gb)),
      tile('Agents', s.agents + ' / ' + s.cap, 'subagents', s.ag, null, 'Subagents running now, out of CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS'));
    return strip;
  }

  // ---------- Markdown, rendered as DOM nodes (never innerHTML), so transcript text cannot run as code ----------
  function inline(parent, text) {
    const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\((https?:\/\/[^)\s]+)\))|(\*[^*\s\n][^*\n]*\*)|(_[^_\s\n][^_\n]*_)|(https?:\/\/[^\s<>()]+[^\s<>().,;:])/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.append(document.createTextNode(text.slice(last, m.index)));
      if (m[1]) parent.append(el('code', null, m[1].slice(1, -1)));
      else if (m[2]) parent.append(el('strong', null, m[2].slice(2, -2)));
      else if (m[3]) { const a = button(m[3].slice(1, m[3].indexOf('](')), 'link mdlink', m[4], () => vscode.postMessage({ openLink: m[4] })); parent.append(a); }
      else if (m[5] || m[6]) parent.append(el('em', null, (m[5] || m[6]).slice(1, -1)));
      else if (m[7]) { const u = m[7]; parent.append(button(u, 'link mdlink', u, () => vscode.postMessage({ openLink: u }))); }
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
      if (/^#{1,6}\s/.test(l)) { const h = el('div', 'mh mh' + Math.min(3, l.match(/^#+/)[0].length)); inline(h, l.replace(/^#+\s*/, '')); root.append(h); i++; continue; }
      if (/^\s*(---|\*\*\*|___)\s*$/.test(l)) { root.append(el('hr')); i++; continue; }
      if (/^\s*>/.test(l)) { const q = el('blockquote'); const buf = []; while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, '')); q.append(md(buf.join('\n'))); root.append(q); continue; }
      if (isTable(l) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
        const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((x) => x.trim());
        const t = el('table', 'mdt'), hr = el('tr'); for (const c of cells(l)) { const th = el('th'); inline(th, c); hr.append(th); } t.append(hr); i += 2;
        while (i < lines.length && isTable(lines[i])) { const tr = el('tr'); for (const c of cells(lines[i])) { const td = el('td'); inline(td, c); tr.append(td); } t.append(tr); i++; }
        const wrap = el('div', 'mdt-wrap'); wrap.append(t); root.append(wrap); continue;
      }
      if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
        const ordered = /^\s*\d/.test(l), list = el(ordered ? 'ol' : 'ul');
        while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
          const indent = lines[i].match(/^\s*/)[0].length, li = el('li'); if (indent >= 2) li.className = 'nested';
          inline(li, lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, '')); list.append(li); i++;
          while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) { li.append(document.createTextNode(' ')); inline(li, lines[i].trim()); i++; }
        }
        root.append(list); continue;
      }
      if (!l.trim()) { i++; continue; }
      const p = el('p'), buf = [];
      while (i < lines.length && lines[i].trim() && !/^\s*(```|#{1,6}\s|>|([-*+]|\d+[.)])\s+)/.test(lines[i]) && !isTable(lines[i])) buf.push(lines[i++]);
      inline(p, buf.join(' ')); root.append(p);
    }
    return root;
  }
  const plain = (t) => String(t).replace(/```[\s\S]*?```/g, ' [code] ').replace(/[#>*_`|]/g, ' ').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\s+/g, ' ').trim();

  /** "You asked" / "Claude said": a two-line preview that expands to the full text as Markdown. */
  function message(kind, label, text, key) {
    const expanded = !!open.get(key);
    const box = el('div', 'msg ' + kind + (expanded ? ' open' : ''));
    const head = el('div', 'msg-h');
    head.append(el('span', 'kl', label));
    const tools = el('span', 'msg-tools');
    const copy = button('Copy', 'link hint small', 'Copy the full text', () => { navigator.clipboard?.writeText(text).catch(() => {}); copy.textContent = 'Copied'; });
    const tog = button(expanded ? 'Show less' : 'Show all', 'link hint small', null, () => { open.set(key, !expanded); save(); render0(); });
    tog.setAttribute('aria-expanded', String(expanded));
    tools.append(copy, tog);
    head.append(tools);
    box.append(head);
    if (expanded) box.append(md(text));
    else { const pv = el('div', 'msg-p', plain(text)); pv.onclick = () => { open.set(key, true); save(); render0(); }; box.append(pv); }
    return box;
  }

  // ---------- replies and new sessions ----------
  /** A one-line reply: opens the session in its Claude tab with the text typed in, ready to send. */
  function replyBox(s) {
    const f = el('form', 'reply');
    const inp = el('input'); inp.type = 'text'; inp.placeholder = s.needs ? 'Answer in Claude…' : 'Reply…'; inp.setAttribute('aria-label', 'Reply to ' + (s.title || 'this session')); inp.maxLength = 8000;
    inp.dataset.draft = 'r:' + s.id; inp.value = drafts.get('r:' + s.id) || ''; inp.oninput = () => drafts.set('r:' + s.id, inp.value);
    const b = el('button', 'btn small', 'Open with reply'); b.type = 'submit'; b.title = 'Opens this session in its Claude tab with your text typed in; press Enter there to send';
    f.append(inp, b);
    f.onsubmit = (e) => { e.preventDefault(); if (!inp.value.trim()) return; vscode.postMessage({ reply: s.id, text: inp.value }); inp.value = ''; drafts.delete('r:' + s.id); inp.blur(); };
    return f;
  }
  function newSessionBox() {
    const f = el('form', 'reply newsess');
    const inp = el('input'); inp.type = 'text'; inp.placeholder = 'Start a new Claude session…'; inp.setAttribute('aria-label', 'Prompt for a new Claude session'); inp.maxLength = 8000;
    inp.dataset.draft = 'new'; inp.value = drafts.get('new') || ''; inp.oninput = () => drafts.set('new', inp.value);
    const b = el('button', 'btn small', 'Start'); b.type = 'submit'; b.title = 'Opens a new Claude session with this prompt typed in';
    f.append(inp, b);
    f.onsubmit = (e) => { e.preventDefault(); if (!inp.value.trim()) return; vscode.postMessage({ newPrompt: inp.value }); inp.value = ''; drafts.delete('new'); inp.blur(); };
    return f;
  }

  // ---------- Live ----------
  function limitsStrip() {
    const acc = snap.account, f = snap.stats && snap.stats.forecast;
    const rows = [];
    if (acc && acc.fiveHour) rows.push(['5-hour', acc.fiveHour.pct, acc.fiveHour.resetsAt, '']);
    if (acc && acc.sevenDay) rows.push(['Week', acc.sevenDay.pct, acc.sevenDay.resetsAt, '']);
    if (!rows.length && f && f.cap) rows.push(['5-hour', f.pct, f.pace ? f.pace.end : 0, 'est.']);
    const wk = snap.derived && snap.derived.weekly;
    if (!(acc && acc.sevenDay) && wk && wk.valid) rows.push(['Week', wk.pct, 0, 'est.']);
    if (!rows.length) return null;
    const box = el('div', 'limits');
    box.title = acc ? 'Plan usage reported by Claude Code ' + ago(acc.at) : 'Estimated from token counts; exact plan usage appears once Claude Code refreshes its status line.';
    for (const [name, p, reset, note] of rows) {
      const r = el('div', 'lim' + (p > 0.9 ? ' bad' : p > 0.7 ? ' warn' : ''));
      r.append(el('span', 'ln', name), bar(p), el('b', 'num', pct(p)), el('span', 'dim', (reset ? 'resets in ' + until(reset) : '') + (note ? ' ' + note : '')));
      box.append(r);
    }
    return box;
  }
  function crew() {
    const agents = snap.sessions.filter((s) => s.running).flatMap((s) => [{ s, a: s, name: s.title || s.prompt || 'Session', sub: false }, ...s.subs.map((a) => ({ s, a, name: a.name || a.id, sub: true }))]);
    if (agents.length < 3) return null; // with one or two agents the cards say it all
    const grid = el('div', 'crew');
    for (const c of agents) {
      const fl = c.a.flow || { work: 0, blocked: 0, failing: 0 }, tot = fl.work + fl.blocked + fl.failing;
      const t = el('button', 'tile ' + (c.a.needs ? 'needs' : c.a.state));
      t.title = c.name + '. Last 30 minutes: working ' + hm(fl.work) + ', blocked ' + hm(fl.blocked) + ', failing ' + hm(fl.failing) + '.';
      t.onclick = () => { const e = $('sess-' + c.s.id); if (e) e.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
      t.append(donut([{ v: fl.work, cls: 'work' }, { v: fl.blocked, cls: 'blocked' }, { v: fl.failing, cls: 'failing' }], 30, tot ? String(Math.round(fl.work / tot * 100)) : ''));
      const tx = el('div', 'tt'); tx.append(el('b', null, (c.sub ? '↳ ' : '') + c.name), el('span', null, doing(c.a)));
      t.append(tx); grid.append(t);
    }
    return grid;
  }
  function toolRows(tools, sid, aid) {
    const ul = el('ul', 'rows');
    for (const t of tools) {
      const li = el('li', 'tool');
      const st = el('span', 'st ' + (t.ok === null ? 'run' : t.ok ? 'ok' : 'bad')); st.title = t.ok === null ? 'Running' : t.ok ? 'Succeeded' : 'Failed';
      const nb = button(t.name, 'link mono', 'Show input and output', () => askDetail(sid, aid, t.id));
      const h = t.file ? button(t.hint, 'link hint', t.file, () => vscode.postMessage({ file: t.file })) : el('span', 'hint', t.hint);
      if (!t.file) h.title = t.hint;
      li.append(st, nb, h, t.ok === null ? since('dim num', t.ts) : el('span', 'dim num', t.ms ? dur(t.ms) : ''));
      ul.append(li);
    }
    return ul;
  }
  function lanes(s) {
    const W = 15 * 60000, now = Date.now(), ns = 'http://www.w3.org/2000/svg';
    const rows = [{ aid: '', name: 'Main', items: s.timeline, think: s.thinking, marks: s.compactions }, ...s.subs.map((a) => ({ aid: a.id, name: a.name || a.id, items: a.timeline, think: a.thinking, marks: a.compactions }))];
    if (!rows.some((r) => r.items.length || (r.think || []).length)) return null;
    const box = el('div', 'lanes');
    const xOf = (ts) => (ts - (now - W)) / W * 1000;
    for (const r of rows) {
      const lane = el('div', 'lane'), ln = el('span', 'ln', r.name); ln.title = r.name;
      const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', '0 0 1000 10'); svg.setAttribute('preserveAspectRatio', 'none');
      svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', r.name + ': ' + r.items.length + ' tool calls in the last 15 minutes');
      const rect = (x, y, w, h, cls, tip, click) => { const e = document.createElementNS(ns, 'rect'); e.setAttribute('x', Math.max(0, x)); e.setAttribute('y', y); e.setAttribute('width', w); e.setAttribute('height', h); e.setAttribute('class', cls); const tt = document.createElementNS(ns, 'title'); tt.textContent = tip; e.append(tt); if (click) e.addEventListener('click', click); svg.append(e); };
      for (const t of r.think || []) if (xOf(t.ts + t.ms) > 0) rect(xOf(t.ts), 3, Math.max(2, t.ms / W * 1000), 4, 'think', 'Thinking ' + dur(t.ms));
      for (const t of r.items) { const x = xOf(t.ts), w = Math.max(3, t.ms / W * 1000); if (x + w < 0) continue; rect(x, 0, w, 10, (t.ok === null ? 'run' : t.ok ? 'ok' : 'bad') + (t.c ? ' commit' : ''), t.n + (t.h ? ': ' + t.h : '') + ' (' + dur(t.ms) + '). Click for details.', () => askDetail(s.id, r.aid, t.id)); }
      for (const c of r.marks || []) if (xOf(c.ts) >= 0) rect(xOf(c.ts), 0, 4, 10, 'compact', 'Context compacted: ' + kt(c.pre) + ' → ' + kt(c.post) + ' tokens');
      lane.append(ln, svg); box.append(lane);
    }
    const ax = el('div', 'axis'), sc = el('div'); ['15m', '10m', '5m', 'now'].forEach((x) => sc.append(el('span', null, x)));
    ax.append(el('span'), sc); box.append(ax);
    return box;
  }
  function menu(s) {
    const pinned = (snap.pinned || []).includes(s.id), muted = (snap.muted || []).includes(s.id);
    const m = disclose('m:' + s.id, false, 'menu');
    const sum = el('summary', 'icon-btn', '⋯'); sum.setAttribute('aria-label', 'Session actions'); sum.title = 'Session actions';
    const list = el('div', 'menu-list'); list.setAttribute('role', 'menu');
    const item = (label, act) => { const b = button(label, 'menu-item', null, () => { m.open = false; open.set('m:' + s.id, false); save(); vscode.postMessage({ sid: s.id, act }); }); b.setAttribute('role', 'menuitem'); return b; };
    const ins = button('Session insights', 'menu-item', null, () => { m.open = false; open.set('m:' + s.id, false); openInsight(s.id); }); ins.setAttribute('role', 'menuitem');
    list.append(ins);
    if (!s.running) { const rc = button('Continue on phone', 'menu-item', null, () => { m.open = false; open.set('m:' + s.id, false); save(); vscode.postMessage({ sid: s.id, act: 'remote' }); }); rc.title = 'Opens a terminal running this session with Remote Control, so you can carry on in the Claude phone app'; rc.setAttribute('role', 'menuitem'); list.append(rc); }
    list.append(item(pinned ? 'Unpin' : 'Pin to top', 'pin'), item(muted ? 'Unmute alerts' : 'Mute alerts', 'mute'), item('Copy resume command', 'resume'), item('Open transcript', 'transcript'));
    const visible = snap.sessions.map((x) => x.id), at = visible.indexOf(s.id);
    if (at >= 0 && visible.length > 1) {
      const move = (label, to) => { const b = button(label, 'menu-item', null, () => { m.open = false; open.set('m:' + s.id, false); save(); const ids = visible.filter((x) => x !== s.id); ids.splice(Math.max(0, Math.min(ids.length, to)), 0, s.id); vscode.postMessage({ order: ids }); }); b.setAttribute('role', 'menuitem'); return b; };
      if (at > 0) list.append(move('Move to top', 0), move('Move up', at - 1));
      if (at < visible.length - 1) list.append(move('Move down', at + 1));
    }
    if (!s.running) list.append((snap.hidden || []).includes(s.id) ? item('Unhide', 'unhide') : item(pinned ? 'Unpin and hide' : 'Hide', 'hide'));
    m.append(sum, list);
    return m;
  }
  function session(s, compact) {
    const pinned = (snap.pinned || []).includes(s.id), muted = (snap.muted || []).includes(s.id);
    const c = el('article', 'sess ' + (s.needs ? 'needs' : s.state) + (compact ? ' compact' : '')); c.id = 'sess-' + s.id;

    const head = el('div', 'sh');
    if (!compact && snap.sessions.length > 1) {
      const h = el('span', 'grip', '⠿'); h.title = 'Drag to reorder'; h.setAttribute('aria-hidden', 'true'); head.append(h);
      c.draggable = true;
      c.addEventListener('dragstart', (e) => { dragging = s.id; c.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', s.id); });
      c.addEventListener('dragend', () => { dragging = null; c.classList.remove('dragging'); document.querySelectorAll('.sess.drop-before,.sess.drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after')); render0(); });
      c.addEventListener('dragover', (e) => { if (!dragging || dragging === s.id) return; e.preventDefault(); const r = c.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2; c.classList.toggle('drop-after', after); c.classList.toggle('drop-before', !after); });
      c.addEventListener('dragleave', () => c.classList.remove('drop-before', 'drop-after'));
      c.addEventListener('drop', (e) => {
        e.preventDefault(); if (!dragging || dragging === s.id) return;
        const after = c.classList.contains('drop-after'), ids = snap.sessions.map((x) => x.id).filter((x) => x !== dragging);
        ids.splice(ids.indexOf(s.id) + (after ? 1 : 0), 0, dragging);
        vscode.postMessage({ order: ids });
      });
    }
    head.append(el('span', 'dot'));
    head.append(button(s.title || s.prompt || 'Untitled session', 'title', 'Show this session in its Claude tab', () => vscode.postMessage({ show: s.id })));
    if (pinned) { const i = el('span', 'flag', '📌'); i.title = 'Pinned'; head.append(i); }
    if (muted) { const i = el('span', 'flag', '🔕'); i.title = 'Alerts muted'; head.append(i); }
    head.append(menu(s));
    if (!s.running && !(snap.hidden || []).includes(s.id)) { const x = button('×', 'icon-btn', 'Hide this session (it comes back if it runs again)', () => vscode.postMessage({ sid: s.id, act: 'hide' })); x.setAttribute('aria-label', 'Hide session'); head.append(x); }
    c.append(head);

    const sub = el('div', 'subline');
    sub.append(el('span', null, s.project));
    if (s.branch && s.branch !== 'HEAD') sub.append(el('span', null, '⎇ ' + s.branch));
    if (s.model) sub.append(el('span', null, s.model));
    c.append(sub);

    // What it is working on: the start of the user's latest prompt.
    const ask = s.lastPrompt || s.prompt;
    if (ask) c.append(message('you', 'You asked', ask, 'ask:' + s.id));

    // The three numbers worth a glance: this turn, cost, context.
    const k = el('div', 'kpis');
    if (s.turnStart) { const x = el('div', 'kpi'); if (s.running) x.append(el('span', 'kl', 'This turn'), since('kv num', s.turnStart)); else x.append(el('span', 'kl', 'Last turn took'), el('span', 'kv num', dur(Math.max(0, s.lastTs - s.turnStart)))); k.append(x); }
    if (s.costEst != null) { const x = el('div', 'kpi'); x.title = 'Estimated at API prices' + (s.costSubs ? ', including ' + s.costSubs + ' subagents' : '') + (s.costPartial ? '; very long transcript, only its last 20 MB counted' : '') + (s.runCost != null ? '. Claude Code reports ' + money(s.runCost) + ' for its current run.' : ''); x.append(el('span', 'kl', 'Session cost'), el('span', 'kv num', '≈' + money(s.costEst) + (s.costPartial ? '+' : ''))); k.append(x); }
    if (s.cacheInfo && s.cacheInfo.hit) {
      const ci = s.cacheInfo, x = el('div', 'kpi' + (ci.warmLeft ? '' : ' warn'));
      x.title = pct(ci.hit) + ' of recent input came from the prompt cache (' + (ci.ttl >= 3600000 ? '1-hour' : '5-minute') + ' cache).' + (ci.missCount ? ' ' + ci.missCount + ' misses in the recent part of this session.' : '') + ' After the cache goes cold, the next reply re-reads the whole conversation at full price.';
      x.append(el('span', 'kl', 'Cache'));
      if (ci.warmLeft) { const t = el('span', 'kv num'); t.dataset.until = Date.now() + ci.warmLeft; t.textContent = 'warm ' + hm(ci.warmLeft); x.append(t); }
      else x.append(el('span', 'kv num', 'cold'));
      k.append(x);
    }
    if (s.context) { const p = s.contextPct, x = el('div', 'kpi ctx' + (p > 0.9 ? ' bad' : p > 0.7 ? ' warn' : '')); x.title = kt(s.context) + ' tokens in context'; x.append(el('span', 'kl', 'Context'), el('span', 'kv num', pct(p)), bar(p)); k.append(x); }
    c.append(k);

    const now = el('div', 'now');
    now.append(el('span', 'what', doing(s)), since('num', stateTs(s)), spark(s.spark));
    c.append(now);
    if (s.said) c.append(message('claude', 'Claude said', s.said, 'said:' + s.id));

    const tl = compact ? null : lanes(s);
    if (tl) c.append(tl);

    if (s.subs.length) {
      const box = el('div', 'subs');
      for (const a of s.subs) {
        const row = el('div', 'subrow ' + a.state); if (a.depth) row.style.paddingLeft = (Math.min(4, a.depth) * 14) + 'px';
        row.append(el('span', 'dot'));
        const nm = el('span', 'nm', a.name || a.id); nm.title = (a.parent ? 'Started by ' + a.parent + '. ' : '') + (a.worktree ? 'Worktree ' + a.worktree + '. ' : '') + a.total + ' tool calls' + (a.errors ? ', ' + a.errors + ' failed' : '');
        row.append(nm, el('span', 'kind', a.type), el('span', 'doing', doing(a)), since('dim num', a.start));
        box.append(row);
      }
      c.append(box);
    }

    const more = disclose('more:' + s.id, pinned, 'more');
    more.append(el('summary', null, 'More'));
    const facts = el('div', 'facts');
    const fact = (label, value, title) => { const f = el('div'); f.append(el('span', 'kl', label), el('span', null, value)); if (title) f.title = title; facts.append(f); };
    fact('Tool calls', s.total + (s.errors ? ', ' + s.errors + ' failed' : ''));
    if (s.cache) fact('From cache', pct(s.cache), 'Share of the last request read from the prompt cache');
    if (s.think) fact('Thinking', dur(s.think), 'Reasoning time in recent turns');
    if (s.compactions.length) { const lc = s.compactions[s.compactions.length - 1]; fact('Compacted', s.compactions.length + '×', 'Last ' + ago(lc.ts) + ': ' + kt(lc.pre) + ' → ' + kt(lc.post) + ' tokens'); }
    more.append(facts, el('h3', null, 'Recent tool calls'), toolRows(s.tools, s.id, ''));
    for (const a of s.subs) if (a.tools.length) more.append(el('h3', null, a.name || a.id), toolRows(a.tools, s.id, a.id));
    const files = [...s.files, ...s.subs.flatMap((a) => a.files)];
    if (files.length) {
      more.append(el('h3', null, 'Files edited'));
      const ul = el('ul', 'rows');
      for (const f of files) { const li = el('li', 'file'); li.append(button(f.name, 'link hint', f.path + ' (open the change)', () => vscode.postMessage({ file: f.path })), el('span', 'dim num', f.n + '×, ' + ago(f.ts))); if (f.conflict) li.append(el('span', 'chip warn', 'also edited elsewhere')); ul.append(li); }
      more.append(ul);
    }
    c.append(more);
    return c;
  }
  function awayCard(a) {
    if (!a) return null;
    const c = card('While you were away', hm(Date.now() - a.since));
    c.classList.add('accent');
    c.querySelector('header').append(button('Dismiss', 'btn small', null, () => vscode.postMessage({ dismissAway: true })));
    const label = { finished: 'Finished', needs: 'Needs you', stuck: 'May be stuck', limit: 'Usage limit' };
    const ul = el('ul', 'rows');
    for (const e of a.items.slice(-10).reverse()) { const li = el('li', 'evt'); li.append(el('span', 'chip k-' + e.kind, label[e.kind] || e.kind), button(e.title, 'link hint', e.text || e.title, () => vscode.postMessage({ show: e.id })), el('span', 'dim num', ago(e.ts))); ul.append(li); }
    c.append(ul);
    return c;
  }
  function pastCard() {
    if (!results || q.trim().length < 3) return null;
    const c = card('Past sessions', results.length ? 'last 7 days' : 'no match in the last 7 days');
    const ul = el('ul', 'rows');
    for (const r of results) { const li = el('li', 'past'); li.append(button(r.title, 'link strong', 'Session insights', () => openInsight(r.id)), el('div', 'dim', r.project + ', ' + ago(r.lastTs) + (r.snippet ? ': “' + r.snippet + '”' : ''))); ul.append(li); }
    c.append(ul);
    return c;
  }
  /** Sessions that finished within the last 30 minutes, as compact cards, so Live is never a dead end. */
  function recentCards(words) {
    const hid = new Set(snap.hidden || []);
    const all = (snap.recent || []).filter((r) => { const hay = [r.title, r.prompt, r.lastPrompt, r.project, r.branch].join(' ').toLowerCase(); return words.every((w) => hay.includes(w)); });
    const list = all.filter((r) => !hid.has(r.id)), gone = all.filter((r) => hid.has(r.id));
    const out = [];
    if (list.length) {
      const h = el('h2', 'group', 'Recently finished'); const right = el('span', 'cm', 'last 30 minutes ');
      right.append(button('Hide all', 'link hint', 'Hide every finished session listed here', () => vscode.postMessage({ hideAll: true })));
      h.append(right); out.push(h, ...list.map((r) => session(r, true)));
    }
    if (gone.length) {
      const showing = open.get('showHidden');
      out.push(button(gone.length + ' hidden · ' + (showing ? 'Hide them again' : 'Show'), 'more-btn', null, () => { open.set('showHidden', !showing); save(); render0(); }));
      if (showing) out.push(...gone.map((r) => session(r, true)));
    }
    return out;
  }
  function renderLive(view) {
    const needle = q.toLowerCase(), words = needle.split(/\s+/).filter(Boolean);
    const list = snap.sessions.filter((s) => { const hay = [s.title, s.prompt, s.project, s.branch].join(' ').toLowerCase(); return words.every((w) => hay.includes(w)); }).filter((s) => s.running || !(snap.hidden || []).includes(s.id));
    const parts = [awayCard(snap.away), machineStrip(), limitsStrip(), crew()];
    if (!snap.sessions.some((s) => s.running)) { const e = el('div', 'empty'); e.append(el('b', null, 'Nothing running right now'), el('span', null, (snap.recent || []).length || snap.sessions.length ? 'Pinned and recently finished sessions are below.' : 'Start a Claude Code session and it appears here.')); parts.push(e); }
    else if (!list.length && q) parts.push(el('div', 'empty', 'No running session matches “' + q + '”.'));
    const rc = el('div', 'acts'); rc.append(button('Start a phone session', 'btn small ghost', 'Opens a terminal running Claude Code with Remote Control; the session appears in the Claude phone app', () => vscode.postMessage({ remoteNew: true })));
    view.append(...parts.filter(Boolean), ...list.map((x) => session(x)), ...recentCards(words), ...[pastCard()].filter(Boolean), newSessionBox(), rc);
  }

  // ---------- Today ----------
  function renderToday(view) {
    const st = snap.stats;
    if (!st) { view.append(el('div', 'empty', 'Reading today’s activity…')); return; }
    const t = st.days[st.days.length - 1], tot = t.work + t.blocked + t.failMs;

    const flow = card('Agent time today', tot ? pct(t.work / tot) + ' flow' : '');
    flow.append(el('p', 'dim small', 'All agents added up: five subagents working for an hour count as five hours. Flow is the share spent working rather than blocked on you or failing.'));
    const row = el('div', 'flow');
    row.append(donut([{ v: t.work, cls: 'work' }, { v: t.blocked, cls: 'blocked' }, { v: t.failMs, cls: 'failing' }], 84, tot ? pct(t.work / tot) : '–', 'flow'));
    const lg = el('div', 'legend');
    const li = (cls, label, ms, go) => { const b = el(go ? 'button' : 'div', 'lg ' + cls + (go ? ' link' : '')); b.append(el('i'), el('span', null, label), el('b', 'num', hm(ms))); if (go) { b.title = 'See what caused it'; b.onclick = go; } return b; };
    const toInsights = (id) => () => { tab = 'insights'; save(); render0(); const e = $('card-' + id); if (e) e.scrollIntoView({ block: 'start' }); };
    lg.append(li('work', 'Working', t.work), li('blocked', 'Blocked on you', t.blocked, toInsights('coach')), li('failing', 'Failing', t.failMs, toInsights('fails')));
    row.append(lg); flow.append(row);
    const kp = el('div', 'kpis wide');
    const k = (label, value) => { const x = el('div', 'kpi'); x.append(el('span', 'kl', label), el('span', 'kv num', value)); kp.append(x); };
    k('Your active time', hm(t.active)); k('Est. cost', '≈' + money(t.est)); k('Commits', String(t.commits)); k('Tool calls', String(t.tools));
    kp.title = 'Your active time is wall-clock time with at least one main session working (gaps under 5 minutes).';
    flow.append(kp);
    view.append(flow);

    view.append(pacingCard(st.forecast, snap.account));
    if (snap.derived && snap.derived.budget) view.append(budgetCard(snap.derived.budget));

    const ps = card('Projects', 'today');
    const rows = st.today;
    if (rows.length) {
      const max = Math.max(1, ...rows.map((r) => r.active));
      ps.append(limited('projects', rows, 5, (r) => {
        const d = el('div', 'prow');
        const name = el('div', 'pn'); name.append(el('b', null, r.project), bar(r.active / max, 'thin'));
        d.append(name, el('span', 'num', hm(r.active)), el('span', 'num dim', r.tools + ' calls'), el('span', 'num', '≈' + money(r.est)));
        d.title = r.sessions + ' sessions, ' + r.errors + ' failed calls, ' + r.commits + ' commits';
        return d;
      }));
    } else ps.append(el('p', 'dim', 'Nothing yet today.'));
    view.append(ps);

    if (st.sessionsToday && st.sessionsToday.length) {
      const sc = card('Sessions by cost', 'today and total, at API prices');
      st.sessionsToday.sort((a, b) => b.est - a.est);
      sc.append(limited('sesscost', st.sessionsToday, 5, (r) => {
        const d = el('div', 'prow');
        const name = el('div', 'pn'); name.append(button(r.title.slice(0, 70), 'link strong', 'Session insights: costs, tools, prompts', () => openInsight(r.id)), el('span', 'dim', r.project + (r.subs ? ', ' + r.subs + ' subagents' : '')));
        const cost = el('div', 'cost2');
        cost.append(el('b', 'num', '≈' + money(r.est)), el('span', 'dim num', '≈' + money(r.lifetime) + (r.partial ? '+' : '') + ' total'));
        cost.title = 'Today, then the whole session so far, both including subagents' + (r.partial ? '. Very long transcript: only its last 20 MB counted, so the total is at least this.' : '.');
        d.append(name, el('span', 'num', hm(r.active)), cost);
        return d;
      }));
      sc.append(el('p', 'foot', 'Estimated from token counts with prices learned from Claude Code’s own cost records. On a subscription you are not billed these amounts.'));
      view.append(sc);
    }

    const hc = card('Last 7 days', 'active time by hour');
    const week = st.days.slice(-7), maxH = Math.max(1, ...week.flatMap((x) => x.hours));
    const heat = el('div', 'heat');
    heat.append(el('span'));
    ['00', '06', '12', '18'].forEach((h) => heat.append(el('span', 'hl', h)));
    heat.append(el('span'));
    for (const day of week) {
      heat.append(el('span', 'dl', day.label));
      day.hours.forEach((ms, h) => { const c = el('span', 'c' + (ms ? ' on' : '')); if (ms) c.style.opacity = String(0.25 + 0.75 * (ms / maxH)); c.title = day.label + ' ' + String(h).padStart(2, '0') + ':00, ' + hm(ms); heat.append(c); });
      const r = el('span', 'num r', hm(day.active)); r.title = day.tools + ' tool calls, ≈' + money(day.est); heat.append(r);
    }
    hc.append(heat, button('Open today’s summary', 'btn', 'A Markdown report as an unsaved document', () => vscode.postMessage({ summary: true })));
    view.append(hc);
  }
  function budgetCard(b) {
    const c = card('Budget', 'at API prices');
    c.querySelector('header').append(button(b.daily || b.monthly ? 'Change' : 'Set a budget', 'btn small ghost', 'Opens the Claude Viz budget settings', () => vscode.postMessage({ budgetSettings: true })));
    const row = (label, value, cap, p) => { const r = el('div', 'lim' + (p >= 1 ? ' bad' : p >= 0.8 ? ' warn' : '')); r.append(el('span', 'ln', label), bar(cap ? p : 0), el('b', 'num', '≈' + money(value)), el('span', 'dim', cap ? 'of ' + money(cap) : 'no cap')); return r; };
    const box = el('div', 'limits'); box.append(row('Today', b.today, b.daily, b.dailyPct), row('Month', b.month, b.monthly, b.monthlyPct)); c.append(box);
    if (b.projected) c.append(el('p', null, 'At this pace the month ends around ≈' + money(b.projected) + (b.monthly ? (b.projected > b.monthly ? ', over your ' + money(b.monthly) + ' budget.' : ', within your budget.') : '.')));
    c.append(el('p', 'foot', 'Budgets warn at 80% and 100%. Days older than 14 come from Claude Viz’s own archive.'));
    return c;
  }

  function pacingCard(f, acc) {
    const p = f.pace, used = acc && acc.fiveHour ? acc.fiveHour.pct : f.pct;
    const c = card('5-hour limit', used ? pct(used) + ' used' + (acc && acc.fiveHour ? '' : ' (est.)') : '');
    if (!p || !f.cap) { c.append(el('p', 'dim', p ? 'No past limit hit to compare with yet.' : 'No 5-hour window is open right now.')); return c; }
    const W = 5 * 3600000, ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'pace'); svg.setAttribute('viewBox', '0 0 300 80'); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Usage in this 5-hour window against an even pace');
    const X = (ms) => ms / W * 300, Y = (u) => 80 - Math.min(1.15, u / f.cap) / 1.15 * 80;
    const line = (cls, pts) => { const pl = document.createElementNS(ns, 'polyline'); pl.setAttribute('class', cls); pl.setAttribute('points', pts.map((q2) => q2.join(',')).join(' ')); svg.append(pl); };
    line('wall', [[0, Y(f.cap)], [300, Y(f.cap)]]);
    line('even', [[0, 80], [300, Y(f.cap)]]);
    line('actual', [[0, 80], ...p.points.map(([ms, u]) => [X(ms), Y(u)])]);
    const nx = X(Date.now() - p.start), ny = Y(p.used);
    if (p.hitAt) line('proj', [[nx, ny], [X(p.hitAt - p.start), Y(f.cap)]]);
    else if (f.lastHour > 0) line('proj', [[nx, ny], [300, Y(p.used + f.lastHour * ((p.end - Date.now()) / 3600000))]]);
    c.append(svg);
    const legend = el('div', 'plegend'); [['actual', 'You'], ['even', 'Even pace'], ['wall', 'Typical limit']].forEach(([k2, l]) => { const s = el('span', 'pl ' + k2); s.append(el('i'), document.createTextNode(l)); legend.append(s); });
    c.append(legend);
    const ahead = p.even ? p.used / p.even : 0;
    c.append(el('p', null, p.hitAt ? 'At the last hour’s pace you hit the limit in about ' + until(p.hitAt) + ', ' + hm(p.end - p.hitAt) + ' before it resets.' : ahead > 1.15 ? 'Ahead of an even pace, but on track to stay under the limit.' : 'On or under an even pace. Window resets in ' + until(p.end) + '.'));
    c.append(el('p', 'foot', 'Estimate from token counts, compared with the median of ' + f.samples + ' past limit hits.'));
    return c;
  }

  // ---------- where usage goes ----------
  function usageCard(a) {
    const c = card('Where usage goes', 'last 7 days, ≈' + money(a.total));
    if (a.tips.length) { const ul = el('ul', 'tips'); for (const t of a.tips) { const li = el('li', null, t.text); if (t.file) li.append(' ', button('Open file', 'link hint', t.file, () => vscode.postMessage({ openMemory: t.file }))); ul.append(li); } c.append(ul); }
    if (a.total) {
      const split = el('div', 'stack'); const m1 = el('span', 'out'); m1.style.flexGrow = String(a.estMain); m1.title = 'Main sessions ≈' + money(a.estMain); const m2 = el('span', 'cw'); m2.style.flexGrow = String(a.estSub); m2.title = 'Subagents ≈' + money(a.estSub); split.append(m1, m2);
      const lg = el('div', 'plegend'); for (const [cls, l, v] of [['out', 'Main sessions', a.estMain], ['cw', 'Subagents', a.estSub]]) { const x = el('span', 'pl tk ' + cls); x.append(el('i'), document.createTextNode(l + ' ≈' + money(v) + ' (' + pct(v / a.total) + ')')); lg.append(x); }
      c.append(el('h3', null, 'Main sessions vs subagents'), split, lg);
    }
    if (a.memory.length) {
      c.append(el('h3', null, 'Sent with every request (memory files)'));
      const max = Math.max(1, ...a.memory.map((m) => m.tokens));
      for (const m of a.memory.slice(0, 6)) { const r = el('div', 'prow'); const n = el('div', 'pn'); n.append(button(m.name, 'link hint', 'Open ' + m.path, () => vscode.postMessage({ openMemory: m.path })), bar(m.tokens / max, 'thin')); r.append(n, el('span', 'dim num', m.projects.length + ' project' + (m.projects.length === 1 ? '' : 's')), el('span', 'num', '≈' + kt(m.tokens) + ' tokens')); c.append(r); }
    }
    const list = (title, items, unit) => { if (!items.length) return; c.append(el('h3', null, title)); const max = Math.max(1, ...items.map((x) => x.tokens)); for (const x of items.slice(0, 5)) { const r = el('div', 'prow'); const n = el('div', 'pn'); n.append(el('b', null, x.name), bar(x.tokens / max, 'thin')); r.append(n, el('span', 'dim num', x.calls ? x.calls + ' calls' : ''), el('span', 'num', '≈' + kt(x.tokens) + ' ' + unit)); c.append(r); } };
    list('Biggest tool output', a.tools, 'tokens'); list('MCP servers', a.mcp, 'tokens'); list('Skills', a.skills, 'tokens');
    c.append(el('p', 'foot', a.cacheMiss + ' cache misses cost about ' + money(a.missCost) + '. Token sizes are estimates (about 3.6 characters per token).'));
    return c;
  }

  // ---------- Insights ----------
  function renderInsights(view) {
    const st = snap.stats, dv = snap.derived;
    if (!st || !dv) { view.append(el('div', 'empty', 'Reading your history…')); return; }
    if (dv.attribution) view.append(usageCard(dv.attribution));
    const c = dv.coach;
    const coach = card('Unblock coach', hm(c.wait) + ' blocked in 7 days', 'coach');
    coach.append(el('p', 'dim', c.total + ' approvals in 7 days, ' + c.chained + ' of them chained commands (checked part by part). Allowing the parts you trust removes these prompts for good.'));
    if (c.items.length) coach.append(limited('coach', c.items, 5, (g) => {
      const d = el('div', 'rule');
      const top = el('div', 'rt'); top.append(el('code', null, g.rule || g.label), el('span', 'num dim', g.count + '×'));
      d.append(top, el('div', 'dim small clip', g.note || 'Last: ' + g.example));
      if (g.rule) {
        const acts = el('div', 'acts');
        if (!g.risky) acts.append(button('Allow in project', 'btn small', 'Add to .claude/settings.local.json of ' + (g.projects[0] || 'the project'), () => vscode.postMessage({ rule: g.rule, scope: 'project' })), button('Allow everywhere', 'btn small', 'Add to ~/.claude/settings.json', () => vscode.postMessage({ rule: g.rule, scope: 'user' })));
        else acts.append(el('span', 'chip warn', 'broad command: review first'));
        acts.append(button('Copy', 'btn small ghost', 'Copy the rule text', () => vscode.postMessage({ rule: g.rule, scope: 'copy' })));
        d.append(acts);
      }
      return d;
    }));
    else coach.append(el('p', 'dim', 'Nothing repeated often enough to suggest a rule.'));
    view.append(coach);

    const badges = card('Achievements', dv.achievements.filter((b) => b.earned).length + ' of ' + dv.achievements.length + ' today');
    const grid = el('div', 'badges');
    for (const b of dv.achievements) { const t = el('div', 'badge' + (b.earned ? ' on' : '')); t.append(el('b', null, (b.earned ? '★ ' : '☆ ') + b.name), el('span', null, b.earned ? 'Earned today' : b.need)); if (b.week != null) t.append(el('span', 'wk', b.week + ' of the last 7 days')); grid.append(t); }
    badges.append(grid); view.append(badges);

    const r = dv.recap;
    const rc = card('This week vs last week');
    const rows = [
      ['Flow', pct(r.now.flow), pct(r.before.flow), r.now.flow - r.before.flow, 1],
      ['Blocked on you', hm(r.now.blocked), hm(r.before.blocked), r.now.blocked - r.before.blocked, -1],
      ['Failure rate', pct(r.now.failRate), pct(r.before.failRate), r.now.failRate - r.before.failRate, -1],
      ['Commits', String(r.now.commits), String(r.before.commits), r.now.commits - r.before.commits, 1],
      ['Tests green again', String(r.now.greens), String(r.before.greens), r.now.greens - r.before.greens, 1],
      ['Limit hits', String(r.now.hits), String(r.before.hits), r.now.hits - r.before.hits, -1],
      ['Active time', hm(r.now.active), hm(r.before.active), 0, 0],
      ['Est. cost', money(r.now.est), money(r.before.est), 0, 0],
    ];
    const tb = el('table', 'recap'), hr = el('tr'); ['', 'This week', 'Last week', ''].forEach((h) => hr.append(el('th', null, h))); tb.append(hr);
    for (const [label, a, b, delta, good] of rows) { const tr = el('tr'), cls = !good || !delta ? '' : (delta > 0) === (good > 0) ? 'up' : 'down'; tr.append(el('td', null, label), el('td', 'num', a), el('td', 'num dim', b), el('td', 'trend ' + cls, !delta ? '' : delta > 0 ? '▲' : '▼')); tb.append(tr); }
    rc.append(tb);
    if (r.bests.length) { const bb = el('div', 'bests'); for (const b of r.bests) { const x = el('div'); x.append(el('span', 'kl', b.label), el('b', 'num', b.value), el('span', 'dim', b.day)); bb.append(x); } rc.append(bb); }
    rc.append(el('p', 'foot', 'Very long transcripts are counted from their last 20 MB, so older days can be undercounted.'));
    view.append(rc);

    const fc = card('Failures', st.failures.reduce((a, g) => a + g.count, 0) + ' in 7 days', 'fails');
    if (st.failures.length) fc.append(limited('fails', st.failures, 5, (g) => { const d = el('div', 'fail'); const top = el('div', 'rt'); top.append(el('span', 'mono', g.name), el('span', 'hint', g.label), el('span', 'num dim', g.count + '×, ' + ago(g.last))); d.append(top, el('div', 'mono small clip dim', g.text || '(no error text)')); return d; }));
    else fc.append(el('p', 'dim', 'No failed tool calls.'));
    view.append(fc);

    const list = st.slowToday.length ? st.slowToday : st.slowWeek;
    const sl = card('Slowest tool calls', st.slowToday.length ? 'today' : 'last 7 days');
    sl.append(limited('slow', list, 5, (x) => { const d = el('div', 'prow'); const n = el('div', 'pn'); n.append(el('span', 'mono', x.name), el('span', 'hint', x.hint)); d.append(n, el('span', 'dim', x.project || ''), el('span', 'num', dur(x.ms))); return d; }));
    view.append(sl);
  }

  // ---------- System ----------
  function qrSvg(matrix) {
    const ns = 'http://www.w3.org/2000/svg', n = matrix.length, svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `-4 -4 ${n + 8} ${n + 8}`); svg.setAttribute('class', 'qr'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Pairing QR code');
    const bg = document.createElementNS(ns, 'rect'); bg.setAttribute('x', -4); bg.setAttribute('y', -4); bg.setAttribute('width', n + 8); bg.setAttribute('height', n + 8); bg.setAttribute('class', 'qrbg'); svg.append(bg);
    matrix.forEach((row, y) => { for (let x = 0; x < row.length; x++) if (row[x] === '1') { const r = document.createElementNS(ns, 'rect'); r.setAttribute('x', x); r.setAttribute('y', y); r.setAttribute('width', 1.02); r.setAttribute('height', 1.02); svg.append(r); } });
    return svg;
  }
  function phoneCard() {
    const p = snap.phone;
    if (!p) return null;
    const c = card('Phone access', p.on ? 'on until ' + new Date(p.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'off');
    c.querySelector('header').append(p.on ? button('Turn off', 'btn small', null, () => vscode.postMessage({ phoneOff: true })) : button('Turn on', 'btn small', 'Starts a read-only HTTPS page on your Wi-Fi address, for paired devices only', () => vscode.postMessage({ phoneOn: true })));
    if (p.error) c.append(el('div', 'alert bad', p.error));
    if (!p.on) c.append(el('p', 'dim', 'A read-only view of your sessions for your phone, on this Wi-Fi only. Only devices you pair with a QR code can open it; it turns itself off after a few hours.'));
    else {
      c.append(el('p', 'dim small', 'Listening on ' + p.urls.join(', ') + '. Other devices on the network see nothing without pairing.'));
      // A new device appeared: the code was used, so the QR code goes away.
      if (pairing && p.devices.length > pairing.devicesBefore) { pairing = null; c.append(el('div', 'alert', '✓ Paired ' + p.devices[p.devices.length - 1].name + '.')); }
      if (pairing && pairing.expires > Date.now()) {
        const box = el('div', 'pair');
        box.append(qrSvg(pairing.matrix));
        const t = el('div', 'pt');
        const left = el('span', 'dim small num'); left.dataset.until = pairing.expires; left.dataset.kind = 'expires';
        t.append(el('b', null, 'Scan with your phone’s camera'), left, el('span', 'dim small', 'Then accept the certificate warning (it is made on this computer: the fingerprint starts with ' + pairing.fingerprint.slice(0, 23) + ') and tap “Pair this phone”. The code works once.'));
        const acts2 = el('div', 'acts'); acts2.append(button('New code', 'btn small ghost', 'Replaces this code', () => vscode.postMessage({ phonePair: true })), button('Cancel', 'btn small ghost', null, () => { pairing = null; render0(); })); t.append(acts2);
        box.append(t); c.append(box);
      } else c.append(button('Pair a device', 'btn small', 'Shows a one-time QR code (valid 10 minutes)', () => vscode.postMessage({ phonePair: true })));
      if (pairing && pairing.expires <= Date.now()) c.append(el('p', 'dim small', 'The last code expired. Press Pair a device for a new one.'));
    }
    if (p.devices.length) {
      c.append(el('h3', null, 'Paired devices'));
      for (const d of p.devices) { const r = el('div', 'prow'); const n = el('div', 'pn'); n.append(el('b', null, d.name), el('span', 'dim', 'paired ' + ago(d.created) + (d.lastSeen ? ', last seen ' + ago(d.lastSeen) : ''))); r.append(n, button('Revoke', 'btn small ghost', 'This device can no longer open the page', () => vscode.postMessage({ phoneRevoke: d.id }))); c.append(r); }
    }
    return c;
  }
  function renderSystem(view) {
    const pc = phoneCard(); if (pc) view.append(pc);
    const s = snap.system;
    const mc = card('Machine', s ? { ok: 'all good', warn: 'watch it', bad: 'under pressure' }[s.level] : '');
    if (s) {
      const g = el('div', 'meters');
      const m = (label, value, sub, p, level, title, graph) => { const x = el('div', 'meter ' + level); x.title = title; x.append(el('span', 'kl', label), el('b', 'num', value)); if (sub) x.append(el('span', 'ms', sub)); x.append(graph || bar(p)); g.append(x); };
      m('CPU', s.cpuPct != null ? pct(s.cpuPct) : '–', s.cores + ' cores, load ' + s.load.toFixed(2), s.cpuPct || 0, s.cpu, 'Share of all cores busy over the last 5 seconds', line(s.hist && s.hist.cpu, s.cpu));
      m('Memory', gb(s.memUsedGb) + ' / ' + Math.round(s.memTotalGb), (s.memFreePct != null ? s.memFreePct + '% available' : '') + (s.compressedGb ? ', ' + gb(s.compressedGb) + ' compressed' : ''), s.memUsedGb / s.memTotalGb, s.mem, 'Used = app + wired + compressed memory, as Activity Monitor counts it', line(s.hist && s.hist.mem, s.mem));
      if (s.swapUsedGb != null) m('Swap', gb(s.swapUsedGb), s.swapTotalGb ? 'of ' + gb(s.swapTotalGb) : '', s.swapTotalGb ? s.swapUsedGb / s.swapTotalGb : 0, s.swap, 'Amber above 6 GB, red above 12 GB');
      if (s.diskFreeGb != null) m('Disk free', gb(s.diskFreeGb), s.diskTotalGb ? 'of ' + gb(s.diskTotalGb) : '', s.diskTotalGb ? 1 - s.diskFreeGb / s.diskTotalGb : 0, s.disk, 'Keep at least ' + s.diskWarnGb + ' GB free');
      m('Agents', s.agents + ' of ' + s.cap, 'subagents running', s.agents / s.cap, s.ag, 'CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS');
      m('Claude Code', s.procs.claude.n + ' running', gb(s.procs.claude.gb) + '; Node ' + s.procs.node.n + ', ' + gb(s.procs.node.gb), 0, 'ok', 'Processes named claude and node');
      mc.append(g);
      mc.append(el('h3', null, 'Biggest memory users'));
      const top = s.procs.top, maxT = Math.max(0.01, ...top.map((t) => t.gb));
      for (const t of top) { const d = el('div', 'prow'); const n = el('div', 'pn'); n.append(el('b', null, t.name), bar(t.gb / maxT, 'thin')); d.append(n, el('span', 'dim num', t.n > 1 ? t.n + ' processes' : ''), el('span', 'num', gb(t.gb))); mc.append(d); }
      mc.append(el('p', 'foot', 'Up ' + Math.floor(s.uptimeH / 24) + 'd ' + Math.round(s.uptimeH % 24) + 'h. Refreshed every 5 seconds.'));
    }
    view.append(mc);

    const w = snap.worktrees || {};
    const trees = (w.repos || []).flatMap((r) => r.trees), free = trees.filter((t) => t.removable);
    const wc = card('Worktrees', w.at ? trees.length + ', ' + trees.reduce((a, t) => a + t.gb, 0).toFixed(1) + ' GB' : 'not scanned yet');
    wc.querySelector('header').append(button(w.scanning ? 'Scanning…' : 'Scan', 'btn small', null, () => vscode.postMessage({ scanWorktrees: true })));
    if (free.length) wc.append(el('p', null, free.length + ' safe to remove, ' + free.reduce((a, t) => a + t.gb, 0).toFixed(1) + ' GB.'));
    for (const r of w.repos || []) {
      wc.append(el('h3', null, r.name + ' (main on ' + r.mainBranch + ')'));
      wc.append(limited('wt:' + r.name, r.trees, 5, (t) => {
        const d = el('div', 'prow'); const n = el('div', 'pn'); const nm = el('b', null, t.branch || t.path.split('/').pop()); nm.title = t.path; n.append(nm, el('span', 'dim', t.removable ? 'clean, merged into ' + t.mergedInto : t.why));
        d.append(n, el('span', 'num', t.gb.toFixed(2) + ' GB'));
        if (t.removable) d.append(button('Remove', 'btn small', 'Deletes the folder with git (no force); the branch is kept', () => vscode.postMessage({ removeWorktree: t.path })));
        return d;
      }));
    }
    if (w.at) wc.append(el('p', 'foot', 'Scanned ' + ago(w.at) + '. Only clean, merged, unlocked agent worktrees can be removed.'));
    view.append(wc);

    const hooks = (snap.stats && snap.stats.hooks) || [];
    const hc = card('Hooks', hooks.length ? hooks.length + ' errors in 24 hours' : 'no errors in 24 hours');
    for (const h of hooks) hc.append(el('div', 'alert bad', ago(h.ts) + ', ' + h.project + ': ' + h.text));
    view.append(hc);
  }

  // ---------- Session insights ----------
  const gitAsked = {};
  function openInsight(id) { gitData = null; prData = null; delete gitAsked[id]; insightId = id; insight = null; insightErr = ''; save(); vscode.postMessage({ insight: id }); render0(); window.scrollTo(0, 0); }
  setInterval(() => { if (insightId && snap && snap.sessions.some((x) => x.id === insightId && x.running)) vscode.postMessage({ insight: insightId }); }, 20000);
  const fmtTime = (ts) => new Date(ts).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const fmtClock = (ts) => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  function rowsBar(items, value, label, right, key, n) {
    const max = Math.max(1e-9, ...items.map(value));
    return limited(key, items, n || 6, (x) => { const d = el('div', 'prow'); const nm = el('div', 'pn'); nm.append(el('b', null, label(x)), bar(value(x) / max, 'thin')); d.append(nm, ...right(x)); return d; });
  }
  function costChart(tl, start) {
    const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg'), max = Math.max(1e-9, ...tl.bins), w = 300 / tl.bins.length;
    svg.setAttribute('class', 'costbars'); svg.setAttribute('viewBox', '0 0 300 60'); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Cost over the session');
    tl.bins.forEach((v, i) => { const h = v ? Math.max(1.5, v / max * 58) : 0; const r = document.createElementNS(ns, 'rect'); r.setAttribute('x', i * w + 0.5); r.setAttribute('y', 60 - h); r.setAttribute('width', Math.max(0.5, w - 1)); r.setAttribute('height', h); const t = document.createElementNS(ns, 'title'); t.textContent = fmtClock(start + i * tl.size) + ': ≈' + money(v); r.append(t); svg.append(r); });
    const axis = el('div', 'caxis'); axis.append(el('span', null, fmtClock(start)), el('span', null, fmtClock(start + tl.bins.length * tl.size)));
    const box = el('div'); box.append(svg, axis); return box;
  }
  function renderInsight(view) {
    const back = button('← Back', 'btn small ghost', null, () => { insightId = null; save(); render0(); });
    if (insightErr) { view.append(back, el('div', 'empty', insightErr)); return; }
    if (!insight || insight.id !== insightId) { view.append(back, el('div', 'empty', 'Reading the whole session and its subagents…')); return; }
    const d = insight;
    const live = snap.sessions.find((x) => x.id === d.id);

    const head = el('section', 'card ihead');
    const top = el('div', 'rt'); top.append(back);
    if (live && live.running) top.append(el('span', 'chip k-finished', 'running · refreshes every 20 s'));
    head.append(top, el('h1', null, d.title));
    const sub = el('div', 'subline');
    [d.project, ...d.branches.map((b) => '⎇ ' + b), d.models.map((m) => m.model).join(', '), d.entrypoint && 'from ' + d.entrypoint.replace('claude-', ''), d.version && 'Claude Code ' + d.version, d.modes.length && d.modes.join(', ') + ' mode', d.effort && d.effort + ' effort'].filter(Boolean).forEach((x) => sub.append(el('span', null, x)));
    head.append(sub, el('p', 'dim small', fmtTime(d.start) + ' → ' + fmtTime(d.end) + (d.analyzedAt ? ' · analyzed ' + ago(d.analyzedAt) : '')));
    const acts = el('div', 'acts');
    const ex = el('div', 'acts'); ex.append(el('span', 'kl', 'Export'));
    for (const [kind, label, tip] of [['report', 'Report', 'Summary, prompts, tools, subagents (Markdown)'], ['conversation', 'Conversation', 'Your prompts, Claude’s replies and one line per tool call (Markdown)'], ['csv', 'CSV', 'One row per prompt'], ['json', 'JSON', 'Everything on this page']]) ex.append(button(label, 'btn small ghost', tip + '. Opens as an unsaved document.', () => vscode.postMessage({ exportId: d.id, kind })));
    acts.append(button('Open in Claude', 'btn small', 'Show this session in its Claude tab', () => vscode.postMessage({ showById: d.id })), button('Copy resume command', 'btn small ghost', null, () => vscode.postMessage({ copyResume: d.id })), button('Open transcript', 'btn small ghost', null, () => vscode.postMessage({ openFileOf: d.id })), button('Refresh', 'btn small ghost', null, () => { vscode.postMessage({ insight: d.id }); }));
    head.append(acts, ex);
    const k = el('div', 'kpis wide');
    const kpi = (l, v, t) => { const x = el('div', 'kpi'); if (t) x.title = t; x.append(el('span', 'kl', l), el('span', 'kv num', v)); k.append(x); };
    const prompts = d.turns.filter((t) => t.text).length;
    kpi('Est. cost', '≈' + money(d.cost), 'At API prices: main ≈' + money(d.mainCost) + ', subagents ≈' + money(d.subCost) + (d.recorded ? '. Claude Code recorded ' + money(d.recorded) + ' for its latest run.' : ''));
    kpi('Duration', span(d.end - d.start), 'First to last entry, including breaks; resumed sessions span days'); kpi('Your active time', hm(d.active), 'Main session, gaps under 5 minutes');
    kpi('Prompts', String(prompts)); kpi('Tool calls', d.calls + (d.failed ? ' (' + d.failed + ' failed)' : ''));
    kpi('Subagents', String(d.subagents.length)); kpi('Tokens', kt(d.tokens.input + d.tokens.output + d.tokens.cacheRead + d.tokens.cacheWrite)); kpi('Context peak', kt(d.ctxPeak));
    head.append(k);
    view.append(head);

    const cc = card('Cost', '≈' + money(d.cost) + ' at API prices');
    cc.append(costChart(d.timeline, d.start));
    cc.append(el('h3', null, 'By model'), rowsBar(d.models, (m) => m.cost, (m) => m.model, (m) => [el('span', 'dim num', m.calls + ' replies'), el('span', 'num', '≈' + money(m.cost))], 'i-models', 4));
    const agents = [{ name: 'Main agent', type: '', cost: d.mainCost, calls: d.calls - d.subagents.reduce((a, x) => a + x.calls, 0) }, ...d.subagents];
    cc.append(el('h3', null, 'By agent'), rowsBar(agents, (a) => a.cost, (a) => (a.type ? a.type + ': ' : '') + (a.name || 'subagent'), (a) => [el('span', 'dim num', a.calls + ' calls'), el('span', 'num', '≈' + money(a.cost))], 'i-agents', 6));
    view.append(cc);

    const tk = d.tokens, tot = tk.input + tk.output + tk.cacheRead + tk.cacheWrite;
    const tc = card('Tokens', kt(tot) + ' total');
    const stack = el('div', 'stack');
    for (const [cls, v, l] of [['in', tk.input, 'Input'], ['cw', tk.cacheWrite, 'Cache write'], ['cr', tk.cacheRead, 'Cache read'], ['out', tk.output, 'Output']]) { const seg = el('span', cls); seg.style.flexGrow = String(v || 0); seg.title = l + ': ' + kt(v); stack.append(seg); }
    const lg = el('div', 'plegend');
    for (const [cls, v, l] of [['in', tk.input, 'Input'], ['cw', tk.cacheWrite, 'Cache write'], ['cr', tk.cacheRead, 'Cache read'], ['out', tk.output, 'Output']]) { const x = el('span', 'pl tk ' + cls); x.append(el('i'), document.createTextNode(l + ' ' + kt(v))); lg.append(x); }
    tc.append(stack, lg, el('p', 'dim small', pct(tot ? tk.cacheRead / (tk.input + tk.cacheRead + tk.cacheWrite || 1) : 0) + ' of input came from the prompt cache. Context peaked at ' + kt(d.ctxPeak) + ' tokens' + (d.compactions.length ? ' and was compacted ' + d.compactions.length + '×' : '') + '.'));
    view.append(tc);

    const cache = card('Prompt cache', d.missCount ? d.missCount + ' misses, ≈' + money(d.missCost) : 'no misses');
    const inTot = tk.input + tk.cacheRead + tk.cacheWrite;
    cache.append(el('p', null, pct(inTot ? tk.cacheRead / inTot : 0) + ' of input came from the cache. A miss means most of the conversation was written to the cache again (1.25× the input price instead of 0.1×).'));
    if (d.cacheMisses.length) cache.append(limited('i-miss', d.cacheMisses, 5, (m) => { const r = el('div', 'prow'); const n = el('div', 'pn'); n.append(el('b', null, m.cause === 'break' ? 'After a ' + hm(m.gap) + ' break' : 'Conversation changed'), el('span', 'dim', fmtTime(m.ts) + ', ' + kt(m.tokens) + ' tokens re-cached')); r.append(n, el('span', 'num', '≈' + money(m.cost))); return r; }));
    view.append(cache);

    const gc = card('Git', gitData && gitData.id === d.id && gitData.data.ok ? '⎇ ' + gitData.data.branch + (gitData.data.changes ? ', ' + gitData.data.changes + ' uncommitted' : '') : '');
    if (!gitData || gitData.id !== d.id) { gc.append(el('p', 'dim', 'Reading git…')); if (!gitAsked[d.id]) { gitAsked[d.id] = 1; vscode.postMessage({ gitOf: d.id }); } }
    else if (!gitData.data.ok) gc.append(el('p', 'dim', gitData.data.err));
    else {
      const g = gitData.data;
      gc.append(el('p', 'dim small', g.commits.length ? g.commits.length + ' commit' + (g.commits.length === 1 ? '' : 's') + ' by you while this session ran (any branch).' : 'No commits by you while this session ran.'));
      gc.append(limited('i-commits', g.commits, 6, (cm) => { const r = el('div', 'prow'); const n = el('div', 'pn'); n.append(button(cm.subject, 'link strong', 'Open this commit as a diff', () => vscode.postMessage({ commitOf: d.id, sha: cm.sha })), el('span', 'dim mono', cm.sha + ' · ' + fmtTime(cm.ts))); r.append(n, el('span', 'num dim', cm.files + ' files'), el('span', 'num', '+' + cm.add + ' −' + cm.del)); return r; }));
      if (g.host === 'github' || g.host === 'azure') {
        const pr = el('div', 'acts'); pr.append(button(prBusy ? 'Checking…' : 'Check pull request', 'btn small ghost', 'Asks ' + (g.host === 'github' ? 'GitHub (gh)' : 'Azure DevOps (az)') + ' for the PR of ' + g.branch, () => { prBusy = true; render0(); vscode.postMessage({ prOf: d.id }); })); gc.append(pr);
      }
      if (prData && prData.id === d.id) {
        if (!prData.data.ok) gc.append(el('p', 'dim', prData.data.err));
        else if (!prData.data.prs.length) gc.append(el('p', 'dim', 'No pull request for ' + g.branch + '.'));
        else for (const x of prData.data.prs) { const r = el('div', 'prow'); const n = el('div', 'pn'); n.append(x.url ? button('#' + x.id + ' ' + x.title, 'link strong', 'Open in the browser', () => vscode.postMessage({ openUrl: x.url })) : el('b', null, '#' + x.id + ' ' + x.title), el('span', 'dim', x.checks.map((ck) => ck.name + ': ' + ck.state).join(', '))); r.append(n, el('span', 'chip', x.state)); gc.append(r); }
      }
    }
    view.append(gc);

    const tl = card('Tools', d.tools.length + ' kinds, ' + d.calls + ' calls');
    tl.append(rowsBar(d.tools, (t) => t.calls, (t) => t.name, (t) => [el('span', 'num', t.calls + '×'), el('span', 'num' + (t.failed ? ' bad-t' : ' dim'), t.failed + ' failed'), el('span', 'dim num', dur(t.ms) + ' total')], 'i-tools', 8));
    view.append(tl);

    const pc = card('Your prompts', prompts + ' turns');
    pc.append(seg('Sort prompts', [['new', 'Newest'], ['old', 'Oldest'], ['costly', 'Costliest'], ['cheap', 'Cheapest']], turnSort, (v) => { turnSort = v; save(); render0(); }));
    const turns = d.turns.filter((t) => t.text);
    const by = { new: (a, b) => b.ts - a.ts, old: (a, b) => a.ts - b.ts, costly: (a, b) => b.total - a.total, cheap: (a, b) => a.total - b.total }[turnSort] || ((a, b) => b.ts - a.ts);
    const ordered = [...turns].sort(by);
    const maxT = Math.max(1e-9, ...turns.map((t) => t.total));
    pc.append(limited('i-turns', ordered, 10, (t) => {
      const row = el('div', 'turn');
      const meta = el('div', 'rt'); meta.append(el('span', 'dim num', fmtClock(t.ts)), el('span', 'dim num', dur(t.dur)), el('span', 'dim num', t.tools + ' tools' + (t.subagents ? ', ' + t.subagents + ' subagents' : '')), t.failed ? el('span', 'num bad-t', t.failed + ' failed') : el('span'), el('b', 'num', '≈' + money(t.total)));
      const txt = el('div', 'tt2', t.text); txt.title = 'Click to expand'; txt.onclick = () => txt.classList.toggle('full');
      row.append(meta, txt, bar(t.total / maxT, 'thin'));
      if (t.subCost) row.title = 'Includes ≈' + money(t.subCost) + ' from subagents started in this turn';
      return row;
    }));
    if (turns.length) { const longest = turns.reduce((a, t) => (t.dur > a.dur ? t : a)); pc.append(el('p', 'foot', 'Average turn ' + dur(turns.reduce((a, t) => a + t.dur, 0) / turns.length) + '; longest ' + dur(longest.dur) + '. Subagent costs are counted in the turn that started them.')); }
    view.append(pc);

    if (d.subagents.length) {
      const sc = card('Subagents', d.subagents.length + ', ≈' + money(d.subCost));
      const chips = el('div', 'acts'); for (const t of d.subTypes) chips.append(el('span', 'chip', t.type + ' ' + t.n)); sc.append(chips);
      sc.append(limited('i-subs', d.subagents, 8, (a) => { const r = el('div', 'prow'); const nm = el('div', 'pn'); nm.append(el('b', null, a.name || a.id), el('span', 'dim', a.type + (a.fork ? ' (fork)' : '') + (a.worktree ? ', worktree ' + a.worktree : ''))); r.append(nm, el('span', 'dim num', dur((a.end || 0) - (a.start || 0))), el('span', 'num', a.calls + ' calls' + (a.failed ? ', ' + a.failed + ' failed' : '')), el('span', 'num', '≈' + money(a.cost))); return r; }));
      view.append(sc);
    }

    const ac = card('Activity');
    const facts = el('div', 'facts big');
    const fact = (l, v, t) => { const f = el('div'); if (t) f.title = t; f.append(el('span', 'kl', l), el('b', 'num', v)); facts.append(f); };
    fact('Approvals', d.approvals + (d.wait ? ', ' + hm(d.wait) + ' waiting' : ''), 'Permission prompts you answered, and how long agents waited');
    fact('Denied', String(d.denied)); fact('Commits', String(d.commits)); fact('Tests green again', String(d.greens));
    fact('Thinking', hm(d.think)); fact('Compactions', String(d.compactions.length)); fact('Interrupted', String(d.interrupts), 'Turns you stopped with Esc');
    fact('API errors', d.apiErrors + (d.retries ? ', ' + d.retries + ' retries' : '')); fact('Limit hits', String(d.limitHits));
    fact('Web', d.webSearches + ' searches, ' + d.webFetches + ' fetches'); fact('Images pasted', String(d.images)); fact('Mid-turn messages', String(d.queued), 'Messages you sent while Claude was working');
    ac.append(facts);
    if (d.mcp.length) { ac.append(el('h3', null, 'MCP servers')); const c2 = el('div', 'acts'); for (const x of d.mcp) c2.append(el('span', 'chip', x.name + ' ' + x.n)); ac.append(c2); }
    if (d.skills.length) { ac.append(el('h3', null, 'Skills')); const c3 = el('div', 'acts'); for (const x of d.skills) c3.append(el('span', 'chip', x.name + ' ' + x.n)); ac.append(c3); }
    if (d.files.length) { ac.append(el('h3', null, 'Files edited (' + d.fileCount + ')')); ac.append(limited('i-files', d.files, 8, (f) => { const r = el('div', 'prow'); r.append(button(f.name, 'link hint', f.path, () => vscode.postMessage({ file: f.path })), el('span', 'dim num', f.n + '×')); return r; })); }
    view.append(ac);

    if (d.slow.length) { const sl = card('Slowest tool calls'); sl.append(limited('i-slow', d.slow, 5, (x) => { const r = el('div', 'prow'); const nm = el('div', 'pn'); nm.append(el('span', 'mono', x.name), el('span', 'hint', x.hint + (x.agent ? ' (' + x.agent + ')' : ''))); r.append(nm, el('span', 'num', dur(x.ms))); return r; })); view.append(sl); }
    if (d.errors.length) { const ec = card('Errors', d.failed + ' failed calls'); ec.append(limited('i-errs', d.errors, 5, (e) => { const r = el('div', 'fail'); const t2 = el('div', 'rt'); t2.append(el('span', 'mono', e.name), el('span', 'hint', e.hint + (e.agent ? ' (' + e.agent + ')' : '')), el('span', 'dim num', fmtClock(e.ts))); r.append(t2, el('div', 'mono small clip dim', e.text || '(no error text)')); return r; })); view.append(ec); }
  }

  /** A small segmented control (radio-like buttons). */
  function seg(label, options, value, onPick) {
    const g = el('div', 'seg'); g.setAttribute('role', 'group'); g.setAttribute('aria-label', label);
    for (const [id, text] of options) { const b = button(text, 'segb' + (value === id ? ' on' : ''), null, () => onPick(id)); b.setAttribute('aria-pressed', String(value === id)); g.append(b); }
    return g;
  }

  // ---------- History: every session on this machine ----------
  setInterval(() => { if (tab === 'history' && !insightId) vscode.postMessage({ history: true }); }, 60000);
  function renderHistory(view) {
    if (!history) { view.append(el('div', 'empty', 'Reading your sessions…')); return; }
    const ranges = [['today', 'Today'], ['7d', '7 days'], ['30d', '30 days'], ['all', 'All']];
    const from = { today: new Date().setHours(0, 0, 0, 0), '7d': Date.now() - 7 * 86400000, '30d': Date.now() - 30 * 86400000, all: 0 }[histRange] || 0;
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const inRange = history.filter((x) => x.lastTs >= from);
    const projects = [...new Set(inRange.map((x) => x.project))].sort();
    const list = inRange.filter((x) => (!histProject || x.project === histProject) && words.every((w) => [x.title, x.firstPrompt, x.lastPrompt, x.project, x.branch].join(' ').toLowerCase().includes(w)));
    // Unknown costs sort last either way.
    const costKey = (x, dir) => (x.est == null ? (dir > 0 ? Infinity : -Infinity) : x.est);
    if (histSort === 'costDesc') list.sort((a, b) => costKey(b, -1) - costKey(a, -1));
    else if (histSort === 'costAsc') list.sort((a, b) => costKey(a, 1) - costKey(b, 1));
    else list.sort((a, b) => b.lastTs - a.lastTs);

    const bar2 = el('div', 'filters');
    const chips = el('div', 'seg'); chips.setAttribute('role', 'group'); chips.setAttribute('aria-label', 'Time range');
    for (const [id, label] of ranges) { const b = button(label, 'segb' + (histRange === id ? ' on' : ''), null, () => { histRange = id; save(); render0(); }); b.setAttribute('aria-pressed', String(histRange === id)); chips.append(b); }
    const sel = el('select', 'psel'); sel.setAttribute('aria-label', 'Project');
    const opt = (v, l) => { const o = el('option', null, l); o.value = v; if (v === histProject) o.selected = true; sel.append(o); };
    opt('', 'All projects (' + inRange.length + ')');
    for (const p of projects) opt(p, p + ' (' + inRange.filter((x) => x.project === p).length + ')');
    sel.onchange = () => { histProject = sel.value; save(); render0(); };
    bar2.append(chips, seg('Sort sessions', [['recent', 'Recent'], ['costDesc', 'Cost ↓'], ['costAsc', 'Cost ↑']], histSort, (v) => { histSort = v; save(); render0(); }), sel);
    view.append(bar2);
    // Full-text search inside every transcript, on demand (it reads ~all transcripts on disk).
    const fts = el('div', 'acts');
    fts.append(button(fullBusy ? 'Searching all transcripts…' : 'Search inside all transcripts' + (q.trim().length >= 3 ? ' for “' + q.trim() + '”' : ''), 'btn small', 'Looks through every prompt, reply and tool output on this computer', () => { if (q.trim().length < 3 || fullBusy) return; fullBusy = true; fullText = null; render0(); vscode.postMessage({ fulltext: q.trim() }); }));
    view.append(fts);
    if (fullText) {
      const fc = card('Found inside transcripts', fullText.total ? fullText.total + ' session' + (fullText.total === 1 ? '' : 's') + ' mention “' + fullText.q + '”' : (fullText.note || 'No transcript mentions “' + fullText.q + '”'));
      fc.querySelector('header').append(button('Close', 'btn small ghost', null, () => { fullText = null; render0(); }));
      for (const r of fullText.results) {
        const row = el('div', 'hrow'); const top = el('div', 'rt');
        top.append(button(r.title, 'link strong clip', 'Session insights', () => openInsight(r.id)), el('span', 'dim num', r.match ? r.match.count + (r.match.count >= 50 ? '+' : '') + ' hits' : ''));
        row.append(top, el('div', 'hsub', r.project + ', ' + (r.lastTs ? ago(r.lastTs) : '') + (r.inSubagents ? ', also in ' + r.inSubagents + ' subagent transcripts' : '')));
        if (r.match) row.append(el('div', 'snip', r.match.role + ': ' + r.match.snippet));
        fc.append(row);
      }
      view.append(fc);
    }

    const known = list.filter((x) => x.est != null);
    const c = card(list.length + ' session' + (list.length === 1 ? '' : 's'), known.length ? '≈' + money(known.reduce((a, x) => a + x.est, 0)) + (known.length < list.length ? ' for ' + known.length + ' with known cost' : '') : '');
    if (!list.length) c.append(el('p', 'dim', 'No session matches. Try a longer range or another project.'));
    c.append(limited('hist', list, 30, (x) => {
      const r = el('div', 'hrow');
      const top = el('div', 'rt');
      if (x.gone) top.append(el('span', 'strong clip', x.title), el('span', 'num', x.est != null ? '≈' + money(x.est) : '–'));
      else top.append(button(x.title, 'link strong clip', 'Session insights: costs, tools, prompts', () => openInsight(x.id)), el('span', 'num', x.est != null ? '≈' + money(x.est) + (x.estPartial ? '+' : '') : '–'));
      const sub = el('div', 'hsub');
      sub.append(el('span', null, x.project), el('span', null, ago(x.lastTs)), x.subs ? el('span', null, x.subs + ' subagents') : el('span'), x.gone ? el('span', 'chip', 'transcript deleted, summary kept') : el('span', null, x.sizeMb >= 1 ? x.sizeMb.toFixed(1) + ' MB' : Math.round(x.sizeMb * 1000) + ' KB'));
      r.append(top, sub);
      const ask = x.lastPrompt || x.firstPrompt;
      if (ask) { const a = el('div', 'dim small clip', 'Last: ' + ask); a.title = ask; r.append(a); }
      return r;
    }));
    c.append(el('p', 'foot', 'Cost shows for sessions read in the last 14 days or opened once; “–” fills in when you open a session. Estimates at API prices.'));
    view.append(c);
  }

  // ---------- render ----------
  function render0() {
    if (!snap) return;
    tabs(); alerts();
    $('search').hidden = (tab !== 'live' && tab !== 'history') || !!insightId;
    const view = $('view'), fresh = el('div');
    if (insightId) renderInsight(fresh);
    else ({ live: renderLive, today: renderToday, history: renderHistory, insights: renderInsights, system: renderSystem }[tab] || renderLive)(fresh);
    view.replaceChildren(...fresh.childNodes);
    view.setAttribute('aria-labelledby', 'tab-' + tab);
  }

  const input = $('q');
  input.value = q;
  let deb = 0;
  input.addEventListener('input', () => { q = input.value; save(); render0(); clearTimeout(deb); deb = setTimeout(() => vscode.postMessage({ search: q }), 250); });
  if (q) vscode.postMessage({ search: q });
  if (insightId) vscode.postMessage({ insight: insightId });
  if (tab === 'history') vscode.postMessage({ history: true });
  window.addEventListener('message', ({ data }) => {
    if (!data) return;
    if (data.type === 'detail') return showDrawer(data);
    if (data.type === 'celebrate') return cheer(data);
    if (data.type === 'pairing') { pairing = { ...data, devicesBefore: snap && snap.phone ? snap.phone.devices.length : 0 }; tab = 'system'; insightId = null; save(); render0(); return; }
    if (data.type === 'fulltext') { fullBusy = false; fullText = data; if (tab === 'history') render0(); return; }
    if (data.type === 'git') { gitData = data; if (insightId === data.id) render0(); return; }
    if (data.type === 'pr') { prBusy = false; prData = data; if (insightId === data.id) render0(); return; }
    if (data.type === 'history') { history = data.list; if (tab === 'history') render0(); return; }
    if (data.type === 'insight') { if (data.id === insightId) { insight = data.data || null; insightErr = data.error || ''; render0(); } return; }
    if (data.type === 'results') { if (data.q === q) { results = data.results; render0(); } return; }
    if (data.sessions) {
      const prev = snap; snap = data;
      // Live is the only view that changes every 2 s. Redrawing the others on every tick would close an
      // open dropdown and flicker tooltips, so they redraw only when their own data changes.
      const changed = !prev || prev.statsVersion !== data.statsVersion || (tab === 'system' && !insightId) || (insightId && !!(prev.sessions.find((x) => x.id === insightId) || {}).running !== !!(data.sessions.find((x) => x.id === insightId) || {}).running);
      if (tab === 'live' && !insightId) {
        // Hold the redraw while the user is typing in a box, selecting text, or dragging a card.
        const sel = window.getSelection ? window.getSelection() : null, ae = document.activeElement;
        const typing = ae && ae.dataset && ae.dataset.draft != null;
        if (!dragging && !typing && !(sel && String(sel).length)) render0(); else { tabs(); alerts(); }
      }
      else if (changed && tab !== 'history') render0();
      else { tabs(); alerts(); }
    }
  });
  vscode.postMessage({ ready: true });
})();
