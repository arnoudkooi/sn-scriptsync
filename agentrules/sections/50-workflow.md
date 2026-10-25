## Workflow

1. **Edit and save locally** using the proper file structure. A saved file is not proof that ServiceNow has changed. The default `externalChanges.syncDelay: 0` only monitors and queues external edits; it does not auto-sync them.
2. **Explicitly write the intended changes** through one supported route:
   - **VS Code file sync:** inspect `get_sync_status`, then call `sync_now` only when all eligible pending files belong to the authorized task. It flushes the workspace queue, not just the named instance or active file. Otherwise ask the user to sync the intended files with their per-file ✓ in **Pending Saves** or **sn-scriptsync: Save & Sync**. A user save via Save All, auto save or refactoring stays held for the user; agents must not bypass that hold through a direct write.
   - **SNU CLI/MCP or the Agent API:** write an existing field with `snu record update ... --file ...`, `snu_update_record`, or `update_record` (`field` + `content`, `await: true`). Use `update_record_batch` for a `fields` object. Discover supported commands first: the standalone host has no VS Code file-sync queue. Do not send both a queued file save and a direct write for the same change.
3. **Respect approval:** `staged: true`, `blocked: true` or `E_REVIEW_PENDING` means the change is waiting, not saved. Name the exact action: approve the file in VS Code **Pending Saves**, or approve the review in the SN Utils browser helper tab and collect `get_review_result`. Do not switch write routes to bypass review.
4. **Verify once, using the save result first.** A successful `verified: true` result with matching `persisted` content for the intended fields already confirms the save: **do not issue another `get_record` just to verify it again**. Only when the save has run without that confirmation, read the same instance and record with `get_record` and compare the changed fields. For file sync, wait until the intended files leave both `pendingFiles` and `syncingFiles` before that read. `synced: true`, an empty queue, `updated: true` alone, or an increased `sys_mod_count` is not content verification. Report verification errors, missing fields and mismatches accurately; inspect the saved state before deciding whether to retry a write.
5. **Report the actual outcome:** saved and verified (instance, table, record and fields), awaiting approval (with the exact next step), or saved locally but remote persistence unverified (with the reason). Execute the save when authorized and tools are available; if blocked, give the specific command or user action needed instead of claiming completion.

For example, save a Fix Script (replace the placeholders with the confirmed target):

```sh
snu record update sys_script_fix <sys_id> script --file ./script.js --instance <instance> --json
```

If the successful response has `verified: true` and matching `persisted.script`, the save is complete. **Only if the save is not already verified**, read it separately:

```sh
snu record get sys_script_fix <sys_id> --fields script,sys_mod_count --instance <instance> --json
```

Compare the returned `script` with the file contents. A verification failure can follow a write that already took effect; do not blindly repeat it. Journal fields such as `work_notes` need verification of the new `sys_journal_field` entry, since the record field is not a plain replacement value.

The extension maintains `_map.json`; never edit those files manually.

## Settings Files

Each instance folder should have a settings file:
- `_settings.json` (recommended format)
- `settings.json` (alternative format)
This is generated and updated by the sn-scriptsync Extension

**Security Note**: These files contain keys and should be added to `.gitignore`.

## Recommended .gitignore

Add these entries to your `.gitignore` to protect credentials and avoid syncing local state:

```gitignore
# ServiceNow credentials
**/settings.json
**/_settings.json

# Extension logs
debug.log

# OS files
.DS_Store
Thumbs.db
```

## Tips for Users

- Let the extension manage `_map.json` - it knows what it's doing
- Use proper folder structure: `<instance>/<scope>/<table>/<artifact>`
- For new artifacts, prefer `create_artifact` with the intended fields, then verify the created record
- Auto-sync requires `externalChanges.syncDelay > 0`; always verify the saved content even when it is enabled
- Check `debug.log` if something isn't working as expected
- Always commit `_map.json` files to version control (they contain sys_ids)
- Never commit `_settings.json` files (they contain credentials)
