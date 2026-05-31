### `delete_application` ⚠️ (DESTRUCTIVE — cascade)

Delete a scoped application: its scoped metadata (records whose `sys_scope` is the app) **and** the `sys_app` record itself, via a guarded background script. Irreversible. Requires `confirm: true` and **both** `sn-scriptsync.deleteRecords.enabled` and `sn-scriptsync.backgroundScripts.enabled`.

**Request:**
```json
{
  "id": "delapp_1",
  "command": "delete_application",
  "params": { "scope": "x_acme_myapp", "confirm": true }
}
```

**Parameters:**
- `sys_id` — the `sys_app` sys_id (32-char hex), **or**
- `scope` — the scope name (e.g. `x_acme_myapp`).
- `confirm` (required): must be `true`.

**Response:**
```json
{ "status": "success", "result": { "deleted": true, "name": "My App", "scope": "x_acme_myapp", "childRecordsDeleted": 37 } }
```

**Errors:**
- `E_DISABLED` — delete and/or background-script settings are off.
- `E_CONFIRM_REQUIRED` — `confirm:true` not provided.
- `E_NOT_FOUND` — no application matched `sys_id`/`scope`.
- `E_INVALID_PARAMS` — neither `sys_id` nor `scope`, or malformed values.

> Best-effort cascade: it sweeps `sys_metadata` for the app's scope then deletes `sys_app`. Some artifact types may need a manual follow-up; verify in the instance afterwards.
