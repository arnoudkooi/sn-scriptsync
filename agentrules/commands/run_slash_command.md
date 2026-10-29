### `run_slash_command` ⚡ (Remote - Async)
Execute SN Utils slash commands on a ServiceNow tab. **Particularly useful for debugging forms with `/tn` (show technical names).**

**⚠️ IMPORTANT: Only use DOCUMENTED slash commands!**

**Documented commands include:**
- `/tn` - Toggle technical names on forms
- `/bg` - Open background scripts
- `/token` - Refresh the session for an explicitly targeted instance when auto-run; manual use opens the helper tab for connection
- `/sn` - Search navigator
- `/xml` - Show XML of current record
- `/rnd` - Fill empty mandatory form fields with test data; `/rnd -a` fills all empty editable fields. Requires admin or impersonation. UI16 and Service Portal are Free; Configurable Workspace requires SN Utils Pro (including an active trial). Leaves the form unsaved.
- See SN Utils documentation for full list

**❌ Do NOT use non-existent commands** like `/click`, `/select`, etc.

**Request:**
```json
{
  "id": "14",
  "command": "run_slash_command",
  "params": {
    "command": "/tn",
    "url": "https://*.service-now.com/*",
    "autoRun": true
  }
}
```

**Parameters:**
- `command` (required): The slash command to run (e.g., `/tn`, `/bg`, `tn` - leading slash is optional)
- `url` (optional): URL pattern to find the tab (default: `https://*.service-now.com/*`). Automatic `/token` needs a specific `tabId` or an exact instance URL, optionally ending in `/*`; it has no wildcard default.
- `tabId` (optional): Specific browser tab ID to target
- `autoRun` (optional): Auto-execute the command (default: `true`)
- `focus` (optional, default `false`): Bring the tab to the front. Tabs an agent drives stay in the background so the user can keep working; set `true` when the user asks to see the page.

**Response (success):**
```json
{
  "id": "14",
  "command": "run_slash_command",
  "status": "success",
  "timestamp": 1733779200000,
  "result": {
    "executed": true,
    "status": "completed",
    "summary": { "status": "completed", "state": "enabled", "enabled": true, "total": 8, "visible": 8 },
    "slashCommand": "/tn",
    "tabId": 12345,
    "autoRun": true
  }
}
```

**Response (error):**
```json
{
  "id": "14",
  "command": "run_slash_command",
  "status": "error",
  "error": "No ServiceNow tab found matching: https://*.service-now.com/*"
}
```

**Completion status:**
`result.status` is `dispatched`, `completed`, `cancelled`, or `error`. `executed` is retained for compatibility and only confirms delivery. Always inspect the status before deciding what to do next.

- `dispatched`: delivered to the page, with no completion confirmation. This includes `autoRun: false`, commands without result reporting, custom overrides of `/rnd`, `/tn`, `/bg` or `/xml`, and older helpers without a reported outcome.
- `completed`: the reported action finished. The meaning is specific to the command; opening a tab does not mean its content has loaded or a script has run.
- `cancelled`: the action stopped, for example because the active Workspace record changed during `/rnd`.
- `error`: the action failed. `/rnd` can include partial results and a reason in `summary`. Delivery, navigation and token-refresh failures use the standard Agent API error response with `details.status: "error"`.

**Additional built-in results (updated SN Utils and ScriptSync required):**

| Command | `result.summary` |
| --- | --- |
| `/tn` | `state`: `enabled`, `disabled`, `mixed`, or `unavailable`; `enabled`: true, false, or null for mixed/unavailable; `total` and `visible`: technical-name element counts across reachable frames. Waits for Workspace toggling to finish. These are element counts, not field counts or viewport visibility. |
| `/bg`, `/xml` | `url` and `tabId` of the tab the helper created. `result.tabId` remains the source tab. The new tab stays in the background unless `focus: true`. `/xml` resolves the current active form and requires a saved record. |
| `/token` | `refreshed: true` and `origin` identifying the refreshed instance. No token or credentials are included in the summary. Existing session-refresh permission checks still apply. |

**Random-fill completion (`/rnd`):**
With an updated SN Utils extension, `autoRun: true` waits for the built-in `/rnd` to finish, including dependent fields and retries. The ScriptSync Agent API returns `result.summary`:

Workspace filling requires SN Utils Pro, Enterprise or an active Pro trial. UI16 and Service Portal remain available on Free. Without the required entitlement, a Workspace request returns the standard Agent API error `E_PRO_REQUIRED` with `details.status: "error"`, before writing any fields. The stripped Community build does not include Workspace filling. This gate is identical for manual use and agent requests; do not retry a blocked fill through another command or script.

```json
{
  "status": "completed",
  "ui": "workspace",
  "table": "incident",
  "sysId": "0123456789abcdef0123456789abcdef",
  "mode": "mandatory",
  "total": 4,
  "filled": 3,
  "skipped": 1,
  "pending": 0,
  "revalidated": 3
}
```

- Always inspect `summary.status`: `completed`, `cancelled` (active Workspace form changed), or `error` (for example, no form or insufficient access). Cancellation and errors include `reason` and any partial counts.
- Workspace uses the active record tab at execution time. If that form changes during a fill, pending writes stop and the summary is `cancelled`; run again only when the intended form is active.
- `filled` and `skipped` count unique fields by their last fill attempt; retries do not inflate these counts. `pending` counts targets not attempted, and `total = filled + skipped + pending`. `revalidated` counts retry attempts across fields.
- `ui` is `workspace`, `classic` (UI16), or `portal`. `table` and `sysId` identify the original form and may be null when unavailable. `mode` is `mandatory`, `all` (including `-all`), or `xss` (`-xss`).
- The summary contains no field values. Use `get_form_state` when you need current values. The command does not save or submit the form.
- Commands without completion reporting, `autoRun: false`, older helpers without reported outcomes, and custom overrides of `/rnd` return `dispatched` and may omit `summary`. Do not interpret `executed: true` alone as proof that fields were filled.
- A page timeout returns `E_TIMEOUT`. The fill may still be running; inspect the form before deciding whether to retry.


**Why `/tn` matters:**
When debugging form issues, you need to know the actual field names (not just labels). The `/tn` command toggles the display of technical field names on any ServiceNow form.

**Before `/tn`:**
```
Short Description: [Server is down]
Priority: [1 - Critical]
Assignment Group: [Network Support]
```

**After `/tn`:**
```
short_description: [Server is down]
priority: [1 - Critical]
assignment_group: [Network Support]
```

**Recommended debugging workflow:**
```
1. User reports form issue: "The priority field won't save"

2. AI activates the form tab and runs /tn:
   { "command": "run_slash_command", "params": { 
     "command": "/tn",
     "url": "https://*.service-now.com/*incident*"
   }}
   
3. AI takes a screenshot to see the technical field names:
   { "command": "take_screenshot", "params": { 
     "url": "https://*.service-now.com/*incident*" 
   }}
   
4. Now AI knows the exact field name (e.g., "priority") 
   to investigate in Business Rules, Client Scripts, etc.
```

