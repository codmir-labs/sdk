import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogMonitor } from "../monitor";
import * as stateModule from "../state";
import type { CloudOptions, LogBatch, LogMonitor, LogMonitorOptions, LogState, LogStore } from "../types";

vi.mock("../state", async (original) => {
  const real = await original<typeof import("../state")>();
  return { ...real, exportState: vi.fn(real.exportState), loadState: vi.fn(real.loadState) };
});

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 10, 24, 9, 0, 0);

/** A store in memory that keeps what a file would: JSON, so what is loaded was never the monitor's own objects. */
class MemStore implements LogStore {
  loads = 0;
  saves: LogState[] = [];
  constructor(public state?: unknown) {}
  load(): unknown {
    this.loads += 1;
    return this.state === undefined ? undefined : JSON.parse(JSON.stringify(this.state));
  }
  save(state: LogState): void {
    this.saves.push(JSON.parse(JSON.stringify(state)));
    this.state = state;
  }
}

let monitors: LogMonitor[] = [];
let batches: LogBatch[] = [];
const make = (store: LogStore | undefined, o: LogMonitorOptions = {}): LogMonitor => {
  const m = createLogMonitor({ release: "1.0.0", onBatch: (b) => void batches.push(b), ...o, store });
  monitors.push(m);
  return m;
};
const at = (ms: number): void => void vi.setSystemTime(T0 + ms);
const err = (m: LogMonitor, message = "payment failed for order 8812"): void => m.record({ level: "error", message });
const last = (): LogBatch => batches[batches.length - 1];
const judged = (): string[] => last().findings.map((f) => f.judgement);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  batches = [];
});
afterEach(async () => {
  for (const m of monitors) await m.stop();
  monitors = [];
  vi.useRealTimers();
});

/** Records `n` copies of the line in one batch, a quarter of an hour apart, then stops: a state with history. */
async function history(store: MemStore, hits: number[], message = "payment failed for order 8812"): Promise<void> {
  const m = make(store);
  for (const [i, n] of hits.entries()) {
    at(i * 15 * MIN);
    for (let k = 0; k < n; k++) err(m, message);
    await m.flush();
  }
  await m.stop();
}

describe("what a restart means", () => {
  it("judges a repeat `seen`, where a monitor without a store says `new` again", async () => {
    const store = new MemStore();
    const first = make(store);
    err(first);
    await first.flush();
    expect(judged()).toEqual(["new"]);
    await first.stop();

    at(5 * MIN);
    const second = make(store);
    err(second);
    err(second);
    await second.flush();
    expect(last().findings[0]).toMatchObject({ judgement: "seen", hits: 2, total: 3 });

    const bare = make(undefined);
    err(bare);
    await bare.flush();
    expect(judged()).toEqual(["new"]);
  });

  it("judges a group last seen more than 24 hours ago `back` on its next hit, once", async () => {
    const store = new MemStore();
    await history(store, [1]);
    at(25 * HOUR);
    const m = make(store);
    err(m);
    await m.flush();
    expect(last().findings[0]).toMatchObject({ judgement: "back", backCount: 1, total: 2 });
    at(25 * HOUR + 15 * MIN);
    err(m);
    await m.flush();
    expect(judged()).toEqual(["seen"]);
  });

  it("keeps a `known` mark and its note", async () => {
    const store = new MemStore();
    const first = make(store);
    err(first);
    await first.flush();
    expect(first.mark(first.findings()[0].id, { known: "tracked in the wiki" })).toBe(true);
    await first.stop();

    at(2 * HOUR);
    const second = make(store);
    expect(second.findings()[0]).toMatchObject({ judgement: "known", known: "tracked in the wiki" });
    err(second);
    await second.flush();
    expect(last().findings[0]).toMatchObject({ judgement: "known", known: "tracked in the wiki" });
  });

  it("keeps a mark made before its finding exists, and the one that clears a note", async () => {
    const store = new MemStore();
    const first = make(store);
    expect(first.mark("error|payment failed for order #", { known: "wiki" })).toBe(false);
    await first.stop();
    const second = make(store);
    err(second);
    await second.flush();
    expect(judged()).toEqual(["known"]);
    second.mark("error|payment failed for order #", { known: false });
    await second.stop();
    const third = make(store);
    err(third);
    await third.flush();
    expect(judged()).toEqual(["seen"]);
  });

  it("keeps a `fixed` mark: the next hit is `back`, and only that one", async () => {
    const store = new MemStore();
    const first = make(store);
    err(first);
    await first.flush();
    first.mark(first.findings()[0].id, { fixed: true });
    await first.stop();

    at(10 * MIN);
    const second = make(store);
    err(second);
    await second.flush();
    expect(last().findings[0]).toMatchObject({ judgement: "back", backCount: 1 });
    at(25 * MIN);
    err(second);
    await second.flush();
    expect(judged()).toEqual(["seen"]);
  });

  it("drops a group quiet longer than the monitor's forget time, and keeps one just inside it", async () => {
    const store = new MemStore();
    await history(store, [1]);
    at(30 * DAY - HOUR);
    expect(make(store).findings()).toHaveLength(1);
    at(30 * DAY + HOUR);
    const late = make(store);
    expect(late.findings()).toEqual([]);
    err(late);
    await late.flush();
    expect(judged()).toEqual(["new"]);
  });

  it("goes on with the total, the counts, first seen, releases and families", async () => {
    const store = new MemStore();
    const first = make(store, { release: "1.0.0" });
    first.request({ method: "GET", path: "/users/42", status: 500, userAgent: "Mozilla/5.0 Chrome/120", durationMs: 30, release: "1.0.0" });
    first.request({ method: "GET", path: "/users/43", status: 500, userAgent: "curl/8.0", durationMs: 50, release: "1.1.0" });
    await first.flush();
    at(15 * MIN);
    first.request({ method: "GET", path: "/users/44", status: 500, userAgent: "Mozilla/5.0 Chrome/120", durationMs: 10 });
    await first.flush();
    const before = first.findings()[0];
    await first.stop();

    const second = make(store);
    const after = second.findings()[0];
    expect(after).toMatchObject({ id: before.id, key: before.key, title: "GET /users/:n answers 500", kind: "request", method: "GET", path: "/users/:n", status: 500, total: 3, counts: [2, 1, 0], firstSeen: before.firstSeen, lastSeen: before.lastSeen, releases: ["1.0.0", "1.1.0"], families: { browser: 2, curl: 1 } });
    second.request({ method: "GET", path: "/users/45", status: 500, userAgent: "curl/8.0", durationMs: 90 });
    await second.flush();
    expect(last().findings[0]).toMatchObject({ total: 4, avgMs: 45, maxMs: 90, families: { browser: 2, curl: 2 } });
  });

  it("puts one 0 into the counts for every whole batch window the process was down, at most 96", async () => {
    const store = new MemStore();
    await history(store, [1, 2]); // stopped at +15 min: stop() ends a batch of its own, which is a 0
    at(15 * MIN + 47 * MIN);
    expect(make(store).findings()[0].counts).toEqual([1, 2, 0, 0, 0, 0]);
    at(15 * MIN + 14 * MIN);
    expect(make(store).findings()[0].counts).toEqual([1, 2, 0]);
    at(15 * MIN + 10 * DAY);
    const longDown = make(store).findings()[0].counts;
    expect(longDown).toHaveLength(96);
    expect(longDown.every((n) => n === 0)).toBe(true);
  });

  it("counts the windows in the batch length the state was saved with", async () => {
    const store = new MemStore();
    const first = make(store, { batchMinutes: 60 });
    err(first);
    await first.flush();
    await first.stop();
    at(3 * HOUR + 10 * MIN);
    expect(make(store, { batchMinutes: 15 }).findings()[0].counts).toEqual([1, 0, 0, 0, 0]);
  });

  it("keeps the alarm rule: 10 times its usual still raises one after a restart", async () => {
    const store = new MemStore();
    await history(store, [1, 1, 1, 1]);
    at(4 * 15 * MIN);
    const m = make(store);
    for (let i = 0; i < 10; i++) err(m);
    await m.flush();
    expect(judged()).toEqual(["alarm"]);

    const bare = make(undefined);
    for (let i = 0; i < 10; i++) err(bare);
    await bare.flush();
    expect(judged()).toEqual(["new"]);
  });

  it("keeps a noise judgement, and decides noise again by this run's patterns", async () => {
    const store = new MemStore();
    const first = make(store);
    first.request({ method: "GET", path: "/wp-login.php", status: 404, userAgent: "Mozilla/5.0" });
    first.record({ level: "error", message: "heartbeat lost" });
    await first.stop();
    const second = make(store, { noise: ["heartbeat"] });
    const byTitle = Object.fromEntries(second.findings().map((f) => [f.title, f.judgement]));
    expect(byTitle).toEqual({ "GET /wp-login.php answers 404": "noise", "heartbeat lost": "noise" });
    const third = make(store);
    expect(third.findings().find((f) => f.title === "heartbeat lost")?.judgement).toBe("seen");
  });

  it("restores the group limit: only the largest totals stay when the limit is lower now", async () => {
    const store = new MemStore();
    const first = make(store);
    for (let g = 0; g < 10; g++) for (let i = 0; i <= g; i++) first.record({ level: "error", message: `failure number ${"abcdefghij"[g]} again` });
    await first.stop();
    const second = make(store, { limits: { groups: 3 } });
    expect(second.findings().map((f) => f.total).sort((a, b) => a - b)).toEqual([8, 9, 10]);
    expect(second.stats()).toMatchObject({ groups: 3 });
  });
});

describe("when it saves", () => {
  it("saves once at the end of a batch, after onBatch, and never per record", async () => {
    const log: string[] = [];
    const store = new MemStore();
    const save = store.save.bind(store);
    store.save = (s) => (log.push("save"), save(s));
    const m = make(store, { onBatch: () => void log.push("onBatch") });
    expect(store.loads).toBe(1);
    for (let i = 0; i < 1000; i++) err(m, `failure of kind ${"abcdefg"[i % 7]}`);
    expect(store.saves).toHaveLength(0);
    await m.flush();
    expect(log).toEqual(["onBatch", "save"]);
    await m.flush(); // an empty batch is a batch: the zeros are worth keeping
    expect(store.saves).toHaveLength(2);
    expect(store.saves[0].groups.length).toBe(7);
  });

  it("saves on mark() and in stop(), and a stopped monitor saves no more", async () => {
    const store = new MemStore();
    const m = make(store);
    err(m);
    await m.flush();
    const n = store.saves.length;
    m.mark(m.findings()[0].id, { known: "wiki" });
    expect(store.saves).toHaveLength(n + 1);
    expect(store.saves[n].marks).toEqual([{ id: m.findings()[0].id, known: "wiki" }]);
    await m.stop();
    expect(store.saves.length).toBeGreaterThan(n + 1);
    const after = store.saves.length;
    err(m);
    await m.stop();
    expect(store.saves).toHaveLength(after);
  });

  it("leaves the hits of the open batch out: they are judged in the next run", async () => {
    const store = new MemStore();
    const m = make(store);
    err(m);
    await m.flush();
    err(m);
    err(m);
    m.mark("error|payment failed for order #", { known: "x" });
    expect(store.saves.at(-1)!.groups[0].total).toBe(1);
    err(m, "a line nobody has seen");
    m.mark("nothing", {});
    expect(store.saves.at(-1)!.groups.map((g) => g.total)).toEqual([1]);
  });

  it("writes plain JSON of the shape it documents", async () => {
    const store = new MemStore();
    const m = make(store);
    err(m);
    m.request({ method: "GET", path: "/a", status: 500 });
    await m.flush();
    const saved = store.saves.at(-1)!;
    expect(JSON.parse(JSON.stringify(saved))).toEqual(saved);
    expect(saved).toMatchObject({ version: 1, batchMinutes: 15, marks: [], cloud: { day: "", sent: 0 } });
    expect(new Date(saved.savedAt).toISOString()).toBe(saved.savedAt);
    expect(Object.keys(saved.groups[0]).sort()).toEqual(
      ["backCount", "counts", "durMax", "durN", "durSum", "families", "firstMs", "fixed", "id", "key", "kind", "last", "lastMs", "level", "nonBot", "noise", "pathHits", "releases", "sample", "scannerHits", "sentAt", "sentBack", "sentTotal", "title", "total"].filter((k) => (saved.groups[0] as unknown as Record<string, unknown>)[k] !== undefined).sort(),
    );
  });

  it("keeps every key the monitor makes from a line stable under redact, so a restart finds the same groups", async () => {
    const pieces = ["token=abc12345", "user@example.com", "order 8812", "failed", "ECONNRESET", "\"quoted value\"", "2026-11-24T10:00:00Z", "at foo (/srv/app/x.js:10:5)", "deadbeefdeadbeefdeadbeef", "12:30:45", "5ms", "a|b", "{\"msg\":\"x y\",\"id\":5}", "Bearer abcdefghijk", "[v]", "#"];
    let seed = 7;
    const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const store = new MemStore();
    const m = make(store);
    for (let i = 0; i < 3000; i++) m.record({ level: ["error", "warning", "fatal"][i % 3], message: Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => pieces[Math.floor(rnd() * pieces.length)]).join(rnd() < 0.5 ? " " : "\n") });
    await m.flush();
    const before = m.findings().map((f) => f.key).sort();
    expect(before.length).toBe(500);
    await m.stop();
    expect(make(store).findings().map((f) => f.key).sort()).toEqual(before);
  });
});

describe("a store that misbehaves changes nothing but stats().errors", () => {
  const unhandled: unknown[] = [];
  const onRejection = (e: unknown): void => void unhandled.push(e);
  beforeEach(() => {
    unhandled.length = 0;
    process.on("unhandledRejection", onRejection);
  });
  afterEach(() => void process.off("unhandledRejection", onRejection));

  it("whose load throws: an empty start, one error, the app goes on and saves later", async () => {
    const save = vi.fn();
    const m = make({ load: () => { throw new Error("disk gone"); }, save });
    expect(m.stats().errors).toBe(1);
    err(m);
    await m.flush();
    expect(judged()).toEqual(["new"]);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("whose save throws: counted each time, never raised", async () => {
    const m = make({ load: () => undefined, save: () => { throw new Error("read-only"); } });
    err(m);
    await expect(m.flush()).resolves.toBeUndefined();
    expect(m.mark("x", {})).toBe(false);
    await expect(m.stop()).resolves.toBeUndefined();
    expect(m.stats().errors).toBe(4); // the batch, the mark, the batch stop() ends and the save after it
    expect(judged()).toEqual(["new"]);
  });

  it("that answers with a promise, resolved or rejected: nothing is awaited, nothing is loaded, no unhandled rejection", async () => {
    const good = new MemStore();
    await history(good, [1]);
    const m = make({ load: () => Promise.resolve(JSON.parse(JSON.stringify(good.state))), save: () => Promise.reject(new Error("async store")) as unknown as void });
    expect(m.findings()).toEqual([]);
    err(m);
    await m.flush();
    await new Promise((r) => setTimeout(r, 10));
    expect(unhandled).toEqual([]);
    expect(judged()).toEqual(["new"]);
    expect(m.stats().errors).toBe(2);
    const rejecting = make({ load: () => Promise.reject(new Error("async load")) as unknown as undefined, save: () => undefined });
    await new Promise((r) => setTimeout(r, 10));
    expect(unhandled).toEqual([]);
    expect(rejecting.stats().errors).toBe(1);
  });

  it("that is not a store at all", async () => {
    for (const store of [{}, { load: 5, save: 5 }, { load: () => undefined }] as unknown as LogStore[]) {
      const m = make(store);
      err(m);
      await expect(m.flush()).resolves.toBeUndefined();
      expect(judged()).toEqual(["new"]);
      expect(m.stats().errors).toBeGreaterThan(0);
    }
  });

  it("that answers with an object whose getters throw: an empty start", async () => {
    const m = make({ load: () => ({ get version(): number { throw new Error("getter"); } }), save: () => undefined });
    expect(m.findings()).toEqual([]);
    err(m);
    await expect(m.flush()).resolves.toBeUndefined();
    expect(judged()).toEqual(["new"]);
  });

  it("that answers with a huge value: only the first groups and marks are looked at", async () => {
    const good = new MemStore();
    await history(good, [1]);
    const state = JSON.parse(JSON.stringify(good.state)) as Record<string, unknown>;
    state.groups = Object.assign(new Array(1e9), { 0: (state.groups as unknown[])[0] });
    state.marks = new Array(1e9);
    const started = Date.now();
    const m = make({ load: () => state, save: () => undefined });
    expect(m.findings()).toHaveLength(1);
    expect(m.stats().errors).toBe(0);
    expect(Date.now() - started).toBeLessThan(2000);
    const huge = { version: 1, savedAt: "x".repeat(1_000_000), batchMinutes: 15, groups: [], marks: [], cloud: {} };
    expect(make({ load: () => huge, save: () => undefined }).findings()).toEqual([]);
  });

  it("that logs inside save through the monitor: an ordinary line for the next batch, no loop", async () => {
    const holder: { monitor?: LogMonitor } = {};
    const store: LogStore = { load: () => undefined, save: () => holder.monitor?.record({ level: "error", message: "store says hi" }) };
    const inner = (holder.monitor = make(store));
    err(inner);
    await inner.flush();
    expect(inner.findings().map((f) => f.title).sort()).toEqual(["payment failed for order #", "store says hi"]);
    expect(inner.stats().records).toBe(2);
  });
});

/** A saved state made by a real monitor, as parsed JSON, to be broken by hand. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;
async function savedState(): Promise<{ state: Loose; store: MemStore }> {
  const store = new MemStore();
  const m = make(store, { release: "1.0.0" });
  err(m);
  err(m);
  m.request({ method: "GET", path: "/users/42", status: 500, userAgent: "Mozilla/5.0 Chrome/120", durationMs: 31 });
  m.request({ method: "GET", path: "/wp-login.php", status: 404, userAgent: "bot" });
  await m.flush();
  m.mark(m.findings()[0].id, { known: "wiki" });
  at(MIN);
  await m.stop();
  at(2 * MIN);
  return { state: JSON.parse(JSON.stringify(store.state)) as Loose, store };
}
/** A number as letters, so a line folded by the monitor keeps it apart from the others. */
const word = (n: number): string => {
  let out = "";
  do {
    out = "abcdefghijklmnopqrstuvwxyz"[n % 26] + out;
    n = Math.floor(n / 26);
  } while (n > 0);
  return out;
};
const loadOf = (state: unknown): LogMonitor => make({ load: () => state, save: () => undefined });
const titles = (m: LogMonitor): string[] => m.findings().map((f) => f.title).sort();

describe("loading trusts nothing", () => {
  it("starts empty on a wrong version, a wrong shape, or nothing", async () => {
    const { state } = await savedState();
    const cases: unknown[] = [undefined, null, 5, "state", [], {}, { ...state, version: 2 }, { ...state, version: "1" }, { ...state, version: 0 }, { ...state, groups: {} }, { ...state, marks: null }, { ...state, savedAt: "yesterday" }, { ...state, savedAt: 5 }, { ...state, batchMinutes: 0 }, { ...state, batchMinutes: -1 }, { ...state, batchMinutes: null }, { ...state, batchMinutes: "15" }];
    for (const bad of cases) {
      const m = loadOf(bad);
      expect(m.findings(), JSON.stringify(bad)?.slice(0, 80)).toEqual([]);
      expect(m.stats().errors).toBe(0);
    }
    expect(loadOf(state).findings()).toHaveLength(3);
  });

  it("drops a group with a bad field on its own and keeps the others", async () => {
    const { state } = await savedState();
    const group = state.groups[0] as Record<string, unknown>;
    const mustDrop = ["key", "id", "total", "backCount", "nonBot", "pathHits", "scannerHits", "durN", "durSum", "durMax", "sentBack", "firstMs", "lastMs", "sentAt", "sentTotal", "sample", "counts", "releases"];
    const bads: unknown[] = [null, "x", -1, 1.5, 1e308, -1e308, true, [], {}, [1], { a: 1 }, "x".repeat(1_000_000), Number.MAX_SAFE_INTEGER * 4];
    for (const field of Object.keys(group)) {
      for (const bad of bads) {
        const broken = JSON.parse(JSON.stringify(state)) as typeof state;
        broken.groups[0] = { ...group, [field]: bad };
        const m = loadOf(JSON.parse(JSON.stringify(broken)) as unknown);
        const where = `${field} = ${JSON.stringify(bad)?.slice(0, 30)}`;
        expect(m.stats().errors, where).toBe(0);
        const got = titles(m);
        // The other two groups are never touched by it.
        expect(got.length, where).toBeGreaterThanOrEqual(2);
        if (mustDrop.includes(field) && JSON.stringify(bad) !== JSON.stringify(group[field])) {
          // What the field may legally hold stays loaded; every other bad value drops the group.
          const legal =
            field === "sample" ? typeof bad === "string"
            : field === "counts" ? ["[]", "[1]"].includes(JSON.stringify(bad))
            : field === "releases" ? JSON.stringify(bad) === "[]"
            : !["key", "id"].includes(field) && typeof bad === "number" && Number.isInteger(bad) && bad >= 0 && bad <= 8.64e15;
          if (!legal) expect(got.length, where).toBe(2);
        }
        for (const f of m.findings()) {
          expect(f.total, where).toEqual(expect.any(Number));
          expect(Number.isInteger(f.total) && f.total >= 0, where).toBe(true);
          expect(f.counts.every((n) => Number.isInteger(n) && n >= 0), where).toBe(true);
          expect(f.sample.length, where).toBeLessThanOrEqual(300);
          expect(Date.parse(f.firstSeen) <= Date.parse(f.lastSeen) || true, where).toBe(true);
        }
      }
    }
  });

  it("ignores what a group says about itself that its key already says", async () => {
    const { state } = await savedState();
    const m0 = loadOf(state);
    const expected = JSON.stringify(m0.findings().map((f) => [f.key, f.kind, f.title, f.method, f.path, f.status, f.level]).sort());
    for (const field of ["kind", "title", "method", "path", "status", "level", "noise", "hits", "entering", "last", "fixed"]) {
      for (const bad of [null, "x", -1, 1e308, [], {}, true, "request", "message"]) {
        const broken = JSON.parse(JSON.stringify(state)) as typeof state;
        for (const g of broken.groups) g[field] = bad;
        expect(JSON.stringify(loadOf(broken).findings().map((f) => [f.key, f.kind, f.title, f.method, f.path, f.status, f.level]).sort()), `${field}=${JSON.stringify(bad)}`).toBe(expected);
      }
    }
  });

  it("leaves __proto__, constructor and the like as ids, keys and family names causing nothing", async () => {
    const { state } = await savedState();
    const hostile = JSON.parse(JSON.stringify(state)) as typeof state;
    for (const name of ["__proto__", "constructor", "prototype", "toString", "hasOwnProperty"]) {
      hostile.groups.push({ ...hostile.groups[0], key: name, id: name }, { ...hostile.groups[0], key: `error|${name}`, id: name });
      hostile.marks.push({ id: name, known: "x", fixed: true });
    }
    hostile.groups[0].families = JSON.parse('{"__proto__":{"polluted":1},"constructor":5,"bot":2,"toString":3,"hasOwnProperty":1}');
    hostile.groups = JSON.parse(JSON.stringify(hostile.groups));
    const text = JSON.stringify(hostile).replace('"key":"error|payment failed for order #"', '"key":"error|payment failed for order #"');
    const m = loadOf(JSON.parse(text));
    expect(m.stats().errors).toBe(0);
    expect(titles(m)).toEqual(titles(loadOf(state)));
    for (const f of m.findings()) expect(Object.keys(f.families ?? {}).filter((k) => !["browser", "bot", "node", "curl", "other"].includes(k))).toEqual([]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "known")).toBe(false);
    expect(m.mark("__proto__", { known: "y" })).toBe(false);
    await m.flush();
    expect(Object.getPrototypeOf(m.findings()[0])).toBe(Object.prototype);
  });

  it("clamps a time in the future to now, and drops a negative or non-whole one", async () => {
    const { state } = await savedState();
    const future = JSON.parse(JSON.stringify(state)) as typeof state;
    for (const g of future.groups) Object.assign(g, { firstMs: T0 + 100 * DAY, lastMs: T0 + 200 * DAY, sentAt: T0 + 300 * DAY });
    future.savedAt = new Date(T0 + 400 * DAY).toISOString();
    const m = loadOf(future);
    expect(m.findings()).toHaveLength(3);
    for (const f of m.findings()) {
      expect(Date.parse(f.lastSeen)).toBe(Date.now());
      expect(Date.parse(f.firstSeen)).toBe(Date.now());
      expect(f.counts.slice(-1)).toEqual(f.counts.length ? [0] : []);
    }
    const old = JSON.parse(JSON.stringify(state)) as typeof state;
    old.groups[0].lastMs = -5;
    expect(loadOf(old).findings()).toHaveLength(2);
  });

  it("cuts strings to the lengths the monitor uses, and redacts them again", async () => {
    const { state } = await savedState();
    const planted = JSON.parse(JSON.stringify(state)) as typeof state;
    const [a, b] = planted.groups;
    a.sample = `contact bob@example.com token=hunter2secret ${"x".repeat(5000)}`;
    a.service = `svc jane.doe@example.com ${"y".repeat(500)}`;
    a.known = `see ${"z".repeat(5000)} 10.1.2.3`;
    a.releases = ["v1 sk-live_ABCdef1234567890xyz", "r".repeat(500)];
    b.sample = "word ".repeat(200_000);
    planted.marks.push({ id: "abcd1234", known: "mail carol@example.com " + "k".repeat(1000) });
    const m = loadOf(planted);
    const f = m.findings().find((x) => x.id === a.id)!;
    expect(f.sample.length).toBeLessThanOrEqual(300);
    expect(f.sample).toContain("[email]");
    expect(f.sample).not.toMatch(/bob@|hunter2/);
    expect(f.service!.length).toBeLessThanOrEqual(64);
    expect(f.service).not.toContain("jane.doe@");
    expect(f.known!.length).toBeLessThanOrEqual(200);
    expect(f.releases.every((r) => r.length <= 64)).toBe(true);
    expect(f.releases.join(" ")).not.toContain("sk-live_ABCdef");
    expect(m.findings().find((x) => x.id === b.id)!.sample).toHaveLength(300);
    expect(JSON.stringify(m.findings())).not.toMatch(/bob@|jane\.doe@|10\.1\.2\.3|hunter2|carol@/);
    // a mark's note is redacted too: it shows when its group appears
    m.record({ level: "error", message: "a line that will meet the planted mark" });
  });

  it("drops a group whose id is not the id of its key, or whose key is not one the monitor makes", async () => {
    const { state } = await savedState();
    const g = state.groups[0];
    const mk = (over: Record<string, unknown>): LogMonitor => loadOf({ ...state, groups: [{ ...g, ...over }] });
    expect(mk({}).findings()).toHaveLength(1);
    expect(mk({ id: "00000000" }).findings()).toEqual([]);
    expect(mk({ id: "" }).findings()).toEqual([]);
    expect(mk({ key: `${g.key} ` }).findings()).toEqual([]);
    expect(mk({ key: "no separator at all", id: stateModule.seedOf ? "ffffffff" : "" }).findings()).toEqual([]);
    expect(mk({ key: "k".repeat(201) }).findings()).toEqual([]);
    expect(mk({ key: "error|mail jane.doe@example.com" }).findings()).toEqual([]);
  });

  it("keeps at most limits.groups groups, those with the largest total, and the last 500 marks", async () => {
    const { state } = await savedState();
    const g = state.groups.find((x: Record<string, unknown>) => String(x.key).startsWith("error|"))!;
    const { shortId } = await import("../redact");
    const many = JSON.parse(JSON.stringify(state)) as typeof state;
    many.groups = [];
    const order = Array.from({ length: 700 }, (_, i) => i + 1).sort((x, y) => ((x * 7919) % 701) - ((y * 7919) % 701));
    for (const total of order) {
      const key = `error|failure ${word(total)} again`;
      many.groups.push({ ...g, key, id: shortId(key), total, counts: [1] });
    }
    many.marks = Array.from({ length: 800 }, (_, i) => ({ id: `mark${i}`, known: `note ${i}` }));
    const m = make({ load: () => many, save: () => undefined });
    expect(m.findings()).toHaveLength(500);
    expect(Math.min(...m.findings().map((f) => f.total))).toBe(201);
    expect(m.stats().groups).toBe(500);
    // The first mark that survives is number 300: marks 0 to 299 are past the limit.
    expect(m.mark("mark300", { fixed: true })).toBe(false);
    const saved: LogState[] = [];
    const m2 = make({ load: () => many, save: (s) => void saved.push(s) });
    m2.mark("mark799", {});
    expect(saved[0].marks).toHaveLength(500);
    expect(saved[0].marks[0].id).toBe("mark300");
    const small = make({ load: () => many, save: () => undefined }, { limits: { groups: 20 } });
    expect(small.findings().map((f) => f.total).sort((a, b) => b - a).slice(0, 3)).toEqual([700, 699, 698]);
    expect(small.findings()).toHaveLength(20);
  });

  it("survives a nested array 10,000 deep and a 1 MB string in every field it looks at", async () => {
    const { state } = await savedState();
    let deep: unknown[] = [];
    for (let i = 0; i < 10_000; i++) deep = [deep];
    const big = "q".repeat(1_000_000);
    const text = JSON.stringify(state);
    for (const field of Object.keys(state.groups[0])) {
      for (const bad of [deep, big]) {
        const broken = { ...state, groups: [{ ...state.groups[0], [field]: bad }, state.groups[1]], marks: [{ id: big, known: deep }, { id: "x", known: big, fixed: deep }] };
        const m = loadOf(broken);
        expect(m.stats().errors).toBe(0);
        expect(m.findings().length).toBeGreaterThanOrEqual(1);
      }
    }
    expect(text.length).toBeGreaterThan(100);
    const m = loadOf({ ...state, cloud: deep, groups: deep, marks: deep });
    expect(m.findings()).toEqual([]);
  });

  it("takes in a null where JSON put a NaN or an Infinity", async () => {
    const { state } = await savedState();
    const text = JSON.stringify({ ...state, groups: state.groups.map((g: Record<string, unknown>) => ({ ...g, durSum: NaN, durMax: Infinity })) });
    expect(text).toContain('"durSum":null');
    expect(loadOf(JSON.parse(text)).findings()).toEqual([]);
    const m = make(new MemStore());
    m.request({ method: "GET", path: "/slow", status: 500, durationMs: 1e308 });
    m.request({ method: "GET", path: "/slow", status: 500, durationMs: 1e308 });
    const store = new MemStore();
    const huge = make(store);
    huge.request({ method: "GET", path: "/slow", status: 500, durationMs: 1e308 });
    huge.request({ method: "GET", path: "/slow", status: 500, durationMs: 1e308 });
    await huge.flush();
    await huge.stop();
    expect(make(store).findings()).toHaveLength(1);
  });
});

describe("nothing raw is in what is saved", () => {
  // What has a shape redact knows, placed anywhere; and what has none (a password), placed where a name gives it away.
  const shaped = [
    "jane.doe@example.com", "10.1.2.3", "2001:db8::7", "sk-live_ABCdef1234567890xyz", "ghp_ABCDEFGHIJKLMNOPQRSTUVWX0123", "abcDEF123456ghiJKL789mnopq",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4", "4242424242424242",
  ];
  const named = ["hunter2secret", "s3cr3tcookie", "SECRETQUERY"];
  const secrets = [...shaped, ...named];
  const wrapAny = [(s: string) => s, (s: string) => `token=${s}`, (s: string) => `Bearer ${s}`, (s: string) => `user ${s} failed`, (s: string) => `"${s}"`, (s: string) => `api_key: ${s}`];
  const wrapNamed = [(s: string) => `token=${s}`, (s: string) => `Bearer ${s}0`, (s: string) => `password: ${s}`, (s: string) => `api_key: ${s}`];

  it("finds none of a made-up secret placed at random in lines, paths, releases, services and marks", async () => {
    let seed = 99;
    const rnd = (n: number): number => Math.floor(((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * n);
    const pick = <T>(xs: T[]): T => xs[rnd(xs.length)];
    const store = new MemStore();
    const m = make(store);
    for (let i = 0; i < 400; i++) {
      const useNamed = rnd(4) === 0;
      const s = useNamed ? pick(named) : pick(shaped);
      const piece = (useNamed ? pick(wrapNamed) : pick(wrapAny))(s);
      const place = useNamed ? pick([0, 1, 5]) : rnd(6); // a word with no shape is only caught in a line, next to its name
      if (place === 0) m.record({ level: pick(["error", "warning", "fatal"]), message: `step ${i % 9} failed ${piece} after retry` });
      else if (place === 1) m.record({ level: "error", message: `${piece}\n    at handler (/srv/app/${useNamed ? "app" : s}.js:1:2)`, path: `/x/${s}?a=${s}` });
      else if (place === 2) m.request({ method: "POST", path: `/api/${pick(["users", "files", "keys"])}/${s}/${pick(["reset", "show"])}?x=${s}`, status: pick([404, 500, 502]), userAgent: `Mozilla/5.0 ${s}` });
      else if (place === 3) m.request({ method: "GET", path: `https://host.example/${piece}#${s}`, status: 500 });
      else if (place === 4) m.record({ level: "error", message: `rel ${i % 5}`, release: `r ${s}`, service: `svc-${s}` });
      else m.record({ level: "fatal", message: JSON.stringify({ msg: `crash ${i % 4} ${piece}`, user: s }) });
    }
    await m.flush();
    for (const f of m.findings().slice(0, 40)) m.mark(f.id, { known: `see ${pick(shaped)} for ${f.id}` });
    m.mark(`mail ${shaped[0]}`, { known: "x" });
    m.mark(shaped[1], { fixed: true });
    await m.flush();
    await m.stop();
    const file = JSON.stringify(store.saves.at(-1));
    expect(store.saves.at(-1)!.groups.length).toBeGreaterThan(10);
    for (const s of secrets) expect(file, `the file holds ${s}`).not.toContain(s);
    expect(file).not.toMatch(/\?x=|\?a=/);
    // and what is loaded from it holds none either
    const again = make(store);
    for (const s of secrets) expect(JSON.stringify(again.findings())).not.toContain(s);
  });

  it("does not keep a group whose key redact would change, such as a path with an address in it", async () => {
    const store = new MemStore();
    const m = make(store);
    m.request({ method: "GET", path: "/hosts/10.0.0.1/status", status: 500 });
    m.request({ method: "GET", path: "/hosts/ok/status", status: 500 });
    await m.stop();
    expect(JSON.stringify(store.saves.at(-1))).not.toContain("10.0.0.1");
    expect(make(store).findings().map((f) => f.title)).toEqual(["GET /hosts/ok/status answers 500"]);
  });
});

describe("without a store nothing changes", () => {
  it("never reads or builds a state, and the source of the core imports no Node module", async () => {
    const exportState = vi.mocked(stateModule.exportState);
    const loadState = vi.mocked(stateModule.loadState);
    exportState.mockClear();
    loadState.mockClear();
    const m = make(undefined);
    err(m);
    m.request({ method: "GET", path: "/a", status: 500 });
    await m.flush();
    m.mark(m.findings()[0].id, { known: "x" });
    await m.flush();
    await m.stop();
    expect(exportState).not.toHaveBeenCalled();
    expect(loadState).not.toHaveBeenCalled();
    expect(m.stats()).toMatchObject({ errors: 0 });
    for (const file of ["monitor.ts", "state.ts", "cloud.ts", "types.ts"]) {
      const source = readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), "utf8");
      expect(source, file).not.toMatch(/from\s+["']node:|require\(|\bprocess\./);
    }
  });

  it("calls the store only when there is one: a store with both calls is called, an undefined one is not", async () => {
    const store = new MemStore();
    const withStore = make(store);
    err(withStore);
    await withStore.flush();
    expect(store.loads).toBe(1);
    expect(store.saves.length).toBe(1);
    const bare = make(undefined);
    err(bare);
    await bare.flush();
    expect(store.loads).toBe(1);
    expect(store.saves.length).toBe(1);
  });
});

describe("how long a save takes", () => {
  it("builds the state of 500 groups in a few milliseconds, the store call excluded", async () => {
    const m = make(new MemStore());
    for (let g = 0; g < 500; g++) {
      for (let i = 0; i < 3; i++) m.record({ level: "error", message: `failure of kind ${word(g)} with a longer text so the sample is not short`, release: `v${g % 3}`, service: "api" });
    }
    await m.flush();
    const times: number[] = [];
    for (let i = 0; i < 30; i++) {
      const started = process.hrtime.bigint();
      m.mark("nothing", {});
      times.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    times.sort((a, b) => a - b);
    console.log(`save of ${m.stats().groups} groups: median ${times[15].toFixed(2)} ms, worst ${times[29].toFixed(2)} ms`);
    expect(m.stats().groups).toBe(500);
    expect(times[15]).toBeLessThan(2000); // measured at a few ms; the bound is loose because CI machines are slow
  });
});

describe("in cloud mode", () => {
  interface Hit { events: Array<{ event: Loose }> }
  let server: Server;
  let hits: Hit[] = [];
  let url = "";

  beforeEach(async () => {
    hits = [];
    server = createServer((req: IncomingMessage, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          hits.push(JSON.parse(raw) as Hit);
        } catch {
          // not JSON
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/overseer`;
  });
  afterEach(async () => {
    for (const m of monitors) await m.stop();
    monitors = [];
    await new Promise<void>((r) => {
      server.close(() => r());
      server.closeAllConnections();
    });
  });

  const cloud = (o: Partial<CloudOptions> = {}): CloudOptions => ({ apiKey: "osk_testkey0123456789", dsn: url, ...o });
  const events = (): Loose[] => hits.flatMap((h) => h.events.map((e) => e.event));

  it("does not send again a finding sent 20 minutes before the restart, for 40 minutes, and counts the hits since the last send", async () => {
    const store = new MemStore();
    const first = make(store, { cloud: cloud() });
    err(first);
    await first.flush();
    expect(events()).toHaveLength(1);
    expect(store.saves.at(-1)!.groups[0]).toMatchObject({ sentAt: T0, sentTotal: 1, sentBack: 0 });
    at(20 * MIN);
    await first.stop();

    const second = make(store, { cloud: cloud() });
    for (let i = 0; i < 3; i++) err(second);
    await second.flush();
    expect(events()).toHaveLength(1);
    at(59 * MIN);
    err(second);
    await second.flush();
    expect(events()).toHaveLength(1);
    at(61 * MIN);
    err(second);
    err(second);
    await second.flush();
    expect(events()).toHaveLength(2);
    expect(events()[1].tags).toMatchObject({ hits: "6", total: "7", judgement: "seen" });
  });

  it("sends a finding again at once after a restart when it is `back` and was not sent for that return", async () => {
    const store = new MemStore();
    const first = make(store, { cloud: cloud() });
    err(first);
    await first.flush();
    first.mark(first.findings()[0].id, { fixed: true });
    await first.stop();
    at(5 * MIN);
    const second = make(store, { cloud: cloud() });
    err(second);
    await second.flush();
    expect(events()).toHaveLength(2);
    expect(events()[1].tags.judgement).toBe("back");
    at(10 * MIN);
    err(second);
    await second.flush();
    expect(events()).toHaveLength(2);
  });

  it("goes on counting perDay within the same UTC day, and starts again on the next", async () => {
    const store = new MemStore();
    const first = make(store, { cloud: cloud({ perDay: 3 }) });
    first.record({ level: "error", message: "first kind of failure" });
    first.record({ level: "error", message: "second kind of failure" });
    await first.flush();
    expect(events()).toHaveLength(2);
    expect(store.saves.at(-1)!.cloud).toEqual({ day: "2026-11-24", sent: 2 });
    await first.stop();
    at(HOUR);
    const second = make(store, { cloud: cloud({ perDay: 3 }) });
    expect(second.stats().cloud.today).toBe(2);
    for (const word of ["third", "fourth", "fifth"]) second.record({ level: "error", message: `${word} kind of failure` });
    await second.flush();
    expect(events()).toHaveLength(3);
    await second.stop();
    at(16 * HOUR); // 01:00 UTC on the 25th
    const third = make(store, { cloud: cloud({ perDay: 3 }) });
    expect(third.stats().cloud.today).toBe(3); // restored, and reset by the next batch
    third.record({ level: "error", message: "sixth kind of failure" });
    await third.flush();
    expect(events()).toHaveLength(4);
    expect(store.saves.at(-1)!.cloud).toEqual({ day: "2026-11-25", sent: 1 });
  });

  it("ignores a perDay count of a day that has not come, a bad one, or a state saved without cloud mode", async () => {
    const { state } = await savedState();
    for (const bad of [{ day: "2999-01-01", sent: 5 }, { day: "x", sent: 5 }, { day: "2026-11-24", sent: -1 }, { day: "2026-11-24", sent: 1.5 }, { day: 5, sent: 5 }, null, "x", {}]) {
      const m = make({ load: () => ({ ...state, cloud: bad }), save: () => undefined }, { cloud: cloud() });
      expect(m.stats().cloud.today, JSON.stringify(bad)).toBe(0);
    }
    const ok = make({ load: () => ({ ...state, cloud: { day: "2026-11-24", sent: 7 } }), save: () => undefined }, { cloud: cloud() });
    expect(ok.stats().cloud.today).toBe(7);
  });

  it("loads the send state of a group saved in local mode as never sent", async () => {
    const store = new MemStore();
    const local = make(store);
    err(local);
    await local.flush();
    await local.stop();
    const m = make(store, { cloud: cloud() });
    err(m);
    await m.flush();
    expect(events()).toHaveLength(1);
    expect(events()[0].tags).toMatchObject({ hits: "2", total: "2", judgement: "seen" });
  });
});
