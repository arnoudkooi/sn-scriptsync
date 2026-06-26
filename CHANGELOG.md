# CHANGELOG.md

## 4.7.3 (2026-06-26)

**Review Agent API writes before they hit the instance:** New setting `sn-scriptsync.agentApi.reviewWrites` (default **off**). When you turn it on, `update_record`, `update_record_batch` and `create_artifact` no longer push straight to ServiceNow — the proposed change is written to its real local file (`\instance\scope\table\name.field.ext`) and parked in the "Pending Saves" panel, exactly like a monitored file edit. Open it, see the diff, tweak it if you want, then approve it with the per-file ✓ (or push everything with **Sync Now**). Reject with ✕ (or "Clear All Pending") and ScriptSync undoes the staged write — it deletes a proposed new file and restores an overwritten one to its previous content, so a rejected agent change never lingers on disk or leaves the local file out of step with the instance. While review is on it holds *every* agent route, not just the API writes: a file an agent edits directly on disk is parked for approval too (instead of auto-syncing), and the agent's own `sync_now` is disabled so it can't flush the queue itself — only you approve, in VS Code. This closes the gap where AI agents (e.g. Windsurf/Devin) synced changes immediately with no chance to review. Off by default, so current setups are unchanged.

**New agent skill — AI Experience (AIX):** Added an on-demand `snu-aix-experience` skill so AI agents can build and edit ServiceNow AI Experience apps on the `sys_aix_*` tables end-to-end — experiences, pages, containers, custom Lit widgets with server data scripts, left-nav menus, and record click-through. It captures the field-tested recipe and the non-obvious framework behavior: the `/aiux/<suffix>` routing and config-cache rules, why records must be created via a background script (REST returns `E_ACL`), the widget compile-metadata pattern, and the OOTB-widget / app-shell dead ends. Read on demand like the other skills. Agent instructions bumped to v15.

**Find the Debug edition build for the browser debugger (beta):** The Welcome / What's New tab, the `sn-scriptsync.browserDebugger.enabled` setting, the `E_CDP_UNAVAILABLE` error, and the agent docs now link straight to the [SN Utils Debug edition browser build](https://chromewebstore.google.com/detail/sn-utils-debug/imjkemgdgfakdbobaoagilnoanibajeb) and spell out the two prerequisites: the debugger adapter ships only in that build (regular builds report `E_CDP_UNAVAILABLE`), and *using* it also needs an active SN Utils Pro subscription (`E_PRO_REQUIRED`). Agent instructions bumped to v17.

**Capabilities highlight in the browser sync log:** When the SN Utils helper tab connects, ScriptSync now adds a highlighted row to the sync log summarising the newer Agent API capabilities (build/edit artifacts, live-form control, code search, and the Pro browser-debugger beta) with a link to the Debug edition build, and the connect banner was refreshed from the old v4.3.0 copy to reflect them.

**Don't mistake a regular repo for the ScriptSync folder in multi-root workspaces:** Folder auto-detection now recognises a sync folder by an actual synced instance (a subfolder with `_settings.json`), not by the presence of `autocomplete/server.d.ts` — so a project that merely tracks that file is no longer picked over your real (empty/dedicated) sync folder.

## 4.6.2 (2026-06-23)

**Picks the right folder in a multi-root workspace:** ScriptSync no longer always syncs into the first workspace folder. It now targets the folder that's already a ScriptSync folder, matches your configured sync path, or is empty/dedicated — and when more than one folder qualifies it prompts you once to pick and remembers your choice (run `sn-scriptsync: Select Sync Folder (multi-root)` to change it). Single-folder and unambiguous workspaces are never prompted and behave as before.

**New Welcome / What's New tab:** On first install and after each update, sn-scriptsync opens a tab that summarizes what changed and surfaces the key agent-capability settings as inline toggles — instruction-file writes (`CLAUDE.md` / `AGENTS.md` / `.cursorrules`), the Agent API create / write / delete / run-scripts / browser-debugger gates, and the legacy file API — so you can review and control what AI agents are allowed to do. Reopen it anytime from the **Info** side panel ("Welcome / What's New") or the `sn-scriptsync: Show Welcome / What's New` command.

**Opt out of injecting instructions into your own files (#150):** New setting `sn-scriptsync.agentInstructions.autoUpdate` (default on). Turn it off and sn-scriptsync stops adding/refreshing its managed reference block inside *your* `CLAUDE.md` / `AGENTS.md` / `.cursorrules` / etc. `agentinstructions.md` and the `agentrules/skills` folder are still kept current either way, so you can reference them on demand (e.g. `@agentinstructions.md`). The header now documents how the docs/skills stay up to date.

**`get_capabilities` now reports a `gates` block:** Alongside `tier`/`proFeatures`/`cdp`, it returns which Agent API permissions are on (`createArtifacts`, `restRequest`, `deleteRecords`, `backgroundScripts`, `browserDebugger`, `fileFallback`) so an agent can preflight `E_DISABLED` from the API alone instead of discovering it mid-operation. Additive — older clients that ignore the new field are unaffected.

**New Agent API command — `create_table`:** Creates a custom table (`sys_db_object`); ServiceNow auto-creates the physical table and base `sys_*` fields. Prefixes the name to `x_<scope>_<name>` for a scoped app and supports `extends`, mirroring `create_application` / `add_column` ergonomics. Gated by the existing `sn-scriptsync.createArtifacts.enabled`.

**`add_column` can set column attributes in one call:** New optional params `display`, `mandatory`, `default`, `read_only`, `reference_qual`, `choice`, and `choices[]` (creates the `sys_choice` values too) — no follow-up `update_record` needed just to make a column the display field or mandatory.

**Docs:** Documented the table-creation recipe (`create_table` → `add_column` → seed rows with `rest_request`), recommended `curl -d @body.json` for large/multi-field payloads like widget code, blessed `rest_request` POST as the seeding path for data tables whose display field isn't `name`, and added the `activate_tab` → `capture_full_page(selector)` widget-preview verify recipe. Agent instructions bumped to v13.

**Fix: stopping the server from the status bar then starting it again now works.** Clicking sn-scriptsync to stop left the helper-tab connection open, which kept port 1978 bound and made the next start silently fail; the connection is now closed on stop (and a port-in-use error is surfaced instead of failing quietly).

**Browser debugger (CDP) is now opt-in (beta):** The Chrome DevTools Protocol commands (network/console capture, full-page screenshots, dialog handling) are off by default behind `sn-scriptsync.browserDebugger.enabled` and return `E_DISABLED` until you turn them on — so existing setups are never disrupted by an unexpected debugger attach.

**New Agent API command — `get_capabilities`:** Asks the connected SN Utils helper tab what it can do right now — license tier and whether the browser debugger is usable (`cdp.available`, with a `reason` of `E_DISABLED` / `E_PRO_REQUIRED` / `E_CDP_UNAVAILABLE` when not). Lets an agent preflight the `snu-browser-debug` skill instead of firing a CDP command and parsing the error. Agent API protocol bumped to v6.

## 4.5.0 (2026-06-05)

**New Agent API command — `code_search` (SN Utils Pro):**
- Runs the SN Utils GraphQL field-index code search across ServiceNow script tables and returns structured matches, so AI agents can discover existing code before writing new artifacts (far better than a `query_records` `LIKE`). Matches come back as excerpts (context + matching lines); follow up with `get_record` to pull a full script.
- Requires an active SN Utils **Pro / Trial / Enterprise** license in the connected browser helper tab — otherwise the command returns `E_DISABLED`. Round-trips through the helper tab over WebSocket like the other agent commands. Returns structured matches with line-level detail (`lineMatches`), `matchingWords`, per-search `words`/`stats`, and `parentRef`/`sysClassName` per hit. Agent API protocol bumped to v5; agent instructions bumped to v10 (full response shape documented + surfaced in the everyday cheat-sheet).

## 4.4.1 (2026-06-04)

**Fix: no longer overwrites your `CLAUDE.md` / `AGENTS.md` / `.cursorrules`.** Sorry — earlier builds (4.3.0–4.4.0) treated an existing one of these as the extension's own file and replaced it with the full instruction document. Now your file is never overwritten: sn-scriptsync only appends a small `@agentinstructions.md` reference inside `SN-SCRIPTSYNC` markers, so the bulk stays in `agentinstructions.md` and loads on demand. If your original was replaced and its `.bak` still exists it's restored automatically; otherwise recover it from version control or your editor's local history. Agent instructions bumped to v8.

## 4.4.0 (2026-06-03)

**Token-efficient agent instructions — slim core + on-demand skills (#148):**
- The monolithic `agentinstructions.md` (~3,700 lines) is now a **slim always-loaded core (~390 lines)**: overview, workflow, critical AI guidelines, an Agent API quickstart, an everyday-command cheat-sheet, a full command index, and a routing table.
- Deep detail moved into discoverable skills under `agentrules/skills/<name>/SKILL.md` (`snu-agent-api`, `snu-form-automation`, `snu-artifacts`, `snu-coding-standards`, `snu-reference`) that an agent opens only when a task needs them — so the full command catalog and form-automation docs aren't force-loaded into every prompt.
- The extension mirrors the skills into the workspace on start and **reconciles against a build manifest (`_skills.json`)**: renamed/removed skills are cleaned up automatically (marker-stamped files only — your own files are never touched), and the legacy `.bak` left by older instruction migrations is removed once the file is on the managed-block format. Agent instructions bumped to v7.

**Live form / page control (Agent API):**
- New browser commands that drive the live ServiceNow form through `g_form` (so client scripts, onChange handlers, and UI policies actually fire — unlike a REST write):
  - **`set_field`:** set a field value on the active form (`g_form.setValue`, with optional `displayValue` for references).
  - **`get_form_state`:** read the live form — table, sys_id, new-record flag, and field values (optionally a named subset), including unsaved edits.
  - **`run_ui_action`:** trigger `save`, `submit`, or a named UI action (`sysverb_*`) on the active form.
  - **`click_element`:** click a CSS selector in the content document (light DOM, best-effort).
  - **`navigate`:** point a connected ServiceNow tab at a URL (opening one if needed) and resolve once it finishes loading.
- All five round-trip through the SN Utils helper tab over WebSocket and return structured error codes (`E_NO_FORM`, `E_NOT_FOUND`, `E_INVALID_PARAMS`, `E_BROWSER_DISCONNECTED`, `E_TIMEOUT`). Agent instructions bumped to v6.
- **Native dialogs no longer freeze automation:** `run_ui_action` / `click_element` auto-handle `confirm()` (accepted), `alert()`/`prompt()` (swallowed), and `navigate` drops the dirty-form "Leave site?" guard — so a `sysverb_delete` confirmation or an unsaved-changes prompt can't hang the tab with no user to answer it. Opt out per call with `suppressDialogs:false` / `discardUnsaved:false`.
- **`run_ui_action` delete verbs are now gated:** because the confirm is auto-accepted, `sysverb_delete` (and any custom verb whose name contains `delete`) returns `E_DISABLED` unless `sn-scriptsync.deleteRecords.enabled` is on — the same guard as `delete_record`/`rest_request DELETE`. Prefer `delete_record`.

## 4.3.0 (2026-05-30)

**New HTTP Agent API (event-driven):**
- Added a local HTTP server bound to `127.0.0.1` on a random port. The extension publishes `{ port, token, pid, apiVersion, startedAt }` to `.vscode/sn-agent-port.json` so AI agents can discover the endpoint without configuration.
- All Agent API commands now accept `POST /api` with `X-Agent-Token` header and return JSON responses with structured error codes. `GET /api/health` is available for capability discovery without auth.
- The legacy file-based transport (`{instance}/agent/requests/*.json`) still works and can be toggled with the new setting `sn-scriptsync.agentApi.fileFallback` (default `true`). The HTTP path avoids the iCloud/OneDrive/file-watcher latency that made the file transport unreliable on macOS.

**New Agent API commands:**
- **`delete_record` (guarded):** delete by `table`+`sys_id`, or bulk-delete by query with `confirm:true`+`limit`; `dryRun:true` previews matches first. Off unless `sn-scriptsync.deleteRecords.enabled`. <!-- web: **Agent API can now delete records** — single by sys_id or bulk by query, gated behind a new opt-in setting and a confirm/limit/dry-run guard. -->
- **`get_record`:** fetch one record by `table`+`sys_id` (+ optional `fields`) — cheaper than `query_records` when you know the sys_id. <!-- web: same -->
- **`create_application` + `add_column`:** create a scoped app (`sys_app`, scope set at insert time) and add `sys_dictionary` columns keyed by `table.element` — no more `_map.json` name collisions. <!-- web: **New scoped-app helpers for AI agents** — create an application and add columns directly via the Agent API. -->
- **`await:true` write confirmation:** `update_record`, `update_record_batch`, and `create_artifact` can now read the value back and return `persisted` + a `warnings[]` list of fields that silently dropped (e.g. read-only `sys_scope`). <!-- web: **Agent writes can now be confirmed synchronously** — opt-in `await` re-reads the record and warns about fields that didn't stick. -->
- **`navigate_and_screenshot` + `get_served_url`:** open/await a URL then screenshot that exact tab in one call, and resolve an artifact's real served URL (UI page `.do`, portal page, widget preview). Screenshots now support strict-tab `exactUrl` targeting, return a structured `E_SCREENSHOT_PERMISSION` code, and auto-retry once after a permission prompt. <!-- web: **One-call navigate-and-screenshot** for AI agents, plus a helper that resolves an artifact's served URL and more reliable tab targeting. -->
- **`rest_request` (guarded passthrough):** generic ServiceNow REST call through the browser session — `GET` always; writes need `sn-scriptsync.restRequest.enabled`; `DELETE` needs `deleteRecords.enabled`. <!-- web: **Generic REST passthrough** for the Agent API, gated by new write/delete opt-in settings. -->
- **`run_background_script` + `delete_application` (guarded):** run a server-side background script and get its output back, and cascade-delete a scoped app (its scoped metadata + the `sys_app`). Both off unless `sn-scriptsync.backgroundScripts.enabled` (delete also needs `deleteRecords.enabled` + `confirm:true`). <!-- web: **Background-script escape hatch + scoped-app deletion** for the Agent API, behind new opt-in settings and a confirm guard. -->

**Structured errors:**
- Introduced `AgentErrorCode` (`E_ACL`, `E_TOKEN_EXPIRED`, `E_TIMEOUT`, `E_BROWSER_DISCONNECTED`, `E_DISABLED`, `E_INSTANCE_NOT_FOUND`, ...) with a mapping to HTTP status codes. Replaces ad-hoc `.includes("ACL")` / `.includes("Required to provide Auth information")` string sniffing in the WebSocket error path. Added `E_NOT_FOUND`, `E_CONFIRM_REQUIRED`, `E_REFERENCE_INTEGRITY`, `E_PARTIAL_FAILURE`, and `E_SCREENSHOT_PERMISSION` for the new commands.

**Modular architecture:**
- Split the monolithic Agent API out of `src/extension.ts` into `src/agent/`: a dispatcher, a `pendingRegistry` (promise-based, with per-request timeouts), an instance resolver, a runtime shim, and per-domain command handlers (`connection`, `records`, `query`, `files`, `browser`). Transports (`http`, `file`) sit on top.
- `extension.ts` now only wires host dependencies (WebSocket broadcast, queue state, logger) into the agent module.

**Versioned agent instructions:**
- `agentrules/agentinstructions.md` is now generated at build time from fragments in `agentrules/sections/*.md` and `agentrules/commands/*.md` via `scripts/build-agent-docs.ts`. The generated file is wrapped in a `<!-- SN-SCRIPTSYNC:BEGIN apiVersion=N -->` / `<!-- SN-SCRIPTSYNC:END -->` managed block.
- On start, the extension now refreshes **whichever instruction file you actually use** — `agentinstructions.md`, `.cursorrules`, `.windsurfrules`, `.clinerules`, `CLAUDE.md`, `AGENTS.md`, or `.github/copilot-instructions.md` — not just `agentinstructions.md`. Only files that already exist are touched (a fresh `agentinstructions.md` is created only when you have no instruction file at all, so no stray duplicate appears next to a renamed file).
- Added `ExtensionUtils.upsertManagedBlock()`: when the bundled docs are newer, only the content **inside** the managed block is replaced, so your own additions outside the markers are preserved. Legacy files without markers fall back to a version-gated whole-file replace that backs up the previous copy as `<file>.bak`.

**Banner:**
- On-connection banner now advertises the HTTP Agent API and points to `.vscode/sn-agent-port.json`.
- The status bar tooltip shows the live `127.0.0.1:<port>` Agent API endpoint while the server is running.

**Fixes:**
- Scheduled Jobs and other records whose form omits `sys_scope` no longer sync into the catch-all `no_scope` folder. When a save arrives without a usable scope, the extension now queries the instance for the record's real `sys_scope` and files it under the correct scope, falling back to `no_scope` only if the instance can't be reached. (`#143`)
- Corrected the ServiceNow Client Script table name in the agent instructions: `sys_client_script` -> `sys_script_client`. (`#141`)

**Dependencies:**
- Bumped `ws` from 8.19.0 to 8.21.0. Supersedes Dependabot's 8.20.1 (`#144`) and additionally picks up the 8.21.0 fix for a remote memory-exhaustion DoS (a peer flooding tiny fragments/chunks could OOM the WebSocket server/client). Exposure is limited here since the server binds to `127.0.0.1`, is origin-restricted, and caps at one client.

**Migration notes (read if you used the file-based Agent API):**
- Both transports run for now. HTTP is the recommended path; the file transport stays **on by default** (`sn-scriptsync.agentApi.fileFallback: true`) so existing agents keep working with zero changes.
- New recommendation — **import instead of rename.** Keep `agentinstructions.md` as the single source of truth and reference it from your tool: `@agentinstructions.md` in a Cursor rule (or `AGENTS.md`) and in `CLAUDE.md`. For tools without an import mechanism (GitHub Copilot, Windsurf) copy it once; sn-scriptsync keeps the managed block in those copies refreshed.
- Renamed-file gotcha: if you previously renamed `agentinstructions.md` (to `.cursorrules`, `CLAUDE.md`, etc.) on an older release, that file is now refreshed in place on next start so your agent learns the HTTP endpoint. A pre-managed-block copy is backed up as `<file>.bak` the first time — diff it if you had local tweaks.
- Discovery must be done every session: read `.vscode/sn-agent-port.json`, call `GET /api/health`, and only trust the endpoint when `health.pid` matches the file's `pid` (guards against stale port files synced by iCloud/OneDrive/git). Never cache the port/token.
- `.vscode/sn-agent-port.json` and `**/agent/` are now gitignored to avoid committing the per-session token and the file-transport queue.
- Deprecation timeline: the file transport is considered legacy and is planned to default **off** in a future major release (5.0). Move tooling to HTTP when you can; until then nothing breaks.

## 4.2.2 (2026-03-09)

**Branding:**
- Updated extension icon to new SN Utils logo (256, 128, SVG).
- Replaced `arnoudkooi.com` references with `snutils.com` / SN Utils B.V.

## 4.2.1 (2026-03-09)

**Security hardening:**
- Rewrote HTML sanitizer to escape-then-restore approach (eliminates XSS taint flow).
- Reconstructed fetch URLs from validated allowlist origins (eliminates SSRF taint flow).
- Updated TypeScript build target to ES2020 for compatibility with newer dev dependencies.

## 4.2.0 (2026-03-09)

**Bug fix:**
- Fixed duplicate record creation when using Agent API `create_artifact` command. File watcher was firing both `create` and `change` events for the same request file, causing the command to execute twice. Added request ID deduplication with a 5-second TTL window. (`#137`)

**Dependencies:**
- Bumped `immutable` from 5.1.3 to 5.1.5 (prototype pollution fix).
- Bumped `ws` from 8.18.3 to 8.19.0 (added `closeTimeout` option).
- Fixed broken README links (`#129`).

**Browser helper (scriptsync.js):**
- Updated helper tab script with latest Agent API handlers.


## 4.1.5 (2026-02-27)

**Sync hardening / safer defaults:**
- Changed `externalChanges.syncDelay` default from `30` to `0` (monitor-only by default).
- Clarified setting descriptions and README guidance for monitor-only vs auto-sync behavior.
- Tightened instance folder validation in watcher/save paths (valid `_settings.json` shape required, stricter root checks).
- Added create guardrails to block record creation when file/path/instance preconditions are not met.
- Added `createArtifacts.enabled` setting to globally block create-record operations when disabled.
- Hardened parser behavior to fail closed when file metadata parsing is ambiguous.

**Forensic audit logging:**
- Added structured NDJSON audit logging to workspace `audit.log` (when `sn-scriptsync.debugLogging` is enabled).
- Added correlation `runId` traces across watcher, queue decisions, dispatch, create checks, map resolution, and remote responses.
- Added data sanitization in audit payloads to avoid logging sensitive fields.

**Issue coverage:**
- Hardening addresses reported concerns around unexpected sync/create behavior and false-positive folder detection (`#132`, `#133`, `#134`).
- Follow-up fixes for queue consistency in monitor-only mode and create-precondition queue timing were included in the same release batch.


## 4.1.1 (2025-12-12)

**External change monitoring / auto-sync (AI agents / git / tools):**
- New `externalChanges.monitorFileChanges` toggle (default: on). Turn off to fully disable monitoring.
- New `externalChanges.syncDelay` auto-sync timer:
  - `= 0`: monitor-only (queue updates, manual Sync Now)
  - `> 0`: auto-sync after N seconds
- **Breaking**: settings renamed under `externalChanges.*` (old `syncDelay` / `monitorFileChanges` keys are no longer read)
- Fix: when the queue is paused, new external file changes no longer re-arm the auto-sync timer

**Pending Saves Queue:**
- Added a "Clear All Pending" header button (with confirmation)
- Clicking a pending file now opens/activates it in the editor

**Documentation:**
- Added "Get single record by sys_id" example to Agent API query_records documentation
- Added Service Portal widget client script patterns (Angular DI vs IIFE)

## 4.0.5 (2025-12-10)

**Packaging fixes:**
- Minor fixes for missing artefacts in the published package

## 4.0.0 (2025-12-10)

**Requirements**: Agent API features require **SN Utils 9.2.0.0 or higher**. 

### AI Agent & External Change Support (Issue #119)
This release adds comprehensive support for AI coding assistants and external file changes:

- **Automatic sync of external changes**: Files modified by AI agents (Cursor, GitHub Copilot, Windsurf, etc.), git operations, or external editors are now automatically synced to ServiceNow
- **New `syncDelay` setting**: Controls how often external changes are synced (default: 30 seconds)
  - Set to `0` to disable external change syncing
  - Changes are batched and deduplicated for efficiency
- **Pending Saves Queue**: New tree view showing files waiting to be synced
  - Pause/Resume queue functionality
  - "Sync Now" button for immediate sync
  - Remove individual files from queue
- **Multi-field batching**: When multiple fields of the same record change, they're combined into a single API call
- **New artifact creation**: AI agents can create new Script Includes and other artifacts by simply creating files in the correct folder structure

### File-based Agent API
AI agents can interact with scriptsync programmatically via folder-based event queue or legacy `_requests.json` files in the instance folder. The file-based approach was designed to be **simple and dependency-free** - no npm packages, no HTTP servers, just JSON files that any AI agent can read and write.

**Event-Driven Queue (Recommended):**
- New `agent/requests/` and `agent/responses/` folder structure
- Instant, event-driven processing (no polling on extension side)
- Parallel request support with unique file names (`req_<id>.json`, `res_<id>.json`)
- Adds `appName` property to all responses (e.g., "Cursor", "VS Code")

### Security Enhancements
Added comprehensive security validations for Agent API:

- **Request ID validation**: IDs must be alphanumeric with underscores/hyphens only (`^[a-zA-Z0-9_-]+$`)
- **Workspace boundary enforcement**: All file operations restricted to VS Code workspace
- **Path traversal protection**: File paths are normalized and validated to prevent directory escapes
- **Upload security**: `upload_attachment` command validates file paths are within workspace
- **Agent folder isolation**: `agent/` folders excluded from ServiceNow sync and git tracking
- Security violations return descriptive error responses

**Request format:**
```json
{
    "id": "unique-request-id",
    "command": "command_name",
    "params": { ... }
}
```

#### Agent Commands

| Command | Description | Parameters |
|---------|-------------|------------|
| `check_connection` | Check if scriptsync server is running and browser is connected | - |
| `get_sync_status` | Get current sync queue status (pending files, paused state) | - |
| `sync_now` | Immediately sync all pending files | - |
| `get_last_error` | Get the most recent sync error | - |
| `clear_last_error` | Clear the last error | - |
| `get_instance_info` | Get instance name and connection status | - |
| `list_tables` | List all table folders (scopes) in the instance | - |
| `list_artifacts` | List artifacts in a table folder | `table` |
| `check_name_exists` | Check if artifact name exists locally in `_map.json` | `table`, `name` |
| `get_file_structure` | Get expected file naming conventions | - |
| `validate_path` | Validate a proposed file path | `path` |
| `update_record` | Update a single field on a record | `sys_id`, `table`, `field`, `content` |
| `update_record_batch` | Update multiple fields on a record | `sys_id`, `table`, `fields` (object) |
| `open_in_browser` | Open an artifact in the browser | `sys_id` or (`name`, `table`, `scope`) |
| `refresh_preview` | Refresh widget preview in browser | `sys_id` or (`name`, `table`, `scope`) |
| `get_table_metadata` | Fetch table schema/fields from ServiceNow | `table` |
| `check_name_exists_remote` | Check if artifact exists in ServiceNow | `table`, `name` |
| `query_records` | Query records from any ServiceNow table | `table`, `query`, `fields`, `limit`, `orderBy` |
| `get_parent_options` | Get available parent records for references | `table`, `scope`, `nameField`, `limit` |
| `create_artifact` | Create a new record in ServiceNow | `table`, `scope`, `fields` (object with `name` required) |

**Example: Check connection**
```json
// Write to _requests.json
{ "id": "1", "command": "check_connection" }

// Response in _responses.json
{
    "id": "1",
    "command": "check_connection",
    "status": "success",
    "result": {
        "ready": true,
        "serverRunning": true,
        "browserConnected": true,
        "message": "Connected and ready"
    }
}
```

**Example: Query incidents**
```json
// Write to _requests.json
{
    "id": "2",
    "command": "query_records",
    "params": {
        "table": "incident",
        "query": "active=true^priority=1",
        "fields": "number,short_description,state",
        "limit": 5
    }
}
```

**Example: Create script include**
```json
// Write to _requests.json
{
    "id": "3",
    "command": "create_artifact",
    "params": {
        "table": "sys_script_include",
        "scope": "global",
        "fields": {
            "name": "MyNewUtils",
            "script": "var MyNewUtils = Class.create();\nMyNewUtils.prototype = {\n    initialize: function() {},\n    type: 'MyNewUtils'\n};",
            "api_name": "global.MyNewUtils",
            "active": true,
            "client_callable": false
        }
    }
}
```

### Context Menu Improvements (Issues #115, #116)
The right-click context menu has been significantly improved to reduce clutter:

- **New `showContextMenu` setting**: Hide/show sn-scriptsync commands in the context menu
  - Supports **language-specific overrides** - configure per file type (e.g., hide for markdown)
  - Can be set globally or per-workspace
- **Server-aware visibility**: Context menu only appears when scriptsync server is running
- **Smart filtering**: 
  - Commands hidden for internal files (`_map.json`, `_settings.json`, etc.)
  - "Load IntelliSense" command only shows for JavaScript files
  - Background script commands restricted to JavaScript files

Example settings.json configuration:
```json
{
    "sn-scriptsync.showContextMenu": true,
    "[markdown]": {
        "sn-scriptsync.showContextMenu": false
    },
    "[plaintext]": {
        "sn-scriptsync.showContextMenu": false
    }
}
```

### Other Improvements
- Files saved with "Save without formatting" (Ctrl+K, S) are now synced to the instance
- Manual saves always sync immediately, bypassing the debounce queue
- Improved duplicate detection for file changes


## 3.3.8 (2025-09-02)
Fixes / changes:
 - Update dependencies
 - Preparation for createArtifact command

## 3.3.6 (2025-02-08)
Fixes / changes:
 - Prevent scriptsync trigger when document is autosaved (Issue #105)

## 3.3.5 (2024-10-05)
Fixes / changes:
 - Fix for loading scope artefacts (Issue #101)

## 3.3.4 (2024-04-18)
Fixes / changes:
 - Improve error handling with SN Utils helper tab
 - Added CONTRIBUTING.md

## 3.3.3 (2024-04-18)
Fixes / changes:
 - Misspelling fix (PR #95)

## 3.3.2 (2024-04-15)
Fixes / changes:
 - Support for Inline PowerShell script from Flow Designer Actions (Discussion #492)

## 3.3.1 (2024-03-25)
Fixes / changes:
 - Improvements to the BG script execution.

## 3.3.0 (2024-03-23)
Features:
  - Improved BG Script execution, you can now select to run it in current or global scope.

## 3.2.1 (2024-03-09)
Features:
  - Execute Background Scripts in VS Code (SN Utils discussion #480, credit abhishekg999)

## 3.1.2 (2024-01-30)
Fixes / changes:
  - Backgroundscript matching. (#issue 91)
  - Fix not being able to save _test_urls.txt for Widgets.

## 3.1.0 (2023-10-21)
Fixes / changes:
  - Fix mixing up scope name and label in Link VS COde function in Studio

## 3.1.0 (2023-09-12)
Fixes / changes:
  - Fix for Miiror in sn-scriptsync

## 3.0.9 (2023-08-23)
Fixes / changes:
  - Allow filename change, that updates the _map.json file (Issue #85 PR #90 Blenderpics )
  - Moved initializing of treeview to startServers method, so that it loads more consistent.

## 3.0.8 (2023-08-22)
Fixes / changes:
  - Fix support for saving variables back to instance in the 3.x series

## 3.0.7 (2023-08-22)
Fixes / changes:
  - Fix to allow non scoped files again (will be stored in folder no_scope)

## 3.0.4 (2023-08-15)
Features:
  - Fixe to allow duplicate filename
  - Minor fixes for the 3.x update

## 3.0.0 (2023-08-15)
Features:
  - Check https://youtu.be/cpyasfe93kQ for intro to version 3.0
  - New way of storing files in the structure instamce/scope/table/name.fieldtype.extension
  - Option to pull in all artefacts from current scope
  - Behind the scenes magic to determine all code fields in current instance as well as mapping files to map names to sys_id
Fixes / changes:
  - Add /esc (Employee Center) to test_urls for widget development (Issue: #80)

## 2.7.3 (2023-06-15)
Fixes / changes:
  - Explicit bind websocket to 127.0,0.1 (SN Utils Issue #405)

## 2.7.2 (2023-04-08)
Fixes / changes:
  - Upgrade Node dependencies
  - Remove mkdirp package use in favor of fs.mdir recursive option
  - Remove /dist directory
  - Activated CodeQL repository scanning and applied fixes

## 2.7.0 (2023-04-07)
Features:
  - Save files when instances has a diffrent scope selected, requires SN Utils >= 6.4.0.0

## 2.6.1 and 2.6.2 (2023-02-13)
Fixes / changes:
  - bugfix new intellisense function
  
## 2.6.0 (2023-02-13)
Features:
  - generate types with tablenames and properties to support intellisense for those (Issue #77)
  - added CHANGELOG.md to maintain a changelog 
  - support to manual add content to the .ts file, in additoion to auto generated ones
  - added info.md with instructions how to generate .md file (only for maintenance of sn-scriptsync)

Fixes / changes:
  - updated d.ts files
  - added TemplatePrinter intellisense based on PR #75

