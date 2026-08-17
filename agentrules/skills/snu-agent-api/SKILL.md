---
name: snu-agent-api
description: SN ScriptSync HTTP/file Agent API: endpoint discovery, auth, the full error-code table, and the complete command catalog (query_records, get_record, update_record, create_artifact, create_application, rest_request, screenshots, etc.). Read this before calling any Agent API command.
---

<!-- SN-SCRIPTSYNC:SKILL apiVersion=19 -->

# SN ScriptSync — Agent API

Full reference for the SN ScriptSync Agent API and every command except the live-form g_form bridge (see the snu-form-automation skill) and the browser debugger (see the snu-browser-debug skill).

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

## Commands

### `check_connection` ⚡ (CALL THIS FIRST)
Verify WebSocket server is running and browser helper tab is connected. **Always call this before any other operations.**

**Request:**
```json
{ "id": "0", "command": "check_connection" }
```

**Response (ready):**
```json
{
  "status": "success",
  "result": {
    "ready": true,
    "serverRunning": true,
    "browserConnected": true,
    "message": "Connected and ready",
    "helper": { "debuggerAvailable": false, "tier": "pro", "proFeatures": true }
  }
}
```

**`helper` tells you which SN Utils build is connected.** `debuggerAvailable` is true only on the SN Utils Debug edition; most users run the regular build. You don't need this to take screenshots (`take_screenshot` auto-routes to the best available path), but it tells you what else this session can do:

- `debuggerAvailable: false` → explicit debugger commands (`capture_full_page`, network/console capture, dialog handling) will return `E_CDP_UNAVAILABLE`, and a screenshot on an ungranted tab will require the user's one-time icon click.
- `debuggerAvailable: true` + `proFeatures: true` → full-page/element captures and network/console/dialog debugging are available (subject to the `browserDebugger` gate — see `get_capabilities`), and screenshots never need a permission click.
- `helper: null` → the handshake hasn't arrived yet (or the license lookup failed); retry or fall back to `get_capabilities` for the authoritative, browser-verified view.

**Response (server not running):**
```json
{
  "status": "error",
  "error": "WebSocket server not running. Click sn-scriptsync in VS Code status bar to start.",
  "result": {
    "ready": false,
    "serverRunning": false,
    "browserConnected": false,
    "message": "WebSocket server not running"
  }
}
```

**Response (no browser):**
```json
{
  "status": "error",
  "error": "No browser connection. Open SN Utils helper tab via /token command in ServiceNow.",
  "result": {
    "ready": false,
    "serverRunning": true,
    "browserConnected": false,
    "message": "No browser connected - open helper tab with /token"
  }
}
```

### `get_capabilities` ⚡ (preflight Pro / debugger / security gates)
Ask the connected SN Utils helper tab what it can do **right now** — the Agent API version, the license tier, whether the Chrome DevTools Protocol **browser debugger** (network/console capture, full-page screenshots, native dialog handling) is usable, which protocol **`capabilities`** the helper supports (two-phase command review, per-instance security gates), and the per-instance **`instanceGates`** snapshots. Call this once up front so you can preflight `E_DISABLED` instead of discovering it mid-operation, and before reaching for the `snu-browser-debug` skill instead of firing a CDP command and parsing the error.

Requires a connected helper tab (`E_BROWSER_DISCONNECTED` otherwise — run `check_connection` first).

**Request:**
```json
{ "id": "cap_1", "command": "get_capabilities" }
```

**Response (v8 helper with per-instance gates):**
```json
{
  "status": "success",
  "result": {
    "apiVersion": 8,
    "tier": "pro",
    "proFeatures": true,
    "cdp": { "available": true, "reason": null },
    "capabilities": { "protocolVersion": 1, "commandReview": 1, "instanceSecurityGates": 1 },
    "instanceGates": {
      "https://example.service-now.com": {
        "revision": 3,
        "gates": {
          "backgroundScripts": "approve",
          "deleteRecords": "off",
          "createArtifacts": "auto",
          "browserDebugger": "off",
          "restRequest": "auto"
        }
      }
    }
  }
}
```

**Response (older SN Utils build — no review protocol):**
```json
{
  "status": "success",
  "result": {
    "apiVersion": 8,
    "tier": "pro",
    "proFeatures": true,
    "cdp": { "available": false, "reason": "E_CDP_UNAVAILABLE" },
    "capabilities": { "protocolVersion": 1 },
    "instanceGates": {}
  }
}
```

- `tier` — `community` | `pro` | `trial` | `enterprise` (license of the connected helper tab).
- `proFeatures` — `true` when the tier unlocks Pro features (e.g. `code_search`).
- `cdp.available` — `true` only when the debugger adapter is present (Debug edition build) **and** the license is Pro/Trial/Enterprise.
- `cdp.reason` — when `available` is `false`, the code you would otherwise have hit: `E_CDP_UNAVAILABLE` (Community build / no debugger adapter) or `E_PRO_REQUIRED` (adapter present but license isn't Pro).
- `capabilities` — what the connected helper's protocol supports. `commandReview: 1` means high-risk commands (`run_background_script`, `delete_record`, destructive `run_ui_action`, `delete_application`) go through the helper-tab **Review Queue**: expect `E_REVIEW_PENDING`, then collect the outcome with `get_review_result`. When `commandReview` is absent the helper is an older SN Utils build: those commands run directly and are gated by the `sn-scriptsync.*.enabled` VS Code settings instead.
- `instanceGates` — per-instance tri-state grants keyed by instance origin, published only by helpers with `instanceSecurityGates: 1`. `off` refuses the command (`E_DISABLED`), `auto` runs it without review, `approve` routes it through the Review Queue. A gate that is missing for an instance counts as `off` (deny-wins). Checking gates up front lets you warn the user *before* issuing a command that will need their approval.
- When a command is refused with `E_DISABLED`, relay the error message to the user (it names the helper-tab gate or the VS Code setting to enable) rather than retrying.

### `get_review_result` (collect a human-review outcome)

Guarded commands (background scripts, deletes, some UI actions) whose per-instance gate is set to **Approve** don't execute immediately: the command returns `E_REVIEW_PENDING` right away with a `reviewId`, and the actual request waits in the SN Utils helper tab **Review Queue** for the developer to approve or reject (5-minute window). The helper tab announces the pending review itself (sound, favicon flash, Review Queue badge).

**When you receive `E_REVIEW_PENDING`: tell the user to approve the request in the SN Utils ScriptSync helper tab in their browser, then call this command to collect the outcome.** Long-polls up to `waitSeconds` (default 30, max 55) per call; poll again while it keeps returning `E_REVIEW_PENDING`.

**Request:**
```json
{ "id": "revres_1", "command": "get_review_result", "params": { "reviewId": "rev_1786...._ab12cd", "waitSeconds": 30 } }
```

**Response (approved & executed):** the original command's result, e.g. for `run_background_script`:
```json
{ "status": "success", "result": { "reviewId": "rev_....", "command": "run_background_script", "output": "*** Script: ..." } }
```

**Errors:**
- `E_REVIEW_PENDING` — still undecided; remind the user and poll again.
- `E_USER_REJECTED` — the developer rejected it; don't retry without asking.
- `E_TIMEOUT` — the 5-minute review window expired unanswered; re-issue the original command to start a new review.
- `E_NOT_FOUND` — unknown/expired `reviewId` (settled results are kept ~10 minutes).

> Prefer this two-phase flow. If you genuinely need the old blocking behavior (the original call holding open until the decision), pass `"awaitReview": true` in the original command's `params` — but note most HTTP clients time out long before the 5-minute window.

### `list_instances`
List every instance in the workspace with its URL and per-instance activity
freshness, plus a suggested default. **Purely local** — it reads the
`*/​_settings.json` files directly, so it needs no browser helper tab and never
returns `E_INSTANCE_REQUIRED`. Use it as the first step when you don't yet know
which instance to target.

`instances` is sorted freshest-first (`lastActiveAgeMs` ascending; never-active
folders last). `recentlyActive` means the instance's `_settings.json` was
rewritten within ~10h — the extension refreshes that file (and `g_ck`) whenever
the helper tab relays for that instance, so it's a freshness proxy, not proof of
a live tab. `defaultInstance` is set **only** when exactly one instance is
recently active; when `needsConfirmation` is `true` (none recent, or two-plus
recent) pick with the user before any write. `connected` is bridge-level (the one
helper tab relays for every instance), not per-instance.

**Request:**
```json
{ "id": "1", "command": "list_instances" }
```

**Response:**
```json
{
  "result": {
    "instances": [
      { "name": "ven08329", "url": "https://ven08329.service-now.com", "recentlyActive": true, "lastActiveAgeMs": 425000, "hasSettings": true },
      { "name": "ven08331", "url": "https://ven08331.service-now.com", "recentlyActive": true, "lastActiveAgeMs": 980000, "hasSettings": true },
      { "name": "empakooi", "url": "https://empakooi.service-now.com", "recentlyActive": false, "lastActiveAgeMs": 10500000000, "hasSettings": true }
    ],
    "count": 3,
    "connected": true,
    "defaultInstance": null,
    "needsConfirmation": true
  }
}
```

### `get_instance_info`
Get instance connection info, including per-instance activity freshness.

Pass `"instance"` to inspect a specific candidate (useful for disambiguating
`E_INSTANCE_REQUIRED`). `connected` is bridge-level — it is `true` for every
instance whenever the WS server is up with the helper tab connected, because the
single helper tab relays for every instance the browser has a session for. Use
`recentlyActive` / `lastActiveAgeMs` (derived from the `_settings.json` mtime) to
tell *which* instance is the most-recently-active session.

**Request:**
```json
{ "id": "2", "command": "get_instance_info", "instance": "ven08329" }
```

**Response:**
```json
{
  "result": {
    "instanceName": "ven08329",
    "hasSettings": true,
    "connected": true,
    "recentlyActive": true,
    "lastActiveAgeMs": 425000
  }
}
```

### `get_sync_status`
Get current sync queue status.

**Request:**
```json
{ "id": "1", "command": "get_sync_status" }
```

**Response:**
```json
{
  "result": {
    "serverRunning": true,
    "pendingFiles": ["/path/to/file.js"],
    "pendingCount": 1,
    "isPaused": false
  }
}
```

### `sync_now` ⚡
Immediately sync all pending files (flush the queue). Use this after making multiple file changes to ensure they're synced before continuing.

**Request:**
```json
{ "id": "2", "command": "sync_now" }
```

**Response (when files pending):**
```json
{
  "result": {
    "synced": true,
    "message": "Synced 3 file(s) immediately",
    "count": 3,
    "files": ["/path/to/file1.js", "/path/to/file2.js", "/path/to/file3.js"]
  }
}
```

**Response (when no files pending):**
```json
{
  "result": {
    "synced": false,
    "message": "No pending files to sync",
    "count": 0
  }
}
```

### `get_last_error`
Get the last error that occurred. Errors are automatically written to `_last_error.json` and pending Agent requests are failed when ServiceNow returns an error.

**Request:**
```json
{ "id": "err", "command": "get_last_error" }
```

**Response (when error exists):**
```json
{
  "result": {
    "hasError": true,
    "isRecent": true,
    "error": "ACL Error, try changing scope in the browser",
    "time": "2024-12-07T12:30:45.123Z",
    "timestamp": 1733567445123,
    "details": { "message": "...", "detail": "..." }
  }
}
```

**Response (no error):**
```json
{
  "result": {
    "hasError": false,
    "message": "No errors recorded"
  }
}
```

### `clear_last_error`
Clear the last error file.

**Request:**
```json
{ "id": "clr", "command": "clear_last_error" }
```

**Response:**
```json
{
  "result": {
    "cleared": true,
    "message": "Error cleared"
  }
}
```

### `update_record`

Update a single field on an existing record. Fire-and-forget (the extension sends the update through the helper tab; success is reported back asynchronously).

**Requires:** browser helper tab connected.

**Request:**
```json
{
  "id": "upd_1",
  "command": "update_record",
  "instance": "dev12345",
  "params": {
    "table": "sys_script_include",
    "sys_id": "abc123def456...",
    "field": "script",
    "content": "gs.info('hello from the agent');"
  }
}
```

**Response (success):**
```json
{
  "id": "upd_1",
  "command": "update_record",
  "status": "success",
  "result": {
    "success": true,
    "message": "Update sent for sys_script_include/abc123def456...",
    "table": "sys_script_include",
    "sys_id": "abc123def456...",
    "field": "script"
  }
}
```

**Synchronous confirmation:** add `"await": true` to write via the Table API and read the value back. The response then includes `awaited: true`, the `persisted` value, and a `warnings[]` array flagging any field that came back empty (e.g. silently dropped by an ACL/read-only/business rule).

```json
{ "id": "upd_2", "command": "update_record", "params": { "table": "sys_script_include", "sys_id": "abc...", "field": "active", "content": "false", "await": true } }
```

**Review mode:** when `sn-scriptsync.agentApi.reviewWrites` is on (default off), this write is **not** sent. It is parked in the VS Code "Pending Saves" queue and the response is `{ "staged": true, "reviewId": "...", "message": "..." }`. The user reviews it and approves it with **Sync Now** (or discards it); `await` is ignored while staged. Treat a `staged: true` response as "queued for human approval", not "applied".

**Errors:**
- `E_INVALID_PARAMS` - missing sys_id/table/field/content
- `E_BROWSER_DISCONNECTED` - no helper tab available
- `E_INSTANCE_NOT_FOUND` - `_settings.json` missing

### `update_record_batch`

Update multiple fields on the same record in one round-trip. Preferred for multi-file artifacts (widgets, UI pages) where you'd otherwise send many `update_record` calls.

**Requires:** browser helper tab connected.

**Request:**
```json
{
  "id": "upd_batch_1",
  "command": "update_record_batch",
  "instance": "dev12345",
  "params": {
    "table": "sp_widget",
    "sys_id": "abc123def456...",
    "fields": {
      "script":        "data.hello = 'world';",
      "client_script": "function($scope){ /* ... */ }",
      "css":           ".c1 { color: red; }"
    }
  }
}
```

**Response (success):**
```json
{
  "id": "upd_batch_1",
  "command": "update_record_batch",
  "status": "success",
  "result": {
    "success": true,
    "message": "Updated 3 field(s) on sp_widget/abc123def456...",
    "table": "sp_widget",
    "sys_id": "abc123def456...",
    "fields": ["script", "client_script", "css"]
  }
}
```

**Synchronous confirmation:** add `"await": true` to write via the Table API and read the values back. The response includes `awaited: true`, `persisted`, and a `warnings[]` array for fields that came back empty. Note: `sys_scope` is read-only after insert — it is stripped from the payload and reported as a warning (use `create_application`/`create_artifact` to set scope at insert time).

**Review mode:** when `sn-scriptsync.agentApi.reviewWrites` is on (default off), this write is **not** sent. It is parked in the VS Code "Pending Saves" queue and the response is `{ "staged": true, "reviewId": "...", "message": "..." }`. The user approves it with **Sync Now** (or discards it); `await` is ignored while staged.

**Errors:**
- `E_INVALID_PARAMS` - missing sys_id/table/fields, or `fields` object is empty
- `E_BROWSER_DISCONNECTED` - no helper tab available
- `E_INSTANCE_NOT_FOUND` - `_settings.json` missing

### `create_artifact` ⚡ (RECOMMENDED FOR AI AGENTS)
Create a new artifact directly via payload. **This is the preferred method for AI agents** - no file creation needed, executes immediately (not queued).

**⚠️ IMPORTANT: Transaction Scope Required**
The extension automatically includes `?sysparm_transaction_scope=<SCOPE_SYS_ID>` in the API request to ensure the artifact is created in the correct scope context.

**Request:**
```json
{ 
  "id": "11", 
  "command": "create_artifact", 
  "params": { 
    "table": "sys_script_include",
    "scope": "global",
    "fields": {
      "name": "MyNewUtils",
      "script": "var MyNewUtils = Class.create();\nMyNewUtils.prototype = {\n    initialize: function() {},\n    type: 'MyNewUtils'\n};",
      "active": "true",
      "access": "public"
    }
  } 
}
```

**Parameters:**
- `table` (required): The ServiceNow table (e.g., `sys_script_include`, `sys_script`)
- `scope` (required): Scope name - always specify explicitly (e.g., `global`, `x_myapp`)
- `fields` (required): Object containing field:value pairs
  - `name` (required): The artifact name
  - Other fields depend on the table (script, active, etc.)

**Response:**
```json
{
  "status": "success",
  "result": {
    "sys_id": "abc123def456789012345678901234",
    "name": "MyNewUtils",
    "table": "sys_script_include",
    "scope": "global"
  }
}
```

**Synchronous confirmation:** add `"await": true` to read the new record back after creation. The response then includes `awaited: true`, the `persisted` field values, and a `warnings[]` array flagging any requested field that came back empty (e.g. silently dropped).

**Benefits over file-based creation:**
- ✅ Executes immediately (not queued with debounce)
- ✅ Can set multiple fields in one request
- ✅ Can set reference fields directly (e.g., `web_service_definition` for REST API operations)
- ✅ No need to create files first
- ✅ Automatically updates `_map.json`

**Example: Creating a Business Rule with table reference:**
```json
{
  "id": "12",
  "command": "create_artifact",
  "params": {
    "table": "sys_script",
    "scope": "global",
    "fields": {
      "name": "My Business Rule",
      "collection": "incident",      // ✅ Include table reference in payload
      "script": "// Business Rule script",
      "when": "before",               // ✅ Include when in payload
      "action_insert": "true",        // ✅ Include action in payload
      "active": "true"                // ✅ Include active in payload
    }
  }
}
```

**⚠️ NOTE:** All configuration fields (`collection`, `when`, `action_insert`, `active`) are included in the **single payload**. These are STRING/BOOLEAN values, not code.

**Do NOT create files for configuration fields:**
- ❌ `MyBR.collection.js` - this is just the string "incident"
- ❌ `MyBR.when.js` - this is just the string "before"
- ❌ `MyBR.active.js` - this is just the boolean true

**Only the script content (actual code) goes in a file:**
- ✅ `MyBR.script.js` - contains the business rule code

**If an artifact has multiple code fields, create multiple files:**
- ✅ `MyUIPage.html` - contains markup
- ✅ `MyUIPage.client_script.js` - contains client-side code
- ✅ `MyUIPage.processing_script.js` - contains server-side code

**Example: Creating a REST API Operation with parent reference:**
```json
{
  "id": "13",
  "command": "create_artifact",
  "params": {
    "table": "sys_ws_operation",
    "scope": "x_myapp",
    "fields": {
      "name": "getUsers",
      "web_service_definition": "abc123def456",
      "http_method": "GET",
      "operation_script": "(function process(request, response) {\n    response.setBody({message: 'Hello'});\n})(request, response);",
      "active": "true"
    }
  }
}
```

**⚠️ Large / multi-field payloads (widgets etc.):** A widget's four big code fields (`template`, `css`, `script`, `client_script`) are escaping-hell to pass inline on a shell command line (`curl -d '...'`). Don't hand-build the JSON string — write the request body to a file and send it with `curl -d @body.json` (build the file with `JSON.stringify` so newlines/quotes are encoded correctly), or use the file transport. This applies to any multiline or large field value.

**Review mode:** when `sn-scriptsync.agentApi.reviewWrites` is on (default off), the record is **not** created. The request is parked in the VS Code "Pending Saves" queue and the response is `{ "staged": true, "reviewId": "...", "message": "..." }`. The user approves it with **Sync Now** (which then creates the record and updates `_map.json`) or discards it; `await` is ignored while staged. Treat a `staged: true` response as "queued for human approval", not "created" — the `sys_id` is only assigned on approval.

**Errors:**
- `E_DISABLED` — artifact creation is off (`sn-scriptsync.createArtifacts.enabled`). This setting **defaults to `true`**, so creation works out of the box; it only fails here if the user explicitly turned it off. Check `get_capabilities` → `gates.createArtifacts` to preflight.
- `E_INVALID_PARAMS` — missing `table`, missing `fields`, or missing `fields.name`.

**⚠️ `fields.name` is required for every table.** For a *data* table whose display field isn't `name` (e.g. a custom table whose display column is `title`), don't fight this command — seed rows with `rest_request` instead: `POST /api/now/table/<table>` with the row in `body` (requires `sn-scriptsync.restRequest.enabled`). `create_artifact` is for metadata/code artifacts; `rest_request` POST is the blessed path for plain data rows.

### `delete_record` ⚠️ (DESTRUCTIVE — guarded)

Delete a record by `table` + `sys_id`, or bulk-delete by query. **Disabled by default.** Enable `sn-scriptsync.deleteRecords.enabled` in VS Code settings to allow it.

**Single delete:**
```json
{
  "id": "del_1",
  "command": "delete_record",
  "params": { "table": "incident", "sys_id": "abc123def456..." }
}
```

The display value (name/number/short_description) is read back first and echoed so you can confirm what was removed.

**Bulk delete (query-based):** requires `confirm: true` AND a positive integer `limit`.
```json
{
  "id": "del_2",
  "command": "delete_record",
  "params": { "table": "incident", "query": "active=false^sys_created_on<javascript:gs.daysAgo(365)", "limit": 50, "confirm": true }
}
```

**Preview without deleting:** add `"dryRun": true` to return the matches that *would* be deleted.

**Parameters:**
- `table` (required).
- `sys_id` — single-record mode.
- `query` — bulk mode (encoded query). Mutually exclusive with `sys_id`.
- `confirm` (bulk, required): must be `true`.
- `limit` (bulk, required): positive integer cap on how many records are deleted.
- `dryRun` (optional): preview only, never deletes.

**Response (single):**
```json
{ "status": "success", "result": { "deleted": true, "table": "incident", "sys_id": "abc...", "display": "INC0010001" } }
```

**Errors:**
- `E_DISABLED` — `sn-scriptsync.deleteRecords.enabled` is off.
- `E_CONFIRM_REQUIRED` — bulk delete without `confirm:true` + `limit`.
- `E_NOT_FOUND` — single sys_id does not exist.
- `E_REFERENCE_INTEGRITY` — blocked by a referencing record (HTTP 409).
- `E_PARTIAL_FAILURE` — some records in a bulk delete failed (see `details.results`).

### `create_application`

Create a scoped application (`sys_app`). The **scope is set at insert time** — it is read-only afterwards, so this is the correct way to establish a new scope. The resolved scope name → sys_id is recorded in `scopes.json` so later `create_artifact` / `add_column` calls can target it.

**Request:**
```json
{
  "id": "app_1",
  "command": "create_application",
  "params": { "name": "My Cool App", "prefix": "acme", "short_description": "Demo app" }
}
```

**Parameters:**
- `name` (required): Friendly application name.
- `scope` (optional): Explicit scope (e.g. `x_acme_mycoolapp`). If omitted, derived as `x_<prefix>_<slug(name)>`.
- `prefix` (required when `scope` omitted): Vendor/company code used to derive the scope.
- `short_description` (optional), `version` (optional, default `1.0.0`).

**Response:**
```json
{ "status": "success", "result": { "created": true, "name": "My Cool App", "scope": "x_acme_my_cool_app", "sys_id": "..." } }
```

**Errors:**
- `E_DISABLED` — `sn-scriptsync.createArtifacts.enabled` is off.
- `E_INVALID_PARAMS` — neither `scope` nor `prefix` provided.

### `create_table`

Create a custom table by inserting a `sys_db_object` record. ServiceNow auto-creates the physical table and its base `sys_*` fields (`sys_id`, `sys_created_on`, `sys_updated_on`, etc.). Pair it with `add_column` for your own fields, and set the display column via `add_column` `display: true`. This mirrors the `create_application` / `add_column` ergonomics so you don't have to drive `create_artifact` against `sys_db_object` by hand.

**Request:**
```json
{
  "id": "tbl_1",
  "command": "create_table",
  "params": { "name": "project", "label": "Project", "scope": "x_acme_myapp", "extends": "task" }
}
```

**Parameters:**
- `name` (required): Table name. When a non-global `scope` is given and the name isn't already prefixed, it is prefixed for you as `<scope>_<name>` (e.g. `x_acme_myapp_project`). An already-prefixed `x_...` name is left as-is.
- `label` (optional): Human label (defaults to a title-cased `name`).
- `scope` (optional): Scope name; when known (in `scopes.json`) the table is created with `sysparm_transaction_scope` set so it lands in the right app. Omit (or `global`) for a global table.
- `extends` / `super_class` (optional): Parent table to extend (e.g. `task`). Omit for a standalone table.

**Response:**
```json
{ "status": "success", "result": { "created": true, "name": "x_acme_myapp_project", "label": "Project", "sys_id": "...", "scope": "x_acme_myapp" } }
```

**Typical table-build flow:**
1. `create_table` → get the prefixed `name` back.
2. `add_column` for each field (set `display: true` on the one you want as the display value, plus `mandatory` / `choices` / etc. inline).
3. Seed data rows with `rest_request` `POST /api/now/table/<name>` (display field need not be `name`).

**Errors:**
- `E_DISABLED` — `sn-scriptsync.createArtifacts.enabled` is off (defaults to `true`). Preflight with `get_capabilities` → `gates.createArtifacts`.
- `E_INVALID_PARAMS` — missing `name`.

### `add_column`

Add a column to a table by creating a `sys_dictionary` entry (keyed by `table.element`). Use this instead of `create_artifact` for dictionary entries — it avoids the `_map.json` name collision where every column would share `name = <table>`.

**Request:**
```json
{
  "id": "col_1",
  "command": "add_column",
  "params": { "table": "x_acme_myapp_widget", "element": "priority", "type": "integer", "label": "Priority", "display": true, "mandatory": true, "scope": "x_acme_myapp" }
}
```

**Parameters:**
- `table` (required): Table to add the column to.
- `element` (required): Column name (the `element`).
- `type` (optional, default `string`): Internal type, e.g. `string`, `integer`, `boolean`, `glide_date_time`, `reference`, `choice`.
- `label` (optional): Column label (defaults to a title-cased `element`).
- `max_length` (optional): For string columns.
- `reference` (optional): Referenced table when `type` is `reference`.
- `display` (optional, boolean): Make this the table's display column — no separate `update_record` needed.
- `mandatory` (optional, boolean): Mark the column mandatory.
- `read_only` (optional, boolean): Mark the column read-only.
- `default` (optional): Default value for the column.
- `reference_qual` (optional): Reference qualifier (for `reference` columns).
- `choice` (optional): Dropdown mode — `0` none, `1` dropdown with `--None--`, `3` dropdown without `--None--`.
- `choices` (optional, array): Create the choice list values in the same call. Each entry is either a plain string (used for both label and value) or `{ "label": "...", "value": "...", "sequence": 0 }`. Supplying `choices` defaults `choice` to `1` unless you set it explicitly.
- `scope` (optional): Scope name; when known (in `scopes.json`) the column (and its choices) are created with `sysparm_transaction_scope` set so they land in the right app.

**Example with attributes + choices:**
```json
{
  "id": "col_2",
  "command": "add_column",
  "params": {
    "table": "x_acme_myapp_project",
    "element": "stage",
    "type": "choice",
    "label": "Stage",
    "display": true,
    "mandatory": true,
    "default": "planning",
    "choices": [
      { "label": "Planning", "value": "planning" },
      { "label": "In Progress", "value": "in_progress" },
      "Done"
    ]
  }
}
```

**Response:**
```json
{ "status": "success", "result": { "created": true, "table": "x_acme_myapp_widget", "element": "priority", "type": "integer", "label": "Priority", "sys_id": "...", "choices": ["planning", "in_progress", "Done"] } }
```

`choices` is present in the response only when you passed a `choices` array; it lists the values that were created.

**Errors:**
- `E_DISABLED` — `sn-scriptsync.createArtifacts.enabled` is off.
- `E_INVALID_PARAMS` — missing table/element.

### `delete_application` ⚠️ (DESTRUCTIVE — cascade)

Delete a scoped application: its scoped metadata (records whose `sys_scope` is the app) **and** the `sys_app` record itself, via a guarded background script. Irreversible. Requires `confirm: true` and **both** `sn-scriptsync.deleteRecords.enabled` and `sn-scriptsync.backgroundScripts.enabled`.

**Request:**
```json
{
  "id": "delapp_1",
  "command": "delete_application",
  "params": { "scope": "x_acme_myapp", "confirm": true }
}
```

**Parameters:**
- `sys_id` — the `sys_app` sys_id (32-char hex), **or**
- `scope` — the scope name (e.g. `x_acme_myapp`).
- `confirm` (required): must be `true`.

**Response:**
```json
{ "status": "success", "result": { "deleted": true, "name": "My App", "scope": "x_acme_myapp", "childRecordsDeleted": 37 } }
```

**Errors:**
- `E_DISABLED` — delete and/or background-script settings are off.
- `E_CONFIRM_REQUIRED` — `confirm:true` not provided.
- `E_NOT_FOUND` — no application matched `sys_id`/`scope`.
- `E_INVALID_PARAMS` — neither `sys_id` nor `scope`, or malformed values.

> Best-effort cascade: it sweeps `sys_metadata` for the app's scope then deletes `sys_app`. Some artifact types may need a manual follow-up; verify in the instance afterwards.

### `get_record`

Fetch a single record by `table` + `sys_id`. Cheaper and simpler than `query_records` when you already know the sys_id (e.g. to confirm a write).

**Request:**
```json
{
  "id": "get_1",
  "command": "get_record",
  "params": {
    "table": "incident",
    "sys_id": "abc123def456...",
    "fields": "number,short_description,state,priority"
  }
}
```

**Parameters:**
- `table` (required): The ServiceNow table.
- `sys_id` (required): The record sys_id.
- `fields` (optional): Comma-separated `sysparm_fields` list. Omit for all fields.

**Response:**
```json
{
  "status": "success",
  "result": {
    "table": "incident",
    "sys_id": "abc123def456...",
    "record": { "number": "INC0010001", "short_description": "...", "state": "2" }
  }
}
```

**Errors:**
- `E_NOT_FOUND` — no record with that sys_id.
- `E_INVALID_PARAMS` — missing table/sys_id.

### `get_table_metadata`
Fetch table field definitions from ServiceNow API.

**Request:**
```json
{ "id": "8", "command": "get_table_metadata", "params": { "table": "sys_script_include" } }
```

**Response:**
```json
{
  "result": {
    "columns": {
      "name": { "label": "Name", "type": "string", "mandatory": false, "max_length": 100 },
      "script": { "label": "Script", "type": "script_plain", "mandatory": false },
      "active": { "label": "Active", "type": "boolean", "default": "false" }
    }
  }
}
```

### `check_name_exists_remote`
Check if an artifact exists in ServiceNow (queries the actual instance, not just local files).

**Request:**
```json
{ "id": "9", "command": "check_name_exists_remote", "params": { "table": "sys_script_include", "name": "MyUtils" } }
```

**Response:**
```json
{
  "result": {
    "exists": true,
    "sysId": "abc123def456",
    "record": { "name": "MyUtils", "sys_scope": "global" }
  }
}
```

### `query_records` ⚡
Execute an arbitrary encoded query against any ServiceNow table. Use this to fetch data, check conditions, or explore records.

**Request:**
```json
{ 
  "id": "q1", 
  "command": "query_records", 
  "params": { 
    "table": "incident",
    "query": "priority=1^active=true",
    "fields": "number,short_description,priority,state,sys_created_on",
    "limit": 5,
    "orderBy": "ORDERBYDESCsys_created_on"
  } 
}
```

**Parameters:**
- `table` (required): The ServiceNow table to query
- `query` (optional): Encoded query string (e.g., `priority=1^active=true`)
- `fields` (optional): Comma-separated field names (default: `sys_id,number,short_description,sys_created_on`)
- `limit` (optional): Max records to return (default: 10)
- `orderBy` (optional): Order clause (e.g., `ORDERBYDESCsys_created_on`)

**Response:**
```json
{
  "status": "success",
  "result": {
    "table": "incident",
    "count": 3,
    "records": [
      {
        "sys_id": "abc123",
        "number": "INC0010001",
        "short_description": "Server down",
        "priority": "1",
        "state": "2",
        "sys_created_on": "2024-12-07 10:30:00"
      },
      ...
    ]
  }
}
```

**Common Query Examples:**

| Use Case | Query |
|----------|-------|
| **Get single record by sys_id** | `sys_id=abc123def456...` |
| Active P1 incidents | `priority=1^active=true` |
| Recent changes | `ORDERBYDESCsys_created_on` |
| My assigned tasks | `assigned_to=javascript:gs.getUserID()^active=true` |
| Open problems | `state!=7^state!=8` |
| Items in scope | `sys_scope.scope=x_myapp` |
| Name contains | `nameLIKEutils` |
| Created today | `sys_created_onONToday@javascript:gs.beginningOfToday()@javascript:gs.endOfToday()` |

**Encoded Query Operators:**
- `=` equals
- `!=` not equals
- `LIKE` contains
- `NOT LIKE` does not contain (the space is required)
- `STARTSWITH` starts with
- `ENDSWITH` ends with
- `>` greater than
- `<` less than
- `>=` greater or equal
- `<=` less or equal
- `IN` in list (comma-separated)
- `NOT IN` not in list (comma-separated; the space is required)
- `ISEMPTY` is empty
- `ISNOTEMPTY` is not empty
- `^` AND
- `^OR` OR
- `^NQ` new query (OR group)

### `get_parent_options`
Get available parent records for reference fields. Use this to find existing REST API services, tables, etc.

**Request:**
```json
{ 
  "id": "10", 
  "command": "get_parent_options", 
  "params": { 
    "table": "sys_ws_definition",
    "scope": "x_myapp",
    "nameField": "name",
    "limit": 50
  } 
}
```

**Parameters:**
- `table` (required): The parent table to query (e.g., `sys_ws_definition` for REST API services)
- `scope` (optional): Filter by scope name
- `nameField` (optional): Field to use as display name (default: `name`)
- `limit` (optional): Max records to return (default: 50)

**Response:**
```json
{
  "result": {
    "table": "sys_ws_definition",
    "count": 3,
    "options": [
      { "sys_id": "abc123", "name": "My REST API", "scope": "x_myapp" },
      { "sys_id": "def456", "name": "Another API", "scope": "global" },
      { "sys_id": "ghi789", "name": "Third API", "scope": "x_myapp" }
    ]
  }
}
```

**Common use cases:**
| Creating | Query table | To get |
|----------|-------------|--------|
| REST API Operation | `sys_ws_definition` | Available REST API services |
| Business Rule | `sys_db_object` | Available tables |
| UI Action | `sys_db_object` | Available tables |
| Client Script | `sys_db_object` | Available tables |

### `code_search` ⚡ (Pro feature)
Run the SN Utils GraphQL field-index code search across ServiceNow script tables and return structured matches. This is the same engine as the SN Utils code search page — far better than a plain `query_records` `LIKE` at finding where a term actually lives in scripts (script includes, business rules, UI actions, client scripts, fix scripts, etc.). Use it to discover existing code before writing new artifacts.

**Requires:** an active SN Utils **Pro / Trial / Enterprise** license in the connected browser helper tab. Without it the command returns `E_DISABLED`.

**Request:**
```json
{
  "id": "cs_1",
  "command": "code_search",
  "instance": "dev12345",
  "params": {
    "term": "sn_appclient dev mode",
    "activeOnly": false,
    "limit": 50
  }
}
```

**Parameters:**
- `term` (required): Search term. Supports the same `table:` / field filters as the code search page (e.g. `table:sys_script_include setPreference`). Minimum 2 characters.
- `activeOnly` (optional, default `false`): Only match active records.
- `limit` (optional, default `50`): Max records per table.
- `tables` (optional): Comma-separated table-name filter to narrow the search scope.

**Response:**
```json
{
  "status": "success",
  "result": {
    "term": "sn_appclient dev mode",
    "stats": { "tables": 3, "records": 7, "matches": 12, "searchedTables": ["sys_script_include", "sys_script", "sys_ui_action"] },
    "words": ["sn_appclient", "dev", "mode"],
    "results": [
      {
        "tableName": "sys_script_include",
        "tableLabel": "Script Include",
        "rowCount": 2,
        "hits": [
          {
            "sysId": "abc123...",
            "name": "AppClientUtils",
            "sysClassName": "sys_script_include",
            "active": true,
            "matches": [
              {
                "field": "script",
                "fieldLabel": "Script",
                "matchingWords": ["dev", "mode"],
                "context": "...if (current.dev_mode) { ... }...",
                "lineMatches": [
                  { "lineNumber": 42, "content": "  var devMode = gs.getProperty('sn_appclient.dev_mode');", "isMatch": true }
                ]
              }
            ],
            "missingWords": null,
            "parentRef": null
          }
        ]
      }
    ]
  }
}
```

**Response shape:**
- `result.stats` — `tables`, `records`, `matches` (total field matches), and `searchedTables` (the tables actually queried).
- `result.words` — the tokenized search terms the engine looked for.
- `result.results[]` — one entry per matching table: `tableName`, `tableLabel`, `rowCount`, `hits[]`.
- Each **hit**: `sysId`, `name`, `sysClassName` (real class of the record), `active` (`true`/`false`/`null`), `matches[]`, `missingWords` (terms not found in this record, or `null`), and `parentRef` (`{ table, sysId, label }` when the value lives on a parent record, e.g. a variable value — else `null`).
- Each **match**: `field`, `fieldLabel`, `matchingWords` (which terms hit this field), `context` (a short excerpt), and `lineMatches[]` for line-level rendering — `{ lineNumber, content, isMatch }` (each match line plus a little surrounding context; `isMatch` flags the line(s) that actually contain a term).

**Notes:**
- Matches are **excerpts** — `context` plus a handful of `lineMatches`, not full field bodies. To get the complete script of a specific hit, follow up with `get_record` (using the hit's `tableName` + `sysId`).
- The first search after the helper tab opens may take longer while the field index builds; later searches reuse the cached per-instance index.

**Errors:**
- `E_DISABLED` — no SN Utils Pro/Trial/Enterprise license in the connected browser.
- `E_INVALID_PARAMS` — missing/short `term`.
- `E_BROWSER_DISCONNECTED` — no helper tab connected.

### `rest_request` (guarded generic passthrough)

Make an arbitrary ServiceNow REST call through the connected browser session (reuses its authentication). The escape hatch for anything the typed commands don't cover.

**Gating:**
- `GET` — always allowed.
- `POST` / `PUT` / `PATCH` — require `sn-scriptsync.restRequest.enabled`.
- `DELETE` — requires `sn-scriptsync.deleteRecords.enabled`.

**Request:**
```json
{
  "id": "rest_1",
  "command": "rest_request",
  "params": {
    "endpoint": "/api/now/table/incident",
    "method": "GET",
    "queryParams": { "sysparm_limit": "1", "sysparm_query": "active=true" }
  }
}
```

**Parameters:**
- `endpoint` (required): Instance-relative path beginning with `/` (e.g. `/api/now/table/incident`).
- `method` (optional, default `GET`): one of `GET`, `POST`, `PUT`, `PATCH`, `DELETE`.
- `body` (optional): JSON body for write methods.
- `queryParams` (optional): Object of query-string parameters.

**Response:**
```json
{ "status": "success", "result": { "status": 200, "data": { "result": [ { "...": "..." } ] } } }
```

**Errors:**
- `E_DISABLED` — the method is gated off by settings.
- `E_INVALID_PARAMS` — missing/invalid endpoint or method.
- `E_NOT_FOUND` / `E_REFERENCE_INTEGRITY` / `E_ACL` — mapped from the HTTP response.

### `run_background_script` ⚠️ (guarded — runs server-side code)

Execute a server-side background script (`/sys.scripts.do`) on the instance and return its captured output. Runs as the connected browser user, in the global scope. **Disabled by default** — enable `sn-scriptsync.backgroundScripts.enabled`.

**Request:**
```json
{
  "id": "bg_1",
  "command": "run_background_script",
  "params": { "script": "gs.print('Active incidents: ' + new GlideAggregate('incident').getRowCount());" }
}
```

**Parameters:**
- `script` (required): The server-side script to run. Use `gs.print(...)` to emit output you want back.

**Response:**
```json
{ "status": "success", "result": { "executed": true, "output": "*** Script: Active incidents: 42" } }
```

**Errors:**
- `E_DISABLED` — `sn-scriptsync.backgroundScripts.enabled` is off, or the instance gate is set to Off in the helper tab.
- `E_REVIEW_PENDING` — the instance gate is set to Approve: the script is waiting in the helper tab Review Queue. Tell the user to approve it in the SN Utils ScriptSync helper tab in their browser, then collect the output with `get_review_result`.
- `E_USER_REJECTED` — the developer rejected the script in the Review Queue; don't retry without asking.
- `E_UNAUTHORIZED` — the instance answered "not authorized" (session lost, or the user can't run background scripts); the helper refreshes the session token and retries once before raising this.
- `E_INVALID_PARAMS` — missing `script`.

> The pragmatic escape hatch for bulk data fixes that the typed commands don't cover. Output is whatever `/sys.scripts.do` returns (the `gs.print` lines plus the server's evaluation log).

### `list_tables`
List available table folders in the instance.

**Request:**
```json
{ "id": "3", "command": "list_tables" }
```

**Response:**
```json
{
  "result": {
    "tables": ["sys_script_include", "sys_script", "sp_widget"]
  }
}
```

### `list_artifacts`
List artifacts in a specific table.

**Request:**
```json
{ "id": "4", "command": "list_artifacts", "params": { "table": "sys_script_include" } }
```

**Response:**
```json
{
  "result": {
    "artifacts": ["global/MyUtils.script.js", "global/HelperFunctions.script.js"]
  }
}
```

### `check_name_exists`
Check if an artifact name already exists (checks local `_map.json` files only, not ServiceNow).

**Request:**
```json
{ "id": "5", "command": "check_name_exists", "params": { "table": "sys_script_include", "name": "MyUtils" } }
```

**Response:**
```json
{
  "result": {
    "exists": true,
    "sysId": "abc123def456"
  }
}
```

### `get_file_structure`
Get the expected file naming convention.

**Request:**
```json
{ "id": "6", "command": "get_file_structure" }
```

**Response:**
```json
{
  "result": {
    "pattern": "{instance}/{scope}/{table}/{name}.{field}.{ext}",
    "example": "myinstance/global/sys_script_include/MyUtils.script.js",
    "fields": {
      "sys_script_include": ["script"],
      "sys_script": ["script"],
      "sp_widget": ["script", "css", "client_script", "link", "template"]
    }
  }
}
```

### `validate_path`
Validate a proposed file path before creating it.

**Request:**
```json
{ "id": "7", "command": "validate_path", "params": { "path": "myinstance/global/sys_script_include/NewUtil.script.js" } }
```

**Response:**
```json
{
  "result": {
    "valid": true,
    "parsed": {
      "instance": "myinstance",
      "scope": "global",
      "table": "sys_script_include",
      "file": "NewUtil.script.js"
    }
  }
}
```

---

### `open_in_browser`
Open an artifact in the browser. For widgets, opens the preview page; for other artifacts, opens the form view.

**Request (with sys_id):**
```json
{ 
  "id": "3", 
  "command": "open_in_browser", 
  "params": { 
    "table": "sp_widget",
    "sys_id": "abc123def456"
  } 
}
```

**Request (with name - looks up sys_id from _map.json):**
```json
{ 
  "id": "3", 
  "command": "open_in_browser", 
  "params": { 
    "table": "sp_widget",
    "name": "MyWidget",
    "scope": "global"
  } 
}
```

**Response:**
```json
{
  "result": {
    "opened": true,
    "url": "https://instance.service-now.com/$sp.do?id=sp-preview&sys_id=abc123def456",
    "table": "sp_widget",
    "sys_id": "abc123def456"
  }
}
```

**URL patterns by table:**
| Table | URL Pattern |
|-------|-------------|
| `sp_widget` | `/$sp.do?id=sp-preview&sys_id={sys_id}` (Widget Preview) |
| `sp_page` | `/sp?id={name}` (Portal Page) |
| Other tables | `/{table}.do?sys_id={sys_id}` (Standard Form) |

### `get_served_url`

Resolve the URL an artifact is actually *served* at — without opening a tab. UI pages render at `<instance>/<name>.do`, Service Portal pages at `/sp?id=...`, widgets in the preview harness — not at their record form. Handy before `navigate_and_screenshot` or for sharing a link.

**Handles the scoped prefix automatically.** A UI page named `todo_app` in scope `x_acme_app` is *stored* with the unprefixed name `todo_app`, but ServiceNow *serves* it at `/x_acme_app_todo_app.do`. This command reads the record's scope (`sys_scope.scope`) and prepends it (guarding against double-prefixing if the name already carries the scope), so you get `/x_acme_app_todo_app.do` — not the 404-prone `/todo_app.do`.

**Request:**
```json
{ "id": "url_1", "command": "get_served_url", "params": { "table": "sys_ui_page", "name": "my_page" } }
```

**Parameters:**
- `table` (required).
- `sys_id` — or `name` (+ optional `scope`) to resolve the sys_id from the local `_map.json`.

**Response:**
```json
{ "status": "success", "result": { "url": "https://dev.service-now.com/x_acme_app_my_page.do", "table": "sys_ui_page", "name": "my_page" } }
```

**Errors:**
- `E_INVALID_PARAMS` — neither `sys_id` nor `name` provided.

### `refresh_preview`
Refresh browser tabs showing the artifact preview. Useful after updating a widget to see changes immediately.

**Request:**
```json
{ 
  "id": "4", 
  "command": "refresh_preview", 
  "params": { 
    "table": "sp_widget",
    "sys_id": "abc123def456"
  } 
}
```

**Request (with name):**
```json
{ 
  "id": "4", 
  "command": "refresh_preview", 
  "params": { 
    "table": "sp_widget",
    "name": "MyWidget",
    "scope": "global"
  } 
}
```

**Response:**
```json
{
  "result": {
    "refreshed": true,
    "sys_id": "abc123def456",
    "testUrls": [
      "https://instance.service-now.com/$sp.do?id=sp-preview&sys_id=abc123def456*",
      "https://instance.service-now.com/sp?id=mywidget*"
    ],
    "message": "Refresh command sent for sp_widget"
  }
}
```

**Note:** This refreshes ALL browser tabs matching the widget's preview URLs, plus the active tab if it's on the same instance.

### `take_screenshot` ⚡ (Remote - Async)
Take a screenshot of a ServiceNow page. The browser picks the best capture path it actually has — no capability juggling needed on your side:

1. **activeTab** (tab already granted): captures directly, as always.
2. **Chrome debugger**: when the grant is missing and the connected build supports it (Debug edition + Pro + `sn-scriptsync.browserDebugger.enabled`), the browser captures via the debugger instead — no user action, just a brief flash of Chrome's debugger banner. The result carries `"capturedVia": "debugger"`.
3. **Ask the user**: only when neither path works does `E_SCREENSHOT_PERMISSION` surface — the user must click the SN Utils extension icon on the target tab, and a retry is built in (see below).

**Permission notes (regular build — most users):**
- **First screenshot**: user must click the SN Utils extension icon on the target tab to grant permission
- **Subsequent screenshots**: reuse the same tab without re-approval (when possible)

**Request:**
```json
{
  "id": "14",
  "command": "take_screenshot",
  "params": {
    "url": "https://instance.service-now.com/sp?id=my_widget"
  }
}
```

**Parameters:**
- `url` (required if no tabId): The full URL to capture
- `tabId` (optional): Specific browser tab ID to capture (alternative to url)
- `fileName` (optional): Custom filename (defaults to `screenshot_TIMESTAMP.png`)
- `exactUrl` (optional): When `true`, do not reuse the last-captured tab — target the given `tabId`/`url` strictly. Use when you must capture a precise page. (`navigate_and_screenshot` sets this automatically.)

**Response (success):**
```json
{
  "id": "14",
  "command": "take_screenshot",
  "status": "success",
  "timestamp": 1733779200000,
  "result": {
    "saved": true,
    "filePath": "/workspace/screenshots/screenshot_2024-12-09T14-00-00.png",
    "fileName": "screenshot_2024-12-09T14-00-00.png",
    "url": "https://instance.service-now.com/sp?id=my_widget",
    "tabTitle": "My Widget - ServiceNow",
    "capturedVia": "activeTab"
  }
}
```

`capturedVia` is `"activeTab"` or `"debugger"` — which path actually produced the image.

**Response (permission needed):**
```json
{
  "id": "14",
  "command": "take_screenshot",
  "status": "error",
  "code": "E_SCREENSHOT_PERMISSION",
  "error": "Screenshot requires permission. Click the SN Utils extension icon on the tab you want to capture, then retry."
}
```

The extension auto-retries once (~10s) after a permission error before surfacing `E_SCREENSHOT_PERMISSION`, giving the user time to click the extension icon — so a "slow" screenshot call usually means the grant flow is in progress, not a hang. The retry stays pinned to the tab selected by the first attempt so a ServiceNow redirect cannot open duplicate tabs.

**Use cases:**
- Capture widget preview for visual verification
- Document UI state during development
- Debug visual issues

**Behavior:**
1. Screenshots are saved to `{workspace}/screenshots/` folder
2. The browser extension must be connected
3. Tab reuse: Requests prefer an open tab on the same ServiceNow instance; retries stay pinned to the selected tab, and later screenshots reuse the last captured tab when possible
4. If no matching tab is found, a new tab will be opened

**Handling permission errors:**
If `E_SCREENSHOT_PERMISSION` surfaces, the debugger route was already tried or isn't available — inform the user they need to click the SN Utils extension icon, then retry the screenshot command. (If the error's details say `cdpFallbackAvailable: true`, the build could do debugger captures but the user hasn't enabled `sn-scriptsync.browserDebugger.enabled` — you can mention that as an alternative.)

### `navigate_and_screenshot`

Open/activate a URL, wait for it to finish loading, settle briefly, then screenshot **that exact tab** — collapsing the activate → sleep → screenshot dance into one call. The PNG is saved under `screenshots/`.

**Request:**
```json
{
  "id": "nss_1",
  "command": "navigate_and_screenshot",
  "params": { "url": "https://dev.service-now.com/incident.do?sys_id=-1", "settleMs": 1500 }
}
```

**Parameters:**
- `url` (required): URL to open/activate (opens a tab if none matches).
- `settleMs` (optional, default `1500`): Extra wait after load before capture.
- `fileName` (optional): Output filename under `screenshots/`.
- `reload` (optional): Force a reload of an already-open tab.

**Response:**
```json
{ "status": "success", "result": { "saved": true, "filePath": ".../screenshots/screenshot_....png", "tabId": 42, "url": "https://dev.service-now.com/incident.do?sys_id=-1", "tabTitle": "Incident | ServiceNow", "navigated": true } }
```

Verify `url`/`tabTitle` match the page you intended — cheaper than rendering the image.

**Errors:**
- `E_SCREENSHOT_PERMISSION` — the browser could not capture the tab. Navigation has already happened at that point, so the target page is on screen; the same capture routing and recovery as `take_screenshot` applies (debugger path when available, then a ~10s icon-click retry window).
- `E_INVALID_PARAMS` — missing `url`.

### `run_slash_command` ⚡ (Remote - Async)
Execute SN Utils slash commands on a ServiceNow tab. **Particularly useful for debugging forms with `/tn` (show technical names).**

**⚠️ IMPORTANT: Only use DOCUMENTED slash commands!**

**Documented commands include:**
- `/tn` - Toggle technical names on forms
- `/bg` - Open background scripts
- `/token` - Open helper tab for connection
- `/sn` - Search navigator
- `/xml` - Show XML of current record
- See SN Utils documentation for full list

**❌ Do NOT use non-existent commands** like `/click`, `/select`, etc.

**Request:**
```json
{
  "id": "14",
  "command": "run_slash_command",
  "params": {
    "command": "/tn",
    "url": "https://*.service-now.com/*",
    "autoRun": true
  }
}
```

**Parameters:**
- `command` (required): The slash command to run (e.g., `/tn`, `/bg`, `tn` - leading slash is optional)
- `url` (optional): URL pattern to find the tab (default: `https://*.service-now.com/*`)
- `tabId` (optional): Specific browser tab ID to target
- `autoRun` (optional): Auto-execute the command (default: `true`)

**Response (success):**
```json
{
  "id": "14",
  "command": "run_slash_command",
  "status": "success",
  "timestamp": 1733779200000,
  "result": {
    "executed": true,
    "slashCommand": "/tn",
    "tabId": 12345,
    "autoRun": true
  }
}
```

**Response (error):**
```json
{
  "id": "14",
  "command": "run_slash_command",
  "status": "error",
  "error": "No ServiceNow tab found matching: https://*.service-now.com/*"
}
```


**Why `/tn` matters:**
When debugging form issues, you need to know the actual field names (not just labels). The `/tn` command toggles the display of technical field names on any ServiceNow form.

**Before `/tn`:**
```
Short Description: [Server is down]
Priority: [1 - Critical]
Assignment Group: [Network Support]
```

**After `/tn`:**
```
short_description: [Server is down]
priority: [1 - Critical]
assignment_group: [Network Support]
```

**Recommended debugging workflow:**
```
1. User reports form issue: "The priority field won't save"

2. AI activates the form tab and runs /tn:
   { "command": "run_slash_command", "params": { 
     "command": "/tn",
     "url": "https://*.service-now.com/*incident*"
   }}
   
3. AI takes a screenshot to see the technical field names:
   { "command": "take_screenshot", "params": { 
     "url": "https://*.service-now.com/*incident*" 
   }}
   
4. Now AI knows the exact field name (e.g., "priority") 
   to investigate in Business Rules, Client Scripts, etc.
```

### `activate_tab` ⚡ (Remote - Async)
Find and activate a browser tab by URL pattern. Useful for navigating to specific ServiceNow pages or ensuring a tab is ready before taking screenshots.

**Request:**
```json
{
  "id": "14",
  "command": "activate_tab",
  "params": {
    "url": "https://*.service-now.com/nav_to.do*",
    "reload": true,
    "waitForLoad": true,
    "openIfNotFound": false
  }
}
```

**Parameters:**
- `url` (required): URL pattern to match (supports wildcards like `*`)
- `reload` (optional): Whether to reload the tab after activating (default: `false`)
- `waitForLoad` (optional): Wait for page load to complete before responding (default: `false`)
- `openIfNotFound` (optional): Open a new tab with the URL if no matching tab exists (default: `false`)

**Response (success):**
```json
{
  "id": "14",
  "command": "activate_tab",
  "status": "success",
  "timestamp": 1733779200000,
  "result": {
    "activated": true,
    "tabId": 12345,
    "url": "https://instance.service-now.com/nav_to.do?uri=incident.do?sys_id=abc123",
    "title": "Incident | ServiceNow",
    "opened": false,
    "reloaded": true
  }
}
```

**Response (tab not found):**
```json
{
  "id": "14",
  "command": "activate_tab",
  "status": "error",
  "error": "No tab found matching: https://*.service-now.com/nav_to.do*"
}
```

**Use cases:**
- Activate a ServiceNow tab before taking a screenshot
- Reload a page to see updated changes
- Navigate to a specific record form
- Ensure a widget preview tab is ready

**URL Pattern Examples:**
| Pattern | Matches |
|---------|---------|
| `https://*.service-now.com/*` | Any ServiceNow page |
| `https://myinstance.service-now.com/sp?id=my_widget*` | Specific widget page |
| `https://*.service-now.com/nav_to.do*` | Any classic UI page |
| `https://*.service-now.com/$sp.do?id=sp-preview*` | Widget preview pages |

**Workflow: Activate tab → Take screenshot:**
```
1. Activate tab with reload to ensure fresh content
   { "command": "activate_tab", "params": { 
     "url": "https://*.service-now.com/sp?id=my_widget*", 
     "reload": true, 
     "waitForLoad": true 
   }}
   
2. Take screenshot (tab is already active and ready)
   { "command": "take_screenshot", "params": { 
     "url": "https://instance.service-now.com/sp?id=my_widget" 
   }}
```

### `switch_context` ⚡ (Remote - Async)
Switch ServiceNow context: update set, application scope, or domain. This uses the ServiceNow UI Concourse Picker API to change the active context in the browser session.

**Request:**
```json
{
  "id": "15",
  "command": "switch_context",
  "params": {
    "switchType": "updateset",
    "value": "abc123def456789012345678901234",
    "reloadTab": true,
    "tabUrl": "https://*.service-now.com/*"
  }
}
```

**Parameters:**
- `switchType` (required): Type of context to switch. Must be one of:
  - `updateset` - Switch the current update set
  - `application` (or `app`) - Switch the application scope
  - `domain` - Switch the domain (for domain-separated instances)
- `value` (required): The sys_id of the target update set, application, or domain
- `reloadTab` (optional): Whether to reload a ServiceNow tab after switching (default: `true`)
- `tabUrl` (optional): URL pattern to find the tab to reload (default: `https://*.service-now.com/*`)

**Response (success):**
```json
{
  "id": "15",
  "command": "switch_context",
  "status": "success",
  "timestamp": 1733779200000,
  "result": {
    "success": true,
    "switchType": "updateset",
    "value": "abc123def456789012345678901234",
    "reloaded": true
  }
}
```

**Response (error):**
```json
{
  "id": "15",
  "command": "switch_context",
  "status": "error",
  "error": "Invalid switchType. Must be one of: updateset, application, domain"
}
```

**Use cases:**
- Switch to a specific update set before creating artifacts
- Change application scope to deploy code to the correct app
- Switch domain context in domain-separated instances

**Finding the sys_id:**

Before switching context, you may need to query for the sys_id:

```
1. Find update set sys_id:
   { "command": "query_records", "params": { 
     "table": "sys_update_set", 
     "query": "name=My Update Set^state=in progress", 
     "fields": "sys_id,name,state" 
   }}
   
2. Find application sys_id:
   { "command": "query_records", "params": { 
     "table": "sys_scope", 
     "query": "scope=x_myapp", 
     "fields": "sys_id,scope,name" 
   }}
   
3. Find domain sys_id:
   { "command": "query_records", "params": { 
     "table": "domain", 
     "query": "name=My Domain", 
     "fields": "sys_id,name" 
   }}
```

**Examples:**

Switch to a specific update set:
```json
{ 
  "id": "sw1", 
  "command": "switch_context", 
  "params": { 
    "switchType": "updateset", 
    "value": "abc123def456..." 
  } 
}
```

Switch application scope (e.g., before creating artifacts):
```json
{ 
  "id": "sw2", 
  "command": "switch_context", 
  "params": { 
    "switchType": "application", 
    "value": "xyz789ghi012..." 
  } 
}
```

Switch domain:
```json
{ 
  "id": "sw3", 
  "command": "switch_context", 
  "params": { 
    "switchType": "domain", 
    "value": "dom456jkl789..." 
  } 
}
```

**Workflow: Find update set → Switch → Create artifact:**
```
1. Query for update set
   { "command": "query_records", "params": { 
     "table": "sys_update_set", 
     "query": "nameLIKEMyFeature^state=in progress", 
     "fields": "sys_id,name" 
   }}
   
2. Switch to the update set (using sys_id from response)
   { "command": "switch_context", "params": { 
     "switchType": "updateset", 
     "value": "<sys_id from step 1>" 
   }}
   
3. Create artifact (now goes into correct update set)
   { "command": "create_artifact", "params": { 
     "table": "sys_script_include", 
     "scope": "global", 
     "fields": { "name": "MyNewUtils", "script": "..." } 
   }}
```

### `upload_attachment` ⚡ (Remote - Async)
Upload a file (image, document, etc.) as an attachment to any ServiceNow record.

**Request (using filePath - recommended):**
```json
{
  "id": "15",
  "command": "upload_attachment",
  "params": {
    "table": "incident",
    "sys_id": "abc123def456789012345678901234",
    "filePath": "screenshots/screenshot_2024-12-09.png"
  }
}
```

**Request (using imageData - base64):**
```json
{
  "id": "15",
  "command": "upload_attachment",
  "params": {
    "table": "incident",
    "sys_id": "abc123def456789012345678901234",
    "fileName": "screenshot_2024-12-09.png",
    "imageData": "iVBORw0KGgoAAAANSUhEUgAA...",
    "contentType": "image/png"
  }
}
```

**Parameters:**
- `table` (required): The ServiceNow table the record belongs to (e.g., `incident`, `sp_widget`, `kb_knowledge`)
- `sys_id` (required): The sys_id of the record to attach the file to
- `filePath` (optional): Path to the file to upload. Can be absolute or relative to instance folder. If provided, `fileName` and `contentType` are auto-detected from the file.
- `fileName` (required if no filePath): Name for the attachment file. Auto-detected from `filePath` if not provided.
- `imageData` (required if no filePath): Base64-encoded file content. Auto-read from `filePath` if not provided.
- `contentType` (optional): MIME type. Auto-detected from file extension if not provided (default: `image/png`)

**Response (success):**
```json
{
  "id": "15",
  "command": "upload_attachment",
  "status": "success",
  "timestamp": 1733779200000,
  "result": {
    "uploaded": true,
    "fileName": "screenshot_2024-12-09.png",
    "table": "incident",
    "recordSysId": "abc123def456789012345678901234",
    "attachment": {
      "sys_id": "xyz789...",
      "size_bytes": "45678",
      "content_type": "image/png"
    }
  }
}
```

**Response (error):**
```json
{
  "id": "15",
  "command": "upload_attachment",
  "status": "error",
  "error": "HTTP 403: Access denied"
}
```

**Use cases:**
- Attach screenshots to incidents or tasks
- Upload documentation images to knowledge articles
- Attach design assets to widgets or UI pages
- Add evidence/proof to change requests

**Combining with `take_screenshot`:**

A powerful workflow is to take a screenshot and then upload it as an attachment:

```
1. Take screenshot of a widget/page
   { "command": "take_screenshot", "params": { "url": "..." } }
   Response includes: "filePath": "/workspace/screenshots/screenshot_2024-12-09_143022.png"
   
2. Upload as attachment using the ABSOLUTE filePath from the response
   { "command": "upload_attachment", "params": { 
     "table": "incident", 
     "sys_id": "...", 
     "filePath": "/workspace/screenshots/screenshot_2024-12-09_143022.png"
   }}
```

**⚠️ IMPORTANT: File Path Resolution**

The `upload_attachment` command resolves relative paths from the **instance folder**, not the workspace root.

- Screenshots are saved to `{workspace}/screenshots/` (workspace root)
- Instance folder is `{workspace}/{instance}/` (e.g., `empakooi/`)

**Always use ABSOLUTE paths** for files outside the instance folder:

```json
// ❌ WRONG - relative path will look in instance folder
{ "filePath": "screenshots/screenshot.png" }
// Resolves to: /workspace/empakooi/screenshots/screenshot.png (NOT FOUND)

// ✅ CORRECT - use absolute path from take_screenshot response
{ "filePath": "/Users/me/workspace/screenshots/screenshot.png" }
// Finds the actual file
```

**Best practice:** Copy the `filePath` value directly from the `take_screenshot` response.

**Note:** Using `filePath` eliminates the need to manually read and base64-encode files. The extension handles this automatically.

**Supported content types (auto-detected from file extension):**
| Extension | contentType |
|-----------|-------------|
| `.png` | `image/png` |
| `.jpg`, `.jpeg` | `image/jpeg` |
| `.gif` | `image/gif` |
| `.webp` | `image/webp` |
| `.svg` | `image/svg+xml` |
| `.pdf` | `application/pdf` |
| `.txt` | `text/plain` |
| `.json` | `application/json` |
| `.xml` | `application/xml` |
| `.html` | `text/html` |
| `.css` | `text/css` |
| `.js` | `application/javascript` |
| `.zip` | `application/zip` |
| `.doc` | `application/msword` |
| `.docx` | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` |
| `.xls` | `application/vnd.ms-excel` |
| `.xlsx` | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` |
| Other | `application/octet-stream` |

---
