---
name: csb-create-schedule
description: "Create a new schedule (routine) in the Claude Session Board (the local app on http://localhost:4747, repo ~/repos/claude-session-board). A schedule is a prompt + project folder + time + repeat (once / daily / weekdays / weekly); each run starts its own new board-only session in that folder. Use when the user wants to schedule a prompt/skill to run later or every day/weekday from the board, e.g. 'schedule /daily-8thnight every day at 10:00 in content-creator'. Trigger: /csb-create-schedule <what to run, where, when, repeat>"
trigger: /csb-create-schedule
---

# /csb-create-schedule

Adds one entry to the board's Schedule tab through its local API. Nothing runs now; the board fires it at the chosen time and each firing creates a fresh session (shown in Focus), so the board must be running then.

## 1. Work out the five inputs from the user's text

| Field | Rule |
|---|---|
| `prompt` | What the session should do. A skill/command is written as `/skill-name args` (e.g. `/daily-8thnight rule story`). Max 8000 chars. `/clear`, `/reset`, `/new` are refused. |
| `folder` | Absolute path of an existing project folder. Resolve a project name against `~/repos/<name>`; if the user gave none, use the current working directory. If it is ambiguous or missing, ask once. |
| `at` | First run time. Repeating schedules only need a time of day (plus a weekday for weekly): use the next occurrence (today if still ahead, else tomorrow, or the next matching weekday). One-off needs a date and time in the future (max 1 year). Times are the user's local time. |
| `repeat` | `none` (once), `daily`, `weekdays` or `weekly` (same weekday every week; `at` must fall on the wanted weekday, so use the next occurrence of that weekday + time). Default `none` when a date is given, `daily` when only a time and "every day". |
| `name` | Short label for the card. Default: the prompt. |

Optional: `model` (`fable`/`opus`/`sonnet`/`haiku` or a full name), `effort` (`low` `medium` `high` `xhigh` `max`), `permissionMode` (`default` `manual` `acceptEdits` `plan` `auto` `dontAsk` `bypassPermissions`), `chrome` (`"on"` when the task needs Claude in Chrome, e.g. posting to social). Leave unset for defaults.

If the prompt is a slash command, check it exists for that folder before saving (typos otherwise run as plain text):

```bash
curl -s "http://localhost:4747/api/commands?folder=<url-encoded folder>" | python3 -c "import sys,json;print([i['name'] for i in json.load(sys.stdin)['items']])"
```

Ask only for what is missing and cannot be inferred. Do not ask for confirmation of values the user already gave.

## 2. Create it

The board rejects POSTs without a same-origin header, so always send `Origin`. Compute `at` in epoch milliseconds with Python so local time is respected:

```bash
python3 - <<'PY'
import json, urllib.request, datetime
hour, minute = 10, 0            # time of day for repeating schedules
now = datetime.datetime.now()
at = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
if at <= now: at += datetime.timedelta(days=1)
# one-off: at = datetime.datetime(2026, 11, 9, 8, 30)
body = {
  "name": "Daily 8th night",
  "folder": "/Users/dachawatsathonkanwiroj/repos/content-creator",
  "prompt": "/daily-8thnight rule story",
  "at": int(at.timestamp() * 1000),
  "repeat": "daily",
  # "model": "opus", "effort": "high", "permissionMode": "bypassPermissions", "chrome": "on",
}
req = urllib.request.Request("http://localhost:4747/api/routines", json.dumps(body).encode(),
  {"content-type": "application/json", "origin": "http://localhost:4747"})
try:
    r = json.load(urllib.request.urlopen(req))["routines"][-1]
    print("created", r["rid"], datetime.datetime.fromtimestamp(r["at"] / 1000))
except urllib.error.HTTPError as e:
    print(e.code, e.read().decode())
PY
```

Errors come back as `{"error": "..."}` (bad folder, past time, bad repeat, blocked command, 50-schedule limit). Fix the input and retry once; if it still fails, report the message.

- Connection refused: the board is not running. Start it with `launchctl kickstart -k gui/$(id -u)/com.user.claude-session-board` (or `npm start` in `~/repos/claude-session-board`) and retry.
- 404 on `/api/routines`: the running board is older than the Schedule feature. Restart it with the same launchctl command.

## 3. Verify and report

`curl -s localhost:4747/api/routines` and confirm the new entry (`enabled: true`, right `at`, `repeat`, `folder`). Reply in one or two lines: name, what runs, folder, next run time (local), repeat, and that it is visible in the board's Schedule tab (http://localhost:4747/schedule) where it can be edited, cloned, paused or run now.

## Notes

- A one-off switches itself off after it fires. A missed time fires once when the board is next running, then moves to the next slot.
- Don't run the prompt now to "test" it: that is a real session and a real cost. Offer **Run now** on the Schedule tab instead.
- Do not edit or delete other schedules from this skill.
