### `sdk_deploy` (Pro/Trial)

Build, pack and install a ServiceNow SDK (NOW SDK / Fluent) app with the user's browser session, with no separate `now-sdk auth` login. It runs the project's own `now-sdk build` and `now-sdk pack`, then the SN Utils helper tab asks the user to confirm in a modal, installs the package and activates the app's flows. The call waits for that confirmation (up to 15 minutes), so tell the user to confirm in the helper tab. Needs the `createArtifacts` permission.

**Request:**
```json
{
  "id": "deploy_1",
  "command": "sdk_deploy",
  "instance": "dev12345",
  "params": { "projectPath": "my-fluent-app" }
}
```

**Parameters:**
- `projectPath` (optional): the project folder (the one with `now.config.json`), relative to the workspace root or absolute, and inside the workspace. Omit it when the workspace holds one NOW SDK project.
- `force` (optional): deploy even when the app changed on the instance since the last deploy or pull. Only after the user agreed.

Without `instance`, the app's linked instance (the one it was last deployed to or pulled from) is used.

**Response:**
```json
{ "status": "success", "result": {
  "success": true, "installed": true, "partial": false,
  "app": { "name": "My App", "scope": "x_1234_my_app", "version": "1.0.0" },
  "rollbackUrl": "https://dev12345.service-now.com/sys_rollback_context.do?sys_id=...",
  "flowActivation": { "ok": true, "total": 1, "succeeded": 1, "failed": 0 },
  "durationMs": 8200
} }
```
- `installed: true, partial: true`: the app installed, but some flows or actions did not activate. Report which, and suggest opening them in Flow Designer.

**Errors:**
- `E_INSTANCE_CHANGED`: the deploy would overwrite changes made on the instance since the last deploy or pull. `details.changes` lists each record with the `fields` it would overwrite and, when a pull cannot bring the change in, a `reason` (for example "compiled from your server source"). Ask the user whether to pull first (`sdk_pull`), copy the unpullable changes into the source, or overwrite (`force: true`). `details.instanceOnly` lists records that exist only on the instance; a deploy leaves them.
- `E_CONFIRM_REQUIRED` with `details.checkFailed`: the check for changes on the instance could not run (for example an expired session), so nothing was deployed. Retry, or ask the user before deploying with `force: true`, which installs without the check. The result's `instanceChecked` says whether a deploy was checked.
- `E_USER_REJECTED`: the user cancelled in the helper tab. Do not retry on your own.
- `E_PRO_REQUIRED`: the connected SN Utils is the Community tier.
- `E_PAUSED`: the user paused agents in the helper tab.
- `E_UNSUPPORTED_HOST`: the connected SN Utils is too old to deploy apps.
- `E_INVALID_PARAMS`: no project found, several projects and no `projectPath`, a path outside the workspace, the SDK not installed in the project (`npm install`), an SDK version outside 4.1 to 4.x, or an app type ScriptSync does not deploy (configuration project, Store app, global scope). Tell the user to use `now-sdk install` for those.
- `E_COMMAND_FAILED`: build or install failed, or the instance refused the app (installed from the Store, or its scope is used by another app). `details` carries `trackerUrl` (the install's execution tracker) and `reason` (the cause the instance logged, e.g. a scope that does not match the instance's vendor prefix).
- `E_TIMEOUT`: no result in time. The install may still have finished: check the app on the instance before deploying again.

The result also carries `instance`, `baselineRecorded` (the state used for the next change check) and, after a forced deploy, `overwritten`.

> `now-sdk dependencies` and the other SDK commands still use the SDK's own login.
