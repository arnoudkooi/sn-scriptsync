### `pull_scope`

Pull every scriptable artifact of one application scope into canonical local workspace files (`<instance>/<scope>/<table>/<name>.<field>.<ext>`, or `<table>/<name>/<field>.<ext>` for folder-record tables) with `_map.json` registration, so an agent can work from local files instead of fetching artifacts one by one. This is the Agent API counterpart of the VS Code **Load Scope** button.

The command first lists which artifact tables the application actually uses, then walks each table that sn-scriptsync knows how to write to disk, paging past the Table API limits. Tables without code fields (properties, roles, ACL rows without scripts, ...) are reported under `skippedTables` and not written.

**Request:**
```json
{
  "id": "pull_scope_1",
  "command": "pull_scope",
  "params": { "scope": "x_acme_app" }
}
```

**Parameters:**
- `scope` (required, string): Application scope name (`x_acme_app`) or the `sys_scope` sys_id. `global` is refused: pull global artifacts with `pull_records` and a query instead.
- `tables` (optional, string[]): Restrict the pull to these tables. Tables that hold no records in the scope are reported in `warnings`.
- `limit` (optional, integer): Maximum records per table, `1` to `10000` (default `2000`). A table that hits the limit is marked `truncated`.
- `includeRecords` (optional, boolean): Return the per-record file list inside each table entry (default `false`, keeps the response small for large applications).

**Response:**
```json
{
  "result": {
    "scope": { "name": "x_acme_app", "sys_id": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6" },
    "folder": "dev221527/x_acme_app",
    "tables": [
      { "table": "sys_script", "matchedRecords": 12, "pulledRecords": 12, "filesWritten": 12, "skippedEmpty": 0, "truncated": false },
      { "table": "sys_script_include", "matchedRecords": 140, "pulledRecords": 140, "filesWritten": 140, "skippedEmpty": 0, "truncated": false }
    ],
    "totals": { "tables": 2, "records": 152, "filesWritten": 152, "skippedEmpty": 0 },
    "skippedTables": [ { "table": "sys_properties", "records": 4, "reason": "no_scriptable_fields" } ],
    "warnings": [],
    "complete": true,
    "outcome": "complete"
  }
}
```

**`outcome`** says what the pull achieved. Check it, not only the HTTP status:
- `complete` — every table with script fields was pulled and verified.
- `partial` — files were written, but something was skipped (`reason: "dictionary_unavailable"`), could not be verified, or hit `limit`. `note` and `warnings` say which. Re-run, or pull the named tables with `pull_records`.
- `empty` — the scope has no records in tables with script fields, established from a complete record list. Nothing to do.
- Discovery failure is an **error**, not an outcome: `E_DISCOVERY_FAILED` (HTTP 422, CLI exit 1) when no table could be pulled because the instance dictionary could not be read, or because the list of the scope's records was incomplete, so emptiness could not be established. `details` holds the full report above, including every skipped table and warning. Pull single tables with `pull_records` meanwhile.

When the instance dictionary cannot be read for a table, known tables fall back to the field definitions bundled with sn-scriptsync and `snu`, with a warning; a table is only reported as `no_scriptable_fields` when its dictionary was read completely.

Existing local files for the same records are refreshed in place and keep their file names through `_map.json`; a remote field that is now empty clears the local file. Run it again at any time to re-sync the whole application.
