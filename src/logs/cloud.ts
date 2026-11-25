/**
 * Cloud mode: a finding becomes one flat error event on the SDK's own client, so delivery, batching, retry and the
 * bounded queue are the client's. This file decides which findings go out and builds the event. Nothing in it is
 * raw: every string is the monitor's redacted one, redacted once more here.
 */
import type { OverseerEvent } from "../overseer/index";
import { SDK_VERSION } from "../version";
import { num } from "./num";
import { nameOf, redact } from "./redact";
import type { CloudOptions, Finding, LogLevel, MonitorStats } from "./types";

/** What the monitor keeps per group so a finding is not sent twice in an hour, and every hit is sent once. */
export interface SendState {
  /** When the group was last sent; none, or 0 after a restart that had none, if it never was. */
  sentAt?: number;
  sentBack: number;
  /** The group's total when it was last sent. */
  sentTotal?: number;
}

export interface Candidate {
  finding: Finding;
  state: SendState;
  /** Hits since the group was last sent (all of them, the first time); set when it is chosen. */
  sinceSent?: number;
  /** The marks the group had before it was chosen, and which choice this was; set when it is chosen. */
  before?: Pick<SendState, "sentAt" | "sentBack" | "sentTotal">;
  seq?: number;
}

/** What is kept of an event the client has not answered for: enough to put the group's marks back. */
interface Waiting {
  state: SendState;
  before: NonNullable<Candidate["before"]>;
  seq: number;
  /** The call of `send` it went out in, the `now` of its `select` and the UTC day it was counted on. */
  call: number;
  now: number;
  day: string;
}

export const CLOUD_DEFAULTS = { everyMinutes: 60, perBatch: 50, perDay: 1000 } as const;
const SEND_TIMEOUT_MS = 5000;
/** As many as can wait in the client's queue. */
const MAX_WAITING = 1000;
const BACKOFF_MS = 60_000;
const BACKOFF_MAX = 60;
const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const RANK: Record<string, number> = { debug: 0, info: 1, warning: 2, error: 3, fatal: 4 };
const PRIORITY: Record<string, number> = { alarm: 0, back: 1, new: 2, known: 3, seen: 4, noise: 5 };

/** The level of the issue: a request is `error` from 500, else `warning`; a log line keeps its own level. */
export function eventLevel(f: Finding): LogLevel {
  if (f.kind === "request") return (f.status ?? 0) >= 500 ? "error" : "warning";
  return f.level ?? "error";
}

const cut = (s: unknown, n: number): string => redact(s).slice(0, n);

/** The flat error event of a finding. `fingerprint` is the group, so one finding is one issue and a repeat counts up. */
export function findingEvent(f: Finding, meta: { environment?: string; release?: string; hits?: number }): OverseerEvent {
  const title = cut(f.title, 200);
  const releases = f.releases.map((r) => nameOf(r)).filter(Boolean);
  const release = releases[releases.length - 1] ?? nameOf(meta.release);
  const level = eventLevel(f);
  const tags: Record<string, string> = {
    source: "codmir-logs",
    finding: f.id,
    kind: f.kind,
    judgement: f.judgement,
    hits: String(meta.hits ?? f.hits),
    total: String(f.total),
  };
  if (f.method) tags.method = cut(f.method, 16);
  if (f.path) tags.path = cut(f.path, 200);
  if (f.status) tags.status = String(f.status);
  const service = nameOf(f.service);
  if (service) tags.service = service;
  if (f.known) tags.known = cut(f.known, 200);
  return {
    id: `${f.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    type: "error",
    timestamp: f.lastSeen,
    level,
    message: title,
    exception: { type: f.kind === "request" ? `HTTP${f.status}` : level === "warning" ? "LogWarning" : "LogError", value: title },
    fingerprint: ["codmir-logs", cut(f.key, 200)],
    tags,
    extra: {
      firstSeen: f.firstSeen,
      lastSeen: f.lastSeen,
      batches: f.counts.slice(-8),
      releases,
      ...(f.families ? { families: f.families } : {}),
      sample: cut(f.sample, 300),
    },
    ...(meta.environment ? { environment: cut(meta.environment, 32) } : {}),
    ...(release ? { release } : {}),
    sdk: { name: "codmir-logs", version: SDK_VERSION },
  };
}

type OverseerModule = typeof import("../overseer/index");
type SdkClient = NonNullable<ReturnType<OverseerModule["getClient"]>>;

export interface Cloud {
  /** The candidates to send now, caps applied; their `state` is marked sent. */
  select(candidates: Candidate[], now: number): Candidate[];
  /** Hands the events to the client and waits for its flush, at most 5 s. `chosen[i]` is the finding of `events[i]`. Never throws. */
  send(events: OverseerEvent[], chosen?: Candidate[]): Promise<boolean>;
  counters(): MonitorStats["cloud"];
  /** The UTC day (`2026-11-24`) the per-day count is for, and the count; what a restart takes up again. */
  state(): { day: string; sent: number };
  restore(saved: unknown): void;
  close(): void;
}

export function createCloud(
  options: true | CloudOptions,
  base: { service?: string; release?: string; environment?: string; onRollback?: () => void },
): Cloud {
  const o: CloudOptions = options === true ? {} : options;
  const everyMs = num(o.everyMinutes, CLOUD_DEFAULTS.everyMinutes, 0, 525_600) * 60_000;
  const perBatch = Math.floor(num(o.perBatch, CLOUD_DEFAULTS.perBatch, 0, 10_000));
  const perDay = Math.floor(num(o.perDay, CLOUD_DEFAULTS.perDay, 0, 1_000_000));
  const minRank = RANK[o.minSeverity ?? "warning"] ?? RANK.warning;
  let day = "";
  let today = 0;
  let sent = 0;
  let skipped = 0;
  let refused = 0;
  let waiting = 0;
  let reason: string | undefined;
  let own: SdkClient | null = null;
  // Only with `apiKey`: the app's own client has no hook that tells.
  const waitingFor = new Map<string, Waiting>();
  const lastChoice = new WeakMap<SendState, number>();
  let seq = 0;
  let calls = 0;
  let lastNow = 0;
  let strikes = 0;
  let lastStrike = 0;
  let pausedUntil = 0;

  /** The server did not take these events: their groups get their marks back (unless sent again since), the day its places, and nothing is chosen for a while. */
  const refuse = (ids: readonly string[]): void => {
    let strike = ids.length === 0 || ids.every((id) => !waitingFor.has(id));
    let at = lastNow;
    let call = calls;
    let changed = false;
    for (const id of ids) {
      const w = waitingFor.get(id);
      if (!w) continue;
      waitingFor.delete(id);
      strike = true;
      at = w.now;
      call = w.call;
      if (lastChoice.get(w.state) === w.seq) {
        w.state.sentAt = w.before.sentAt;
        w.state.sentBack = w.before.sentBack;
        w.state.sentTotal = w.before.sentTotal;
        changed = true;
      }
      if (w.day === day && today > 0) today -= 1;
    }
    if (strike && call > lastStrike) {
      lastStrike = call;
      strikes += 1;
      pausedUntil = at + Math.min(BACKOFF_MAX, 2 ** (strikes - 1)) * BACKOFF_MS;
    }
    if (changed) {
      try {
        base.onRollback?.();
      } catch {
        // the monitor's save never breaks the client's hook
      }
    }
  };
  const wants = (c: Candidate, now: number): boolean => {
    const { finding: f, state } = c;
    if (f.judgement === "noise" || f.hits <= 0) return false;
    if ((RANK[eventLevel(f)] ?? 0) < minRank) return false;
    if (!state.sentAt) return true;
    if (f.judgement === "back" && state.sentBack !== f.backCount) return true;
    if (f.judgement === "known") return false;
    return now - state.sentAt >= everyMs;
  };

  const client = async (): Promise<SdkClient | null> => {
    const mod = await import("../overseer/index");
    if (!o.apiKey) return mod.getClient() ?? ((globalThis as Record<symbol, unknown>)[Symbol.for("codmir.overseer.client")] as SdkClient | undefined) ?? null;
    if (!own) {
      own = new mod.OverseerClient({
        clientKey: o.apiKey,
        dsn: o.dsn,
        service: base.service,
        release: base.release,
        environment: o.environment ?? base.environment,
        onDropped: (d) => {
          refused += d.events;
          reason = cut(d.reason ?? `status ${d.status}`, 64);
          refuse(Array.isArray(d.eventIds) ? d.eventIds : []);
        },
      }) as SdkClient;
      own.init();
    }
    return own;
  };

  return {
    select(candidates, now) {
      if (now < pausedUntil) return [];
      lastNow = now;
      const d = utcDay(now);
      if (d !== day) {
        day = d;
        today = 0;
      }
      const eligible = candidates
        .filter((c) => wants(c, now))
        .sort((a, b) => PRIORITY[a.finding.judgement] - PRIORITY[b.finding.judgement] || b.finding.hits - a.finding.hits);
      const room = Math.max(0, Math.min(perBatch, perDay - today));
      const chosen = eligible.slice(0, room);
      skipped += eligible.length - chosen.length;
      for (const c of chosen) {
        c.before = { sentAt: c.state.sentAt, sentBack: c.state.sentBack, sentTotal: c.state.sentTotal };
        c.seq = ++seq;
        lastChoice.set(c.state, c.seq);
        c.state.sentAt = now;
        c.state.sentBack = c.finding.backCount;
        c.sinceSent = c.finding.total - (c.state.sentTotal ?? 0);
        c.state.sentTotal = c.finding.total;
      }
      today += chosen.length;
      return chosen;
    },

    async send(events, chosen) {
      if (events.length === 0) return true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const c = await client();
        if (!c) return false;
        const call = ++calls;
        const strikesBefore = lastStrike;
        for (const [i, e] of events.entries()) {
          try {
            const id = c.captureEvent(e);
            if (id) {
              sent += 1;
              waiting += 1;
              const k = chosen?.[i];
              if (o.apiKey && k?.before && k.seq !== undefined) {
                if (waitingFor.size >= MAX_WAITING) waitingFor.delete(waitingFor.keys().next().value as string);
                waitingFor.set(id, { state: k.state, before: k.before, seq: k.seq, call, now: lastNow, day });
              }
            }
          } catch {
            // one bad event never stops the others
          }
        }
        const deadline = new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), SEND_TIMEOUT_MS);
          (timer as { unref?: () => void }).unref?.();
        });
        const answered = await Promise.race([c.flush(), deadline]);
        if (answered) {
          // The client's queue is empty: what an earlier call left in it went out too, and what nobody named was taken.
          waiting = 0;
          waitingFor.clear();
          if (lastStrike === strikesBefore) {
            strikes = 0;
            pausedUntil = 0;
          }
        }
        return answered;
      } catch {
        return false;
      } finally {
        if (timer) clearTimeout(timer);
      }
    },

    counters: () => ({ sent, skipped, today, refused, waiting, ...(reason ? { reason } : {}), ...(pausedUntil > Date.now() ? { pausedUntil: new Date(pausedUntil).toISOString() } : {}) }),

    state: () => ({ day, sent: today }),

    restore(saved) {
      const { day: d, sent: n } = (saved ?? {}) as { day?: string; sent?: number };
      // A date orders like text, and a day that has not come yet is no day.
      if (typeof d === "string" && d <= utcDay(Date.now()) && Number.isInteger(n) && (n as number) >= 0) {
        day = d;
        today = n as number;
      }
    },

    close() {
      try {
        own?.close();
      } catch {
        // closing never throws into the app
      }
      own = null;
    },
  };
}
