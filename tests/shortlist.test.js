import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { select, jsImports, pyImports, globToRegex, parseJsonc } from '../skills/shortlist/scripts/shortlist.js';

// ---- a real git repo per scenario: commit the base, then change files on a branch -------------
function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'shortlist-t-'));
  const g = (...a) => spawnSync('git', ['-c', 'user.email=t@t.t', '-c', 'user.name=t', ...a], { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  write(dir, files);
  g('add', '-A'); g('commit', '-qm', 'base');
  g('checkout', '-q', '-b', 'feature');
  return {
    dir, g,
    change(files) { write(dir, files); },
    remove(p) { unlinkSync(join(dir, p)); },
    commit(msg = 'change') { g('add', '-A'); g('commit', '-qm', msg); },
    sel(opts = {}) { return select({ root: dir, ...opts }); },
    done() { rmSync(dir, { recursive: true, force: true }); },
  };
}
function write(dir, files) { for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), c); } }

const JSAPP = {
  'package.json': JSON.stringify({ name: 'app', scripts: { test: 'node --test' } }),
  'src/a.js': 'export const a = 1;\n',
  'src/b.js': "import { a } from './a.js';\nexport const b = a + 1;\n",
  'src/c.js': 'export const c = 3;\n',
  'src/util/index.js': 'export const u = 1;\n',
  'src/d.js': "const { u } = require('./util');\nmodule.exports = { d: u };\n",
  'tests/a.test.js': "import { a } from '../src/a.js';\n",
  'tests/b.test.js': "import { b } from '../src/b.js';\n",
  'tests/c.test.js': "import { c } from '../src/c.js';\n",
  'tests/d.test.js': "const { d } = require('../src/d');\n",
  'tests/helpers.js': 'export const h = 1;\n',
  'tests/e.test.js': "import { h } from './helpers.js';\n",
  'README.md': '# app\n',
};

test('a change selects the tests that reach it, directly and transitively, and nothing else', () => {
  const r = repo(JSAPP);
  try {
    r.change({ 'src/a.js': 'export const a = 2;\n' });
    const s = r.sel();
    assert.equal(s.full, false, s.reasons.join('; '));
    assert.deepEqual(s.selected, ['tests/a.test.js', 'tests/b.test.js']);
    assert.equal(s.total, 5);
    assert.match(s.why['tests/b.test.js'], /imports src\/a\.js/);
    assert.deepEqual(s.via['tests/b.test.js'], ['tests/b.test.js', 'src/b.js', 'src/a.js']);
    assert.match(s.command, /^node --test tests\/a\.test\.js tests\/b\.test\.js$/);
  } finally { r.done(); }
});

test('require() of a directory resolves to index.js; helpers imported by tests count', () => {
  const r = repo(JSAPP);
  try {
    r.change({ 'src/util/index.js': 'export const u = 2;\n', 'tests/helpers.js': 'export const h = 2;\n' });
    assert.deepEqual(r.sel().selected, ['tests/d.test.js', 'tests/e.test.js']);
  } finally { r.done(); }
});

test('committed changes on the branch and uncommitted edits are both included', () => {
  const r = repo(JSAPP);
  try {
    r.change({ 'src/c.js': 'export const c = 4;\n' }); r.commit();
    r.change({ 'src/a.js': 'export const a = 9;\n' });
    assert.deepEqual(r.sel().selected, ['tests/a.test.js', 'tests/b.test.js', 'tests/c.test.js']);
  } finally { r.done(); }
});

test('docs-only change runs nothing; a changed test runs itself', () => {
  const r = repo(JSAPP);
  try {
    r.change({ 'README.md': '# new\n' });
    let s = r.sel(); assert.equal(s.full, false); assert.deepEqual(s.selected, []);
    r.change({ 'tests/c.test.js': "import { c } from '../src/c.js';\n// more\n" });
    s = r.sel(); assert.deepEqual(s.selected, ['tests/c.test.js']);
  } finally { r.done(); }
});

test('a deleted module still selects the tests that import it', () => {
  const r = repo(JSAPP);
  try { r.remove('src/c.js'); r.commit(); assert.deepEqual(r.sel().selected, ['tests/c.test.js']); } finally { r.done(); }
});

test('renaming a file selects importers of the old path', () => {
  const r = repo(JSAPP);
  try { r.g('mv', 'src/c.js', 'src/c2.js'); r.commit(); assert.ok(r.sel().selected.includes('tests/c.test.js')); } finally { r.done(); }
});

test('fail-safe: lockfiles, root package.json, CI workflows and unsupported languages run everything', () => {
  for (const [file, content, re] of [
    ['package-lock.json', '{}', /package-lock\.json changed/],
    ['package.json', JSON.stringify({ name: 'app', dependencies: { left: '1' }, scripts: { test: 'node --test' } }), /package\.json changed at the repo root/],
    ['package.json', JSON.stringify({ name: 'app', scripts: { test: 'node --test --test-concurrency=1' } }), /package\.json changed at the repo root/],
    ['.github/workflows/ci.yml', 'on: push\njobs:\n  t:\n    steps:\n      - run: npm test\n', /ci\.yml changed \(it runs the tests\)/],
    ['mise.toml', '[tools]\nnode = "24"\n', /mise\.toml changed/],
    ['tools/gen.go', 'package main', /does not map \.go files/],
    ['data/blob.bin', 'x', /nothing imports it/],
  ]) {
    const r = repo(JSAPP);
    try {
      r.change({ [file]: content });
      const s = r.sel();
      assert.equal(s.full, true, file);
      assert.match(s.reasons.join('\n'), re);
      assert.equal(s.selected.length, 5);
      assert.equal(s.command, 'npm test');
    } finally { r.done(); }
  }
});

test('metadata-only edits run nothing: a version bump, a non-test workflow, .npmignore, eslint config', () => {
  const r = repo({ ...JSAPP, '.github/workflows/links.yml': 'on: push\njobs:\n  l:\n    steps:\n      - run: lychee .\n' });
  try {
    r.change({
      'package.json': JSON.stringify({ name: 'app', version: '9.9.9', description: 'new', scripts: { test: 'node --test', lint: 'eslint .' } }),
      '.github/workflows/links.yml': 'on: pull_request\njobs:\n  l:\n    steps:\n      - run: lychee --verbose .\n',
      '.npmignore': 'tests/\n', 'eslint.config.js': 'export default [];\n',
    });
    const s = r.sel();
    assert.equal(s.full, false, s.reasons.join('; '));
    assert.deepEqual(s.selected, []);
  } finally { r.done(); }
});

test('Python: a pyproject version bump runs nothing; a dependency change runs everything', () => {
  const r = repo({ 'pyproject.toml': '[project]\nname = "p"\nversion = "1.0"\ndependencies = [\n  "requests",\n]\n', 'p/__init__.py': '', 'tests/test_p.py': 'import p\n' });
  try {
    r.change({ 'pyproject.toml': '[project]\nname = "p"\nversion = "1.1"\ndependencies = [\n  "requests",\n]\n' });
    assert.equal(r.sel().full, false);
    r.change({ 'pyproject.toml': '[project]\nname = "p"\nversion = "1.1"\ndependencies = [\n  "requests>=3",\n]\n' });
    assert.equal(r.sel().full, true);
  } finally { r.done(); }
});

test('an unimported fixture file selects the tests that live next to it', () => {
  const r = repo({ ...JSAPP, 'tests/fixtures/user.json': '{"a":1}' });
  try {
    r.change({ 'tests/fixtures/user.json': '{"a":2}' });
    const s = r.sel();
    assert.equal(s.full, false);
    assert.equal(s.selected.length, 5); // everything under tests/
    assert.match(s.why['tests/a.test.js'], /no importer; tests under tests\//);
  } finally { r.done(); }
});

test('a JSON file imported by source is followed like code', () => {
  const r = repo({ ...JSAPP, 'src/config.json': '{"x":1}', 'src/c.js': "import cfg from './config.json' with { type: 'json' };\nexport const c = cfg.x;\n" });
  try { r.change({ 'src/config.json': '{"x":2}' }); assert.deepEqual(r.sel().selected, ['tests/c.test.js']); } finally { r.done(); }
});

// ---- TypeScript specifics ---------------------------------------------------------------

const TSAPP = {
  'package.json': JSON.stringify({ name: 'ts', devDependencies: { vitest: '3' }, scripts: { test: 'vitest' } }),
  'tsconfig.json': '{\n  // comments are allowed\n  "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] }, },\n}\n',
  'src/model/user.ts': 'export type User = { id: number };\nexport const make = (id: number): User => ({ id });\n',
  'src/model/index.ts': "export * from './user.js';\n",
  'src/api.ts': "import { make } from '@/model';\nexport const get = () => make(1);\n",
  'src/view.tsx': "import type { User } from './model/user.js';\nexport const V = (u: User) => u.id;\n",
  'src/other.ts': 'export const o = 1;\n',
  'src/api.test.ts': "import { get } from './api';\n",
  'src/view.spec.tsx': "import { V } from './view';\n",
  'src/__tests__/other.ts': "import { o } from '../other';\n",
  'src/mocked.test.ts': "vi.mock('./other', () => ({ o: 2 }));\n",
};

test('TypeScript: tsconfig paths alias, .js→.ts ESM specifiers, index barrels, type imports, vi.mock, __tests__', () => {
  const r = repo(TSAPP);
  try {
    r.change({ 'src/model/user.ts': 'export type User = { id: string };\nexport const make = (id: any) => ({ id });\n' });
    let s = r.sel();
    assert.deepEqual(s.selected, ['src/api.test.ts', 'src/view.spec.tsx']);
    assert.match(s.command, /^npx vitest run src\/api\.test\.ts src\/view\.spec\.tsx$/);
    r.change({ 'src/model/user.ts': TSAPP['src/model/user.ts'], 'src/other.ts': 'export const o = 2;\n' });
    s = r.sel();
    assert.deepEqual(s.selected, ['src/__tests__/other.ts', 'src/mocked.test.ts']);
  } finally { r.done(); }
});

test('a dynamic import with a computed path depends on its whole directory', () => {
  const r = repo({ ...TSAPP, 'src/plugins/load.ts': 'export const load = (n: string) => import(`./${n}`);\n', 'src/plugins/x.ts': 'export default 1;\n', 'src/plugins.test.ts': "import { load } from './plugins/load';\n" });
  try {
    r.change({ 'src/plugins/x.ts': 'export default 2;\n' });
    const s = r.sel();
    assert.deepEqual(s.selected, ['src/plugins.test.ts']);
    assert.ok(s.dynamicFiles >= 1);
  } finally { r.done(); }
});

test('an import of a directory with a trailing slash resolves to its index', () => {
  const r = repo({ ...TSAPP, 'src/index.ts': "export * from './api';\n", 'src/helper/x.test.ts': "import { get } from '../../src/';\nimport { o } from '../';\n" });
  try {
    r.change({ 'src/api.ts': "import { make } from '@/model';\nexport const get = () => make(2);\n" });
    assert.ok(r.sel().selected.includes('src/helper/x.test.ts'));
  } finally { r.done(); }
});

// The automatic JSX runtime is injected by the compiler; no source file imports it.
const JSXAPP = {
  'package.json': JSON.stringify({ name: 'ui', devDependencies: { vitest: '4' } }),
  'tsconfig.json': JSON.stringify({ compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'ui/jsx' } }),
  'src/jsx/jsx-runtime.ts': "export { jsx } from './base';\n",
  'src/jsx/jsx-dev-runtime.ts': "export { jsx as jsxDEV } from './base';\n",
  'src/jsx/base.ts': 'export const jsx = () => null;\n',
  'src/dom/jsx-runtime.ts': 'export const jsx = () => 1;\n',
  'src/card.test.tsx': 'test("x", () => <div />);\n',
  'src/pragma.test.tsx': '/** @jsxImportSource ./dom */\ntest("y", () => <p />);\n',
  'src/plain.test.ts': 'test("z", () => 1);\n',
};

test('JSX: tsconfig jsxImportSource naming the package itself makes every .tsx depend on the runtime', () => {
  const r = repo(JSXAPP);
  try {
    r.change({ 'src/jsx/base.ts': 'export const jsx = () => undefined;\n' });
    assert.deepEqual(r.sel().selected, ['src/card.test.tsx', 'src/pragma.test.tsx']);
  } finally { r.done(); }
});

test('JSX: vitest config importSource and a per-file pragma are both followed', () => {
  const r = repo({ ...JSXAPP, 'tsconfig.json': JSON.stringify({ compilerOptions: { jsx: 'react-jsx' } }), 'vitest.config.ts': "export default { test: {}, oxc: { jsx: { runtime: 'automatic', importSource: './src/jsx' } } };\n" });
  try {
    r.change({ 'src/jsx/base.ts': 'export const jsx = () => 0;\n' });
    assert.deepEqual(r.sel().selected, ['src/card.test.tsx', 'src/pragma.test.tsx']);
    r.change({ 'src/jsx/base.ts': JSXAPP['src/jsx/base.ts'], 'src/dom/jsx-runtime.ts': 'export const jsx = () => 2;\n' });
    assert.deepEqual(r.sel().selected, ['src/pragma.test.tsx']);
  } finally { r.done(); }
});

// ---- monorepo -----------------------------------------------------------------------------

const MONO = {
  'package.json': JSON.stringify({ name: 'mono', private: true, workspaces: ['packages/*'] }),
  'packages/utils/package.json': JSON.stringify({ name: '@acme/utils', main: 'dist/index.js', devDependencies: { vitest: '3' } }),
  'packages/utils/src/index.ts': "export * from './str';\n",
  'packages/utils/src/str.ts': 'export const up = (s: string) => s.toUpperCase();\n',
  'packages/utils/src/str.test.ts': "import { up } from './str';\n",
  'packages/web/package.json': JSON.stringify({ name: '@acme/web', devDependencies: { jest: '30' } }),
  'packages/web/src/page.ts': "import { up } from '@acme/utils';\nexport const title = up('x');\n",
  'packages/web/src/page.test.ts': "import { title } from './page';\n",
  'packages/web/src/lone.test.ts': 'test("x", () => {});\n',
  'packages/api/package.json': JSON.stringify({ name: '@acme/api', scripts: { test: 'node --test' } }),
  'packages/api/src/srv.test.js': "import '@acme/utils/src/str';\n",
};

test('monorepo: a change in a shared package reaches dependents through the workspace name, one command per package', () => {
  const r = repo(MONO);
  try {
    r.change({ 'packages/utils/src/str.ts': 'export const up = (s: string) => s.toLocaleUpperCase();\n' });
    const s = r.sel();
    assert.deepEqual(s.selected, ['packages/api/src/srv.test.js', 'packages/utils/src/str.test.ts', 'packages/web/src/page.test.ts']);
    assert.match(s.command, /\(cd packages\/utils && npx vitest run src\/str\.test\.ts\)/);
    assert.match(s.command, /\(cd packages\/web && npx jest --runTestsByPath src\/page\.test\.ts\)/);
    assert.match(s.command, /\(cd packages\/api && node --test src\/srv\.test\.js\)/);
  } finally { r.done(); }
});

test('monorepo: a package.json inside one package runs only that package', () => {
  const r = repo(MONO);
  try {
    r.change({ 'packages/web/package.json': JSON.stringify({ name: '@acme/web', devDependencies: { jest: '31' } }) });
    const s = r.sel();
    assert.equal(s.full, false);
    assert.deepEqual(s.selected, ['packages/web/src/lone.test.ts', 'packages/web/src/page.test.ts']);
  } finally { r.done(); }
});

// ---- Python -------------------------------------------------------------------------------

const PYAPP = {
  'pyproject.toml': '[project]\nname = "shop"\n',
  'src/shop/__init__.py': '',
  'src/shop/core.py': 'def price(x):\n    return x\n',
  'src/shop/api.py': 'from .core import price\n\ndef quote(x):\n    return price(x)\n',
  'src/shop/tax.py': 'RATE = 0.2\n',
  'src/shop/report/__init__.py': 'from ..tax import RATE\n',
  'tests/conftest.py': 'import pytest\n',
  'tests/test_api.py': 'from shop.api import quote\n',
  'tests/test_tax.py': 'from shop import (\n    tax,\n)\n',
  'tests/unit/test_report.py': 'import shop.report as r\n',
  'tests/unit/conftest.py': '',
  'tests/test_misc.py': 'import json\n',
};

test('Python: absolute, relative and parenthesised imports, src layout, package __init__', () => {
  const r = repo(PYAPP);
  try {
    r.change({ 'src/shop/core.py': 'def price(x):\n    return x * 2\n' });
    let s = r.sel();
    assert.deepEqual(s.selected, ['tests/test_api.py']);
    assert.equal(s.command, 'python -m pytest tests/test_api.py');
    r.change({ 'src/shop/core.py': PYAPP['src/shop/core.py'], 'src/shop/tax.py': 'RATE = 0.25\n' });
    s = r.sel();
    assert.deepEqual(s.selected, ['tests/test_tax.py', 'tests/unit/test_report.py']);
  } finally { r.done(); }
});

test('Python: a package __init__ change reaches everything importing that package', () => {
  const r = repo(PYAPP);
  try {
    r.change({ 'src/shop/__init__.py': 'VERSION = 2\n' });
    assert.deepEqual(r.sel().selected, ['tests/test_api.py', 'tests/test_tax.py', 'tests/unit/test_report.py']);
  } finally { r.done(); }
});

test('Python: conftest.py applies to the tests at and below its directory only', () => {
  const r = repo(PYAPP);
  try {
    r.change({ 'tests/unit/conftest.py': 'X = 1\n' });
    assert.deepEqual(r.sel().selected, ['tests/unit/test_report.py']);
    r.change({ 'tests/unit/conftest.py': '', 'tests/conftest.py': 'import pytest\nX = 2\n' });
    assert.equal(r.sel().selected.length, 4);
  } finally { r.done(); }
});

test('Python: root pyproject.toml runs the full suite', () => {
  const r = repo(PYAPP);
  try { r.change({ 'pyproject.toml': '[project]\nname = "shop"\ndependencies = ["attrs"]\n' }); const s = r.sel(); assert.equal(s.full, true); assert.equal(s.command, 'python -m pytest'); } finally { r.done(); }
});

// ---- base detection -----------------------------------------------------------------------

test('on the base branch with a clean tree it compares against the previous commit (a push to main)', () => {
  const r = repo(JSAPP);
  try {
    r.g('checkout', '-q', 'main');
    r.change({ 'src/c.js': 'export const c = 5;\n' }); r.commit('on main');
    const s = r.sel();
    assert.match(s.base, /HEAD~1/);
    assert.deepEqual(s.selected, ['tests/c.test.js']);
  } finally { r.done(); }
});

test('outside git it falls back to the full suite and says why', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shortlist-nogit-'));
  write(dir, JSAPP);
  try { const s = select({ root: dir }); assert.equal(s.full, true); assert.match(s.reasons[0], /not a git repository/); } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('.shortlist.json can add test globs, always-run tests, and a custom command', () => {
  const r = repo({ ...JSAPP, 'test/smoke.js': "import '../src/c.js';\n", '.shortlist.json': JSON.stringify({ tests: ['tests/**/*.test.js', 'test/**/*.js'], always: ['tests/e.test.js'], command: { js: 'pnpm vitest run {files}' } }) });
  try {
    r.change({ 'src/c.js': 'export const c = 6;\n' });
    const s = r.sel();
    assert.deepEqual(s.selected, ['test/smoke.js', 'tests/c.test.js', 'tests/e.test.js']);
    assert.equal(s.command, 'pnpm vitest run test/smoke.js tests/c.test.js tests/e.test.js');
  } finally { r.done(); }
});

// ---- parsers --------------------------------------------------------------------------------

test('jsImports: static, re-exports, side-effect, require, dynamic literal, multiline, and computed', () => {
  const src = "import a from 'a';\nimport {\n  x,\n  y as z,\n} from './multi';\nimport './side.css';\nexport * from './re';\nexport { q } from \"./dq\";\nconst r = require('./r');\nconst l = await import('./lazy');\njest.mock('./mocked');\n";
  const { specs, dynamic } = jsImports(src);
  for (const s of ['a', './multi', './side.css', './re', './dq', './r', './lazy', './mocked']) assert.ok(specs.includes(s), s);
  assert.equal(dynamic, false);
  assert.equal(jsImports('const m = require(name);').dynamic, true);
  assert.equal(jsImports('const m = import(`./x/${n}`);').dynamic, true);
  assert.equal(jsImports('const mods = import.meta.glob("./*.ts");').dynamic, true);
});

test('pyImports: forms and dynamic importlib', () => {
  const { mods, dynamic } = pyImports('import os, shop.core as c\nfrom . import util\nfrom ..pkg.mod import (\n  a,\n  b as bb,\n)\nimportlib.import_module("shop.plugins.x")\n');
  assert.deepEqual(mods.map(m => [m.level, m.module, m.names.join(',')]), [[0, 'os', ''], [0, 'shop.core', ''], [1, '', 'util'], [2, 'pkg.mod', 'a,b'], [0, 'shop.plugins.x', '']]);
  assert.equal(dynamic, false);
  assert.equal(pyImports('importlib.import_module(name)').dynamic, true);
});

test('glob and jsonc helpers', () => {
  assert.ok(globToRegex('**/*.test.{js,ts}').test('a/b/c.test.ts'));
  assert.ok(globToRegex('**/*.test.{js,ts}').test('c.test.js'));
  assert.ok(!globToRegex('docs/**').test('src/docs.js'));
  assert.deepEqual(parseJsonc('{ "a": "http://x", /* c */ "b": [1,], }'), { a: 'http://x', b: [1] });
});
