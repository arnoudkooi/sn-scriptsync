/**
 * Per-instance ServiceNow session health.
 *
 * The bridge used to report one word, `connected`, covering four unrelated
 * questions: is the HTTP API up, is the WebSocket listening, is the helper tab
 * attached, and does ServiceNow still accept our session. The first three were
 * true throughout the 2026-08-29 incident while the fourth was false, so the
 * CLI said "Connected and ready" and every operation returned 401.
 *
 * The states are kept separate here, and the authentication one is never
 * inferred — it is the result of an actual bounded, read-only request.
 *
 * Nothing in this module stores session material. It records *when* things
 * happened, never the credential itself; a timestamp cannot leak a session.
 */

export type AuthState =
	/** A read-only probe succeeded. */
	| 'AUTH_OK'
	/** The instance answered 401: the browser session is gone or expired. */
	| 'AUTH_EXPIRED'
	/** No session material has ever been seen for this instance. */
	| 'AUTH_MISSING'
	/** The helper tab is not attached, so no request can be made at all. */
	| 'HELPER_DISCONNECTED'
	/** The bridge does not know this instance. */
	| 'INSTANCE_NOT_FOUND'
	/** The probe could not complete (timeout, transport error). Not a verdict. */
	| 'AUTH_UNKNOWN';

export interface SessionRecord {
	/** When this instance's session material last arrived (a /token receipt). */
	receivedAt?: number;
	/** When a probe last confirmed the session works. */
	lastValidatedAt?: number;
	/** When an authenticated operation last succeeded. */
	lastUsedAt?: number;
	/** Latest probe verdict. */
	state?: AuthState;
	/**
	 * Set when a probe returned 401. A quarantined session must not be reported
	 * as ready again until something proves otherwise — the readiness claim
	 * outliving the session is the whole failure being fixed.
	 */
	quarantinedAt?: number;
}

/** Origin -> record. In memory only: this is deliberately not persisted. */
const sessions = new Map<string, SessionRecord>();

export function canonicalOrigin(value: unknown): string | null {
	if (typeof value !== 'string' || !value.trim()) return null;
	try {
		return new URL(value).origin.toLowerCase();
	} catch {
		return null;
	}
}

function recordFor(origin: string): SessionRecord {
	let record = sessions.get(origin);
	if (!record) {
		record = {};
		sessions.set(origin, record);
	}
	return record;
}

/** A /token receipt arrived: new session material for this instance. */
export function noteSessionReceived(originValue: unknown, now = Date.now()): void {
	const origin = canonicalOrigin(originValue);
	if (!origin) return;
	const record = recordFor(origin);
	record.receivedAt = now;
	// Fresh material clears a quarantine — that is what /token is for.
	record.quarantinedAt = undefined;
	record.state = undefined;
}

/** An authenticated operation succeeded, which is itself proof of a live session. */
export function noteAuthenticatedUse(originValue: unknown, now = Date.now()): void {
	const origin = canonicalOrigin(originValue);
	if (!origin) return;
	const record = recordFor(origin);
	record.lastUsedAt = now;
	record.lastValidatedAt = now;
	record.state = 'AUTH_OK';
	record.quarantinedAt = undefined;
}

/** Record a probe verdict. */
export function noteProbeResult(originValue: unknown, state: AuthState, now = Date.now()): void {
	const origin = canonicalOrigin(originValue);
	if (!origin) return;
	const record = recordFor(origin);
	record.state = state;
	if (state === 'AUTH_OK') {
		record.lastValidatedAt = now;
		record.quarantinedAt = undefined;
		return;
	}
	if (state === 'AUTH_EXPIRED') {
		// Quarantine rather than delete: the timestamps stay useful for
		// diagnostics, and readiness is gated on the quarantine, not on absence.
		record.quarantinedAt = now;
	}
}

export function getSession(originValue: unknown): SessionRecord | undefined {
	const origin = canonicalOrigin(originValue);
	if (!origin) return undefined;
	const existing = sessions.get(origin);
	return existing ? { ...existing } : undefined;
}

/**
 * Is this instance's session usable right now?
 *
 * Deliberately conservative: only a positive, recent validation counts. An
 * unprobed session is not "ready", it is unknown — reporting unknown as ready
 * is precisely how a 401 got described as "Connected and ready".
 */
export function isSessionReady(originValue: unknown, now = Date.now(), maxAgeMs = 5 * 60_000): boolean {
	const record = getSession(originValue);
	if (!record) return false;
	if (record.quarantinedAt) return false;
	if (record.state !== 'AUTH_OK') return false;
	const validated = record.lastValidatedAt ?? 0;
	return now - validated <= maxAgeMs;
}

/**
 * Map a REST failure to an auth state.
 *
 * 401 and 403 are collapsed to one error code elsewhere in the bridge, which
 * makes an expired session indistinguishable from a working session that is
 * merely denied a table. They mean opposite things here: 401 says the session
 * is gone, 403 says the session authenticated fine and an ACL said no.
 */
export function authStateForStatus(status: number | undefined): AuthState {
	if (status === 401) return 'AUTH_EXPIRED';
	if (status === 403) return 'AUTH_OK'; // authenticated, then refused by an ACL
	if (status !== undefined && status >= 200 && status < 300) return 'AUTH_OK';
	return 'AUTH_UNKNOWN';
}

/** Test seam: drop all recorded session health. */
export function resetSessionHealth(): void {
	sessions.clear();
}
