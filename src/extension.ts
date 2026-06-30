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

/**
 * Shows a multi-select QuickPick split into two sections — Labels and
 * Repositories — letting the user pick any combination. A session is shown only
 * when it satisfies both dimensions (AND): its label is among the picked labels
 * (if any) and its repository is among the picked repositories (if any).
 */
async function filterSessions(
  state: StateManager,
  provider: SessionTreeDataProvider
): Promise<void> {
  const labels = state.getLabels();
  const repos = provider.getRepos();
  const active = provider.getFilter();

  type Pick = vscode.QuickPickItem & { id?: string; dimension?: "label" | "repo" };

  const items: Pick[] = [];

  // --- Labels section ----------------------------------------------------
  items.push({ label: "Labels", kind: vscode.QuickPickItemKind.Separator });
  for (const l of labels) {
    items.push({
      label: l.name,
      id: l.id,
      dimension: "label",
      picked: active.labels?.has(l.id) ?? false,
    });
  }
  items.push({
    label: "Unassigned",
    description: "Sessions with no label",
    id: SessionTreeDataProvider.UNASSIGNED,
    dimension: "label",
    picked: active.labels?.has(SessionTreeDataProvider.UNASSIGNED) ?? false,
  });

  // --- Repositories section ---------------------------------------------
  if (repos.length > 0) {
    items.push({
      label: "Repositories",
      kind: vscode.QuickPickItemKind.Separator,
    });
    for (const r of repos) {
      items.push({
        label: r.name,
        id: r.key,
        dimension: "repo",
        picked: active.repos?.has(r.key) ?? false,
      });
    }
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: "Filter Sessions by Label and Repository",
    placeHolder: "Select labels and/or repositories (none = show all)",
    canPickMany: true,
  });

  // Cancelled (Escape): leave the current filter untouched.
  if (picked === undefined) {
    return;
  }

  const labelIds = picked
    .filter((p) => p.dimension === "label" && p.id)
    .map((p) => p.id as string);
  const repoKeys = picked
    .filter((p) => p.dimension === "repo" && p.id)
    .map((p) => p.id as string);
  provider.setFilter(labelIds, repoKeys);
}

export function deactivate(): void {
  // no-op
}
