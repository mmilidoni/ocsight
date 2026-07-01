import { readdir, stat } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import {
  OpenCodeData,
  OpenCodeSession,
  OpenCodeMessage,
  ToolUsage,
} from "../types/index.js";
import { runtime } from "./runtime-compat.js";
import { openDb, closeDb, queryAll } from "./database.js";

export function getDefaultOpenCodePath(): string {
  const platform = process.platform;
  if (platform === "win32") {
    return join(
      process.env.USERPROFILE || homedir(),
      ".local",
      "share",
      "opencode",
    );
  }
  return join(homedir(), ".local", "share", "opencode");
}

export async function findOpenCodeDataDirectory(
  customPath?: string,
): Promise<string> {
  const basePath = customPath || getDefaultOpenCodePath();
  try {
    await stat(basePath).catch(async () => {
      const { mkdir } = await import("fs/promises");
      await mkdir(basePath, { recursive: true });
    });
    return basePath;
  } catch (error) {
    throw new Error(`OpenCode data directory not found: ${basePath}`);
  }
}

async function dbPathExists(dataDir: string): Promise<boolean> {
  try {
    await stat(join(dataDir, "opencode.db"));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// File-based fallback types (kept for backward compat)
// ---------------------------------------------------------------------------

interface SessionMetadata {
  id: string;
  title?: string;
  time: {
    created: number;
    updated?: number;
  };
  version?: string;
  parentID?: string;
}

interface MessageData {
  id: string;
  role: "user" | "assistant";
  sessionID: string;
  time: { created: number };
  content?: any;
  tools?: any[];
  providerID?: string;
  modelID?: string;
  tokens?: {
    input: number;
    output: number;
    reasoning?: number;
    cache?: { write: number; read: number };
  };
  cost?: number;
  system?: string[];
  mode?: string;
}

// ---------------------------------------------------------------------------
// Tool extraction helpers
// ---------------------------------------------------------------------------

function extractToolName(command: string): string | null {
  const cleanCommand = command
    .replace(/^(sudo|doas)\s+/, "")
    .replace(/^['"`]/, "")
    .replace(/['"`]\s*$/, "")
    .trim();
  const firstPart = cleanCommand.split(/[\s|]/)[0];
  const baseCommand = firstPart.split("/").pop() || firstPart;
  if (baseCommand && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(baseCommand)) {
    return baseCommand.toLowerCase();
  }
  return null;
}

function extractToolsFromMessage(msg: MessageData): ToolUsage[] {
  const tools: ToolUsage[] = [];
  const content = typeof msg.content === "string" ? msg.content : "";
  const timestamp = new Date(msg.time?.created || Date.now()).toISOString();

  if (content) {
    const codeBlockMatches = content.match(
      /```(?:bash|tool|sh|shell|command)\s*\n([\s\S]*?)\n```/g,
    );
    if (codeBlockMatches) {
      codeBlockMatches.forEach((match) => {
        const toolCommand = match
          .replace(/```(?:bash|tool|sh|shell|command)\s*\n([\s\S]*?)\n```/, "$1")
          .trim();
        if (toolCommand) {
          tools.push({
            name: extractToolName(toolCommand) || "unknown",
            duration_ms: 0,
            timestamp,
          });
        }
      });
    }

    const directToolMentions = content.match(
      /\b(?:bash|read|write|glob|grep|edit|list|task|chrome|figma|serena|vibe|context7|webfetch|sequential-thinking)\b/gi,
    );
    if (directToolMentions) {
      [...new Set(directToolMentions.map((t) => t.toLowerCase()))].forEach((name) => {
        tools.push({ name, duration_ms: 0, timestamp });
      });
    }
  }

  return tools;
}

// ---------------------------------------------------------------------------
// Database loading path
// ---------------------------------------------------------------------------

async function loadFromDatabase(
  dataDir: string,
  options?: { limit?: number; days?: number; quiet?: boolean },
): Promise<OpenCodeData> {
  const db = await openDb(join(dataDir, "opencode.db"), { readonly: true });

  try {
    let sql = `SELECT id, title, time_created, time_updated, version, parent_id,
                     cost, tokens_input, tokens_output, tokens_reasoning,
                     tokens_cache_read, tokens_cache_write, model, agent
              FROM session`;
    const params: number[] = [];

    if (options?.days) {
      const cutoff = Date.now() - options.days * 86400000;
      sql += ` WHERE time_updated > ?`;
      params.push(cutoff);
    }

    sql += ` ORDER BY time_updated DESC`;

    if (options?.limit && options.limit < Infinity) {
      sql += ` LIMIT ?`;
      params.push(options.limit);
    }

    const sessionRows = queryAll(db, sql, ...params);

    if (!options?.quiet) {
      console.log(`Found ${sessionRows.length} sessions in database`);
    }

    const sessions: OpenCodeSession[] = [];

    for (const row of sessionRows) {
      // Parse model JSON
      let provider = "unknown";
      let model = "unknown";
      if (row.model) {
        try {
          const parsed = typeof row.model === "string" ? JSON.parse(row.model) : row.model;
          provider = parsed.providerID || "unknown";
          model = parsed.id || "unknown";
        } catch {
          // fall through with defaults
        }
      }

      // Pre-aggregated tokens from session table
      const tokensUsed =
        (row.tokens_input || 0) +
        (row.tokens_output || 0) +
        (row.tokens_reasoning || 0) +
        (row.tokens_cache_read || 0) +
        (row.tokens_cache_write || 0);

      const costCents =
        typeof row.cost === "number" && isFinite(row.cost) && !isNaN(row.cost)
          ? Math.round(row.cost * 100)
          : 0;

      // Load messages for this session
      const messageRows = queryAll(
        db,
        `SELECT id, session_id, time_created, time_updated, data
         FROM message WHERE session_id = ? ORDER BY time_created`,
        row.id,
      );

      const messages: OpenCodeMessage[] = messageRows.map((msgRow: any) => {
        let msgData: any = {};
        try {
          msgData = typeof msgRow.data === "string" ? JSON.parse(msgRow.data) : msgRow.data;
        } catch {
          // empty message data
        }

        const role: "user" | "assistant" =
          msgData.role === "assistant" ? "assistant" : "user";

        return {
          id: msgRow.id,
          role,
          content: msgData.content || msgData.summary
            ? JSON.stringify(msgData.summary || "")
            : "",
          timestamp: new Date(msgRow.time_created).toISOString(),
          tools: extractToolsFromMessage({
            ...msgData,
            time: { created: msgRow.time_created },
          }),
        } as OpenCodeMessage;
      });

      sessions.push({
        id: row.id,
        title: row.title || "Untitled Session",
        time: {
          created: row.time_created,
          updated: row.time_updated,
        },
        messages,
        tokens_used: tokensUsed,
        cost_cents: costCents,
        model: { provider, model },
      });
    }

    return { sessions };
  } finally {
    closeDb(db);
  }
}

// ---------------------------------------------------------------------------
// File-based fallback loading path (no caching)
// ---------------------------------------------------------------------------

async function findSessionFiles(dataDir: string): Promise<string[]> {
  const files: string[] = [];
  const sessionDir = join(dataDir, "storage", "session");
  try {
    await readdir(sessionDir);
    async function search(dir: string) {
      try {
        const entries = await readdir(dir);
        for (const entry of entries) {
          const fullPath = join(dir, entry);
          try {
            await readdir(fullPath);
            await search(fullPath);
          } catch {
            if (entry.endsWith(".json") && entry.startsWith("ses_")) {
              files.push(fullPath);
            }
          }
        }
      } catch {
        // skip unreadable
      }
    }
    await search(sessionDir);
  } catch {
    console.warn("Could not access session directory");
  }
  return files;
}

async function findMessageFiles(dataDir: string): Promise<string[]> {
  const files: string[] = [];
  const messageDir = join(dataDir, "storage", "message");
  try {
    await readdir(messageDir);
    async function search(dir: string) {
      try {
        const entries = await readdir(dir);
        for (const entry of entries) {
          const fullPath = join(dir, entry);
          try {
            await readdir(fullPath);
            await search(fullPath);
          } catch {
            if (entry.endsWith(".json") && entry.startsWith("msg_")) {
              files.push(fullPath);
            }
          }
        }
      } catch {
        // skip unreadable
      }
    }
    await search(messageDir);
  } catch {
    console.warn("Could not access message directory");
  }
  return files;
}

async function loadFromFiles(
  dataDir: string,
  options?: { limit?: number; days?: number; quiet?: boolean; verbose?: boolean },
): Promise<OpenCodeData> {
  const [sessionFiles, messageFiles] = await Promise.all([
    findSessionFiles(dataDir),
    findMessageFiles(dataDir),
  ]);

  if (!options?.quiet) {
    console.log(
      `Found ${sessionFiles.length} session files and ${messageFiles.length} message files`,
    );
  }

  // Time-based filtering
  let filteredMessageFiles = messageFiles;
  if (options?.days) {
    const cutoffTime = Date.now() - options.days * 86400000;
    if (!options?.quiet) {
      console.log(`Filtering to data from last ${options.days} days...`);
    }
    const timeFilteredFiles: string[] = [];
    for (const file of messageFiles) {
      try {
        const stats = await runtime.file(file).stat();
        if (stats.mtimeMs >= cutoffTime) {
          timeFilteredFiles.push(file);
        }
      } catch {
        // skip unstatable
      }
    }
    filteredMessageFiles = timeFilteredFiles;
    if (!options?.quiet) {
      console.log(`Found ${filteredMessageFiles.length} recent message files`);
    }
  }

  const messageLimit = options?.limit || Infinity;
  const limitedMessageFiles = filteredMessageFiles.slice(0, messageLimit);

  // Load session metadata
  const sessionMap = new Map<string, SessionMetadata>();
  let sessionErrors = 0;

  const sessionResults = await Promise.all(
    sessionFiles.map(async (file) => {
      try {
        const content = await runtime.file(file).text();
        const data = JSON.parse(content);
        if (data && typeof data.id === "string" && data.time && typeof data.time.created === "number") {
          return data as SessionMetadata;
        }
        sessionErrors++;
        return null;
      } catch {
        sessionErrors++;
        return null;
      }
    }),
  );

  for (const session of sessionResults) {
    if (session) {
      sessionMap.set(session.id, session);
    }
  }

  // Load messages
  const messagesBySession = new Map<string, MessageData[]>();

  for (let i = 0; i < limitedMessageFiles.length; i += 100) {
    const batch = limitedMessageFiles.slice(i, i + 100);
    const batchResults = await Promise.all(
      batch.map(async (file) => {
        try {
          const content = await runtime.file(file).text();
          const data = JSON.parse(content);
          if (data && typeof data.id === "string" && data.role && data.sessionID) {
            return data as MessageData;
          }
          return null;
        } catch {
          return null;
        }
      }),
    );

    for (const message of batchResults) {
      if (message) {
        if (!messagesBySession.has(message.sessionID)) {
          messagesBySession.set(message.sessionID, []);
        }
        messagesBySession.get(message.sessionID)!.push(message);
      }
    }

    if (!options?.quiet && i > 0 && i % 1000 === 0) {
      console.log(
        `Processed ${Math.min(i, limitedMessageFiles.length)}/${limitedMessageFiles.length} message files...`,
      );
    }
  }

  // Build sessions from session map + messages
  const sessions: OpenCodeSession[] = [];

  for (const [sessionId, sessionMeta] of sessionMap) {
    const messages = messagesBySession.get(sessionId) || [];

    let totalTokens = 0;
    let totalCost = 0;
    let provider = "unknown";
    let model = "unknown";
    let latestAssistantTime = 0;

    for (const msg of messages) {
      if (msg.role === "assistant" && msg.providerID && msg.modelID) {
        const msgTime = msg.time?.created || 0;
        if (msgTime > latestAssistantTime) {
          latestAssistantTime = msgTime;
          provider = msg.providerID;
          model = msg.modelID;
        }

        if (msg.tokens) {
          totalTokens += (msg.tokens.input || 0) + (msg.tokens.output || 0);
          if (msg.tokens.cache) {
            totalTokens += (msg.tokens.cache.read || 0) + (msg.tokens.cache.write || 0);
          }
        }

        if (typeof msg.cost === "number") {
          totalCost += msg.cost;
        }
      }
    }

    const processedMessages = messages.map((msg) => ({
      id: msg.id,
      role: msg.role,
      content: msg.content || "",
      timestamp: new Date(msg.time.created).toISOString(),
      tools: extractToolsFromMessage(msg),
    })) as OpenCodeMessage[];

    if (processedMessages.length > 0) {
      sessions.push({
        id: sessionId,
        title: sessionMeta.title || "Untitled Session",
        time: {
          created: sessionMeta.time.created,
          updated: sessionMeta.time.updated,
        },
        messages: processedMessages,
        tokens_used: totalTokens,
        cost_cents:
          isFinite(totalCost) && !isNaN(totalCost)
            ? Math.round(totalCost * 100)
            : 0,
        model: { provider, model },
      });
    }
  }

  return { sessions };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function loadOpenCodeData(options?: {
  limit?: number;
  cache?: boolean;
  days?: number;
  quiet?: boolean;
  verbose?: boolean;
}): Promise<OpenCodeData> {
  const dataDir = await findOpenCodeDataDirectory();

  // Try SQLite database first
  if (await dbPathExists(dataDir)) {
    return loadFromDatabase(dataDir, {
      limit: options?.limit,
      days: options?.days,
      quiet: options?.quiet,
    });
  }

  // Fall back to file-based storage
  if (!options?.quiet) {
    console.log("Database not found, falling back to file-based storage");
  }
  return loadFromFiles(dataDir, {
    limit: options?.limit,
    days: options?.days,
    quiet: options?.quiet,
    verbose: options?.verbose,
  });
}

export async function loadAllData(options?: {
  limit?: number;
  cache?: boolean;
  days?: number;
  verbose?: boolean;
  quiet?: boolean;
}): Promise<OpenCodeData> {
  return loadOpenCodeData(options);
}
