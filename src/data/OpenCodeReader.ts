import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import initSqlJs, { Database, SqlJsStatic } from "sql.js";
import { SessionCost, TokenUsage } from "./types";
import { SessionSource } from "./SessionSource";
import { friendlyModelName } from "./ModelNames";

/** `globalState` key under which the parsed OpenCode cache is persisted. */
const CACHE_KEY = "creditCounter.openCodeCache";

/** Setting listing extra OpenCode data roots to scan, on top of the default. */
const DATA_ROOTS_SETTING = "creditCounter.opencode.dataRoots";

/**
 * One cached database's parse result, keyed by absolute `opencode.db` path.
 * `mtimeMs` and `size` together detect changes cheaply so the (expensive) load
 * of a multi-hundred-megabyte database is skipped when nothing has changed.
 */
interface CacheEntry {
  mtimeMs: number;
  size: number;
  sessions: SessionCost[];
}

/** Persisted cache envelope; discarded when the extension version changes. */
interface CacheEnvelope {
  version: string;
  entries: Record<string, CacheEntry>;
}

/** A single `session` row, before subagent costs are folded into parents. */
interface RawSession {
  id: string;
  /** Parent session id; empty for top-level (non-subagent) sessions. */
  parentId: string;
  directory?: string;
  title?: string;
  cost: number;
  timeCreated: number;
  tokens: TokenUsage;
  projectId?: string;
}

/** A top-level session with its descendants' cost and tokens accumulated in. */
interface RolledSession {
  root: RawSession;
  cost: number;
  tokens: TokenUsage;
  /** Cost attributed to each model across this session and its descendants. */
  costByModel: Record<string, number>;
  /** Number of descendant (subagent) sessions folded into this root. */
  subagentCount: number;
}

/**
 * Reads OpenCode session data from its SQLite store (`opencode.db`) and produces
 * per-session cost summaries. Recent OpenCode versions aggregate cost and token
 * usage onto each row of the `session` table, so no per-message pricing is
 * needed — we read those columns directly.
 *
 * OpenCode locates its data under `$XDG_DATA_HOME/opencode` (falling back to
 * `~/.local/share/opencode`). Users who run multiple profiles with distinct
 * `XDG_DATA_HOME` values can list those extra roots via the
 * `creditCounter.opencode.dataRoots` setting; the default location is always
 * scanned as well so no configuration is required out of the box.
 */
export class OpenCodeReader implements SessionSource {
  private inFlight: Promise<SessionCost[]> | undefined;

  /** Lazily-initialized sql.js module (loads the WASM once). */
  private sqlJs: Promise<SqlJsStatic> | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  private get version(): string {
    return (this.context.extension?.packageJSON?.version as string) ?? "0.0.0";
  }

  /**
   * Initializes sql.js once, locating the WASM binary that `esbuild.js` copies
   * next to the bundled extension (`dist/sql-wasm.wasm`).
   */
  private getSqlJs(): Promise<SqlJsStatic> {
    if (!this.sqlJs) {
      this.sqlJs = initSqlJs({
        locateFile: (file: string) => path.join(__dirname, file),
      });
    }
    return this.sqlJs;
  }

  /**
   * Resolves the absolute `opencode.db` paths to scan: the auto-discovered
   * default location plus any roots configured via {@link DATA_ROOTS_SETTING}.
   * Order is preserved and exact duplicate paths are collapsed; sessions
   * themselves are intentionally not de-duplicated across databases.
   */
  getDatabasePaths(): string[] {
    const roots: string[] = [];

    const xdgData =
      process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
    roots.push(xdgData);

    const configured = vscode.workspace
      .getConfiguration()
      .get<string[]>(DATA_ROOTS_SETTING, []);
    for (const entry of configured) {
      if (typeof entry === "string" && entry.trim()) {
        roots.push(this.expandHome(entry.trim()));
      }
    }

    const dbPaths: string[] = [];
    const seen = new Set<string>();
    for (const root of roots) {
      const db = this.resolveDbForRoot(root);
      if (db && !seen.has(db)) {
        seen.add(db);
        dbPaths.push(db);
      }
    }
    return dbPaths;
  }

  /**
   * Given a data root, returns the `opencode.db` path within it, if one exists.
   * A root may be an `XDG_DATA_HOME` directory (db at `<root>/opencode/…`) or
   * point directly at the folder containing the database.
   */
  private resolveDbForRoot(root: string): string | undefined {
    const candidates = [
      path.join(root, "opencode", "opencode.db"),
      path.join(root, "opencode.db"),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return undefined;
  }

  private expandHome(p: string): string {
    if (p === "~") {
      return os.homedir();
    }
    if (p.startsWith("~/") || p.startsWith("~\\")) {
      return path.join(os.homedir(), p.slice(2));
    }
    return p;
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

  /** Reads and aggregates all OpenCode sessions. Overlapping calls share one read. */
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
    const dbPaths = this.getDatabasePaths();
    if (dbPaths.length === 0) {
      return [];
    }

    const cache = this.loadCache();
    const nextCache: Record<string, CacheEntry> = {};
    const sessions: SessionCost[] = [];
    let dirty = false;

    for (const dbPath of dbPaths) {
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(dbPath);
      } catch {
        continue;
      }

      const hit = cache[dbPath];
      if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
        nextCache[dbPath] = hit;
        sessions.push(...hit.sessions);
        continue;
      }

      const parsed = await this.readDatabase(dbPath);
      nextCache[dbPath] = {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        sessions: parsed,
      };
      dirty = true;
      sessions.push(...parsed);
    }

    // Detect evictions: any previously-cached database not seen this pass.
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

  /** Reads one `opencode.db`, mapping each priced `session` row to a summary. */
  private async readDatabase(dbPath: string): Promise<SessionCost[]> {
    let bytes: Buffer;
    try {
      bytes = await fs.promises.readFile(dbPath);
    } catch {
      return [];
    }

    let db: Database | undefined;
    try {
      const SQL = await this.getSqlJs();
      db = new SQL.Database(bytes);
      // Read every session (not just priced ones): a subagent's cost lives on
      // its own child row while its parent conversation may report $0, so we
      // need the full set to attribute child costs to their top-level parent.
      const result = db.exec(
        `SELECT id, parent_id, directory, title, cost, time_created,
                tokens_input, tokens_output, tokens_cache_write, tokens_cache_read,
                project_id
           FROM session`
      );
      const rows = result[0]?.values;
      if (!rows) {
        return [];
      }

      const raw = new Map<string, RawSession>();
      for (const row of rows) {
        const id = typeof row[0] === "string" ? row[0] : String(row[0] ?? "");
        if (!id) {
          continue;
        }
        const parentId = typeof row[1] === "string" ? row[1] : "";
        raw.set(id, {
          id,
          parentId,
          directory: typeof row[2] === "string" ? row[2] : undefined,
          title: typeof row[3] === "string" ? row[3] : undefined,
          cost: this.num(row[4]),
          timeCreated: this.num(row[5]),
          tokens: {
            input: this.num(row[6]),
            output: this.num(row[7]),
            cacheWrite: this.num(row[8]),
            cacheRead: this.num(row[9]),
          },
          projectId: typeof row[10] === "string" ? row[10] : undefined,
        });
      }

      // Per-model cost lives on individual assistant messages (the `session`
      // row's aggregate `model` is often null), so read it from the `message`
      // table keyed by session id.
      const modelCostBySession = this.readModelCosts(db);

      // Fold every session's cost and tokens into its top-level ancestor
      // (subagents can themselves spawn subagents), keyed by the root's id.
      const rolled = new Map<string, RolledSession>();
      for (const s of raw.values()) {
        const root = this.rootOf(s, raw);
        let agg = rolled.get(root.id);
        if (!agg) {
          agg = {
            root,
            cost: 0,
            tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
            costByModel: {},
            subagentCount: 0,
          };
          rolled.set(root.id, agg);
        }
        if (s.id !== root.id) {
          agg.subagentCount += 1;
        }
        agg.cost += s.cost;
        agg.tokens.input += s.tokens.input;
        agg.tokens.output += s.tokens.output;
        agg.tokens.cacheWrite += s.tokens.cacheWrite;
        agg.tokens.cacheRead += s.tokens.cacheRead;
        // Attribute this (sub)session's message-level costs to the root.
        const perModel = modelCostBySession.get(s.id);
        if (perModel) {
          for (const [name, c] of perModel) {
            agg.costByModel[name] = (agg.costByModel[name] ?? 0) + c;
          }
        }
      }

      const sessions: SessionCost[] = [];
      for (const {
        root,
        cost,
        tokens,
        costByModel,
        subagentCount,
      } of rolled.values()) {
        // Only surface sessions that actually cost something, matching the
        // behaviour of the other readers (free/subscription models report $0).
        if (cost <= 0) {
          continue;
        }

        const cwd = root.directory;
        const displayTitle =
          root.title && root.title.trim()
            ? root.title.trim().replace(/\s+/g, " ").slice(0, 200)
            : root.id.slice(0, 8);

        sessions.push({
          sessionId: root.id,
          workspaceHash: root.projectId || this.workspaceNameFromCwd(cwd) || "unknown",
          workspaceName: this.workspaceNameFromCwd(cwd),
          firstPrompt: displayTitle,
          timestamp: root.timeCreated || Date.now(),
          totalCredits: Math.round(cost * 100) / 100,
          source: "opencode",
          tokens,
          // Scale message-derived per-model costs so they sum to the session's
          // authoritative rolled cost (message costs can drift slightly).
          costByModel: this.scaleByModel(costByModel, cost),
          subagentCount,
        });
      }
      return sessions;
    } catch {
      return []; // missing table/columns, or load failure
    } finally {
      db?.close();
    }
  }

  /**
   * Walks up the `parent_id` chain to the top-level session. Guards against
   * missing parents (orphans are their own root) and cyclic references.
   */
  private rootOf(
    session: RawSession,
    all: Map<string, RawSession>
  ): RawSession {
    let current = session;
    const visited = new Set<string>([current.id]);
    while (current.parentId) {
      const parent = all.get(current.parentId);
      if (!parent || visited.has(parent.id)) {
        break;
      }
      visited.add(parent.id);
      current = parent;
    }
    return current;
  }

  /**
   * Reads per-model cost from the `message` table, grouped by session. Each
   * assistant message stores its `modelID` and `cost` inside the `data` JSON
   * blob, so we use `json_extract` to sum cost per (session, model). Returns an
   * empty map if the table/columns are missing or the query fails.
   */
  private readModelCosts(db: Database): Map<string, Map<string, number>> {
    const bySession = new Map<string, Map<string, number>>();
    try {
      const result = db.exec(
        `SELECT session_id,
                json_extract(data, '$.modelID') AS model,
                SUM(json_extract(data, '$.cost')) AS cost
           FROM message
          WHERE json_extract(data, '$.role') = 'assistant'
            AND json_extract(data, '$.cost') > 0
          GROUP BY session_id, model`
      );
      const rows = result[0]?.values;
      if (!rows) {
        return bySession;
      }
      for (const row of rows) {
        const sessionId = typeof row[0] === "string" ? row[0] : "";
        if (!sessionId) {
          continue;
        }
        const name = friendlyModelName(
          typeof row[1] === "string" ? row[1] : undefined
        );
        const cost = this.num(row[2]);
        if (cost <= 0) {
          continue;
        }
        let models = bySession.get(sessionId);
        if (!models) {
          models = new Map<string, number>();
          bySession.set(sessionId, models);
        }
        models.set(name, (models.get(name) ?? 0) + cost);
      }
    } catch {
      // Missing `message` table or no json1 support — no model breakdown.
    }
    return bySession;
  }

  /**
   * Scales a per-model cost map so its values sum to `target` USD and rounds to
   * cents. Returns undefined when there is no per-model data (the dashboard then
   * buckets the session's cost under its harness name).
   */
  private scaleByModel(
    byModel: Record<string, number>,
    target: number
  ): Record<string, number> | undefined {
    const entries = Object.entries(byModel);
    if (entries.length === 0) {
      return undefined;
    }
    const sum = entries.reduce((acc, [, v]) => acc + v, 0);
    const factor = sum > 0 ? target / sum : 0;
    const out: Record<string, number> = {};
    for (const [k, v] of entries) {
      out[k] = Math.round(v * factor * 100) / 100;
    }
    return out;
  }

  private num(value: unknown): number {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const n = Number(value);
      return Number.isFinite(n) ? n : 0;
    }
    return 0;
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
