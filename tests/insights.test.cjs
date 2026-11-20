// The unblock coach must never offer one-click rules for commands that can run anything.
const test = require('node:test');
const assert = require('node:assert');
const { coach } = require('../lib/insights');

const approvals = (cmds) => cmds.flatMap((cmd) => [0, 1].map(() => ({ name: 'Bash', cmd, url: '', cwd: '', project: 'p', ts: Date.now(), wait: 1000 })));

test('safe commands can be allowed with one click', () => {
  const items = coach(approvals(['npx vitest run a.test.ts', 'git commit -m x'])).items;
  for (const r of ['Bash(npx vitest:*)', 'Bash(git commit:*)']) assert.strictEqual(items.find((g) => g.rule === r)?.risky, false, r);
});

test('command runners and destructive commands are copy-only', () => {
  const cmds = ['rm -rf build', 'sudo ls', 'python3 x.py', 'npm run build', 'xargs echo', 'find . -exec ls', 'env FOO=1 make', 'git push origin main'];
  const items = coach(approvals(cmds)).items;
  for (const g of items) assert.strictEqual(g.risky, true, g.rule);
});

test('chained commands are split into their parts', () => {
  const c = coach(approvals(['cd /x && npx vitest run && tail -5 log.txt']));
  assert.strictEqual(c.chained, 2);
  assert.ok(c.items.some((g) => g.rule === 'Bash(tail:*)'));
});
