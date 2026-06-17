### `get_capabilities` ⚡ (preflight Pro / debugger / settings gates)
Ask the connected SN Utils helper tab what it can do **right now** — the license tier, whether the Chrome DevTools Protocol **browser debugger** (network/console capture, full-page screenshots, native dialog handling) is usable, and the **`gates`** block telling you which write/create/delete/script permissions are enabled. Call this once up front so you can preflight `E_DISABLED` instead of discovering it mid-operation, and before reaching for the `snu-browser-debug` skill instead of firing a CDP command and parsing the error.

Requires a connected helper tab (`E_BROWSER_DISCONNECTED` otherwise — run `check_connection` first).

**Request:**
```json
{ "id": "cap_1", "command": "get_capabilities" }
```

**Response (Pro, debugger usable):**
```json
{
  "status": "success",
  "result": {
    "tier": "pro",
    "proFeatures": true,
    "cdp": { "available": true, "reason": null },
    "gates": {
      "createArtifacts": true,
      "restRequest": false,
      "deleteRecords": false,
      "backgroundScripts": false,
      "browserDebugger": true,
      "fileFallback": true
    }
  }
}
```

**Response (debugger beta not enabled — the default):**
```json
{
  "status": "success",
  "result": {
    "tier": "pro",
    "proFeatures": true,
    "cdp": { "available": false, "reason": "E_DISABLED" },
    "gates": {
      "createArtifacts": true,
      "restRequest": false,
      "deleteRecords": false,
      "backgroundScripts": false,
      "browserDebugger": false,
      "fileFallback": true
    }
  }
}
```

- `tier` — `community` | `pro` | `trial` | `enterprise` (license of the connected helper tab).
- `proFeatures` — `true` when the tier unlocks Pro features (e.g. `code_search`).
- `cdp.available` — `true` only when the browser-debugger beta is enabled (`sn-scriptsync.browserDebugger.enabled`) **and** the debugger adapter is present (Pro build) **and** the license is Pro/Trial/Enterprise.
- `cdp.reason` — when `available` is `false`, the code you would otherwise have hit: `E_DISABLED` (beta off — enable `sn-scriptsync.browserDebugger.enabled`), `E_CDP_UNAVAILABLE` (Community build / no debugger adapter) or `E_PRO_REQUIRED` (adapter present but license isn't Pro).
- `gates` — the VS Code settings that produce `E_DISABLED`, so you can preflight before calling a gated command:
  - `createArtifacts` — `create_artifact`, `create_application`, `create_table`, `add_column` (default **on**).
  - `restRequest` — POST/PUT/PATCH via `rest_request` (default off).
  - `deleteRecords` — `delete_record`, DELETE via `rest_request`, delete UI verbs in `run_ui_action` (default off).
  - `backgroundScripts` — `run_background_script` and the `delete_application` cascade (default off).
  - `browserDebugger` — the CDP browser-debugger beta (default off); same flag reflected in `cdp.available`.
  - `fileFallback` — legacy file-based transport (`agent/requests/*.json`) is active alongside HTTP (default on).
- When a gate is `false`, tell the user exactly which setting to enable (e.g. `sn-scriptsync.deleteRecords.enabled`) rather than retrying.
