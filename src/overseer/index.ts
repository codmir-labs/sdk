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

import { nanoid } from "nanoid";
import { PatchRuntime, type SelfHealingConfig } from "./patch-runtime";

// =============================================================================
// Types
// =============================================================================

export interface OverseerConfig {
  /** Data Source Name - your Codmir project endpoint (optional if clientKey is set) */
  dsn?: string;
  /** Client key for authenticating with Codmir (preferred over dsn) */
  clientKey?: string;
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
  /** Sample rate for traces/performance (0-1) */
  tracesSampleRate?: number;
  /** Sample rate for session replay (0-1) */
  replaysSessionSampleRate?: number;
  /** Sample rate for replay on error (0-1) */
  replaysOnErrorSampleRate?: number;
  /** Hook to modify/filter events before sending */
  beforeSend?: (event: OverseerEvent) => OverseerEvent | null;
  /** Initial user context */
  initialUser?: UserContext;
  /** Initial tags */
  initialTags?: Record<string, string>;
  /** Self-healing patch runtime configuration */
  selfHealing?: SelfHealingConfig;
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

export type SeverityLevel = "fatal" | "error" | "warning" | "info" | "debug";

// =============================================================================
// Core Client
// =============================================================================

type ResolvedConfig = Omit<Required<OverseerConfig>, 'initialUser' | 'selfHealing'> & {
  initialUser?: UserContext;
  selfHealing?: SelfHealingConfig;
  clientKey: string;
  secretKey: string;
};

class OverseerClient {
  private config: ResolvedConfig;
  private user: UserContext | null = null;
  private tags: Record<string, string> = {};
  private breadcrumbs: Breadcrumb[] = [];
  private eventQueue: OverseerEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private isInitialized = false;
  private conversationId: string | null = null;
  private sessionId: string | null = null;
  private patchRuntime: PatchRuntime | null = null;

  constructor(config: OverseerConfig = {}) {
    const resolvedKey = config.clientKey || config.overseerKey || "";
    const defaultIngestUrl = typeof window !== "undefined"
      ? `${window.location.origin}/api/overseer`
      : "https://codmir.com/api/overseer";

    this.config = {
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
      replaysSessionSampleRate: config.replaysSessionSampleRate ?? 0,
      replaysOnErrorSampleRate: config.replaysOnErrorSampleRate ?? 1.0,
      beforeSend: config.beforeSend || ((e) => e),
      initialUser: config.initialUser,
      initialTags: config.initialTags || {},
      selfHealing: config.selfHealing,
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

    const eventId = nanoid();
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
        stacktrace: this.parseStackTrace(err.stack),
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
      sdk: { name: "@codmir/sdk", version: "1.0.0" },
      contexts: {
        conversation: this.conversationId ? { id: this.conversationId } : undefined,
        session: this.sessionId ? { id: this.sessionId } : undefined,
      },
    };

    this.sendEvent(event);
    return eventId;
  }

  captureMessage(message: string, level: SeverityLevel = "info"): string {
    if (!this.config.enabled) return "";
    if (!this.shouldSample(this.config.sampleRate)) return "";

    const eventId = nanoid();

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
      sdk: { name: "@codmir/sdk", version: "1.0.0" },
    };

    this.sendEvent(event);
    return eventId;
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

  async flush(timeout?: number): Promise<boolean> {
    if (this.eventQueue.length === 0) return true;

    const events = [...this.eventQueue];
    this.eventQueue = [];

    try {
      await this.sendBatch(events);
      return true;
    } catch {
      // Re-queue failed events
      this.eventQueue.unshift(...events);
      return false;
    }
  }

  close(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    this.patchRuntime?.stop();
    this.flush();
  }

  // Private methods
  private shouldSample(rate: number): boolean {
    return Math.random() < rate;
  }

  private parseStackTrace(stack?: string): StackFrame[] {
    if (!stack) return [];

    return stack
      .split("\n")
      .slice(1)
      .map((line) => {
        const match = line.match(/at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)/);
        if (match) {
          return {
            function: match[1],
            filename: match[2],
            lineno: parseInt(match[3], 10),
            colno: parseInt(match[4], 10),
            in_app: !match[2].includes("node_modules"),
          };
        }
        return { function: line.trim() };
      })
      .filter((f) => f.function);
  }

  private sendEvent(event: OverseerEvent): void {
    const processed = this.config.beforeSend(event);
    if (!processed) return;

    this.eventQueue.push(processed);

    // Debounced flush
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flush(), 1000);
  }

  private async sendBatch(events: OverseerEvent[]): Promise<void> {
    if (!this.config.dsn) {
      if (this.config.debug) {
        console.log("[Overseer] No DSN configured, events:", events);
      }
      return;
    }

    const endpoint = this.config.dsn.endsWith("/ingest")
      ? this.config.dsn
      : `${this.config.dsn}/ingest`;

    const authKey = this.config.clientKey || this.config.overseerKey;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (authKey) {
      headers["x-overseer-key"] = authKey;
    }

    await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ events }),
    });
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
export { OverseerSystem } from '../agent/overseer/OverseerSystem';
