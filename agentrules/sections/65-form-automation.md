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
