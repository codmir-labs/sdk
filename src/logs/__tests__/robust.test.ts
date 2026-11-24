import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogMonitor } from "../monitor";
import { captureConsole, fileSink, honoLogs } from "../node";
import { messageKey, redact } from "../redact";
import { scratch } from "./helpers";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("an async onBatch", () => {
  it("that rejects never becomes an unhandled rejection, is counted, and flush waits for it", async () => {
    const seen: unknown[] = [];
    const onRejection = (e: unknown): void => void seen.push(e);
    process.on("unhandledRejection", onRejection);
    try {
      let settled = false;
      const m = createLogMonitor({
        onBatch: (async () => {
          await new Promise((r) => setTimeout(r, 20));
          settled = true;
          throw new Error("the app's own store is down");
        }) as () => void,
      });
      m.record({ level: "error", message: "boom" });
      await m.flush();
      expect(settled).toBe(true);
      expect(m.stats().errors).toBe(1);
      await new Promise((r) => setTimeout(r, 20));
      expect(seen).toEqual([]);
      await m.stop();
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});

describe("a runtime or a config that is not what we expect", () => {
  it("does not throw where timers are refused at module scope, and flush still ends a batch", async () => {
    vi.spyOn(globalThis, "setInterval").mockImplementation(() => {
      throw new Error("Disallowed operation called within global scope");
    });
    const batches: number[] = [];
    const m = createLogMonitor({ onBatch: (b) => void batches.push(b.findings.length) });
    m.record({ level: "error", message: "boom" });
    await m.flush();
    expect(batches).toEqual([1]);
    await m.stop();
  });

  it("uses the default for an option that is not a number, and caps the timer", async () => {
    const spy = vi.spyOn(globalThis, "setInterval");
    const nan = Number(undefined);
    const a = createLogMonitor({ batchMinutes: nan });
    const b = createLogMonitor({ batchMinutes: 1e9 });
    const c = createLogMonitor({ batchMinutes: 0 });
    const ms = spy.mock.calls.map((x) => x[1]);
    expect(ms[0]).toBe(15 * 60_000);
    expect(ms[1]).toBeLessThan(2 ** 31);
    expect(ms[2]).toBe(60_000);
    const m = createLogMonitor({ limits: { groups: nan }, include: { minStatus: nan } });
    for (let i = 0; i < 700; i++) m.record({ level: "error", message: `word${"abcdefghij"[i % 10]}${"klmnopqrst"[Math.floor(i / 10) % 10]}${"uvwxyzabcd"[Math.floor(i / 100)]} broke` });
    expect(m.stats().groups).toBe(500);
    await Promise.all([a, b, c, m].map((x) => x.stop()));
  });
});

describe("structured lines", () => {
  it("groups JSON lines by their message, not by their shape", () => {
    const m = createLogMonitor();
    m.record({ level: "error", message: JSON.stringify({ level: "error", time: 1, msg: "db down" }) });
    m.record({ level: "error", message: JSON.stringify({ level: "error", time: 2, msg: "db down" }) });
    m.record({ level: "error", message: JSON.stringify({ level: "error", time: 3, message: "payment failed for order 8812", err: { message: "card declined" } }) });
    expect(m.findings().map((f) => [f.title, f.total]).sort()).toEqual([["db down", 2], ["payment failed for order #: card declined", 1]]);
    expect(JSON.stringify(m.findings())).not.toContain('"time"');
    void m.stop();
  });

  it("takes an Error or an object as the message", () => {
    const m = createLogMonitor();
    m.record({ level: "error", message: new Error("boom") as unknown as string });
    m.record({ level: "error", message: { msg: "queue full" } as unknown as string });
    m.record({ level: "error", message: { code: 7 } as unknown as string });
    const titles = m.findings().map((f) => f.title).sort();
    expect(titles[0]).toMatch(/^Error: boom/);
    expect(titles).toContain("queue full");
    expect(titles.every((t) => t.length > 0)).toBe(true);
    void m.stop();
  });

  it("takes an object given to console.error by its message", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const m = createLogMonitor();
    const undo = captureConsole(m, ["error"]);
    console.error({ msg: "cache is cold" });
    console.error({ msg: "disk is full" });
    undo();
    expect(m.findings().map((f) => f.title).sort()).toEqual(["cache is cold", "disk is full"]);
    void m.stop();
  });

  it("keeps a broken or a huge JSON text as it is and stays quick", () => {
    const m = createLogMonitor();
    m.record({ level: "error", message: '{"msg": "cut off' });
    const big = JSON.stringify({ msg: "x", pad: "y".repeat(5_000_000) });
    const t = performance.now();
    m.record({ level: "error", message: big });
    expect(performance.now() - t).toBeLessThan(100);
    expect(m.stats().errors).toBe(0);
    expect(m.findings()).toHaveLength(2);
    void m.stop();
  });
});

describe("redaction of pairs", () => {
  it("masks a secret in a JSON pair and keeps the quotes balanced", () => {
    const out = redact('{"password":"hunter2","api_key": "abc","user":"bob"}');
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("abc");
    expect((out.match(/"/g) ?? []).length % 2).toBe(0);
    expect(redact(out)).toBe(out);
    expect(redact("{'session-id': 'q1w2e3'}")).not.toContain("q1w2e3");
  });

  it("keeps words that only look like a secret's name", () => {
    expect(redact("author=Jane author_id: 5 design: blue signal=SIGTERM assigned: 3")).toBe("author=Jane author_id: 5 design: blue signal=SIGTERM assigned: 3");
  });

  it("still masks the real ones", () => {
    for (const s of ["auth=abc", "authorization: abc", "oauth_token=abc", "x-signature: abc", "sig=abc", "x-sig: abc", "url_sig=abc", "API_KEY=abc", "db-password: abc", "my_session=abc"]) {
      expect(redact(s), s).not.toContain("abc");
    }
  });
});

describe("what the monitor holds", () => {
  it("holds no raw log text anywhere reachable from the monitor's own state", async () => {
    const maps: Map<unknown, unknown>[] = [];
    const RealMap = globalThis.Map;
    class Spy<K, V> extends RealMap<K, V> {
      constructor(...args: ConstructorParameters<typeof Map<K, V>>) {
        super(...args);
        maps.push(this as unknown as Map<unknown, unknown>);
      }
    }
    globalThis.Map = Spy as unknown as MapConstructor;
    try {
      const m = createLogMonitor();
      m.record({ level: "error", message: "login failed for jane@example.com from 10.1.2.3 password=hunter2" });
      const held = JSON.stringify(maps.map((x) => [...x.entries()]));
      for (const raw of ["jane@example.com", "10.1.2.3", "hunter2"]) expect(held).not.toContain(raw);
      await m.stop();
    } finally {
      globalThis.Map = RealMap;
    }
  });

  it("uses no lookbehind, which older browsers refuse to parse", () => {
    const dir = fileURLToPath(new URL("..", import.meta.url));
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) expect(readFileSync(join(dir, f), "utf8"), f).not.toMatch(/\(\?<[!=]/);
  });
});

describe("Node helpers", () => {
  it("makes the folder of a file sink", async () => {
    const path = join(scratch("sink"), "deep", "er", "findings.jsonl");
    const m = createLogMonitor({ onBatch: fileSink(path) });
    m.record({ level: "error", message: "boom" });
    await m.stop();
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).findings).toHaveLength(1);
  });

  it("names an unmatched Hono path by itself, not by the middleware's wildcard", async () => {
    const seen: string[] = [];
    const app = new Hono();
    app.use("/api/*", honoLogs({ request: (r) => void seen.push(`${r.path} ${r.status}`) }));
    app.get("/api/users/:id", (c) => c.text("ok"));
    await app.request("/api/users/42");
    await app.request("/api/nope");
    await app.request("/api/other?token=abc");
    expect(seen).toEqual(["/api/users/:id 200", "/api/nope 404", "/api/other 404"]);
  });
});

it("a message key is the same for the JSON line and its text", () => {
  expect(messageKey(JSON.stringify({ level: "error", msg: "db down on 10.1.2.3" }))).toBe(messageKey("db down on 10.1.2.3"));
});
