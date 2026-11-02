/**
 * Wire format and delivery helpers for the Overseer client (CSL-5492).
 *
 * The deployed Codmir ingest route (`POST /api/v1/overseer/ingest`) stores an error only when it arrives as
 * `{ type: "error", event: {...}, group: {...} }`. A flat `OverseerEvent` is counted as dropped behind a 200,
 * so every error is converted here before it leaves the process. Other event types are sent as they are.
 */

/** Public ingest base. Never derived from `window.location`: that is the customer's own origin. */
export const DEFAULT_DSN = "https://codmir.com/api/overseer";

/** Events per request. The server caps a body at 256 KB and 500 events; 100 events of ~1-2 KB sits well under both. */
export const MAX_BATCH_EVENTS = 100;
/** Events kept while the network is down. Past this the oldest are dropped. */
export const MAX_QUEUE_SIZE = 1000;
/** Retry delay is `RETRY_BASE_MS * 2^attempt`, never more than `RETRY_MAX_MS`. */
export const RETRY_BASE_MS = 1000;
export const RETRY_MAX_MS = 60_000;
/** `fetch(..., { keepalive: true })` bodies are limited to 64 KB by browsers; stay under it. */
export const KEEPALIVE_MAX_BYTES = 60_000;

/** Envelope limits the server validates (TelemetryIngestBodySchema); a longer value would 400 the whole batch. */
const MAX_SESSION_ID = 128;
const MAX_SERVICE = 64;
const MAX_ENVIRONMENT = 32;
const MAX_RELEASE = 64;

interface FrameLike {
  filename?: string;
  lineno?: number;
  in_app?: boolean;
}

/** The subset of an SDK event the wire conversion reads. */
export interface WireSourceEvent {
  id: string;
  type: string;
  timestamp: string;
  level: string;
  message?: string;
  exception?: { type: string; value: string; stacktrace?: FrameLike[] };
  fingerprint?: string[];
}

/**
 * Group fingerprint, identical to `sdkFingerprint` in the platform (apps/api normalize-sdk-event.ts, CSL-5492):
 * error name, `file:line` of the first in-app frame, then the message with digits masked to `<N>` and runs of
 * 8+ hex characters masked to `<ID>`, cut to 100 characters.
 */
export function sdkFingerprint(event: WireSourceEvent): string[] {
  const exception = event.exception;
  const parts: string[] = [exception?.type || "Error"];

  const inAppFrame = exception?.stacktrace?.find((f) => f.in_app === true && f.filename);
  if (inAppFrame) parts.push(`${inAppFrame.filename}:${inAppFrame.lineno}`);

  const message = exception?.value ?? event.message ?? "";
  parts.push(
    message
      .replace(/\d+/g, "<N>")
      .replace(/[a-f0-9]{8,}/gi, "<ID>")
      .slice(0, 100),
  );
  return parts;
}

/**
 * An `error` event becomes `{ type, event, group }`; any other type is returned untouched.
 * The event's own `fingerprint[]` (set in `beforeSend`) wins over the computed one.
 */
export function toWireEvent<T extends WireSourceEvent>(source: T): unknown {
  if (source.type !== "error") return source;

  const fingerprint = source.fingerprint?.length ? source.fingerprint : sdkFingerprint(source);
  const message = source.message ?? source.exception?.value;
  const topFrame = source.exception?.stacktrace?.find((f) => f.filename);
  const { type: _type, ...rest } = source;

  return {
    type: "error",
    event: { ...rest, message, fingerprint },
    group: {
      fingerprint,
      message,
      culprit: topFrame ? `${topFrame.filename}:${topFrame.lineno}` : undefined,
      level: source.level,
    },
  };
}

export interface EnvelopeMeta {
  service?: string;
  environment?: string;
  release?: string;
  sessionId?: string | null;
}

/** The request body: the envelope fields the route reads, clipped to its limits, plus the converted events. */
export function buildBody(events: WireSourceEvent[], meta: EnvelopeMeta): string {
  const body: Record<string, unknown> = { events: events.map(toWireEvent) };
  if (meta.service) body.service = meta.service.slice(0, MAX_SERVICE);
  if (meta.environment) body.environment = meta.environment.slice(0, MAX_ENVIRONMENT);
  if (meta.release) body.release = meta.release.slice(0, MAX_RELEASE);
  if (meta.sessionId) body.sessionId = meta.sessionId.slice(0, MAX_SESSION_ID);
  return JSON.stringify(body);
}

/** Delay before retry number `attempt` (0-based): 1s, 2s, 4s ... capped at {@link RETRY_MAX_MS}. */
export function retryDelayMs(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(attempt, 20));
}

/** 4xx other than 408 and 429 means the request itself is wrong; sending it again cannot help. */
export function isRetryableStatus(status: number): boolean {
  if (status >= 500) return true;
  if (status === 408 || status === 429) return true;
  return false;
}

export interface DroppedEventInfo {
  index: number;
  reason: string;
  type?: string;
}

/** `droppedEvents` from the response, or an empty list when the body is not JSON or has none. */
export async function readDroppedEvents(res: { json(): Promise<unknown> }): Promise<DroppedEventInfo[]> {
  try {
    const body = (await res.json()) as { droppedEvents?: unknown };
    return Array.isArray(body?.droppedEvents) ? (body.droppedEvents as DroppedEventInfo[]) : [];
  } catch {
    return [];
  }
}
