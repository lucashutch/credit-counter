# Credit Counter

Track, label, and visualize the cost of your local Copilot **and Claude Code** chat sessions — right inside VS Code.

The extension reads your **local Copilot chat logs and Claude Code transcripts** (no network calls, no telemetry), tallies each session's cost, and lets you organize sessions with custom labels and explore the data in a dashboard. Sessions are tagged by source (Copilot / Claude Code) and can be filtered by source.

> **Everything is normalized to US dollars.** Copilot credits are converted at **$0.01/credit** (1 GitHub Copilot AI credit = US$0.01); Claude Code sessions have no credit concept, so their cost is computed from per-model token usage (Anthropic list pricing). Costs across both sources therefore aggregate directly (e.g. `$0.73`).

## Features

### Activity bar & sidebar
- A dedicated **Credit Counter** icon in the Activity Bar.
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

Session data is sourced entirely from local storage on your machine.

**Copilot** — from VS Code's workspace storage:

```text
<User>/workspaceStorage/<hash>/chatSessions/<sessionId>.jsonl
```

Each `.jsonl` file is streamed line by line. Credit values are extracted from
`details` strings such as `"Claude Opus 4.8 • 143.6 credits"`, summed per
session, and converted to US dollars at $0.01/credit. Session titles use the
chat's custom title when available.

**Claude Code** — from the Claude CLI's project transcripts:

```text
~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
```

Claude Code records raw token usage but no cost, so each assistant turn's
tokens (input, output, cache-write, cache-read) are priced per model to a
US-dollar total. Session titles come from the first real user prompt, and the
repository name from the session's working directory.

Labels and assignments are stored in the extension's `globalState`, so they
persist across reloads and workspaces. Both storage locations are detected
automatically (Copilot across Linux/macOS/Windows and Insiders/OSS builds;
Claude Code honoring `CLAUDE_CONFIG_DIR`).

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
| `Credit Counter: Open Dashboard` | Open the analytics dashboard |
| `Credit Counter: Add Label` | Create a new label |
| `Credit Counter: Rename Label` | Rename an existing label |
| `Credit Counter: Delete Label` | Delete a label (and its assignments) |
| `Credit Counter: Assign Label` | Assign a label to a session (right-click) |
| `Credit Counter: Refresh Sessions` | Re-read the chat logs |

## Privacy

All data is read locally from your own machine. The extension makes no network
requests and collects no telemetry.
