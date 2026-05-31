### `check_name_exists_remote`
Check if an artifact exists in ServiceNow (queries the actual instance, not just local files).

**Request:**
```json
{ "id": "9", "command": "check_name_exists_remote", "params": { "table": "sys_script_include", "name": "MyUtils" } }
```

**Response:**
```json
{
  "result": {
    "exists": true,
    "sysId": "abc123def456",
    "record": { "name": "MyUtils", "sys_scope": "global" }
  }
}
```

