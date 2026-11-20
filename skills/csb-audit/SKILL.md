---
name: csb-audit
description: "Audit the Claude Session Board repo (~/repos/claude-session-board) for bugs and loose wiring: three parallel read-only reviewers (backend server.js + lib, frontend app.js + index.html, small modules + service worker + Electron + skills/docs), spot-check the top claims, then report a ranked list with a fix recommendation and save it to data/audits/<date>.md, marking each item new, still open or fixed since the last audit. Read-only unless asked to fix: on 'fix' (or 'fix 1-5', 'fix all') it fixes the chosen items with parallel subagents in separate git worktrees, merges them linearly, runs the tests, smoke-tests a spare-port server, commits, pushes and restarts the board. Use when the user says 'audit the board', 'recheck the board for bugs', 'what is not well connected', or when the weekly schedule sends it. Trigger: /csb-audit [fix <items>]"
trigger: /csb-audit
---

# /csb-audit

Find real bugs and loose wiring in the board, rank them, and recommend what to fix. Work in the board repo: `git rev-parse --show-toplevel` must contain `server.js`, `lib/` and `public/app.js`; if not, `cd ~/repos/claude-session-board`. If that folder is missing either, say so and stop.

Without an argument this is read-only: never edit, commit or restart anything. With `fix <items>` (or when the user replies `fix …` after a report), go to the Fix phase.

## Audit phase

1. **Baseline.** Run in parallel:
   - `git status --short` and `git log --oneline -15`. A dirty tree is fine for the audit; note it in the report.
   - `GITLAB_HOST=gitlab.example.com node --test test/*.test.js 2>&1 | grep -E '^# (tests|pass|fail)'`. A failing test goes to the top of the report.
   - `curl -s -o /dev/null -w '%{http_code}' http://localhost:4747/` to note whether the board is up.
   - The newest file in `data/audits/` (if any), so findings can be compared with it.
2. **Route cross-check (mechanical, do it yourself).** Extract every quoted `/api/...` path from `server.js` and from `public/`, `skills/`, `README.md` and `scripts/` (skip `electron/node_modules` and `electron/out`). List frontend or skill paths with no server handler, and server routes nothing calls (`/api/login` is expected).
3. **Three reviewers in parallel.** Start three `general-purpose` agents in one message. Each brief says: read-only, do not edit files, ignore `electron/node_modules` and `electron/out`, route existence was already checked, verify each finding by reading the actual code path and drop speculation, return at most about 15 findings ranked by severity, each with `file:line`, a one-sentence defect, a concrete failure scenario and severity (high, medium or low), plus a short list of dead or unwired code. Paste the previous audit's still-open item titles into each brief so they are not re-reported as new.
   - **Backend:** `server.js` and `lib/*.js`. Logic bugs, races (read-modify-write of `data/*.json` without the per-file lock in `lib/atomic.js`), unhandled rejections, request fields named differently from what `lib` expects, exports nothing uses, leaked timers or child processes, path traversal or auth gaps in `/api/file`, `/api/upload` and `/api/reveal` (check that the remote token gate covers every route), wrong status codes, edge cases (empty arrays, missing ids, restart mid-run).
   - **Frontend:** `public/app.js` with `public/index.html` and the matching `server.js` handlers. Element ids looked up but missing from the HTML, payload and response field mismatches against the server, listeners lost on re-render, leftovers from removed UI, routing and deep-link breaks, polls that never stop, errors swallowed so the UI stays stuck, out-of-order refreshes, functions defined but never called or called but never defined.
   - **Modules, docs and shell:** the other `public/*.js` files, `app.css`, `sw.js` (its `SHELL` list must hold every module `app.js` imports, followed transitively), `manifest.webmanifest`, `electron/`, `skills/*/SKILL.md`, `README.md`, `STATUS.md` and `scripts/`. Exports nothing imports, imports of names a module does not export, CSS for removed UI, docs describing endpoints, fields, env vars or UI that do not exist or behave differently, and logic modules with no test file.
4. **Spot-check.** Before ranking, open the code for every high finding and the two or three most surprising medium ones yourself and confirm them. Drop or downgrade any you cannot confirm. Mark the ones you checked with ✔.
5. **Merge and rank.** Remove duplicates across reviewers (the service worker list, hardcoded hosts and dead code often show up twice). Compare with the previous audit: tag each item **New**, **Still open** (same defect, same place) or list it under **Fixed since last audit**.

## Report

Save the report to `data/audits/YYYY-MM-DD.md` (`data/` is gitignored, so it stays local) and post the same content as your final message:

1. One line with the baseline: tests (pass/fail count), board up or down, tree clean or dirty, and the number of findings per severity.
2. **Fix now:** a table of up to about 10 items with columns #, Issue, Where, Failure scenario and Tag. Items that will break soon, lose data, freeze the UI or undo user actions go here.
3. **Fix soon** and **Lower priority:** one line each.
4. **Docs and cleanup:** stale docs, dead code, unused CSS.
5. **Fixed since last audit:** short list, if any.
6. **Recommendation:** which items to fix first and why, grouped into batches that touch separate files. Note any item that needs a decision from the user, with the default you would pick.
7. The last line: `Reply "fix" to fix the Fix-now items, or "fix 1,3,7" / "fix all".`

If nothing medium or higher was found, say so plainly and keep the report short.

## Fix phase

Only when the user asked (`fix`, `fix 1,3,7`, `fix all`, or a reply to a report). `fix` alone means the Fix-now items. Items that need a decision use the default named in the report unless the user chose otherwise.

1. **Plan batches by file.** Group the items so that no two batches edit the same region of the same file; at most 4 batches. Put every `public/sw.js` change in one batch.
2. **Parallel fixers.** Start one `general-purpose` agent per batch in one message, each with `isolation: "worktree"`. Each brief holds the exact defect, `file:line`, the failure scenario and the chosen fix direction, plus these rules:
   - Work only in your worktree, and do not touch the files the other batches own (list them).
   - Follow the user's CLAUDE.md rules, including: no code comments; put the reasoning in the commit body.
   - Never add employer or company names or internal hostnames (the repo is open source; the GitLab host comes from `GITLAB_HOST`).
   - Match the existing style (no semicolons, small pure functions in `lib/` or `public/*.js` with tests in `test/`). Add tests for each fix.
   - Run the full test suite, then `git add` only the changed files and commit on the worktree branch, with the body ending `Co-Authored-By: <the current model> <noreply@anthropic.com>`. Do not push.
   - Never touch port 4747. To check a server change, run `PORT=<spare port> DATA_DIR=<temp dir with copies of data/focus.json and data/board-sessions.json> node server.js` and stop it afterwards.
   - Report the files changed, the approach, the test count and anything not verified.
3. **Review each branch as it finishes.** Read `git diff main...<branch>`. Check for added comments (`git diff | grep -E '^\+.*(//|/\*)'`, ignoring URLs), employer names, variables used out of scope, and imports of names another batch renamed.
4. **Merge linearly.** On `main` with a clean tree, `git cherry-pick` each branch (no merge commits). Resolve conflicts by keeping both sides' intent.
5. **Integrate:**
   - If a fix added a module that `app.js` imports, add it to `SHELL` in `public/sw.js` and bump `CACHE`.
   - `node --check server.js`.
   - Run the full test suite; never commit with failing tests.
   - Smoke-test the merged server on a spare port with a temp `DATA_DIR`: `/`, `/focus`, `/api/sessions`, `/api/focus`, `/api/routines` and `/sw.js` should return 200. Stop it afterwards.
6. **Record.** Add a dated line to `STATUS.md` under "Recently done" (what was fixed, the test count, what was not run end to end), update its test count and `Updated:` date, and commit it.
7. **Ship.** `git push origin main`, then, as the very last step, `launchctl kickstart -k gui/$(id -u)/com.user.claude-session-board` and confirm `http://localhost:4747/` and `/api/sessions` return 200.
8. **Clean up.** Remove the agent worktrees (`git worktree remove .claude/worktrees/agent-*`) and delete their branches.
9. **Report:** what is fixed per item, the test count before and after, what was verified by hand, what was not, and which audit items are still open.
