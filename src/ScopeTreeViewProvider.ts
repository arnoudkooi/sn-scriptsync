import { window, workspace, commands, Disposable, ExtensionContext, StatusBarAlignment, StatusBarItem, TextDocument } from 'vscode';

import { ExtensionUtils } from "./ExtensionUtils";
import * as path from "path";
import * as vscode from "vscode";
import { Constants } from './constants';
let idx = 0;

let fs = require('fs');
let getDirName = require('path').dirname;
const nodePath = require('path');
let eu = new ExtensionUtils();

let cnt = 0;


export class ScopeTreeViewProvider implements vscode.TreeDataProvider<TreeItem> {
  onDidChangeTreeData?: vscode.Event<TreeItem | null | undefined> | undefined;

  data: TreeItem[];
  scriptFields : any;
  instance : any;
  scope : any;
  scopeTree : any;

  constructor(tree: any, scriptFields: any, instance : any) {

    let scopeTree = tree.scopeTree;

    let items: TreeItem[] = new Array<TreeItem>();
    Object.keys(scopeTree || {}).forEach(group => {
        let tablesData = scopeTree[group];
        let groupName = scriptFields.tableGroups[group] || "Other";
        let meta = {
          "group" : group
        };
        items.push(new TreeItem(groupName, "", meta ,null, tablesData));
    })
    this.data = items;
    this.scriptFields = scriptFields;
    this.instance = instance;
    this.scope = tree.scopeMeta
    this.scopeTree = tree.scopeTree;

  }

  getTreeItem(element: TreeItem): vscode.TreeItem | Thenable<vscode.TreeItem> {
    return element;
  }

  getChildren(element?: TreeItem | undefined): vscode.ProviderResult<TreeItem[]> {
    let meta = JSON.parse(JSON.stringify(element?.meta || {}));
    // if (idx ==160 || meta?.sysIdParent == '0cb994324fc9bf009881c5c18110c741'){
    //   let x =1;
    // }
    let items: TreeItem[] = new Array<TreeItem>();
    if (element === undefined) {
      return this.data;
    }
    else if (Object.keys(element.children || {}).length) {
      let meta = JSON.parse(JSON.stringify(element.meta));
      let children: any = element.children;
      Object.keys(children[children?.type] || {}).forEach(child => {
        meta = JSON.parse(JSON.stringify(meta));
        if (children?.type == 'tables' ) {
            let tableName = this.scriptFields.tableFields[child].label
            let records = children.tables[child];
            meta.tableName = child;
            children.type = 'tables';
            items.push(new TreeItem(tableName, child, meta, null, records));
        }
        else if (children?.type == 'records') {
          if (meta.tableName == 'sp_container'){
            let x =1;
          }
          let recordName = children.records[child].name || 'SysId: ' + child; 
          let fields: any =  {
            type: 'fields',
            fields : {
              codeFields: children.records[child].codeFields,
              referenceFields: children.records[child].referenceFields,
              codeChildReferences: this.scriptFields.tableFields[meta.tableName]?.codeChildReferences
            }
          }
          meta.sysId = child;
          meta.sysIdParent = child;
          meta.name = children.records[child].name || child;
          items.push(new TreeItem(recordName, children.records[child].updated , meta, null, fields));
        }
        else if (children?.type == 'fields') {


          if (child == 'codeFields'){

            Object.keys(children.fields?.codeFields || {}).forEach(child => {
              let fieldLabel = children?.fields?.codeFields[child]?.label
              meta.fieldName = child + '';
              meta.fieldLabel = fieldLabel;
              meta.fieldType = children.fields?.codeFields[child]?.type;
              meta.extension = Constants.FIELDTYPES[meta.fieldType].extension;
              meta.instance = this.instance;
              meta.scope = this.scope;
              items.push(new TreeItem(child + meta.extension, fieldLabel, meta, meta.extension , []));
            });
          }
          else if (child == 'referenceFields' && children.fields?.referenceFields){

            let referenceFields = children.fields.referenceFields;
            Object.keys(referenceFields || {}).forEach(tbl => {
                let group = this.scriptFields.tableFields[meta.tableName].group || 'other';
                let subrecords = this.scopeTree[group]?.tables[tbl]?.records;
                if (subrecords){

                    //items.push(new TreeItem("No code fields", "None", meta, null, []));
                  
                }

            });
            
          }
          else if (child == 'codeChildReferences' && children.fields?.codeChildReferences){

            let codeChildReferences = children.fields.codeChildReferences;
            Object.keys(codeChildReferences || {}).forEach(tbl => {

                let group = this.scriptFields.tableFields[meta.tableName].group || 'other';
                let subrecords = this.scopeTree[group]?.tables[tbl]?.records;
                let matchedSubRecords = {};
                if (subrecords){
                  Object.keys(codeChildReferences[tbl] || {}).forEach(field => {

                    Object.keys(subrecords || {}).forEach(subrecordId =>{
                      if (subrecords[subrecordId]?.referenceFields && subrecords[subrecordId]?.referenceFields[field] == meta.sysIdParent)
                          matchedSubRecords[subrecordId] = subrecords[subrecordId];
                    })
                    
                  })

                  if (Object.keys(matchedSubRecords || {}).length){

                    if (meta.tableName == 'sp_container'){
                      let x =1;
                    }
          
                    let tableObj = this.scriptFields.tableFields[tbl];
                    let records : any = {
                      type : 'records',
                      records : matchedSubRecords
                    }
                    meta.tableName = tbl;
                    items.push(new TreeItem(tableObj.label, "Related List", meta, null, records));
                  }
                }

            });
            
          }
        }
        else {
          //var x = 2; //for debugging
        }
      });
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

  constructor(label: string, tooltip: string, meta:any, extension, children?: any) {
    meta = JSON.parse(JSON.stringify(meta));
    if (meta?.tableName == 'sp_widget'){
      let x = 1;
    }

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
      this.iconPath = {
        light: path.join(__filename, '..', '..', 'resources', 'images', extension.replace('.','') + '.svg'),
        dark: path.join(__filename, '..', '..', 'resources', 'images', extension.replace('.','') + '.svg')
      };
      this.command = {command: 'openFile', title: 'Open file',  arguments: [meta]}
    }
  }
}



