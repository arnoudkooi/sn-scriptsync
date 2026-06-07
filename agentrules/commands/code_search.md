### `code_search` ⚡ (Pro feature)
Run the SN Utils GraphQL field-index code search across ServiceNow script tables and return structured matches. This is the same engine as the SN Utils code search page — far better than a plain `query_records` `LIKE` at finding where a term actually lives in scripts (script includes, business rules, UI actions, client scripts, fix scripts, etc.). Use it to discover existing code before writing new artifacts.

**Requires:** an active SN Utils **Pro / Trial / Enterprise** license in the connected browser helper tab. Without it the command returns `E_DISABLED`.

**Request:**
```json
{
  "id": "cs_1",
  "command": "code_search",
  "instance": "dev12345",
  "params": {
    "term": "sn_appclient dev mode",
    "activeOnly": false,
    "limit": 50
  }
}
```

**Parameters:**
- `term` (required): Search term. Supports the same `table:` / field filters as the code search page (e.g. `table:sys_script_include setPreference`). Minimum 2 characters.
- `activeOnly` (optional, default `false`): Only match active records.
- `limit` (optional, default `50`): Max records per table.
- `tables` (optional): Comma-separated table-name filter to narrow the search scope.

**Response:**
```json
{
  "status": "success",
  "result": {
    "term": "sn_appclient dev mode",
    "stats": { "tables": 3, "records": 7, "matches": 12, "searchedTables": ["sys_script_include", "sys_script", "sys_ui_action"] },
    "words": ["sn_appclient", "dev", "mode"],
    "results": [
      {
        "tableName": "sys_script_include",
        "tableLabel": "Script Include",
        "rowCount": 2,
        "hits": [
          {
            "sysId": "abc123...",
            "name": "AppClientUtils",
            "sysClassName": "sys_script_include",
            "active": true,
            "matches": [
              {
                "field": "script",
                "fieldLabel": "Script",
                "matchingWords": ["dev", "mode"],
                "context": "...if (current.dev_mode) { ... }...",
                "lineMatches": [
                  { "lineNumber": 42, "content": "  var devMode = gs.getProperty('sn_appclient.dev_mode');", "isMatch": true }
                ]
              }
            ],
            "missingWords": null,
            "parentRef": null
          }
        ]
      }
    ]
  }
}
```

**Response shape:**
- `result.stats` — `tables`, `records`, `matches` (total field matches), and `searchedTables` (the tables actually queried).
- `result.words` — the tokenized search terms the engine looked for.
- `result.results[]` — one entry per matching table: `tableName`, `tableLabel`, `rowCount`, `hits[]`.
- Each **hit**: `sysId`, `name`, `sysClassName` (real class of the record), `active` (`true`/`false`/`null`), `matches[]`, `missingWords` (terms not found in this record, or `null`), and `parentRef` (`{ table, sysId, label }` when the value lives on a parent record, e.g. a variable value — else `null`).
- Each **match**: `field`, `fieldLabel`, `matchingWords` (which terms hit this field), `context` (a short excerpt), and `lineMatches[]` for line-level rendering — `{ lineNumber, content, isMatch }` (each match line plus a little surrounding context; `isMatch` flags the line(s) that actually contain a term).

**Notes:**
- Matches are **excerpts** — `context` plus a handful of `lineMatches`, not full field bodies. To get the complete script of a specific hit, follow up with `get_record` (using the hit's `tableName` + `sysId`).
- The first search after the helper tab opens may take longer while the field index builds; later searches reuse the cached per-instance index.

**Errors:**
- `E_DISABLED` — no SN Utils Pro/Trial/Enterprise license in the connected browser.
- `E_INVALID_PARAMS` — missing/short `term`.
- `E_BROWSER_DISCONNECTED` — no helper tab connected.
