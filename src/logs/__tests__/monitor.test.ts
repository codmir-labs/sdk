import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogMonitor } from "../monitor";
import type { LogBatch, LogMonitor } from "../types";

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 24, 9, 0, 0);

let monitors: LogMonitor[] = [];
const make = (o: Parameters<typeof createLogMonitor>[0] = {}): LogMonitor => {
  const m = createLogMonitor(o);
  monitors.push(m);
  return m;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(async () => {
  for (const m of monitors) await m.stop();
  monitors = [];
  vi.useRealTimers();
});

const err = (m: LogMonitor, message = "payment failed for order 8812"): void => m.record({ level: "error", message });
const hit = (m: LogMonitor, status = 500, path = "/api/orders/42"): void => m.request({ method: "GET", path, status, durationMs: 12 });

describe("what becomes a finding", () => {
  it("takes warning, error and fatal lines and status 400 and above; the rest only counts", () => {
    const m = make();
    m.record({ level: "info", message: "started" });
    m.record({ level: "debug", message: "x" });
    m.record({ level: "warn", message: "slow query" });
    m.record({ level: "error", message: "boom" });
    m.record({ level: "fatal", message: "dead" });
    m.request({ method: "GET", path: "/", status: 200 });
    m.request({ method: "GET", path: "/", status: 304 });
    m.request({ method: "GET", path: "/x", status: 404 });
    expect(m.findings()).toHaveLength(4);
    expect(m.stats()).toMatchObject({ records: 8, ignored: 4, groups: 4 });
  });

  it("takes other levels and another status floor when asked", () => {
    const m = make({ include: { levels: ["info", "error"], minStatus: 500 } });
    m.record({ level: "info", message: "hello" });
    m.record({ level: "warning", message: "no" });
    m.request({ method: "GET", path: "/x", status: 404 });
    m.request({ method: "GET", path: "/x", status: 503 });
    expect(m.findings().map((f) => f.kind).sort()).toEqual(["message", "request"]);
  });
});

describe("grouping", () => {
  it("folds numbers, ids, dates and quoted values into one group per message", () => {
    const m = make();
    err(m, 'user "ann" order 1 failed at 2026-01-01T00:00:00Z');
    err(m, 'user "bob" order 22 failed at 2026-02-02T10:10:10Z');
    err(m, "something else");
    const f = m.findings();
    expect(f).toHaveLength(2);
    expect(f.find((x) => x.total === 2)?.title).toBe("user [v] order # failed at [ts]");
  });

  it("groups a request by method, path pattern and status", () => {
    const m = make();
    hit(m, 500, "/api/orders/1?x=1");
    hit(m, 500, "/api/orders/2");
    hit(m, 502, "/api/orders/3");
    m.request({ method: "post", path: "/api/orders/3", status: 500 });
    const f = m.findings();
    expect(f).toHaveLength(3);
    expect(f.find((x) => x.status === 500 && x.method === "GET")).toMatchObject({ title: "GET /api/orders/:n answers 500", total: 2, hits: 2 });
  });

  it("keeps keys under 200 characters", () => {
    const m = make();
    m.request({ method: "GET", path: `/${"a".repeat(400)}`, status: 500 });
    m.record({ level: "error", message: "x ".repeat(600) });
    for (const f of m.findings()) expect(f.key.length).toBeLessThanOrEqual(200);
  });

  it("drops the quietest group at the limit and counts it", () => {
    const m = make({ limits: { groups: 3 } });
    for (let i = 0; i < 3; i++) m.record({ level: "error", message: "shape-a failed" }); // the busy one
    for (let i = 1; i < 5; i++) m.record({ level: "error", message: `shape-${"abcde"[i]} failed` });
    m.record({ level: "error", message: "shape-z failed" });
    expect(m.stats().groups).toBe(3);
    expect(m.stats().dropped).toBe(3);
    expect(m.findings().some((f) => f.title === "shape-a failed" && f.total >= 3)).toBe(true);
  });

  it("keeps one redacted sample, the user agent as a family, and no raw query", () => {
    const m = make();
    m.request({ method: "GET", path: "/a?token=SECRETVALUE1&e=jo@example.com", status: 500, userAgent: "Mozilla/5.0 Chrome/120 Safari/537" });
    const f = m.findings()[0];
    expect(JSON.stringify(f)).not.toMatch(/SECRETVALUE1|jo@x\.com|Mozilla/);
    expect(f.families).toEqual({ browser: 1 });
    expect(f.sample).toBe("GET /a?[q]");
  });
});

describe("batches and judging", () => {
  it("calls onBatch every batchMinutes with the findings and the alarms, and never keeps the process alive", async () => {
    const batches: LogBatch[] = [];
    const m = make({ onBatch: (b) => batches.push(b) });
    hit(m);
    hit(m);
    hit(m);
    err(m, "one off");
    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ records: 4, from: new Date(T0).toISOString(), to: new Date(T0 + 15 * MIN).toISOString() });
    expect(batches[0].findings.map((f) => f.judgement).sort()).toEqual(["alarm", "new"]);
    expect(batches[0].alarms).toHaveLength(1);
    expect(batches[0].alarms[0].title).toBe("GET /api/orders/:n answers 500");
    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(batches).toHaveLength(1); // an empty batch is not reported
    expect(vi.getTimerCount()).toBe(1);
  });

  it("judges new, then seen; a 5xx with fewer than 3 hits is only new", async () => {
    const m = make();
    hit(m);
    expect(m.findings()[0].judgement).toBe("new");
    await m.flush();
    hit(m);
    expect(m.findings()[0].judgement).toBe("seen");
  });

  it("alarms a fatal line with 3 hits, and a 4xx never", () => {
    const m = make();
    for (let i = 0; i < 3; i++) m.record({ level: "fatal", message: "db gone" });
    for (let i = 0; i < 9; i++) hit(m, 400);
    const by = Object.fromEntries(m.findings().map((f) => [f.title, f.judgement]));
    expect(by["db gone"]).toBe("alarm");
    expect(by["GET /api/orders/:n answers 400"]).toBe("new");
  });

  it("alarms a group at 10 times its usual", async () => {
    const m = make();
    for (let b = 0; b < 4; b++) {
      for (let i = 0; i < 2; i++) err(m, "slow thing");
      await m.flush();
    }
    for (let i = 0; i < 19; i++) err(m, "slow thing");
    expect(m.findings()[0].judgement).toBe("seen");
    err(m, "slow thing"); // 20 = 10 x the median of 2
    expect(m.findings()[0].judgement).toBe("alarm");
  });

  it("keeps the last 96 batch counts, first and last seen, releases and one sample", async () => {
    const m = make({ release: "1.0.0" });
    for (let b = 0; b < 100; b++) {
      m.record({ level: "error", message: "again", release: b < 50 ? "1.0.0" : "1.0.1" });
      await vi.advanceTimersByTimeAsync(15 * MIN);
    }
    const f = m.findings()[0];
    expect(f.counts).toHaveLength(96);
    expect(f.total).toBe(100);
    expect(f.releases).toEqual(["1.0.0", "1.0.1"]);
    expect(Date.parse(f.firstSeen)).toBe(T0);
    expect(Date.parse(f.lastSeen)).toBe(T0 + 99 * 15 * MIN);
    expect(f.sample).toBe("again");
  });

  it("judges back after 24 quiet hours", async () => {
    const m = make();
    err(m);
    await m.flush();
    await vi.advanceTimersByTimeAsync(23 * 3_600_000);
    err(m);
    expect(m.findings()[0]).toMatchObject({ judgement: "seen", backCount: 0 });
    await m.flush();
    await vi.advanceTimersByTimeAsync(25 * 3_600_000);
    err(m);
    expect(m.findings()[0]).toMatchObject({ judgement: "back", backCount: 1 });
  });

  it("uses the record's own time for first and last seen", () => {
    const m = make();
    m.record({ level: "error", message: "old", time: "2026-11-24T08:00:00Z" });
    m.record({ level: "error", message: "old", time: new Date("2026-11-24T08:30:00Z") });
    expect(m.findings()[0]).toMatchObject({ firstSeen: "2026-11-24T08:00:00.000Z", lastSeen: "2026-11-24T08:30:00.000Z" });
  });
});

describe("mark", () => {
  it("fixed: the next hit is back", async () => {
    const m = make();
    err(m);
    await m.flush();
    const id = m.findings()[0].id;
    expect(m.mark(id, { fixed: true })).toBe(true);
    err(m);
    expect(m.findings()[0]).toMatchObject({ judgement: "back", backCount: 1 });
    await m.flush();
    err(m);
    expect(m.findings()[0].judgement).toBe("seen"); // the mark is used up
  });

  it("known: the finding is known with its note, until cleared; a mark made early applies later", () => {
    const m = make();
    expect(m.mark("deadbeef", { known: "https://example.com/issue/1" })).toBe(false);
    err(m);
    const f = m.findings()[0];
    expect(m.mark(f.id, { known: "see the wiki" })).toBe(true);
    expect(m.findings()[0]).toMatchObject({ judgement: "known", known: "see the wiki" });
    m.mark(f.id, { known: false });
    expect(m.findings()[0].judgement).toBe("new");
    const m2 = make();
    m2.mark("GET|/api/orders/:n|500", { known: "ticket" });
    hit(m2);
    expect(m2.findings()[0]).toMatchObject({ judgement: "known", known: "ticket" });
  });
});

describe("noise", () => {
  it("judges scanner probes noise, but a 5xx on such a path is not", () => {
    const m = make();
    for (const p of ["/wp-login.php", "/.env", "/.git/config", "/xmlrpc.php", "/phpmyadmin/index.php"]) m.request({ method: "GET", path: p, status: 404 });
    m.request({ method: "GET", path: "/wp-admin/x.php", status: 500 });
    const j = m.findings().map((f) => f.judgement);
    expect(j.filter((x) => x === "noise")).toHaveLength(5);
    expect(j.filter((x) => x !== "noise")).toHaveLength(1);
  });

  it("judges bots on 404s noise, and a log line logged under a scanner path", () => {
    const m = make();
    m.request({ method: "GET", path: "/nothing", status: 404, userAgent: "Googlebot/2.1" });
    m.request({ method: "GET", path: "/other", status: 404, userAgent: "Mozilla/5.0 Chrome/1 Safari/1" });
    m.record({ level: "error", message: "not found", path: "/wp-login.php" });
    expect(m.findings().map((f) => f.judgement).sort()).toEqual(["new", "noise", "noise"]);
  });

  it("takes your own noise patterns", () => {
    const m = make({ noise: ["/healthz", /^ERROR socket hang up/] });
    m.request({ method: "GET", path: "/healthz", status: 503 });
    m.record({ level: "error", message: "socket hang up" });
    m.record({ level: "error", message: "real problem" });
    expect(m.findings().map((f) => f.judgement).sort()).toEqual(["new", "noise", "noise"]);
  });
});

describe("it never hurts the app", () => {
  it("does not throw for any input", async () => {
    const m = make({ onBatch: () => { throw new Error("mine"); } });
    const junk: unknown[] = [undefined, null, 0, "x", [], {}, { level: 5 }, { level: "error", message: {} }, { level: "error", message: null }, { method: 5, path: {}, status: "x" }, { method: "GET", path: null, status: 500 }, { level: "error", message: "m", time: "not a time" }];
    for (const j of junk) {
      expect(() => m.record(j as never)).not.toThrow();
      expect(() => m.request(j as never)).not.toThrow();
      expect(() => m.mark(j as never, j as never)).not.toThrow();
    }
    err(m);
    await expect(m.flush()).resolves.toBeUndefined();
    expect(m.stats().errors).toBeGreaterThan(0); // onBatch threw, and it stayed there
    expect(() => m.findings()).not.toThrow();
  });

  it("skips what the app logs inside onBatch instead of recursing", async () => {
    let calls = 0;
    const m: LogMonitor = make({ onBatch: () => { calls++; m.record({ level: "error", message: "logged from onBatch" }); m.request({ method: "GET", path: "/in-batch", status: 500 }); } });
    err(m);
    await m.flush();
    expect(calls).toBe(1);
    expect(m.stats().reentrant).toBe(2);
    expect(m.findings().map((f) => f.title)).not.toContain("logged from onBatch");
  });

  it("ignores everything after stop, and a second stop is harmless", async () => {
    const m = make();
    err(m);
    await m.stop();
    err(m, "late");
    await m.stop();
    expect(m.findings().map((f) => f.title)).toEqual(["payment failed for order #"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("holds bounded memory: 20,000 distinct lines leave at most the group limit", () => {
    const m = make();
    for (let i = 0; i < 20_000; i++) m.record({ level: "error", message: `distinct-${i.toString(36)}-word failed` });
    expect(m.stats().groups).toBeLessThanOrEqual(500);
  });
});
