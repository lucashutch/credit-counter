import * as vscode from "vscode";
import { LabelTreeDataProvider } from "./views/LabelTreeDataProvider";
import { SessionTreeDataProvider } from "./views/SessionTreeDataProvider";
import { StateManager } from "./state/StateManager";
import { SessionReader } from "./data/SessionReader";
import { DashboardPanel } from "./dashboard/DashboardPanel";
import { registerLabelCommands, registerSessionCommands } from "./commands";

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

  // Session label assignment (Phase 4).
  context.subscriptions.push(...registerSessionCommands(state));

  // Dashboard (Phase 5).
  context.subscriptions.push(
    vscode.commands.registerCommand("copilotCostTracker.openDashboard", () =>
      DashboardPanel.show(context.extensionUri, reader, state)
    ),
    vscode.commands.registerCommand(
      "copilotCostTracker.refreshSessions",
      () => sessionProvider.refresh()
    )
  );
}

export function deactivate(): void {
  // no-op
}
