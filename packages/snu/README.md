# SN Utils Bridge (`@snutils/snu`)

Unified CLI and Model Context Protocol (MCP) server for ServiceNow development, powered by **SN Utils** and **ScriptSync**.

---

## Features

- **Zero Manual Credentials:** Connects to your live browser session via SN Utils, automatically inheriting authenticated SSO/MFA sessions, cookies, update set, and application scope.
- **Dual Mode (CLI + MCP):** Use it as a terminal command tool (`snu query`, `snu search`, `snu schema`) or as a local stdio MCP server (`snu --mcp`) in any compatible AI client.
- **Works Attached & Standalone:** Operates seamlessly when VS Code is open (Attached Mode), or completely standalone without VS Code (Standalone Mode with in-process bridge and auto-handover).
- **14 Strictly-Typed Tools:** Fast GraphQL code search, schema dictionary inspection, record queries, CRUD operations, background script execution, and live form automation.

---

## 1. Installation & Quickstart

### Requirements

- Node.js 20 or newer.
- Attached mode requires ScriptSync 4.8.0 or newer.
- A connected SN Utils helper tab is required for ServiceNow operations. In standalone mode, start the bridge first and then run `/token` on the ServiceNow instance you want to use. The live session remains in memory only and is cleared when the helper disconnects.

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

# Standalone: keep this running, then run /token in ServiceNow
snu serve

# In another terminal, run 'snu' anywhere
snu context
snu query sys_script_include "active=true"
snu run "gs.print('Hello from ' + gs.getUserName());"
```

---

## 2. Use as an MCP Server

`@snutils/snu` exposes the same ServiceNow capabilities as 14 MCP tools. The MCP client starts `snu --mcp` as a local stdio process; no remote MCP endpoint or API key is required.

### Configure your MCP client

The fastest path is the built-in installer. It detects Claude Code, Cursor, Claude Desktop, and Windsurf, and writes the entry below into each one's configuration (merge-only and idempotent; existing config keys are never touched):

```bash
npx -y @snutils/snu@latest setup
```

Useful variants: `snu setup --print` shows copy-paste blocks for every dialect without writing anything, `snu setup --client cursor` targets one client, `--project` writes project-scoped config (Cursor, VS Code, Claude Code), and `--client vscode` writes a workspace `.vscode/mcp.json`. The config is static and secret-free (discovery of the bridge port and auth token happens at call time), so project-scoped files are safe to commit and share with a team.

To configure a client manually instead, add this server to its MCP configuration. Depending on the client, this may be an `mcp.json`, `claude_desktop_config.json`, project setting, or an **Add MCP server** screen.

Using `npx` is the easiest option because it does not require a global installation:

```json
{
  "mcpServers": {
    "sn-utils": {
      "command": "npx",
      "args": ["--yes", "--prefer-online", "@snutils/snu@latest", "--mcp"]
    }
  }
}
```

If the package is installed globally, use the shorter command:

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

Restart or refresh the MCP client after changing its configuration. The server should appear as `sn-utils` with 14 tools. `@latest` with `--prefer-online` checks npm for a newer release each time the MCP process starts; a running MCP process is never replaced underneath an active session.

### Connect a ServiceNow instance

1. Start or enable the `sn-utils` server in your MCP client.
2. Open the ServiceNow instance in a browser where you are already signed in.
3. Run `/token` from the SN Utils slash command box. This opens the ScriptSync and AI Agent Helper tab.
4. Keep the helper tab open while the agent is working.
5. Ask the agent to call `snu_get_context` before doing other work. It reports the connected instance, helper status, license tier, host policy, per-instance setting, and their deny-wins combined result.

You normally do **not** need to run `snu serve` separately. `snu --mcp` first looks for the ScriptSync bridge supplied by VS Code or an existing standalone daemon. If neither is available, it starts an in-process standalone bridge automatically. Run `snu serve` only when you also want a persistent bridge for separate terminal commands.

The `/token` connection must be made after a bridge is running. If the MCP client or standalone bridge is restarted, run `/token` again. Session credentials remain in memory and are cleared when the helper disconnects.

### Try it from your agent

Example prompts:

```text
Use snu_get_context and summarize the connected ServiceNow instance and permission gates.

Inspect the incident table schema, then query five active priority 1 incidents.

Find active Script Includes containing "GlideRecordSecure" and summarize what they do.

Read the current incident form and explain which fields are populated. Do not change anything.
```

When more than one instance is connected, tell the agent which instance to use or pass the optional `instance` argument to a tool.

### Available MCP tools

| Category | Tools | Purpose |
| --- | --- | --- |
| Connection | `snu_get_context` | Inspect the bridge, helper, instances, license, and permission gates. |
| Schema and search | `snu_get_schema`, `snu_code_search` | Inspect table metadata and search server-side code. Code Search requires SN Utils Pro. |
| Record reads | `snu_query_records`, `snu_get_record` | Query tables or fetch a record by `sys_id`. |
| Record writes | `snu_create_record`, `snu_create_artifact`, `snu_update_record`, `snu_delete_record` | Create data rows or scriptable artifacts, update fields, or delete a record. |
| Escape hatch | `snu_rest_request` | Call any ServiceNow REST endpoint through the authenticated browser session. |
| Server execution | `snu_run_background_script` | Run server-side JavaScript and return its captured output. |
| Browser and forms | `snu_get_form_state`, `snu_set_form_field`, `snu_run_ui_action`, `snu_navigate`, `snu_take_screenshot` | Inspect and operate the connected ServiceNow browser tab. |

**Choosing a write tool.** `snu_create_record` inserts a plain data row (incident, task, `sys_user`, CMDB CI) and returns the inserted record. `snu_create_artifact` is for scriptable artifacts (Script Include, Business Rule, widget) and also tracks the record in the local workspace. Both sit on the same Create Artifacts permission, which is on by default. The browser tools exist to exercise real form behaviour and to show something on screen; they are not a record-writing path.

The MCP server also publishes routing instructions that most clients surface to the agent, so an agent that only ever sees the tool list still knows which tool creates a record.

### Permissions and human review

The helper tab applies permissions per ServiceNow instance:

- **Off** blocks that class of operation.
- **Approve** sends high-risk operations to the helper's Review Queue for one-time approval.
- **Auto** allows that operation without a review prompt.

Standalone mode also has fail-closed host gates. Background Scripts, record deletion, REST writes, and browser debugger access are disabled by default; artifact creation is enabled by default. Both the host gate and the instance gate must allow an operation.

`snu context` shows these sources separately. **Host** is the standalone daemon/MCP process policy, **Instance** is the setting published by the helper tab for the selected ServiceNow origin, and **Effective** is the combined result. In attached VS Code mode the host column is blank because the current helper's per-instance setting is authoritative; older helpers fall back to VS Code settings.

For an MCP process, host gates can be enabled through environment variables in clients that support an `env` block. Only enable the capabilities you intend to give the agent:

```json
{
  "mcpServers": {
    "sn-utils": {
      "command": "npx",
      "args": ["--yes", "--prefer-online", "@snutils/snu@latest", "--mcp"],
      "env": {
        "SNU_ALLOW_BACKGROUND_SCRIPTS": "1"
      }
    }
  }
}
```

Supported host settings are `SNU_ALLOW_BACKGROUND_SCRIPTS`, `SNU_ALLOW_DELETE_RECORDS`, `SNU_ALLOW_CREATE_ARTIFACTS`, `SNU_ALLOW_BROWSER_DEBUGGER`, and `SNU_ALLOW_REST_REQUEST`. Global defaults can alternatively be stored in `~/.sn-scriptsync/settings.json`.

Interactive CLI commands check for a newer release at most once every 24 hours and print an update hint when one is available. MCP, JSON output, CI, and npm offline mode never perform this check. Set `SNU_DISABLE_UPDATE_CHECK=1` to opt out explicitly.

### MCP troubleshooting

- **`Missing instance URL or authentication token`:** make sure the MCP server is running, then run `/token` again from the intended ServiceNow instance.
- **`E_BROWSER_DISCONNECTED`:** reopen the helper with `/token` and leave that tab open.
- **An operation is disabled:** check both the host setting and the matching per-instance permission in the helper's Agent Access tab.
- **The MCP server is not listed:** refresh or restart the MCP client after editing its configuration. With a global install, verify that the client can resolve `snu`; otherwise use the `npx` configuration.
- **Multiple instances are connected:** pass the tool's `instance` argument or name the target instance in the prompt.

---

## 3. CLI Command Reference

### Context, Standalone Daemon & Code Search
```bash
# Show active connection, helper tab, and instance roster
snu context

# Start a persistent standalone bridge daemon
snu serve

# Inspect, gracefully restart, or stop the standalone bridge
snu status
snu restart
snu stop

# Check for a newer global CLI, then install it explicitly
snu update --check
snu update

# GraphQL field-index code search across script tables (Pro)
snu search "OAuthUtil" --tables sys_script_include,sys_ui_action --limit 20
```

`snu serve` is idempotent: if a healthy bridge already owns the ports, it reports that process instead of failing with `EADDRINUSE`. `snu stop` and `snu restart` only manage a bridge that identifies itself as a standalone `snu` host and whose authenticated port file matches its live PID. They refuse to stop a VS Code-owned bridge or an unrelated process.

`snu update` checks npm and updates a global installation with `npm install --global @snutils/snu@latest`. Use `snu update --check` for a read-only check. When running through `npx`, restart the MCP or CLI process with `@snutils/snu@latest` instead; there is no global installation to replace.

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

# Create a data row (field=value pairs, or --fields with a JSON payload)
snu record create incident "short_description=Printer on 3rd floor is down" urgency=2
snu record create sys_user --fields '{"user_name":"jdoe","first_name":"Jane","last_name":"Doe"}'

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

### Generic REST Calls
```bash
# Any endpoint the typed commands do not cover, through the browser session
snu rest /api/now/table/incident --query "sysparm_limit=1,sysparm_query=active=true"
snu rest /api/now/attachment/<sys_id>/file --method GET
snu rest /api/now/table/incident --method POST --body '{"short_description":"Created from the CLI"}'
```

`GET` is always allowed. `POST`/`PUT`/`PATCH` need the REST Request gate and `DELETE` needs the Delete Records gate; `snu context` shows both the host and per-instance state.

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

Session credentials stay on your machine. The standalone bridge keeps the `/token` session in memory only, clears it when the helper disconnects, and never writes it to disk or sends it over the internet.

---

## License

Copyright © 2020–2026 SN Utils B.V. All rights reserved. Use of this package is governed by the [SN Utils Service Terms](https://snutils.com/legal/service-terms).
