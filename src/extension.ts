import * as vscode from "vscode";
import { LabelTreeDataProvider } from "./views/LabelTreeDataProvider";
import { SessionTreeDataProvider } from "./views/SessionTreeDataProvider";
import { StateManager } from "./state/StateManager";
import { SessionReader } from "./data/SessionReader";
import { ClaudeCodeReader } from "./data/ClaudeCodeReader";
import { OpenCodeReader } from "./data/OpenCodeReader";
import { AggregateReader } from "./data/SessionSource";
import { DashboardPanel } from "./dashboard/DashboardPanel";
import { registerLabelCommands, registerSessionCommands } from "./commands";

export function activate(context: vscode.ExtensionContext): void {
  const state = new StateManager(context);
  // Merge every cost source (Copilot + Claude Code + OpenCode) behind one reader.
  const reader = new AggregateReader([
    new SessionReader(context),
    new ClaudeCodeReader(context),
    new OpenCodeReader(context),
  ]);
  const labelProvider = new LabelTreeDataProvider(state);
  const sessionProvider = new SessionTreeDataProvider(reader, state);

  const sessionsView = vscode.window.createTreeView(
    "creditCounter.sessions",
    { treeDataProvider: sessionProvider }
  );
  sessionProvider.setTreeView(sessionsView);

  context.subscriptions.push(
    sessionsView,
    vscode.window.registerTreeDataProvider(
      "creditCounter.labels",
      labelProvider
    )
  );

  // Label CRUD (Phase 2).
  context.subscriptions.push(...registerLabelCommands(state));

  // Session label assignment (Phase 4).
  context.subscriptions.push(
    ...registerSessionCommands(
      state,
      (item) => item ?? sessionProvider.getSelectedItem()
    )
  );

  // Dashboard (Phase 5).
  // Re-scan when the OpenCode data-root list changes.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("creditCounter.opencode.dataRoots")) {
        sessionProvider.refresh();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("creditCounter.openDashboard", () =>
      DashboardPanel.show(context.extensionUri, reader, state)
    ),
    vscode.commands.registerCommand(
      "creditCounter.refreshSessions",
      () => sessionProvider.refresh()
    ),
    vscode.commands.registerCommand(
      "creditCounter.filterSessions",
      () => filterSessions(state, sessionProvider)
    ),
    vscode.commands.registerCommand(
      "creditCounter.clearFilter",
      () => sessionProvider.clearFilter()
    ),
    vscode.commands.registerCommand(
      "creditCounter.filterByDate",
      () => filterByDate(sessionProvider)
    ),
    vscode.commands.registerCommand(
      "creditCounter.showHidden",
      () => sessionProvider.setShowHidden(true)
    ),
    vscode.commands.registerCommand(
      "creditCounter.hideHidden",
      () => sessionProvider.setShowHidden(false)
    )
  );
}

/**
 * Prompts for a date range (presets or a custom range) and applies it as a
 * filter. Choosing "All time" clears the date filter.
 */
async function filterByDate(provider: SessionTreeDataProvider): Promise<void> {
  type RangePick = vscode.QuickPickItem & { kind?: never; make?: () => void };
  const now = new Date();
  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const daysAgo = (n: number) => startOfDay(new Date(Date.now() - n * 86400000));

  const picks: RangePick[] = [
    {
      label: "$(clock) All time",
      description: "Clear the date filter",
      make: () => provider.setDateRange(undefined, undefined),
    },
    {
      label: "$(calendar) Last 7 days",
      make: () => provider.setDateRange(daysAgo(6), undefined, "Last 7 days"),
    },
    {
      label: "$(calendar) Last 30 days",
      make: () => provider.setDateRange(daysAgo(29), undefined, "Last 30 days"),
    },
    {
      label: "$(calendar) This month",
      make: () =>
        provider.setDateRange(
          new Date(now.getFullYear(), now.getMonth(), 1).getTime(),
          undefined,
          "This month"
        ),
    },
    {
      label: "$(calendar) Last month",
      make: () =>
        provider.setDateRange(
          new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime(),
          new Date(now.getFullYear(), now.getMonth(), 1).getTime() - 1,
          "Last month"
        ),
    },
    {
      label: "$(calendar) This year",
      make: () =>
        provider.setDateRange(
          new Date(now.getFullYear(), 0, 1).getTime(),
          undefined,
          "This year"
        ),
    },
    {
      label: "$(edit) Custom range…",
      description: "Enter start and end dates",
    },
  ];

  const choice = await vscode.window.showQuickPick(picks, {
    title: "Filter Sessions by Date",
    placeHolder: "Select a date range",
  });
  if (!choice) {
    return;
  }
  if (choice.make) {
    choice.make();
    return;
  }
  await promptCustomRange(provider);
}

/** Prompts for explicit start/end dates (YYYY-MM-DD) and applies the range. */
async function promptCustomRange(
  provider: SessionTreeDataProvider
): Promise<void> {
  const parse = (value: string): number | undefined => {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const ms = Date.parse(trimmed);
    return Number.isNaN(ms) ? undefined : ms;
  };
  const validate = (value: string): string | null =>
    !value.trim() || parse(value) !== undefined
      ? null
      : "Use a date like 2026-06-01 (or leave blank).";

  const startStr = await vscode.window.showInputBox({
    title: "Custom Date Range — Start",
    prompt: "Start date (YYYY-MM-DD), or blank for no lower bound",
    placeHolder: "2026-06-01",
    validateInput: validate,
  });
  if (startStr === undefined) {
    return;
  }
  const endStr = await vscode.window.showInputBox({
    title: "Custom Date Range — End",
    prompt: "End date (YYYY-MM-DD, inclusive), or blank for no upper bound",
    placeHolder: "2026-06-30",
    validateInput: validate,
  });
  if (endStr === undefined) {
    return;
  }

  const start = parse(startStr);
  // Make the end bound inclusive of the whole day.
  let end = parse(endStr);
  if (end !== undefined) {
    end += 86400000 - 1;
  }
  if (start === undefined && end === undefined) {
    provider.setDateRange(undefined, undefined);
    return;
  }
  const fmt = (ms?: number) =>
    ms === undefined ? "…" : new Date(ms).toLocaleDateString();
  provider.setDateRange(start, end, `${fmt(start)} – ${fmt(end)}`);
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
  const sources = provider.getSources();
  const active = provider.getFilter();

  type Pick = vscode.QuickPickItem & {
    id?: string;
    dimension?: "label" | "repo" | "source";
  };

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

  // --- Sources section ---------------------------------------------------
  if (sources.length > 1) {
    items.push({
      label: "Sources",
      kind: vscode.QuickPickItemKind.Separator,
    });
    for (const s of sources) {
      items.push({
        label: s.name,
        id: s.key,
        dimension: "source",
        picked: active.sources?.has(s.key) ?? false,
      });
    }
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: "Filter Sessions by Label, Repository, and Source",
    placeHolder: "Select labels, repositories, and/or sources (none = show all)",
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
  const sourceKeys = picked
    .filter((p) => p.dimension === "source" && p.id)
    .map((p) => p.id as string);
  provider.setFilter(labelIds, repoKeys, sourceKeys);
}

export function deactivate(): void {
  // no-op
}
