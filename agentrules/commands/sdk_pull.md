### `sdk_pull` (Pro/Trial)

Pull changes made on the instance into a ServiceNow SDK (NOW SDK / Fluent) project, with the user's browser session and the project's own `now-sdk` (no separate `now-sdk auth` login). SN Utils downloads the app package, the SDK converts it into Fluent in a temporary copy of the project, and the differing files are copied into the project. Without `instance`, the app's linked instance (the one it was last deployed to or pulled from) is used.

**Request:**
```json
{
  "id": "pull_1",
  "command": "sdk_pull",
  "instance": "dev12345",
  "params": { "projectPath": "my-fluent-app" }
}
```

**Parameters:**
- `projectPath` (optional): the project folder (the one with `now.config.json`), relative to the workspace root or absolute, and inside the workspace. Omit it when the workspace holds one NOW SDK project.
- `dryRun` (optional): only list what would change.
- `force` (optional): apply even when the project is not in git or an affected file has uncommitted edits. Only after the user agreed.

**Response:**
```json
{ "status": "success", "result": {
  "app": { "name": "My App", "scope": "x_1234_my_app", "version": "1.0.0" },
  "instance": "dev12345",
  "changes": [{ "path": "src/server/script-includes/util.js", "status": "modified" }],
  "applied": ["src/server/script-includes/util.js"],
  "upToDate": false
} }
```
- Review the applied files with `git diff`; undo with `git checkout -- <file>`.
- `firstPull: true`: the first pull also writes out defaults and IDs the ServiceNow SDK keeps in the source. Mention it so the user is not surprised by the extra lines.
- `notOnInstance`: files that are not in the instance package. They are never deleted; tell the user.
- `notPulled`: instance changes the SDK cannot write back to the source, with a `reason` (generated UI pages, server modules, module glue scripts, build assets, `@fluent-disable-sync`). Tell the user to copy them into the source by hand; the next deploy would otherwise overwrite them.

**Errors:**
- `E_CONFIRM_REQUIRED`: the project is not in git, or an affected file has uncommitted edits (`details.uncommitted`). Ask the user to commit first, or whether to pass `force: true`.
- `E_PRO_REQUIRED`, `E_PAUSED`, `E_UNSUPPORTED_HOST`: as for `sdk_deploy`.
- `E_INVALID_PARAMS`: no project found, a path outside the workspace, the SDK not installed, an SDK version outside 4.1 to 4.x, or an app type ScriptSync does not handle.
- `E_COMMAND_FAILED`: the download or the conversion failed; the message says why (for example, the app is not installed on the instance).
