// Legacy file-based transport. AI agents that predate the HTTP API drop a
// JSON request into <instance>/agent/requests/<id>.json; we write the
// matching response into <instance>/agent/responses/res_<id>.json. The
// implementation is intentionally thin – all the real work lives in the
// dispatcher.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { dispatchAgentCommand } from '../dispatcher';
import { AgentRequest, AgentResponse } from '../types';
import { instanceFolderFromRequestFile } from '../instanceResolver';
import { getWorkspaceRoot } from '../../workspaceRoot';

const processedIds = new Set<string>();

interface FileTransportDeps {
	log: (msg: string) => void;
	/** Append a one-line audit entry under <instance>/_requests.log. */
	audit?: (instanceFolder: string, request: AgentRequest, response: AgentResponse) => void;
}

export async function handleAgentRequestFile(requestPath: string, deps: FileTransportDeps): Promise<void> {
	try {
		const raw = fs.readFileSync(requestPath, 'utf8').trim();
		if (!raw || raw === '{}') return;

		let request: AgentRequest;
		try {
			request = JSON.parse(raw);
		} catch {
			deps.log(`Agent API (file): invalid JSON in ${requestPath}`);
			return;
		}
		if (!request?.id || !request?.command) return;

		// Dedupe – watchers fire both create and change events.
		if (processedIds.has(request.id)) return;
		processedIds.add(request.id);
		setTimeout(() => processedIds.delete(request.id), 5000);

		// File transport discovers the instance by walking three dirs up.
		// Inject the instance name into the request so the dispatcher doesn't
		// go hunting again.
		const instanceFolder = instanceFolderFromRequestFile(requestPath);
		const workspaceRoot = getWorkspaceRoot() || '';
		if (!workspaceRoot || !instanceFolder.startsWith(workspaceRoot)) {
			deps.log(`Agent API (file): refusing request outside workspace: ${requestPath}`);
			return;
		}
		if (!request.instance) request.instance = path.basename(instanceFolder);

		const response = await dispatchAgentCommand(request);

		const responseDir = path.join(instanceFolder, 'agent', 'responses');
		fs.mkdirSync(responseDir, { recursive: true });
		const responsePath = path.join(responseDir, `res_${request.id}.json`);
		fs.writeFileSync(responsePath, JSON.stringify(response, null, 2));
		deps.log(`Agent API (file): wrote ${responsePath} (${response.status})`);

		if (deps.audit) deps.audit(instanceFolder, request, response);
	} catch (e: any) {
		deps.log(`Agent API (file) error: ${e?.message || e}`);
	}
}

export interface FileTransportHandle {
	watcher: vscode.FileSystemWatcher;
	dispose(): void;
}

export function startAgentFileTransport(deps: FileTransportDeps): FileTransportHandle {
	const watcher = vscode.workspace.createFileSystemWatcher(
		new vscode.RelativePattern(getWorkspaceRoot() || '', '**/agent/requests/*.json')
	);

	const onEvent = (uri: vscode.Uri) => {
		deps.log(`Agent API (file): event on ${uri.fsPath}`);
		handleAgentRequestFile(uri.fsPath, deps);
	};
	watcher.onDidCreate(onEvent);
	watcher.onDidChange(onEvent);

	return {
		watcher,
		dispose() {
			watcher.dispose();
		},
	};
}

export function logAgentRequestToFile(instanceFolder: string, request: AgentRequest, response: AgentResponse): void {
	try {
		const logPath = path.join(instanceFolder, '_requests.log');
		const timestamp = new Date().toISOString();
		const entry = `[${timestamp}] ${request.command} (id: ${request.id}) - ${response.status}${response.error ? ': ' + response.error : ''}\n`;
		fs.appendFileSync(logPath, entry);
	} catch {
		/* ignore */
	}
}
