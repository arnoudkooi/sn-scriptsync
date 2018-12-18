

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

			let jsnS = '';
			let jsnx;
			req.on('data', chunk => {
				jsnS += chunk.toString();
			});
			req.on('end', () => {
				jsnx = JSON.parse(jsnS);
				var fs = require('fs');

				var fileExtension = ".js";
				var fieldType: string = jsnx.fieldType;
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


				writeInstanceSettings(jsnx.instance);

				var fileName = workspace.rootPath + "/" + jsnx.instance.name + "/" + jsnx.table + "/" +
					jsnx.field + '^' + jsnx.name + '^' + jsnx.sys_id + fileExtension;
					writeFile(fileName, jsnx.content, function (err) {
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
						jsnx.result = '';
						jsnx.contentLength = jsnx.content.length;
						jsnx.send = false;		

						wss.clients.forEach(function each(client) {
							if (client.readyState === WebSocket.OPEN && !jsnx.send) {
							client.send(JSON.stringify(jsnx));
							jsnx.send = true;		
							}
						});					
					}
				});


			});
			res.setHeader("Access-Control-Allow-Origin", "*");
			res.end('Data received');
		}
		else {
			res.end('Please post data for ScriptSync to this enpoint');
		}
	});
	server.listen(1977);

	var fs = require('fs');
	const wss = new WebSocket.Server({ port: 1978 });


	wss.on('connection', (ws: WebSocket) => {

		ws.on('message', function incoming(message) {
			if (message.includes('error'))
				vscode.window.showErrorMessage("Error while saving file: " + message);
		});

		//send immediatly a feedback to the incoming connection    
		ws.send('["Connected to VS Code ScriptScync WebSocket"]',function(){});
		updateScriptSyncStatusBarItem('http:1977 ws:1978');


		vscode.workspace.onDidSaveTextDocument(listener => {
			
			try{
			var fileName = listener.fileName;
			var fileNameArr = fileName.split(/\\|\/|\.|\^/).slice(1).slice(-6);//
			if (fileNameArr.length < 6) return;
			if (fileNameArr[4].length != 32) return; //must be the sys_id
			var scriptObj = <any>{};
			scriptObj.name = fileNameArr[3];
			scriptObj.tableName = fileNameArr[1];
			scriptObj.fieldName = fileNameArr[2];
			scriptObj.sys_id = fileNameArr[4];
			scriptObj.content = window.activeTextEditor.document.getText();
			scriptObj.instance = getInstanceSettings(fileNameArr[0]);	

			if (!wss.clients.size){
				vscode.window.showErrorMessage("No WebSocket connection. Please open SN ScriptSync in a browser");
			}
			wss.clients.forEach(function each(client) {
				if (client.readyState === WebSocket.OPEN) {
					if ((Date.now() - lastsend) > 100){
						client.send(JSON.stringify(scriptObj));
						lastsend = Date.now(); 
					}
				}
			});
		}
		catch(err){
			vscode.window.showErrorMessage("Error while saving file: " + JSON.stringify(err,null,4) );
		}


		});
	});



}


export function deactivate() { }




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

function writeFile(path, contents, cb) {

	mkdirp(getDirName(path), function (err) {
		if (err) return cb(err);
		fs.writeFile(path, contents,(error) => { /* handle error */ });
		vscode.workspace.openTextDocument(path).then(doc => {
			vscode.window.showTextDocument(doc);
		});
		return cb();
	});
}

function updateScriptSyncStatusBarItem(message): void {
	scriptSyncStatusBarItem.text = `$(megaphone) SN ScriptSync: ${message}`;
	scriptSyncStatusBarItem.show();
}
