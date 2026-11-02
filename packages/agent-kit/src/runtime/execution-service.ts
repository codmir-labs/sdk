export interface RunnerExecutionTaskInput {
  taskId: string;
  goal: string;
  workspace?: string;
  projectId?: string;
  attemptId?: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface RunnerExecutionProgressUpdate {
  type: string;
  data?: unknown;
  timestamp?: number;
}

export type RunnerExecutionResult =
  | {
      success: true;
      summary?: string;
      result?: unknown;
    }
  | {
      success: false;
      error: string;
      summary?: string;
      result?: unknown;
    };

export interface RunnerExecutionAdapterContext {
  signal?: AbortSignal;
  emitProgress: (update: RunnerExecutionProgressUpdate) => Promise<void>;
}

export interface RunnerExecutionAdapter {
  run(
    task: RunnerExecutionTaskInput,
    context: RunnerExecutionAdapterContext,
  ): Promise<RunnerExecutionResult>;
}

export type RunnerExecutionLifecycleEvent =
  | {
      type: "started";
      task: RunnerExecutionTaskInput;
      timestamp: number;
    }
  | {
      type: "progress";
      task: RunnerExecutionTaskInput;
      progress: RunnerExecutionProgressUpdate;
      timestamp: number;
    }
  | {
      type: "completed";
      task: RunnerExecutionTaskInput;
      result: RunnerExecutionResult & { success: true };
      timestamp: number;
    }
  | {
      type: "failed";
      task: RunnerExecutionTaskInput;
      result: RunnerExecutionResult & { success: false };
      timestamp: number;
    };

export interface RunnerExecutionRunOptions {
  signal?: AbortSignal;
  throwOnFailure?: boolean;
  onLifecycleEvent?: (event: RunnerExecutionLifecycleEvent) => Promise<void> | void;
}

/**
 * Shared runner execution lifecycle wrapper used across task surfaces.
 * Adapters provide task-specific execution logic while this service
 * standardizes started/progress/completed/failed lifecycle events.
 */
export class RunnerExecutionService {
  async run(
    task: RunnerExecutionTaskInput,
    adapter: RunnerExecutionAdapter,
    options: RunnerExecutionRunOptions = {},
  ): Promise<RunnerExecutionResult> {
    await this.emitLifecycle(
      {
        type: "started",
        task,
        timestamp: Date.now(),
      },
      options,
    );

    const emitProgress = async (update: RunnerExecutionProgressUpdate): Promise<void> => {
      await this.emitLifecycle(
        {
          type: "progress",
          task,
          progress: {
            ...update,
            timestamp: update.timestamp ?? Date.now(),
          },
          timestamp: Date.now(),
        },
        options,
      );
    };

    try {
      const result = this.normalizeResult(await adapter.run(task, {
        signal: options.signal,
        emitProgress,
      }));

      if (result.success) {
        await this.emitLifecycle(
          {
            type: "completed",
            task,
            result,
            timestamp: Date.now(),
          },
          options,
        );
        return result;
      }

      await this.emitLifecycle(
        {
          type: "failed",
          task,
          result,
          timestamp: Date.now(),
        },
        options,
      );

      if (options.throwOnFailure) {
        throw new Error(result.error);
      }
      return result;
    } catch (error) {
      const failedResult: RunnerExecutionResult & { success: false } = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };

      await this.emitLifecycle(
        {
          type: "failed",
          task,
          result: failedResult,
          timestamp: Date.now(),
        },
        options,
      );

      if (options.throwOnFailure) {
        throw error;
      }
      return failedResult;
    }
  }

  private async emitLifecycle(
    event: RunnerExecutionLifecycleEvent,
    options: RunnerExecutionRunOptions,
  ): Promise<void> {
    if (!options.onLifecycleEvent) {
      return;
    }
    await options.onLifecycleEvent(event);
  }

  private normalizeResult(result: RunnerExecutionResult): RunnerExecutionResult {
    if (result.success) {
      return result;
    }
    const error = typeof result.error === "string" && result.error.length > 0
      ? result.error
      : "Task execution failed";
    return {
      ...result,
      error,
    };
  }
}
