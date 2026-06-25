# PLAN.md: Chat Cost Dashboard Extension

This document is the implementation plan derived from [`SPEC.md`](./SPEC.md). It breaks the work into phases, deliverables, file-level tasks, and acceptance criteria.

---

## 0. Tech Stack & Conventions

| Concern | Choice |
| --- | --- |
| Language | TypeScript |
| Runtime | VS Code Extension Host (Node.js) |
| Bundler | `esbuild` (fast dev + production bundle) |
| Charts | `Chart.js` (lightweight, CSP-friendly via bundled script) |
| Lint/Format | ESLint + Prettier |
| Testing | `@vscode/test-electron` + Mocha |
| Min VS Code | `^1.90.0` |

**Conventions**
- All commands prefixed with `copilotCostTracker.`
- All settings/state keys prefixed with `copilotCostTracker.`
- Source under `src/`, webview assets under `media/`.

---

## 1. Project Structure

```text
copilot-cost-tracker/
├── package.json                 # Manifest + contribution points
├── tsconfig.json
├── esbuild.js
├── .eslintrc.json
├── src/
│   ├── extension.ts             # activate() / deactivate()
│   ├── commands.ts              # Command registrations
│   ├── state/
│   │   └── StateManager.ts      # Labels + session→label persistence
│   ├── data/
│   │   ├── SessionReader.ts     # Locate + parse .jsonl files
│   │   ├── CostParser.ts        # Extract credits from details strings
│   │   └── types.ts             # Session, Label, CostRecord interfaces
│   ├── views/
│   │   ├── LabelTreeDataProvider.ts
│   │   └── SessionTreeDataProvider.ts
│   └── dashboard/
│       └── DashboardPanel.ts    # Webview lifecycle + messaging
├── media/
│   ├── dashboard.html
│   ├── dashboard.js             # Chart rendering + message handling
│   ├── dashboard.css
│   └── icon.svg                 # Activity bar icon
└── test/
    └── suite/
```

---

## 2. Data Model (`src/data/types.ts`)

```ts
interface Label {
  id: string;        // uuid
  name: string;
  color?: string;    // optional, for charts
}

interface SessionCost {
  sessionId: string;     // filename without .jsonl
  workspaceHash: string; // parent storage dir
  firstPrompt: string;   // snippet for display
  timestamp: number;     // earliest request time (ms)
  totalCredits: number;  // summed from details strings
  labelId?: string;      // assigned label
}

interface CostEntry {
  model: string;         // e.g. "Claude Opus 4.8"
  credits: number;       // e.g. 143.6
}
```

---

## 3. Phases

### Phase 1 — Scaffolding & Activity Bar
**Goal:** Extension activates and shows an empty sidebar under a new activity bar icon.

Tasks:
1. Init project: `package.json`, `tsconfig.json`, `esbuild.js`, ESLint.
2. Add `icon.svg` to `media/`.
3. Contribution points in `package.json`:
   - `viewsContainers.activitybar` → `copilotCostTracker` container with icon.
   - `views.copilotCostTracker` → two views: `copilotCostTracker.labels`, `copilotCostTracker.sessions`.
   - `viewsWelcome` → "Open Dashboard" button rendered at top via `view/title` or a welcome content button.
4. `extension.ts` → register placeholder tree providers.

**Acceptance:** Icon appears; clicking reveals two empty sections; extension activates without errors.

---

### Phase 2 — State Management (Labels)
**Goal:** Full CRUD for labels persisted across sessions.

Tasks:
1. `StateManager.ts` backed by `context.globalState`:
   - `getLabels(): Label[]`
   - `addLabel(name)`, `renameLabel(id, name)`, `deleteLabel(id)`
   - `assignLabel(sessionId, labelId)`, `getAssignment(sessionId)`
   - Deleting a label clears its assignments.
2. Commands (`commands.ts`):
   - `copilotCostTracker.addLabel` (input box)
   - `copilotCostTracker.renameLabel` (input box, prefilled)
   - `copilotCostTracker.deleteLabel` (confirm dialog)
3. `LabelTreeDataProvider` renders labels with inline `[✎]` / `[x]` actions via `view/item/context`.
4. Fire `onDidChangeTreeData` after each mutation.

**Acceptance:** Add/rename/delete labels; state survives reload.

---

### Phase 3 — Data Ingestion
**Goal:** Read and parse real chat sessions into `SessionCost[]`.

Confirmed layout (verified on this machine):
```text
~/.config/Code/User/workspaceStorage/<hash>/chatSessions/<sessionId>.jsonl
```
`details` strings look like `"Claude Opus 4.8"` or `"Claude Opus 4.8 • 143.6 credits"`.

Tasks:
1. `SessionReader.ts`:
   - Resolve global storage root cross-platform:
     - Linux: `~/.config/Code/User/workspaceStorage`
     - macOS: `~/Library/Application Support/Code/User/workspaceStorage`
     - Windows: `%APPDATA%/Code/User/workspaceStorage`
   - Derive from `context.globalStorageUri` where possible (walk up to `workspaceStorage`).
   - Enumerate `*/chatSessions/*.jsonl`.
   - Stream each file line-by-line; `JSON.parse` per line with try/catch (skip bad lines).
   - Extract first prompt + earliest timestamp for display metadata.
2. `CostParser.ts`:
   - Read `line.v.details` (guard for missing/nested shapes).
   - Regex: `/([\d.]+)\s*credits/i` → parse float.
   - Sum per session → `totalCredits`.
3. `SessionTreeDataProvider` lists sessions sorted by recency, showing time + prompt snippet + current label.

**Acceptance:** Sidebar lists real sessions with non-zero credits where present; malformed lines never crash parsing.

---

### Phase 4 — Label Assignment (Right-Click)
**Goal:** Assign a label to a session via context menu.

Tasks:
1. Register `copilotCostTracker.assignLabel` on `view/item/context` for the sessions view.
2. Command shows a `QuickPick` of existing labels (plus "Clear label").
3. Persist via `StateManager.assignLabel`; refresh sessions tree.

**Acceptance:** Right-click → choose label → session row reflects new label and persists.

---

### Phase 5 — Dashboard Webview
**Goal:** "Open Dashboard" opens an editor tab with three visualizations.

Tasks:
1. `copilotCostTracker.openDashboard` command → `DashboardPanel` (singleton, `retainContextWhenHidden`).
2. Strict CSP; bundle `Chart.js` locally (no CDN).
3. Extension → webview message: aggregated payload
   `{ perSession, perLabel, monthlyTimeseries }`.
4. `dashboard.js` renders:
   - **Cost per Session** — bar chart.
   - **Cost per Label** — pie/doughnut (unlabeled grouped as "Unassigned").
   - **Total Cost Timeseries** — line chart, daily cumulative for current month.
5. KPI header: total credits, active labels, % vs previous month.
6. `[Refresh]` button → re-reads data and re-posts payload.

**Acceptance:** Dashboard opens as a tab; all three charts render from real data; refresh updates them.

---

### Phase 6 — Testing & Polish
Tasks:
1. Unit tests for `CostParser` (varied model strings, missing fields, multiple entries/session).
2. Unit tests for `StateManager` CRUD + cascade delete.
3. Integration smoke test: activation + command registration.
4. Empty-state UX (no sessions / no labels).
5. README with screenshots; `.vscodeignore`; package with `vsce`.

**Acceptance:** Tests green; clean package; graceful empty states.

---

## 4. Risks & Mitigations

| Risk | Mitigation |
| --- | --- |
| Log schema changes (`v.details` shape) | Defensive parsing + skip-on-error; centralize in `CostParser`. |
| Cross-platform storage path differences | Derive from `globalStorageUri`; OS fallbacks. |
| Large `.jsonl` files | Stream line-by-line; avoid loading whole file. |
| Credits absent in many lines | Treat missing as 0; never throw. |
| Webview CSP blocking charts | Bundle Chart.js locally with nonce-based CSP. |

---

## 5. Milestone Order (Build Sequence)

1. Phase 1 — Scaffolding & Activity Bar
2. Phase 2 — Labels CRUD
3. Phase 3 — Data Ingestion
4. Phase 4 — Label Assignment
5. Phase 5 — Dashboard
6. Phase 6 — Testing & Polish

Each phase is independently runnable/demoable before moving on.
