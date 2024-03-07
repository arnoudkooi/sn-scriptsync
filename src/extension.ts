import { window, workspace, commands, Disposable, ExtensionContext, StatusBarAlignment, StatusBarItem, TextDocument } from 'vscode';

import * as WebSocket from 'ws';
import * as vscode from 'vscode';
import { ScopeTreeViewProvider } from "./ScopeTreeViewProvider";
import { InfoTreeViewProvider } from "./InfoTreeViewProvider";
import { ExtensionUtils } from "./ExtensionUtils";
import { Constants } from "./constants";
import * as path from "path";
import nodePath = require('path');
import * as fs from 'fs';
import * as he from 'he';



let sass = require('sass');
let metaDataRelations : any;
let scopeTableResponseCount = 0;
let scopeJson : any = {};

let wss;
let serverRunning = false;
//let openFiles = {};

let scriptSyncStatusBarItem: vscode.StatusBarItem;
let eu = new ExtensionUtils();

let lastSave = Math.floor(+new Date() / 1000); 

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
	let refresh: number = settings.get('refresh');
	refresh = Math.max(refresh, 30);
	syncDir = syncDir.replace('~', '');	
	if (nodePath.sep == "\\"){ //reverse slash when windows.
		syncDir = syncDir.replace(/\//g,'\\');
	}
	
	if (typeof workspace.rootPath == 'undefined') {
		//
	}
	else if (vscode.workspace.rootPath.endsWith(syncDir)) {
		startServers();

	}


	// let handle = setInterval(() => { //todo auto check for changes

	// 	let fileMeta = openFiles[window.activeTextEditor.document.fileName];
	// 	let currentTime = new Date().getTime()
	// 	if (fileMeta) {
	// 		if (currentTime - fileMeta.refreshed > (refresh * 1000)) {
	// 			let req = eu.fileNameToObject(window.activeTextEditor.document.fileName);
	// 			req.action = 'requestRecord';
	// 			req.actionGoal = 'updateCheck';
	// 			req.sys_id = req.sys_id + "?sysparm_query=sys_updated_on>" + fileMeta.sys_updated_on +
	// 				"&sysparm_fields=name,sys_updated_on,sys_updated_by,sys_scope.scope," + req.fieldName;
	// 			requestRecords(req);

	// 			openFiles[window.activeTextEditor.document.fileName].refreshed = currentTime;
	// 		}
	// 	}
	// 	else {
	// 		let fileMeta = {
	// 			"opened": currentTime,
	// 			"refreshed": currentTime,
	// 			"sys_updated_by": "",
	// 			"sys_updated_on": "",
	// 			"original_content": window.activeTextEditor.document.getText(),
	// 			"scope": ""
	// 		}
	// 		openFiles[window.activeTextEditor.document.fileName] = fileMeta;
	// 	}

	// }, 1000);

	vscode.commands.registerCommand('extension.snScriptSyncDisable', () => {
		stopServers();
	});

	vscode.commands.registerCommand('extension.snScriptSyncEnable', () => {
		startServers();
	});

	vscode.commands.registerCommand('extension.bgScriptMirror', () => {
		selectionToBG();
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


	vscode.workspace.onDidSaveTextDocument(listener => {
		if (!saveFieldsToServiceNow(listener, true)) {
			//if (listener.fileName.includes("^"))//only sn files
				markFileAsDirty(listener);
		}
	});

	vscode.workspace.onDidChangeConfiguration(event => {
		settings = vscode.workspace.getConfiguration('sn-scriptsync');
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
				wss.clients.forEach(function each(client) {
					if (client.readyState === WebSocket.OPEN) {
						client.send(JSON.stringify(scriptObj));
					}
				});
			}
		}
		else if (listener.document.fileName.includes(path.sep + 'background' + path.sep)) {
				if (!wss.clients.size) {
					vscode.window.showErrorMessage("No WebSocket connection. Please open SN ScriptSync in a browser");
				}

				let scriptObj = eu.fileNameToObject(listener.document);
				scriptObj.mirrorbgscript = true;
				wss.clients.forEach(function each(client) {
					if (client.readyState === WebSocket.OPEN) {
						client.send(JSON.stringify(scriptObj));
					}
				});

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

function writeResponseToTab(jsn: any) {
    const outputChannel = vscode.window.createOutputChannel('sn-scriptsync - Background');
    outputChannel.clear();
    outputChannel.appendLine(he.decode(jsn.response));
    outputChannel.show();
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


	let instance  = eu.getFileAsJson(path.join(basePath + "settings.json"));

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
			let messageJson = JSON.parse(message)
			if (messageJson.hasOwnProperty('error')) {
				if (messageJson.error.detail.includes("ACL"))
					messageJson.error.detail = "ACL Error, try changing scope in the browser";
				else if (messageJson.error.detail.includes("Required to provide Auth information"))
					messageJson.error.detail = "Could not sync file, no valid token. Try typing the slashcommand /token in a active browser session and retry.";


				vscode.window.showErrorMessage("Error while saving file: " + messageJson.error.detail);

				markFileAsDirty(window.activeTextEditor.document);
			}

			// start new methods to replace webserver with websocket
			if (messageJson?.instance) 
				eu.writeInstanceSettings(messageJson.instance);
			if (messageJson?.action == 'saveFieldAsFile')
				saveFieldAsFile(messageJson);
			else if (messageJson?.action == 'saveWidget')
				saveWidget(messageJson);
			else if (messageJson?.action == 'linkAppToVSCode')
				linkAppToVSCode(messageJson);
			else if (message.instance && !message?.action)
				refreshedToken(messageJson);
			// end new methods to replace webserver with websocket

			else if (messageJson.action == "requestAppMeta") {
				setScopeTreeView(messageJson);
			}
			else if (messageJson.action == "writeInstanceSettings") {
				eu.writeInstanceSettings(messageJson.instance);
			}
            else if (messageJson.action == "writeResponseToTab") {
                writeResponseToTab(messageJson);
            }
			else if (messageJson.hasOwnProperty('actionGoal')) {
				if (messageJson.actionGoal == 'updateCheck') {
					// todo track open files for auto refresh when changed

					// openFiles[messageJson.fileName].sys_updated_on = messageJson.result.sys_updated_on;
					// openFiles[messageJson.fileName].sys_updated_by = messageJson.result.sys_updated_by;
					// openFiles[messageJson.fileName].scope = messageJson.result['sys_scope.scope'];
					// openFiles[messageJson.fileName].content = messageJson.result[messageJson.fieldName];
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
		});

		//send immediatly a feedback to the incoming connection    
		ws.send('["Connected to VS Code ScriptScync WebSocket"]', function () { });
		ws.send(JSON.stringify({ action : 'bannerMessage', message : 'You are using the 3.0 version of sn-scriptsync! Files are now stored in a new structure. <a href="https://youtu.be/cpyasfe93kQ" target="_blank">[Intro Video]</a>', class: 'alert alert-primary' }), function () { });

	});
	updateScriptSyncStatusBarItem('Running');
	serverRunning = true;

	setScopeTree();
	const infoTreeViewProvider = new InfoTreeViewProvider();
	vscode.window.registerTreeDataProvider("infoTreeView", infoTreeViewProvider);

}

function stopServers() {
	wss.close();
	updateScriptSyncStatusBarItem('Stopped');
	serverRunning = false;
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
			scopeJson.scopeTree[cat].tables[messageJson.tableName].records[record.sys_id + ''].referenceFields[field] = record[field];
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
			"client_cript.js": { "content": postedJson.widget.client_script.value, "openFile": true },
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
				//todo
			}
			else {

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
	wss.clients.forEach(function each(client) {
		if (client.readyState === WebSocket.OPEN) {
			client.send(JSON.stringify(postedJson));
		}
	});
}


function saveRequestResponse(responseJson) {

	if (!responseJson.hasOwnProperty("results")) {
		console.log("responseJson does not have property results")
		//https://github.com/arnoudkooi/sn-scriptsync/issues/19
		//need to look in this further..
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
	wss.clients.forEach(function each(client) {
		if (client.readyState === WebSocket.OPEN && !postedJson.send) {
			client.send(JSON.stringify(postedJson));
			postedJson.send = true;
		}
	});
}



function requestRecords(requestJson) {
	if (!serverRunning) return;

	try {
		if (!wss.clients.size) {
			vscode.window.showErrorMessage("No WebSocket connection. Please open SN Utils helper tab in a browser via slashcommand /token");
		}
		wss.clients.forEach(function each(client) {
			if (client.readyState === WebSocket.OPEN) {
				client.send(JSON.stringify(requestJson));
			}
		});
	}
	catch (err) {
		vscode.window.showErrorMessage("Error requesting data: " + JSON.stringify(err, null, 4));
	}
}

function saveFieldsToServiceNow(fileName, fromVsCode:boolean): boolean {

	if (!serverRunning) return;

	let scriptObj = eu.fileNameToObject(fileName);

	if (scriptObj.fieldName == '_test_urls') return true; //helper file, dont save to instance
	if (!serverRunning || !scriptObj?.sys_id ) return true; //r server is off or this was not a recognized file (probably metadata)

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
		wss.clients.forEach(function each(client) {
			if (client.readyState === WebSocket.OPEN) {
				client.send(JSON.stringify(scriptObj));
			}
		});

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

	let fileName = fullPath + cleanName + separtorCharacter + req.fieldName + fileExtension;

	eu.writeFile(fileName, postedJson.content, true, function (err) {
		if (err) {
			err.response = {};
			err.response.result = {};
			err.send = false;
			wss.clients.forEach(function each(client) {
				if (client.readyState === WebSocket.OPEN && !err.send) {
					client.send(JSON.stringify(err));
					err.send = true;
				}
			});
		}
		else {
			postedJson.result = '';
			postedJson.contentLength = postedJson.content.length;
			postedJson.send = false;

			wss.clients.forEach(function each(client) {
				if (client.readyState === WebSocket.OPEN && !postedJson.send) {
					client.send(JSON.stringify(postedJson));
					postedJson.send = true;
				}
			});
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

async function selectionToBG() {

	if (!serverRunning) {
		vscode.window.showInformationMessage("sn-scriptsync server must be running")
		return;
	}

	var date = new Date();
	let my_id = ( date.getFullYear().toString() + pad2(date.getMonth() + 1) + pad2( date.getDate()) + '-' +  pad2( date.getHours() ) + pad2( date.getMinutes() ) + pad2( date.getSeconds() ) );


	let editor = vscode.window.activeTextEditor;
	let scriptObj = eu.fileNameToObject(editor.document);

	scriptObj.content = '// sn-scriptsync - Snippet received from: (delete file after usage.)\n// file://' + scriptObj.fileName + "\n\n" 
						 + String.raw`${editor.document.getText(editor.selection)}`;;
	scriptObj.field = 'bg';
	scriptObj.table = 'background'
	scriptObj.sys_id = my_id;
	scriptObj.fieldType = 'script';
	scriptObj.name = 'script'; 
	scriptObj.mirrorbgscript = true;

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
	scriptObj.mirrorbgscript = true;
	scriptObj.executeScript = true;
	wss.clients.forEach(function each(client) {
		if (client.readyState === WebSocket.OPEN) {
			client.send(JSON.stringify(scriptObj));
		}
	});

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