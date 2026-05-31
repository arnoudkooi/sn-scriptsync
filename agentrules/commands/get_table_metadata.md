### `get_table_metadata`
Fetch table field definitions from ServiceNow API.

**Request:**
```json
{ "id": "8", "command": "get_table_metadata", "params": { "table": "sys_script_include" } }
```

**Response:**
```json
{
  "result": {
    "columns": {
      "name": { "label": "Name", "type": "string", "mandatory": false, "max_length": 100 },
      "script": { "label": "Script", "type": "script_plain", "mandatory": false },
      "active": { "label": "Active", "type": "boolean", "default": "false" }
    }
  }
}
```

