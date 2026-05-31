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

