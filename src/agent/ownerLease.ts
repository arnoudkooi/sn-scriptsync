/**
 * Cross-window bridge ownership.
 *
 * Two editor windows pointed at ScriptSync used to both try to own ports
 * 1977/1978. The port descriptor recorded only `pid`, and a PID alone is not
 * proof of ownership: after a reboot the same number is routinely handed to an
 * unrelated process, so a stale descriptor could read as a live owner (and a
 * live owner as stale).
 *
 * A lease pins ownership to identity that survives neither reboot nor reuse:
 * the PID *and* that process's start time, plus a heartbeat that proves the
 * owner is still writing. All three must agree before we treat a descriptor as
 * a live claim.
 *
 * Host-agnostic on purpose: no `vscode` import, so the staleness rules are
 * testable without an extension host.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** How often a live owner refreshes `lastHeartbeatAt`. */
export const LEASE_HEARTBEAT_MS = 30_000;

/**
 * A lease older than this is treated as abandoned even if the PID is alive —
 * covers a wedged extension host that still exists but stopped servicing the
 * bridge. Three missed beats, so a slow machine does not lose its own lease.
 */
export const LEASE_STALE_AFTER_MS = LEASE_HEARTBEAT_MS * 3 + 5_000;

export interface OwnerLease {
	pid: number;
	/** Process start time. Guards against PID reuse after a reboot. */
	processStartedAt: number;
	hostKind: 'vscode' | 'standalone';
	/** 'code' | 'cursor' | 'windsurf' | ... — free-form, for diagnostics. */
	editorKind?: string;
	/** Which workspace the owning window is syncing. */
	workspaceRoot?: string;
	extensionVersion?: string;
	transportApiVersion: number;
	lastHeartbeatAt: number;
}

export type LeaseVerdict =
	| { status: 'none' }
	| { status: 'live'; lease: OwnerLease }
	| { status: 'self'; lease: OwnerLease }
	| { status: 'stale'; lease: OwnerLease; reason: 'dead-pid' | 'pid-reused' | 'heartbeat-expired' }
	| { status: 'unreadable' };

export function leaseFilePath(): string {
	return path.join(os.homedir(), '.sn-scriptsync', 'bridge-owner.json');
}

/**
 * Best-effort start time for a PID, in epoch milliseconds.
 *
 * Returns undefined when it cannot be determined; callers must treat that as
 * "cannot prove reuse" and fall back to the heartbeat, never as a match.
 */
export function processStartTime(pid: number, now: number = Date.now()): number | undefined {
	try {
		if (process.platform === 'win32') return undefined; // no cheap synchronous source
		const { execFileSync } = require('child_process') as typeof import('child_process');
		// `etime` is elapsed wall-clock time: [[dd-]hh:]mm:ss
		const out = String(
			execFileSync('ps', ['-p', String(pid), '-o', 'etime='], { timeout: 2_000 })
		).trim();
		if (!out) return undefined;
		const elapsedMs = parseElapsed(out);
		if (elapsedMs === undefined) return undefined;
		return now - elapsedMs;
	} catch {
		return undefined;
	}
}

/** Parse `ps -o etime=` output ([[dd-]hh:]mm:ss) into milliseconds. */
export function parseElapsed(value: string): number | undefined {
	const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(value.trim());
	if (!match) return undefined;
	const [, dd, hh, mm, ss] = match;
	const days = dd ? parseInt(dd, 10) : 0;
	const hours = hh ? parseInt(hh, 10) : 0;
	const minutes = parseInt(mm, 10);
	const seconds = parseInt(ss, 10);
	return ((days * 24 + hours) * 60 + minutes) * 60_000 + seconds * 1_000;
}

export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err: any) {
		// EPERM means the process exists but belongs to another user.
		return err?.code === 'EPERM';
	}
}

/**
 * Decide whether a lease represents a live owner.
 *
 * `startTimeFor` is injected so the reuse rules can be tested deterministically
 * without spawning processes.
 */
export function evaluateLease(
	lease: OwnerLease | undefined,
	options: {
		now?: number;
		selfPid?: number;
		isAlive?: (pid: number) => boolean;
		startTimeFor?: (pid: number) => number | undefined;
		staleAfterMs?: number;
	} = {}
): LeaseVerdict {
	if (!lease) return { status: 'none' };

	const now = options.now ?? Date.now();
	const selfPid = options.selfPid ?? process.pid;
	const isAlive = options.isAlive ?? pidAlive;
	const startTimeFor = options.startTimeFor ?? ((pid: number) => processStartTime(pid, now));
	const staleAfter = options.staleAfterMs ?? LEASE_STALE_AFTER_MS;

	if (lease.pid === selfPid) return { status: 'self', lease };

	if (!isAlive(lease.pid)) {
		return { status: 'stale', lease, reason: 'dead-pid' };
	}

	// The PID is alive — but is it the *same* process that took the lease?
	const actualStart = startTimeFor(lease.pid);
	if (
		actualStart !== undefined &&
		typeof lease.processStartedAt === 'number' &&
		// `ps` reports whole seconds, so allow a couple of seconds of slack.
		Math.abs(actualStart - lease.processStartedAt) > 5_000
	) {
		return { status: 'stale', lease, reason: 'pid-reused' };
	}

	if (now - (lease.lastHeartbeatAt ?? 0) > staleAfter) {
		return { status: 'stale', lease, reason: 'heartbeat-expired' };
	}

	return { status: 'live', lease };
}

export function readLease(file: string = leaseFilePath()): OwnerLease | undefined {
	try {
		const raw = fs.readFileSync(file, 'utf8');
		const data = JSON.parse(raw);
		if (typeof data?.pid !== 'number') return undefined;
		return data as OwnerLease;
	} catch {
		return undefined;
	}
}

/**
 * Write the lease atomically: a reader must never observe a half-written file,
 * and a crash mid-write must not destroy the previous claim.
 */
export function writeLease(lease: OwnerLease, file: string = leaseFilePath()): boolean {
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const tmp = `${file}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(lease, null, 2), { mode: 0o600 });
		fs.renameSync(tmp, file); // atomic within a directory
		return true;
	} catch {
		return false;
	}
}

/**
 * Release the lease — but only our own. A non-owner must never remove the
 * active owner's claim; that is precisely the bug that left healthy bridges
 * undiscoverable.
 */
export function releaseLease(file: string = leaseFilePath(), selfPid: number = process.pid): void {
	try {
		const existing = readLease(file);
		if (existing && existing.pid !== selfPid) return;
		fs.unlinkSync(file);
	} catch {
		/* already gone */
	}
}
