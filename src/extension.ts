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

  const sessionsView = vscode.window.createTreeView(
    "copilotCostTracker.sessions",
    { treeDataProvider: sessionProvider }
  );
  sessionProvider.setTreeView(sessionsView);

  context.subscriptions.push(
    sessionsView,
    vscode.window.registerTreeDataProvider(
      "copilotCostTracker.labels",
      labelProvider
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
    ),
    vscode.commands.registerCommand(
      "copilotCostTracker.filterSessions",
      () => filterSessions(state, sessionProvider)
    ),
    vscode.commands.registerCommand(
      "copilotCostTracker.clearFilter",
      () => sessionProvider.clearFilter()
    )
  );
}

/** Shows a multi-select QuickPick of labels (plus "Unassigned") to filter sessions. */
async function filterSessions(
  state: StateManager,
  provider: SessionTreeDataProvider
): Promise<void> {
  const labels = state.getLabels();
  const active = provider.getFilter();

  type Pick = vscode.QuickPickItem & { id: string };
  const items: Pick[] = [
    ...labels.map<Pick>((l) => ({
      label: l.name,
      id: l.id,
      picked: active?.has(l.id) ?? false,
    })),
    {
      label: "Unassigned",
      description: "Sessions with no label",
      id: SessionTreeDataProvider.UNASSIGNED,
      picked: active?.has(SessionTreeDataProvider.UNASSIGNED) ?? false,
    },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: "Filter Sessions by Label",
    placeHolder: "Select labels to show (none = show all)",
    canPickMany: true,
  });

  // Cancelled (Escape): leave the current filter untouched.
  if (picked === undefined) {
    return;
  }
  provider.setFilter(picked.map((p) => p.id));
}

export function deactivate(): void {
  // no-op
}
