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

**Errors:**
- `E_INVALID_PARAMS` - missing sys_id/table/fields, or `fields` object is empty
- `E_BROWSER_DISCONNECTED` - no helper tab available
- `E_INSTANCE_NOT_FOUND` - `_settings.json` missing
