import * as vscode from "vscode";

/**
 * Placeholder provider for the Chat Sessions view (Phase 1).
 * Real data ingestion arrives in Phase 3.
 */
export class SessionTreeDataProvider
  implements vscode.TreeDataProvider<vscode.TreeItem>
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    vscode.TreeItem | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.ProviderResult<vscode.TreeItem[]> {
    // Phase 1: placeholder row until the session reader lands in Phase 3.
    const item = new vscode.TreeItem(
      "No sessions loaded yet",
      vscode.TreeItemCollapsibleState.None
    );
    item.iconPath = new vscode.ThemeIcon("comment-discussion");
    return [item];
  }
}
