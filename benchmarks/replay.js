#!/usr/bin/env node
// Replay benchmark: how much of the suite would shortlist have skipped on a real repo's recent history?
//
//   node benchmarks/replay.js <git-url> [--commits 50] [--name x] [--config '<json for .shortlist.json>']
//
// Clones the repo (shallow, enough history), walks the last N non-merge commits, and for each one asks
// shortlist which tests the commit's diff can reach (base = the commit's parent). No install, no test
// runs: this measures selection size only. Safety is measured separately by mutate.js.
// Appends one JSON row per repo to benchmarks/replay.jsonl.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { select } from '../skills/shortlist/scripts/shortlist.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const url = args.find(a => !a.startsWith('--') && !['--commits', '--name', '--config'].includes(args[args.indexOf(a) - 1]));
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const N = Number(flag('--commits', 50));
const name = flag('--name', url.split('/').slice(-2).join('/').replace(/\.git$/, ''));
const work = join(here, 'work', name.replace('/', '__'));
const g = (a, cwd = work) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout; };

mkdirSync(join(here, 'work'), { recursive: true });
if (!existsSync(work)) g(['clone', '-q', '--filter=blob:none', '--depth', String(N * 3 + 10), '--single-branch', url, work], here);
const commits = g(['log', '--no-merges', '--format=%H', '-n', String(N)]).trim().split('\n');
const cfg = flag('--config', '');
const rows = [];
const t0 = Date.now();
for (const c of commits) {
  g(['checkout', '-q', '--detach', c]);
  if (cfg) writeFileSync(join(work, '.shortlist.json'), cfg);
  let r;
  try { r = select({ root: work, base: c + '~1' }); } catch (e) { rows.push({ c, error: String(e.message).slice(0, 200) }); continue; }
  const changedCode = r.changed.filter(x => /\.(m|c)?[jt]sx?$|\.py$/.test(x.path)).length;
  rows.push({ c: c.slice(0, 10), changed: r.changed.length, changedCode, total: r.total, selected: r.selected.length, full: r.full, reason: r.full ? r.reasons[0] : '', ms: r.ms });
  if (cfg) rmSync(join(work, '.shortlist.json'), { force: true });
  process.stdout.write(`${c.slice(0, 8)}  ${r.full ? 'FULL' : String(r.selected.length).padStart(4)} / ${r.total}  ${r.ms}ms  ${r.full ? r.reasons[0].slice(0, 70) : ''}\n`);
}
g(['checkout', '-q', '-']);

const ok = rows.filter(r => !r.error && r.total > 0);
const ran = ok.map(r => r.full ? r.total : r.selected);
const frac = ok.map((r, i) => ran[i] / r.total).sort((a, b) => a - b);
const median = frac.length ? frac[Math.floor(frac.length / 2)] : 0;
const totalRun = ran.reduce((a, b) => a + b, 0), totalAll = ok.reduce((a, r) => a + r.total, 0);
const summary = {
  repo: name, at: new Date().toISOString(), commits: ok.length, testFiles: ok.at(-1)?.total ?? 0,
  fullRuns: ok.filter(r => r.full).length, zeroRuns: ok.filter(r => !r.full && r.selected === 0).length,
  medianRunPct: Math.round(median * 1000) / 10, medianSelected: ran.slice().sort((a, b) => a - b)[Math.floor(ran.length / 2)] ?? 0, overallSkippedPct: totalAll ? Math.round(100 * (1 - totalRun / totalAll)) : 0,
  medianMs: ok.map(r => r.ms).sort((a, b) => a - b)[Math.floor(ok.length / 2)] ?? 0,
  fullReasons: Object.entries(ok.filter(r => r.full).reduce((m, r) => { const k = r.reason.replace(/^\S+ changed/, 'X changed').slice(0, 60); m[k] = (m[k] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 5),
  seconds: Math.round((Date.now() - t0) / 1000),
};
appendFileSync(join(here, 'replay.jsonl'), JSON.stringify({ ...summary, rows }) + '\n');
console.log('\n' + JSON.stringify(summary, null, 2));
