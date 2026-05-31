### `navigate` ⚡ (Remote - Async)
Navigate a connected ServiceNow tab to a URL (opening a tab if none is found) and resolve once the page finishes loading. Use this to put a specific record/list in front of the live-form commands (`set_field`, `get_form_state`, `run_ui_action`). For a screenshot in the same step, prefer `navigate_and_screenshot`.

**Request:**
```json
{
  "id": "nav_1",
  "command": "navigate",
  "params": { "url": "https://dev12345.service-now.com/incident.do?sys_id=-1" }
}
```

**Parameters:**
- `url` (required): The http(s) URL to open. (`sys_id=-1` opens a new record form.)
- `tabId` (optional): Navigate this specific tab instead of finding one by pattern.
- `newTab` (optional, default `false`): Open the URL in a new tab instead of reusing an existing ServiceNow tab.
- `waitForLoad` (optional, default `true`): Resolve only after the tab reports load `complete` (capped at 30s).
- `discardUnsaved` (optional, default `true`): Drop a dirty-form "Leave site?" guard before navigating, so unsaved changes don't stall the navigation on a prompt. **⚠️ Any unsaved edits on the current form are discarded.** Set `false` to keep the guard (the navigation may then time out if the form is dirty); save first with `run_ui_action` if you need to keep the changes.

**Response (success):**
```json
{
  "id": "nav_1",
  "command": "navigate",
  "status": "success",
  "timestamp": 1733779200000,
  "result": {
    "navigated": true,
    "tabId": 12345,
    "url": "https://dev12345.service-now.com/incident.do?sys_id=-1",
    "title": "Incident | ServiceNow"
  }
}
```

**Response (error):**
```json
{
  "id": "nav_1",
  "command": "navigate",
  "status": "error",
  "code": "E_INVALID_PARAMS",
  "error": "Only http(s) URLs are allowed"
}
```

**Error codes:** `E_INVALID_PARAMS` (missing/invalid URL), `E_NO_TAB` (could not activate/open a tab), `E_BROWSER_DISCONNECTED`, `E_TIMEOUT`.
