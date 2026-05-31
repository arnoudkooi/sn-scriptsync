### `get_sync_status`
Get current sync queue status.

**Request:**
```json
{ "id": "1", "command": "get_sync_status" }
```

**Response:**
```json
{
  "result": {
    "serverRunning": true,
    "pendingFiles": ["/path/to/file.js"],
    "pendingCount": 1,
    "isPaused": false
  }
}
```

