// Wire-format interfaces shared by every transport and every command.
// Nothing in this file knows about HTTP, the file system, or ServiceNow.

export interface AgentRequest {
	id: string;
	command: string;
	params?: any;
	/** Optional instance folder name. When omitted the dispatcher falls back
	 * to the sole instance folder in the workspace. */
	instance?: string;
	timestamp?: number;
}

export interface AgentResponse {
	id: string;
	command: string;
	status: 'success' | 'error';
	result?: any;
	error?: string;
	/** Structured error code (see errors.ts). Present when status === 'error'. */
	code?: string;
	timestamp: number;
}

/**
 * The runtime a command handler sees. Commands never touch ws, fs, or the VS
 * Code API directly; they ask the context.
 */
export interface AgentContext {
	request: AgentRequest;
	instanceFolder: string;
	workspaceRoot: string;
	/** Push a message to the connected browser helper tab. */
	sendToBrowser(payload: any): void;
	/** Register this request id so the matching browser response resolves it. */
	waitForBrowserResponse<T = any>(correlationId: string, timeoutMs?: number): Promise<T>;
	/** Structured debug log. Writes to debug.log when debugLogging is on. */
	log(message: string): void;
	/** Check whether the WebSocket browser bridge is ready. */
	hasBrowserClient(): boolean;
	/** True if the WS server is up (irrespective of clients). */
	isServerRunning(): boolean;
}

export interface CommandExample {
	curl?: string;
	powershell?: string;
}

export interface CommandDocs {
	/** One-line description. */
	summary: string;
	/** Longer-form markdown description. Optional. */
	description?: string;
	/** Example request body. */
	request?: any;
	/** Example response body. */
	response?: any;
	/** Additional notes, tips, gotchas. */
	notes?: string;
	examples?: CommandExample[];
}

export interface CommandHandler<P = any, R = any> {
	name: string;
	/** When true the handler does not need an instance folder (e.g. health). */
	noInstance?: boolean;
	/** When true the handler requires a live browser bridge. */
	requiresBrowser?: boolean;
	handle(ctx: AgentContext, params: P): Promise<R>;
	docs: CommandDocs;
}

/** Metadata written to .vscode/sn-agent-port.json for agents to discover. */
export interface AgentPortFile {
	port: number;
	token: string;
	pid: number;
	apiVersion: number;
	startedAt: number;
	extensionVersion?: string;
}
