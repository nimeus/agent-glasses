// The pre-rename data folder moves to ~/.claude/agent-glasses once, and the old path keeps working.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { migrate, dataDir, legacyDir } = require('../lib/paths');

const tmpHome = () => { const h = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-home-')); fs.mkdirSync(path.join(h, '.claude')); return h; };

test('moves the old folder and leaves a working link', () => {
  const home = tmpHome(), from = legacyDir(home), to = dataDir(home);
  fs.mkdirSync(path.join(from, 'phone'), { recursive: true });
  fs.writeFileSync(path.join(from, 'phone', 'devices.json'), '[]');
  fs.writeFileSync(path.join(from, 'events.jsonl'), 'a\n');
  const r = migrate(home);
  assert.deepStrictEqual([r.moved, r.linked, r.error], [true, true, undefined]);
  assert.strictEqual(fs.readFileSync(path.join(to, 'phone', 'devices.json'), 'utf8'), '[]');
  assert.ok(fs.lstatSync(from).isSymbolicLink());
  fs.appendFileSync(path.join(from, 'events.jsonl'), 'b\n'); // an old hook still writing to the old path
  assert.strictEqual(fs.readFileSync(path.join(to, 'events.jsonl'), 'utf8'), 'a\nb\n');
  assert.deepStrictEqual(migrate(home), { moved: false, linked: false, kept: [] }, 'second run does nothing');
});

test('merges into an existing new folder without overwriting it', () => {
  const home = tmpHome(), from = legacyDir(home), to = dataDir(home);
  fs.mkdirSync(from); fs.mkdirSync(to);
  fs.writeFileSync(path.join(from, 'limits.json'), 'old');
  fs.mkdirSync(path.join(from, 'archive')); fs.writeFileSync(path.join(from, 'archive', 'days.json'), '{}');
  fs.writeFileSync(path.join(to, 'limits.json'), 'new');
  const r = migrate(home);
  assert.deepStrictEqual(r.kept, ['limits.json']);
  assert.strictEqual(fs.readFileSync(path.join(to, 'limits.json'), 'utf8'), 'new');
  assert.ok(fs.existsSync(path.join(to, 'archive', 'days.json')));
  assert.ok(!fs.lstatSync(from).isSymbolicLink(), 'old folder kept while it still holds a file');
});

test('nothing to do without an old folder', () => {
  const home = tmpHome();
  assert.deepStrictEqual(migrate(home), { moved: false, linked: false, kept: [] });
  assert.ok(!fs.existsSync(dataDir(home)));
});
