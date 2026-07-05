import { SessionCost } from "./types";

/**
 * A provider of chat-session cost data. Both {@link SessionReader} (Copilot) and
 * {@link ClaudeCodeReader} implement this so they can be merged behind one
 * interface consumed by the tree view and dashboard.
 */
export interface SessionSource {
  readAllSessions(): Promise<SessionCost[]>;
}

/**
 * Fans out to several {@link SessionSource}s and merges their sessions into a
 * single list, most-recent first. Individual source failures are isolated so
 * one unreadable source can't blank out the others.
 */
export class AggregateReader implements SessionSource {
  constructor(private readonly sources: SessionSource[]) {}

  async readAllSessions(): Promise<SessionCost[]> {
    const results = await Promise.all(
      this.sources.map((s) => s.readAllSessions().catch(() => []))
    );
    return results.flat().sort((a, b) => b.timestamp - a.timestamp);
  }
}
