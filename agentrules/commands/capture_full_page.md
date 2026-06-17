### `capture_full_page` ⚡ (Remote - Async · Pro)
Capture a **full-page** (entire scrollable page, beyond the viewport) or **single-element** screenshot through the Chrome debugger and save it under `screenshots/`. Unlike `take_screenshot` (viewport only, no debugger), this uses CDP to render the whole page or a specific element.

> Briefly attaches the Chrome debugger (banner flashes, then detaches). Requires SN Utils **Pro**.

**Request:**
```json
{ "id": "cfp_1", "command": "capture_full_page", "params": { "fullPage": true } }
```

**Parameters:**
- `fullPage` (optional, default `true`): Capture the whole scrollable page. Ignored when `selector` is set.
- `selector` (optional): CSS selector — capture just that element's bounding box instead of the page.
- `format` (optional, default `png`): `png` or `jpeg`.
- `quality` (optional, default 80): JPEG quality (1–100), only for `format: "jpeg"`.
- `fileName` (optional): Output filename; defaults to `fullpage_<timestamp>.png`.
- `url` (optional): URL pattern to find the tab (default `https://*.service-now.com/*`).
- `tabId` (optional): Target a specific browser tab.

**Response (success):**
```json
{
  "status": "success",
  "result": {
    "saved": true,
    "filePath": "/abs/workspace/screenshots/fullpage_2026-06-16T19-30-00.png",
    "fileName": "fullpage_2026-06-16T19-30-00.png",
    "format": "png",
    "clip": { "x": 0, "y": 0, "width": 1280, "height": 4200, "scale": 1 },
    "tabId": 42
  }
}
```

**Error codes:** `E_PRO_REQUIRED`, `E_CDP_UNAVAILABLE`, `E_DEBUGGER_BUSY`, `E_NO_ELEMENT` (selector matched nothing / not visible), `E_NO_TAB`, `E_BROWSER_DISCONNECTED`, `E_TIMEOUT`.

**Tip:** Reach for `take_screenshot` for a quick viewport check; use `capture_full_page` when you need the whole long form/list or a specific component in isolation.
