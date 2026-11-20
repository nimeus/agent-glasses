// Syntax check for every source file (there is no build step).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const files = [];
const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory() && !['node_modules', '.git'].includes(e.name)) walk(p); else if (/\.(c|m)?js$/.test(e.name)) files.push(p); } };
walk('.');
let failed = 0;
for (const f of files) { try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); } catch (e) { failed++; console.error(String(e.stderr || e.message)); } }
console.log(`${files.length - failed}/${files.length} files OK`);
process.exit(failed ? 1 : 0);
