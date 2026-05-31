### `check_connection` ⚡ (CALL THIS FIRST)
Verify WebSocket server is running and browser helper tab is connected. **Always call this before any other operations.**

**Request:**
```json
{ "id": "0", "command": "check_connection" }
```

**Response (ready):**
```json
{
  "status": "success",
  "result": {
    "ready": true,
    "serverRunning": true,
    "browserConnected": true,
    "clientCount": 1,
    "message": "Connected and ready"
  }
}
```

**Response (server not running):**
```json
{
  "status": "error",
  "error": "WebSocket server not running. Click sn-scriptsync in VS Code status bar to start.",
  "result": {
    "ready": false,
    "serverRunning": false,
    "browserConnected": false,
    "message": "WebSocket server not running"
  }
}
```

**Response (no browser):**
```json
{
  "status": "error",
  "error": "No browser connection. Open SN Utils helper tab via /token command in ServiceNow.",
  "result": {
    "ready": false,
    "serverRunning": true,
    "browserConnected": false,
    "message": "No browser connected - open helper tab with /token"
  }
}
```

