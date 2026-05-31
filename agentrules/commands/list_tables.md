### `list_tables`
List available table folders in the instance.

**Request:**
```json
{ "id": "3", "command": "list_tables" }
```

**Response:**
```json
{
  "result": {
    "tables": ["sys_script_include", "sys_script", "sp_widget"]
  }
}
```

