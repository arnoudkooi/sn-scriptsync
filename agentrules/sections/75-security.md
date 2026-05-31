## Security & Validation

The extension enforces several security measures to protect the workspace and ServiceNow instance:

### Request ID Validation
- **Format**: Request IDs must be alphanumeric with underscores/hyphens only: `^[a-zA-Z0-9_-]+$`
- **Invalid examples**: `../../../etc/passwd`, `req;rm -rf`, `req with spaces`
- **Valid examples**: `req_123`, `abc-def`, `test_001`

**Error response for invalid ID:**
```json
{
  "status": "error",
  "error": "Invalid request ID: only alphanumeric, underscore, and hyphen allowed"
}
```

### Workspace Boundary Enforcement
- All file operations are **restricted to the VS Code workspace**
- Path traversal attempts (e.g., `../../../`) are blocked
- Absolute paths outside workspace are rejected

### File Upload Security (`upload_attachment`)
When using `filePath` parameter:
- Paths are normalized using `path.resolve()` to prevent traversal
- Only files **within the workspace** can be uploaded
- Both relative and absolute paths are validated

**Example secure paths:**
```bash
✅ "screenshots/screenshot1.png"           # Relative to instance
✅ "/full/path/to/workspace/file.pdf"      # Absolute within workspace

❌ "../../../etc/passwd"                   # Blocked: path traversal
❌ "/etc/hosts"                            # Blocked: outside workspace
❌ "C:\\Windows\\System32\\file.txt"       # Blocked: outside workspace
```

### ServiceNow API Access
- Browser helper tab validates instance URLs (allowed/blocked lists)
- User must explicitly approve each ServiceNow instance
- All API calls use the `safeFetch()` wrapper that checks approvals

### Best Practices for Agents
1. ✅ Use simple, descriptive request IDs: `query_incidents_001`
2. ✅ Always use relative paths for file uploads: `screenshots/image.png`
3. ✅ Check response status before processing results
4. ✅ Handle errors gracefully and inform users
5. ❌ Never attempt path traversal or workspace escape
6. ❌ Don't use special characters in request IDs

**Security violation example:**
```json
{
  "id": "../../../evil",
  "command": "upload_attachment",
  "params": {
    "filePath": "../../../etc/passwd"
  }
}
```
**Response:**
```json
{
  "status": "error",
  "error": "Security: File path outside workspace not allowed"
}
```

---

