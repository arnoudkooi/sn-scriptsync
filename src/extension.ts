

import { window, workspace, commands, Disposable, ExtensionContext, StatusBarAlignment, StatusBarItem, TextDocument } from 'vscode';
import * as http from 'http';
import * as WebSocket from 'ws';
import * as vscode from 'vscode';

var mkdirp = require('mkdirp');
var fs = require('fs');
var getDirName = require('path').dirname;
var lastsend = Date.now();

let scriptSyncStatusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {

	let disposable = vscode.commands.registerCommand('extension.snScriptSync', () => {
		vscode.window.showInformationMessage('ServiceNow ScriptSync!');
	});
	context.subscriptions.push(disposable);

	scriptSyncStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);

	const server = http.createServer((req, res) => {
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
					saveFieldAsFile(postedJson, wss);
				else if (postedJson.action == 'saveWidget')
					saveWidget(postedJson, wss);
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

	const wss = new WebSocket.Server({ port: 1978 });
	wss.on('connection', (ws: WebSocket) => {

		ws.on('message', function incoming(message) {
			if (message.includes('error'))
				vscode.window.showErrorMessage("Error while saving file: " + message);
		});

		//send immediatly a feedback to the incoming connection    
		ws.send('["Connected to VS Code ScriptScync WebSocket"]', function () { });
		updateScriptSyncStatusBarItem('http:1977 ws:1978');



	});

	vscode.workspace.onDidSaveTextDocument(listener => {
		saveFieldsToServiceNow(listener.fileName, wss);
	});



}


export function deactivate() { }

function saveWidget(postedJson, wss) {
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

	var testUrls = [];
	testUrls.push(postedJson.instance.url + "/$sp.do?id=sp-preview&sys_id=" + postedJson.sys_id);
	testUrls.push(postedJson.instance.url + "/sp_config/?id=" + postedJson.widget.id.displayValue);
	writeFileIfNotExists(filePath + "test_urls.txt", testUrls.join("\n"),false,function(){});


	postedJson.widget = {};
	postedJson.result = {};
	postedJson.content = {};
	postedJson.fieldName = "template,css,client_script,script,link,option_schema,demo_data";
	postedJson.content.length = contentLength;
	wss.clients.forEach(function each(client) {
		if (client.readyState === WebSocket.OPEN) {
			if ((Date.now() - lastsend) > 100) {
				client.send(JSON.stringify(postedJson));
				lastsend = Date.now();
			}
		}
	});	


}
function saveFieldsToServiceNow(fileName, wss) {


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
			scriptObj.instance = getInstanceSettings(fileNameArr[0]);
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
				if ((Date.now() - lastsend) > 100) {
					client.send(JSON.stringify(scriptObj));
					lastsend = Date.now();
				}
			}
		});
	}
	catch (err) {
		vscode.window.showErrorMessage("Error while saving file: " + JSON.stringify(err, null, 4));
	}

}

function saveFieldAsFile(postedJson, wss) {
	var fs = require('fs');

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

function getInstanceSettings(instanceName) {
	var path = workspace.rootPath + "/" + instanceName + "/settings.json";
	return JSON.parse(fs.readFileSync(path)) || {};
}

function getFileAsJson(path) {
	return JSON.parse(fs.readFileSync(path)) || {};
}

function getFileAsArray(path) {
	return fs.readFileSync(path, {"encoding" : "utf8"}).split("\n") || [];
}

function writeFile(path, contents, openFile, cb) {

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
		fs.writeFile(path, contents, { "flag" : "wx"}, (error) => { /* handle error */ });
		vscode.workspace.openTextDocument(path).then(doc => {
			if (openFile)
				vscode.window.showTextDocument(doc, { "preview": false });
		});
		return cb();
	});
}


function updateScriptSyncStatusBarItem(message): void {
	scriptSyncStatusBarItem.text = `$(megaphone) SN ScriptSync: ${message}`;
	scriptSyncStatusBarItem.show();
}
