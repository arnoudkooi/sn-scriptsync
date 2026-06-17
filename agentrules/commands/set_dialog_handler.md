### `set_dialog_handler` ⚡ (Remote - Async · Pro)
Install a native-dialog handler on the connected tab through the Chrome debugger (CDP). While active, browser-native `confirm()` / `alert()` / `prompt()` and the dirty-form `beforeunload` ("Leave site?") prompt are answered automatically and **recorded** (message text included). Pair with `clear_dialog_handler` to remove it and read what was intercepted.

> Keeps the Chrome debugger attached (banner stays) until cleared. Requires SN Utils **Pro**.

This is the heavyweight alternative to the per-action `suppressDialogs` flag on `run_ui_action` / `click_element`: it persists across navigations and, unlike the in-page suppression, **captures the dialog message** via CDP. Prefer `suppressDialogs` for a single action; use this when you need a persistent handler and/or the dialog text.

**Request:**
```json
{ "id": "sdh_1", "command": "set_dialog_handler", "params": { "autoAccept": true } }
```

**Parameters:**
- `autoAccept` (optional, default `true`): `true` accepts/confirms dialogs; `false` dismisses/cancels them.
- `promptText` (optional): Text to return for `prompt()` dialogs when accepting.
- `url` (optional): URL pattern to find the tab (default `https://*.service-now.com/*`).
- `tabId` (optional): Target a specific browser tab.

**Response (success):**
```json
{ "status": "success", "result": { "handlerActive": true, "autoAccept": true, "tabId": 42 } }
```

**Error codes:** `E_PRO_REQUIRED`, `E_CDP_UNAVAILABLE`, `E_DEBUGGER_BUSY`, `E_NO_TAB`, `E_BROWSER_DISCONNECTED`, `E_TIMEOUT`.

**Warning:** With `autoAccept: true`, a destructive UI action that asks "Are you sure?" (e.g. `sysverb_delete`) will be confirmed — the record gets deleted. Clear the handler when done.
