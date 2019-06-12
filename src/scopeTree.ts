import * as path from "path";
import * as vscode from "vscode";
let idx = 0;

export class ScopeTreeViewProvider implements vscode.TreeDataProvider<TreeItem> {
  onDidChangeTreeData?: vscode.Event<TreeItem | null | undefined> | undefined;

  data: TreeItem[];
  scriptFields: {};

  scriptFieldMeta: {}

  constructor(dta: any, scriptFields: any) {

    let items: TreeItem[] = new Array<TreeItem>();
    let artf: object = dta.artifacts;
    for (let o in artf) {
      if (["Server Development", "Client Development", "Inbound Integrations", "Outbound Integrations"].includes(artf[o]['id'])) {
        items.push(new TreeItem(artf[o].name, artf[o]['helpText'], null, artf[o].types));
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
        let name: string = childs[o]['name'] + '';
        if (childs[o].hasOwnProperty('sysId')) {
          if (!name.includes('var__m')) {

            let table = childs[o]['id'].split(".")[0];
            let fields = this.scriptFields[table];
            items.push(new TreeItem(name, childs[o]['sysId'], null, fields));
          }
        }
        else if (childs[o].hasOwnProperty('artifacts')) {
          if (childs[o]['artifacts']) {
              items.push(new TreeItem(name, childs[o]['helpText'], null, childs[o]['artifacts']));
          }
        }
        else if (childs[o].hasOwnProperty('fieldName')) {
          var extension = this.scriptFieldMeta[childs[o]['type']].extension;
          items.push(new TreeItem(childs[o]['label'], childs[o]['type'], extension));
        }
        else {
          var x = 2;
        }
      }
      return items;
    }
    return null;

  }
}


class TreeItem extends vscode.TreeItem {
  children: object[] | undefined;
  constructor(label: string, tooltip: string, extension, children?: object[]) {
    super(
      label,
      children === undefined || children.length == 0 ?
        vscode.TreeItemCollapsibleState.None :
        vscode.TreeItemCollapsibleState.Expanded);
    this.children = children;
    this.tooltip = tooltip;
    if (extension) {
      this.iconPath = path.join(__filename, '..', '..', 'resources', 'images', extension + '.svg');

      this.command = {command: 'openFile', title: 'Open file',  arguments: [label]}
    }
  }
}
vscode.commands.registerCommand('openFile', (label) => {
  vscode.commands.executeCommand('vscode.open', vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(`https://google.com/?q=${label}`)));
});