/**
 * The single source of truth for "does a live bridge already own the ports?".
 *
 * There used to be two answers, which disagreed. The port descriptor asked
 * only `pidAlive(pid)`; the owner lease asked PID + process start time +
 * heartbeat. Descriptor reassertion, takeover, startup and status each reached
 * for whichever was nearest, so ownership meant different things depending on
 * which code path you were in. Every caller now goes through this module.
 *
 * Two rules shape the resolution order:
 *
 * 1. A lease is the strongest evidence, but its ABSENCE proves nothing. Only
 *    this extension writes one. A standalone `snu serve` / `snu --mcp` bridge
 *    registers itself with a port descriptor alone, and so does any older
 *    ScriptSync build in another window. Treating "no lease" as "unowned"
 *    would let this window clobber a perfectly healthy bridge — which is the
 *    original alive-but-undiscoverable bug, reintroduced from the other side.
 *
 * 2. Process liveness is not bridge liveness. A host whose event loop is fine
 *    while its HTTP listener is wedged still answers `kill -0`. So the
 *    descriptor fallback does not ask whether the PID exists; it asks whether
 *    the advertised endpoint still answers, which is the property every
 *    consumer actually depends on.
 *
 * Host-agnostic and fully injectable, so the ownership matrix is testable
 * without processes, sockets or an extension host.
 */

import { OwnerLease, evaluateLease, readLease, pidAlive } from './ownerLease';

export type OwnershipSource = 'lease' | 'descriptor';

export type BridgeOwnership =
	/** Nothing credible claims the bridge. The caller may take it. */
	| { state: 'claimable'; reason: string }
	/** This process is the owner. */
	| { state: 'self'; pid: number }
	/** Someone else owns it and is demonstrably serving. Keep off. */
	| { state: 'live'; pid: number; source: OwnershipSource; lease?: OwnerLease; port?: number };

/** The subset of the port descriptor that ownership cares about. */
export interface PortDescriptor {
	pid?: number;
	port?: number;
	token?: string;
	hostKind?: string;
}

export interface OwnershipProbes {
	readLease?: () => OwnerLease | undefined;
	readDescriptor?: () => PortDescriptor | undefined;
	isAlive?: (pid: number) => boolean;
	/** True when the bridge at this port answers its health endpoint. */
	isReachable?: (port: number) => Promise<boolean>;
	startTimeFor?: (pid: number) => number | undefined;
	now?: number;
	selfPid?: number;
}

/** How long to wait for a foreign bridge's health endpoint before calling it unreachable. */
export const OWNERSHIP_PROBE_TIMEOUT_MS = 1_200;

/**
 * Probe a bridge's health endpoint. Deliberately unauthenticated: /api/health
 * needs no token, so ownership can be resolved without reading anyone's
 * credentials.
 */
export async function probeBridgeHealth(
	port: number,
	timeoutMs = OWNERSHIP_PROBE_TIMEOUT_MS
): Promise<boolean> {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: controller.signal });
			return res.ok;
		} finally {
			clearTimeout(timer);
		}
	} catch {
		return false;
	}
}

/**
 * Resolve who owns the bridge right now.
 *
 * Order: our own claim, then a live lease, then a reachable descriptor. A
 * stale lease does not short-circuit — an older build or a standalone bridge
 * may still hold the ports without ever having written one.
 */
export async function resolveBridgeOwnership(probes: OwnershipProbes = {}): Promise<BridgeOwnership> {
	const selfPid = probes.selfPid ?? process.pid;
	const now = probes.now ?? Date.now();
	const isAlive = probes.isAlive ?? pidAlive;
	const isReachable = probes.isReachable ?? ((port: number) => probeBridgeHealth(port));
	const lease = (probes.readLease ?? readLease)();

	const verdict = evaluateLease(lease, {
		now,
		selfPid,
		isAlive,
		startTimeFor: probes.startTimeFor,
	});

	if (verdict.status === 'self') {
		return { state: 'self', pid: verdict.lease.pid };
	}
	if (verdict.status === 'live') {
		return { state: 'live', pid: verdict.lease.pid, source: 'lease', lease: verdict.lease };
	}

	// No usable lease. That is not evidence of absence: fall through and ask the
	// descriptor, which every bridge writes regardless of version or host.
	const staleReason =
		verdict.status === 'stale' ? `lease ${verdict.reason}` : 'no lease';

	const descriptor = (probes.readDescriptor ?? (() => undefined))();
	const pid = typeof descriptor?.pid === 'number' ? descriptor.pid : undefined;
	const port = typeof descriptor?.port === 'number' ? descriptor.port : undefined;

	if (pid === undefined || port === undefined) {
		return { state: 'claimable', reason: `${staleReason}, no usable port descriptor` };
	}
	if (pid === selfPid) {
		return { state: 'self', pid };
	}
	if (!isAlive(pid)) {
		return { state: 'claimable', reason: `${staleReason}, descriptor owner ${pid} is gone` };
	}

	// The PID is alive — but that is exactly the proxy that misleads. Ask the
	// endpoint itself, which is what a consumer would have to reach.
	if (await isReachable(port)) {
		return { state: 'live', pid, source: 'descriptor', port };
	}

	return {
		state: 'claimable',
		reason: `${staleReason}, descriptor owner ${pid} is alive but its bridge on ${port} does not answer`,
	};
}

/** Convenience: may this process take the bridge? */
export async function bridgeIsClaimable(probes: OwnershipProbes = {}): Promise<boolean> {
	const ownership = await resolveBridgeOwnership(probes);
	return ownership.state !== 'live';
}
