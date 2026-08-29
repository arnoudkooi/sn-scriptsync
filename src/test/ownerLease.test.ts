import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	OwnerLease,
	evaluateLease,
	parseElapsed,
	readLease,
	writeLease,
	releaseLease,
	LEASE_STALE_AFTER_MS,
} from '../agent/ownerLease';

const NOW = 1_800_000_000_000;

function lease(overrides: Partial<OwnerLease> = {}): OwnerLease {
	return {
		pid: 4242,
		processStartedAt: NOW - 60_000,
		hostKind: 'vscode',
		editorKind: 'cursor',
		workspaceRoot: '/tmp/ws',
		extensionVersion: '4.9.0',
		transportApiVersion: 9,
		lastHeartbeatAt: NOW - 1_000,
		...overrides,
	};
}

function tmpFile(name: string): string {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'snlease-')), name);
}

test('no lease means the port is free to claim', () => {
	assert.deepStrictEqual(evaluateLease(undefined), { status: 'none' });
});

test('a fresh lease held by a live process is live', () => {
	const verdict = evaluateLease(lease(), {
		now: NOW,
		selfPid: 1,
		isAlive: () => true,
		startTimeFor: () => NOW - 60_000,
	});
	assert.strictEqual(verdict.status, 'live');
});

test('our own lease is recognised as self, not as a competitor', () => {
	const verdict = evaluateLease(lease({ pid: 777 }), {
		now: NOW,
		selfPid: 777,
		isAlive: () => true,
		startTimeFor: () => NOW - 60_000,
	});
	assert.strictEqual(verdict.status, 'self');
});

test('a dead PID is stale', () => {
	const verdict = evaluateLease(lease(), {
		now: NOW,
		selfPid: 1,
		isAlive: () => false,
	});
	assert.strictEqual(verdict.status, 'stale');
	assert.strictEqual(verdict.status === 'stale' && verdict.reason, 'dead-pid');
});

test('a reused PID is stale even though the process is alive', () => {
	// The classic post-reboot trap: same PID, different process.
	const verdict = evaluateLease(lease({ processStartedAt: NOW - 86_400_000 }), {
		now: NOW,
		selfPid: 1,
		isAlive: () => true,
		startTimeFor: () => NOW - 30_000, // started far more recently than the lease claims
	});
	assert.strictEqual(verdict.status, 'stale');
	assert.strictEqual(verdict.status === 'stale' && verdict.reason, 'pid-reused');
});

test('a couple of seconds of clock skew does not count as reuse', () => {
	// `ps` reports whole seconds, so an exact match is never guaranteed.
	const verdict = evaluateLease(lease(), {
		now: NOW,
		selfPid: 1,
		isAlive: () => true,
		startTimeFor: () => NOW - 60_000 + 1_500,
	});
	assert.strictEqual(verdict.status, 'live');
});

test('an expired heartbeat is stale even with a live, matching process', () => {
	const verdict = evaluateLease(lease({ lastHeartbeatAt: NOW - LEASE_STALE_AFTER_MS - 1 }), {
		now: NOW,
		selfPid: 1,
		isAlive: () => true,
		startTimeFor: () => NOW - 60_000,
	});
	assert.strictEqual(verdict.status, 'stale');
	assert.strictEqual(verdict.status === 'stale' && verdict.reason, 'heartbeat-expired');
});

test('an unknown process start time falls back to the heartbeat instead of claiming reuse', () => {
	// Windows has no cheap synchronous source; not knowing must never be
	// treated as proof the owner is gone.
	const verdict = evaluateLease(lease(), {
		now: NOW,
		selfPid: 1,
		isAlive: () => true,
		startTimeFor: () => undefined,
	});
	assert.strictEqual(verdict.status, 'live');
});

test('parseElapsed handles every ps etime shape', () => {
	assert.strictEqual(parseElapsed('00:07'), 7_000);
	assert.strictEqual(parseElapsed('01:30'), 90_000);
	assert.strictEqual(parseElapsed('02:01:30'), 2 * 3_600_000 + 90_000);
	assert.strictEqual(parseElapsed('3-04:05:06'), ((3 * 24 + 4) * 60 + 5) * 60_000 + 6_000);
	assert.strictEqual(parseElapsed('garbage'), undefined);
});

test('a lease round-trips through the file and is owner-only', () => {
	const file = tmpFile('bridge-owner.json');
	assert.strictEqual(writeLease(lease(), file), true);

	const read = readLease(file);
	assert.strictEqual(read?.pid, 4242);
	assert.strictEqual(read?.editorKind, 'cursor');

	if (process.platform !== 'win32') {
		assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600, 'lease carries no secret but names the workspace');
	}
});

test('a corrupt lease file reads as no lease rather than throwing', () => {
	const file = tmpFile('bridge-owner.json');
	fs.writeFileSync(file, '{ not json');
	assert.strictEqual(readLease(file), undefined);
});

test('writing leaves no temp file behind', () => {
	const file = tmpFile('bridge-owner.json');
	writeLease(lease(), file);
	const dir = path.dirname(file);
	assert.deepStrictEqual(fs.readdirSync(dir), ['bridge-owner.json']);
});

test('release removes our own lease', () => {
	const file = tmpFile('bridge-owner.json');
	writeLease(lease({ pid: 999 }), file);
	releaseLease(file, 999);
	assert.strictEqual(fs.existsSync(file), false);
});

test('release never removes another live owner\'s lease', () => {
	// The exact bug that left healthy bridges undiscoverable.
	const file = tmpFile('bridge-owner.json');
	writeLease(lease({ pid: 999 }), file);
	releaseLease(file, 1234);
	assert.strictEqual(fs.existsSync(file), true);
	assert.strictEqual(readLease(file)?.pid, 999);
});
