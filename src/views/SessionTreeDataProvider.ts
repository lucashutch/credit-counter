import * as vscode from "vscode";
import { SessionCost } from "../data/types";
import { SessionReader } from "../data/SessionReader";
import { StateManager } from "../state/StateManager";

/**
 * Deterministic hex palette for the workspace-initial letter. A workspace name
 * always maps to the same color.
 */
const BADGE_COLORS = [
  "#4e79a7",
  "#f28e2b",
  "#e15759",
  "#76b7b2",
  "#59a14f",
  "#d4a72c",
  "#b07aa1",
  "#e26d76",
  "#9c755f",
  "#8a807c",
];

/** Stable hash → palette index (deterministic per name). */
function colorIndexForName(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % BADGE_COLORS.length;
}

/** First letter (uppercased) of a workspace name, for the badge. */
function initialForName(name: string): string {
  const ch = name.trim().charAt(0).toUpperCase();
  return /[A-Z0-9]/.test(ch) ? ch : "•";
}

/**
 * Builds an SVG data URI rendering just the colored letter (transparent
 * background) so only the letter is colored — not the row label.
 */
function letterIconUri(name: string): vscode.Uri {
  const letter = initialForName(name);
  const color = BADGE_COLORS[colorIndexForName(name)];
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">` +
    `<text x="8" y="12" text-anchor="middle" font-family="sans-serif" ` +
    `font-size="13" font-weight="700" fill="${color}">${escapeXml(letter)}</text>` +
    `</svg>`;
  return vscode.Uri.parse(
    "data:image/svg+xml;utf8," + encodeURIComponent(svg)
  );
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

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

    // Colored workspace-initial letter (only the letter is colored).
    this.iconPath = letterIconUri(session.workspaceName ?? session.workspaceHash);

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
            k === "Session" || k === "Workspace ID"
              ? `- ${k}: \`${v}\``
              : `- ${k}: ${v}`
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
      ["Workspace", session.workspaceName ?? "Unknown"],
      ["Session", session.sessionId],
      ["Workspace ID", session.workspaceHash],
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
