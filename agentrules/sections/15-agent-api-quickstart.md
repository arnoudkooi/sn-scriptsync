## Agent API — Quickstart

AI assistants drive the extension (sync files, read/write records, query ServiceNow,
take screenshots, control live forms) through a local Agent API. This is the connect-once
essentials; the **full transport spec, every error code, and the complete command catalog
live in the `snu-agent-api` skill** — read it before issuing commands.

> **A browser helper tab is required.** Every command that touches ServiceNow round-trips
> through the SN Utils helper tab over WebSocket. Keep a helper tab open (run `/token` in a
> ServiceNow session) or commands return `E_BROWSER_DISCONNECTED`.

### Connect (do this every session — never cache port/token)

The server prefers the **fixed port 1977** and publishes its actual port + auth token to two
port files: `~/.sn-scriptsync/agent-port.json` (well-known, works from any directory —
written only when the connected browser has an active SN Utils Pro/Trial/Enterprise license)
and `<workspace>/.vscode/sn-agent-port.json` (always written; workspace agent workflows are
free). Files can be stale (leftover from a crash), so validate live every session:

1. Read `port`, `token`, `pid` from `~/.sn-scriptsync/agent-port.json` (fall back to
   `.vscode/sn-agent-port.json` for older versions). Expect `port` to be 1977 unless it was
   taken and the server fell back to an ephemeral one.
2. `GET http://127.0.0.1:<port>/api/health` — trust the endpoint **only if** it returns HTTP 200,
   `health.pid` matches the file's `pid`, and `health.apiVersion` is one you support.
3. Discover the live command set from `health.commands[]` — don't hard-code it.
4. If any check fails, the HTTP server isn't usable — fall back to the file transport (see the
   `snu-agent-api` skill).

The running server also serves its own docs (no auth): `GET /api/instructions` (this guide,
always matching the installed version), `GET /api/skills` (index), and `GET /api/skills/<name>`
(full skill) — useful when you have the endpoint but not the workspace files.

### Send a command

```bash
curl -s -X POST http://127.0.0.1:$PORT/api \
  -H "Content-Type: application/json" \
  -H "X-Agent-Token: $TOKEN" \
  -d '{ "command": "check_connection", "instance": "dev12345" }'
```

Errors return `{ "status": "error", "code": "E_...", "error": "..." }`. The most common ones:
`E_BROWSER_DISCONNECTED` (open a helper tab), `E_DISABLED` (feature gated in settings),
`E_CONFIRM_REQUIRED` (destructive command needs `confirm:true`), `E_SCREENSHOT_PERMISSION`
(click the SN Utils icon on the tab once, then retry). Full table is in the `snu-agent-api` skill.
