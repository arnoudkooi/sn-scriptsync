import test from 'node:test';
import assert from 'node:assert';
import { PendingRegistry } from '../server/pendingRegistry.js';

test('PendingRegistry.extend gives an approved command a fresh timeout window', async (t) => {
  (t.mock.timers.enable as any)({ apis: ['setTimeout'] });
  const reg = new PendingRegistry();
  const p = reg.register<any>({ id: 'ext_1', command: 'run_background_script', timeoutMs: 300_000 });

  t.mock.timers.tick(290_000);
  assert.strictEqual(reg.extend('ext_1', 300_000), true);
  t.mock.timers.tick(60_000);
  assert.strictEqual(reg.has('ext_1'), true);
  reg.resolve('ext_1', { ok: true });
  assert.deepStrictEqual(await p, { ok: true });

  const q = reg.register<any>({ id: 'ext_2', command: 'x', timeoutMs: 1_000 });
  reg.extend('ext_2', 5_000);
  t.mock.timers.tick(5_000);
  await assert.rejects(q, (e: any) => e.code === 'E_TIMEOUT');
});
