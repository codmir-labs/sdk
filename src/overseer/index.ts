/**
 * @codmir/sdk/overseer - Error Tracking & Session Replay
 *
 * API for error tracking, session replay,
 * and performance monitoring.
 *
 * @example
 * ```typescript
 * import { init, captureException } from '@codmir/sdk/overseer';
 *
 * init({
 *   dsn: 'https://www.codmir.com/api/v1/overseer',
 *   environment: 'production',
 * });
 *
 * try {
 *   riskyOperation();
 * } catch (error) {
 *   captureException(error);
 * }
 * ```
 */

import { generateId } from "../id";
import { ingestUrl } from "../endpoints";
import type { TransactionEvent } from "../tracing/types";
import { SDK_INFO } from "../version";
import { PatchRuntime, type SelfHealingConfig } from "./patch-runtime";
import { getRequestScope } from "./request-scope";
import { sanitizeExtra } from "./sanitize-extra";
import { redactSecrets } from "../logs/redact";
import { scrubEvent, scrubTags } from "./scrub-text";
import { readHint } from "./capture-hint";
import { normalizeThrown, syntheticStack, type Caller } from "./thrown-value";
import { browserRequest, envContexts } from "./runtime-context";
import { addSourceContext } from "./source-context";
import { callerOrigin, normalizeOrigins, parseStackTrace } from "./stack";
import { collectCauses } from "./causes";
import { installProcessErrors } from "./process-errors";
import { userForWire } from "./user-pii";
import { setAppRoot } from "./frame-file";
import { detectEnvironment, detectRelease } from "./detect";
import {
  DEFAULT_DSN,
  KEEPALIVE_MAX_BYTES,
  MAX_BATCH_BYTES,
  MAX_BATCH_EVENTS,
  MAX_QUEUE_SIZE,
  buildBody,
  fitEventToBytes,
  isRetryableStatus,
  requestTimeoutMs,
  readDroppedEvents,
  retryDelayMs,
  sdkFingerprint,
  utf8Bytes,
  withoutOldestBreadcrumbs,
  wireEventBytes,
  RETRY_MAX_MS,
  type WireSourceEvent,
} from "./transport";

// =============================================================================
// Types
// =============================================================================

export interface OverseerConfig {
  /** Data Source Name - your Codmir project endpoint (optional if clientKey is set) */
  dsn?: string;
  /** Client key for authenticating with Codmir (preferred over dsn) */
  clientKey?: string;
  /** Alias of `clientKey`, the name `@codmir/overseer` used; the Settings > Codmir SDK snippet uses it. `clientKey` wins if both are set. */
  apiKey?: string;
  /** Secret key for server-side authentication */
  secretKey?: string;
  /** @deprecated Use clientKey instead */
  overseerKey?: string;
  /** Environment (production, staging, development) */
  environment?: string;
  /** Release version */
  release?: string;
  /** Enable/disable SDK */
  enabled?: boolean;
  /** Enable debug logging */
  debug?: boolean;
  /** Sample rate for errors (0-1) */
  sampleRate?: number;
  /**
   * Sample rate for traces/performance (0-1). Default 0: no transactions are sent. The decision is made once
   * per trace at its root and inherited downstream through the `traceparent` sampled flag.
   */
  tracesSampleRate?: number;
  /**
   * Outgoing URLs that get a `traceparent` header, besides same-origin ones. A string matches when the full URL
   * contains it, a RegExp when it tests true against the full URL. The Codmir ingest URL never gets one.
   */
  tracePropagationTargets?: Array<string | RegExp>;
  /** Sample rate for session replay (0-1) */
  replaysSessionSampleRate?: number;
  /** Sample rate for replay on error (0-1) */
  replaysOnErrorSampleRate?: number;
  /** Service name sent in the ingest envelope (max 64 chars). */
  service?: string;
  /**
   * Hook to modify/filter events before sending. It gets copies of the event's `user`, breadcrumbs and `contexts`, so
   * editing them never reaches the app's own objects. `null` drops the event; a throw, or a result that is not an
   * event, drops it too and reports `before_send` to `onDropped`. A hook that returns a Promise is awaited, and
   * `flush()` waits for it.
   */
  beforeSend?: (event: OverseerEvent) => OverseerEvent | null | PromiseLike<OverseerEvent | null>;
  /**
   * Called when the server did not take events: a batch it refused (`status` 401 for a wrong key, say), or events it
   * dropped out of a batch it answered 200 to (`reason`, such as `payment_required`), or that the client gave up on
   * (`status` 0: the queue was full, the client was closed before the last try went through, `beforeSend` threw, or `rateLimit` held the event back, reason `rate_limited`, or an event could not be written as JSON, reason `unserializable`). They are not sent again.
   * `eventIds` are the ids `captureEvent` returned for those events, when they are known.
   */
  onDropped?: (dropped: { events: number; status: number; reason?: string; eventIds?: string[] }) => void;
  /**
   * How many `error` and `message` events leave per rolling minute: `perGroupPerMinute` (default 10) for one group,
   * the event's own `fingerprint` or else the default one, and `perMinute` (default 100) for the whole client.
   * The rest are not sent and `onDropped` hears them as `rate_limited`, at most once a second. Transactions are never
   * counted. `false` turns the limit off.
   */
  rateLimit?: { perGroupPerMinute?: number; perMinute?: number } | false;
  /**
   * Send the whole user object, and Express's client IP, with every error and message event. Default `false`: an event
   * carries only the user's `id` and `username` (and the `email` when there is no `id`, so that user is still counted),
   * and Express adds no `clientIp`. On, every key of the user is sent except one that names a secret (a password, token
   * or key). `beforeSend` sees what will be sent.
   * @default false
   */
  sendDefaultPii?: boolean;
  /**
   * Origins (`"https://static.example.com"`) whose scripts are your app's code, for a page whose bundle is served from
   * somewhere other than the page's own origin. In a browser a frame counts as app code (`in_app`, the fingerprint and
   * the culprit) only on the page's origin, the origin of the code that called `init()` or one of these; a tag
   * manager's or an extension's frames never do. It does nothing in Node or React Native.
   * @default []
   */
  inAppOrigins?: string[];
  /** Initial user context */
  initialUser?: UserContext;
  /** Initial tags */
  initialTags?: Record<string, string>;
  /** Self-healing patch runtime configuration */
  selfHealing?: SelfHealingConfig;
  /**
   * Node only: send the source lines around the first three in-app frames of an error (5 before, 5 after, each cut to
   * 240 characters; files over 1 MB are skipped). Default true in Node; the browser never sends source lines.
   */
  includeSourceContext?: boolean;
  /**
   * Node only: capture the errors that end a process, and send what is queued before it ends. An uncaught exception and
   * an unhandled rejection are captured as fatal (mechanism `onuncaughtexception` and `onunhandledrejection`, not
   * handled), the queue is flushed for 2 seconds at most, and the process then ends as it would have: exit code 1 for a
   * crash. SIGTERM and SIGINT flush the queue and, when the app has no listener of its own, end the process by that signal.
   * An app's own `uncaughtException`, `unhandledRejection` or signal listener is left to decide what happens next.
   * `close()` removes the hooks. Default `false` here, `true` in `@codmir/sdk/express`.
   */
  captureProcessErrors?: boolean;
}

export interface OverseerEvent {
  id: string;
  type: "error" | "message" | "transaction" | "replay";
  timestamp: string;
  level: "fatal" | "error" | "warning" | "info" | "debug";
  message?: string;
  exception?: ExceptionData;
  user?: UserContext;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  breadcrumbs?: Breadcrumb[];
  contexts?: Record<string, unknown>;
  request?: RequestData;
  sdk?: { name: string; version: string };
  environment?: string;
  release?: string;
  fingerprint?: string[];
}

export interface ExceptionData {
  type: string;
  value: string;
  stacktrace?: StackFrame[];
  mechanism?: { type: string; handled: boolean };
  /**
   * The errors behind this one, breadth first over `cause` and `AggregateError.errors`, at most 10 and 5 deep. Absent
   * when there is nothing to walk.
   */
  causes?: ExceptionCause[];
}

export interface ExceptionCause {
  type: string;
  value: string;
  /** At most 30 frames, never with source context. */
  stacktrace?: StackFrame[];
  /** `"cause"` or `"errors[i]"`. */
  source: string;
  /** Index in `causes` of the error this one hangs from, or -1 for the top exception. */
  parent: number;
}

export interface StackFrame {
  filename?: string;
  function?: string;
  lineno?: number;
  colno?: number;
  in_app?: boolean;
  context_line?: string;
  pre_context?: string[];
  post_context?: string[];
}

export interface UserContext {
  id?: string;
  email?: string;
  username?: string;
  ip_address?: string;
  [key: string]: unknown;
}

export interface Breadcrumb {
  type?: string;
  category?: string;
  message?: string;
  data?: Record<string, unknown>;
  level?: "fatal" | "error" | "warning" | "info" | "debug";
  timestamp?: string;
}

export interface RequestData {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  query_string?: string;
  data?: unknown;
}

/** What the transport queue holds: SDK events, and finished transactions already in their wire shape. */
export type QueuedEvent = OverseerEvent | TransactionEvent;

export type SeverityLevel = "fatal" | "error" | "warning" | "info" | "debug";

// =============================================================================
// Core Client
// =============================================================================

type ResolvedConfig = Omit<Required<OverseerConfig>, 'initialUser' | 'sendDefaultPii' | 'selfHealing' | 'apiKey' | 'includeSourceContext' | 'inAppOrigins' | 'captureProcessErrors' | 'onDropped' | 'rateLimit'> & {
  initialUser?: UserContext;
  sendDefaultPii: boolean;
  onDropped?: OverseerConfig["onDropped"];
  selfHealing?: SelfHealingConfig;
  includeSourceContext: boolean;
  inAppOrigins: string[];
  tracePropagationTargets: Array<string | RegExp>;
  clientKey: string;
  secretKey: string;
};

/** What `@codmir/sdk/replay`'s `startReplay()` registers so errors link to the replay that recorded them. */
export interface ReplayHook {
  /** The id of the replay recording now, or null. */
  getReplayId(): string | null;
  /** Called with the id of every error event captured while the hook is set. */
  onError(eventId: string): void;
}

/** What `@codmir/sdk/feedback` reads from the client. Not part of the stable API. */
export interface FeedbackContext {
  enabled: boolean;
  dsn: string;
  key: string;
  environment: string;
  release: string;
  userId: unknown;
  replayId: string | null;
  /** The last error event that was really queued: not one sampled out, dropped by `beforeSend` or captured while disabled. */
  lastError: { id: string; at: number } | null;
  breadcrumbs: readonly Breadcrumb[];
  tracePropagationTargets: Array<string | RegExp>;
}

/** Breadcrumbs kept, process-wide and per request. */
// The server keeps an error's last 20 breadcrumbs, so the SDK neither buffers nor sends more.
const MAX_BREADCRUMBS = 20;
const RATE_WINDOW_MS = 60_000;
const DEFAULT_PER_GROUP_PER_MINUTE = 10;
const DEFAULT_PER_MINUTE = 100;
/** Dropped ids kept for one `onDropped` call; the count stays exact. */
const MAX_REPORTED_IDS = 1000;
/** Above this many groups, groups with no event in the last minute are forgotten. */
const MAX_TRACKED_GROUPS = 1000;

/** True when this runtime's `fetch` takes `signal`. One from another realm (jsdom's, beside Node's fetch) makes it throw. */
function signalAccepted(signal: AbortSignal): boolean {
  if (typeof Request !== "function") return false;
  try {
    return !!new Request("http://localhost/", { signal });
  } catch {
    return false;
  }
}

/** What marks a value in the registry slot as one of this SDK's clients. A symbol, so a copy of the SDK recognises another's. */
const CLIENT_MARKER = Symbol.for("codmir.overseer.client.marker");

class OverseerClient {
  readonly [CLIENT_MARKER] = true;
  private lastError: { id: string; at: number } | null = null;
  private config: ResolvedConfig;
  private replayHook: ReplayHook | null = null;
  private user: UserContext | null = null;
  private tags: Record<string, string> = {};
  private breadcrumbs: Breadcrumb[] = [];
  private eventQueue: QueuedEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  // Bytes queued since the last send started: a full batch leaves at once.
  private queuedBytes = 0;
  private rateLimits: { perGroup: number; perMinute: number } | null;
  // Times (ms) of the events let through in the last minute, per group and in all.
  private groupSent = new Map<string, number[]>();
  private allSent: number[] = [];
  private rateDropped: { events: number; ids: string[] } | null = null;
  private rateDroppedTimer: ReturnType<typeof setTimeout> | null = null;
  private isInitialized = false;
  private conversationId: string | null = null;
  private sessionId: string | null = null;
  private patchRuntime: PatchRuntime | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  // Once closed, the client never schedules a retry.
  private closed = false;
  private flushing: Promise<boolean> | null = null;
  // True while `flushing` can still pick up events that are queued now.
  private flushOpen = false;
  // `beforeSend` hooks that returned a Promise and have not settled; `flush()` waits for them.
  private pendingHooks = new Set<Promise<void>>();
  private onPageHide = (): void => this.flushOnHide();
  private onVisibilityChange = (): void => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") this.flushOnHide();
  };

  constructor(config: OverseerConfig = {}) {
    const resolvedKey = config.clientKey || config.apiKey || config.overseerKey || "";
    // Always Codmir's own endpoint; an explicit `dsn` wins. Never the page's origin.
    const defaultIngestUrl = DEFAULT_DSN;

    this.config = {
      service: config.service || "",
      dsn: config.dsn || (resolvedKey ? defaultIngestUrl : ""),
      clientKey: resolvedKey,
      secretKey: config.secretKey || "",
      overseerKey: resolvedKey,
      environment: config.environment || detectEnvironment() || "development",
      release: config.release || detectRelease() || "unknown",
      enabled: config.enabled ?? true,
      debug: config.debug ?? false,
      sampleRate: config.sampleRate ?? 1.0,
      tracesSampleRate: config.tracesSampleRate ?? 0,
      tracePropagationTargets: config.tracePropagationTargets ?? [],
      replaysSessionSampleRate: config.replaysSessionSampleRate ?? 0,
      replaysOnErrorSampleRate: config.replaysOnErrorSampleRate ?? 1.0,
      beforeSend: config.beforeSend || ((e) => e),
      onDropped: config.onDropped,
      initialUser: config.initialUser,
      sendDefaultPii: config.sendDefaultPii === true,
      initialTags: config.initialTags || {},
      selfHealing: config.selfHealing,
      includeSourceContext: config.includeSourceContext ?? true,
      inAppOrigins: normalizeOrigins(config.inAppOrigins),
    };

    const limit = config.rateLimit;
    const count = (n: unknown, fallback: number): number => (typeof n === "number" && n >= 0 ? n : fallback);
    this.rateLimits =
      limit === false
        ? null
        : {
            perGroup: count(limit?.perGroupPerMinute, DEFAULT_PER_GROUP_PER_MINUTE),
            perMinute: count(limit?.perMinute, DEFAULT_PER_MINUTE),
          };

    if (this.config.initialUser) {
      this.user = this.config.initialUser;
    }
    if (this.config.initialTags) {
      this.tags = { ...this.config.initialTags };
    }
  }

  init(): void {
    if (this.isInitialized) return;
    this.isInitialized = true;

    // The page origin of the code that called `init()`: its frames are the app's even when the bundle sits on a CDN.
    const caller = callerOrigin(new Error().stack);
    if (caller && !this.config.inAppOrigins.includes(caller)) this.config.inAppOrigins.push(caller);
    // The app root a Node frame's path is made relative to in the group key.
    if (typeof process !== "undefined" && typeof process.cwd === "function") {
      try {
        setAppRoot(process.cwd());
      } catch {
        // a deleted working directory: no root
      }
    }

    if (this.config.debug && this.config.release === "unknown") {
      console.log(
        "[Overseer] No release: set the `release` option or the CODMIR_RELEASE environment variable, or events are sent with the release `unknown`.",
      );
    }

    if (this.config.debug) {
      console.log("[Overseer] Initialized", {
        dsn: this.config.dsn,
        environment: this.config.environment,
      });
    }

    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("pagehide", this.onPageHide);
    }
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", this.onVisibilityChange);
    }

    if (this.config.selfHealing?.enabled && this.config.dsn) {
      this.patchRuntime = new PatchRuntime({
        dsn: this.config.dsn,
        environment: this.config.environment,
        overseerKey: this.config.overseerKey,
        config: this.config.selfHealing,
      });
      this.patchRuntime.start();
    }
  }

  captureException(error: Error | unknown, context?: Record<string, unknown>): string {
    return this.captureFrom(error, context, this.captureException);
  }

  /**
   * `captureException` for a `caller` that is the function the app called (this method, or the module's own
   * `captureException`): a stack made up for a thrown value that is not an error starts at that function's caller.
   * Not part of the stable API.
   */
  captureFrom(error: Error | unknown, context: Record<string, unknown> | undefined, caller: Caller): string {
    if (!this.config.enabled) return "";
    if (!this.shouldSample(this.config.sampleRate)) return "";

    const eventId = generateId();
    // Set by an integration only (a symbol key): a caller's own `handled` or `mechanism` is plain data in `extra`.
    const hint = readHint(context);
    const err = normalizeThrown(error);
    // Kept in this function (not in a helper): the stack of an error made up for the value starts at the app's call.
    const stack = err.stack ?? syntheticStack(err.name, err.message, caller, hint?.frames);

    const causes = collectCauses(error, this.config.inAppOrigins);
    const conversationId = this.getConversationId();
    const sessionId = this.getSessionId();

    const event: OverseerEvent = {
      id: eventId,
      type: "error",
      timestamp: new Date().toISOString(),
      level: hint?.level ?? "error",
      message: err.message,
      exception: {
        type: err.name,
        value: err.message,
        stacktrace: this.stackFor(stack),
        mechanism: hint?.mechanism ?? { type: "generic", handled: true },
        ...(causes ? { causes } : {}),
      },
      user: this.userOf() || undefined,
      tags: this.tagsOf(),
      extra: {
        // No request, headers, cookies, query, params or body, whatever the caller passed.
        ...(err.thrown === undefined ? {} : sanitizeExtra({ thrown: err.thrown })),
        ...sanitizeExtra(context),
        conversationId,
        sessionId,
      },
      breadcrumbs: this.breadcrumbsOf(),
      environment: this.config.environment,
      release: this.config.release,
      sdk: { ...SDK_INFO },
      ...this.requestOf(),
      contexts: {
        ...envContexts(),
        conversation: conversationId ? { id: conversationId } : undefined,
        session: sessionId ? { id: sessionId } : undefined,
      },
    };

    this.linkReplay(event);
    this.sendEvent(event, true);
    return eventId;
  }

  captureMessage(message: string, level: SeverityLevel = "info"): string {
    if (!this.config.enabled) return "";
    if (!this.shouldSample(this.config.sampleRate)) return "";

    const eventId = generateId();

    const event: OverseerEvent = {
      id: eventId,
      type: "message",
      timestamp: new Date().toISOString(),
      level,
      message,
      user: this.userOf() || undefined,
      tags: this.tagsOf(),
      breadcrumbs: this.breadcrumbsOf(),
      environment: this.config.environment,
      release: this.config.release,
      sdk: { ...SDK_INFO },
    };

    this.sendEvent(event);
    return eventId;
  }

  /**
   * Queues an event another part of the SDK built (the log monitor's findings), on the same transport as errors:
   * batching, retry and `beforeSend` apply, `sampleRate` does not. Returns the event id, or "" when the SDK is off.
   */
  captureEvent(event: OverseerEvent): string {
    if (!this.config.enabled) return "";
    this.sendEvent({ ...event, environment: event.environment ?? this.config.environment });
    return event.id;
  }

  /** Set by `startReplay()` in `@codmir/sdk/replay`; null unlinks. Not part of the stable API. */
  setReplayHook(hook: ReplayHook | null): void {
    this.replayHook = hook;
  }

  /** What `sendFeedback()` in `@codmir/sdk/feedback` adds to a visitor's words. Not part of the stable API. */
  feedbackContext(): FeedbackContext {
    let replayId: string | null = null;
    let userId: unknown;
    try {
      replayId = this.replayHook?.getReplayId() ?? null;
    } catch {
      // a failing replay hook never breaks feedback
    }
    try {
      userId = this.userOf()?.id;
    } catch {
      // a user object with a throwing getter has no id
    }
    const { enabled, dsn, environment, release, tracePropagationTargets } = this.config;
    return {
      enabled,
      dsn,
      key: this.getOverseerKey(),
      environment,
      release,
      userId,
      replayId,
      lastError: this.lastError,
      breadcrumbs: this.breadcrumbsOf(),
      tracePropagationTargets,
    };
  }

  getReplaySampleRates(): { session: number; onError: number } {
    return { session: this.config.replaysSessionSampleRate, onError: this.config.replaysOnErrorSampleRate };
  }

  /** While a replay records, the error carries its id (`tags.replay_id` is what the server reads). */
  private linkReplay(event: OverseerEvent): void {
    const hook = this.replayHook;
    if (!hook) return;
    try {
      const replayId = hook.getReplayId();
      if (replayId) {
        event.tags = { ...event.tags, replay_id: replayId };
        event.contexts = { ...event.contexts, replay: { replay_id: replayId } };
      }
    } catch {
      // replay must never break error capture
    }
  }

  /** The replay learns of an error only once it is queued, so an error `beforeSend` drops never uploads a replay. */
  private notifyReplay(eventId: string): void {
    try {
      this.replayHook?.onError(eventId);
    } catch {
      // replay must never break error capture
    }
  }

  /** Inside a request the user is the request's own: `setUser` sets it and leaves the client's alone. */
  setUser(user: UserContext | null): void {
    const scope = getRequestScope();
    if (scope) scope.user = user;
    else this.user = user;
  }

  /** The request's user (`null`: nobody) when it has one, else the client's. */
  private userOf(): UserContext | null {
    const scope = getRequestScope();
    try {
      scope?.refreshUser?.();
    } catch {
      // a lookup that fails leaves the user as it was
    }
    const own = scope?.user;
    return own === undefined ? this.user : own;
  }

  /** The tags an event gets: the process-wide ones overlaid with the request's own, which win key by key. A copy. */
  private tagsOf(): Record<string, string> {
    return { ...this.tags, ...getRequestScope()?.tags };
  }

  /** The breadcrumbs an event gets: the process-wide ones, then the request's own, the newest 20. A copy. */
  private breadcrumbsOf(): Breadcrumb[] {
    const own = getRequestScope()?.breadcrumbs;
    return own ? [...this.breadcrumbs, ...own].slice(-MAX_BREADCRUMBS) : [...this.breadcrumbs];
  }

  /** Inside a request the tag is the request's: it never reaches another request or the process-wide tags. */
  setTag(key: string, value: string): void {
    const scope = getRequestScope();
    if (scope) scope.tags = { ...scope.tags, [key]: value };
    else this.tags[key] = value;
  }

  setTags(tags: Record<string, string>): void {
    const scope = getRequestScope();
    if (scope) scope.tags = { ...scope.tags, ...tags };
    else this.tags = { ...this.tags, ...tags };
  }

  setExtra(key: string, value: unknown): void {
    // Store in next event context
  }

  /** Inside a request the id is the request's own, and the client's is left alone. */
  setConversationId(conversationId: string | null): void {
    const scope = getRequestScope();
    if (scope) scope.conversationId = conversationId;
    else this.conversationId = conversationId;
  }

  /** The request's conversation id when it has set one, else the client's. */
  getConversationId(): string | null {
    const own = getRequestScope()?.conversationId;
    return own === undefined ? this.conversationId : own;
  }

  /** Inside a request the id is the request's own, and the client's (which a batch carries) is left alone. */
  setSessionId(sessionId: string | null): void {
    const scope = getRequestScope();
    if (scope) scope.sessionId = sessionId;
    else this.sessionId = sessionId;
  }

  /** The request's session id when it has set one, else the client's. */
  getSessionId(): string | null {
    const own = getRequestScope()?.sessionId;
    return own === undefined ? this.sessionId : own;
  }

  getDsn(): string {
    return this.config.dsn;
  }

  /** Full ingest URL events are POSTed to; empty when no DSN is configured. */
  getIngestUrl(): string {
    return this.config.dsn ? this.endpoint() : "";
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  getTracesSampleRate(): number {
    return this.config.tracesSampleRate;
  }

  getTracePropagationTargets(): Array<string | RegExp> {
    return this.config.tracePropagationTargets;
  }

  getRelease(): string {
    return this.config.release;
  }

  getTags(): Record<string, string> {
    return this.tagsOf();
  }

  /**
   * Queues a finished transaction on the same transport as errors (batching, retry, pagehide flush).
   * `beforeSend` is an error-event hook and does not see transactions. Their name and tags are scrubbed like an error's.
   */
  captureTransaction(transaction: TransactionEvent): void {
    if (!this.config.enabled) return;
    this.enqueue({
      ...transaction,
      name: redactSecrets(transaction.name),
      ...(transaction.tags ? { tags: scrubTags(transaction.tags) } : {}),
    });
  }

  getEnvironment(): string {
    return this.config.environment;
  }

  /** Inside a request the breadcrumb is the request's own; outside, the process-wide trail. The newest 20 are kept. */
  addBreadcrumb(breadcrumb: Breadcrumb): void {
    const crumb: Breadcrumb = {
      ...breadcrumb,
      ...(breadcrumb.data ? { data: sanitizeExtra(breadcrumb.data) } : {}),
      timestamp: breadcrumb.timestamp || new Date().toISOString(),
    };
    const scope = getRequestScope();
    if (scope) scope.breadcrumbs = [...(scope.breadcrumbs ?? []), crumb].slice(-MAX_BREADCRUMBS);
    else this.breadcrumbs = [...this.breadcrumbs, crumb].slice(-MAX_BREADCRUMBS);
  }

  /**
   * Like `addBreadcrumb`, except that a breadcrumb with the category, level and message of the newest one does not add
   * another: the newest one's `data.count` goes up (2 for the first repeat), so a message that repeats does not push the
   * rest of the trail out of the 20 an error keeps.
   */
  addRepeatedBreadcrumb(breadcrumb: Breadcrumb): void {
    const scope = getRequestScope();
    const trail = scope ? (scope.breadcrumbs ?? []) : this.breadcrumbs;
    const last = trail[trail.length - 1];
    if (!last || last.category !== breadcrumb.category || last.level !== breadcrumb.level || last.message !== breadcrumb.message) {
      this.addBreadcrumb(breadcrumb);
      return;
    }
    const count = typeof last.data?.count === "number" ? last.data.count + 1 : 2;
    const next = [...trail.slice(0, -1), { ...last, data: { ...last.data, count } }];
    if (scope) scope.breadcrumbs = next;
    else this.breadcrumbs = next;
  }

  /** Sends everything queued: true when all of it was sent or refused, false when a batch is put back for a retry or `timeout` ms ran out first. */
  flush(timeout?: number): Promise<boolean> {
    // A send that has looked at the queue for the last time takes nothing more: an event queued after that needs a send of its own.
    if (!this.flushing || !this.flushOpen) {
      this.flushOpen = true;
      const sending: Promise<boolean> = (this.pendingHooks.size > 0 ? this.settleHooks().then(() => this.drain()) : this.drain()).finally(() => {
        if (this.flushing === sending) this.flushing = null;
      });
      this.flushing = sending;
    }
    const sending = this.flushing;
    if (typeof timeout !== "number" || !(timeout < Infinity)) return sending;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<boolean>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, timeout), false);
      (timer as { unref?: () => void }).unref?.();
    });
    return Promise.race([sending, late]).finally(() => clearTimeout(timer));
  }

  /**
   * Stops the client and makes one last send. Resolves `true` when the queue was sent (or refused) within `timeoutMs`
   * (default 2000), `false` otherwise; it never rejects, and a caller that ignores the result is unaffected.
   */
  close(timeoutMs = 2000): Promise<boolean> {
    this.closed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.reportRateDropped();
    if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
      window.removeEventListener("pagehide", this.onPageHide);
    }
    if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
      document.removeEventListener("visibilitychange", this.onVisibilityChange);
    }
    this.patchRuntime?.stop();
    return this.flush(timeoutMs).catch((err) => {
      this.log("Flush failed:", err);
      return false;
    });
  }

  // Private methods
  private shouldSample(rate: number): boolean {
    return Math.random() < rate;
  }

  /**
   * `{ request }` from the server request in scope, else the page in a browser (origin and path), else
   * nothing: the key is absent, not undefined. Never a query string, headers or cookies.
   */
  private requestOf(): { request?: RequestData } {
    const scope = getRequestScope();
    const request = scope ? { url: scope.url, method: scope.method } : browserRequest();
    return request ? { request } : {};
  }

  private stackFor(stack?: string): StackFrame[] {
    const frames = parseStackTrace(stack, this.config.inAppOrigins);
    return this.config.includeSourceContext ? addSourceContext(frames) : frames;
  }

  /** True with `sendDefaultPii: true`: Express adds `clientIp` only then. */
  sendsDefaultPii(): boolean {
    return this.config.sendDefaultPii;
  }

  /** A copy of the event whose `user`, and `extra.user` (Express's), are cut down to what `sendDefaultPii` allows. */
  private withWireUser(event: OverseerEvent): OverseerEvent {
    if (event.type !== "error" && event.type !== "message") return event;
    const pii = this.config.sendDefaultPii;
    const out: OverseerEvent = { ...event };
    const user = userForWire(event.user, pii);
    if (user) out.user = user as UserContext;
    else delete out.user;
    const extraUser = event.extra?.user;
    if (extraUser !== undefined) {
      const reduced = userForWire(extraUser, pii);
      const extra = { ...event.extra };
      if (reduced) extra.user = reduced;
      else delete extra.user;
      out.extra = extra;
    }
    return out;
  }

  private sendEvent(raw: OverseerEvent, linkedToReplay = false): void {
    // Before the hook and before any fingerprint: the hook and the group see the user `sendDefaultPii` allows and the
    // scrubbed text.
    const event = scrubEvent(this.withWireUser(raw));
    let result: ReturnType<NonNullable<OverseerConfig["beforeSend"]>>;
    try {
      result = this.config.beforeSend(copyForHook(event));
    } catch (err) {
      this.hookFailed(event, err);
      return;
    }
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      const pending: Promise<void> = Promise.resolve(result as PromiseLike<OverseerEvent | null>)
        .then(
          (processed) => this.afterHook(event, processed, linkedToReplay),
          (err) => this.hookFailed(event, err),
        )
        .finally(() => this.pendingHooks.delete(pending));
      this.pendingHooks.add(pending);
      return;
    }
    this.afterHook(event, result as OverseerEvent | null, linkedToReplay);
  }

  /** What the hook returned: `null` is the app dropping the event on purpose; anything else that is not an event is a failed hook. */
  private afterHook(original: OverseerEvent, processed: OverseerEvent | null | undefined, linkedToReplay = false): void {
    if (processed === null || processed === undefined) return;
    if (typeof processed !== "object") {
      this.hookFailed(original, new Error("beforeSend returned something that is not an event"));
      return;
    }
    if (this.rateLimited(processed)) return;
    if (processed.type === "error") this.lastError = { id: processed.id, at: Date.now() };
    this.enqueue(processed);
    if (linkedToReplay) this.notifyReplay(typeof processed.id === "string" ? processed.id : original.id);
  }

  /** True when the event is over the limit and was dropped. Only `error` and `message` events count, and only those let through. */
  private rateLimited(event: OverseerEvent): boolean {
    const limits = this.rateLimits;
    if (!limits || (event.type !== "error" && event.type !== "message")) return false;
    const now = Date.now();
    const since = now - RATE_WINDOW_MS;
    let group: string;
    try {
      group = (event.fingerprint?.length ? event.fingerprint : sdkFingerprint(event as WireSourceEvent)).join("\u0000");
    } catch {
      // An event that cannot be fingerprinted is let through, not limited.
      return false;
    }

    const recent = (times: number[]): number[] => {
      let from = 0;
      while (from < times.length && times[from] <= since) from++;
      if (from > 0) times.splice(0, from);
      return times;
    };
    const times = recent(this.groupSent.get(group) ?? []);
    if (times.length >= limits.perGroup || recent(this.allSent).length >= limits.perMinute) {
      this.log(`Rate limit: dropped an event of group "${group.split("\u0000").join(" | ")}"`);
      this.noteRateDropped(event.id);
      return true;
    }
    times.push(now);
    this.allSent.push(now);
    this.groupSent.set(group, times);
    if (this.groupSent.size > MAX_TRACKED_GROUPS) {
      for (const [key, list] of this.groupSent) if (recent(list).length === 0) this.groupSent.delete(key);
    }
    return false;
  }

  /** Collects dropped events so `onDropped` hears them in one call a second, not one per event. */
  private noteRateDropped(id: string): void {
    const pending = (this.rateDropped ??= { events: 0, ids: [] });
    pending.events++;
    if (id && pending.ids.length < MAX_REPORTED_IDS) pending.ids.push(id);
    if (this.closed) {
      this.reportRateDropped();
      return;
    }
    if (this.rateDroppedTimer) return;
    this.rateDroppedTimer = setTimeout(() => this.reportRateDropped(), 1000);
    (this.rateDroppedTimer as { unref?: () => void }).unref?.();
  }

  private reportRateDropped(): void {
    if (this.rateDroppedTimer) {
      clearTimeout(this.rateDroppedTimer);
      this.rateDroppedTimer = null;
    }
    const pending = this.rateDropped;
    if (!pending) return;
    this.rateDropped = null;
    this.tellDropped(pending.events, 0, "rate_limited", pending.ids.map((id) => ({ id })));
  }

  /** A failed hook drops the event: it may have been half way through scrubbing it. */
  private hookFailed(event: OverseerEvent, err: unknown): void {
    this.log("beforeSend failed; dropping the event:", err);
    this.tellDropped(1, 0, "before_send", [event]);
  }

  private async settleHooks(): Promise<void> {
    while (this.pendingHooks.size > 0) await Promise.allSettled([...this.pendingHooks]);
  }

  private enqueue(event: QueuedEvent): void {
    this.eventQueue.push(event);
    try {
      this.queuedBytes += wireEventBytes(event) + 1;
    } catch {
      // An event that cannot be serialized counts as 0 bytes; the send path meets it as before.
    }
    this.trimQueue();

    // A pending retry will pick this event up; flushing now would skip its backoff.
    if (this.retryTimer) return;

    // A full batch leaves at once.
    if (this.eventQueue.length >= MAX_BATCH_EVENTS || this.queuedBytes >= MAX_BATCH_BYTES) {
      this.flushQuietly();
      return;
    }

    // The timer is never pushed back: events leave at most 1 s after the first one waiting.
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flushQuietly(), 1000);
  }

  /** A flush nobody awaits: a failure is logged, never an unhandled rejection. */
  private flushQuietly(): void {
    this.flush().catch((err) => this.log("Flush failed:", err));
  }

  private log(...args: unknown[]): void {
    if (this.config.debug) console.log("[Overseer]", ...args);
  }

  /** Keeps the queue at MAX_QUEUE_SIZE by dropping the oldest events. */
  private trimQueue(): void {
    const excess = this.eventQueue.length - MAX_QUEUE_SIZE;
    if (excess > 0) {
      const lost = this.eventQueue.splice(0, excess);
      this.log(`Queue full (${MAX_QUEUE_SIZE}); dropped ${excess} oldest event(s)`);
      this.tellDropped(excess, 0, "queue_full", lost);
    }
  }

  private async drain(): Promise<boolean> {
    this.queuedBytes = 0;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    // Lowered when the server answers 413 to a batch: the halves go out first and the rest of this drain stays small.
    let maxEvents = MAX_BATCH_EVENTS;
    const retriedSmaller = new WeakSet<object>();
    while (this.eventQueue.length > 0) {
      const batch = this.takeBatch(maxEvents);
      if (batch.length === 0) continue; // everything it looked at was too large and has been dropped
      const outcome = await this.sendBatch(batch);
      if (outcome.kind === "too_large") {
        if (batch.length > 1) {
          maxEvents = Math.ceil(batch.length / 2);
          this.eventQueue.unshift(...batch);
          continue;
        }
        const [event] = batch;
        const crumbs = (event as { breadcrumbs?: unknown[] }).breadcrumbs;
        const smaller = retriedSmaller.has(event) ? null : withoutOldestBreadcrumbs(event, Math.ceil((crumbs?.length ?? 0) / 2));
        if (smaller) {
          retriedSmaller.add(smaller);
          this.eventQueue.unshift(smaller);
        } else {
          this.log("Server refused a single event as too large; dropping it");
          this.tellDropped(1, 413, "too_large", batch);
        }
        continue;
      }
      if (outcome.kind === "ok") {
        this.retryAttempt = 0;
        continue;
      }
      if (outcome.kind === "drop") continue;

      if (this.closed) {
        // close() makes one last attempt; a failure then is final.
        this.tellDropped(batch.length, 0, "closed", batch);
        this.flushOpen = false;
        return false;
      }
      this.eventQueue.unshift(...batch);
      this.trimQueue();
      this.scheduleRetry(outcome.retryAfterMs);
      this.flushOpen = false;
      return false;
    }
    this.flushOpen = false;
    return true;
  }

  /**
   * Takes the next request's events off the queue: up to `maxEvents`, and while the body stays within
   * MAX_BATCH_BYTES. Always one event at least; one that cannot fit alone loses breadcrumbs, or is dropped.
   */
  private takeBatch(maxEvents: number): QueuedEvent[] {
    const base = utf8Bytes(this.body([]));
    let bytes = base;
    const batch: QueuedEvent[] = [];
    while (this.eventQueue.length > 0 && batch.length < maxEvents) {
      let event = this.eventQueue[0];
      let size: number;
      try {
        size = wireEventBytes(event);
      } catch (err) {
        this.eventQueue.shift();
        this.unserializable(event, err);
        continue;
      }
      if (base + size > MAX_BATCH_BYTES) {
        const fitted = fitEventToBytes(event, MAX_BATCH_BYTES - base);
        if (!fitted) {
          this.eventQueue.shift();
          this.log("Event is over the size cap with no breadcrumbs left; dropping it");
          this.tellDropped(1, 0, "too_large", [event]);
          continue;
        }
        event = fitted;
        size = wireEventBytes(fitted);
        this.eventQueue[0] = fitted;
      }
      const added = size + (batch.length > 0 ? 1 : 0);
      if (batch.length > 0 && bytes + added > MAX_BATCH_BYTES) break;
      this.eventQueue.shift();
      batch.push(event);
      bytes += added;
    }
    return batch;
  }

  /** An event that cannot be written as JSON (a `toJSON` or getter that throws) can never be sent: the caller has removed it. */
  private unserializable(event: QueuedEvent, err: unknown): void {
    this.log("Event cannot be serialized; dropping it:", err);
    this.tellDropped(1, 0, "unserializable", [event]);
  }

  private scheduleRetry(retryAfterMs?: number): void {
    // close() makes one last attempt; a failure then is final, or a closed client would keep posting with backoff.
    if (this.closed) return;
    const delay = Math.min(RETRY_MAX_MS, Math.max(retryDelayMs(this.retryAttempt), retryAfterMs ?? 0));
    this.retryAttempt++;
    this.log(`Send failed; retrying in ${delay}ms (attempt ${this.retryAttempt})`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.flushQuietly();
    }, delay);
    // Do not keep a Node process alive just to retry telemetry.
    (this.retryTimer as { unref?: () => void }).unref?.();
  }

  private endpoint(): string {
    return ingestUrl(this.config.dsn);
  }

  private requestHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const authKey = this.config.clientKey || this.config.overseerKey;
    if (authKey) headers["x-overseer-key"] = authKey;
    return headers;
  }

  private body(events: QueuedEvent[]): string {
    return buildBody(events, {
      service: this.config.service,
      environment: this.config.environment,
      release: this.config.release,
      // The client's own, never a request's: a batch holds events of many requests, and each carries its own in `contexts.session`.
      sessionId: this.sessionId,
    });
  }

  private tellDropped(events: number, status: number, reason?: unknown, which?: ReadonlyArray<object | undefined>): void {
    const eventIds = which?.flatMap((e) => ((e as { id?: string } | undefined)?.id ? [(e as { id: string }).id] : []));
    try {
      this.config.onDropped?.({ events, status, ...(typeof reason === "string" ? { reason } : {}), ...(eventIds?.length ? { eventIds } : {}) });
    } catch {
      // the app's hook never breaks the sending
    }
  }

  private async sendBatch(
    events: QueuedEvent[],
  ): Promise<{ kind: "ok" } | { kind: "drop" } | { kind: "too_large" } | { kind: "retry"; retryAfterMs?: number }> {
    if (!this.config.dsn) {
      this.log("No DSN configured, events:", events);
      return { kind: "ok" };
    }

    // A request that never answers is given up on and retried, so it cannot hold back every later flush. The race frees
    // the queue in every runtime; the signal, where this runtime's fetch takes it, also frees the socket.
    const limit = requestTimeoutMs();
    const abort = typeof AbortController === "function" ? new AbortController() : null;
    const signal = abort && signalAccepted(abort.signal) ? abort.signal : undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<{ kind: "retry" }>((resolve) => {
      deadline = setTimeout(() => {
        this.log(`No answer in ${limit} ms; retrying`);
        resolve({ kind: "retry" });
        abort?.abort();
      }, limit);
      // Never keep a Node process alive for a request that may not answer.
      (deadline as { unref?: () => void }).unref?.();
    });
    try {
      return await Promise.race([this.sendBatchOnce(events, signal), timedOut]);
    } finally {
      clearTimeout(deadline);
    }
  }

  private async sendBatchOnce(
    events: QueuedEvent[],
    signal: AbortSignal | undefined,
  ): Promise<{ kind: "ok" } | { kind: "drop" } | { kind: "too_large" } | { kind: "retry"; retryAfterMs?: number }> {
    let res: Response;
    try {
      res = await fetch(this.endpoint(), {
        method: "POST",
        headers: this.requestHeaders(),
        body: this.body(events),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      this.log("Network error:", err);
      return { kind: "retry" };
    }

    if (res.ok) {
      if (this.config.debug || this.config.onDropped) {
        const dropped = await readDroppedEvents(res);
        if (dropped.length > 0) {
          this.log("Server dropped events:", dropped);
          this.tellDropped(dropped.length, res.status, dropped[0]?.reason, dropped.map((d) => events[d?.index]));
        }
      }
      return { kind: "ok" };
    }

    if (res.status === 413) {
      this.log(`Server refused a batch of ${events.length} event(s) as too large`);
      return { kind: "too_large" };
    }
    if (!isRetryableStatus(res.status)) {
      this.log(`Server rejected a batch of ${events.length} event(s) with ${res.status}; not retrying`);
      this.tellDropped(events.length, res.status, undefined, events);
      return { kind: "drop" };
    }
    const retryAfter = Number(res.headers?.get?.("retry-after"));
    return { kind: "retry", retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined };
  }

  /**
   * Page is going away or hidden: send what is queued with `keepalive` so the request outlives the page.
   * `sendBeacon` is not used: it cannot set the `x-overseer-key` header, and the ingest route reads the
   * telemetry key only from that header or `Authorization`, so a beacon would arrive unkeyed and have its errors dropped.
   */
  private flushOnHide(): void {
    if (!this.config.dsn || this.eventQueue.length === 0 || typeof fetch !== "function") return;
    this.queuedBytes = 0;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    while (this.eventQueue.length > 0) {
      let size = 300;
      let n = 0;
      while (n < this.eventQueue.length && n < MAX_BATCH_EVENTS) {
        let bytes: number;
        try {
          bytes = wireEventBytes(this.eventQueue[n]);
        } catch (err) {
          this.unserializable(this.eventQueue.splice(n, 1)[0], err);
          continue;
        }
        size += bytes + 1;
        if (n > 0 && size > KEEPALIVE_MAX_BYTES) break;
        n++;
      }
      const batch = this.eventQueue.splice(0, n);
      fetch(this.endpoint(), {
        method: "POST",
        headers: this.requestHeaders(),
        body: this.body(batch),
        keepalive: true,
      })
        .then((res) => {
          if (!res.ok && isRetryableStatus(res.status)) this.requeue(batch);
        })
        .catch(() => this.requeue(batch));
    }
  }

  private requeue(batch: QueuedEvent[]): void {
    this.eventQueue.unshift(...batch);
    this.trimQueue();
  }

  getClientKey(): string {
    return this.config.clientKey;
  }

  getOverseerKey(): string {
    return this.config.clientKey || this.config.overseerKey;
  }
}

// =============================================================================
// Singleton & Exports
// =============================================================================

let client: OverseerClient | null = null;

/** Where `init()` leaves the client for another copy of this module: `getClient()` of a sibling entry. */
const CLIENT_SLOT = Symbol.for("codmir.overseer.client");

const slots = globalThis as Record<symbol, unknown>;

/** The slot's value when it is one of this SDK's clients, else null: a foreign value there is no client. */
function slotClient(): OverseerClient | null {
  const value = slots[CLIENT_SLOT] as Partial<OverseerClient> | null | undefined;
  if (typeof value !== "object" || value === null) return null;
  if (typeof value.captureException !== "function" || (value as Record<symbol, unknown>)[CLIENT_MARKER] !== true) return null;
  return value as OverseerClient;
}

/** Ends the process hooks `captureProcessErrors` installed; null when none are. */
let stopProcessErrors: (() => void) | null = null;

export function init(config: OverseerConfig = {}): void {
  // The client being replaced stops here: its timers, retries, listeners and runtime patches.
  stopProcessErrors?.();
  stopProcessErrors = null;
  void client?.close();
  client = new OverseerClient(config);
  client.init();
  if (config.captureProcessErrors === true) {
    stopProcessErrors = installProcessErrors({
      capture: (error, context) => captureException(error, context),
      flush: (timeoutMs) => flush(timeoutMs),
    });
  }
  // The slot lets `@codmir/sdk/feedback` and `@codmir/sdk/logs` find the client without importing this module.
  slots[CLIENT_SLOT] = client;
}

/**
 * This copy's own client, else the one another copy of the module left in the slot. A bundler may load the SDK once
 * per server layer (Next.js: instrumentation, each route), and only the copy that ran `init` has a client of its own.
 */
export function getClient(): OverseerClient | null {
  return client ?? slotClient();
}

export function captureException(error: Error | unknown, context?: Record<string, unknown>): string {
  return getClient()?.captureFrom(error, context, captureException) || "";
}

export function captureMessage(message: string, level?: SeverityLevel): string {
  return getClient()?.captureMessage(message, level) || "";
}

export function setUser(user: UserContext | null): void {
  getClient()?.setUser(user);
}

export function setTag(key: string, value: string): void {
  getClient()?.setTag(key, value);
}

export function setTags(tags: Record<string, string>): void {
  getClient()?.setTags(tags);
}

export function addBreadcrumb(breadcrumb: Breadcrumb): void {
  getClient()?.addBreadcrumb(breadcrumb);
}

/** `addBreadcrumb`, except that a repeat of the newest breadcrumb raises its `data.count` instead of adding one. */
export function addRepeatedBreadcrumb(breadcrumb: Breadcrumb): void {
  getClient()?.addRepeatedBreadcrumb(breadcrumb);
}

export function flush(timeout?: number): Promise<boolean> {
  return getClient()?.flush(timeout) || Promise.resolve(true);
}

/**
 * Closes this copy's own client and empties the slot when it holds that client; another copy's client is left alone.
 * Removes the hooks `captureProcessErrors` installed. Resolves `true` when the queue was sent within `timeoutMs`
 * (default 2000), `false` otherwise, so a shutdown hook can wait for it; a caller that ignores the result is unaffected.
 */
export function close(timeoutMs?: number): Promise<boolean> {
  stopProcessErrors?.();
  stopProcessErrors = null;
  const sent = client ? client.close(timeoutMs) : Promise.resolve(true);
  if (client && slots[CLIENT_SLOT] === client) delete slots[CLIENT_SLOT];
  return sent;
}

export function setConversationId(conversationId: string | null): void {
  getClient()?.setConversationId(conversationId);
}

export function getConversationId(): string | null {
  return getClient()?.getConversationId() || null;
}

export function setSessionId(sessionId: string | null): void {
  getClient()?.setSessionId(sessionId);
}

export function getSessionId(): string | null {
  return getClient()?.getSessionId() || null;
}

export function getDsn(): string {
  return getClient()?.getDsn() || "";
}

export function getEnvironment(): string {
  return getClient()?.getEnvironment() || "development";
}

/** True when the client was started with `sendDefaultPii: true`. */
export function sendsDefaultPii(): boolean {
  return getClient()?.sendsDefaultPii() ?? false;
}

export function getClientKey(): string {
  return getClient()?.getClientKey() || "";
}

export function getOverseerKey(): string {
  return getClient()?.getOverseerKey() || "";
}

export { OverseerClient };
export { PatchRuntime } from "./patch-runtime";
export type { SelfHealingConfig, PatchManifest, PatchEntry, PatchOp } from "./patch-runtime";

/** The event as `beforeSend` sees it: its own copies of `user`, each breadcrumb and its `data`, and `contexts`, so edits never reach the app's objects or the shared breadcrumb buffer. */
function copyForHook(event: OverseerEvent): OverseerEvent {
  const copy: OverseerEvent = { ...event };
  if (event.user) copy.user = { ...event.user };
  if (event.breadcrumbs) copy.breadcrumbs = event.breadcrumbs.map((b) => ({ ...b, ...(b.data ? { data: { ...b.data } } : {}) }));
  if (event.contexts) {
    copy.contexts = Object.fromEntries(
      Object.entries(event.contexts).map(([k, v]) => [k, v && typeof v === "object" && !Array.isArray(v) ? { ...(v as object) } : v]),
    );
  }
  return copy;
}
