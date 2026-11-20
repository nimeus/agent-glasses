// Where Agent Glasses keeps its own files: ~/.claude/agent-glasses/ (status-line figures, hook events,
// phone keys, archive). Before the rename it was ~/.claude/claude-viz/; migrate() moves that folder here once
// and leaves a link at the old path, so status-line and hook commands that still name it keep working.
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = (home = os.homedir()) => path.join(home, '.claude', 'agent-glasses');
const legacyDir = (home = os.homedir()) => path.join(home, '.claude', 'claude-viz');
const DATA_DIR = dataDir();

const lstat = (p) => { try { return fs.lstatSync(p); } catch { return null; } };

/**
 * Moves the pre-rename data folder to the new one. Idempotent; never deletes a file.
 * - only the old folder exists: rename it, then link old → new;
 * - both exist (a script already wrote to the new one): move each old entry the new folder lacks, keep the
 *   rest in place, and link old → new only if the old folder ended up empty;
 * - the old path is already a link, or there is no old folder: nothing to do.
 * @returns {{ moved: boolean, linked: boolean, kept: string[], error?: string }}
 */
function migrate(home = os.homedir()) {
  const from = legacyDir(home), to = dataDir(home);
  const result = { moved: false, linked: false, kept: [] };
  const old = lstat(from);
  if (!old || old.isSymbolicLink() || !old.isDirectory()) return result;
  try {
    let whole = false;
    if (!lstat(to)) {
      fs.renameSync(from, to);
      result.moved = whole = true;
    } else {
      for (const name of fs.readdirSync(from)) {
        if (lstat(path.join(to, name))) { result.kept.push(name); continue; }
        fs.renameSync(path.join(from, name), path.join(to, name));
        result.moved = true;
      }
      if (result.kept.length) return result; // old folder still holds files: leave it, never overwrite
      fs.rmdirSync(from); // empty now
    }
    // 'junction' makes a directory link on Windows without admin rights; other systems ignore the type.
    try {
      fs.symlinkSync(to, from, 'junction');
      result.linked = true;
    } catch (e) {
      // Without the link, commands that name the old path would break: put the folder back if it moved whole.
      if (whole && !lstat(from)) { try { fs.renameSync(to, from); result.moved = false; } catch { /* leave it */ } }
      throw e;
    }
  } catch (e) {
    result.error = String(e.message || e);
  }
  return result;
}

module.exports = { DATA_DIR, dataDir, legacyDir, migrate };
