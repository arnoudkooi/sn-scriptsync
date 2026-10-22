### `query_records` ⚡
Execute an arbitrary encoded query against any ServiceNow table. Use this to fetch data, check conditions, or explore records.

**Request:**
```json
{ 
  "id": "q1", 
  "command": "query_records", 
  "params": { 
    "table": "incident",
    "query": "priority=1^active=true",
    "fields": "number,short_description,priority,state,sys_created_on",
    "limit": 5,
    "orderBy": "ORDERBYDESCsys_created_on"
  } 
}
```

**Parameters:**
- `table` (required): The ServiceNow table to query
- `query` (optional): Encoded query string (e.g., `priority=1^active=true`)
- `fields` (optional): Comma-separated field names (default: `sys_id,number,short_description,sys_created_on`)
- `limit` (optional): Max records to return (default: 10)
- `orderBy` (optional): Order clause (e.g., `ORDERBYDESCsys_created_on`)
- `validate` (optional, default `true`): `false` runs the query without checking its field paths.

**Field paths are checked before the query runs.** ServiceNow silently ignores a condition on a field that does not exist and returns unfiltered rows, so every path in `query`, `fields` (when you pass it) and `orderBy` is checked hop by hop against the table schema, including dot-walks and the field inside `ORDERBY`, `DYNAMIC`, `OR`/`NQ` branches. Values are not judged: `javascript:gs.beginningOfToday()` is fine once its field exists. Keyword search (`123TEXTQUERY321`) and related-list blocks are supported.
- `E_INVALID_QUERY` — a path does not exist (e.g. `question.cat_item` on `question_choice`: `question` has no `cat_item`; use `question.ref_item_option_new.cat_item`), or a non-reference field is dot-walked. `details.problems` lists each one with the failing `hop` and `table`. The query was not run: fix the path.
- `E_QUERY_UNVERIFIABLE` — a path could not be checked (the table's columns could not be read, or an operator was not recognised). The query was not run. Pass `validate: false` only when you are sure the query is right, for example a field your session cannot see the definition of.

**Response:**
```json
{
  "status": "success",
  "result": {
    "table": "incident",
    "count": 3,
    "records": [
      {
        "sys_id": "abc123",
        "number": "INC0010001",
        "short_description": "Server down",
        "priority": "1",
        "state": "2",
        "sys_created_on": "2024-12-07 10:30:00"
      },
      ...
    ]
  }
}
```

**Common Query Examples:**

| Use Case | Query |
|----------|-------|
| **Get single record by sys_id** | `sys_id=abc123def456...` |
| Active P1 incidents | `priority=1^active=true` |
| Recent changes | `ORDERBYDESCsys_created_on` |
| My assigned tasks | `assigned_to=javascript:gs.getUserID()^active=true` |
| Open problems | `state!=7^state!=8` |
| Items in scope | `sys_scope.scope=x_myapp` |
| Name contains | `nameLIKEutils` |
| Created today | `sys_created_onONToday@javascript:gs.beginningOfToday()@javascript:gs.endOfToday()` |

**Encoded Query Operators:**
- `=` equals
- `!=` not equals
- `LIKE` contains
- `NOT LIKE` does not contain (the space is required)
- `STARTSWITH` starts with
- `ENDSWITH` ends with
- `>` greater than
- `<` less than
- `>=` greater or equal
- `<=` less or equal
- `IN` in list (comma-separated)
- `NOT IN` not in list (comma-separated; the space is required)
- `ISEMPTY` is empty
- `ISNOTEMPTY` is not empty
- `^` AND
- `^OR` OR
- `^NQ` new query (OR group)

