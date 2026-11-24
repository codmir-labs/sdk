import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { close as closeOverseer, init } from "../../overseer/index";
import { createLogMonitor } from "../monitor";
import type { CloudOptions, LogMonitor } from "../types";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 24, 9, 0, 0);

interface Hit {
  url: string;
  key: string | undefined;
  raw: string;
  events: Array<{ type: string; event: Record<string, any>; group: Record<string, any> }>;
}

let server: Server;
let hits: Hit[] = [];
let answer = 200;
let url = "";
let monitors: LogMonitor[] = [];

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  hits = [];
  answer = 200;
  server = createServer((req: IncomingMessage, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let events: Hit["events"] = [];
      try {
        events = (JSON.parse(raw) as { events: Hit["events"] }).events;
      } catch {
        // not JSON: kept raw for the search below
      }
      hits.push({ url: req.url ?? "", key: req.headers["x-overseer-key"] as string | undefined, raw, events });
      res.writeHead(answer, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/overseer`;
});

afterEach(async () => {
  for (const m of monitors) await m.stop();
  monitors = [];
  closeOverseer();
  vi.useRealTimers();
  await new Promise<void>((r) => server.close(() => r()));
});

const make = (cloud: Partial<CloudOptions> | true = {}): LogMonitor => {
  const m = createLogMonitor({ release: "1.2.3", cloud: cloud === true ? true : { apiKey: "osk_testkey0123456789", dsn: url, ...cloud } });
  monitors.push(m);
  return m;
};
const events = (): Hit["events"] => hits.flatMap((h) => h.events);
const fail = (m: LogMonitor, message = "payment failed for order 8812"): void => m.record({ level: "error", message });
const at = (ms: number): void => void vi.setSystemTime(T0 + ms);

describe("what is sent, and when", () => {
  it("sends a finding once as one flat error event with its own fingerprint and title, then counts up", async () => {
    const m = make();
    fail(m);
    m.request({ method: "POST", path: "/api/pay/42", status: 500, durationMs: 40 });
    await m.flush();
    expect(hits).toHaveLength(1);
    expect(hits[0].url).toBe("/api/overseer/ingest");
    expect(hits[0].key).toBe("osk_testkey0123456789");
    const ev = events();
    expect(ev).toHaveLength(2);
    const req = ev.find((e) => e.event.message === "POST /api/pay/:n answers 500")!;
    expect(req.type).toBe("error");
    expect(req.group.fingerprint).toEqual(["codmir-logs", "POST|/api/pay/:n|500"]);
    expect(req.event.fingerprint).toEqual(req.group.fingerprint);
    expect(req.event).toMatchObject({ level: "error", exception: { type: "HTTP500", value: "POST /api/pay/:n answers 500" }, tags: { source: "codmir-logs", kind: "request", status: "500", judgement: "new", hits: "1" } });
    const line = ev.find((e) => e.event.message === "payment failed for order #")!;
    expect(line.group.fingerprint).toEqual(["codmir-logs", "error|payment failed for order #"]);
    expect(line.event.exception.type).toBe("LogError");
    expect(m.stats().cloud).toMatchObject({ sent: 2 });
  });

  it("does not send it again within the hour, sends it again after", async () => {
    const m = make();
    fail(m);
    await m.flush();
    for (const min of [15, 30, 45, 59]) {
      at(min * 60_000);
      fail(m);
      await m.flush();
    }
    expect(events()).toHaveLength(1);
    at(HOUR + 60_000);
    fail(m);
    fail(m);
    await m.flush();
    expect(events()).toHaveLength(2);
    expect(events()[1].event.tags).toMatchObject({ hits: "2", total: "7", judgement: "seen" });
    expect(events()[1].group.fingerprint).toEqual(events()[0].group.fingerprint); // the same issue: the server counts it up
  });

  it("sends a finding that came back at once, whatever the hour", async () => {
    const m = make();
    fail(m);
    await m.flush();
    m.mark(m.findings()[0].id, { fixed: true });
    at(60_000);
    fail(m);
    await m.flush();
    expect(events()).toHaveLength(2);
    expect(events()[1].event.tags.judgement).toBe("back");
    at(120_000);
    fail(m);
    await m.flush();
    expect(events()).toHaveLength(2);
  });

  it("never sends noise, and a known finding only the first time (with its note)", async () => {
    const m = make();
    m.request({ method: "GET", path: "/wp-login.php", status: 404 });
    m.request({ method: "GET", path: "/.env", status: 404 });
    m.mark("error|payment failed for order #", { known: "tracked in the wiki" });
    fail(m);
    await m.flush();
    expect(events()).toHaveLength(1);
    expect(events()[0].event.tags).toMatchObject({ judgement: "known", known: "tracked in the wiki" });
    at(3 * HOUR);
    fail(m);
    await m.flush();
    expect(events()).toHaveLength(1);
  });

  it("sends only what minSeverity allows: a 404 is a warning, a 500 an error", async () => {
    const m = make({ minSeverity: "error" });
    m.request({ method: "GET", path: "/a", status: 404 });
    m.record({ level: "warn", message: "careful" });
    m.request({ method: "GET", path: "/b", status: 500 });
    await m.flush();
    expect(events().map((e) => e.event.message)).toEqual(["GET /b answers 500"]);
  });

  it("caps a batch at perBatch, most serious first, and a day at perDay", async () => {
    const m = make({ perBatch: 3, perDay: 5 });
    for (let i = 0; i < 6; i++) m.record({ level: "warning", message: `minor ${"abcdef"[i]} problem` });
    for (let i = 0; i < 3; i++) m.request({ method: "GET", path: "/boom", status: 500 });
    await m.flush();
    expect(events()).toHaveLength(3);
    expect(events()[0].event.message).toBe("GET /boom answers 500"); // the alarm is first
    expect(m.stats().cloud.skipped).toBe(4);
    at(15 * 60_000);
    for (let i = 0; i < 4; i++) m.record({ level: "error", message: `fresh ${"abcd"[i]} problem` });
    await m.flush();
    expect(events()).toHaveLength(5); // perDay reached
    expect(m.stats().cloud.today).toBe(5);
    at(24 * HOUR);
    m.record({ level: "error", message: "next day problem" });
    await m.flush();
    expect(events()).toHaveLength(6);
  });
});

describe("it never hurts the app", () => {
  it("is silent when the server refuses (401, 500) and when nothing listens", async () => {
    for (const status of [401, 500]) {
      answer = status;
      const m = make();
      fail(m, `refused ${status} case`);
      await expect(m.flush()).resolves.toBeUndefined();
      await m.stop();
    }
    expect(hits.length).toBeGreaterThan(0);
    await new Promise<void>((r) => server.close(() => r()));
    const m = make({ dsn: "http://127.0.0.1:1/api/overseer" });
    fail(m);
    await expect(m.flush()).resolves.toBeUndefined();
    server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  });

  it("is off by default: nothing is sent, nothing is loaded", async () => {
    const m = createLogMonitor();
    monitors.push(m);
    fail(m);
    await m.flush();
    expect(hits).toHaveLength(0);
    expect(m.stats().cloud).toEqual({ sent: 0, skipped: 0, today: 0 });
  });

  it("cloud: true uses the client init() made, and does nothing without one", async () => {
    const lonely = make(true);
    fail(lonely);
    await lonely.flush();
    expect(hits).toHaveLength(0);
    await lonely.stop();
    init({ clientKey: "osk_fromInit0123456789", dsn: url, environment: "staging" });
    const m = make(true);
    fail(m);
    await m.flush();
    expect(hits).toHaveLength(1);
    expect(hits[0].key).toBe("osk_fromInit0123456789");
    expect(events()[0].event.environment).toBe("staging");
  });
});

describe("nothing raw is sent", () => {
  it("searches every body for what the app planted", async () => {
    const planted = [
      "hunter2secret", "jane.doe@example.com", "10.1.2.3", "2001:db8::7", "sk-live_ABCdef1234567890xyz", "abcDEF123456ghiJKL789mno",
      "eyJhbGciOiJIUzI1NiJ9", "SECRETQUERY", "SecretBrowser", "cust-8812-private", "4242424242424242", "s3cr3tcookie",
    ];
    const m = make();
    m.record({ level: "error", message: "login for jane.doe@example.com from 10.1.2.3 failed: token=hunter2secret" });
    m.record({ level: "error", message: "upstream said Bearer abcDEF123456ghiJKL789mno at 2001:db8::7 key sk-live_ABCdef1234567890xyz" });
    m.record({ level: "fatal", message: `jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4 rejected "cust-8812-private" card 4242424242424242`, path: "/checkout?x=SECRETQUERY" });
    m.record({ level: "error", message: "Cookie: sid=s3cr3tcookie; theme=dark" });
    m.request({ method: "POST", path: "/api/users/jane.doe@example.com/reset?token=SECRETQUERY&e=jane.doe@example.com", status: 500, userAgent: "Mozilla/5.0 (X11) SecretBrowser/1.0", durationMs: 5 });
    m.request({ method: "GET", path: "/orders/4242424242424242?sig=SECRETQUERY", status: 502, userAgent: "SecretBrowser" });
    await m.flush();
    expect(events().length).toBeGreaterThanOrEqual(5);
    const all = hits.map((h) => h.raw).join("\n");
    for (const secret of planted) expect(all, `body contains ${secret}`).not.toContain(secret);
    expect(all).not.toMatch(/@example\.com|\?token=|\?x=|\?sig=/);
  });
});
