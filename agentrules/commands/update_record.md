### `update_record`

Update a single field on an existing record. Fire-and-forget (the extension sends the update through the helper tab; success is reported back asynchronously).

**Requires:** browser helper tab connected.

**Request:**
```json
{
  "id": "upd_1",
  "command": "update_record",
  "instance": "dev12345",
  "params": {
    "table": "sys_script_include",
    "sys_id": "abc123def456...",
    "field": "script",
    "content": "gs.info('hello from the agent');"
  }
}
```

**Response (success):**
```json
{
  "id": "upd_1",
  "command": "update_record",
  "status": "success",
  "result": {
    "success": true,
    "message": "Update sent for sys_script_include/abc123def456...",
    "table": "sys_script_include",
    "sys_id": "abc123def456...",
    "field": "script"
  }
}
```

**Synchronous confirmation:** add `"await": true` to write via the Table API and read the value back. The response then includes `awaited: true`, the `persisted` value, and a `warnings[]` array flagging any field that came back empty (e.g. silently dropped by an ACL/read-only/business rule).

```json
{ "id": "upd_2", "command": "update_record", "params": { "table": "sys_script_include", "sys_id": "abc...", "field": "active", "content": "false", "await": true } }
```

**Errors:**
- `E_INVALID_PARAMS` - missing sys_id/table/field/content
- `E_BROWSER_DISCONNECTED` - no helper tab available
- `E_INSTANCE_NOT_FOUND` - `_settings.json` missing
