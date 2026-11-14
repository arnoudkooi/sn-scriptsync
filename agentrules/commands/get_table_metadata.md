### `get_table_metadata`
Fetch the columns of a table, including the ones it inherits, with type, reference target, mandatory and read-only flags.

**Request:**
```json
{ "id": "8", "command": "get_table_metadata", "params": { "table": "sys_script_include", "choices": false } }
```

**Parameters:**
- `table` (required): table name.
- `choices` (optional, default `false`): include `{ value, label }` choices per choice field. Without it a choice field only carries `choiceCount`.

**Response (VS Code host):** `columns` is the instance's form metadata keyed by column name, as before. `fields` is the same list normalized:
```json
{
  "result": {
    "columns": { "name": { "label": "Name", "type": "string", "mandatory": false, "max_length": 100 } },
    "fields": [
      { "name": "name", "label": "Name", "internalType": "string", "type": "string", "mandatory": false, "readOnly": false, "maxLength": 100 },
      { "name": "sys_scope", "label": "Application", "internalType": "reference", "type": "reference", "reference": "sys_scope", "mandatory": false, "readOnly": false, "maxLength": 32 }
    ]
  }
}
```

**Response (standalone bridge, `snu schema`):** an array of the same normalized columns. Each keeps the API documentation keys `name`, `label`, `internalType` and `exampleValue`.

- A key that is missing means **unknown**, not false: the instance did not report it.
- `exampleValue` is a generated sample from the REST API documentation, the same on every instance. It is never record data. Use `query_records` for real values.
