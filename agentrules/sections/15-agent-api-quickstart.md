## Agent API — Quickstart

AI assistants drive the extension (sync files, read/write records, query ServiceNow,
take screenshots, control live forms) through a local Agent API. This is the connect-once
essentials; the **full transport spec, every error code, and the complete command catalog
live in the `snu-agent-api` skill** — read it before issuing commands.

> **A browser helper tab is required.** Every command that touches ServiceNow round-trips
> through the SN Utils helper tab over WebSocket. Keep a helper tab open (run `/token` in a
> ServiceNow session) or commands return `E_BROWSER_DISCONNECTED`.

### Connect (do this every session — never cache port/token)

The extension publishes its port + auth token to `.vscode/sn-agent-port.json`. The file can be
stale (synced from another machine, leftover from a crash), so validate it live every session:

1. Read `port`, `token`, `pid` from `.vscode/sn-agent-port.json`.
2. `GET http://127.0.0.1:<port>/api/health` — trust the endpoint **only if** it returns HTTP 200,
   `health.pid` matches the file's `pid`, and `health.apiVersion` is one you support.
3. Discover the live command set from `health.commands[]` — don't hard-code it.
4. If any check fails, the HTTP server isn't usable — fall back to the file transport (see the
   `snu-agent-api` skill).

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
