import * as vscode from "vscode";
import { LabelTreeDataProvider } from "./views/LabelTreeDataProvider";
import { SessionTreeDataProvider } from "./views/SessionTreeDataProvider";

export function activate(context: vscode.ExtensionContext): void {
  const labelProvider = new LabelTreeDataProvider();
  const sessionProvider = new SessionTreeDataProvider();

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(
      "copilotCostTracker.labels",
      labelProvider
    ),
    vscode.window.registerTreeDataProvider(
      "copilotCostTracker.sessions",
      sessionProvider
    )
  );

  // --- Command stubs (fully implemented in later phases) ---
  const stub = (name: string) =>
    vscode.commands.registerCommand(name, () => {
      vscode.window.showInformationMessage(
        `${name} is not implemented yet (Phase 1 scaffold).`
      );
    });

  context.subscriptions.push(
    stub("copilotCostTracker.openDashboard"),
    stub("copilotCostTracker.addLabel"),
    stub("copilotCostTracker.renameLabel"),
    stub("copilotCostTracker.deleteLabel"),
    stub("copilotCostTracker.assignLabel"),
    vscode.commands.registerCommand(
      "copilotCostTracker.refreshSessions",
      () => sessionProvider.refresh()
    )
  );
}

export function deactivate(): void {
  // no-op
}
