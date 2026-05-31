### `take_screenshot` ⚡ (Remote - Async)
Take a screenshot of a ServiceNow page. Requires explicit user action on first use.

**⚠️ IMPORTANT: Permission Required**
- **First screenshot**: User must click the SN Utils extension icon on the target tab to grant permission
- **Subsequent screenshots**: Will reuse the same tab without re-approval (when possible)
- If permission is denied, the response will include an error message guiding the user

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
    "tabTitle": "My Widget - ServiceNow"
  }
}
```

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

The extension auto-retries once (~1.5s) after a permission error before surfacing `E_SCREENSHOT_PERMISSION`, giving you a moment to click the extension icon.

**Use cases:**
- Capture widget preview for visual verification
- Document UI state during development
- Debug visual issues

**Behavior:**
1. Screenshots are saved to `{workspace}/screenshots/` folder
2. The browser extension must be connected
3. Tab reuse: After the first successful screenshot, subsequent requests will try to reuse the same tab (navigating to new URLs if needed) to avoid repeated permission prompts
4. If no matching tab is found, a new tab will be opened

**Handling permission errors:**
When receiving a permission error, inform the user they need to click the SN Utils extension icon, then retry the screenshot command.

