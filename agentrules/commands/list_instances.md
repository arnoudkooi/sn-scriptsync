### `list_instances`
List every instance in the workspace with its URL and per-instance activity
freshness, plus a suggested default. **Purely local** — it reads the
`*/​_settings.json` files directly, so it needs no browser helper tab and never
returns `E_INSTANCE_REQUIRED`. Use it as the first step when you don't yet know
which instance to target.

`instances` is sorted freshest-first (`lastActiveAgeMs` ascending; never-active
folders last). `recentlyActive` means the instance's `_settings.json` was
rewritten within ~10h — the extension refreshes that file (and `g_ck`) whenever
the helper tab relays for that instance, so it's a freshness proxy, not proof of
a live tab. `defaultInstance` is set **only** when exactly one instance is
recently active; when `needsConfirmation` is `true` (none recent, or two-plus
recent) pick with the user before any write. `connected` is bridge-level (the one
helper tab relays for every instance), not per-instance.

**Request:**
```json
{ "id": "1", "command": "list_instances" }
```

**Response:**
```json
{
  "result": {
    "instances": [
      { "name": "ven08329", "url": "https://ven08329.service-now.com", "recentlyActive": true, "lastActiveAgeMs": 425000, "hasSettings": true },
      { "name": "ven08331", "url": "https://ven08331.service-now.com", "recentlyActive": true, "lastActiveAgeMs": 980000, "hasSettings": true },
      { "name": "empakooi", "url": "https://empakooi.service-now.com", "recentlyActive": false, "lastActiveAgeMs": 10500000000, "hasSettings": true }
    ],
    "count": 3,
    "connected": true,
    "defaultInstance": null,
    "needsConfirmation": true
  }
}
```
