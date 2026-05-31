### `set_field` ⚡ (Remote - Async)
Set a field value on the **active ServiceNow form** in the connected browser tab via `g_form.setValue`. Because this drives the live form, it fires client scripts, onChange handlers, and UI policies — unlike a REST `update_record`, which bypasses all client-side logic. Use it to reproduce/verify client behaviour, not for bulk data writes.

**Request:**
```json
{
  "id": "sf_1",
  "command": "set_field",
  "params": {
    "field": "short_description",
    "value": "Network down in building C"
  }
}
```

**Parameters:**
- `field` (required): Field (column) name, e.g. `short_description`, `assigned_to`.
- `value` (required): Value to set. For reference fields pass the sys_id; add `displayValue` to set the shown label too.
- `displayValue` (optional): Display value for reference/choice fields (`g_form.setValue(field, value, displayValue)`).
- `url` (optional): URL pattern to find the tab (default: `https://*.service-now.com/*`).
- `tabId` (optional): Specific browser tab ID to target.

**Response (success):**
```json
{
  "id": "sf_1",
  "command": "set_field",
  "status": "success",
  "timestamp": 1733779200000,
  "result": {
    "set": true,
    "field": "short_description",
    "value": "Network down in building C",
    "displayValue": "Network down in building C"
  }
}
```

**Response (error):**
```json
{
  "id": "sf_1",
  "command": "set_field",
  "status": "error",
  "code": "E_NO_FORM",
  "error": "No active form on this page"
}
```

**Error codes:** `E_INVALID_PARAMS` (missing field/value), `E_NO_FORM` (no `g_form` on the page), `E_NOT_FOUND` (field not on the form), `E_BROWSER_DISCONNECTED`, `E_TIMEOUT`.

**Tip:** Run `get_form_state` after `set_field` to confirm the value (and any dependent fields recalculated by client logic) before triggering a save.
