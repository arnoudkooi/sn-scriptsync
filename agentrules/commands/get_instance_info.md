### `get_instance_info`
Get instance connection info, including per-instance activity freshness.

Pass `"instance"` to inspect a specific candidate (useful for disambiguating
`E_INSTANCE_REQUIRED`). `connected` is bridge-level — it is `true` for every
instance whenever the WS server is up with the helper tab connected, because the
single helper tab relays for every instance the browser has a session for. Use
`recentlyActive` / `lastActiveAgeMs` (derived from the `_settings.json` mtime) to
tell *which* instance is the most-recently-active session.

**Request:**
```json
{ "id": "2", "command": "get_instance_info", "instance": "ven08329" }
```

**Response:**
```json
{
  "result": {
    "instanceName": "ven08329",
    "hasSettings": true,
    "connected": true,
    "recentlyActive": true,
    "lastActiveAgeMs": 425000
  }
}
```

