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
| Client Script | `sys_script_client` | Global + Scoped |
| UI Action | `sys_ui_action` | Global + Scoped |
| UI Script | `sys_ui_script` | Global + Scoped |
| UI Page | `sys_ui_page` | Global + Scoped |
| Scripted REST API | `sys_ws_operation` | Global + Scoped |
| Service Portal Widget | `sp_widget` | Scoped only |
| Fix Script | `sys_script_fix` | Global + Scoped |

