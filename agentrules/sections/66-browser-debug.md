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
- **Needs the Debug edition build + Pro.** The debugger adapter ships only in the
  SN Utils **Debug edition** browser build
  (https://chromewebstore.google.com/detail/sn-utils-debug/imjkemgdgfakdbobaoagilnoanibajeb) —
  the regular build returns `E_CDP_UNAVAILABLE`. *Using* it is a Pro capability, so
  an active SN Utils **Pro** subscription is also required (`E_PRO_REQUIRED` when the
  adapter is present but the license isn't Pro). Tell the user which of the two is
  missing rather than just surfacing the code.
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
