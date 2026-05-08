import { nanoid } from "nanoid";
import type {
  CanonicalTaskEvent,
  WorkerAssignmentEvent,
  WorkerClient,
} from "./protocol/types";
import {
  RunnerExecutionService,
  type RunnerExecutionAdapter,
  type RunnerExecutionAdapterContext,
  type RunnerExecutionResult,
} from "./execution-service";

export interface RunnerWorkerAssignmentInput {
  taskId: string;
  attemptId: string;
  goal: string;
  workspace: string;
  projectId?: string;
  metadata?: Record<string, unknown>;
}

export interface RunnerWorkerCheckpoint {
  taskId: string;
  attemptId: string;
  goal: string;
  workspace?: string;
  startedAt: number;
}

export interface RunnerWorkerCheckpointStore {
  writeCheckpoint(checkpoint: RunnerWorkerCheckpoint): Promise<void>;
  removeCheckpoint(taskId: string): Promise<void>;
}

export type RunnerWorkerExecutor = (
  assignment: RunnerWorkerAssignmentInput,
  context: RunnerExecutionAdapterContext,
) => Promise<RunnerExecutionResult>;

export interface RunnerWorkerHostOptions {
  workerClient: WorkerClient;
  workerId: string;
  defaultWorkspace: string;
  executor: RunnerWorkerExecutor;
  source?: string;
  reconnectDelayMs?: number;
  checkpointStore?: RunnerWorkerCheckpointStore;
  onInfo?: (message: string) => void | Promise<void>;
  onWarning?: (message: string) => void | Promise<void>;
  onAssignmentEvent?: (event: WorkerAssignmentEvent) => void | Promise<void>;
  onHeartbeat?: (info: {
    timestamp: number;
    currentLoad: number;
    assignedTaskCount: number;
  }) => void | Promise<void>;
}

export interface RunnerWorkerRunOptions {
  heartbeatIntervalMs: number;
  capabilities?: string[];
  signal?: AbortSignal;
}

/**
 * Shared worker runtime host used by CLI/IDE surfaces.
 * Owns heartbeat, assignment stream, task claim/execute/finalize, and reconnect loops.
 */
export class RunnerWorkerHost {
  private readonly executionService = new RunnerExecutionService();
  private readonly activeTasks = new Map<string, Promise<void>>();
  private readonly taskAbortControllers = new Map<string, AbortController>();
  private readonly seqByTask = new Map<string, number>();
  private stopController: AbortController | null = null;

  constructor(private readonly options: RunnerWorkerHostOptions) {}

  stop(): void {
    this.stopController?.abort();
    for (const controller of this.taskAbortControllers.values()) {
      controller.abort();
    }
  }

  getActiveTaskCount(): number {
    return this.activeTasks.size;
  }

  async run(runOptions: RunnerWorkerRunOptions): Promise<void> {
    const localStopController = new AbortController();
    this.stopController = localStopController;

    const signal = runOptions.signal
      ? AbortSignal.any([runOptions.signal, localStopController.signal])
      : localStopController.signal;
    const capabilities = runOptions.capabilities ?? [];
    const heartbeatIntervalMs = Math.max(2000, runOptions.heartbeatIntervalMs);

    await this.sendHeartbeat(capabilities);
    const heartbeatTimer = setInterval(() => {
      void this.sendHeartbeat(capabilities);
    }, heartbeatIntervalMs);
    if (typeof heartbeatTimer.unref === "function") {
      heartbeatTimer.unref();
    }

    try {
      await this.runAssignmentStreamLoop(signal);
    } finally {
      clearInterval(heartbeatTimer);
      this.stopController = null;
      if (this.activeTasks.size > 0) {
        await Promise.allSettled(this.activeTasks.values());
      }
    }
  }

  private async runAssignmentStreamLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const stream = await this.options.workerClient.streamAssignments(
          this.options.workerId,
          signal,
        );

        for await (const event of stream) {
          if (signal.aborted) {
            return;
          }
          await this.handleAssignmentEvent(event, signal);
        }
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        await this.warn(
          `Assignment stream disconnected: ${error instanceof Error ? error.message : String(error)}`,
        );
        await sleep(this.options.reconnectDelayMs ?? 2000, signal);
      }
    }
  }

  private async handleAssignmentEvent(
    event: WorkerAssignmentEvent,
    parentSignal: AbortSignal,
  ): Promise<void> {
    if (this.options.onAssignmentEvent) {
      await this.options.onAssignmentEvent(event);
    }

    if (event.type === "task_assigned") {
      await this.handleTaskAssigned(event, parentSignal);
      return;
    }

    const taskId = asTaskId(event.payload);
    if (!taskId) {
      return;
    }

    if (event.type === "task_cancelled") {
      this.taskAbortControllers.get(taskId)?.abort();
      return;
    }

    if (event.type === "task_control") {
      const action = typeof event.payload.action === "string" ? event.payload.action : "";
      if (action === "cancel") {
        this.taskAbortControllers.get(taskId)?.abort();
      }
    }
  }

  private async handleTaskAssigned(
    event: WorkerAssignmentEvent,
    parentSignal: AbortSignal,
  ): Promise<void> {
    const payload = event.payload as {
      taskId?: unknown;
      goal?: unknown;
      workspace?: unknown;
      attemptId?: unknown;
      projectId?: unknown;
      metadata?: unknown;
    };

    const taskId = typeof payload.taskId === "string" ? payload.taskId : "";
    const goal = typeof payload.goal === "string" ? payload.goal : "";
    const attemptId = typeof payload.attemptId === "string" ? payload.attemptId : "";
    if (!taskId || !goal || !attemptId || this.activeTasks.has(taskId)) {
      return;
    }

    const assignment: RunnerWorkerAssignmentInput = {
      taskId,
      goal,
      attemptId,
      workspace:
        typeof payload.workspace === "string" && payload.workspace.length > 0
          ? payload.workspace
          : this.options.defaultWorkspace,
      projectId:
        typeof payload.projectId === "string" && payload.projectId.length > 0
          ? payload.projectId
          : undefined,
      metadata: toRecord(payload.metadata),
    };

    const taskAbortController = new AbortController();
    this.taskAbortControllers.set(taskId, taskAbortController);
    const taskSignal = AbortSignal.any([parentSignal, taskAbortController.signal]);

    const taskPromise = this.executeAssignment(assignment, taskSignal).finally(() => {
      this.activeTasks.delete(taskId);
      this.taskAbortControllers.delete(taskId);
    });
    this.activeTasks.set(taskId, taskPromise);
  }

  private async executeAssignment(
    assignment: RunnerWorkerAssignmentInput,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.options.workerClient.claimTask(assignment.taskId, {
        workerId: this.options.workerId,
        attemptId: assignment.attemptId,
      });

      if (this.options.checkpointStore) {
        await this.options.checkpointStore.writeCheckpoint({
          taskId: assignment.taskId,
          attemptId: assignment.attemptId,
          goal: assignment.goal,
          workspace: assignment.workspace,
          startedAt: Date.now(),
        });
      }

      const adapter: RunnerExecutionAdapter = {
        run: async (_task, context) => this.options.executor(assignment, context),
      };

      const execution = await this.executionService.run(
        {
          taskId: assignment.taskId,
          attemptId: assignment.attemptId,
          projectId: assignment.projectId,
          goal: assignment.goal,
          workspace: assignment.workspace,
          source: this.options.source ?? "worker_runtime",
          metadata: assignment.metadata,
        },
        adapter,
        {
          signal,
          onLifecycleEvent: async (lifecycle) => {
            if (lifecycle.type !== "progress") {
              return;
            }
            await this.publishProgressEvent(
              assignment.taskId,
              assignment.attemptId,
              lifecycle.progress.type,
              toRecord(lifecycle.progress.data),
            );
          },
        },
      );

      if (execution.success) {
        await this.options.workerClient.completeTask(assignment.taskId, {
          workerId: this.options.workerId,
          attemptId: assignment.attemptId,
          summary: execution.summary,
          result: execution.result,
        });
      } else {
        await this.reportFailure(
          assignment.taskId,
          assignment.attemptId,
          execution.error || "Execution failed",
        );
      }
    } catch (error) {
      await this.reportFailure(
        assignment.taskId,
        assignment.attemptId,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      if (this.options.checkpointStore) {
        await this.options.checkpointStore.removeCheckpoint(assignment.taskId);
      }
    }
  }

  private async reportFailure(
    taskId: string,
    attemptId: string,
    error: string,
  ): Promise<void> {
    try {
      await this.options.workerClient.failTask(taskId, {
        workerId: this.options.workerId,
        attemptId,
        error,
      });
    } catch (reportError) {
      await this.warn(
        `Failed to report task failure (${taskId}): ${
          reportError instanceof Error ? reportError.message : String(reportError)
        }`,
      );
    }
  }

  private async publishProgressEvent(
    taskId: string,
    attemptId: string,
    eventType: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const event = this.toCanonicalEvent(taskId, eventType, data);
    try {
      await this.options.workerClient.publishTaskEvent(taskId, {
        workerId: this.options.workerId,
        attemptId,
        event,
      });
    } catch (error) {
      await this.warn(
        `Failed to publish task event (${taskId}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private toCanonicalEvent(
    taskId: string,
    eventType: string,
    data: Record<string, unknown>,
  ): CanonicalTaskEvent {
    const nextSeq = (this.seqByTask.get(taskId) ?? 0) + 1;
    this.seqByTask.set(taskId, nextSeq);

    if (eventType === "phase_change") {
      const phase = typeof data.phase === "string" ? data.phase : "coding";
      return {
        version: "v1",
        id: nanoid(12),
        seq: nextSeq,
        taskId,
        type: "state_change",
        timestamp: Date.now(),
        source: this.options.source ?? "worker_runtime",
        payload: {
          phase,
          state: mapPhaseToState(phase),
        },
      };
    }

    return {
      version: "v1",
      id: nanoid(12),
      seq: nextSeq,
      taskId,
      type: eventType === "error" ? "error" : eventType,
      timestamp: Date.now(),
      source: this.options.source ?? "worker_runtime",
      payload: data,
    };
  }

  private async sendHeartbeat(capabilities: string[]): Promise<void> {
    try {
      const currentLoad = this.activeTasks.size;
      const response = await this.options.workerClient.heartbeat(this.options.workerId, {
        currentLoad,
        capabilities,
      });
      if (this.options.onHeartbeat) {
        await this.options.onHeartbeat({
          timestamp: Date.now(),
          currentLoad,
          assignedTaskCount: response.assignedTaskCount,
        });
      }
    } catch (error) {
      await this.warn(
        `Heartbeat failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async warn(message: string): Promise<void> {
    if (this.options.onWarning) {
      await this.options.onWarning(message);
      return;
    }
    if (this.options.onInfo) {
      await this.options.onInfo(message);
    }
  }
}

function asTaskId(payload: Record<string, unknown>): string | null {
  const taskId = payload.taskId;
  return typeof taskId === "string" && taskId.length > 0 ? taskId : null;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function mapPhaseToState(phase: string): string {
  if (phase === "queued") return "queued";
  if (phase === "awaiting_approval") return "awaiting_approval";
  if (phase === "complete") return "completed";
  if (phase === "error") return "failed";
  return "running";
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      resolve();
    };

    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}
