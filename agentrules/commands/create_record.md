### `create_record`

Insert a plain data row on any table: an incident, task, `sys_user`, `sys_user_group`, `cmdb_ci`, catalog request — anything whose display field is not `name`.

Use `create_artifact` instead for scriptable artifacts (Script Include, Business Rule, widget): it also tracks the new record in the local workspace and its `_map.json`.

**Gating:** `createArtifacts` (`sn-scriptsync.createArtifacts.enabled` in VS Code, `SNU_ALLOW_CREATE_ARTIFACTS` in the standalone `snu` host) — the same permission as the other `create_*` commands, **on by default**.

**Request:**
```json
{
  "id": "crec_1",
  "command": "create_record",
  "params": {
    "table": "incident",
    "fields": { "short_description": "Printer on 3rd floor is down", "urgency": "2" }
  }
}
```

**Parameters:**
- `table` (required): target table name.
- `fields` (required): field-value dictionary, at least one entry. Use raw values (a `sys_id` for reference fields, the choice *value* for choice fields), not display labels.

**Response:**
```json
{
  "status": "success",
  "result": {
    "created": true,
    "table": "incident",
    "sys_id": "b1c2...",
    "name": "INC0010001",
    "record": { "...": "..." }
  }
}
```

`record` is the inserted row as ServiceNow returned it, so the write is already verified — no follow-up `get_record` is needed unless you want fields the insert did not return. `name` is the best available display handle (`number`, then `name`, `sys_name`, `short_description`).

**Errors:**
- `E_INVALID_PARAMS` — missing/invalid `table`, or an empty `fields` payload.
- `E_DISABLED` — the `createArtifacts` gate is off.
- `E_ACL` — the session may not insert on that table.
- `E_REFERENCE_INTEGRITY` — a reference field points at a record that does not exist.

**Do not create records by driving the form UI** (`navigate` + `set_field` + `run_ui_action`). Those commands exist to exercise real form behaviour (client scripts, UI policies) and to show the user something on screen. As a way to write data they are slow, silently lossy, and leave half-filled forms behind when a step fails.
