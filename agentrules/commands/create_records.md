### `create_records`

Insert up to 200 records on one table in one call. Use it instead of looping `create_record`, and instead of `rest_request` batch calls or a GlideRecord loop in `run_background_script`: those reach the instance as one opaque write, while this one gets one review for the whole batch, one write-history entry per record, and an outcome for every row.

**Rows that succeed are not rolled back.** If row 7 fails, rows 0 to 6 stay written. Never resend the whole batch after a partial failure, or you create duplicates: retry only the rows whose outcome is not `succeeded`, and query the table first for rows marked `unknown`.

**Requires:** browser helper tab connected, SN Utils 10.2.8.0 or later (older helpers answer `E_UNSUPPORTED_HOST`).

**Gating:** `createArtifacts`, same as `create_record`. With an **approve** grant the user reviews the batch once in the helper tab (every row is on the card) and the call returns `E_REVIEW_PENDING`; with **auto** it runs at once.

**Request:**
```json
{
  "id": "crecs_1",
  "command": "create_records",
  "instance": "dev12345",
  "params": {
    "table": "sys_choice",
    "scope": "x_acme_app",
    "rows": [
      { "name": "incident", "element": "category", "label": "Network", "value": "network" },
      { "name": "incident", "element": "category", "label": "Storage", "value": "storage" }
    ]
  }
}
```

**Parameters:**
- `table` (required): one table per call.
- `rows` (required): array of field-value objects, at most 200 and at most 1 MB of JSON together. A row may carry `sys_id` to insert with that id; a row with only a `sys_id` inserts an empty record.
- `scope` (optional): the application the rows are written in (name, sys_id or `global`), exactly as on `create_record`: it becomes the transaction scope and is never written into the rows. A row's own `sys_scope` (a sys_id or `global`) is left as written, but every stated scope in one call must name the same application, or the call is refused.
- `continueOnError` (optional, default `false`): `false` stops at the first row that fails or gets no answer; `true` attempts every row. An expired session (401) always stops the batch.
- `dryRun` (optional): validate and normalize only, including that the table exists and the scope resolves. Nothing is written, nothing is staged, no review is raised. It does not predict business rules or ACLs.
- `deadlineMinutes` (optional, 1 to 30, default 10): how long the helper may run the batch. Rows not reached by then are `not_attempted`.

**Response (all rows written):**
```json
{
  "status": "success",
  "result": {
    "batchId": "bat_lzx1y2_a1b2c3d4",
    "table": "sys_choice",
    "mode": "create",
    "effectiveScope": "x_acme_app",
    "running": false,
    "counts": { "total": 2, "succeeded": 2, "failed": 0, "notAttempted": 0, "unknown": 0 },
    "rows": [
      { "index": 0, "outcome": "succeeded", "status": 201, "sys_id": "..." },
      { "index": 1, "outcome": "succeeded", "status": 201, "sys_id": "..." }
    ]
  }
}
```

**Field warnings:** every written row is checked against the record the instance answered with. A row whose fields did not stick keeps `outcome: "succeeded"` (it was written; do not create it again) and gets `warnings: [{ "field", "issue" }]`:

| issue | meaning |
|---|---|
| `empty` | a value was sent and the instance stored nothing (dropped by a business rule, field ACL or read-only field) |
| `different` | the instance stored another value, including a clear (`""`) that did not take |
| `unverified` | the answer does not show the field: no read access, an unknown field name, or a type the Table API does not echo (journal fields such as `work_notes`, passwords, encrypted fields) |

Booleans, numbers and list fields are compared by value (`"1"` and `"true"`, `0` and `"0"`, `b,a` and `a,b` match); a reference sent as a sys_id matches its stored sys_id. `counts.withWarnings` counts the rows with any warning. Read an `empty` or `different` field back with `get_record` and fix it deliberately; the cause is usually the creation path (the UI does something the Table API does not).

**Row outcomes:**

| outcome | meaning | retry |
|---|---|---|
| `succeeded` | the instance answered 2xx; `sys_id` included | do not retry |
| `failed` | the instance answered an error; `status` and `error` included | retry this row after fixing the cause |
| `not_attempted` | the batch stopped earlier, was rejected, or hit its deadline | safe to retry this row |
| `unknown` | the request was sent and no answer arrived | **not** safe to retry blindly: query the table first |

**Overall status:** all rows `succeeded` is `success`. Otherwise the call is an error whose `details` carry `batchId`, `counts` and every row:
- some rows succeeded: `E_PARTIAL_FAILURE`
- none succeeded and at least one is `unknown`: `E_TIMEOUT`
- none succeeded and at least one `failed`: `E_COMMAND_FAILED`
- nothing ran: the cause (`E_USER_REJECTED`, `E_DISABLED`, `E_INVALID_PARAMS`, `E_TOKEN_EXPIRED`, `E_UNSUPPORTED_HOST`)

**Long batches and lost answers:** every call gets a `batchId` before anything runs (also on `E_REVIEW_PENDING`, in `details`). Once a batch was sent, a lost answer (your wait expired, the helper tab disconnected, the bridge stopped) is always `E_TIMEOUT` with `details.batchId`, `details.cause` and `details.retrySafe: false`: some rows may be written. Do not send the batch again. Call `get_batch_result` with the `batchId` once the helper tab is connected, then retry only what it reports as `failed` or `not_attempted`. The helper keeps every row's outcome for 24 hours, never runs one `batchId` twice, and refuses to start a batch at all when it cannot record its progress (`E_COMMAND_FAILED`, nothing written, safe to retry).

**Review mode:** with `sn-scriptsync.agentApi.reviewWrites` on, the batch is staged first as one editable rows file in Pending Saves (`{ "staged": true, "batchId": ... }`). The user can edit or drop rows; Sync Now validates the edited rows again and only then raises the helper review (when the grant is approve) or runs them. The file stays in Pending Saves, with the user's edits, until the batch has run; after a run, rows that failed or were not attempted go back as a new batch.

**Errors:**
- `E_INVALID_PARAMS` - invalid or nonexistent table, rows, scope, a row without fields, or limits exceeded (the message names the row index)
- `E_DISABLED` - `createArtifacts` is off for this host or instance
- `E_UNSUPPORTED_HOST` - the helper tab predates multi-record writes
- `E_PARTIAL_FAILURE` / `E_COMMAND_FAILED` / `E_TIMEOUT` - see above (`E_TIMEOUT` with `retrySafe: false`: collect with `get_batch_result`, never resend)
