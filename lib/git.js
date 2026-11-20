// Git view of one session: the commits made while it ran, uncommitted changes in its folder, and, on
// request, the pull request for its branch (GitHub via `gh`, Azure DevOps via `az`) with its checks.
const fs = require('fs');
const { execFile } = require('child_process');

// git: a repository's config can make it run programs (core.fsmonitor, hooks); turn those off on every call.
const SAFE_GIT = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.untrackedCache=false'];
const run = (cmd, args, cwd, timeout = 15_000) => new Promise((resolve) =>
  execFile(cmd, cmd === 'git' ? [...SAFE_GIT, ...args] : args, { cwd, timeout, maxBuffer: 8_000_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, out, errOut) =>
    resolve({ ok: !err, out: String(out || ''), err: String(errOut || err?.message || '').trim() })));

/** Commits in the session's time window (any branch), plus the folder's branch and pending changes. */
async function sessionGit(cwd, start, end) {
  if (!cwd || !fs.existsSync(cwd)) return { ok: false, err: 'The session folder no longer exists.' };
  const top = await run('git', ['rev-parse', '--show-toplevel'], cwd);
  if (!top.ok) return { ok: false, err: 'Not a git repository.' };
  const root = top.out.trim();
  const branch = (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], root)).out.trim();
  const status = (await run('git', ['status', '--porcelain'], root)).out.split('\n').filter(Boolean);
  const since = Math.floor(start / 1000) - 60, until = Math.floor(end / 1000) + 600;
  // Only commits by this machine's git identity: `--all` also holds teammates' work fetched meanwhile.
  const email = (await run('git', ['config', 'user.email'], root)).out.trim();
  const log = await run('git', ['log', '--all', `--since=@${since}`, `--until=@${until}`, '--no-merges', '-n', '60', ...(email ? [`--author=${email}`] : []), '--pretty=format:%h%x09%ct%x09%an%x09%D%x09%s', '--shortstat'], root);
  const commits = [];
  let cur = null;
  for (const line of log.out.split('\n')) {
    const parts = line.split('\t');
    if (parts.length >= 5 && /^[0-9a-f]{7,}$/.test(parts[0])) { cur = { sha: parts[0], ts: Number(parts[1]) * 1000, author: parts[2], refs: parts[3], subject: parts.slice(4).join('\t'), files: 0, add: 0, del: 0 }; commits.push(cur); }
    else if (cur && /files? changed/.test(line)) {
      cur.files = Number((line.match(/(\d+) files? changed/) || [])[1] || 0);
      cur.add = Number((line.match(/(\d+) insertions?/) || [])[1] || 0);
      cur.del = Number((line.match(/(\d+) deletions?/) || [])[1] || 0);
    }
  }
  const remote = (await run('git', ['remote', 'get-url', 'origin'], root)).out.trim();
  const host = /github\.com/.test(remote) ? 'github' : /dev\.azure\.com|visualstudio\.com/.test(remote) ? 'azure' : remote ? 'other' : '';
  return { ok: true, root, branch, changes: status.length, commits, remote: remote.replace(/\/\/[^@/]+@/, '//'), host };
}

/** The pull request for a branch and its checks. Uses the GitHub or Azure CLI if installed and signed in. */
async function pullRequest(root, branch, host) {
  if (!branch || branch === 'HEAD') return { ok: false, err: 'Detached HEAD: no branch to look up.' };
  if (host === 'github') {
    const r = await run('gh', ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '3', '--json', 'number,title,url,state,isDraft,statusCheckRollup'], root, 20_000);
    if (!r.ok) return { ok: false, err: 'GitHub CLI (gh) not available or not signed in.' };
    let list = [];
    try { list = JSON.parse(r.out); } catch { /* empty */ }
    return { ok: true, prs: list.map((p) => ({ id: p.number, title: p.title, url: p.url, state: p.isDraft ? 'draft' : String(p.state).toLowerCase(), checks: (p.statusCheckRollup || []).map((c) => ({ name: c.name || c.context, state: String(c.conclusion || c.state || c.status || '').toLowerCase() })) })) };
  }
  if (host === 'azure') {
    const r = await run('az', ['repos', 'pr', 'list', '--source-branch', branch, '--status', 'all', '--top', '3', '-o', 'json'], root, 30_000);
    if (!r.ok) return { ok: false, err: 'Azure CLI (az) not available or not signed in (az login).' };
    let list = [];
    try { list = JSON.parse(r.out); } catch { /* empty */ }
    return { ok: true, prs: list.map((p) => ({ id: p.pullRequestId, title: p.title, state: p.isDraft ? 'draft' : String(p.status).toLowerCase(), url: p.repository?.webUrl ? `${p.repository.webUrl}/pullrequest/${p.pullRequestId}` : '', checks: p.mergeStatus ? [{ name: 'merge', state: String(p.mergeStatus).toLowerCase() }] : [] })) };
  }
  return { ok: false, err: 'Pull requests are looked up for GitHub and Azure DevOps remotes only.' };
}

/** `git show` for one commit (stat + patch), for an unsaved diff document. */
async function show(root, sha) {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) return '';
  const r = await run('git', ['show', '--stat', '--patch', '--no-color', sha], root, 20_000);
  return r.ok ? r.out.slice(0, 2_000_000) : '';
}

module.exports = { sessionGit, pullRequest, show };
