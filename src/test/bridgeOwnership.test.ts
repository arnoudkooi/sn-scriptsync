import test from 'node:test';
import assert from 'node:assert';
import { resolveBridgeOwnership, PortDescriptor } from '../agent/bridgeOwnership';
import { OwnerLease } from '../agent/ownerLease';

const NOW = 1_800_000_000_000;
const SELF = 100;
const FOREIGN = 200;

function lease(overrides: Partial<OwnerLease> = {}): OwnerLease {
	return {
		pid: FOREIGN,
		processStartedAt: NOW - 600_000,
		hostKind: 'vscode',
		editorKind: 'cursor',
		workspaceRoot: '/tmp/ws',
		extensionVersion: '4.9.0',
		transportApiVersion: 9,
		lastHeartbeatAt: NOW - 5_000,
		...overrides,
	};
}

function descriptor(overrides: Partial<PortDescriptor> = {}): PortDescriptor {
	return { pid: FOREIGN, port: 1977, token: 'tok', ...overrides };
}

/** Default probes: nothing claims anything, nothing is alive, nothing answers. */
function probes(over: Parameters<typeof resolveBridgeOwnership>[0] = {}) {
	return {
		now: NOW,
		selfPid: SELF,
		readLease: () => undefined,
		readDescriptor: () => undefined,
		isAlive: () => false,
		isReachable: async () => false,
		startTimeFor: () => NOW - 600_000,
		...over,
	};
}

// ---------------------------------------------------------------------------
// The ownership matrix. These run against the single resolver, not against two
// files' separate interpretations — which is the point of the abstraction.
// ---------------------------------------------------------------------------

test('no lease and no descriptor is claimable', async () => {
	const result = await resolveBridgeOwnership(probes());
	assert.strictEqual(result.state, 'claimable');
});

test('a corrupt lease with no descriptor is claimable', async () => {
	const result = await resolveBridgeOwnership(probes({ readLease: () => undefined }));
	assert.strictEqual(result.state, 'claimable');
});

test('a fresh foreign lease on a live process is not claimable', async () => {
	const result = await resolveBridgeOwnership(probes({
		readLease: () => lease(),
		isAlive: () => true,
	}));
	assert.strictEqual(result.state, 'live');
	assert.strictEqual(result.state === 'live' && result.source, 'lease');
});

test('our own lease reports self, not a competitor', async () => {
	const result = await resolveBridgeOwnership(probes({
		readLease: () => lease({ pid: SELF }),
		isAlive: () => true,
	}));
	assert.strictEqual(result.state, 'self');
});

test('a lease whose PID is gone is claimable', async () => {
	const result = await resolveBridgeOwnership(probes({
		readLease: () => lease(),
		isAlive: () => false,
	}));
	assert.strictEqual(result.state, 'claimable');
});

test('a lease whose PID was reused is claimable', async () => {
	const result = await resolveBridgeOwnership(probes({
		readLease: () => lease({ processStartedAt: NOW - 86_400_000 }),
		isAlive: () => true,
		startTimeFor: () => NOW - 30_000, // a different, younger process
	}));
	assert.strictEqual(result.state, 'claimable');
});

test('a lease with an expired heartbeat is claimable even though the PID lives', async () => {
	const result = await resolveBridgeOwnership(probes({
		readLease: () => lease({ lastHeartbeatAt: NOW - 10 * 60_000 }),
		isAlive: () => true,
	}));
	assert.strictEqual(result.state, 'claimable');
});

// --- the descriptor fallback: absence of a lease proves nothing -------------

test('a standalone bridge with no lease but a reachable endpoint is NOT claimable', async () => {
	// Only the extension writes leases. A standalone `snu serve` bridge — and
	// any older ScriptSync build — registers with a descriptor alone. Treating
	// that as unowned would clobber a healthy bridge.
	const result = await resolveBridgeOwnership(probes({
		readLease: () => undefined,
		readDescriptor: () => descriptor(),
		isAlive: () => true,
		isReachable: async () => true,
	}));
	assert.strictEqual(result.state, 'live');
	assert.strictEqual(result.state === 'live' && result.source, 'descriptor');
});

test('a descriptor whose owner is gone is claimable', async () => {
	const result = await resolveBridgeOwnership(probes({
		readDescriptor: () => descriptor(),
		isAlive: () => false,
	}));
	assert.strictEqual(result.state, 'claimable');
});

test('THE OPEN QUESTION: PID alive but the bridge does not answer is claimable', async () => {
	// Process liveness is not bridge liveness. A wedged host still answers
	// kill -0 forever; under the old PID-only rule its registration was
	// protected indefinitely and the bridge stayed undiscoverable.
	const result = await resolveBridgeOwnership(probes({
		readDescriptor: () => descriptor(),
		isAlive: () => true,
		isReachable: async () => false,
	}));
	assert.strictEqual(result.state, 'claimable');
	assert.match(
		result.state === 'claimable' ? result.reason : '',
		/alive but its bridge on 1977 does not answer/
	);
});

test('a stale lease does not short-circuit a reachable descriptor', async () => {
	// A stale lease and a live standalone bridge can coexist: the lease is left
	// over from a closed window, the ports belong to something else entirely.
	const result = await resolveBridgeOwnership(probes({
		readLease: () => lease({ lastHeartbeatAt: NOW - 10 * 60_000, pid: 999 }),
		readDescriptor: () => descriptor({ pid: FOREIGN }),
		isAlive: () => true,
		isReachable: async () => true,
	}));
	assert.strictEqual(result.state, 'live');
	assert.strictEqual(result.state === 'live' && result.pid, FOREIGN);
});

test('a descriptor naming this process reports self', async () => {
	const result = await resolveBridgeOwnership(probes({
		readDescriptor: () => descriptor({ pid: SELF }),
		isAlive: () => true,
	}));
	assert.strictEqual(result.state, 'self');
});

test('a descriptor without a port cannot be probed and is claimable', async () => {
	const result = await resolveBridgeOwnership(probes({
		readDescriptor: () => ({ pid: FOREIGN }),
		isAlive: () => true,
	}));
	assert.strictEqual(result.state, 'claimable');
});

test('a live owner is never probed twice per resolution', async () => {
	let probeCount = 0;
	await resolveBridgeOwnership(probes({
		readDescriptor: () => descriptor(),
		isAlive: () => true,
		isReachable: async () => { probeCount++; return true; },
	}));
	assert.strictEqual(probeCount, 1);
});

test('a live lease skips the descriptor probe entirely', async () => {
	// The cheap evidence wins: no HTTP round trip when the lease is fresh.
	let probeCount = 0;
	await resolveBridgeOwnership(probes({
		readLease: () => lease(),
		readDescriptor: () => descriptor(),
		isAlive: () => true,
		isReachable: async () => { probeCount++; return true; },
	}));
	assert.strictEqual(probeCount, 0);
});

test('claimable results explain themselves', async () => {
	// The reason is what a diagnostic prints; an empty one is a dead end.
	const result = await resolveBridgeOwnership(probes());
	assert.ok(result.state === 'claimable' && result.reason.length > 0);
});
