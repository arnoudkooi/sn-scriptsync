import test from 'node:test';
import assert from 'node:assert';
import { decideUpdate, isNpxExecution } from '../cli/selfUpdate.js';

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
