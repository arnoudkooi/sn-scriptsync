import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentPortFile } from './types';

// v2 -> v3: added get_record, delete_record, create_application, add_column,
// get_served_url, navigate_and_screenshot, rest_request; await:true write
// confirmation on update_record/update_record_batch/create_artifact.
// v3 -> v4: added run_background_script + delete_application (browser-side
// agentRunBackgroundScript path), screenshot exactUrl + E_SCREENSHOT_PERMISSION.
// v4 -> v5: added code_search (SN Utils GraphQL field-index code search, Pro).
// v5 -> v6: added get_capabilities (helper-tab capability probe: license tier +
// CDP/browser-debugger availability, so agents can preflight instead of probing).
export const AGENT_API_VERSION = 6;

function portFilePath(): string | undefined {
	const root = vscode.workspace.rootPath;
	if (!root) return undefined;
	return path.join(root, '.vscode', 'sn-agent-port.json');
}

export function writePortFile(data: Omit<AgentPortFile, 'apiVersion' | 'startedAt'>): string | undefined {
	const target = portFilePath();
	if (!target) return undefined;
	try {
		fs.mkdirSync(path.dirname(target), { recursive: true });
		const payload: AgentPortFile = {
			...data,
			apiVersion: AGENT_API_VERSION,
			startedAt: Date.now(),
		};
		fs.writeFileSync(target, JSON.stringify(payload, null, 2));
		return target;
	} catch {
		return undefined;
	}
}

export function deletePortFile(): void {
	const target = portFilePath();
	if (!target) return;
	try {
		if (fs.existsSync(target)) fs.unlinkSync(target);
	} catch { /* ignore */ }
}

export function getPortFilePath(): string | undefined {
	return portFilePath();
}
