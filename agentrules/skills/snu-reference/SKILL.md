---
name: snu-reference
description: Extended reference appendix: detailed file-structure notes, table metadata caching, agent best-practices, and edge cases not covered by the core. Read this when you need depth the other skills do not cover.
---

<!-- SN-SCRIPTSYNC:SKILL apiVersion=7 -->

# SN ScriptSync — Deep Reference

Appendix and deep-dive reference material.

## File Structure

ServiceNow files follow this pattern:
```
{workspace}/
  {instance}/                    # e.g., "myinstance"
    _settings.json               # Instance configuration
    _requests.log                # Log of completed requests
    agent/                       # Event-driven Agent API
      requests/                  # Place request files here
        req_abc123.json          # Individual request (you create)
      responses/                 # Responses appear here
        res_abc123.json          # Matching response (extension creates)
    {scope}/                     # e.g., "global", "x_myapp"
      {table}/                   # e.g., "sys_script_include"
        _map.json                # Maps sys_id to file names
        structure.json           # Table metadata (cached from ServiceNow)
        {name}.{field}.{ext}     # e.g., "MyUtils.script.js"
```

### _structure.json(Table Metadata Cache)

The `structure.json` file contains cached table metadata from ServiceNow:
- **Created automatically** when `get_table_metadata` is called
- **Used for validation** when creating new artifacts
- **Contains field definitions**: mandatory fields, types, defaults, references

**AI agents should:**
1. **Check if `structure.json` exists first** - read it instead of calling API
2. **If not exists**, call `get_table_metadata` (which will create it)
3. **Use it to understand** mandatory fields and reference requirements

**Example structure.json:**
```json
{
  "columns": {
    "name": { "label": "Name", "type": "string", "mandatory": true, "max_length": 100 },
    "script": { "label": "Script", "type": "script_plain", "mandatory": false },
    "active": { "label": "Active", "type": "boolean", "default": "true" },
    "sys_scope": { "label": "Application", "type": "reference", "reference": "sys_scope" }
  }
}
```

## Best Practices for AI Agents

### 🚫 DO NOT Use Cursor's Internal Browser Tools

**Never use the built-in Cursor browser tools** (`mcp_cursor-ide-browser_*`) for ServiceNow interactions:
- ❌ `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, etc.
- These tools open a separate browser session that is NOT authenticated with ServiceNow
- The SN Utils connection runs through the user's authenticated browser session

**Instead, use the Agent API commands:**
- ✅ `open_in_browser` / `navigate` - Open/navigate pages in the authenticated browser
- ✅ `take_screenshot` / `navigate_and_screenshot` - Captures via the SN Utils extension
- ✅ `activate_tab` - Switches/reloads tabs in the authenticated browser
- ✅ `refresh_preview` - Refreshes widget previews
- ✅ `set_field` / `get_form_state` / `run_ui_action` / `click_element` - Drive the live form via `g_form` in the authenticated session

### 🚫 Only Use Documented Slash Commands

**Only use slash commands documented in SN Utils:**
- ✅ `/tn` - Toggle technical names on forms
- ✅ `/bg` - Open background scripts
- ✅ `/token` - Open helper tab for connection
- ❌ `/click` - NOT a real command (does not exist)
- ❌ Any other undocumented commands

**If unsure about a slash command, don't use it.** Stick to the documented ones.

### 🚀 IMPORTANT: Always Check Connection First

**Before ANY ServiceNow operations, call `check_connection` to verify readiness:**

```json
{ "id": "init", "command": "check_connection" }
```

**If NOT ready**, inform the user:
- Server not running → "Please click sn-scriptsync in VS Code status bar to start"
- No browser → "Please open the SN Utils helper tab by typing /token in ServiceNow"

### ⚠️ IMPORTANT: Always Call `sync_now` When Finished

**After making file changes, ALWAYS call `sync_now` before reporting completion to the user:**

```json
{ "id": "final", "command": "sync_now" }
```

This ensures all pending file updates are synced to ServiceNow immediately, rather than waiting for the debounce timer.

### 📸 Screenshot Permission Required

**First-time screenshots require user action:**

When taking the first screenshot in a session, the user must click the SN Utils extension icon on the target browser tab to grant permission.

**AI Agent workflow:**
1. Call `take_screenshot` command
2. If response contains permission error, inform the user:
   > "Please click the SN Utils extension icon on the ServiceNow tab to grant screenshot permission, then I'll retry."
3. Wait for user confirmation
4. Retry the screenshot command

**Subsequent screenshots** will reuse the same tab and won't require re-approval.

### 🚫 Avoid Opening Duplicate Tabs

**Before opening a new tab, check if a similar tab is already open:**

Use `activate_tab` with `reload: true` instead of `open_in_browser` when you want to refresh an existing tab:

```json
// ❌ DON'T open multiple tabs to the same URL
{ "command": "open_in_browser", "params": { "table": "rm_story", "sys_id": "abc123" } }
// (calling again opens ANOTHER tab)

// ✅ DO use activate_tab to refresh existing tab
{ "command": "activate_tab", "params": { 
  "url": "https://*.service-now.com/rm_story.do*sys_id=abc123*", 
  "reload": true,
  "waitForLoad": true 
}}
```

**Guidelines:**
- Use `open_in_browser` only when you need to open a NEW record/page
- Use `activate_tab` when you want to refresh or switch to an existing tab
- Use `refresh_preview` specifically for widget previews after updates

### ⚡ PREFERRED: Use `create_artifact` for Creating New Records

**The `create_artifact` command is the recommended way for AI agents to create artifacts:**
- Executes immediately (not queued with debounce)
- Send all fields in a single payload
- Can set reference fields directly
- No file creation needed
- Automatically updates `_map.json`

**⚠️ IMPORTANT: The `name` field is REQUIRED for ALL tables**, even if the table's display field is different (like `short_description` for stories).

```json
{
  "id": "1",
  "command": "create_artifact",
  "params": {
    "table": "sys_script_include",
    "scope": "global",
    "fields": {
      "name": "MyUtils",
      "script": "var MyUtils = Class.create();\nMyUtils.prototype = { initialize: function() {}, type: 'MyUtils' };"
    }
  }
}
```

### Queue Behavior Note

| Operation | Behavior |
|-----------|----------|
| **create_artifact** (Agent API) | Executes immediately |
| **sync_now** (Agent API) | Flushes queue immediately |
| **New file** (no sys_id) | Executes immediately |
| **Update file** (has sys_id) | Queued with debounce timer |

### ⚠️ Multi-File Artifacts (Widgets, UI Pages)

When creating multi-file artifacts like widgets, the flow is:
1. **First file** (no sys_id) → Executes immediately, creates record, updates `_map.json`
2. **Subsequent files** (now have sys_id) → Queued as updates
3. **Queue processes** after debounce timer (~5-10s)

**To speed this up, ALWAYS call `sync_now` after creating all files:**
```json
// After creating all widget files
{ "id": "flush", "command": "sync_now" }
```

**Recommended flow for widgets:**
```
1. Create all widget files (template.html, script.js, client_script.js, css.scss, etc.)
2. Wait ~1 second for file watcher to detect all files
3. Call sync_now to flush queue immediately
4. All files sync in ~2-3 seconds instead of ~20 seconds
```

### 🖥️ Opening and Refreshing Widget Previews

After creating or updating a widget, you can open it in the browser and refresh it automatically:

**Open widget preview:**
```json
{ "id": "open", "command": "open_in_browser", "params": { "table": "sp_widget", "name": "MyWidget", "scope": "global" } }
```
This opens: `/$sp.do?id=sp-preview&sys_id={sys_id}`

**Refresh after changes:**
```json
{ "id": "refresh", "command": "refresh_preview", "params": { "table": "sp_widget", "name": "MyWidget", "scope": "global" } }
```
This refreshes all browser tabs showing the widget preview.

**Recommended widget development flow:**
```
1. check_connection           → Verify connected
2. create_artifact            → Create widget with all fields
3. open_in_browser            → Open preview in browser
4. (make changes to files)
5. sync_now                   → Sync changes immediately
6. refresh_preview            → Refresh browser to see changes
7. Report completion to user
```

### Step-by-Step Workflow

1. **FIRST: Get table metadata (REQUIRED for any new artifact):**
   
   **Step 1: Check for cached `structure.json` first:**
   ```
   {instance}/{scope}/{table}/structure.json
   ```
   If this file exists, read it directly - no API call needed!
   
   **Step 2: If no cache, call the API:**
   ```
   { "command": "get_table_metadata", "params": { "table": "sys_script_include" } }
   ```
   This will also create/update `structure.json` for future use.
   
   **Step 3: Analyze the metadata for:**
   - **Mandatory fields**: Fields where `mandatory: true`
   - **Reference fields**: Fields with `type: "reference"` (need parent records)
   - **Default values**: Fields with `default` values
   
   This determines if you need to ask questions before creating.

2. **Before creating a new artifact:**
   - Use `get_table_metadata` first (see above)
   - Use `check_name_exists` or `check_name_exists_remote` to avoid duplicates
   - For tables with mandatory references, use `get_parent_options` first

3. **Creating new artifacts (two methods):**

   **Method 1: Agent API (PREFERRED)**
   ```json
   { "command": "create_artifact", "params": { "table": "...", "fields": { ... } } }
   ```
   
   **Method 2: File creation (alternative)**
   - Create ONLY code/content files with correct naming
   - ❌ DO NOT create configuration field files (e.g., `.collection.js`, `.when.js`, `.active.js`)
   - ✅ DO create script/content field files (e.g., `.script.js`, `.server_script.js`, `.template.html`)
   - ✅ Configuration fields should be in the creation payload or extension prompt
   - The extension detects new files and creates immediately (not queued)
   
   **⚠️ Common Mistake to Avoid:**
   ```
   ❌ WRONG (mixing code files with configuration files):
      MyBusinessRule.script.js        <- ✅ Code field (create file)
      MyBusinessRule.collection.js    <- ❌ Config field (DO NOT CREATE)
      MyBusinessRule.when.js          <- ❌ Config field (DO NOT CREATE)
      MyBusinessRule.active.js        <- ❌ Config field (DO NOT CREATE)
   
   ✅ CORRECT (only code/content files):
      MyBusinessRule.script.js        <- ✅ Create this (contains code)
      (collection, when, active in payload OR extension prompts)
   
   ✅ CORRECT (UI Page with multiple code fields):
      MyUIPage.html                   <- ✅ Create this (contains markup)
      MyUIPage.processing_script.js   <- ✅ Create this (contains code)
      MyUIPage.client_script.js       <- ✅ Create this (contains code)
      (name, active, etc. in payload OR extension prompts)
   ```

4. **Wait for responses:**
   - Extension responds **instantly** - no queue delays
   - Use optimized polling (100ms intervals)
   - **Unix/macOS/Linux**: `while [ ! -f "res_X.json" ]; do sleep 0.1; done`
   - **Windows**: `while (!(Test-Path "res_X.json")) { Start-Sleep -Milliseconds 100 }`
   - **Response timing:**
     - Local commands (status, info): <100ms
     - Remote commands (`create_artifact`, screenshots): 1-5s (depends on ServiceNow)
   - Check the `status` field for success/error
   - Response includes `appName` property (e.g., "Cursor", "VS Code")
   - Completed requests are logged to `_requests.log`
   - **Cleanup:** Delete both request and response files after processing

5. **Remote commands require:**
   - WebSocket connection to browser (SN Utils helper tab open)
   - Use `get_instance_info` to check if `connected: true`

6. **Complex tables with parent records:**
   Some tables CANNOT be created without a parent record:
   
   | Table | Requires Parent | Parent Table | Notes |
   |-------|-----------------|--------------|-------|
   | `sys_ws_operation` | Yes | `sys_ws_definition` | REST API endpoint needs a REST API service |
   | `sys_script` | Yes | Table reference | Business Rule needs a target table |
   | `sys_ui_action` | Yes | Table reference | UI Action needs a target table |
   | `sys_script_client` | Yes | Table reference | Client Script needs a target table |
   | `sys_dictionary` | Yes | Table reference | Dictionary entry needs a table |
   
   **Before creating these artifacts:**
   - Ask the user which parent record to use
   - Use `get_table_metadata` to understand required fields
   - Never create files for these tables without user confirmation of the parent

7. **Recommended workflow for AI agents:**
   ```
   1. User requests: "Create a REST API endpoint"
   
   2. AI calls: get_table_metadata for sys_ws_operation
      → Analyzes response, sees: web_service_definition is mandatory reference
      
   3. AI calls: get_parent_options for sys_ws_definition
      → Gets list of existing REST API services
      
   4a. IF options exist, AI asks:
       "Which REST API service should this belong to?
        - MyAPIService (global)
        - UtilsAPI (x_myapp)"
           
   4b. IF NO options exist, AI offers TWO options:
   
       "No REST API services found. Choose an option:
       
        **Option 1: Create in ServiceNow (opens pre-filled form)**
        👉 [Click here to create REST API Service](https://myinstance.service-now.com/sys_ws_definition.do?sys_id=-1&sysparm_query=name=HelloWorld API^active=true)
        After creating, I can add the endpoint.
        
        **Option 2: I'll create both for you**
        I'll use create_artifact to create the REST API service first,
        then create the endpoint with the reference."
           
   5. User provides choice
   
   6. AI calls: check_name_exists to avoid duplicates
   
   7. AI uses create_artifact command:
      {
        "command": "create_artifact",
        "params": {
          "table": "sys_ws_operation",
          "scope": "global",
          "fields": {
            "name": "getUsers",
            "web_service_definition": "<parent_sys_id>",
            "http_method": "GET",
            "operation_script": "..."
          }
        }
      }
   ```

   **⚠️ IMPORTANT: Guiding users is the AI agent's responsibility!**
   
   The sn-scriptsync extension cannot determine context or make decisions.
   When no parent records exist, the AI agent MUST:
   - Offer to create the parent record first (if supported)
   - OR provide a direct link to the instance for manual creation:
     `https://<instance>.service-now.com/<parent_table>_list.do`

8. **When no parent record exists - Two options:**

   **Option 1: User creates in ServiceNow (with pre-filled form)**
   
   Provide a link with `sysparm_query` to pre-fill the form:
   ```
   https://<instance>.service-now.com/<table>.do?sys_id=-1&sysparm_query=name=<suggested_name>^active=true^sys_scope=<scope>
   ```
   
   **Example for REST API Service:**
   ```
   https://myinstance.service-now.com/sys_ws_definition.do?sys_id=-1&sysparm_query=name=HelloWorld API^active=true^sys_scope=x_myapp
   ```
   
   **Option 2: AI Agent creates the parent record (RECOMMENDED)**
   
   Use `create_artifact` to create the parent first, then the child:
   
   ```json
   // Step 1: Create parent REST API service
   {
     "id": "1",
     "command": "create_artifact",
     "params": {
       "table": "sys_ws_definition",
       "scope": "global",
       "fields": {
         "name": "HelloWorld API",
         "active": "true"
       }
     }
   }
   
   // Step 2: Wait for response, get sys_id from result
   // Response: { "result": { "sys_id": "abc123def456...", "name": "HelloWorld API" } }
   
   // Step 3: Create child with reference to parent sys_id
   {
     "id": "2",
     "command": "create_artifact",
     "params": {
       "table": "sys_ws_operation",
       "scope": "global",
       "fields": {
         "name": "getUsers",
         "web_service_definition": "abc123def456...",
         "http_method": "GET",
         "operation_script": "(function process(request, response) { ... })(request, response);"
       }
     }
   }
   ```
   
   **⚠️ IMPORTANT: Reference fields require sys_id!**
   
   When creating a child record that has a mandatory reference field:
   - The parent sys_id is returned in the `create_artifact` response
   - Use that sys_id directly in the child's reference field
   - No need to read `_map.json` - the response contains everything
   
   **⚠️ Do NOT suggest:**
   - Fix scripts
   - Background scripts
   - Manual SQL/API calls
   
   **Generic URL pattern with pre-fill:**
   ```
   https://<instance>.service-now.com/<table>.do?sys_id=-1&sysparm_query=<field>=<value>^<field2>=<value2>
   ```
   
   **Common parent tables:**
   | Parent Type | Table | Key Fields to Pre-fill |
   |-------------|-------|----------------------|
   | REST API Service | `sys_ws_definition` | `name`, `active`, `sys_scope` |
   | Table | `sys_db_object` | `name`, `label`, `sys_scope` |
   | Application | `sys_app` | `name`, `scope`, `version` |
   | Portal | `sp_portal` | `title`, `url_suffix` |

9. **Simple vs Complex artifacts:**
   
   **Simple (can create directly):**
   - `sys_script_include` - Script Include
   - `sp_widget` - Service Portal Widget (folder structure)
   - `sys_ui_script` - UI Script
   - `sys_script_fix` - Fix Script
   
   **Complex (ask questions first):**
   - `sys_ws_operation` - "Which REST API service?"
   - `sys_script` - "Which table should this Business Rule run on?"
   - `sys_ui_action` - "Which table should this UI Action appear on?"
   - `sys_script_client` - "Which form should this Client Script run on?"

---

## 🏁 AI Agent Workflow Checklist

### At Start of Session

**1. ALWAYS confirm instance and scope:**
- If not provided in the prompt, ASK the user before proceeding
- Never assume or guess the instance or scope

**2. For GLOBAL scope work: ALWAYS use a specific update set:**
- Work in global scope should **never** go into the Default update set
- ASK the user which update set to use, or create one if needed
- **If requirements come from a Story**, use the naming format:
  ```
  STRY0012345 - Implement user validation logic
  ```
  Format: `<Story Number> - <Story Short Description>`
- Use `switch_context` command to switch to the correct update set before creating artifacts

**Workflow for update set management:**
```
1. Query for existing update set (or create new one):
   { "command": "query_records", "params": { 
     "table": "sys_update_set", 
     "query": "nameLIKESTRY0012345^state=in progress", 
     "fields": "sys_id,name,state" 
   }}
   
2. If no update set exists, create one:
   { "command": "create_artifact", "params": { 
     "table": "sys_update_set", 
     "scope": "global", 
     "fields": { 
       "name": "STRY0012345 - Implement user validation logic",
       "state": "in progress"
     } 
   }}
   
3. Switch to the update set:
   { "command": "switch_context", "params": { 
     "switchType": "updateset", 
     "value": "<sys_id from step 1 or 2>" 
   }}
   
4. Now proceed with creating artifacts
```

**3. ALWAYS call `check_connection` first:**
```json
{ "id": "init", "command": "check_connection" }
```

**If `ready: false`**, inform the user and STOP:
- `serverRunning: false` → "Please start sn-scriptsync (click status bar item)"
- `browserConnected: false` → "Please open SN Utils helper tab (type /token in ServiceNow)"

### Before Completion

**ALWAYS call `sync_now` to flush pending changes:**
```json
{ "id": "final-sync", "command": "sync_now" }
```

**Wait for response** to confirm sync completed, then report results.

### Complete Example Flow

```
1. AI calls: { "command": "check_connection" }
   → If not ready, inform user and stop
   → If ready, proceed

2. AI calls: { "command": "clear_last_error" }
   → Clear any previous errors before starting

3. For GLOBAL scope: Ensure correct update set
   → Query for existing update set or create new one
   → Use story number format if from a story: "STRY0012345 - Description"
   → { "command": "switch_context", "params": { "switchType": "updateset", "value": "..." }}

4. AI creates/modifies artifacts using create_artifact or file changes

5. AI calls: { "command": "sync_now" }
   → Flushes any queued file updates

6. AI calls: { "command": "get_last_error" }
   → Check if any errors occurred during sync

7. AI reports results:
   → If error: "❌ Error: {error message}"
   → If success: "✅ Done! Created MyUtils (sys_id: abc123)"
```

**Why this matters:**
- `check_connection` prevents confusing errors from missing connections
- `clear_last_error` gives a clean slate before operations
- `switch_context` ensures global work goes into the correct update set (not Default)
- `sync_now` ensures changes are live before reporting completion
- `get_last_error` catches errors that occurred asynchronously
- Users get accurate feedback about what happened

### Error Handling

**Errors are automatically:**
1. Written to `{instance}/_last_error.json`
2. Used to fail any pending Agent API requests
3. Available via `get_last_error` command

**Common errors and solutions:**
| Error | Solution |
|-------|----------|
| "ACL Error" | Change scope in browser to match the artifact's scope |
| "No valid token" | Run /token in ServiceNow browser session |
| "No WebSocket connection" | Open SN Utils helper tab |
| "User Not Authenticated" | Login to ServiceNow in browser |

---

## 🔧 Updating Any ServiceNow Record (Advanced)

The sn-scriptsync extension can update **any** ServiceNow table, not just script artifacts. This is useful for adding work notes to incidents, updating task fields, etc.

### ⚠️ IMPORTANT: Use In-Memory Approach - Clean Up After

**Do NOT leave temporary files in the workspace.** Create the files, sync, then delete them immediately.

### How It Works

1. Create a temporary folder structure: `{instance}/global/{table}/`
2. Create a `_map.json` with the record's sys_id
3. Create a field file: `{record_identifier}.{field_name}.txt`
4. Call `sync_now` to push the change
5. **Delete the temporary folder immediately after sync**

### Example: Adding a Work Note to an Incident

```
Step 1: Query the incident to get sys_id
{ "command": "query_records", "params": { "table": "incident", "query": "number=INC0010020", "fields": "sys_id,number,short_description" } }

Step 2: Update the record directly (no temp files!)
{ "command": "update_record", "params": { "table": "incident", "sys_id": "<sys_id>", "field": "work_notes", "content": "Your work note message here" } }

Step 3: Verify (optional)
{ "command": "query_records", "params": { "table": "sys_journal_field", "query": "element_id=<sys_id>^element=work_notes", "fields": "value,sys_created_on", "limit": 1, "orderBy": "ORDERBYDESCsys_created_on" } }
```

### Common Use Cases

| Task | Table | Field |
|------|-------|-------|
| Add incident work note | `incident` | `work_notes` |
| Add incident comment | `incident` | `comments` |
| Update task description | `task` | `description` |
| Update short description | `incident` | `short_description` |
| Add change work note | `change_request` | `work_notes` |

### Field Types

- **Journal fields** (`work_notes`, `comments`): Appends to existing entries
- **String fields** (`short_description`, `description`): Overwrites existing value
- **HTML fields** (`acceptance_criteria`, rich text fields): Use HTML formatting

### Work Notes Formatting

Work notes support ServiceNow's wiki markup and basic HTML:

```
// Basic formatting
[code]<b>Bold Header</b>[/code]    → Bold text in a code-style block

// HTML tags work in work notes
<b>Bold</b>                        → Bold text
<i>Italic</i>                      → Italic text
<u>Underline</u>                   → Underlined text

// Lists (plain text works best)
• Item 1                           → Bullet point (use • character)
• Item 2

// Line breaks
Text line 1\nText line 2           → Use \n in JSON strings
```

**Example work note:**
```json
{
  "command": "update_record",
  "params": {
    "table": "rm_story",
    "sys_id": "abc123",
    "field": "work_notes",
    "content": "[code]<b>🚀 Development Started</b>[/code]\n\nCreated update set: <b>STRY001 - My Feature</b>\n\n<b>Tasks:</b>\n• Create widget\n• Add styling\n• Test functionality"
  }
}
```

### AI Agent Workflow for Record Updates (Direct API) ⚡

**Preferred method - zero temporary files:**

```
1. Query record to get sys_id (if not already known)
2. Use update_record command directly
3. Optionally verify the update
4. Report result to user
```

### Direct Update Commands

**⚠️ IMPORTANT: Transaction Scope Required**
For update operations, the extension automatically includes `?sysparm_transaction_scope=<SCOPE_SYS_ID>` in the API request. Always ensure you're operating in the correct scope context.

#### `update_record` - Single field update
```json
{
    "id": "unique-id",
    "command": "update_record",
    "params": {
        "sys_id": "a1b2c3d4e5f67890...",
        "table": "sys_script_include",
        "field": "script",
        "content": "var MyUtils = Class.create();\n...",
        "scope": "global"
    }
}
```

**Response:**
```json
{
    "id": "unique-id",
    "command": "update_record",
    "status": "success",
    "result": {
        "success": true,
        "message": "Update sent for sys_script_include/a1b2c3d4e5f67890...",
        "table": "sys_script_include",
        "sys_id": "a1b2c3d4e5f67890...",
        "field": "script"
    }
}
```

#### `update_record_batch` - Multiple fields at once
Perfect for widgets (script + css + template) or any record with multiple code fields:

```json
{
    "id": "unique-id",
    "command": "update_record_batch",
    "params": {
        "sys_id": "widget_sys_id...",
        "table": "sp_widget",
        "fields": {
            "script": "// Server script\ndata.message = 'Hello';",
            "client_script": "// Client script\nc.message = c.data.message;",
            "css": ".my-widget { color: blue; }",
            "template": "<div class=\"my-widget\">{{c.message}}</div>"
        }
    }
}
```

**Response:**
```json
{
    "id": "unique-id",
    "command": "update_record_batch",
    "status": "success",
    "result": {
        "success": true,
        "message": "Updated 4 field(s) on sp_widget/widget_sys_id...",
        "table": "sp_widget",
        "sys_id": "widget_sys_id...",
        "fields": ["script", "client_script", "css", "template"]
    }
}
```

### Benefits of Direct API

| Aspect | File-based (old) | Direct API (new) |
|--------|------------------|------------------|
| Disk writes | 4+ files | 1 file (_requests.json) |
| Cleanup needed | ✅ Must delete temp folder | ❌ None |
| Speed | Slow | Fast |
| Complexity | High | Low |
| Error-prone | Yes (cleanup failures) | No |

### Legacy File-based Workflow (deprecated)

For reference only - prefer Direct API above:

```
1. Query record to get sys_id
2. Create temp folder: {instance}/global/{table}/
3. Create _map.json with sys_id mapping  
4. Create field file with content
5. sync_now
6. DELETE temp folder (rm -rf)
7. Optionally verify the update
8. Report result to user
```

**⚠️ If using file-based workflow: Always delete the temporary folder after syncing.**

---

## 🎓 Lessons Learned / Common Mistakes

### Things to ALWAYS Do

1. **Check connection first** - Call `check_connection` before any operations
2. **Use absolute paths for attachments** - Copy filePath directly from take_screenshot response
3. **Include `name` field in create_artifact** - Required for ALL tables
4. **Use HTML in acceptance_criteria** - rm_story.acceptance_criteria is an HTML field
5. **Clean up request/response files** - Delete both files after processing
6. **Use string values for state fields** - Pass `"-7"` not `-7`
7. **Call sync_now before completion** - Ensures all changes are synced

### Things to NEVER Do

1. **Don't use Cursor browser tools** - Use Agent API commands instead (open_in_browser, take_screenshot, etc.)
2. **Don't use undocumented slash commands** - Only use `/tn`, `/bg`, `/token`, etc.
3. **Don't open duplicate tabs** - Use activate_tab with reload:true for existing tabs
4. **Don't use relative paths for screenshots** - They resolve from instance folder, not workspace
5. **Don't assume state values** - Query sys_choice to get valid values for choice fields
6. **Don't use markdown in HTML fields** - Check field type in table metadata

### Quick Reference: Agent API vs Cursor Browser Tools

| Task | ✅ Use Agent API | ❌ Don't Use |
|------|-----------------|--------------|
| Open ServiceNow page | `open_in_browser` / `navigate` | `browser_navigate` |
| Take screenshot | `take_screenshot` / `navigate_and_screenshot` | `browser_take_screenshot` |
| Click element | `click_element` (or `set_field` / `run_ui_action`) | `browser_click` |
| Set a form field | `set_field` | `browser_type` |
| Read page content | `query_records` / `get_form_state` | `browser_snapshot` |
| Refresh page | `activate_tab` with reload | `browser_navigate` |
| Run slash command | `run_slash_command` | Manual typing |

The Agent API uses the **authenticated browser session** via SN Utils, while Cursor browser tools open an **unauthenticated separate session**.
