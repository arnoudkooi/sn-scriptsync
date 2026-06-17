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

**Synchronous confirmation:** add `"await": true` to read the new record back after creation. The response then includes `awaited: true`, the `persisted` field values, and a `warnings[]` array flagging any requested field that came back empty (e.g. silently dropped).

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

**⚠️ Large / multi-field payloads (widgets etc.):** A widget's four big code fields (`template`, `css`, `script`, `client_script`) are escaping-hell to pass inline on a shell command line (`curl -d '...'`). Don't hand-build the JSON string — write the request body to a file and send it with `curl -d @body.json` (build the file with `JSON.stringify` so newlines/quotes are encoded correctly), or use the file transport. This applies to any multiline or large field value.

**Errors:**
- `E_DISABLED` — artifact creation is off (`sn-scriptsync.createArtifacts.enabled`). This setting **defaults to `true`**, so creation works out of the box; it only fails here if the user explicitly turned it off. Check `get_capabilities` → `gates.createArtifacts` to preflight.
- `E_INVALID_PARAMS` — missing `table`, missing `fields`, or missing `fields.name`.

**⚠️ `fields.name` is required for every table.** For a *data* table whose display field isn't `name` (e.g. a custom table whose display column is `title`), don't fight this command — seed rows with `rest_request` instead: `POST /api/now/table/<table>` with the row in `body` (requires `sn-scriptsync.restRequest.enabled`). `create_artifact` is for metadata/code artifacts; `rest_request` POST is the blessed path for plain data rows.

