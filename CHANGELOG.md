# CHANGELOG.md


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

