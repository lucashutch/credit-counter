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
    * **Filter:** A filter action in the view title narrows the list, with a matching action to clear the active filter.
    * **Refresh:** A refresh action in the view title re-reads the chat logs.
    * **Context Menu (Right-Click):** Right-clicking on a session opens a menu to "Assign Label" (expanding to the available labels) and to "Copy Metadata".

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
* **Headline KPIs:** This month's credits, percent change vs. the previous month, active label count, and total credits.
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
* **Session Discovery:** The extension enumerates chat sessions from each workspace's `state.vscdb` SQLite store (`workspaceStorage/<hash>/state.vscdb`). The `chat.ChatSessionStore.index` key holds a JSON index of sessions; entries with `isEmpty: true` are excluded. Session titles are always taken from this index, never from the file.
* **Session Parsing:** For each indexed session, the `.jsonl` file is read directly at `chatSessions/<sessionId>.jsonl` (no directory globbing) to tally credits.
* **Cost Calculation:** * Each `.jsonl` file is parsed line by line.
    * The extension searches for and extracts the `line["v"]["details"]` field.
    * Using a regex or string extraction, it parses the credit value from strings formatted like `"Claude Opus 4.8 • 143.6 credits"`.
    * Total cost is calculated by summing all parsed credit values per session.
* **Storage:** Label definitions and session-to-label mappings are persisted locally using the VS Code Extension `globalState` or `workspaceState` APIs.

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
* **Chat Session Reader Service:** A utility that reads the `chat.ChatSessionStore.index` from each workspace's `state.vscdb` (via sql.js), filters out empty sessions, then opens each session's `.jsonl` file directly to safely parse the JSON on each line, extract the `v.details` field, and tally the total credits. The display title is sourced from the database index.
* **Webview Panel:** An HTML/JS-based UI for the Dashboard. Uses a charting library (like Chart.js or Recharts) to render the timeseries and cost breakdowns.
* **State Manager:** Handles saving and retrieving label arrays and the dictionary mapping `sessionId` to `labelId`.
