// Public surface for extension.ts. extension.ts should only import from here.

export { setRuntime, Runtime } from './runtime';
export { setSyncStateProvider, SyncState } from './commands/connection';
export { dispatchAgentCommand } from './dispatcher';
export { AGENT_API_VERSION, getPortFilePath } from './portFile';
export { startAgentHttpServer, stopAgentHttpServer, HttpServerState } from './transport/http';
export { startAgentFileTransport, logAgentRequestToFile, FileTransportHandle } from './transport/file';
export * as pendingRegistry from './pendingRegistry';
export { AgentError, AgentErrorCode, httpStatusForCode, inferCodeFromMessage } from './errors';
export { listCommands, commandNames } from './commands';
export type { AgentRequest } from './types';
