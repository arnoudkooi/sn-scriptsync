import test from 'node:test';
import assert from 'node:assert';
import { decideUpdate, isNpxExecution, npmInstallSpawnSpec, updateFailure, MANUAL_UPDATE_COMMAND } from '../cli/selfUpdate.js';

test('Self update: recognizes npx cache execution', () => {
  assert.strictEqual(isNpxExecution('/Users/me/.npm/_npx/abc/node_modules/@snutils/snu/bin/snu.js', {}), true);
  assert.strictEqual(isNpxExecution('/opt/homebrew/lib/node_modules/@snutils/snu/bin/snu.js', {}), false);
  assert.strictEqual(isNpxExecution('/some/path/snu.js', { npm_command: 'exec' }), true);
});

test('Self update: stays current when npm latest is not newer', () => {
  assert.strictEqual(decideUpdate('0.1.6', '0.1.6', false).action, 'current');
  assert.strictEqual(decideUpdate('0.1.6', '0.1.5', false).action, 'current');
});

test('Self update: installs global updates and redirects npx users', () => {
  assert.strictEqual(decideUpdate('0.1.5', '0.1.6', false).action, 'install');
  assert.strictEqual(decideUpdate('0.1.5', '0.1.6', true).action, 'npx');
});

test('Self update: npm is spawned through a shell on Windows only', () => {
  // Node refuses to spawn npm.cmd without a shell (spawn EINVAL), which is
  // how `snu update` failed on Windows in 0.3.0.
  const win = npmInstallSpawnSpec('win32');
  assert.strictEqual(win.command, 'npm');
  assert.strictEqual(win.options.shell, true);
  assert.deepStrictEqual(win.args, ['install', '--global', '@snutils/snu@latest']);
  for (const platform of ['darwin', 'linux'] as const) {
    const spec = npmInstallSpawnSpec(platform);
    assert.strictEqual(spec.command, 'npm');
    assert.strictEqual(spec.options.shell, false);
  }
});

test('Self update: a failed automatic update names the manual command', () => {
  const err: any = updateFailure('Could not start npm (spawn EINVAL)');
  assert.strictEqual(err.code, 'E_UPDATE_FAILED');
  assert.match(err.message, /spawn EINVAL/);
  assert.ok(err.message.endsWith(MANUAL_UPDATE_COMMAND));
});
