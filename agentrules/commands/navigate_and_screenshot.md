### `navigate_and_screenshot`

Open/activate a URL, wait for it to finish loading, settle briefly, then screenshot **that exact tab** — collapsing the activate → sleep → screenshot dance into one call. The PNG is saved under `screenshots/`.

**Request:**
```json
{
  "id": "nss_1",
  "command": "navigate_and_screenshot",
  "params": { "url": "https://dev.service-now.com/incident.do?sys_id=-1", "settleMs": 1500 }
}
```

**Parameters:**
- `url` (required): URL to open/activate (opens a tab if none matches).
- `settleMs` (optional, default `1500`): Extra wait after load before capture.
- `fileName` (optional): Output filename under `screenshots/`.
- `reload` (optional): Force a reload of an already-open tab.

**Response:**
```json
{ "status": "success", "result": { "saved": true, "filePath": ".../screenshots/screenshot_....png", "tabId": 42, "url": "https://dev.service-now.com/incident.do?sys_id=-1", "tabTitle": "Incident | ServiceNow", "navigated": true } }
```

Verify `url`/`tabTitle` match the page you intended — cheaper than rendering the image.

**Errors:**
- `E_SCREENSHOT_PERMISSION` — the browser could not capture the tab. Navigation has already happened at that point, so the target page is on screen; the same capture routing and recovery as `take_screenshot` applies (debugger path when available, then a ~10s icon-click retry window).
- `E_INVALID_PARAMS` — missing `url`.
