# Copilot Cost Tracker

Track, label, and visualize the credit cost of your local Copilot chat sessions — right inside VS Code.

The extension reads your **local Copilot chat logs** (no network calls, no telemetry), tallies the credits reported in each session, and lets you organize sessions with custom labels and explore the data in a dashboard.

## Features

### Activity bar & sidebar
- A dedicated **Copilot Cost Tracker** icon in the Activity Bar.
- **Label Management** — add, rename, and delete labels (e.g. *Project Alpha*, *Debugging*, *Research*).
- **Chat Sessions** — every detected session, most recent first, showing its title, total credits, and assigned label.
- **Open Dashboard** button at the top of the sidebar.

### Label assignment
- **Right-click any session → Assign Label** to categorize it (or clear the label).
- Deleting a label automatically removes it from all sessions.

### Dashboard
Opens in an editor tab with:
- **KPIs** — total credits, active labels, this-month spend, and % change vs the previous month.
- **Cost per Label** — doughnut chart (includes an *Unassigned* bucket).
- **Cost per Session** — top 15 sessions, each bar colored by its label.
- **Total Cost Timeseries** — daily cumulative credits for the current month.
- A **Refresh** button to re-read the latest logs.

## How it works

Session data is sourced entirely from VS Code's local storage:

```text
<User>/workspaceStorage/<hash>/chatSessions/<sessionId>.jsonl
```

Each `.jsonl` file is streamed line by line. Credit values are extracted from
`details` strings such as `"Claude Opus 4.8 • 143.6 credits"` and summed per
session. Session titles use the chat's custom title when available, otherwise
the first prompt. Labels and assignments are stored in the extension's
`globalState`, so they persist across reloads and workspaces.

The storage location is detected automatically and works across Linux, macOS,
Windows, and Insiders/OSS builds.

## Getting started

### Install locally
```bash
./install.sh            # build + install into ~/.vscode/extensions
# VSCODE_DIR=~/.vscode-insiders ./install.sh   # for Insiders
```
Then run **Developer: Reload Window**.

### Develop
```bash
npm install
npm run watch    # rebuild on change
# Press F5 to launch the Extension Development Host
```

### Test
```bash
npm test         # runs the unit suite (Mocha + ts-node)
```

## Commands

| Command | Description |
| --- | --- |
| `Copilot Cost Tracker: Open Dashboard` | Open the analytics dashboard |
| `Copilot Cost Tracker: Add Label` | Create a new label |
| `Copilot Cost Tracker: Rename Label` | Rename an existing label |
| `Copilot Cost Tracker: Delete Label` | Delete a label (and its assignments) |
| `Copilot Cost Tracker: Assign Label` | Assign a label to a session (right-click) |
| `Copilot Cost Tracker: Refresh Sessions` | Re-read the chat logs |

## Privacy

All data is read locally from your own machine. The extension makes no network
requests and collects no telemetry.
