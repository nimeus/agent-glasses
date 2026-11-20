// Exports for one session: a Markdown report, a CSV of turns, the raw insight JSON, and the conversation
// itself as Markdown. Each is returned as text; the extension opens it as an unsaved document.
const fs = require('fs');
const readline = require('readline');
const data = require('./data');

const money = (v) => `$${(v || 0).toFixed(2)}`;
const mins = (ms) => { const m = Math.round((ms || 0) / 60000); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };
const when = (ts) => (ts ? new Date(ts).toLocaleString() : '');
const cell = (s) => `"${String(s ?? '').replace(/"/g, '""').replace(/\s+/g, ' ')}"`;
const mdEscape = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ');

function report(d) {
  const out = [
    `# ${d.title}`, '',
    `- **Project:** ${d.project}${d.branches.length ? ` (${d.branches.join(', ')})` : ''}`,
    `- **When:** ${when(d.start)} → ${when(d.end)}; your active time ${mins(d.active)}`,
    `- **Models:** ${d.models.map((m) => `${m.model} (${money(m.cost)})`).join(', ')}`,
    `- **Estimated cost:** ${money(d.cost)} at API prices (main ${money(d.mainCost)}, subagents ${money(d.subCost)})`,
    `- **Tool calls:** ${d.calls} (${d.failed} failed); subagents: ${d.subagents.length}; commits: ${d.commits}; tests green again: ${d.greens}`,
    `- **Tokens:** input ${d.tokens.input}, cache write ${d.tokens.cacheWrite}, cache read ${d.tokens.cacheRead}, output ${d.tokens.output}; context peak ${d.ctxPeak}`,
    `- **Approvals:** ${d.approvals} (${mins(d.wait)} waiting), denied ${d.denied}; interrupted ${d.interrupts}; API errors ${d.apiErrors}`,
    '', '## Prompts', '', '| # | Time | Duration | Tools | Cost | Prompt |', '|---:|---|---:|---:|---:|---|',
    ...d.turns.filter((t) => t.text).map((t, i) => `| ${i + 1} | ${when(t.ts)} | ${mins(t.dur)} | ${t.tools} | ${money(t.total)} | ${mdEscape(t.text).slice(0, 200)} |`),
    '', '## Tools', '', '| Tool | Calls | Failed | Time |', '|---|---:|---:|---:|',
    ...d.tools.map((t) => `| ${t.name} | ${t.calls} | ${t.failed} | ${mins(t.ms)} |`),
  ];
  if (d.subagents.length) out.push('', '## Subagents', '', '| Task | Type | Calls | Cost |', '|---|---|---:|---:|', ...d.subagents.map((a) => `| ${mdEscape(a.name || a.id)} | ${a.type} | ${a.calls} | ${money(a.cost)} |`));
  if (d.files.length) out.push('', '## Files edited', '', ...d.files.map((f) => `- \`${f.path}\` (${f.n}×)`));
  if (d.errors.length) out.push('', '## Recent errors', '', ...d.errors.map((e) => `- ${when(e.ts)} **${e.name}** ${mdEscape(e.hint)}: ${mdEscape(e.text).slice(0, 200)}`));
  return out.join('\n') + '\n';
}

function csv(d) {
  const rows = [['turn', 'started', 'duration_min', 'tools', 'failed', 'subagents', 'cost_usd', 'subagent_cost_usd', 'prompt']];
  d.turns.filter((t) => t.text).forEach((t, i) => rows.push([i + 1, new Date(t.ts).toISOString(), ((t.dur || 0) / 60000).toFixed(1), t.tools, t.failed, t.subagents, t.total.toFixed(4), t.subCost.toFixed(4), t.text]));
  return rows.map((r) => r.map(cell).join(',')).join('\n') + '\n';
}

/** The conversation as Markdown: your prompts, Claude's replies, and one line per tool call (no tool output). */
async function conversation(file, title) {
  const out = [`# ${title}`, ''];
  let size = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  const push = (s) => { out.push(s); size += s.length; };
  const failed = new Set();
  for await (const line of rl) {
    if (size > 3_000_000) { out.push('', '_…cut off at 3 MB._'); break; }
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const ts = j.timestamp ? new Date(j.timestamp).toLocaleTimeString() : '';
    const you = data.userText(j);
    if (you) { push(`\n### You · ${ts}\n\n${data.redact(you)}\n`); continue; }
    const c = j.message?.content;
    if (!Array.isArray(c)) continue;
    for (const p of c) {
      if (j.type === 'assistant' && p.type === 'text' && p.text.trim()) push(`\n**Claude** · ${ts}\n\n${data.redact(p.text.trim())}\n`);
      else if (j.type === 'assistant' && p.type === 'tool_use') push(`- \`${p.name}\` ${data.redact(data.describe(p.input).hint)}`);
      else if (p.type === 'tool_result' && p.is_error && !failed.has(p.tool_use_id)) { failed.add(p.tool_use_id); push('  - ✕ failed'); }
    }
  }
  rl.close();
  return out.join('\n') + '\n';
}

module.exports = { report, csv, conversation };
