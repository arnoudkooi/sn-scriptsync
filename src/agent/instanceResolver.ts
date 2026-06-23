import * as fs from 'fs';
import * as path from 'path';
import { getWorkspaceRoot } from '../workspaceRoot';
import { AgentError } from './errors';

const NON_INSTANCE_FOLDERS = new Set([
	'.vscode', '.cursor', '.git', 'node_modules',
	'profiles', 'profile', 'screenshots', 'agentrules', 'autocomplete',
]);

function hasSettings(folder: string): boolean {
	return fs.existsSync(path.join(folder, '_settings.json'))
		|| fs.existsSync(path.join(folder, 'settings.json'));
}

/** Return every child folder of the workspace root that looks like an instance. */
export function listInstanceFolders(): string[] {
	const root = getWorkspaceRoot() || '';
	if (!root || !fs.existsSync(root)) return [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((d) => d.isDirectory() && !d.name.startsWith('.') && !NON_INSTANCE_FOLDERS.has(d.name.toLowerCase()))
		.map((d) => path.join(root, d.name))
		.filter(hasSettings);
}

/**
 * Resolve the instance folder for a request.
 *
 * Rules:
 * - If `request.instance` is provided, use workspaceRoot/<instance>.
 * - Otherwise, if exactly one instance folder exists, use it.
 * - Otherwise throw E_INSTANCE_REQUIRED.
 *
 * When `noInstance` is true the function returns the workspace root so
 * connection-check style commands still have a context folder to log into.
 */
export function resolveInstanceFolder(requestInstance: string | undefined, noInstance = false): string {
	const root = getWorkspaceRoot() || '';
	if (!root) {
		throw new AgentError('E_INSTANCE_REQUIRED', 'No workspace folder open');
	}

	if (requestInstance) {
		const folder = path.join(root, requestInstance);
		if (!folder.startsWith(root)) {
			throw new AgentError('E_SECURITY', 'Instance path escapes workspace');
		}
		if (!fs.existsSync(folder)) {
			throw new AgentError('E_INSTANCE_NOT_FOUND', `Instance folder not found: ${requestInstance}`);
		}
		if (!hasSettings(folder)) {
			throw new AgentError('E_INSTANCE_NOT_FOUND', `Instance folder missing _settings.json: ${requestInstance}`);
		}
		return folder;
	}

	const folders = listInstanceFolders();
	if (folders.length === 1) return folders[0];

	if (noInstance) return root;

	if (folders.length === 0) {
		throw new AgentError('E_INSTANCE_NOT_FOUND', 'No instance folder found in workspace');
	}
	throw new AgentError(
		'E_INSTANCE_REQUIRED',
		`Multiple instances found (${folders.map((f) => path.basename(f)).join(', ')}). Pass "instance": "<name>" in the request.`
	);
}

/**
 * Legacy: resolve an instance folder from a file path, the way
 * handleAgentRequest did by walking up three levels from
 * <instance>/agent/requests/<file>.json.
 */
export function instanceFolderFromRequestFile(requestPath: string): string {
	return path.dirname(path.dirname(path.dirname(requestPath)));
}
