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
