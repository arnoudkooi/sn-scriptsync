import { window, workspace, commands, Disposable, ExtensionContext, StatusBarAlignment, StatusBarItem, TextDocument } from 'vscode';
import * as http from 'http';
import * as WebSocket from 'ws';
import * as vscode from 'vscode';
import { userInfo } from 'os';


let mkdirp = require('mkdirp');
let fs = require('fs');
let getDirName = require('path').dirname;
const nodePath = require('path');

let wss;
let server;
let serverRunning = false;

let scriptSyncStatusBarItem: vscode.StatusBarItem;



export function activate({ subscriptions }: vscode.ExtensionContext) {

	//initialize statusbaritem and click events
	const toggleSyncID = 'sample.toggleScriptSync';
	subscriptions.push(vscode.commands.registerCommand(toggleSyncID, () => {
		if (serverRunning)
			vscode.commands.executeCommand("extension.snScriptSyncDisable");
		else
			vscode.commands.executeCommand("extension.snScriptSyncEnable");

	}));
	scriptSyncStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	scriptSyncStatusBarItem.command = toggleSyncID;
	subscriptions.push(scriptSyncStatusBarItem);

	updateScriptSyncStatusBarItem('click to start.');

	const settings = vscode.workspace.getConfiguration('sn-scriptsync')
	var syncDir: string = settings.get('path');
	syncDir = syncDir.replace('~', userInfo().homedir);
	if (vscode.workspace.rootPath == syncDir) {
		startServers();
	}


	vscode.commands.registerCommand('extension.snScriptSyncEnable', () => {
		startServers();
	});

	vscode.commands.registerCommand('extension.snScriptSyncDisable', () => {
		stopServers();
	});

	vscode.workspace.onDidSaveTextDocument(listener => {
		if(!saveFieldsToServiceNow(listener.fileName)) {
			markFileAsDirty(listener)
		}
	});

}

export function deactivate() { }

function markFileAsDirty(file : TextDocument) : void {
	let insertEdit: vscode.WorkspaceEdit = new vscode.WorkspaceEdit();
	let removeEdit: vscode.WorkspaceEdit = new vscode.WorkspaceEdit();
	let lastLineIndex: number = file.lineCount - 1;
	let lastCharacterIndex: number = file.lineAt(lastLineIndex).range.end.character;

	insertEdit.insert(file.uri, new vscode.Position(lastLineIndex, lastCharacterIndex), " ");
	removeEdit.delete(file.uri, new vscode.Range(
		new vscode.Position(lastLineIndex, lastCharacterIndex), new vscode.Position(lastLineIndex, lastCharacterIndex+1)));
	workspace.applyEdit(insertEdit).then(() => {
		workspace.applyEdit(removeEdit);
	});
}

function startServers() {

	if (typeof workspace.rootPath == 'undefined') {
		vscode.window.showWarningMessage("Please open a folder, before running ScriptSync");
		return;
	}

	//start the webserver
	server = http.createServer((req, res) => {
		if (req.method === 'POST') {

			let postedData = '';
			let postedJson;
			req.on('data', chunk => {
				postedData += chunk.toString();
			});
			req.on('end', () => {
				postedJson = JSON.parse(postedData);
				writeInstanceSettings(postedJson.instance);

				if (postedJson.action == 'saveFieldAsFile' || !postedJson.action)
					saveFieldAsFile(postedJson);
				else if (postedJson.action == 'saveWidget')
					saveWidget(postedJson);
				//requestRecord(postedJson,wss);
			});
			res.setHeader("Access-Control-Allow-Origin", "*");
			res.setHeader('Access-Control-Allow-Methods', 'POST');
			res.end('Data received');
		}
		else {
			res.end('Please post data for ScriptSync to this enpoint');
		}
	});
	server.listen(1977);

	//Start WebSocket Server
	wss = new WebSocket.Server({ port: 1978 });
	wss.on('connection', (ws: WebSocket) => {

		if (wss.clients.size > 1) {
			ws.close(0, 'max connection');
		}
		ws.on('message', function incoming(message) {
			let messageJson = JSON.parse(message)
			if (messageJson.hasOwnProperty('error')) {
				if (messageJson.error.detail.includes("ACL"))
					messageJson.error.detail = "ACL Error, try changing scope in the browser";

				vscode.window.showErrorMessage("Error while saving file: " + messageJson.error.detail);

				markFileAsDirty(window.activeTextEditor.document);
			}
			else
				saveRequestResponse(messageJson);
		});

		//send immediatly a feedback to the incoming connection    
		ws.send('["Connected to VS Code ScriptScync WebSocket"]', function () { });

	});
	updateScriptSyncStatusBarItem('Running');
	serverRunning = true;

}

function stopServers() {
	server.close()
	wss.close();
	updateScriptSyncStatusBarItem('Stopped');
	serverRunning = false;
}


function saveWidget(postedJson) {
	//lastsend = 0;
	var filePath = workspace.rootPath + nodePath.sep + postedJson.instance.name + nodePath.sep +
		postedJson.tableName + nodePath.sep + postedJson.name + nodePath.sep;

	var files = {};

	if (postedJson.widget.hasOwnProperty("option_schema")) { //sp_widget
		files = {
			"1 HTML Template.html": { "content": postedJson.widget.template.value, "openFile": true },
			"2 SCSS.css": { "content": postedJson.widget.css.value, "openFile": true },
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
			"2 SCSS.css": { "content": postedJson.widget.css.value, "openFile": true },
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

		writeFile(filePath + file, files[file].content, files[file].openFile, function (err) {
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
	testUrls.push(postedJson.instance.url + nodePath.sep + "$sp.do?id=sp-preview&sys_id=" + postedJson.sys_id);
	testUrls.push(postedJson.instance.url + nodePath.sep + "sp_config?id=" + postedJson.widget.id.displayValue);
	writeFileIfNotExists(filePath + "test_urls.txt", testUrls.join("\n"), false, function () { });

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
	let filePath = responseJson.filePath + responseJson.tableName + nodePath.sep;
	for (let result of responseJson.results) {
		for (let field of responseJson.fields) {
			writeFile(filePath +
				field.name + '^' +
				result[responseJson.displayValueField].replace(/\./, '') + '^' +
				result.sys_id + '.' +
				field.fileType,
				result[field.name], false, function () { });
		}
	}
}

function requestRecords(requestJson) {

	try {
		if (!wss.clients.size) {
			vscode.window.showErrorMessage("No WebSocket connection. Please open SN ScriptSync in a browser");
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

function saveFieldsToServiceNow(fileName) : boolean {
	let success : boolean = true;
	try {
		var fileNameUse = fileName.replace(workspace.rootPath, "");
		var fileNameArr = fileNameUse.split(/\\|\/|\.|\^/).slice(1);//
		var basePath = workspace.rootPath + nodePath.sep + fileNameArr.slice(0, 2).join(nodePath.sep);

		if (fileNameArr[5] === "ts") {
			return true;
		}

		if (fileNameArr.length < 5) return true;
		if (fileNameArr[4].length != 32 && fileNameArr[1] != 'sp_widget') return true; //must be the sys_id
		var scriptObj = <any>{};
		scriptObj.instance = getInstanceSettings(fileNameArr[0]);
		scriptObj.tableName = fileNameArr[1];
		if (fileNameArr[4].length == 32) {
			scriptObj.name = fileNameArr[3];
			scriptObj.fieldName = fileNameArr[2];
			scriptObj.sys_id = fileNameArr[4];
		}
		else if (fileNameArr[1] == 'sp_widget') {
			scriptObj.name = fileNameArr[2];
			scriptObj.testUrls = getFileAsArray(basePath + nodePath.sep + scriptObj.name + nodePath.sep + "test_urls.txt");

			if (fileNameArr[3] != 'sp_ng_template') {
				var nameToField = {
					"1 HTML Template": "template",
					"2 SCSS": "css",
					"3 Client Script": "client_script",
					"4 Server Script": "script",
					"5 Link function": "link",
					"6 Option schema": "option_schema",
					"7 Demo data": fileNameArr
				}
				scriptObj.fieldName = nameToField[fileNameArr[3]];
				scriptObj.sys_id = getFileAsJson(basePath + nodePath.sep + scriptObj.name + nodePath.sep + "widget.json")['sys_id'];
			}
			else {
				scriptObj.tableName = fileNameArr[3];
				scriptObj.fieldName = fileNameArr[4];
				scriptObj.sys_id = fileNameArr[6];
			}
		}
		scriptObj.content = window.activeTextEditor.document.getText();

		if (!wss.clients.size) {
			vscode.window.showErrorMessage("No WebSocket connection. Please open SN ScriptSync in a browser");
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

	var fileExtension = ".js";
	var fieldType: string = postedJson.fieldType;
	if (fieldType.includes("xml"))
		fileExtension = ".xml";
	else if (fieldType.includes("html"))
		fileExtension = ".html";
	else if (fieldType.includes("json"))
		fileExtension = ".json";
	else if (fieldType.includes("css"))
		fileExtension = ".scss";
	else if (postedJson.name.split(".").length == 2) {
		fileExtension = "." + postedJson.name.split(".")[1];
		postedJson.name = postedJson.name.split(".")[0];
	}
	else if (fieldType.includes("string") || fieldType == "conditions")
		fileExtension = ".txt";

	var fileName = workspace.rootPath + nodePath.sep + postedJson.instance.name + nodePath.sep + postedJson.table + nodePath.sep +
		postedJson.field + '^' + postedJson.name + '^' + postedJson.sys_id + fileExtension;
	writeFile(fileName, postedJson.content, true, function (err) {
		if (err) {
			//console.log(err);
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
}


function writeInstanceSettings(instance) {
	var path = workspace.rootPath + nodePath.sep + instance.name + nodePath.sep + "settings.json";
	mkdirp(getDirName(path), function (err) {
		if (err) console.log(err);
		fs.writeFile(path, JSON.stringify(instance, null, 4), (error) => { /* handle error */ });
	});
}

function getInstanceSettings(instanceName: string) {
	var path = workspace.rootPath + nodePath.sep + instanceName + nodePath.sep + "settings.json";
	return JSON.parse(fs.readFileSync(path)) || {};
}

function getFileAsJson(path: string) {
	return JSON.parse(fs.readFileSync(path)) || {};
}

function getFileAsArray(path: string) {
	return fs.readFileSync(path, { "encoding": "utf8" }).split("\n") || [];
}

function writeFile(path: string, contents: string, openFile, cb: Function) {

	mkdirp(getDirName(path), function (err) {
		if (err) return cb(err);
		fs.writeFile(path, contents, (error) => { /* handle error */ });
		vscode.workspace.openTextDocument(path).then(doc => {
			if (openFile)
				vscode.window.showTextDocument(doc, { "preview": false });
		});
		return cb();
	});
}

function writeFileIfNotExists(path, contents, openFile, cb) {

	mkdirp(getDirName(path), function (err) {
		if (err) return cb(err);
		fs.writeFile(path, contents, { "flag": "wx" }, (error) => { /* handle error */ });
		vscode.workspace.openTextDocument(path).then(doc => {
			if (openFile)
				vscode.window.showTextDocument(doc, { "preview": false });
		});
		return cb();
	});
}


function updateScriptSyncStatusBarItem(message: string): void {
	scriptSyncStatusBarItem.text = `$(megaphone) SN ScriptSync: ${message}`;
	scriptSyncStatusBarItem.show();
}
