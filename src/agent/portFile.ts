import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getWorkspaceRoot } from '../workspaceRoot';
import { AgentPortFile } from './types';

// v2 -> v3: added get_record, delete_record, create_application, add_column,
// get_served_url, navigate_and_screenshot, rest_request; await:true write
// confirmation on update_record/update_record_batch/create_artifact.
// v3 -> v4: added run_background_script + delete_application (browser-side
// agentRunBackgroundScript path), screenshot exactUrl + E_SCREENSHOT_PERMISSION.
// v4 -> v5: added code_search (SN Utils GraphQL field-index code search, Pro).
// v5 -> v6: added get_capabilities (helper-tab capability probe: license tier +
// CDP/browser-debugger availability, so agents can preflight instead of probing).
// v6 -> v7: fixed port 1977 (ephemeral fallback) + global port file
// (~/.sn-scriptsync/agent-port.json) + self-describing docs endpoints
// (GET /api/instructions, /api/skills[/<name>]); check_connection reports the
// connected SN Utils build (helper.*); new E_PAUSED refusal (helper-tab pause
// switch). All additive.
export const AGENT_API_VERSION = 7;

/** Preferred fixed port for the Agent API. If it's taken the server falls back
 * to an ephemeral port — the port files below always carry the actual port. */
export const AGENT_API_FIXED_PORT = 1977;

function workspacePortFilePath(): string | undefined {
	const root = getWorkspaceRoot();
	if (!root) return undefined;
	return path.join(root, '.vscode', 'sn-agent-port.json');
}

/** Well-known per-user location so agents in any directory (terminal sessions,
 * dedicated apps) can discover the endpoint without knowing the workspace.
 * Lives outside iCloud-synced folders on macOS. */
export function globalPortFilePath(): string {
	return path.join(os.homedir(), '.sn-scriptsync', 'agent-port.json');
}

function writeOne(target: string, payload: AgentPortFile): boolean {
	try {
		fs.mkdirSync(path.dirname(target), { recursive: true });
		// The file carries the auth token — scope it to the current user.
		fs.writeFileSync(target, JSON.stringify(payload, null, 2), { mode: 0o600 });
		try { fs.chmodSync(target, 0o600); } catch { /* best effort (Windows) */ }
		return true;
	} catch {
		return false;
	}
}

let lastPayload: AgentPortFile | undefined;

export function writePortFile(data: Omit<AgentPortFile, 'apiVersion' | 'startedAt'>): string | undefined {
	const payload: AgentPortFile = {
		...data,
		apiVersion: AGENT_API_VERSION,
		startedAt: Date.now(),
	};
	lastPayload = payload;
	// The workspace copy is always written — in-editor/workspace agent
	// workflows are free. The global copy (external-agent connectivity from
	// any directory: Claude Code, Codex, terminal tools) is Pro-gated: it is
	// only written via setGlobalPortFileEnabled(true) once the connected
	// helper reports a Pro/Trial/Enterprise license. Clear any stale copy
	// from a previous session until then.
	const workspaceTarget = workspacePortFilePath();
	const workspaceOk = workspaceTarget ? writeOne(workspaceTarget, payload) : false;
	removeGlobalPortFile();
	return workspaceOk ? workspaceTarget : undefined;
}

/** Toggle the well-known global port file based on the connected license. */
export function setGlobalPortFileEnabled(enabled: boolean): void {
	if (enabled && lastPayload) writeOne(globalPortFilePath(), lastPayload);
	else removeGlobalPortFile();
}

function removeGlobalPortFile(): void {
	try {
		if (fs.existsSync(globalPortFilePath())) fs.unlinkSync(globalPortFilePath());
	} catch { /* ignore */ }
}

export function deletePortFile(): void {
	[workspacePortFilePath(), globalPortFilePath()].forEach((target) => {
		if (!target) return;
		try {
			if (fs.existsSync(target)) fs.unlinkSync(target);
		} catch { /* ignore */ }
	});
}

export function getPortFilePath(): string | undefined {
	return workspacePortFilePath();
}
