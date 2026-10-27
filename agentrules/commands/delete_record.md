### `delete_record` ⚠️ (DESTRUCTIVE — guarded)

Delete a record by `table` + `sys_id`, or bulk-delete by query. **Disabled by default.** Enable `sn-scriptsync.deleteRecords.enabled` in VS Code settings to allow it. Both hosts (VS Code and the standalone `snu` bridge) implement the single and the bulk form.

**Single delete:**
```json
{
  "id": "del_1",
  "command": "delete_record",
  "params": { "table": "incident", "sys_id": "abc123def456..." }
}
```

The display value (name/number/short_description) is read back first and echoed so you can confirm what was removed.

**Bulk delete (query-based):** requires `confirm: true` AND a positive integer `limit`.
```json
{
  "id": "del_2",
  "command": "delete_record",
  "params": { "table": "incident", "query": "active=false^sys_created_on<javascript:gs.daysAgo(365)", "limit": 50, "confirm": true }
}
```

**Preview without deleting:** add `"dryRun": true` to return the matches that *would* be deleted. A dry run only reads, so it is never held for review; the delete permission must still be granted.

**Parameters:**
- `table` (required).
- `sys_id` — single-record mode.
- `query` — bulk mode (encoded query). Mutually exclusive with `sys_id`.
- `confirm` (bulk, required): must be `true`.
- `limit` (bulk, required): positive integer cap on how many records are deleted.
- `dryRun` (optional): preview only, never deletes.

**Response (single):**
```json
{ "status": "success", "result": { "deleted": true, "table": "incident", "sys_id": "abc...", "display": "INC0010001" } }
```

**Response (bulk):** an outcome per record. `deleted` is `true` only when every match was removed; when some fail the command answers `E_PARTIAL_FAILURE` with the same `results` list in `details`.
```json
{ "status": "success", "result": { "deleted": true, "table": "incident", "count": 2, "deletedCount": 2,
  "results": [ { "sys_id": "abc...", "display": "INC0010001", "deleted": true }, { "sys_id": "def...", "display": "INC0010002", "deleted": true } ] } }
```

**Errors:**
- `E_DISABLED` — `sn-scriptsync.deleteRecords.enabled` is off.
- `E_CONFIRM_REQUIRED` — bulk delete without `confirm:true` + `limit`.
- `E_NOT_FOUND` — single sys_id does not exist.
- `E_REFERENCE_INTEGRITY` — blocked by a referencing record (HTTP 409).
- `E_PARTIAL_FAILURE` — some records in a bulk delete failed (see `details.results`).
