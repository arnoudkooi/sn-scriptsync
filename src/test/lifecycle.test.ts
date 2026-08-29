import test from 'node:test';
import assert from 'node:assert';
import { BridgeLifecycle, LifecycleState } from '../agent/lifecycle';

/** Controllable transports: each start/stop can be resolved or rejected by hand. */
function makeTransports() {
	const calls = { start: 0, stop: 0 };
	let releaseStart: (() => void) | undefined;
	let failStart: ((err: Error) => void) | undefined;
	let releaseStop: (() => void) | undefined;

	const transports = {
		start(): Promise<void> {
			calls.start++;
			return new Promise<void>((resolve, reject) => {
				releaseStart = resolve;
				failStart = reject;
			});
		},
		stop(): Promise<void> {
			calls.stop++;
			return new Promise<void>((resolve) => {
				releaseStop = resolve;
			});
		},
	};

	return {
		transports,
		calls,
		finishStart: () => releaseStart?.(),
		breakStart: (err: Error) => failStart?.(err),
		finishStop: () => releaseStop?.(),
	};
}

/** Transports that settle immediately. */
function instantTransports() {
	const calls = { start: 0, stop: 0 };
	return {
		calls,
		transports: {
			async start() { calls.start++; },
			async stop() { calls.stop++; },
		},
	};
}

test('start binds the transports exactly once and reports running', async () => {
	const { transports, calls } = instantTransports();
	const lifecycle = new BridgeLifecycle({ transports });

	const outcome = await lifecycle.start();

	assert.strictEqual(outcome.state, 'running');
	assert.strictEqual(outcome.performed, true);
	assert.strictEqual(outcome.alreadyRunning, false);
	assert.strictEqual(calls.start, 1);
	assert.strictEqual(lifecycle.isRunning, true);
});

test('a second start on a running bridge returns the existing one without rebinding', async () => {
	const { transports, calls } = instantTransports();
	const lifecycle = new BridgeLifecycle({ transports });

	await lifecycle.start();
	const second = await lifecycle.start();

	assert.strictEqual(calls.start, 1, 'transports must not be started twice');
	assert.strictEqual(second.performed, false);
	assert.strictEqual(second.alreadyRunning, true);
});

test('concurrent starts in the same tick collapse to one bind', async () => {
	const harness = makeTransports();
	const lifecycle = new BridgeLifecycle({ transports: harness.transports });

	// The status-bar double-click: two starts before either resolves.
	const first = lifecycle.start();
	const second = lifecycle.start();
	const third = lifecycle.start();
	assert.strictEqual(lifecycle.state, 'starting');

	harness.finishStart();
	const [a, b, c] = await Promise.all([first, second, third]);

	assert.strictEqual(harness.calls.start, 1, 'only one transport start for three callers');
	assert.strictEqual(a.performed, true);
	assert.strictEqual(b.performed, false);
	assert.strictEqual(c.performed, false);
	assert.ok(b.alreadyRunning && c.alreadyRunning);
	assert.strictEqual(lifecycle.state, 'running');
});

test('a failed start lands in failed, not running, and releases partial binds', async () => {
	const harness = makeTransports();
	const lifecycle = new BridgeLifecycle({ transports: harness.transports });

	const started = lifecycle.start();
	harness.breakStart(new Error('EADDRINUSE 1978'));
	// The cleanup stop is issued automatically; let it settle.
	queueMicrotask(() => harness.finishStop());

	await assert.rejects(started, /EADDRINUSE 1978/);
	assert.strictEqual(lifecycle.state, 'failed');
	assert.strictEqual(lifecycle.isRunning, false);
	assert.strictEqual(harness.calls.stop, 1, 'a partial bind must be torn down');
});

test('a bridge can be started again after a failed start', async () => {
	const calls = { start: 0, stop: 0 };
	let shouldFail = true;
	const lifecycle = new BridgeLifecycle({
		transports: {
			async start() {
				calls.start++;
				if (shouldFail) throw new Error('port busy');
			},
			async stop() { calls.stop++; },
		},
	});

	await assert.rejects(lifecycle.start(), /port busy/);
	assert.strictEqual(lifecycle.state, 'failed');

	shouldFail = false;
	const retry = await lifecycle.start();
	assert.strictEqual(retry.state, 'running');
	assert.strictEqual(calls.start, 2);
});

test('stop during start waits for the start to settle before tearing down', async () => {
	const harness = makeTransports();
	const lifecycle = new BridgeLifecycle({ transports: harness.transports });

	const started = lifecycle.start();
	const stopped = lifecycle.stop();
	assert.strictEqual(lifecycle.state, 'starting', 'stop must not pre-empt an in-flight start');

	harness.finishStart();
	await started;
	queueMicrotask(() => harness.finishStop());
	await stopped;

	assert.strictEqual(lifecycle.state, 'stopped');
	assert.strictEqual(harness.calls.start, 1);
	assert.strictEqual(harness.calls.stop, 1);
});

test('start during stop queues behind it instead of binding a closing port', async () => {
	const calls: string[] = [];
	let releaseStop: (() => void) | undefined;
	const lifecycle = new BridgeLifecycle({
		transports: {
			async start() { calls.push('start'); },
			stop() {
				calls.push('stop');
				return new Promise<void>((resolve) => { releaseStop = resolve; });
			},
		},
	});

	await lifecycle.start();
	calls.length = 0;

	const stopped = lifecycle.stop();
	const restarted = lifecycle.start();
	assert.strictEqual(lifecycle.state, 'stopping');

	releaseStop?.();
	await stopped;
	await restarted;

	assert.deepStrictEqual(calls, ['stop', 'start'], 'the rebind must follow the release');
	assert.strictEqual(lifecycle.state, 'running');
});

test('repeated stops are idempotent', async () => {
	const { transports, calls } = instantTransports();
	const lifecycle = new BridgeLifecycle({ transports });

	await lifecycle.start();
	await lifecycle.stop();
	await lifecycle.stop();
	await lifecycle.stop();

	assert.strictEqual(calls.stop, 1);
	assert.strictEqual(lifecycle.state, 'stopped');
});

test('stop on a never-started bridge does nothing', async () => {
	const { transports, calls } = instantTransports();
	const lifecycle = new BridgeLifecycle({ transports });

	await lifecycle.stop();

	assert.strictEqual(calls.stop, 0);
	assert.strictEqual(lifecycle.state, 'stopped');
});

test('a throwing stop still reaches stopped rather than stranding in stopping', async () => {
	const lifecycle = new BridgeLifecycle({
		transports: {
			async start() { /* ok */ },
			async stop() { throw new Error('close failed'); },
		},
	});

	await lifecycle.start();
	await lifecycle.stop(); // must not reject

	assert.strictEqual(lifecycle.state, 'stopped');
});

test('state changes are reported in order', async () => {
	const { transports } = instantTransports();
	const seen: LifecycleState[] = [];
	const lifecycle = new BridgeLifecycle({
		transports,
		onStateChange: (next) => seen.push(next),
	});

	await lifecycle.start();
	await lifecycle.stop();

	assert.deepStrictEqual(seen, ['starting', 'running', 'stopping', 'stopped']);
});

test('a listener that throws cannot break a transition', async () => {
	const { transports } = instantTransports();
	const lifecycle = new BridgeLifecycle({
		transports,
		onStateChange: () => { throw new Error('status bar blew up'); },
	});

	const outcome = await lifecycle.start();
	assert.strictEqual(outcome.state, 'running');
});
