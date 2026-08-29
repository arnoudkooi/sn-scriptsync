import { HealthResponse } from '../types.js';

/**
 * How an MCP server (or any client) should obtain a bridge.
 *
 * The old rule was "if discovery fails, take port 1978 and start our own". That
 * conflates two very different failures. Discovery fails when the *descriptor*
 * is missing, stale, or clobbered — which says nothing about whether a bridge
 * is running. A healthy standalone bridge started by another MCP client whose
 * port file had been removed was therefore stopped and replaced, which is the
 * "multiple MCP clients reclaim each other's ports" failure exactly.
 *
 * A running bridge is proven by its health endpoint, not by a file. So an
 * undiscoverable-but-serving bridge is attached to, never displaced; only a
 * port held by something that answers nothing may be reclaimed.
 *
 * Pure decision logic with injected probes: no sockets, no process control.
 */

export type AttachmentMode =
	/** Found through the normal port-descriptor path. */
	| 'attached-discovered'
	/** Serving, but its descriptor was missing or stale. Attached anyway. */
	| 'attached-undiscoverable'
	/** No bridge was serving; this process must start one. */
	| 'create-standalone';

export interface BridgeAttachment {
	mode: AttachmentMode;
	/** HTTP port of the bridge to talk to, when one was found. */
	port?: number;
	pid?: number;
	hostKind?: string;
	/** Human-readable explanation, surfaced in MCP startup logs and diagnostics. */
	reason: string;
	/**
	 * True only when the caller is allowed to reclaim a held port before
	 * binding. Never true while any bridge is answering.
	 */
	mayReclaimPorts: boolean;
}

export interface AttachmentProbes {
	/** Normal discovery. Should reject the way discoverBridge does. */
	discover: () => Promise<{ port: number; pid: number } | undefined>;
	/** Probe a port's health endpoint; undefined when nothing healthy answers. */
	probeHealth: (port: number) => Promise<HealthResponse | undefined>;
	/** Ports to check when discovery fails, in order. */
	candidatePorts?: number[];
}

export const DEFAULT_HTTP_PORT = 1977;

/**
 * Decide how to obtain a bridge, without changing anything.
 *
 * Discovery failures that mean "no bridge" and failures that mean "a bridge is
 * running but is not registered" are deliberately handled the same way here:
 * both fall through to a health probe, because only the probe can tell them
 * apart.
 */
export async function resolveBridgeAttachment(probes: AttachmentProbes): Promise<BridgeAttachment> {
	try {
		const found = await probes.discover();
		if (found) {
			return {
				mode: 'attached-discovered',
				port: found.port,
				pid: found.pid,
				reason: `Attached to the bridge registered on port ${found.port} (PID ${found.pid}).`,
				mayReclaimPorts: false,
			};
		}
	} catch {
		// Discovery says nothing about whether a bridge is running — only that
		// no usable descriptor was found. Fall through and ask the ports.
	}

	const candidates = probes.candidatePorts ?? [DEFAULT_HTTP_PORT];
	for (const port of candidates) {
		const health = await probes.probeHealth(port);
		if (health) {
			return {
				mode: 'attached-undiscoverable',
				port,
				pid: health.pid,
				hostKind: health.hostKind,
				reason:
					`Attached to a healthy ${health.hostKind || 'unknown'} bridge on port ${port} (PID ${health.pid}) ` +
					`whose port descriptor was missing or stale. It was not replaced.`,
				mayReclaimPorts: false,
			};
		}
	}

	return {
		mode: 'create-standalone',
		reason: 'No bridge is answering on the known ports; starting an in-process standalone bridge.',
		mayReclaimPorts: true,
	};
}
