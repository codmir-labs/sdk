/**
 * Segment upload for session replay. Wire contract: `ReplaySegmentUploadSchema` in the platform's
 * `@codmir/types`, mirrored in `__tests__/helpers.ts`. Nothing here throws into the page.
 */

import { replayUrl } from "../endpoints";
import { claimKeepalive, KEEPALIVE_MAX_BYTES } from "../overseer/keepalive";
import { utf8Bytes } from "../overseer/transport";
import { scrubUrl } from "../overseer/url-scrub";
import { SDK_INFO } from "../version";

/** rrweb's Meta event: `data.href` is the page's address (`window.location.href`), then its width and height. */
export const RRWEB_META = 4;
/** rrweb's FullSnapshot event: the whole page, which the player needs before any incremental event. */
export const RRWEB_FULL_SNAPSHOT = 2;

/** The server rejects a body over 2 MB (UTF-8 bytes, not string length) with 413. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** Headroom under {@link MAX_BODY_BYTES} for the envelope and for the events being sized one by one. */
export const TARGET_BODY_BYTES = 1_800_000;
export const MAX_EVENTS_PER_SEGMENT = 10_000;
/**
 * The most the on-error buffer holds, and the most one session or post-error segment gathers before it is cut, in
 * {@link eventBytes}. 4 MiB is a little over two requests of {@link TARGET_BODY_BYTES}, so an error sends at most three
 * chunks, and it stays under the 5 MiB the retry queue takes.
 */
export const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
export { KEEPALIVE_MAX_BYTES };
export const RETRY_DELAY_MS = 1000;
/** A 429 without a readable `Retry-After`: the server's rate window is 60 s. */
export const DEFAULT_RETRY_AFTER_MS = 60_000;
/** A `Retry-After` is trusted between these bounds. */
export const MIN_RETRY_AFTER_MS = 1000;
export const MAX_RETRY_AFTER_MS = 10 * 60_000;
/** The server accepts at most 500; the newest are kept. */
export const MAX_ERROR_EVENT_IDS = 500;

/**
 * The segment was not stored but may be later: the server is rate limiting (`delayMs` is its `Retry-After`, or 60 s
 * without a readable one), or the request failed twice (a network error, a 5xx or a 408; `delayMs` is `null`, the caller
 * picks a backoff).
 */
export interface RetryLater {
  outcome: "retry_later";
  delayMs: number | null;
}

/**
 * `stored`: accepted. `refused`: 202 `{stored:false}` (no card, or no credits): stop uploading this session.
 * `too_large`: 413, the body is over what the server takes; the caller may send it in halves. `failed`: dropped.
 * {@link RetryLater}: try again later. Internal: the replay entry does not export this type.
 */
export type UploadOutcome = "stored" | "refused" | "too_large" | "failed" | RetryLater;

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
  return replayUrl(dsn);
}

/**
 * The page's address keeps origin and path only, as breadcrumb and transaction URLs do (`scrubUrl`), so a token in its
 * query or fragment stays in the page. A Meta event is copied with the scrubbed `href`; the caller's events are never
 * mutated, since the recorder and its on-error buffer still hold them.
 */
function scrubPageUrls(events: RrwebEvent[]): RrwebEvent[] {
  return events.map((event) => {
    if (event.type !== RRWEB_META || typeof event.data !== "object" || event.data === null) return event;
    const data = event.data as { href?: unknown };
    if (data.href === undefined || data.href === null) return event;
    return { ...event, data: { ...data, href: scrubUrl(data.href) } };
  });
}

/**
 * The body of one segment upload. Every send path builds it here, so every Meta event goes out with the page's address
 * cut to origin and path; the events passed in are left as they were.
 */
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
    error_event_ids: segment.errorIds.slice(-MAX_ERROR_EVENT_IDS),
    sdk: { ...SDK_INFO },
    events: scrubPageUrls(segment.events),
  };
  if (target.environment) body.environment = target.environment.slice(0, 32);
  if (target.release && target.release !== "unknown") body.release = target.release.slice(0, 64);
  return body;
}

/** What one event adds to a request body: the UTF-8 bytes of its JSON plus the comma. {@link chunkEvents} sizes events the same way. */
export function eventBytes(event: RrwebEvent): number {
  return utf8Bytes(JSON.stringify(event)) + 1;
}

/**
 * Cuts `events` into consecutive runs that each fit one request: at most {@link MAX_EVENTS_PER_SEGMENT} events
 * and about {@link TARGET_BODY_BYTES} UTF-8 bytes once serialised. A single event larger than the budget cannot be split
 * and is dropped (counted in `dropped`; `snapshotDropped` says one of them was a FullSnapshot, so what follows cannot play).
 */
export function chunkEvents(
  events: RrwebEvent[],
  overheadBytes = 600,
  budget = TARGET_BODY_BYTES,
): { chunks: RrwebEvent[][]; dropped: number; snapshotDropped: boolean } {
  const chunks: RrwebEvent[][] = [];
  let current: RrwebEvent[] = [];
  let size = overheadBytes;
  let dropped = 0;
  let snapshotDropped = false;

  for (const event of events) {
    const bytes = eventBytes(event);
    if (bytes + overheadBytes > budget) {
      dropped++;
      if (event.type === RRWEB_FULL_SNAPSHOT) snapshotDropped = true;
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
  return { chunks, dropped, snapshotDropped };
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
  });

const isRetryable = (status: number) => status >= 500 || status === 408;
const TOO_LARGE = 413;
const RATE_LIMITED = 429;

/**
 * How long a `Retry-After` header asks to wait, in ms, clamped to 1 s .. 10 min: whole seconds, or an HTTP date.
 * `null` when it is absent or unreadable.
 */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "") return null;
  let ms: number;
  if (/^\d+$/.test(text)) ms = Number(text) * 1000;
  else {
    if (!/[a-z]/i.test(text)) return null; // an HTTP date has a month and a day name; "-3" is no date
    const at = Date.parse(text);
    if (Number.isNaN(at)) return null;
    ms = at - now;
  }
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(MIN_RETRY_AFTER_MS, ms));
}

type Attempt =
  | { kind: "ok" | "refused" | "retry" | "drop" | "too_large" }
  | { kind: "rate_limited"; delayMs: number };

/** The sends of one page hide, in order: once one goes without `keepalive`, every later one does too. */
export interface HideRun {
  cut: boolean;
}

/**
 * POSTs one segment. A network error or a 5xx/408 is retried once, about 1 s later; a second failure resolves
 * {@link RetryLater} with no delay. A 429 is not retried at once: it resolves {@link RetryLater} with the server's
 * `Retry-After` (60 s without one). A 413 is not retried and resolves `too_large` so the caller can split it; any other
 * status drops the segment (`failed`). Never rejects.
 *
 * `hiding` is the pagehide path: no immediate retry, and the request takes `keepalive` while its body fits the SDK's one
 * keepalive budget ({@link claimKeepalive}) and no earlier request of the same {@link HideRun} went without. A failure
 * that a retry could cure, a 429 included, resolves {@link RetryLater} like any other: the page may only have been
 * hidden, and the caller's queue holds the segment either way.
 * `immediateRetry: false` skips the 1 s retry (the caller's queue paces its own attempts).
 * `sendBeacon` is deliberately not used: it cannot set `x-overseer-key`, so the server would see an unkeyed
 * request (the same reason the error transport does not use it).
 */
export async function postSegment(
  target: UploadTarget,
  body: SegmentUploadBody,
  hiding = false,
  immediateRetry = true,
  run: HideRun = { cut: false },
): Promise<UploadOutcome> {
  if (typeof fetch !== "function") return "failed";
  const payload = JSON.stringify(body);
  let release: (() => void) | null = null;
  if (hiding && !run.cut) {
    const bytes = utf8Bytes(payload);
    release = bytes <= KEEPALIVE_MAX_BYTES ? claimKeepalive(bytes) : null;
    // One that does not fit ends keepalive for the rest of the hide: a later segment never travels where an earlier one did not.
    if (!release) run.cut = true;
  }
  const keepalive = release !== null;
  const log = (...args: unknown[]) => {
    if (target.debug) console.log("[Overseer replay]", ...args);
  };

  const attempt = async (): Promise<Attempt> => {
    try {
      const res = await fetch(target.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-overseer-key": target.key },
        body: payload,
        ...(keepalive ? { keepalive: true } : {}),
      });
      if (res.ok) {
        // 202 `{ stored: false, reason }` is the pay-as-you-go refusal: nothing was stored, do not keep sending.
        const answer = (await res.json().catch(() => null)) as { stored?: unknown } | null;
        return { kind: answer?.stored === false ? "refused" : "ok" };
      }
      log(`segment ${body.segment} answered ${res.status}`);
      if (res.status === TOO_LARGE) return { kind: "too_large" };
      if (res.status === RATE_LIMITED) {
        const header = res.headers?.get?.("Retry-After");
        return { kind: "rate_limited", delayMs: parseRetryAfter(header) ?? DEFAULT_RETRY_AFTER_MS };
      }
      return { kind: isRetryable(res.status) ? "retry" : "drop" };
    } catch (err) {
      log("segment upload failed", err);
      return { kind: "retry" };
    }
  };

  try {
    let result = await attempt();
    if (result.kind === "retry" && immediateRetry && !hiding) {
      await sleep(RETRY_DELAY_MS);
      result = await attempt();
    }
    switch (result.kind) {
      case "ok":
        return "stored";
      case "refused":
        return "refused";
      case "too_large":
        return "too_large";
      case "rate_limited":
        return { outcome: "retry_later", delayMs: result.delayMs };
      case "retry":
        return { outcome: "retry_later", delayMs: null };
      default:
        return "failed";
    }
  } catch {
    return "failed";
  } finally {
    release?.();
  }
}
