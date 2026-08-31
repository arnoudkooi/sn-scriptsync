import * as fs from 'fs';
import * as path from 'path';
import { getWorkspaceRoot } from '../workspaceRoot';
import { AgentError } from './errors';
import { LiveInstanceReference, selectKnownInstance } from './instanceSelection';

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
export function resolveInstanceFolder(
	requestInstance: string | undefined,
	noInstance = false,
	liveInstances: LiveInstanceReference[] = []
): string {
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
	const known = folders.map((folder) => {
		let url: string | null = null;
		try {
			const settingsPath = fs.existsSync(path.join(folder, '_settings.json'))
				? path.join(folder, '_settings.json')
				: path.join(folder, 'settings.json');
			url = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))?.url || null;
		} catch {}
		return { name: path.basename(folder), folder, url };
	});
	const selection = selectKnownInstance(known, liveInstances);
	if (selection.kind === 'single') return selection.instance.folder;

	const knownInstances = known.map((item) => item.name);
	const connectedInstances = selection.kind === 'multiple-live'
		? selection.instances.map((item) => item.name)
		: [];
	const names = (connectedInstances.length ? connectedInstances : knownInstances).join(', ');
	const message = connectedInstances.length
		? `Multiple helper-connected instances found (${names}). Pass "instance": "<name>" in the request.`
		: `Multiple known workspace instances found (${names}); this does not mean they have live helper sessions. Pass "instance": "<name>" in the request.`;
	throw new AgentError('E_INSTANCE_REQUIRED', message, { knownInstances, connectedInstances });
}

/**
 * Legacy: resolve an instance folder from a file path, the way
 * handleAgentRequest did by walking up three levels from
 * <instance>/agent/requests/<file>.json.
 */
export function instanceFolderFromRequestFile(requestPath: string): string {
	return path.dirname(path.dirname(path.dirname(requestPath)));
}
