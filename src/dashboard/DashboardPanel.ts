import * as vscode from "vscode";
import { SessionSource } from "../data/SessionSource";
import { StateManager } from "../state/StateManager";
import { buildDashboardData } from "../data/DashboardData";

/** Manages the singleton dashboard webview panel. */
export class DashboardPanel {
  public static readonly viewType = "creditCounter.dashboard";
  private static current: DashboardPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  static show(
    extensionUri: vscode.Uri,
    reader: SessionSource,
    state: StateManager
  ): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (DashboardPanel.current) {
      DashboardPanel.current.panel.reveal(column);
      void DashboardPanel.current.update();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      DashboardPanel.viewType,
      "Credit Counter",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      }
    );

    DashboardPanel.current = new DashboardPanel(panel, extensionUri, reader, state);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly reader: SessionSource,
    private readonly state: StateManager
  ) {
    this.panel = panel;
    this.panel.webview.html = this.getHtml(this.panel.webview);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      (message: { type: string }) => {
        if (message.type === "ready" || message.type === "refresh") {
          void this.update();
        }
      },
      null,
      this.disposables
    );

    // Keep the dashboard in sync when labels/assignments change.
    this.state.onDidChange(() => void this.update());
  }

  /** Reads fresh data and posts it to the webview. */
  private async update(): Promise<void> {
    const sessions = await this.reader.readAllSessions();
    const data = buildDashboardData(
      sessions,
      this.state.getLabels(),
      this.state.getAssignments()
    );
    await this.panel.webview.postMessage({ type: "data", payload: data });
  }

  private dispose(): void {
    DashboardPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const mediaUri = (file: string) =>
      webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, "media", file)
      );

    const chartUri = mediaUri("chart.umd.min.js");
    const scriptUri = mediaUri("dashboard.js");
    const styleUri = mediaUri("dashboard.css");
    const nonce = getNonce();

    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join("; ");

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Credit Counter</title>
</head>
<body>
  <header class="topbar">
    <h1>Credit Counter</h1>
    <div class="topbar-actions">
      <select id="period" class="period-select" aria-label="Chart period">
        <option value="thisMonth" selected>This month</option>
        <option value="lastMonth">Last month</option>
        <option value="last3Months">Last 3 months</option>
        <option value="allTime">All time</option>
      </select>
      <button id="refresh" class="btn">↻ Refresh</button>
    </div>
  </header>

  <section class="kpis">
    <div class="kpi"><div class="kpi-value" id="kpi-cost">—</div><div class="kpi-label" id="kpi-cost-label">Cost</div></div>
    <div class="kpi"><div class="kpi-value" id="kpi-change">—</div><div class="kpi-label" id="kpi-change-label">vs Previous</div></div>
    <div class="kpi"><div class="kpi-value" id="kpi-labels">—</div><div class="kpi-label">Active Labels</div></div>
    <div class="kpi"><div class="kpi-value" id="kpi-avg">—</div><div class="kpi-label">Avg / Session</div></div>
  </section>

  <section class="grid">
    <div class="card">
      <div class="card-head">
        <h2>Cost per Label</h2>
      </div>
      <div class="chart-wrap"><canvas id="labelChart"></canvas></div>
    </div>
    <div class="card">
      <div class="card-head">
        <h2>Cost per Session (Top 15)</h2>
      </div>
      <div class="chart-wrap"><canvas id="sessionChart"></canvas></div>
    </div>
  </section>

  <section class="card full">
    <h2 id="timeseries-title">Total Cost Timeseries</h2>
    <div class="chart-wrap tall"><canvas id="monthChart"></canvas></div>
  </section>

  <section class="grid">
    <div class="card">
      <div class="card-head"><h2>Cost per Harness</h2></div>
      <div class="chart-wrap"><canvas id="harnessChart"></canvas></div>
    </div>
    <div class="card">
      <div class="card-head"><h2>Cost per Model</h2></div>
      <div class="chart-wrap"><canvas id="modelChart"></canvas></div>
    </div>
  </section>

  <section class="grid grid-3">
    <div class="card">
      <div class="card-head"><h2>Cost per Repo (Top 10)</h2></div>
      <div class="chart-wrap"><canvas id="repoChart"></canvas></div>
    </div>
    <div class="card">
      <div class="card-head"><h2>Token Usage &amp; Efficiency</h2></div>
      <div id="tokenStats" class="token-stats"></div>
    </div>
    <div class="card">
      <div class="card-head"><h2>Spend by Time of Week</h2></div>
      <div class="heatmap-wrap"><div id="heatmap" class="heatmap"></div></div>
    </div>
  </section>

  <section class="grid">
    <div class="card">
      <div class="card-head"><h2>Avg Cost / Session by Harness</h2></div>
      <div class="chart-wrap"><canvas id="avgCostHarnessChart"></canvas></div>
    </div>
    <div class="card">
      <div class="card-head"><h2>Avg Cost / Session by Model</h2></div>
      <div class="chart-wrap"><canvas id="avgCostModelChart"></canvas></div>
    </div>
  </section>

  <section class="grid">
    <div class="card">
      <div class="card-head"><h2>Sessions by Model</h2></div>
      <div class="chart-wrap"><canvas id="sessionsModelChart"></canvas></div>
    </div>
    <div class="card">
      <div class="card-head"><h2>Avg Tokens / Session by Model</h2></div>
      <div class="chart-wrap"><canvas id="avgTokensModelChart"></canvas></div>
    </div>
  </section>

  <section class="grid">
    <div class="card">
      <div class="card-head"><h2>Avg Subagents / Session by Model</h2></div>
      <div class="chart-wrap"><canvas id="avgSubagentsModelChart"></canvas></div>
    </div>
    <div class="card">
      <div class="card-head"><h2>Sessions by Label</h2></div>
      <div class="chart-wrap"><canvas id="sessionsLabelChart"></canvas></div>
    </div>
  </section>

  <div id="empty" class="empty hidden">No cost data found yet.</div>

  <script nonce="${nonce}" src="${chartUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = "";
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
