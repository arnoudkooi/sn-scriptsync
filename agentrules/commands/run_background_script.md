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
{ "status": "success", "result": { "executed": true, "output": "*** Script: Active incidents: 42" } }
```

**Errors:**
- `E_DISABLED` — `sn-scriptsync.backgroundScripts.enabled` is off.
- `E_INVALID_PARAMS` — missing `script`.

> The pragmatic escape hatch for bulk data fixes that the typed commands don't cover. Output is whatever `/sys.scripts.do` returns (the `gs.print` lines plus the server's evaluation log).
