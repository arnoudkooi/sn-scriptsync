### `check_name_exists`
Check if an artifact name already exists (checks local `_map.json` files only, not ServiceNow).

**Request:**
```json
{ "id": "5", "command": "check_name_exists", "params": { "table": "sys_script_include", "name": "MyUtils" } }
```

**Response:**
```json
{
  "result": {
    "exists": true,
    "sysId": "abc123def456"
  }
}
```

