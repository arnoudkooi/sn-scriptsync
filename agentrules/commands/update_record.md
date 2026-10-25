### `update_record`

Update a single field on an existing record. Fire-and-forget (the extension sends the update through the helper tab; success is reported back asynchronously).

Use `field` plus `content`. A `fields` object belongs to `update_record_batch`; it is not accepted as a substitute for these parameters.

**Requires:** browser helper tab connected.

**Gating:** `updateRecords` (`sn-scriptsync.updateRecords.enabled` in VS Code, `SNU_ALLOW_UPDATE_RECORDS` in the standalone `snu` host, or the per-instance **Update Records** grant in the SN Utils helper tab) — **on by default**. Where nothing sets it, it follows `createArtifacts`: a host or instance that may not create records may not overwrite them either.

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

**Review mode:** when `sn-scriptsync.agentApi.reviewWrites` is on (default off), this write is **not** sent. It is parked in the VS Code "Pending Saves" queue and the response is `{ "staged": true, "reviewId": "...", "message": "..." }`. The user reviews it and approves it with **Sync Now** (or discards it); `await` is ignored while staged. Treat a `staged: true` response as "queued for human approval", not "applied".

**Standalone persistence verification:** the standalone host waits for the PATCH, then separately reads the field using raw stored values and compares it to `content`, even when `await` is omitted. A match returns `updated: true`, `awaited: true`, `verified: true`, `persisted: { "<field>": <saved value> }` and an empty `warnings` list. Empty content remains a deliberate clear; script whitespace is significant.

A mismatch, unreadable field or failed read returns `E_COMMAND_FAILED` with `details.writeAcknowledged: true`, `verified: false` and a `reason` (`value_mismatch`, `field_unreadable` or `read_failed`). A failed read also includes `causeCode`. The write may already have taken effect: inspect the record and any ACL/business rule before retrying. Journal fields such as `work_notes` must be checked through the new `sys_journal_field` entry, not by equality against the parent record field; never repeat a journal write just because that comparison failed.

**Do not verify twice:** a successful `verified: true` result with matching `persisted` content already completes persistence verification. No extra `get_record` is needed. Only on hosts or save results without that confirmation, call `get_record` and compare the content before reporting it saved. A PATCH success or increased `sys_mod_count` alone is insufficient. Collect any pending approval before checking for the resulting change.

**Errors:**
- `E_INVALID_PARAMS` - missing sys_id/table/field/content
- `E_DISABLED` - the `updateRecords` gate is off for this host or instance
- `E_BROWSER_DISCONNECTED` - no helper tab available
- `E_INSTANCE_NOT_FOUND` - `_settings.json` missing
- `E_COMMAND_FAILED` - standalone persistence verification failed; inspect `details` and read the saved state before deciding whether to retry
