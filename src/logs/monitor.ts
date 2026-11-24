/**
 * The log monitor: groups an app's own log lines and served requests, judges each group once per batch, and hands
 * the findings to `onBatch` and, when asked, to Codmir. Isomorphic: no Node import. It must never hurt the app, so
 * no public call throws, memory is bounded (groups, keys, samples, counts), the work per record is bounded
 * (texts are cut before any pattern runs) and a call made while a batch is being delivered is skipped.
 */
import { createCloud, findingEvent, type Candidate, type Cloud, type SendState } from "./cloud";
import { num } from "./num";
import { MAX_KEY, MAX_SAMPLE, compileExtra, isScannerPath, lineText, messageKey, pathPattern, redact, shortId, uaFamily } from "./redact";
import type { Finding, Judgement, LogBatch, LogLevel, LogMonitor, LogMonitorOptions, LogRecord, MarkOptions, MonitorStats, RequestRecord, TimeInput } from "./types";

export const COUNT_BATCHES = 96;
export const QUIET_MS = 24 * 3_600_000;
const FORGET_MS = 30 * 24 * 3_600_000;
const ALARM_HITS = 3;
const GROWTH_FACTOR = 10;
const MAX_RELEASES = 8;
const MAX_MARKS = 500;
/** A week: past 24.8 days a timer overflows and fires at once, again and again. */
const MAX_BATCH_MINUTES = 7 * 24 * 60;
const DEFAULT_LEVELS: LogLevel[] = ["warning", "error", "fatal"];

const LEVELS: Record<string, LogLevel> = {
  debug: "debug", trace: "debug", verbose: "debug", silly: "debug",
  info: "info", log: "info", notice: "info",
  warn: "warning", warning: "warning",
  error: "error", err: "error",
  fatal: "fatal", critical: "fatal", crit: "fatal", alert: "fatal", emerg: "fatal", panic: "fatal",
};

/** A level name as one of the five; anything unknown is `info`. */
export function normalizeLevel(level: unknown): LogLevel {
  return (typeof level === "string" && LEVELS[level.toLowerCase()]) || "info";
}

type Seed = Pick<Group, "kind" | "title" | "noise" | "sample"> & Partial<Pick<Group, "method" | "path" | "status" | "level">>;

interface Group extends SendState {
  key: string;
  id: string;
  kind: "request" | "message";
  title: string;
  method?: string;
  path?: string;
  status?: number;
  level?: LogLevel;
  service?: string;
  releases: string[];
  sample: string;
  total: number;
  hits: number;
  counts: number[];
  firstMs: number;
  lastMs: number;
  entering: "new" | "back" | "seen";
  backCount: number;
  fixed: boolean;
  known?: string;
  noise: boolean;
  families: Record<string, number>;
  nonBot: number;
  pathHits: number;
  scannerHits: number;
  durN: number;
  durSum: number;
  durMax: number;
  last: Judgement;
}

const toMs = (t: TimeInput | undefined, fallback: number): number => {
  if (t === undefined) return fallback;
  const ms = typeof t === "number" ? t : t instanceof Date ? t.getTime() : Date.parse(t);
  return Number.isFinite(ms) ? ms : fallback;
};

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** 10 times its usual: the median of the batches it was seen in (3 of them at least), and at least 10 hits. */
const grows = (g: Group, hits: number): boolean => {
  const before = g.counts.filter((n) => n > 0);
  return before.length >= 3 && hits >= 10 && hits >= GROWTH_FACTOR * median(before);
};

const clip = (s: string | undefined, n: number): string => (s ? redact(s).slice(0, n) : "");

/** One example of a log line: redacted, quoted values folded (a name or an id between quotes is data), lines joined. */
const sampleOf = (text: string, extra?: readonly RegExp[]): string =>
  redact(text.slice(0, 4 * MAX_SAMPLE).replace(/\s*\n\s*/g, " | "), extra)
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "[v]")
    .slice(0, MAX_SAMPLE);

export function createLogMonitor(options: LogMonitorOptions = {}): LogMonitor {
  const opts = options ?? {};
  const extra = compileExtra(opts.redact);
  const levels = new Set<string>(opts.include?.levels?.length ? opts.include.levels : DEFAULT_LEVELS);
  const minStatus = num(opts.include?.minStatus, 400, 0, 1000);
  const maxGroups = Math.floor(num(opts.limits?.groups, 500, 1, 100_000));
  const batchMs = num(opts.batchMinutes, 15, 1, MAX_BATCH_MINUTES) * 60_000;
  const noiseTests = (opts.noise ?? []).map((n) => (typeof n === "string" ? (label: string) => label.toLowerCase().includes(n.toLowerCase()) : (label: string) => new RegExp(n.source, n.flags.replace(/[gy]/g, "")).test(label)));
  const cloud: Cloud | null = opts.cloud ? createCloud(opts.cloud, { service: opts.service, release: opts.release, environment: typeof opts.cloud === "object" ? opts.cloud.environment : undefined }) : null;

  const groups = new Map<string, Group>();
  const marks = new Map<string, MarkOptions>();
  const pending = new Set<Promise<unknown>>();
  const counters = { records: 0, ignored: 0, dropped: 0, batches: 0, reentrant: 0, errors: 0 };
  let windowStart = Date.now();
  let windowRecords = 0;
  let busy = false;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const isNoise = (label: string): boolean => noiseTests.some((t) => { try { return t(label); } catch { return false; } });

  const evict = (): void => {
    let worst: Group | null = null;
    for (const g of groups.values()) if (!worst || g.total < worst.total || (g.total === worst.total && g.lastMs < worst.lastMs)) worst = g;
    if (worst) {
      groups.delete(worst.key);
      counters.dropped += 1;
    }
  };

  const open = (key: string, make: () => Seed, ms: number): Group => {
    const hit = groups.get(key);
    if (hit) return hit;
    if (groups.size >= maxGroups) evict();
    const id = shortId(key);
    const g: Group = {
      ...make(), key, id, releases: [], total: 0, hits: 0, counts: [], backCount: 0, fixed: false, entering: "new", families: {},
      nonBot: 0, pathHits: 0, scannerHits: 0, durN: 0, durSum: 0, durMax: 0, last: "new", sentBack: 0, firstMs: ms, lastMs: ms,
    };
    const earlier = marks.get(id) ?? marks.get(key);
    if (typeof earlier?.known === "string") g.known = earlier.known;
    groups.set(key, g);
    return g;
  };

  /** The state the group enters this batch with, at its first hit of the window. */
  const enter = (g: Group, ms: number): void => {
    if (g.total === 0) g.entering = "new";
    else if (g.fixed || ms - g.lastMs > QUIET_MS) {
      g.entering = "back";
      g.backCount += 1;
      g.fixed = false;
    } else g.entering = "seen";
  };

  const touch = (g: Group, ms: number, release?: string, service?: string): void => {
    if (g.hits === 0) enter(g, ms);
    g.hits += 1;
    g.total += 1;
    if (ms < g.firstMs || g.total === 1) g.firstMs = ms;
    if (ms > g.lastMs || g.total === 1) g.lastMs = ms;
    const rel = release ?? opts.release;
    if (rel && g.releases.length < MAX_RELEASES) {
      const r = clip(rel, 64);
      if (r && !g.releases.includes(r)) g.releases.push(r);
    }
    if (!g.service && (service ?? opts.service)) g.service = clip(service ?? opts.service, 64);
  };

  const judge = (g: Group, hits: number): Judgement => {
    if (g.noise || (g.kind === "message" && g.pathHits > 0 && g.pathHits === g.scannerHits)) return "noise";
    if (g.kind === "request" && g.status === 404 && g.nonBot === 0 && Object.keys(g.families).length > 0 && g.families.bot) return "noise";
    if (g.known !== undefined) return "known";
    const serious = (g.kind === "request" && (g.status ?? 0) >= 500) || g.level === "fatal";
    if (serious && hits >= ALARM_HITS) return "alarm";
    if (g.entering !== "new" && grows(g, hits)) return "alarm";
    if (g.entering === "back") return "back";
    if (g.entering === "new") return "new";
    return "seen";
  };

  const snapshot = (g: Group, hits: number, judgement: Judgement): Finding => {
    const f: Finding = {
      id: g.id, key: g.key, kind: g.kind, title: g.title, judgement, hits, total: g.total,
      counts: hits === g.hits && g.hits > 0 ? [...g.counts, hits].slice(-COUNT_BATCHES) : [...g.counts],
      firstSeen: new Date(g.firstMs).toISOString(), lastSeen: new Date(g.lastMs).toISOString(),
      releases: [...g.releases], sample: g.sample, backCount: g.backCount,
    };
    if (g.service) f.service = g.service;
    if (g.method) f.method = g.method;
    if (g.path) f.path = g.path;
    if (g.status) f.status = g.status;
    if (g.level) f.level = g.level;
    if (g.kind === "request") {
      f.families = { ...g.families };
      if (g.durN > 0) {
        f.avgMs = Math.round(g.durSum / g.durN);
        f.maxMs = Math.round(g.durMax);
      }
    }
    if (g.known !== undefined) f.known = g.known;
    return f;
  };

  const guard = <T>(fn: () => T): T | undefined => {
    try {
      return fn();
    } catch {
      counters.errors += 1;
      return undefined;
    }
  };

  const record = (rec: LogRecord): void => {
    if (stopped) return;
    if (busy) {
      counters.reentrant += 1;
      return;
    }
    guard(() => {
      if (!rec || typeof rec !== "object") return;
      counters.records += 1;
      windowRecords += 1;
      const level = normalizeLevel(rec.level);
      if (!levels.has(level)) {
        counters.ignored += 1;
        return;
      }
      const now = Date.now();
      const ms = toMs(rec.time, now);
      const text = lineText(rec.message);
      const key = `${level}|${messageKey(text, extra)}`.slice(0, MAX_KEY);
      let g = groups.get(key);
      if (!g) {
        g = open(key, () => {
          const title = key.slice(level.length + 1);
          const label = `${level.toUpperCase()} ${title}`;
          return { kind: "message" as const, title: title.slice(0, 200), level, noise: isNoise(label), sample: sampleOf(text, extra) };
        }, ms);
      }
      touch(g, ms, rec.release, rec.service);
      if (typeof rec.path === "string" && rec.path) {
        g.pathHits += 1;
        if (isScannerPath(rec.path)) g.scannerHits += 1;
      }
    });
  };

  const request = (req: RequestRecord): void => {
    if (stopped) return;
    if (busy) {
      counters.reentrant += 1;
      return;
    }
    guard(() => {
      if (!req || typeof req !== "object") return;
      counters.records += 1;
      windowRecords += 1;
      const status = Number(req.status);
      if (!Number.isFinite(status) || status < minStatus) {
        counters.ignored += 1;
        return;
      }
      const now = Date.now();
      const ms = toMs(req.time, now);
      const method = String(req.method ?? "GET").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 10) || "GET";
      const path = pathPattern(req.path);
      const key = `${method}|${path}|${status}`.slice(0, MAX_KEY);
      let g = groups.get(key);
      if (!g) {
        g = open(key, () => {
          const noise = (isScannerPath(path) && status < 500) || isNoise(`${method} ${path} ${status}`);
          return { kind: "request" as const, title: `${method} ${path} answers ${status}`.slice(0, 200), method, path, status, noise, sample: clip(`${method} ${typeof req.path === "string" ? req.path : ""}`, MAX_SAMPLE) };
        }, ms);
      }
      touch(g, ms, req.release, req.service);
      const fam = uaFamily(req.userAgent);
      g.families[fam] = (g.families[fam] ?? 0) + 1;
      if (fam !== "bot") g.nonBot += 1;
      const d = Number(req.durationMs);
      if (Number.isFinite(d) && d >= 0) {
        g.durN += 1;
        g.durSum += d;
        if (d > g.durMax) g.durMax = d;
      }
    });
  };

  const findings = (): Finding[] =>
    guard(() =>
      [...groups.values()]
        .sort((a, b) => b.lastMs - a.lastMs)
        .map((g) => (g.hits > 0 ? snapshot(g, g.hits, judge(g, g.hits)) : snapshot(g, 0, g.last))),
    ) ?? [];

  const mark = (id: string, m: MarkOptions): boolean =>
    guard(() => {
      const g = [...groups.values()].find((x) => x.id === id || x.key === id);
      const cur = { ...(marks.get(g?.id ?? id) ?? {}) };
      if (m && "known" in m) {
        if (typeof m.known === "string") cur.known = m.known.slice(0, 200);
        else delete cur.known;
      }
      if (m?.fixed) cur.fixed = true;
      if (!marks.has(g?.id ?? id) && marks.size >= MAX_MARKS) marks.delete(marks.keys().next().value as string);
      marks.set(g?.id ?? id, cur);
      if (g) {
        if (m && "known" in m) {
          if (typeof m.known === "string") g.known = m.known.slice(0, 200);
          else delete g.known;
        }
        if (m?.fixed) g.fixed = true;
        return true;
      }
      return false;
    }) ?? false;

  /** Keeps what a batch started (an async onBatch, a sending) until it is done, for `flush` to wait on. */
  const track = (p: Promise<unknown>): void => {
    const tracked: Promise<unknown> = p.finally(() => pending.delete(tracked));
    pending.add(tracked);
  };

  /** Ends the open window. */
  const runBatch = (): void => {
    if (busy) return;
    const now = Date.now();
    const out: Finding[] = [];
    const candidates: Candidate[] = [];
    const from = new Date(windowStart).toISOString();
    guard(() => {
      for (const g of groups.values()) {
        if (g.hits > 0) {
          const judgement = judge(g, g.hits);
          const f = snapshot(g, g.hits, judgement);
          out.push(f);
          candidates.push({ finding: f, state: g });
          g.last = judgement;
          g.counts = [...g.counts, g.hits].slice(-COUNT_BATCHES);
          g.hits = 0;
        } else g.counts = [...g.counts, 0].slice(-COUNT_BATCHES);
      }
      for (const [k, g] of groups) if (now - g.lastMs > FORGET_MS) groups.delete(k);
    });
    const batch: LogBatch = { from, to: new Date(now).toISOString(), records: windowRecords, findings: out, alarms: out.filter((f) => f.judgement === "alarm") };
    windowStart = now;
    windowRecords = 0;
    counters.batches += 1;
    if (out.length === 0) return;

    busy = true;
    try {
      const answer = opts.onBatch ? guard(() => opts.onBatch?.(batch) as unknown) : undefined;
      // An async onBatch: its rejection is counted here, never left to become an unhandled rejection of the app.
      if (typeof (answer as PromiseLike<unknown> | undefined)?.then === "function") track(Promise.resolve(answer as PromiseLike<unknown>).catch(() => void (counters.errors += 1)));
    } finally {
      busy = false;
    }
    if (!cloud) return;
    const p = guard(() => {
      const chosen = cloud.select(candidates, now);
      return cloud.send(chosen.map((c) => findingEvent(c.finding, { environment: undefined, release: opts.release })));
    });
    if (p) track(p.catch(() => false));
  };

  const startTimer = (): void => {
    timer = setInterval(() => void guard(runBatch), batchMs);
    (timer as { unref?: () => void }).unref?.();
  };
  guard(startTimer); // a runtime that refuses timers here (a worker's module scope) still gets `flush()`

  const flush = async (): Promise<void> => {
    try {
      guard(runBatch);
      await Promise.all([...pending]);
    } catch {
      // flush never rejects
    }
  };

  const stop = async (): Promise<void> => {
    if (stopped) return;
    await flush();
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    cloud?.close();
  };

  const stats = (): MonitorStats => ({
    ...counters,
    groups: groups.size,
    cloud: cloud ? cloud.counters() : { sent: 0, skipped: 0, today: 0 },
  });

  return { record, request, findings, mark, flush, stop, stats };
}
