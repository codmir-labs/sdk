import { z } from "zod";

export const ExecutionTargetSchema = z.enum(["auto", "local_runner", "remote_worker"]);
export type ExecutionTarget = z.infer<typeof ExecutionTargetSchema>;

export const RunnerTaskStateSchema = z.enum([
  "queued",
  "assigned",
  "running",
  "awaiting_approval",
  "completed",
  "failed",
  "cancelled",
]);
export type RunnerTaskState = z.infer<typeof RunnerTaskStateSchema>;

export const CreateTaskRequestSchema = z.object({
  goal: z.string().min(1),
  projectId: z.string().optional(),
  workspace: z.string().optional(),
  executionTarget: ExecutionTargetSchema.default("auto"),
  metadata: z.record(z.unknown()).optional(),
  requiredCapabilities: z.array(z.string()).optional(),
});
export type CreateTaskRequest = z.infer<typeof CreateTaskRequestSchema>;

export const CreateTaskResponseSchema = z.object({
  taskId: z.string(),
  state: RunnerTaskStateSchema,
  executionTarget: ExecutionTargetSchema,
  assignedWorkerId: z.string().optional(),
  attemptId: z.string().optional(),
});
export type CreateTaskResponse = z.infer<typeof CreateTaskResponseSchema>;

export const TaskStatusResponseSchema = z.object({
  taskId: z.string(),
  state: RunnerTaskStateSchema,
  executionTarget: ExecutionTargetSchema,
  projectId: z.string().optional(),
  goal: z.string(),
  assignedWorkerId: z.string().optional(),
  attemptId: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  result: z.unknown().optional(),
  error: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  currentAttempt: z
    .object({
      attemptId: z.string(),
      workerId: z.string().optional(),
      state: z.enum([
        "assigned",
        "claimed",
        "running",
        "awaiting_approval",
        "completed",
        "failed",
        "cancelled",
        "abandoned",
      ]),
      assignedAt: z.number(),
      startedAt: z.number().optional(),
      finishedAt: z.number().optional(),
      leaseExpiresAt: z.number().optional(),
      stepId: z.string().optional(),
    })
    .optional(),
});
export type TaskStatusResponse = z.infer<typeof TaskStatusResponseSchema>;

export const CanonicalTaskEventSchema = z.object({
  version: z.literal("v1").optional().default("v1"),
  id: z.string(),
  seq: z.number().int().nonnegative(),
  taskId: z.string(),
  type: z.string(),
  timestamp: z.number(),
  source: z.string(),
  payload: z.record(z.unknown()),
});
export type CanonicalTaskEvent = z.infer<typeof CanonicalTaskEventSchema>;

export const RegisterWorkerRequestSchema = z.object({
  name: z.string().optional(),
  capabilities: z.array(z.string()).default([]),
  metadata: z.record(z.unknown()).optional(),
  maxConcurrentTasks: z.number().int().positive().default(1),
});
export type RegisterWorkerRequest = z.infer<typeof RegisterWorkerRequestSchema>;

export const RegisterWorkerResponseSchema = z.object({
  workerId: z.string(),
  workerToken: z.string(),
  heartbeatIntervalMs: z.number().int().positive(),
  assignmentsStreamUrl: z.string(),
});
export type RegisterWorkerResponse = z.infer<typeof RegisterWorkerResponseSchema>;

export const WorkerHeartbeatRequestSchema = z.object({
  currentLoad: z.number().int().nonnegative().default(0),
  capabilities: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type WorkerHeartbeatRequest = z.infer<typeof WorkerHeartbeatRequestSchema>;

export const WorkerHeartbeatResponseSchema = z.object({
  ok: z.boolean(),
  workerId: z.string(),
  nextHeartbeatMs: z.number().int().positive(),
  assignedTaskCount: z.number().int().nonnegative(),
});
export type WorkerHeartbeatResponse = z.infer<typeof WorkerHeartbeatResponseSchema>;

export const WorkerAssignmentEventSchema = z.object({
  id: z.string(),
  type: z.enum(["task_assigned", "task_cancelled", "task_control", "ping"]),
  workerId: z.string(),
  timestamp: z.number(),
  payload: z.record(z.unknown()),
});
export type WorkerAssignmentEvent = z.infer<typeof WorkerAssignmentEventSchema>;

export const ClaimTaskRequestSchema = z.object({
  workerId: z.string(),
  attemptId: z.string().optional(),
  idempotencyKey: z.string().optional(),
});
export type ClaimTaskRequest = z.infer<typeof ClaimTaskRequestSchema>;

export const ClaimTaskResponseSchema = z.object({
  ok: z.boolean(),
  taskId: z.string(),
  workerId: z.string(),
  attemptId: z.string(),
  state: RunnerTaskStateSchema,
});
export type ClaimTaskResponse = z.infer<typeof ClaimTaskResponseSchema>;

export const IngestTaskEventRequestSchema = z.object({
  workerId: z.string(),
  attemptId: z.string(),
  event: CanonicalTaskEventSchema,
});
export type IngestTaskEventRequest = z.infer<typeof IngestTaskEventRequestSchema>;

export const CompleteTaskRequestSchema = z.object({
  workerId: z.string(),
  attemptId: z.string(),
  result: z.unknown().optional(),
  summary: z.string().optional(),
  idempotencyKey: z.string().optional(),
});
export type CompleteTaskRequest = z.infer<typeof CompleteTaskRequestSchema>;

export const FailTaskRequestSchema = z.object({
  workerId: z.string(),
  attemptId: z.string(),
  error: z.string(),
  idempotencyKey: z.string().optional(),
});
export type FailTaskRequest = z.infer<typeof FailTaskRequestSchema>;

export const TaskControlActionSchema = z.enum([
  "pause",
  "resume",
  "cancel",
  "approve",
  "reject",
]);
export type TaskControlAction = z.infer<typeof TaskControlActionSchema>;

export const TaskControlRequestSchema = z.object({
  action: TaskControlActionSchema,
  attemptId: z.string().optional(),
  stepId: z.string().optional(),
  reason: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  idempotencyKey: z.string().optional(),
});
export type TaskControlRequest = z.infer<typeof TaskControlRequestSchema>;

export const TaskControlResponseSchema = z.object({
  ok: z.boolean(),
  taskId: z.string(),
  action: TaskControlActionSchema,
  state: RunnerTaskStateSchema,
  attemptId: z.string().optional(),
  stepId: z.string().optional(),
});
export type TaskControlResponse = z.infer<typeof TaskControlResponseSchema>;

export const IngestTaskEventResponseSchema = z.object({
  ok: z.boolean(),
  taskId: z.string(),
  eventId: z.string(),
  duplicate: z.boolean().optional(),
});
export type IngestTaskEventResponse = z.infer<typeof IngestTaskEventResponseSchema>;

export const CompleteTaskResponseSchema = z.object({
  ok: z.boolean(),
  taskId: z.string(),
  state: RunnerTaskStateSchema,
});
export type CompleteTaskResponse = z.infer<typeof CompleteTaskResponseSchema>;

export const FailTaskResponseSchema = z.object({
  ok: z.boolean(),
  taskId: z.string(),
  state: RunnerTaskStateSchema,
});
export type FailTaskResponse = z.infer<typeof FailTaskResponseSchema>;

export interface TaskRunnerClient {
  createTask(input: CreateTaskRequest): Promise<CreateTaskResponse>;
  getTask(taskId: string): Promise<TaskStatusResponse>;
  streamTaskEvents(
    taskId: string,
    signal?: AbortSignal,
  ): Promise<AsyncGenerator<CanonicalTaskEvent>>;
  controlTask(taskId: string, input: TaskControlRequest): Promise<TaskControlResponse>;
}

export interface WorkerClient {
  register(input: RegisterWorkerRequest): Promise<RegisterWorkerResponse>;
  heartbeat(workerId: string, input: WorkerHeartbeatRequest): Promise<WorkerHeartbeatResponse>;
  streamAssignments(
    workerId: string,
    signal?: AbortSignal,
  ): Promise<AsyncGenerator<WorkerAssignmentEvent>>;
  claimTask(taskId: string, input: ClaimTaskRequest): Promise<ClaimTaskResponse>;
  publishTaskEvent(taskId: string, input: IngestTaskEventRequest): Promise<IngestTaskEventResponse>;
  completeTask(taskId: string, input: CompleteTaskRequest): Promise<CompleteTaskResponse>;
  failTask(taskId: string, input: FailTaskRequest): Promise<FailTaskResponse>;
}
