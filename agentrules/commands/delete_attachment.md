### `delete_attachment` ⚠️ (DESTRUCTIVE — guarded)
Delete one attachment through the Attachment API, which removes the `sys_attachment` row and its stored content. Prefer it over `delete_record` on `sys_attachment`.

**Gating:** the `deleteRecords` permission, like `delete_record`, including the helper-tab Review Queue when the instance gate is Approve (`E_REVIEW_PENDING`, then `get_review_result`). In `snu`, pass `confirm: true` (or `--confirm`).

**Request:**
```json
{ "id": "dat_1", "command": "delete_attachment", "params": { "sys_id": "68cf699a97485f14c3e2fc90f053af5d" } }
```

**Parameters:**
- `sys_id` (required): the `sys_attachment` record.
- `dryRun` (optional): only read and return the attachment; not reviewed.

**Response:**
```json
{ "status": "success", "result": { "deleted": true, "sys_id": "68cf…", "fileName": "lineup.png", "table": "sc_cat_item", "tableSysId": "73da…", "sizeBytes": 1748088 } }
```

**Errors:** `E_NOT_FOUND` (nothing deleted), `E_DISABLED`, `E_REVIEW_PENDING`, `E_USER_REJECTED`.

---
