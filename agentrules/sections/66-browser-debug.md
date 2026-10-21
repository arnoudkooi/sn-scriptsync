## 🐞 Browser Debugger (CDP) — network, console, full-page capture & dialogs

These commands drive the connected ServiceNow tab through the **Chrome DevTools
Protocol** (`chrome.debugger`) for things the normal content-script bridge
can't do. They are an **escalation**, not the default — reach for the g_form /
REST commands first; use these only when you specifically need network bodies,
console errors, a beyond-viewport screenshot, or captured dialog text.

### Requirements & caveats (read before using)
- **Off by default.** These commands return `E_DISABLED` until the user
  enables `sn-scriptsync.browserDebugger.enabled`. Don't ask repeatedly — if it's
  disabled, fall back (e.g. `take_screenshot`, the `suppressDialogs` flag) and
  mention the setting once.
- **Needs the Debug edition build + a qualifying license.** The debugger adapter ships only in the
  SN Utils **Debug edition** browser build
  (https://chromewebstore.google.com/detail/sn-utils-debug/imjkemgdgfakdbobaoagilnoanibajeb) —
  the regular build returns `E_CDP_UNAVAILABLE`. *Using* it is a Pro capability, so
  an active SN Utils **Pro, Trial, or Enterprise** license is also required
  (`E_PRO_REQUIRED` when the adapter is present but the license doesn't
  qualify). Tell the user which of the two is missing rather than just surfacing
  the code.
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
- **Screenshots route themselves:** just call `take_screenshot` (or
  `navigate_and_screenshot`) — the browser uses activeTab when the tab is
  granted, silently switches to the debugger when the grant is missing and
  the build + Pro + `browserDebugger.enabled` allow it (result carries
  `capturedVia: "debugger"`), and only asks the user to click the SN Utils
  icon as a last resort. Call `capture_full_page` explicitly only for
  whole-page or element-selector captures. `check_connection`'s
  `helper.debuggerAvailable` tells you up front whether the debugger features
  (full-page capture, network/console, dialogs) exist on this session — the
  Debug edition is the exception, not the rule. Don't use the debugger path at
  all if the user has asked you not to attach the debugger.
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

### Verify a change end to end (Pro / Trial)
Run this after any write that changes behaviour in the browser: a client script, UI policy,
UI action, widget, or a server script that a form or list triggers. Do not report the behaviour
as verified until it has been exercised against the synced code. If verification is blocked,
report the implementation and the remaining verification gap explicitly.

Console and network evidence need the Debug edition plus a Pro, Trial or Enterprise license.
Check `get_capabilities` and respect per-instance gates: for `E_PRO_REQUIRED`, offer
https://snutils.com/trial once; for `E_CDP_UNAVAILABLE`, explain that the Debug edition is
missing; for `E_DISABLED`, respect the opt-out without proposing a trial as the remedy.
Use the free screenshot, form-state (where supported), and `get_last_error` steps when CDP is
unavailable. State that console errors and request bodies were not checked. A failed or
unsupported check is not a pass.

Before starting captures, identify a test tab on the instance you changed. Pass its `tabId`
to both captures, navigation, form actions, stop commands, and screenshots. Navigate in that
same tab with `newTab: false` and `discardUnsaved: false`; do not silently discard a user's
unsaved work. If a clean test tab is needed, create it before starting captures and use its
returned `tabId`. A new load alone does not prove that a widget or browser cache has refreshed;
verify an observable effect of the changed code before declaring success.

```
sync_now                      (only for the intended pending writes; never bypass review)
get_sync_status               (wait until the changed files are no longer pending or syncing)
get_record                    (confirm the expected field reached this instance; sync_now's synced:true only means sent)
                              (for a NOW SDK app, use sdk_deploy and wait for its final install result instead)
get_capabilities              (cdp.available must be true for capture; otherwise use the free fallback)
start_console_capture         (tabId: the test tab; remember whether this succeeded)
start_network_capture         (same tabId; scoped urlFilter, e.g. "/api/now" or "xmlhttp.do"; includeBodies: true)
→ navigate                    (same tabId, newTab: false, discardUnsaved: false; wait for load)
→ set_field / run_ui_action / click_element   (same tabId; reproduce the affected behaviour)
get_form_state                (same tabId; values, mandatory flags, messages, where g_form exists)
stop_network_capture          (same tabId; inspect failed requests, status and available response bodies)
stop_console_capture          (same tabId; inspect exceptions and console errors)
capture_full_page             (same tabId; take_screenshot when CDP is unavailable)
run_background_script         (optional, if permitted: read-only assertion for server-side behaviour)
```

Rules for the loop:
- **Stop what you start, also when a step fails.** Stop each successfully started capture independently, even if the other start or stop failed. Do not stop a capture that you did not start. Report cleanup failures; use `debugger_detach` on the test tab only as recovery for your own session.
- **Verify on the instance you wrote to**, in the same scope. Check `get_instance_info` when more than one instance is connected. For a page or widget without `g_form`, use screenshots and an appropriate read-only query to verify the outcome; do not treat an unsupported `get_form_state` as a failure of the feature itself.
- **Verification never writes production data.** Run tests that save data or trigger side effects only on a confirmed non-production instance within the user's authorized scope. If a disposable test record is needed there, create it with `create_record`, record its exact `sys_id`, and delete only that test record with `delete_record` when finished. Report failed cleanup. On production, use only read-only checks and state which behavioural checks remain unverified. Background scripts in this loop read and log; they do not insert or update.
- **Report evidence, not confidence.** List what was exercised, pass or fail per expectation, console errors and failed requests with their status, and the screenshot path. Note capture filters, missing or truncated bodies, and skipped steps; do not imply the capture covered requests outside its filter. `get_last_error` is bridge error context, not a substitute for browser console capture.
- **A fix restarts the loop.** After editing in response to a finding, sync and run the whole loop again instead of re-checking only the failing step.
