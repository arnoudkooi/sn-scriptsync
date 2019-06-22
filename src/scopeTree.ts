import { window, workspace, commands, Disposable, ExtensionContext, StatusBarAlignment, StatusBarItem, TextDocument } from 'vscode';

import { ExtensionUtils } from "./ExtensionUtils";
import * as path from "path";
import * as vscode from "vscode";
import { open } from 'fs';
let idx = 0;

let fs = require('fs');
let mkdirp = require('mkdirp');
let getDirName = require('path').dirname;
const nodePath = require('path');
let eu = new ExtensionUtils();



export class ScopeTreeViewProvider implements vscode.TreeDataProvider<TreeItem> {
  onDidChangeTreeData?: vscode.Event<TreeItem | null | undefined> | undefined;

  data: TreeItem[];
  scriptFields: {};
  scriptFieldMeta: {}

  constructor(dta: any, scriptFields: any) {

    let items: TreeItem[] = new Array<TreeItem>();
    let artf: object = dta.result.artifacts;
    for (let o in artf) {
      if (["Forms & UI", "Server Development", "Client Development", "Inbound Integrations", "Outbound Integrations"].indexOf(artf[o]['id']) > -1) {
        var meta = {
          "instance" : dta.instance
        };
        items.push(new TreeItem(artf[o].name, artf[o]['helpText'], meta ,null, artf[o].types));
      }
    }
    this.data = items;
    this.scriptFields = scriptFields;

    this.scriptFieldMeta = {
      "css": { "order": 10, "extension": "scss" },
      "email_script": { "order": 5, "extension": "js" },
      "html": { "order": 6, "extension": "html" },
      "html_script": { "order": 7, "extension": "html" },
      "html_template": { "order": 8, "extension": "html" },
      "script": { "order": 1, "extension": "js" },
      "script_plain": { "order": 2, "extension": "js" },
      "script_server": { "order": 3, "extension": "js" },
      "translated_html": { "order": 4, "extension": "html" },
      "xml": { "order": 9, "extension": "xml" }
    }

  }

  getTreeItem(element: TreeItem): vscode.TreeItem | Thenable<vscode.TreeItem> {
    return element;
  }

  getChildren(element?: TreeItem | undefined): vscode.ProviderResult<TreeItem[]> {
    let items: TreeItem[] = new Array<TreeItem>();
    if (element === undefined) {
      return this.data;
    }
    else if (element.children.length > 0) {
      
      let childs: Array<Object> = element.children;
      for (let o in childs) {
        let meta = JSON.parse(JSON.stringify(element.meta));
        if (!childs[o].hasOwnProperty('metadata')) childs[o]['metadata'] = [];

        let name: string = childs[o]['name'] + '';
        if (childs[o].hasOwnProperty('sysId')) {
          if (!name.includes('var__m')) {
            name = name.replace(/[^a-z0-9_\-+]+/gi, ' ');
            let table = childs[o]['id'].split(".")[0];
            let fields = this.scriptFields[table];
            meta['type'] = 'record';
            meta['name'] = name;
            meta['sys_id'] = childs[o]['sysId'];
            items.push(new TreeItem(name, childs[o]['sysId'], meta, null, fields));
          }
        }
        else if (childs[o].hasOwnProperty('artifacts')) {
          if (childs[o].hasOwnProperty('recordType') && childs[o]['artifacts'].length){
            meta['type'] = 'table';
            meta['tableName'] = childs[o]['recordType'];
            meta['tableLabel'] = childs[o]['name'];
            items.push(new TreeItem(name, childs[o]['helpText'], meta, null, childs[o]['artifacts']));
          }
        }
        else if (childs[o].hasOwnProperty('fieldName')) {
          var extension = this.scriptFieldMeta[childs[o]['type']].extension;
            meta['type'] = 'field';
            meta['fieldName'] = childs[o]['fieldName'];
            meta['extension'] = extension;
          items.push(new TreeItem(childs[o]['label'], JSON.stringify(meta), meta, extension));
        }
        else {
          //var x = 2; //for debugging
        }
      }
      return items;
    }
    return null;

  }
}

class TreeItem extends vscode.TreeItem {
  children: object[] | undefined;
  parent: TreeItem | undefined;
  extension : string;
  meta : {};

  constructor(label: string, tooltip: string, meta:{}, extension, children?: object[]) {
    super(
      label,
      children === undefined || children.length == 0 ?
        vscode.TreeItemCollapsibleState.None :
        vscode.TreeItemCollapsibleState.Expanded);
    this.children = children;
    this.tooltip = tooltip;
    this.extension = extension;
    this.meta = meta;
    if (extension) {
      this.iconPath = path.join(__filename, '..', '..', 'resources', 'images', extension + '.svg');
      this.command = {command: 'openFile', title: 'Open file',  arguments: [meta]}
    }
  }
}



