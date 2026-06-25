import * as vscode from "vscode";
import { LabelTreeDataProvider } from "./views/LabelTreeDataProvider";
import { SessionTreeDataProvider } from "./views/SessionTreeDataProvider";
import { StateManager } from "./state/StateManager";
import { SessionReader } from "./data/SessionReader";
import { registerLabelCommands } from "./commands";

export function activate(context: vscode.ExtensionContext): void {
  const state = new StateManager(context);
  const reader = new SessionReader(context);
  const labelProvider = new LabelTreeDataProvider(state);
  const sessionProvider = new SessionTreeDataProvider(reader, state);

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

  // Label CRUD (Phase 2).
  context.subscriptions.push(...registerLabelCommands(state));

  // --- Command stubs (implemented in later phases) ---
  const stub = (name: string) =>
    vscode.commands.registerCommand(name, () => {
      vscode.window.showInformationMessage(
        `${name} is not implemented yet.`
      );
    });

  context.subscriptions.push(
    stub("copilotCostTracker.openDashboard"),
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
