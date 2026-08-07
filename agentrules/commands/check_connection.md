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
    "message": "Connected and ready",
    "helper": { "debuggerAvailable": false, "tier": "pro", "proFeatures": true },
    "browserDebuggerEnabled": false
  }
}
```

**`helper` tells you which SN Utils build is connected.** `debuggerAvailable` is true only on the SN Utils Debug edition; most users run the regular build. You don't need this to take screenshots (`take_screenshot` auto-routes to the best available path), but it tells you what else this session can do:

- `debuggerAvailable: false` → explicit debugger commands (`capture_full_page`, network/console capture, dialog handling) will return `E_CDP_UNAVAILABLE`, and a screenshot on an ungranted tab will require the user's one-time icon click.
- `debuggerAvailable: true` + `proFeatures: true` + `browserDebuggerEnabled: true` → full-page/element captures and network/console/dialog debugging are available, and screenshots never need a permission click.
- `helper: null` → the handshake hasn't arrived yet (or the license lookup failed); retry or fall back to `get_capabilities` for the authoritative, browser-verified view.

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

