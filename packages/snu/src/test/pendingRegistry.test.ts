import test from 'node:test';
import assert from 'node:assert';
import { MAX_PENDING_TIMEOUT_MS, PendingRegistry } from '../server/pendingRegistry.js';

for (const [name, requested, expected] of [
  ['oversized', Number.MAX_SAFE_INTEGER, MAX_PENDING_TIMEOUT_MS],
  ['bulk deadline plus grace', MAX_PENDING_TIMEOUT_MS, MAX_PENDING_TIMEOUT_MS],
  ['deploy window', 15 * 60_000, 15 * 60_000],
  ['NaN', NaN, 60_000],
  ['infinity', Infinity, 60_000],
  ['negative infinity', -Infinity, 60_000],
  ['negative', -10, 1],
  ['zero', 0, 1],
  ['non-numeric', '30000' as any, 60_000],
] as const) {
  for (const extend of [false, true]) {
    test(`pending timeout bounds: ${name}, extend=${extend}`, async (t) => {
      (t.mock.timers.enable as any)({ apis: ['setTimeout'] });
      const reg = new PendingRegistry();
      const p = reg.register({ id: 'bounded', command: 'test', timeoutMs: extend ? 1_000 : requested });
      if (extend) reg.extend('bounded', requested);
      t.mock.timers.tick(expected - 1);
      assert.ok(reg.has('bounded'));
      t.mock.timers.tick(1);
      await assert.rejects(p, (e: any) => e.code === 'E_TIMEOUT' && e.message.includes(`${expected / 1000}s`));
      assert.strictEqual(reg.size(), 0);
    });
  }
}

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
