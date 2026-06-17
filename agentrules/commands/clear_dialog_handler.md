### `clear_dialog_handler` ⚡ (Remote - Async · Pro)
Remove the native-dialog handler installed by `set_dialog_handler` and return the dialogs intercepted while it was active. Detaches the Chrome debugger unless a network/console capture is still running on the tab.

**Request:**
```json
{ "id": "cdh_1", "command": "clear_dialog_handler", "params": {} }
```

**Parameters:**
- `url` (optional): URL pattern to find the tab (default `https://*.service-now.com/*`).
- `tabId` (optional): Target a specific browser tab.

**Response (success):**
```json
{
  "status": "success",
  "result": {
    "count": 1,
    "tabId": 42,
    "dialogs": [
      { "type": "confirm", "message": "Are you sure you want to delete this record?", "url": "https://acme.service-now.com/incident.do?sys_id=..." }
    ]
  }
}
```

`type` is `confirm`, `alert`, `prompt`, or `beforeunload`.

**Error codes:** `E_PRO_REQUIRED`, `E_CDP_UNAVAILABLE`, `E_NO_TAB`, `E_BROWSER_DISCONNECTED`, `E_TIMEOUT`.
