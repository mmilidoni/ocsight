import { join } from "path";
import { homedir } from "os";

const isBun = typeof Bun !== "undefined";

export async function openDb(
  path: string,
  opts: { readonly?: boolean } = {},
): Promise<any> {
  if (isBun) {
    const { Database } = await import("bun:sqlite");
    return new Database(path, { ...opts, create: false });
  }
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(path, { readOnly: opts.readonly ?? false });
}

export function closeDb(db: any): void {
  db.close();
}

export function queryAll(db: any, sql: string, ...params: any[]): any[] {
  const stmt = db.prepare(sql);
  return params.length > 0 ? stmt.all(...params) : stmt.all();
}

export function queryGet(db: any, sql: string, ...params: any[]): any {
  const stmt = db.prepare(sql);
  return params.length > 0 ? stmt.get(...params) : stmt.get();
}

export function getDefaultDatabasePath(): string {
  const platform = process.platform;
  const base =
    platform === "win32"
      ? join(process.env.USERPROFILE || homedir(), ".local", "share", "opencode")
      : join(homedir(), ".local", "share", "opencode");
  return join(base, "opencode.db");
}
