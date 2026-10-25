### `sync_now` ⚡
Send eligible pending files from the VS Code workspace queue. Inspect `get_sync_status` first and use this only when all eligible files belong to the authorized task: it does not filter by instance or file. The standalone host does not provide this queue; use the typed record-write commands there.

`synced: true` means the files were sent, not that their content was verified. Wait until the intended files leave both `pendingFiles` and `syncingFiles`, then read their records with `get_record` and compare the changed fields. An empty queue or `count: 0` does not prove your edits reached the instance.

When `sn-scriptsync.agentApi.reviewWrites` is enabled, the result has `synced: false` and `blocked: true`: tell the user to approve the intended files in VS Code **Pending Saves** (per-file ✓). Saves held for the user after Save All, auto save or refactoring cannot be flushed by an agent either. Do not bypass these holds using a direct write.

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

