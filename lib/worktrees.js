// Git worktrees of the repos Claude Code worked in: size, clean/dirty, merged/unmerged, lock state.
// Removal is offered only for agent worktrees (<repo>/.claude/worktrees/*) that are clean, merged and unlocked,
// and goes through `git worktree remove` without --force, so git itself refuses anything with changes.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// A repository's own config can make git run programs (core.fsmonitor on `git status`, hooks); every automatic
// call turns those off. Filter drivers from .gitattributes remain a residual risk for untrusted repos.
const SAFE = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.untrackedCache=false'];
const git = (args, cwd, timeout = 20_000) => new Promise((resolve) =>
  execFile('git', [...SAFE, ...args], { cwd, timeout, maxBuffer: 8_000_000 }, (err, out, errOut) =>
    resolve({ ok: !err, out: String(out || ''), err: String(errOut || err?.message || '').trim() })));

const duKb = (dir) => new Promise((resolve) =>
  execFile('du', ['-sk', dir], { timeout: 90_000 }, (err, out) => resolve(err ? null : Number(String(out).split(/\s+/)[0]))));

/** Main worktree path of the repo containing `cwd`, or null. */
async function mainOf(cwd) {
  if (!fs.existsSync(cwd)) return null;
  const r = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  if (!r.ok) return null;
  const common = r.out.trim();
  return path.basename(common) === '.git' ? path.dirname(common) : null;
}

function parseList(text) {
  const out = [];
  let cur = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: line.slice(9), branch: '', head: '', locked: '', prunable: '' }; out.push(cur); }
    else if (!cur) continue;
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace('refs/heads/', '');
    else if (line.startsWith('locked')) cur.locked = line.slice(6).trim() || 'locked';
    else if (line.startsWith('prunable')) cur.prunable = line.slice(8).trim() || 'prunable';
    else if (line === 'detached') cur.branch = '(detached)';
  }
  return out;
}

let last = { at: 0, repos: [] };

/** Scans every repo seen in `cwds`. Slow (du), so it runs on demand and at most every few minutes. */
async function scan(cwds) {
  const mains = new Set();
  for (const c of cwds) { const m = await mainOf(c); if (m) mains.add(m); }
  const repos = [];
  for (const main of mains) {
    const list = parseList((await git(['worktree', 'list', '--porcelain'], main)).out);
    if (list.length < 2) continue;
    const mainBranch = list[0].branch;
    const bases = [];
    for (const b of [mainBranch, 'develop', 'master', 'main', 'v2/fork']) {
      if (b && !bases.includes(b) && (await git(['rev-parse', '--verify', '--quiet', 'refs/heads/' + b], main)).ok) bases.push(b);
    }
    const trees = [];
    for (const w of list.slice(1)) {
      const exists = fs.existsSync(w.path);
      const agent = w.path.includes(`${path.sep}.claude${path.sep}worktrees${path.sep}`);
      const dirty = exists ? (await git(['status', '--porcelain'], w.path)).out.trim().split('\n').filter(Boolean).length : 0;
      let mergedInto = '';
      for (const b of bases) {
        if (b === w.branch || !w.head) continue;
        if ((await git(['merge-base', '--is-ancestor', w.head, 'refs/heads/' + b], main)).ok) { mergedInto = b; break; }
      }
      const kb = exists ? await duKb(w.path) : 0;
      const removable = agent && exists && !dirty && !!mergedInto && !w.locked;
      const why = !agent ? 'not an agent worktree' : !exists ? 'folder is missing' : w.locked ? `locked: ${w.locked}` : dirty ? `${dirty} uncommitted change(s)` : !mergedInto ? 'not merged' : '';
      trees.push({ ...w, exists, agent, dirty, mergedInto, gb: kb ? kb / 1_048_576 : 0, removable, why });
    }
    repos.push({ main, name: path.basename(main), mainBranch, trees: trees.sort((a, b) => b.gb - a.gb) });
  }
  last = { at: Date.now(), repos };
  return last;
}

/** Removes one worktree from the last scan, re-checking it first; never forces. */
async function remove(wtPath) {
  const repo = last.repos.find((r) => r.trees.some((t) => t.path === wtPath));
  const t = repo?.trees.find((x) => x.path === wtPath);
  if (!repo || !t || !t.removable) return { ok: false, err: 'Not removable (rescan first).' };
  const status = await git(['status', '--porcelain'], wtPath);
  if (!status.ok || status.out.trim()) return { ok: false, err: 'It has uncommitted changes now.' };
  const r = await git(['worktree', 'remove', wtPath], repo.main, 120_000);
  return r.ok ? { ok: true, branch: t.branch } : { ok: false, err: r.err };
}

module.exports = { scan, remove, lastScan: () => last };
