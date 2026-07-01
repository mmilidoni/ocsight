import { readdir, stat, readFile } from "fs/promises";
import { join } from "path";
import { getDefaultOpenCodePath } from "./data.js";
import { openDb, closeDb, queryAll, queryGet, getDefaultDatabasePath } from "./database.js";

export interface ActiveSessionInfo {
  sessionId: string;
  provider: string;
  model: string;
  lastActivity: Date;
  messageCount: number;
  totalTokens: {
    input: number;
    output: number;
    reasoning: number;
    cache_write: number;
    cache_read: number;
    total: number;
  };
  totalCost: number;
  realCost?: number;
  currentContextTokens: number;
}

export async function findMostRecentlyActiveSession(): Promise<string | null> {
  const dbPath = getDefaultDatabasePath();

  // Try DB first
  try {
    await stat(join(dbPath, "..", "opencode.db"));
    const db = await openDb(dbPath, { readonly: true });
    try {
      const row = queryGet(db, `SELECT session_id FROM message ORDER BY time_updated DESC LIMIT 1`);
      return row?.session_id || null;
    } finally {
      closeDb(db);
    }
  } catch {
    // Fall back to file-based
  }

  try {
    const dataPath = getDefaultOpenCodePath();
    const messagePath = join(dataPath, "storage", "message");

    const entries = await readdir(messagePath, { withFileTypes: true });
    const sessionDirs = entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("ses_"))
      .map((entry) => entry.name);

    if (sessionDirs.length === 0) return null;

    let mostRecentTimestamp = 0;
    let mostRecentSession: string | null = null;

    for (const sessionId of sessionDirs) {
      try {
        const sessionPath = join(messagePath, sessionId);
        const messageFiles = await readdir(sessionPath);

        for (const messageFile of messageFiles) {
          if (!messageFile.endsWith(".json")) continue;

          const mPath = join(sessionPath, messageFile);
          const stats = await stat(mPath);
          const timestamp = Math.floor(stats.mtime.getTime() / 1000);

          if (timestamp > mostRecentTimestamp) {
            mostRecentTimestamp = timestamp;
            mostRecentSession = sessionId;
          }
        }
      } catch {
        continue;
      }
    }

    return mostRecentSession;
  } catch {
    return null;
  }
}

export async function getActiveSessionInfo(
  sessionId: string,
): Promise<ActiveSessionInfo | null> {
  const dbPath = getDefaultDatabasePath();

  // Try DB first
  try {
    await stat(dbPath);
    return getActiveSessionInfoFromDb(sessionId);
  } catch {
    // Fall back to file-based
  }

  return getActiveSessionInfoFromFiles(sessionId);
}

async function getActiveSessionInfoFromDb(
  sessionId: string,
): Promise<ActiveSessionInfo | null> {
  const db = await openDb(getDefaultDatabasePath(), { readonly: true });
  try {
    const sessionRow = queryGet(db, `SELECT * FROM session WHERE id = ?`, sessionId);
    if (!sessionRow) return null;

    // Parse model JSON
    let provider = "unknown";
    let model = "unknown";
    if (sessionRow.model) {
      try {
        const parsed = typeof sessionRow.model === "string"
          ? JSON.parse(sessionRow.model)
          : sessionRow.model;
        provider = parsed.providerID || "unknown";
        model = parsed.id || "unknown";
      } catch {
        // fall through
      }
    }

    // Count messages
    const messageCountRow = queryGet(
      db,
      `SELECT COUNT(*) as cnt FROM message WHERE session_id = ?`,
      sessionId,
    );

    const totalTokens = {
      input: sessionRow.tokens_input || 0,
      output: sessionRow.tokens_output || 0,
      reasoning: sessionRow.tokens_reasoning || 0,
      cache_write: sessionRow.tokens_cache_write || 0,
      cache_read: sessionRow.tokens_cache_read || 0,
      total:
        (sessionRow.tokens_input || 0) +
        (sessionRow.tokens_output || 0) +
        (sessionRow.tokens_reasoning || 0) +
        (sessionRow.tokens_cache_write || 0) +
        (sessionRow.tokens_cache_read || 0),
    };

    const totalCost = typeof sessionRow.cost === "number" ? sessionRow.cost : 0;

    // Get last activity from messages
    const lastMsgRow = queryGet(
      db,
      `SELECT time_updated FROM message WHERE session_id = ? ORDER BY time_updated DESC LIMIT 1`,
      sessionId,
    );

    const lastActivity = lastMsgRow
      ? new Date(lastMsgRow.time_updated)
      : new Date(sessionRow.time_updated || sessionRow.time_created);

    // Calculate context tokens from most recent assistant message data
    let currentContextTokens = 0;
    const recentMsgRows = queryAll(
      db,
      `SELECT data FROM message WHERE session_id = ? ORDER BY time_created DESC LIMIT 10`,
      sessionId,
    );
    for (const msgRow of recentMsgRows) {
      try {
        const msgData = typeof msgRow.data === "string"
          ? JSON.parse(msgRow.data)
          : msgRow.data;
        if (msgData.role === "assistant" && msgData.tokens) {
          const t = msgData.tokens;
          const tokens =
            (t.input || 0) + (t.output || 0) + (t.reasoning || 0) +
            (t.cache?.write || 0) + (t.cache?.read || 0);
          if (tokens >= 1000) {
            currentContextTokens = tokens;
            break;
          }
        }
      } catch {
        continue;
      }
    }

    // Calculate real cost using model pricing if available
    let realCost: number | undefined;
    try {
      const { findModel, calculateModelCost } = await import("./models-db.js");
      const modelData = await findModel(`${provider}/${model}`);
      if (modelData) {
        const tokenDistribution = {
          input: Math.floor(totalTokens.total * 0.7),
          output: Math.floor(totalTokens.total * 0.2),
          reasoning: Math.floor(totalTokens.total * 0.05),
          cache_read: Math.floor(totalTokens.total * 0.02),
          cache_write: Math.floor(totalTokens.total * 0.03),
        };
        realCost = calculateModelCost(modelData, tokenDistribution);
      }
    } catch {
      // use stored cost
    }

    return {
      sessionId,
      provider,
      model,
      lastActivity,
      messageCount: messageCountRow?.cnt || 0,
      totalTokens,
      totalCost,
      realCost,
      currentContextTokens,
    };
  } finally {
    closeDb(db);
  }
}

async function getActiveSessionInfoFromFiles(
  sessionId: string,
): Promise<ActiveSessionInfo | null> {
  try {
    const dataPath = getDefaultOpenCodePath();
    const messagePath = join(dataPath, "storage", "message", sessionId);

    const messageFiles = await readdir(messagePath);
    const jsonFiles = messageFiles.filter((f) => f.endsWith(".json"));

    if (jsonFiles.length === 0) return null;

    let provider = "unknown";
    let model = "unknown";
    let lastActivity = new Date(0);
    let totalCost = 0;
    let latestAssistantMessageTime = 0;

    const totalTokens = {
      input: 0,
      output: 0,
      reasoning: 0,
      cache_write: 0,
      cache_read: 0,
      total: 0,
    };

    for (const messageFile of jsonFiles) {
      try {
        const filePath = join(messagePath, messageFile);
        const stats = await stat(filePath);

        if (stats.mtime > lastActivity) {
          lastActivity = stats.mtime;
        }

        const content = await readFile(filePath, "utf8");
        const message = JSON.parse(content);

        if (message.role === "assistant" && message.providerID && message.modelID) {
          const messageTime =
            message.time?.completed || message.time?.created || stats.mtime.getTime();
          if (messageTime > latestAssistantMessageTime) {
            latestAssistantMessageTime = messageTime;
            provider = message.providerID;
            model = message.modelID;
          }
        }

        if (message.tokens) {
          totalTokens.input += message.tokens.input || 0;
          totalTokens.output += message.tokens.output || 0;
          totalTokens.reasoning += message.tokens.reasoning || 0;
          if (message.tokens.cache) {
            totalTokens.cache_write += message.tokens.cache.write || 0;
            totalTokens.cache_read += message.tokens.cache.read || 0;
          }
        }

        if (typeof message.cost === "number") {
          totalCost += message.cost;
        }
      } catch {
        continue;
      }
    }

    totalTokens.total =
      totalTokens.input + totalTokens.output + totalTokens.reasoning +
      totalTokens.cache_write + totalTokens.cache_read;

    // Current context tokens calculation
    const messageData: Array<{ file: string; timestamp: number }> = [];
    for (const file of jsonFiles) {
      try {
        const filePath = join(messagePath, file);
        const stats = await stat(filePath);
        messageData.push({ file, timestamp: stats.mtime.getTime() });
      } catch {
        continue;
      }
    }
    messageData.sort((a, b) => b.timestamp - a.timestamp);

    let currentContextTokens = 0;
    for (const { file } of messageData) {
      try {
        const content = await readFile(join(messagePath, file), "utf8");
        const msg = JSON.parse(content);
        if (msg.role !== "assistant" || !msg.tokens) continue;
        const tokenSum =
          (msg.tokens.input || 0) + (msg.tokens.output || 0) + (msg.tokens.reasoning || 0) +
          (msg.tokens.cache?.write || 0) + (msg.tokens.cache?.read || 0);
        if (tokenSum >= 1000) {
          currentContextTokens = tokenSum;
          break;
        }
      } catch {
        continue;
      }
    }

    // Real cost from pricing DB
    let realCost = totalCost;
    try {
      const { findModel, calculateModelCost } = await import("./models-db.js");
      const modelData = await findModel(`${provider}/${model}`);
      if (modelData) {
        const dist = {
          input: Math.floor(totalTokens.total * 0.7),
          output: Math.floor(totalTokens.total * 0.2),
          reasoning: Math.floor(totalTokens.total * 0.05),
          cache_read: Math.floor(totalTokens.total * 0.02),
          cache_write: Math.floor(totalTokens.total * 0.03),
        };
        realCost = calculateModelCost(modelData, dist);
      }
    } catch {
      // use stored cost
    }

    return {
      sessionId,
      provider,
      model,
      lastActivity,
      messageCount: jsonFiles.length,
      totalTokens,
      totalCost,
      realCost,
      currentContextTokens,
    };
  } catch {
    return null;
  }
}
