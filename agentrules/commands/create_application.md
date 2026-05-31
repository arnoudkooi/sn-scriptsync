### `create_application`

Create a scoped application (`sys_app`). The **scope is set at insert time** — it is read-only afterwards, so this is the correct way to establish a new scope. The resolved scope name → sys_id is recorded in `scopes.json` so later `create_artifact` / `add_column` calls can target it.

**Request:**
```json
{
  "id": "app_1",
  "command": "create_application",
  "params": { "name": "My Cool App", "prefix": "acme", "short_description": "Demo app" }
}
```

**Parameters:**
- `name` (required): Friendly application name.
- `scope` (optional): Explicit scope (e.g. `x_acme_mycoolapp`). If omitted, derived as `x_<prefix>_<slug(name)>`.
- `prefix` (required when `scope` omitted): Vendor/company code used to derive the scope.
- `short_description` (optional), `version` (optional, default `1.0.0`).

**Response:**
```json
{ "status": "success", "result": { "created": true, "name": "My Cool App", "scope": "x_acme_my_cool_app", "sys_id": "..." } }
```

**Errors:**
- `E_DISABLED` — `sn-scriptsync.createArtifacts.enabled` is off.
- `E_INVALID_PARAMS` — neither `scope` nor `prefix` provided.
