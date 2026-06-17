### `stop_console_capture` ⚡ (Remote - Async · Pro)
Stop the capture started by `start_console_capture` and return the collected entries. Detaches the Chrome debugger unless another capture/handler is still active on the tab.

**Request:**
```json
{ "id": "scc_2", "command": "stop_console_capture", "params": {} }
```

**Parameters:**
- `url` (optional): URL pattern to find the tab (default `https://*.service-now.com/*`).
- `tabId` (optional): Target a specific browser tab.

**Response (success):**
```json
{
  "status": "success",
  "result": {
    "count": 2,
    "tabId": 42,
    "entries": [
      { "kind": "console", "level": "error", "text": "TypeError: g_form is not defined", "timestamp": 173... },
      { "kind": "exception", "level": "error", "text": "Uncaught ReferenceError: x is not defined", "url": "https://acme.service-now.com/...", "lineNumber": 12 }
    ]
  }
}
```

`kind` is `console` (a `console.*` call), `log` (a `Log.entryAdded` browser log), or `exception` (an uncaught error).

**Error codes:** `E_PRO_REQUIRED`, `E_CDP_UNAVAILABLE`, `E_NO_TAB`, `E_BROWSER_DISCONNECTED`, `E_TIMEOUT`.
