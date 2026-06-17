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
