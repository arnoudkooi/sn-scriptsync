### `add_column`

Add a column to a table by creating a `sys_dictionary` entry (keyed by `table.element`). Use this instead of `create_artifact` for dictionary entries — it avoids the `_map.json` name collision where every column would share `name = <table>`.

**Request:**
```json
{
  "id": "col_1",
  "command": "add_column",
  "params": { "table": "x_acme_myapp_widget", "element": "priority", "type": "integer", "label": "Priority", "scope": "x_acme_myapp" }
}
```

**Parameters:**
- `table` (required): Table to add the column to.
- `element` (required): Column name (the `element`).
- `type` (optional, default `string`): Internal type, e.g. `string`, `integer`, `boolean`, `glide_date_time`, `reference`.
- `label` (optional): Column label (defaults to a title-cased `element`).
- `max_length` (optional): For string columns.
- `reference` (optional): Referenced table when `type` is `reference`.
- `scope` (optional): Scope name; when known (in `scopes.json`) the column is created with `sysparm_transaction_scope` set so it lands in the right app.

**Response:**
```json
{ "status": "success", "result": { "created": true, "table": "x_acme_myapp_widget", "element": "priority", "type": "integer", "label": "Priority", "sys_id": "..." } }
```

**Errors:**
- `E_DISABLED` — `sn-scriptsync.createArtifacts.enabled` is off.
- `E_INVALID_PARAMS` — missing table/element.
