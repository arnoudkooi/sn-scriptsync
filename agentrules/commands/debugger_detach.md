### `debugger_detach` ⚡ (Remote - Async · Pro)
Force-detach the Chrome debugger from the connected tab. Removes the yellow "SN Utils started debugging this browser" banner and ends any network/console capture or dialog handler still active. A safety net — `stop_*` / `clear_*` already detach when nothing else is running.

**Request:**
```json
{ "id": "dd_1", "command": "debugger_detach", "params": {} }
```

**Parameters:**
- `url` (optional): URL pattern to find the tab (default `https://*.service-now.com/*`).
- `tabId` (optional): Target a specific browser tab.

**Response (success):**
```json
{ "status": "success", "result": { "detached": true, "tabId": 42 } }
```

**Error codes:** `E_PRO_REQUIRED`, `E_CDP_UNAVAILABLE`, `E_NO_TAB`, `E_BROWSER_DISCONNECTED`, `E_TIMEOUT`.
