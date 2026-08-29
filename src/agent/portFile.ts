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
// v7 -> v8: Two-phase Monaco review protocol, command policies, per-instance
// monotonic gate cache, deny-wins security model, cancellation propagation,
// structured userFeedback and E_USER_REJECTED.
// v8 -> v9: added pull_records (and pull_artifacts alias) for bulk and single
// artifact pulling to canonical local workspace files with _map.json sync.
export const AGENT_API_VERSION = 9;

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
let globalPortFileEnabled = false;

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
	globalPortFileEnabled = enabled;
	if (enabled && lastPayload) writeOne(globalPortFilePath(), lastPayload);
	else removeGlobalPortFile();
}

/**
 * Re-write any port file of the live bridge that has gone missing or stale.
 * Older ScriptSync builds in a second editor window blindly delete the global
 * port file on their own start/stop, leaving this healthy bridge undiscoverable
 * from outside its workspace. Called on helper (re)connects and on a slow
 * heartbeat so such deletions heal automatically. A file owned by another live
 * bridge process is left alone, matching removeIfOwnedOrDead.
 */
export function reassertPortFiles(): void {
	if (!lastPayload) return;
	const targets: string[] = [];
	const workspaceTarget = workspacePortFilePath();
	if (workspaceTarget) targets.push(workspaceTarget);
	if (globalPortFileEnabled) targets.push(globalPortFilePath());
	for (const target of targets) {
		if (needsReassert(target)) writeOne(target, lastPayload);
	}
}

function needsReassert(target: string): boolean {
	try {
		if (!fs.existsSync(target)) return true;
		const data = JSON.parse(fs.readFileSync(target, 'utf8'));
		if (data?.pid === lastPayload!.pid) {
			// Our own file — repair it only if the contents drifted.
			return data.port !== lastPayload!.port || data.token !== lastPayload!.token;
		}
		if (typeof data?.pid === 'number' && pidAlive(data.pid)) {
			return false; // a live foreign bridge owns this file — leave it
		}
		return true; // dead owner or invalid structure
	} catch {
		return true; // unreadable or corrupt
	}
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err: any) {
		// EPERM: the process exists but belongs to another user.
		return err?.code === 'EPERM';
	}
}

/**
 * Delete a port file unless it belongs to another live bridge process. A
 * standalone `snu` bridge (e.g. spawned in-process by an MCP client) registers
 * itself through these same files; blindly deleting them here used to leave
 * that bridge undiscoverable — still holding ports 1977/1978 with no way for
 * `snu stop` or the next ScriptSync start to find it.
 */
function removeIfOwnedOrDead(target: string): void {
	try {
		if (!fs.existsSync(target)) return;
		try {
			const data = JSON.parse(fs.readFileSync(target, 'utf8'));
			if (typeof data?.pid === 'number' && data.pid !== process.pid && pidAlive(data.pid)) {
				return; // a live foreign bridge owns this file — leave it discoverable
			}
		} catch { /* corrupt file — safe to delete */ }
		fs.unlinkSync(target);
	} catch { /* ignore */ }
}

function removeGlobalPortFile(): void {
	removeIfOwnedOrDead(globalPortFilePath());
}

export function deletePortFile(): void {
	// The bridge is going down — make sure a late reassert can't resurrect
	// the files it is about to remove.
	lastPayload = undefined;
	[workspacePortFilePath(), globalPortFilePath()].forEach((target) => {
		if (!target) return;
		removeIfOwnedOrDead(target);
	});
}

export function getPortFilePath(): string | undefined {
	return workspacePortFilePath();
}
