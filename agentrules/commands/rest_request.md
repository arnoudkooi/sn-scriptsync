### `rest_request` (guarded generic passthrough)

Make an arbitrary ServiceNow REST call through the connected browser session (reuses its authentication). The escape hatch for anything the typed commands don't cover.

**Gating:**
- `GET` — always allowed.
- `POST` / `PUT` / `PATCH` — require `sn-scriptsync.restRequest.enabled` (VS Code) or `SNU_ALLOW_REST_REQUEST=1` (standalone `snu` host).
- `DELETE` — requires `sn-scriptsync.deleteRecords.enabled` (VS Code) or `SNU_ALLOW_DELETE_RECORDS=1` (standalone `snu` host).
- `POST /api/now/v1/batch` (the Batch API) is gated by the requests inside its `rest_requests` array, not by the outer `POST`: a batch holding a `DELETE` sub-request, or whose body cannot be read, needs the delete permission as well as the REST write permission and goes through the Review Queue with its sub-requests listed on the card. A batch of reads and writes needs the REST write permission only. For bulk deletes prefer `delete_record` with `query` + `limit`: one review, an outcome per record.

Both hosts implement this command. Over MCP it is also reachable as the `snu_rest_request` tool, and a plain record insert has a dedicated wrapper, `snu_create_record`, that returns the inserted record instead of a raw HTTP envelope.

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
