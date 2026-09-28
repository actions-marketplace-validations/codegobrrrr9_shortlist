# shortlist

Rules from https://github.com/codegobrrrr9/shortlist.

1. After a change, run `node scripts/shortlist.js --cmd` (copy `skills/shortlist/scripts/shortlist.js` from the repo to `scripts/shortlist.js`) and run exactly the command it prints.
2. Read the verdict: `RUN n of N` → run them. `NO TESTS` → say so, run nothing. `FULL SUITE because …` → run the full command and quote the reason.
3. Say what ran: "ran 7 of 142 test files selected by shortlist, all passed". Never "all tests pass" after a shortlist run.
4. Full suite once at the end only if the user asked, the change is wide, or before a release.
5. If you believe a test is affected but was not selected, check `node scripts/shortlist.js --why <test>`, run it, and add it to `always` in `.shortlist.json`.
