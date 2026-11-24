/**
 * Cloud mode: a finding becomes one flat error event on the SDK's own client, so delivery, batching, retry and the
 * bounded queue are the client's. This file decides which findings go out and builds the event. Nothing in it is
 * raw: every string is the monitor's redacted one, redacted once more here.
 */
import type { OverseerEvent } from "../overseer/index";
import { SDK_VERSION } from "../version";
import { num } from "./num";
import { redact } from "./redact";
import type { CloudOptions, Finding, LogLevel } from "./types";

/** What the monitor keeps per group so a finding is not sent twice in an hour, and every hit is sent once. */
export interface SendState {
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
}

export const CLOUD_DEFAULTS = { everyMinutes: 60, perBatch: 50, perDay: 1000 } as const;
const SEND_TIMEOUT_MS = 5000;
const DAY_MS = 86_400_000;
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
  if (f.service) tags.service = cut(f.service, 64);
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
      releases: f.releases.map((r) => cut(r, 64)),
      ...(f.families ? { families: f.families } : {}),
      sample: cut(f.sample, 300),
    },
    ...(meta.environment ? { environment: cut(meta.environment, 32) } : {}),
    ...(f.releases.length ? { release: cut(f.releases[f.releases.length - 1], 64) } : meta.release ? { release: cut(meta.release, 64) } : {}),
    sdk: { name: "codmir-logs", version: SDK_VERSION },
  };
}

type OverseerModule = typeof import("../overseer/index");
type SdkClient = NonNullable<ReturnType<OverseerModule["getClient"]>>;

export interface Cloud {
  /** The candidates to send now, caps applied; their `state` is marked sent. */
  select(candidates: Candidate[], now: number): Candidate[];
  /** Hands the events to the client and waits for its flush, at most 5 s. Never throws. */
  send(events: OverseerEvent[]): Promise<boolean>;
  counters(): { sent: number; skipped: number; today: number };
  close(): void;
}

export function createCloud(
  options: true | CloudOptions,
  base: { service?: string; release?: string; environment?: string },
): Cloud {
  const o: CloudOptions = options === true ? {} : options;
  const everyMs = num(o.everyMinutes, CLOUD_DEFAULTS.everyMinutes, 0, 525_600) * 60_000;
  const perBatch = Math.floor(num(o.perBatch, CLOUD_DEFAULTS.perBatch, 0, 10_000));
  const perDay = Math.floor(num(o.perDay, CLOUD_DEFAULTS.perDay, 0, 1_000_000));
  const minRank = RANK[o.minSeverity ?? "warning"] ?? RANK.warning;
  let day = -1;
  let today = 0;
  let sent = 0;
  let skipped = 0;
  let own: SdkClient | null = null;

  const wants = (c: Candidate, now: number): boolean => {
    const { finding: f, state } = c;
    if (f.judgement === "noise" || f.hits <= 0) return false;
    if ((RANK[eventLevel(f)] ?? 0) < minRank) return false;
    if (state.sentAt === undefined) return true;
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
      }) as SdkClient;
      own.init();
    }
    return own;
  };

  return {
    select(candidates, now) {
      const d = Math.floor(now / DAY_MS);
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
        c.state.sentAt = now;
        c.state.sentBack = c.finding.backCount;
        c.sinceSent = c.finding.total - (c.state.sentTotal ?? 0);
        c.state.sentTotal = c.finding.total;
      }
      today += chosen.length;
      return chosen;
    },

    async send(events) {
      if (events.length === 0) return true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const c = await client();
        if (!c) return false;
        for (const e of events) {
          try {
            if (c.captureEvent(e)) sent += 1;
          } catch {
            // one bad event never stops the others
          }
        }
        const deadline = new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), SEND_TIMEOUT_MS);
          (timer as { unref?: () => void }).unref?.();
        });
        return await Promise.race([c.flush(), deadline]);
      } catch {
        return false;
      } finally {
        if (timer) clearTimeout(timer);
      }
    },

    counters: () => ({ sent, skipped, today }),

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
