/**
 * Wire format and delivery helpers for the Overseer client.
 *
 * The deployed Codmir ingest route (`POST /api/v1/overseer/ingest`) stores an error only when it arrives as
 * `{ type: "error", event: {...}, group: {...} }`. A flat `OverseerEvent` is counted as dropped behind a 200,
 * so every error is converted here before it leaves the process. Other event types are sent as they are.
 */

/** Public ingest base. Never derived from `window.location`: that is the customer's own origin. */
/**
 * The address that answers itself. The apex answers every request with a redirect to `www`, and a browser refuses a
 * redirect on the preflight that `x-overseer-key` makes it send: from a page, nothing would ever arrive.
 */
export const DEFAULT_DSN = "https://www.codmir.com/api/v1/overseer";

/** Events per request. The server caps a body at 256 KB and 500 events; batches are capped by bytes too ({@link MAX_BATCH_BYTES}), because events with many breadcrumbs run far over 2 KB. */
export const MAX_BATCH_EVENTS = 100;
/** UTF-8 bytes per request body: a margin under the 256 KB the server takes before it answers 413. */
export const MAX_BATCH_BYTES = 240_000;
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
 * Group fingerprint, identical to `sdkFingerprint` in the platform:
 * error name, `file:line` of the first in-app frame, then the message with UUIDs masked to `<UUID>`, runs of
 * 8+ hex characters holding at least one letter a-f masked to `<ID>` and digits masked to `<N>` (in that order), cut
 * to 100 characters. A digit-only number is always `<N>`, whatever its length.
 */
export function sdkFingerprint(event: WireSourceEvent): string[] {
  const exception = event.exception;
  const parts: string[] = [exception?.type || "Error"];

  const inAppFrame = exception?.stacktrace?.find((f) => f.in_app === true && f.filename);
  if (inAppFrame) parts.push(`${inAppFrame.filename}:${inAppFrame.lineno}`);

  const message = exception?.value ?? event.message ?? "";
  parts.push(
    message
      .replace(/\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/gi, "<UUID>")
      .replace(/(?=[0-9a-f]*[a-f])[0-9a-f]{8,}/gi, "<ID>")
      .replace(/\d+/g, "<N>")
      .slice(0, 100),
  );
  return parts;
}

/**
 * An `error` event becomes `{ type, event, group }`; any other type is returned untouched.
 * The event's own `fingerprint[]` (set in `beforeSend`) wins over the computed one.
 */
export function toWireEvent<T extends { type: string }>(input: T): unknown {
  if (input.type !== "error") return input;
  const source = input as unknown as WireSourceEvent;

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

/**
 * `JSON.stringify` that does not throw on what apps capture: a BigInt is written as its decimal string, and a value
 * that is its own ancestor is written as "[Circular]". Only true cycles are cut: the chain of parents is tracked, not
 * every object seen, so one object reached twice side by side (the fingerprint in `event` and in `group`) is written
 * both times. Everything else is as `JSON.stringify` writes it. A `toJSON` or getter that throws still throws.
 */
export function safeStringify(value: unknown): string {
  const ancestors: unknown[] = [];
  return JSON.stringify(value, function (this: unknown, _key: string, v: unknown) {
    if (typeof v === "bigint") return v.toString();
    if (v === null || typeof v !== "object") return v;
    // `this` is the object holding `v`; whatever sits above it in the chain is a sibling branch that has been left.
    while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
    if (ancestors.includes(v)) return "[Circular]";
    ancestors.push(v);
    return v;
  }) as string;
}

/** The request body: the envelope fields the route reads, clipped to its limits, plus the converted events. */
export function buildBody(events: Array<{ type: string }>, meta: EnvelopeMeta): string {
  const body: Record<string, unknown> = { events: events.map(toWireEvent) };
  if (meta.service) body.service = meta.service.slice(0, MAX_SERVICE);
  if (meta.environment) body.environment = meta.environment.slice(0, MAX_ENVIRONMENT);
  if (meta.release) body.release = meta.release.slice(0, MAX_RELEASE);
  if (meta.sessionId) body.sessionId = meta.sessionId.slice(0, MAX_SESSION_ID);
  return safeStringify(body);
}

/** UTF-8 byte length of a string, the unit a request body is limited in. Needs no `TextEncoder`, so it also runs in React Native. */
export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/** Bytes one event adds to a request body. */
export function wireEventBytes(event: { type: string }): number {
  return utf8Bytes(safeStringify(toWireEvent(event)));
}

/** A copy of `event` without its `count` oldest breadcrumbs, or null when it has none to lose. The caller's event is not touched. */
export function withoutOldestBreadcrumbs<T extends { type: string }>(event: T, count: number): T | null {
  const crumbs = (event as { breadcrumbs?: unknown }).breadcrumbs;
  if (!Array.isArray(crumbs) || crumbs.length === 0 || count <= 0) return null;
  return { ...event, breadcrumbs: crumbs.slice(count) };
}

/**
 * A copy of `event` that takes at most `budget` bytes on the wire, losing breadcrumbs oldest first,
 * or null when it does not fit even with none left. An event that already fits is returned as it is.
 */
export function fitEventToBytes<T extends { type: string }>(event: T, budget: number): T | null {
  let size = wireEventBytes(event);
  if (size <= budget) return event;
  const crumbs = (event as { breadcrumbs?: unknown[] }).breadcrumbs;
  if (!Array.isArray(crumbs) || crumbs.length === 0) return null;
  // Each breadcrumb is sized once; dropping one frees its bytes and one comma (none for the last one left).
  let drop = 0;
  while (drop < crumbs.length && size > budget) {
    size -= utf8Bytes(safeStringify(crumbs[drop]) ?? "null") + (drop < crumbs.length - 1 ? 1 : 0);
    drop++;
  }
  const fitted = withoutOldestBreadcrumbs(event, drop);
  return fitted && wireEventBytes(fitted) <= budget ? fitted : null;
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
