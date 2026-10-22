### `download_attachment` (bytes to a file, never to you)
Download one attachment (`sys_attachment` sys_id) to a file in the workspace. The result carries the file path, size, content type and sha256, **never the bytes**, so a binary file never lands in your context. Process the file locally (resize, convert, inspect) and send it back with `upload_attachment` using `relativePath` or `filePath` from the result.

Needs a current SN Utils helper tab (`capabilities.attachmentDownload` in `get_capabilities`); an older one answers `E_UNSUPPORTED_HELPER`. A read: no permission gate.

**Request:**
```json
{ "id": "dl_1", "command": "download_attachment", "params": { "sys_id": "68cf699a97485f14c3e2fc90f053af5d" } }
```

**Parameters:**
- `sys_id` (required): the `sys_attachment` record.
- `filePath` (optional): where to write it. Relative paths resolve under the instance folder; absolute paths must stay inside the workspace. Default: `<instance>/attachments/<sys_id>/<file name>`.
- `overwrite` (optional, default `false`): replace an existing file. Without it an existing file is never touched (`E_FILE_EXISTS`).
- `maxBytes` (optional, default and maximum 50 MB): refuse larger attachments.

**Response:**
```json
{ "status": "success", "result": {
  "downloaded": true, "sys_id": "68cf699a97485f14c3e2fc90f053af5d",
  "filePath": "/workspace/dev1/attachments/68cf699a97485f14c3e2fc90f053af5d/lineup.png",
  "relativePath": "attachments/68cf699a97485f14c3e2fc90f053af5d/lineup.png",
  "fileName": "lineup.png", "sizeBytes": 1748088, "contentType": "image/png",
  "sha256": "…", "sourceTable": "sc_cat_item", "sourceSysId": "73da21de97085f14c3e2fc90f053aff3"
} }
```

The file is written to a temporary file first and published atomically only after its size and sha256 match what the helper read, so a file at `filePath` is always complete.

**Errors:**
- `E_UNSUPPORTED_HELPER` — update SN Utils and reopen the ScriptSync helper tab. Do not fall back to base64 through `run_background_script` or `rest_request`.
- `E_TOO_LARGE` — larger than `maxBytes`.
- `E_FILE_EXISTS` — the target exists; pick another path or pass `overwrite: true`.
- `E_ATOMIC_PUBLISH_UNSUPPORTED` — the volume cannot publish without overwriting; choose another folder.
- `E_TRANSFER_MISMATCH` — the received bytes did not match; nothing was written. Retrying is safe (a read).
- `E_SECURITY` — the path leaves the workspace or goes through a symbolic link.
- `E_NOT_FOUND` — no such attachment.

---
