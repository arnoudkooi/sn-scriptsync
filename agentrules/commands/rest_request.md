### `rest_request` (guarded generic passthrough)

Make an arbitrary ServiceNow REST call through the connected browser session (reuses its authentication). The escape hatch for anything the typed commands don't cover.

**Gating:**
- `GET` — always allowed.
- `POST` / `PUT` / `PATCH` — require `sn-scriptsync.restRequest.enabled`.
- `DELETE` — requires `sn-scriptsync.deleteRecords.enabled`.

**Request:**
```json
{
  "id": "rest_1",
  "command": "rest_request",
  "params": {
    "endpoint": "/api/now/table/incident",
    "method": "GET",
    "queryParams": { "sysparm_limit": "1", "sysparm_query": "active=true" }
  }
}
```

**Parameters:**
- `endpoint` (required): Instance-relative path beginning with `/` (e.g. `/api/now/table/incident`).
- `method` (optional, default `GET`): one of `GET`, `POST`, `PUT`, `PATCH`, `DELETE`.
- `body` (optional): JSON body for write methods.
- `queryParams` (optional): Object of query-string parameters.

**Response:**
```json
{ "status": "success", "result": { "status": 200, "data": { "result": [ { "...": "..." } ] } } }
```

**Errors:**
- `E_DISABLED` — the method is gated off by settings.
- `E_INVALID_PARAMS` — missing/invalid endpoint or method.
- `E_NOT_FOUND` / `E_REFERENCE_INTEGRITY` / `E_ACL` — mapped from the HTTP response.
