### `click_element` ⚡ (Remote - Async)
Click a DOM element by CSS selector in the ServiceNow content document of the connected tab. Best-effort and **light-DOM only** — it does not pierce shadow DOM (Polaris/Next Experience web components). For form fields and UI actions prefer `set_field` / `run_ui_action`; reach for `click_element` only when there is no `g_form` path (e.g. a classic UI button or link).

**Request:**
```json
{
  "id": "ce_1",
  "command": "click_element",
  "params": { "selector": "#sysverb_update" }
}
```

**Parameters:**
- `selector` (required): A CSS selector resolved against the content document (the `gsft_main` iframe in classic UI, otherwise the top document).
- `suppressDialogs` (optional, default `true`): Auto-handle native dialogs the click may raise (`confirm()` auto-accepted, `alert()`/`prompt()` swallowed) so the tab doesn't freeze on a modal. Set `false` to let a native dialog appear.
- `url` (optional): URL pattern to find the tab (default: `https://*.service-now.com/*`).
- `tabId` (optional): Specific browser tab ID to target.

**Response (success):**
```json
{
  "id": "ce_1",
  "command": "click_element",
  "status": "success",
  "timestamp": 1733779200000,
  "result": { "clicked": true, "selector": "#sysverb_update" }
}
```

**Response (error):**
```json
{
  "id": "ce_1",
  "command": "click_element",
  "status": "error",
  "code": "E_NOT_FOUND",
  "error": "Element not found: #sysverb_update"
}
```

**Error codes:** `E_INVALID_PARAMS` (missing/invalid selector), `E_NOT_FOUND` (no element matches), `E_BROWSER_DISCONNECTED`, `E_TIMEOUT`.
