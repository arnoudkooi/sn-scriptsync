// Structured error codes for the Agent API. Transports map these onto HTTP
// status codes or file responses without string-sniffing.

export type AgentErrorCode =
	| 'E_UNKNOWN_COMMAND'
	| 'E_INVALID_PARAMS'
	| 'E_INVALID_REQUEST'
	| 'E_INSTANCE_REQUIRED'
	| 'E_INSTANCE_NOT_FOUND'
	| 'E_SERVER_NOT_RUNNING'
	| 'E_BROWSER_DISCONNECTED'
	| 'E_TIMEOUT'
	| 'E_ACL'
	| 'E_TOKEN_EXPIRED'
	| 'E_UNAUTHORIZED'
	| 'E_SECURITY'
	| 'E_DISABLED'
	| 'E_NOT_FOUND'
	| 'E_CONFIRM_REQUIRED'
	| 'E_REFERENCE_INTEGRITY'
	| 'E_PARTIAL_FAILURE'
	| 'E_SCREENSHOT_PERMISSION'
	| 'E_INTERNAL';

export class AgentError extends Error {
	code: AgentErrorCode;
	details?: any;

	constructor(code: AgentErrorCode, message: string, details?: any) {
		super(message);
		this.name = 'AgentError';
		this.code = code;
		this.details = details;
	}
}

/** Map an AgentErrorCode to an HTTP status. Unknown codes default to 500. */
export function httpStatusForCode(code?: string): number {
	switch (code) {
		case 'E_INVALID_PARAMS':
		case 'E_INVALID_REQUEST':
		case 'E_CONFIRM_REQUIRED':
			return 400;
		case 'E_UNAUTHORIZED':
		case 'E_SECURITY':
			return 401;
		case 'E_UNKNOWN_COMMAND':
		case 'E_NOT_FOUND':
			return 404;
		case 'E_REFERENCE_INTEGRITY':
			return 409;
		case 'E_INSTANCE_REQUIRED':
		case 'E_INSTANCE_NOT_FOUND':
			return 422;
		case 'E_DISABLED':
			return 423;
		case 'E_PARTIAL_FAILURE':
			return 207;
		case 'E_SCREENSHOT_PERMISSION':
			return 502;
		case 'E_TIMEOUT':
			return 504;
		case 'E_BROWSER_DISCONNECTED':
		case 'E_SERVER_NOT_RUNNING':
			return 503;
		case 'E_ACL':
		case 'E_TOKEN_EXPIRED':
			return 502;
		case 'E_INTERNAL':
		default:
			return 500;
	}
}

/** Best-effort code inference from a raw remote error detail. */
export function inferCodeFromMessage(msg: string | undefined): AgentErrorCode {
	if (!msg) return 'E_INTERNAL';
	const lower = msg.toLowerCase();
	if (lower.includes('acl')) return 'E_ACL';
	if (lower.includes('auth') || lower.includes('token')) return 'E_TOKEN_EXPIRED';
	if (lower.includes('browser')) return 'E_BROWSER_DISCONNECTED';
	if (lower.includes('timeout')) return 'E_TIMEOUT';
	return 'E_INTERNAL';
}
