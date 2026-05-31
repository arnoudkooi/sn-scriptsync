### `get_served_url`

Resolve the URL an artifact is actually *served* at — without opening a tab. UI pages render at `<instance>/<name>.do`, Service Portal pages at `/sp?id=...`, widgets in the preview harness — not at their record form. Handy before `navigate_and_screenshot` or for sharing a link.

**Handles the scoped prefix automatically.** A UI page named `todo_app` in scope `x_acme_app` is *stored* with the unprefixed name `todo_app`, but ServiceNow *serves* it at `/x_acme_app_todo_app.do`. This command reads the record's scope (`sys_scope.scope`) and prepends it (guarding against double-prefixing if the name already carries the scope), so you get `/x_acme_app_todo_app.do` — not the 404-prone `/todo_app.do`.

**Request:**
```json
{ "id": "url_1", "command": "get_served_url", "params": { "table": "sys_ui_page", "name": "my_page" } }
```

**Parameters:**
- `table` (required).
- `sys_id` — or `name` (+ optional `scope`) to resolve the sys_id from the local `_map.json`.

**Response:**
```json
{ "status": "success", "result": { "url": "https://dev.service-now.com/x_acme_app_my_page.do", "table": "sys_ui_page", "name": "my_page" } }
```

**Errors:**
- `E_INVALID_PARAMS` — neither `sys_id` nor `name` provided.
