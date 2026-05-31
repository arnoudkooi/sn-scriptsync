// Runtime shim. The dispatcher needs three pieces of host state that live in
// extension.ts: the WebSocket broadcaster, a debug logger, and the running
// status of the WS server. Rather than importing the whole extension.ts
// (circular) the host wires up this shim during activate().

import { AgentContext, AgentRequest } from './types';
import * as pendingRegistry from './pendingRegistry';
import * as vscode from 'vscode';

export interface Runtime {
	sendToBrowser(payload: any): void;
	hasBrowserClient(): boolean;
	isServerRunning(): boolean;
	log(message: string): void;
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
		workspaceRoot: vscode.workspace.rootPath || '',
		sendToBrowser: (payload) => r.sendToBrowser(payload),
		hasBrowserClient: () => r.hasBrowserClient(),
		isServerRunning: () => r.isServerRunning(),
		log: (msg) => r.log(msg),
		waitForBrowserResponse: <T = any>(correlationId: string, timeoutMs = DEFAULT_BROWSER_TIMEOUT_MS) =>
			pendingRegistry.register<T>({
				id: correlationId,
				command: request.command,
				instanceFolder,
				timeoutMs,
			}),
	};
}
