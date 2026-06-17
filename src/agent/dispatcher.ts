import { AgentRequest, AgentResponse } from './types';
import { AgentError } from './errors';
import { getCommand } from './commands';
import { resolveInstanceFolder } from './instanceResolver';
import { buildContext } from './runtime';

const VALID_ID = /^[a-zA-Z0-9_-]+$/;

function errorResponse(id: string, command: string, code: string, message: string): AgentResponse {
	return {
		id,
		command,
		status: 'error',
		error: message,
		code,
		timestamp: Date.now(),
	};
}

/**
 * Framework entry point. Every transport (HTTP, file) calls this and nothing
 * else.  No ServiceNow logic lives here.
 */
export async function dispatchAgentCommand(request: AgentRequest): Promise<AgentResponse> {
	if (!request || typeof request !== 'object') {
		return errorResponse('unknown', 'unknown', 'E_INVALID_REQUEST', 'Request must be a JSON object');
	}
	if (!request.id || !request.command) {
		return errorResponse(request?.id || 'unknown', request?.command || 'unknown', 'E_INVALID_REQUEST', 'Missing required fields: id, command');
	}
	if (!VALID_ID.test(request.id)) {
		return errorResponse(request.id, request.command, 'E_SECURITY', 'Invalid request id: only [a-zA-Z0-9_-] allowed');
	}

	const handler = getCommand(request.command);
	if (!handler) {
		return errorResponse(request.id, request.command, 'E_UNKNOWN_COMMAND', `Unknown command: ${request.command}`);
	}

	let instanceFolder: string;
	try {
		instanceFolder = resolveInstanceFolder(request.instance, handler.noInstance);
	} catch (e: any) {
		if (e instanceof AgentError) {
			return errorResponse(request.id, request.command, e.code, e.message);
		}
		console.error('[agent] instance resolution failed:', e?.stack || e);
		return errorResponse(request.id, request.command, 'E_INTERNAL', 'Failed to resolve instance folder');
	}

	const ctx = buildContext(request, instanceFolder);

	if (handler.requiresBrowser) {
		if (!ctx.isServerRunning()) {
			return errorResponse(request.id, request.command, 'E_SERVER_NOT_RUNNING', 'WebSocket server not running. Click sn-scriptsync in VS Code status bar to start.');
		}
		if (!ctx.hasBrowserClient()) {
			return errorResponse(request.id, request.command, 'E_BROWSER_DISCONNECTED', 'No browser connection. Open SN Utils helper tab via /token command.');
		}
	}

	try {
		const result = await handler.handle(ctx, request.params || {});
		return {
			id: request.id,
			command: request.command,
			status: 'success',
			result,
			timestamp: Date.now(),
		};
	} catch (err: any) {
		if (err instanceof AgentError) {
			return errorResponse(request.id, request.command, err.code, err.message);
		}
		console.error(`[agent] command "${request.command}" failed:`, err?.stack || err);
		return errorResponse(request.id, request.command, 'E_INTERNAL', 'Internal error while handling the command');
	}
}
