### `get_file_structure`
Get the expected file naming convention.

**Request:**
```json
{ "id": "6", "command": "get_file_structure" }
```

**Response:**
```json
{
  "result": {
    "pattern": "{instance}/{scope}/{table}/{name}.{field}.{ext}",
    "example": "myinstance/global/sys_script_include/MyUtils.script.js",
    "fields": {
      "sys_script_include": ["script"],
      "sys_script": ["script"],
      "sp_widget": ["script", "css", "client_script", "link", "template"]
    }
  }
}
```

