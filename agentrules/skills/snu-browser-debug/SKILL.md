---
name: snu-browser-debug
description: Drive the connected ServiceNow tab through the Chrome DevTools Protocol (Pro): capture network requests + response bodies, capture console output and uncaught exceptions, take full-page/element screenshots beyond the viewport, and auto-handle (and record) native confirm/alert/prompt/beforeunload dialogs. Read this when you need network bodies, console errors, a whole-page screenshot, or dialog text — capabilities the normal content-script bridge cannot provide. Note the unavoidable Chrome debugger banner and the Pro requirement.
---

<!-- SN-SCRIPTSYNC:SKILL apiVersion=13 -->

# SN ScriptSync — Browser Debugger (CDP)

Escalation layer that uses the Chrome debugger for what content scripts cannot do: network/console capture, full-page screenshots, and native dialog handling.

## 🐞 Browser Debugger (CDP) — network, console, full-page capture & dialogs

These commands drive the connected ServiceNow tab through the **Chrome DevTools
Protocol** (`chrome.debugger`) for things the normal content-script bridge
can't do. They are an **escalation**, not the default — reach for the g_form /
REST commands first; use these only when you specifically need network bodies,
console errors, a beyond-viewport screenshot, or captured dialog text.

### Requirements & caveats (read before using)
- **Off by default (beta).** These commands return `E_DISABLED` until the user
  enables `sn-scriptsync.browserDebugger.enabled`. Don't ask repeatedly — if it's
  disabled, fall back (e.g. `take_screenshot`, the `suppressDialogs` flag) and
  mention the setting once.
- **Pro only.** Even when enabled, non-Pro (or a build without the debugger
  adapter) returns `E_PRO_REQUIRED` / `E_CDP_UNAVAILABLE`.
- **Preflight with `get_capabilities`.** Rather than probing with a CDP command
  and parsing the error, call `get_capabilities` once: if `cdp.available` is
  `true` the debugger is usable; if `false`, `cdp.reason` tells you why
  (`E_DISABLED` / `E_CDP_UNAVAILABLE` / `E_PRO_REQUIRED`) so you can fall back
  gracefully.
- **The yellow banner is unavoidable.** The moment the debugger attaches, Chrome
  shows a persistent "SN Utils started debugging this browser" bar. Streaming
  captures keep it up until you stop; one-shot `capture_full_page` flashes it
  briefly. Always close what you open.
- **One debugger per tab.** If the user has DevTools open on that tab (common —
  these are developers), attach fails with `E_DEBUGGER_BUSY`. Ask them to close
  DevTools, or target another tab.

### Always pair start/stop
The capture commands hold the debugger session open. Pair them so the banner
drops and you actually read results:
- `start_network_capture` → drive the page → `stop_network_capture` (returns the log)
- `start_console_capture` → reproduce → `stop_console_capture` (returns entries)
- `set_dialog_handler` → act → `clear_dialog_handler` (returns intercepted dialogs)
- `debugger_detach` is the safety net if a session was left open.

### Picking the right tool
- **Screenshot:** `take_screenshot` is the lightweight viewport grab (no
  debugger, no banner) **but needs a per-tab capture grant** — the first call on
  a tab returns `E_SCREENSHOT_PERMISSION`. `capture_full_page` goes through the
  Chrome debugger (`Page.captureScreenshot`), which needs **no per-tab grant**
  (only the debugger attach + brief yellow banner) and also does whole-page /
  element-selector capture.
- **When `take_screenshot` returns `E_SCREENSHOT_PERMISSION` and Pro/CDP is
  available, prefer falling back to `capture_full_page`** (e.g. `fullPage:false`
  for a viewport-equivalent shot) instead of prompting the user to click the SN
  Utils icon. Only fall back to the icon-click checkpoint if the debugger is
  unavailable (`E_PRO_REQUIRED` / `E_CDP_UNAVAILABLE`) or the user has asked you
  not to attach the debugger.
- **Dialogs:** the per-action `suppressDialogs` flag on `run_ui_action` /
  `click_element` is lighter and needs no debugger — use it for a single action.
  Use `set_dialog_handler` only when you need a persistent handler across
  navigations or want the dialog's **message text**.
- **Network / console:** there is no non-debugger equivalent — this is the
  reason the capability exists.

### Typical "why did that request fail?" loop
```
start_network_capture  (urlFilter: "/api/now")
start_console_capture
→ run_ui_action / click_element / navigate   (reproduce the action)
stop_network_capture   (inspect status, response body)
stop_console_capture   (inspect client-side errors)
```

## Commands

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

### `stop_network_capture` ⚡ (Remote - Async · Pro)
Stop the capture started by `start_network_capture` and return the recorded requests. Detaches the Chrome debugger (dropping the banner) unless a console capture or dialog handler is still active on the tab.

**Request:**
```json
{ "id": "snc_2", "command": "stop_network_capture", "params": {} }
```

**Parameters:**
- `url` (optional): URL pattern to find the tab (default `https://*.service-now.com/*`).
- `tabId` (optional): Target a specific browser tab (use the one returned by `start_network_capture`).

**Response (success):**
```json
{
  "status": "success",
  "result": {
    "count": 2,
    "tabId": 42,
    "requests": [
      {
        "url": "https://acme.service-now.com/api/now/table/incident",
        "method": "GET",
        "type": "XHR",
        "status": 200,
        "mimeType": "application/json",
        "responseHeaders": { "...": "..." },
        "body": "{\"result\":[...]}",
        "bodyTruncated": false
      }
    ]
  }
}
```

Each entry may also include `requestHeaders`, `postData`, `encodedDataLength`, `remoteIP`, `fromCache`, and — on failures — `failed`, `errorText`. `body` is omitted when unavailable; `bodyBase64: true` marks binary bodies.

**Error codes:** `E_PRO_REQUIRED`, `E_CDP_UNAVAILABLE`, `E_NO_TAB`, `E_BROWSER_DISCONNECTED`, `E_TIMEOUT`.

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

### `clear_dialog_handler` ⚡ (Remote - Async · Pro)
Remove the native-dialog handler installed by `set_dialog_handler` and return the dialogs intercepted while it was active. Detaches the Chrome debugger unless a network/console capture is still running on the tab.

**Request:**
```json
{ "id": "cdh_1", "command": "clear_dialog_handler", "params": {} }
```

**Parameters:**
- `url` (optional): URL pattern to find the tab (default `https://*.service-now.com/*`).
- `tabId` (optional): Target a specific browser tab.

**Response (success):**
```json
{
  "status": "success",
  "result": {
    "count": 1,
    "tabId": 42,
    "dialogs": [
      { "type": "confirm", "message": "Are you sure you want to delete this record?", "url": "https://acme.service-now.com/incident.do?sys_id=..." }
    ]
  }
}
```

`type` is `confirm`, `alert`, `prompt`, or `beforeunload`.

**Error codes:** `E_PRO_REQUIRED`, `E_CDP_UNAVAILABLE`, `E_NO_TAB`, `E_BROWSER_DISCONNECTED`, `E_TIMEOUT`.

### `debugger_detach` ⚡ (Remote - Async · Pro)
Force-detach the Chrome debugger from the connected tab. Removes the yellow "SN Utils started debugging this browser" banner and ends any network/console capture or dialog handler still active. A safety net — `stop_*` / `clear_*` already detach when nothing else is running.

**Request:**
```json
{ "id": "dd_1", "command": "debugger_detach", "params": {} }
```

**Parameters:**
- `url` (optional): URL pattern to find the tab (default `https://*.service-now.com/*`).
- `tabId` (optional): Target a specific browser tab.

**Response (success):**
```json
{ "status": "success", "result": { "detached": true, "tabId": 42 } }
```

**Error codes:** `E_PRO_REQUIRED`, `E_CDP_UNAVAILABLE`, `E_NO_TAB`, `E_BROWSER_DISCONNECTED`, `E_TIMEOUT`.
