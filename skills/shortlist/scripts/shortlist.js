#!/usr/bin/env node
// shortlist — run only the tests your diff can reach. Zero dependencies.
//
//   shortlist                    human summary: which tests, and why
//   shortlist --list             just the test files, one per line
//   shortlist --cmd              the command that runs them (per runner, per workspace package)
//   shortlist --json             everything, machine-readable
//   shortlist --why <test>       the import chain from a test to the change that selected it
//   shortlist --github           write GitHub Actions outputs and a step summary
//   --base <ref>                 compare against this ref (default: PR base, origin/HEAD, main, master)
//   --root <dir>                 repository root (default: git toplevel of cwd)
//
// How it decides: it builds the import graph of the repo (JS/TS imports, requires, mocks, tsconfig
// paths, workspace packages; Python imports, relative imports, package __init__, conftest.py), then
// walks it backwards from every changed file to the test files that can reach it. Anything it cannot
// map with confidence (lockfiles, root config, CI workflows, unsupported languages, dynamic imports it
// cannot follow, an unknown base) makes it fall back to the full suite and say why.

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, statSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const JS_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const JS_RESOLVE_EXT = [...JS_EXT, '.json', '.vue', '.svelte', '.astro', '.d.ts'];
const CODE_JS = /\.(m|c)?[jt]sx?$|\.vue$|\.svelte$|\.astro$/;
const CODE_PY = /\.py$/;
const UNSUPPORTED = /\.(go|rs|rb|java|kt|kts|swift|c|cc|cpp|h|hpp|cs|php|scala|ex|exs|dart|m|mm|lua|zig|clj|hs|ml|fs)$/;
const DOCLIKE = /\.(md|mdx|txt|rst|adoc|png|jpe?g|gif|webp|svg|ico|pdf|mp4|mov|webm|mp3|wav|woff2?|ttf|otf|eot|psd|sketch|fig|drawio)$/i;

const DEFAULT_TESTS = [
  '**/*.test.{js,jsx,ts,tsx,mjs,cjs,mts,cts}', '**/*.spec.{js,jsx,ts,tsx,mjs,cjs,mts,cts}',
  '**/__tests__/**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}', '**/*_test.{js,ts}', '**/test.{js,jsx,ts,tsx,mjs,cjs,mts,cts}', '**/tests.{js,jsx,ts,tsx,mjs,cjs,mts,cts}', '**/*.test-d.{ts,tsx,mts,cts}',
  '**/test_*.py', '**/*_test.py',
];
const DEFAULT_IGNORE = [
  '**/*.md', '**/*.mdx', 'docs/**', '**/LICENSE*', '**/CHANGELOG*', '**/.gitignore', '**/.gitattributes',
  '**/.editorconfig', '.vscode/**', '.idea/**', '.github/ISSUE_TEMPLATE/**', '.github/*.md', '**/.prettierrc*',
  '**/.prettierignore', '.shortlist-cache/**', '**/.npmignore', '**/.dockerignore', '**/CODEOWNERS', '.github/*.yml',
  '.github/*.yaml', '**/renovate.json', '**/.eslintrc*', '**/eslint.config.*', '**/.oxlintrc*', '**/.oxfmtrc*',
  '**/biome.json', '**/.markdownlint*', '**/.lintstagedrc*', '**/.husky/**', '**/SECURITY*', '**/CONTRIBUTING*', '**/AGENTS.md',
];
// Changing one of these can change the result of any test at or below its directory.
const SCOPED_CONFIG = [
  '**/package.json', '**/tsconfig*.json', '**/jsconfig*.json', '**/jest.config.*', '**/vitest.config.*', '**/vitest.workspace.*',
  '**/vite.config.*', '**/babel.config.*', '**/.babelrc*', '**/.swcrc', '**/webpack.config.*', '**/rollup.config.*',
  '**/esbuild.config.*', '**/playwright.config.*', '**/.mocharc*', '**/ava.config.*', '**/.env.test*',
  '**/pyproject.toml', '**/setup.py', '**/setup.cfg', '**/pytest.ini', '**/tox.ini', '**/requirements*.txt', '**/Pipfile',
];
// Changing one of these can change anything. Always the full suite.
const FULL_ALWAYS = [
  '**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock', '**/bun.lock', '**/bun.lockb', '**/npm-shrinkwrap.json',
  '**/Pipfile.lock', '**/poetry.lock', '**/uv.lock', 'pnpm-workspace.yaml', '.nvmrc', 'mise.toml', '.mise.toml',
  '.node-version', '.tool-versions', '.python-version', '.shortlist.json', '.npmrc', 'turbo.json', 'nx.json',
];
// package.json fields that cannot change a test result. A change that touches only these is skipped.
const PKG_INERT = new Set(['name', 'version', 'description', 'keywords', 'author', 'contributors', 'maintainers', 'license', 'homepage',
  'repository', 'bugs', 'funding', 'files', 'publishConfig', 'private', 'readme', 'directories', 'packageManager', 'volta', 'prettier',
  'eslintConfig', 'lint-staged', 'husky', 'commitlint', 'release', 'changelog', 'np', 'xo', 'size-limit', 'typesVersions', 'man', 'bin', 'config']);


// ---------- small utilities ----------
function git(args, cwd) { const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }); return r.status === 0 ? r.stdout : null; }
function readText(root, p) { try { return readFileSync(join(root, p), 'utf8'); } catch { return ''; } }
const dirOf = (p) => { const d = posix.dirname(p); return d === '.' ? '' : d; };
function isUnder(p, dir) { return !dir || p === dir || p.startsWith(dir + '/'); }

export function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { i++; if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*'; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') { const end = glob.indexOf('}', i); const opts = glob.slice(i + 1, end).split(','); re += '(?:' + opts.map(o => o.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|') + ')'; i = end; }
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}
const matcher = (globs) => { const res = globs.map(globToRegex); return (p) => res.some(r => r.test(p)); };

export function parseJsonc(text) {
  let out = '', inStr = false, q = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inStr) { out += c; if (c === '\\') { out += n; i++; } else if (c === q) inStr = false; continue; }
    if (c === '"' || c === "'") { inStr = true; q = c; out += c; continue; }
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue; }
    out += c;
  }
  out = out.replace(/,(\s*[}\]])/g, '$1');
  try { return JSON.parse(out); } catch { return null; }
}

// ---------- repository inventory ----------
export function repoRoot(cwd = process.cwd()) { const t = git(['rev-parse', '--show-toplevel'], cwd); return t ? t.trim() : resolve(cwd); }

export function listFiles(root) {
  const out = git(['ls-files', '-z', '-c', '-o', '--exclude-standard'], root);
  if (out !== null) return [...new Set(out.split('\0').filter(Boolean))];
  const files = [];
  const skip = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.venv', 'venv', '__pycache__', 'target']);
  const walk = (d) => { let es; try { es = readdirSync(join(root, d), { withFileTypes: true }); } catch { return; }
    for (const e of es) { const p = d ? d + '/' + e.name : e.name; if (e.isDirectory()) { if (!skip.has(e.name)) walk(p); } else if (e.isFile()) files.push(p); } };
  walk('');
  return files;
}

export function loadConfig(root) {
  const c = existsSync(join(root, '.shortlist.json')) ? (parseJsonc(readText(root, '.shortlist.json')) || {}) : {};
  return {
    tests: c.tests || DEFAULT_TESTS,
    ignore: [...DEFAULT_IGNORE, ...(c.ignore || [])],
    full: [...FULL_ALWAYS, ...(c.full || [])],
    scoped: SCOPED_CONFIG,
    always: c.always || [],
    command: c.command || {},
  };
}

// ---------- the diff ----------
export function resolveBase(root, explicit) {
  const tries = [];
  if (explicit) tries.push(explicit);
  if (process.env.SHORTLIST_BASE) tries.push(process.env.SHORTLIST_BASE);
  if (process.env.GITHUB_BASE_REF) tries.push('origin/' + process.env.GITHUB_BASE_REF);
  const sym = git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], root);
  if (sym) tries.push(sym.trim().replace('refs/remotes/', ''));
  tries.push('origin/main', 'origin/master', 'main', 'master');
  const head = (git(['rev-parse', 'HEAD'], root) || '').trim();
  if (!head) return { error: 'not a git repository with commits' };
  for (const t of tries) {
    if (!git(['rev-parse', '--verify', '--quiet', t + '^{commit}'], root)) continue;
    const mb = (git(['merge-base', t, 'HEAD'], root) || '').trim();
    if (!mb) continue;
    if (mb === head && !explicit) {
      // On the base branch itself. Local edits: compare to HEAD. Clean tree (a push to main): the last commit.
      const dirty = (git(['status', '--porcelain'], root) || '').trim();
      if (dirty) return { ref: 'HEAD', sha: head, label: `${t} (on it; working tree vs HEAD)` };
      const prev = (git(['rev-parse', '--verify', '--quiet', 'HEAD~1'], root) || '').trim();
      if (prev) return { ref: prev, sha: prev, label: 'HEAD~1 (clean tree on base branch)' };
      return { ref: 'HEAD', sha: head, label: 'HEAD (single commit)' };
    }
    return { ref: mb, sha: mb, label: t };
  }
  return { error: `could not find a base to compare against (tried ${tries.join(', ')}). In CI, check out with fetch-depth: 0.` };
}

function parseNameStatus(out) {
  const res = []; if (!out) return res;
  const t = out.split('\0').filter(x => x !== '');
  for (let i = 0; i < t.length;) {
    const st = t[i++];
    if (st[0] === 'R' || st[0] === 'C') { res.push({ status: 'D', path: t[i++] }); res.push({ status: 'A', path: t[i++] }); }
    else res.push({ status: st[0], path: t[i++] });
  }
  return res;
}

export function changedFiles(root, baseRef) {
  const all = new Map();
  const add = (e) => { if (e.path && !e.path.startsWith('.shortlist-cache/')) all.set(e.path, e.status === 'D' && all.get(e.path) === 'A' ? 'M' : e.status); };
  if (baseRef !== 'HEAD') for (const e of parseNameStatus(git(['diff', '--name-status', '-M', '-z', baseRef, 'HEAD'], root))) add(e);
  for (const e of parseNameStatus(git(['diff', '--name-status', '-M', '-z', 'HEAD'], root))) add(e);
  const untracked = git(['ls-files', '-z', '-o', '--exclude-standard'], root);
  if (untracked) for (const p of untracked.split('\0').filter(Boolean)) add({ status: 'A', path: p });
  return [...all.entries()].map(([path, status]) => ({ path, status }));
}

// ---------- JS/TS resolution ----------
function workspaces(root, files) {
  const dirs = new Set();
  const rootPkg = parseJsonc(readText(root, 'package.json')) || {};
  let globs = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : (rootPkg.workspaces?.packages || []);
  const pnpm = readText(root, 'pnpm-workspace.yaml');
  if (pnpm) for (const m of pnpm.matchAll(/^\s*-\s*['"]?([^'"\n#]+?)['"]?\s*$/gm)) globs.push(m[1]);
  const inc = matcher(globs.filter(g => !g.startsWith('!')).map(g => g.replace(/\/$/, '')));
  for (const f of files) if (f.endsWith('/package.json')) { const d = dirOf(f); if (inc(d)) dirs.add(d); }
  const pkgs = [];
  for (const d of dirs) {
    const pj = parseJsonc(readText(root, d + '/package.json')) || {};
    if (!pj.name) continue;
    let entry = null;
    const exp = pj.exports;
    const expDot = typeof exp === 'string' ? exp : (exp && (typeof exp['.'] === 'string' ? exp['.'] : (exp['.']?.import || exp['.']?.default || exp['.']?.require || exp['.']?.types)));
    for (const cand of [pj.source, expDot, pj.module, pj.main, pj.types, 'src/index', 'index']) {
      if (typeof cand !== 'string') continue;
      entry = cand.replace(/^\.\//, '');
      break;
    }
    pkgs.push({ name: pj.name, dir: d, entry });
  }
  return pkgs.sort((a, b) => b.name.length - a.name.length);
}

function tsconfigs(root, files) {
  const out = [];
  for (const f of files) {
    if (!/(^|\/)(tsconfig|jsconfig)[^/]*\.json$/.test(f)) continue;
    let cfg = parseJsonc(readText(root, f));
    if (!cfg) continue;
    let dir = dirOf(f);
    // follow one level of a relative "extends" for paths/baseUrl
    if ((!cfg.compilerOptions?.paths) && typeof cfg.extends === 'string' && cfg.extends.startsWith('.')) {
      const ext = posix.normalize(posix.join(dir, cfg.extends.endsWith('.json') ? cfg.extends : cfg.extends + '.json'));
      const base = parseJsonc(readText(root, ext));
      if (base?.compilerOptions?.paths) { cfg = { compilerOptions: { ...base.compilerOptions, ...cfg.compilerOptions } }; dir = dirOf(ext); }
    }
    const co = cfg.compilerOptions || {};
    if (!co.paths && !co.baseUrl) continue;
    const baseDir = co.baseUrl ? posix.normalize(posix.join(dir, co.baseUrl)).replace(/^\.$/, '') : dir;
    out.push({ dir: dirOf(f), baseDir, paths: co.paths || {} });
  }
  return out.sort((a, b) => b.dir.length - a.dir.length);
}

function makeJsResolver(fileSet, pkgs, tscs) {
  const tryPath = (p) => {
    p = posix.normalize(p).replace(/^\.\//, '');
    if (p.startsWith('..')) return null;
    if (fileSet.has(p)) return p;
    for (const e of JS_RESOLVE_EXT) if (fileSet.has(p + e)) return p + e;
    const swapped = p.replace(/\.(m|c)?js$/, (m, x) => '.' + (x || '') + 'ts');
    if (swapped !== p) { if (fileSet.has(swapped)) return swapped; if (fileSet.has(swapped + 'x')) return swapped + 'x'; }
    if (/\.jsx$/.test(p) && fileSet.has(p.replace(/\.jsx$/, '.tsx'))) return p.replace(/\.jsx$/, '.tsx');
    for (const e of JS_RESOLVE_EXT) if (fileSet.has(p + '/index' + e)) return p + '/index' + e;
    return null;
  };
  return (from, spec) => {
    spec = spec.split('?')[0];
    if (spec.startsWith('.')) return { file: tryPath(posix.join(dirOf(from), spec)) };
    for (const t of tscs) {
      if (!isUnder(from, t.dir)) continue;
      for (const [alias, targets] of Object.entries(t.paths)) {
        const star = alias.indexOf('*');
        const hit = star < 0 ? (spec === alias ? '' : null) : (spec.startsWith(alias.slice(0, star)) && spec.endsWith(alias.slice(star + 1)) ? spec.slice(star, spec.length - (alias.length - star - 1)) : null);
        if (hit === null) continue;
        for (const tg of targets) { const r = tryPath(posix.join(t.baseDir, tg.replace('*', hit))); if (r) return { file: r }; }
      }
      if (t.baseDir !== undefined) { const r = tryPath(posix.join(t.baseDir, spec)); if (r) return { file: r }; }
    }
    for (const p of pkgs) {
      if (spec !== p.name && !spec.startsWith(p.name + '/')) continue;
      const sub = spec.slice(p.name.length + 1);
      if (sub) { const r = tryPath(posix.join(p.dir, sub)) || tryPath(posix.join(p.dir, 'src', sub)); return r ? { file: r } : { wildDir: p.dir }; }
      const cands = [p.entry && posix.join(p.dir, p.entry), posix.join(p.dir, 'src/index'), posix.join(p.dir, 'index')].filter(Boolean);
      for (const c of cands) { const r = tryPath(c) || tryPath(c.replace(/^(.*?)\/(dist|lib|build|out)\//, '$1/src/').replace(/\.d\.ts$/, '')); if (r) return { file: r }; }
      return { wildDir: p.dir }; // cannot find the entry: depend on the whole package
    }
    return {}; // external dependency
  };
}

const JS_STATIC = /(?:^|[^\w$.])(?:import|export)\s+(?:type\s+)?(?:[\w*${}\s,]+?\s+from\s+)?['"]([^'"\n]+)['"]/g;
const JS_CALL = /\b(?:require|import|require\.resolve|jest\.(?:mock|doMock|requireActual|unmock)|vi\.(?:mock|doMock|importActual|unmock))\s*\(\s*(['"`])([^'"`\n]*)\1\s*[,)]/g;
const JS_DYNAMIC = /\b(?:require|import)\s*\(\s*(?!['"`][^'"`$]*['"`]\s*[,)])(?!\))[^\s)]/;
const JS_GLOB = /\brequire\.context\s*\(|\bimport\.meta\.glob(?:Eager)?\s*\(/;

export function jsImports(src) {
  const specs = new Set();
  for (const m of src.matchAll(JS_STATIC)) specs.add(m[1]);
  for (const m of src.matchAll(JS_CALL)) if (!m[2].includes('${')) specs.add(m[2]);
  const reference = src.matchAll(/\/\/\/\s*<reference\s+path=["']([^"']+)["']/g);
  for (const m of reference) specs.add(m[1].startsWith('.') ? m[1] : './' + m[1]);
  const dynamic = JS_DYNAMIC.test(src.replace(/\bimport\s*\(\s*['"`][^'"`$]*['"`]\s*\)/g, '')) || JS_GLOB.test(src);
  return { specs: [...specs], dynamic };
}

// ---------- Python resolution ----------
export function pyImports(src) {
  const mods = []; // {level, module, names}
  const lines = src.replace(/\\\r?\n/g, ' ').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m = /^\s*import\s+(.+)$/.exec(line);
    if (m) { for (const part of m[1].split('#')[0].split(',')) { const name = part.trim().split(/\s+as\s+/)[0].trim(); if (/^[\w.]+$/.test(name)) mods.push({ level: 0, module: name, names: [] }); } continue; }
    m = /^\s*from\s+(\.*)([\w.]*)\s+import\s+(.*)$/.exec(line);
    if (m) {
      let rest = m[3].split('#')[0];
      if (rest.trim().startsWith('(') && !rest.includes(')')) { while (++i < lines.length) { rest += ' ' + lines[i].split('#')[0]; if (lines[i].includes(')')) break; } }
      const names = rest.replace(/[()]/g, ' ').split(',').map(s => s.trim().split(/\s+as\s+/)[0].trim()).filter(n => /^\w+$/.test(n));
      mods.push({ level: m[1].length, module: m[2], names });
    }
  }
  for (const m of src.matchAll(/\b(?:importlib\.import_module|__import__)\s*\(\s*['"]([\w.]+)['"]/g)) mods.push({ level: 0, module: m[1], names: [] });
  const dynamic = /\b(?:importlib\.import_module|__import__)\s*\(\s*(?!['"][\w.]+['"]\s*[,)])/.test(src);
  return { mods, dynamic };
}

function pyRoots(fileSet) {
  const roots = new Set(['', 'src', 'lib']);
  for (const f of fileSet) if (/(^|\/)(pyproject\.toml|setup\.py|setup\.cfg)$/.test(f)) { const d = dirOf(f); roots.add(d); roots.add(d ? d + '/src' : 'src'); }
  return [...roots];
}

function makePyResolver(fileSet) {
  const roots = pyRoots(fileSet);
  const moduleFiles = (root, dotted) => {
    const rel = dotted.split('.').join('/');
    const base = root ? root + '/' + rel : rel;
    const hit = fileSet.has(base + '.py') ? base + '.py' : fileSet.has(base + '/__init__.py') ? base + '/__init__.py' : null;
    if (!hit) return null;
    const out = [hit];
    const parts = dotted.split('.');
    for (let k = 1; k < parts.length; k++) { const init = (root ? root + '/' : '') + parts.slice(0, k).join('/') + '/__init__.py'; if (fileSet.has(init)) out.push(init); }
    return out;
  };
  return (from, imp) => {
    const out = [];
    const tryModule = (dotted) => {
      if (!dotted) return false;
      if (imp.level > 0) {
        let pkg = dirOf(from);
        for (let k = 1; k < imp.level; k++) pkg = dirOf(pkg);
        const r = moduleFiles(pkg, dotted); if (r) { out.push(...r); return true; } return false;
      }
      for (const root of roots) { const r = moduleFiles(root, dotted); if (r) { out.push(...r); return true; } }
      return false;
    };
    if (imp.level > 0 && !imp.module) {
      let pkg = dirOf(from); for (let k = 1; k < imp.level; k++) pkg = dirOf(pkg);
      const init = (pkg ? pkg + '/' : '') + '__init__.py'; if (fileSet.has(init)) out.push(init);
      for (const n of imp.names) tryModule(n);
      return out;
    }
    let any = false;
    for (const n of imp.names) if (tryModule(imp.module + '.' + n)) any = true;
    if (!tryModule(imp.module) && !any) return out;
    return out;
  };
}

// ---------- the graph ----------
export function buildGraph(root, files, cfg) {
  const fileSet = new Set(files);
  const isTest = matcher(cfg.tests);
  const tests = files.filter(f => isTest(f) && (CODE_JS.test(f) || CODE_PY.test(f)));
  const pkgs = workspaces(root, files);
  const resolveJs = makeJsResolver(fileSet, pkgs, tsconfigs(root, files));
  const resolvePy = makePyResolver(fileSet);
  const deps = new Map();   // file -> Set(files it depends on)
  const dynamic = [];
  const code = files.filter(f => CODE_JS.test(f) || CODE_PY.test(f));
  const addDep = (a, b) => { if (!b || a === b) return; (deps.get(a) || deps.set(a, new Set()).get(a)).add(b); };
  const wildDirs = [];
  for (const f of code) {
    const src = readText(root, f);
    if (CODE_JS.test(f)) {
      const { specs, dynamic: dyn } = jsImports(src);
      for (const s of specs) { const r = resolveJs(f, s); if (r.file) addDep(f, r.file); else if (r.wildDir) wildDirs.push([f, r.wildDir]); }
      if (dyn) { dynamic.push(f); wildDirs.push([f, dirOf(f)]); }
    } else {
      const { mods, dynamic: dyn } = pyImports(src);
      for (const m of mods) for (const r of resolvePy(f, m)) addDep(f, r);
      if (dyn) { dynamic.push(f); wildDirs.push([f, dirOf(f)]); }
      if (isTest(f)) { // pytest loads every conftest.py from the rootdir down to the test
        let d = dirOf(f);
        while (true) { const c = (d ? d + '/' : '') + 'conftest.py'; if (fileSet.has(c)) addDep(f, c); if (!d) break; d = dirOf(d); }
      }
    }
  }
  // a file that loads modules by computed name depends on everything under its directory
  for (const [f, d] of wildDirs) for (const g of files) if (g !== f && isUnder(g, d) && !isUnder(g, 'node_modules')) addDep(f, g);
  const rdeps = new Map();
  for (const [a, bs] of deps) for (const b of bs) (rdeps.get(b) || rdeps.set(b, new Set()).get(b)).add(a);
  return { deps, rdeps, tests, testSet: new Set(tests), pkgs, dynamic, fileSet };
}

// ---------- selection ----------
export function select(opts = {}) {
  const root = opts.root || repoRoot(opts.cwd);
  const cfg = loadConfig(root);
  const t0 = Date.now();
  const base = resolveBase(root, opts.base);
  const changed = base.error ? [] : changedFiles(root, base.ref);
  // deleted files still count as import targets: a test that imports a deleted module must run (and fail)
  const files = [...new Set([...listFiles(root), ...changed.filter(c => c.status === 'D').map(c => c.path)])];
  const graph = buildGraph(root, files, cfg);
  const result = { root, base: base.label || null, baseSha: base.sha || null, changed, total: 0, selected: [], full: false, reasons: [], via: {}, why: {}, ms: 0, dynamicFiles: graph.dynamic.length };
  const fullBecause = (why) => { result.full = true; result.reasons.push(why); };
  if (base.error) { fullBecause(base.error); return finish(); }
  const deletedSet = new Set(changed.filter(c => c.status === 'D').map(c => c.path));
  const isIgnored = matcher(cfg.ignore), isFull = matcher(cfg.full), isScoped = matcher(cfg.scoped), isAlways = matcher(cfg.always);
  const picked = new Map(); // test -> reason string
  const seeds = [];
  const testsUnder = (dir) => graph.tests.filter(t => isUnder(t, dir));

  for (const { path: p, status } of changed) {
    if (isIgnored(p)) continue;
    if (p.startsWith('.github/workflows/')) {
      // a workflow only matters if it is the one that runs the tests
      const text = status === 'D' ? (git(['show', `${base.ref}:${p}`], root) || 'test') : readText(root, p);
      if (/\b(npm (run )?test|pnpm (run )?test|yarn test|bun test|vitest|jest|mocha|pytest|tox|node --test|shortlist)\b/i.test(text)) fullBecause(`${p} changed (it runs the tests)`);
      continue;
    }
    if (isFull(p)) { fullBecause(`${p} changed (can affect every test)`); continue; }
    if (/(^|\/)package\.json$/.test(p) && status === 'M' && pkgInert(root, base.ref, p)) continue;
    if (/(^|\/)pyproject\.toml$/.test(p) && status === 'M' && pyInert(root, base.ref, p)) continue;
    if (isScoped(p)) {
      const d = dirOf(p);
      if (!d) { fullBecause(`${p} changed at the repo root`); continue; }
      const ts = testsUnder(d);
      for (const t of ts) if (!picked.has(t)) picked.set(t, `${p} changed (config for ${d}/)`);
      continue;
    }
    if (UNSUPPORTED.test(p)) { fullBecause(`${p} changed and shortlist does not map ${posix.extname(p)} files`); continue; }
    const isCode = CODE_JS.test(p) || CODE_PY.test(p);
    const imported = graph.rdeps.has(p);
    if (isCode || imported || graph.testSet.has(p)) { seeds.push(p); continue; }
    if (status === 'D' && !imported) continue;
    // an unimported data file: tests might read it from disk. Take the tests that live closest to it.
    let d = dirOf(p), scoped = [];
    while (d) { scoped = testsUnder(d); if (scoped.length) break; d = dirOf(d); }
    if (scoped.length) { for (const t of scoped) if (!picked.has(t)) picked.set(t, `${p} changed (no importer; tests under ${d}/)`); continue; }
    if (DOCLIKE.test(p)) continue;
    fullBecause(`${p} changed and nothing imports it`);
  }
  if (result.full) return finish();

  // walk the reverse import graph from every changed file
  const via = new Map();
  const queue = [];
  for (const s of seeds) { via.set(s, null); queue.push(s); }
  while (queue.length) {
    const f = queue.shift();
    for (const g of graph.rdeps.get(f) || []) if (!via.has(g)) { via.set(g, f); queue.push(g); }
  }
  for (const f of via.keys()) if (graph.testSet.has(f) && !deletedSet.has(f)) {
    let origin = f; while (via.get(origin)) origin = via.get(origin);
    if (!picked.has(f)) picked.set(f, origin === f ? `${f} changed` : `imports ${origin}`);
  }
  for (const t of graph.tests) if (isAlways(t) && !picked.has(t)) picked.set(t, 'always run (.shortlist.json)');
  result.selected = [...picked.keys()].filter(t => graph.fileSet.has(t) && !deletedSet.has(t)).sort();
  for (const t of result.selected) result.why[t] = picked.get(t);
  result.via = Object.fromEntries([...via.entries()].filter(([k]) => graph.testSet.has(k)).map(([k]) => [k, chain(k)]));
  function chain(t) { const c = [t]; let x = t; while (via.get(x)) { x = via.get(x); c.push(x); } return c; }
  return finish();

  function finish() {
    const deleted = new Set(changed.filter(c => c.status === 'D').map(c => c.path));
    const liveTests = graph.tests.filter(t => !deleted.has(t));
    result.total = liveTests.length;
    if (result.full) { result.selected = liveTests.slice().sort(); result.why = {}; }
    result.ms = Date.now() - t0;
    result.packages = graph.pkgs.map(p => p.dir);
    result.command = commandFor(root, result, cfg);
    return result;
  }
}

// A package.json edit that only touches metadata (version bump, description, files, publishConfig…) cannot
// change a test result. Anything else (dependencies, engines, type, exports, scripts.test…) can.
function pkgInert(root, baseRef, p) {
  const before = parseJsonc(baseRef === 'HEAD' ? (git(['show', `HEAD:${p}`], root) || '') : (git(['show', `${baseRef}:${p}`], root) || ''));
  const after = parseJsonc(readText(root, p));
  if (!before || !after) return false;
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[k]) === JSON.stringify(after[k])) continue;
    if (k === 'scripts') {
      const a = before.scripts || {}, b = after.scripts || {};
      for (const s of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[s] !== b[s] && /^(test|pretest|posttest)(:|$)/.test(s)) return false;
      continue;
    }
    if (!PKG_INERT.has(k)) return false;
  }
  return true;
}
// pyproject.toml: compare key by key (a dependency and a classifier look identical as lines).
export function tomlKeys(text) {
  const out = {}; let sect = '';
  const lines = String(text || '').split(/\r?\n/);
  const depth = (s) => (s.match(/[[{]/g) || []).length - (s.match(/[\]}]/g) || []).length;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].replace(/\s+#.*$/, '').trim();
    if (!t || t.startsWith('#')) continue;
    let m = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(t);
    if (m) { sect = m[1].replace(/["']/g, ''); continue; }
    m = /^([\w.\-"']+)\s*=\s*(.*)$/.exec(t);
    if (!m) continue;
    let val = m[2], d = depth(val);
    while (d > 0 && i + 1 < lines.length) { const nxt = lines[++i].replace(/\s+#.*$/, ''); val += ' ' + nxt; d += depth(nxt); }
    const key = sect + '::' + m[1].replace(/["']/g, '');
    out[key] = (out[key] ? out[key] + ' ' : '') + val.replace(/\s+/g, ' ').trim();
  }
  return out;
}
const PY_PROJECT_INERT = new Set(['name', 'version', 'description', 'readme', 'keywords', 'classifiers', 'authors', 'maintainers', 'license', 'license-files', 'urls', 'dynamic']);
const PY_RISKY_TOOL = /^tool\.(pytest|coverage|tox|nox|setuptools|poetry|pdm|uv|hatch|maturin|flit|scikit-build|cibuildwheel|pixi)\b/;
function pyKeyInert(key) {
  const [sect, k] = key.split('::');
  if (sect === 'project') return PY_PROJECT_INERT.has(k);
  if (/^project\.(urls|authors|maintainers)$/.test(sect)) return true;
  if (/^tool\./.test(sect)) return !PY_RISKY_TOOL.test(sect);
  return false; // build-system, dependency-groups, project.optional-dependencies, scripts, entry points…
}
function pyInert(root, baseRef, p) {
  const before = git(['show', `${baseRef}:${p}`], root);
  if (before === null) return false;
  const a = tomlKeys(before), b = tomlKeys(readText(root, p));
  const changed = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => a[k] !== b[k]);
  return changed.length > 0 && changed.every(pyKeyInert);
}

// ---------- runner commands ----------
const q = (s) => /[\s"'$`&|;()<>]/.test(s) ? `"${s.replace(/(["\\$`])/g, '\\$1')}"` : s;
function jsRunner(root, dir) {
  const pre = dir ? dir + '/' : '';
  const pj = parseJsonc(readText(root, pre + 'package.json')) || {};
  const deps = { ...pj.dependencies, ...pj.devDependencies };
  // the test script, else any test:* script (monorepo packages often only have test:lib / test:unit)
  const scripts = pj.scripts || {};
  const script = String(scripts.test || Object.entries(scripts).filter(([k]) => /^test(:|$)/.test(k)).map(([, v]) => v).join(' ; '));
  const hasFile = (re) => { try { return readdirSync(join(root, dir || '.')).some(n => re.test(n)); } catch { return false; } };
  if (!script && hasFile(/^vitest\.(config|workspace)\./)) return { run: (fs) => `npx vitest run ${fs}`, all: 'npx vitest run' };
  if (/\bvitest\b/.test(script) && !deps.vitest) deps.vitest = '*';
  if (!script && hasFile(/^jest\.config\./)) return { run: (fs) => `npx jest --runTestsByPath ${fs}`, all: 'npx jest' };
  if (/\bvitest\b/.test(script) || deps.vitest) return { run: (fs) => `npx vitest run ${fs}`, all: 'npx vitest run' };
  if (/\bjest\b/.test(script) || deps.jest) return { run: (fs) => `npx jest --runTestsByPath ${fs}`, all: 'npx jest' };
  if (/\bbun test\b/.test(script)) return { run: (fs) => `bun test ${fs}`, all: 'bun test' };
  if (/\bnode\b[^&|;]*--test\b/.test(script)) return { run: (fs) => `node --test ${fs}`, all: 'npm test' };
  if (/\bmocha\b/.test(script) || deps.mocha) return { run: (fs) => `npx mocha ${fs}`, all: 'npx mocha' };
  if (/\bava\b/.test(script) || deps.ava) return { run: (fs) => `npx ava ${fs}`, all: 'npx ava' };
  if (/\btap\b/.test(script) || deps.tap) return { run: (fs) => `npx tap ${fs}`, all: 'npx tap' };
  return null;
}
export function commandFor(root, result, cfg = loadConfig(root)) {
  const jsTests = result.selected.filter(t => CODE_JS.test(t));
  const pyTests = result.selected.filter(t => CODE_PY.test(t));
  const parts = [];
  const pkgDirs = result.packages || [];
  const owner = (t) => pkgDirs.filter(d => isUnder(t, d)).sort((a, b) => b.length - a.length)[0] ?? '';
  if (jsTests.length) {
    const groups = new Map();
    for (const t of jsTests) { const o = owner(t); (groups.get(o) || groups.set(o, []).get(o)).push(t); }
    for (const [dir, ts] of groups) {
      const r = jsRunner(root, dir) || (dir ? jsRunner(root, '') : null);
      const rel = ts.map(t => q(dir ? posix.relative(dir, t) : t)).join(' ');
      const custom = cfg.command.js;
      const cmd = custom ? custom.replace('{files}', rel) : r ? (result.full ? r.all : r.run(rel)) : 'npm test';
      parts.push(dir ? `(cd ${q(dir)} && ${cmd})` : cmd);
    }
  }
  if (pyTests.length) {
    const rel = pyTests.map(q).join(' ');
    const custom = cfg.command.py;
    parts.push(custom ? custom.replace('{files}', rel) : result.full ? 'python -m pytest' : `python -m pytest ${rel}`);
  }
  return parts.join(' && ');
}

// ---------- output ----------
export function format(r) {
  const out = [];
  const pct = r.total ? Math.round(100 * (1 - r.selected.length / r.total)) : 0;
  out.push(`shortlist  base ${r.base || 'unknown'}${r.baseSha ? ` (${r.baseSha.slice(0, 7)})` : ''}  ·  ${r.changed.length} file${r.changed.length === 1 ? '' : 's'} changed  ·  ${r.ms}ms`);
  if (r.full) {
    out.push(`FULL SUITE  ${r.total} test files`);
    for (const why of [...new Set(r.reasons)].slice(0, 5)) out.push(`  because ${why}`);
    if (r.reasons.length > 5) out.push(`  and ${r.reasons.length - 5} more reasons`);
  } else if (!r.selected.length) {
    out.push(`NO TESTS  none of the ${r.total} test files can reach this change`);
  } else {
    out.push(`RUN ${r.selected.length} of ${r.total} test files  (${pct}% skipped)`);
    for (const t of r.selected.slice(0, 25)) out.push(`  ${t}   ← ${r.why[t] || ''}`);
    if (r.selected.length > 25) out.push(`  and ${r.selected.length - 25} more (--list for all)`);
  }
  if (r.command) out.push('', r.command);
  return out.join('\n');
}

function githubOutput(r) {
  const pct = r.total ? Math.round(100 * (1 - r.selected.length / r.total)) : 0;
  const outFile = process.env.GITHUB_OUTPUT;
  const lines = [`count=${r.selected.length}`, `total=${r.total}`, `full=${r.full}`, `skipped-percent=${r.full ? 0 : pct}`, `cmd=${r.command || ''}`,
    `tests<<SHORTLIST_EOF\n${r.selected.join('\n')}\nSHORTLIST_EOF`, `reason=${r.full ? r.reasons[0] : ''}`];
  if (outFile) appendFileSync(outFile, lines.join('\n') + '\n');
  const sum = process.env.GITHUB_STEP_SUMMARY;
  if (sum) {
    const md = ['### shortlist', '', r.full ? `**Full suite** (${r.total} test files) because ${r.reasons[0]}.` : r.selected.length ? `**Ran ${r.selected.length} of ${r.total} test files** (${pct}% skipped), base \`${r.base}\`.` : `**No tests affected** by this change (${r.total} test files skipped).`,
      '', ...(!r.full && r.selected.length ? ['| test | why |', '|---|---|', ...r.selected.slice(0, 50).map(t => `| \`${t}\` | ${r.why[t] || ''} |`)] : [])];
    appendFileSync(sum, md.join('\n') + '\n');
  }
  return lines.join('\n');
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const args = process.argv.slice(2);
  const flag = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const r = select({ base: flag('--base'), root: flag('--root') ? resolve(flag('--root')) : undefined });
  if (args.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else if (args.includes('--list')) { if (r.selected.length) console.log(r.selected.join('\n')); }
  else if (args.includes('--cmd')) { if (r.command) console.log(r.command); }
  else if (args.includes('--github')) { githubOutput(r); console.log(format(r)); }
  else if (flag('--why')) {
    const t = flag('--why').replace(/\\/g, '/');
    if (r.full) console.log(`full suite: ${r.reasons[0]}`);
    else if (r.via[t]) console.log(r.via[t].join('\n  imports ') + '   (changed)');
    else console.log(r.selected.includes(t) ? `${t}: ${r.why[t]}` : `${t} is not selected: nothing it imports changed`);
  } else console.log(format(r));
}
