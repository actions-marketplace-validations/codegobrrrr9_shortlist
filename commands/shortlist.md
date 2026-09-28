---
description: Which tests can this change reach? Runs shortlist on the current diff, shows the selection with the reason for each test, and runs them on request.
allowed-tools: Bash(node:*), Bash(npx:*), Bash(npm:*), Bash(pnpm:*), Bash(python:*), Read
---

1. Run `node ${CLAUDE_PLUGIN_ROOT}/skills/shortlist/scripts/shortlist.js $ARGUMENTS` from the project
   root (if that path does not exist, find `shortlist.js` under the installed shortlist skill).
2. Quote the verdict line (RUN n of N / NO TESTS / FULL SUITE because …) and the first few selected
   tests with their reasons.
3. If the user wants them run, run the command shortlist printed and report: "ran n of N test files
   selected by shortlist" plus the pass/fail result. Never call a shortlist run "all tests pass".
