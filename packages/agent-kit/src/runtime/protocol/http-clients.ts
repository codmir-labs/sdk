import {
  ClaimTaskResponseSchema,
  CompleteTaskResponseSchema,
  CreateTaskResponseSchema,
  type ClaimTaskRequest,
  type ClaimTaskResponse,
  type CompleteTaskRequest,
  type CompleteTaskResponse,
  type CreateTaskRequest,
  type CreateTaskResponse,
  type FailTaskRequest,
  type FailTaskResponse,
  FailTaskResponseSchema,
  IngestTaskEventResponseSchema,
  type IngestTaskEventRequest,
  type IngestTaskEventResponse,
  RegisterWorkerResponseSchema,
  type RegisterWorkerRequest,
  type RegisterWorkerResponse,
  TaskControlResponseSchema,
  type TaskControlRequest,
  type TaskControlResponse,
  type TaskRunnerClient,
  TaskStatusResponseSchema,
  type TaskStatusResponse,
  type WorkerClient,
  WorkerHeartbeatResponseSchema,
  type WorkerHeartbeatRequest,
  type WorkerHeartbeatResponse,
} from "./types";
import { streamCanonicalTaskEvents, streamWorkerAssignments } from "./sse";

export interface RunnerHttpClientOptions {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface RequestOptions {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  signal?: AbortSignal;
}

export class TaskRunnerHttpClient implements TaskRunnerClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: RunnerHttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async createTask(input: CreateTaskRequest): Promise<CreateTaskResponse> {
    const response = await this.request({
      method: "POST",
      path: "/v1/tasks",
      body: input,
    });
    return CreateTaskResponseSchema.parse(await response.json());
  }

  async getTask(taskId: string): Promise<TaskStatusResponse> {
    const response = await this.request({
      method: "GET",
      path: `/v1/tasks/${encodeURIComponent(taskId)}`,
    });
    return TaskStatusResponseSchema.parse(await response.json());
  }

  async streamTaskEvents(
    taskId: string,
    signal?: AbortSignal,
  ): Promise<AsyncGenerator<import("./types").CanonicalTaskEvent>> {
    const response = await this.request({
      method: "GET",
      path: `/v1/tasks/${encodeURIComponent(taskId)}/events`,
      signal,
    });
    return streamCanonicalTaskEvents(response, signal);
  }

  async controlTask(taskId: string, input: TaskControlRequest): Promise<TaskControlResponse> {
    const response = await this.request({
      method: "POST",
      path: `/v1/tasks/${encodeURIComponent(taskId)}/control`,
      body: input,
    });
    return TaskControlResponseSchema.parse(await response.json());
  }

  protected async request(options: RequestOptions): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    const headers: Record<string, string> = {};
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${options.path}`, {
        method: options.method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(
          `Runner HTTP ${response.status} (${options.method} ${options.path}): ${text || response.statusText}`,
        );
      }

      return response;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class WorkerHttpClient extends TaskRunnerHttpClient implements WorkerClient {
  async register(input: RegisterWorkerRequest): Promise<RegisterWorkerResponse> {
    const response = await this.request({
      method: "POST",
      path: "/v1/workers/register",
      body: input,
    });
    return RegisterWorkerResponseSchema.parse(await response.json());
  }

  async heartbeat(
    workerId: string,
    input: WorkerHeartbeatRequest,
  ): Promise<WorkerHeartbeatResponse> {
    const response = await this.request({
      method: "POST",
      path: `/v1/workers/${encodeURIComponent(workerId)}/heartbeat`,
      body: input,
    });
    return WorkerHeartbeatResponseSchema.parse(await response.json());
  }

  async streamAssignments(
    workerId: string,
    signal?: AbortSignal,
  ): Promise<AsyncGenerator<import("./types").WorkerAssignmentEvent>> {
    const response = await this.request({
      method: "GET",
      path: `/v1/workers/${encodeURIComponent(workerId)}/assignments`,
      signal,
    });
    return streamWorkerAssignments(response, signal);
  }

  async claimTask(taskId: string, input: ClaimTaskRequest): Promise<ClaimTaskResponse> {
    const response = await this.request({
      method: "POST",
      path: `/v1/tasks/${encodeURIComponent(taskId)}/claim`,
      body: input,
    });
    return ClaimTaskResponseSchema.parse(await response.json());
  }

  async publishTaskEvent(
    taskId: string,
    input: IngestTaskEventRequest,
  ): Promise<IngestTaskEventResponse> {
    const response = await this.request({
      method: "POST",
      path: `/v1/tasks/${encodeURIComponent(taskId)}/events`,
      body: input,
    });
    return IngestTaskEventResponseSchema.parse(await response.json());
  }

  async completeTask(taskId: string, input: CompleteTaskRequest): Promise<CompleteTaskResponse> {
    const response = await this.request({
      method: "POST",
      path: `/v1/tasks/${encodeURIComponent(taskId)}/complete`,
      body: input,
    });
    return CompleteTaskResponseSchema.parse(await response.json());
  }

  async failTask(taskId: string, input: FailTaskRequest): Promise<FailTaskResponse> {
    const response = await this.request({
      method: "POST",
      path: `/v1/tasks/${encodeURIComponent(taskId)}/fail`,
      body: input,
    });
    return FailTaskResponseSchema.parse(await response.json());
  }
}
