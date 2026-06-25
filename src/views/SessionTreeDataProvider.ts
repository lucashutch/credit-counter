import * as vscode from "vscode";
import { SessionCost } from "../data/types";
import { SessionReader } from "../data/SessionReader";
import { StateManager } from "../state/StateManager";

/** Tree item wrapping a single chat session. */
export class SessionTreeItem extends vscode.TreeItem {
  /** Plain-text metadata (matches the tooltip), used by "Copy metadata". */
  public readonly metadataText: string;

  constructor(
    public readonly session: SessionCost,
    public readonly labelName: string | undefined
  ) {
    super(SessionTreeItem.makeLabel(session), vscode.TreeItemCollapsibleState.None);
    this.id = session.sessionId;
    this.contextValue = "session";
    this.iconPath = new vscode.ThemeIcon("comment-discussion");

    const credits = session.totalCredits.toFixed(1);
    this.description = labelName
      ? `${credits} cr · ${labelName}`
      : `${credits} cr`;

    const fields = SessionTreeItem.buildFields(session, labelName, credits);
    this.metadataText = fields.map(([k, v]) => `${k}: ${v}`).join("\n");

    this.tooltip = new vscode.MarkdownString(
      [
        `**${session.firstPrompt}**`,
        "",
        ...fields
          .filter(([k]) => k !== "Title")
          .map(([k, v]) =>
            k === "Session" ? `- ${k}: \`${v}\`` : `- ${k}: ${v}`
          ),
      ].join("\n")
    );
  }

  /** Ordered metadata fields shared by the tooltip and clipboard copy. */
  private static buildFields(
    session: SessionCost,
    labelName: string | undefined,
    credits: string
  ): [string, string][] {
    return [
      ["Title", session.firstPrompt],
      ["Credits", credits],
      ["Label", labelName ?? "None"],
      ["Date", new Date(session.timestamp).toLocaleString()],
      ["Session", session.sessionId],
      ["Workspace", session.workspaceHash],
    ];
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
  /**
   * Active label filter. `undefined` means no filter (show all). Otherwise a
   * set of label ids and/or the special `UNASSIGNED` token; a session is shown
   * if its assignment matches any entry in the set.
   */
  private filter: Set<string> | undefined;

  static readonly UNASSIGNED = "__unassigned__";

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

  /** Returns whether a filter is currently active. */
  isFiltered(): boolean {
    return this.filter !== undefined && this.filter.size > 0;
  }

  /** Returns the active filter set (label ids + UNASSIGNED token), if any. */
  getFilter(): Set<string> | undefined {
    return this.filter;
  }

  /** Applies a label filter. Pass an empty set or undefined to clear it. */
  setFilter(ids: string[] | undefined): void {
    this.filter = ids && ids.length > 0 ? new Set(ids) : undefined;
    void vscode.commands.executeCommand(
      "setContext",
      "copilotCostTracker.filterActive",
      this.isFiltered()
    );
    this._onDidChangeTreeData.fire();
  }

  /** Clears any active filter and shows all sessions. */
  clearFilter(): void {
    this.setFilter(undefined);
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

    return this.sessions
      .filter((s) => this.matchesFilter(s, assignments))
      .map((s) => {
        const labelId = assignments[s.sessionId];
        const labelName = labels.find((l) => l.id === labelId)?.name;
        return new SessionTreeItem(s, labelName);
      });
  }

  /** Whether a session passes the active filter (always true when unfiltered). */
  private matchesFilter(
    session: SessionCost,
    assignments: Record<string, string>
  ): boolean {
    if (!this.filter || this.filter.size === 0) {
      return true;
    }
    const labelId = assignments[session.sessionId];
    const key = labelId ? labelId : SessionTreeDataProvider.UNASSIGNED;
    return this.filter.has(key);
  }
}
