### `get_capabilities` ⚡ (preflight Pro / debugger / security gates)
Ask the connected SN Utils helper tab what it can do **right now** — the Agent API version, the license tier, whether the Chrome DevTools Protocol **browser debugger** (network/console capture, full-page screenshots, native dialog handling) is usable, which protocol **`capabilities`** the helper supports (two-phase command review, per-instance security gates), and the per-instance **`instanceGates`** snapshots. Call this once up front so you can preflight `E_DISABLED` instead of discovering it mid-operation, and before reaching for the `snu-browser-debug` skill instead of firing a CDP command and parsing the error.

Requires a connected helper tab (`E_BROWSER_DISCONNECTED` otherwise — run `check_connection` first).

**Request:**
```json
{ "id": "cap_1", "command": "get_capabilities" }
```

**Response (v8 helper with per-instance gates):**
```json
{
  "status": "success",
  "result": {
    "apiVersion": 8,
    "tier": "pro",
    "proFeatures": true,
    "cdp": { "available": true, "reason": null },
    "capabilities": { "protocolVersion": 1, "commandReview": 1, "instanceSecurityGates": 1 },
    "instanceGates": {
      "https://example.service-now.com": {
        "revision": 3,
        "gates": {
          "backgroundScripts": "approve",
          "deleteRecords": "off",
          "createArtifacts": "auto",
          "browserDebugger": "off",
          "restRequest": "auto"
        }
      }
    }
  }
}
```

**Response (older SN Utils build — no review protocol):**
```json
{
  "status": "success",
  "result": {
    "apiVersion": 8,
    "tier": "pro",
    "proFeatures": true,
    "cdp": { "available": false, "reason": "E_CDP_UNAVAILABLE" },
    "capabilities": { "protocolVersion": 1 },
    "instanceGates": {}
  }
}
```

- `tier` — `community` | `pro` | `trial` | `enterprise` (license of the connected helper tab).
- `proFeatures` — `true` when the tier unlocks Pro features (e.g. `code_search`).
- `cdp.available` — `true` only when the debugger adapter is present (Debug edition build) **and** the license is Pro/Trial/Enterprise.
- `cdp.reason` — when `available` is `false`, the code you would otherwise have hit: `E_CDP_UNAVAILABLE` (Community build / no debugger adapter) or `E_PRO_REQUIRED` (adapter present but license isn't Pro).
- `capabilities` — what the connected helper's protocol supports. `commandReview: 1` means high-risk commands (`run_background_script`, `delete_record`, destructive `run_ui_action`, `delete_application`) go through the helper-tab **Review Queue**: expect `E_REVIEW_PENDING`, then collect the outcome with `get_review_result`. When `commandReview` is absent the helper is an older SN Utils build: those commands run directly and are gated by the `sn-scriptsync.*.enabled` VS Code settings instead.
- `instanceGates` — per-instance tri-state grants keyed by instance origin, published only by helpers with `instanceSecurityGates: 1`. `off` refuses the command (`E_DISABLED`), `auto` runs it without review, `approve` routes it through the Review Queue. A gate that is missing for an instance counts as `off` (deny-wins). Checking gates up front lets you warn the user *before* issuing a command that will need their approval.
- When a command is refused with `E_DISABLED`, relay the error message to the user (it names the helper-tab gate or the VS Code setting to enable) rather than retrying.
