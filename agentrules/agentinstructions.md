<!--
===============================================================================
  SN SCRIPTSYNC - SETUP INSTRUCTIONS FOR USERS
===============================================================================

  This file has been automatically copied to your workspace root by the 
  sn-scriptsync extension. 
  
  📝 RENAME THIS FILE based on your AI coding assistant:
  
  • Cursor:          Rename to `.cursorrules`
  • Claude Desktop:  Rename to `CLAUDE.md` or keep as `agentinstructions.md`
  • GitHub Copilot:  Create folder `.github/` and rename to `copilot-instructions.md`
  • Windsurf:        Rename to `.windsurfrules`
  • Cline/Aider:     Keep as `agentinstructions.md`
  
  Below are instructions that help AI assistants understand the sn-scriptsync 
  file structure, Agent API, and ServiceNow development best practices.
  
  For more information: https://github.com/arnoudkooi/sn-scriptsync
  
===============================================================================
-->

# ServiceNow Script Sync File Structure

> **Note**: This file provides guidelines for using the `sn-scriptsync` VS Code extension.
> Place this file in the root of your workspace to help AI assistants understand the file structure.

## Overview
This workspace uses the `sn-scriptsync` VS Code extension to sync ServiceNow artifacts with local files.

## Getting Started

1. Install the `sn-scriptsync` extension in VS Code
2. Create an instance folder (e.g., `dev12345` or `myinstance`)
3. Add a `_settings.json` file in the instance folder with your credentials
4. **Sync at least one artifact** from ServiceNow to establish the scope folders
5. Start creating or editing files - the extension handles the sync automatically

**⚠️ Important**: Do not manually create scope folders. Always sync at least one artifact from a scope first to ensure proper folder structure.

## File Structure Pattern
```
<instance_folder>/<scope>/<table_name>/<artifact_file>
```

### Structure Breakdown:
1. **Instance Folder**: The ServiceNow instance name (e.g., `dev12345`, `myinstance`)
2. **Scope**: Either `global` for global scope or the scope name (e.g., `x_abc_my_app`)
3. **Table Name**: The ServiceNow table where the artifact belongs (e.g., `sys_script_include`, `sys_script`, `sys_ws_operation`)
4. **Artifact File**: The actual script file with appropriate naming convention

## Examples

### Script Include (Scoped App)
```
myinstance/x_abc_my_app/sys_script_include/MyUtils.script.js
```

### Business Rule (Global Scope)
```
myinstance/global/sys_script/MyBusinessRule.script.js
```

### Scripted REST API Resource (Global Scope)
```
myinstance/global/sys_ws_operation/MyAPIEndpoint.script.js
```

### Service Portal Widget (Scoped App)
```
myinstance/x_abc_my_app/sp_widget/MyWidget/
  ├── template.html
  ├── client_script.js
  ├── css.scss
  ├── script.js
  ├── link.js
  ├── option_schema.json
  ├── demo_data.json
  └── _test_urls.txt
```

## Important: _map.json Files

### ⚠️ DO NOT MANUALLY EDIT _map.json FILES

The `_map.json` files are **automatically maintained** by the `sn-scriptsync` extension.

**What they contain:**
```json
{
  "ArtifactName": "sys_id_from_servicenow"
}
```

**How they work:**
- When you **create a new file** without a sys_id, the extension creates it in ServiceNow and updates `_map.json`
- When you **edit an existing file**, the extension uses the sys_id from `_map.json` to update the correct record
- When the extension **pulls from ServiceNow**, it updates `_map.json` with any new or changed sys_ids

**Example:**
```json
{
  "MyUtils": "abc123def456789012345678901234",
  "AnotherUtils": "def456789012345678901234567890",
  "ThirdUtils": "789012345678901234567890123456"
}
```

## Common Table Names

| Artifact Type | Table Name | Scope Support |
|--------------|------------|---------------|
| Script Include | `sys_script_include` | Global + Scoped |
| Business Rule | `sys_script` | Global + Scoped |
| Client Script | `sys_client_script` | Global + Scoped |
| UI Action | `sys_ui_action` | Global + Scoped |
| UI Script | `sys_ui_script` | Global + Scoped |
| UI Page | `sys_ui_page` | Global + Scoped |
| Scripted REST API | `sys_ws_operation` | Global + Scoped |
| Service Portal Widget | `sp_widget` | Scoped only |
| Fix Script | `sys_script_fix` | Global + Scoped |

## File Naming Conventions

### ⚠️ CRITICAL: Do NOT Create Separate Field Files for Configuration

**NEVER create separate files for configuration/metadata fields:**
- ❌ `MyBusinessRule.collection.js` (table name - this is a STRING reference)
- ❌ `MyBusinessRule.when.js` (when to run - this is a STRING choice)
- ❌ `MyBusinessRule.active.js` (active status - this is a BOOLEAN)
- ❌ `MyUIAction.table.js` (table reference - this is a STRING)
- ❌ `MyOperation.http_method.js` (HTTP method - this is a STRING)
- ❌ `MyScript.action_insert.js` (action flag - this is a BOOLEAN)

**These configuration fields belong in the creation payload ONLY**, not as separate files.

**✅ DO create files for actual script/code/content fields:**
1. **Script fields** (contain executable code):
   - `script` → `MyBusinessRule.script.js`
   - `operation_script` → `MyOperation.operation_script.js`
   - `client_script` → `MyWidget.client_script.js`
   - `server_script` → `MyWidget.server_script.js`
   - `processing_script` → `MyUIPage.processing_script.js`
   
2. **Template/HTML fields** (contain markup):
   - `template` → `MyWidget.template.html`
   - `html` → `MyUIPage.html`
   
3. **CSS fields** (contain styles):
   - `css` → `MyWidget.css.scss`
   
4. **Special files**:
   - `option_schema.json` (widget configuration schema)
   - `demo_data.json` (widget demo data)
   - `link.js` (widget link function)

**Rule of thumb:** If the field contains **code, markup, or styles** → create a file. If it's a **configuration value** (string, boolean, number, reference) → include in payload only.

### Common Fields Reference Table

| Field Name | Type | Create File? | Example |
|------------|------|--------------|---------|
| `script` | CODE | ✅ Yes | `MyBR.script.js` |
| `operation_script` | CODE | ✅ Yes | `MyOperation.operation_script.js` |
| `client_script` | CODE | ✅ Yes | `MyWidget.client_script.js` |
| `server_script` | CODE | ✅ Yes | `MyWidget.server_script.js` |
| `processing_script` | CODE | ✅ Yes | `MyUIPage.processing_script.js` |
| `template` | MARKUP | ✅ Yes | `MyWidget.template.html` |
| `html` | MARKUP | ✅ Yes | `MyUIPage.html` |
| `css` | STYLES | ✅ Yes | `MyWidget.css.scss` |
| `link` | CODE | ✅ Yes | `MyWidget.link.js` |
| `collection` | CONFIG (string) | ❌ No | In payload: `"collection": "incident"` |
| `when` | CONFIG (string) | ❌ No | In payload: `"when": "before"` |
| `active` | CONFIG (boolean) | ❌ No | In payload: `"active": "true"` |
| `http_method` | CONFIG (string) | ❌ No | In payload: `"http_method": "GET"` |
| `table` | CONFIG (string) | ❌ No | In payload: `"table": "incident"` |
| `action_insert` | CONFIG (boolean) | ❌ No | In payload: `"action_insert": "true"` |
| `action_update` | CONFIG (boolean) | ❌ No | In payload: `"action_update": "true"` |
| `priority` | CONFIG (number) | ❌ No | In payload: `"priority": "100"` |
| `order` | CONFIG (number) | ❌ No | In payload: `"order": "100"` |
| `web_service_definition` | CONFIG (reference) | ❌ No | In payload: `"web_service_definition": "abc123..."` |

### Standard Scripts
- Use the artifact name with `.script.js` extension
- Example: `HelloWorldUtils.script.js`, `DummyIncidentBR.script.js`

### Calculation Fields
- Use field name with `.calculation.js` extension
- Example: `Foreign.calculation.js`

### Client Scripts for UI Actions
- Use artifact name with `.client_script_v2.js` extension
- Example: `LargeBold.client_script_v2.js`

### Service Portal Widgets
- Widgets are folders containing multiple files
- File names: `template.html`, `client_script.js`, `css.scss`, `script.js`, etc.

## Creating New Artifacts

### Important: Understanding Table Metadata

When creating a new artifact, the extension needs to understand the table structure:

**Key Considerations:**
1. **Mandatory Reference Fields**: Some tables require references to other records (cannot be empty)
2. **Field Mappings**: Different tables store scripts in different fields
3. **Required Setup**: Some artifacts need parent records to exist first

### Example: Scripted REST API (sys_ws_operation)

A `sys_ws_operation` record requires:
- **Mandatory Reference**: `web_service_definition` field must reference a `sys_ws_definition` record
- **Script Field**: The script content is stored in the `operation_script` field
- **Parent Record Required**: You must first create or have an existing REST API service definition

**Workflow for Complex Artifacts:**
1. Extension detects new file
2. Extension fetches table metadata from ServiceNow
3. Extension analyzes mandatory fields and references
4. Extension prompts user: "This requires a web_service_definition reference. Do you want to:
   - Select an existing REST API service?
   - Create a new REST API service?"
5. User provides required information
6. Extension creates the record with all required fields
7. Extension updates `_map.json` with the new sys_id

### Working with Scoped Applications

**⚠️ IMPORTANT: Do NOT create scope folders manually**

Before creating files in a new scope folder:
1. **Sync at least one artifact first** from ServiceNow for that scope
2. This ensures the scope exists and the folder structure is correct
3. The extension will create the scope folder automatically during the first sync

**Why this matters:**
- Scope names must match exactly with ServiceNow
- The scope must exist in the instance
- Incorrect scope names will cause sync failures

**Correct Workflow:**
1. Create or identify a scope in ServiceNow (e.g., `x_abc_my_app`)
2. Create at least one artifact in that scope in ServiceNow
3. Use the extension to pull/sync that artifact
4. The extension creates: `<instance>/x_abc_my_app/<table>/`
5. Now you can create new files in that scope folder

### Step-by-Step: Creating Simple Artifacts

For simple artifacts like Script Includes (no mandatory references):

#### Step 1: Create the file in the correct location
```
<your_instance>/global/sys_script_include/MyNewUtils.script.js
```
Or for a scoped app (after syncing at least one artifact):
```
<your_instance>/<your_scope>/sys_script_include/MyNewUtils.script.js
```

#### Step 2: Write your code
```javascript
var MyNewUtils = Class.create();
MyNewUtils.prototype = {
    initialize: function() {
    },
    
    myFunction: function() {
        return 'Hello World';
    },
    
    type: 'MyNewUtils'
};
```

#### Step 3: Save the file
The `sn-scriptsync` extension will:
1. Detect the new file
2. Fetch table metadata to check for mandatory fields
3. Create the record in ServiceNow (prompting for required info if needed)
4. Automatically update `_map.json` with the new sys_id

**⚠️ IMPORTANT: Only create the `.script.js` file**
- Do NOT create separate files like `.collection.js`, `.when.js`, `.active.js`
- The extension will prompt for required fields (like `collection` for Business Rules)
- OR use `create_artifact` command to include all fields in one payload

### Common Table Requirements

| Table | Script Field | Mandatory References | Notes |
|-------|-------------|---------------------|-------|
| `sys_script_include` | `script` | None | Simple creation |
| `sys_script` | `script` | `collection` (table name) | Must specify which table |
| `sys_ws_operation` | `operation_script` | `web_service_definition` | Needs parent REST API |
| `sys_ui_action` | `script` | `table` (table name) | Must specify which table |
| `sys_client_script` | `script` | `table` (table name) | Must specify which table |
| `sp_widget` | Multiple files | None | Widget folder structure |
| `rm_story` | N/A | None | See rm_story specific guidance below |

### rm_story (Story) Table Specifics

**Key Fields:**
- `name` - Required by create_artifact (can be same as short_description)
- `short_description` - The story title/summary
- `description` - Detailed description (plain text)
- `acceptance_criteria` - **HTML field** - use HTML formatting, not markdown
- `state` - Story state (see values below)
- `priority` - Priority level (1-4)

**State Values:**
| State | Value | Description |
|-------|-------|-------------|
| Draft | `-6` | Initial state, not ready for work |
| **Ready** | `1` | Ready for development |
| Work in Progress | `2` | Currently being worked on |
| **Ready for Testing** | `-7` | Development complete, ready for QA |
| Testing | `-8` | Currently being tested |
| Complete | `3` | Story is done |
| Cancelled | `4` | Story was cancelled |

**⚠️ IMPORTANT: acceptance_criteria is an HTML field!**

Use HTML tags for formatting, NOT markdown:

```html
<!-- ✅ CORRECT - HTML formatting -->
<b>Acceptance Criteria:</b>
<ul>
  <li>Widget displays correctly</li>
  <li>Score tracking works</li>
  <li>No console errors</li>
</ul>

<b>Definition of Done:</b>
<ul>
  <li>Code reviewed</li>
  <li>Unit tests pass</li>
</ul>
```

```markdown
<!-- ❌ INCORRECT - Markdown won't render -->
**Acceptance Criteria:**
- Widget displays correctly
- Score tracking works
```

**Example: Creating a Story**
```json
{
  "command": "create_artifact",
  "params": {
    "table": "rm_story",
    "scope": "global",
    "fields": {
      "name": "Implement User Dashboard Widget",
      "short_description": "Implement User Dashboard Widget",
      "description": "Create a Service Portal widget that displays user statistics and recent activity.",
      "acceptance_criteria": "<b>Acceptance Criteria:</b><ul><li>Widget shows user stats</li><li>Responsive design</li></ul><b>Definition of Done:</b><ul><li>Code reviewed</li><li>Tested in dev</li></ul>",
      "state": "1",
      "priority": "2"
    }
  }
}
```

**Updating Story State:**
```json
{ 
  "command": "update_record", 
  "params": { 
    "table": "rm_story", 
    "sys_id": "abc123...", 
    "field": "state", 
    "content": "-7"
  } 
}
```

**Note:** State values are strings (e.g., `"-7"` not `-7`)

### Handling Mandatory References

When the extension detects a mandatory reference field:

**The extension should:**
1. Query ServiceNow for available reference options
2. Present choices to the user
3. Allow creation of a new reference record if needed
4. Validate the reference exists before creating the artifact

**The extension should NOT:**
- Set reference fields to empty strings
- Create records without required references
- Assume default values for mandatory fields

### Fetching Table Metadata

Before creating a new record, the extension should:

1. **Query the ServiceNow API** to get table dictionary information:
   ```
   GET /api/now/table/sys_dictionary?sysparm_query=name=<table_name>^ORDERBYelement
   ```

2. **Analyze mandatory fields**: Check for fields where `mandatory=true`

3. **Identify reference fields**: Check `reference` field for reference table names

4. **Map script fields**: Different tables use different field names:
   - Most tables: `script`
   - REST API Operations: `operation_script`
   - UI Pages: Multiple fields (`html`, `client_script`, `processing_script`)

5. **Consult ServiceNow documentation** if needed for complex tables:
   - ServiceNow Docs: https://docs.servicenow.com/
   - Table API documentation
   - Field specifications and requirements

## ServiceNow Coding Standards

### ⚠️ CRITICAL: Scoped Application API Restrictions

**In scoped applications (like Service Portal widgets), certain global APIs are NOT allowed:**

```javascript
// ❌ INCORRECT - NOT allowed in scoped apps
var now = new GlideDateTime();
now.setDisplayValue(gs.nowDateTime());  // ERROR: Function nowDateTime is not allowed in scope!

// ✅ CORRECT - Use GlideDateTime constructor directly
var now = new GlideDateTime();  // Automatically initializes to current time
data.currentDay = parseInt(now.getDayOfMonthLocalTime());
data.currentMonth = parseInt(now.getMonthLocalTime());
data.currentYear = parseInt(now.getYearLocalTime());
data.dayOfWeek = now.getDayOfWeekLocalTime();
```

**Key Rules:**
- ✅ `new GlideDateTime()` - Creates current date/time automatically
- ✅ Use `LocalTime` methods: `getDayOfMonthLocalTime()`, `getMonthLocalTime()`, `getYearLocalTime()`
- ❌ `gs.nowDateTime()` - NOT allowed in scoped applications
- ❌ `gs.now()` - NOT allowed in scoped applications
- ❌ Non-LocalTime methods may fail: `getDayOfMonth()`, `getMonth()`, `getYear()`

### Service Portal Widget Client Scripts

**Use Angular dependency injection, not IIFE patterns:**

```javascript
// ❌ WRONG - IIFE loses 'this' context, causes $apply issues
(function() {
  var c = this;
  setInterval(function() { c.$apply(); }, 1000);
})();

// ✅ CORRECT - Proper Angular controller with DI
api.controller = function($scope, $interval, $timeout) {
  var c = this;
  $interval(updateFn, 1000);  // Auto-handles digest cycle
};
```

**Available Angular services:** `$scope`, `$interval`, `$timeout`, `$http`, `$q`, `$location`, `spUtil`, `spModal`

### GlideRecord Best Practices
Always use `setValue()` and `getValue()` methods:

```javascript
// ✅ CORRECT
var grUser = new GlideRecord('sys_user');
if (grUser.get(userId)) {
    var userName = grUser.getValue('name');
    grUser.setValue('active', true);
    grUser.update();
}

// ❌ INCORRECT
var gr = new GlideRecord('sys_user');
if (gr.get(userId)) {
    var userName = gr.name;  // Direct property access
    gr.active = true;        // Direct property assignment
    gr.update();
}
```

### Variable Naming
Use semantic variable names with prefixes:
- `grUser` - GlideRecord for user
- `grIncident` - GlideRecord for incident
- `gaRecords` - GlideAggregate
- Not just `gr` or `ga`

## Workflow

1. **Edit files** in VS Code using the proper file structure
2. **Save** your changes
3. The extension **automatically syncs** to ServiceNow after a debounce period
4. The extension **updates _map.json** automatically
5. **Never manually edit** `_map.json` files

## Settings Files

Each instance folder should have a settings file:
- `_settings.json` (recommended format)
- `settings.json` (alternative format)
This is generated and updated by the sn-scriptsync Extension

**Security Note**: These files contain keys and should be added to `.gitignore`.

## Recommended .gitignore

Add these entries to your `.gitignore` to protect credentials and avoid syncing local state:

```gitignore
# ServiceNow credentials
**/settings.json
**/_settings.json

# Extension logs
debug.log

# OS files
.DS_Store
Thumbs.db
```

## Tips for Users

- Let the extension manage `_map.json` - it knows what it's doing
- Use proper folder structure: `<instance>/<scope>/<table>/<artifact>`
- For new artifacts, just create the file and save - the extension handles the rest
- The extension uses a debounce timer, so changes sync after a short delay
- Check `debug.log` if something isn't working as expected
- Always commit `_map.json` files to version control (they contain sys_ids)
- Never commit `_settings.json` files (they contain credentials)

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


# SN ScriptSync - Agent API

This VS Code extension syncs ServiceNow scripts. AI agents can communicate with it via **event-driven file-based requests** using folder queues for zero-latency, parallel communication.

## How to Use

### 1. Send a Request
Create a uniquely-named file in `{instance_folder}/agent/requests/`:

```bash
# File: {instance_folder}/agent/requests/req_abc123.json
```

```json
{
  "id": "abc123",
  "command": "command_name",
  "params": { },
  "timestamp": 1733567890
}
```

### 2. Wait for Response
The extension responds **instantly** (typically <100ms). Check for `res_abc123.json`:

**Optimized polling pattern:**
```bash
# Unix/macOS/Linux
RESPONSE_FILE="agent/responses/res_abc123.json"
while [ ! -f "$RESPONSE_FILE" ]; do sleep 0.1; done
cat "$RESPONSE_FILE"

# Windows (PowerShell)
$file = "agent/responses/res_abc123.json"
while (!(Test-Path $file)) { Start-Sleep -Milliseconds 100 }
Get-Content $file
```

**Or use file system watcher** (if available):
```bash
# macOS with fswatch: fswatch -1 agent/responses/res_abc123.json
# Linux with inotifywait: inotifywait -e create agent/responses/
```

**Response format:**
```json
{
  "id": "abc123",
  "command": "command_name",
  "status": "success",
  "result": { },
  "timestamp": 1733567891,
  "appName": "Cursor"
}
```

### 3. Cleanup
After processing the response, **delete both files**:
```bash
# Unix/macOS/Linux
rm agent/requests/req_abc123.json agent/responses/res_abc123.json

# Windows (PowerShell)
Remove-Item agent/requests/req_abc123.json,agent/responses/res_abc123.json

# Windows (CMD)
del agent\requests\req_abc123.json agent\responses\res_abc123.json
```

**Benefits:**
- ✅ **Instant responses** - extension processes immediately (no queue delays)
- ✅ **Parallel requests** - multiple requests can be in-flight simultaneously
- ✅ **No file conflicts** - each request gets its own unique files
- ✅ **App identification** - `appName` property shows which editor responded

---

### Complete Example (Unix/macOS/Linux)

```bash
# 1. Create request
cat > agent/requests/req_conn1.json << 'EOF'
{
  "id": "conn1",
  "command": "check_connection"
}
EOF

# 2. Wait for response (optimized polling)
while [ ! -f agent/responses/res_conn1.json ]; do sleep 0.1; done

# 3. Read response
cat agent/responses/res_conn1.json
# Output: {"id":"conn1","status":"success","result":{"ready":true},"appName":"Cursor"}

# 4. Cleanup
rm agent/requests/req_conn1.json agent/responses/res_conn1.json
```

### Complete Example (Windows PowerShell)

```powershell
# 1. Create request
@"
{
  "id": "conn1",
  "command": "check_connection"
}
"@ | Out-File -FilePath agent/requests/req_conn1.json -Encoding utf8

# 2. Wait for response (optimized polling)
while (!(Test-Path agent/responses/res_conn1.json)) { Start-Sleep -Milliseconds 100 }

# 3. Read response
Get-Content agent/responses/res_conn1.json
# Output: {"id":"conn1","status":"success","result":{"ready":true},"appName":"Cursor"}

# 4. Cleanup
Remove-Item agent/requests/req_conn1.json,agent/responses/res_conn1.json
```

## Security & Validation

The extension enforces several security measures to protect the workspace and ServiceNow instance:

### Request ID Validation
- **Format**: Request IDs must be alphanumeric with underscores/hyphens only: `^[a-zA-Z0-9_-]+$`
- **Invalid examples**: `../../../etc/passwd`, `req;rm -rf`, `req with spaces`
- **Valid examples**: `req_123`, `abc-def`, `test_001`

**Error response for invalid ID:**
```json
{
  "status": "error",
  "error": "Invalid request ID: only alphanumeric, underscore, and hyphen allowed"
}
```

### Workspace Boundary Enforcement
- All file operations are **restricted to the VS Code workspace**
- Path traversal attempts (e.g., `../../../`) are blocked
- Absolute paths outside workspace are rejected

### File Upload Security (`upload_attachment`)
When using `filePath` parameter:
- Paths are normalized using `path.resolve()` to prevent traversal
- Only files **within the workspace** can be uploaded
- Both relative and absolute paths are validated

**Example secure paths:**
```bash
✅ "screenshots/screenshot1.png"           # Relative to instance
✅ "/full/path/to/workspace/file.pdf"      # Absolute within workspace

❌ "../../../etc/passwd"                   # Blocked: path traversal
❌ "/etc/hosts"                            # Blocked: outside workspace
❌ "C:\\Windows\\System32\\file.txt"       # Blocked: outside workspace
```

### ServiceNow API Access
- Browser helper tab validates instance URLs (allowed/blocked lists)
- User must explicitly approve each ServiceNow instance
- All API calls use the `safeFetch()` wrapper that checks approvals

### Best Practices for Agents
1. ✅ Use simple, descriptive request IDs: `query_incidents_001`
2. ✅ Always use relative paths for file uploads: `screenshots/image.png`
3. ✅ Check response status before processing results
4. ✅ Handle errors gracefully and inform users
5. ❌ Never attempt path traversal or workspace escape
6. ❌ Don't use special characters in request IDs

**Security violation example:**
```json
{
  "id": "../../../evil",
  "command": "upload_attachment",
  "params": {
    "filePath": "../../../etc/passwd"
  }
}
```
**Response:**
```json
{
  "status": "error",
  "error": "Security: File path outside workspace not allowed"
}
```

---

## Available Commands

### `check_connection` ⚡ (CALL THIS FIRST)
Verify WebSocket server is running and browser helper tab is connected. **Always call this before any other operations.**

**Request:**
```json
{ "id": "0", "command": "check_connection" }
```

**Response (ready):**
```json
{
  "status": "success",
  "result": {
    "ready": true,
    "serverRunning": true,
    "browserConnected": true,
    "clientCount": 1,
    "message": "Connected and ready"
  }
}
```

**Response (server not running):**
```json
{
  "status": "error",
  "error": "WebSocket server not running. Click sn-scriptsync in VS Code status bar to start.",
  "result": {
    "ready": false,
    "serverRunning": false,
    "browserConnected": false,
    "message": "WebSocket server not running"
  }
}
```

**Response (no browser):**
```json
{
  "status": "error",
  "error": "No browser connection. Open SN Utils helper tab via /token command in ServiceNow.",
  "result": {
    "ready": false,
    "serverRunning": true,
    "browserConnected": false,
    "message": "No browser connected - open helper tab with /token"
  }
}
```

### `get_sync_status`
Get current sync queue status.

**Request:**
```json
{ "id": "1", "command": "get_sync_status" }
```

**Response:**
```json
{
  "result": {
    "serverRunning": true,
    "pendingFiles": ["/path/to/file.js"],
    "pendingCount": 1,
    "isPaused": false
  }
}
```

### `get_last_error`
Get the last error that occurred. Errors are automatically written to `_last_error.json` and pending Agent requests are failed when ServiceNow returns an error.

**Request:**
```json
{ "id": "err", "command": "get_last_error" }
```

**Response (when error exists):**
```json
{
  "result": {
    "hasError": true,
    "isRecent": true,
    "error": "ACL Error, try changing scope in the browser",
    "time": "2024-12-07T12:30:45.123Z",
    "timestamp": 1733567445123,
    "details": { "message": "...", "detail": "..." }
  }
}
```

**Response (no error):**
```json
{
  "result": {
    "hasError": false,
    "message": "No errors recorded"
  }
}
```

### `clear_last_error`
Clear the last error file.

**Request:**
```json
{ "id": "clr", "command": "clear_last_error" }
```

**Response:**
```json
{
  "result": {
    "cleared": true,
    "message": "Error cleared"
  }
}
```

### `sync_now` ⚡
Immediately sync all pending files (flush the queue). Use this after making multiple file changes to ensure they're synced before continuing.

**Request:**
```json
{ "id": "2", "command": "sync_now" }
```

**Response (when files pending):**
```json
{
  "result": {
    "synced": true,
    "message": "Synced 3 file(s) immediately",
    "count": 3,
    "files": ["/path/to/file1.js", "/path/to/file2.js", "/path/to/file3.js"]
  }
}
```

**Response (when no files pending):**
```json
{
  "result": {
    "synced": false,
    "message": "No pending files to sync",
    "count": 0
  }
}
```

### `open_in_browser`
Open an artifact in the browser. For widgets, opens the preview page; for other artifacts, opens the form view.

**Request (with sys_id):**
```json
{ 
  "id": "3", 
  "command": "open_in_browser", 
  "params": { 
    "table": "sp_widget",
    "sys_id": "abc123def456"
  } 
}
```

**Request (with name - looks up sys_id from _map.json):**
```json
{ 
  "id": "3", 
  "command": "open_in_browser", 
  "params": { 
    "table": "sp_widget",
    "name": "MyWidget",
    "scope": "global"
  } 
}
```

**Response:**
```json
{
  "result": {
    "opened": true,
    "url": "https://instance.service-now.com/$sp.do?id=sp-preview&sys_id=abc123def456",
    "table": "sp_widget",
    "sys_id": "abc123def456"
  }
}
```

**URL patterns by table:**
| Table | URL Pattern |
|-------|-------------|
| `sp_widget` | `/$sp.do?id=sp-preview&sys_id={sys_id}` (Widget Preview) |
| `sp_page` | `/sp?id={name}` (Portal Page) |
| Other tables | `/{table}.do?sys_id={sys_id}` (Standard Form) |

### `refresh_preview`
Refresh browser tabs showing the artifact preview. Useful after updating a widget to see changes immediately.

**Request:**
```json
{ 
  "id": "4", 
  "command": "refresh_preview", 
  "params": { 
    "table": "sp_widget",
    "sys_id": "abc123def456"
  } 
}
```

**Request (with name):**
```json
{ 
  "id": "4", 
  "command": "refresh_preview", 
  "params": { 
    "table": "sp_widget",
    "name": "MyWidget",
    "scope": "global"
  } 
}
```

**Response:**
```json
{
  "result": {
    "refreshed": true,
    "sys_id": "abc123def456",
    "testUrls": [
      "https://instance.service-now.com/$sp.do?id=sp-preview&sys_id=abc123def456*",
      "https://instance.service-now.com/sp?id=mywidget*"
    ],
    "message": "Refresh command sent for sp_widget"
  }
}
```

**Note:** This refreshes ALL browser tabs matching the widget's preview URLs, plus the active tab if it's on the same instance.

### `get_instance_info`
Get instance connection info.

**Request:**
```json
{ "id": "2", "command": "get_instance_info" }
```

**Response:**
```json
{
  "result": {
    "instanceName": "myinstance",
    "hasSettings": true,
    "connected": true
  }
}
```

### `list_tables`
List available table folders in the instance.

**Request:**
```json
{ "id": "3", "command": "list_tables" }
```

**Response:**
```json
{
  "result": {
    "tables": ["sys_script_include", "sys_script", "sp_widget"]
  }
}
```

### `list_artifacts`
List artifacts in a specific table.

**Request:**
```json
{ "id": "4", "command": "list_artifacts", "params": { "table": "sys_script_include" } }
```

**Response:**
```json
{
  "result": {
    "artifacts": ["global/MyUtils.script.js", "global/HelperFunctions.script.js"]
  }
}
```

### `check_name_exists`
Check if an artifact name already exists (checks local `_map.json` files only, not ServiceNow).

**Request:**
```json
{ "id": "5", "command": "check_name_exists", "params": { "table": "sys_script_include", "name": "MyUtils" } }
```

**Response:**
```json
{
  "result": {
    "exists": true,
    "sysId": "abc123def456"
  }
}
```

### `get_file_structure`
Get the expected file naming convention.

**Request:**
```json
{ "id": "6", "command": "get_file_structure" }
```

**Response:**
```json
{
  "result": {
    "pattern": "{instance}/{scope}/{table}/{name}.{field}.{ext}",
    "example": "myinstance/global/sys_script_include/MyUtils.script.js",
    "fields": {
      "sys_script_include": ["script"],
      "sys_script": ["script"],
      "sp_widget": ["script", "css", "client_script", "link", "template"]
    }
  }
}
```

### `validate_path`
Validate a proposed file path before creating it.

**Request:**
```json
{ "id": "7", "command": "validate_path", "params": { "path": "myinstance/global/sys_script_include/NewUtil.script.js" } }
```

**Response:**
```json
{
  "result": {
    "valid": true,
    "parsed": {
      "instance": "myinstance",
      "scope": "global",
      "table": "sys_script_include",
      "file": "NewUtil.script.js"
    }
  }
}
```

---

## Remote Commands (ServiceNow API)

These commands make HTTP requests to ServiceNow and may take 1-5 seconds.

### `get_table_metadata`
Fetch table field definitions from ServiceNow API.

**Request:**
```json
{ "id": "8", "command": "get_table_metadata", "params": { "table": "sys_script_include" } }
```

**Response:**
```json
{
  "result": {
    "columns": {
      "name": { "label": "Name", "type": "string", "mandatory": false, "max_length": 100 },
      "script": { "label": "Script", "type": "script_plain", "mandatory": false },
      "active": { "label": "Active", "type": "boolean", "default": "false" }
    }
  }
}
```

### `check_name_exists_remote`
Check if an artifact exists in ServiceNow (queries the actual instance, not just local files).

**Request:**
```json
{ "id": "9", "command": "check_name_exists_remote", "params": { "table": "sys_script_include", "name": "MyUtils" } }
```

**Response:**
```json
{
  "result": {
    "exists": true,
    "sysId": "abc123def456",
    "record": { "name": "MyUtils", "sys_scope": "global" }
  }
}
```

### `query_records` ⚡
Execute an arbitrary encoded query against any ServiceNow table. Use this to fetch data, check conditions, or explore records.

**Request:**
```json
{ 
  "id": "q1", 
  "command": "query_records", 
  "params": { 
    "table": "incident",
    "query": "priority=1^active=true",
    "fields": "number,short_description,priority,state,sys_created_on",
    "limit": 5,
    "orderBy": "ORDERBYDESCsys_created_on"
  } 
}
```

**Parameters:**
- `table` (required): The ServiceNow table to query
- `query` (optional): Encoded query string (e.g., `priority=1^active=true`)
- `fields` (optional): Comma-separated field names (default: `sys_id,number,short_description,sys_created_on`)
- `limit` (optional): Max records to return (default: 10)
- `orderBy` (optional): Order clause (e.g., `ORDERBYDESCsys_created_on`)

**Response:**
```json
{
  "status": "success",
  "result": {
    "table": "incident",
    "count": 3,
    "records": [
      {
        "sys_id": "abc123",
        "number": "INC0010001",
        "short_description": "Server down",
        "priority": "1",
        "state": "2",
        "sys_created_on": "2024-12-07 10:30:00"
      },
      ...
    ]
  }
}
```

**Common Query Examples:**

| Use Case | Query |
|----------|-------|
| **Get single record by sys_id** | `sys_id=abc123def456...` |
| Active P1 incidents | `priority=1^active=true` |
| Recent changes | `ORDERBYDESCsys_created_on` |
| My assigned tasks | `assigned_to=javascript:gs.getUserID()^active=true` |
| Open problems | `state!=7^state!=8` |
| Items in scope | `sys_scope.scope=x_myapp` |
| Name contains | `nameLIKEutils` |
| Created today | `sys_created_onONToday@javascript:gs.beginningOfToday()@javascript:gs.endOfToday()` |

**Encoded Query Operators:**
- `=` equals
- `!=` not equals
- `LIKE` contains
- `STARTSWITH` starts with
- `ENDSWITH` ends with
- `>` greater than
- `<` less than
- `>=` greater or equal
- `<=` less or equal
- `IN` in list (comma-separated)
- `NOTIN` not in list
- `ISEMPTY` is empty
- `ISNOTEMPTY` is not empty
- `^` AND
- `^OR` OR
- `^NQ` new query (OR group)

### `get_parent_options`
Get available parent records for reference fields. Use this to find existing REST API services, tables, etc.

**Request:**
```json
{ 
  "id": "10", 
  "command": "get_parent_options", 
  "params": { 
    "table": "sys_ws_definition",
    "scope": "x_myapp",
    "nameField": "name",
    "limit": 50
  } 
}
```

**Parameters:**
- `table` (required): The parent table to query (e.g., `sys_ws_definition` for REST API services)
- `scope` (optional): Filter by scope name
- `nameField` (optional): Field to use as display name (default: `name`)
- `limit` (optional): Max records to return (default: 50)

**Response:**
```json
{
  "result": {
    "table": "sys_ws_definition",
    "count": 3,
    "options": [
      { "sys_id": "abc123", "name": "My REST API", "scope": "x_myapp" },
      { "sys_id": "def456", "name": "Another API", "scope": "global" },
      { "sys_id": "ghi789", "name": "Third API", "scope": "x_myapp" }
    ]
  }
}
```

**Common use cases:**
| Creating | Query table | To get |
|----------|-------------|--------|
| REST API Operation | `sys_ws_definition` | Available REST API services |
| Business Rule | `sys_db_object` | Available tables |
| UI Action | `sys_db_object` | Available tables |
| Client Script | `sys_db_object` | Available tables |

### `create_artifact` ⚡ (RECOMMENDED FOR AI AGENTS)
Create a new artifact directly via payload. **This is the preferred method for AI agents** - no file creation needed, executes immediately (not queued).

**⚠️ IMPORTANT: Transaction Scope Required**
The extension automatically includes `?sysparm_transaction_scope=<SCOPE_SYS_ID>` in the API request to ensure the artifact is created in the correct scope context.

**Request:**
```json
{ 
  "id": "11", 
  "command": "create_artifact", 
  "params": { 
    "table": "sys_script_include",
    "scope": "global",
    "fields": {
      "name": "MyNewUtils",
      "script": "var MyNewUtils = Class.create();\nMyNewUtils.prototype = {\n    initialize: function() {},\n    type: 'MyNewUtils'\n};",
      "active": "true",
      "access": "public"
    }
  } 
}
```

**Parameters:**
- `table` (required): The ServiceNow table (e.g., `sys_script_include`, `sys_script`)
- `scope` (required): Scope name - always specify explicitly (e.g., `global`, `x_myapp`)
- `fields` (required): Object containing field:value pairs
  - `name` (required): The artifact name
  - Other fields depend on the table (script, active, etc.)

**Response:**
```json
{
  "status": "success",
  "result": {
    "sys_id": "abc123def456789012345678901234",
    "name": "MyNewUtils",
    "table": "sys_script_include",
    "scope": "global"
  }
}
```

**Benefits over file-based creation:**
- ✅ Executes immediately (not queued with debounce)
- ✅ Can set multiple fields in one request
- ✅ Can set reference fields directly (e.g., `web_service_definition` for REST API operations)
- ✅ No need to create files first
- ✅ Automatically updates `_map.json`

**Example: Creating a Business Rule with table reference:**
```json
{
  "id": "12",
  "command": "create_artifact",
  "params": {
    "table": "sys_script",
    "scope": "global",
    "fields": {
      "name": "My Business Rule",
      "collection": "incident",      // ✅ Include table reference in payload
      "script": "// Business Rule script",
      "when": "before",               // ✅ Include when in payload
      "action_insert": "true",        // ✅ Include action in payload
      "active": "true"                // ✅ Include active in payload
    }
  }
}
```

**⚠️ NOTE:** All configuration fields (`collection`, `when`, `action_insert`, `active`) are included in the **single payload**. These are STRING/BOOLEAN values, not code.

**Do NOT create files for configuration fields:**
- ❌ `MyBR.collection.js` - this is just the string "incident"
- ❌ `MyBR.when.js` - this is just the string "before"
- ❌ `MyBR.active.js` - this is just the boolean true

**Only the script content (actual code) goes in a file:**
- ✅ `MyBR.script.js` - contains the business rule code

**If an artifact has multiple code fields, create multiple files:**
- ✅ `MyUIPage.html` - contains markup
- ✅ `MyUIPage.client_script.js` - contains client-side code
- ✅ `MyUIPage.processing_script.js` - contains server-side code

**Example: Creating a REST API Operation with parent reference:**
```json
{
  "id": "13",
  "command": "create_artifact",
  "params": {
    "table": "sys_ws_operation",
    "scope": "x_myapp",
    "fields": {
      "name": "getUsers",
      "web_service_definition": "abc123def456",
      "http_method": "GET",
      "operation_script": "(function process(request, response) {\n    response.setBody({message: 'Hello'});\n})(request, response);",
      "active": "true"
    }
  }
}
```

### `take_screenshot` ⚡ (Remote - Async)
Take a screenshot of a ServiceNow page. Requires explicit user action on first use.

**⚠️ IMPORTANT: Permission Required**
- **First screenshot**: User must click the SN Utils extension icon on the target tab to grant permission
- **Subsequent screenshots**: Will reuse the same tab without re-approval (when possible)
- If permission is denied, the response will include an error message guiding the user

**Request:**
```json
{
  "id": "14",
  "command": "take_screenshot",
  "params": {
    "url": "https://instance.service-now.com/sp?id=my_widget"
  }
}
```

**Parameters:**
- `url` (required if no tabId): The full URL to capture
- `tabId` (optional): Specific browser tab ID to capture (alternative to url)
- `fileName` (optional): Custom filename (defaults to `screenshot_TIMESTAMP.png`)

**Response (success):**
```json
{
  "id": "14",
  "command": "take_screenshot",
  "status": "success",
  "timestamp": 1733779200000,
  "result": {
    "saved": true,
    "filePath": "/workspace/screenshots/screenshot_2024-12-09T14-00-00.png",
    "fileName": "screenshot_2024-12-09T14-00-00.png",
    "url": "https://instance.service-now.com/sp?id=my_widget",
    "tabTitle": "My Widget - ServiceNow"
  }
}
```

**Response (permission needed):**
```json
{
  "id": "14",
  "command": "take_screenshot",
  "status": "error",
  "error": "Screenshot requires permission. Click the SN Utils extension icon on the tab you want to capture, then retry."
}
```

**Use cases:**
- Capture widget preview for visual verification
- Document UI state during development
- Debug visual issues

**Behavior:**
1. Screenshots are saved to `{workspace}/screenshots/` folder
2. The browser extension must be connected
3. Tab reuse: After the first successful screenshot, subsequent requests will try to reuse the same tab (navigating to new URLs if needed) to avoid repeated permission prompts
4. If no matching tab is found, a new tab will be opened

**Handling permission errors:**
When receiving a permission error, inform the user they need to click the SN Utils extension icon, then retry the screenshot command.

### `run_slash_command` ⚡ (Remote - Async)
Execute SN Utils slash commands on a ServiceNow tab. **Particularly useful for debugging forms with `/tn` (show technical names).**

**⚠️ IMPORTANT: Only use DOCUMENTED slash commands!**

**Documented commands include:**
- `/tn` - Toggle technical names on forms
- `/bg` - Open background scripts
- `/token` - Open helper tab for connection
- `/sn` - Search navigator
- `/xml` - Show XML of current record
- See SN Utils documentation for full list

**❌ Do NOT use non-existent commands** like `/click`, `/select`, etc.

**Request:**
```json
{
  "id": "14",
  "command": "run_slash_command",
  "params": {
    "command": "/tn",
    "url": "https://*.service-now.com/*",
    "autoRun": true
  }
}
```

**Parameters:**
- `command` (required): The slash command to run (e.g., `/tn`, `/bg`, `tn` - leading slash is optional)
- `url` (optional): URL pattern to find the tab (default: `https://*.service-now.com/*`)
- `tabId` (optional): Specific browser tab ID to target
- `autoRun` (optional): Auto-execute the command (default: `true`)

**Response (success):**
```json
{
  "id": "14",
  "command": "run_slash_command",
  "status": "success",
  "timestamp": 1733779200000,
  "result": {
    "executed": true,
    "slashCommand": "/tn",
    "tabId": 12345,
    "autoRun": true
  }
}
```

**Response (error):**
```json
{
  "id": "14",
  "command": "run_slash_command",
  "status": "error",
  "error": "No ServiceNow tab found matching: https://*.service-now.com/*"
}
```


**Why `/tn` matters:**
When debugging form issues, you need to know the actual field names (not just labels). The `/tn` command toggles the display of technical field names on any ServiceNow form.

**Before `/tn`:**
```
Short Description: [Server is down]
Priority: [1 - Critical]
Assignment Group: [Network Support]
```

**After `/tn`:**
```
short_description: [Server is down]
priority: [1 - Critical]
assignment_group: [Network Support]
```

**Recommended debugging workflow:**
```
1. User reports form issue: "The priority field won't save"

2. AI activates the form tab and runs /tn:
   { "command": "run_slash_command", "params": { 
     "command": "/tn",
     "url": "https://*.service-now.com/*incident*"
   }}
   
3. AI takes a screenshot to see the technical field names:
   { "command": "take_screenshot", "params": { 
     "url": "https://*.service-now.com/*incident*" 
   }}
   
4. Now AI knows the exact field name (e.g., "priority") 
   to investigate in Business Rules, Client Scripts, etc.
```

### `activate_tab` ⚡ (Remote - Async)
Find and activate a browser tab by URL pattern. Useful for navigating to specific ServiceNow pages or ensuring a tab is ready before taking screenshots.

**Request:**
```json
{
  "id": "14",
  "command": "activate_tab",
  "params": {
    "url": "https://*.service-now.com/nav_to.do*",
    "reload": true,
    "waitForLoad": true,
    "openIfNotFound": false
  }
}
```

**Parameters:**
- `url` (required): URL pattern to match (supports wildcards like `*`)
- `reload` (optional): Whether to reload the tab after activating (default: `false`)
- `waitForLoad` (optional): Wait for page load to complete before responding (default: `false`)
- `openIfNotFound` (optional): Open a new tab with the URL if no matching tab exists (default: `false`)

**Response (success):**
```json
{
  "id": "14",
  "command": "activate_tab",
  "status": "success",
  "timestamp": 1733779200000,
  "result": {
    "activated": true,
    "tabId": 12345,
    "url": "https://instance.service-now.com/nav_to.do?uri=incident.do?sys_id=abc123",
    "title": "Incident | ServiceNow",
    "opened": false,
    "reloaded": true
  }
}
```

**Response (tab not found):**
```json
{
  "id": "14",
  "command": "activate_tab",
  "status": "error",
  "error": "No tab found matching: https://*.service-now.com/nav_to.do*"
}
```

**Use cases:**
- Activate a ServiceNow tab before taking a screenshot
- Reload a page to see updated changes
- Navigate to a specific record form
- Ensure a widget preview tab is ready

**URL Pattern Examples:**
| Pattern | Matches |
|---------|---------|
| `https://*.service-now.com/*` | Any ServiceNow page |
| `https://myinstance.service-now.com/sp?id=my_widget*` | Specific widget page |
| `https://*.service-now.com/nav_to.do*` | Any classic UI page |
| `https://*.service-now.com/$sp.do?id=sp-preview*` | Widget preview pages |

**Workflow: Activate tab → Take screenshot:**
```
1. Activate tab with reload to ensure fresh content
   { "command": "activate_tab", "params": { 
     "url": "https://*.service-now.com/sp?id=my_widget*", 
     "reload": true, 
     "waitForLoad": true 
   }}
   
2. Take screenshot (tab is already active and ready)
   { "command": "take_screenshot", "params": { 
     "url": "https://instance.service-now.com/sp?id=my_widget" 
   }}
```

### `switch_context` ⚡ (Remote - Async)
Switch ServiceNow context: update set, application scope, or domain. This uses the ServiceNow UI Concourse Picker API to change the active context in the browser session.

**Request:**
```json
{
  "id": "15",
  "command": "switch_context",
  "params": {
    "switchType": "updateset",
    "value": "abc123def456789012345678901234",
    "reloadTab": true,
    "tabUrl": "https://*.service-now.com/*"
  }
}
```

**Parameters:**
- `switchType` (required): Type of context to switch. Must be one of:
  - `updateset` - Switch the current update set
  - `application` (or `app`) - Switch the application scope
  - `domain` - Switch the domain (for domain-separated instances)
- `value` (required): The sys_id of the target update set, application, or domain
- `reloadTab` (optional): Whether to reload a ServiceNow tab after switching (default: `true`)
- `tabUrl` (optional): URL pattern to find the tab to reload (default: `https://*.service-now.com/*`)

**Response (success):**
```json
{
  "id": "15",
  "command": "switch_context",
  "status": "success",
  "timestamp": 1733779200000,
  "result": {
    "success": true,
    "switchType": "updateset",
    "value": "abc123def456789012345678901234",
    "reloaded": true
  }
}
```

**Response (error):**
```json
{
  "id": "15",
  "command": "switch_context",
  "status": "error",
  "error": "Invalid switchType. Must be one of: updateset, application, domain"
}
```

**Use cases:**
- Switch to a specific update set before creating artifacts
- Change application scope to deploy code to the correct app
- Switch domain context in domain-separated instances

**Finding the sys_id:**

Before switching context, you may need to query for the sys_id:

```
1. Find update set sys_id:
   { "command": "query_records", "params": { 
     "table": "sys_update_set", 
     "query": "name=My Update Set^state=in progress", 
     "fields": "sys_id,name,state" 
   }}
   
2. Find application sys_id:
   { "command": "query_records", "params": { 
     "table": "sys_scope", 
     "query": "scope=x_myapp", 
     "fields": "sys_id,scope,name" 
   }}
   
3. Find domain sys_id:
   { "command": "query_records", "params": { 
     "table": "domain", 
     "query": "name=My Domain", 
     "fields": "sys_id,name" 
   }}
```

**Examples:**

Switch to a specific update set:
```json
{ 
  "id": "sw1", 
  "command": "switch_context", 
  "params": { 
    "switchType": "updateset", 
    "value": "abc123def456..." 
  } 
}
```

Switch application scope (e.g., before creating artifacts):
```json
{ 
  "id": "sw2", 
  "command": "switch_context", 
  "params": { 
    "switchType": "application", 
    "value": "xyz789ghi012..." 
  } 
}
```

Switch domain:
```json
{ 
  "id": "sw3", 
  "command": "switch_context", 
  "params": { 
    "switchType": "domain", 
    "value": "dom456jkl789..." 
  } 
}
```

**Workflow: Find update set → Switch → Create artifact:**
```
1. Query for update set
   { "command": "query_records", "params": { 
     "table": "sys_update_set", 
     "query": "nameLIKEMyFeature^state=in progress", 
     "fields": "sys_id,name" 
   }}
   
2. Switch to the update set (using sys_id from response)
   { "command": "switch_context", "params": { 
     "switchType": "updateset", 
     "value": "<sys_id from step 1>" 
   }}
   
3. Create artifact (now goes into correct update set)
   { "command": "create_artifact", "params": { 
     "table": "sys_script_include", 
     "scope": "global", 
     "fields": { "name": "MyNewUtils", "script": "..." } 
   }}
```

### `upload_attachment` ⚡ (Remote - Async)
Upload a file (image, document, etc.) as an attachment to any ServiceNow record.

**Request (using filePath - recommended):**
```json
{
  "id": "15",
  "command": "upload_attachment",
  "params": {
    "table": "incident",
    "sys_id": "abc123def456789012345678901234",
    "filePath": "screenshots/screenshot_2024-12-09.png"
  }
}
```

**Request (using imageData - base64):**
```json
{
  "id": "15",
  "command": "upload_attachment",
  "params": {
    "table": "incident",
    "sys_id": "abc123def456789012345678901234",
    "fileName": "screenshot_2024-12-09.png",
    "imageData": "iVBORw0KGgoAAAANSUhEUgAA...",
    "contentType": "image/png"
  }
}
```

**Parameters:**
- `table` (required): The ServiceNow table the record belongs to (e.g., `incident`, `sp_widget`, `kb_knowledge`)
- `sys_id` (required): The sys_id of the record to attach the file to
- `filePath` (optional): Path to the file to upload. Can be absolute or relative to instance folder. If provided, `fileName` and `contentType` are auto-detected from the file.
- `fileName` (required if no filePath): Name for the attachment file. Auto-detected from `filePath` if not provided.
- `imageData` (required if no filePath): Base64-encoded file content. Auto-read from `filePath` if not provided.
- `contentType` (optional): MIME type. Auto-detected from file extension if not provided (default: `image/png`)

**Response (success):**
```json
{
  "id": "15",
  "command": "upload_attachment",
  "status": "success",
  "timestamp": 1733779200000,
  "result": {
    "uploaded": true,
    "fileName": "screenshot_2024-12-09.png",
    "table": "incident",
    "recordSysId": "abc123def456789012345678901234",
    "attachment": {
      "sys_id": "xyz789...",
      "size_bytes": "45678",
      "content_type": "image/png"
    }
  }
}
```

**Response (error):**
```json
{
  "id": "15",
  "command": "upload_attachment",
  "status": "error",
  "error": "HTTP 403: Access denied"
}
```

**Use cases:**
- Attach screenshots to incidents or tasks
- Upload documentation images to knowledge articles
- Attach design assets to widgets or UI pages
- Add evidence/proof to change requests

**Combining with `take_screenshot`:**

A powerful workflow is to take a screenshot and then upload it as an attachment:

```
1. Take screenshot of a widget/page
   { "command": "take_screenshot", "params": { "url": "..." } }
   Response includes: "filePath": "/workspace/screenshots/screenshot_2024-12-09_143022.png"
   
2. Upload as attachment using the ABSOLUTE filePath from the response
   { "command": "upload_attachment", "params": { 
     "table": "incident", 
     "sys_id": "...", 
     "filePath": "/workspace/screenshots/screenshot_2024-12-09_143022.png"
   }}
```

**⚠️ IMPORTANT: File Path Resolution**

The `upload_attachment` command resolves relative paths from the **instance folder**, not the workspace root.

- Screenshots are saved to `{workspace}/screenshots/` (workspace root)
- Instance folder is `{workspace}/{instance}/` (e.g., `empakooi/`)

**Always use ABSOLUTE paths** for files outside the instance folder:

```json
// ❌ WRONG - relative path will look in instance folder
{ "filePath": "screenshots/screenshot.png" }
// Resolves to: /workspace/empakooi/screenshots/screenshot.png (NOT FOUND)

// ✅ CORRECT - use absolute path from take_screenshot response
{ "filePath": "/Users/me/workspace/screenshots/screenshot.png" }
// Finds the actual file
```

**Best practice:** Copy the `filePath` value directly from the `take_screenshot` response.

**Note:** Using `filePath` eliminates the need to manually read and base64-encode files. The extension handles this automatically.

**Supported content types (auto-detected from file extension):**
| Extension | contentType |
|-----------|-------------|
| `.png` | `image/png` |
| `.jpg`, `.jpeg` | `image/jpeg` |
| `.gif` | `image/gif` |
| `.webp` | `image/webp` |
| `.svg` | `image/svg+xml` |
| `.pdf` | `application/pdf` |
| `.txt` | `text/plain` |
| `.json` | `application/json` |
| `.xml` | `application/xml` |
| `.html` | `text/html` |
| `.css` | `text/css` |
| `.js` | `application/javascript` |
| `.zip` | `application/zip` |
| `.doc` | `application/msword` |
| `.docx` | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` |
| `.xls` | `application/vnd.ms-excel` |
| `.xlsx` | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` |
| Other | `application/octet-stream` |

---

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
- ✅ `open_in_browser` - Opens pages in the authenticated browser
- ✅ `take_screenshot` - Captures via the SN Utils extension
- ✅ `activate_tab` - Switches/reloads tabs in the authenticated browser
- ✅ `refresh_preview` - Refreshes widget previews

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
   | `sys_client_script` | Yes | Table reference | Client Script needs a target table |
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
   - `sys_client_script` - "Which form should this Client Script run on?"

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
| Open ServiceNow page | `open_in_browser` | `browser_navigate` |
| Take screenshot | `take_screenshot` | `browser_take_screenshot` |
| Click element | Not available (use ServiceNow API) | `browser_click` |
| Read page content | `query_records` | `browser_snapshot` |
| Refresh page | `activate_tab` with reload | `browser_navigate` |
| Run slash command | `run_slash_command` | Manual typing |

The Agent API uses the **authenticated browser session** via SN Utils, while Cursor browser tools open an **unauthenticated separate session**.

