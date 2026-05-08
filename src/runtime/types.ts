export type RunnerTaskState =
  | "queued"
  | "assigned"
  | "running"
  | "awaiting_approval"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export interface RunnerTask {
  id: string;
  goal: string;
  projectId?: string;
  workspace?: string;
  state: RunnerTaskState;
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, unknown>;
  steps: RunnerTaskStep[];
  result?: unknown;
  error?: string;
  attemptId?: string;
}

export interface RunnerTaskStep {
  id: string;
  type:
    | "thinking"
    | "tool_call"
    | "tool_result"
    | "step_pending"
    | "state_change"
    | "result";
  timestamp: number;
  payload: Record<string, unknown>;
}

export interface RunnerEvent {
  id: string;
  seq: number;
  taskId: string;
  type: string;
  timestamp: number;
  source: string;
  payload: Record<string, unknown>;
}

export interface RunnerToolRegistry {
  listTools(): Array<{ name: string; description?: string }>;
  executeTool(
    name: string,
    args: Record<string, unknown>,
    context: RunnerExecutionContext,
  ): Promise<unknown>;
}

export interface RunnerLlmAdapter {
  nextAction(input: {
    task: RunnerTask;
    history: RunnerTaskStep[];
    availableTools: Array<{ name: string; description?: string }>;
    context: RunnerExecutionContext;
  }): Promise<RunnerDecision>;
}

export type RunnerDecision =
  | {
      kind: "tool_call";
      toolName: string;
      args: Record<string, unknown>;
      thinking?: string;
    }
  | {
      kind: "finish";
      output?: unknown;
      summary?: string;
    }
  | {
      kind: "pause";
      reason?: string;
    };

export interface RunnerExecutionContext {
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
}

export interface RunnerStateStore {
  saveCheckpoint(checkpoint: LocalTaskCheckpoint): Promise<void>;
  loadCheckpoint(taskId: string): Promise<LocalTaskCheckpoint | null>;
  deleteCheckpoint(taskId: string): Promise<void>;
}

export interface RunnerEngine {
  run(task: RunnerTask, context?: RunnerExecutionContext): Promise<RunnerTask>;
  resume(taskId: string, context?: RunnerExecutionContext): Promise<RunnerTask>;
}

export interface LocalWorkerState {
  workerId: string;
  token: string;
  registeredAt: number;
  lastHeartbeatAt: number;
  runnerBaseUrl: string;
  capabilities: string[];
}

export interface LocalTaskCheckpoint {
  taskId: string;
  attemptId?: string;
  savedAt: number;
  task: RunnerTask;
}

