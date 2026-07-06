import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as readline from "readline";
import initSqlJs, { Database, SqlJsStatic } from "sql.js";
import { SessionCost } from "./types";
import { sumCreditsInLine, addCreditsByModelInLine } from "./CostParser";
import { SessionSource } from "./SessionSource";

/** `globalState` key under which the parsed-session cache is persisted. */
const CACHE_KEY = "creditCounter.sessionCache";

/** SQLite `ItemTable` key holding the chat-session index JSON. */
const SESSION_INDEX_KEY = "chat.ChatSessionStore.index";

/** US-dollar value of one GitHub Copilot AI credit. */
const CREDIT_USD = 0.01;

/** Converts a raw per-model credit map to USD, rounded to cents. */
function toUsdByModel(
  credits: Record<string, number>
): Record<string, number> | undefined {
  const entries = Object.entries(credits);
  if (entries.length === 0) {
    return undefined;
  }
  const out: Record<string, number> = {};
  for (const [model, value] of entries) {
    out[model] = Math.round(value * CREDIT_USD * 100) / 100;
  }
  return out;
}

/**
 * One session entry as stored in the `chat.ChatSessionStore.index` value of
 * `state.vscdb`. Only the fields we consume are modelled.
 */
interface SessionIndexEntry {
  sessionId: string;
  title?: string;
  isEmpty?: boolean;
  timing?: { created?: number };
  lastMessageDate?: number;
}

/** Parsed shape of the `chat.ChatSessionStore.index` value. */
interface SessionIndex {
  version?: number;
  entries?: Record<string, SessionIndexEntry>;
}


/**
 * One cached file's parse result, keyed by absolute file path. `mtimeMs` and
 * `size` together detect changes cheaply (a `stat` instead of a full re-read).
 * `session` is `null` when the file parsed successfully but produced no
 * displayable session (e.g. no title/prompt), so we don't re-parse it.
 */
interface CacheEntry {
  mtimeMs: number;
  size: number;
  session: SessionCost | null;
}

/**
 * Persisted cache envelope. `version` is the extension version; when it differs
 * from the running extension the entire cache is discarded so that changes to
 * the parsing logic can't surface stale results.
 */
interface CacheEnvelope {
  version: string;
  entries: Record<string, CacheEntry>;
}

/**
 * Reads Copilot chat session logs from VS Code's `workspaceStorage` directory
 * and produces per-session cost summaries.
 */
export class SessionReader implements SessionSource {
  /** In-flight `readAllSessions` promise, used to single-flight overlapping calls. */
  private inFlight: Promise<SessionCost[]> | undefined;

  /** Lazily-initialized sql.js module (loads the WASM once). */
  private sqlJs: Promise<SqlJsStatic> | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Current extension version, used as the cache invalidation key. */
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

  /** Loads the persisted cache, discarding it if the extension version changed. */
  private loadCache(): Record<string, CacheEntry> {
    const env = this.context.globalState.get<CacheEnvelope>(CACHE_KEY);
    if (!env || env.version !== this.version || !env.entries) {
      return {};
    }
    return env.entries;
  }

  /** Persists the cache under the current extension version. */
  private async saveCache(entries: Record<string, CacheEntry>): Promise<void> {
    const env: CacheEnvelope = { version: this.version, entries };
    await this.context.globalState.update(CACHE_KEY, env);
  }

  /**
   * Resolves the absolute path to `.../User/workspaceStorage`.
   *
   * Preferred: derive it from `globalStorageUri`, which points at
   * `.../User/globalStorage/<ext-id>` — its grandparent is `User`. This handles
   * portable installs, Insiders, OSS builds, and custom `--user-data-dir`.
   * Falls back to per-OS defaults if the derived path is missing.
   */
  getWorkspaceStorageRoot(): string | undefined {
    const derived = this.deriveFromGlobalStorage();
    if (derived && fs.existsSync(derived)) {
      return derived;
    }
    for (const candidate of this.defaultRoots()) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return derived; // may not exist, but best effort for diagnostics
  }

  private deriveFromGlobalStorage(): string | undefined {
    const gs = this.context.globalStorageUri?.fsPath;
    if (!gs) {
      return undefined;
    }
    // gs = .../User/globalStorage/<publisher.name>
    const userDir = path.resolve(gs, "..", "..");
    return path.join(userDir, "workspaceStorage");
  }

  private defaultRoots(): string[] {
    const home = os.homedir();
    const roots: string[] = [];
    const names = ["Code", "Code - Insiders", "VSCodium", "Code - OSS"];
    if (process.platform === "darwin") {
      for (const n of names) {
        roots.push(
          path.join(home, "Library", "Application Support", n, "User", "workspaceStorage")
        );
      }
    } else if (process.platform === "win32") {
      const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
      for (const n of names) {
        roots.push(path.join(appData, n, "User", "workspaceStorage"));
      }
    } else {
      const configHome = process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");
      for (const n of names) {
        roots.push(path.join(configHome, n, "User", "workspaceStorage"));
      }
    }
    return roots;
  }

  /**
   * Reads and aggregates all chat sessions found under the storage root.
   *
   * Overlapping calls share a single in-flight read (the tree view and the
   * dashboard both call this independently). Results are cached per file keyed
   * on `mtime`+`size`; unchanged files skip the (expensive) streaming parse.
   */
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
    const root = this.getWorkspaceStorageRoot();
    if (!root || !fs.existsSync(root)) {
      return [];
    }

    let workspaceHashes: string[];
    try {
      workspaceHashes = await fs.promises.readdir(root);
    } catch {
      return [];
    }

    const cache = this.loadCache();
    const nextCache: Record<string, CacheEntry> = {};
    const sessions: SessionCost[] = [];
    // Whether the cache changed (entry added/updated/evicted) and must be saved.
    let dirty = false;

    for (const workspaceHash of workspaceHashes) {
      const workspaceDir = path.join(root, workspaceHash);
      // The chat-session index lives in the workspace's SQLite state store.
      const indexEntries = await this.readSessionIndex(workspaceDir);
      if (!indexEntries.length) {
        continue; // workspace has no chat sessions (or no/locked db)
      }
      const chatDir = path.join(workspaceDir, "chatSessions");
      const workspaceName = await this.readWorkspaceName(workspaceDir);

      for (const entry of indexEntries) {
        // Skip sessions the editor flagged as empty (no real activity).
        if (entry.isEmpty) {
          continue;
        }
        // Direct path construction — no globbing needed.
        const filePath = path.join(chatDir, `${entry.sessionId}.jsonl`);

        // The display title always comes from the database, never the file.
        const title = (entry.title ?? "").trim().replace(/\s+/g, " ");

        let stat: fs.Stats;
        try {
          stat = await fs.promises.stat(filePath);
        } catch {
          continue; // indexed session has no backing file
        }

        const hit = cache[filePath];
        if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
          // Reuse the cached parse result; re-stamp the workspace name and the
          // DB-sourced title (file content unchanged, but metadata might differ).
          const session = hit.session
            ? { ...hit.session, workspaceName, firstPrompt: title }
            : null;
          nextCache[filePath] = { ...hit, session };
          if (session) {
            sessions.push(session);
          }
          continue;
        }

        const session = await this.readSessionFile(
          filePath,
          workspaceHash,
          workspaceName,
          title,
          entry
        );
        nextCache[filePath] = {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
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

    // Most recent first.
    sessions.sort((a, b) => b.timestamp - a.timestamp);
    return sessions;
  }

  /**
   * Reads `workspace.json` for a workspace storage folder and derives a
   * human-readable name from its `folder` (or `workspace`) URI. Returns
   * undefined when unavailable.
   */
  private async readWorkspaceName(
    workspaceDir: string
  ): Promise<string | undefined> {
    try {
      const raw = await fs.promises.readFile(
        path.join(workspaceDir, "workspace.json"),
        "utf8"
      );
      const json = JSON.parse(raw) as {
        folder?: string;
        workspace?: string;
      };
      const uri = json.folder ?? json.workspace;
      if (!uri) {
        return undefined;
      }
      // Take the last path segment of the URI as the name.
      const decoded = decodeURIComponent(uri.replace(/\/+$/, ""));
      let name = decoded.substring(decoded.lastIndexOf("/") + 1);
      // For multi-root workspaces, strip the .code-workspace extension.
      name = name.replace(/\.code-workspace$/i, "");
      return name || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Reads the chat-session index from a workspace's `state.vscdb` SQLite store.
   *
   * The index lives under the `chat.ChatSessionStore.index` key as a JSON blob.
   * The database is opened from an in-memory copy of the file bytes (via
   * sql.js) so we never contend with the lock VS Code holds on the live file.
   * Returns an empty array when the db/key is missing or unreadable.
   */
  private async readSessionIndex(
    workspaceDir: string
  ): Promise<SessionIndexEntry[]> {
    const dbPath = path.join(workspaceDir, "state.vscdb");
    let bytes: Buffer;
    try {
      bytes = await fs.promises.readFile(dbPath);
    } catch {
      return []; // no state store for this workspace
    }

    let db: Database | undefined;
    try {
      const SQL = await this.getSqlJs();
      db = new SQL.Database(bytes);
      const result = db.exec(
        "SELECT value FROM ItemTable WHERE key = ?",
        [SESSION_INDEX_KEY]
      );
      const raw = result[0]?.values?.[0]?.[0];
      if (typeof raw !== "string") {
        return [];
      }
      const index = JSON.parse(raw) as SessionIndex;
      const entries = index.entries;
      if (!entries || typeof entries !== "object") {
        return [];
      }
      return Object.values(entries).filter(
        (e): e is SessionIndexEntry =>
          !!e && typeof e.sessionId === "string"
      );
    } catch {
      return []; // missing table/key, malformed json, or load failure
    } finally {
      db?.close();
    }
  }

  /** Streams one `.jsonl` file, tallying credits and extracting the timestamp. */
  private async readSessionFile(
    filePath: string,
    workspaceHash: string,
    workspaceName: string | undefined,
    title: string,
    indexEntry: SessionIndexEntry
  ): Promise<SessionCost | undefined> {
    const sessionId = path.basename(filePath, ".jsonl");
    let totalCredits = 0;
    let timestamp = 0;
    // Per-model credit tallies (raw Copilot credits, converted to USD below).
    const creditsByModel: Record<string, number> = {};

    try {
      const stream = fs.createReadStream(filePath, { encoding: "utf8" });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

      for await (const line of rl) {
        if (!line.trim()) {
          continue;
        }
        // Credits: scan the raw line (resilient to schema differences).
        totalCredits += sumCreditsInLine(line);
        addCreditsByModelInLine(line, creditsByModel);

        // Metadata: parse the line and pull the earliest timestamp from requests.
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue; // skip malformed lines without crashing
        }
        const meta = this.extractMetadata(parsed);
        if (meta.timestamp && (timestamp === 0 || meta.timestamp < timestamp)) {
          timestamp = meta.timestamp;
        }
        if (meta.creationDate && timestamp === 0) {
          timestamp = meta.creationDate;
        }
      }
    } catch {
      return undefined;
    }

    // The display title always comes from the database.
    if (!title) {
      return undefined;
    }

    if (timestamp === 0) {
      // Fall back to the index's created time, then file mtime.
      timestamp = indexEntry.timing?.created ?? 0;
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
      workspaceHash,
      workspaceName,
      firstPrompt: title,
      timestamp,
      // Stored in USD (1 credit = $0.01) so all sources share one unit.
      totalCredits: Math.round(totalCredits * CREDIT_USD * 100) / 100,
      source: "copilot",
      costByModel: toUsdByModel(creditsByModel),
    };
  }

  /** Extracts the earliest timestamp / creation date from a parsed JSONL record. */
  private extractMetadata(parsed: unknown): {
    timestamp?: number;
    creationDate?: number;
  } {
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    const obj = parsed as Record<string, unknown>;
    const v = obj.v as Record<string, unknown> | undefined;
    const result: {
      timestamp?: number;
      creationDate?: number;
    } = {};

    if (v && typeof v.creationDate === "number") {
      result.creationDate = v.creationDate;
    }

    // Requests can live in v.requests (header) or v itself (kind:2 with k:["requests"]).
    const requests: unknown[] = Array.isArray(v?.requests)
      ? (v!.requests as unknown[])
      : Array.isArray(obj.v)
      ? (obj.v as unknown[])
      : [];

    for (const r of requests) {
      if (!r || typeof r !== "object") {
        continue;
      }
      const req = r as Record<string, unknown>;
      if (typeof req.timestamp === "number") {
        result.timestamp =
          result.timestamp === undefined
            ? req.timestamp
            : Math.min(result.timestamp, req.timestamp);
      }
    }
    return result;
  }
}
