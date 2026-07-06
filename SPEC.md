# SPEC.md: Credit Counter Extension

## 1. Overview
The Credit Counter is a Visual Studio Code extension designed to track, categorize, and visualize the costs (credits) associated with local chat sessions. It provides an intuitive sidebar for managing chat sessions and assigning labels, alongside a rich dashboard for cost analysis.

## 2. Features and User Experience

### 2.1. Activity Bar Integration
* **Icon:** A custom icon added to the VS Code Activity Bar.
* **Action:** Clicking the icon toggles the extension's primary Sidebar view.

### 2.2. Sidebar View
The sidebar is divided into distinct sections:
* **Global Actions (Top):**
    * **"Open Dashboard" Button:** A prominent button at the very top of the sidebar. Clicking this opens the main Dashboard in a new editor tab.
* **Label Management (Upper Section):**
    * A list of user-defined labels (e.g., "Project A", "Debugging", "Refactoring"), sorted alphabetically.
    * **Add Label:** A `+` button to create a new label.
    * **Rename Label:** An inline action to rename existing labels.
    * **Delete Label:** An inline trash action to remove a label.
* **Chat Sessions (Lower Section):**
    * A chronological list of all detected chat sessions.
    * Displays brief session metadata (e.g., date, time, snippet of first prompt, current label, and originating workspace).
    * **Filter:** A filter action in the view title narrows the list by any combination of **label**, **repository**, and **source** (Copilot / Claude Code), combined with AND. A separate **Filter by Date** action constrains the list to a date range (presets — last 7/30 days, this/last month, this year — or a custom start/end). A matching action clears all active filters.
    * **Hidden sessions:** Sessions can be hidden from the list via the right-click menu. A view-title toggle (**Show/Hide Hidden Sessions**) reveals hidden sessions — shown with a muted eye-off icon and a "hidden" tag — so they can be unhidden. The hidden set is persisted in `globalState`.
    * **Refresh:** A refresh action in the view title re-reads the chat logs.
    * **Context Menu (Right-Click):** Right-clicking on a session opens a menu to **Assign Label** (a QuickPick of the available labels, with the current one marked), **Hide/Unhide Session**, and **Copy Metadata**.
    * **Keyboard:** when the Chat Sessions view is focused, `l` assigns a label to the selected session and `h` hides it. These commands resolve their target from the context-menu item when present, otherwise from the tree's current selection, so they work identically from mouse, keyboard, and command palette.

**Wireframe: Sidebar Layout**
```text
_______________________________________________
| [  OPEN DASHBOARD  ] <--- Primary Action    |
|_____________________________________________|
|                                             |
| ▼ LABEL MANAGEMENT                    [ + ] |
|   • Project Alpha                    [✎][x] |
|   • Debugging                        [✎][x] |
|   • Research                         [✎][x] |
|_____________________________________________|
|                                             |
| ▼ CHAT SESSIONS              [filter][↻] |
|   • 10:45 AM | "Fix regex pattern..."       |
|     [Label: Debugging]                      |
|                                             |
|   • 09:20 AM | "Refactor API logic..."      |
|     [Label: None]  <-- (Right-click to assign)|
|                                             |
|   • Yesterday | "Write SPEC.md file..."     |
|     [Label: Project Alpha]                  |
|_____________________________________________|
```

### 2.3. Editor Dashboard
Clicking "Open Dashboard" launches a Webview in a new editor tab. A shared period selector (This month, Last month, Last 3 months, All time) in the toolbar drives the per-label and per-session charts. The dashboard visualizes cost data:
* **Headline KPIs:** This month's cost (USD), percent change vs. the previous month, active label count, and total cost (USD).
* **Cost per Session:** A bar chart detailing the credit usage of the most expensive individual chat sessions.
* **Cost per Label:** A pie chart aggregating total credits by assigned labels.
* **Total Cost Timeseries:** A line chart displaying daily cumulative credits for the current month (up to the current day), overlaid with the previous month for comparison.

**Wireframe: Dashboard Tab**

```text
+-------------------------------------------------------------+
|  CREDIT COUNTER                    [ Period v ] [ Refresh ] |
+-------------------------------------------------------------+
|                                                             |
| [ THIS MONTH ] [ % vs PREV ] [ ACTIVE LABELS ] [ TOTAL ]    |
|     452.8         +8.5%            12            1,452.8     |
|                                                             |
+------------------------------+------------------------------+
| COST PER LABEL (Pie)         | COST PER SESSION (Bar)       |
|                              |                              |
|          (  ) Alpha: 40%     |  Session A: ||||||| 143      |
|          (  ) Beta:  30%     |  Session B: ||||| 92         |
|          (  ) Other: 30%     |  Session C: |||||||||| 210   |
|                              |                              |
+------------------------------+------------------------------+
| TOTAL COST TIMESERIES (This Month vs Last Month)            |
|                                                             |
|  Credits                                                    |
|    ^          _..---''                                      |
|    |      _.-'                                              |
|    |  _.-'                                                  |
|    +------------------------------------------------------> |
|      1st    5th    10th   15th   20th   25th   31st         |
+-------------------------------------------------------------+
```

### 2.4. Data Source & Processing
The extension reads from multiple **sources**, each producing the same `SessionCost` shape (tagged with a `source` field) and merged behind a single `SessionSource` interface (`AggregateReader`). Sessions are tagged by source in the tree and can be filtered by source, alongside label and repository.

All cost is normalized to **US dollars** so the two sources aggregate directly. Copilot credits are converted at $0.01/credit (1 GitHub Copilot AI credit = US$0.01); Claude Code token usage is priced per model. The shared numeric field (`totalCredits`) therefore always holds USD, and both the tree and dashboard display it as `$X.XX`.

**Copilot source (`SessionReader`):**
* **Session Discovery:** Enumerates chat sessions from each workspace's `state.vscdb` SQLite store (`workspaceStorage/<hash>/state.vscdb`). The `chat.ChatSessionStore.index` key holds a JSON index of sessions; entries with `isEmpty: true` are excluded. Session titles are always taken from this index, never from the file.
* **Session Parsing:** For each indexed session, the `.jsonl` file is read directly at `chatSessions/<sessionId>.jsonl` (no directory globbing) to tally credits.
* **Cost Calculation:** Each `.jsonl` file is parsed line by line; credit values are extracted from strings formatted like `"Claude Opus 4.8 • 143.6 credits"`, summed per session, and converted to USD at $0.01/credit.

**Claude Code source (`ClaudeCodeReader`):**
* **Session Discovery:** Enumerates transcripts under `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` (honoring `CLAUDE_CONFIG_DIR`). Each `.jsonl` file is one session.
* **Session Parsing:** Each file is streamed line by line. Assistant turns carry `message.usage` token counts (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`) and a `model`. The session title is Claude Code's own generated title (`{"type":"ai-title"}` lines, matching what `claude --resume` shows; the latest one wins), falling back to the first real user prompt when no title has been generated. The repository name is derived from the session's `cwd`.
* **Cost Calculation:** Claude Code records no cost, so each turn's tokens are priced per model (`ClaudeCodePricing`) to a US-dollar total. Two subtleties are handled to match `claude /cost`:
    * **Deduplication:** A single assistant response is logged across several lines (one per streamed content block), each repeating the same `message.id` and cumulative `usage`. Each message's usage is counted only once.
    * **Tiered cache:** Cache-creation tokens are billed by TTL — 5-minute ephemeral cache at 1.25× the input rate, 1-hour cache at 2× — read from the `usage.cache_creation` breakdown (falling back to the flat field as 5-minute).
  Synthetic turns are not billed; unknown models fall back to Sonnet-tier pricing.

**Caching:** Both sources cache per-file parse results in `globalState` keyed on `mtime`+`size`, invalidated on extension version change.

**Storage:** Label definitions and session-to-label mappings are persisted locally using the VS Code Extension `globalState` API.

## 3. Technical Architecture

### 3.1. Contribution Points (`package.json`)
* `viewsContainers`: Defines the activity bar icon and container.
* `views`: Defines the tree views for Label Management and Chat Sessions.
* `commands`: Registers commands for:
    * `openDashboard`
    * `addLabel`
    * `renameLabel`
    * `deleteLabel`
    * `assignLabel`
    * `copyMetadata`
    * `refreshSessions`
    * `filterSessions` / `clearFilter`
* `menus`: Registers view-title actions (open dashboard, add label, filter/refresh sessions) and the context menu on tree view items (`view/item/context`).

### 3.2. Key Components
* **TreeView Providers:**
    * `LabelTreeDataProvider`: Manages the state and UI for the upper label section.
    * `SessionTreeDataProvider`: Manages the state and UI for the lower sessions section.
* **Session Sources:** Each cost provider implements the `SessionSource` interface (`readAllSessions(): Promise<SessionCost[]>`):
    * `SessionReader` — reads the `chat.ChatSessionStore.index` from each workspace's `state.vscdb` (via sql.js), filters out empty sessions, then opens each session's `.jsonl` file directly to tally credits. The display title is sourced from the database index.
    * `ClaudeCodeReader` — reads Claude Code transcripts from `~/.claude/projects`, pricing per-turn token usage (`ClaudeCodePricing`) to a US-dollar total.
    * `AggregateReader` — fans out to all sources and merges their sessions (most-recent first), isolating per-source failures.
* **Webview Panel:** An HTML/JS-based UI for the Dashboard. Uses a charting library (like Chart.js or Recharts) to render the timeseries and cost breakdowns.
* **State Manager:** Handles saving and retrieving label arrays and the dictionary mapping `sessionId` to `labelId`.
