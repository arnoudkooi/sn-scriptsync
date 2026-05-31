### `upload_attachment` ⚡ (Remote - Async)
Upload a file (image, document, etc.) as an attachment to any ServiceNow record.

**Request (using filePath - recommended):**
```json
{
  "id": "15",
  "command": "upload_attachment",
  "params": {
    "table": "incident",
    "sys_id": "abc123def456789012345678901234",
    "filePath": "screenshots/screenshot_2024-12-09.png"
  }
}
```

**Request (using imageData - base64):**
```json
{
  "id": "15",
  "command": "upload_attachment",
  "params": {
    "table": "incident",
    "sys_id": "abc123def456789012345678901234",
    "fileName": "screenshot_2024-12-09.png",
    "imageData": "iVBORw0KGgoAAAANSUhEUgAA...",
    "contentType": "image/png"
  }
}
```

**Parameters:**
- `table` (required): The ServiceNow table the record belongs to (e.g., `incident`, `sp_widget`, `kb_knowledge`)
- `sys_id` (required): The sys_id of the record to attach the file to
- `filePath` (optional): Path to the file to upload. Can be absolute or relative to instance folder. If provided, `fileName` and `contentType` are auto-detected from the file.
- `fileName` (required if no filePath): Name for the attachment file. Auto-detected from `filePath` if not provided.
- `imageData` (required if no filePath): Base64-encoded file content. Auto-read from `filePath` if not provided.
- `contentType` (optional): MIME type. Auto-detected from file extension if not provided (default: `image/png`)

**Response (success):**
```json
{
  "id": "15",
  "command": "upload_attachment",
  "status": "success",
  "timestamp": 1733779200000,
  "result": {
    "uploaded": true,
    "fileName": "screenshot_2024-12-09.png",
    "table": "incident",
    "recordSysId": "abc123def456789012345678901234",
    "attachment": {
      "sys_id": "xyz789...",
      "size_bytes": "45678",
      "content_type": "image/png"
    }
  }
}
```

**Response (error):**
```json
{
  "id": "15",
  "command": "upload_attachment",
  "status": "error",
  "error": "HTTP 403: Access denied"
}
```

**Use cases:**
- Attach screenshots to incidents or tasks
- Upload documentation images to knowledge articles
- Attach design assets to widgets or UI pages
- Add evidence/proof to change requests

**Combining with `take_screenshot`:**

A powerful workflow is to take a screenshot and then upload it as an attachment:

```
1. Take screenshot of a widget/page
   { "command": "take_screenshot", "params": { "url": "..." } }
   Response includes: "filePath": "/workspace/screenshots/screenshot_2024-12-09_143022.png"
   
2. Upload as attachment using the ABSOLUTE filePath from the response
   { "command": "upload_attachment", "params": { 
     "table": "incident", 
     "sys_id": "...", 
     "filePath": "/workspace/screenshots/screenshot_2024-12-09_143022.png"
   }}
```

**⚠️ IMPORTANT: File Path Resolution**

The `upload_attachment` command resolves relative paths from the **instance folder**, not the workspace root.

- Screenshots are saved to `{workspace}/screenshots/` (workspace root)
- Instance folder is `{workspace}/{instance}/` (e.g., `empakooi/`)

**Always use ABSOLUTE paths** for files outside the instance folder:

```json
// ❌ WRONG - relative path will look in instance folder
{ "filePath": "screenshots/screenshot.png" }
// Resolves to: /workspace/empakooi/screenshots/screenshot.png (NOT FOUND)

// ✅ CORRECT - use absolute path from take_screenshot response
{ "filePath": "/Users/me/workspace/screenshots/screenshot.png" }
// Finds the actual file
```

**Best practice:** Copy the `filePath` value directly from the `take_screenshot` response.

**Note:** Using `filePath` eliminates the need to manually read and base64-encode files. The extension handles this automatically.

**Supported content types (auto-detected from file extension):**
| Extension | contentType |
|-----------|-------------|
| `.png` | `image/png` |
| `.jpg`, `.jpeg` | `image/jpeg` |
| `.gif` | `image/gif` |
| `.webp` | `image/webp` |
| `.svg` | `image/svg+xml` |
| `.pdf` | `application/pdf` |
| `.txt` | `text/plain` |
| `.json` | `application/json` |
| `.xml` | `application/xml` |
| `.html` | `text/html` |
| `.css` | `text/css` |
| `.js` | `application/javascript` |
| `.zip` | `application/zip` |
| `.doc` | `application/msword` |
| `.docx` | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` |
| `.xls` | `application/vnd.ms-excel` |
| `.xlsx` | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` |
| Other | `application/octet-stream` |

---

