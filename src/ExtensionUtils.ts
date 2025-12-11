import { window, workspace, commands, Disposable, ExtensionContext, StatusBarAlignment, StatusBarItem, TextDocument } from 'vscode';

import * as path from "path";
import * as vscode from "vscode";
import { open } from 'fs';
import { Constants } from "./constants";

let idx = 0;

let fs = require('fs');
let getDirName = require('path').dirname;
const nodePath = require('path');
let instanceSettings = {};



export class ExtensionUtils {

    public static ignoreNextSync = new Set<string>();

    renamePath(oldPath: string, newPath: string) : void {
        fs.renameSync(oldPath, newPath);
    }

    copyFile(sourcePath: string, path: string, cb: Function) {
        fs.mkdir(getDirName(path), {recursive: true}, function (err) {
            if (err) return cb(err);
            fs.copyFile(sourcePath, path, (error) => {
                return cb(error);
            });
            return cb();
        });
    }

    copyFileIfNotExists(sourcePath: string, path: string, cb: Function) {

        if (fs.existsSync(path)){
            return cb("existst")
        }
        fs.mkdir(getDirName(path), {recursive: true}, function (err) {
            if (err) return cb(err);
            fs.copyFile(sourcePath, path, (error) => {
                return cb(error);
            });
            return cb();
        });
    }


    writeFile(path: string, contents: string, openFile, cb: Function, myThis = this) {

        ExtensionUtils.ignoreNextSync.add(path);

        fs.mkdir(getDirName(path), {recursive: true}, function (err) {
            if (err) return cb(err);
            fs.writeFile(path, contents, (error) => { /* handle error */ });
            vscode.workspace.openTextDocument(path).then(doc => {
                if (openFile){
                    vscode.window.showTextDocument(doc, { "preview": false });
                    //vscode.window.showInformationMessage("Data loaded from Instance and written to file")
                    myThis.showMessage("Data loaded from Instance and written to file");
                    
                }
            });
            return cb();
        });
        
    }



    writeFileIfNotExists(path, contents, openFile, cb) {

        ExtensionUtils.ignoreNextSync.add(path);

        fs.mkdir(getDirName(path), {recursive: true}, function (err) {
            if (err) return cb(err);
            fs.writeFile(path, contents, { "flag": "wx" }, (error) => { /* handle error */ });
            vscode.workspace.openTextDocument(path).then(doc => {
                if (openFile){
                    vscode.window.showTextDocument(doc, { "preview": false });
                    vscode.commands.executeCommand("editor.action.formatDocument");
                    
                }
            });
            return cb();
        });
    }



    writeInstanceSettings(instance) {
        var path = workspace.rootPath + nodePath.sep + instance.name + nodePath.sep + "_settings.json";
        fs.mkdir(getDirName(path), {recursive: true}, function (err) {
            if (err) console.log(err);
            fs.writeFile(path, JSON.stringify(instance, null, 4), (error) => { /* handle error */ });
        });
        instanceSettings[instance.name] = instance;
    }

    getInstanceSettings(instanceName: string) {
        if (typeof instanceSettings[instanceName] != 'undefined') { //from variable if available
            return instanceSettings[instanceName];
        }
        else {
            const newPath = workspace.rootPath + nodePath.sep + instanceName + nodePath.sep + "_settings.json";
            const oldPath = workspace.rootPath + nodePath.sep + instanceName + nodePath.sep + "settings.json";
            
            // Check new path first, fall back to old path for backwards compatibility
            if (fs.existsSync(newPath)) {
                return JSON.parse(fs.readFileSync(newPath)) || {};
            } else if (fs.existsSync(oldPath)) {
                // Migrate: rename old file to new name
                try {
                    fs.renameSync(oldPath, newPath);
                    return JSON.parse(fs.readFileSync(newPath)) || {};
                } catch (e) {
                    // If rename fails, just read from old path
                    return JSON.parse(fs.readFileSync(oldPath)) || {};
                }
            }
            return {};
        }
    }

    getFileAsJson(path: string) {
        try {
            return JSON.parse(fs.readFileSync(path)) || {};
        }
        catch(ex){
            console.log(ex);
            return {};
        }
    }

    getFileAsArray(path: string) {
        try {
            return fs.readFileSync(path, { "encoding": "utf8" }).split("\n") || [];
        }
        catch{
            return [];
        }
    }

    showMessage(msg: string, duration: number = 3000) {
        vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'sn-scriptsync',
                cancellable: false,
            },
            async (progress, token) => {
                for (let i = 0; i < 100; i++) {
                    await new Promise(resolve => setTimeout(resolve, duration/100));
                    progress.report({ increment: i , message: msg })
                }
            })
    }

    //
    fileNameToObject(listener : TextDocument | string) {

        let fileName = (typeof listener === 'string') ? listener : listener.fileName;
        let content = (typeof listener === 'string') ? fs.readFileSync(listener, 'utf-8') : listener.getText();

        var fileNameUse = fileName.replace(workspace.rootPath, "");
        var fileNameArr = fileNameUse.split(/\\|\/|\.|\^/).slice(1);//
        var basePath = workspace.rootPath + nodePath.sep + fileNameArr[0]+ nodePath.sep;
        let fullPath = basePath + fileNameArr[1]+ nodePath.sep + fileNameArr[2]+ nodePath.sep

        if (fileNameArr[5] === "ts") {
            return true;
        }

        if (fileNameArr.length == 8){ //this is a variable stored in sys_variable_value use some creativity to support these files...
            var fileNme = fileNameArr[2] + "." + fileNameArr[3] + "." + fileNameArr[4];
            fileNameArr.splice(2, 1);
            fileNameArr.splice(2, 1);
            fileNameArr[2] = fileNme;
        }


        if (fileNameArr.length < 5) {
            vscode.window.showWarningMessage("This command can only be executed from a synced file.")
            return true;
        }

        if (fileNameArr.length == 6){ //new 2023 way: instance/scope/table/name.fieldname.extension

            let scopes = {"global" : "global"};
            if (fileNameArr[1] != "global") scopes = this.getFileAsJson(basePath + 'scopes.json');
            let objNameToSysId = this.writeOrReadNameToSysIdMapping(fullPath + '_map.json');

            var scriptObj = <any>{};
            scriptObj.instance = this.getInstanceSettings(fileNameArr[0]);
            scriptObj.tableName = fileNameArr[2];
            // Handle folder record tables where the structure is different
            if (Constants.FOLDERRECORDTABLES.includes(scriptObj.tableName)) {
                // For folder records, fileNameArr[3] is the record name (folder)
                // and fileNameArr[4] is the field name.
                // This block handles the general "6 parts" case, but folder records 
                // might need specific handling if they fall into this length check.
                // However, based on the regex in dissasembleFilePath, folder records 
                // usually have a different structure.
                // Let's assume standard flat structure for now as per "new 2023 way".
            }
            
            scriptObj.name = fileNameArr[3];
            scriptObj.fieldName = fileNameArr[4];
            scriptObj.sys_id = objNameToSysId[fileNameArr[3]] || '';
            scriptObj.scopeName = fileNameArr[1];
            if (scopes.hasOwnProperty(fileNameArr[1])) 
                scriptObj.scope = scopes[fileNameArr[1]];

            scriptObj.fileName = fileName;
            scriptObj.content = content;

            if (fileNameArr[2] == 'sp_widget')
                scriptObj.testUrls = this.getFileAsArray(path.dirname(scriptObj.fileName) + nodePath.sep + "_test_urls.txt");


            return scriptObj;

        }



        if ((fileNameArr[4].length != 32 && fileNameArr[1] != 'sp_widget') && fileNameArr[1] != 'background') return true; //must be the sys_id
        var scriptObj = <any>{};
        scriptObj.instance = this.getInstanceSettings(fileNameArr[0]);
        scriptObj.tableName = fileNameArr[1];
        if (fileNameArr[4].length == 32) {
            scriptObj.name = fileNameArr[3];
            scriptObj.fieldName = fileNameArr[2];
            scriptObj.sys_id = fileNameArr[4];

        }
        else if (fileNameArr[1] == 'sp_widget') {
            scriptObj.name = fileNameArr[2];
            scriptObj.testUrls = this.getFileAsArray(basePath + nodePath.sep + scriptObj.name + nodePath.sep + "test_urls.txt");

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
                var widgetjson = this.getFileAsJson(basePath + nodePath.sep + scriptObj.name + nodePath.sep + "widget.json");
                scriptObj.fieldName = nameToField[fileNameArr[3]];
                scriptObj.sys_id = widgetjson['sys_id'];
                scriptObj.scope = widgetjson.widget.sys_scope.value;

            }
            else {
                scriptObj.tableName = fileNameArr[3];
                scriptObj.fieldName = fileNameArr[4];
                scriptObj.sys_id = fileNameArr[6];
            }
        }
        scriptObj.fileName = fileName;
        scriptObj.content = content;
        return scriptObj;

    }

    writeOrReadNameToSysIdMapping(path:string, mappingObject?: object, overwriteExistingMap : boolean = false) : object {
        let mergedMappingObject = {};

        if(!overwriteExistingMap) {
            try {
                mergedMappingObject = JSON.parse(fs.readFileSync(path))
            } catch(_) {}
        }

        if(mappingObject) {
            mergedMappingObject = {...mergedMappingObject, ...mappingObject};
            this.writeFile(path, JSON.stringify(mergedMappingObject),false,function(){});
        }

        return mergedMappingObject;
    }

    fileExsists(path:string){
        return fs.existsSync(path)
    }

    isFile(path: string) : boolean {
        return this.fileExsists(path) && fs.lstatSync(path).isFile();
    }

    pathOfBaseDirectory(path: string) : string {
        return nodePath.dirname(path)
    }

    fileOrDirectoryName(path: string) : string {
        return nodePath.basename(path)
    }

    joinPaths(...pathParts) : string {
        return nodePath.join(...pathParts);
    }

    dissasembleFilePath(path: string, isFolderRecordTable : boolean = false) : {recordName: string, fieldName: string, fileExtension: string} | undefined {
        const fsName = this.fileOrDirectoryName(path);
        
        if(isFolderRecordTable) {
            return {
                recordName: fsName,
                fieldName: undefined,
                fileExtension: undefined
            }
        }

        const match = /^(?<recordName>[^.]+)\.(?<fieldName>[^.]+)\.(?<fileExtension>[^.]+)$/.exec(fsName);

        if(!match) {
            return;
        }

        const {recordName, fieldName, fileExtension} = match.groups;
        return {recordName, fieldName, fileExtension};
    }
}
