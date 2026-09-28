# shortlist — instructions for coding agents

You are reading this because a user pasted something like:

> Install the shortlist skill from https://github.com/codegobrrrr9/shortlist, refer to the repo's AGENTS.md.

Do the install for the agent you are, confirm in one line, then follow the rules below for the rest
of the session. Do not explain what shortlist is unless asked.

## Install

`<repo>` is a clone of this repository, or the raw files fetched from
`https://raw.githubusercontent.com/codegobrrrr9/shortlist/main/`.

| Agent | Do this |
|-------|---------|
| Claude Code | Run `/plugin marketplace add codegobrrrr9/shortlist` then `/plugin install shortlist@shortlist`. If plugins are unavailable, copy `<repo>/skills/shortlist/` to `~/.claude/skills/shortlist/`. |
| Codex | Copy `<repo>/skills/shortlist/` to `~/.codex/skills/shortlist/`, or run `npx skills add codegobrrrr9/shortlist`. Append the **Rules** below to the project's `AGENTS.md`. |
| Cursor | Copy `<repo>/.cursor/rules/shortlist.mdc` to `.cursor/rules/`, and `<repo>/skills/shortlist/scripts/shortlist.js` to `scripts/shortlist.js`. |
| Gemini CLI | Run `gemini extensions install https://github.com/codegobrrrr9/shortlist`. |
| GitHub Copilot | Copy `<repo>/.github/copilot-instructions.md` into the project's `.github/`. |
| Anything else | Append the **Rules** below to the agent's instruction file and keep `shortlist.js` in the project. |

If the project has CI on GitHub Actions and the user wants it, add the action to the test job (see
the README's CI section). Ask before editing a workflow.

After installing, say: `shortlist on. I will run the tests this change can reach, and say which ran.`

## Rules

1. **After a change, run the shortlist, not the suite:** `node <path>/shortlist.js --cmd`, then run
   exactly what it prints.
2. **Read the verdict first.** `RUN n of N` → run them. `NO TESTS` → say so, run nothing.
   `FULL SUITE because …` → run the full command and quote the reason.
3. **Say what ran.** "Ran 7 of 142 test files selected by shortlist, all passed." Never "all tests
   pass" after a shortlist run.
4. **Full suite once at the end** only if the user asked, the change is wide, or before a release.
   CI owns the full suite otherwise.
5. **If you believe a test is affected but it was not selected,** check `shortlist.js --why <test>`,
   run it anyway, and add it to `always` in `.shortlist.json`.

## Commands

```
shortlist.js            summary: which tests and why
shortlist.js --cmd      the command to run them
shortlist.js --list     one test file per line
shortlist.js --why <t>  import chain from a test to the change
shortlist.js --json     everything
--base <ref>            compare against a specific ref
```
