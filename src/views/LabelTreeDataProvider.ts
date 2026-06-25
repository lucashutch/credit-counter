import * as vscode from "vscode";

/**
 * Placeholder provider for the Label Management view (Phase 1).
 * Real CRUD logic arrives in Phase 2.
 */
export class LabelTreeDataProvider
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
    // Phase 1: no labels yet — welcome content shows the "Open Dashboard" button.
    return [];
  }
}
