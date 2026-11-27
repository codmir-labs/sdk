/**
 * @codmir/sdk/replay - Session Replay
 *
 * Records the page with rrweb (loaded lazily, only by this entry), masks inputs by default, and uploads
 * segments to Codmir. Wire contract: `ReplaySegmentUploadSchema` in the platform's `@codmir/types`.
 *
 * Two ways in:
 * - `startReplay()` after `init()`: reads the client's `replaysSessionSampleRate` (default 0) and
 *   `replaysOnErrorSampleRate` (default 1), uploads to the client's DSN with its key, and links every error
 *   event to the replay (`tags.replay_id`).
 * - `new ReplayRecorder({ upload })` for full control.
 *
 * A sampled session uploads its first segment 5 s after the start (`firstSegmentDelay`), then a segment every 30 s or
 * 5,000 events. Otherwise, with the on-error rate hit, the
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

import { generateId } from "../id";
import { getClient } from "../overseer/index";
import { runHideFlushes } from "../overseer/keepalive";
import { utf8Bytes } from "../overseer/transport";
import { ChoiceFilter, hiddenChoices } from "./choices";
import { ComposedPrivacyFilter } from "./composed-privacy";
import { dropPageQuery } from "./page-query";
import {
  resolvePrivacy,
  unknownDefaultDrops,
  toRrwebPrivacy,
  type ReplayPrivacyConfig,
} from "./privacy";
import {
  buildSegmentBody,
  chunkEvents,
  postSegment,
  replayEndpoint,
  type HideRun,
  RRWEB_FULL_SNAPSHOT,
  RRWEB_META,
  TARGET_BODY_BYTES,
  type RrwebEvent,
  type UploadOutcome,
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
  /**
   * rrweb events. A link or source that rrweb resolved to the page itself, such as `href="#top"`, keeps the page's
   * origin and path and its own fragment, never the page's query. Empty on the copies kept in `ReplaySession.segments`.
   */
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
  /**
   * In a sampled session the first segment, the one with the full snapshot, is uploaded this many ms after the replay
   * starts, so a short visit keeps its replay. At least 1,000 and at most `segmentDuration`. Default 5,000.
   */
  firstSegmentDelay: number;
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
  firstSegmentDelay: 5000,
  maxSegmentEvents: 5000,
  bufferDuration: 60_000,
  postErrorDuration: 30_000,
};

/** In session mode rrweb takes a full snapshot this often, so a lost segment costs about this much of the replay. */
export const SESSION_CHECKOUT_MS = 300_000;

type Mode = "idle" | "session" | "buffer" | "post-error";
type RrwebRecord = typeof import("@rrweb/record").record;

/** Recovery snapshots taken with no stored segment in between; past this a loss waits for the next periodic checkout. */
const MAX_RECOVERY_SNAPSHOTS = 3;

/** A segment whose upload ended "retry later" waits in a queue of at most this many segments... */
const MAX_QUEUED_SEGMENTS = 10;
/** ...or this many bytes of request bodies, whichever comes first. */
const MAX_QUEUED_BYTES = 5 * 1024 * 1024;
/** With no `Retry-After`, the wait before a queued segment is tried again starts here, doubles per failure... */
const QUEUE_BACKOFF_START_MS = 5000;
/** ...up to this. */
const QUEUE_BACKOFF_MAX_MS = 300_000;
/** A queued segment that ended "retry later" this many times from the queue is lost, so a queue that outlives `stop()` ends. */
const MAX_QUEUE_ATTEMPTS = 6;

/** A segment waiting to be sent again. */
interface QueuedSegment {
  counter: { next: number };
  replayId: string;
  sequenceNumber: number;
  events: RrwebEvent[];
  errorIds: string[];
  epoch: number;
  /** UTF-8 bytes of its request body. */
  bytes: number;
  /** Requests sent for it from the queue that ended "retry later". */
  attempts: number;
  /** A request for it, sent as the page hid, has not settled: nothing sends it again until it does. */
  sending?: boolean;
}

/** The page is known to be offline (`navigator.onLine` is a hint: only a `false` is believed). */
function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

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
  /** Segment numbers of the replay now recording; a segment cut in two after a 413 keeps drawing from the counter of its own replay. */
  private segments = { next: 0 };
  private sessionStartTime = 0;
  /** Events of the segment being built (session and post-error modes). */
  private events: RrwebEvent[] = [];
  /** On-error buffer: the previous and the current checkout generation. */
  private prevBuffer: RrwebEvent[] = [];
  private curBuffer: RrwebEvent[] = [];
  private pendingErrorIds: string[] = [];
  /** Set when the server refused a segment (no card or credits); nothing more uploads this session. */
  private uploadsRefused = false;
  /** Chosen for the on-error buffer at start: rrweb then needs periodic checkouts, even if an error came first. */
  private buffered = false;
  private record: RrwebRecord | null = null;
  private stopRrweb: (() => void) | undefined;
  /** Bumped by start and stop so a late `import()` knows it was cancelled. */
  private generation = 0;
  /** Bumped by each recovery snapshot; a segment emitted before one is older than it, so its loss needs no second snapshot. */
  private epoch = 0;
  /** A segment was lost and no fresh full snapshot has been taken yet (the page is offline, or the loss is just known). */
  private recoveryPending = false;
  /** Recovery snapshots taken since a segment of this replay was last stored. */
  private recoveries = 0;
  /** The cap was hit: what is recorded is dropped until rrweb's next periodic checkout, which costs no extra serialisation. */
  private awaitingCheckout = false;
  /** A FullSnapshot did not fit one request: this replay cannot play from there, so it records and uploads no more. */
  private halted = false;
  /** Segments whose upload ended "retry later", of any replay: in arrival order across replays, in sequence order within one; they go out one at a time. */
  private queue: QueuedSegment[] = [];
  private queueBytes = 0;
  /** Epoch ms before which the head of the queue is not sent again (a backoff, but not a server wait, ends on `online`). */
  private queueDueAt = 0;
  /** Set once a hide has advanced the backoff, so one hide takes one step. */
  private hideStepped = false;
  /** What the head is waiting out: our own backoff, or a delay the server asked for. */
  private queueDueKind: "backoff" | "server" = "backoff";
  /** The last backoff used with no server delay, 0 after a stored segment. */
  private queueBackoffMs = 0;
  /** A request for the head of the queue is in flight. */
  private draining = false;
  /** Bumped whenever the queue is dropped, so the answer to a request sent for an older queue is ignored. */
  private queueGeneration = 0;
  private queueTimer: ReturnType<typeof setTimeout> | null = null;
  private segmentTimer: ReturnType<typeof setInterval> | null = null;
  private firstSegmentTimer: ReturnType<typeof setTimeout> | null = null;
  /** The sends of the page hide being made now, so every request of it shares one keepalive order. */
  private hideRun: HideRun | null = null;
  private postErrorTimer: ReturnType<typeof setTimeout> | null = null;
  private onSegmentReady?: (segment: ReplaySegment) => void;
  private onSessionEnd?: (session: ReplaySession) => void;
  private onHide = (): void => {
    if (typeof document !== "undefined" && document.visibilityState === "visible") return;
    this.flushOnHide();
  };
  private onPageHide = (): void => this.flushOnHide();
  private onOnline = (): void => {
    this.recover();
    this.drain(true);
  };

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
    this.halted = false;
    this.buffered = mode === "buffer";
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
    window.addEventListener("online", this.onOnline);
    document.addEventListener("visibilitychange", this.onHide);
    if (mode === "session") {
      this.segmentTimer = setInterval(() => this.tick(), this.config.segmentDuration);
      const first = Math.min(this.config.segmentDuration, Math.max(1000, this.config.firstSegmentDelay));
      if (first < this.config.segmentDuration) {
        this.firstSegmentTimer = setTimeout(() => {
          this.firstSegmentTimer = null;
          this.tick();
        }, first);
      }
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
      // Nothing recorded yet (rrweb still loading, or waiting for `load`): the ids ride on the post-error segment.
      if (history.length > 0) this.emitSegment(history, this.takeErrorIds());
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
    this.segments = { next: 0 };
    this.events = [];
    this.prevBuffer = [];
    this.curBuffer = [];
    this.pendingErrorIds = [];
    this.recoveryPending = false;
    this.recoveries = 0;
    this.awaitingCheckout = false;
  }

  private async boot(generation: number): Promise<void> {
    try {
      // Lazy on purpose: the root, /browser and /nextjs entries never reach this import.
      const mod = await import("@rrweb/record");
      if (generation !== this.generation) return;
      const record = mod.record;
      this.record = record;
      const rrwebPrivacy = toRrwebPrivacy(this.config.privacy, (selector, list) => {
        if (!this.config.upload?.debug) return;
        console.log(`[Overseer replay] privacy.${list}: skipped invalid selector ${JSON.stringify(selector)}`);
      });
      if (this.config.upload?.debug) {
        for (const entry of unknownDefaultDrops(this.config.privacy)) {
          console.log(`[Overseer replay] privacy.dropDefaultSelectors: ignored ${JSON.stringify(entry)}, it names no default selector`);
        }
      }
      const choices = new ChoiceFilter(hiddenChoices(this.config.privacy));
      const composed = new ComposedPrivacyFilter({
        maskSelector: rrwebPrivacy.maskTextSelector,
        blockSelector: rrwebPrivacy.blockSelector,
        getNode: (id) => record.mirror.getNode(id),
      });
      this.stopRrweb = record({
        // rrweb resolved this event's links against the page's address of this moment, and a pushState changes that
        // address without a Meta event, so the page's query is cut out of them here, the one place that still knows it.
        // The state of a radio button or a checkbox, which no input mask hides, is taken out here too, and the mask and
        // block of what is added or changed later in a shadow root or a same-origin iframe, which rrweb checks only in a snapshot.
        emit: (event, isCheckout) => {
          const kept = choices.apply(dropPageQuery(event as unknown as RrwebEvent, window.location.href));
          const safe = kept && composed.apply(kept);
          if (safe) this.onEvent(safe, isCheckout === true);
        },
        ...rrwebPrivacy,
        // rrweb drops the meta tags that hold verification tokens (a CSRF token among them); the composed filter blanks the rest
        slimDOMOptions: { headMetaVerification: true },
        // On-error mode needs a full snapshot at the start of whatever window is uploaded; a session takes one every
        // few minutes, so one lost segment costs a few minutes of the replay, not the rest of it.
        checkoutEveryNms: this.buffered ? Math.max(1000, Math.floor(this.config.bufferDuration / 2)) : SESSION_CHECKOUT_MS,
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
    if (this.mode === "idle" || this.halted) return;
    if (this.awaitingCheckout) {
      // Without the lost state nothing recorded can play: drop it until the periodic checkout, then resume from it.
      if (!(isCheckout && event.type === RRWEB_META)) return;
      this.awaitingCheckout = false;
      this.epoch++; // a segment sent before the checkout is older than it
    }
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

  /**
   * The page is hidden or going away. The error transport's queue goes first, so it gets its keepalive bytes; then what
   * waits in this replay's queue, oldest first; then the segment being built. Each request has `keepalive` while it
   * fits the budget, and once one does not, it and every later one do without.
   */
  private flushOnHide(): void {
    runHideFlushes();
    const run: HideRun = { cut: false };
    this.hideRun = run;
    this.hideStepped = false;
    try {
      this.sendQueueOnHide(run);
      this.flushSegment(true);
    } finally {
      this.hideRun = null;
    }
  }

  private sendQueueOnHide(run: HideRun): void {
    const upload = this.config.upload;
    if (!upload || this.uploadsRefused || this.queue.length === 0) return;
    if (this.queueMustWait()) return; // the wait holds at hide: no request, so no attempt is counted
    // A request of the queue still in flight went without keepalive: nothing after it may take one.
    if (this.draining) run.cut = true;
    const generation = this.queueGeneration;
    for (const entry of [...this.queue]) {
      if (entry.sending) continue;
      entry.sending = true;
      void postSegment(upload, this.bodyOf(entry), true, false, run).then((outcome) => {
        entry.sending = false;
        if (generation !== this.queueGeneration) return; // the queue was dropped while this was in flight
        const at = this.queue.indexOf(entry);
        if (typeof outcome === "object") {
          entry.attempts++;
          if (outcome.delayMs !== null) this.waitForServer(outcome.delayMs);
          else if (!this.hideStepped) {
            // One hide is one backoff step, however many of its sends fail.
            this.hideStepped = true;
            this.queueDueAt = Date.now() + this.nextBackoff();
            this.queueDueKind = "backoff";
          }
          if (at >= 0 && entry.attempts >= MAX_QUEUE_ATTEMPTS) {
            if (upload.debug) console.log("[Overseer replay] a segment could not be sent after repeated attempts; dropping it");
            this.lose(entry.replayId, entry.epoch);
          }
          this.armQueueTimer();
          return;
        }
        if (at >= 0) {
          this.queue.splice(at, 1);
          this.queueBytes -= entry.bytes;
        }
        if (this.queue.length === 0) this.clearQueue();
        this.settle(entry, outcome, false);
        this.drain();
      });
    }
  }

  /** Offline, or a wait the server asked for that has not passed: the queue sends nothing, a hide included. */
  private queueMustWait(): boolean {
    return isOffline() || (this.queueDueKind === "server" && Date.now() < this.queueDueAt);
  }

  private flushSegment(hiding = false): void {
    if (this.mode !== "session" && this.mode !== "post-error") return;
    if (this.recoveryPending) {
      // What was recorded since the lost segment cannot play without it: while offline it is dropped rather than sent.
      if (isOffline()) {
        this.events = [];
        return;
      }
      this.recover();
    }
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
    if (events.length === 0 || !this.session || this.halted) return;
    const { chunks, dropped, snapshotDropped } = chunkEvents(events);
    if (snapshotDropped) {
      this.haltReplay(`a full snapshot is over the ${TARGET_BODY_BYTES} byte limit of one request, so this replay cannot be played; stopping it`);
      return;
    }
    if (dropped > 0 && this.config.upload?.debug) console.log(`[Overseer replay] dropped ${dropped} oversized event(s)`);

    const counter = this.segments;
    const epoch = this.epoch;
    chunks.forEach((chunk, index) => {
      const segment: ReplaySegment = {
        id: generateId(),
        sessionId: this.replayId,
        sequenceNumber: counter.next++,
        startTime: chunk[0].timestamp,
        endTime: chunk[chunk.length - 1].timestamp,
        events: chunk,
        // The player seeks to the end of the earliest segment that lists the error, so the last chunk is the one that ends at it.
        errorIds: index === chunks.length - 1 ? errorIds : [],
      };
      this.session?.segments.push({ ...segment, events: [] });
      try {
        this.onSegmentReady?.(segment);
      } catch {
        // a consumer's handler must not break recording
      }
      this.upload(counter, segment.sessionId, segment.sequenceNumber, segment.events, segment.errorIds ?? [], hiding, epoch);
    });
  }

  private upload(
    counter: { next: number },
    replayId: string,
    sequenceNumber: number,
    events: RrwebEvent[],
    errorIds: string[],
    hiding: boolean,
    epoch: number,
  ): void {
    const upload = this.config.upload;
    if (!upload || this.uploadsRefused) return;
    const segment: QueuedSegment = { counter, replayId, sequenceNumber, events, errorIds, epoch, bytes: 0, attempts: 0 };
    // Behind a queued segment (of any replay) a new one waits its turn, so segments reach the server in order. A segment
    // flushed as the page hides is sent once, now, and not queued: the page may be gone before a queue could send it.
    // Unless the queue must wait (offline, or a server wait): then it joins the queue's end without a request.
    if (hiding ? this.queueMustWait() : this.queue.length > 0) {
      this.enqueue(segment, null);
      return;
    }
    void postSegment(upload, this.bodyOf(segment), hiding, true, this.hideRun ?? undefined).then((outcome) => {
      if (typeof outcome === "object") this.enqueue(segment, outcome.delayMs);
      else this.settle(segment, outcome, hiding);
    });
  }

  private bodyOf(segment: QueuedSegment) {
    return buildSegmentBody(this.config.upload as UploadTarget, segment);
  }

  /** What became of a segment that is not waiting for a retry. */
  private settle(segment: QueuedSegment, outcome: Exclude<UploadOutcome, { outcome: "retry_later" }>, hiding: boolean): void {
    const { counter, replayId, sequenceNumber, events, errorIds, epoch } = segment;
    const upload = this.config.upload;
    if (!upload) return;
    if (outcome === "refused") {
      this.uploadsRefused = true;
      this.clearQueue();
      // Nothing more can be stored this session: stop recording too (deferred, we may be inside stop()).
      setTimeout(() => this.stop(), 0);
    } else if (outcome === "too_large") {
      // The server took it for over its cap: send it in two halves, the first under its own number, the second under
      // the next one of that replay; the error ids go with the later half. One event too big alone is dropped.
      if (events.length < 2) {
        if (events[0]?.type === RRWEB_FULL_SNAPSHOT) {
          // A fresh snapshot would be as large: no recovery, the replay cannot be played.
          if (replayId === this.replayId) this.haltReplay("the server refused a full snapshot as too large, so this replay cannot be played; stopping it");
          return;
        }
        if (upload.debug) console.log("[Overseer replay] the server refused a single event as too large; dropping it");
        this.lose(replayId, epoch);
        return;
      }
      const middle = Math.ceil(events.length / 2);
      this.upload(counter, replayId, sequenceNumber, events.slice(0, middle), [], hiding, epoch);
      this.upload(counter, replayId, counter.next++, events.slice(middle), errorIds, hiding, epoch);
    } else if (outcome === "stored") {
      this.queueBackoffMs = 0;
      if (replayId === this.replayId) this.recoveries = 0;
    } else {
      this.lose(replayId, epoch);
    }
  }

  /** A segment is gone for good: what waits behind it in the queue cannot play without it, so it goes too. */
  private lose(replayId: string, epoch: number): void {
    const kept = this.queue.filter((queued) => queued.replayId !== replayId || queued.epoch > epoch);
    if (kept.length !== this.queue.length) {
      this.queueBytes = kept.reduce((sum, queued) => sum + queued.bytes, 0);
      this.queue = kept;
      if (kept.length === 0) this.clearQueue();
    }
    this.segmentLost(replayId, epoch);
  }

  /**
   * Puts a segment whose upload ended "retry later" in the queue: behind the entries of other replays, in sequence
   * order among those of its own. `delayMs` is the server's wait, or null for the backoff. Past 10 segments or 5 MB the
   * queue is dropped, each replay in it as one lost segment: the later ones cannot play without the earliest.
   */
  private enqueue(segment: QueuedSegment, delayMs: number | null): void {
    if (this.uploadsRefused || !this.config.upload) return;
    const wasEmpty = this.queue.length === 0;
    segment.bytes = utf8Bytes(JSON.stringify(this.bodyOf(segment)));
    let at = this.queue.length;
    while (at > 0 && this.queue[at - 1].replayId === segment.replayId && this.queue[at - 1].sequenceNumber > segment.sequenceNumber) at--;
    this.queue.splice(at, 0, segment);
    this.queueBytes += segment.bytes;
    if (this.queue.length > MAX_QUEUED_SEGMENTS || this.queueBytes > MAX_QUEUED_BYTES) {
      const lost = new Map<string, { replayId: string; epoch: number }>();
      for (const queued of this.queue) lost.set(`${queued.replayId}:${queued.epoch}`, { replayId: queued.replayId, epoch: queued.epoch });
      if (this.config.upload.debug) console.log("[Overseer replay] too many segments are waiting to be sent; dropping them");
      this.clearQueue();
      for (const { replayId, epoch } of lost.values()) this.segmentLost(replayId, epoch);
      return;
    }
    if (delayMs !== null) this.waitForServer(delayMs);
    else if (wasEmpty) {
      this.queueDueAt = Date.now() + this.nextBackoff();
      this.queueDueKind = "backoff";
    }
    if (wasEmpty || delayMs !== null) this.armQueueTimer();
    else this.drain();
  }

  /** The server asked for a wait: the queue is not due before then, and `online` does not change that. */
  private waitForServer(delayMs: number): void {
    this.queueDueAt = Math.max(this.queueDueAt, Date.now() + delayMs);
    this.queueDueKind = "server";
  }

  private nextBackoff(): number {
    this.queueBackoffMs = Math.min(QUEUE_BACKOFF_MAX_MS, this.queueBackoffMs === 0 ? QUEUE_BACKOFF_START_MS : this.queueBackoffMs * 2);
    return this.queueBackoffMs;
  }

  private armQueueTimer(delayMs = Math.max(0, this.queueDueAt - Date.now())): void {
    if (this.queueTimer) clearTimeout(this.queueTimer);
    this.queueTimer = null;
    if (this.queue.length === 0 || this.draining) return;
    this.queueTimer = setTimeout(() => {
      this.queueTimer = null;
      this.drain();
    }, delayMs);
    (this.queueTimer as { unref?: () => void }).unref?.();
  }

  /**
   * Sends the head of the queue, when its delay has passed and the page is not known to be offline. `online`, which
   * calls this with `force`, skips a backoff but not a wait the server asked for. While offline nothing is sent and
   * no attempt is counted: the timer is re-armed, so a queue still drains when no `online` listener is left. One
   * request at a time; the next waits for its answer.
   */
  private drain(force = false): void {
    const upload = this.config.upload;
    if (this.draining || this.queue.length === 0 || !upload || this.uploadsRefused) return;
    if (isOffline()) {
      this.armQueueTimer(this.queueBackoffMs || QUEUE_BACKOFF_START_MS);
      return;
    }
    if (!(force && this.queueDueKind === "backoff") && Date.now() < this.queueDueAt) {
      this.armQueueTimer();
      return;
    }
    if (this.queueTimer) clearTimeout(this.queueTimer);
    this.queueTimer = null;
    const head = this.queue[0];
    if (head.sending) return; // a request sent as the page hid is still out; its answer drains the queue
    const generation = this.queueGeneration;
    this.draining = true;
    void postSegment(upload, this.bodyOf(head), false, false).then((outcome) => {
      if (generation !== this.queueGeneration) return; // the queue was dropped while this was in flight
      this.draining = false;
      const at = this.queue.indexOf(head);
      if (typeof outcome === "object") {
        head.attempts++;
        if (outcome.delayMs !== null) this.waitForServer(outcome.delayMs);
        else {
          this.queueDueAt = Date.now() + this.nextBackoff();
          this.queueDueKind = "backoff";
        }
        if (at >= 0 && head.attempts >= MAX_QUEUE_ATTEMPTS) {
          if (upload.debug) console.log("[Overseer replay] a segment could not be sent after repeated attempts; dropping it");
          this.lose(head.replayId, head.epoch);
        }
        this.armQueueTimer();
        return;
      }
      if (at >= 0) {
        this.queue.splice(at, 1);
        this.queueBytes -= head.bytes;
      }
      if (this.queue.length === 0) this.clearQueue();
      this.settle(head, outcome, false);
      this.drain();
    });
  }

  private clearQueue(): void {
    if (this.queueTimer) clearTimeout(this.queueTimer);
    this.queueTimer = null;
    this.queue = [];
    this.queueBytes = 0;
    this.queueDueAt = 0;
    this.queueBackoffMs = 0;
    this.draining = false;
    this.queueGeneration++;
  }

  /** Stops this replay for good (deferred: we may be inside `stop()`); nothing more is recorded or uploaded. */
  private haltReplay(reason: string): void {
    if (this.halted) return;
    this.halted = true;
    this.events = [];
    if (this.config.upload?.debug) console.log(`[Overseer replay] ${reason}`);
    setTimeout(() => this.stop(), 0);
  }

  /**
   * A segment of the replay did not arrive. The events since it cannot play without it, so a fresh full snapshot
   * follows: at once, or, while the page is offline, on the `online` event or the first flush back online.
   * On-error mode: a loss while buffering needs nothing (every buffer window opens with its own snapshot, and an upload
   * of an earlier replay id is ignored); a loss in the post-error window is recovered like a session's.
   */
  private segmentLost(replayId: string, epoch: number): void {
    if (replayId !== this.replayId || epoch !== this.epoch || this.recoveryPending || this.halted) return;
    if (this.mode !== "session" && this.mode !== "post-error") return;
    if (this.awaitingCheckout) return;
    if (this.recoveries >= MAX_RECOVERY_SNAPSHOTS) {
      // Nothing is getting through (a wrong key, a failing server, a dead network): no more snapshots until the next checkout.
      this.awaitingCheckout = true;
      this.events = [];
      return;
    }
    this.recoveryPending = true;
    if (!isOffline()) this.recover();
  }

  private recover(): void {
    if (!this.recoveryPending) return;
    this.recoveryPending = false;
    if (this.mode !== "session" && this.mode !== "post-error") return;
    this.epoch++;
    this.recoveries++;
    this.events = [];
    try {
      this.record?.takeFullSnapshot(true);
    } catch {
      // never into the page
    }
  }

  private teardown(): void {
    if (this.segmentTimer) clearInterval(this.segmentTimer);
    if (this.firstSegmentTimer) clearTimeout(this.firstSegmentTimer);
    this.firstSegmentTimer = null;
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
    this.recoveryPending = false;
    this.recoveries = 0;
    this.awaitingCheckout = false;
    if (typeof window !== "undefined") window.removeEventListener("pagehide", this.onPageHide);
    if (typeof window !== "undefined") window.removeEventListener("online", this.onOnline);
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
