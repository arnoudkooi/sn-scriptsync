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



let sass = require('sass');
let metaDataRelations : any;
let scopeTableResponseCount = 0;
let scopeJson : any = {};

let wss;
let serverRunning = false;
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
// Track timestamps of manual saves to ignore subsequent watcher events
const recentManualSaves: Map<string, number> = new Map();

// Global debounce state
let globalDebounceTimer: NodeJS.Timeout | undefined;
const pendingFiles = new Set<string>();

// Pending artifact creations (waiting for name check)
const pendingCreations: Map<string, any> = new Map();

// Process all pending files - extracted for reuse by Sync Now
function processPendingFiles() {
	// Group files by record (same instance/scope/table/sys_id)
	const recordGroups = new Map<string, { scriptObj: any, fields: Map<string, string> }>();
	
	pendingFiles.forEach(file => {
		const scriptObj = eu.fileNameToObject(file);
		if (scriptObj === true || !scriptObj?.sys_id) {
			// Can't group, save individually
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
			sendToServiceNow(group.scriptObj);
		} else {
			// Multiple fields - combine into single request
			group.scriptObj.fields = Object.fromEntries(group.fields);
			group.scriptObj.fieldName = Array.from(group.fields.keys()).join(', ');
			group.scriptObj.content = ''; // Not used for multi-field
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

// Agent API - File-based AI communication
interface AgentRequest {
	id: string;
	command: string;
	params?: any;
	timestamp?: number;
}

interface AgentResponse {
	id: string;
	command: string;
	status: 'success' | 'error';
	result?: any;
	error?: string;
	timestamp: number;
}

// Pending async Agent API requests (for commands that need ServiceNow round-trip)
interface PendingAgentRequest {
	request: AgentRequest;
	responsePath: string;
	instanceFolder: string;
}
const pendingAgentRequests: Map<string, PendingAgentRequest> = new Map();

async function handleAgentRequest(requestPath: string) {
	try {
		const content = fs.readFileSync(requestPath, 'utf8').trim();
		
		// Skip empty or cleared request files
		if (!content || content === '{}' || content === '') {
			return;
		}
		
		const request: AgentRequest = JSON.parse(content);
		
		// Skip if no valid command
		if (!request.id || !request.command) {
			debugLog(`Agent API: Skipping invalid request (missing id or command)`);
			return;
		}
		
		// Security: Validate request ID format (alphanumeric, underscore, hyphen only)
		if (!/^[a-zA-Z0-9_-]+$/.test(request.id)) {
			debugLog(`Agent API: Security violation - invalid request ID format: ${request.id}`);
			const errorResponse: AgentResponse = {
				id: request.id || 'unknown',
				command: request.command,
				status: 'error',
				error: 'Invalid request ID: only alphanumeric, underscore, and hyphen allowed',
				timestamp: Date.now()
			};
			// Try to write error response if possible
			try {
				const safeDir = path.join(path.dirname(requestPath), '..', 'responses');
				if (fs.existsSync(safeDir)) {
					fs.writeFileSync(path.join(safeDir, `res_error.json`), JSON.stringify(errorResponse, null, 2));
				}
			} catch (e) {
				// Silently fail - security takes precedence
			}
			return;
		}
		
		debugLog(`Agent API Request: ${request.command} (id: ${request.id})`);
		
		// Structure: <instance>/agent/requests/<req>.json
		// Go up two levels to get instance folder: requests -> agent -> instance
		const instanceFolder = path.dirname(path.dirname(path.dirname(requestPath)));
		
		// Security: Validate instance folder is within workspace
		const workspaceRoot = vscode.workspace.rootPath || '';
		if (!workspaceRoot || !instanceFolder.startsWith(workspaceRoot)) {
			debugLog(`Agent API: Security violation - request path outside workspace`);
			const errorResponse: AgentResponse = {
				id: request.id,
				command: request.command,
				status: 'error',
				error: 'Security: Request path outside workspace',
				timestamp: Date.now()
			};
			return;
		}
		
		const responseDir = path.join(instanceFolder, 'agent', 'responses');
		if (!fs.existsSync(responseDir)) {
			fs.mkdirSync(responseDir, { recursive: true });
		}
		
		// Response file matches request ID
		const responsePath = path.join(responseDir, `res_${request.id}.json`);
		
		let response: AgentResponse = {
			id: request.id,
			command: request.command,
			status: 'success',
			timestamp: Date.now()
		};
		
		try {
			switch (request.command) {
				case 'check_connection':
					// Verify WebSocket server is running and browser is connected
					const wsRunning = serverRunning && wss !== undefined;
					const browserConnected = wsRunning && wss?.clients?.size > 0;
					
					if (!wsRunning) {
						response.status = 'error';
						response.error = 'WebSocket server not running. Click sn-scriptsync in VS Code status bar to start.';
						response.result = {
							ready: false,
							serverRunning: false,
							browserConnected: false,
							message: 'WebSocket server not running'
						};
					} else if (!browserConnected) {
						response.status = 'error';
						response.error = 'No browser connection. Open SN Utils helper tab via /token command in ServiceNow.';
						response.result = {
							ready: false,
							serverRunning: true,
							browserConnected: false,
							message: 'No browser connected - open helper tab with /token'
						};
					} else {
						response.result = {
							ready: true,
							serverRunning: true,
							browserConnected: true,
							clientCount: wss.clients.size,
							message: 'Connected and ready'
						};
					}
					break;
				
				case 'get_sync_status':
					response.result = {
						serverRunning,
						pendingFiles: Array.from(pendingFiles),
						pendingCount: pendingFiles.size,
						isPaused: queueProvider?.isPaused || false
					};
					break;
				
				case 'get_last_error': {
					// Get the last error that occurred (if any)
					const errorFilePath = path.join(instanceFolder, '_last_error.json');
					if (fs.existsSync(errorFilePath)) {
						try {
							const errorData = JSON.parse(fs.readFileSync(errorFilePath, 'utf8'));
							// Check if error is recent (within last 60 seconds)
							const isRecent = errorData.timestamp && (Date.now() - errorData.timestamp < 60000);
							response.result = {
								hasError: true,
								isRecent: isRecent,
								error: errorData.error,
								time: errorData.time,
								timestamp: errorData.timestamp,
								details: errorData.details
							};
						} catch (e) {
							response.result = { hasError: false, message: 'No recent errors' };
						}
					} else {
						response.result = { hasError: false, message: 'No errors recorded' };
					}
					break;
				}
				
				case 'clear_last_error': {
					// Clear the last error file
					const clearErrorPath = path.join(instanceFolder, '_last_error.json');
					if (fs.existsSync(clearErrorPath)) {
						fs.unlinkSync(clearErrorPath);
						response.result = { cleared: true, message: 'Error cleared' };
					} else {
						response.result = { cleared: false, message: 'No error to clear' };
					}
					break;
				}
				
				case 'sync_now':
					// Immediately sync all pending files (flush the queue)
					if (pendingFiles.size === 0) {
						response.result = {
							synced: false,
							message: 'No pending files to sync',
							count: 0
						};
					} else {
						const count = pendingFiles.size;
						const files = Array.from(pendingFiles);
						processPendingFiles();
						response.result = {
							synced: true,
							message: `Synced ${count} file(s) immediately`,
							count: count,
							files: files
						};
					}
					break;
				
				case 'update_record': {
					// Direct update without creating temporary files
					const updateSysId = request.params?.sys_id;
					const updateTable = request.params?.table;
					const updateField = request.params?.field;
					const updateContent = request.params?.content;
					
					if (!updateSysId || !updateTable || !updateField || updateContent === undefined) {
						throw new Error('Missing required params: sys_id, table, field, content');
					}
					
					// Get instance settings
					const instanceSettings1 = eu.getInstanceSettings(path.basename(instanceFolder));
					if (!instanceSettings1?.url) {
						throw new Error('Instance settings not found. Ensure _settings.json exists.');
					}
					
					// Check WebSocket connection
					if (!serverRunning || !wss) {
						throw new Error('WebSocket server not running. Click sn-scriptsync in status bar to start.');
					}
					if (!wss.clients.size) {
						throw new Error('No browser connection. Open SN Utils helper tab via /token command.');
					}
					
					// Build scriptObj directly (no file system!)
					const directScriptObj = {
						sys_id: updateSysId,
						tableName: updateTable,
						fieldName: updateField,
						content: updateContent,
						instance: instanceSettings1,
						saveSource: 'AgentAPI-Direct'
					};
					
					// Send directly to ServiceNow via WebSocket
					broadcastToHelperTab(directScriptObj);
					
					debugLog(`Agent API: Direct update sent for ${updateTable}/${updateSysId}.${updateField}`);
					
					response.result = {
						success: true,
						message: `Update sent for ${updateTable}/${updateSysId}`,
						table: updateTable,
						sys_id: updateSysId,
						field: updateField
					};
					break;
				}
				
				case 'update_record_batch': {
					// Update multiple fields on the same record in one request
					const batchSysId = request.params?.sys_id;
					const batchTable = request.params?.table;
					const batchFields = request.params?.fields; // { script: "...", css: "...", etc }
					
					if (!batchSysId || !batchTable || !batchFields || typeof batchFields !== 'object') {
						throw new Error('Missing required params: sys_id, table, fields (object with field:content pairs)');
					}
					
					const fieldNames = Object.keys(batchFields);
					if (fieldNames.length === 0) {
						throw new Error('Fields object cannot be empty');
					}
					
					// Get instance settings
					const instanceSettings2 = eu.getInstanceSettings(path.basename(instanceFolder));
					if (!instanceSettings2?.url) {
						throw new Error('Instance settings not found. Ensure _settings.json exists.');
					}
					
					// Check WebSocket connection
					if (!serverRunning || !wss) {
						throw new Error('WebSocket server not running. Click sn-scriptsync in status bar to start.');
					}
					if (!wss.clients.size) {
						throw new Error('No browser connection. Open SN Utils helper tab via /token command.');
					}
					
					// Build batch scriptObj
					const batchScriptObj = {
						sys_id: batchSysId,
						tableName: batchTable,
						fields: batchFields,
						fieldName: fieldNames.join(', '),
						content: '', // Not used for multi-field
						instance: instanceSettings2,
						saveSource: 'AgentAPI-Batch'
					};
					
					// Send directly to ServiceNow via WebSocket
					broadcastToHelperTab(batchScriptObj);
					
					debugLog(`Agent API: Batch update sent for ${batchTable}/${batchSysId} (${fieldNames.length} fields)`);
					
					response.result = {
						success: true,
						message: `Updated ${fieldNames.length} field(s) on ${batchTable}/${batchSysId}`,
						table: batchTable,
						sys_id: batchSysId,
						fields: fieldNames
					};
					break;
				}
				
				case 'open_in_browser': {
					// Open an artifact in the browser via scriptsync (to maintain correct scope)
					const openTable = request.params?.table;
					const openSysId = request.params?.sys_id;
					const openScope = request.params?.scope || 'global';
					const openName = request.params?.name;
					
					if (!openSysId) {
						// Try to get sys_id from _map.json if name is provided
						if (openName && openTable) {
							const mapPath = path.join(instanceFolder, openScope, openTable, '_map.json');
							if (fs.existsSync(mapPath)) {
								const mapContent = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
								const cleanName = openName.replace(/[^a-z0-9\._\-+]+/gi, '').replace(/\./g, '-');
								if (mapContent[cleanName]) {
									request.params.sys_id = mapContent[cleanName];
								}
							}
						}
						if (!request.params?.sys_id) {
							throw new Error('Missing required param: sys_id (or name + table + scope to look it up)');
						}
					}
					
					const instanceSettings5 = eu.getInstanceSettings(path.basename(instanceFolder));
					if (!instanceSettings5?.url) {
						throw new Error('Instance settings not found');
					}
					
					// Check if scriptsync is connected
					if (!serverRunning || !wss?.clients?.size) {
						throw new Error('Not connected to ServiceNow. Open browser helper tab first.');
					}
					
					let openUrl: string;
					const sysId = request.params.sys_id;
					
					// Build URL based on table type
					if (openTable === 'sp_widget') {
						// Widget preview URL
						openUrl = `${instanceSettings5.url}/$sp.do?id=sp-preview&sys_id=${sysId}`;
					} else if (openTable === 'sp_page') {
						// Portal page - open in portal
						openUrl = `${instanceSettings5.url}/sp?id=${openName || sysId}`;
					} else {
						// Standard form view
						openUrl = `${instanceSettings5.url}/${openTable}.do?sys_id=${sysId}`;
					}
					
					// Route through scriptsync to open in connected browser (maintains scope)
					const agentRequestIdOpen = `open_${request.id}_${Date.now()}`;
					
					pendingAgentRequests.set(agentRequestIdOpen, {
						request,
						responsePath,
						instanceFolder
					});
					
					const openRequest = {
						action: 'activateTab',
						agentRequestId: agentRequestIdOpen,
						url: openUrl,
						reload: false,
						waitForLoad: false,
						openIfNotFound: true
					};
					
					broadcastToHelperTab(openRequest);
					
					debugLog(`Agent API: Sent open_in_browser request for ${openUrl}`);
					return; // Response written when WebSocket returns
				}
				
				case 'refresh_preview': {
					// Send refresh command to browser for widget preview or test URLs
					const refreshTable = request.params?.table;
					const refreshSysId = request.params?.sys_id;
					const refreshScope = request.params?.scope || 'global';
					const refreshName = request.params?.name;
					
					if (!serverRunning || !wss?.clients?.size) {
						throw new Error('Not connected to ServiceNow. Open browser helper tab first.');
					}
					
					const instanceSettings6 = eu.getInstanceSettings(path.basename(instanceFolder));
					if (!instanceSettings6?.url) {
						throw new Error('Instance settings not found');
					}
					
					// Get sys_id from _map.json if needed
					let sysIdToRefresh = refreshSysId;
					if (!sysIdToRefresh && refreshName && refreshTable) {
						const mapPath = path.join(instanceFolder, refreshScope, refreshTable, '_map.json');
						if (fs.existsSync(mapPath)) {
							const mapContent = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
							const cleanName = refreshName.replace(/[^a-z0-9\._\-+]+/gi, '').replace(/\./g, '-');
							sysIdToRefresh = mapContent[cleanName];
						}
					}
					
					if (!sysIdToRefresh) {
						throw new Error('Missing required param: sys_id (or name + table + scope to look it up)');
					}
					
					// Build test URLs for widget
					const testUrls: string[] = [];
					if (refreshTable === 'sp_widget') {
						testUrls.push(`${instanceSettings6.url}/$sp.do?id=sp-preview&sys_id=${sysIdToRefresh}*`);
						if (refreshName) {
							const widgetId = refreshName.toLowerCase().replace(/\s+/g, '_');
							testUrls.push(`${instanceSettings6.url}/sp_config?id=${widgetId}*`);
							testUrls.push(`${instanceSettings6.url}/sp?id=${widgetId}*`);
							testUrls.push(`${instanceSettings6.url}/esc?id=${widgetId}*`);
						}
					}
					
					// Send refresh command to browser
					const refreshCommand = {
						action: 'refreshPreview',
						testUrls: testUrls,
						sys_id: sysIdToRefresh,
						instance: instanceSettings6
					};
					
					broadcastToHelperTab(refreshCommand);
					
					response.result = {
						refreshed: true,
						sys_id: sysIdToRefresh,
						testUrls: testUrls,
						message: `Refresh command sent for ${refreshTable || 'artifact'}`
					};
					break;
				}
					
				case 'get_instance_info':
					const settings = eu.getInstanceSettings(path.basename(instanceFolder));
					response.result = {
						instanceName: path.basename(instanceFolder),
						hasSettings: !!settings,
						connected: serverRunning && wss?.clients?.size > 0
					};
					break;
					
				case 'list_tables':
					// List table folders in the instance
					const instancePath = instanceFolder;
					const folders = fs.readdirSync(instancePath, { withFileTypes: true })
						.filter(d => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.'))
						.map(d => d.name);
					response.result = { tables: folders };
					break;
					
				case 'list_artifacts':
					// List artifacts in a table folder
					const tableName = request.params?.table;
					if (!tableName) {
						throw new Error('Missing required param: table');
					}
					const tablePath = path.join(instanceFolder, tableName);
					if (!fs.existsSync(tablePath)) {
						// Check in scope subfolders
						const scopes = fs.readdirSync(instanceFolder, { withFileTypes: true })
							.filter(d => d.isDirectory() && !d.name.startsWith('_'));
						let artifacts: string[] = [];
						for (const scope of scopes) {
							const scopeTablePath = path.join(instanceFolder, scope.name, tableName);
							if (fs.existsSync(scopeTablePath)) {
								const files = fs.readdirSync(scopeTablePath)
									.filter(f => !f.startsWith('_') && !f.startsWith('.'));
								artifacts = artifacts.concat(files.map(f => `${scope.name}/${f}`));
							}
						}
						response.result = { artifacts };
					} else {
						const files = fs.readdirSync(tablePath)
							.filter(f => !f.startsWith('_') && !f.startsWith('.'));
						response.result = { artifacts: files };
					}
					break;
					
				case 'check_name_exists':
					// Check if an artifact name exists in the mapping
					const checkTable = request.params?.table;
					const checkName = request.params?.name;
					if (!checkTable || !checkName) {
						throw new Error('Missing required params: table, name');
					}
					// Search through scope folders for _map.json
					let exists = false;
					let existingSysId: string | null = null;
					const scopeDirs = fs.readdirSync(instanceFolder, { withFileTypes: true })
						.filter(d => d.isDirectory() && !d.name.startsWith('_'));
					for (const scopeDir of scopeDirs) {
						const mapPath = path.join(instanceFolder, scopeDir.name, checkTable, '_map.json');
						if (fs.existsSync(mapPath)) {
							const mapContent = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
							for (const [sysId, info] of Object.entries(mapContent)) {
								if ((info as any).name === checkName) {
									exists = true;
									existingSysId = sysId;
									break;
								}
							}
						}
						if (exists) break;
					}
					response.result = { exists, sysId: existingSysId };
					break;
					
				case 'get_file_structure':
					// Return expected file naming convention
					response.result = {
						pattern: '{instance}/{scope}/{table}/{name}.{field}.{ext}',
						example: 'myinstance/global/sys_script_include/MyUtils.script.js',
						fields: {
							sys_script_include: ['script'],
							sys_script: ['script'],
							sys_ui_script: ['script'],
							sp_widget: ['script', 'css', 'client_script', 'link', 'template'],
							sys_ui_page: ['html', 'client_script', 'processing_script']
						}
					};
					break;
					
				case 'validate_path':
					// Validate a proposed file path
					const filePath = request.params?.path;
					if (!filePath) {
						throw new Error('Missing required param: path');
					}
					const parts = filePath.split(path.sep).filter((p: string) => p);
					const isValid = parts.length >= 3;
					response.result = {
						valid: isValid,
						parsed: isValid ? {
							instance: parts[0],
							scope: parts.length > 3 ? parts[1] : 'global',
							table: parts.length > 3 ? parts[2] : parts[1],
							file: parts[parts.length - 1]
						} : null,
						reason: !isValid ? 'Path must be at least instance/table/file' : null
					};
					break;
				
				// ===== REMOTE COMMANDS (require ServiceNow round-trip) =====
				
				case 'get_table_metadata': {
					// Fetch table metadata from ServiceNow (reuses existing requestTableStructure)
					const metaTable = request.params?.table;
					if (!metaTable) {
						throw new Error('Missing required param: table');
					}
					if (!serverRunning || !wss?.clients?.size) {
						throw new Error('Not connected to ServiceNow. Open browser helper tab first.');
					}
					
					// Get instance settings
					const instanceSettings = eu.getInstanceSettings(path.basename(instanceFolder));
					if (!instanceSettings?.url) {
						throw new Error('Instance settings not found');
					}
					
					// Store pending request
					const agentRequestId = `agent_${request.id}`;
					pendingAgentRequests.set(agentRequestId, {
						request,
						responsePath,
						instanceFolder
					});
					
					// Send request using existing action
					const metaRequest = {
						action: 'requestTableStructure',
						agentRequestId,
						tableName: metaTable,
						instance: instanceSettings
					};
					
					broadcastToHelperTab(metaRequest);
					
					debugLog(`Agent API: Sent remote request for table metadata: ${metaTable}`);
					return; // Response written when WebSocket returns
				}
				
				case 'check_name_exists_remote': {
					// Check if artifact exists in ServiceNow (reuses existing checkNameExists)
					const remoteTable = request.params?.table;
					const remoteName = request.params?.name;
					if (!remoteTable || !remoteName) {
						throw new Error('Missing required params: table, name');
					}
					if (!serverRunning || !wss?.clients?.size) {
						throw new Error('Not connected to ServiceNow. Open browser helper tab first.');
					}
					
					const instanceSettings2 = eu.getInstanceSettings(path.basename(instanceFolder));
					if (!instanceSettings2?.url) {
						throw new Error('Instance settings not found');
					}
					
					const agentRequestId2 = `agent_${request.id}`;
					pendingAgentRequests.set(agentRequestId2, {
						request,
						responsePath,
						instanceFolder
					});
					
					// Send request using existing action
					const checkRemoteRequest = {
						action: 'checkNameExists',
						agentRequestId: agentRequestId2,
						tableName: remoteTable,
						name: remoteName,
						instance: instanceSettings2
					};
					
					broadcastToHelperTab(checkRemoteRequest);
					
					debugLog(`Agent API: Sent remote check for ${remoteName} in ${remoteTable}`);
					return; // Response written when WebSocket returns
				}
				
				case 'query_records': {
					// Execute an arbitrary query against any ServiceNow table
					const queryTable = request.params?.table;
					const encodedQuery = request.params?.query || '';
					const queryFields = request.params?.fields || 'sys_id,number,short_description,sys_created_on';
					const queryLimit = request.params?.limit || 10;
					const queryOrderBy = request.params?.orderBy || '';
					
					if (!queryTable) {
						throw new Error('Missing required param: table');
					}
					if (!serverRunning || !wss?.clients?.size) {
						throw new Error('Not connected to ServiceNow. Open browser helper tab first.');
					}
					
					const instanceSettingsQuery = eu.getInstanceSettings(path.basename(instanceFolder));
					if (!instanceSettingsQuery?.url) {
						throw new Error('Instance settings not found');
					}
					
					const agentRequestIdQuery = `agent_${request.id}`;
					pendingAgentRequests.set(agentRequestIdQuery, {
						request,
						responsePath,
						instanceFolder
					});
					
					// Build query string
					let queryString = `sysparm_fields=${queryFields}&sysparm_limit=${queryLimit}`;
					if (encodedQuery) {
						queryString += `&sysparm_query=${encodedQuery}`;
					}
					if (queryOrderBy) {
						// Append to existing query or create new one
						if (encodedQuery) {
							queryString = queryString.replace(`sysparm_query=${encodedQuery}`, `sysparm_query=${encodedQuery}^${queryOrderBy}`);
						} else {
							queryString += `&sysparm_query=${queryOrderBy}`;
						}
					}
					
					const queryRequest = {
						action: 'agentQueryRecords',
						agentRequestId: agentRequestIdQuery,
						tableName: queryTable,
						queryString: queryString,
						instance: instanceSettingsQuery
					};
					
					broadcastToHelperTab(queryRequest);
					
					debugLog(`Agent API: Sent query request to ${queryTable}: ${encodedQuery}`);
					return; // Response written when WebSocket returns
				}
				
				case 'get_parent_options': {
					// Get available parent records for reference fields (e.g., REST API services for sys_ws_operation)
					const parentTable = request.params?.table;
					const scopeFilter = request.params?.scope; // optional scope filter
					const nameField = request.params?.nameField || 'name'; // field to use as display name
					const limit = request.params?.limit || 50;
					
					if (!parentTable) {
						throw new Error('Missing required param: table');
					}
					if (!serverRunning || !wss?.clients?.size) {
						throw new Error('Not connected to ServiceNow. Open browser helper tab first.');
					}
					
					const instanceSettings3 = eu.getInstanceSettings(path.basename(instanceFolder));
					if (!instanceSettings3?.url) {
						throw new Error('Instance settings not found');
					}
					
					const agentRequestId3 = `agent_${request.id}`;
					pendingAgentRequests.set(agentRequestId3, {
						request,
						responsePath,
						instanceFolder
					});
					
					// Build query string
					let queryString = `sysparm_fields=sys_id,${nameField},sys_scope&sysparm_limit=${limit}`;
					if (scopeFilter) {
						queryString += `&sysparm_query=sys_scope.scope=${scopeFilter}^ORDERBYname`;
					} else {
						queryString += `&sysparm_query=ORDERBYname`;
					}
					
					const parentRequest = {
						action: 'agentGetParentOptions',
						agentRequestId: agentRequestId3,
						tableName: parentTable,
						nameField: nameField,
						queryString: queryString,
						instance: instanceSettings3
					};
					
					broadcastToHelperTab(parentRequest);
					
					debugLog(`Agent API: Sent request for parent options from ${parentTable}`);
					return; // Response written when WebSocket returns
				}
				
				case 'take_screenshot': {
					// Take a screenshot of a ServiceNow page
					const screenshotUrl = request.params?.url;
					const screenshotTabId = request.params?.tabId;
					
					if (!screenshotUrl && !screenshotTabId) {
						throw new Error('Missing required param: url or tabId');
					}
					if (!serverRunning || !wss?.clients?.size) {
						throw new Error('Not connected to ServiceNow. Open browser helper tab first.');
					}
					
					const workspacePath = workspace.rootPath;
					if (!workspacePath) {
						throw new Error('No workspace folder open');
					}
					
					// Create screenshots folder if it doesn't exist
					const screenshotsFolder = path.join(workspacePath, 'screenshots');
					if (!fs.existsSync(screenshotsFolder)) {
						fs.mkdirSync(screenshotsFolder, { recursive: true });
					}
					
					// Generate filename with timestamp
					const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
					const fileName = request.params?.fileName || `screenshot_${timestamp}.png`;
					
					const agentRequestIdScreenshot = `agent_${request.id}`;
					pendingAgentRequests.set(agentRequestIdScreenshot, {
						request,
						responsePath,
						instanceFolder
					});
					
					const screenshotRequest = {
						action: 'takeScreenshot',
						agentRequestId: agentRequestIdScreenshot,
						url: screenshotUrl,
						tabId: screenshotTabId,
						fileName: fileName,
						savePath: path.join(screenshotsFolder, fileName)
					};
					
					broadcastToHelperTab(screenshotRequest);
					
					debugLog(`Agent API: Sent screenshot request for ${screenshotUrl || `tabId:${screenshotTabId}`}`);
					return; // Response written when WebSocket returns
				}
				
				case 'run_slash_command': {
					// Run a SN Utils slash command on a ServiceNow tab
					const slashCommand = request.params?.command;
					const slashUrl = request.params?.url || 'https://*.service-now.com/*';
					const slashTabId = request.params?.tabId;
					const slashAutoRun = request.params?.autoRun !== false; // Default true
					
					if (!slashCommand) {
						throw new Error('Missing required param: command');
					}
					if (!serverRunning || !wss?.clients?.size) {
						throw new Error('Not connected to ServiceNow. Open browser helper tab first.');
					}
					
					const agentRequestIdSlash = `agent_${request.id}`;
					pendingAgentRequests.set(agentRequestIdSlash, {
						request,
						responsePath,
						instanceFolder
					});
					
					const slashRequest = {
						action: 'runSlashCommand',
						agentRequestId: agentRequestIdSlash,
						command: slashCommand,
						url: slashUrl,
						tabId: slashTabId,
						autoRun: slashAutoRun
					};
					
					broadcastToHelperTab(slashRequest);
					
					debugLog(`Agent API: Sent slash command request: ${slashCommand}`);
					return; // Response written when WebSocket returns
				}
				
				case 'activate_tab': {
					// Find and activate a browser tab by URL pattern, optionally reload it
					const activateUrl = request.params?.url;
					const activateReload = request.params?.reload || false;
					const activateWaitForLoad = request.params?.waitForLoad || false;
					const activateOpenIfNotFound = request.params?.openIfNotFound || false;
					
					if (!activateUrl) {
						throw new Error('Missing required param: url');
					}
					if (!serverRunning || !wss?.clients?.size) {
						throw new Error('Not connected to ServiceNow. Open browser helper tab first.');
					}
					
					const agentRequestIdActivate = `agent_${request.id}`;
					pendingAgentRequests.set(agentRequestIdActivate, {
						request,
						responsePath,
						instanceFolder
					});
					
					const activateRequest = {
						action: 'activateTab',
						agentRequestId: agentRequestIdActivate,
						url: activateUrl,
						reload: activateReload,
						waitForLoad: activateWaitForLoad,
						openIfNotFound: activateOpenIfNotFound
					};
					
					broadcastToHelperTab(activateRequest);
					
					debugLog(`Agent API: Sent activate tab request for ${activateUrl}`);
					return; // Response written when WebSocket returns
				}
				
				case 'switch_context': {
					// Switch ServiceNow context (update set, application, or domain)
					let switchType = request.params?.switchType; // 'updateset', 'application', or 'domain'
					const switchValue = request.params?.value || request.params?.sysId; // Support both 'value' and 'sysId' for backwards compat
					const switchReloadTab = request.params?.reloadTab !== false; // Default true
					const switchTabUrl = request.params?.tabUrl || 'https://*.service-now.com/*';
					
					// Map 'app' to 'application' for convenience
					if (switchType === 'app') {
						switchType = 'application';
					}
					
					const validSwitchTypes = ['updateset', 'application', 'domain'];
					if (!switchType || !validSwitchTypes.includes(switchType)) {
						throw new Error(`Missing or invalid switchType. Must be one of: ${validSwitchTypes.join(', ')}`);
					}
					if (!switchValue) {
						throw new Error('Missing required param: value (sys_id of update set/app/domain)');
					}
					if (!serverRunning || !wss?.clients?.size) {
						throw new Error('Not connected to ServiceNow. Open browser helper tab first.');
					}
					
					const instanceSettingsSwitch = eu.getInstanceSettings(path.basename(instanceFolder));
					if (!instanceSettingsSwitch?.url) {
						throw new Error('Instance settings not found');
					}
					
					const agentRequestIdSwitch = `agent_${request.id}`;
					pendingAgentRequests.set(agentRequestIdSwitch, {
						request,
						responsePath,
						instanceFolder
					});
					
					const switchRequest = {
						action: 'switchContext',
						agentRequestId: agentRequestIdSwitch,
						switchType: switchType,
						value: switchValue,
						reloadTab: switchReloadTab,
						tabUrl: switchTabUrl,
						instance: instanceSettingsSwitch
					};
					
					broadcastToHelperTab(switchRequest);
					
					debugLog(`Agent API: Sent switch context request - ${switchType}: ${switchValue}`);
					return; // Response written when WebSocket returns
				}
				
				case 'upload_attachment': {
					// Upload a file/image as an attachment to a ServiceNow record
					const attachTable = request.params?.table;
					const attachSysId = request.params?.sys_id;
					let attachFileName = request.params?.fileName;
					let attachImageData = request.params?.imageData; // Base64 encoded
					let attachContentType = request.params?.contentType;
					const attachFilePath = request.params?.filePath; // Alternative: read file from path
					
					if (!attachTable || !attachSysId) {
						throw new Error('Missing required params: table, sys_id');
					}
					
					// Support filePath as alternative to imageData
					if (attachFilePath && !attachImageData) {
						// Resolve path: support absolute or relative to instance folder
						const resolvedPath = path.isAbsolute(attachFilePath) 
							? path.resolve(attachFilePath)
							: path.resolve(instanceFolder, attachFilePath);
						
						// Security: Ensure file is within workspace
						const workspaceRoot = vscode.workspace.rootPath || '';
						if (!resolvedPath.startsWith(workspaceRoot)) {
							throw new Error('Security: File path outside workspace not allowed');
						}
						
						if (!fs.existsSync(resolvedPath)) {
							throw new Error(`File not found: ${resolvedPath}`);
						}
						
						// Read file and encode to base64
						attachImageData = fs.readFileSync(resolvedPath, 'base64');
						
						// Auto-detect fileName from path if not provided
						if (!attachFileName) {
							attachFileName = path.basename(resolvedPath);
						}
						
						// Auto-detect contentType based on extension if not provided
						if (!attachContentType) {
							const ext = path.extname(resolvedPath).toLowerCase();
							const mimeTypes: Record<string, string> = {
								'.png': 'image/png',
								'.jpg': 'image/jpeg',
								'.jpeg': 'image/jpeg',
								'.gif': 'image/gif',
								'.webp': 'image/webp',
								'.svg': 'image/svg+xml',
								'.pdf': 'application/pdf',
								'.txt': 'text/plain',
								'.json': 'application/json',
								'.xml': 'application/xml',
								'.html': 'text/html',
								'.css': 'text/css',
								'.js': 'application/javascript',
								'.zip': 'application/zip',
								'.doc': 'application/msword',
								'.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
								'.xls': 'application/vnd.ms-excel',
								'.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
							};
							attachContentType = mimeTypes[ext] || 'application/octet-stream';
						}
						
						debugLog(`Agent API: Read file from ${resolvedPath} (${attachContentType})`);
					}
					
					// Set default content type if still not set
					if (!attachContentType) {
						attachContentType = 'image/png';
					}
					
					if (!attachFileName) {
						throw new Error('Missing required param: fileName (or provide filePath)');
					}
					if (!attachImageData) {
						throw new Error('Missing required param: imageData (base64) or filePath');
					}
					if (!serverRunning || !wss?.clients?.size) {
						throw new Error('Not connected to ServiceNow. Open browser helper tab first.');
					}
					
					const instanceSettingsAttach = eu.getInstanceSettings(path.basename(instanceFolder));
					if (!instanceSettingsAttach?.url) {
						throw new Error('Instance settings not found');
					}
					
					const agentRequestIdAttach = `agent_${request.id}`;
					pendingAgentRequests.set(agentRequestIdAttach, {
						request,
						responsePath,
						instanceFolder
					});
					
					const attachmentRequest = {
						action: 'uploadAttachment',
						agentRequestId: agentRequestIdAttach,
						tableName: attachTable,
						recordSysId: attachSysId,
						fileName: attachFileName,
						imageData: attachImageData,
						contentType: attachContentType,
						instance: instanceSettingsAttach
					};
					
					broadcastToHelperTab(attachmentRequest);
					
					debugLog(`Agent API: Sent upload attachment request for ${attachFileName} to ${attachTable}/${attachSysId}`);
					return; // Response written when WebSocket returns
				}
				
				case 'create_artifact': {
					// Create a new artifact directly via payload (no file creation needed)
					// This allows AI agents to create artifacts immediately without the file system
					const createTable = request.params?.table;
					const createScope = request.params?.scope || 'global';
					const createFields = request.params?.fields; // Object with field:value pairs
					
					if (!createTable) {
						throw new Error('Missing required param: table');
					}
					if (!createFields || typeof createFields !== 'object') {
						throw new Error('Missing required param: fields (object with field:value pairs)');
					}
					if (!createFields.name) {
						throw new Error('Missing required field: name');
					}
					if (!serverRunning || !wss?.clients?.size) {
						throw new Error('Not connected to ServiceNow. Open browser helper tab first.');
					}
					
					const instanceSettings4 = eu.getInstanceSettings(path.basename(instanceFolder));
					if (!instanceSettings4?.url) {
						throw new Error('Instance settings not found');
					}
					
					// Get scope sys_id from scopes.json
					const scopesPath = path.join(instanceFolder, 'scopes.json');
					let scopeSysId = createScope;
					if (createScope !== 'global' && fs.existsSync(scopesPath)) {
						const scopes = JSON.parse(fs.readFileSync(scopesPath, 'utf8'));
						if (scopes[createScope]) {
							scopeSysId = scopes[createScope];
						}
					}
					
					const agentRequestId4 = `agent_${request.id}`;
					pendingAgentRequests.set(agentRequestId4, {
						request,
						responsePath,
						instanceFolder
					});
					
					// Build the record payload
					const recordPayload: any = {
						...createFields,
						sys_scope: scopeSysId
					};
					
					const createRequest = {
						action: 'createRecord',
						agentRequestId: agentRequestId4,
						tableName: createTable,
						instance: instanceSettings4,
						scope: scopeSysId,
						payload: recordPayload
					};
					
					broadcastToHelperTab(createRequest);
					
					debugLog(`Agent API: Sent create request for ${createFields.name} in ${createTable}`);
					return; // Response written when WebSocket returns
				}
					
				default:
					response.status = 'error';
					response.error = `Unknown command: ${request.command}`;
			}
		} catch (err: any) {
			response.status = 'error';
			response.error = err.message;
		}
		
		// Write response (for local commands only - remote commands return early)
		fs.writeFileSync(responsePath, JSON.stringify(response, null, 2));
		debugLog(`Agent API Response written: ${response.status}`);
		
		// Log request to _requests.log
		logAgentRequest(instanceFolder, request, response);
		// Note: Request file is NOT deleted - agent is responsible for cleanup (Option B)
		
	} catch (err: any) {
		debugLog(`Agent API error: ${err.message}`);
	}
}

// Log completed Agent API requests
function logAgentRequest(instanceFolder: string, request: AgentRequest, response: AgentResponse) {
	try {
		const logPath = path.join(instanceFolder, '_requests.log');
		const timestamp = new Date().toISOString();
		const logEntry = `[${timestamp}] ${request.command} (id: ${request.id}) - ${response.status}${response.error ? ': ' + response.error : ''}\n`;
		fs.appendFileSync(logPath, logEntry);
	} catch (e) {
		// Silently ignore if we can't write to log file
		console.log(`[sn-scriptsync] Agent API: ${request.command} - ${response.status}`);
	}
}

// Agent API handler for get_parent_options response
function handleAgentParentOptionsResponse(responseJson: any) {
	const agentRequestId = responseJson.agentRequestId;
	const pending = pendingAgentRequests.get(agentRequestId);
	
	if (!pending) {
		debugLog(`Agent API: No pending request found for ${agentRequestId}`);
		return;
	}
	
	pendingAgentRequests.delete(agentRequestId);
	
	const response: AgentResponse = {
		id: pending.request.id,
		command: pending.request.command,
		status: responseJson.error ? 'error' : 'success',
		timestamp: Date.now()
	};
	
	if (responseJson.error) {
		response.error = responseJson.error;
	} else {
		// Transform the results into a more usable format
		const records = responseJson.result || [];
		const nameField = responseJson.nameField || 'name';
		response.result = {
			table: responseJson.tableName,
			count: records.length,
			options: records.map((r: any) => ({
				sys_id: r.sys_id,
				name: r[nameField] || r.name || r.sys_id,
				scope: r.sys_scope?.value || r.sys_scope || 'global'
			}))
		};
	}
	
	fs.writeFileSync(pending.responsePath, JSON.stringify(response, null, 2));
	debugLog(`Agent API: Parent options response written for ${pending.request.params?.table}`);
	
	// Log and clear request file
	logAgentRequest(pending.instanceFolder, pending.request, response);
	const requestPath = path.join(pending.instanceFolder, '_requests.json');
	fs.writeFileSync(requestPath, '{}');
}

// Agent API handler for query_records response
function handleAgentQueryRecordsResponse(responseJson: any) {
	const agentRequestId = responseJson.agentRequestId;
	const pending = pendingAgentRequests.get(agentRequestId);
	
	if (!pending) {
		debugLog(`Agent API: No pending request found for ${agentRequestId}`);
		return;
	}
	
	pendingAgentRequests.delete(agentRequestId);
	
	const response: AgentResponse = {
		id: pending.request.id,
		command: pending.request.command,
		status: responseJson.success ? 'success' : 'error',
		timestamp: Date.now()
	};
	
	if (responseJson.error) {
		response.error = responseJson.error;
	} else {
		response.result = {
			table: responseJson.tableName,
			count: responseJson.count,
			records: responseJson.records
		};
	}
	
	try {
		fs.writeFileSync(pending.responsePath, JSON.stringify(response, null, 2));
		debugLog(`Agent API: Query response written with ${responseJson.count} records`);
	} catch (e) {
		console.log(`[sn-scriptsync] Error writing query response: ${e}`);
	}
	
	// Log and clear request file
	logAgentRequest(pending.instanceFolder, pending.request, response);
	try {
		const requestPath = path.join(pending.instanceFolder, '_requests.json');
		fs.writeFileSync(requestPath, '{}');
	} catch (e) {
		// Ignore
	}
}

// Handle screenshot response from browser
function handleScreenshotResponse(responseJson: any) {
	// Check if this is for an Agent API request
	const agentRequestId = responseJson.agentRequestId;
	const isAgentRequest = agentRequestId && pendingAgentRequests.has(agentRequestId);
	
	if (responseJson.error) {
		if (isAgentRequest) {
			const pending = pendingAgentRequests.get(agentRequestId)!;
			pendingAgentRequests.delete(agentRequestId);
			
			const response: AgentResponse = {
				id: pending.request.id,
				command: pending.request.command,
				status: 'error',
				error: responseJson.error,
				timestamp: Date.now()
			};
			
			fs.writeFileSync(pending.responsePath, JSON.stringify(response, null, 2));
			logAgentRequest(pending.instanceFolder, pending.request, response);
			debugLog(`Agent API: Screenshot failed - ${responseJson.error}`);
		} else {
			vscode.window.showErrorMessage(`Screenshot failed: ${responseJson.error}`);
		}
		return;
	}

	if (!responseJson.imageData) {
		const errorMsg = 'No image data received';
		if (isAgentRequest) {
			const pending = pendingAgentRequests.get(agentRequestId)!;
			pendingAgentRequests.delete(agentRequestId);
			
			const response: AgentResponse = {
				id: pending.request.id,
				command: pending.request.command,
				status: 'error',
				error: errorMsg,
				timestamp: Date.now()
			};
			
			fs.writeFileSync(pending.responsePath, JSON.stringify(response, null, 2));
			logAgentRequest(pending.instanceFolder, pending.request, response);
			debugLog(`Agent API: Screenshot failed - ${errorMsg}`);
		} else {
			vscode.window.showErrorMessage(`Screenshot failed: ${errorMsg}`);
		}
		return;
	}

	try {
		const workspacePath = workspace.rootPath;
		if (!workspacePath) {
			throw new Error('No workspace folder open');
		}

		// Create screenshots folder if it doesn't exist
		const screenshotsFolder = path.join(workspacePath, 'screenshots');
		if (!fs.existsSync(screenshotsFolder)) {
			fs.mkdirSync(screenshotsFolder, { recursive: true });
		}

		// Generate filename with timestamp
		const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
		const fileName = responseJson.fileName || `screenshot_${timestamp}.png`;
		const filePath = path.join(screenshotsFolder, fileName);

		// Decode base64 image data and save
		const imageBuffer = Buffer.from(responseJson.imageData, 'base64');
		fs.writeFileSync(filePath, new Uint8Array(imageBuffer));

		debugLog(`Screenshot saved to ${filePath}`);

		// Handle Agent API response
		if (isAgentRequest) {
			const pending = pendingAgentRequests.get(agentRequestId)!;
			pendingAgentRequests.delete(agentRequestId);
			
			const response: AgentResponse = {
				id: pending.request.id,
				command: pending.request.command,
				status: 'success',
				timestamp: Date.now(),
				result: {
					saved: true,
					filePath: filePath,
					fileName: fileName,
					url: responseJson.url || pending.request.params?.url,
					tabTitle: responseJson.tabTitle
				}
			};
			
			fs.writeFileSync(pending.responsePath, JSON.stringify(response, null, 2));
			logAgentRequest(pending.instanceFolder, pending.request, response);
			debugLog(`Agent API: Screenshot saved to ${filePath}`);
		} else {
			// Show success message with option to open (only for manual command)
			vscode.window.showInformationMessage(
				`Screenshot saved: ${fileName}`,
				'Open File',
				'Open Folder'
			).then(selection => {
				if (selection === 'Open File') {
					vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath));
				} else if (selection === 'Open Folder') {
					vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(filePath));
				}
			});
		}
	} catch (e: any) {
		if (isAgentRequest) {
			const pending = pendingAgentRequests.get(agentRequestId)!;
			pendingAgentRequests.delete(agentRequestId);
			
			const response: AgentResponse = {
				id: pending.request.id,
				command: pending.request.command,
				status: 'error',
				error: e.message || String(e),
				timestamp: Date.now()
			};
			
			fs.writeFileSync(pending.responsePath, JSON.stringify(response, null, 2));
			logAgentRequest(pending.instanceFolder, pending.request, response);
			debugLog(`Agent API: Screenshot save error - ${e}`);
		} else {
			vscode.window.showErrorMessage(`Failed to save screenshot: ${e}`);
			debugLog(`Screenshot save error: ${e}`);
		}
	}
}

// Handle upload attachment response from browser
function handleUploadAttachmentResponse(responseJson: any) {
	const agentRequestId = responseJson.agentRequestId;
	
	if (!agentRequestId || !pendingAgentRequests.has(agentRequestId)) {
		// Not an Agent API request, just log it
		if (responseJson.success) {
			vscode.window.showInformationMessage(`Attachment uploaded: ${responseJson.fileName}`);
		} else {
			vscode.window.showErrorMessage(`Attachment upload failed: ${responseJson.error}`);
		}
		return;
	}
	
	const pending = pendingAgentRequests.get(agentRequestId)!;
	pendingAgentRequests.delete(agentRequestId);
	
	let response: AgentResponse;
	
	if (responseJson.success) {
		response = {
			id: pending.request.id,
			command: pending.request.command,
			status: 'success',
			timestamp: Date.now(),
			result: {
				uploaded: true,
				fileName: responseJson.fileName,
				table: responseJson.tableName,
				recordSysId: responseJson.recordSysId,
				attachment: responseJson.attachment // Contains sys_id, size_bytes, etc.
			}
		};
		debugLog(`Agent API: Attachment uploaded - ${responseJson.fileName} to ${responseJson.tableName}/${responseJson.recordSysId}`);
	} else {
		response = {
			id: pending.request.id,
			command: pending.request.command,
			status: 'error',
			error: responseJson.error || 'Upload failed',
			timestamp: Date.now()
		};
		debugLog(`Agent API: Attachment upload failed - ${responseJson.error}`);
	}
	
	fs.writeFileSync(pending.responsePath, JSON.stringify(response, null, 2));
	logAgentRequest(pending.instanceFolder, pending.request, response);
}

// Handle activate tab response from browser
function handleActivateTabResponse(responseJson: any) {
	const agentRequestId = responseJson.agentRequestId;
	
	if (!agentRequestId || !pendingAgentRequests.has(agentRequestId)) {
		// Not an Agent API request, just log it
		if (responseJson.success) {
			debugLog(`Tab activated: ${responseJson.url}`);
		} else {
			debugLog(`Tab activation failed: ${responseJson.error}`);
		}
		return;
	}
	
	const pending = pendingAgentRequests.get(agentRequestId)!;
	pendingAgentRequests.delete(agentRequestId);
	
	let response: AgentResponse;
	
	if (responseJson.success) {
		response = {
			id: pending.request.id,
			command: pending.request.command,
			status: 'success',
			timestamp: Date.now(),
			result: {
				activated: true,
				tabId: responseJson.tabId,
				url: responseJson.url,
				title: responseJson.title,
				opened: responseJson.opened || false, // true if a new tab was opened
				reloaded: responseJson.reloaded || false
			}
		};
		debugLog(`Agent API: Tab activated - ${responseJson.url}`);
	} else {
		response = {
			id: pending.request.id,
			command: pending.request.command,
			status: 'error',
			error: responseJson.error || 'Tab activation failed',
			timestamp: Date.now()
		};
		debugLog(`Agent API: Tab activation failed - ${responseJson.error}`);
	}
	
	fs.writeFileSync(pending.responsePath, JSON.stringify(response, null, 2));
	logAgentRequest(pending.instanceFolder, pending.request, response);
}

// Handle run slash command response from browser
function handleRunSlashCommandResponse(responseJson: any) {
	const agentRequestId = responseJson.agentRequestId;
	
	if (!agentRequestId || !pendingAgentRequests.has(agentRequestId)) {
		// Not an Agent API request, just log it
		if (responseJson.success) {
			debugLog(`Slash command executed: ${responseJson.command}`);
		} else {
			debugLog(`Slash command failed: ${responseJson.error}`);
		}
		return;
	}
	
	const pending = pendingAgentRequests.get(agentRequestId)!;
	pendingAgentRequests.delete(agentRequestId);
	
	let response: AgentResponse;
	
	if (responseJson.success) {
		response = {
			id: pending.request.id,
			command: pending.request.command,
			status: 'success',
			timestamp: Date.now(),
			result: {
				executed: true,
				slashCommand: responseJson.command,
				tabId: responseJson.tabId,
				autoRun: responseJson.autoRun
			}
		};
		debugLog(`Agent API: Slash command executed - ${responseJson.command}`);
	} else {
		response = {
			id: pending.request.id,
			command: pending.request.command,
			status: 'error',
			error: responseJson.error || 'Slash command failed',
			timestamp: Date.now()
		};
		debugLog(`Agent API: Slash command failed - ${responseJson.error}`);
	}
	
	fs.writeFileSync(pending.responsePath, JSON.stringify(response, null, 2));
	logAgentRequest(pending.instanceFolder, pending.request, response);
}

// Handle switch context response from browser
function handleSwitchContextResponse(responseJson: any) {
	const agentRequestId = responseJson.agentRequestId;
	
	if (!agentRequestId || !pendingAgentRequests.has(agentRequestId)) {
		// Not an Agent API request, just log it
		if (responseJson.success) {
			debugLog(`Context switched: ${responseJson.switchType} -> ${responseJson.value}`);
		} else {
			debugLog(`Context switch failed: ${responseJson.error}`);
		}
		return;
	}
	
	const pending = pendingAgentRequests.get(agentRequestId)!;
	pendingAgentRequests.delete(agentRequestId);
	
	let response: AgentResponse;
	
	if (responseJson.success) {
		response = {
			id: pending.request.id,
			command: pending.request.command,
			status: 'success',
			timestamp: Date.now(),
			result: {
				success: true,
				switchType: responseJson.switchType,
				value: responseJson.value,
				reloaded: responseJson.reloaded || false
			}
		};
		debugLog(`Agent API: Context switched - ${responseJson.switchType}: ${responseJson.value}`);
	} else {
		response = {
			id: pending.request.id,
			command: pending.request.command,
			status: 'error',
			error: responseJson.error || 'Context switch failed',
			timestamp: Date.now()
		};
		debugLog(`Agent API: Context switch failed - ${responseJson.error}`);
	}
	
	fs.writeFileSync(pending.responsePath, JSON.stringify(response, null, 2));
	logAgentRequest(pending.instanceFolder, pending.request, response);
}

// Relay errors to Agent API by writing to _last_error.json
function relayErrorToAgent(errorMessage: string, rawError?: any) {
	try {
		// Find instance folders in workspace and write error to each
		const workspaceRoot = vscode.workspace.rootPath || '';
		const folders = fs.readdirSync(workspaceRoot, { withFileTypes: true })
			.filter(d => d.isDirectory() && !d.name.startsWith('.'));
		
		for (const folder of folders) {
			const settingsPath = path.join(workspaceRoot, folder.name, '_settings.json');
			const oldSettingsPath = path.join(workspaceRoot, folder.name, 'settings.json');
			
			// Only write to instance folders (those with settings files)
			if (fs.existsSync(settingsPath) || fs.existsSync(oldSettingsPath)) {
				const errorPath = path.join(workspaceRoot, folder.name, '_last_error.json');
				const errorData = {
					timestamp: Date.now(),
					time: new Date().toISOString(),
					error: errorMessage,
					details: rawError?.error || null
				};
				fs.writeFileSync(errorPath, JSON.stringify(errorData, null, 2));
				debugLog(`Agent API: Error relayed to ${folder.name}/_last_error.json`);
				
				// Also fail any pending Agent requests for this instance
				const instanceFolder = path.join(workspaceRoot, folder.name);
				pendingAgentRequests.forEach((pending, requestId) => {
					if (pending.instanceFolder === instanceFolder) {
						const response: AgentResponse = {
							id: pending.request.id,
							command: pending.request.command,
							status: 'error',
							error: errorMessage,
							timestamp: Date.now()
						};
						fs.writeFileSync(pending.responsePath, JSON.stringify(response, null, 2));
						logAgentRequest(pending.instanceFolder, pending.request, response);
						const requestPath = path.join(pending.instanceFolder, '_requests.json');
						fs.writeFileSync(requestPath, '{}');
						pendingAgentRequests.delete(requestId);
						debugLog(`Agent API: Pending request ${requestId} failed with error`);
					}
				});
			}
		}
	} catch (e) {
		// Silently ignore errors in error relay
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
	
	// If monitoring is disabled, keep Agent API working by watching only agent request files.
	if (!monitorFileChanges) {
		watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(vscode.workspace.rootPath || '', '**/agent/requests/*.json')
		);

		watcher.onDidCreate(uri => {
			debugLog(`Agent API request file created: ${uri.fsPath}`);
			handleAgentRequest(uri.fsPath);
		});

		watcher.onDidChange(uri => {
			debugLog(`Agent API request file changed: ${uri.fsPath}`);
			handleAgentRequest(uri.fsPath);
		});
		return;
	}

	const DEBOUNCE_DELAY = debounceSeconds > 0 ? debounceSeconds * 1000 : 0;

		watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.workspace.rootPath || '', "**/*"));
		
		watcher.onDidCreate(uri => {
			const fileName = path.basename(uri.fsPath);
			if (fileName.endsWith('.json') && uri.fsPath.includes(`${path.sep}agent${path.sep}requests${path.sep}`)) {
				debugLog(`Agent API request file created: ${uri.fsPath}`);
				handleAgentRequest(uri.fsPath);
			}
		});
		
		watcher.onDidChange(uri => {
			const fileName = path.basename(uri.fsPath);
			
			// Ignore debug.log to prevent infinite loop
			if (fileName === 'debug.log') {
				return;
			}
			
			// Handle Agent API requests (fallback for file changes)
			if (fileName.endsWith('.json') && uri.fsPath.includes(`${path.sep}agent${path.sep}requests${path.sep}`)) {
				debugLog(`Agent API request file changed: ${uri.fsPath}`);
				handleAgentRequest(uri.fsPath);
				return;
			}
			
			// Ignore Agent API folders (already handled separately above)
			if (uri.fsPath.includes(`${path.sep}agent${path.sep}`)) {
				return;
			}
			
			// Ignore system/hidden files
			const ignoredFiles = ['.DS_Store', '.gitignore', '.git', 'Thumbs.db', '.env', '.vscode'];
			if (fileName.startsWith('.') || fileName.startsWith('_') || ignoredFiles.includes(fileName)) {
				return;
			}

			// Only queue files in instance folders (folders containing _settings.json)
			// Path structure: workspace/instance/table/file.js (minimum 3 levels)
			const relativePath = uri.fsPath.replace(vscode.workspace.rootPath || '', '');
			const pathParts = relativePath.split(path.sep).filter(p => p);
			
			// Must be at least: instance/table/file (3 parts minimum)
			// Files directly in instance folder should be ignored
			if (pathParts.length < 3) {
				return; // Not in a table folder
			}
			
			const instanceFolder = path.join(vscode.workspace.rootPath || '', pathParts[0]);
			const settingsPath = path.join(instanceFolder, '_settings.json');
			const oldSettingsPath = path.join(instanceFolder, 'settings.json');
			const hasSettings = fs.existsSync(settingsPath) || fs.existsSync(oldSettingsPath);
			
			if (!hasSettings) {
				return; // Not a synced instance folder
			}

			// Ignore if this is a result of our own write
			if (ExtensionUtils.ignoreNextSync.has(uri.fsPath)) {
				ExtensionUtils.ignoreNextSync.delete(uri.fsPath);
				return;
			}

			// Ignore if this file was manually saved recently (within 2 seconds)
			const lastManualSave = recentManualSaves.get(uri.fsPath);
			if (lastManualSave && (Date.now() - lastManualSave < 2000)) {
				return;
			}

			// Check if this is a NEW artifact (no sys_id) - execute immediately, don't queue
			// This allows AI agents to create artifacts without waiting for the debounce timer
			const scriptObj = eu.fileNameToObject(uri.fsPath);
			if (scriptObj !== true && !scriptObj.sys_id && scriptObj.tableName && scriptObj.fieldName) {
				saveFieldsToServiceNow(uri.fsPath, false);
				return;
			}

			// Add to pending set (for updates only)
			pendingFiles.add(uri.fsPath);

			// Monitor-only: update queue/badge but don't schedule auto sync.
			if (debounceSeconds <= 0) {
				queueProvider.updateQueue(pendingFiles, 0);
				return;
			}

			// If paused, do not schedule auto-sync; just refresh UI.
			if (queueProvider?.isPaused) {
				queueProvider.updateQueue(pendingFiles, DEBOUNCE_DELAY);
				return;
			}

			// Reset global timer
			if (globalDebounceTimer) {
				clearTimeout(globalDebounceTimer);
			}

			globalDebounceTimer = setTimeout(() => {
				processPendingFiles();
			}, DEBOUNCE_DELAY);

			// Update UI
			queueProvider.updateQueue(pendingFiles, DEBOUNCE_DELAY);
		});
}

// Listen for the "will save" event and mark the document if the reason was manual.
vscode.workspace.onWillSaveTextDocument((event) => {
	if (event.reason === vscode.TextDocumentSaveReason.Manual) {
		manualSaveMap.set(event.document.uri.toString(), true);
	}
});

// In the did-save handler, only process files that were flagged as manually saved. #105
vscode.workspace.onDidSaveTextDocument(document => {
	// Manual saves should always sync immediately, regardless of debounce setting
	if (manualSaveMap.get(document.uri.toString())) {
		manualSaveMap.delete(document.uri.toString());
		
		const settings = vscode.workspace.getConfiguration('sn-scriptsync');
		const debounceSeconds = (settings.get('externalChanges.syncDelay') as number) ?? 0;
		
		// If external sync is ON, remove this file from the pending queue
		// since we're saving it NOW (instant manual save)
			if (debounceSeconds !== 0) {
			pendingFiles.delete(document.fileName);
			queueProvider?.removeFromQueue(document.fileName);
		}

		recentManualSaves.set(document.fileName, Date.now());

		if (!saveFieldsToServiceNow(document, true)) {
			markFileAsDirty(document);
		}
	}
});

export function activate(context: vscode.ExtensionContext) {

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

export function deactivate() { }


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

	// Copy AI agent instructions
	let agentRulesSourceDir = path.join(__filename, '..', '..', 'agentrules') + nodePath.sep;
	let workspaceRoot = path.join(workspace.rootPath, '') + nodePath.sep;
	eu.copyFileIfNotExists(agentRulesSourceDir + 'agentinstructions.md', workspaceRoot + 'agentinstructions.md', function () { });

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
				if (messageJson.hasOwnProperty('error')) {
					let errorDetail = '';
					if (messageJson.error?.detail){
						if (messageJson.error.detail.includes("ACL"))
							errorDetail = "ACL Error, try changing scope in the browser";
						else if (messageJson.error.detail.includes("Required to provide Auth information"))
							errorDetail = "Could not sync file, no valid token. Try typing the slashcommand /token in a active browser session and retry.";
						else
							errorDetail = messageJson.error.detail;
					} 
					else {
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
				if (messageJson.actionGoal == 'getCurrent') {
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
		ws.send(JSON.stringify({ action : 'bannerMessage', message : '2025-12-06 Added support for syncing external changes (AI Agents). Enable via settings (syncDelay > 0)!', class: 'alert alert-primary' }), function () { });

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
	// Check if this is for an Agent API request
	const agentRequestId = responseJson.agentRequestId;
	if (agentRequestId && pendingAgentRequests.has(agentRequestId)) {
		const pending = pendingAgentRequests.get(agentRequestId)!;
		pendingAgentRequests.delete(agentRequestId);
		
		const response: AgentResponse = {
			id: pending.request.id,
			command: pending.request.command,
			status: responseJson.success ? 'success' : 'error',
			timestamp: Date.now()
		};
		
		if (responseJson.success) {
			response.result = {
				sys_id: responseJson.newRecord.sys_id,
				name: responseJson.newRecord.name,
				table: responseJson.newRecord.tableName,
				scope: responseJson.newRecord.scope
			};
			
			// Update _map.json for the new artifact
			const scopeName = pending.request.params?.scope || 'global';
			const tableName = pending.request.params?.table;
			const artifactName = pending.request.params?.fields?.name;
			
			if (tableName && artifactName) {
				const mapPath = path.join(pending.instanceFolder, scopeName, tableName, '_map.json');
				const nameToSysId = eu.writeOrReadNameToSysIdMapping(mapPath);
				const cleanName = artifactName.replace(/[^a-z0-9\._\-+]+/gi, '').replace(/\./g, '-');
				nameToSysId[cleanName] = responseJson.newRecord.sys_id;
				eu.writeOrReadNameToSysIdMapping(mapPath, nameToSysId);
				debugLog(`Agent API: Updated _map.json with ${cleanName} -> ${responseJson.newRecord.sys_id}`);
			}
		} else {
			response.error = responseJson.error || 'Unknown error creating artifact';
		}
		
		fs.writeFileSync(pending.responsePath, JSON.stringify(response, null, 2));
		debugLog(`Agent API: Create artifact response written for ${pending.request.params?.fields?.name}`);
		
		// Log and clear request file
		logAgentRequest(pending.instanceFolder, pending.request, response);
		const requestPath = path.join(pending.instanceFolder, '_requests.json');
		fs.writeFileSync(requestPath, '{}');
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

	if (!serverRunning) return;

	// Get file name to check for internal files
	const filePath = typeof documentOrPath === 'string' ? documentOrPath : documentOrPath.fileName;
	const fileName = path.basename(filePath);
	
	// Skip Agent API folders (communication files, not for sync)
	if (filePath.includes(`${path.sep}agent${path.sep}`)) {
		return true;
	}
	
	// Skip system/hidden files
	const ignoredFiles = ['.DS_Store', 'Thumbs.db', '.env'];
	if (fileName.startsWith('.') || fileName.startsWith('_') || ignoredFiles.includes(fileName)) {
		return true;
	}

	let scriptObj = eu.fileNameToObject(documentOrPath);

	if (scriptObj.fieldName == '_test_urls') return true; //helper file, dont save to instance
	if (!serverRunning) return true; 

	// Handle new artifacts that have no sys_id yet - create them in ServiceNow
	if (!scriptObj.sys_id) {
		if (scriptObj.tableName && scriptObj.fieldName) {
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

		if (!wss.clients.size) {
			vscode.window.showErrorMessage("No WebSocket connection. Please open SN Utils helper tab in a browser via slashcommand /token");
			success = false;
		}
		broadcastToHelperTab(scriptObj);

	}
	catch (err) {
		vscode.window.showErrorMessage("Error while saving file: " + JSON.stringify(err, null, 4));
		success = false;
	}

	return success;
}


function saveFieldAsFile(postedJson, retry = 0) {

	
	let basePath = workspace.rootPath + nodePath.sep + postedJson.instance.name + nodePath.sep;
	
	let scope:string;
	if (postedJson.scope == 'global') 
		scope = 'global';
	else if (postedJson.scope == '' || !postedJson.hasOwnProperty('scope'))  //sync a none metadata file
		scope = 'no_scope';
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
	// If this file was synced before, use whatever name is in the _map.json
	cleanName = Object.keys(nameToSysId).find(fileName => nameToSysId[fileName] === postedJson.sys_id) ?? cleanName
	if (nameToSysId[cleanName] && nameToSysId[cleanName] != postedJson.sys_id){
		cleanName = cleanName + ("-" + postedJson.sys_id.slice(0,2) + postedJson.sys_id.slice(-2)).toUpperCase(); //if mapping already exist add first and last 2 chars of the syid to the filename
	}


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
	
	scriptObj.saveSource = "FileWatcher";
	
	if (!wss.clients.size) {
		vscode.window.showErrorMessage("No WebSocket connection. Please open SN Utils helper tab in a browser via slashcommand /token");
		return;
	}
	
	broadcastToHelperTab(scriptObj);
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
	// Check if this is for an Agent API request
	const agentRequestId = responseJson.agentRequestId;
	if (agentRequestId && pendingAgentRequests.has(agentRequestId)) {
		const pending = pendingAgentRequests.get(agentRequestId)!;
		pendingAgentRequests.delete(agentRequestId);
		
		const response: AgentResponse = {
			id: pending.request.id,
			command: pending.request.command,
			status: responseJson.error ? 'error' : 'success',
			timestamp: Date.now()
		};
		
		if (responseJson.error) {
			response.error = responseJson.error;
		} else {
			response.result = { columns: responseJson.result?.columns || responseJson.result };
		}
		
		fs.writeFileSync(pending.responsePath, JSON.stringify(response, null, 2));
		debugLog(`Agent API: Table metadata response written for ${pending.request.params?.table}`);
		
		// Log and clear request file
		logAgentRequest(pending.instanceFolder, pending.request, response);
		const requestPath = path.join(pending.instanceFolder, '_requests.json');
		fs.writeFileSync(requestPath, '{}');
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

	if (wss.clients.size === 0) {
		vscode.window.showErrorMessage("No WebSocket connection. Cannot create new artifact.");
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
	
	broadcastToHelperTab(checkRequest);
}

function handleCheckNameExistsResponse(responseJson: any) {
	// Check if this is for an Agent API request
	const agentRequestId = responseJson.agentRequestId;
	if (agentRequestId && pendingAgentRequests.has(agentRequestId)) {
		const pending = pendingAgentRequests.get(agentRequestId)!;
		pendingAgentRequests.delete(agentRequestId);
		
		const response: AgentResponse = {
			id: pending.request.id,
			command: pending.request.command,
			status: responseJson.error ? 'error' : 'success',
			timestamp: Date.now()
		};
		
		if (responseJson.error) {
			response.error = responseJson.error;
		} else {
			response.result = {
				exists: responseJson.exists,
				sysId: responseJson.existingRecord?.sys_id || null,
				record: responseJson.existingRecord || null
			};
		}
		
		fs.writeFileSync(pending.responsePath, JSON.stringify(response, null, 2));
		debugLog(`Agent API: Check name exists response written for ${pending.request.params?.name}`);
		
		// Log and clear request file
		logAgentRequest(pending.instanceFolder, pending.request, response);
		const requestPath = path.join(pending.instanceFolder, '_requests.json');
		fs.writeFileSync(requestPath, '{}');
		return;
	}
	
	// Original logic for artifact creation flow
	const creationKey = responseJson.originalRequest?.creationKey;
	
	if (!creationKey || !pendingCreations.has(creationKey)) {
		console.error("No pending creation found for key:", creationKey);
		return;
	}

	const scriptObj = pendingCreations.get(creationKey);
	pendingCreations.delete(creationKey);

	if (!responseJson.success) {
		vscode.window.showErrorMessage(`Error checking name: ${responseJson.error}`);
		return;
	}

	if (responseJson.exists) {
		vscode.window.showErrorMessage(
			`Artifact "${scriptObj.name}" already exists in ServiceNow (sys_id: ${responseJson.existingRecord?.sys_id}). Use a different name.`
		);
		return;
	}

	// Name is available, proceed with creation
	proceedWithArtifactCreation(scriptObj);
}

function proceedWithArtifactCreation(scriptObj: any) {
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
	vscode.window.showInformationMessage(`Creating new ${scriptObj.tableName}: ${scriptObj.name}`);
}

async function createArtifact(artifact: any) {
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
