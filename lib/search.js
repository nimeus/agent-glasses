// Full-text search across every transcript (prompts, replies, tool output). The system grep finds the
// matching files quickly; each match is then read properly to show a clean snippet.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execFile } = require('child_process');
const data = require('./data');

const GREP = fs.existsSync('/usr/bin/grep') ? '/usr/bin/grep' : 'grep';

function grepFiles(q) {
  return new Promise((resolve) =>
    // -F fixed string, -i any case, -l file names only; `--` stops a leading '-' being read as an option.
    execFile(GREP, ['-r', '-l', '-i', '-F', '--include=*.jsonl', '--', q, data.ROOT], { timeout: 30_000, maxBuffer: 8_000_000 }, (err, out) =>
      resolve(String(out || '').split('\n').filter(Boolean))));
}

const textOf = (j) => {
  const c = j.message?.content;
  if (j.type === 'queue-operation' && typeof j.content === 'string') return { role: 'You', text: j.content };
  if (typeof c === 'string') return { role: j.type === 'user' ? 'You' : 'Claude', text: c };
  if (!Array.isArray(c)) return null;
  const parts = c.map((p) => p.text || (p.type === 'tool_result' ? (typeof p.content === 'string' ? p.content : Array.isArray(p.content) ? p.content.map((x) => x.text || '').join(' ') : '') : p.type === 'tool_use' ? JSON.stringify(p.input || {}) : '')).join(' ');
  const role = j.type === 'assistant' ? (c.some((p) => p.type === 'tool_use') ? 'Tool call' : 'Claude') : c.some((p) => p.type === 'tool_result') ? 'Tool output' : 'You';
  return { role, text: parts };
};

/** First readable occurrence of `q` in a transcript, with its role, time and surrounding text. */
async function firstMatch(file, needle) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  let count = 0, hit = null;
  for await (const line of rl) {
    if (!line.toLowerCase().includes(needle)) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const t = textOf(j);
    if (!t) continue;
    const flat = t.text.replace(/\s+/g, ' ');
    const at = flat.toLowerCase().indexOf(needle);
    if (at < 0) continue;
    count++;
    if (!hit) hit = { role: t.role, ts: Date.parse(j.timestamp) || 0, snippet: data.redact((at > 70 ? '…' : '') + flat.slice(Math.max(0, at - 70), at + needle.length + 110) + (at + needle.length + 110 < flat.length ? '…' : '')) };
    if (count >= 50) break;
  }
  rl.close();
  return hit ? { ...hit, count } : null;
}

/** Sessions containing `q` anywhere, newest first; subagent hits count for their session. */
async function fullText(q) {
  const needle = String(q || '').trim().toLowerCase();
  if (needle.length < 3 || needle.length > 200) return { q, results: [], note: 'Type at least 3 characters.' };
  const files = await grepFiles(needle);
  const bySession = new Map();
  for (const f of files) {
    const m = f.match(/([^/]+)\/subagents\/agent-[^/]+\.jsonl$/);
    const main = m ? path.join(path.dirname(path.dirname(f)) + '.jsonl') : f;
    const id = path.basename(main, '.jsonl');
    const e = bySession.get(id) || { id, main, files: [] };
    e.files.push(f); bySession.set(id, e);
  }
  const results = [];
  for (const e of bySession.values()) {
    let info = null;
    try { info = data.listSessionInfo(e.main); } catch { /* transcript gone */ }
    results.push({ id: e.id, title: info?.title || 'Session ' + e.id.slice(0, 8), project: info?.project || '', lastTs: info?.lastTs || 0, cwd: info?.cwd || '', entrypoint: info?.entrypoint || '', inSubagents: e.files.filter((f) => f.includes('/subagents/')).length, file: e.files.find((f) => !f.includes('/subagents/')) || e.files[0] });
  }
  results.sort((a, b) => b.lastTs - a.lastTs);
  const top = results.slice(0, 25);
  for (const r of top) { try { r.match = await firstMatch(r.file, needle); } catch { r.match = null; } delete r.file; }
  return { q, results: top, total: results.length };
}

module.exports = { fullText };
