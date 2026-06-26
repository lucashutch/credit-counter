import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as readline from "readline";
import { SessionCost } from "./types";
import { sumCreditsInLine } from "./CostParser";

/** `globalState` key under which the parsed-session cache is persisted. */
const CACHE_KEY = "copilotCostTracker.sessionCache";

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
export class SessionReader {
  /** In-flight `readAllSessions` promise, used to single-flight overlapping calls. */
  private inFlight: Promise<SessionCost[]> | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Current extension version, used as the cache invalidation key. */
  private get version(): string {
    return (this.context.extension?.packageJSON?.version as string) ?? "0.0.0";
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
      const chatDir = path.join(root, workspaceHash, "chatSessions");
      let files: string[];
      try {
        files = await fs.promises.readdir(chatDir);
      } catch {
        continue; // workspace has no chat sessions
      }
      const workspaceName = await this.readWorkspaceName(
        path.join(root, workspaceHash)
      );
      for (const file of files) {
        if (!file.endsWith(".jsonl")) {
          continue;
        }
        const filePath = path.join(chatDir, file);

        let stat: fs.Stats;
        try {
          stat = await fs.promises.stat(filePath);
        } catch {
          continue; // file vanished between readdir and stat
        }

        const hit = cache[filePath];
        if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
          // Reuse the cached parse result; re-stamp the workspace name in case
          // it changed (the file content didn't, but its metadata might have).
          const session = hit.session
            ? { ...hit.session, workspaceName }
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
          workspaceName
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

  /** Streams one `.jsonl` file, tallying credits and extracting display metadata. */
  private async readSessionFile(
    filePath: string,
    workspaceHash: string,
    workspaceName: string | undefined
  ): Promise<SessionCost | undefined> {
    const sessionId = path.basename(filePath, ".jsonl");
    let totalCredits = 0;
    let firstPrompt = "";
    let customTitle = "";
    let timestamp = 0;

    try {
      const stream = fs.createReadStream(filePath, { encoding: "utf8" });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

      for await (const line of rl) {
        if (!line.trim()) {
          continue;
        }
        // Credits: scan the raw line (resilient to schema differences).
        totalCredits += sumCreditsInLine(line);

        // Metadata: parse the line and pull prompt/timestamp from requests.
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
        if (!firstPrompt && meta.firstPrompt) {
          firstPrompt = meta.firstPrompt;
        }
        if (meta.customTitle) {
          customTitle = meta.customTitle;
        }
        if (meta.creationDate && timestamp === 0) {
          timestamp = meta.creationDate;
        }
      }
    } catch {
      return undefined;
    }

    // Prefer the user/AI-assigned custom title; fall back to the first prompt.
    const displayTitle = customTitle || firstPrompt;

    // Exclude sessions that never captured a title or prompt.
    if (!displayTitle) {
      return undefined;
    }

    if (timestamp === 0) {
      // Fall back to file mtime if no in-file timestamp was found.
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
      firstPrompt: displayTitle,
      timestamp,
      totalCredits: Math.round(totalCredits * 10) / 10,
    };
  }

  /** Extracts prompt text / timestamps from a parsed JSONL record. */
  private extractMetadata(parsed: unknown): {
    firstPrompt?: string;
    customTitle?: string;
    timestamp?: number;
    creationDate?: number;
  } {
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    const obj = parsed as Record<string, unknown>;
    const v = obj.v as Record<string, unknown> | undefined;
    const result: {
      firstPrompt?: string;
      customTitle?: string;
      timestamp?: number;
      creationDate?: number;
    } = {};

    if (v && typeof v.creationDate === "number") {
      result.creationDate = v.creationDate;
    }

    // Custom title: lines shaped like {"kind":1,"k":["customTitle"],"v":"..."}.
    const k = obj.k;
    if (
      Array.isArray(k) &&
      k[0] === "customTitle" &&
      typeof obj.v === "string" &&
      obj.v.trim()
    ) {
      result.customTitle = obj.v.trim().replace(/\s+/g, " ");
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
      if (!result.firstPrompt) {
        const message = req.message as Record<string, unknown> | undefined;
        const text = message?.text;
        if (typeof text === "string" && text.trim()) {
          result.firstPrompt = text.trim().replace(/\s+/g, " ").slice(0, 40);
        }
      }
    }
    return result;
  }
}
