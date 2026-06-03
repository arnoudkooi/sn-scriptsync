---
name: snu-form-automation
description: Drive live ServiceNow forms via the g_form bridge (navigate, set_field, get_form_state, run_ui_action, click_element): insert vs update verbs, optimistic-write verification, auto-handled native dialogs, and auto-filling mandatory reference fields. Read this when automating or visually verifying a form/UI page/widget.
---

<!-- SN-SCRIPTSYNC:SKILL apiVersion=7 -->

# SN ScriptSync — Live Form Automation

How to control and verify live ServiceNow forms through the authenticated browser session.

## 🤖 Live Form Automation & Visual Verification

### 📸 Verify visually EARLY — don't loop blind
- When building or automating anything visual (UI Pages, forms, widgets), or when a call
  doesn't behave as expected, take a screenshot to confirm the real page state instead of
  iterating blindly through more API calls.
- A single screenshot often reveals the actual blocker that would otherwise cost many
  speculative attempts — a mandatory-field validation banner, a 404 "page not found", an
  unsaved-changes state, or simply the wrong browser tab.
- **Rule of thumb: if two consecutive attempts don't do what you expect, STOP and
  screenshot + read the page before a third attempt.**

### Save verbs: insert (new) vs update (existing)
Use the correct UI action for the record's state — the wrong one *silently* no-ops:

| Record state | `run_ui_action` verb | Form button |
|--------------|----------------------|-------------|
| **New** (`sys_id=-1`) | `sysverb_insert` | "Submit" |
| **Existing** | `sysverb_update` | "Update" / "Save" |

Calling `sysverb_update` on a *new* record returns `{ "triggered": true }` but inserts
nothing.

### Live-form commands are optimistic — always verify server-side
`set_field`, `run_ui_action`, and `click_element` report what was *sent / triggered /
clicked* in the browser, not what *committed*. `triggered: true` means the UI action fired,
NOT that the save succeeded — a mandatory field or client/UI-policy validation can still
block it. **Never report success on `triggered: true` alone.**

Confirm the write before reporting success:
- `query_records` by a distinguishing field (`number=…`, `short_descriptionLIKE…`) —
  **required after a new-record insert**, or
- `get_record` by sys_id, or
- a `take_screenshot` (URL/title flipping from `sys_id=-1` to a real number, plus a populated
  activity stream, is proof of an insert).

Two traps that look like success but aren't:
- **`get_form_state` returns a pre-allocated `sys_id` and `number` even on an UNSAVED new
  record** (ServiceNow assigns these client-side at form load). The form having a
  `sys_id`/`number` is NOT proof the record persisted.
- **`get_form_state.mandatory` reflects DICTIONARY-level mandatory only.** UI-policy-enforced
  mandatory fields (shown yellow on the form) are not flagged — screenshot before saving to
  catch them.

### Native dialogs are auto-handled (no hang)
Browser-native `confirm()` / `alert()` / `prompt()` and the dirty-form "Leave site?"
(`beforeunload`) prompt would otherwise freeze the tab and hang the bridge with no user to
click them. The live-form commands neutralize these automatically:
- `run_ui_action` / `click_element` — `confirm()` is **auto-accepted**, `alert()`/`prompt()`
  swallowed (`suppressDialogs: true` by default).
- `navigate` — the dirty-form guard is dropped so the page changes without stalling
  (`discardUnsaved: true` by default).

**Two consequences to be deliberate about:**
- `run_ui_action sysverb_delete` auto-confirms the "Are you sure?" prompt — **the record is
  deleted**. To prevent surprise deletes this verb is **gated**: it returns `E_DISABLED` unless
  `sn-scriptsync.deleteRecords.enabled` is on. Prefer `delete_record` (REST) for removals; it
  never raises a dialog.
- `navigate` away from a form with unsaved edits **discards those edits**. Save first with
  `run_ui_action` if you need to keep them, or pass `discardUnsaved: false`.

### Recommended new-record cycle
```
navigate  (table.do?sys_id=-1)
→ set_field        (all mandatory + content fields)
→ take_screenshot  (confirm filled; catch yellow UI-policy-mandatory fields)
→ run_ui_action    sysverb_insert
→ query_records    (verify the record actually exists)   ← REQUIRED
→ report result
```
For an existing record the flow is the same but with `sysverb_update` and a
`get_record` / `get_form_state` verification. Prefer `set_field` (fires client scripts / UI
policies) over a raw REST `update_record` when you need the form's client logic to run. If a
save didn't persist, screenshot to read the validation banner, fill the missing fields, and
retry once.

### Auto-fill mandatory REFERENCE fields (no hardcoded sys_ids)
1. `get_table_metadata(formTable)` → find columns with `type=reference` and their reference
   table (this resolves table inheritance for you).
2. For each mandatory reference column: `get_parent_options(referenceTable)` → take an
   `option.sys_id` (prefer `active=true`; mind reference qualifiers).
3. `set_field(column, sys_id)`.

- **Raw fallback:** `query_records('sys_dictionary', 'nameIN<table>,<parents>^element=<field>^referenceISNOTEMPTY')`
  → reference table, then `query_records(refTable, …, limit 1)`.
- **Inheritance gotcha:** fields defined on a parent table (e.g. `task`) won't appear under
  `name=<child>` — query across the whole table hierarchy.

## Commands

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

### `set_field` ⚡ (Remote - Async)
Set a field value on the **active ServiceNow form** in the connected browser tab via `g_form.setValue`. Because this drives the live form, it fires client scripts, onChange handlers, and UI policies — unlike a REST `update_record`, which bypasses all client-side logic. Use it to reproduce/verify client behaviour, not for bulk data writes.

**Request:**
```json
{
  "id": "sf_1",
  "command": "set_field",
  "params": {
    "field": "short_description",
    "value": "Network down in building C"
  }
}
```

**Parameters:**
- `field` (required): Field (column) name, e.g. `short_description`, `assigned_to`.
- `value` (required): Value to set. For reference fields pass the sys_id; add `displayValue` to set the shown label too.
- `displayValue` (optional): Display value for reference/choice fields (`g_form.setValue(field, value, displayValue)`).
- `url` (optional): URL pattern to find the tab (default: `https://*.service-now.com/*`).
- `tabId` (optional): Specific browser tab ID to target.

**Response (success):**
```json
{
  "id": "sf_1",
  "command": "set_field",
  "status": "success",
  "timestamp": 1733779200000,
  "result": {
    "set": true,
    "field": "short_description",
    "value": "Network down in building C",
    "displayValue": "Network down in building C"
  }
}
```

**Response (error):**
```json
{
  "id": "sf_1",
  "command": "set_field",
  "status": "error",
  "code": "E_NO_FORM",
  "error": "No active form on this page"
}
```

**Error codes:** `E_INVALID_PARAMS` (missing field/value), `E_NO_FORM` (no `g_form` on the page), `E_NOT_FOUND` (field not on the form), `E_BROWSER_DISCONNECTED`, `E_TIMEOUT`.

**Tip:** Run `get_form_state` after `set_field` to confirm the value (and any dependent fields recalculated by client logic) before triggering a save.

### `get_form_state` ⚡ (Remote - Async)
Read the **live form** in the connected browser tab: its table, sys_id, new-record flag, and current field values (including unsaved edits). Reads from `g_form`, so it reflects what the user/agent actually sees — not the saved database row. Pair it with `set_field` to verify writes and with `/tn` (`run_slash_command`) when you need technical field names.

**Request (all fields):**
```json
{
  "id": "gfs_1",
  "command": "get_form_state"
}
```

**Request (subset):**
```json
{
  "id": "gfs_2",
  "command": "get_form_state",
  "params": { "fields": ["state", "assigned_to", "short_description"] }
}
```

**Parameters:**
- `fields` (optional): Array of field names to read. Omit to read all fields on the form.
- `url` (optional): URL pattern to find the tab (default: `https://*.service-now.com/*`).
- `tabId` (optional): Specific browser tab ID to target.

**Response (success):**
```json
{
  "id": "gfs_2",
  "command": "get_form_state",
  "status": "success",
  "timestamp": 1733779200000,
  "result": {
    "table": "incident",
    "sys_id": "a1b2c3...",
    "isNewRecord": false,
    "fields": {
      "state": { "value": "2", "displayValue": "In Progress", "mandatory": false, "readOnly": false },
      "assigned_to": { "value": "62826bf0...", "displayValue": "Beth Anglin" },
      "short_description": { "value": "Network down", "displayValue": "Network down" }
    }
  }
}
```

**Response (error):**
```json
{
  "id": "gfs_1",
  "command": "get_form_state",
  "status": "error",
  "code": "E_NO_FORM",
  "error": "No active form on this page"
}
```

**Error codes:** `E_NO_FORM` (no `g_form` on the page), `E_BROWSER_DISCONNECTED`, `E_TIMEOUT`.

### `run_ui_action` ⚡ (Remote - Async)
Trigger a UI action on the **active ServiceNow form** in the connected browser tab. Runs the real client-side path (`g_form.save()` / `g_form.submit()`), so onSubmit client scripts and UI policies execute. A page reload usually follows, so the command resolves as soon as the action is dispatched (not when the reload finishes) — re-read with `get_form_state` afterward.

**Request:**
```json
{
  "id": "rua_1",
  "command": "run_ui_action",
  "params": { "uiAction": "save" }
}
```

**Parameters:**
- `uiAction` (optional, default `save`): One of:
  - `save` — `g_form.save()` (save and stay on the form)
  - `submit` — `g_form.submit()` (submit the default action)
  - a named UI action — `g_form.submit("<sysverb>")`, e.g. `sysverb_update`, `sysverb_insert`, `sysverb_delete`, or a custom action name

**⚠️ Pick the verb that matches the record state:** use `sysverb_insert` ("Submit") on a **new** record (`sys_id=-1`) and `sysverb_update` ("Update"/"Save") on an **existing** one. Calling `sysverb_update` on a new record returns `{ "triggered": true }` but inserts nothing.

**🔒 Destructive verbs are gated:** any delete verb (`sysverb_delete`, or a custom action whose name contains `delete`) is rejected with `E_DISABLED` unless `sn-scriptsync.deleteRecords.enabled` is on — the same guard that protects `delete_record`. Prefer `delete_record` for removals; it never raises a dialog.
- `suppressDialogs` (optional, default `true`): Auto-handle native browser dialogs the action may raise — `confirm()` is **auto-accepted**, `alert()`/`prompt()` are swallowed — so the tab doesn't freeze on a modal no user will answer. **⚠️ This means `sysverb_delete`'s "Are you sure?" confirmation is accepted automatically and the record is deleted.** Set `false` only if you want the native dialog to appear (rarely useful headless).
- `url` (optional): URL pattern to find the tab (default: `https://*.service-now.com/*`).
- `tabId` (optional): Specific browser tab ID to target.

**Response (success):**
```json
{
  "id": "rua_1",
  "command": "run_ui_action",
  "status": "success",
  "timestamp": 1733779200000,
  "result": { "triggered": true, "uiAction": "save" }
}
```

**Response (error):**
```json
{
  "id": "rua_1",
  "command": "run_ui_action",
  "status": "error",
  "code": "E_NO_FORM",
  "error": "No active form on this page"
}
```

**Error codes:** `E_NO_FORM` (no `g_form` on the page), `E_DISABLED` (a delete verb while `deleteRecords.enabled` is off), `E_BROWSER_DISCONNECTED`, `E_TIMEOUT`.

**Note:** `success` confirms the action was dispatched, not that the save succeeded server-side. If a mandatory field or an onSubmit script blocks the save, the form stays open — verify with a follow-up `get_form_state` or a `take_screenshot`.

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
