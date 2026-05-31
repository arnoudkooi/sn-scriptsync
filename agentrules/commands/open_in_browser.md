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

