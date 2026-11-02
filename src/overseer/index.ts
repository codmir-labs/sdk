/**
 * @codmir/sdk/overseer - Error Tracking & Session Replay
 *
 * Sentry-compatible API for error tracking, session replay,
 * and performance monitoring.
 *
 * @example
 * ```typescript
 * import { init, captureException } from '@codmir/sdk/overseer';
 *
 * init({
 *   dsn: 'https://your-project.codmir.com/api/overseer',
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
import type { TransactionEvent } from "../tracing/types";
import { SDK_INFO } from "../version";
import { PatchRuntime, type SelfHealingConfig } from "./patch-runtime";
import { getRequestScope } from "./request-scope";
import { browserRequest, envContexts } from "./runtime-context";
import { addSourceContext } from "./source-context";
import { parseStackTrace } from "./stack";
import {
  DEFAULT_DSN,
  KEEPALIVE_MAX_BYTES,
  MAX_BATCH_EVENTS,
  MAX_QUEUE_SIZE,
  buildBody,
  isRetryableStatus,
  readDroppedEvents,
  retryDelayMs,
  toWireEvent,
  RETRY_MAX_MS,
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
  /** Hook to modify/filter events before sending */
  beforeSend?: (event: OverseerEvent) => OverseerEvent | null;
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

type ResolvedConfig = Omit<Required<OverseerConfig>, 'initialUser' | 'selfHealing' | 'apiKey' | 'includeSourceContext'> & {
  initialUser?: UserContext;
  selfHealing?: SelfHealingConfig;
  includeSourceContext: boolean;
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

class OverseerClient {
  private config: ResolvedConfig;
  private replayHook: ReplayHook | null = null;
  private user: UserContext | null = null;
  private tags: Record<string, string> = {};
  private breadcrumbs: Breadcrumb[] = [];
  private eventQueue: QueuedEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private isInitialized = false;
  private conversationId: string | null = null;
  private sessionId: string | null = null;
  private patchRuntime: PatchRuntime | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private flushing: Promise<boolean> | null = null;
  private onPageHide = (): void => this.flushOnHide();
  private onVisibilityChange = (): void => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") this.flushOnHide();
  };

  constructor(config: OverseerConfig = {}) {
    const resolvedKey = config.clientKey || config.apiKey || config.overseerKey || "";
    // Always Codmir's own endpoint; an explicit `dsn` wins. Never the page's origin (CSL-5492).
    const defaultIngestUrl = DEFAULT_DSN;

    this.config = {
      service: config.service || "",
      dsn: config.dsn || (resolvedKey ? defaultIngestUrl : ""),
      clientKey: resolvedKey,
      secretKey: config.secretKey || "",
      overseerKey: resolvedKey,
      environment: config.environment || "development",
      release: config.release || "unknown",
      enabled: config.enabled ?? true,
      debug: config.debug ?? false,
      sampleRate: config.sampleRate ?? 1.0,
      tracesSampleRate: config.tracesSampleRate ?? 0,
      tracePropagationTargets: config.tracePropagationTargets ?? [],
      replaysSessionSampleRate: config.replaysSessionSampleRate ?? 0,
      replaysOnErrorSampleRate: config.replaysOnErrorSampleRate ?? 1.0,
      beforeSend: config.beforeSend || ((e) => e),
      initialUser: config.initialUser,
      initialTags: config.initialTags || {},
      selfHealing: config.selfHealing,
      includeSourceContext: config.includeSourceContext ?? true,
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
    if (!this.config.enabled) return "";
    if (!this.shouldSample(this.config.sampleRate)) return "";

    const eventId = generateId();
    const err = error instanceof Error ? error : new Error(String(error));

    const event: OverseerEvent = {
      id: eventId,
      type: "error",
      timestamp: new Date().toISOString(),
      level: "error",
      message: err.message,
      exception: {
        type: err.name,
        value: err.message,
        stacktrace: this.stackFor(err.stack),
        mechanism: { type: "generic", handled: true },
      },
      user: this.user || undefined,
      tags: { ...this.tags },
      extra: {
        ...context,
        conversationId: this.conversationId,
        sessionId: this.sessionId,
      },
      breadcrumbs: [...this.breadcrumbs],
      environment: this.config.environment,
      release: this.config.release,
      sdk: { ...SDK_INFO },
      ...this.requestOf(),
      contexts: {
        ...envContexts(),
        conversation: this.conversationId ? { id: this.conversationId } : undefined,
        session: this.sessionId ? { id: this.sessionId } : undefined,
      },
    };

    this.linkReplay(event);
    this.sendEvent(event);
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
      user: this.user || undefined,
      tags: { ...this.tags },
      breadcrumbs: [...this.breadcrumbs],
      environment: this.config.environment,
      release: this.config.release,
      sdk: { ...SDK_INFO },
    };

    this.sendEvent(event);
    return eventId;
  }

  /** Set by `startReplay()` in `@codmir/sdk/replay`; null unlinks. Not part of the stable API. */
  setReplayHook(hook: ReplayHook | null): void {
    this.replayHook = hook;
  }

  getReplaySampleRates(): { session: number; onError: number } {
    return { session: this.config.replaysSessionSampleRate, onError: this.config.replaysOnErrorSampleRate };
  }

  /** While a replay records, the error carries its id (`tags.replay_id` is what the server reads) and the replay learns the error id. */
  private linkReplay(event: OverseerEvent): void {
    const hook = this.replayHook;
    if (!hook) return;
    try {
      const replayId = hook.getReplayId();
      if (replayId) {
        event.tags = { ...event.tags, replay_id: replayId };
        event.contexts = { ...event.contexts, replay: { replay_id: replayId } };
      }
      hook.onError(event.id);
    } catch {
      // replay must never break error capture
    }
  }

  setUser(user: UserContext | null): void {
    this.user = user;
  }

  setTag(key: string, value: string): void {
    this.tags[key] = value;
  }

  setTags(tags: Record<string, string>): void {
    this.tags = { ...this.tags, ...tags };
  }

  setExtra(key: string, value: unknown): void {
    // Store in next event context
  }

  setConversationId(conversationId: string | null): void {
    this.conversationId = conversationId;
  }

  getConversationId(): string | null {
    return this.conversationId;
  }

  setSessionId(sessionId: string | null): void {
    this.sessionId = sessionId;
  }

  getSessionId(): string | null {
    return this.sessionId;
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
    return { ...this.tags };
  }

  /**
   * Queues a finished transaction on the same transport as errors (batching, retry, pagehide flush).
   * `beforeSend` is an error-event hook and does not see transactions.
   */
  captureTransaction(transaction: TransactionEvent): void {
    if (!this.config.enabled) return;
    this.enqueue(transaction);
  }

  getEnvironment(): string {
    return this.config.environment;
  }

  addBreadcrumb(breadcrumb: Breadcrumb): void {
    this.breadcrumbs.push({
      ...breadcrumb,
      timestamp: breadcrumb.timestamp || new Date().toISOString(),
    });

    // Keep last 100 breadcrumbs
    if (this.breadcrumbs.length > 100) {
      this.breadcrumbs = this.breadcrumbs.slice(-100);
    }
  }

  /** Sends everything queued. Resolves false when a batch failed and was re-queued for a retry. */
  flush(_timeout?: number): Promise<boolean> {
    if (this.flushing) return this.flushing;
    this.flushing = this.drain().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  close(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
      window.removeEventListener("pagehide", this.onPageHide);
    }
    if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
      document.removeEventListener("visibilitychange", this.onVisibilityChange);
    }
    this.patchRuntime?.stop();
    void this.flush();
  }

  // Private methods
  private shouldSample(rate: number): boolean {
    return Math.random() < rate;
  }

  /**
   * `{ request }` from the server request in scope (CSL-5637), else the page in a browser (origin and path), else
   * nothing: the key is absent, not undefined. Never a query string, headers or cookies.
   */
  private requestOf(): { request?: RequestData } {
    const scope = getRequestScope();
    const request = scope ? { url: scope.url, method: scope.method } : browserRequest();
    return request ? { request } : {};
  }

  private stackFor(stack?: string): StackFrame[] {
    const frames = parseStackTrace(stack);
    return this.config.includeSourceContext ? addSourceContext(frames) : frames;
  }

  private sendEvent(event: OverseerEvent): void {
    const processed = this.config.beforeSend(event);
    if (!processed) return;
    this.enqueue(processed);
  }

  private enqueue(event: QueuedEvent): void {
    this.eventQueue.push(event);
    this.trimQueue();

    // A pending retry will pick this event up; flushing now would skip its backoff.
    if (this.retryTimer) return;

    // Debounced flush
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => void this.flush(), 1000);
  }

  private log(...args: unknown[]): void {
    if (this.config.debug) console.log("[Overseer]", ...args);
  }

  /** Keeps the queue at MAX_QUEUE_SIZE by dropping the oldest events. */
  private trimQueue(): void {
    const excess = this.eventQueue.length - MAX_QUEUE_SIZE;
    if (excess > 0) {
      this.eventQueue.splice(0, excess);
      this.log(`Queue full (${MAX_QUEUE_SIZE}); dropped ${excess} oldest event(s)`);
    }
  }

  private async drain(): Promise<boolean> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    while (this.eventQueue.length > 0) {
      const batch = this.eventQueue.splice(0, MAX_BATCH_EVENTS);
      const outcome = await this.sendBatch(batch);
      if (outcome.kind === "ok") {
        this.retryAttempt = 0;
        continue;
      }
      if (outcome.kind === "drop") continue;

      this.eventQueue.unshift(...batch);
      this.trimQueue();
      this.scheduleRetry(outcome.retryAfterMs);
      return false;
    }
    return true;
  }

  private scheduleRetry(retryAfterMs?: number): void {
    const delay = Math.min(RETRY_MAX_MS, Math.max(retryDelayMs(this.retryAttempt), retryAfterMs ?? 0));
    this.retryAttempt++;
    this.log(`Send failed; retrying in ${delay}ms (attempt ${this.retryAttempt})`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.flush();
    }, delay);
    // Do not keep a Node process alive just to retry telemetry.
    (this.retryTimer as { unref?: () => void }).unref?.();
  }

  private endpoint(): string {
    return this.config.dsn.endsWith("/ingest") ? this.config.dsn : `${this.config.dsn}/ingest`;
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
      sessionId: this.sessionId,
    });
  }

  private async sendBatch(
    events: QueuedEvent[],
  ): Promise<{ kind: "ok" } | { kind: "drop" } | { kind: "retry"; retryAfterMs?: number }> {
    if (!this.config.dsn) {
      this.log("No DSN configured, events:", events);
      return { kind: "ok" };
    }

    let res: Response;
    try {
      res = await fetch(this.endpoint(), {
        method: "POST",
        headers: this.requestHeaders(),
        body: this.body(events),
      });
    } catch (err) {
      this.log("Network error:", err);
      return { kind: "retry" };
    }

    if (res.ok) {
      if (this.config.debug) {
        const dropped = await readDroppedEvents(res);
        if (dropped.length > 0) this.log("Server dropped events:", dropped);
      }
      return { kind: "ok" };
    }

    if (!isRetryableStatus(res.status)) {
      this.log(`Server rejected a batch of ${events.length} event(s) with ${res.status}; not retrying`);
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
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    while (this.eventQueue.length > 0) {
      let size = 300;
      let n = 0;
      while (n < this.eventQueue.length && n < MAX_BATCH_EVENTS) {
        size += JSON.stringify(toWireEvent(this.eventQueue[n])).length + 1;
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

export function init(config: OverseerConfig = {}): void {
  client = new OverseerClient(config);
  client.init();
}

export function getClient(): OverseerClient | null {
  return client;
}

export function captureException(error: Error | unknown, context?: Record<string, unknown>): string {
  return client?.captureException(error, context) || "";
}

export function captureMessage(message: string, level?: SeverityLevel): string {
  return client?.captureMessage(message, level) || "";
}

export function setUser(user: UserContext | null): void {
  client?.setUser(user);
}

export function setTag(key: string, value: string): void {
  client?.setTag(key, value);
}

export function setTags(tags: Record<string, string>): void {
  client?.setTags(tags);
}

export function addBreadcrumb(breadcrumb: Breadcrumb): void {
  client?.addBreadcrumb(breadcrumb);
}

export function flush(timeout?: number): Promise<boolean> {
  return client?.flush(timeout) || Promise.resolve(true);
}

export function close(): void {
  client?.close();
}

export function setConversationId(conversationId: string | null): void {
  client?.setConversationId(conversationId);
}

export function getConversationId(): string | null {
  return client?.getConversationId() || null;
}

export function setSessionId(sessionId: string | null): void {
  client?.setSessionId(sessionId);
}

export function getSessionId(): string | null {
  return client?.getSessionId() || null;
}

export function getDsn(): string {
  return client?.getDsn() || "";
}

export function getEnvironment(): string {
  return client?.getEnvironment() || "development";
}

export function getClientKey(): string {
  return client?.getClientKey() || "";
}

export function getOverseerKey(): string {
  return client?.getOverseerKey() || "";
}

export { OverseerClient };
export { PatchRuntime } from "./patch-runtime";
export type { SelfHealingConfig, PatchManifest, PatchEntry, PatchOp } from "./patch-runtime";
