### `update_records`

Update up to 200 existing records on one table in one call. Each row is `{ "sys_id": "...", ...fields }`. Same contract as `create_records`: one review for the batch, one write-history entry per record, an outcome per row, and **no rollback** of rows that succeeded. Use `update_record_batch` instead for several fields on one record.

**Requires:** browser helper tab connected, SN Utils 10.2.8.0 or later.

**Gating:** `updateRecords`, same as `update_record` (follows `createArtifacts` where nothing sets it).

**Request:**
```json
{
  "id": "urecs_1",
  "command": "update_records",
  "instance": "dev12345",
  "params": {
    "table": "incident",
    "continueOnError": true,
    "rows": [
      { "sys_id": "0123456789abcdef0123456789abcdef", "urgency": "2" },
      { "sys_id": "1123456789abcdef0123456789abcdef", "urgency": "2", "assignment_group": "..." }
    ]
  }
}
```

**Parameters:** `table`, `rows`, `continueOnError`, `dryRun` and `deadlineMinutes` as on `create_records`. Each row needs a `sys_id`, at least one field, and may appear only once per call. There is no `scope`: each record is written in its own application scope (a cross-scope refusal is retried once in the record's scope, as on `update_record`).

`sys_scope` in a row is refused with `E_INVALID_PARAMS` (read-only after insert). This is stricter than `update_record_batch`, which drops the field and warns.

**Response and errors:** identical in shape to `create_records` (`mode: "update"`), including per-row field `warnings` when a written field came back empty, different or unverifiable. Collect late or lost results with `get_batch_result`.
