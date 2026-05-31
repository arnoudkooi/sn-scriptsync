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
- `STARTSWITH` starts with
- `ENDSWITH` ends with
- `>` greater than
- `<` less than
- `>=` greater or equal
- `<=` less or equal
- `IN` in list (comma-separated)
- `NOTIN` not in list
- `ISEMPTY` is empty
- `ISNOTEMPTY` is not empty
- `^` AND
- `^OR` OR
- `^NQ` new query (OR group)

