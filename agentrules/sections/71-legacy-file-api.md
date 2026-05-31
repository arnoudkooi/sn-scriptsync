## Legacy File-Based Agent API

Kept for backward compatibility. Prefer the HTTP transport above.

### How to Use

### 1. Send a Request
Create a uniquely-named file in `{instance_folder}/agent/requests/`:

```bash
# File: {instance_folder}/agent/requests/req_abc123.json
```

```json
{
  "id": "abc123",
  "command": "command_name",
  "params": { },
  "timestamp": 1733567890
}
```

### 2. Wait for Response
The extension responds **instantly** (typically <100ms). Check for `res_abc123.json`:

**Optimized polling pattern:**
```bash
# Unix/macOS/Linux
RESPONSE_FILE="agent/responses/res_abc123.json"
while [ ! -f "$RESPONSE_FILE" ]; do sleep 0.1; done
cat "$RESPONSE_FILE"

# Windows (PowerShell)
$file = "agent/responses/res_abc123.json"
while (!(Test-Path $file)) { Start-Sleep -Milliseconds 100 }
Get-Content $file
```

**Or use file system watcher** (if available):
```bash
# macOS with fswatch: fswatch -1 agent/responses/res_abc123.json
# Linux with inotifywait: inotifywait -e create agent/responses/
```

**Response format:**
```json
{
  "id": "abc123",
  "command": "command_name",
  "status": "success",
  "result": { },
  "timestamp": 1733567891,
  "appName": "Cursor"
}
```

### 3. Cleanup
After processing the response, **delete both files**:
```bash
# Unix/macOS/Linux
rm agent/requests/req_abc123.json agent/responses/res_abc123.json

# Windows (PowerShell)
Remove-Item agent/requests/req_abc123.json,agent/responses/res_abc123.json

# Windows (CMD)
del agent\requests\req_abc123.json agent\responses\res_abc123.json
```

**Benefits:**
- ✅ **Instant responses** - extension processes immediately (no queue delays)
- ✅ **Parallel requests** - multiple requests can be in-flight simultaneously
- ✅ **No file conflicts** - each request gets its own unique files
- ✅ **App identification** - `appName` property shows which editor responded

---

### Complete Example (Unix/macOS/Linux)

```bash
# 1. Create request
cat > agent/requests/req_conn1.json << 'EOF'
{
  "id": "conn1",
  "command": "check_connection"
}
EOF

# 2. Wait for response (optimized polling)
while [ ! -f agent/responses/res_conn1.json ]; do sleep 0.1; done

# 3. Read response
cat agent/responses/res_conn1.json
# Output: {"id":"conn1","status":"success","result":{"ready":true},"appName":"Cursor"}

# 4. Cleanup
rm agent/requests/req_conn1.json agent/responses/res_conn1.json
```

### Complete Example (Windows PowerShell)

```powershell
# 1. Create request
@"
{
  "id": "conn1",
  "command": "check_connection"
}
"@ | Out-File -FilePath agent/requests/req_conn1.json -Encoding utf8

# 2. Wait for response (optimized polling)
while (!(Test-Path agent/responses/res_conn1.json)) { Start-Sleep -Milliseconds 100 }

# 3. Read response
Get-Content agent/responses/res_conn1.json
# Output: {"id":"conn1","status":"success","result":{"ready":true},"appName":"Cursor"}

# 4. Cleanup
Remove-Item agent/requests/req_conn1.json,agent/responses/res_conn1.json
```

