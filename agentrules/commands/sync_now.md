### `sync_now` ⚡
Immediately sync all pending files (flush the queue). Use this after making multiple file changes to ensure they're synced before continuing.

**Request:**
```json
{ "id": "2", "command": "sync_now" }
```

**Response (when files pending):**
```json
{
  "result": {
    "synced": true,
    "message": "Synced 3 file(s) immediately",
    "count": 3,
    "files": ["/path/to/file1.js", "/path/to/file2.js", "/path/to/file3.js"]
  }
}
```

**Response (when no files pending):**
```json
{
  "result": {
    "synced": false,
    "message": "No pending files to sync",
    "count": 0
  }
}
```

