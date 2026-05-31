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

