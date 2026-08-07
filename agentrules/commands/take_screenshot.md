### `take_screenshot` ⚡ (Remote - Async)
Take a screenshot of a ServiceNow page. The browser picks the best capture path it actually has — no capability juggling needed on your side:

1. **activeTab** (tab already granted): captures directly, as always.
2. **Chrome debugger**: when the grant is missing and the connected build supports it (Debug edition + Pro + `sn-scriptsync.browserDebugger.enabled`), the browser captures via the debugger instead — no user action, just a brief flash of Chrome's debugger banner. The result carries `"capturedVia": "debugger"`.
3. **Ask the user**: only when neither path works does `E_SCREENSHOT_PERMISSION` surface — the user must click the SN Utils extension icon on the target tab, and a retry is built in (see below).

**Permission notes (regular build — most users):**
- **First screenshot**: user must click the SN Utils extension icon on the target tab to grant permission
- **Subsequent screenshots**: reuse the same tab without re-approval (when possible)

**Request:**
```json
{
  "id": "14",
  "command": "take_screenshot",
  "params": {
    "url": "https://instance.service-now.com/sp?id=my_widget"
  }
}
```

**Parameters:**
- `url` (required if no tabId): The full URL to capture
- `tabId` (optional): Specific browser tab ID to capture (alternative to url)
- `fileName` (optional): Custom filename (defaults to `screenshot_TIMESTAMP.png`)
- `exactUrl` (optional): When `true`, do not reuse the last-captured tab — target the given `tabId`/`url` strictly. Use when you must capture a precise page. (`navigate_and_screenshot` sets this automatically.)

**Response (success):**
```json
{
  "id": "14",
  "command": "take_screenshot",
  "status": "success",
  "timestamp": 1733779200000,
  "result": {
    "saved": true,
    "filePath": "/workspace/screenshots/screenshot_2024-12-09T14-00-00.png",
    "fileName": "screenshot_2024-12-09T14-00-00.png",
    "url": "https://instance.service-now.com/sp?id=my_widget",
    "tabTitle": "My Widget - ServiceNow",
    "capturedVia": "activeTab"
  }
}
```

`capturedVia` is `"activeTab"` or `"debugger"` — which path actually produced the image.

**Response (permission needed):**
```json
{
  "id": "14",
  "command": "take_screenshot",
  "status": "error",
  "code": "E_SCREENSHOT_PERMISSION",
  "error": "Screenshot requires permission. Click the SN Utils extension icon on the tab you want to capture, then retry."
}
```

The extension auto-retries once (~10s) after a permission error before surfacing `E_SCREENSHOT_PERMISSION`, giving the user time to click the extension icon — so a "slow" screenshot call usually means the grant flow is in progress, not a hang. The retry stays pinned to the tab selected by the first attempt so a ServiceNow redirect cannot open duplicate tabs.

**Use cases:**
- Capture widget preview for visual verification
- Document UI state during development
- Debug visual issues

**Behavior:**
1. Screenshots are saved to `{workspace}/screenshots/` folder
2. The browser extension must be connected
3. Tab reuse: Requests prefer an open tab on the same ServiceNow instance; retries stay pinned to the selected tab, and later screenshots reuse the last captured tab when possible
4. If no matching tab is found, a new tab will be opened

**Handling permission errors:**
If `E_SCREENSHOT_PERMISSION` surfaces, the debugger route was already tried or isn't available — inform the user they need to click the SN Utils extension icon, then retry the screenshot command. (If the error's details say `cdpFallbackAvailable: true`, the build could do debugger captures but the user hasn't enabled `sn-scriptsync.browserDebugger.enabled` — you can mention that as an alternative.)

