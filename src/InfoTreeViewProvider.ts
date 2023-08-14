import * as vscode from 'vscode';

export class InfoTreeViewProvider implements vscode.TreeDataProvider<TreeItem> {
  onDidChangeTreeData?: vscode.Event<TreeItem | null | undefined> | undefined;

  data: TreeItem[];

  constructor() {
    this.data = [
      new TreeItem('Actions',{},[
        new TreeItem('Load / Refresh Tree', { action : 'refreshTree'}),
        new TreeItem('Load Scope', { action : 'loadScope'}),
        new TreeItem('Open in Instance', { action : 'openInInstance'})
      ]),
      new TreeItem('Links',{},[
      new TreeItem('arnoudkooi.com', { action : 'openUrl', url : 'https://www.arnoudkooi.com' }),
      new TreeItem('github.com/arnoudkooi', { action : 'openUrl', url : 'https://github.com/arnoudkooi' }),
      new TreeItem('Join sndevs slack channel #snutils', { action : 'openUrl', url : 'https://invite.sndevs.com' })
      ])
    ]
  }

  getTreeItem(element: TreeItem): vscode.TreeItem|Thenable<vscode.TreeItem> {
    return element;
  }

  getChildren(element?: TreeItem|undefined): vscode.ProviderResult<TreeItem[]> {
    if (element === undefined) {
      return this.data;
    }
    return element.children;
  }
}

class TreeItem extends vscode.TreeItem {
  children: TreeItem[]|undefined;


  constructor(label: string, args:any, children?: TreeItem[]) {
    super(
        label,
        children === undefined ? vscode.TreeItemCollapsibleState.None :
                                 vscode.TreeItemCollapsibleState.Expanded);
    this.children = children;
    if (children === undefined)
      this.command = {command: "infoTreeCommand"  , title: 'Open page',  arguments: [{ action: args.action, url : args.url }]};
  }
}

