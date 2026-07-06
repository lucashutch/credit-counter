import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as readline from "readline";
import { SessionCost, TokenUsage } from "./types";
import { SessionSource } from "./SessionSource";
import { costForUsage, PricedUsage } from "./ClaudeCodePricing";
import { friendlyModelName } from "./ModelNames";
import { ModelsDevPricing, RateMap } from "./ModelsDevPricing";

/** `globalState` key under which the parsed Claude Code cache is persisted. */
const CACHE_KEY = "creditCounter.claudeCodeCache";

/** Rounds each value of a per-model USD map to cents; undefined when empty. */
function roundCents(
  byModel: Record<string, number>
): Record<string, number> | undefined {
  const entries = Object.entries(byModel);
  if (entries.length === 0) {
    return undefined;
  }
  const out: Record<string, number> = {};
  for (const [k, v] of entries) {
    out[k] = Math.round(v * 100) / 100;
  }
  return out;
}

/**
 * One cached file's parse result, keyed by absolute file path. `mtimeMs` and
 * `size` together detect changes cheaply. `session` is `null` when the file
 * parsed but produced nothing displayable, so we don't re-parse it.
 */
interface CacheEntry {
  mtimeMs: number;
  size: number;
  /**
   * Freshness stamp of the models.dev pricing used to cost this file. When the
   * pricing refreshes, this changes and the file is re-parsed so costs re-price
   * against the new rates.
   */
  pricingStamp: number;
  session: SessionCost | null;
}

/** Persisted cache envelope; discarded when the extension version changes. */
interface CacheEnvelope {
  version: string;
  entries: Record<string, CacheEntry>;
}

/** A parsed assistant `message.usage` block. Only fields we price are modelled. */
interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  /** Cache-creation split by TTL tier; present on recent Claude Code versions. */
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}

/**
 * Reads Claude Code session transcripts from `~/.claude/projects/<encoded-cwd>/`
 * and produces per-session cost summaries. Each `<uuid>.jsonl` file is one
 * session; cost is derived from per-turn token usage priced by model.
 */
export class ClaudeCodeReader implements SessionSource {
  private inFlight: Promise<SessionCost[]> | undefined;
  private readonly pricing: ModelsDevPricing;

  constructor(
    private readonly context: vscode.ExtensionContext,
    pricing?: ModelsDevPricing
  ) {
    this.pricing = pricing ?? new ModelsDevPricing(context);
  }

  private get version(): string {
    return (this.context.extension?.packageJSON?.version as string) ?? "0.0.0";
  }

  /** Absolute path to the Claude Code projects directory (may not exist). */
  getProjectsRoot(): string {
    return (
      process.env.CLAUDE_CONFIG_DIR
        ? path.join(process.env.CLAUDE_CONFIG_DIR, "projects")
        : path.join(os.homedir(), ".claude", "projects")
    );
  }

  private loadCache(): Record<string, CacheEntry> {
    const env = this.context.globalState.get<CacheEnvelope>(CACHE_KEY);
    if (!env || env.version !== this.version || !env.entries) {
      return {};
    }
    return env.entries;
  }

  private async saveCache(entries: Record<string, CacheEntry>): Promise<void> {
    const env: CacheEnvelope = { version: this.version, entries };
    await this.context.globalState.update(CACHE_KEY, env);
  }

  /** Reads and aggregates all Claude Code sessions. Overlapping calls share one read. */
  async readAllSessions(): Promise<SessionCost[]> {
    if (this.inFlight) {
      return this.inFlight;
    }
    this.inFlight = this.readAllSessionsUncached();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = undefined;
    }
  }

  private async readAllSessionsUncached(): Promise<SessionCost[]> {
    const root = this.getProjectsRoot();
    if (!fs.existsSync(root)) {
      return [];
    }

    let projectDirs: string[];
    try {
      projectDirs = await fs.promises.readdir(root);
    } catch {
      return [];
    }

    // Rates used to price token usage; empty (→ $0) when models.dev is
    // unavailable and nothing has been fetched yet.
    const { rates, stamp: pricingStamp } = await this.pricing.getRates();

    const cache = this.loadCache();
    const nextCache: Record<string, CacheEntry> = {};
    const sessions: SessionCost[] = [];
    let dirty = false;

    for (const projectDir of projectDirs) {
      const dirPath = path.join(root, projectDir);
      let files: string[];
      try {
        files = await fs.promises.readdir(dirPath);
      } catch {
        continue;
      }

      for (const file of files) {
        if (!file.endsWith(".jsonl")) {
          continue;
        }
        const filePath = path.join(dirPath, file);

        let stat: fs.Stats;
        try {
          stat = await fs.promises.stat(filePath);
        } catch {
          continue;
        }

        const hit = cache[filePath];
        if (
          hit &&
          hit.mtimeMs === stat.mtimeMs &&
          hit.size === stat.size &&
          hit.pricingStamp === pricingStamp
        ) {
          nextCache[filePath] = hit;
          if (hit.session) {
            sessions.push(hit.session);
          }
          continue;
        }

        const session = await this.readSessionFile(filePath, projectDir, rates);
        nextCache[filePath] = {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          pricingStamp,
          session: session ?? null,
        };
        dirty = true;
        if (session) {
          sessions.push(session);
        }
      }
    }

    // Detect evictions: any previously-cached file not seen this pass.
    if (!dirty) {
      for (const key of Object.keys(cache)) {
        if (!(key in nextCache)) {
          dirty = true;
          break;
        }
      }
    }

    if (dirty) {
      await this.saveCache(nextCache);
    }

    sessions.sort((a, b) => b.timestamp - a.timestamp);
    return sessions;
  }

  /** Streams one transcript, pricing token usage and extracting metadata. */
  private async readSessionFile(
    filePath: string,
    projectDir: string,
    rates: RateMap
  ): Promise<SessionCost | undefined> {
    const sessionId = path.basename(filePath, ".jsonl");
    const tokens: TokenUsage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
    const costByModel: Record<string, number> = {};
    let costUsd = 0;
    // Subagents are launched via the `Task` tool; count its invocations.
    let subagentCount = 0;
    let timestamp = 0;
    let title = "";
    // Claude Code's own generated session title (shown in `claude --resume`),
    // logged as `{"type":"ai-title","aiTitle":"…"}` and rewritten as it is
    // regenerated — the last one wins. Preferred over the first user prompt.
    let aiTitle = "";
    let cwd: string | undefined;
    // A single assistant response is logged across multiple lines (one per
    // streamed content block), each repeating the same `message.id` and the
    // same cumulative `usage`. Count each message's usage only once.
    const seenMessageIds = new Set<string>();
    // `Task` tool_use block ids already counted, to avoid double-counting a
    // block that recurs across streamed lines.
    const seenTaskIds = new Set<string>();

    try {
      const stream = fs.createReadStream(filePath, { encoding: "utf8" });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

      for await (const line of rl) {
        if (!line.trim()) {
          continue;
        }
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }

        const ts = this.parseTimestamp(parsed.timestamp);
        if (ts && (timestamp === 0 || ts < timestamp)) {
          timestamp = ts;
        }
        if (!cwd && typeof parsed.cwd === "string") {
          cwd = parsed.cwd;
        }

        const message = parsed.message as Record<string, unknown> | undefined;

        // Cost: price each assistant turn's usage by its model, once per message.
        if (parsed.type === "assistant" && message) {
          const usage = message.usage as RawUsage | undefined;
          const messageId = message.id as string | undefined;
          const alreadyCounted = messageId
            ? seenMessageIds.has(messageId)
            : false;
          if (usage && !alreadyCounted) {
            if (messageId) {
              seenMessageIds.add(messageId);
            }
            // Cache-creation is tiered (5-minute vs 1-hour). Prefer the split
            // breakdown; fall back to the flat field (treated as 5-minute).
            const split = usage.cache_creation;
            const total = usage.cache_creation_input_tokens ?? 0;
            const cache5m =
              split?.ephemeral_5m_input_tokens ??
              (split ? 0 : total);
            const cache1h = split?.ephemeral_1h_input_tokens ?? 0;

            const priced: PricedUsage = {
              input: usage.input_tokens ?? 0,
              output: usage.output_tokens ?? 0,
              cacheWrite5m: cache5m,
              cacheWrite1h: cache1h,
              cacheRead: usage.cache_read_input_tokens ?? 0,
            };
            tokens.input += priced.input;
            tokens.output += priced.output;
            tokens.cacheWrite += cache5m + cache1h;
            tokens.cacheRead += priced.cacheRead;
            const model = message.model as string | undefined;
            const turnCost = costForUsage(model, priced, rates);
            costUsd += turnCost;
            if (turnCost > 0) {
              const name = friendlyModelName(model);
              costByModel[name] = (costByModel[name] ?? 0) + turnCost;
            }
          }
          // Count `Task` tool_use blocks (each spawns a subagent), deduped by
          // the block id since a block can recur across streamed lines.
          const content = message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              const b = block as Record<string, unknown>;
              if (b && b.type === "tool_use" && b.name === "Task") {
                const id = typeof b.id === "string" ? b.id : "";
                if (!id || !seenTaskIds.has(id)) {
                  if (id) {
                    seenTaskIds.add(id);
                  }
                  subagentCount += 1;
                }
              }
            }
          }
        }

        // Title: prefer Claude Code's generated title; keep the latest one.
        if (parsed.type === "ai-title" && typeof parsed.aiTitle === "string") {
          const t = parsed.aiTitle.trim().replace(/\s+/g, " ");
          if (t) {
            aiTitle = t;
          }
        }

        // Fallback title: first real user prompt (skip meta/command turns).
        if (!title && parsed.type === "user" && parsed.isMeta !== true && message) {
          const text = this.userText(message.content);
          if (text) {
            title = text;
          }
        }
      }
    } catch {
      return undefined;
    }

    // Only surface sessions that actually cost something.
    if (costUsd <= 0) {
      return undefined;
    }

    if (timestamp === 0) {
      try {
        timestamp = (await fs.promises.stat(filePath)).mtimeMs;
      } catch {
        timestamp = Date.now();
      }
    }

    return {
      sessionId,
      workspaceHash: projectDir,
      workspaceName: this.workspaceNameFromCwd(cwd),
      firstPrompt: aiTitle || title || sessionId.slice(0, 8),
      timestamp,
      totalCredits: Math.round(costUsd * 100) / 100,
      source: "claude-code",
      tokens,
      costByModel: roundCents(costByModel),
      subagentCount,
    };
  }

  /** Parses an ISO-8601 (or epoch-ms) timestamp into epoch milliseconds. */
  private parseTimestamp(value: unknown): number {
    if (typeof value === "number") {
      return value;
    }
    if (typeof value === "string") {
      const ms = Date.parse(value);
      return Number.isNaN(ms) ? 0 : ms;
    }
    return 0;
  }

  /**
   * Extracts a display-worthy first line from a user `content` (string or block
   * array), skipping command/reminder wrappers and tool results.
   */
  private userText(content: unknown): string {
    let raw = "";
    if (typeof content === "string") {
      raw = content;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (
          block &&
          typeof block === "object" &&
          (block as Record<string, unknown>).type === "text" &&
          typeof (block as Record<string, unknown>).text === "string"
        ) {
          raw = (block as Record<string, unknown>).text as string;
          break;
        }
      }
    }
    const trimmed = raw.trim();
    // Skip synthetic wrappers and tool results that aren't real prompts.
    if (!trimmed || trimmed.startsWith("<") || trimmed.startsWith("[")) {
      return "";
    }
    return trimmed.replace(/\s+/g, " ").slice(0, 200);
  }

  /** Derives a repo name from a session's working directory. */
  private workspaceNameFromCwd(cwd: string | undefined): string | undefined {
    if (!cwd) {
      return undefined;
    }
    const cleaned = cwd.replace(/[/\\]+$/, "");
    const name = cleaned.substring(
      Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\")) + 1
    );
    return name || undefined;
  }
}
