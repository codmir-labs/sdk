/**
 * Wire format and delivery helpers for the Overseer client.
 *
 * The deployed Codmir ingest route (`POST /api/v1/overseer/ingest`) stores an error only when it arrives as
 * `{ type: "error", event: {...}, group: {...} }`. A flat `OverseerEvent` is counted as dropped behind a 200,
 * so every error is converted here before it leaves the process. Other event types are sent as they are.
 */

import { messageKey, pathPattern } from "../logs/redact";
import { normalizeFrameFile } from "./frame-file";

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
/** Time one request may take before it is given up on and retried: 10 s under Node, 30 s in a browser and in React Native. */
export function requestTimeoutMs(): number {
  return typeof process !== "undefined" && process.versions?.node ? 10_000 : 30_000;
}
/** `fetch(..., { keepalive: true })` bodies are limited to 64 KB by browsers; stay under it. */
export const KEEPALIVE_MAX_BYTES = 60_000;

/** Envelope limits the server validates (TelemetryIngestBodySchema); a longer value would 400 the whole batch. */
const MAX_SESSION_ID = 128;
const MAX_SERVICE = 64;
const MAX_ENVIRONMENT = 32;
const MAX_RELEASE = 64;

interface FrameLike {
  filename?: string;
  function?: string;
  lineno?: number;
  colno?: number;
  context_line?: string;
  in_app?: boolean;
}

/** The subset of an SDK event the wire conversion reads. */
export interface WireSourceEvent {
  id: string;
  type: string;
  timestamp: string;
  level: string;
  message?: string;
  exception?: {
    type: string;
    value: string;
    stacktrace?: FrameLike[];
    causes?: Array<{ type: string; value: string; stacktrace?: FrameLike[]; source: string; parent: number }>;
  };
  fingerprint?: string[];
}

const inAppOf = (frames?: FrameLike[]): FrameLike | undefined => frames?.find((f) => f.in_app === true && f.filename);
const fileOf = (frames?: FrameLike[]): FrameLike | undefined => frames?.find((f) => f.filename);

/**
 * The frame the culprit names: the one the fingerprint uses (the first in-app frame of the top exception, else of the
 * first cause that has one); else the top exception's first frame with a file; else that of the first cause with one.
 */
function culpritFrame(exception: WireSourceEvent["exception"]): FrameLike | undefined {
  if (!exception) return undefined;
  const causes = exception.causes ?? [];
  return (
    inAppOf(exception.stacktrace) ??
    causes.map((c) => inAppOf(c.stacktrace)).find(Boolean) ??
    fileOf(exception.stacktrace) ??
    causes.map((c) => fileOf(c.stacktrace)).find(Boolean)
  );
}

/**
 * The grouping key before v2, kept as it was. Identical to the platform's own copy of the fingerprint for an event
 * without `causes`; that copy adds the causes rule below in its own part.
 *
 * - primary: the top exception when it has an in-app frame; otherwise the first `causes` entry, in walk order, that has
 *   one; otherwise the top exception.
 * - Parts: the top exception's type, then the `file:line` of primary's first in-app frame, then primary's masked
 *   message: UUIDs masked to `<UUID>`, runs of 8+ hex characters holding at least one letter a-f masked to `<ID>` and
 *   digits masked to `<N>` (in that order), cut to 100 characters. A digit-only number is always `<N>`, whatever its length.
 * - Root type: when `causes` is not empty, a fourth part: the type of the deepest entry reached by following
 *   `source: "cause"` links from the top. If the top has no `cause`, the type of `causes[0]`.
 * - An event without `causes` gives the first three parts only, as before.
 */
export function legacyFingerprint(event: WireSourceEvent): string[] {
  const exception = event.exception;
  const causes = exception?.causes?.length ? exception.causes : undefined;
  const parts: string[] = [exception?.type || "Error"];

  let inAppFrame = inAppOf(exception?.stacktrace);
  let message = exception?.value ?? event.message ?? "";
  if (!inAppFrame && causes) {
    const primary = causes.find((c) => inAppOf(c.stacktrace));
    if (primary) {
      inAppFrame = inAppOf(primary.stacktrace);
      message = primary.value ?? "";
    }
  }
  if (inAppFrame) parts.push(`${inAppFrame.filename}:${inAppFrame.lineno}`);

  parts.push(
    message
      .replace(/\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/gi, "<UUID>")
      .replace(/(?=[0-9a-f]*[a-f])[0-9a-f]{8,}/gi, "<ID>")
      .replace(/\d+/g, "<N>")
      .slice(0, 100),
  );

  if (causes) {
    let at = -1;
    for (let i = 0; i < causes.length; i++) {
      if (causes[i]!.parent === at && causes[i]!.source === "cause") at = i;
    }
    parts.push(causes[Math.max(at, 0)]!.type);
  }
  return parts;
}

const ANONYMOUS = /^(?:|\?|anonymous|\(anonymous\)|<anonymous>|<unknown>|<computed>)$|\.<anonymous>$/;
const RECEIVERS = /^(?:(?:module\.)?exports|Object|Module|Function|Array|Promise|Generator|AsyncFunction|Proxy|Reflect|globalThis|global|window|self)\./;

/** A function name without what differs between engines and call styles: `async `, `new `, `[as x]`, a generic receiver (`Object.`, `Module.`) and Firefox's `promise callback*`. */
export function normalizeFunctionName(name: string | undefined): string {
  let n = (name ?? "").trim().replace(/\s*\[as [^\]]*\]$/, "");
  for (let prev = ""; prev !== n; ) {
    prev = n;
    n = n.replace(/^(?:async|new)\s+/, "").replace(/^promise callback\*/, "").replace(RECEIVERS, "");
  }
  return n;
}

const SHORT_NAME = /^[A-Za-z0-9_$]{1,2}$/;
const MID_NAME = /^[A-Za-z0-9_$]{3}$/;

/** Whether a frame sits deep inside a one-line bundle: line 1 or 2, column above 1000. */
const deepInBundle = (frame: FrameLike): boolean => (frame.lineno === 1 || frame.lineno === 2) && (frame.colno ?? 0) > 1000;

/** One frame of the key and whether it is minified: `<normalized file>:<normalized function>`; an anonymous function by its trimmed source line, else its line number; a minified frame by its file alone. A mangled class name before the method is dropped. */
function frameKey(frame: FrameLike): { key: string; minified: boolean } {
  const normalized = normalizeFunctionName(frame.function);
  const file = normalizeFrameFile(frame.filename ?? "");
  const anonymous = ANONYMOUS.test(normalized);
  const context = anonymous ? frame.context_line?.trim().slice(0, 100) : undefined;
  const mangled = (name: string): boolean => SHORT_NAME.test(name) || (MID_NAME.test(name) && deepInBundle(frame));
  let fn = normalized;
  if (!anonymous) {
    const segments = normalized.split(".");
    while (segments.length > 1 && mangled(segments[0]!)) segments.shift();
    fn = segments.join(".");
  }
  if (anonymous ? !context && deepInBundle(frame) : mangled(fn.slice(fn.lastIndexOf(".") + 1))) {
    return { key: file, minified: true };
  }
  return { key: `${file}:${anonymous ? context || String(frame.lineno ?? "?") : fn}`, minified: false };
}

const KEY_FRAMES = 3;

const URL_IN_TEXT = /\bhttps?:\/\/[^\s'"`<>)\]]+/gi;

/**
 * The message part of a key with no frame. The log monitor's `messageKey` folds quoted values, dates, times, durations,
 * short hex, numbers and emails (its redaction); a URL in the text is first cut to its path as `pathPattern` writes it.
 * Then today's masks (UUID, hex runs, digits), cut to 100.
 */
function foldMessage(message: string): string {
  return messageKey(message.replace(URL_IN_TEXT, (url) => pathPattern(url)))
    .replace(/\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/gi, "<UUID>")
    .replace(/(?=[0-9a-f]*[a-f])[0-9a-f]{8,}/gi, "<ID>")
    .replace(/\d+/g, "<N>")
    .slice(0, 100);
}

/**
 * Group fingerprint, v2: where the error is, not what it says.
 *
 * - primary: the top exception when it has an in-app frame; otherwise the first `causes` entry, in walk order, that has
 *   one; otherwise there is no primary.
 * - Parts: the top exception's type, then the first 3 in-app frames of primary, each `<file>:<function>`. The file is
 *   normalized by {@link normalizeFrameFile}; the function loses `async `, `new `, `[as x]`, generic receivers such as
 *   `Object.` and `Module.`, and Firefox's `promise callback*`; an anonymous function is its trimmed `context_line`
 *   when source context gives one, else its line number. Fewer than 3 in-app frames means fewer parts.
 * - A frame whose function looks mangled by a minifier keys as its normalized file alone, with no function: the
 *   normalized name is 1 or 2 characters (letters, digits, `_`, `$`), or 3 such characters on a frame at line 1 or 2
 *   and column above 1000 (deep inside a one-line bundle). In a method name (`a.b.run`) each leading segment that
 *   looks mangled the same way is dropped, since a minifier renames class names and keeps method names: `e.charge`
 *   keys as `charge`, `OrderService.charge` keeps its class. When nothing is left, or the last segment itself looks
 *   mangled, the frame is a minified frame. Only a minified function name adds the message; a dropped class name
 *   does not. An anonymous frame with no `context_line`, at line 1 or 2
 *   and column above 1000, keys as its file alone too: its line number says nothing there. When any of the key's
 *   frames is one of these, the folded message (as below) is added after the frame parts and before the root type, so
 *   a minified app with no source maps keeps two errors of one bundle apart and the key survives a redeploy.
 * - Otherwise no line number and no message is in the key of an error that has a frame, so an edit above the throw, another
 *   engine's wording or a user's text never starts a new group.
 * - With no in-app frame (a frameless error, or a message event) the message is the second part, folded: a URL in it is
 *   cut to its path (`pathPattern`), then the log monitor's `messageKey` rules apply (emails, quoted values, dates,
 *   times, durations, short hex, numbers), then UUIDs are masked to `<UUID>`, runs of 8+ hex characters holding at
 *   least one letter a-f to `<ID>` and digits to `<N>` (in that order), cut to 100 characters.
 * - Root type: when `causes` is not empty, the last part is the type of the deepest entry reached by following
 *   `source: "cause"` links from the top. If the top has no `cause`, the type of `causes[0]`.
 */
export function sdkFingerprint(event: WireSourceEvent): string[] {
  const exception = event.exception;
  const causes = exception?.causes?.length ? exception.causes : undefined;
  const parts: string[] = [exception?.type || "Error"];

  const inApp = (frames?: FrameLike[]): FrameLike[] => (frames ?? []).filter((f) => f.in_app === true && f.filename);
  let frames = inApp(exception?.stacktrace);
  if (!frames.length && causes) frames = inApp(causes.find((c) => inApp(c.stacktrace).length)?.stacktrace);

  if (frames.length) {
    const keys = frames.slice(0, KEY_FRAMES).map(frameKey);
    for (const k of keys) parts.push(k.key);
    if (keys.some((k) => k.minified)) parts.push(foldMessage(exception?.value ?? event.message ?? ""));
  } else {
    parts.push(foldMessage(exception?.value ?? event.message ?? ""));
  }

  if (causes) {
    let at = -1;
    for (let i = 0; i < causes.length; i++) {
      if (causes[i]!.parent === at && causes[i]!.source === "cause") at = i;
    }
    parts.push(causes[Math.max(at, 0)]!.type);
  }
  return parts;
}

/**
 * An `error` event becomes `{ type, event, group }`; any other type is returned untouched.
 *
 * `group.fingerprint` (and `event.fingerprint`) is the v2 key, {@link sdkFingerprint}. `group.legacyFingerprint` is the
 * key of every earlier SDK ({@link legacyFingerprint}, the type, the first in-app frame's `file:line` and the masked
 * message), so the platform can attach a new event to an issue that was created before v2: it falls back to
 * `legacyFingerprint` when no issue has the new key. The platform's own copy of the fingerprint, which it computes for
 * an event that carries none (an older SDK's flat event), stays the legacy rule.
 *
 * The event's own `fingerprint[]` (set in `beforeSend`) wins over the computed one, as it always did, and then no
 * `legacyFingerprint` is sent: the app's key is the app's, and the issue it names has no earlier key to carry over.
 */
export function toWireEvent<T extends { type: string }>(input: T): unknown {
  if (input.type !== "error") return input;
  const source = input as unknown as WireSourceEvent;

  const own = source.fingerprint?.length ? source.fingerprint : undefined;
  const fingerprint = own ?? sdkFingerprint(source);
  const message = source.message ?? source.exception?.value;
  const topFrame = culpritFrame(source.exception);
  const { type: _type, ...rest } = source;

  return {
    type: "error",
    event: { ...rest, message, fingerprint },
    group: {
      fingerprint,
      ...(own ? {} : { legacyFingerprint: legacyFingerprint(source) }),
      message,
      culprit: topFrame ? (topFrame.lineno != null ? `${topFrame.filename}:${topFrame.lineno}` : topFrame.filename) : undefined,
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
