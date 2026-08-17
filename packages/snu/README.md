# SN Utils Bridge (`@snutils/snu`)

Unified CLI and Model Context Protocol (MCP) server for ServiceNow development, powered by **SN Utils** and **ScriptSync**.

---

## Features

- **Zero Manual Credentials:** Connects to your live browser session via SN Utils, automatically inheriting authenticated SSO/MFA sessions, cookies, update set, and application scope.
- **Dual Mode (CLI + MCP):** Use it as a terminal command tool (`snu query`, `snu search`, `snu schema`) or as an MCP server (`snu --mcp`) in Cursor, Windsurf, Claude Desktop, and Antigravity.
- **Works Attached & Standalone:** Operates seamlessly when VS Code is open (Attached Mode), or completely standalone without VS Code (Standalone Mode with in-process bridge and auto-handover).
- **14 Strictly-Typed Tools:** Fast GraphQL code search, schema dictionary inspection, record queries, CRUD operations, background script execution, and live form automation.

---

## 1. Installation & Quickstart

### Using `npx` (No Installation Needed)
```bash
# Run a quick query
npx @snutils/snu query incident "active=true" --limit 5

# Inspect table schema
npx @snutils/snu schema sys_user

# Fast code search across script includes
npx @snutils/snu search "GlideRecord"
```

### Global Install
```bash
npm install -g @snutils/snu

# Now run 'snu' anywhere
snu context
snu query sys_script_include "active=true"
snu run "gs.print('Hello from ' + gs.getUserName());"
```

---

## 2. MCP Configuration (Cursor / Claude Desktop / Windsurf)

Add the following block to your editor's MCP configuration (`mcp.json` or `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "sn-utils": {
      "command": "npx",
      "args": ["-y", "@snutils/snu", "--mcp"]
    }
  }
}
```

Or if installed globally:
```json
{
  "mcpServers": {
    "sn-utils": {
      "command": "snu",
      "args": ["--mcp"]
    }
  }
}
```

> **Standalone MCP:** When you launch `snu --mcp`, it automatically detects if VS Code is running. If not, it spins up an in-process standalone bridge so your AI editor connects directly to your browser's SN Utils helper tab with zero extra steps.

---

## 3. CLI Command Reference

### Context, Standalone Daemon & Code Search
```bash
# Show active connection, helper tab, and instance roster
snu context

# Start a persistent standalone bridge daemon
snu serve

# GraphQL field-index code search across script tables (Pro)
snu search "OAuthUtil" --tables sys_script_include,sys_ui_action --limit 20
```

### Query & Schema
```bash
# Inspect table dictionary columns, types, references, choices
snu schema incident

# Query records with encoded queries and field projections
snu query incident "priority=1^active=true" --fields number,short_description,sys_created_on --limit 10

# Output strict JSON for terminal scripting or piping into jq
snu query incident --json | jq '.records[].number'
```

### Record Operations
```bash
# Fetch record by sys_id
snu record get incident <sys_id>

# Update record field (direct value, from file, or piped via stdin)
snu record update incident <sys_id> short_description --value "Database latency resolved"
snu record update sys_script_include <sys_id> script --file ./my_script.js
cat ./script.js | snu record update sys_script_include <sys_id> script

# Create a scriptable artifact (Script Include, Business Rule, etc.)
snu artifact create sys_script_include MyNewHelper --fields '{"script":"var MyNewHelper = Class.create();"}'

# Delete record (--confirm required for safety, or --dry-run to inspect)
snu record delete incident <sys_id> --dry-run
snu record delete incident <sys_id> --confirm
```

### Background Scripts
```bash
# Run server-side JavaScript on the instance
snu run "gs.print('User: ' + gs.getUserName());"
snu run --file ./fix_script.js
```

### Browser & Live Form Automation
```bash
# Read live form fields from active ServiceNow browser tab
snu browser form

# Set form field via g_form (triggers client scripts / policies)
snu browser set short_description "Network disruption"

# Trigger a UI action on the active form
snu browser action sysverb_update

# Navigate active browser tab to a URL
snu browser nav "https://myinstance.service-now.com/incident.do?sys_id=-1"

# Capture viewport screenshot of ServiceNow tab (saved to screenshots/)
snu screenshot
```

---

## 4. How It Works & Handover Protocol

- **Attached Mode (VS Code Open):** `snu` connects to the local **ScriptSync Agent HTTP API** on `127.0.0.1:1977` (with token discovery via `.vscode/sn-agent-port.json` or `~/.sn-scriptsync/agent-port.json`), which relays commands over a local WebSocket to the **SN Utils browser extension**.
- **Standalone Mode (VS Code Closed):** `snu serve` (or `snu --mcp`) hosts the WebSocket server on `127.0.0.1:1978` and HTTP API on `127.0.0.1:1977`.
- **Safe Handover:** When VS Code launches while a standalone bridge is active, VS Code sends an automated `yield` signal to acquire the WebSocket and HTTP ports cleanly without port collisions.

All credentials stay in your browser—zero tokens or passwords are ever stored or sent over the internet.

---

## License

MIT © [SN Utils B.V. / Arnoud Kooi](https://snutils.com)
