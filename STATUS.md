# Claude Session Board status

State: Working local Node web app (no dependencies) that lists Claude desktop sessions and shows live cards for starred ones; published on GitHub (PunchBui/claude-session-board), runs as a launch agent on :4747, 286 tests pass.
Recently done:
- 2026-11-12: board sessions get a short model-written title after their first run (lib/autotitle.js, `claude -p --model haiku --no-session-persistence`), replacing the first-prompt name; first-prompt name stays if the call fails (484 tests pass; the live title call was checked by hand, not yet seen on a new board session end to end)
- 2026-11-11: desktop now uses the phone's layout: the top bar is gone and one left sidebar (public/mobile.js + app.css) holds the page menu on top, the Focus list below, and limits/Alerts/Refresh at the bottom; it shrinks to an icon rail; Filter + Archived moved into the All sessions page; picking a session from any page opens it on Focus (checked in the built-in browser at 1440, 1280, 1024, 760 and 375px, 429 tests pass; uncommitted; Electron shell and installed-PWA title-bar spacing not checked)
- 2026-11-11: fixed the Schedule tab looking missing on desktop: the uncommitted no-overflow top bar clipped the tab strip with a hidden scrollbar; now the clipped edge fades, the mouse wheel scrolls the strip and the active tab scrolls into view (checked in headless Chrome at 1280px; uncommitted, along with Focus 'Clean all')
- 2026-11-07: phone redesign (<=720px): chat-first Focus, header = menu + title + Live + bell, hamburger drawer holds all sessions (starred grouped, others below; tapping one stars + opens it), page nav, limits, alerts, refresh, archived, broadcast; Chat/Changes now above the composer, card actions behind a ... button (public/mobile.js + CSS; desktop unchanged; checked in headless Chrome at 390px, not yet on a real iPhone)
- 2026-11-07: mobile layout pass on every page (topbar, Focus card, All sessions cards)
- 2026-11-07: Cloudflare quick-tunnel option (scripts/enable-cloudflare.sh) running and verified through the public URL with curl; login limiter now per client IP; 353 tests pass; not yet tried from a phone. Tunnel URL changes on every cloudflared restart
- 2026-11-07: remote/phone access: token login for tunnel hostnames (lib/remote.js, data/remote.json) + scripts/enable-remote.sh for `tailscale serve`; gate verified with curl against a temp server, Tailscale itself not installed here so the script is untested end to end
- 2026-11-07: top-right 5h + weekly limit meters next to the bell (lib/limits.js reads Claude Code's keychain token and the undocumented api/oauth/usage endpoint, cached 60s; not yet eyeballed in a browser)
- 2026-11-07: chat renders markdown tables, headings, lists, quotes and rules (parseBlocks in public/richtext.js, 336 tests pass); not yet eyeballed in a browser; charts/mermaid/images not supported
- 2026-11-09: new Schedule tab (/schedule): routines with folder + prompt + time + repeat, each run starts its own board-only session (data/routines.json, lib/routines.js, 330 tests pass); UI not yet eyeballed in a browser
- 2026-11-07: New chat has a Chrome option (On passes --chrome to the board's claude -p runs, kept on resume); untested against a real Chrome extension, 322 tests pass
- 2026-11-07: New chat moved to the Focus sidebar and the modal replaced by an in-page empty chat with a project picker (Enter = Start here, Open in Claude secondary)
- 2026-11-07: Focus page redesigned: sidebar of starred sessions (Needs you / Working / Idle, filter, arrow keys) + one big centered chat; removed the 1/2/Auto grid and the enlarge modal; sidebar.js + 7 tests (293 pass)
- 2026-11-07: New chat → "Start here (board only)" starts a headless session from the board (data/board-sessions.json; Copy resume, Move to desktop); the desktop app cannot auto-send, its deep link only pre-fills
- 2026-11-05: origin/main history rewritten to scrub the internal GitLab host; Merge requests tab now needs GITLAB_HOST set
- 2026-11-05 (44f6389 after the history rewrite, pushed): prompt runs now start in their own process group with stderr logged to data/runs/, and the launch agent sets AbandonProcessGroup, so restarting the board no longer kills runs (including one that restarts the board); installer waits for bootout before bootstrap
- 2026-11-05: cards stay Working while a turn is mid-generation
- 2026-11-01: launch-agent plist now sets PATH so claude and MCP servers are found
- 2026-10-31: "Hand off" button on cards over 200k tokens
NEXT ACTION: Open the board in the Electron shell and confirm the sidebar head clears the window buttons and drags the window, then commit the sidebar layout; after that: Open the trycloudflare URL on the phone and sign in with the token from data/remote.json (cloudflared dies on reboot: rerun scripts/enable-cloudflare.sh, or set up a named tunnel); then Commit the Focus redesign, retake docs/screenshots/focus.png (card.png and the Enlarge section are gone), restart the launch agent (launchctl kickstart -k gui/$(id -u)/com.user.claude-session-board) and try New chat → Chrome On → Start here with a browser task to confirm --chrome works headless
Blocked on: none
Skills: csb-create-schedule
Updated: 2026-11-11
