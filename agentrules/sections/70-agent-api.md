# SN ScriptSync - Agent API

The Agent API lets AI assistants drive the extension: sync files, create/update records, query ServiceNow, take screenshots, and more. Two transports are available. Prefer the HTTP transport; the file transport is kept for backward compatibility.

> **The browser helper tab is still required.** Both transports only change the *agent <-> extension* hop. Anything that touches ServiceNow (record reads/writes, queries, screenshots) still round-trips through the SN Utils helper tab over WebSocket. Keep a helper tab open (run `/token` in a browser session) or commands return `E_BROWSER_DISCONNECTED`.

## Transport 1: HTTP (recommended, event-driven)

When the extension is running it spins up a local HTTP server bound to `127.0.0.1`, preferring the **fixed port 1977** (ephemeral fallback if taken). The actual port and auth token are published to two port files — `~/.sn-scriptsync/agent-port.json` (well-known, discoverable from any directory; written only while the connected browser has an active SN Utils Pro/Trial/Enterprise license) and `<workspace>/.vscode/sn-agent-port.json` (always written — workspace agent workflows are free):

```json
{
  "port": 1977,
  "token": "4f9a...hex...",
  "pid": 68861,
  "apiVersion": 6,
  "startedAt": 1734000000000
}
```

### Discovering the endpoint

```bash
# Unix / macOS — global file works from any cwd; older versions only write the workspace file
PORT=$(jq -r .port ~/.sn-scriptsync/agent-port.json 2>/dev/null || jq -r .port .vscode/sn-agent-port.json)
TOKEN=$(jq -r .token ~/.sn-scriptsync/agent-port.json 2>/dev/null || jq -r .token .vscode/sn-agent-port.json)
```

```powershell
# Windows PowerShell
$cfg = Get-Content "$HOME/.sn-scriptsync/agent-port.json" | ConvertFrom-Json
$PORT  = $cfg.port
$TOKEN = $cfg.token
```

### Required discovery algorithm (do this every session)

Port files can be **stale** (leftover from a crash; the workspace copy may even be synced
by iCloud/OneDrive/git from another machine), so never trust one blindly and never cache
the port/token. Each session:

1. Read `port`, `token`, and `pid` from `~/.sn-scriptsync/agent-port.json`, falling back to
   `<workspace>/.vscode/sn-agent-port.json` (older versions write only the workspace file).
2. Call `GET http://127.0.0.1:<port>/api/health`.
3. Trust the endpoint **only if** all hold:
   - the health request succeeds (HTTP 200), and
   - `health.pid` equals the `pid` from the port file (confirms the file matches the live server), and
   - `health.apiVersion` is one you support.
4. If any check fails (no file, connection refused, pid mismatch, version mismatch),
   the HTTP server is not usable here — fall back to the file transport below.
5. Detect available commands from `health.commands[]` rather than hard-coding the list;
   it changes between versions.

### Health check (no auth)

```bash
curl -s http://127.0.0.1:$PORT/api/health
# → { "status": "success", "apiVersion": 6, "commands": [...], "pid": 68861 }
```

The extension deletes both port files when the server stops, but a crash or a sync
conflict can leave a stale file behind — which is exactly why the `pid` cross-check
in step 3 is mandatory before sending real commands.

### Self-describing docs (no auth)

The running server serves its own documentation, so instructions can never drift from
the installed version: `GET /api/instructions` (connect guide + core instructions),
`GET /api/skills` (skill index), `GET /api/skills/<name>` (full skill markdown). If you
were handed only the endpoint — no workspace, no files — start there.

### Sending a command

Every authenticated request is `POST /api` with a JSON body. Provide an `X-Agent-Token` header.

```bash
curl -s -X POST http://127.0.0.1:$PORT/api \
  -H "Content-Type: application/json" \
  -H "X-Agent-Token: $TOKEN" \
  -d '{
        "command": "check_connection",
        "instance": "dev12345"
      }'
```

Response:

```json
{
  "id": "http_1734000001234_a1b2c3",
  "command": "check_connection",
  "status": "success",
  "result": { "ready": true, "appName": "Cursor" },
  "timestamp": 1734000001235
}
```

If `id` is omitted, the server generates one. Errors return a JSON body with `status: "error"` and a structured `code`:

```json
{ "status": "error", "code": "E_BROWSER_DISCONNECTED", "error": "No browser helper tab is connected." }
```

HTTP status codes map to codes:

| Code | HTTP | Meaning |
|------|------|---------|
| `E_INVALID_PARAMS` / `E_INVALID_REQUEST` / `E_CONFIRM_REQUIRED` | 400 | Malformed request, or a destructive command called without `confirm:true` |
| `E_UNAUTHORIZED` | 401 | Missing/invalid `X-Agent-Token` |
| `E_UNKNOWN_COMMAND` / `E_NOT_FOUND` | 404 | No such command, or the target record doesn't exist |
| `E_REFERENCE_INTEGRITY` | 409 | Write/delete blocked by a reference or data-integrity constraint |
| `E_INSTANCE_REQUIRED` / `E_INSTANCE_NOT_FOUND` | 422 | Instance not resolvable |
| `E_DISABLED` | 423 | Feature disabled via settings (e.g. deletes, background scripts) |
| `E_PAUSED` | 423 | The user paused agent access in the ScriptSync helper tab. Stop and tell the user — do not retry until they press Resume agents there |
| `E_PARTIAL_FAILURE` | 207 | Batch partially succeeded — inspect per-item results |
| `E_REVIEW_PENDING` | 202 | The command needs human approval in the helper tab Review Queue. **Tell the user to approve it** in the SN Utils ScriptSync helper tab in their browser, then call `get_review_result` with the `reviewId` from `details` to collect the outcome |
| `E_USER_REJECTED` | 403 | The developer rejected the command in the Review Queue — do not retry without asking the user |
| `E_INTERNAL` | 500 | Unexpected error |
| `E_ACL` / `E_TOKEN_EXPIRED` / `E_SCREENSHOT_PERMISSION` | 502 | ServiceNow rejected the request, or a tab needs a one-time capture grant (click the SN Utils icon on it, then retry) |
| `E_SERVER_NOT_RUNNING` / `E_BROWSER_DISCONNECTED` | 503 | Can't reach ServiceNow |
| `E_TIMEOUT` | 504 | Round-trip exceeded deadline |

### Resolving `E_INSTANCE_REQUIRED` (multiple instances)

When a command returns `E_INSTANCE_REQUIRED`, the workspace has more than one
instance folder and you didn't pass `"instance"`. **A single helper tab relays
for every instance the browser has a session for**, so more than one instance
can answer as "live" — don't treat any single one as exclusive, and don't
immediately ask the user to pick either.

Use freshness as a *default pick*, not an exclusivity test. The extension
rewrites `<instance>/_settings.json` (refreshing `g_ck`) every time it relays for
that instance, so the **most recently modified `_settings.json` is the
most-recently-active session**.

The fastest path — and the one to prefer — is the one-shot **`list_instances`**
command. It's purely local (no browser round-trip, never returns
`E_INSTANCE_REQUIRED`) and returns the whole roster, each `url`, a freshest-first
ranking, and a suggested `defaultInstance`:

1. Call `list_instances`. If `defaultInstance` is set (exactly one instance was
   recently active), retry your command with `"instance": defaultInstance`.
2. If `needsConfirmation` is `true` (none recent, or two-plus recent — e.g.
   `ven08329` + `ven08331`), or the operation is a write / destructive action,
   confirm the target with the user instead of guessing.
3. Optionally confirm the chosen instance's bridge actually responds with a cheap
   `get_instance_info` (check `recentlyActive` / `lastActiveAgeMs`) or
   `query_records` round-trip before committing — `connected` is bridge-level and
   is `true` for every instance whenever the helper tab is up, so it doesn't
   disambiguate.

If `list_instances` isn't available (older extension), fall back to reading the
`<instance>/_settings.json` mtimes yourself and applying the same rule. Once
resolved, reuse that `instance` for the rest of the session.

## Transport: HTTP only

The legacy file-based transport (`{instance_folder}/agent/requests/*.json`) was removed in 4.8.0. Every agent flow uses the HTTP Agent API above; if a request file is dropped in the workspace nothing will pick it up.
