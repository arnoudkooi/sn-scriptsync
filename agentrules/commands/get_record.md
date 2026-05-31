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
