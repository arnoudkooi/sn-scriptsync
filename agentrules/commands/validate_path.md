### `validate_path`
Validate a proposed file path before creating it.

**Request:**
```json
{ "id": "7", "command": "validate_path", "params": { "path": "myinstance/global/sys_script_include/NewUtil.script.js" } }
```

**Response:**
```json
{
  "result": {
    "valid": true,
    "parsed": {
      "instance": "myinstance",
      "scope": "global",
      "table": "sys_script_include",
      "file": "NewUtil.script.js"
    }
  }
}
```

---

