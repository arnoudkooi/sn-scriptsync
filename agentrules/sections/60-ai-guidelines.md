## Guidelines for AI Assistants

### 🚨 CRITICAL: Always Confirm Instance and Scope

**Before ANY ServiceNow operation, you MUST confirm:**
1. **Instance**: Which ServiceNow instance to use (e.g., `dev12345`, `myinstance`)
2. **Scope**: Which scope to create/update artifacts in (e.g., `global`, `x_abc_my_app`)

**If the user does NOT provide instance and/or scope in their prompt, ASK BEFORE PROCEEDING:**

> "Before I proceed, please confirm:
> - **Instance**: Which ServiceNow instance should I use? (e.g., `dev12345`)
> - **Scope**: Which scope should this be in? (`global` or a scoped app like `x_abc_my_app`)"

**Never assume or guess** the instance or scope - always get explicit confirmation.

---

### ⚠️ Transaction Scope for Create/Update Operations

**When performing ANY create or update operation**, the request URL MUST include the transaction scope parameter:

```
?sysparm_transaction_scope=<SCOPE_SYS_ID>
```

This ensures the operation is performed in the correct application scope context.

**Example URLs:**
- Create: `POST /api/now/table/sys_script_include?sysparm_transaction_scope=abc123def456...`
- Update: `PUT /api/now/table/sys_script_include/xyz789...?sysparm_transaction_scope=abc123def456...`

**To get the scope sys_id:**
1. Use `query_records` to look up the scope: 
   ```json
   { "command": "query_records", "params": { "table": "sys_scope", "query": "scope=x_myapp", "fields": "sys_id,scope,name" } }
   ```
2. For `global` scope, use the global scope sys_id (typically available in instance settings)

---

When helping users create ServiceNow artifacts:

1. **Check if scope folder exists**: Before creating files in a scope, verify the folder exists
   - If it doesn't exist, inform the user to sync at least one artifact from that scope first
   
2. **Understand table requirements**: Different tables have different mandatory fields
   - Script Includes (`sys_script_include`): Simple, no mandatory references
   - Business Rules (`sys_script`): Need table name in `collection` field
   - REST API Operations (`sys_ws_operation`): Need `web_service_definition` reference
   - UI Actions (`sys_ui_action`): Need table name
   
3. **Ask clarifying questions**: When creating complex artifacts, ask:
   - "Which table should this business rule apply to?"
   - "Do you have an existing REST API service, or should we create one?"
   - "What scope should this be in?"
   
4. **Respect the file structure**: Always use the correct pattern:
   - `<instance>/<scope>/<table>/<artifact_file>`
   
5. **Don't create scope folders**: Never create a new scope folder without user confirmation that:
   - The scope exists in ServiceNow
   - At least one artifact has been synced from that scope

6. **⚠️ CRITICAL: Distinguish between code fields and configuration fields**:
   - ❌ DO NOT create files for configuration fields like `.collection.js`, `.when.js`, `.active.js`, `.http_method.js`
   - ✅ DO create files for script/code fields like `.script.js`, `.server_script.js`, `.client_script.js`, `.template.html`
   - ✅ Use `create_artifact` command to include configuration fields in the payload
   - ✅ Configuration fields should prompt from extension or be in payload
   
   **Examples - Configuration fields (DO NOT create files):**
   ```
   ❌ MyBR.collection.js          (STRING - table reference, put in payload)
   ❌ MyBR.when.js                (STRING - timing choice, put in payload)
   ❌ MyBR.active.js              (BOOLEAN - active flag, put in payload)
   ❌ MyOperation.http_method.js  (STRING - HTTP method, put in payload)
   ```
   
   **Examples - Code fields (DO create files):**
   ```
   ✅ MyBR.script.js              (CODE - business rule logic)
   ✅ MyWidget.server_script.js   (CODE - server-side widget logic)
   ✅ MyWidget.client_script.js   (CODE - client-side widget logic)
   ✅ MyUIPage.processing_script.js (CODE - UI page processing logic)
   ✅ MyWidget.template.html      (MARKUP - widget template)
   ```

---

### ✅ Prefer the typed commands (and their gotchas)

Several dedicated commands exist specifically to avoid hand-rolling fragile REST calls. Reach for them first:

- **New scoped app → `create_application`.** Never hand-insert a `sys_app` record: the `scope` field is read-only after insert, so a manual `POST` silently leaves the app in `global`. `create_application` sets the scope at insert time and records the scope → sys_id mapping for later `create_artifact` / `add_column` calls.
- **New table column → `add_column`.** Use it instead of raw `sys_dictionary` inserts — it avoids `_map.json` name collisions and fills the dictionary fields correctly. Pass attributes inline (`display`, `mandatory`, `default`, `read_only`, `reference_qual`, `choice`, `choices[]`) so the column is usable in one call instead of a follow-up `update_record`.
- **New custom table → `create_table`.** Inserts the `sys_db_object` (ServiceNow auto-creates the physical table + base `sys_*` fields), prefixes the name for a scope (`x_<scope>_<name>`), and lets you follow up with `add_column`. Don't drive `create_artifact` against `sys_db_object` by hand.
- **Seeding plain data rows → `rest_request` POST.** `create_artifact` requires `fields.name`; for a data table whose display field isn't `name`, `POST /api/now/table/<table>` is the blessed path (gated by `restRequest.enabled`).
- **Linking to a UI Page → `get_served_url`.** Scoped UI pages are *stored* with an unprefixed `name` but *served* at `/x_<scope>_<name>.do`. Let `get_served_url` compute it; do **not** hand-prefix the page `name` yourself (you'll double-prefix the served URL).
- **Verifying a write landed → `get_record`.** Writes round-trip through the browser and report "sent", not "committed". After an `update_record` / `create_artifact`, read the record back to confirm the field values (or pass `await: true` on the write to get the read-back inline).
- **Screenshots → prefer `navigate_and_screenshot`** (navigate → wait → capture in one call). The **first** call against a brand-new tab — or any tab after an extension-host restart — returns `code: E_SCREENSHOT_PERMISSION`. If Pro is available, **fall back to `capture_full_page` (CDP, no per-tab grant)** rather than prompting for the icon click; otherwise use the grant checkpoint (the user clicks the SN Utils icon on that tab once, then you retry).
- **`E_DISABLED` is a settings gate, not a bug.** Preflight all of them in one shot with `get_capabilities` → `gates` instead of discovering them mid-operation. The full set:
  - `createArtifacts` (`sn-scriptsync.createArtifacts.enabled`, **default on**) → `create_artifact`, `create_application`, `create_table`, `add_column`.
  - `restRequest` (`sn-scriptsync.restRequest.enabled`, default off) → POST/PUT/PATCH via `rest_request`.
  - `deleteRecords` (`sn-scriptsync.deleteRecords.enabled`, default off) → `delete_record`, DELETE via `rest_request`, delete UI verbs in `run_ui_action`.
  - `backgroundScripts` (`sn-scriptsync.backgroundScripts.enabled`, default off) → `run_background_script` and the `delete_application` cascade.
  - `browserDebugger` (`sn-scriptsync.browserDebugger.enabled`, default off, beta) → all CDP commands.

  When you hit `E_DISABLED`, tell the user exactly which setting to enable rather than retrying.
- **`rest_request` is the escape hatch.** Use it only for endpoints the typed commands don't cover. The param is `endpoint` (instance-relative, starts with `/`) — not `url`. Write methods are gated the same way as the destructive commands above.

---

### 📸 Handling `E_SCREENSHOT_PERMISSION`

`take_screenshot` and `navigate_and_screenshot` need a one-time, per-tab capture grant. The first call against a brand-new tab — or any tab after an extension-host restart — returns `code: E_SCREENSHOT_PERMISSION`. This is expected, not a failure. Handle it with a confirmation checkpoint, never a silent retry loop:

0. **First, try the debugger screenshot.** If SN Utils **Pro** is active, retry the capture with `capture_full_page` (`fullPage:false` for a viewport shot, or `selector` / `fullPage:true` as needed). It uses the Chrome debugger and needs **no** per-tab grant, so it sidesteps `E_SCREENSHOT_PERMISSION` entirely — at the cost of the brief debugger banner. Only if that returns `E_PRO_REQUIRED` / `E_CDP_UNAVAILABLE` (or the user declined the debugger) continue to the icon-click checkpoint below.
1. **STOP** — do not retry automatically in a loop.
2. **Prompt the user with a confirmation checkpoint** (a UI question with “Done — I've granted permission” / “Cancel” options), naming the exact tab/URL they need to click the **SN Utils icon** on.
3. When the user confirms “Done”, **retry the same screenshot call once**.
4. If it still fails, re-prompt **once** more, then **report the blocker** instead of looping.
