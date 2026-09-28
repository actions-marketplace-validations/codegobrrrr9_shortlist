# How shortlist decides

## 1. What changed

Against a base ref it collects, as one set:

- commits on the branch: `git diff --name-status -M <merge-base> HEAD`
- uncommitted edits (staged and unstaged): `git diff --name-status -M HEAD`
- new untracked files

Renames count as a deletion of the old path plus an addition of the new one, so tests importing
either are selected. Deleted files stay in the graph, so a test that imports a deleted module runs
(and fails, which is the point).

**The base** is the first of: `--base`, `$SHORTLIST_BASE`, `origin/$GITHUB_BASE_REF` (pull
requests), `origin/HEAD`, `origin/main`, `origin/master`, `main`, `master`. If you are *on* the base
branch, it compares the working tree to `HEAD` when you have local edits, and `HEAD~1` when the tree
is clean (a push to main). No base at all: full suite.

## 2. The graph

An edge `A → B` means "A cannot run without B".

**JS / TS** (`.js .jsx .ts .tsx .mjs .cjs .mts .cts .vue .svelte .astro`):

- `import … from`, `import '…'`, `export … from`, `import type`, `import()`, `require()`,
  `require.resolve()`, `jest.mock/doMock/requireActual`, `vi.mock/doMock/importActual`,
  `/// <reference path>`
- relative specifiers with extension probing, `index.*` directories, `./x.js` → `x.ts` (TypeScript
  ESM style), `.json`, `.css` and other imported assets
- `compilerOptions.paths` and `baseUrl` from the nearest `tsconfig.json` / `jsconfig.json` (one level
  of relative `extends` is followed)
- workspace packages (npm/yarn `workspaces`, `pnpm-workspace.yaml`): `@acme/utils` resolves to the
  package's source entry (`source`, `exports["."]`, `module`, `main`, or `src/index`), and
  `@acme/utils/sub` to the file inside it. If the entry cannot be found, the importer depends on the
  whole package.
- **computed imports** (`require(name)`, `` import(`./${x}`) ``, `import.meta.glob`,
  `require.context`) make the file depend on everything under its own directory

**Python** (`.py`):

- `import a.b`, `from a.b import c`, parenthesised multi-line imports, `from . import x`,
  `from ..pkg import y`, literal `importlib.import_module('a.b')`
- module lookup under the repo root, `src/`, `lib/`, and every directory with a `pyproject.toml`,
  `setup.py` or `setup.cfg` (and its `src/`)
- importing `a.b.c` also depends on `a/__init__.py` and `a/b/__init__.py`, because Python runs them
- every test depends on each `conftest.py` from the repo root down to its directory
- a computed `importlib.import_module(name)` depends on its whole directory

**Tests** are, by default, `*.test.*`, `*.spec.*`, anything under `__tests__/`, `*_test.js|ts`,
`test_*.py` and `*_test.py`. Override with `tests` in `.shortlist.json`.

## 3. Selection

Every changed file is classified, in this order:

| Changed file | Result |
|---|---|
| Ignored (`*.md`, `docs/**`, `LICENSE`, `CHANGELOG`, editor config …) | nothing |
| Lockfile, `.github/workflows/**`, `.nvmrc`, `.python-version`, `.npmrc`, `pnpm-workspace.yaml`, `turbo.json`, `nx.json`, `.shortlist.json` | **full suite** |
| `package.json`, `tsconfig*.json`, test-runner / bundler / babel config, `pyproject.toml`, `setup.*`, `pytest.ini`, `requirements*.txt` | every test at or below that file's directory; **full suite** if it is at the repo root |
| A file in a language shortlist does not map (`.go`, `.rs`, `.rb`, `.java`, …) | **full suite** |
| Code, or anything something imports | walk the reverse graph to every test that reaches it |
| An unimported data file (a fixture a test reads from disk) | every test under the nearest directory that contains tests |
| An unimported doc or image with no test directory above it | nothing |
| Anything else unimported | **full suite** |

Then `always` globs from `.shortlist.json` are added.

## 4. `.shortlist.json`

```json
{
  "tests": ["src/**/test.ts", "tests/**/*.test.ts"],
  "ignore": ["examples/**"],
  "full": ["scripts/codegen/**"],
  "always": ["tests/smoke.test.ts"],
  "command": { "js": "pnpm vitest run {files}", "py": "uv run pytest {files}" }
}
```

## 5. What it cannot see

- A test that reads a source file as text (not by importing it), or spawns a script by path.
  Add it to `always`, or put the file under the test's directory so the fixture rule catches it.
- Behaviour that flows through the network, a database schema, or environment variables.
- Languages beyond JS/TS and Python. A change in one of them triggers the full suite rather than a
  guess.

This is why the recommended CI setup is: shortlist on every pull request, the full suite on a
schedule and on the main branch.
