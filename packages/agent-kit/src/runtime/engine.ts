import { nanoid } from "nanoid";
import type {
  RunnerDecision,
  RunnerEngine,
  RunnerEvent,
  RunnerExecutionContext,
  RunnerLlmAdapter,
  RunnerStateStore,
  RunnerTask,
  RunnerTaskStep,
  RunnerToolRegistry,
} from "./types";

export interface RunnerEngineOptions {
  llm: RunnerLlmAdapter;
  tools: RunnerToolRegistry;
  state: RunnerStateStore;
  maxIterations?: number;
  onEvent?: (event: RunnerEvent) => Promise<void> | void;
}

export class DefaultRunnerEngine implements RunnerEngine {
  private readonly llm: RunnerLlmAdapter;
  private readonly tools: RunnerToolRegistry;
  private readonly state: RunnerStateStore;
  private readonly maxIterations: number;
  private readonly onEvent?: (event: RunnerEvent) => Promise<void> | void;
  private readonly seqByTask = new Map<string, number>();

  constructor(options: RunnerEngineOptions) {
    this.llm = options.llm;
    this.tools = options.tools;
    this.state = options.state;
    this.maxIterations = options.maxIterations ?? 60;
    this.onEvent = options.onEvent;
  }

  async run(task: RunnerTask, context: RunnerExecutionContext = {}): Promise<RunnerTask> {
    const started = this.ensureTaskDefaults(task);
    return this.executeLoop(started, context);
  }

  async resume(taskId: string, context: RunnerExecutionContext = {}): Promise<RunnerTask> {
    const checkpoint = await this.state.loadCheckpoint(taskId);
    if (!checkpoint) {
      throw new Error(`No checkpoint found for task "${taskId}"`);
    }
    return this.executeLoop(checkpoint.task, context);
  }

  private async executeLoop(
    task: RunnerTask,
    context: RunnerExecutionContext,
  ): Promise<RunnerTask> {
    task.state = task.state === "queued" ? "running" : task.state;
    task.updatedAt = Date.now();
    await this.emit(task, "state_change", { state: task.state, reason: "runner_started" });

    let iteration = 0;
    while (iteration < this.maxIterations) {
      if (context.signal?.aborted) {
        task.state = "cancelled";
        task.updatedAt = Date.now();
        await this.appendStep(task, {
          type: "state_change",
          payload: { state: task.state, reason: "aborted" },
        });
        await this.persist(task);
        return task;
      }

      iteration++;
      const decision = await this.llm.nextAction({
        task,
        history: task.steps,
        availableTools: this.tools.listTools(),
        context,
      });

      await this.handleDecision(task, decision, context);

      if (task.state === "completed" || task.state === "failed" || task.state === "cancelled") {
        if (task.state === "completed") {
          await this.state.deleteCheckpoint(task.id);
        } else {
          await this.persist(task);
        }
        return task;
      }

      await this.persist(task);
    }

    task.state = "failed";
    task.error = "Runner exceeded max iterations";
    task.updatedAt = Date.now();
    await this.appendStep(task, {
      type: "state_change",
      payload: { state: task.state, reason: "max_iterations" },
    });
    await this.persist(task);
    return task;
  }

  private async handleDecision(
    task: RunnerTask,
    decision: RunnerDecision,
    context: RunnerExecutionContext,
  ): Promise<void> {
    if (decision.kind === "pause") {
      task.state = "awaiting_approval";
      task.updatedAt = Date.now();
      await this.appendStep(task, {
        type: "step_pending",
        payload: { reason: decision.reason ?? "approval_required" },
      });
      return;
    }

    if (decision.kind === "finish") {
      task.state = "completed";
      task.result = decision.output ?? {
        summary: decision.summary ?? "Task completed",
      };
      task.updatedAt = Date.now();
      await this.appendStep(task, {
        type: "result",
        payload: {
          summary: decision.summary ?? "Task completed",
        },
      });
      await this.emit(task, "complete", {
        summary: decision.summary ?? "Task completed",
      });
      return;
    }

    if (decision.kind === "tool_call") {
      const toolCallId = nanoid(10);
      if (decision.thinking) {
        await this.appendStep(task, {
          type: "thinking",
          payload: { text: decision.thinking },
        });
      }

      await this.appendStep(task, {
        type: "tool_call",
        payload: {
          id: toolCallId,
          toolName: decision.toolName,
          args: decision.args,
        },
      });

      try {
        const output = await this.tools.executeTool(decision.toolName, decision.args, context);
        await this.appendStep(task, {
          type: "tool_result",
          payload: {
            id: toolCallId,
            toolName: decision.toolName,
            output: this.serializeResult(output),
          },
        });
      } catch (error) {
        task.state = "failed";
        task.error = error instanceof Error ? error.message : String(error);
        task.updatedAt = Date.now();
        await this.appendStep(task, {
          type: "tool_result",
          payload: {
            id: toolCallId,
            toolName: decision.toolName,
            isError: true,
            error: task.error,
          },
        });
        await this.emit(task, "error", { message: task.error });
      }
      return;
    }
  }

  private ensureTaskDefaults(task: RunnerTask): RunnerTask {
    const now = Date.now();
    return {
      ...task,
      state: task.state ?? "queued",
      createdAt: task.createdAt ?? now,
      updatedAt: task.updatedAt ?? now,
      steps: task.steps ?? [],
      metadata: task.metadata ?? {},
    };
  }

  private async appendStep(
    task: RunnerTask,
    input: Pick<RunnerTaskStep, "type" | "payload">,
  ): Promise<void> {
    const step: RunnerTaskStep = {
      id: nanoid(10),
      type: input.type,
      payload: input.payload,
      timestamp: Date.now(),
    };
    task.steps.push(step);
    task.updatedAt = step.timestamp;

    await this.emit(task, input.type, {
      stepId: step.id,
      ...input.payload,
    });
  }

  private async emit(
    task: RunnerTask,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.onEvent) return;

    const seq = (this.seqByTask.get(task.id) ?? 0) + 1;
    this.seqByTask.set(task.id, seq);

    await this.onEvent({
      id: nanoid(12),
      seq,
      taskId: task.id,
      type,
      timestamp: Date.now(),
      source: "runner_engine",
      payload,
    });
  }

  private async persist(task: RunnerTask): Promise<void> {
    await this.state.saveCheckpoint({
      taskId: task.id,
      attemptId: task.attemptId,
      savedAt: Date.now(),
      task,
    });
  }

  private serializeResult(value: unknown): Record<string, unknown> {
    if (value === null || typeof value === "undefined") {
      return { value: null };
    }

    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return { value };
    }

    if (Array.isArray(value)) {
      return { value };
    }

    if (typeof value === "object") {
      return value as Record<string, unknown>;
    }

    return { value: String(value) };
  }
}

