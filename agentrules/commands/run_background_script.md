### `run_background_script` ⚠️ (guarded — runs server-side code)

Execute a server-side background script (`/sys.scripts.do`) on the instance and return its captured output. Runs as the connected browser user, in the global scope. **Disabled by default** — enable `sn-scriptsync.backgroundScripts.enabled`.

**Request:**
```json
{
  "id": "bg_1",
  "command": "run_background_script",
  "params": { "script": "gs.print('Active incidents: ' + new GlideAggregate('incident').getRowCount());" }
}
```

**Parameters:**
- `script` (required): The server-side script to run. Use `gs.print(...)` to emit output you want back.

**Response:**
```json
{ "status": "success", "result": {
  "executed": true,
  "output": "[0:00:00.1] Script completed … <PRE>*** Script: Active incidents: 42<BR/>[CacheFlushLog] …</PRE>",
  "stdout": "Active incidents: 42",
  "warnings": [], "errors": [], "logLines": ["[CacheFlushLog] …"],
  "executionId": "47eea1d697485f14c3e2fc90f053af06",
  "status": "completed"
} }
```
- `output` is the raw page text, unchanged. Read `stdout` for your `gs.print` lines; `errors` holds evaluator errors (`status: "failed"`), `logLines` the platform's own log noise.
- `executionId` is the `sys_script_execution_history` record of the run.

**Errors:**
- `E_DISABLED` — `sn-scriptsync.backgroundScripts.enabled` is off, or the instance gate is set to Off in the helper tab.
- `E_REVIEW_PENDING` — the instance gate is set to Approve: the script is waiting in the helper tab Review Queue. Tell the user to approve it in the SN Utils ScriptSync helper tab in their browser, then collect the output with `get_review_result`.
- `E_USER_REJECTED` — the developer rejected the script in the Review Queue; don't retry without asking.
- `E_UNAUTHORIZED` — the instance refused the session before running the script (session lost, or the user can't run background scripts). Only when the reply proves the script never ran is the token refreshed and the script run once more; otherwise nothing is replayed.
- `E_TIMEOUT` / `E_BROWSER_DISCONNECTED` — the wait ended, **not necessarily the script**: it may still be running or may have finished. Never run a mutating script again after these. Check its effect first (query the records it changes).
- `E_INVALID_PARAMS` — missing `script`.

> The pragmatic escape hatch for bulk data fixes that the typed commands don't cover. Output is whatever `/sys.scripts.do` returns (the `gs.print` lines plus the server's evaluation log).
