import test from 'node:test';
import assert from 'node:assert';
import * as pendingRegistry from '../agent/pendingRegistry';

// An approved review must not inherit what was left of the 5-minute review
// window: a script approved at 4:50 that runs 45 s would otherwise time out.
test('extend gives a pending request a fresh timeout window', async (t) => {
	(t.mock.timers.enable as any)({ apis: ['setTimeout'] });
	const p = pendingRegistry.register<any>({ id: 'ext_1', command: 'run_background_script', instanceFolder: 'x', timeoutMs: 300_000 });

	t.mock.timers.tick(290_000); // approved with 10 s of the review window left
	assert.strictEqual(pendingRegistry.extend('ext_1', 300_000), true);
	t.mock.timers.tick(60_000); // past the original deadline
	assert.strictEqual(pendingRegistry.has('ext_1'), true, 'still waiting after the original deadline');

	pendingRegistry.resolve('ext_1', { output: 'done' });
	assert.deepStrictEqual(await p, { output: 'done' });
});

test('an extended request still times out after its new window', async (t) => {
	(t.mock.timers.enable as any)({ apis: ['setTimeout'] });
	const p = pendingRegistry.register<any>({ id: 'ext_2', command: 'run_background_script', instanceFolder: 'x', timeoutMs: 1_000 });
	pendingRegistry.extend('ext_2', 5_000);
	t.mock.timers.tick(5_000);
	await assert.rejects(p, (e: any) => e.code === 'E_TIMEOUT');
	assert.strictEqual(pendingRegistry.extend('missing', 5_000), false);
});
