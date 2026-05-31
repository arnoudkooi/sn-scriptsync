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

