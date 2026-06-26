---
name: snu-coding-standards
description: ServiceNow coding standards (scoped-app restrictions, server vs client APIs, best practices) and security guidance for the sn-scriptsync workflow. Read this when writing or reviewing ServiceNow script content.
---

<!-- SN-SCRIPTSYNC:SKILL apiVersion=17 -->

# SN ScriptSync — Coding Standards & Security

Coding standards and security practices for ServiceNow script content.

## ServiceNow Coding Standards

### ⚠️ CRITICAL: Scoped Application API Restrictions

**In scoped applications (like Service Portal widgets), certain global APIs are NOT allowed:**

```javascript
// ❌ INCORRECT - NOT allowed in scoped apps
var now = new GlideDateTime();
now.setDisplayValue(gs.nowDateTime());  // ERROR: Function nowDateTime is not allowed in scope!

// ✅ CORRECT - Use GlideDateTime constructor directly
var now = new GlideDateTime();  // Automatically initializes to current time
data.currentDay = parseInt(now.getDayOfMonthLocalTime());
data.currentMonth = parseInt(now.getMonthLocalTime());
data.currentYear = parseInt(now.getYearLocalTime());
data.dayOfWeek = now.getDayOfWeekLocalTime();
```

**Key Rules:**
- ✅ `new GlideDateTime()` - Creates current date/time automatically
- ✅ Use `LocalTime` methods: `getDayOfMonthLocalTime()`, `getMonthLocalTime()`, `getYearLocalTime()`
- ❌ `gs.nowDateTime()` - NOT allowed in scoped applications
- ❌ `gs.now()` - NOT allowed in scoped applications
- ❌ Non-LocalTime methods may fail: `getDayOfMonth()`, `getMonth()`, `getYear()`

### Service Portal Widget Client Scripts

**Use Angular dependency injection, not IIFE patterns:**

```javascript
// ❌ WRONG - IIFE loses 'this' context, causes $apply issues
(function() {
  var c = this;
  setInterval(function() { c.$apply(); }, 1000);
})();

// ✅ CORRECT - Proper Angular controller with DI
api.controller = function($scope, $interval, $timeout) {
  var c = this;
  $interval(updateFn, 1000);  // Auto-handles digest cycle
};
```

**Available Angular services:** `$scope`, `$interval`, `$timeout`, `$http`, `$q`, `$location`, `spUtil`, `spModal`

### GlideRecord Best Practices
Always use `setValue()` and `getValue()` methods:

```javascript
// ✅ CORRECT
var grUser = new GlideRecord('sys_user');
if (grUser.get(userId)) {
    var userName = grUser.getValue('name');
    grUser.setValue('active', true);
    grUser.update();
}

// ❌ INCORRECT
var gr = new GlideRecord('sys_user');
if (gr.get(userId)) {
    var userName = gr.name;  // Direct property access
    gr.active = true;        // Direct property assignment
    gr.update();
}
```

### Variable Naming
Use semantic variable names with prefixes:
- `grUser` - GlideRecord for user
- `grIncident` - GlideRecord for incident
- `gaRecords` - GlideAggregate
- Not just `gr` or `ga`

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
