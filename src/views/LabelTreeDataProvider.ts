import * as vscode from "vscode";
import { Label } from "../data/types";
import { StateManager } from "../state/StateManager";

/** Tree item that wraps a single {@link Label}. */
export class LabelTreeItem extends vscode.TreeItem {
  constructor(public readonly labelData: Label) {
    super(labelData.name, vscode.TreeItemCollapsibleState.None);
    this.id = labelData.id;
    this.contextValue = "label";
    this.iconPath = new vscode.ThemeIcon("tag");
    this.tooltip = labelData.name;
  }
}

/**
 * Renders the user's labels in the Label Management view and refreshes
 * automatically whenever the underlying state changes.
 */
export class LabelTreeDataProvider
  implements vscode.TreeDataProvider<LabelTreeItem>
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    LabelTreeItem | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly state: StateManager) {
    this.state.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: LabelTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.ProviderResult<LabelTreeItem[]> {
    return this.state.getLabels().map((label) => new LabelTreeItem(label));
  }
}
