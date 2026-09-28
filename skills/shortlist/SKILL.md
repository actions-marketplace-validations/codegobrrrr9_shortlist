---
name: shortlist
description: Run only the tests a change can reach instead of the whole suite. Builds the repo's import graph (JS/TS across Jest, Vitest, node:test, Mocha, AVA, Bun, with tsconfig paths and monorepo workspaces; Python with pytest and conftest.py) and walks it backwards from the diff to the test files that can be affected, falling back to the full suite with a stated reason whenever it cannot be sure. Use whenever you are about to run tests after a change, when the suite is slow, when CI time or cost comes up, or when the user says run the tests, affected tests, only the relevant tests, or /shortlist.
license: MIT
metadata:
  author: codegobrrrr9
  version: "0.1.0"
  homepage: https://github.com/codegobrrrr9/shortlist
---

# shortlist

A full test run after every small edit is the slowest, most expensive habit a coding agent has. The
diff touched three files; most of the suite cannot possibly reach them. Run the tests that can.

## Rules

1. **After a change, run the shortlist, not the suite.** Get the command with
   `node <path-to-this-skill>/scripts/shortlist.js --cmd` and run exactly that. It groups tests by
   workspace package and picks the right runner for each.
2. **Read the verdict line before running anything.**
   - `RUN 7 of 142 test files`: run them.
   - `NO TESTS`: nothing can reach the change (docs, unrelated assets). Say so; do not run the suite.
   - `FULL SUITE because …`: a lockfile, root config, CI workflow, unsupported language or unknown
     base changed. Run the full command it prints, and quote the reason.
3. **Say what ran.** "Ran 7 of 142 test files selected by shortlist (all passed)" is honest. "All
   tests pass" after a shortlist run is not; it claims files you did not run.
4. **Once, at the end, run the full suite if the user asked for it**, if the change is wide (more
   than a handful of shared modules), or before a release. CI owns the full suite otherwise.
5. **When a test you expected is missing,** run `shortlist.js --why <test>`. If it says nothing it
   imports changed, but you believe it is affected (it reads a file from disk, loads a module by a
   computed name the graph could not follow), run it too and add it to `always` in `.shortlist.json`.
6. **Never hand-edit the selection to make CI green.** If a test fails that shortlist selected, fix
   the code. If shortlist missed a test that fails in CI, that is a bug to report, not to hide.

## Commands

```
shortlist.js              human summary: which tests, and the change that pulled each one in
shortlist.js --cmd        the command that runs them
shortlist.js --list       test files, one per line
shortlist.js --why <t>    the import chain from a test to the changed file
shortlist.js --json       everything
--base <ref>              compare against a specific ref (default: PR base, origin/HEAD, main)
```

`references/how-it-decides.md` explains what counts as an edge in the graph, every fail-safe rule,
and `.shortlist.json` options.

## Report shape

```
shortlist: ran 7 of 142 test files (95% skipped) · all passed
  base origin/main · 3 files changed (src/user.ts, src/api.ts, tests/user.test.ts)
```

or

```
shortlist: FULL SUITE because pnpm-lock.yaml changed · 142 test files · 2 failed (tests/api.test.ts, tests/auth.test.ts)
```

## Overrides

- The user asks for the full suite: run it. shortlist is a default, not a rule.
- The repo is not a git repo, or the base cannot be found: shortlist already falls back to the full
  suite. Run what it prints.
