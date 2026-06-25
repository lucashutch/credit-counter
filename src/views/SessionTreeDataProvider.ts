import * as vscode from "vscode";
import { SessionCost } from "../data/types";
import { SessionReader } from "../data/SessionReader";
import { StateManager } from "../state/StateManager";

/** Tree item wrapping a single chat session. */
export class SessionTreeItem extends vscode.TreeItem {
  constructor(
    public readonly session: SessionCost,
    labelName: string | undefined
  ) {
    super(SessionTreeItem.makeLabel(session), vscode.TreeItemCollapsibleState.None);
    this.id = session.sessionId;
    this.contextValue = "session";
    this.iconPath = new vscode.ThemeIcon("comment-discussion");

    const credits = session.totalCredits.toFixed(1);
    this.description = labelName
      ? `${credits} cr · ${labelName}`
      : `${credits} cr`;
    this.tooltip = new vscode.MarkdownString(
      [
        `**${session.firstPrompt}**`,
        "",
        `- Credits: ${credits}`,
        `- Label: ${labelName ?? "None"}`,
        `- Date: ${new Date(session.timestamp).toLocaleString()}`,
        `- Session: \`${session.sessionId}\``,
      ].join("\n")
    );
  }

  private static makeLabel(session: SessionCost): string {
    const time = new Date(session.timestamp).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    return `${time} · ${session.firstPrompt}`;
  }
}

/**
 * Lists all detected chat sessions, sorted most-recent first, annotated with
 * their total credits and any assigned label.
 */
export class SessionTreeDataProvider
  implements vscode.TreeDataProvider<SessionTreeItem>
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    SessionTreeItem | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private sessions: SessionCost[] = [];
  private loaded = false;

  constructor(
    private readonly reader: SessionReader,
    private readonly state: StateManager
  ) {
    // Re-render when label assignments change.
    this.state.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  /** Forces a re-read of the log files. */
  async refresh(): Promise<void> {
    this.sessions = await this.reader.readAllSessions();
    this.loaded = true;
    this._onDidChangeTreeData.fire();
  }

  /** Returns the currently loaded sessions (cached). */
  getSessions(): SessionCost[] {
    return this.sessions;
  }

  getTreeItem(element: SessionTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<SessionTreeItem[]> {
    if (!this.loaded) {
      this.sessions = await this.reader.readAllSessions();
      this.loaded = true;
    }
    // When empty, return nothing so the view's welcome content is shown.
    if (this.sessions.length === 0) {
      return [];
    }
    const labels = this.state.getLabels();
    const assignments = this.state.getAssignments();
    return this.sessions.map((s) => {
      const labelId = assignments[s.sessionId];
      const labelName = labels.find((l) => l.id === labelId)?.name;
      return new SessionTreeItem(s, labelName);
    });
  }
}
