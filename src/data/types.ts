/**
 * Shared data-model types for the Copilot Cost Tracker extension.
 */

/** A user-defined label that can be assigned to chat sessions. */
export interface Label {
  /** Stable unique identifier (uuid-like). */
  id: string;
  /** Display name shown in the sidebar. */
  name: string;
  /** Optional hex color used for charts in the dashboard. */
  color?: string;
}

/** Aggregated cost information for a single chat session (Phase 3+). */
export interface SessionCost {
  /** Filename without the `.jsonl` extension. */
  sessionId: string;
  /** Parent `workspaceStorage` directory hash. */
  workspaceHash: string;
  /** Snippet of the first prompt, for display. */
  firstPrompt: string;
  /** Earliest request time in epoch milliseconds. */
  timestamp: number;
  /** Sum of all parsed credit values in the session. */
  totalCredits: number;
  /** Assigned label id, if any. */
  labelId?: string;
}

/** A single parsed cost entry extracted from a `details` string (Phase 3+). */
export interface CostEntry {
  /** Model name, e.g. "Claude Opus 4.8". */
  model: string;
  /** Parsed credit value, e.g. 143.6. */
  credits: number;
}
