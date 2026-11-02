/**
 * Segment upload for session replay (CSL-5612). Wire contract: `ReplaySegmentUploadSchema` in platform-v2
 * `@codmir/types` (CSL-5611), mirrored in `__tests__/helpers.ts`. Nothing here throws into the page.
 */

import { SDK_INFO } from "../version";

/** The server rejects a body over 2 MB with 413. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** Headroom under {@link MAX_BODY_BYTES} for the envelope and for UTF-8 expanding past `string.length`. */
export const TARGET_BODY_BYTES = 1_800_000;
export const MAX_EVENTS_PER_SEGMENT = 10_000;
/** `fetch(..., { keepalive: true })` bodies are limited to 64 KB by browsers. */
export const KEEPALIVE_MAX_BYTES = 60_000;
export const RETRY_DELAY_MS = 1000;

export interface RrwebEvent {
  type: number;
  timestamp: number;
  data?: unknown;
  [key: string]: unknown;
}

export interface SegmentUploadBody {
  replay_id: string;
  segment: number;
  started_at: string;
  ended_at: string;
  environment?: string;
  release?: string;
  error_event_ids: string[];
  sdk: { name: string; version: string };
  events: RrwebEvent[];
}

export interface UploadTarget {
  /** Full replay URL, see {@link replayEndpoint}. */
  url: string;
  key: string;
  environment?: string;
  release?: string;
  debug?: boolean;
}

/** `<dsn>/replay`, the same shape as the error ingest `<dsn>/ingest`; a DSN already ending in `/ingest` is swapped. */
export function replayEndpoint(dsn: string): string {
  const base = dsn.replace(/\/+$/, "");
  return base.endsWith("/ingest") ? `${base.slice(0, -"/ingest".length)}/replay` : `${base}/replay`;
}

export function buildSegmentBody(
  target: Pick<UploadTarget, "environment" | "release">,
  segment: { replayId: string; sequenceNumber: number; events: RrwebEvent[]; errorIds: string[] },
): SegmentUploadBody {
  const first = segment.events[0]?.timestamp ?? Date.now();
  const last = segment.events[segment.events.length - 1]?.timestamp ?? first;
  const body: SegmentUploadBody = {
    replay_id: segment.replayId,
    segment: segment.sequenceNumber,
    started_at: new Date(first).toISOString(),
    ended_at: new Date(Math.max(first, last)).toISOString(),
    error_event_ids: segment.errorIds,
    sdk: { ...SDK_INFO },
    events: segment.events,
  };
  if (target.environment) body.environment = target.environment.slice(0, 32);
  if (target.release && target.release !== "unknown") body.release = target.release.slice(0, 64);
  return body;
}

/**
 * Cuts `events` into consecutive runs that each fit one request: at most {@link MAX_EVENTS_PER_SEGMENT} events
 * and about {@link TARGET_BODY_BYTES} once serialised. A single event larger than the budget cannot be split
 * and is dropped (counted in `dropped`).
 */
export function chunkEvents(
  events: RrwebEvent[],
  overheadBytes = 600,
  budget = TARGET_BODY_BYTES,
): { chunks: RrwebEvent[][]; dropped: number } {
  const chunks: RrwebEvent[][] = [];
  let current: RrwebEvent[] = [];
  let size = overheadBytes;
  let dropped = 0;

  for (const event of events) {
    const bytes = JSON.stringify(event).length + 1;
    if (bytes + overheadBytes > budget) {
      dropped++;
      continue;
    }
    if (current.length > 0 && (current.length >= MAX_EVENTS_PER_SEGMENT || size + bytes > budget)) {
      chunks.push(current);
      current = [];
      size = overheadBytes;
    }
    current.push(event);
    size += bytes;
  }
  if (current.length > 0) chunks.push(current);
  return { chunks, dropped };
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
  });

const isRetryable = (status: number) => status >= 500 || status === 408 || status === 429;

/**
 * POSTs one segment. A network error or a retryable status is retried once; everything else, and the second
 * failure, drops the segment. Resolves true when the server accepted it. Never rejects.
 *
 * `hiding` is the pagehide path: the request goes out with `keepalive` when the body fits 64 KB, no retry.
 * `sendBeacon` is deliberately not used: it cannot set `x-overseer-key`, so the server would see an unkeyed
 * request (the same reason the error transport does not use it).
 */
export async function postSegment(target: UploadTarget, body: SegmentUploadBody, hiding = false): Promise<boolean> {
  if (typeof fetch !== "function") return false;
  const payload = JSON.stringify(body);
  const log = (...args: unknown[]) => {
    if (target.debug) console.log("[Overseer replay]", ...args);
  };

  const attempt = async (): Promise<"ok" | "retry" | "drop"> => {
    try {
      const res = await fetch(target.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-overseer-key": target.key },
        body: payload,
        ...(hiding && payload.length <= KEEPALIVE_MAX_BYTES ? { keepalive: true } : {}),
      });
      if (res.ok) return "ok";
      log(`segment ${body.segment} answered ${res.status}`);
      return isRetryable(res.status) ? "retry" : "drop";
    } catch (err) {
      log("segment upload failed", err);
      return "retry";
    }
  };

  try {
    let outcome = await attempt();
    if (outcome === "retry" && !hiding) {
      await sleep(RETRY_DELAY_MS);
      outcome = await attempt();
    }
    return outcome === "ok";
  } catch {
    return false;
  }
}
