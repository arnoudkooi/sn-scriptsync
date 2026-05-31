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
| `sys_script_client` | `script` | `table` (table name) | Must specify which table |
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
