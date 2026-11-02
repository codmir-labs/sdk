/**
 * @codmir/sdk/replay - Session Replay
 *
 * Records the page with rrweb (loaded lazily, only by this entry), masks inputs by default, and uploads
 * segments to Codmir (CSL-5612). Wire contract: `ReplaySegmentUploadSchema` in platform-v2 `@codmir/types`.
 *
 * Two ways in:
 * - `startReplay()` after `init()`: reads the client's `replaysSessionSampleRate` (default 0) and
 *   `replaysOnErrorSampleRate` (default 1), uploads to the client's DSN with its key, and links every error
 *   event to the replay (`tags.replay_id`).
 * - `new ReplayRecorder({ upload })` for full control.
 *
 * A sampled session uploads a segment every 30 s or 5,000 events. Otherwise, with the on-error rate hit, the
 * last 30-60 s are kept in memory and uploaded, plus the next 30 s, when `captureException` runs. Both rates
 * 0 records nothing and never loads rrweb.
 *
 * @example
 * ```typescript
 * import { init } from '@codmir/sdk/browser';
 * import { startReplay } from '@codmir/sdk/replay';
 *
 * init({ clientKey: 'osk_...', replaysOnErrorSampleRate: 1 });
 * startReplay();
 * ```
 *
 * Privacy: every input is masked, `[data-private]` / `.private` text is masked, `[data-codmir-block]`
 * subtrees are not recorded, and a password field is masked whatever the config says.
 */

import { nanoid } from "nanoid";
import { getClient } from "../overseer/index";
import {
  resolvePrivacy,
  toRrwebPrivacy,
  type ReplayPrivacyConfig,
} from "./privacy";
import {
  buildSegmentBody,
  chunkEvents,
  postSegment,
  replayEndpoint,
  type RrwebEvent,
  type UploadTarget,
} from "./upload";

export { DEFAULT_PRIVACY, toRrwebPrivacy, type ReplayPrivacyConfig } from "./privacy";
export { buildSegmentBody, chunkEvents, replayEndpoint, type RrwebEvent, type SegmentUploadBody, type UploadTarget } from "./upload";

// =============================================================================
// Types
// =============================================================================

export interface ReplaySession {
  id: string;
  userId?: string;
  startedAt: Date;
  endedAt?: Date;
  duration: number;
  url: string;
  userAgent: string;
  viewport: { width: number; height: number };
  /** @deprecated Always empty; events live in the segments that were uploaded. */
  events: ReplayEvent[];
  errorIds: string[];
  /** Metadata of the segments emitted so far. Their `events` are not retained once uploaded. */
  segments: ReplaySegment[];
  tags: Record<string, string>;
}

export interface ReplaySegment {
  id: string;
  /** The replay id. */
  sessionId: string;
  /** 0-based, increasing per replay. */
  sequenceNumber: number;
  /** Epoch milliseconds of the first event. (Milliseconds since session start before 2.2.) */
  startTime: number;
  /** Epoch milliseconds of the last event. */
  endTime: number;
  /** rrweb events. Empty on the copies kept in `ReplaySession.segments`. */
  events: RrwebEvent[];
  /** Ids of the errors captured while this segment recorded. */
  errorIds?: string[];
  compressed?: boolean;
}

/** @deprecated The hand-written recorder's event types. Segments now carry rrweb events (`RrwebEvent`). */
export type ReplayEvent =
  | DOMSnapshotEvent
  | DOMIncrementalEvent
  | MouseEvent
  | ScrollEvent
  | InputEvent
  | ViewportEvent
  | ConsoleEvent
  | NetworkEvent
  | CustomEvent;

interface BaseReplayEvent {
  timestamp: number;
  type: string;
}

/** @deprecated */
export interface DOMSnapshotEvent extends BaseReplayEvent {
  type: "dom_snapshot";
  data: { html: string; baseUrl: string; doctype?: string };
}

/** @deprecated */
export interface DOMIncrementalEvent extends BaseReplayEvent {
  type: "dom_incremental";
  data: { mutations: DOMMutation[] };
}

/** @deprecated */
export interface DOMMutation {
  type: "add" | "remove" | "attribute" | "text";
  targetId: number;
  parentId?: number;
  data?: unknown;
}

/** @deprecated */
export interface MouseEvent extends BaseReplayEvent {
  type: "mouse_move" | "mouse_click" | "mouse_down" | "mouse_up";
  data: { x: number; y: number; targetId?: number; button?: number };
}

/** @deprecated */
export interface ScrollEvent extends BaseReplayEvent {
  type: "scroll";
  data: { targetId: number | "window"; x: number; y: number };
}

/** @deprecated */
export interface InputEvent extends BaseReplayEvent {
  type: "input";
  data: { targetId: number; value: string; masked?: boolean };
}

/** @deprecated */
export interface ViewportEvent extends BaseReplayEvent {
  type: "viewport";
  data: { width: number; height: number };
}

/** @deprecated */
export interface ConsoleEvent extends BaseReplayEvent {
  type: "console";
  data: { level: "log" | "info" | "warn" | "error" | "debug"; args: unknown[]; stack?: string };
}

/** @deprecated */
export interface NetworkEvent extends BaseReplayEvent {
  type: "network";
  data: {
    requestId: string;
    method: string;
    url: string;
    status?: number;
    duration?: number;
    error?: string;
  };
}

/** @deprecated */
export interface CustomEvent extends BaseReplayEvent {
  type: "custom";
  data: { name: string; payload: unknown };
}

export interface ReplayConfig {
  /** Probability a session records continuously and uploads segments. Default 0. */
  sessionSampleRate: number;
  /** Probability a session not sampled above keeps a rolling buffer for an error. Default 1. */
  errorSampleRate: number;
  /** Upper bound on one continuous session, in ms. Default 1 hour. */
  maxSessionDuration: number;
  /** A segment is uploaded after this many ms. Default 30,000. */
  segmentDuration: number;
  /** ...or after this many events, whichever comes first. Default 5,000. */
  maxSegmentEvents: number;
  /** How much history the on-error buffer keeps, in ms (it holds between half of this and all of it). Default 60,000. */
  bufferDuration: number;
  /** How long recording continues after an error before the follow-up segment uploads, in ms. Default 30,000. */
  postErrorDuration: number;
  privacy: ReplayPrivacyConfig;
  /** Where segments go. Without it the recorder only calls `onSegment`. `startReplay()` fills it in. */
  upload?: UploadTarget;
  /** @deprecated Applies only to the object `stop()` returns, never to what is uploaded. Use the privacy options. */
  beforeSend?: (session: ReplaySession) => ReplaySession | null;
}

export type ReplayRecorderConfig = Partial<Omit<ReplayConfig, "privacy">> & {
  privacy?: Partial<ReplayPrivacyConfig>;
};

export type PlaybackState = "idle" | "playing" | "paused" | "ended";
export type PlaybackSpeed = 0.5 | 1 | 2 | 4 | 8;

export interface PlayerConfig {
  container: HTMLElement;
  speed?: PlaybackSpeed;
  skipInactiveThreshold?: number;
  showCursor?: boolean;
  showClickRipple?: boolean;
  highlightErrors?: boolean;
}

// =============================================================================
// Replay Recorder
// =============================================================================

const DEFAULT_CONFIG: Omit<ReplayConfig, "privacy" | "upload" | "beforeSend"> = {
  sessionSampleRate: 0,
  errorSampleRate: 1.0,
  maxSessionDuration: 60 * 60 * 1000,
  segmentDuration: 30_000,
  maxSegmentEvents: 5000,
  bufferDuration: 60_000,
  postErrorDuration: 30_000,
};

/** rrweb event types the recorder reads. */
const RRWEB_META = 4;

type Mode = "idle" | "session" | "buffer" | "post-error";
type RrwebRecord = typeof import("@rrweb/record").record;

function uuidv4(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export class ReplayRecorder {
  private config: ReplayConfig;
  private session: ReplaySession | null = null;
  private mode: Mode = "idle";
  private replayId = "";
  private nextSegment = 0;
  private sessionStartTime = 0;
  /** Events of the segment being built (session and post-error modes). */
  private events: RrwebEvent[] = [];
  /** On-error buffer: the previous and the current checkout generation. */
  private prevBuffer: RrwebEvent[] = [];
  private curBuffer: RrwebEvent[] = [];
  private pendingErrorIds: string[] = [];
  /** Set when the server refused a segment (no card or credits); nothing more uploads this session. */
  private uploadsRefused = false;
  private record: RrwebRecord | null = null;
  private stopRrweb: (() => void) | undefined;
  /** Bumped by start and stop so a late `import()` knows it was cancelled. */
  private generation = 0;
  private segmentTimer: ReturnType<typeof setInterval> | null = null;
  private postErrorTimer: ReturnType<typeof setTimeout> | null = null;
  private onSegmentReady?: (segment: ReplaySegment) => void;
  private onSessionEnd?: (session: ReplaySession) => void;
  private onHide = (): void => {
    if (typeof document !== "undefined" && document.visibilityState === "visible") return;
    this.flushSegment(true);
  };
  private onPageHide = (): void => this.flushSegment(true);

  constructor(config: ReplayRecorderConfig = {}) {
    const { privacy, ...rest } = config;
    this.config = { ...DEFAULT_CONFIG, ...rest, privacy: resolvePrivacy(privacy) };
  }

  /**
   * Decides sampling and starts recording. Returns the replay id, or null when nothing records (not in a
   * browser, or neither rate hit). rrweb loads asynchronously, so events start a moment after this returns.
   */
  start(options?: { userId?: string; tags?: Record<string, string> }): string | null {
    if (this.mode !== "idle") return this.replayId || null;
    if (typeof window === "undefined") return null;

    let mode: Mode | null = null;
    if (Math.random() < this.config.sessionSampleRate) mode = "session";
    else if (Math.random() < this.config.errorSampleRate) mode = "buffer";
    if (!mode) return null;

    this.mode = mode;
    this.sessionStartTime = Date.now();
    this.beginReplay();
    this.session = {
      id: this.replayId,
      userId: options?.userId,
      startedAt: new Date(),
      duration: 0,
      url: window.location.href,
      userAgent: navigator.userAgent,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      events: [],
      errorIds: [],
      segments: [],
      tags: options?.tags || {},
    };

    const generation = ++this.generation;
    window.addEventListener("pagehide", this.onPageHide);
    document.addEventListener("visibilitychange", this.onHide);
    if (mode === "session") {
      this.segmentTimer = setInterval(() => this.tick(), this.config.segmentDuration);
    }
    void this.boot(generation);
    return this.replayId;
  }

  stop(): ReplaySession | null {
    if (this.mode === "idle" || !this.session) return null;

    // A buffer nobody asked for is discarded: no error, nothing uploads.
    if (this.mode === "session" || this.mode === "post-error") this.flushSegment();
    this.mode = "idle";
    this.generation++;
    this.teardown();

    const session = this.session;
    session.endedAt = new Date();
    session.duration = Date.now() - this.sessionStartTime;
    this.session = null;
    this.replayId = "";

    let finalSession = session;
    if (this.config.beforeSend) {
      const processed = this.config.beforeSend(session);
      if (!processed) return null;
      finalSession = processed;
    }
    this.onSessionEnd?.(finalSession);
    return finalSession;
  }

  /**
   * An error was captured (called by the client for every event while `startReplay()` is active). In on-error
   * mode it uploads the buffer as a segment and keeps recording for `postErrorDuration`.
   */
  markError(errorId: string): void {
    this.session?.errorIds.push(errorId);
    if (this.mode === "buffer") {
      this.pendingErrorIds.push(errorId);
      this.mode = "post-error";
      const history = this.prevBuffer.concat(this.curBuffer);
      this.prevBuffer = [];
      this.curBuffer = [];
      this.emitSegment(history, this.takeErrorIds());
      this.postErrorTimer = setTimeout(() => this.endPostError(), this.config.postErrorDuration);
      (this.postErrorTimer as { unref?: () => void }).unref?.();
    } else if (this.mode === "session" || this.mode === "post-error") {
      this.pendingErrorIds.push(errorId);
    }
  }

  addCustomEvent(name: string, payload: unknown): void {
    if (this.mode === "idle") return;
    try {
      this.record?.addCustomEvent(name, payload);
    } catch {
      // never into the page
    }
  }

  /** The id of the replay recording now (in on-error mode, the one an upload would carry), or null. */
  getReplayId(): string | null {
    return this.mode === "idle" ? null : this.replayId;
  }

  /** Same as {@link getReplayId}. */
  getSessionId(): string | null {
    return this.getReplayId();
  }

  isActive(): boolean {
    return this.mode !== "idle";
  }

  onSegment(handler: (segment: ReplaySegment) => void): void {
    this.onSegmentReady = handler;
  }

  onSession(handler: (session: ReplaySession) => void): void {
    this.onSessionEnd = handler;
  }

  // ---------------------------------------------------------------------------

  private beginReplay(): void {
    this.replayId = uuidv4();
    this.nextSegment = 0;
    this.events = [];
    this.prevBuffer = [];
    this.curBuffer = [];
    this.pendingErrorIds = [];
  }

  private async boot(generation: number): Promise<void> {
    try {
      // Lazy on purpose: the root, /browser and /nextjs entries never reach this import.
      const mod = await import("@rrweb/record");
      if (generation !== this.generation) return;
      const record = mod.record;
      this.record = record;
      const rrwebPrivacy = toRrwebPrivacy(this.config.privacy);
      this.stopRrweb = record({
        emit: (event, isCheckout) => this.onEvent(event as unknown as RrwebEvent, isCheckout === true),
        ...rrwebPrivacy,
        // On-error mode needs a full snapshot at the start of whatever window is uploaded.
        ...(this.mode === "buffer" ? { checkoutEveryNms: Math.max(1000, Math.floor(this.config.bufferDuration / 2)) } : {}),
        errorHandler: () => true,
      });
    } catch (err) {
      if (generation !== this.generation) return;
      if (this.config.upload?.debug) console.log("[Overseer replay] could not start the recorder", err);
      this.mode = "idle";
      this.teardown();
      this.session = null;
      this.replayId = "";
    }
  }

  private onEvent(event: RrwebEvent, isCheckout: boolean): void {
    if (this.mode === "buffer") {
      // A checkout starts with a Meta event: that is where the older generation can go.
      if (isCheckout && event.type === RRWEB_META) {
        this.prevBuffer = this.curBuffer;
        this.curBuffer = [];
      }
      this.curBuffer.push(event);
      return;
    }
    if (this.mode === "idle") return;
    this.events.push(event);
    if (this.events.length >= this.config.maxSegmentEvents) this.flushSegment();
  }

  private tick(): void {
    if (Date.now() - this.sessionStartTime >= this.config.maxSessionDuration) {
      this.stop();
      return;
    }
    this.flushSegment();
  }

  private takeErrorIds(): string[] {
    const ids = this.pendingErrorIds;
    this.pendingErrorIds = [];
    return ids;
  }

  private flushSegment(hiding = false): void {
    if (this.mode !== "session" && this.mode !== "post-error") return;
    if (this.events.length === 0) return;
    const events = this.events;
    this.events = [];
    this.emitSegment(events, this.takeErrorIds(), hiding);
  }

  /** The post-error window is over: upload what followed the error, then go back to buffering under a new id. */
  private endPostError(): void {
    this.postErrorTimer = null;
    if (this.mode !== "post-error") return;
    this.flushSegment();
    this.mode = "buffer";
    this.beginReplay();
    // Start the next buffer with its own full snapshot.
    try {
      this.record?.takeFullSnapshot(true);
    } catch {
      // never into the page
    }
  }

  private emitSegment(events: RrwebEvent[], errorIds: string[], hiding = false): void {
    if (events.length === 0 || !this.session) return;
    const { chunks, dropped } = chunkEvents(events);
    if (dropped > 0 && this.config.upload?.debug) console.log(`[Overseer replay] dropped ${dropped} oversized event(s)`);

    chunks.forEach((chunk, index) => {
      const segment: ReplaySegment = {
        id: nanoid(),
        sessionId: this.replayId,
        sequenceNumber: this.nextSegment++,
        startTime: chunk[0].timestamp,
        endTime: chunk[chunk.length - 1].timestamp,
        events: chunk,
        errorIds: index === 0 ? errorIds : [],
      };
      this.session?.segments.push({ ...segment, events: [] });
      try {
        this.onSegmentReady?.(segment);
      } catch {
        // a consumer's handler must not break recording
      }
      const upload = this.config.upload;
      if (upload && !this.uploadsRefused) {
        void postSegment(
          upload,
          buildSegmentBody(upload, {
            replayId: segment.sessionId,
            sequenceNumber: segment.sequenceNumber,
            events: segment.events,
            errorIds: segment.errorIds ?? [],
          }),
          hiding,
        ).then((outcome) => {
          if (outcome === "refused") this.uploadsRefused = true;
        });
      }
    });
  }

  private teardown(): void {
    if (this.segmentTimer) clearInterval(this.segmentTimer);
    if (this.postErrorTimer) clearTimeout(this.postErrorTimer);
    this.segmentTimer = null;
    this.postErrorTimer = null;
    try {
      this.stopRrweb?.();
    } catch {
      // never into the page
    }
    this.stopRrweb = undefined;
    this.record = null;
    this.events = [];
    this.prevBuffer = [];
    this.curBuffer = [];
    this.pendingErrorIds = [];
    if (typeof window !== "undefined") window.removeEventListener("pagehide", this.onPageHide);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onHide);
  }
}

// =============================================================================
// Replay Player (Simplified)
// =============================================================================

export class ReplayPlayer {
  private config: PlayerConfig;
  private session: ReplaySession | null = null;
  private state: PlaybackState = "idle";
  private currentTime = 0;
  private animationFrameId: number | null = null;

  constructor(config: PlayerConfig) {
    this.config = {
      speed: 1,
      skipInactiveThreshold: 5000,
      showCursor: true,
      showClickRipple: true,
      highlightErrors: true,
      ...config,
    };
  }

  load(session: ReplaySession): void {
    this.session = session;
    this.currentTime = 0;
    this.state = "idle";
  }

  play(): void {
    if (!this.session) return;
    this.state = "playing";
    // Playback implementation would go here
  }

  pause(): void {
    this.state = "paused";
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }
  }

  stop(): void {
    this.pause();
    this.currentTime = 0;
    this.state = "idle";
  }

  seek(time: number): void {
    if (!this.session) return;
    this.currentTime = Math.max(0, Math.min(time, this.session.duration));
  }

  setSpeed(speed: PlaybackSpeed): void {
    (this.config as any).speed = speed;
  }

  getState(): PlaybackState {
    return this.state;
  }

  getCurrentTime(): number {
    return this.currentTime;
  }

  getDuration(): number {
    return this.session?.duration || 0;
  }

  destroy(): void {
    this.stop();
  }
}

// =============================================================================
// Client integration
// =============================================================================

export interface StartReplayOptions extends ReplayRecorderConfig {
  userId?: string;
  tags?: Record<string, string>;
}

let active: ReplayRecorder | null = null;

/**
 * Starts replay for the initialised Overseer client: rates from `replaysSessionSampleRate` /
 * `replaysOnErrorSampleRate`, upload to the client's DSN with its key, and every error event it sends carries
 * `tags.replay_id` while a replay records. Returns the replay id, or null when nothing records (no client, no
 * key, or both rates 0).
 */
export function startReplay(options: StartReplayOptions = {}): string | null {
  const client = getClient();
  if (!client || !client.isEnabled()) return null;
  if (active?.isActive()) return active.getReplayId();

  const dsn = client.getDsn();
  const key = client.getOverseerKey();
  if (!dsn || !key) return null;

  const rates = client.getReplaySampleRates();
  const { userId, tags, ...config } = options;
  const recorder = new ReplayRecorder({
    sessionSampleRate: rates.session,
    errorSampleRate: rates.onError,
    upload: { url: replayEndpoint(dsn), key, environment: client.getEnvironment(), release: client.getRelease() },
    ...config,
  });
  const id = recorder.start({ userId, tags });
  if (!id) return null;

  active = recorder;
  client.setReplayHook({
    getReplayId: () => recorder.getReplayId(),
    onError: (errorId) => recorder.markError(errorId),
  });
  return id;
}

/** Stops the recorder `startReplay()` started and unlinks it from the client. */
export function stopReplay(): void {
  const client = getClient();
  client?.setReplayHook(null);
  active?.stop();
  active = null;
}

// =============================================================================
// Factory Functions
// =============================================================================

export function createReplayRecorder(config?: ReplayRecorderConfig): ReplayRecorder {
  return new ReplayRecorder(config);
}

export function createReplayPlayer(config: PlayerConfig): ReplayPlayer {
  return new ReplayPlayer(config);
}
