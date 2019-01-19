

import { window, workspace, commands, Disposable, ExtensionContext, StatusBarAlignment, StatusBarItem, TextDocument } from 'vscode';
import * as http from 'http';
import * as WebSocket from 'ws';
import * as vscode from 'vscode';
import { userInfo } from 'os';

let mkdirp = require('mkdirp');
let fs = require('fs');
let getDirName = require('path').dirname;

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
		saveFieldsToServiceNow(listener.fileName);
	});

}

export function deactivate() { }


function startServers() {

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
			// if (message.includes('error'))
			// 	vscode.window.showErrorMessage("Error while saving file: " + message);
			// else
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
	var filePath = workspace.rootPath + "/" + postedJson.instance.name + "/" +
		postedJson.tableName + "/" + postedJson.name + '/';

	var files = {
		"1 HTML Template.html": { "content": postedJson.widget.template.value, "openFile": true },
		"2 SCSS.css": { "content": postedJson.widget.css.value, "openFile": true },
		"3 Client Script.js": { "content": postedJson.widget.client_script.value, "openFile": true },
		"4 Server Script.js": { "content": postedJson.widget.script.value, "openFile": true },
		"5 Link function.js": { "content": postedJson.widget.link.value, "openFile": false },
		"6 Option schema.json": { "content": postedJson.widget.option_schema.value, "openFile": false },
		"7 Demo data.json": { "content": postedJson.widget.demo_data.value, "openFile": false },
		"widget.json": { "content": JSON.stringify(postedJson, null, 4), "openFile": false },
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
	fields.push({"name" : "template", "fileType" : "html" }); 
	requestJson.fields = fields;
	requestJson.queryString = 'sysparm_query=sp_widget=' + postedJson.sys_id;

	requestRecords(requestJson);

	var testUrls = [];
	testUrls.push(postedJson.instance.url + "/$sp.do?id=sp-preview&sys_id=" + postedJson.sys_id);
	testUrls.push(postedJson.instance.url + "/sp_config/?id=" + postedJson.widget.id.displayValue);
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
	let filePath = responseJson.filePath + responseJson.tableName + "/";
	for (let result of responseJson.results) {
		for (let field of responseJson.fields) {
			writeFile(filePath + 
					field.name + '^' + 
					result[responseJson.displayValueField].replace(/\./,'') + '^' + 
					result.sys_id + '^' + 
					field.fileType, 
				result[field.name], false, function(){});
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

function saveFieldsToServiceNow(fileName) {


	try {
		var fileNameArrFull = fileName.split(/\\|\/|\.|\^/);//
		var fileNameArr = fileNameArrFull.slice(1).slice(-6);//
		if (fileNameArr.length < 6) return;
		if (fileNameArr[4].length != 32 && fileNameArr[2] != 'sp_widget') return; //must be the sys_id
		var scriptObj = <any>{};
		if (fileNameArr[4].length == 32) {
			scriptObj.name = fileNameArr[3];
			scriptObj.tableName = fileNameArr[1];
			scriptObj.fieldName = fileNameArr[2];
			scriptObj.sys_id = fileNameArr[4];
			if (fileNameArrFull.length < 8)
				scriptObj.instance = getInstanceSettings(fileNameArr[0]);
			else { //subdirectory of a widget
				var basePath = fileNameArrFull.slice(0, -5).join("/");
				scriptObj.instance = getInstanceSettings(fileNameArrFull[fileNameArrFull.length - 8]);
				scriptObj.testUrls = getFileAsArray(basePath + "/test_urls.txt");
			}

		}
		else if (fileNameArr[2] == 'sp_widget') {

			var basePath = fileNameArrFull.slice(0, -2).join("/");
			var nameToField = {
				"1 HTML Template": "template",
				"2 SCSS": "css",
				"3 Client Script": "client_script",
				"4 Server Script": "script",
				"5 Link function": "link",
				"6 Option schema": "option_schema",
				"7 Demo data": fileNameArr
			}
			scriptObj.name = fileNameArr[3];
			scriptObj.tableName = fileNameArr[2];
			scriptObj.fieldName = nameToField[fileNameArr[4]];
			scriptObj.sys_id = getFileAsJson(basePath + "/widget.json")['sys_id'];
			scriptObj.instance = getInstanceSettings(fileNameArr[1]);
			scriptObj.testUrls = getFileAsArray(basePath + "/test_urls.txt");
		}
		scriptObj.content = window.activeTextEditor.document.getText();

		if (!wss.clients.size) {
			vscode.window.showErrorMessage("No WebSocket connection. Please open SN ScriptSync in a browser");
		}
		wss.clients.forEach(function each(client) {
			if (client.readyState === WebSocket.OPEN) {
				client.send(JSON.stringify(scriptObj));
			}
		});
	}
	catch (err) {
		vscode.window.showErrorMessage("Error while saving file: " + JSON.stringify(err, null, 4));
	}

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

	var fileName = workspace.rootPath + "/" + postedJson.instance.name + "/" + postedJson.table + "/" +
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
	var path = workspace.rootPath + "/" + instance.name + "/settings.json";
	mkdirp(getDirName(path), function (err) {
		if (err) console.log(err);
		fs.writeFile(path, JSON.stringify(instance, null, 4), (error) => { /* handle error */ });
	});
}

function getInstanceSettings(instanceName: string) {
	var path = workspace.rootPath + "/" + instanceName + "/settings.json";
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
