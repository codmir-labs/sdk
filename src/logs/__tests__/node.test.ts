import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { captureConsole, captureProcess, expressLogs, fileSink, honoLogs, SINK_MAX_BYTES } from "../node";
import { createLogMonitor } from "../monitor";
import type { LogBatch, RequestRecord } from "../types";
import { bundle, scratch } from "./helpers";

const dir = scratch("node");
let logsJs = "";
let nodeJs = "";

beforeAll(async () => {
  logsJs = await bundle("src/logs/index.ts", dir, "logs");
  nodeJs = await bundle("src/logs/node.ts", dir, "logs-node");
});

const run = (name: string, source: string, args: string[] = []) => {
  const file = join(dir, `${name}.mjs`);
  writeFileSync(file, source);
  return spawnSync(process.execPath, [...args, file], { encoding: "utf8", timeout: 15_000, env: { ...process.env, NODE_OPTIONS: "" } });
};

describe("the timer", () => {
  it("never keeps the process alive: a child that only made a monitor exits by itself", () => {
    const r = run("timer", `import { createLogMonitor } from ${JSON.stringify(logsJs)};
const m = createLogMonitor({ batchMinutes: 60 });
m.record({ level: "error", message: "x" });
console.log("done");
`);
    expect(r.signal).toBeNull();
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("done");
  });
});

describe("captureConsole", () => {
  it("records error and warn, calls through with the same arguments, and restores", () => {
    const origError = console.error;
    const origWarn = console.warn;
    const origLog = console.log;
    const errSpy = vi.fn();
    const warnSpy = vi.fn();
    const logSpy = vi.fn();
    console.error = errSpy;
    console.warn = warnSpy;
    console.log = logSpy;
    const m = createLogMonitor();
    try {
      const restore = captureConsole(m);
      const e = new Error("db down");
      console.error("failed:", e, { id: 7 });
      console.warn("careful %s", "now");
      console.log("not captured");
      expect(errSpy).toHaveBeenCalledWith("failed:", e, { id: 7 });
      expect(warnSpy).toHaveBeenCalledWith("careful %s", "now");
      expect(logSpy).toHaveBeenCalledTimes(1);
      const found = m.findings();
      expect(found.map((f) => f.level).sort()).toEqual(["error", "warning"]);
      expect(found.find((f) => f.level === "error")?.title).toMatch(/^failed: Error: db down/);
      restore();
      expect(console.error).toBe(errSpy);
      expect(console.warn).toBe(warnSpy);
      console.error("after restore");
      expect(m.findings()).toHaveLength(2);
    } finally {
      console.error = origError;
      console.warn = origWarn;
      console.log = origLog;
      void m.stop();
    }
  });

  it("does not recurse when the monitor itself prints to the console", () => {
    const orig = console.error;
    const spy = vi.fn();
    console.error = spy;
    const record = vi.fn(() => console.error("the monitor prints too"));
    try {
      const restore = captureConsole({ record });
      console.error("app line");
      restore();
    } finally {
      console.error = orig;
    }
    expect(record).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls.map((c) => c[0])).toEqual(["the monitor prints too", "app line"]);
  });

  it("does not record what an app logs inside onBatch, with capture on", async () => {
    const orig = console.error;
    console.error = vi.fn();
    const m = createLogMonitor({ onBatch: () => console.error("batch ready") });
    try {
      const restore = captureConsole(m);
      console.error("first");
      await m.flush();
      restore();
      expect(m.findings().map((f) => f.title)).toEqual(["first"]);
    } finally {
      console.error = orig;
      await m.stop();
    }
  });

  it("an app that throws from console.error is not hidden by the monitor", () => {
    const orig = console.error;
    console.error = () => {
      throw new Error("sink closed");
    };
    const m = createLogMonitor();
    const restore = captureConsole(m);
    try {
      expect(() => console.error("x")).toThrow("sink closed");
    } finally {
      restore();
      console.error = orig;
      void m.stop();
    }
  });
});

describe("captureProcess leaves Node as it was", () => {
  const script = (capture: boolean, body: string) => `import { createLogMonitor } from ${JSON.stringify(logsJs)};
import { captureProcess, fileSink } from ${JSON.stringify(nodeJs)};
const m = createLogMonitor({ onBatch: fileSink(${JSON.stringify(join(dir, capture ? "crash-on.jsonl" : "crash-off.jsonl"))}) });
${capture ? "captureProcess(m);" : ""}
${body}
`;

  it("an uncaught exception still exits with code 1 and prints its stack, and is recorded as fatal", () => {
    const body = `setTimeout(function crashHere() { throw new Error("boom-uncaught"); }, 5);`;
    const off = run("crash-off", script(false, body));
    const on = run("crash-on", script(true, body));
    expect(off.status).toBe(1);
    expect(on.status).toBe(1);
    expect(on.stderr).toContain("Error: boom-uncaught");
    expect(on.stderr).toContain("at Timeout.crashHere");
    expect(on.stderr.split("\n")[0]).toBe(off.stderr.split("\n")[0].replace(/crash-off/, "crash-on"));
    const line = JSON.parse(readFileSync(join(dir, "crash-on.jsonl"), "utf8").trim().split("\n")[0]) as LogBatch;
    expect(line.findings[0]).toMatchObject({ level: "fatal", kind: "message" });
    expect(line.findings[0].title).toContain("boom-uncaught");
  });

  it("an unhandled rejection still exits with code 1, and an uncaughtException handler of the app still runs", () => {
    const rej = run("rej-on", script(true, `Promise.reject(new Error("rejected-x"));`));
    expect(rej.status).toBe(1);
    expect(rej.stderr).toContain("rejected-x");
    const handled = run("handled-on", script(true, `process.on("uncaughtException", (e) => { console.log("app handler: " + e.message); });\nsetTimeout(() => { throw new Error("handled-y"); }, 5);`));
    expect(handled.status).toBe(0);
    expect(handled.stdout).toContain("app handler: handled-y");
  });

  it("with --unhandled-rejections=warn Node still carries on (exit 0), and the rejection is recorded", () => {
    const r = run("warn-on", script(true, `Promise.reject(new Error("rejected-z"));\nsetTimeout(async () => { await m.flush(); console.log("alive"); }, 50);`), ["--unhandled-rejections=warn"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("alive");
    expect(readFileSync(join(dir, "crash-on.jsonl"), "utf8")).toContain("rejected-z");
  });

  it("adds no unhandledRejection listener, and removes its own on restore", () => {
    const before = [process.listenerCount("unhandledRejection"), process.listenerCount("uncaughtException"), process.listenerCount("uncaughtExceptionMonitor"), process.listenerCount("warning")];
    const m = createLogMonitor();
    const restore = captureProcess(m);
    expect(process.listenerCount("unhandledRejection")).toBe(before[0]);
    expect(process.listenerCount("uncaughtException")).toBe(before[1]);
    restore();
    expect([process.listenerCount("unhandledRejection"), process.listenerCount("uncaughtException"), process.listenerCount("uncaughtExceptionMonitor"), process.listenerCount("warning")]).toEqual(before);
    void m.stop();
  });
});

describe("fileSink", () => {
  const batch = (n: number, pad = 0): LogBatch => ({
    from: "2026-11-24T09:00:00.000Z",
    to: "2026-11-24T09:15:00.000Z",
    records: n,
    findings: [{ id: "abcd0123", key: "k", kind: "message", title: "t", judgement: "new", hits: n, total: n, counts: [n], firstSeen: "", lastSeen: "", releases: [], sample: "x".repeat(pad), backCount: 0 }],
    alarms: [],
  });

  it("appends one JSON line per batch with mode 0600, and narrows a file made wider", () => {
    const file = join(dir, "sink.jsonl");
    const sink = fileSink(file);
    sink(batch(1));
    sink(batch(2));
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines.map((l) => (JSON.parse(l) as LogBatch).records)).toEqual([1, 2]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const wide = join(dir, "wide.jsonl");
    writeFileSync(wide, "");
    chmodSync(wide, 0o644);
    fileSink(wide)(batch(1));
    expect(statSync(wide).mode & 0o777).toBe(0o600);
  });

  it("rotates at 5 MB and keeps 2", () => {
    const file = join(dir, "rot.jsonl");
    const sink = fileSink(file);
    for (let i = 1; i <= 40; i++) sink(batch(i, 400_000));
    expect(existsSync(file)).toBe(true);
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(existsSync(`${file}.2`)).toBe(true);
    expect(existsSync(`${file}.3`)).toBe(false);
    for (const f of [file, `${file}.1`, `${file}.2`]) {
      expect(statSync(f).size).toBeLessThanOrEqual(SINK_MAX_BYTES);
      expect(statSync(f).mode & 0o777).toBe(0o600);
    }
    const last = readFileSync(file, "utf8").trim().split("\n").pop() as string;
    expect((JSON.parse(last) as LogBatch).records).toBe(40);
  });

  it("never throws, even when the folder is missing", () => {
    expect(() => fileSink(join(dir, "no", "such", "dir", "x.jsonl"))(batch(1))).not.toThrow();
  });
});

describe("expressLogs", () => {
  const fake = (over: Partial<{ originalUrl: string; route: { path?: unknown }; baseUrl: string }> = {}) => {
    const res = Object.assign(new EventEmitter(), { statusCode: 500 });
    const req = { method: "GET", originalUrl: "/orders/12?token=abc&email=a@example.com", url: "/orders/12?token=abc", headers: { "user-agent": "curl/8.4" }, ...over };
    return { req, res };
  };
  const spy = () => {
    const seen: RequestRecord[] = [];
    return { seen, monitor: { request: (r: RequestRecord) => void seen.push(r) } };
  };

  it("records one request on finish, with the path without its query, the status and the duration", () => {
    const { seen, monitor } = spy();
    const { req, res } = fake();
    const next = vi.fn();
    expressLogs(monitor)(req, res as never, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(0);
    res.emit("finish");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "GET", path: "/orders/12", status: 500, userAgent: "curl/8.4" });
    expect(seen[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(seen)).not.toMatch(/token|a@b\.co|\?/);
  });

  it("uses the matched route when Express has one", () => {
    const { seen, monitor } = spy();
    const { req, res } = fake({ route: { path: "/users/:id" }, baseUrl: "/api" });
    expressLogs(monitor)(req, res as never, () => undefined);
    res.emit("finish");
    expect(seen[0].path).toBe("/api/users/:id");
  });

  it("a monitor that throws never reaches the response", () => {
    const { req, res } = fake();
    expressLogs({ request: () => { throw new Error("no"); } })(req, res as never, () => undefined);
    expect(() => res.emit("finish")).not.toThrow();
  });

  it("works end to end with a real monitor", () => {
    const m = createLogMonitor();
    const { req, res } = fake();
    expressLogs(m)(req, res as never, () => undefined);
    res.emit("finish");
    expect(m.findings()[0]).toMatchObject({ title: "GET /orders/:n answers 500", families: { curl: 1 } });
    void m.stop();
  });
});

describe("honoLogs", () => {
  it("records the matched route, status and duration with the real library, never the query", async () => {
    const seen: RequestRecord[] = [];
    const app = new Hono();
    app.use(honoLogs({ request: (r) => void seen.push(r) }));
    app.get("/users/:id", (c) => c.text("ok"));
    app.get("/boom", () => {
      throw new Error("handler broke");
    });
    app.onError((_e, c) => c.text("failed", 500));
    expect((await app.request("/users/5?token=abc&e=a@example.com", { headers: { "user-agent": "Mozilla/5.0 Chrome/1 Safari/1" } })).status).toBe(200);
    expect((await app.request("/boom?secret=1")).status).toBe(500);
    expect((await app.request("/nope?x=1")).status).toBe(404);
    expect(seen.map((r) => [r.method, r.path, r.status])).toEqual([
      ["GET", "/users/:id", 200],
      ["GET", "/boom", 500],
      ["GET", "/nope", 404],
    ]);
    expect(seen[0].userAgent).toContain("Mozilla");
    expect(JSON.stringify(seen)).not.toMatch(/token|secret|a@b\.co|\?/);
  });

  it("records a 500 when the error is not handled", async () => {
    const seen: RequestRecord[] = [];
    const app = new Hono();
    app.use(honoLogs({ request: (r) => void seen.push(r) }));
    app.get("/boom", () => {
      throw new Error("unhandled");
    });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined); // Hono prints the error it turns into a 500
    const res = await app.request("/boom");
    quiet.mockRestore();
    expect(res.status).toBe(500);
    expect(seen[0]).toMatchObject({ path: "/boom", status: 500 });
  });
});
