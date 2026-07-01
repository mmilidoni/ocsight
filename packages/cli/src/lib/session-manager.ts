import { glob } from "glob";
import { watch, stat as fsStat } from "fs/promises";
import { join } from "path";
import { readFile } from "fs/promises";
import { runtime } from "./runtime-compat.js";
import { openDb, closeDb, queryAll } from "./database.js";
import { getDefaultOpenCodePath } from "./data.js";

export interface SessionIndex {
  id: string;
  mtime: number;
  size: number;
  filePath: string;
}

export interface MessageSummary {
  role: string;
  created: number;
  tokens: {
    input: number;
    output: number;
    reasoning?: number;
    cache?: { write: number; read: number };
  };
  cost?: number;
  modelID?: string;
  providerID?: string;
}

export interface RecentActivity {
  messages: number;
  tokens: number;
  cost: number;
  tokens_per_minute: number;
  cost_per_minute: number;
  last_message_time: number;
  time_since_last: number;
}

export interface SessionData {
  id: string;
  title: string;
  time: { created: number; updated?: number };
  messages: MessageSummary[];
  message_count: number;
  tokens_used: number;
  cost_cents: number;
  context_used: number;
  model: { provider: string; model: string };
}

function getDefaultDatabasePath(): string {
  return join(getDefaultOpenCodePath(), "opencode.db");
}

export class SessionManager {
  private sessionIndex: Map<string, SessionIndex> = new Map();
  private activeSession: {
    id: string;
    data: SessionData;
    mtime: number;
  } | null = null;
  private watcher: AbortController | null = null;
  private dataDir: string = "";
  private useDb: boolean = false;

  async init(dataDir: string, options?: { quiet?: boolean }): Promise<void> {
    this.dataDir = dataDir;
    // Check if DB exists
    try {
      await fsStat(join(dataDir, "opencode.db"));
      this.useDb = true;
    } catch {
      this.useDb = false;
    }
    await this.buildIndex(options?.quiet);
  }

  private async buildIndex(quiet: boolean = false): Promise<void> {
    this.sessionIndex.clear();

    if (this.useDb) {
      await this.buildIndexFromDb(quiet);
    } else {
      await this.buildIndexFromFiles(quiet);
    }
  }

  private async buildIndexFromDb(quiet: boolean): Promise<void> {
    const db = await openDb(getDefaultDatabasePath(), { readonly: true });
    try {
      const rows = queryAll(db, `SELECT id, time_created, time_updated FROM session`);
      for (const row of rows) {
        this.sessionIndex.set(row.id, {
          id: row.id,
          mtime: row.time_updated || row.time_created,
          size: 0,
          filePath: row.id,
        });
      }
      if (!quiet) {
        console.log(
          `Session index built: ${this.sessionIndex.size} sessions (from database)`,
        );
      }
    } finally {
      closeDb(db);
    }
  }

  private async buildIndexFromFiles(quiet: boolean): Promise<void> {
    const sessionDir = join(this.dataDir, "storage", "session");
    const files = await glob("**/ses_*.json", { cwd: sessionDir });

    for (const filePath of files) {
      const fullPath = join(sessionDir, filePath);
      const stats = await fsStat(fullPath).catch(() => null);
      if (!stats) continue;

      const id = this.extractSessionId(filePath);
      this.sessionIndex.set(id, {
        id,
        mtime: stats.mtime.getTime(),
        size: stats.size,
        filePath: fullPath,
      });
    }

    if (!quiet) {
      console.log(
        `Session index built: ${this.sessionIndex.size} sessions (metadata only)`,
      );
    }
  }

  async loadSession(sessionId: string): Promise<SessionData | null> {
    const index = this.sessionIndex.get(sessionId);
    if (!index) {
      console.warn(`Session ${sessionId} not found in index`);
      return null;
    }

    if (
      this.activeSession?.id === sessionId &&
      this.activeSession.mtime === index.mtime
    ) {
      return this.activeSession.data;
    }

    if (this.useDb) {
      return this.loadSessionFromDb(sessionId, index.mtime);
    }
    return this.loadSessionFromFiles(sessionId, index);
  }

  private async loadSessionFromDb(
    sessionId: string,
    mtime: number,
  ): Promise<SessionData | null> {
    const db = await openDb(getDefaultDatabasePath(), { readonly: true });
    try {
      const row = queryAll(
        db,
        `SELECT * FROM session WHERE id = ?`,
        sessionId,
      );
      if (!row || row.length === 0) return null;
      const s = row[0];

      // Parse model JSON
      let provider = "unknown";
      let model = "unknown";
      if (s.model) {
        try {
          const parsed = typeof s.model === "string" ? JSON.parse(s.model) : s.model;
          provider = parsed.providerID || "unknown";
          model = parsed.id || "unknown";
        } catch {
          // fall through
        }
      }

      // Load messages
      const messageRows = queryAll(
        db,
        `SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created`,
        sessionId,
      );

      const messages: MessageSummary[] = messageRows.map((row: any) => {
        let msgData: any = {};
        try {
          msgData = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
        } catch {
          // empty
        }
        const tokens = msgData.tokens || {};
        return {
          role: msgData.role || "user",
          created: row.time_created,
          tokens: {
            input: tokens.input || 0,
            output: tokens.output || 0,
            reasoning: tokens.reasoning,
            cache: {
              write: tokens.cache?.write || 0,
              read: tokens.cache?.read || 0,
            },
          },
          cost: msgData.cost,
          modelID: msgData.modelID,
          providerID: msgData.providerID,
        } as MessageSummary;
      });

      const tokensUsed =
        (s.tokens_input || 0) +
        (s.tokens_output || 0) +
        (s.tokens_reasoning || 0) +
        (s.tokens_cache_read || 0) +
        (s.tokens_cache_write || 0);

      const costCents =
        typeof s.cost === "number" && isFinite(s.cost) && !isNaN(s.cost)
          ? Math.round(s.cost * 100)
          : 0;

      const context_used = this.calculateContext(messages);

      const data: SessionData = {
        id: s.id,
        title: s.title || "Untitled",
        time: { created: s.time_created, updated: s.time_updated },
        messages,
        message_count: messages.length,
        tokens_used: tokensUsed,
        cost_cents: costCents,
        context_used,
        model: { provider, model },
      };

      this.activeSession = { id: sessionId, data, mtime };
      return data;
    } finally {
      closeDb(db);
    }
  }

  private async loadSessionFromFiles(
    sessionId: string,
    index: SessionIndex,
  ): Promise<SessionData | null> {
    const file = runtime.file(index.filePath);
    try {
      const sessionMeta = await file.json();
      const messages = await this.loadMessagesForSession(sessionId);
      const tokens_used = this.calculateTokens(messages);
      const cost_cents = this.calculateCost(messages);
      const context_used = this.calculateContext(messages);
      const model = this.extractModel(messages);

      const data: SessionData = {
        id: sessionMeta.id,
        title: sessionMeta.title || "Untitled",
        time: sessionMeta.time,
        messages,
        message_count: messages.length,
        tokens_used,
        cost_cents,
        context_used,
        model,
      };

      this.activeSession = { id: sessionId, data, mtime: index.mtime };
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        console.error(`Error loading session ${sessionId}:`, error);
      }
      return null;
    }
  }

  private async loadMessagesForSession(
    sessionId: string,
  ): Promise<MessageSummary[]> {
    const sessionMessageDir = join(
      this.dataDir,
      "storage",
      "message",
      sessionId.replace(/\u0000/g, ""),
    );

    const messages: MessageSummary[] = [];

    try {
      const files = await glob("msg_*.json", { cwd: sessionMessageDir });

      for (const filePath of files) {
        const fullPath = join(sessionMessageDir, filePath);
        const content = await readFile(fullPath, "utf-8").catch(() => null);
        if (!content) continue;

        const message = JSON.parse(content);
        if (!message) continue;

        messages.push({
          role: message.role,
          created: message.time?.created || 0,
          tokens: {
            input: message.tokens?.input || 0,
            output: message.tokens?.output || 0,
            reasoning: message.tokens?.reasoning,
            cache: {
              write: message.tokens?.cache?.write || 0,
              read: message.tokens?.cache?.read || 0,
            },
          },
          cost: message.cost,
          modelID: message.modelID,
          providerID: message.providerID,
        });
      }
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException)?.code !== "ENOENT" &&
        (error as NodeJS.ErrnoException)?.code !== "ENOTDIR"
      ) {
        console.error(`Error scanning messages for ${sessionId}:`, error);
      }
      return [];
    }

    return messages.sort((a, b) => a.created - b.created);
  }

  getRecentSessions(limit: number = 10): SessionIndex[] {
    return Array.from(this.sessionIndex.values())
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit);
  }

  getSessionsByDateRange(
    startTime: number,
    endTime: number,
    limit: number = 1000,
  ): SessionIndex[] {
    return Array.from(this.sessionIndex.values())
      .filter(
        (session) => session.mtime >= startTime && session.mtime <= endTime,
      )
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit);
  }

  getMostRecentSession(): SessionIndex | null {
    const recent = this.getRecentSessions(1);
    return recent.length > 0 ? recent[0] : null;
  }

  startWatcher(onChange: (sessionId: string) => void): void {
    if (this.watcher) {
      this.watcher.abort();
    }

    this.watcher = new AbortController();

    if (this.useDb) {
      this.startDbWatcher(onChange);
    } else {
      this.startFileWatcher(onChange);
    }
  }

  private startDbWatcher(onChange: (sessionId: string) => void): void {
    const dbPath = getDefaultDatabasePath();
    let lastMtime = 0;

    const poll = async () => {
      try {
        const stats = await fsStat(dbPath);
        const currentMtime = stats.mtime.getTime();
        if (lastMtime > 0 && currentMtime > lastMtime) {
          // Rebuild index and notify
          await this.buildIndex(true);
          const recent = this.getRecentSessions(3);
          for (const s of recent) {
            onChange(s.id);
          }
        }
        lastMtime = currentMtime;
      } catch {
        // ignore
      }
    };

    // Initial stat
    fsStat(dbPath).then((s) => { lastMtime = s.mtime.getTime(); }).catch(() => {});

    const interval = setInterval(poll, 1000);
    this.watcher!.signal.addEventListener("abort", () => {
      clearInterval(interval);
    });
  }

  private startFileWatcher(onChange: (sessionId: string) => void): void {
    const messageDir = join(this.dataDir, "storage", "message");
    const debounceMap = new Map<string, NodeJS.Timeout>();

    (async () => {
      try {
        const fileWatcher = watch(messageDir, {
          recursive: true,
          signal: this.watcher!.signal,
        });

        for await (const event of fileWatcher) {
          if (event.filename?.includes("msg_")) {
            const sessionId = this.extractSessionIdFromMessage(event.filename);
            if (sessionId) {
              if (this.activeSession?.id === sessionId) {
                this.activeSession = null;
              }

              const existingTimeout = debounceMap.get(sessionId);
              if (existingTimeout) {
                clearTimeout(existingTimeout);
              }

              const timeout = setTimeout(() => {
                onChange(sessionId);
                debounceMap.delete(sessionId);
              }, 500);

              debounceMap.set(sessionId, timeout);
            }
          }
        }
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          console.error("File watcher error:", error);
        }
      }
    })();
  }

  stopWatcher(): void {
    if (this.watcher) {
      this.watcher.abort();
      this.watcher = null;
    }
  }

  async reload(): Promise<void> {
    await this.buildIndex();
  }

  private extractSessionId(filePath: string): string {
    const match = filePath.match(/ses_[a-zA-Z0-9]+/);
    return match ? match[0].replace(/\u0000/g, "") : "";
  }

  private extractSessionIdFromMessage(filename: string): string | null {
    const match = filename.match(/ses_[a-zA-Z0-9]+/);
    return match ? match[0].replace(/\u0000/g, "") : null;
  }

  private calculateTokens(messages: MessageSummary[]): number {
    return messages.reduce((total, msg) => {
      return total + msg.tokens.input + msg.tokens.output +
        (msg.tokens.reasoning || 0) +
        (msg.tokens.cache?.read || 0) +
        (msg.tokens.cache?.write || 0);
    }, 0);
  }

  private calculateCost(messages: MessageSummary[]): number {
    return messages
      .filter((msg) => msg.role === "assistant" && typeof msg.cost === "number")
      .reduce((total, msg) => total + (msg.cost || 0), 0);
  }

  private calculateContext(messages: MessageSummary[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant" && msg.tokens.cache?.read) {
        return msg.tokens.cache.read;
      }
    }
    return 0;
  }

  private extractModel(messages: MessageSummary[]): {
    provider: string;
    model: string;
  } {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant" && msg.providerID && msg.modelID) {
        return {
          provider: String(msg.providerID),
          model: String(msg.modelID),
        };
      }
    }
    return { provider: "unknown", model: "unknown" };
  }

  async getRecentActivity(
    sessionId: string,
    minutes: number = 5,
  ): Promise<RecentActivity> {
    const session = this.activeSession;
    if (!session || session.id !== sessionId) {
      return {
        messages: 0,
        tokens: 0,
        cost: 0,
        tokens_per_minute: 0,
        cost_per_minute: 0,
        last_message_time: 0,
        time_since_last: 0,
      };
    }

    const now = Date.now();
    const cutoff = now - minutes * 60 * 1000;
    const recentMessages = session.data.messages.filter(
      (m) => m.created >= cutoff,
    );

    const { findModel } = await import("./models-db.js");
    const model = await findModel(
      `${session.data.model.provider}/${session.data.model.model}`,
    );

    const tokenTotals = recentMessages.reduce(
      (acc, msg) => {
        acc.input += msg.tokens.input;
        acc.output += msg.tokens.output;
        acc.reasoning += msg.tokens.reasoning || 0;
        acc.cacheWrite += msg.tokens.cache?.write || 0;
        acc.cacheRead += msg.tokens.cache?.read || 0;
        return acc;
      },
      { input: 0, output: 0, reasoning: 0, cacheWrite: 0, cacheRead: 0 },
    );

    const totalTokens =
      tokenTotals.input + tokenTotals.output + tokenTotals.reasoning +
      tokenTotals.cacheWrite + tokenTotals.cacheRead;

    let cost = 0;
    if (model?.cost) {
      const multiplier = 1 / 1_000_000;
      cost =
        tokenTotals.input * multiplier * (model.cost.input || 0) +
        tokenTotals.output * multiplier * (model.cost.output || 0) +
        tokenTotals.reasoning * multiplier * (model.cost.reasoning || 0) +
        tokenTotals.cacheWrite * multiplier * (model.cost.cache_write || 0) +
        tokenTotals.cacheRead * multiplier * (model.cost.cache_read || 0);
    }

    const lastMessage = session.data.messages[session.data.messages.length - 1];
    const lastMessageTime = lastMessage?.created || 0;
    const timeSinceLast = now - lastMessageTime;

    const hasRecentMessages = recentMessages.length > 0;

    return {
      messages: recentMessages.length,
      tokens: totalTokens,
      cost,
      tokens_per_minute:
        hasRecentMessages && minutes > 0 ? totalTokens / minutes : 0,
      cost_per_minute: hasRecentMessages && minutes > 0 ? cost / minutes : 0,
      last_message_time: lastMessageTime,
      time_since_last: timeSinceLast,
    };
  }
}
