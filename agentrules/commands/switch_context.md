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

