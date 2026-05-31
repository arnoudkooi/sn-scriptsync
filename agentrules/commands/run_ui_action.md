### `run_ui_action` ⚡ (Remote - Async)
Trigger a UI action on the **active ServiceNow form** in the connected browser tab. Runs the real client-side path (`g_form.save()` / `g_form.submit()`), so onSubmit client scripts and UI policies execute. A page reload usually follows, so the command resolves as soon as the action is dispatched (not when the reload finishes) — re-read with `get_form_state` afterward.

**Request:**
```json
{
  "id": "rua_1",
  "command": "run_ui_action",
  "params": { "uiAction": "save" }
}
```

**Parameters:**
- `uiAction` (optional, default `save`): One of:
  - `save` — `g_form.save()` (save and stay on the form)
  - `submit` — `g_form.submit()` (submit the default action)
  - a named UI action — `g_form.submit("<sysverb>")`, e.g. `sysverb_update`, `sysverb_insert`, `sysverb_delete`, or a custom action name

**⚠️ Pick the verb that matches the record state:** use `sysverb_insert` ("Submit") on a **new** record (`sys_id=-1`) and `sysverb_update` ("Update"/"Save") on an **existing** one. Calling `sysverb_update` on a new record returns `{ "triggered": true }` but inserts nothing.

**🔒 Destructive verbs are gated:** any delete verb (`sysverb_delete`, or a custom action whose name contains `delete`) is rejected with `E_DISABLED` unless `sn-scriptsync.deleteRecords.enabled` is on — the same guard that protects `delete_record`. Prefer `delete_record` for removals; it never raises a dialog.
- `suppressDialogs` (optional, default `true`): Auto-handle native browser dialogs the action may raise — `confirm()` is **auto-accepted**, `alert()`/`prompt()` are swallowed — so the tab doesn't freeze on a modal no user will answer. **⚠️ This means `sysverb_delete`'s "Are you sure?" confirmation is accepted automatically and the record is deleted.** Set `false` only if you want the native dialog to appear (rarely useful headless).
- `url` (optional): URL pattern to find the tab (default: `https://*.service-now.com/*`).
- `tabId` (optional): Specific browser tab ID to target.

**Response (success):**
```json
{
  "id": "rua_1",
  "command": "run_ui_action",
  "status": "success",
  "timestamp": 1733779200000,
  "result": { "triggered": true, "uiAction": "save" }
}
```

**Response (error):**
```json
{
  "id": "rua_1",
  "command": "run_ui_action",
  "status": "error",
  "code": "E_NO_FORM",
  "error": "No active form on this page"
}
```

**Error codes:** `E_NO_FORM` (no `g_form` on the page), `E_DISABLED` (a delete verb while `deleteRecords.enabled` is off), `E_BROWSER_DISCONNECTED`, `E_TIMEOUT`.

**Note:** `success` confirms the action was dispatched, not that the save succeeded server-side. If a mandatory field or an onSubmit script blocks the save, the form stays open — verify with a follow-up `get_form_state` or a `take_screenshot`.
