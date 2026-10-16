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
    "syncingFiles": ["/path/to/other.js"],
    "syncingCount": 1,
    "isPaused": false
  }
}
```

`syncingFiles` were sent to the instance and wait for the helper tab's confirmation; `sync_now` never sends them twice. A file whose save failed stays in `pendingFiles`, held for the user, with the reason in the Pending Saves panel.

