### `pull_records` (alias: `pull_artifacts`)

Pull records from ServiceNow and store their code fields into canonical local workspace files (`<instance>/<scope>/<table>/<name>.<field>.<ext>` or `<table>/<name>/<field>.<ext>` for folder-record tables) with automatic `_map.json` registration.

> **Key Advantage**: Agents call this command over HTTP (port 1977) and never compete for the WebSocket client; the existing SN Utils helper tab remains connected and is required to fulfill the request via the authenticated session.

**Request:**
```json
{
  "id": "pull_1",
  "command": "pull_records",
  "params": {
    "table": "sys_script_include",
    "query": "nameSTARTSWITHincident^active=true",
    "limit": 10,
    "openFiles": false
  }
}
```

**Parameters:**
- `table` (required, string): ServiceNow table name (e.g. `sys_script_include`, `sys_script`, `sp_widget`). Must be alphanumeric/underscores.
- `query` (optional, string): ServiceNow encoded query string.
- `sys_id` (optional, string): Single 32-character hex sys_id (or `'global'`). Combined with `query` using `^` (AND).
- `sys_ids` (optional, string[]): Array of 32-character hex sys_ids. Combined with `query` using `^` (AND).
- `fields` (optional, string[] | string): Custom code fields to pull. If omitted, fields and file extensions are automatically discovered from table metadata (e.g. `script` for `sys_script`, `template`/`client_script`/`css`/`script` for `sp_widget`).
- `limit` (optional, integer): Max records to pull (`1` to `500`, default: `50`). Values outside this range return `E_INVALID_PARAMS`.
- `openFiles` (optional, boolean): Whether to open each written file in active VS Code editor tabs (default: `false` to avoid tab spam).

**Response:**
```json
{
  "status": "success",
  "result": {
    "table": "sys_script_include",
    "matchedRecords": 2,
    "pulledRecords": 2,
    "filesWritten": 2,
    "skippedEmpty": 0,
    "warnings": [],
    "records": [
      {
        "sys_id": "9659b9900a0a0b340079eb7c8a410eb8",
        "name": "IncidentUtils",
        "scope": "global",
        "files": [
          {
            "field": "script",
            "path": "dev12345/global/sys_script_include/IncidentUtils.script.js",
            "bytes": 1420,
            "action": "updated"
          }
        ]
      }
    ]
  }
}
```

**Behavior & Rules:**
- **`_map.json` tracking**: Maintains `<instance>/<scope>/<table>/_map.json`. If a record was previously pulled, its existing mapped name is preserved. Name collisions receive a `"-XXXX"` sys_id suffix.
- **Folder record tables**: Tables in `FOLDERRECORDTABLES` (such as `sp_widget`, `sp_header_footer`, `sys_ui_page`) are stored in subfolders (`sp_widget/<name>/template.html`, `client_script.js`, `css.scss`, `script.js`).
- **Empty remote fields**: If a remote field has no content and a local file already exists, the local file is cleared (action: `cleared`) to prevent stale code. If no local file exists, it is skipped (action: `skipped_empty`).
- **Self-write protection**: Every written file is marked as a self-write to prevent the file watcher from triggering an unnecessary sync-back loop to ServiceNow.

**Errors:**
- `E_INVALID_PARAMS` — invalid table name, invalid sys_id format, or `limit` out of range `[1, 500]`.
- `E_BROWSER_DISCONNECTED` — the SN Utils helper tab is not connected.
- `E_PAUSED` — agent commands are paused in the SN Utils helper tab.
- `E_COMMAND_FAILED` — ServiceNow Table API query failed.
