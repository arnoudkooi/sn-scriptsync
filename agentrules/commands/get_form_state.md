### `get_form_state` ⚡ (Remote - Async)
Read the **live form** in the connected browser tab: its table, sys_id, new-record flag, and current field values (including unsaved edits). Reads from `g_form`, so it reflects what the user/agent actually sees — not the saved database row. Pair it with `set_field` to verify writes and with `/tn` (`run_slash_command`) when you need technical field names.

**Request (all fields):**
```json
{
  "id": "gfs_1",
  "command": "get_form_state"
}
```

**Request (subset):**
```json
{
  "id": "gfs_2",
  "command": "get_form_state",
  "params": { "fields": ["state", "assigned_to", "short_description"] }
}
```

**Parameters:**
- `fields` (optional): Array of field names to read. Omit to read all fields on the form.
- `url` (optional): URL pattern to find the tab (default: `https://*.service-now.com/*`).
- `tabId` (optional): Specific browser tab ID to target.

**Response (success):**
```json
{
  "id": "gfs_2",
  "command": "get_form_state",
  "status": "success",
  "timestamp": 1733779200000,
  "result": {
    "table": "incident",
    "sys_id": "a1b2c3...",
    "isNewRecord": false,
    "fields": {
      "state": { "value": "2", "displayValue": "In Progress", "mandatory": false, "readOnly": false },
      "assigned_to": { "value": "62826bf0...", "displayValue": "Beth Anglin" },
      "short_description": { "value": "Network down", "displayValue": "Network down" }
    }
  }
}
```

**Response (error):**
```json
{
  "id": "gfs_1",
  "command": "get_form_state",
  "status": "error",
  "code": "E_NO_FORM",
  "error": "No active form on this page"
}
```

**Error codes:** `E_NO_FORM` (no `g_form` on the page), `E_BROWSER_DISCONNECTED`, `E_TIMEOUT`.
