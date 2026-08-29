// Public surface for extension.ts. extension.ts should only import from here.

export { setRuntime, Runtime } from './runtime';
export { setSyncStateProvider, SyncState } from './commands/connection';
export { dispatchAgentCommand } from './dispatcher';
export { AGENT_API_VERSION, getPortFilePath, setGlobalPortFileEnabled, reassertPortFiles } from './portFile';
export { startAgentHttpServer, stopAgentHttpServer, HttpServerState, AGENT_CONNECT_SNIPPET } from './transport/http';
export { findPortListener, classifyListener, terminateListener, isPortFree } from './portReclaim';
export * as pendingRegistry from './pendingRegistry';
export { AgentError, AgentErrorCode, httpStatusForCode, inferCodeFromMessage } from './errors';
export { listCommands, commandNames } from './commands';
export { BridgeLifecycle } from './lifecycle';
export type { LifecycleState, LifecycleTransports, StartOutcome } from './lifecycle';
export {
	evaluateLease,
	readLease,
	writeLease,
	releaseLease,
	leaseFilePath,
	processStartTime,
	LEASE_HEARTBEAT_MS,
} from './ownerLease';
export type { OwnerLease, LeaseVerdict } from './ownerLease';
export type { AgentRequest } from './types';
