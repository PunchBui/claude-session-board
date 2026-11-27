---
name: csb-update
description: "Change the Claude Session Board (repo ~/repos/claude-session-board, the local app on http://localhost:4747) without making open clients reload while the work is in progress. All edits happen in a separate git worktree and are tested on a spare-port server there; only when the update is finished and green is it applied to the main repo in one step, followed by one push and one restart. Knows what the board does, how it is wired, and the repo's conventions. Use when the user wants to add a feature, fix a bug or change the board's UI, server or skills and does not want the board window, phone or Electron app to keep reloading meanwhile. Trigger: /csb-update <what to change>"
trigger: /csb-update
---

# /csb-update

Make one change to the board in isolation, then land it in the live repo once, so the board window, the installed PWA and the Electron app reload once at the end instead of on every save.

## Why a worktree

The Electron app watches the live repo (`public/` recursive, `lib/` recursive, and the top-level files such as `server.js`). A changed file under `public/` reloads the window; a changed `server.js` or `lib/*.js` restarts the server and then reloads. Editing the live checkout therefore reloads every open client on every save. A git worktree is a second checkout in another folder: nothing the live board watches changes until the finished work is applied.

## What the board is

A dependency-free Node (>=20, ES modules) web app on `127.0.0.1:4747` that shows Claude desktop Code sessions and does things with them. It reads the files the Claude desktop app and Claude Code already write (`SESSIONS_DIR`, `PROJECTS_DIR`), and runs `claude` itself for the prompts it sends.

| Area | Where | What it does |
|---|---|---|
| Server | `server.js` | HTTP routes (`/api/...`), polling, the remote-token gate, serving `public/`. Runs as the launch agent `com.user.claude-session-board` (KeepAlive). |
| Logic | `lib/*.js` | Small pure modules, one concern each: `scan` (transcripts), `runs` (running prompts), `queue`, `schedule` / `routines`, `mrs` / `babysit` / `deploycheck` / `mrevents` (GitLab merge requests via `glab`), `flow` / `jira` (Jira), `ask` (question cards), `live`, `ping`, `sidechats`, `atomic` (per-file lock for `data/*.json`), and so on. |
| Frontend | `public/app.js`, `index.html`, `app.css`, `public/*.js` modules | Pages: `/` all sessions, `/focus` sidebar of starred sessions with one large chat (tools, token usage, prompt queue, prompt box, question cards, Changes tab), merge requests and babysit, schedules, flow/lifecycle map, search, usage. |
| Shell | `public/sw.js`, `manifest.webmanifest`, `electron/` | Service worker for the installed PWA (its `SHELL` list must hold every module `app.js` imports, followed transitively; bump `CACHE` when `SHELL` or shell files change), Electron wrapper with auto reload. |
| State | `data/*.json` (gitignored) | Focus, queue, schedules, babysit and deploy status, caches, logs of runs. Live data: never edit it by hand and never point a test server at it. |
| Skills | `skills/csb-*` | Slash commands the board itself launches (`csb-babysit`, `csb-check-deploy`, `csb-create-schedule`) or the user runs (`csb-audit`, `csb-attention-audit`, `csb-update`). Each is linked from `~/.claude/skills`. |
| Docs | `README.md`, `STATUS.md` | README describes pages, endpoints, env vars; `STATUS.md` has "Recently done", the test count, `Skills:` and `Updated:`. |

Read `README.md` and the relevant `lib/` and `public/` files before changing anything; do not rely on this table for details.

### Conventions (they come from the repo and the user's CLAUDE.md)

- No code comments. Put the reasoning in the commit body.
- No semicolons; small pure functions in `lib/` or `public/*.js` with a test in `test/`. Add or update tests for every behaviour change.
- The repo is open source: never write employer or company names or internal hostnames. The GitLab host comes from `GITLAB_HOST`.
- `data/*.json` writes go through `lib/atomic.js`.
- New `public/*.js` module imported by `app.js`: add it to `SHELL` in `public/sw.js` and bump `CACHE`.
- Stage specific files only; never `git add -A`; never force-push; never commit with failing tests. Committing and pushing in this repo needs no confirmation.
- Commit trailer: `Co-Authored-By: <the current model> <noreply@anthropic.com>`.

## Phase 1: Set up the worktree

Work from the live repo: `git rev-parse --show-toplevel` must be a folder that holds `server.js`, `lib/` and `public/app.js`; if not, `cd ~/repos/claude-session-board`.

1. Note the live tree's state: `git status --short` and `git log --oneline -3`. Uncommitted files there are someone else's work in progress (another session, or the user). Never stash, reset, checkout or commit them, and do not copy them into the worktree.
2. Pick a short slug from the request (`update-<slug>`) and create the worktree from `main`:

   ```bash
   git worktree add .claude/worktrees/update-<slug> -b update/<slug> main
   ```

   `.claude/worktrees/` is already excluded from git and is outside everything the Electron app watches. Do all further work with absolute paths inside it, and `cd` there for commands. If the path or branch already exists, a previous update was left behind: look at it, and either continue it (when the user is resuming) or ask before removing it.
3. The worktree has no `data/` (gitignored) and no dependencies to install.

## Phase 2: Build and test in the worktree

Everything below happens only in the worktree. Do not edit a file under the live repo, even to "just try something".

1. Make the change, following the conventions above. Commit in small steps on `update/<slug>` as you go (these commits are not visible to the live board until Phase 3).
2. Run the tests in the worktree after each step, and never carry on while one fails:

   ```bash
   cd <worktree> && GITLAB_HOST=gitlab.example.com node --test test/*.test.js 2>&1 | grep -E '^# (tests|pass|fail)'
   ```

   Also `node --check server.js` when it changed.
3. Try the change in a running server, on a spare port. Never touch port 4747 and never use the live `data/`:
   - Fictional data (default, safe for screenshots):

     ```bash
     PORT=4790 DEMO_DIR="$(mktemp -d)" node scripts/demo.mjs
     ```

   - Real data shapes (only when the change depends on them): copy the files it needs, not the folder.

     ```bash
     D="$(mktemp -d)"; cp ~/repos/claude-session-board/data/{focus,board-sessions,routines,schedules}.json "$D"/ 2>/dev/null
     PORT=4790 DATA_DIR="$D" node server.js
     ```

   Run the server in the background, hit the routes the change touches (`/`, `/focus`, `/api/sessions`, `/api/focus`, `/api/routines`, `/sw.js` should return 200), and for UI changes load the page in headless Chrome (screenshot at 1280px and 390px, then read the PNG). Stop the server and delete the temp folder afterwards. Say plainly what was not exercised (a click you could not make, a real GitLab or Jira call, a phone).
4. Read your own diff before finishing: `git diff main...HEAD`. Check for added comments (`git diff main...HEAD | grep -E '^\+.*(//|/\*)'`, ignoring URLs), employer names, and a missing `SHELL` / `CACHE` update.
5. Update `STATUS.md` in the worktree: a dated line under "Recently done" (what changed, the test count, what was not verified), the test count in `State:`, the `Skills:` line if skills changed, and `Updated:`. Update `README.md` if a page, endpoint, env var or skill changed. Commit.

## Phase 3: Apply to the live repo, once

Only when the update is complete and the tests pass. The point is a single change in the live checkout, so do not start before the work is done and do not apply in pieces.

1. **Rebase on the current `main`** inside the worktree, so the apply is a fast-forward and the tests run on exactly what will land:

   ```bash
   cd <worktree> && git rebase main
   ```

   Resolve conflicts keeping both sides' intent, then rerun the full test suite and the spare-port smoke test. If `main` moved a lot, or the conflict is not mechanical, tell the user before applying.
2. **Check the live tree can take it.** In the live repo, `git status --short` must show no uncommitted change in any file the update touches (`git diff --name-only main...update/<slug>`). If it does, stop and tell the user which files; do not stash or overwrite them. Uncommitted changes in other files are fine.
3. **Apply in one step**, from the live repo:

   ```bash
   git merge --ff-only update/<slug>
   ```

   This writes every changed file at once, so the Electron app sees one burst (it batches changes within 150 ms for the page and 500 ms for the server) and reloads or restarts once. Do not run this more than once per update.
4. `git push origin main`. Never force-push.
5. **Restart the server only if `server.js` or `lib/*.js` changed**, as the very last step, after the summary is written (a restart from a board-run session cuts its own live link): `launchctl kickstart -k gui/$(id -u)/com.user.claude-session-board`, then confirm `http://localhost:4747/` and `/api/sessions` return 200. A `public/`-only change needs no restart: say the pages need a reload (the Electron app already did it; the installed PWA picks up the new `CACHE` on its next load).
6. **Clean up:** `git worktree remove .claude/worktrees/update-<slug>` and `git branch -d update/<slug>`.

## Report

Keep it short:

- What changed, in one or two lines per area, and the commits that landed.
- Test count before and after, and what was checked by hand.
- What was not verified (so the user knows what to look at first).
- Whether the board was restarted, or only needs a reload.
- The last thing the user must do, if any.

If you stop before Phase 3 (the user wants to review first, a conflict needs a decision, the live tree has overlapping changes), leave the worktree and branch in place and say where they are and the exact command to resume.
