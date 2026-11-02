import { nanoid } from "nanoid";
import type { CanonicalTaskEvent, RunnerTaskState } from "./types";

export interface LegacyRunnerEvent {
  type: string;
  taskId: string;
  timestamp: number;
  data: unknown;
}

export interface LegacyTranslatorOptions {
  seq: number;
  source?: string;
}

const PHASE_TO_STATE: Record<string, RunnerTaskState> = {
  queued: "queued",
  initializing: "running",
  analyzing: "running",
  coding: "running",
  testing: "running",
  awaiting_approval: "awaiting_approval",
  complete: "completed",
  error: "failed",
};

export function legacyPhaseToState(phase: string): RunnerTaskState {
  return PHASE_TO_STATE[phase] ?? "running";
}

export function translateLegacyRunnerEvent(
  event: LegacyRunnerEvent,
  options: LegacyTranslatorOptions,
): CanonicalTaskEvent {
  const payload = normalizeLegacyPayload(event);
  return {
    version: "v1",
    id: nanoid(12),
    seq: options.seq,
    taskId: event.taskId,
    type: payload.type,
    timestamp: event.timestamp,
    source: options.source ?? "legacy_runner",
    payload: payload.payload,
  };
}

function normalizeLegacyPayload(
  event: LegacyRunnerEvent,
): { type: string; payload: Record<string, unknown> } {
  if (event.type === "phase_change") {
    const phase = readString((event.data as { phase?: unknown })?.phase, "running");
    return {
      type: "state_change",
      payload: {
        phase,
        state: legacyPhaseToState(phase),
      },
    };
  }

  if (event.type === "error") {
    const message = readString((event.data as { message?: unknown })?.message, "Unknown error");
    return {
      type: "error",
      payload: {
        message,
      },
    };
  }

  return {
    type: event.type,
    payload: ensureRecord(event.data),
  };
}

function ensureRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { value };
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}
