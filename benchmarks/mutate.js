#!/usr/bin/env node
// Safety benchmark: does shortlist ever skip a test that would have failed?
//
//   node benchmarks/mutate.js <repo-dir> --pkg <subdir> [--k 20] [--seed 1] [--vitest "<cmd prefix>"]
//
// For K source files sampled from <pkg>/src, one at a time:
//   1. inject a runtime failure at the top of the file (throw on import)
//   2. ask shortlist which tests the change can reach (S)
//   3. run the package's FULL vitest suite and record every test file that actually failed (F)
//   4. a miss is a file in F that is not in S (after removing files that already fail with no mutation)
// The repo must already have its dependencies installed. Appends a row to benchmarks/mutate.jsonl.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { select, listFiles, loadConfig, buildGraph } from '../skills/shortlist/scripts/shortlist.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const root = resolve(args[0]);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const pkg = flag('--pkg', '');
const K = Number(flag('--k', 20));
let seed = Number(flag('--seed', 1));
const vitest = flag('--vitest', 'npx vitest run');
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const toRel = (p) => relative(root, p).split('\\').join('/');

function runSuite() {
  const out = join(root, pkg, '.shortlist-mutate.json');
  rmSync(out, { force: true });
  const t0 = Date.now();
  spawnSync(`${vitest} --reporter=json --outputFile=.shortlist-mutate.json`, { cwd: join(root, pkg), shell: true, encoding: 'utf8', timeout: 20 * 60 * 1000, env: { ...process.env, CI: '1' } });
  let j = null; try { j = JSON.parse(readFileSync(out, 'utf8')); } catch { /* none */ }
  rmSync(out, { force: true });
  if (!j) return { ok: false, ms: Date.now() - t0 };
  const failed = new Set(j.testResults.filter(t => t.status === 'failed').map(t => toRel(t.name)));
  return { ok: true, failed, files: j.testResults.length, ms: Date.now() - t0 };
}

const cfg = loadConfig(root);
const graph = buildGraph(root, listFiles(root), cfg);
const pkgTests = new Set(graph.tests.filter(t => !pkg || t.startsWith(pkg + '/')));
const srcPrefix = flag('--src', pkg ? pkg + '/src/' : 'src/');
const only = flag('--files', '') ? flag('--files').split(',') : null;
const sources = only || [...graph.fileSet].filter(f => f.startsWith(srcPrefix) &&/\.(m|c)?[jt]sx?$/.test(f) && !/\.d\.ts$/.test(f) && !graph.testSet.has(f) && !/__tests__|__mocks__|\.bench\./.test(f));
const sample = [];
const pool = sources.slice();
const want = Math.min(K, pool.length);
while (sample.length < want) sample.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);

console.log(`baseline run of ${pkg || '.'} ...`);
const base = runSuite();
if (!base.ok) { console.error('baseline suite did not produce a JSON report; is the repo installed?'); process.exit(1); }
console.log(`baseline: ${base.files} test files, ${base.failed.size} already failing, ${Math.round(base.ms / 1000)}s`);

const rows = [];
for (const f of sample) {
  const abs = join(root, f);
  const orig = readFileSync(abs, 'utf8');
  writeFileSync(abs, `throw new Error('shortlist-mutation');\n` + orig);
  try {
    const s = select({ root, base: 'HEAD' });
    const S = new Set(s.selected.filter(t => pkgTests.has(t)));
    const run = runSuite();
    const F = run.ok ? [...run.failed].filter(t => !base.failed.has(t)) : [];
    const misses = F.filter(t => !S.has(t));
    rows.push({ file: f, selected: S.size, failed: F.length, misses, full: s.full, ok: run.ok });
    console.log(`${misses.length ? 'MISS' : 'ok  '}  ${f}  selected ${S.size}, actually failed ${F.length}${misses.length ? '  missed: ' + misses.join(', ') : ''}`);
  } finally { writeFileSync(abs, orig); }
}

const done = rows.filter(r => r.ok);
const summary = {
  repo: toRel(root) || root, pkg, at: new Date().toISOString(), mutations: done.length, suiteFiles: base.files,
  mutationsThatBrokeTests: done.filter(r => r.failed > 0).length,
  failingTestFiles: done.reduce((a, r) => a + r.failed, 0),
  missedTestFiles: done.reduce((a, r) => a + r.misses.length, 0),
  avgSelected: Math.round(done.reduce((a, r) => a + r.selected, 0) / Math.max(1, done.length) * 10) / 10,
  avgActuallyFailed: Math.round(done.reduce((a, r) => a + r.failed, 0) / Math.max(1, done.length) * 10) / 10,
};
appendFileSync(join(here, 'mutate.jsonl'), JSON.stringify({ ...summary, rows }) + '\n');
console.log('\n' + JSON.stringify(summary, null, 2));
