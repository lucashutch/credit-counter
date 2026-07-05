import * as vscode from "vscode";
import { randomUUID } from "crypto";
import { Label } from "../data/types";

const LABELS_KEY = "creditCounter.labels";
const ASSIGNMENTS_KEY = "creditCounter.assignments";

/** Map of sessionId -> labelId. */
type AssignmentMap = Record<string, string>;

/**
 * Persists labels and session→label assignments using the extension's
 * `globalState`, so they survive reloads and apply across workspaces.
 */
export class StateManager {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /** Fires whenever labels or assignments change. */
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  // --- Labels -------------------------------------------------------------

  getLabels(): Label[] {
    return this.context.globalState.get<Label[]>(LABELS_KEY, []);
  }

  /** Adds a new label. Returns the created label, or undefined if the name is a duplicate. */
  async addLabel(name: string): Promise<Label | undefined> {
    const trimmed = name.trim();
    if (!trimmed) {
      return undefined;
    }
    const labels = this.getLabels();
    if (labels.some((l) => l.name.toLowerCase() === trimmed.toLowerCase())) {
      return undefined;
    }
    const label: Label = { id: randomUUID(), name: trimmed };
    await this.saveLabels([...labels, label]);
    return label;
  }

  /** Renames a label. Returns false if not found or the new name duplicates another. */
  async renameLabel(id: string, name: string): Promise<boolean> {
    const trimmed = name.trim();
    if (!trimmed) {
      return false;
    }
    const labels = this.getLabels();
    const target = labels.find((l) => l.id === id);
    if (!target) {
      return false;
    }
    if (
      labels.some(
        (l) => l.id !== id && l.name.toLowerCase() === trimmed.toLowerCase()
      )
    ) {
      return false;
    }
    target.name = trimmed;
    await this.saveLabels(labels);
    return true;
  }

  /** Deletes a label and clears any assignments that referenced it. */
  async deleteLabel(id: string): Promise<void> {
    const labels = this.getLabels().filter((l) => l.id !== id);
    await this.saveLabels(labels);

    // Cascade: drop assignments pointing at the removed label.
    const assignments = this.getAssignments();
    let changed = false;
    for (const sessionId of Object.keys(assignments)) {
      if (assignments[sessionId] === id) {
        delete assignments[sessionId];
        changed = true;
      }
    }
    if (changed) {
      await this.context.globalState.update(ASSIGNMENTS_KEY, assignments);
    }
  }

  // --- Assignments --------------------------------------------------------

  getAssignments(): AssignmentMap {
    return { ...this.context.globalState.get<AssignmentMap>(ASSIGNMENTS_KEY, {}) };
  }

  getAssignment(sessionId: string): string | undefined {
    return this.getAssignments()[sessionId];
  }

  /** Assigns a label to a session, or clears it when labelId is undefined. */
  async assignLabel(sessionId: string, labelId?: string): Promise<void> {
    const assignments = this.getAssignments();
    if (labelId) {
      assignments[sessionId] = labelId;
    } else {
      delete assignments[sessionId];
    }
    await this.context.globalState.update(ASSIGNMENTS_KEY, assignments);
    this._onDidChange.fire();
  }

  // --- Internal -----------------------------------------------------------

  private async saveLabels(labels: Label[]): Promise<void> {
    await this.context.globalState.update(LABELS_KEY, labels);
    this._onDidChange.fire();
  }
}
