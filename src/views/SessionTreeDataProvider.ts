import * as vscode from "vscode";
import { SessionCost, Source } from "../data/types";
import { SessionSource } from "../data/SessionSource";
import { StateManager } from "../state/StateManager";

/** Human-readable name for a session source. */
export function sourceLabel(source: Source): string {
  return source === "claude-code" ? "Claude Code" : "Copilot";
}

/** Formats a US-dollar cost, e.g. `$1.23`. */
export function formatCost(session: SessionCost): string {
  return formatUsd(session.totalCredits);
}

/** Formats a US-dollar amount, e.g. `$1.23`. */
export function formatUsd(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

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
    public readonly labelName: string | undefined,
    public readonly hidden: boolean = false
  ) {
    super(SessionTreeItem.makeLabel(session), vscode.TreeItemCollapsibleState.None);
    this.id = session.sessionId;
    // Context value drives which context-menu items appear (Hide vs Unhide).
    this.contextValue = hidden ? "sessionHidden" : "session";

    // Colored workspace-initial letter (only the letter is colored). Hidden
    // sessions use a muted eye-off icon instead.
    this.iconPath = hidden
      ? new vscode.ThemeIcon("eye-closed")
      : letterIconUri(session.workspaceName ?? session.workspaceHash);

    const cost = formatCost(session);
    const suffix = hidden ? " · hidden" : "";
    this.description = (labelName ? `${cost} · ${labelName}` : cost) + suffix;

    const fields = SessionTreeItem.buildFields(session, labelName, cost);
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
    cost: string
  ): [string, string][] {
    const fields: [string, string][] = [
      ["Title", session.firstPrompt],
      ["Source", sourceLabel(session.source)],
      ["Cost", cost],
      ["Label", labelName ?? "None"],
      ["Date", new Date(session.timestamp).toLocaleString()],
      ["Workspace", session.workspaceName ?? "Unknown"],
      ["Session", session.sessionId],
      ["Workspace ID", session.workspaceHash],
    ];
    if (session.tokens) {
      const t = session.tokens;
      fields.splice(3, 0, [
        "Tokens",
        `${t.input} in · ${t.output} out · ${t.cacheWrite} cache-write · ${t.cacheRead} cache-read`,
      ]);
    }
    return fields;
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
  /** The owning TreeView, set after `createTreeView`, used to show a summary. */
  private treeView: vscode.TreeView<SessionTreeItem> | undefined;
  /**
   * Active label filter. `undefined` means no label constraint (show all
   * labels). Otherwise a set of label ids and/or the special `UNASSIGNED`
   * token; a session matches the label dimension if its assignment is in the
   * set.
   */
  private labelFilter: Set<string> | undefined;
  /**
   * Active repository filter. `undefined` means no repo constraint. Otherwise a
   * set of repo keys (the session's `workspaceName`, or `UNKNOWN_REPO` for
   * sessions without one); a session matches the repo dimension if its repo key
   * is in the set.
   *
   * The two dimensions are combined with AND: a session is shown only when it
   * satisfies both the label filter and the repo filter.
   */
  private repoFilter: Set<string> | undefined;
  /**
   * Active source filter. `undefined` means no source constraint. Otherwise a
   * set of {@link Source} values; combined with the other dimensions via AND.
   */
  private sourceFilter: Set<string> | undefined;
  /**
   * Active date-range filter (inclusive-start, inclusive-end epoch ms). Either
   * bound may be undefined (open-ended). Combined with the other dimensions via
   * AND.
   */
  private dateStart: number | undefined;
  private dateEnd: number | undefined;
  /** Human-readable label for the active date range, e.g. "Last 7 days". */
  private dateLabel: string | undefined;
  /** Whether hidden sessions are currently shown (marked) in the list. */
  private showHidden = false;

  static readonly UNASSIGNED = "__unassigned__";
  static readonly UNKNOWN_REPO = "__unknown_repo__";

  constructor(
    private readonly reader: SessionSource,
    private readonly state: StateManager
  ) {
    // Re-render when label assignments change.
    this.state.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  /** Associates the created TreeView so we can show the monthly summary on it. */
  setTreeView(view: vscode.TreeView<SessionTreeItem>): void {
    this.treeView = view;
    this.updateSummary();
  }

  /**
   * The session item currently selected/focused in the tree, if any. Used by
   * keyboard-triggered commands (e.g. pressing `l` to assign a label) which
   * receive no explicit item argument.
   */
  getSelectedItem(): SessionTreeItem | undefined {
    return this.treeView?.selection?.[0];
  }

  /** Forces a re-read of the log files. */
  async refresh(): Promise<void> {
    this.sessions = await this.reader.readAllSessions();
    this.loaded = true;
    this.updateSummary();
    this._onDidChangeTreeData.fire();
  }

  /**
   * Updates the TreeView description with the cost incurred in the current
   * month (e.g. "$14.06 · June"), shown dimmed beside the view title.
   */
  private updateSummary(): void {
    if (!this.treeView) {
      return;
    }
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    let monthCost = 0;
    for (const s of this.sessions) {
      const d = new Date(s.timestamp);
      if (d.getFullYear() === year && d.getMonth() === month) {
        monthCost += s.totalCredits;
      }
    }
    const monthLabel = now.toLocaleString(undefined, { month: "long" });
    this.treeView.description = `${formatUsd(monthCost)} · ${monthLabel}`;
  }

  /** Returns the currently loaded sessions (cached). */
  getSessions(): SessionCost[] {
    return this.sessions;
  }

  /** Whether any filter (label, repo, source, or date range) is active. */
  isFiltered(): boolean {
    return (
      (this.labelFilter !== undefined && this.labelFilter.size > 0) ||
      (this.repoFilter !== undefined && this.repoFilter.size > 0) ||
      (this.sourceFilter !== undefined && this.sourceFilter.size > 0) ||
      this.dateStart !== undefined ||
      this.dateEnd !== undefined
    );
  }

  /** Returns the active label/repo/source filter sets and date range, if any. */
  getFilter(): {
    labels?: Set<string>;
    repos?: Set<string>;
    sources?: Set<string>;
    dateLabel?: string;
  } {
    return {
      labels: this.labelFilter,
      repos: this.repoFilter,
      sources: this.sourceFilter,
      dateLabel: this.dateLabel,
    };
  }

  /** Applies (or clears, when both bounds are undefined) a date-range filter. */
  setDateRange(
    start: number | undefined,
    end: number | undefined,
    label?: string
  ): void {
    this.dateStart = start;
    this.dateEnd = end;
    this.dateLabel = start === undefined && end === undefined ? undefined : label;
    void vscode.commands.executeCommand(
      "setContext",
      "creditCounter.filterActive",
      this.isFiltered()
    );
    this._onDidChangeTreeData.fire();
  }

  /** Whether hidden sessions are currently being shown. */
  isShowingHidden(): boolean {
    return this.showHidden;
  }

  /** Shows or hides the hidden sessions in the list. */
  setShowHidden(show: boolean): void {
    this.showHidden = show;
    void vscode.commands.executeCommand(
      "setContext",
      "creditCounter.showHidden",
      show
    );
    this._onDidChangeTreeData.fire();
  }

  /** Distinct sources present across loaded sessions, sorted by name. */
  getSources(): { key: Source; name: string }[] {
    const seen = new Set<Source>();
    for (const s of this.sessions) {
      seen.add(s.source);
    }
    return [...seen]
      .map((key) => ({ key, name: sourceLabel(key) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * The repo key for a session: its workspace name, or `UNKNOWN_REPO` when no
   * workspace name is available.
   */
  static repoKey(session: SessionCost): string {
    return session.workspaceName ?? SessionTreeDataProvider.UNKNOWN_REPO;
  }

  /**
   * Distinct repositories across loaded sessions, sorted by name. Sessions
   * without a workspace name are surfaced as the `UNKNOWN_REPO` key.
   */
  getRepos(): { key: string; name: string }[] {
    const seen = new Map<string, string>();
    for (const s of this.sessions) {
      const key = SessionTreeDataProvider.repoKey(s);
      if (!seen.has(key)) {
        seen.set(
          key,
          s.workspaceName ?? "Unknown workspace"
        );
      }
    }
    return [...seen.entries()]
      .map(([key, name]) => ({ key, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Applies the label and repo filters. Pass empty arrays/undefined for a
   * dimension to remove that constraint.
   */
  setFilter(
    labelIds: string[] | undefined,
    repoKeys: string[] | undefined,
    sourceKeys?: string[] | undefined
  ): void {
    this.labelFilter =
      labelIds && labelIds.length > 0 ? new Set(labelIds) : undefined;
    this.repoFilter =
      repoKeys && repoKeys.length > 0 ? new Set(repoKeys) : undefined;
    this.sourceFilter =
      sourceKeys && sourceKeys.length > 0 ? new Set(sourceKeys) : undefined;
    void vscode.commands.executeCommand(
      "setContext",
      "creditCounter.filterActive",
      this.isFiltered()
    );
    this._onDidChangeTreeData.fire();
  }

  /** Clears every active filter (labels, repos, sources, and date range). */
  clearFilter(): void {
    this.dateStart = undefined;
    this.dateEnd = undefined;
    this.dateLabel = undefined;
    this.setFilter(undefined, undefined, undefined);
  }

  getTreeItem(element: SessionTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<SessionTreeItem[]> {
    if (!this.loaded) {
      this.sessions = await this.reader.readAllSessions();
      this.loaded = true;
      this.updateSummary();
    }
    // When empty, return nothing so the view's welcome content is shown.
    if (this.sessions.length === 0) {
      return [];
    }
    const labels = this.state.getLabels();
    const assignments = this.state.getAssignments();
    const hidden = this.state.getHiddenSessions();

    return this.sessions
      .filter((s) => {
        // Drop hidden sessions unless the user is showing them.
        if (hidden.has(s.sessionId) && !this.showHidden) {
          return false;
        }
        return this.matchesFilter(s, assignments);
      })
      .map((s) => {
        const labelId = assignments[s.sessionId];
        const labelName = labels.find((l) => l.id === labelId)?.name;
        return new SessionTreeItem(s, labelName, hidden.has(s.sessionId));
      });
  }

  /** Whether a session passes the active filter (always true when unfiltered). */
  private matchesFilter(
    session: SessionCost,
    assignments: Record<string, string>
  ): boolean {
    // Label dimension.
    if (this.labelFilter && this.labelFilter.size > 0) {
      const labelId = assignments[session.sessionId];
      const key = labelId ? labelId : SessionTreeDataProvider.UNASSIGNED;
      if (!this.labelFilter.has(key)) {
        return false;
      }
    }
    // Repo dimension (combined with AND).
    if (this.repoFilter && this.repoFilter.size > 0) {
      if (!this.repoFilter.has(SessionTreeDataProvider.repoKey(session))) {
        return false;
      }
    }
    // Source dimension (combined with AND).
    if (this.sourceFilter && this.sourceFilter.size > 0) {
      if (!this.sourceFilter.has(session.source)) {
        return false;
      }
    }
    // Date-range dimension (combined with AND).
    if (this.dateStart !== undefined && session.timestamp < this.dateStart) {
      return false;
    }
    if (this.dateEnd !== undefined && session.timestamp > this.dateEnd) {
      return false;
    }
    return true;
  }
}
