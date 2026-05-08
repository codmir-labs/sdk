/**
 * @codmir/sdk/replay - Session Replay
 *
 * Record and replay user sessions for debugging.
 *
 * @example
 * ```typescript
 * import { ReplayRecorder, ReplayPlayer } from '@codmir/sdk/replay';
 *
 * // Recording
 * const recorder = new ReplayRecorder({ sessionSampleRate: 0.1 });
 * recorder.start();
 *
 * // Later: stop and get session
 * const session = recorder.stop();
 *
 * // Playback
 * const player = new ReplayPlayer({ container: document.getElementById('replay') });
 * player.load(session);
 * player.play();
 * ```
 */

import { nanoid } from "nanoid";

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
  events: ReplayEvent[];
  errorIds: string[];
  segments: ReplaySegment[];
  tags: Record<string, string>;
}

export interface ReplaySegment {
  id: string;
  sessionId: string;
  sequenceNumber: number;
  startTime: number;
  endTime: number;
  events: ReplayEvent[];
  compressed?: boolean;
}

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

export interface DOMSnapshotEvent extends BaseReplayEvent {
  type: "dom_snapshot";
  data: { html: string; baseUrl: string; doctype?: string };
}

export interface DOMIncrementalEvent extends BaseReplayEvent {
  type: "dom_incremental";
  data: { mutations: DOMMutation[] };
}

export interface DOMMutation {
  type: "add" | "remove" | "attribute" | "text";
  targetId: number;
  parentId?: number;
  data?: unknown;
}

export interface MouseEvent extends BaseReplayEvent {
  type: "mouse_move" | "mouse_click" | "mouse_down" | "mouse_up";
  data: { x: number; y: number; targetId?: number; button?: number };
}

export interface ScrollEvent extends BaseReplayEvent {
  type: "scroll";
  data: { targetId: number | "window"; x: number; y: number };
}

export interface InputEvent extends BaseReplayEvent {
  type: "input";
  data: { targetId: number; value: string; masked?: boolean };
}

export interface ViewportEvent extends BaseReplayEvent {
  type: "viewport";
  data: { width: number; height: number };
}

export interface ConsoleEvent extends BaseReplayEvent {
  type: "console";
  data: { level: "log" | "info" | "warn" | "error" | "debug"; args: unknown[]; stack?: string };
}

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

export interface CustomEvent extends BaseReplayEvent {
  type: "custom";
  data: { name: string; payload: unknown };
}

export interface ReplayPrivacyConfig {
  maskAllInputs: boolean;
  maskInputTypes: string[];
  maskSelectors: string[];
  blockSelectors: string[];
  ignoreSelectors: string[];
}

export interface ReplayConfig {
  sessionSampleRate: number;
  errorSampleRate: number;
  maxSessionDuration: number;
  segmentDuration: number;
  privacy: ReplayPrivacyConfig;
  beforeSend?: (session: ReplaySession) => ReplaySession | null;
}

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

const DEFAULT_PRIVACY: ReplayPrivacyConfig = {
  maskAllInputs: false,
  maskInputTypes: ["password", "credit-card"],
  maskSelectors: ["[data-private]", ".private"],
  blockSelectors: ["[data-block-replay]"],
  ignoreSelectors: [],
};

const DEFAULT_CONFIG: ReplayConfig = {
  sessionSampleRate: 0.1,
  errorSampleRate: 1.0,
  maxSessionDuration: 60 * 60 * 1000,
  segmentDuration: 5 * 60 * 1000,
  privacy: DEFAULT_PRIVACY,
};

export class ReplayRecorder {
  private config: ReplayConfig;
  private session: ReplaySession | null = null;
  private currentSegment: ReplaySegment | null = null;
  private isRecording = false;
  private sessionStartTime = 0;
  private cleanupFns: (() => void)[] = [];
  private onSegmentReady?: (segment: ReplaySegment) => void;
  private onSessionEnd?: (session: ReplaySession) => void;

  constructor(config: Partial<ReplayConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  start(options?: { userId?: string; tags?: Record<string, string> }): string | null {
    if (this.isRecording) return this.session?.id || null;
    if (typeof window === "undefined") return null;
    if (Math.random() > this.config.sessionSampleRate) return null;

    this.sessionStartTime = Date.now();
    this.session = {
      id: nanoid(),
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

    this.startNewSegment();
    this.isRecording = true;
    this.setupEventListeners();
    this.captureSnapshot();

    return this.session.id;
  }

  stop(): ReplaySession | null {
    if (!this.isRecording || !this.session) return null;

    this.isRecording = false;
    this.session.endedAt = new Date();
    this.session.duration = Date.now() - this.sessionStartTime;

    if (this.currentSegment) {
      this.currentSegment.endTime = this.session.duration;
      this.session.segments.push(this.currentSegment);
      this.onSegmentReady?.(this.currentSegment);
    }

    this.cleanupFns.forEach((fn) => fn());
    this.cleanupFns = [];

    let finalSession = this.session;
    if (this.config.beforeSend) {
      const processed = this.config.beforeSend(this.session);
      if (!processed) {
        this.session = null;
        return null;
      }
      finalSession = processed;
    }

    this.onSessionEnd?.(finalSession);
    const result = finalSession;
    this.session = null;
    this.currentSegment = null;

    return result;
  }

  markError(errorId: string): void {
    this.session?.errorIds.push(errorId);
  }

  addCustomEvent(name: string, payload: unknown): void {
    this.addEvent({
      type: "custom",
      timestamp: this.getRelativeTime(),
      data: { name, payload },
    });
  }

  getSessionId(): string | null {
    return this.session?.id || null;
  }

  isActive(): boolean {
    return this.isRecording;
  }

  onSegment(handler: (segment: ReplaySegment) => void): void {
    this.onSegmentReady = handler;
  }

  onSession(handler: (session: ReplaySession) => void): void {
    this.onSessionEnd = handler;
  }

  private getRelativeTime(): number {
    return Date.now() - this.sessionStartTime;
  }

  private addEvent(event: ReplayEvent): void {
    if (!this.isRecording || !this.currentSegment) return;
    this.currentSegment.events.push(event);

    if (event.timestamp - this.currentSegment.startTime >= this.config.segmentDuration) {
      this.finalizeSegment();
      this.startNewSegment();
    }

    if (event.timestamp >= this.config.maxSessionDuration) {
      this.stop();
    }
  }

  private startNewSegment(): void {
    this.currentSegment = {
      id: nanoid(),
      sessionId: this.session!.id,
      sequenceNumber: this.session!.segments.length,
      startTime: this.getRelativeTime(),
      endTime: 0,
      events: [],
    };
  }

  private finalizeSegment(): void {
    if (!this.currentSegment || !this.session) return;
    this.currentSegment.endTime = this.getRelativeTime();
    this.session.segments.push(this.currentSegment);
    this.onSegmentReady?.(this.currentSegment);
  }

  private captureSnapshot(): void {
    if (typeof document === "undefined") return;
    this.addEvent({
      type: "dom_snapshot",
      timestamp: this.getRelativeTime(),
      data: {
        html: document.documentElement.outerHTML,
        baseUrl: document.baseURI,
        doctype: document.doctype ? `<!DOCTYPE ${document.doctype.name}>` : undefined,
      },
    });
  }

  private setupEventListeners(): void {
    // Mouse move (throttled)
    let lastMouseMove = 0;
    const onMouseMove = (e: globalThis.MouseEvent) => {
      if (Date.now() - lastMouseMove < 50) return;
      lastMouseMove = Date.now();
      this.addEvent({
        type: "mouse_move",
        timestamp: this.getRelativeTime(),
        data: { x: e.clientX, y: e.clientY },
      });
    };
    window.addEventListener("mousemove", onMouseMove);
    this.cleanupFns.push(() => window.removeEventListener("mousemove", onMouseMove));

    // Click
    const onClick = (e: globalThis.MouseEvent) => {
      this.addEvent({
        type: "mouse_click",
        timestamp: this.getRelativeTime(),
        data: { x: e.clientX, y: e.clientY, button: e.button },
      });
    };
    window.addEventListener("click", onClick);
    this.cleanupFns.push(() => window.removeEventListener("click", onClick));

    // Scroll
    let lastScroll = 0;
    const onScroll = () => {
      if (Date.now() - lastScroll < 100) return;
      lastScroll = Date.now();
      this.addEvent({
        type: "scroll",
        timestamp: this.getRelativeTime(),
        data: { targetId: "window", x: window.scrollX, y: window.scrollY },
      });
    };
    window.addEventListener("scroll", onScroll);
    this.cleanupFns.push(() => window.removeEventListener("scroll", onScroll));

    // Resize
    const onResize = () => {
      this.addEvent({
        type: "viewport",
        timestamp: this.getRelativeTime(),
        data: { width: window.innerWidth, height: window.innerHeight },
      });
    };
    window.addEventListener("resize", onResize);
    this.cleanupFns.push(() => window.removeEventListener("resize", onResize));
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
// Factory Functions
// =============================================================================

export function createReplayRecorder(config?: Partial<ReplayConfig>): ReplayRecorder {
  return new ReplayRecorder(config);
}

export function createReplayPlayer(config: PlayerConfig): ReplayPlayer {
  return new ReplayPlayer(config);
}
