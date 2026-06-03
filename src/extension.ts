import { window, workspace, commands, Disposable, ExtensionContext, StatusBarAlignment, StatusBarItem, TextDocument } from 'vscode';

import * as WebSocket from 'ws';
import * as vscode from 'vscode';
import { ScopeTreeViewProvider } from "./ScopeTreeViewProvider";
import { InfoTreeViewProvider } from "./InfoTreeViewProvider";
import { QueueTreeViewProvider } from "./QueueTreeViewProvider";
import { ExtensionUtils } from "./ExtensionUtils";
import { Constants } from "./constants";
import * as path from "path";
import nodePath = require('path');
import * as fs from 'fs';
import {
	setRuntime as setAgentRuntime,
	setSyncStateProvider,
	startAgentHttpServer,
	stopAgentHttpServer,
	startAgentFileTransport,
	logAgentRequestToFile,
	pendingRegistry,
	inferCodeFromMessage,
	AGENT_API_VERSION,
	HttpServerState,
	FileTransportHandle,
} from './agent';



let sass = require('sass');
let metaDataRelations : any;
let scopeTableResponseCount = 0;
let scopeJson : any = {};

let wss;
let serverRunning = false;
let agentHttpState: HttpServerState | undefined;
let agentFileHandle: FileTransportHandle | undefined;
//let openFiles = {};

let scriptSyncStatusBarItem: vscode.StatusBarItem;

// Update context menu visibility based on settings and active editor
function updateContextMenuVisibility() {
	const editor = vscode.window.activeTextEditor;
	// Get config scoped to current document (for language-specific overrides) or global
	const config = vscode.workspace.getConfiguration('sn-scriptsync', editor?.document);
	const showMenu = config.get<boolean>('showContextMenu', true);
	vscode.commands.executeCommand('setContext', 'sn-scriptsync.showContextMenu', showMenu);
}

// Update server running context
function setServerRunningContext(running: boolean) {
	serverRunning = running;
	vscode.commands.executeCommand('setContext', 'sn-scriptsync.serverRunning', running);
}
let eu = new ExtensionUtils();
let watcher: vscode.FileSystemWatcher | undefined;
let queueProvider: QueueTreeViewProvider;

let lastSave = Math.floor(+new Date() / 1000); 

// Use a map to track which documents were manually saved #105
const manualSaveMap: Map<string, boolean> = new Map();
// Track all documents that went through onWillSaveTextDocument (any reason).
// "Save without formatting" skips this event entirely, so its absence signals a manual save. #119
const willSaveSeenMap: Map<string, boolean> = new Map();
// Track timestamps of manual saves to ignore subsequent watcher events
const recentManualSaves: Map<string, number> = new Map();

// Global debounce state
let globalDebounceTimer: NodeJS.Timeout | undefined;
const pendingFiles = new Set<string>();

// Pending artifact creations (waiting for name check)
const pendingCreations: Map<string, any> = new Map();
const NON_SYNC_FOLDER_NAMES = new Set(['.vscode', '.cursor', '.git', 'node_modules', 'profiles', 'profile']);

// Process all pending files - extracted for reuse by Sync Now
function processPendingFiles() {
	const runId = buildRunId();
	auditLog('pending_processing_started', { pendingCount: pendingFiles.size }, runId);
	// Group files by record (same instance/scope/table/sys_id)
	const recordGroups = new Map<string, { scriptObj: any, fields: Map<string, string> }>();
	
	pendingFiles.forEach(file => {
		const scriptObj = eu.fileNameToObject(file);
		if (scriptObj === true || !scriptObj?.sys_id) {
			// Can't group, save individually
			auditLog('pending_file_individual_dispatch', { filePath: file, reason: 'invalid_or_missing_sys_id' }, runId);
			saveFieldsToServiceNow(file, true);
			return;
		}
		
		// Create unique key for this record
		const recordKey = `${scriptObj.instance?.name}|${scriptObj.scopeName}|${scriptObj.tableName}|${scriptObj.sys_id}`;
		
		if (!recordGroups.has(recordKey)) {
			recordGroups.set(recordKey, { 
				scriptObj: { ...scriptObj, fields: {} }, 
				fields: new Map() 
			});
		}
		
		const group = recordGroups.get(recordKey)!;
		group.fields.set(scriptObj.fieldName, scriptObj.content);
	});
	
	// Process each record group
	recordGroups.forEach((group, key) => {
		if (group.fields.size === 1) {
			// Single field - use existing flow
			const [fieldName, content] = group.fields.entries().next().value;
			group.scriptObj.fieldName = fieldName;
			group.scriptObj.content = content;
			delete group.scriptObj.fields;
			auditLog('pending_group_dispatch', {
				recordKey: key,
				mode: 'single_field',
				tableName: group.scriptObj.tableName,
				sys_id: group.scriptObj.sys_id
			}, runId);
			sendToServiceNow(group.scriptObj);
		} else {
			// Multiple fields - combine into single request
			group.scriptObj.fields = Object.fromEntries(group.fields);
			group.scriptObj.fieldName = Array.from(group.fields.keys()).join(', ');
			group.scriptObj.content = ''; // Not used for multi-field
			auditLog('pending_group_dispatch', {
				recordKey: key,
				mode: 'multi_field',
				fieldCount: group.fields.size,
				tableName: group.scriptObj.tableName,
				sys_id: group.scriptObj.sys_id
			}, runId);
			sendToServiceNow(group.scriptObj);
		}
	});
	
	pendingFiles.clear();
	queueProvider?.clearQueue();
	vscode.commands.executeCommand('setContext', 'sn-scriptsync.queuePaused', false);
	
	if (globalDebounceTimer) {
		clearTimeout(globalDebounceTimer);
		globalDebounceTimer = undefined;
	}
}

// Debug logging - only logs when server is running and debugLogging is enabled
function debugLog(message: string) {
	if (!serverRunning) return;
	
	try {
		const settings = vscode.workspace.getConfiguration('sn-scriptsync');
		const enabled = settings.get('debugLogging') as boolean;
		if (!enabled) return;

		const logPath = path.join(vscode.workspace.rootPath || '', 'debug.log');
		const timestamp = new Date().toISOString();
		const logLine = `[${timestamp}] ${message}\n`;
		fs.appendFileSync(logPath, logLine);
	} catch (e) {
		// Silently ignore if we can't write to debug.log (e.g., read-only file system)
	}
}

function buildRunId(): string {
	return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeAuditData(value: any): any {
	if (Array.isArray(value)) {
		return value.map(item => sanitizeAuditData(item));
	}
	if (value && typeof value === 'object') {
		const sanitized: Record<string, any> = {};
		Object.entries(value).forEach(([key, val]) => {
			const k = key.toLowerCase();
			if (k.includes('token') || k.includes('password') || k.includes('authorization') || k === 'g_ck' || k === 'content') {
				sanitized[key] = '[redacted]';
			} else {
				sanitized[key] = sanitizeAuditData(val);
			}
		});
		return sanitized;
	}
	return value;
}

function auditLog(event: string, data: Record<string, any> = {}, runId?: string) {
	if (!serverRunning) return;
	try {
		const settings = vscode.workspace.getConfiguration('sn-scriptsync');
		const enabled = settings.get('debugLogging') as boolean;
		if (!enabled) return;

		const logPath = path.join(vscode.workspace.rootPath || '', 'audit.log');
		const payload = {
			timestamp: new Date().toISOString(),
			event,
			runId: runId || buildRunId(),
			data: sanitizeAuditData(data)
		};
		fs.appendFileSync(logPath, `${JSON.stringify(payload)}\n`);
	} catch (_) {
		// Silently ignore logging failures.
	}
}

function getInstanceRootForPath(filePath: string): string | undefined {
	const workspaceRoot = vscode.workspace.rootPath || '';
	if (!workspaceRoot || !filePath.startsWith(workspaceRoot)) {
		return undefined;
	}
	const relativePath = filePath.replace(workspaceRoot, '').replace(/^[\\/]/, '');
	const parts = relativePath.split(path.sep).filter(Boolean);
	if (!parts.length) {
		return undefined;
	}
	return path.join(workspaceRoot, parts[0]);
}

function isValidInstanceSettingsObject(settings: any, expectedName?: string): boolean {
	if (!settings || typeof settings !== 'object') return false;
	if (typeof settings.name !== 'string' || !settings.name.trim()) return false;
	if (expectedName && settings.name !== expectedName) return false;
	if (typeof settings.url !== 'string' || !settings.url.trim()) return false;
	try {
		const parsedUrl = new URL(settings.url);
		if (!parsedUrl.hostname || !parsedUrl.protocol.startsWith('http')) return false;
	} catch {
		return false;
	}
	return true;
}

function isValidInstanceRoot(instanceFolder: string): boolean {
	const workspaceRoot = vscode.workspace.rootPath || '';
	if (!workspaceRoot || !instanceFolder || !instanceFolder.startsWith(workspaceRoot)) {
		return false;
	}
	const folderName = path.basename(instanceFolder);
	if (!folderName || NON_SYNC_FOLDER_NAMES.has(folderName.toLowerCase())) {
		return false;
	}
	const settingsPath = path.join(instanceFolder, '_settings.json');
	const oldSettingsPath = path.join(instanceFolder, 'settings.json');
	const candidatePath = fs.existsSync(settingsPath) ? settingsPath : oldSettingsPath;
	if (!candidatePath || !fs.existsSync(candidatePath)) {
		return false;
	}
	try {
		const settings = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
		return isValidInstanceSettingsObject(settings, folderName);
	} catch {
		return false;
	}
}

function canCreateArtifactFromFile(filePath: string, scriptObj: any): { ok: boolean; reason?: string } {
	const instanceRoot = getInstanceRootForPath(filePath);
	if (!instanceRoot || !isValidInstanceRoot(instanceRoot)) {
		return { ok: false, reason: 'invalid_instance_root' };
	}
	if (!scriptObj || !scriptObj.tableName || !scriptObj.fieldName || !scriptObj.name || !scriptObj.scopeName) {
		return { ok: false, reason: 'missing_required_fields' };
	}
	if (!isValidInstanceSettingsObject(scriptObj.instance, path.basename(instanceRoot))) {
		return { ok: false, reason: 'invalid_instance_settings' };
	}
	if (scriptObj.fieldName.startsWith('_') || scriptObj.tableName === 'background') {
		return { ok: false, reason: 'blocked_table_or_field' };
	}
	const baseName = path.basename(filePath);
	const validFilePattern = /^[^.]+\.[^.]+\.[^.]+$/;
	if (!validFilePattern.test(baseName)) {
		return { ok: false, reason: 'invalid_filename_pattern' };
	}
	const mapPath = path.join(path.dirname(filePath), '_map.json');
	if (!fs.existsSync(mapPath)) {
		return { ok: false, reason: 'missing_map_file' };
	}
	return { ok: true };
}

function isCreateArtifactsEnabled(): boolean {
	const settings = vscode.workspace.getConfiguration('sn-scriptsync');
	return (settings.get('createArtifacts.enabled') as boolean) ?? true;
}

function enqueuePendingFile(
	filePath: string,
	reason: string,
	runId: string,
	debounceSeconds: number,
	debounceDelay: number
) {
	pendingFiles.add(filePath);
	auditLog('queue_decision', { filePath, queued: true, reason }, runId);

	// Monitor-only: update queue/badge but don't schedule auto sync.
	if (debounceSeconds <= 0) {
		queueProvider.updateQueue(pendingFiles, 0);
		auditLog('queue_monitor_only', { filePath, pendingCount: pendingFiles.size }, runId);
		return;
	}

	// If paused, do not schedule auto-sync; just refresh UI.
	if (queueProvider?.isPaused) {
		queueProvider.updateQueue(pendingFiles, debounceDelay);
		auditLog('queue_paused', { filePath, pendingCount: pendingFiles.size }, runId);
		return;
	}

	// Reset global timer
	if (globalDebounceTimer) {
		clearTimeout(globalDebounceTimer);
	}

	globalDebounceTimer = setTimeout(() => {
		auditLog('queue_debounce_elapsed', { pendingCount: pendingFiles.size, debounceDelayMs: debounceDelay }, runId);
		processPendingFiles();
	}, debounceDelay);

	// Update UI
	queueProvider.updateQueue(pendingFiles, debounceDelay);
}

// ---------------------------------------------------------------------------
// Agent API bridge: thin helpers that forward WebSocket responses from the
// SN Utils helper tab into the agent module's pendingRegistry. The heavy
// lifting lives in src/agent/ so this file stays focused on VS Code wiring.
// ---------------------------------------------------------------------------

function resolvePending(agentRequestId: string, value: any): boolean {
	return pendingRegistry.resolve(agentRequestId, value);
}

function rejectPending(agentRequestId: string, code: any, message: string): boolean {
	return pendingRegistry.reject(agentRequestId, code, message);
}

// Legacy WS response handlers. They forward straight into the registry so
// the waiting command handler resumes with the browser payload.
function handleAgentParentOptionsResponse(responseJson: any) {
	if (responseJson?.agentRequestId) resolvePending(responseJson.agentRequestId, responseJson);
}
function handleAgentQueryRecordsResponse(responseJson: any) {
	if (responseJson?.agentRequestId) resolvePending(responseJson.agentRequestId, responseJson);
}
function handleActivateTabResponse(responseJson: any) {
	if (responseJson?.agentRequestId && resolvePending(responseJson.agentRequestId, responseJson)) return;
	debugLog(`activateTabResponse (non-agent): ${responseJson?.url || responseJson?.error}`);
}
function handleRunSlashCommandResponse(responseJson: any) {
	if (responseJson?.agentRequestId && resolvePending(responseJson.agentRequestId, responseJson)) return;
	debugLog(`runSlashCommandResponse (non-agent): ${responseJson?.command || responseJson?.error}`);
}
function handleSwitchContextResponse(responseJson: any) {
	if (responseJson?.agentRequestId && resolvePending(responseJson.agentRequestId, responseJson)) return;
	debugLog(`switchContextResponse (non-agent): ${responseJson?.switchType || responseJson?.error}`);
}
function handleUploadAttachmentResponse(responseJson: any) {
	if (responseJson?.agentRequestId && resolvePending(responseJson.agentRequestId, responseJson)) return;
	if (responseJson?.success) {
		vscode.window.showInformationMessage(`Attachment uploaded: ${responseJson.fileName}`);
	} else {
		vscode.window.showErrorMessage(`Attachment upload failed: ${responseJson?.error}`);
	}
}

// Screenshot from the browser: when it's tied to an Agent API request let
// the command handler (see src/agent/commands/browser.ts) save it. Otherwise
// this is a manual `Take Screenshot` command and we save it here for UX.
function handleScreenshotResponse(responseJson: any) {
	if (responseJson?.agentRequestId && resolvePending(responseJson.agentRequestId, responseJson)) return;

	if (responseJson?.error) {
		vscode.window.showErrorMessage(`Screenshot failed: ${responseJson.error}`);
		return;
	}
	if (!responseJson?.imageData) {
		vscode.window.showErrorMessage('Screenshot failed: No image data received');
		return;
	}
	try {
		const workspacePath = workspace.rootPath;
		if (!workspacePath) throw new Error('No workspace folder open');
		const screenshotsFolder = path.join(workspacePath, 'screenshots');
		if (!fs.existsSync(screenshotsFolder)) fs.mkdirSync(screenshotsFolder, { recursive: true });
		const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
		const fileName = responseJson.fileName || `screenshot_${timestamp}.png`;
		const filePath = path.join(screenshotsFolder, fileName);
		const buf = Buffer.from(responseJson.imageData, 'base64');
		fs.writeFileSync(filePath, new Uint8Array(buf));
		debugLog(`Screenshot saved to ${filePath}`);
		vscode.window.showInformationMessage(`Screenshot saved: ${fileName}`, 'Open File', 'Open Folder').then(selection => {
			if (selection === 'Open File') vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath));
			else if (selection === 'Open Folder') vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(filePath));
		});
	} catch (e: any) {
		vscode.window.showErrorMessage(`Failed to save screenshot: ${e?.message || e}`);
		debugLog(`Screenshot save error: ${e}`);
	}
}

// Write _last_error.json for every instance folder so `get_last_error` works,
// and fail any pending HTTP/file requests pointing at that folder.
function relayErrorToAgent(errorMessage: string, rawError?: any) {
	try {
		const workspaceRoot = vscode.workspace.rootPath || '';
		if (!workspaceRoot) return;
		const folders = fs.readdirSync(workspaceRoot, { withFileTypes: true })
			.filter(d => d.isDirectory() && !d.name.startsWith('.'));
		for (const folder of folders) {
			const settingsPath = path.join(workspaceRoot, folder.name, '_settings.json');
			const oldSettingsPath = path.join(workspaceRoot, folder.name, 'settings.json');
			if (!fs.existsSync(settingsPath) && !fs.existsSync(oldSettingsPath)) continue;

			const errorPath = path.join(workspaceRoot, folder.name, '_last_error.json');
			fs.writeFileSync(errorPath, JSON.stringify({
				timestamp: Date.now(),
				time: new Date().toISOString(),
				error: errorMessage,
				details: rawError?.error || null,
			}, null, 2));
			debugLog(`Agent API: Error relayed to ${folder.name}/_last_error.json`);

			const instanceFolder = path.join(workspaceRoot, folder.name);
			const code = inferCodeFromMessage(errorMessage);
			pendingRegistry.rejectForInstance(instanceFolder, code, errorMessage);
		}
	} catch (e) {
		console.log(`[sn-scriptsync] Error relaying to agent: ${e}`);
	}
}

// Pause queue on sync error
function pauseQueueOnError(errorMessage: string) {
	if (queueProvider && pendingFiles.size > 0) {
		queueProvider.togglePause();
		vscode.commands.executeCommand('setContext', 'sn-scriptsync.queuePaused', true);
		
		if (globalDebounceTimer) {
			clearTimeout(globalDebounceTimer);
			globalDebounceTimer = undefined;
		}
		
		vscode.window.showErrorMessage(`Sync failed: ${errorMessage}. Queue paused.`, 'Resume').then(selection => {
			if (selection === 'Resume') {
				vscode.commands.executeCommand('extension.resumeQueue');
			}
		});
	}
}

function setupWatcher() {
	if (watcher) {
		watcher.dispose();
		watcher = undefined;
	}
	const settings = vscode.workspace.getConfiguration('sn-scriptsync');
	const debounceSeconds = (settings.get('externalChanges.syncDelay') as number) ?? 0;
	const monitorFileChanges = (settings.get('externalChanges.monitorFileChanges') as boolean) ?? true;
	const autoSyncEnabled = monitorFileChanges && debounceSeconds > 0;
	vscode.commands.executeCommand('setContext', 'sn-scriptsync.queueAutoSyncEnabled', autoSyncEnabled);

	// The file-based Agent API transport is wired separately in activate();
	// this watcher only cares about queueing external code changes.
	if (!monitorFileChanges) {
		return;
	}

	const DEBOUNCE_DELAY = debounceSeconds > 0 ? debounceSeconds * 1000 : 0;

		watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.workspace.rootPath || '', "**/*"));

		watcher.onDidChange(uri => {
			const runId = buildRunId();
			const fileName = path.basename(uri.fsPath);
			auditLog('watcher_event_received', { filePath: uri.fsPath, fileName }, runId);

			// Ignore debug.log to prevent infinite loop
			if (fileName === 'debug.log' || fileName === 'audit.log') {
				auditLog('watcher_event_ignored', { reason: 'internal_log_file', filePath: uri.fsPath }, runId);
				return;
			}

			// The file-based Agent API transport owns everything under /agent/.
			if (uri.fsPath.includes(`${path.sep}agent${path.sep}`)) {
				auditLog('watcher_event_ignored', { reason: 'agent_folder', filePath: uri.fsPath }, runId);
				return;
			}
			
			// Ignore system/hidden files
			const ignoredFiles = ['.DS_Store', '.gitignore', '.git', 'Thumbs.db', '.env', '.vscode'];
			if (fileName.startsWith('.') || fileName.startsWith('_') || ignoredFiles.includes(fileName)) {
				auditLog('watcher_event_ignored', { reason: 'hidden_or_system_file', filePath: uri.fsPath }, runId);
				return;
			}

			// Only queue files in instance folders (folders containing _settings.json)
			// Path structure: workspace/instance/table/file.js (minimum 3 levels)
			const relativePath = uri.fsPath.replace(vscode.workspace.rootPath || '', '');
			const pathParts = relativePath.split(path.sep).filter(p => p);
			
			// Must be at least: instance/table/file (3 parts minimum)
			// Files directly in instance folder should be ignored
			if (pathParts.length < 3) {
				auditLog('watcher_event_ignored', { reason: 'outside_table_folder', filePath: uri.fsPath }, runId);
				return; // Not in a table folder
			}
			
			const instanceFolder = path.join(vscode.workspace.rootPath || '', pathParts[0]);
			if (!isValidInstanceRoot(instanceFolder)) {
				auditLog('watcher_event_ignored', { reason: 'invalid_instance_root', filePath: uri.fsPath, instanceFolder }, runId);
				return; // Not a synced instance folder
			}

			// Ignore if this is a result of our own write
			if (ExtensionUtils.ignoreNextSync.has(uri.fsPath)) {
				ExtensionUtils.ignoreNextSync.delete(uri.fsPath);
				auditLog('watcher_event_ignored', { reason: 'self_write_guard', filePath: uri.fsPath }, runId);
				return;
			}

			// Ignore if this file was manually saved recently (within 2 seconds)
			const lastManualSave = recentManualSaves.get(uri.fsPath);
			if (lastManualSave && (Date.now() - lastManualSave < 2000)) {
				auditLog('watcher_event_ignored', { reason: 'recent_manual_save', filePath: uri.fsPath }, runId);
				return;
			}

			// Check if this is a NEW artifact (no sys_id) - execute immediately, don't queue
			// This allows AI agents to create artifacts without waiting for the debounce timer
			const scriptObj = eu.fileNameToObject(uri.fsPath);
			if (scriptObj !== true && !scriptObj.sys_id && scriptObj.tableName && scriptObj.fieldName) {
				const createSent = saveFieldsToServiceNow(uri.fsPath, false);
				auditLog('create_candidate_from_watcher', {
					filePath: uri.fsPath,
					tableName: scriptObj.tableName,
					fieldName: scriptObj.fieldName,
					createSent
				}, runId);
				if (!createSent) {
					enqueuePendingFile(uri.fsPath, 'create_preconditions_failed', runId, debounceSeconds, DEBOUNCE_DELAY);
				}
				return;
			}

			enqueuePendingFile(uri.fsPath, 'watcher_update', runId, debounceSeconds, DEBOUNCE_DELAY);
		});
}

// Listen for the "will save" event and mark the document if the reason was manual.
// Also track that onWillSaveTextDocument fired at all — "Save without formatting" skips it. #119
vscode.workspace.onWillSaveTextDocument((event) => {
	const key = event.document.uri.toString();
	willSaveSeenMap.set(key, true);
	if (event.reason === vscode.TextDocumentSaveReason.Manual) {
		manualSaveMap.set(key, true);
	}
});

// In the did-save handler, only process files that were flagged as manually saved. #105
// Also handle "Save without formatting" which skips onWillSaveTextDocument entirely. #119
vscode.workspace.onDidSaveTextDocument(document => {
	const key = document.uri.toString();
	const wasManual = manualSaveMap.get(key);
	const wasSeenByWillSave = willSaveSeenMap.get(key);

	manualSaveMap.delete(key);
	willSaveSeenMap.delete(key);

	// Treat as manual save if: explicitly flagged as manual, OR onWillSaveTextDocument
	// never fired (which means "Save without formatting" was used). #119
	if (wasManual || !wasSeenByWillSave) {
		pendingFiles.delete(document.fileName);
		queueProvider?.removeFromQueue(document.fileName);

		recentManualSaves.set(document.fileName, Date.now());

		if (!saveFieldsToServiceNow(document, true)) {
			markFileAsDirty(document);
		}
	}
});

export function activate(context: vscode.ExtensionContext) {

	// Wire the agent module's host shims. This must happen before any
	// command handler runs so getRuntime()/getSyncState() don't throw.
	setAgentRuntime({
		sendToBrowser: (payload) => broadcastToHelperTab(payload),
		hasBrowserClient: () => !!wss && wss.clients.size > 0,
		isServerRunning: () => serverRunning,
		log: (msg) => debugLog(msg),
	});
	setSyncStateProvider(() => ({
		pendingFiles: Array.from(pendingFiles),
		isPaused: !!queueProvider && queueProvider.isPaused,
		processPendingFiles: () => processPendingFiles(),
	}));

	//initialize statusbaritem and click events
	const toggleSyncID = 'sample.toggleScriptSync';
	vscode.commands.registerCommand(toggleSyncID, () => {
		if (serverRunning)
			vscode.commands.executeCommand("extension.snScriptSyncDisable");
		else
			vscode.commands.executeCommand("extension.snScriptSyncEnable");

	});
	scriptSyncStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	scriptSyncStatusBarItem.command = toggleSyncID;


	updateScriptSyncStatusBarItem('click to start.');

	let settings = vscode.workspace.getConfiguration('sn-scriptsync');
	let syncDir: string = settings.get('path');
	syncDir = syncDir.replace('~', '');	
	if (nodePath.sep == "\\"){ //reverse slash when windows.
		syncDir = syncDir.replace(/\//g,'\\');
	}
	
	// Initialize context menu visibility tracking (#115, #116)
	// Must be done BEFORE startServers() so it doesn't overwrite the server running state
	vscode.commands.executeCommand('setContext', 'sn-scriptsync.serverRunning', false);
	updateContextMenuVisibility();
	
	// Track active editor changes for context menu visibility
	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor(() => updateContextMenuVisibility())
	);
	
	// Track configuration changes for context menu visibility
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('sn-scriptsync.showContextMenu')) {
				updateContextMenuVisibility();
			}
		})
	);

	if (typeof workspace.rootPath == 'undefined') {
		//
	}
	else if (vscode.workspace.rootPath.endsWith(syncDir)) {
		startServers();
	}
	setupWatcher();

	vscode.commands.registerCommand('extension.snScriptSyncDisable', () => {
		stopServers();
	});

	vscode.commands.registerCommand('extension.snScriptSyncEnable', () => {
		startServers();
	});

	vscode.commands.registerCommand('extension.bgScriptGlobal', (context) => {
		selectionToBG(true);
	});
	vscode.commands.registerCommand('extension.bgScriptScope', (context) => {
		selectionToBG(false);
	});
	vscode.commands.registerCommand('extension.bgScriptExecute', () => {
		bgScriptExecute();
	});

	vscode.commands.registerCommand('extension.openInInstance', (context) => {
		openInInstance();
	});

	vscode.commands.registerCommand('extension.refreshFromInstance', (context) => {
		refreshFromInstance();
	});

	vscode.commands.registerCommand('extension.requestInstanceMetaData', (context) => {
		requestInstanceMetaData();
	});

	vscode.commands.registerCommand('extension.requestScopeArtifacts', (context) => {
		requestScopeArtifacts();
	});

	vscode.commands.registerCommand('extension.requestScopeArtifactsAll', (context) => {
		requestScopeArtifacts(true);
	});

	vscode.commands.registerCommand('extension.createArtifact', (artifact) => {
		createArtifact(artifact);
	});

	vscode.commands.registerCommand('extension.takeScreenshot', () => {
		takeScreenshot();
	});




	// vscode.workspace.onDidCloseTextDocument(listener => {
	// 	delete openFiles[listener.fileName];
	// });

	vscode.workspace.onDidRenameFiles(fileRenameEvent => {
		if (!serverRunning) {
			return;
		}

		const modifiedMapFiles = new Map<string, object>();

		fileRenameEvent.files.forEach(file => {
			const newPath = file.newUri.fsPath;
			const oldPath = file.oldUri.fsPath;
			const isFolderRecordTable = !eu.isFile(newPath)

			const mapFilePath = eu.joinPaths(eu.pathOfBaseDirectory(newPath), "_map.json");

			// Map file not present. File is not a synced file.
			if(!eu.fileExsists(mapFilePath)) {
				return;
			}

			const oldRecordInfo = eu.dissasembleFilePath(oldPath, isFolderRecordTable);
			const newRecordInfo = eu.dissasembleFilePath(newPath, isFolderRecordTable);

			// Old file name does not follow a known format. Probably not a synced file. Abort.
			if(!oldRecordInfo) {
				return;
			}

			// The new file name is invalid. Revert and abort.
			if(!newRecordInfo) {
				vscode.window.showInformationMessage(
					`Invalid file name:\n
					File name needs to be in the format "[name of your choosing].${oldRecordInfo.fieldName}.${oldRecordInfo.fileExtension}".`
				);
				eu.renamePath(newPath, oldPath);
				return;
			}

			// File extension and field name cannot change. If they changed, revert and abort.
			if(
				oldRecordInfo.fileExtension !== newRecordInfo.fileExtension ||
				oldRecordInfo.fieldName !== newRecordInfo.fieldName
			) {
				vscode.window.showInformationMessage(
					`Invalid file name:\n
					File name needs to be in the format "[name of your choosing].${oldRecordInfo.fieldName}.${oldRecordInfo.fileExtension}".`
				);

				vscode.commands.executeCommand("workbench.action.closeActiveEditor");
				setTimeout(()=>{ //in a timeout to prevnt fileonotfounderror
					eu.renamePath(newPath, oldPath); 
					vscode.workspace.openTextDocument(oldPath).then(doc => {
						vscode.window.showTextDocument(doc, { "preview": false });
					});
				},300);
				
				return;
			}

			// Cache the map file, if not done already
			if(!modifiedMapFiles.has(mapFilePath)) {
				modifiedMapFiles.set(mapFilePath, eu.writeOrReadNameToSysIdMapping(mapFilePath));
			}

			const map = modifiedMapFiles.get(mapFilePath);
				
			// File is not in _map.json, so it's unknown to us.
			if(!map.hasOwnProperty(oldRecordInfo.recordName)) {
				return;
			}

			const sysId = map[oldRecordInfo.recordName];
			delete map[oldRecordInfo.recordName];
			map[newRecordInfo.recordName] = sysId;
		});

		modifiedMapFiles.forEach((map, path) => eu.writeOrReadNameToSysIdMapping(path, map, true));
	});


	vscode.workspace.onDidChangeConfiguration(event => {
		settings = vscode.workspace.getConfiguration('sn-scriptsync');
		setupWatcher();
    })

	vscode.workspace.onDidChangeTextDocument(listener => {
		if (!serverRunning) return;

		if (listener.document.fileName.endsWith('css') && listener.document.fileName.includes('sp_widget')) {
			if (!wss.clients.size) {
				vscode.window.showErrorMessage("No WebSocket connection. Please open SN Utils Helper tab in a browser via slashcommand /token");
			}
			var scriptObj = <any>{};
			scriptObj.liveupdate = true;
			var filePath = listener.document.fileName.substring(0, listener.document.fileName.lastIndexOf(nodePath.sep));
			scriptObj.sys_id = eu.getFileAsJson(filePath + nodePath.sep + "_widget.json")['sys_id'];
			var scss = ".v" + scriptObj.sys_id + " { " + listener.document.getText() + " }";
			var cssObj = sass.renderSync({
				"data": scss,
				"outputStyle": "expanded"
			});

			var testUrls = eu.getFileAsArray(filePath + nodePath.sep + "_test_urls.txt");
			for (var testUrl in testUrls) {
				testUrls[testUrl] += "*";
			}
			scriptObj.testUrls = testUrls;

		if (scriptObj.testUrls.length) {
			scriptObj.css = cssObj.css.toString();
			broadcastToHelperTab(scriptObj);
		}
	}
});

}

export function deactivate() {
	stopAgentHttpServer(agentHttpState).catch(() => { /* ignore */ });
	agentHttpState = undefined;
	if (agentFileHandle) {
		try { agentFileHandle.dispose(); } catch { /* ignore */ }
		agentFileHandle = undefined;
	}
}


function setScopeTreeView(jsn?: any) {
	if (!metaDataRelations)
		metaDataRelations = eu.getFileAsJson(path.join(__filename, '..', '..', 'resources', 'metaDataRelations.json'));

	//const scopeTreeViewProvider = new ScopeTreeViewProvider(jsn, metaDataRelations);
	//vscode.window.registerTreeDataProvider("scopeTreeView", scopeTreeViewProvider);
}

let webViewPanel: vscode.WebviewPanel | null = null;
let updateInterval = null;
const updateIntervalTime = 100;
function initializeWebViewPanelIfNotExists() {
	clearInterval(updateInterval);
	updateInterval = null;

	if (webViewPanel === null) {
		webViewPanel = vscode.window.createWebviewPanel("sn-scriptsync Background", "Background Script", vscode.ViewColumn.Beside, { enableScripts: true });
		webViewPanel.onDidDispose(() => {
			webViewPanel = null;
			clearInterval(updateInterval);
		});
		clearInterval(updateInterval);
		updateInterval = null;
	}
}

function writeBGScriptStartToWebViewPanel(scriptObj: any) {
	initializeWebViewPanelIfNotExists();
	
	webViewPanel.webview.html = `
	<!DOCTYPE html>
	<html>
		<head>
			<meta charset="UTF-8">
			<meta name="viewport" content="width=device-width, initial-scale=1.0">
			<title>Background Script</title>
			<base href="${scriptObj.instance.url}">

			<style>
				body { font-family: monospace; }
			</style>

		</head>
		<body>
			
			[<span id="timer">[0.000]</span>] - Background script running... 
			<a href="/cancel_my_transactions.do" target="_blank" title="Cancel running this backgroundscript">cancel</a>

			<script>
				let transactionTime = 0;
				updateInterval = setInterval(() => {
					transactionTime += ${updateIntervalTime};
					document.getElementById("timer").innerText = (transactionTime / 1000).toFixed(3);
				}, ${updateIntervalTime});
			</script>
		</body>
	</html>
	`;
}

function writeResponseToWebViewPanel(jsn: any) {
	initializeWebViewPanelIfNotExists();
	if (jsn.data == "not authorized") jsn.data = `Not authorized<br /> 
	please run /token in a <a href='/' target='_blank'>browser session</a> to refresh token`;
	webViewPanel.webview.html = `
	<!DOCTYPE html>
	<html>
		<head>
			<meta charset="UTF-8">
			<meta name="viewport" content="width=device-width, initial-scale=1.0">
			<title>Background Script</title>
			<base href="${jsn?.instance?.url}">

			<style>
				pre { font-family: monospace; white-space: pre-wrap; word-wrap: break-word; max-width: 99%; }
			</style>

		</head>
		<body>
			${jsn.data}
		</body>
	</html>`

}


function setScopeTree(showWarning = false) {

	let scriptObj:any = true;
	let editor = vscode.window?.activeTextEditor;
	if (editor)
		scriptObj = eu.fileNameToObject(editor.document);

	if (scriptObj === true) {
		if (showWarning)
			eu.showMessage("Please open a scope file to load matching scope tree",3000);
		return; //not a valid file
	} 


	let basePath = workspace.rootPath + nodePath.sep + scriptObj.instance.name + nodePath.sep;
	let scopePath = basePath + scriptObj.scopeName + nodePath.sep ;

	let scopeTree  = eu.getFileAsJson(path.join(scopePath + "scope.json"));

	if (Object.keys(scopeTree).length == 0) {
		if (showWarning)
			eu.showMessage("File scope.json not found, run Load Scope first!",4000);
		return; //not a valid file
	} 


	// Check for _settings.json first, fall back to settings.json for backwards compatibility
	let settingsPath = path.join(basePath, "_settings.json");
	if (!fs.existsSync(settingsPath)) {
		settingsPath = path.join(basePath, "settings.json");
	}
	let instance  = eu.getFileAsJson(settingsPath);

	if (!metaDataRelations)
		metaDataRelations = eu.getFileAsJson(path.join(__filename, '..', '..', 'resources', 'metaDataRelations.json'));

	if (scopeTree?.scopeTree)	{
		const scopeTreeViewProvider = new ScopeTreeViewProvider(scopeTree, metaDataRelations, instance);
		vscode.window.registerTreeDataProvider("scopeTreeView", scopeTreeViewProvider);		
	}

}

function markFileAsDirty(file: TextDocument): void {

	if (!serverRunning) return;

	let insertEdit: vscode.WorkspaceEdit = new vscode.WorkspaceEdit();
	let removeEdit: vscode.WorkspaceEdit = new vscode.WorkspaceEdit();
	let lastLineIndex: number = file.lineCount - 1;
	let lastCharacterIndex: number = file.lineAt(lastLineIndex).range.end.character;

	insertEdit.insert(file.uri, new vscode.Position(lastLineIndex, lastCharacterIndex), " ");
	removeEdit.delete(file.uri, new vscode.Range(
		new vscode.Position(lastLineIndex, lastCharacterIndex), new vscode.Position(lastLineIndex, lastCharacterIndex + 1)));
	workspace.applyEdit(insertEdit).then(() => {
		workspace.applyEdit(removeEdit);
	});
}

function startServers() {

	if (typeof workspace.rootPath == 'undefined') {
		vscode.window.showWarningMessage("Please open a folder, before running ScriptSync");
		return;
	}


	let sourceDir = path.join(__filename, '..', '..', 'autocomplete') + nodePath.sep;
	let targetDir = path.join(workspace.rootPath, 'autocomplete') + nodePath.sep;
	eu.copyFile(sourceDir + 'client.d.ts.txt', targetDir + 'client.d.ts', function () { });
	eu.copyFile(sourceDir + 'server.d.ts.txt', targetDir + 'server.d.ts', function () { });
	eu.copyFile(sourceDir + 'GlideQuery.js.txt', targetDir + 'GlideQuery.js', function () { });
	targetDir = path.join(workspace.rootPath, '') + nodePath.sep;
	eu.copyFileIfNotExists(sourceDir + 'jsconfig.json.txt', targetDir + 'jsconfig.json', function () { });

	// Refresh AI agent instructions. Users are told to RENAME agentinstructions.md
	// for their tool (.cursorrules, CLAUDE.md, ...), so we refresh whichever
	// variant they actually have — otherwise the agent's real rules file would go
	// stale and never learn about the HTTP Agent API. The generated docs carry a
	// SN-SCRIPTSYNC managed block so user customizations outside it are preserved.
	let agentRulesSourceDir = path.join(__filename, '..', '..', 'agentrules') + nodePath.sep;
	const instructionsSource = agentRulesSourceDir + 'agentinstructions.md';
	const instructionTargets = [
		'agentinstructions.md',
		'.cursorrules',
		'.windsurfrules',
		'.clinerules',
		'CLAUDE.md',
		'AGENTS.md',
		path.join('.github', 'copilot-instructions.md'),
	];
	// Only bootstrap the default agentinstructions.md when the user has no
	// instruction file at all — avoids creating a stray duplicate next to a file
	// they already renamed.
	const anyInstructionFileExists = instructionTargets.some(
		rel => fs.existsSync(path.join(workspace.rootPath, rel))
	);
	instructionTargets.forEach(rel => {
		const dest = path.join(workspace.rootPath, rel);
		const exists = fs.existsSync(dest);
		if (!exists && !(rel === 'agentinstructions.md' && !anyInstructionFileExists)) {
			return; // don't create renamed variants that the user never had
		}
		eu.upsertManagedBlock(instructionsSource, dest, (err: any, status?: string) => {
			if (err) {
				debugLog(`instructions refresh error (${rel}): ${err?.message || err}`);
			} else if (status && status !== 'up_to_date') {
				debugLog(`instructions ${status}: ${rel}`);
			}
		});
	});

	// Mirror the on-demand agent skills (issue #148) into the workspace and
	// reconcile against the build manifest — copies/refreshes managed skill files
	// and deletes any marker-stamped skill no longer in the manifest (renamed or
	// removed), while leaving user-authored files untouched.
	const skillsSourceDir = agentRulesSourceDir + 'skills';
	const skillsDestDir = path.join(workspace.rootPath, 'agentrules', 'skills');
	eu.syncManagedSkills(skillsSourceDir, skillsDestDir, (err: any, res?: { copied: number; removed: number }) => {
		if (err) {
			debugLog(`agent skills sync error: ${err?.message || err}`);
		} else if (res && (res.copied || res.removed)) {
			debugLog(`agent skills synced: ${res.copied} written, ${res.removed} removed`);
		}
	});

	// Start the HTTP Agent API (preferred, event-driven) and optionally the
	// legacy file-based transport. Both sit on top of the same dispatcher.
	startAgentHttpServer({ onLog: (m) => debugLog(m) })
		.then((state) => {
			agentHttpState = state;
			debugLog(`Agent HTTP API listening on 127.0.0.1:${state.port}`);
			// Surface the live endpoint so users can confirm the HTTP Agent API is up.
			scriptSyncStatusBarItem.tooltip = `sn-scriptsync running\nAgent HTTP API: 127.0.0.1:${state.port}\nSee .vscode/sn-agent-port.json (port + token)`;
		})
		.catch((err) => {
			debugLog(`Agent HTTP API failed to start: ${err?.message || err}`);
			vscode.window.showWarningMessage(`SN ScriptSync: Agent HTTP API failed to start: ${err?.message || err}`);
		});

	const agentSettings = vscode.workspace.getConfiguration('sn-scriptsync');
	const fileFallback = agentSettings.get<boolean>('agentApi.fileFallback', true);
	if (fileFallback) {
		agentFileHandle = startAgentFileTransport({
			log: (m) => debugLog(m),
			audit: (instanceFolder, request, response) => logAgentRequestToFile(instanceFolder, request, response),
		});
	}

	//Start WebSocket Server
	wss = new WebSocket.Server({ port: 1978 , host : '127.0.0.1'});
	wss.on('connection', (ws: WebSocket, req) => {

		if (!serverRunning) return;

		if (req.headers.origin.startsWith('http')) { // only allow via extension pages like chrome-extension://;
			ws.close(0, 'Not allowed');
		}

		if (wss.clients.size > 1) {
			ws.close(0, 'Max connection');
		}

		ws.on('message', function incoming(message) {
			try {
				let messageJson = JSON.parse(message)
				// Errors that belong to an Agent API round-trip carry an
				// agentRequestId and are surfaced to the calling command via the
				// pending registry below. Skip the global popup / queue-pause /
				// _last_error path for those so a single agent REST failure
				// doesn't spam the UI or clobber the shared error file.
				if (messageJson.hasOwnProperty('error') && !messageJson.agentRequestId) {
					auditLog('remote_result_error', { action: messageJson?.action || 'unknown', detail: messageJson.error?.detail || null });
					let errorDetail = '';
					const rawDetail = messageJson.error?.detail;
					if (rawDetail) {
						const code = inferCodeFromMessage(rawDetail);
						switch (code) {
							case 'E_ACL':
								errorDetail = 'ACL Error, try changing scope in the browser';
								break;
							case 'E_TOKEN_EXPIRED':
								errorDetail = 'Could not sync file, no valid token. Try typing the slashcommand /token in a active browser session and retry.';
								break;
							default:
								errorDetail = rawDetail;
						}
					} else {
						errorDetail = JSON.stringify(messageJson, null, 2);
					}

					// Relay error to Agent API - write to _last_error.json in all instance folders
					relayErrorToAgent(errorDetail, messageJson);

					// Pause queue on error if there are pending files
					if (pendingFiles.size > 0) {
						pauseQueueOnError(errorDetail);
					} else {
						vscode.window.showErrorMessage("Error while saving file: " + errorDetail);
					}
					
					if (window.activeTextEditor?.document) {
						markFileAsDirty(window.activeTextEditor.document);
					}
				}

			// start new methods to replace webserver with websocket
			if (messageJson?.instance) 
				eu.writeInstanceSettings(messageJson.instance);
			if (messageJson?.action == 'saveFieldAsFile')
				saveFieldAsFile(messageJson);
			else if (messageJson?.action == 'createRecordResponse')
				handleCreateRecordResponse(messageJson);
			else if (messageJson?.action == 'saveWidget')
				saveWidget(messageJson);
			else if (messageJson?.action == 'linkAppToVSCode')
				linkAppToVSCode(messageJson);
			else if (messageJson?.action == 'tableStructureResponse')
				handleTableStructureResponse(messageJson);
			else if (messageJson?.action == 'checkNameExistsResponse')
				handleCheckNameExistsResponse(messageJson);
			else if (messageJson?.action == 'agentParentOptionsResponse')
				handleAgentParentOptionsResponse(messageJson);
			else if (messageJson?.action == 'agentQueryRecordsResponse')
				handleAgentQueryRecordsResponse(messageJson);
			else if (messageJson?.action == 'screenshotResponse')
				handleScreenshotResponse(messageJson);
			else if (messageJson?.action == 'uploadAttachmentResponse')
				handleUploadAttachmentResponse(messageJson);
			else if (messageJson?.action == 'activateTabResponse')
				handleActivateTabResponse(messageJson);
			else if (messageJson?.action == 'runSlashCommandResponse')
				handleRunSlashCommandResponse(messageJson);
			else if (messageJson?.action == 'switchContextResponse')
				handleSwitchContextResponse(messageJson);
			else if (messageJson?.agentRequestId && resolvePending(messageJson.agentRequestId, messageJson)) {
				// Already resolved into a pending Agent API request.
			}
			else if (message.instance && !message?.action)
				refreshedToken(messageJson);
			// end new methods to replace webserver with websocket

			else if (messageJson.action == "requestAppMeta") {
				setScopeTreeView(messageJson);
			}
			else if (messageJson.action == "writeInstanceSettings") {
				eu.writeInstanceSettings(messageJson.instance);
			}
            else if (messageJson.action == "responseFromBackgroundScript") {
                writeResponseToWebViewPanel(messageJson);
            }
			else if (messageJson.hasOwnProperty('actionGoal')) {
				if (messageJson.actionGoal == 'resolveScopeForSave') {
					handleResolveScopeForSave(messageJson);
				}
				else if (messageJson.actionGoal == 'getCurrent') {
					eu.writeFile(messageJson.fileName, messageJson.result[messageJson.fieldName], true, function () { });
				}
				else if (messageJson.actionGoal == 'writeInstanceMetaData') {
					writeInstanceMetaData(messageJson);
				}
				// else if (messageJson.actionGoal == 'writeInstanceScriptFields') {
				// 	writeInstanceScriptFields(messageJson);
				// }
				// else if (messageJson.actionGoal == 'writeInstanceMetaDataTables') {
				// 	writeInstanceMetaDataTables(messageJson);
				// }
				else if (messageJson.actionGoal == 'writeInstanceScope') {
					writeInstanceScope(messageJson);
				}
				else if (messageJson.actionGoal == 'writeInstanceMetaDataScope') {
					writeInstanceMetaDataScope(messageJson);
				}
				else if (messageJson.actionGoal == 'writeTableFields') {
					writeTableFields(messageJson);
				}
				else {
					saveRequestResponse(messageJson);
				}

			}
			else {
				saveRequestResponse(messageJson); //fallback for older version of browser extension
			}
			} catch (e) {
				console.error('WebSocket message handler error:', e);
				debugLog(`WebSocket message handler error: ${e}`);
				// Don't let errors break the WebSocket connection
			}
		});

		//send immediatly a feedback to the incoming connection    
		ws.send('["Connected to VS Code ScriptScync WebSocket"]', function () { });
		ws.send(JSON.stringify({
			action: 'bannerMessage',
			message: `v4.3.0: new HTTP Agent API on 127.0.0.1 (see .vscode/sn-agent-port.json). Auth via X-Agent-Token header. File-based API still works.`,
			class: 'alert alert-primary',
		}), function () { });

	});
	updateScriptSyncStatusBarItem('Running');
	setServerRunningContext(true);

	setScopeTree();
	const infoTreeViewProvider = new InfoTreeViewProvider();
	vscode.window.registerTreeDataProvider("infoTreeView", infoTreeViewProvider);

	queueProvider = new QueueTreeViewProvider();
	const queueView = vscode.window.createTreeView("queueTreeView", {
		treeDataProvider: queueProvider
	});
	queueProvider.setView(queueView);
	
	// Set up Sync Now callback
	queueProvider.setSyncNowCallback(() => {
		processPendingFiles();
	});

	// Register Sync Now command
	vscode.commands.registerCommand('extension.syncNow', () => {
		if (pendingFiles.size > 0) {
			queueProvider.syncNow();
		} else {
			vscode.window.showInformationMessage('No pending files to sync.');
		}
	});

	// Register Pause command
	vscode.commands.registerCommand('extension.pauseQueue', () => {
		const settings = vscode.workspace.getConfiguration('sn-scriptsync');
		const debounceSeconds = (settings.get('externalChanges.syncDelay') as number) ?? 0;
		const monitorFileChanges = (settings.get('externalChanges.monitorFileChanges') as boolean) ?? true;
		if (!monitorFileChanges || debounceSeconds <= 0) {
			vscode.window.showInformationMessage('Auto-sync is disabled. Enable monitoring and set syncDelay > 0 to use Pause/Resume.');
			return;
		}

		if (pendingFiles.size === 0) {
			vscode.window.showInformationMessage('No pending files to pause.');
			return;
		}
		
		queueProvider.togglePause();
		vscode.commands.executeCommand('setContext', 'sn-scriptsync.queuePaused', true);
		
		if (globalDebounceTimer) {
			clearTimeout(globalDebounceTimer);
			globalDebounceTimer = undefined;
		}
		vscode.window.showInformationMessage('Queue paused. Files will not sync until resumed.');
	});

	// Register Resume command
	vscode.commands.registerCommand('extension.resumeQueue', () => {
		const settings = vscode.workspace.getConfiguration('sn-scriptsync');
		const debounceSeconds = (settings.get('externalChanges.syncDelay') as number) ?? 0;
		const monitorFileChanges = (settings.get('externalChanges.monitorFileChanges') as boolean) ?? true;
		if (!monitorFileChanges || debounceSeconds <= 0) {
			vscode.window.showInformationMessage('Auto-sync is disabled. Use "Sync Now" to sync pending files.');
			return;
		}

		if (pendingFiles.size === 0) {
			vscode.window.showInformationMessage('No pending files to resume.');
			return;
		}
		
		queueProvider.togglePause();
		vscode.commands.executeCommand('setContext', 'sn-scriptsync.queuePaused', false);
		
		// Resume: restart the timer with remaining time
		const DEBOUNCE_DELAY = debounceSeconds * 1000;
		
		globalDebounceTimer = setTimeout(() => {
			processPendingFiles();
		}, DEBOUNCE_DELAY);
		
		vscode.window.showInformationMessage('Queue resumed. Files will sync when timer expires.');
	});

	// Register Remove from Queue command
	vscode.commands.registerCommand('extension.removeFromQueue', (item: any) => {
		if (item && item.filePath) {
			pendingFiles.delete(item.filePath);
			queueProvider.removeFromQueue(item.filePath);
			
			// If queue is now empty, clear the timer
			if (pendingFiles.size === 0 && globalDebounceTimer) {
				clearTimeout(globalDebounceTimer);
				globalDebounceTimer = undefined;
			}
		}
	});

	// Open/activate a pending file in the editor
	vscode.commands.registerCommand('extension.openQueuedFile', async (item: any) => {
		try {
			const filePath: string | undefined = item?.filePath;
			if (!filePath) {
				return;
			}

			const uri = vscode.Uri.file(filePath);
			await vscode.window.showTextDocument(uri, { preview: false, preserveFocus: false });
		} catch (e) {
			console.error('Failed to open pending file:', e);
			debugLog(`Failed to open pending file: ${e}`);
			vscode.window.showErrorMessage('Failed to open pending file.');
		}
	});

	// Clear all pending files from the queue (with confirmation)
	vscode.commands.registerCommand('extension.clearQueue', async () => {
		if (pendingFiles.size === 0) {
			vscode.window.showInformationMessage('No pending files to clear.');
			return;
		}

		const confirm = await vscode.window.showWarningMessage(
			`Clear all ${pendingFiles.size} pending file sync${pendingFiles.size !== 1 ? 's' : ''}?`,
			{ modal: true },
			'Clear all'
		);

		if (confirm !== 'Clear all') {
			return;
		}

		pendingFiles.clear();
		queueProvider.clearQueue();

		// Reset paused context + timers
		vscode.commands.executeCommand('setContext', 'sn-scriptsync.queuePaused', false);
		if (globalDebounceTimer) {
			clearTimeout(globalDebounceTimer);
			globalDebounceTimer = undefined;
		}
	});

}

function handleCreateRecordResponse(responseJson) {
	auditLog('remote_create_response', {
		success: !!responseJson.success,
		tableName: responseJson?.newRecord?.tableName,
		name: responseJson?.newRecord?.name,
		error: responseJson?.error || null
	});
	// Agent API requests use pendingRegistry for async round-trips.
	if (responseJson?.agentRequestId && resolvePending(responseJson.agentRequestId, responseJson)) {
		return;
	}
	
	// Original logic for file-based creation flow
	if (responseJson.success) {
		vscode.window.showInformationMessage(`Successfully created artifact: ${responseJson.newRecord.name}`);
		
		// Adapt the response to the structure expected by saveFieldAsFile
		const artifactToSave = {
			instance: responseJson.instance,
			table: responseJson.newRecord.tableName,
			sys_id: responseJson.newRecord.sys_id,
			name: responseJson.newRecord.name,
			scope: responseJson.newRecord.scope,
			field: responseJson.newRecord.field || 'script', // Default to script if not provided
			fieldType: responseJson.newRecord.fieldType || 'script', 
			content: responseJson.newRecord.content
		};

		saveFieldAsFile(artifactToSave);

	} else {
		vscode.window.showErrorMessage(`Failed to create artifact: ${responseJson.error}`);
	}
}

function stopServers() {
	wss.close();
	stopAgentHttpServer(agentHttpState).catch(() => { /* ignore */ });
	agentHttpState = undefined;
	if (agentFileHandle) {
		try { agentFileHandle.dispose(); } catch { /* ignore */ }
		agentFileHandle = undefined;
	}
	scriptSyncStatusBarItem.tooltip = undefined;
	updateScriptSyncStatusBarItem('Stopped');
	setServerRunningContext(false);
}

function requestInstanceScope(instance, scopeId) {

	var filePath = workspace.rootPath + nodePath.sep + instance.name + nodePath.sep;

	let requestJson = <any>{};
	requestJson.action = 'requestRecords';
	requestJson.actionGoal = 'writeInstanceScope'
	requestJson.instance = instance;
	requestJson.filePath = filePath + 'scopes.json';
	requestJson.tableName = 'sys_scope';
	requestJson.displayValueField = 'scope';
	requestJson.queryString = `sysparm_fields=sys_id,scope&sysparm_query=sys_id=${scopeId}&sysparm_no_count=true`;
	requestRecords(requestJson);

}


function requestScopeArtifacts(includeEmpty = false, scriptObj = null, showWarning = true) {

	if (scriptObj === null){
		scriptObj = true;
		let editor = vscode.window?.activeTextEditor;
		if (editor)
			scriptObj = eu.fileNameToObject(editor.document);
	
		if (scriptObj === true) {
			if (showWarning)
				eu.showMessage("Please open a scope file to load matching scope tree",3000);
			return; //not a valid file
		} 
	}

	eu.showMessage("Loading scope artifacts started...", 2000);


	if (scriptObj === true) return; //not a valid file 

	var basePath = workspace.rootPath + nodePath.sep + scriptObj.instance.name + nodePath.sep;
	var scopePath = basePath + scriptObj.scopeName + nodePath.sep ;

	//first request fields
	let requestJson = <any>{};
	requestJson.action = 'requestRecords';
	requestJson.instance = scriptObj.instance;

	//test scope application files
	requestJson.actionGoal = 'writeInstanceMetaDataScope';
	requestJson.includeEmpty = includeEmpty;
	requestJson.filePath = scopePath + 'scope.json';
	requestJson.scopeName = scriptObj.scopeName;
	requestJson.tableName = 'sys_metadata';
	requestJson.queryString = 'sysparm_fields=sys_class_name,sys_name,sys_id,sys_updated_on&sysparm_query=sys_scope='+ scriptObj.scope +'^sys_class_name!=sys_metadata_delete^sys_update_name!=NULL^ORDERBYDESCsys_class_name';
	requestRecords(requestJson);

}

function requestInstanceMetaData(showWarning = false) {

	let scriptObj:any = true;
	let editor = vscode.window?.activeTextEditor;
	if (editor)
		scriptObj = eu.fileNameToObject(editor.document);

	if (scriptObj === true) {
		if (showWarning)
			eu.showMessage("Please open a scope file to load matching scope data",3000);
		return; //not a valid file
	} 

	var filePath = workspace.rootPath + nodePath.sep + scriptObj.instance.name + nodePath.sep;

	//first request tablemnames
	let requestJson = <any>{};
	requestJson.action = 'requestRecords';
	requestJson.actionGoal = 'writeInstanceMetaData'
	requestJson.instance = scriptObj.instance;
	requestJson.filePath = filePath + 'tablenames.d.ts';
	requestJson.tableName = 'sys_db_object';
	requestJson.displayValueField = 'name';
	requestJson.queryString = 'sysparm_query=nameNOT LIKE00^sys_update_nameISNOTEMPTY^ORDERBYname&sysparm_fields=name&sysparm_no_count=true';
	requestRecords(requestJson);

	//second properies
	requestJson.filePath = filePath + 'properties.d.ts';
	requestJson.tableName = 'sys_properties';
	requestJson.queryString = 'sysparm_query=ORDERBYname&sysparm_fields=name&sysparm_no_count=true';
	requestRecords(requestJson);

}


function writeInstanceMetaData(messageJson) {

	let tableToType = {
		"sys_db_object" : "InstanceTableNames",
		"sys_properties" : "InstanceProperties"
	}

	let content = "declare type " + (tableToType[messageJson.tableName] || "unknown") + " = \n";
	for (let row of messageJson.results) {
		content += ` | "${row.name}" ` + '\n';
	}
	eu.writeFile(messageJson.filePath, content, false, function () { });
}




function writeInstanceMetaDataScope(messageJson){

	let basePath = workspace.rootPath + nodePath.sep + messageJson.instance.name + nodePath.sep;
	let scopes = eu.getFileAsJson(basePath + 'scopes.json');
	let scope = scopes[messageJson.scopeName];

	// always read the correct file here to be sure we dont use it from diffrent instance or scope.
	metaDataRelations = eu.getFileAsJson(path.join(__filename, '..', '..', 'resources', 'metaDataRelations.json'));

	let uniqueScopeTables = [...new Set(messageJson.results.map(item => item.sys_class_name + ''))];

	//for now only load tables with direct code fields in the tree, this function removes all table that dont have the .codeFields key
	metaDataRelations.tableFields = Object.keys(metaDataRelations.tableFields).filter(key => metaDataRelations.tableFields[key]?.codeFields)
	.reduce((obj, key) => { obj[key] = metaDataRelations.tableFields[key];
	  return obj;
	}, {});


	let allCodeTables = Object.keys(metaDataRelations.tableFields);
	let scopeCodeTables = allCodeTables.filter(value => uniqueScopeTables.includes(value + ''));

	// Object.keys(metaDataRelations.tableFields).forEach(tbl => {
	// 	let hasCodeChildren = false;
	// 	if (tbl == 'sp_widget') {
	// 		let p = 1;
	// 	}
	// 	if (metaDataRelations.tableFields[tbl].hasOwnProperty('referenceFields')){
	// 		let refFields = metaDataRelations.tableFields[tbl].referenceFields;
	// 		Object.keys(refFields).forEach(ref =>{
	// 			let tableName = refFields[ref].table
	// 			if (metaDataRelations.tableFields.hasOwnProperty(tableName) && allCodeTables.includes(tableName)){
    //                 metaDataRelations.tableFields[tbl].canHaveCodeChildren = true;
	// 				if (!metaDataRelations.tableFields[tableName].hasOwnProperty('codeChildReferences')) metaDataRelations.tableFields[tableName].codeChildReferences = {};
    //                   if (!metaDataRelations.tableFields[tableName].codeChildReferences.hasOwnProperty(tbl)) 
    //                       metaDataRelations.tableFields[tableName].codeChildReferences[tbl] = {};
	// 				   metaDataRelations.tableFields[tableName].codeChildReferences[tbl][ref] = refFields[ref].label;
	// 			}
	// 			else {
	// 				delete refFields[ref]
	// 			}
	// 		})
			
	// 	}
		
	// })
	
	// Object.keys(metaDataRelations.tableFields).forEach(tbl => {
	// 	let keep = true;
	// 	if (!metaDataRelations.tableFields[tbl].hasOwnProperty('codeFields')){
	// 		if (!metaDataRelations.tableFields[tbl].hasOwnProperty('canHaveCodeChildren')){
    // 			delete metaDataRelations.tableFields[tbl];
    //             keep = false
    //         }
    //     }
    //     if (keep) 
    //         delete metaDataRelations.tableFields[tbl].canHaveCodeChildren;
	// })

	
	let tree = {};
	messageJson.results.forEach(rec => {
		if (metaDataRelations.tableFields[rec['sys_class_name']]?.codeFields ||
			metaDataRelations.tableFields[rec['sys_class_name']]?.referenceFields) {
			let cat = metaDataRelations.tableFields[rec.sys_class_name]?.group || 'other'
			if (!tree[cat]) tree[cat] = { type : "tables", tables : {}};
			if (!tree[cat].tables[rec['sys_class_name']]) tree[cat].tables[rec['sys_class_name']] = { type : "records", records : {}};
			tree[cat].tables[rec['sys_class_name']].records[rec['sys_id']] =
				  { name : rec.sys_name, updated: rec.sys_updated_on , 
					codeFields : metaDataRelations.tableFields[rec['sys_class_name']]?.codeFields,
					referenceFields : {}
			}
		};


	})

	scopeTableResponseCount = 0; //initialize the response counter
	scopeJson = {
		scopeMeta : {
			name :  messageJson.scopeName,
			sysId : scope
		},
		scopeTree : tree
	}


	let strObj = JSON.stringify(scopeJson,null,2);
	eu.writeFile(messageJson.filePath, strObj, false, function () { });

	scopeCodeTables.forEach(table =>{

		if (metaDataRelations.tableFields[table]?.codeFields){ 

			let requestJson = <any>{};
			requestJson.action = 'requestRecords';
			requestJson.actionGoal = 'writeTableFields';
			requestJson.scopeName = messageJson.scopeName;
			requestJson.instance = messageJson.instance;
			requestJson.includeEmpty = messageJson.includeEmpty;
			requestJson.basePath = basePath;
			requestJson.scopeFilePath = messageJson.filePath + '';
			requestJson.filePath = basePath + messageJson.scopeName + nodePath.sep + table + nodePath.sep;
			requestJson.tableName = table;
			requestJson.scopeTableRequestCount = scopeCodeTables.length;
			requestJson.displayValueField = 'sys_name';
			requestJson.fields = Object.keys({...metaDataRelations.tableFields[table].codeFields, ...metaDataRelations.tableFields[table].referenceFields});
			requestJson.queryString = `sysparm_fields=sys_name,sys_id,${requestJson.fields}&sysparm_query=sys_scope=${scope}^sys_class_name=${table}&sysparm_exclude_reference_link=true&sysparm_no_count=true&&sysparm_limit=100`;
		
			requestRecords(requestJson);
		}

	});

}


function writeTableFields(messageJson) {

	if (!metaDataRelations)
		metaDataRelations = eu.getFileAsJson(path.join(__filename, '..', '..', 'resources', 'metaDataRelations.json'));
	let scopeMappingFile = messageJson.filePath + '_map.json';
	let nameToSysId = eu.writeOrReadNameToSysIdMapping(scopeMappingFile);

	messageJson.results.forEach(record =>{


		
		let cleanName = record.sys_name.replace(/[^a-z0-9\._\-+]+/gi, '').replace(/\./g, '-') || record.sys_id + '';
		// If this file was synced before, use whatever name is in the _map.json
		cleanName = Object.keys(nameToSysId).find(fileName => nameToSysId[fileName] === record.sys_id) ?? cleanName
		if (nameToSysId[cleanName] && nameToSysId[cleanName] != record.sys_id){
			cleanName = cleanName + ("-" + record.sys_id.slice(0,2) + record.sys_id.slice(-2)).toUpperCase(); //if mapping already exist add first and last 2 chars of the syid to the filename
		}
		let dispVal = record.sys_name.toLowerCase().replaceAll(" ","_"); //must be checked..
		
		//the configured tables will get a distinct folder containing the files.
		let isFolderRecordTable = Constants.FOLDERRECORDTABLES.includes(messageJson.tableName);
		let separtorCharacter = (isFolderRecordTable) ? nodePath.sep : ".";

		let codeFields = Object.keys(metaDataRelations.tableFields[messageJson.tableName]?.codeFields || {}); 

		if(messageJson.tableName == 'sp_widget'){
			let filePath = messageJson.filePath + cleanName + separtorCharacter;
			let testUrls = [];
			testUrls.push(messageJson.instance.url + "/$sp.do?id=sp-preview&sys_id=" + record.sys_id);
			testUrls.push(messageJson.instance.url + "/sp_config?id=" + dispVal);
			testUrls.push(messageJson.instance.url + "/sp?id=" + dispVal);
			testUrls.push(messageJson.instance.url + "/esc?id=" + dispVal);
			eu.writeFileIfNotExists(filePath + "_test_urls.txt", testUrls.join("\n"), false, function () { });
			metaDataRelations.tableFields.sp_widget.codeFields['_test_urls'] = {  "label": "Test URLs", "type": "string" };
			codeFields = Object.keys(metaDataRelations.tableFields[messageJson.tableName]?.codeFields || {}); 
		}
	

		codeFields.forEach(field => {

			//if (record[field].length == 0) return;

			let fileExtension = ".js";
			let fieldType: string = "script";

			try {
				fieldType = metaDataRelations.tableFields[messageJson.tableName].codeFields[field].type + "";
			} catch  (e){};
		
			fileExtension = Constants.FIELDTYPES[fieldType]?.extension

			
			if (fieldType.includes("xml"))
				fileExtension = ".xml";
			else if (fieldType.includes("html"))
				fileExtension = ".html";
			else if (fieldType.includes("json"))
				fileExtension = ".json";
			else if (fieldType.includes("css") || fieldType == "properties" || field == "css")
				fileExtension = ".scss";
			else if (record.sys_name.includes(".") && ["ecc_agent_script_file"].includes(messageJson.tableName)) {
				let fileextens = record.sys_name.substring(record.sys_name.lastIndexOf(".") + 1, record.sys_name.length);
				fileExtension = "." + fileextens;
				record.sys_name = record.sys_name.substring(0, record.sys_name.lastIndexOf(".")) + "." + fieldType;
			}
			else if (fieldType.includes("string") || fieldType == "conditions")
				fileExtension = ".txt";
			
			

			let fileName = messageJson.filePath + cleanName + separtorCharacter + field + fileExtension;
			let fieldValue = '';
			try { fieldValue = record[field] + "" } catch (e) {
				fieldValue = 'undefined'; //dont save in this case. Protected files will be undifined as well.
			};
			if ((messageJson.includeEmpty || isFolderRecordTable || fieldValue != '') && fieldValue != 'undefined') { //check if can be skipped when empty
				nameToSysId[cleanName] = record.sys_id + '';
				eu.writeFile(fileName, fieldValue, false, function () { });
			}
		})

		let referenceFields = Object.keys(metaDataRelations.tableFields[messageJson.tableName]?.referenceFields || {}); 
		referenceFields.forEach(field => {
			let cat = metaDataRelations.tableFields[messageJson.tableName]?.group || 'other';
			const table = scopeJson.scopeTree[cat].tables[messageJson.tableName];
			const recordId = record.sys_id + '';
			if (table.records && table.records[recordId]) {
				const referenceFields = table.records[recordId].referenceFields ?? (table.records[recordId].referenceFields = {});
				referenceFields[field] = record[field];
			}
		});

		// let codeChildReferences = Object.keys(metaDataRelations.tableFields[messageJson.tableName]?.codeChildReferences || {}); 
		// codeChildReferences.forEach(field => {
		// 	let cat = metaDataRelations.tableFields[messageJson.tableName]?.group || 'other';
		// 	let x = scopeJson.scopeTree[cat].tables[messageJson.tableName].records
		// 	let y = scopeJson.scopeTree[cat].tables[messageJson.tableName].records[record.sys_id + '']
		// 	//scopeJson.scopeTree[cat].tables[messageJson.tableName].records[record.sys_id + ''].codeChildReferences[field] = record[field];
		// });

	})

	if (Object.keys(nameToSysId).length)
		eu.writeOrReadNameToSysIdMapping(scopeMappingFile, nameToSysId);
	
	scopeTableResponseCount++;
	if (messageJson.scopeTableRequestCount == scopeTableResponseCount){
		//after all response from tables returned value, save the file from memory to the scope.json file

		//loop over the object to remove stuff that is emty or has refrences to artifacts outside current scope.

		Object.keys(scopeJson.scopeTree).forEach(catName =>{
            scopeJson.scopeTree[catName].delete = true;
			let catTables = scopeJson.scopeTree[catName].tables;
			Object.keys(catTables).forEach(tableName => {
				if (tableName == 'sp_ng_template') {
					let p = 1;
				}
                catTables[tableName].delete = true;
				let tableRecords = catTables[tableName].records;
				Object.keys(tableRecords).forEach(record => {
                    tableRecords[record].delete = true;
                    let rec = tableRecords[record];
                    if (rec?.codeFields) {
                        tableRecords[record].delete = false;
                        catTables[tableName].delete = false;
                        scopeJson.scopeTree[catName].delete = false;
                    }
                    if (rec?.referenceFields) {
                        let refFields = rec.referenceFields;
                        let deleteRefFields = true;
                        Object.keys(refFields).forEach(refField => {
                            if (refFields[refField]) {
								
                                let refTable = metaDataRelations.tableFields[tableName]?.referenceFields[refField].table;
                                let refGroup = metaDataRelations.tableFields[tableName]?.group || 'other';
                                let refRecordsInScope = scopeJson.scopeTree[refGroup]?.tables[refTable]?.records || {};
                                let refSysIdsInScope = Object.keys(refRecordsInScope);

                                if (refSysIdsInScope.includes(refFields[refField])){
                                    tableRecords[record].delete = false; 
                                    catTables[tableName].delete = false;
                                    scopeJson.scopeTree[catName].delete = false;
                                    deleteRefFields = false;
                                }
                                else {
                                    delete refFields[refField];
                                }
                            }
                        });
                        if (deleteRefFields) delete rec.referenceFields;
                    };
                    if (tableRecords[record].delete ) delete tableRecords[record];
                    else delete tableRecords[record].delete;
				});
                if (catTables[tableName].delete) delete catTables[tableName];
                else delete catTables[tableName].delete;
			});
            if (scopeJson.scopeTree[catName].delete) delete scopeJson.scopeTree[catName];
            else delete scopeJson.scopeTree[catName].delete;
		})

		// end of the cleanup loop
		

		setTimeout(()=>{
			let strObj = JSON.stringify(scopeJson,null,2);
			eu.writeFile(messageJson.scopeFilePath, strObj, false, function () { });
			setScopeTree();
			eu.showMessage("Loading scope artifacts finished!", 2000);
		},1000);


	}

}

function writeInstanceScope(messageJson) {

	let scopes = eu.getFileAsJson(messageJson.filePath);
	let obj = messageJson.results.reduce( //convert scopes array to object in format { scope: sys_id}
		(obj, item) => Object.assign(obj, { [item.scope]: item.sys_id }), {});

	let merged = {...scopes,...obj};

	let strObj = JSON.stringify(merged,null,2);

	eu.writeFile(messageJson.filePath, strObj, false, function () { });
}

function saveWidget(postedJson, retry = 0) {
	//lastsend = 0;
	let basePath = workspace.rootPath + nodePath.sep + postedJson.instance.name + nodePath.sep;
	let scope:string;
	if (postedJson.widget.sys_scope.value == 'global') 
		scope = 'global';
	else {
		let scopes = eu.getFileAsJson(basePath + "scopes.json");
		scopes = Object.entries(scopes).reduce((acc, [key, value]) => (acc[value + ''] = key, acc), {}); //invert object to have sys_id as key;
		scope = scopes[postedJson.widget.sys_scope.value];
	}

	if (!scope) { //if scope could not be determined, request the scopes via websocket, abort current try and try again in a few seconds.
		requestInstanceScope(postedJson.instance, postedJson.widget.sys_scope.value);
		if (++retry <= 2) setTimeout(() =>{ saveWidget(postedJson, retry)}, 2500);
		return;
	}

	let scopeMappingFile = basePath + scope + nodePath.sep + postedJson.tableName + nodePath.sep + '_map.json';
	let nameToSysId = eu.writeOrReadNameToSysIdMapping(scopeMappingFile);
	let cleanName = postedJson.name.replace(/[^a-z0-9\._\-+]+/gi, '').replace(/\./g, '-').replace(/\s\s+/g, '_');
	// If this file was synced before, use whatever name is in the _map.json
	cleanName = Object.keys(nameToSysId).find(fileName => nameToSysId[fileName] === postedJson.sys_id) ?? cleanName
	if (nameToSysId[cleanName] && nameToSysId[cleanName] != postedJson.sys_id){
		cleanName = cleanName + ("-" + postedJson.sys_id.slice(0,2) + postedJson.sys_id.slice(-2)).toUpperCase(); //if mapping already exist add first and last 2 chars of the syid to the filename
	}
	nameToSysId[cleanName] = postedJson.sys_id + '';
	eu.writeOrReadNameToSysIdMapping(scopeMappingFile, nameToSysId);

	let filePath = basePath + scope + nodePath.sep + postedJson.tableName + nodePath.sep + cleanName + nodePath.sep;

	var files = {};

	if (postedJson.widget.hasOwnProperty("option_schema")) { //sp_widget
		files = {
			"template.html": { "content": postedJson.widget.template.value, "openFile": true },
			"css.scss": { "content": postedJson.widget.css.value, "openFile": true },
			"client_script.js": { "content": postedJson.widget.client_script.value, "openFile": true },
			"script.js": { "content": postedJson.widget.script.value, "openFile": true },
			"link.js": { "content": postedJson.widget.link.value, "openFile": false },
			"option_schema.json": { "content": postedJson.widget.option_schema.value, "openFile": false },
			"demo_data.json": { "content": postedJson.widget.demo_data.value, "openFile": false },
			"_widget.json": { "content": JSON.stringify(postedJson, null, 4), "openFile": false },
		}
	}
	else { //sp_header_footer
		files = {
			"template.html": { "content": postedJson.widget.template.value, "openFile": true },
			"css.scss": { "content": postedJson.widget.css.value, "openFile": true },
			"client_script.js": { "content": postedJson.widget.client_script.value, "openFile": true },
			"script.js": { "content": postedJson.widget.script.value, "openFile": true },
			"link.js": { "content": postedJson.widget.link.value, "openFile": false },
			"_widget.json": { "content": JSON.stringify(postedJson, null, 4), "openFile": false },
		}
	}

	var contentLength = 0;
	for (var file in files) {
		if (file != "_widget.json")
			contentLength += files[file].content.length;

		eu.writeFile(filePath + file, files[file].content, files[file].openFile, function (err) {
			if (err) {
				vscode.window.showErrorMessage(`Error writing widget file: ${err}`);
			}
		});
	}

	let requestJson = <any>{};
	requestJson.action = 'requestRecords';
	requestJson.instance = postedJson.instance;
	requestJson.filePath = filePath;
	requestJson.tableName = 'sp_ng_template';
	requestJson.displayValueField = 'sys_name';
	let fields = [];
	fields.push({ "name": "template", "fileType": "html" });
	requestJson.fields = fields;
	requestJson.queryString = 'sysparm_query=sp_widget=' + postedJson.sys_id;

	requestRecords(requestJson);

	var testUrls = [];
	testUrls.push(postedJson.instance.url + "/$sp.do?id=sp-preview&sys_id=" + postedJson.sys_id);
	testUrls.push(postedJson.instance.url + "/sp_config?id=" + postedJson.widget.id.displayValue);
	testUrls.push(postedJson.instance.url + "/sp?id=" + postedJson.widget.id.displayValue);
	testUrls.push(postedJson.instance.url + "/esc?id=" + postedJson.widget.id.displayValue);
	eu.writeFileIfNotExists(filePath + "_test_urls.txt", testUrls.join("\n"), false, function () { });

	postedJson.widget = {};
	postedJson.result = {};
	postedJson.content = {};
	postedJson.fieldName = "template,css,client_script,script,link,option_schema,demo_data";
	postedJson.content.length = contentLength;
	broadcastToHelperTab(postedJson);
}


function saveRequestResponse(responseJson) {
	// Guard: response must have results array (see issue #19)
	if (!responseJson.hasOwnProperty("results")) {
		return;
	}
	let filePath = responseJson.filePath + responseJson.tableName + nodePath.sep;
	for (let result of responseJson.results) {
		for (let field of responseJson.fields) {
			eu.writeFile(filePath +
				field.name.replace(/\./g, '-') + '^' +
				result[responseJson.displayValueField].replace(/[^a-z0-9\._\-+]+/gi, '').replace(/\./, '') + '^' + //strip non alpahanumeric, then replace dot
				result.sys_id + '.' +
				field.fileType,
				result[field.name], false, function () { });
		}
	}
}

function linkAppToVSCode(postedJson) {

	let req = <any>{};
	req.action = 'requestAppMeta';
	req.actionGoal = 'saveCheck';
	req.scope = postedJson.appId;
	req.scopeLabel = postedJson.appName;
	req.scopeName = postedJson.appScope;
	req.instance = postedJson.instance;


	let scopesPath = workspace.rootPath + nodePath.sep + postedJson.instance.name + nodePath.sep + "scopes.json";
	let scopes = eu.getFileAsJson(scopesPath);
	if (!(scopes[req.scopeName] && scopes[req.scopeName] == req.scope)){
		scopes[req.scopeName] = req.scope;
		let strObj = JSON.stringify(scopes,null,2);
		eu.writeFile(scopesPath, strObj, false, function () { });
	}

	requestScopeArtifacts(false, req); 

	// requestRecords(req);

	// wss.clients.forEach(function each(client) {
	// 	if (client.readyState === WebSocket.OPEN && !postedJson.send) {
	// 		client.send(JSON.stringify(postedJson));
	// 		postedJson.send = true;
	// 	}
	// });
}

function refreshedToken(postedJson) {
	postedJson.refreshedtoken = true;
	postedJson.response = "Refreshed token in VS Code via /token slashcommand. Instance: " + postedJson.instance.name;
	broadcastToHelperTab(postedJson);
}



function requestRecords(requestJson) {
	if (!serverRunning) return;

	try {
		if (!wss.clients.size) {
			vscode.window.showErrorMessage("No WebSocket connection. Please open SN Utils helper tab in a browser via slashcommand /token");
		}
		broadcastToHelperTab(requestJson);
	}
	catch (err) {
		vscode.window.showErrorMessage("Error requesting data: " + JSON.stringify(err, null, 4));
	}
}

function broadcastToHelperTab(messageObj: any) {
	if (typeof messageObj === 'object') {
		messageObj.appName = vscode.env.appName || 'VS Code';
	}
	const message = JSON.stringify(messageObj);
	if (wss) {
		wss.clients.forEach(client => {
			if (client.readyState === WebSocket.OPEN) {
				client.send(message);
			}
		});
	}
}

function saveFieldsToServiceNow(documentOrPath: TextDocument | string, fromVsCode:boolean): boolean {
	const runId = buildRunId();

	if (!serverRunning) return true;

	// Get file name to check for internal files
	const filePath = typeof documentOrPath === 'string' ? documentOrPath : documentOrPath.fileName;
	const fileName = path.basename(filePath);
	auditLog('sync_candidate_received', { filePath, fileName, fromVsCode }, runId);
	
	// Skip Agent API folders (communication files, not for sync)
	// But still handle agent request files (Kiro/VS Code forks may create files via onDidSaveTextDocument, not onDidCreate)
	if (filePath.includes(`${path.sep}agent${path.sep}`)) {
		// The file-based Agent API transport handles /agent/requests/*.json.
		auditLog('sync_candidate_ignored', { reason: 'agent_folder', filePath }, runId);
		return true;
	}
	
	// Skip system/hidden files
	const ignoredFiles = ['.DS_Store', 'Thumbs.db', '.env'];
	if (fileName.startsWith('.') || fileName.startsWith('_') || ignoredFiles.includes(fileName)) {
		auditLog('sync_candidate_ignored', { reason: 'hidden_or_system_file', filePath }, runId);
		return true;
	}

	let scriptObj = eu.fileNameToObject(documentOrPath);
	if (scriptObj === true) {
		auditLog('sync_candidate_ignored', { reason: 'parse_failed', filePath }, runId);
		return true;
	}
	const instanceRoot = getInstanceRootForPath(filePath);
	if (!instanceRoot || !isValidInstanceRoot(instanceRoot)) {
		auditLog('sync_candidate_ignored', { reason: 'invalid_instance_root', filePath, instanceRoot }, runId);
		return true;
	}
	if (!isValidInstanceSettingsObject(scriptObj.instance, path.basename(instanceRoot))) {
		auditLog('sync_candidate_ignored', { reason: 'invalid_instance_settings', filePath }, runId);
		return true;
	}

	if (scriptObj.fieldName == '_test_urls') return true; //helper file, dont save to instance
	if (!serverRunning) return true; 

	// Handle new artifacts that have no sys_id yet - create them in ServiceNow
	if (!scriptObj.sys_id) {
		if (scriptObj.tableName && scriptObj.fieldName) {
			if (!isCreateArtifactsEnabled()) {
				auditLog('create_guard_blocked', {
					filePath,
					tableName: scriptObj.tableName,
					fieldName: scriptObj.fieldName,
					reason: 'create_setting_disabled'
				}, runId);
				vscode.window.showWarningMessage('Artifact creation is disabled by setting sn-scriptsync.createArtifacts.enabled');
				return false;
			}

			const canCreate = canCreateArtifactFromFile(filePath, scriptObj);
			if (!canCreate.ok) {
				auditLog('create_guard_blocked', {
					filePath,
					tableName: scriptObj.tableName,
					fieldName: scriptObj.fieldName,
					reason: canCreate.reason
				}, runId);
				return false;
			}
			auditLog('create_guard_passed', {
				filePath,
				tableName: scriptObj.tableName,
				fieldName: scriptObj.fieldName
			}, runId);
			createNewArtifact(scriptObj);
			return true;
		}
	}

	if (!scriptObj?.sys_id ) {
		return true; // server is off or this was not a recognized file (probably metadata)
	}

	if (fromVsCode) lastSave = Math.floor(+new Date() / 1000);

	let success: boolean = true;
	try {
		
		scriptObj.saveSource = (fromVsCode) ? "VS Code" : "FileWatcher";
		if(scriptObj.tableName == 'background') return true; // do not save bg scripts to SN.

		if (scriptObj.fieldName.startsWith('variable-')) {
			scriptObj.fieldName = scriptObj.fieldName.substring(9);
			scriptObj.action = "updateVar";
		}

		if (!wss || !wss.clients.size) {
			vscode.window.showErrorMessage("No WebSocket connection. Please open SN Utils helper tab in a browser via slashcommand /token");
			auditLog('sync_dispatch_blocked', { reason: 'no_websocket_client', filePath, tableName: scriptObj.tableName, sys_id: scriptObj.sys_id }, runId);
			success = false;
		}
		auditLog('sync_dispatch_sent', {
			filePath,
			tableName: scriptObj.tableName,
			fieldName: scriptObj.fieldName,
			sys_id: scriptObj.sys_id,
			saveSource: scriptObj.saveSource
		}, runId);
		broadcastToHelperTab(scriptObj);

	}
	catch (err) {
		vscode.window.showErrorMessage("Error while saving file: " + JSON.stringify(err, null, 4));
		auditLog('sync_dispatch_error', { filePath, error: `${err}` }, runId);
		success = false;
	}

	return success;
}


// #143: pending scope-resolution round-trips, keyed by a unique token. We stash
// the original save payload here while the instance answers with the record's
// real sys_scope, then re-enter saveFieldAsFile with the resolved scope.
const pendingScopeResolves: Map<string, any> = new Map();

// Ask the instance for the record's sys_scope, then re-run the save. Used when a
// form-save payload arrives without a usable scope so we don't dump scoped
// records (e.g. Scheduled Jobs) into the "no_scope" folder.
function resolveScopeThenSave(postedJson: any) {
	const resolveKey = `${postedJson.table}:${postedJson.sys_id}:${postedJson.field}:${Date.now()}`;
	pendingScopeResolves.set(resolveKey, postedJson);

	// Safety net: if the helper tab never answers (offline/error/closed), don't
	// silently drop the save — fall back to no_scope after a short wait.
	setTimeout(() => {
		if (pendingScopeResolves.has(resolveKey)) {
			pendingScopeResolves.delete(resolveKey);
			postedJson.scopeResolveAttempted = true;
			saveFieldAsFile(postedJson);
		}
	}, 8000);

	const req: any = {
		action: 'requestRecord',
		actionGoal: 'resolveScopeForSave',
		instance: postedJson.instance,
		tableName: postedJson.table,
		name: postedJson.name,
		resolveKey,
		// requestRecord (scriptsync.js) appends this query string to the URL.
		sys_id: postedJson.sys_id + '?sysparm_fields=sys_scope,sys_scope.scope&sysparm_exclude_reference_link=true',
	};
	debugLog(`Scope resolve requested for ${postedJson.table}/${postedJson.sys_id} (#143)`);
	broadcastToHelperTab(req);
}

function handleResolveScopeForSave(responseJson: any) {
	const key = responseJson?.resolveKey;
	if (!key || !pendingScopeResolves.has(key)) return;

	const payload = pendingScopeResolves.get(key);
	pendingScopeResolves.delete(key);
	payload.scopeResolveAttempted = true; // guard against re-querying in the retry

	const result = responseJson?.result || {};
	const scopeName = result['sys_scope.scope'];
	const scopeSysId = result['sys_scope'];

	if (scopeName === 'global' || scopeSysId === 'global') {
		payload.resolvedScopeName = 'global';
	} else if (scopeName) {
		// Use the resolved scope name directly as the folder, and best-effort
		// persist name->sys_id in scopes.json for other features (scope tree etc).
		payload.resolvedScopeName = scopeName;
		try {
			const scopesPath = workspace.rootPath + nodePath.sep + payload.instance.name + nodePath.sep + 'scopes.json';
			const scopes = eu.getFileAsJson(scopesPath);
			if (scopeSysId && scopes[scopeName] !== scopeSysId) {
				scopes[scopeName] = scopeSysId;
				eu.writeFile(scopesPath, JSON.stringify(scopes, null, 2), false, function () { });
			}
		} catch { /* best effort */ }
	}
	// else: genuinely scopeless -> resolvedScopeName stays undefined and the
	// scopeResolveAttempted guard routes it to no_scope.

	debugLog(`Scope resolved for ${payload.table}/${payload.sys_id} (#143): ${payload.resolvedScopeName || 'no_scope'}`);
	saveFieldAsFile(payload);
}

function saveFieldAsFile(postedJson, retry = 0) {

	
	let basePath = workspace.rootPath + nodePath.sep + postedJson.instance.name + nodePath.sep;
	
	let scope:string;
	if (postedJson.resolvedScopeName) // #143: scope resolved via an instance query below
		scope = postedJson.resolvedScopeName;
	else if (postedJson.scope == 'global') 
		scope = 'global';
	else if (postedJson.scope == '' || !postedJson.hasOwnProperty('scope')) {
		// #143: the form-save payload carried no scope (e.g. sys_scope isn't a
		// field on the Scheduled Job form). Before dropping the record into the
		// catch-all "no_scope" folder, ask the instance for its real sys_scope
		// and retry once with the resolved value.
		if (!postedJson.scopeResolveAttempted && postedJson.sys_id && wss && wss.clients.size) {
			resolveScopeThenSave(postedJson);
			return;
		}
		scope = 'no_scope'; //sync a none metadata file
	}
	else {
		let scopes = eu.getFileAsJson(basePath + "scopes.json");
		scopes = Object.entries(scopes).reduce((acc, [key, value]) => (acc[value + ''] = key, acc), {}); //invert object to have sys_id as key;
		scope = scopes[postedJson.scope];
	}

	if (!scope) { //if scope could not be determined, request the scopes via websocket, abort current try and try again in a few seconds.
		requestInstanceScope(postedJson.instance, postedJson.scope);
		if (++retry <= 2) setTimeout(() =>{ saveFieldAsFile(postedJson, retry)}, 2500);
		return;
	}

	//the configured tables will get a distinct folder containing the files.
	let isFolderRecordTable = Constants.FOLDERRECORDTABLES.includes(postedJson.table);
	let separtorCharacter = (isFolderRecordTable) ? nodePath.sep : ".";
	let fullPath = basePath + scope + nodePath.sep + postedJson.table + nodePath.sep;

	let scopeMappingFile = fullPath + '_map.json';
	let nameToSysId = eu.writeOrReadNameToSysIdMapping(scopeMappingFile);
	let cleanName = postedJson.name.replace(/[^a-z0-9\._\-+]+/gi, '').replace(/\./g, '-') || postedJson.sys_id + '';
	const runId = buildRunId();
	// If this file was synced before, use whatever name is in the _map.json
	cleanName = Object.keys(nameToSysId).find(fileName => nameToSysId[fileName] === postedJson.sys_id) ?? cleanName
	if (nameToSysId[cleanName] && nameToSysId[cleanName] != postedJson.sys_id){
		cleanName = cleanName + ("-" + postedJson.sys_id.slice(0,2) + postedJson.sys_id.slice(-2)).toUpperCase(); //if mapping already exist add first and last 2 chars of the syid to the filename
	}
	auditLog('map_resolution', {
		tableName: postedJson.table,
		sys_id: postedJson.sys_id,
		mapPath: scopeMappingFile,
		resolvedName: cleanName
	}, runId);


	nameToSysId[cleanName] = postedJson.sys_id;
	eu.writeOrReadNameToSysIdMapping(scopeMappingFile, nameToSysId);

	let req = <any>{};
	req.action = 'requestRecord';
	req.actionGoal = 'saveCheck';
	req.name = cleanName;
	req.instance = postedJson.instance;
	req.tableName = postedJson.table;
	req.fieldName = (postedJson.field.split(".").length == 3 ) ? "variable-" + postedJson.field.split(".")[2] : postedJson.field; //check if is a variable like 'inputs.var__m_atf_input_variable_41de4a935332120028bc29cac2dc349a.script'
	req.sys_id = postedJson.sys_id + "?sysparm_fields=name,sys_updated_on,sys_updated_by,sys_scope.scope," + postedJson.field;
	//requestRecords(req); // mmaybe implemt later to check changes with server version

	var fileExtension = ".js";
	var fieldType: string = postedJson.fieldType;

	fileExtension = Constants.FIELDTYPES[fieldType]?.extension;

	if (fieldType.includes("xml"))
		fileExtension = ".xml";
	else if (fieldType.includes("html"))
		fileExtension = ".html";
	else if (fieldType.includes("json"))
		fileExtension = ".json";
	else if (fieldType.includes("css") || fieldType == "properties" || req.fieldName == "css")
		fileExtension = ".scss";
	else if (req.name.lastIndexOf("-") > -1 && ["ecc_agent_script_file"].includes(req.tableName)) {
		var fileextens = req.name.substring(req.name.lastIndexOf("-") + 1, req.name.length);
		if (fileextens.length < 5) {
			fileExtension = "." + fileextens;
			req.name = req.name.substring(0, req.name.lastIndexOf("-"));
		}
	}
	else if (fieldType.includes("string") || fieldType == "conditions")
		fileExtension = ".txt";
	else if (req.fieldName == "PowerShell")
		fileExtension = ".ps1";

	let fileName = fullPath + cleanName + separtorCharacter + req.fieldName + fileExtension;

	eu.writeFile(fileName, postedJson.content, true, function (err) {
		if (err) {
			err.response = {};
			err.response.result = {};
			err.send = false;
			broadcastToHelperTab(err);
		}
		else {
			postedJson.result = '';
			postedJson.contentLength = postedJson.content.length;
			postedJson.send = false;

			broadcastToHelperTab(postedJson);
		}
	});


	eu.writeOrReadNameToSysIdMapping(scopeMappingFile, nameToSysId);

}

vscode.commands.registerCommand('infoTreeCommand', (arg) => {
	if (arg.action == "openUrl")
		vscode.env.openExternal(vscode.Uri.parse(arg.url));
	else if (arg.action == "refreshTree"){
		setScopeTree(true);
	}
	else if (arg.action == "loadScope"){
		requestScopeArtifacts();
	}
	else if (arg.action == "openInInstance"){
		openInInstance();
	}
	else if (arg.action == "selectionToBG"){
		selectionToBG(arg.global);
	}
});


vscode.commands.registerCommand('openFile', (meta) => {

	//the configured tables will get a distinct folder containing the files.
	let isFolderRecordTable = Constants.FOLDERRECORDTABLES.includes(meta.tableName);
	let separtorCharacter = (isFolderRecordTable) ? nodePath.sep : ".";
	let cleanName = meta.name.replace(/[^a-z0-9\._\-+]+/gi, '').replace(/\./g, '-').replace(/\s\s+/g, '_');

	let fileName = workspace.rootPath + nodePath.sep + meta.instance.name + nodePath.sep + meta.scope.name + nodePath.sep +
		meta.tableName + nodePath.sep + cleanName + separtorCharacter + meta.fieldName + meta.extension;

	if (fs.existsSync(fileName)) {
		vscode.workspace.openTextDocument(fileName).then(doc => {
			vscode.window.showTextDocument(doc, { "preview": false });
		});
	}
	else {
		let req = <any>{};
		req.instance = meta.instance;
		req.action = 'requestRecord';
		req.actionGoal = 'getCurrent';
		req.tableName = meta.tableName;
		req.fieldName = meta.fieldName;
		req.fileName = fileName;
		req.name = meta.name;
		req.sys_id = meta.sysId + "?sysparm_fields=name,sys_updated_on,sys_updated_by,sys_scope.scope," + req.fieldName;
		requestRecords(req);
	}

	//let opened = false;

	// //if its open activate the window
	// let tds = vscode.workspace.textDocuments;
	// for (let td in tds) {
	// 	if (tds[td].fileName == fileName) {
	// 		vscode.window.showTextDocument(tds[td]);
	// 		opened = true;
	// 	}
	// }

	// if (!opened) { //if not get the current version from the server.
	// 	let req = <any>{};
	// 	req.instance = meta.instance;
	// 	req.action = 'requestRecord';
	// 	req.actionGoal = 'getCurrent';
	// 	req.tableName = meta.tableName;
	// 	req.fieldName = meta.fieldName;
	// 	req.fileName = fileName;
	// 	req.name = meta.name;
	// 	req.sys_id = meta.sys_id + "?sysparm_fields=name,sys_updated_on,sys_updated_by,sys_scope.scope," + req.fieldName;
	// 	requestRecords(req);
	// }

});



function updateScriptSyncStatusBarItem(message: string): void {
	scriptSyncStatusBarItem.text = `$(megaphone) sn-scriptsync: ${message}`;
	scriptSyncStatusBarItem.show();
}

function sendToServiceNow(scriptObj: any) {
	if (!serverRunning) return;
	const runId = buildRunId();
	
	scriptObj.saveSource = "FileWatcher";
	auditLog('sync_dispatch_prepare', {
		tableName: scriptObj.tableName,
		fieldName: scriptObj.fieldName,
		sys_id: scriptObj.sys_id,
		saveSource: scriptObj.saveSource
	}, runId);
	
	if (!wss || !wss.clients.size) {
		vscode.window.showErrorMessage("No WebSocket connection. Please open SN Utils helper tab in a browser via slashcommand /token");
		auditLog('sync_dispatch_blocked', { reason: 'no_websocket_client', tableName: scriptObj.tableName, sys_id: scriptObj.sys_id }, runId);
		return;
	}
	
	broadcastToHelperTab(scriptObj);
	auditLog('sync_dispatch_sent', { tableName: scriptObj.tableName, sys_id: scriptObj.sys_id }, runId);
}

function requestTableStructure(tableName: string, instance: any) {
	const requestJson = {
		action: 'requestTableStructure',
		tableName: tableName,
		instance: instance
	};
	if (wss && wss.clients.size > 0) {
		broadcastToHelperTab(requestJson);
	}
}

function handleTableStructureResponse(responseJson: any) {
	if (responseJson?.agentRequestId && resolvePending(responseJson.agentRequestId, responseJson)) {
		return;
	}
	if (!responseJson.result) return;

	// Original logic for artifact creation flow
	const instanceName = responseJson.instance.name;
	const tableName = responseJson.tableName;
	const content = JSON.stringify(responseJson.result, null, 4);
	
	const basePath = workspace.rootPath + nodePath.sep + instanceName + nodePath.sep;
	
	// Quick heuristic: Check if we can find the folder. 
	// Since we don't have the scope here readily available without passing it through, 
	// we will try to find the folder.
	
	// Use fs.readdir to list scopes
	try {
		const scopes = fs.readdirSync(basePath).filter(f => fs.statSync(path.join(basePath, f)).isDirectory());
		scopes.forEach(scope => {
			const tablePath = path.join(basePath, scope, tableName);
			if (fs.existsSync(tablePath)) {
				const structurePath = path.join(tablePath, 'structure.json');
				if (!fs.existsSync(structurePath)) {
					eu.writeFile(structurePath, content, false, () => {});
				}
			}
		});
	} catch (e) {
		console.error("Error saving structure.json", e);
	}
}

async function createNewArtifact(scriptObj: any) {
	// Only support script includes for now
	const runId = buildRunId();
	auditLog('create_prepare', {
		tableName: scriptObj?.tableName,
		fieldName: scriptObj?.fieldName,
		name: scriptObj?.name,
		scope: scriptObj?.scope
	}, runId);

	if (!isCreateArtifactsEnabled()) {
		vscode.window.showWarningMessage('Artifact creation is disabled by setting sn-scriptsync.createArtifacts.enabled');
		auditLog('create_blocked', { reason: 'create_setting_disabled', tableName: scriptObj?.tableName, name: scriptObj?.name }, runId);
		return;
	}

	if (!wss || wss.clients.size === 0) {
		vscode.window.showErrorMessage("No WebSocket connection. Cannot create new artifact.");
		auditLog('create_blocked', { reason: 'no_websocket_client', tableName: scriptObj?.tableName, name: scriptObj?.name }, runId);
		return;
	}

	// Generate a unique key for this creation request
	const creationKey = `${scriptObj.tableName}:${scriptObj.name}:${scriptObj.scope}`;
	
	// Store the scriptObj for later use after name check
	pendingCreations.set(creationKey, scriptObj);

	// First, check if name already exists on the server
	const checkRequest = {
		action: 'checkNameExists',
		tableName: scriptObj.tableName,
		name: scriptObj.name,
		scope: scriptObj.scope,
		instance: scriptObj.instance,
		creationKey: creationKey
	};

	vscode.window.showInformationMessage(`Checking if "${scriptObj.name}" already exists...`);
	auditLog('create_name_check_sent', { creationKey, tableName: scriptObj.tableName, name: scriptObj.name }, runId);
	
	broadcastToHelperTab(checkRequest);
}

function handleCheckNameExistsResponse(responseJson: any) {
	if (responseJson?.agentRequestId && resolvePending(responseJson.agentRequestId, responseJson)) {
		return;
	}

	// Original logic for artifact creation flow
	const creationKey = responseJson.originalRequest?.creationKey;
	
	if (!creationKey || !pendingCreations.has(creationKey)) {
		console.error("No pending creation found for key:", creationKey);
		auditLog('create_name_check_orphaned', { creationKey: creationKey || 'missing' });
		return;
	}

	const scriptObj = pendingCreations.get(creationKey);
	pendingCreations.delete(creationKey);

	if (!responseJson.success) {
		vscode.window.showErrorMessage(`Error checking name: ${responseJson.error}`);
		auditLog('create_name_check_error', { creationKey, error: responseJson.error });
		return;
	}

	if (responseJson.exists) {
		auditLog('create_name_check_exists', { creationKey, existingSysId: responseJson.existingRecord?.sys_id || null });
		vscode.window.showErrorMessage(
			`Artifact "${scriptObj.name}" already exists in ServiceNow (sys_id: ${responseJson.existingRecord?.sys_id}). Use a different name.`
		);
		return;
	}

	// Name is available, proceed with creation
	auditLog('create_name_check_passed', { creationKey });
	proceedWithArtifactCreation(scriptObj);
}

function proceedWithArtifactCreation(scriptObj: any) {
	if (!isCreateArtifactsEnabled()) {
		vscode.window.showWarningMessage('Artifact creation is disabled by setting sn-scriptsync.createArtifacts.enabled');
		auditLog('create_blocked', { reason: 'create_setting_disabled', tableName: scriptObj?.tableName, name: scriptObj?.name });
		return;
	}

	const basePath = workspace.rootPath + nodePath.sep + scriptObj.instance.name + nodePath.sep;
	const tablePath = path.join(basePath, scriptObj.scopeName, scriptObj.tableName);

    // 1:1 Mapping: Pass the fields exactly as they should appear on the record.
    const recordPayload: any = {
        name: scriptObj.name,
        sys_scope: scriptObj.scope,
        [scriptObj.fieldName]: scriptObj.content // Dynamic field name (e.g. 'script')
    };

	// Best effort: Try to set sensible defaults for mandatory fields from structure.json
	const structurePath = path.join(tablePath, 'structure.json');
	
	if (fs.existsSync(structurePath)) {
		try {
			const structure = JSON.parse(fs.readFileSync(structurePath, 'utf8'));
			const columns = structure.columns || {};
			
			// Fields that are auto-generated by ServiceNow - skip these
			const autoGeneratedFields = ['sys_id', 'sys_created_on', 'sys_created_by', 'sys_updated_on', 'sys_updated_by', 'sys_mod_count'];
			
			// Best effort: Set default values for mandatory fields that aren't provided
			for (const [fieldName, fieldMeta] of Object.entries(columns) as [string, any][]) {
				// Skip if already provided, auto-generated, or not mandatory
				if (recordPayload[fieldName] !== undefined && recordPayload[fieldName] !== '') continue;
				if (autoGeneratedFields.includes(fieldName)) continue;
				
				// Try to set a default value if one exists
				if (fieldMeta.default_value) {
					recordPayload[fieldName] = fieldMeta.default_value;
				}
				// For boolean fields, default to true for common ones like 'active'
				else if (fieldMeta.type === 'boolean' && fieldName === 'active') {
					recordPayload[fieldName] = 'true';
				}
			}
		} catch (e) {
			console.error("Error reading structure.json for best effort defaults", e);
			// Continue anyway
		}
	} else {
		// Request structure for future use (non-blocking)
		requestTableStructure(scriptObj.tableName, scriptObj.instance);
	}

	const requestJson = {
		action: 'createRecord',
        tableName: scriptObj.tableName,
		instance: scriptObj.instance,
		scope: scriptObj.scope, // For sysparm_transaction_scope in URL
		payload: recordPayload 
	};

	broadcastToHelperTab(requestJson);
	auditLog('create_dispatch_sent', { tableName: scriptObj.tableName, name: scriptObj.name, scope: scriptObj.scope });
	vscode.window.showInformationMessage(`Creating new ${scriptObj.tableName}: ${scriptObj.name}`);
}

async function createArtifact(artifact: any) {
	if (!isCreateArtifactsEnabled()) {
		vscode.window.showWarningMessage('Artifact creation is disabled by setting sn-scriptsync.createArtifacts.enabled');
		auditLog('create_blocked', { reason: 'create_setting_disabled', source: 'command_palette' });
		return;
	}

	if (!serverRunning) {
		vscode.window.showInformationMessage("sn-scriptsync server must be running");
		return;
	}

	if (!wss.clients.size) {
		vscode.window.showErrorMessage("No WebSocket connection. Please open SN Utils helper tab in a browser via slashcommand /token");
		return;
	}

	const requestJson = {
		action: 'createRecord',
		payload: artifact
	};

	broadcastToHelperTab(requestJson);

	vscode.window.showInformationMessage(`Requesting to create artifact: ${JSON.stringify(artifact?.name || artifact?.sys_id || 'unknown')}`);
}

async function selectionToBG(global = true) {

	if (!serverRunning) {
		vscode.window.showInformationMessage("sn-scriptsync server must be running")
		return;
	}

	var date = new Date();
	let my_id = ( date.getFullYear().toString() + pad2(date.getMonth() + 1) + pad2( date.getDate()) + '-' +  pad2( date.getHours() ) + pad2( date.getMinutes() ) + pad2( date.getSeconds() ) );


	let editor = vscode.window.activeTextEditor;
	if (!editor) {
		vscode.window.showInformationMessage("Please open a script file first.")
		return;
	}
	let scriptObj = eu.fileNameToObject(editor.document);

	if (global){
		scriptObj.scope = 'global';
		scriptObj.scopeName = 'global';
	}

	scriptObj.content = `gs.info("// sn-scriptsync BG Script - scope: ${scriptObj?.scopeName}");\n\n`
						 + String.raw`${editor.document.getText(editor.selection)}`;
	scriptObj.field = 'bg';
	scriptObj.table = 'background'
	scriptObj.sys_id = my_id;
	scriptObj.fieldType = 'script';
	scriptObj.name = 'script'; 

	saveFieldAsFile(scriptObj)

	function pad2(n) { return n < 10 ? '0' + n : n } //helper for date id


};

async function bgScriptExecute(showWarning = true) {
	if (!serverRunning) {
		vscode.window.showInformationMessage("sn-scriptsync server must be running")
		return;
	}
	let scriptObj:any = true;
	let editor = vscode.window?.activeTextEditor;
	if (editor)
		scriptObj = eu.fileNameToObject(editor.document);

	if (scriptObj === true) {
		if (showWarning)
			eu.showMessage("Please open a scope file first.",3000);
		return; //not a valid file
	} 
	if(!editor.document.fileName.includes(path.sep + 'background' + path.sep)){
		vscode.window.showInformationMessage("Only files in /background directory can be executed")
		return;
	}
	if (wss.clients.size == 0) {
		vscode.window.showInformationMessage("No WebSocket connection. Please open SN Utils helper tab in a browser via slashcommand /token");
		return;
	}

	scriptObj.instance.scope = scriptObj.scope; //expected like this in SN Utils scriptsync.js
	editor.document.save();
	scriptObj.executeScript = true;

	scriptObj.action = 'executeBackgroundScript';
    writeBGScriptStartToWebViewPanel(scriptObj);

	broadcastToHelperTab(scriptObj);

};

async function openInInstance(showWarning = true) {
	if (!serverRunning) {
		vscode.window.showInformationMessage("sn-scriptsync server must be running")
		return;
	}
	let scriptObj:any = true;
	let editor = vscode.window?.activeTextEditor;
	if (editor)
		scriptObj = eu.fileNameToObject(editor.document);

	if (scriptObj === true) {
		if (showWarning)
			eu.showMessage("Please open a scope file to open matching record.",3000);
		return; //not a valid file
	} 
	let url = scriptObj.instance.url + "/";

	if (scriptObj.tableName == 'sp_widget'){
		url += 'sp_config?id=widget_editor&sys_id=' + scriptObj.sys_id;
	}
	else {
		url += scriptObj.tableName + '.do?sys_id=' + scriptObj.sys_id;
	}
	vscode.env.openExternal(vscode.Uri.parse(url));
};

async function refreshFromInstance(showWarning = true) {
	if (!serverRunning) {
		vscode.window.showInformationMessage("sn-scriptsync server must be running")
		return;
	}
	let scriptObj:any = true;
	let editor = vscode.window?.activeTextEditor;
	if (editor)
		scriptObj = eu.fileNameToObject(editor.document);

	if (scriptObj === true) {
		if (showWarning)
			eu.showMessage("Please open a scope file...",3000);
		return; //not a valid file
	} 

	scriptObj.action = 'requestRecord';
	scriptObj.actionGoal = 'getCurrent';
	scriptObj.sys_id = scriptObj.sys_id + "?sysparm_fields=name,sys_updated_on,sys_updated_by,sys_scope.scope," + scriptObj.fieldName;
	requestRecords(scriptObj);

};

async function takeScreenshot(url?: string) {
	if (!serverRunning) {
		vscode.window.showErrorMessage("sn-scriptsync server must be running");
		return;
	}
	
	if (!wss || !wss.clients.size) {
		vscode.window.showErrorMessage("No WebSocket connection. Please open SN Utils helper tab in a browser via slashcommand /token");
		return;
	}

	// If no URL provided, prompt user for one
	if (!url) {
		url = await vscode.window.showInputBox({
			prompt: 'Enter the URL to capture',
			placeHolder: 'https://instance.service-now.com/...',
			validateInput: (value) => {
				if (!value) {
					return 'URL is required';
				}
				if (!value.startsWith('http://') && !value.startsWith('https://')) {
					return 'URL must start with http:// or https://';
				}
				return null;
			}
		});

		if (!url) {
			return; // User cancelled
		}
	}

	// Generate a timestamp for the filename
	const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
	const fileName = `screenshot_${timestamp}.png`;

	// Get workspace path for saving
	const workspacePath = workspace.rootPath;
	if (!workspacePath) {
		vscode.window.showErrorMessage("No workspace folder open. Please open a folder first.");
		return;
	}

	// Create screenshots folder if it doesn't exist
	const screenshotsFolder = path.join(workspacePath, 'screenshots');
	if (!fs.existsSync(screenshotsFolder)) {
		fs.mkdirSync(screenshotsFolder, { recursive: true });
	}

	const screenshotRequest = {
		action: 'takeScreenshot',
		url: url,
		fileName: fileName,
		savePath: path.join(screenshotsFolder, fileName)
	};

	vscode.window.showInformationMessage(`Taking screenshot of ${url}...`);

	broadcastToHelperTab(screenshotRequest);
}
