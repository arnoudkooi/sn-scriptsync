## Workflow

1. **Edit files** in VS Code using the proper file structure
2. **Save** your changes
3. The extension **automatically syncs** to ServiceNow after a debounce period
4. The extension **updates _map.json** automatically
5. **Never manually edit** `_map.json` files

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
- For new artifacts, just create the file and save - the extension handles the rest
- The extension uses a debounce timer, so changes sync after a short delay
- Check `debug.log` if something isn't working as expected
- Always commit `_map.json` files to version control (they contain sys_ids)
- Never commit `_settings.json` files (they contain credentials)
