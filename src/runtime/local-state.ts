import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LocalTaskCheckpoint, LocalWorkerState, RunnerStateStore } from "./types";

export interface LocalStateOptions {
  rootDir?: string;
}

const DEFAULT_ROOT = ".codmir/worker";

export class FileSystemRunnerStateStore implements RunnerStateStore {
  private readonly rootDir: string;

  constructor(options: LocalStateOptions = {}) {
    this.rootDir = options.rootDir ?? DEFAULT_ROOT;
  }

  async saveCheckpoint(checkpoint: LocalTaskCheckpoint): Promise<void> {
    const filePath = this.getCheckpointPath(checkpoint.taskId);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(checkpoint, null, 2), "utf-8");
  }

  async loadCheckpoint(taskId: string): Promise<LocalTaskCheckpoint | null> {
    try {
      const filePath = this.getCheckpointPath(taskId);
      const raw = await readFile(filePath, "utf-8");
      return JSON.parse(raw) as LocalTaskCheckpoint;
    } catch {
      return null;
    }
  }

  async deleteCheckpoint(taskId: string): Promise<void> {
    const filePath = this.getCheckpointPath(taskId);
    await rm(filePath, { force: true });
  }

  private getCheckpointPath(taskId: string): string {
    return join(this.rootDir, "tasks", taskId, "checkpoint.json");
  }
}

export async function loadWorkerState(
  options: LocalStateOptions = {},
): Promise<LocalWorkerState | null> {
  const rootDir = options.rootDir ?? DEFAULT_ROOT;
  const filePath = join(rootDir, "state.json");
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as LocalWorkerState;
  } catch {
    return null;
  }
}

export async function saveWorkerState(
  state: LocalWorkerState,
  options: LocalStateOptions = {},
): Promise<void> {
  const rootDir = options.rootDir ?? DEFAULT_ROOT;
  const filePath = join(rootDir, "state.json");
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(state, null, 2), "utf-8");
}

export async function clearWorkerState(options: LocalStateOptions = {}): Promise<void> {
  const rootDir = options.rootDir ?? DEFAULT_ROOT;
  await rm(join(rootDir, "state.json"), { force: true });
}

