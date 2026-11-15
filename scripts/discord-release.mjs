#!/usr/bin/env node
// Use the shared local release tooling and webhook without copying credentials.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const toolingRoot = process.env.SNU_RELEASE_TOOLING_ROOT || path.resolve(root, '../ServiceNowUtils Pro');
const command = path.join(toolingRoot, 'scripts/discord-release.mjs');
const args = process.argv.slice(2);
if (args.includes('--product')) {
    console.error(JSON.stringify({ ok: false, error: 'This command announces ScriptSync. Omit --product.' }));
    process.exitCode = 1;
} else if (!fs.existsSync(command)) {
    console.error(JSON.stringify({ ok: false, error: 'Shared release tooling was not found. Set SNU_RELEASE_TOOLING_ROOT to the SN Utils Pro checkout.' }));
    process.exitCode = 1;
} else {
    const result = spawnSync(process.execPath, [command, ...(args.length ? args : ['help']), '--product', 'scriptsync'], {
        stdio: 'inherit', env: { ...process.env, SCRIPTSYNC_RELEASE_ROOT: root },
    });
    if (result.error) console.error(JSON.stringify({ ok: false, error: 'Could not start the shared Discord release command.' }));
    process.exitCode = result.status ?? 1;
}
