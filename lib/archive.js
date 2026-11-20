// Claude Viz's own history, kept after Claude Code's 30-day transcript cleanup deletes the transcripts:
// one summary per session and one row of totals per day, in ~/.claude/claude-viz/archive/.
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(os.homedir(), '.claude', 'claude-viz', 'archive');
const SESSIONS = path.join(DIR, 'sessions.json');
const DAYS = path.join(DIR, 'days.json');
const DAY_FIELDS = ['units', 'est', 'estMain', 'estSub', 'active', 'tools', 'errors', 'commits', 'work', 'blocked', 'failMs', 'greens', 'hits', 'approvals', 'wait', 'denied', 'think', 'cacheMiss', 'missCost'];

const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
/** Writes through a temp file and a rename, so a crash never leaves half a file. */
function write(f, value) {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, f);
}

let sessions = null, days = null;
const loadSessions = () => (sessions ??= read(SESSIONS));
const loadDays = () => (days ??= read(DAYS));

const SESSION_FIELDS = ['id', 'project', 'cwd', 'entrypoint', 'branch', 'start', 'lastTs', 'title', 'firstPrompt', 'lastPrompt', 'sizeMb', 'subs', 'est'];

/**
 * Records every session currently on disk. A session whose transcript has gone keeps its last summary,
 * flagged `gone`, so History and lifetime totals survive the cleanup.
 */
function saveSessions(list) {
  const arc = loadSessions();
  const present = new Set();
  for (const x of list) {
    present.add(x.id);
    const prev = arc[x.id] || {};
    const next = {};
    for (const k of SESSION_FIELDS) next[k] = x[k] ?? prev[k] ?? null;
    if (prev.est != null && (next.est == null || next.est < prev.est)) next.est = prev.est; // never lose a fuller cost
    next.gone = false;
    arc[x.id] = next;
  }
  for (const [id, x] of Object.entries(arc)) if (!present.has(id)) x.gone = true;
  write(SESSIONS, arc);
}

/** Archived sessions whose transcripts no longer exist. */
const goneSessions = () => Object.values(loadSessions()).filter((x) => x.gone);

/**
 * Stores daily totals. A day is only overwritten by a reading with at least as many tool calls, so a day
 * whose transcripts were cleaned up keeps its archived figures instead of dropping to zero.
 */
function saveDays(list) {
  const arc = loadDays();
  let changed = false;
  for (const d of list) {
    const prev = arc[d.key];
    if (prev && (prev.tools || 0) > (d.tools || 0)) continue;
    const row = { label: d.label };
    for (const k of DAY_FIELDS) row[k] = d[k] || 0;
    row.hours = d.hours;
    arc[d.key] = row; changed = true;
  }
  if (changed) write(DAYS, arc);
}

/** Every archived day, oldest first, as { key, ...totals }. */
const allDays = () => Object.entries(loadDays()).map(([key, v]) => ({ key, ...v })).sort((a, b) => (a.key < b.key ? -1 : 1));

module.exports = { saveSessions, goneSessions, saveDays, allDays, DIR };
