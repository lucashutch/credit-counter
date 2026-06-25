# SPEC.md: Chat Cost Dashboard Extension

## 1. Overview
The Chat Cost Dashboard is a Visual Studio Code extension designed to track, categorize, and visualize the costs (credits) associated with local chat sessions. It provides an intuitive sidebar for managing chat sessions and assigning labels, alongside a rich dashboard for cost analysis.

## 2. Features and User Experience

### 2.1. Activity Bar Integration
* **Icon:** A custom icon added to the VS Code Activity Bar.
* **Action:** Clicking the icon toggles the extension's primary Sidebar view.

### 2.2. Sidebar View
The sidebar is divided into distinct sections:
* **Global Actions (Top):**
    * **"Open Dashboard" Button:** A prominent button at the very top of the sidebar. Clicking this opens the main Dashboard in a new editor tab.
* **Label Management (Upper Section):**
    * A list of user-defined labels (e.g., "Project A", "Debugging", "Refactoring").
    * **Add Label:** An input field or `+` button to create a new label.
    * **Rename Label:** Inline editing or a context menu option to rename existing labels.
    * **Delete Label:** A trash icon or context menu option to remove a label.
* **Chat Sessions (Lower Section):**
    * A chronological list of all detected chat sessions.
    * Displays brief session metadata (e.g., date, time, snippet of first prompt, current label).
    * **Context Menu (Right-Click):** Right-clicking on a session opens a menu to "Assign Label". This expands to a sub-menu of available labels defined in the Label Management section.

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
| ▼ CHAT SESSIONS                             |
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
Clicking "Open Dashboard" launches a Webview in a new editor tab. The dashboard visualizes cost data:
* **Cost per Session:** A table or bar chart detailing the credit usage of individual chat sessions.
* **Cost per Label:** A pie chart or bar chart aggregating total credits by assigned labels.
* **Total Cost Timeseries:** A line chart displaying daily cumulative credits for the current month.

**Wireframe: Dashboard Tab**

```text
+-------------------------------------------------------------+
|  CHAT COST ANALYTICS                            [ Refresh ] |
+-------------------------------------------------------------+
|                                                             |
|  [ TOTAL CREDITS ]      [ ACTIVE LABELS ]    [ % vs PREV ]  |
|      1,452.8                 12                 +8.5%       |
|                                                             |
+------------------------------+------------------------------+
| COST PER LABEL (Pie)         | COST PER SESSION (Bar)       |
|                              |                              |
|          (  ) Alpha: 40%     |  Session A: ||||||| 143      |
|          (  ) Beta:  30%     |  Session B: ||||| 92         |
|          (  ) Other: 30%     |  Session C: |||||||||| 210   |
|                              |                              |
+------------------------------+------------------------------+
| TOTAL COST TIMESERIES (Current Month)                       |
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
* **Session Parsing:** The extension sources data by reading `.jsonl` files located in the VS Code `workspaceStorage` under the `chatSessions` directory.
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
    * `extension.openDashboard`
    * `extension.addLabel`
    * `extension.renameLabel`
    * `extension.deleteLabel`
    * `extension.assignLabel`
* `menus`: Registers the context menu on tree view items (`view/item/context`).

### 3.2. Key Components
* **TreeView Providers:**
    * `LabelTreeDataProvider`: Manages the state and UI for the upper label section.
    * `SessionTreeDataProvider`: Manages the state and UI for the lower sessions section.
* **Chat Session Reader Service:** A utility that accesses the `workspaceStorage/chatSessions` directory, iterates through the `.jsonl` files, safely parses the JSON on each line, extracts the `v.details` field, and tallies the total credits.
* **Webview Panel:** An HTML/JS-based UI for the Dashboard. Uses a charting library (like Chart.js or Recharts) to render the timeseries and cost breakdowns.
* **State Manager:** Handles saving and retrieving label arrays and the dictionary mapping `sessionId` to `labelId`.

## 4. Development Milestones
1.  **Scaffolding & UI Structure:** Setup VS Code extension template, register Activity Bar icon, and mock the Sidebar TreeViews.
2.  **State Management:** Implement Create/Read/Update/Delete (CRUD) operations for labels and the right-click assignment logic for sessions.
3.  **Data Ingestion:** Implement the reader service to locate the `workspaceStorage` directory, parse `.jsonl` session files, isolate `line["v"]["details"]`, and accurately sum the numeric credit values.
4.  **Dashboard Implementation:** Create the Webview, integrate a charting library, and wire up the parsed `.jsonl` data to the charts.
5.  **Testing & Polish:** Ensure correct state persistence, accurate credit aggregations across diverse model strings, and a responsive Webview UI.
