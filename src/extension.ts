import { window, workspace, commands, Disposable, ExtensionContext, StatusBarAlignment, StatusBarItem, TextDocument } from 'vscode';

import * as WebSocket from 'ws';
import * as vscode from 'vscode';
import { ScopeTreeViewProvider } from "./ScopeTreeViewProvider";
import { ExtensionUtils } from "./ExtensionUtils";
import * as path from "path";

let sass = require('sass');
let scriptFields;

const nodePath = require('path');

let wss;
let serverRunning = false;
let openFiles = {};

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



	vscode.workspace.onDidCloseTextDocument(listener => {
		delete openFiles[listener.fileName];
	});


	vscode.workspace.onDidSaveTextDocument(listener => {
		if (!saveFieldsToServiceNow(listener, true)) {
			if (listener.fileName.includes("^"))//only sn files
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
			scriptObj.sys_id = eu.getFileAsJson(filePath + nodePath.sep + "widget.json")['sys_id'];
			var scss = ".v" + scriptObj.sys_id + " { " + listener.document.getText() + " }";
			var cssObj = sass.renderSync({
				"data": scss,
				"outputStyle": "expanded"
			});

			var testUrls = eu.getFileAsArray(filePath + nodePath.sep + "test_urls.txt");
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
	if (!scriptFields)
		scriptFields = eu.getFileAsJson(path.join(__filename, '..', '..', 'resources', 'syncfields.json'));

	const scopeTreeViewProvider = new ScopeTreeViewProvider(jsn, scriptFields);
	vscode.window.registerTreeDataProvider("scopeTreeView", scopeTreeViewProvider);
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
	wss = new WebSocket.Server({ port: 1978 });
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
			else if (messageJson.hasOwnProperty('actionGoal')) {
				if (messageJson.actionGoal == 'updateCheck') {

					openFiles[messageJson.fileName].sys_updated_on = messageJson.result.sys_updated_on;
					openFiles[messageJson.fileName].sys_updated_by = messageJson.result.sys_updated_by;
					openFiles[messageJson.fileName].scope = messageJson.result['sys_scope.scope'];
					openFiles[messageJson.fileName].content = messageJson.result[messageJson.fieldName];
				}
				if (messageJson.actionGoal == 'getCurrent') {
					eu.writeFile(messageJson.fileName, messageJson.result[messageJson.fieldName], true, function () { });
				}
				if (messageJson.actionGoal == 'writeInstanceMetaData') {
					writeInstanceMetaData(messageJson);
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

	});
	updateScriptSyncStatusBarItem('Running');
	serverRunning = true;

}

function stopServers() {
	wss.close();
	updateScriptSyncStatusBarItem('Stopped');
	serverRunning = false;
}


function requestInstanceMetaData() {

	let editor = vscode.window.activeTextEditor;
	let scriptObj = eu.fileNameToObject(editor.document);

	if (scriptObj === true) return; //not a valid file 

	var filePath = workspace.rootPath + nodePath.sep + scriptObj.instance.name + nodePath.sep;

	//first request tablemnames
	let requestJson = <any>{};
	requestJson.action = 'requestRecords';
	requestJson.actionGoal = 'writeInstanceMetaData'
	requestJson.instance = scriptObj.instance;
	requestJson.filePath = filePath + 'tablenames.d.ts';
	requestJson.tableName = 'sys_db_object';
	requestJson.displayValueField = 'name';
	requestJson.queryString = 'sysparm_query=nameNOT LIKE00^sys_update_nameISNOTEMPTY^ORDERBYname&sysparm_fields=name';
	requestRecords(requestJson);

	//second properies
	requestJson.filePath = filePath + 'properties.d.ts';
	requestJson.tableName = 'sys_properties';
	requestJson.queryString = 'sysparm_query=ORDERBYname&sysparm_fields=name';
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

function saveWidget(postedJson) {
	//lastsend = 0;
	var cleanName = postedJson.name.replace(/[^a-z0-9 \.\-+]+/gi, '').replace(/\./g, '-').replace(/\s\s+/g, '_');
	var filePath = workspace.rootPath + nodePath.sep + postedJson.instance.name + nodePath.sep +
		postedJson.tableName + nodePath.sep + cleanName + nodePath.sep;

	var files = {};

	if (postedJson.widget.hasOwnProperty("option_schema")) { //sp_widget
		files = {
			"1 HTML Template.html": { "content": postedJson.widget.template.value, "openFile": true },
			"2 SCSS.scss": { "content": postedJson.widget.css.value, "openFile": true },
			"3 Client Script.js": { "content": postedJson.widget.client_script.value, "openFile": true },
			"4 Server Script.js": { "content": postedJson.widget.script.value, "openFile": true },
			"5 Link function.js": { "content": postedJson.widget.link.value, "openFile": false },
			"6 Option schema.json": { "content": postedJson.widget.option_schema.value, "openFile": false },
			"7 Demo data.json": { "content": postedJson.widget.demo_data.value, "openFile": false },
			"widget.json": { "content": JSON.stringify(postedJson, null, 4), "openFile": false },
		}
	}
	else { //sp_header_footer
		files = {
			"1 HTML Template.html": { "content": postedJson.widget.template.value, "openFile": true },
			"2 SCSS.scss": { "content": postedJson.widget.css.value, "openFile": true },
			"3 Client Script.js": { "content": postedJson.widget.client_script.value, "openFile": true },
			"4 Server Script.js": { "content": postedJson.widget.script.value, "openFile": true },
			"5 Link function.js": { "content": postedJson.widget.link.value, "openFile": false },
			"widget.json": { "content": JSON.stringify(postedJson, null, 4), "openFile": false },
		}
	}

	var contentLength = 0;
	for (var file in files) {
		if (file != "widget.json")
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
	eu.writeFileIfNotExists(filePath + "test_urls.txt", testUrls.join("\n"), false, function () { });

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
				result[responseJson.displayValueField].replace(/[^a-z0-9 \.\-+]+/gi, '').replace(/\./, '') + '^' + //strip non alpahanumeric, then replace dot
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
	req.appId = postedJson.appId;
	req.appName = postedJson.appName;
	req.appScope = postedJson.appScope;
	req.instance = postedJson.instance;
	requestRecords(req);

	wss.clients.forEach(function each(client) {
		if (client.readyState === WebSocket.OPEN && !postedJson.send) {
			client.send(JSON.stringify(postedJson));
			postedJson.send = true;
		}
	});
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
	if (!serverRunning || (!fileName.fileName.includes("^") && !fileName.fileName.includes("sp_widget"))  ) return;

	if (fromVsCode) lastSave = Math.floor(+new Date() / 1000);

	let success: boolean = true;
	try {
		let scriptObj = eu.fileNameToObject(fileName);
		scriptObj.saveSource = (fromVsCode) ? "VS Code" : "FileWatcher";
		if(scriptObj.tableName == 'background') return true; // do not save bg scripts to SN.

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

function saveFieldAsFile(postedJson) {

	let req = <any>{};
	req.action = 'requestRecord';
	req.actionGoal = 'saveCheck';
	req.name = postedJson.name.replace(/[^a-z0-9 \.\-+]+/gi, '').replace(/\./g, '-');
	req.instance = postedJson.instance;
	req.tableName = postedJson.table;
	req.fieldName = postedJson.field;
	req.sys_id = postedJson.sys_id + "?sysparm_fields=name,sys_updated_on,sys_updated_by,sys_scope.scope," + postedJson.field;
	//requestRecords(req); // mmaybe implemt later to check changes with server version

	var fileExtension = ".js";
	var fieldType: string = postedJson.fieldType;
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

	var basePath = workspace.rootPath + nodePath.sep + postedJson.instance.name + nodePath.sep + postedJson.table + nodePath.sep 
	var fileName = basePath + postedJson.field + '^' + req.name.replace(/[^a-z0-9 \.\-+]+/gi, '').replace(/\./g, '-') + '^' + postedJson.sys_id + fileExtension;

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

	var scopeMappingFile = basePath + 'zz_map.json';
	eu.writeOrReadMapping(scopeMappingFile, postedJson.sys_id, postedJson.scope);

}

vscode.commands.registerCommand('openFile', (meta) => {

	var fileName = workspace.rootPath + nodePath.sep + meta.instance.name + nodePath.sep + meta.tableName + nodePath.sep +
		meta.fieldName + '^' + meta.name.replace(/[^a-z0-9 \.\-+]+/gi, '').replace(/\./g, '-') + '^' + meta.sys_id + '.' + meta.extension;
	let opened = false;

	//if its open activate the window
	let tds = vscode.workspace.textDocuments;
	for (let td in tds) {
		if (tds[td].fileName == fileName) {
			vscode.window.showTextDocument(tds[td]);
			opened = true;
		}
	}

	if (!opened) { //if not get the current version from the server.
		let req = <any>{};
		req.instance = meta.instance;
		req.action = 'requestRecord';
		req.actionGoal = 'getCurrent';
		req.tableName = meta.tableName;
		req.fieldName = meta.fieldName;
		req.fileName = fileName;
		req.name = meta.name;
		req.sys_id = meta.sys_id + "?sysparm_fields=name,sys_updated_on,sys_updated_by,sys_scope.scope," + req.fieldName;
		requestRecords(req);
	}

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

async function bgScriptExecute() {
	if (!serverRunning) {
		vscode.window.showInformationMessage("sn-scriptsync server must be running")
		return;
	}
	let editor = vscode.window.activeTextEditor;
	let scriptObj = eu.fileNameToObject(editor.document);
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

async function openInInstance() {
	if (!serverRunning) {
		vscode.window.showInformationMessage("sn-scriptsync server must be running")
		return;
	}
	let editor = vscode.window.activeTextEditor;
	let scriptObj = eu.fileNameToObject(editor.document);
	let url = scriptObj.instance.url + "/";

	if (scriptObj.tableName == 'sp_widget'){
		url += 'sp_config?id=widget_editor&sys_id=' + scriptObj.sys_id;
	}
	else {
		url += scriptObj.tableName + '.do?sys_id=' + scriptObj.sys_id;
	}
	vscode.env.openExternal(vscode.Uri.parse(url));
};

async function refreshFromInstance() {
	if (!serverRunning) {
		vscode.window.showInformationMessage("sn-scriptsync server must be running")
		return;
	}
	let editor = vscode.window.activeTextEditor;
	let scriptObj = eu.fileNameToObject(editor.document);

	scriptObj.action = 'requestRecord';
	scriptObj.actionGoal = 'getCurrent';
	scriptObj.sys_id = scriptObj.sys_id + "?sysparm_fields=name,sys_updated_on,sys_updated_by,sys_scope.scope," + scriptObj.fieldName;
	requestRecords(scriptObj);

};