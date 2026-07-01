import { window, workspace, commands, Disposable, ExtensionContext, StatusBarAlignment, StatusBarItem, TextDocument } from 'vscode';

import * as path from "path";
import * as vscode from "vscode";
import { open } from 'fs';
import { Constants } from "./constants";
import { getWorkspaceRoot } from "./workspaceRoot";

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

    /**
     * Copy `sourcePath` to `destPath` when the source's `<!-- apiVersion: N -->`
     * marker is higher than the destination's (or when destination is missing).
     * The existing destination is preserved as `${destPath}.bak` so the user
     * can diff local tweaks.
     */
    copyFileIfVersionOlder(sourcePath: string, destPath: string, cb: Function) {
        try {
            if (!fs.existsSync(sourcePath)) {
                return cb(new Error(`source missing: ${sourcePath}`));
            }

            const srcVersion = ExtensionUtils.readApiVersion(sourcePath);
            if (srcVersion === null) {
                // Source has no marker - fall back to "copy only if missing".
                if (fs.existsSync(destPath)) return cb(null);
                fs.mkdir(getDirName(destPath), { recursive: true }, function (err) {
                    if (err) return cb(err);
                    fs.copyFile(sourcePath, destPath, (error) => cb(error));
                });
                return;
            }

            const destExists = fs.existsSync(destPath);
            const destVersion = destExists ? ExtensionUtils.readApiVersion(destPath) : null;

            if (destExists && destVersion !== null && destVersion >= srcVersion) {
                return cb(null);
            }

            fs.mkdir(getDirName(destPath), { recursive: true }, function (err) {
                if (err) return cb(err);
                if (destExists) {
                    try {
                        const backup = destPath + '.bak';
                        try { fs.unlinkSync(backup); } catch { /* no previous backup */ }
                        fs.renameSync(destPath, backup);
                    } catch {
                        /* best effort; overwrite below if rename fails */
                    }
                }
                fs.copyFile(sourcePath, destPath, (error) => cb(error));
            });
        } catch (e) {
            return cb(e);
        }
    }

    private static readApiVersion(filePath: string): number | null {
        try {
            const head = fs.readFileSync(filePath, { encoding: 'utf8', flag: 'r' }).slice(0, 4096);
            return ExtensionUtils.readApiVersionFromText(head);
        } catch {
            return null;
        }
    }

    private static readApiVersionFromText(text: string): number | null {
        const m = /<!--\s*apiVersion:\s*(\d+)\s*-->/i.exec(text.slice(0, 4096));
        return m ? parseInt(m[1], 10) : null;
    }

    // Markers that delimit the block this extension owns inside a user's
    // instruction file. Anything outside the markers is the user's own content
    // and is preserved across refreshes.
    private static MANAGED_BEGIN_RE = /<!--\s*SN-SCRIPTSYNC:BEGIN\s+apiVersion=(\d+)\s*-->/i;
    private static MANAGED_END_RE = /<!--\s*SN-SCRIPTSYNC:END\s*-->/i;

    private static extractManagedBlock(text: string): { begin: number; end: number; version: number } | null {
        const begin = ExtensionUtils.MANAGED_BEGIN_RE.exec(text);
        if (!begin) return null;
        const tail = text.slice(begin.index);
        const end = ExtensionUtils.MANAGED_END_RE.exec(tail);
        if (!end) return null;
        return {
            begin: begin.index,
            end: begin.index + end.index + end[0].length,
            version: parseInt(begin[1], 10),
        };
    }

    /**
     * Insert or refresh the SN-SCRIPTSYNC managed block in `destPath` from the
     * generated `sourcePath`, preserving any user content outside the markers.
     *
     * `opts.preserveUserFile` distinguishes the extension's OWN file
     * (`agentinstructions.md`, false) from tool-standard files the user authors
     * themselves (`CLAUDE.md`, `AGENTS.md`, `.cursorrules`, ...; true). For the
     * latter we must NEVER replace the whole file — a `CLAUDE.md` is the user's
     * project memory, not a renamed copy of our instructions.
     *
     * Behaviour:
     * - dest missing
     *     preserveUserFile=false -> write the full generated file (first-time setup).
     *     preserveUserFile=true  -> write just the managed block as a new file.
     * - dest has markers, newer -> replace ONLY the block, keep the user's text.
     * - dest has markers, same/older version -> no-op.
     * - dest has no markers (user's own file / legacy)
     *     preserveUserFile=true  -> APPEND the managed block, keep all user content
     *                               (no backup, no clobber).
     *     preserveUserFile=false -> version-gated whole-file replace, backing up
     *                               the previous copy as `${destPath}.bak`.
     *
     * If an older release already clobbered a user file into a pure managed block
     * and left the original as `${destPath}.bak`, the refresh self-heals: it
     * restores the backed-up content and appends only the slim block.
     *
     * Calls `cb(err, status)` where status is one of
     * 'created' | 'updated_block' | 'appended_block' | 'restored_user_file'
     * | 'replaced_legacy' | 'up_to_date'.
     */
    upsertManagedBlock(sourcePath: string, destPath: string, cb: Function, opts: { preserveUserFile?: boolean } = {}) {
        try {
            if (!fs.existsSync(sourcePath)) {
                return cb(new Error(`source missing: ${sourcePath}`));
            }

            const preserveUserFile = opts.preserveUserFile === true;
            const srcText: string = fs.readFileSync(sourcePath, 'utf8');
            const srcBlock = ExtensionUtils.extractManagedBlock(srcText);
            const srcVersion = srcBlock ? srcBlock.version : (ExtensionUtils.readApiVersionFromText(srcText) ?? 0);
            // The exact bytes we own inside the dest file: the managed block from
            // the source (or, defensively, the whole source if it has no markers).
            const srcManagedBlock = srcBlock ? srcText.slice(srcBlock.begin, srcBlock.end) : srcText.trim();

            if (!fs.existsSync(destPath)) {
                fs.mkdirSync(getDirName(destPath), { recursive: true });
                fs.writeFileSync(destPath, preserveUserFile ? srcManagedBlock + '\n' : srcText);
                return cb(null, 'created');
            }

            const destText: string = fs.readFileSync(destPath, 'utf8');
            const destBlock = ExtensionUtils.extractManagedBlock(destText);

            if (destBlock) {
                if (!preserveUserFile) {
                    // Our own file: any `${destPath}.bak` is a stale copy of an
                    // earlier version of OUR content — drop it (issue #148).
                    ExtensionUtils.tryUnlinkBak(destPath);
                    if (destBlock.version >= srcVersion) return cb(null, 'up_to_date');
                    const merged = destText.slice(0, destBlock.begin) + srcManagedBlock + destText.slice(destBlock.end);
                    fs.writeFileSync(destPath, merged);
                    return cb(null, 'updated_block');
                }

                if (destBlock.version >= srcVersion) return cb(null, 'up_to_date');

                // A user-authored tool file. If everything OUTSIDE our markers is
                // empty AND a `${destPath}.bak` exists, an older release clobbered
                // the user's file into a pure managed block and stashed their
                // original in the backup — heal it by restoring their content and
                // appending only the slim reference block.
                const outside = (destText.slice(0, destBlock.begin) + destText.slice(destBlock.end)).trim();
                const backup = destPath + '.bak';
                if (outside === '' && fs.existsSync(backup)) {
                    let bakText = '';
                    try { bakText = fs.readFileSync(backup, 'utf8'); } catch { /* unreadable backup */ }
                    if (bakText.trim() !== '' && !ExtensionUtils.extractManagedBlock(bakText)) {
                        const restored = bakText.replace(/\s*$/, '') + '\n\n' + srcManagedBlock + '\n';
                        fs.writeFileSync(destPath, restored);
                        try { fs.unlinkSync(backup); } catch { /* best effort */ }
                        return cb(null, 'restored_user_file');
                    }
                }

                // Normal in-place refresh: swap just our block, keep the user's
                // content, and never touch their `.bak` (it may be their original).
                const merged = destText.slice(0, destBlock.begin) + srcManagedBlock + destText.slice(destBlock.end);
                fs.writeFileSync(destPath, merged);
                return cb(null, 'updated_block');
            }

            // Dest has no markers. For a user-authored tool file, never clobber:
            // append our managed block after their content (it wins as the more
            // specific, later instruction) and leave everything they wrote intact.
            if (preserveUserFile) {
                const merged = destText.replace(/\s*$/, '') + '\n\n' + srcManagedBlock + '\n';
                fs.writeFileSync(destPath, merged);
                return cb(null, 'appended_block');
            }

            // Legacy copy of our OWN file without markers (pre-managed-block).
            // Version-gate, then back up the user's copy and drop in the new file.
            const destVersion = ExtensionUtils.readApiVersionFromText(destText);
            if (destVersion !== null && destVersion >= srcVersion) {
                return cb(null, 'up_to_date');
            }
            try {
                const backup = destPath + '.bak';
                try { fs.unlinkSync(backup); } catch { /* no previous backup */ }
                fs.renameSync(destPath, backup);
            } catch {
                /* best effort; overwrite below if rename fails */
            }
            fs.writeFileSync(destPath, srcText);
            return cb(null, 'replaced_legacy');
        } catch (e) {
            return cb(e);
        }
    }

    private static tryUnlinkBak(destPath: string) {
        try { fs.unlinkSync(destPath + '.bak'); } catch { /* no backup to clean */ }
    }

    private static SKILL_MARKER_RE = /SN-SCRIPTSYNC:SKILL/;

    private static walkFiles(dir: string): string[] {
        const out: string[] = [];
        let entries: any[] = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
        for (const entry of entries) {
            const abs = nodePath.join(dir, entry.name);
            if (entry.isDirectory()) out.push(...ExtensionUtils.walkFiles(abs));
            else out.push(abs);
        }
        return out;
    }

    private static removeEmptyDirs(dir: string) {
        let entries: any[] = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const sub = nodePath.join(dir, entry.name);
            ExtensionUtils.removeEmptyDirs(sub);
            try { if (fs.readdirSync(sub).length === 0) fs.rmdirSync(sub); } catch { /* best effort */ }
        }
    }

    /**
     * Mirror the extension's generated agent skills into the user's workspace and
     * reconcile the destination against the build manifest (issue #148).
     *
     * - Each file listed in `_skills.json` is copied (written only when changed).
     * - The manifest itself is mirrored so the tree is self-describing.
     * - CONTROLLED DELETE: any file under `destSkillsDir` that carries the
     *   `SN-SCRIPTSYNC:SKILL` marker but is NOT in the manifest is removed, so
     *   renamed/removed skills don't accumulate across updates. Files WITHOUT the
     *   marker (user-authored content) are never touched.
     *
     * Calls `cb(err, { copied, removed })`.
     */
    syncManagedSkills(sourceSkillsDir: string, destSkillsDir: string, cb: Function) {
        try {
            const manifestPath = nodePath.join(sourceSkillsDir, '_skills.json');
            if (!fs.existsSync(manifestPath)) {
                return cb(new Error(`skills manifest missing: ${manifestPath}`));
            }

            const srcManifestText: string = fs.readFileSync(manifestPath, 'utf8');
            const manifest = JSON.parse(srcManifestText);
            const files: string[] = Array.isArray(manifest.files) ? manifest.files : [];
            const expected = new Set<string>(files.map((f) => f.split('/').join(nodePath.sep)));

            fs.mkdirSync(destSkillsDir, { recursive: true });

            let copied = 0;
            for (const rel of files) {
                const relNative = rel.split('/').join(nodePath.sep);
                const src = nodePath.join(sourceSkillsDir, relNative);
                const dst = nodePath.join(destSkillsDir, relNative);
                if (!fs.existsSync(src)) continue;
                const srcText: string = fs.readFileSync(src, 'utf8');
                const dstText: string | null = fs.existsSync(dst) ? fs.readFileSync(dst, 'utf8') : null;
                if (dstText !== srcText) {
                    fs.mkdirSync(getDirName(dst), { recursive: true });
                    fs.writeFileSync(dst, srcText);
                    copied++;
                }
            }

            const destManifest = nodePath.join(destSkillsDir, '_skills.json');
            if (!fs.existsSync(destManifest) || fs.readFileSync(destManifest, 'utf8') !== srcManifestText) {
                fs.writeFileSync(destManifest, srcManifestText);
            }

            let removed = 0;
            for (const abs of ExtensionUtils.walkFiles(destSkillsDir)) {
                const rel = nodePath.relative(destSkillsDir, abs);
                if (rel === '_skills.json' || expected.has(rel)) continue;
                let text = '';
                try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
                if (ExtensionUtils.SKILL_MARKER_RE.test(text)) {
                    try { fs.unlinkSync(abs); removed++; } catch { /* best effort */ }
                }
            }
            ExtensionUtils.removeEmptyDirs(destSkillsDir);

            return cb(null, { copied, removed });
        } catch (e) {
            return cb(e);
        }
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
        var path = getWorkspaceRoot() + nodePath.sep + instance.name + nodePath.sep + "_settings.json";
        fs.mkdir(getDirName(path), {recursive: true}, function (err) {
            fs.writeFile(path, JSON.stringify(instance, null, 4), (error) => { /* handle error */ });
        });
        instanceSettings[instance.name] = instance;
    }

    getInstanceSettings(instanceName: string) {
        if (typeof instanceSettings[instanceName] != 'undefined') { //from variable if available
            return instanceSettings[instanceName];
        }
        else {
            const newPath = getWorkspaceRoot() + nodePath.sep + instanceName + nodePath.sep + "_settings.json";
            const oldPath = getWorkspaceRoot() + nodePath.sep + instanceName + nodePath.sep + "settings.json";
            
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
        let content = '';
        try {
            content = (typeof listener === 'string') ? fs.readFileSync(listener, 'utf-8') : listener.getText();
        } catch {
            return true;
        }

        var fileNameUse = fileName.replace(getWorkspaceRoot(), "");
        var fileNameArr = fileNameUse.split(/\\|\/|\.|\^/).slice(1);//
        var basePath = getWorkspaceRoot() + nodePath.sep + fileNameArr[0]+ nodePath.sep;
        let fullPath = basePath + fileNameArr[1]+ nodePath.sep + fileNameArr[2]+ nodePath.sep

        if (fileNameArr[5] === "ts") {
            return true;
        }

        // ng-templates synced from a widget are written into a `sp_ng_template`
        // folder with a `<field>^<sys_name>^<sys_id>.<ext>` filename, e.g.
        // <instance>/<scope>/sp_widget/<widgetName>/sp_ng_template/template^myTpl^<sys_id>.html
        // The '.'-split positional parsing below can't handle this (the sys_name may
        // contain dots, and the folder can be nested at varying depths), so detect it
        // by the parent folder + '^' filename format and parse the basename directly.
        if (nodePath.basename(nodePath.dirname(fileName)) === 'sp_ng_template') {
            let baseName = nodePath.basename(fileName);
            let parts = baseName.split('^');
            if (parts.length >= 3) {
                let lastSegment = parts[parts.length - 1];
                var scriptObj = <any>{};
                scriptObj.instance = this.getInstanceSettings(fileNameArr[0]);
                scriptObj.tableName = 'sp_ng_template';
                scriptObj.fieldName = parts[0];
                scriptObj.name = parts.slice(1, parts.length - 1).join('^');
                scriptObj.sys_id = lastSegment.replace(/\.[^.]+$/, ''); // strip trailing extension, leaving the sys_id
                scriptObj.scopeName = fileNameArr[1];
                scriptObj.fileName = fileName;
                scriptObj.content = content;

                if (!this.isValidParsedScriptObject(scriptObj)) {
                    return true;
                }
                return scriptObj;
            }
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


            if (!this.isValidParsedScriptObject(scriptObj)) {
                return true;
            }
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
        if (!this.isValidParsedScriptObject(scriptObj)) {
            return true;
        }
        return scriptObj;

    }

    isValidParsedScriptObject(scriptObj: any): boolean {
        if (!scriptObj || typeof scriptObj !== 'object') return false;
        if (!scriptObj.fileName || !scriptObj.tableName || !scriptObj.fieldName) return false;
        if (!scriptObj.instance || typeof scriptObj.instance !== 'object') return false;
        if (!scriptObj.instance.name || !scriptObj.instance.url) return false;
        if (typeof scriptObj.content !== 'string') return false;
        return true;
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
