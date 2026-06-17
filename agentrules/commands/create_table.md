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
