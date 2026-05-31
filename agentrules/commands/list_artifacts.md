### `list_artifacts`
List artifacts in a specific table.

**Request:**
```json
{ "id": "4", "command": "list_artifacts", "params": { "table": "sys_script_include" } }
```

**Response:**
```json
{
  "result": {
    "artifacts": ["global/MyUtils.script.js", "global/HelperFunctions.script.js"]
  }
}
```

