### `start_network_capture` ⚡ (Remote - Async · Pro)
Start recording network traffic on the connected ServiceNow tab through the Chrome debugger (CDP). Captures request method/URL/headers and, by default, **response bodies** — things content scripts can't see. Pair every call with `stop_network_capture`, which returns the log and detaches the debugger.

> Attaching the debugger shows Chrome's unavoidable yellow "SN Utils started debugging this browser" banner until you stop. Requires SN Utils **Pro** (and a build that ships the debugger adapter).

**Request:**
```json
{
  "id": "snc_1",
  "command": "start_network_capture",
  "params": { "urlFilter": "/api/now", "includeBodies": true }
}
```

**Parameters:**
- `urlFilter` (optional): Only record requests whose URL contains this substring (e.g. `/api/now`).
- `includeBodies` (optional, default `true`): Capture response bodies (capped per body; binary types like images/fonts/media are skipped).
- `includeTypes` (optional): Array of CDP resource types to keep (e.g. `["XHR","Fetch","Document"]`). Overrides the default skip-list.
- `maxEntries` (optional, default 250): Max requests to retain.
- `maxBodyBytes` (optional, default ~200000): Max decoded characters kept per body before truncation.
- `url` (optional): URL pattern to find the tab (default `https://*.service-now.com/*`).
- `tabId` (optional): Target a specific browser tab.

**Response (success):**
```json
{ "status": "success", "result": { "capturing": true, "urlFilter": "/api/now", "includeBodies": true, "tabId": 42 } }
```

**Error codes:** `E_PRO_REQUIRED`, `E_CDP_UNAVAILABLE` (build without the debugger adapter), `E_DEBUGGER_BUSY` (DevTools/another debugger attached to that tab), `E_NO_TAB`, `E_BROWSER_DISCONNECTED`, `E_TIMEOUT`.

**Tip:** Start the capture, then drive the page (`navigate` / `run_ui_action` / `click_element`), then `stop_network_capture` to read what fired.
