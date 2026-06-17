### `start_console_capture` ⚡ (Remote - Async · Pro)
Start capturing `console.*` output, log entries, and **uncaught exceptions** on the connected ServiceNow tab through the Chrome debugger (CDP). Pair with `stop_console_capture`.

> Shows Chrome's yellow debugger banner until stopped. Requires SN Utils **Pro**.

**Request:**
```json
{ "id": "scc_1", "command": "start_console_capture", "params": {} }
```

**Parameters:**
- `maxEntries` (optional, default 500): Max entries to retain (oldest dropped past the cap).
- `url` (optional): URL pattern to find the tab (default `https://*.service-now.com/*`).
- `tabId` (optional): Target a specific browser tab.

**Response (success):**
```json
{ "status": "success", "result": { "capturing": true, "tabId": 42 } }
```

**Error codes:** `E_PRO_REQUIRED`, `E_CDP_UNAVAILABLE`, `E_DEBUGGER_BUSY`, `E_NO_TAB`, `E_BROWSER_DISCONNECTED`, `E_TIMEOUT`.

**Tip:** Use this to catch client-script / UI-policy errors that only surface in the console while you reproduce a form interaction.
