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

