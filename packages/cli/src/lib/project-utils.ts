import { readdir, readFile, stat } from "fs/promises";
import { join } from "path";
import { getDefaultOpenCodePath } from "./data.js";
import { openDb, closeDb, queryAll } from "./database.js";
import { getDefaultDatabasePath } from "./database.js";

export interface ProjectInfo {
  id: string;
  worktree: string;
  vcs?: string;
  name?: string;
  time?: { created: number };
}

export async function detectProjectInfo(): Promise<ProjectInfo | null> {
  // Try DB first
  const db = await tryDetectFromDb();
  if (db) return db;

  return detectFromFiles();
}

async function tryDetectFromDb(): Promise<ProjectInfo | null> {
  try {
    await stat(getDefaultDatabasePath());
    const db = await openDb(getDefaultDatabasePath(), { readonly: true });
    try {
      const rows = queryAll(db, "SELECT * FROM project ORDER BY time_updated DESC LIMIT 1");
      if (rows && rows.length > 0) {
        const p = rows[0];
        return {
          id: p.id,
          worktree: p.worktree,
          vcs: p.vcs,
          name: p.name || (p.worktree ? p.worktree.split("/").pop() : "Unknown"),
          time: { created: p.time_created || 0 },
        };
      }
      return null;
    } finally {
      closeDb(db);
    }
  } catch {
    return null;
  }
}

async function detectFromFiles(): Promise<ProjectInfo | null> {
  try {
    const dataPath = getDefaultOpenCodePath();
    const projectPath = join(dataPath, "storage", "project");

    const files = await readdir(projectPath);
    const jsonFiles = files.filter(f => f.endsWith(".json"));

    if (jsonFiles.length === 0) return null;

    let mostRecentProject: ProjectInfo | null = null;
    let mostRecentTime = 0;

    for (const file of jsonFiles) {
      try {
        const filePath = join(projectPath, file);
        const stats = await stat(filePath);

        if (stats.mtimeMs > mostRecentTime) {
          const content = await readFile(filePath, "utf8");
          const projectData = JSON.parse(content);

          mostRecentTime = stats.mtimeMs;
          mostRecentProject = {
            ...projectData,
            name: projectData.worktree ? projectData.worktree.split('/').pop() : 'Unknown',
          };
        }
      } catch {
        continue;
      }
    }

    return mostRecentProject;
  } catch {
    return null;
  }
}

export async function getProjectById(projectId: string): Promise<ProjectInfo | null> {
  // Try DB first
  try {
    await stat(getDefaultDatabasePath());
    const db = await openDb(getDefaultDatabasePath(), { readonly: true });
    try {
      const rows = queryAll(db, "SELECT * FROM project WHERE id = ?", projectId);
      if (rows && rows.length > 0) {
        const p = rows[0];
        return {
          id: p.id,
          worktree: p.worktree,
          vcs: p.vcs,
          name: p.name || (p.worktree ? p.worktree.split("/").pop() : "Unknown"),
          time: { created: p.time_created || 0 },
        };
      }
      return null;
    } finally {
      closeDb(db);
    }
  } catch {
    // Fall through to file-based
  }

  try {
    const dataPath = getDefaultOpenCodePath();
    const projectFile = join(dataPath, "storage", "project", `${projectId}.json`);

    const content = await readFile(projectFile, "utf8");
    const projectData = JSON.parse(content);

    return {
      ...projectData,
      name: projectData.worktree ? projectData.worktree.split('/').pop() : 'Unknown',
    };
  } catch {
    return null;
  }
}