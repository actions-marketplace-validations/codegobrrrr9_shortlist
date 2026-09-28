<div align="center">

# ✂️ shortlist

**Your CI runs the whole suite. Your diff can reach seven test files. shortlist runs the seven.**

Import-graph test selection for JS/TS and Python. One zero-dependency file, a GitHub Action, and an agent skill. When it cannot be sure, it runs everything and says why.

[![test](https://github.com/codegobrrrr9/shortlist/actions/workflows/test.yml/badge.svg)](https://github.com/codegobrrrr9/shortlist/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
![zero deps](https://img.shields.io/badge/dependencies-0-brightgreen)

</div>

## In CI

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0          # shortlist needs the merge base
- uses: actions/setup-node@v4
- run: npm ci
- uses: codegobrrrr9/shortlist@v1
```

On a pull request that runs only the test files the diff can reach, with the right runner per
workspace package, and writes a summary to the job page:

```
shortlist  base origin/main (a1b2c3d)  ·  3 files changed  ·  412ms
RUN 7 of 142 test files  (95% skipped)
  src/user.test.ts        ← imports src/user.ts
  src/api.test.ts         ← imports src/user.ts
  src/billing.test.ts     ← imports src/api.ts
  ...

npx vitest run src/user.test.ts src/api.test.ts src/billing.test.ts ...
```

Keep the full suite where it belongs: on `main` and on a schedule. The pattern people are moving to
is *affected tests on every PR, everything hourly*.

```yaml
on:
  pull_request:            # shortlist
  schedule: [{ cron: '0 * * * *' }]   # full suite, hourly
```

## For your coding agent

Paste this into Claude Code, Codex, Cursor or Gemini CLI:

```
Install the shortlist skill from https://github.com/codegobrrrr9/shortlist, refer to the repo's AGENTS.md.
```

From then on the agent runs the tests its change can reach instead of the full suite after every
edit, and says "ran 7 of 142 test files selected by shortlist" instead of "all tests pass".

No install at all:

```bash
npx --yes --allow-git=all github:codegobrrrr9/shortlist
```

## Why

CI is the new bottleneck. Agents open more pull requests than any team did, and every one runs the
whole suite. Teams are moving CI on-prem, buying faster runners, and asking their agents to pick
which tests to run. Most of the suite cannot reach a three-file diff. The work is knowing which part
can, and not guessing.

## How it decides

1. **What changed**: commits on the branch since the merge base, plus uncommitted edits and new files.
   Renames and deletions included.
2. **The graph**: every import, re-export, `require`, dynamic `import()`, `jest.mock`/`vi.mock`,
   tsconfig `paths` alias, workspace package name, and Python import (absolute, relative,
   parenthesised, package `__init__`, `conftest.py` scope).
3. **Walk it backwards** from each changed file to every test file that can reach it.

| Changed | shortlist runs |
|---|---|
| A source file | every test that imports it, directly or through any chain |
| A test file | that test |
| A fixture no one imports | the tests living next to it |
| `package.json` / `tsconfig` / runner config in a package | that package's tests |
| A version bump, a lint config, docs, a workflow that doesn't run tests | nothing |
| A lockfile, root config, the test workflow, `.nvmrc`, a `.go`/`.rs`/… file, an unknown base | **the full suite, with the reason** |

Code that loads modules by a computed name (`require(name)`, `import.meta.glob`) is treated as
depending on its whole directory. Every rule is in
[`references/how-it-decides.md`](skills/shortlist/references/how-it-decides.md).

```bash
shortlist                 # summary: which tests, and why each one
shortlist --cmd           # the command that runs them
shortlist --why src/api.test.ts   # the import chain that selected it
shortlist --list | --json | --github
```

## Does it work

**How much it skips.** Replaying the last 40 commits of real repos, no configuration:

_Replay table lands here from [`benchmarks/replay.jsonl`](benchmarks/)._

**Whether it skips anything it shouldn't.** The number that matters. For sampled source files in a
real repo, the benchmark injects a runtime failure, runs the full suite, and checks that every test
file that actually failed was on the shortlist:

_Mutation table lands here from [`benchmarks/mutate.jsonl`](benchmarks/)._

25 unit tests build real git repos for every rule above: transitive imports, index resolution,
`.js`→`.ts` specifiers, tsconfig aliases, workspaces, deletions, renames, Python packages and
conftest scope, metadata-only edits, every fail-safe.

## Runners

| Runner | Command shortlist writes |
|---|---|
| Vitest | `npx vitest run <files>` |
| Jest | `npx jest --runTestsByPath <files>` |
| node:test | `node --test <files>` |
| Mocha · AVA · tap · Bun | `npx mocha` · `npx ava` · `npx tap` · `bun test` `<files>` |
| pytest | `python -m pytest <files>` |

In a monorepo each package gets its own runner and working directory. Override with
`"command": { "js": "pnpm vitest run {files}" }` in `.shortlist.json`.

## `.shortlist.json`

```json
{
  "tests": ["src/**/test.ts"],
  "ignore": ["examples/**"],
  "full": ["scripts/codegen/**"],
  "always": ["tests/smoke.test.ts"],
  "command": { "js": "pnpm vitest run {files}", "py": "uv run pytest {files}" }
}
```

## Honest limits

- It follows imports. A test that reads a source file as text, spawns a script by path, or depends
  on a database schema or env var is invisible to it. Put that test in `always`.
- JS/TS and Python only. Any other language in the diff means the full suite, not a guess.
- Libraries whose tests all import one root entry (`import x from '../index'`) gain the least:
  every change reaches every test. Apps and monorepos gain the most.
- It is a pull-request speedup, not a replacement for running everything on `main`.

## Install by agent

| Agent | How |
|---|---|
| **Claude Code** | `/plugin marketplace add codegobrrrr9/shortlist` then `/plugin install shortlist@shortlist`. Adds `/shortlist`. |
| **Codex** | Copy `skills/shortlist/` to `~/.codex/skills/shortlist/` and append the Rules from [`AGENTS.md`](AGENTS.md). |
| **Cursor** | Copy [`.cursor/rules/shortlist.mdc`](.cursor/rules/shortlist.mdc) and `shortlist.js` into the project. |
| **Gemini CLI** | `gemini extensions install https://github.com/codegobrrrr9/shortlist` |
| **GitHub Copilot** | Copy [`.github/copilot-instructions.md`](.github/copilot-instructions.md). |
| **Anything else** | The Rules from [`AGENTS.md`](AGENTS.md) plus `shortlist.js` in the project. |

## Credits

The idea is old: Bazel, Nx `affected`, Jest `--findRelatedTests`, pytest-impacted and
vitest-affected all do it inside their own worlds. shortlist is the zero-config version that works
on a plain repo, across runners, in one file. Same family as
[seatbelt](https://github.com/codegobrrrr9/seatbelt), [cheapskate](https://github.com/codegobrrrr9/cheapskate)
and [alibi](https://github.com/codegobrrrr9/alibi).

## License

MIT. Star ⭐ if it cut your CI bill.
