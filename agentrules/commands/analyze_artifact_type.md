### `analyze_artifact_type`

Read-only. Samples existing artifacts of one type on the instance and compares them into a **type profile**: what records make up one artifact of this type, how often each appears, what the platform creates for you, what the creation path changes, and what the scan could and could not see. Use it before building a composite artifact you have not built on this instance in this project, then build with `create_records` and ask the user about everything labeled `choice`.

**When to use it, and when not:** it costs many reads and returns a large result.
- **Use** before creating a new table or catalog item on an instance where you have not built one in this project, and as a diagnostic when a create succeeded but the result does not behave (a role cannot see the new table, an item does not show its variables).
- **Do not use** for a single record, an edit to an existing artifact, or a type you already have a fresh profile for.

Supported types in this version: `table` (root `sys_db_object`) and `catalog_item` (root `sc_cat_item`). UI Builder pages are not profiled by this command.

**Requires:** browser helper tab connected. No permission gate: every request is a GET through the helper tab, as the connected user. The profile is written to the local workspace (`<instance>/_profiles/`), never to the instance.

**Request:**
```json
{ "id": "prof_1", "command": "analyze_artifact_type", "instance": "dev12345", "params": { "type": "table", "scope": "x_acme_app" } }
```

**Parameters:**
- `type` (required): `table` or `catalog_item`.
- `roots` (optional): up to 30 sys_ids to analyze instead of a sample.
- `query` (optional): extra encoded query to narrow the sample (no `^NQ`, no `javascript:`).
- `scope` (optional): only samples from this application scope.
- `sample` (optional, 1 to 30, default 12): how many samples. Tables created by the `system` user (machine-made, for example CMDB query builder results) are excluded and counted unless `includeGenerated: true`.
- `detail` (optional): classify the records around each sampled root (slower; best with `roots`).
- `refresh` (optional): analyze again even when a saved profile is still fresh. `save: false` skips writing the file.

**Reading the profile:**
- `satellites[]`: one entry per related table, each with three separate facets:
  - `observed`: `{ samples, of, perSample: { min, max } }`, recurrence only;
  - `generated`: `yes` / `no` / `unknown`, from recorded experiments only, with `path` (for example "UI table form only") and `evidence`;
  - `required`: the same, `unknown` unless an experiment or documentation says otherwise.
- `label`: `platform` (generated on every creation path tested: do not create it), `convention` (in every sample, not shown to be required: build it unless told otherwise and say that you did), `choice` (varies between samples: ask the user), `not_observed`, `unknown` (fewer than 3 samples or the probe could not be read).
- `creationPaths[]`: findings about how the artifact must be created, with evidence. For tables: the UI table form creates the role and four record ACLs; an API insert and `create_table` do not, so build them deliberately. For catalog items: setting `sc_catalogs` and `category` creates their link rows; policy actions lose `ui_policy` and `catalog_variable` through the Table API.
- `applicationAccess` (tables): what other scopes may do with the table. A new scoped table lets other scopes, Global included, only read it.
- `flows[]` (catalog items): each sampled fulfillment flow with its distinct subflows (followed up to 3 levels; `uses` counts repeated calls; `cycles` lists only subflows that call one of their own ancestors), and whether it asks for approval or sends notifications. An order waits for any approval before fulfillment tasks appear.
- `sampleReports[]`: per sample, satellite counts, root fields and `provenance` (`origin` with a `confidence` and the raw `signals`; inferred, not confirmed history). With `detail`, `members[]` and `embeddedRefs[]`:
  - `owned_by_reference`: the record points at the root through its own container field.
  - `shared`: other configuration uses it (a variable set linked by two or more items, a role guarding other tables).
  - `inherits_shared`: belongs to a shared container (a variable of a shared set).
  - `no_other_use_found`: nothing else found within the scan; not confirmed ownership.
  - `external`: outside the artifact (a catalog, a category).
  - `dataReferences`: rows such as order answers that reference the record; reported, never used to classify.
- `coverage`: probes run and their status (`ok`, `restricted`, `error`), embedded patterns searched, reference fields scanned, limits, unresolved embedded references, and the access note (everything is filtered by the connected user's ACLs; unreadable rows are invisible, not reported missing).
- `freshness`: the fingerprint used for reuse and its limitation. A saved profile is reused when type, scope, instance, analyzer version and the fingerprint match (`reused: true`).
- `deferred[]`: what this version does not do (UI Builder pages, non-admin CRUD verification for tables, general flow profiling).

**Errors:**
- `E_INVALID_PARAMS` - unsupported type, bad roots, query, scope or sample.
- `E_BROWSER_DISCONNECTED` - no helper tab available.
