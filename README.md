# Claude Session Board

Local web app that lists your Claude desktop Code sessions, opens any of them in the desktop app, and shows live cards for the ones you star.

> Unofficial community project. It is not made by, affiliated with or endorsed by Anthropic. It reads the files the Claude desktop app and Claude Code already write on your machine, and those formats are undocumented and may change without notice.

## Requirements

- Node.js 20 or newer. There are no dependencies to install.
- The Claude desktop app (Code tab) and the `claude` CLI on your PATH, for sending prompts.
- macOS paths are the defaults. On another system set `SESSIONS_DIR` and `PROJECTS_DIR` (see Configuration).

## Run

```bash
npm start
```

Then open http://localhost:4747. Run `npm test` for the unit tests.

## Pages

- `/` all sessions. Search, status filter and the archived toggle are kept in the URL (`?q=`, `?status=`, `?archived=1`).
- `/focus` one live card per starred session. The 1, 2 or Auto column layout is remembered.
- `/search` full-text search inside every conversation, grouped by session with highlighted snippets.
- `/usage` tokens per day and per project (stacked chart) plus the top sessions.

## Focus cards

- Chat with full-length messages and expandable tool calls (full commands).
- Live strip: the tool Claude is running now with a ticking timer, thinking or writing state, and running subagents.
- Attention banner when a transcript ends on an unanswered question (AskUserQuestion, ExitPlanMode) or a tool has been pending for 45s or more, which usually means it is waiting for approval.
- Token usage with a yellow warning at 100k context and red at 200k.
- Changes tab: git branch, ahead and behind, uncommitted files and diff size for the session folder, the files Claude edited, ticket keys (set `JIRA_BASE_URL` to link them) and merge request links mentioned in the chat.
- Prompt box with a queue, ⚡ shortcuts (stored in `data/snippets.json`) and ⏰ scheduling (once, daily or weekdays).
- 📣 Broadcast queues one prompt on several focused sessions.

## Prompts, queue and schedules

- Prompts run as headless `claude -p --resume <id>` in the session folder with `PROMPT_PERMISSION_MODE` (default `default`, where tools that need approval are denied). Setting it to `acceptEdits` or `bypassPermissions` lets prompts sent from this page edit files and run commands without asking, so only do that on a machine you trust and never expose the server beyond localhost.
- While a prompt is running, or the session is busy in the desktop app, new prompts are queued and sent in order when it is idle. A failed or stopped run pauses the queue until you press Resume.
- Queues persist in `data/queue.json` and schedules in `data/schedules.json`. Due schedules are added to the queue, so they follow the same rules.
- The desktop app may not show turns sent from the board until you reopen the session.

## Alerts

The 🔔 button turns on toasts, a short beep, browser notifications and a tab-title counter when a focused session finishes, asks a question, may need approval, passes 100k or 200k context, is marked blocked, or a prompt fails or pauses the queue.

## Configuration

- `PORT` (default `4747`), `SESSIONS_DIR`, `PROJECTS_DIR`, `DATA_DIR`
- `PROMPT_PERMISSION_MODE`, `CLAUDE_BIN`, `JIRA_BASE_URL`

The server binds to `127.0.0.1`, rejects other Host headers, and only accepts POSTs from its own origin. It reads session files and transcripts and never edits them.

## License

[MIT](LICENSE)
