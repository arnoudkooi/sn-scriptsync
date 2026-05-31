### `get_last_error`
Get the last error that occurred. Errors are automatically written to `_last_error.json` and pending Agent requests are failed when ServiceNow returns an error.

**Request:**
```json
{ "id": "err", "command": "get_last_error" }
```

**Response (when error exists):**
```json
{
  "result": {
    "hasError": true,
    "isRecent": true,
    "error": "ACL Error, try changing scope in the browser",
    "time": "2024-12-07T12:30:45.123Z",
    "timestamp": 1733567445123,
    "details": { "message": "...", "detail": "..." }
  }
}
```

**Response (no error):**
```json
{
  "result": {
    "hasError": false,
    "message": "No errors recorded"
  }
}
```

