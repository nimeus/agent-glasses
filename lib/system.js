// Machine guard: CPU, memory, swap, disk, Claude/Node processes and subagents against the configured cap.
// Defaults: warn when subagents reach CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS (4 if unset) and when free disk
// drops below claudeViz.diskWarnGb. Swap is watched too: swap growing on a nearly full disk can hang a Mac.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const mac = process.platform === 'darwin';
const run = (cmd, args) => new Promise((resolve) =>
  execFile(cmd, args, { timeout: 3000, maxBuffer: 4_000_000 }, (err, out) => resolve(err ? '' : String(out))));

/** CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS from ~/.claude/settings.json, then the environment, else 4. */
function agentCap() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'));
    const v = Number(s.env?.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS);
    if (v > 0) return v;
  } catch { /* fall through */ }
  const e = Number(process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS);
  return e > 0 ? e : 4;
}

let prevCpu = null;
/** CPU busy share across all cores since the previous call (0..1). */
function cpuUsage() {
  const now = os.cpus().reduce((a, c) => { const t = c.times; a.idle += t.idle || 0; a.total += (t.user || 0) + (t.nice || 0) + (t.sys || 0) + (t.idle || 0) + (t.irq || 0); return a; }, { idle: 0, total: 0 });
  const prev = prevCpu; prevCpu = now;
  if (!prev || now.total <= prev.total) return null;
  return 1 - (now.idle - prev.idle) / (now.total - prev.total);
}

/** macOS memory "used" the way Activity Monitor counts it: app (anonymous) + wired + compressed. */
async function memory() {
  const total = os.totalmem();
  if (!mac) return { total, used: total - os.freemem(), pressureFree: Math.round((os.freemem() / total) * 100) };
  const vm = await run('/usr/bin/vm_stat', []);
  const page = Number((vm.match(/page size of (\d+)/) || [])[1]) || 16384;
  const n = (label) => Number((vm.match(new RegExp(label + ':\\s+(\\d+)')) || [])[1]) || 0;
  const app = n('Anonymous pages') - n('Pages purgeable');
  const used = (Math.max(0, app) + n('Pages wired down') + n('Pages occupied by compressor')) * page;
  const level = Number((await run('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_level'])).trim());
  return { total, used: Math.min(used, total), compressed: n('Pages occupied by compressor') * page, pressureFree: Number.isFinite(level) && level > 0 ? level : null };
}

async function swap() {
  if (!mac) return null;
  const out = await run('/usr/sbin/sysctl', ['-n', 'vm.swapusage']);
  const mb = (k) => { const m = out.match(new RegExp(k + '\\s*=\\s*([\\d.]+)([MG])')); return m ? Number(m[1]) * (m[2] === 'G' ? 1024 : 1) : 0; };
  return { totalGb: mb('total') / 1024, usedGb: mb('used') / 1024 };
}

/** Claude Code and Node processes, and the biggest memory users overall. */
async function processes() {
  const out = await run('/bin/ps', ['-A', '-o', 'rss=,comm=']);
  const rows = out.split('\n').map((l) => { const m = l.trim().match(/^(\d+)\s+(.+)$/); return m ? { kb: Number(m[1]), name: path.basename(m[2]) } : null; }).filter(Boolean);
  const group = (test) => rows.filter((r) => test(r.name)).reduce((a, r) => ({ n: a.n + 1, gb: a.gb + r.kb / 1_048_576 }), { n: 0, gb: 0 });
  // Top memory users, with same-named processes added together (browser helpers, node workers …).
  const by = new Map();
  for (const r of rows) { const k = r.name.replace(/ Helper.*$/, '').slice(0, 40); const x = by.get(k) || { name: k, n: 0, gb: 0 }; x.n++; x.gb += r.kb / 1_048_576; by.set(k, x); }
  return {
    claude: group((n) => n === 'claude'),
    node: group((n) => n === 'node'),
    top: [...by.values()].sort((a, b) => b.gb - a.gb).slice(0, 6),
  };
}

async function machine(agents, diskWarnGb = 30) {
  let diskFreeGb = null, diskTotalGb = null;
  try {
    const s = await fs.promises.statfs(mac ? '/System/Volumes/Data' : '/');
    diskFreeGb = (s.bavail * s.bsize) / 1e9; diskTotalGb = (s.blocks * s.bsize) / 1e9;
  } catch { /* unknown */ }
  const [mem, sw, procs] = await Promise.all([memory(), swap(), processes()]);
  const cpu = cpuUsage();
  const load = os.loadavg()[0] / os.cpus().length;
  const cap = agentCap();
  const memFreePct = mem.pressureFree;

  const lvl = (bad, warn) => (bad ? 'bad' : warn ? 'warn' : 'ok');
  const levels = {
    disk: diskFreeGb === null ? 'ok' : lvl(diskFreeGb < diskWarnGb * (2 / 3), diskFreeGb < diskWarnGb),
    mem: memFreePct == null ? 'ok' : lvl(memFreePct < 10, memFreePct < 20),
    swap: !sw ? 'ok' : lvl(sw.usedGb > 12, sw.usedGb > 6),
    ag: lvl(agents > cap, agents === cap),
    cpu: lvl((cpu ?? load) > 0.9, (cpu ?? load) > 0.75),
  };
  const all = Object.values(levels);
  return {
    agents, cap, diskFreeGb, diskTotalGb, diskWarnGb, memFreePct, load, cpuPct: cpu, // `cpu` itself is the level below
    // Memory in GiB, as macOS reports it (16 GB of RAM reads as 16, not 17.2).
    memUsedGb: mem.used / 2 ** 30, memTotalGb: mem.total / 2 ** 30, compressedGb: (mem.compressed || 0) / 2 ** 30,
    swapUsedGb: sw ? sw.usedGb : null, swapTotalGb: sw ? sw.totalGb : null,
    procs, cores: os.cpus().length, uptimeH: os.uptime() / 3600,
    ...levels, level: all.includes('bad') ? 'bad' : all.includes('warn') ? 'warn' : 'ok',
  };
}

module.exports = { machine };
