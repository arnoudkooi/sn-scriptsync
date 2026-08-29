import test from 'node:test';
import assert from 'node:assert';
import {
	noteSessionReceived,
	noteAuthenticatedUse,
	noteProbeResult,
	getSession,
	isSessionReady,
	authStateForStatus,
	canonicalOrigin,
	resetSessionHealth,
} from '../agent/sessionHealth';

const ORIGIN = 'https://ven08329.service-now.com';
const NOW = 1_800_000_000_000;

test.beforeEach(() => resetSessionHealth());

test('an unprobed session is not ready', () => {
	// Unknown is not the same as ready. Treating it as ready is exactly how a
	// 401 got reported as "Connected and ready".
	noteSessionReceived(ORIGIN, NOW);
	assert.strictEqual(isSessionReady(ORIGIN, NOW), false);
});

test('a validated session is ready', () => {
	noteProbeResult(ORIGIN, 'AUTH_OK', NOW);
	assert.strictEqual(isSessionReady(ORIGIN, NOW), true);
});

test('a validated session goes stale rather than staying ready forever', () => {
	noteProbeResult(ORIGIN, 'AUTH_OK', NOW);
	assert.strictEqual(isSessionReady(ORIGIN, NOW + 6 * 60_000), false);
});

test('a 401 quarantines the session so readiness cannot be re-claimed', () => {
	noteProbeResult(ORIGIN, 'AUTH_OK', NOW);
	noteProbeResult(ORIGIN, 'AUTH_EXPIRED', NOW + 1_000);

	const record = getSession(ORIGIN);
	assert.strictEqual(record?.state, 'AUTH_EXPIRED');
	assert.ok(record?.quarantinedAt, 'expiry must quarantine, not merely be recorded');
	assert.strictEqual(isSessionReady(ORIGIN, NOW + 1_000), false);
});

test('a quarantine keeps the diagnostic timestamps rather than wiping them', () => {
	noteProbeResult(ORIGIN, 'AUTH_OK', NOW);
	noteProbeResult(ORIGIN, 'AUTH_EXPIRED', NOW + 1_000);
	assert.strictEqual(getSession(ORIGIN)?.lastValidatedAt, NOW);
});

test('a fresh /token receipt clears the quarantine', () => {
	noteProbeResult(ORIGIN, 'AUTH_EXPIRED', NOW);
	noteSessionReceived(ORIGIN, NOW + 1_000);

	const record = getSession(ORIGIN);
	assert.strictEqual(record?.quarantinedAt, undefined);
	assert.strictEqual(record?.receivedAt, NOW + 1_000);
	// Still not ready: new material is not proof it works.
	assert.strictEqual(isSessionReady(ORIGIN, NOW + 1_000), false);
});

test('a successful authenticated operation counts as validation', () => {
	noteAuthenticatedUse(ORIGIN, NOW);
	assert.strictEqual(isSessionReady(ORIGIN, NOW), true);
	assert.strictEqual(getSession(ORIGIN)?.lastUsedAt, NOW);
});

test('401 and 403 are not the same verdict', () => {
	// The bridge collapses both to E_ACL, which makes an expired session
	// indistinguishable from a working session denied one table.
	assert.strictEqual(authStateForStatus(401), 'AUTH_EXPIRED');
	assert.strictEqual(authStateForStatus(403), 'AUTH_OK');
	assert.strictEqual(authStateForStatus(200), 'AUTH_OK');
	assert.strictEqual(authStateForStatus(undefined), 'AUTH_UNKNOWN');
	assert.strictEqual(authStateForStatus(500), 'AUTH_UNKNOWN');
});

test('sessions are tracked per instance origin', () => {
	const other = 'https://ven08330.service-now.com';
	noteProbeResult(ORIGIN, 'AUTH_OK', NOW);
	noteProbeResult(other, 'AUTH_EXPIRED', NOW);

	assert.strictEqual(isSessionReady(ORIGIN, NOW), true);
	assert.strictEqual(isSessionReady(other, NOW), false);
});

test('origins are canonicalised so path and case differences do not fork a session', () => {
	assert.strictEqual(canonicalOrigin('https://VEN08329.service-now.com/nav_to.do'), ORIGIN);
	assert.strictEqual(canonicalOrigin('not a url'), null);
	assert.strictEqual(canonicalOrigin(undefined), null);
});

test('no session material is ever stored, only timings', () => {
	noteSessionReceived(ORIGIN, NOW);
	noteAuthenticatedUse(ORIGIN, NOW);
	const serialised = JSON.stringify(getSession(ORIGIN));
	for (const key of ['token', 'g_ck', 'cookie', 'password', 'secret']) {
		assert.ok(!serialised.toLowerCase().includes(key), `session record must not carry ${key}`);
	}
});
