import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('ScriptSync release commands preserve arguments and select only their own product and checkout', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptsync-release-command-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.writeFileSync(path.join(root, 'scripts/discord-release.mjs'), 'console.log(JSON.stringify({args:process.argv.slice(2),source:process.env.SCRIPTSYNC_RELEASE_ROOT}));');
    const wrapper = fileURLToPath(new URL('./discord-release.mjs', import.meta.url));
    const env = { ...process.env, SNU_RELEASE_TOOLING_ROOT: root };
    const run = args => spawnSync(process.execPath, [wrapper, ...args], { env, encoding: 'utf8', timeout: 10_000 });
    const result = run(['preview', '--version', '4.10.6', '--highlights', '1,2']);
    assert.equal(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.args, ['preview', '--version', '4.10.6', '--highlights', '1,2', '--product', 'scriptsync']);
    assert.equal(output.source, fileURLToPath(new URL('..', import.meta.url)));
    assert.equal(run(['post', '--preview', 'saved-preview', '--product', 'snutils']).status, 1);
    fs.unlinkSync(path.join(root, 'scripts/discord-release.mjs'));
    const missing = run(['list']);
    assert.equal(missing.status, 1);
    assert.match(JSON.parse(missing.stderr).error, /SNU_RELEASE_TOOLING_ROOT/);
});
