import * as vscode from "vscode";
import { StateManager } from "./state/StateManager";
import { LabelTreeItem } from "./views/LabelTreeDataProvider";
import { SessionTreeItem } from "./views/SessionTreeDataProvider";

/**
 * Registers the label CRUD commands. Returns disposables to be added to the
 * extension's subscriptions.
 */
export function registerLabelCommands(
  state: StateManager
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("copilotCostTracker.addLabel", () =>
      addLabel(state)
    ),
    vscode.commands.registerCommand(
      "copilotCostTracker.renameLabel",
      (item?: LabelTreeItem) => renameLabel(state, item)
    ),
    vscode.commands.registerCommand(
      "copilotCostTracker.deleteLabel",
      (item?: LabelTreeItem) => deleteLabel(state, item)
    ),
  ];
}

/**
 * Registers the session-related commands (label assignment).
 */
export function registerSessionCommands(
  state: StateManager
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(
      "copilotCostTracker.assignLabel",
      (item?: SessionTreeItem) => assignLabel(state, item)
    ),
  ];
}

async function assignLabel(
  state: StateManager,
  item?: SessionTreeItem
): Promise<void> {
  if (!item?.session) {
    vscode.window.showInformationMessage(
      "Right-click a chat session to assign a label."
    );
    return;
  }

  const labels = state.getLabels();
  if (labels.length === 0) {
    const action = await vscode.window.showInformationMessage(
      "No labels exist yet. Create one first?",
      "Add Label"
    );
    if (action === "Add Label") {
      await vscode.commands.executeCommand("copilotCostTracker.addLabel");
    }
    return;
  }

  const current = state.getAssignment(item.session.sessionId);

  type Pick = vscode.QuickPickItem & { id?: string; clear?: boolean };
  const picks: Pick[] = [
    {
      label: "$(circle-slash) Clear label",
      description: current ? "Remove the current label" : undefined,
      clear: true,
    },
    ...labels.map<Pick>((l) => ({
      label: l.name,
      id: l.id,
      picked: l.id === current,
      description: l.id === current ? "Currently assigned" : undefined,
    })),
  ];

  const choice = await vscode.window.showQuickPick(picks, {
    title: `Assign Label · ${item.session.firstPrompt}`,
    placeHolder: "Select a label for this session",
  });
  if (!choice) {
    return;
  }

  await state.assignLabel(
    item.session.sessionId,
    choice.clear ? undefined : choice.id
  );
}

async function addLabel(state: StateManager): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: "Add Label",
    prompt: "Enter a name for the new label",
    placeHolder: "e.g. Project Alpha",
    validateInput: (value) => validateName(state, value),
  });
  if (name === undefined) {
    return;
  }
  const created = await state.addLabel(name);
  if (!created) {
    vscode.window.showWarningMessage(
      `Could not add label "${name.trim()}".`
    );
  }
}

async function renameLabel(
  state: StateManager,
  item?: LabelTreeItem
): Promise<void> {
  const target = await resolveLabel(state, item);
  if (!target) {
    return;
  }
  const name = await vscode.window.showInputBox({
    title: "Rename Label",
    prompt: "Enter a new name for the label",
    value: target.name,
    validateInput: (value) => validateName(state, value, target.id),
  });
  if (name === undefined) {
    return;
  }
  const ok = await state.renameLabel(target.id, name);
  if (!ok) {
    vscode.window.showWarningMessage(
      `Could not rename label to "${name.trim()}".`
    );
  }
}

async function deleteLabel(
  state: StateManager,
  item?: LabelTreeItem
): Promise<void> {
  const target = await resolveLabel(state, item);
  if (!target) {
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    `Delete label "${target.name}"? This also removes it from any assigned sessions.`,
    { modal: true },
    "Delete"
  );
  if (confirm !== "Delete") {
    return;
  }
  await state.deleteLabel(target.id);
}

// --- Helpers --------------------------------------------------------------

/** Validates a label name for the input box. Returns an error string or null. */
function validateName(
  state: StateManager,
  value: string,
  excludeId?: string
): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return "Label name cannot be empty.";
  }
  const duplicate = state
    .getLabels()
    .some(
      (l) =>
        l.id !== excludeId &&
        l.name.toLowerCase() === trimmed.toLowerCase()
    );
  return duplicate ? "A label with this name already exists." : null;
}

/**
 * Resolves the label to act on. When invoked from the context menu the item is
 * provided directly; when invoked from the command palette we prompt the user
 * to pick one.
 */
async function resolveLabel(state: StateManager, item?: LabelTreeItem) {
  if (item?.labelData) {
    return item.labelData;
  }
  const labels = state.getLabels();
  if (labels.length === 0) {
    vscode.window.showInformationMessage("There are no labels to select.");
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    labels.map((l) => ({ label: l.name, id: l.id })),
    { title: "Select a label" }
  );
  return picked ? labels.find((l) => l.id === picked.id) : undefined;
}
