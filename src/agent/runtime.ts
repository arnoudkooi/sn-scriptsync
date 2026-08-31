// Runtime shim. The dispatcher needs three pieces of host state that live in
// extension.ts: the WebSocket broadcaster, a debug logger, and the running
// status of the WS server. Rather than importing the whole extension.ts
// (circular) the host wires up this shim during activate().

import { AgentContext, AgentRequest, HelperBuildInfo, StagedWriteMeta, StagedWriteResult } from './types';
import * as pendingRegistry from './pendingRegistry';
import { getWorkspaceRoot } from '../workspaceRoot';
import { LiveInstanceReference } from './instanceSelection';

export interface Runtime {
	sendToBrowser(payload: any): void;
	hasBrowserClient(): boolean;
	isServerRunning(): boolean;
	log(message: string): void;
	/** True when Agent API writes should be staged for review (optional;
	 * absent/false means writes go straight through). */
	reviewWritesEnabled?(): boolean;
	/** Host hook that parks a write in the Pending Saves queue. */
	stageAgentWrite?(input: StagedWriteMeta & { request: AgentRequest; instanceFolder: string }): StagedWriteResult;
	/** Build/license handshake of the connected helper tab, if any. */
	getHelperBuildInfo?(): HelperBuildInfo | null;
	getInstanceGates?(origin: string): Record<string, any> | null;
	/** Instances observed on the current helper connection, newest first. */
	getLiveInstances?(): LiveInstanceReference[];
	/** Stop the bridge from a remote request (`snu stop`/`snu restart` against an
	 * editor-hosted bridge). Resolves once the ports are released. */
	stopBridge?(): Promise<void>;
	/** Stop and start again in one lifecycle-serialised operation. This is what
	 * removes the manual `kill` from editor-host recovery. */
	restartBridge?(): Promise<void>;
	/** Current lifecycle state, for health and diagnostics. */
	bridgeState?(): string;
}

let runtime: Runtime | undefined;

export function setRuntime(r: Runtime) {
	runtime = r;
}

export function getRuntime(): Runtime {
	if (!runtime) {
		throw new Error('Agent runtime not initialised. Call setRuntime() in extension.ts activate().');
	}
	return runtime;
}

/** Default timeout for round-trip browser commands. */
export const DEFAULT_BROWSER_TIMEOUT_MS = 60_000;

export function buildContext(request: AgentRequest, instanceFolder: string): AgentContext {
	const r = getRuntime();
	return {
		request,
		instanceFolder,
		workspaceRoot: getWorkspaceRoot() || '',
		sendToBrowser: (payload) => r.sendToBrowser(payload),
		hasBrowserClient: () => r.hasBrowserClient(),
		isServerRunning: () => r.isServerRunning(),
		log: (msg) => r.log(msg),
		reviewWritesEnabled: () => (r.reviewWritesEnabled ? r.reviewWritesEnabled() : false),
		getHelperBuildInfo: () => (r.getHelperBuildInfo ? r.getHelperBuildInfo() : null),
		getInstanceGates: (origin) => (r.getInstanceGates ? r.getInstanceGates(origin) : null),
		stageWrite: (meta) => {
			if (!r.stageAgentWrite) {
				throw new Error('Review mode is on but the host did not wire stageAgentWrite().');
			}
			return r.stageAgentWrite({ ...meta, request, instanceFolder });
		},
		waitForBrowserResponse: <T = any>(correlationId: string, timeoutMs = DEFAULT_BROWSER_TIMEOUT_MS) =>
			pendingRegistry.register<T>({
				id: correlationId,
				requestId: request.id,
				command: request.command,
				instanceFolder,
				timeoutMs,
			}),
	};
}
