import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { close as closeOverseer, init } from "../../overseer/index";
import { createLogMonitor } from "../monitor";
import type { LogMonitor, LogState } from "../types";

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 24, 9, 0, 0);

interface Hit {
  events: Array<{ type: string; event: Record<string, any> }>;
}
let server: Server;
let hits: Hit[] = [];
let respond: (n: number) => { status: number; body?: unknown } = () => ({ status: 200 });
let url = "";
let monitors: LogMonitor[] = [];
let states: LogState[] = [];

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  hits = [];
  states = [];
  respond = () => ({ status: 200 });
  server = createServer((req: IncomingMessage, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      hits.push({ events: (JSON.parse(raw) as { events: Hit["events"] }).events });
      const r = respond(hits.length);
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(JSON.stringify(r.body ?? {}));
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
  await new Promise<void>((r) => {
    server.close(() => r());
    server.closeAllConnections();
  });
});

const at = (ms: number): void => void vi.setSystemTime(T0 + ms);
const make = (load?: LogState, cloud: object | true = {}): LogMonitor => {
  const m = createLogMonitor({
    batchMinutes: 10_000,
    cloud: cloud === true ? true : { apiKey: "osk_testkey0123456789", dsn: url, ...cloud },
    store: { load: () => (load ? JSON.parse(JSON.stringify(load)) : undefined), save: (s) => void states.push(JSON.parse(JSON.stringify(s))) },
  });
  monitors.push(m);
  return m;
};
const fail = (m: LogMonitor, message = "payment failed for order 8812", times = 1): void => {
  for (let i = 0; i < times; i++) m.record({ level: "error", message });
};
const group = (s: LogState | undefined, i = 0) => s!.groups[i];
const sentEvents = () => hits.flatMap((h) => h.events);
const tag = (e: { event: Record<string, any> }, k: string): string => e.event.tags[k];

/** The four ways a server does not take an event; each refuses the first request it sees. */
const REFUSALS: Array<[string, (n: number) => { status: number; body?: unknown }]> = [
  ["401", (n) => (n === 1 ? { status: 401 } : { status: 200 })],
  ["402", (n) => (n === 1 ? { status: 402, body: { error: "payment_required" } } : { status: 200 })],
  ["200 with droppedEvents", (n) => (n === 1 ? { status: 200, body: { received: 0, dropped: 1, droppedEvents: [{ index: 0, reason: "payment_required", type: "error" }] } } : { status: 200 })],
];

describe("a refused finding is sent again", () => {
  for (const [name, answer] of REFUSALS) {
    it(`${name}: the next send carries all the hits, and the marks go back and forth in the state`, async () => {
      respond = answer;
      const m = make();
      fail(m, undefined, 3);
      await m.flush();
      expect(hits).toHaveLength(1);
      expect(states[0].groups[0]).toMatchObject({ sentAt: T0, sentTotal: 3 }); // before the answer is known
      expect(group(states.at(-1))).toMatchObject({ sentAt: 0, sentBack: 0, sentTotal: 0 }); // after the refusal
      expect(m.stats().cloud).toMatchObject({ refused: 1, today: 0, pausedUntil: new Date(T0 + MIN).toISOString() });
      at(2 * MIN);
      fail(m, undefined, 2);
      await m.flush();
      expect(hits).toHaveLength(2);
      expect(sentEvents().map((e) => tag(e, "hits"))).toEqual(["3", "5"]);
      expect(group(states.at(-1))).toMatchObject({ sentAt: T0 + 2 * MIN, sentTotal: 5 });
      expect(m.stats().cloud.pausedUntil).toBeUndefined();
    });
  }

  it("429 with the client giving up: the finding comes back with a restart", async () => {
    respond = () => ({ status: 429 });
    const m = make();
    fail(m, undefined, 3);
    await m.flush();
    expect(m.stats().cloud).toMatchObject({ sent: 1, refused: 0, waiting: 1 }); // nobody has answered yet: the marks stay
    expect(group(states.at(-1))).toMatchObject({ sentAt: T0, sentTotal: 3 });
    await m.stop(); // the client's last try is refused again, and it gives up
    await vi.waitFor(() => expect(m.stats().cloud.refused).toBe(1));
    expect(group(states.at(-1))).toMatchObject({ sentAt: 0, sentTotal: 0 });
    respond = () => ({ status: 200 });
    const again = make(states.at(-1));
    fail(again, undefined, 1);
    await again.flush();
    expect(sentEvents().at(-1)).toBeDefined();
    expect(tag(sentEvents().at(-1)!, "hits")).toBe("4");
    expect(tag(sentEvents().at(-1)!, "total")).toBe("4");
  });

  it("a restart between the refusal and the next send sends the finding with all its hits", async () => {
    respond = REFUSALS[0][1];
    const m = make();
    fail(m, undefined, 3);
    await m.flush();
    await m.stop();
    const again = make(states.at(-1));
    fail(again);
    await again.flush();
    expect(tag(sentEvents().at(-1)!, "hits")).toBe("4");
  });

  it("of two findings in one batch, only the dropped one comes back", async () => {
    respond = (n) => (n === 1 ? { status: 200, body: { droppedEvents: [{ index: 1, reason: "payment_required" }] } } : { status: 200 });
    const m = make();
    fail(m, "first problem with the disk", 3);
    fail(m, "second problem with the net", 1);
    await m.flush();
    expect(sentEvents().map((e) => tag(e, "hits"))).toEqual(["3", "1"]);
    const [a, b] = states.at(-1)!.groups.sort((x, y) => y.total - x.total);
    expect(a).toMatchObject({ sentTotal: 3 });
    expect(a.sentAt).toBe(T0);
    expect(b).toMatchObject({ sentAt: 0, sentTotal: 0 });
    expect(m.stats().cloud.today).toBe(1);
    at(2 * MIN);
    fail(m, "first problem with the disk");
    fail(m, "second problem with the net");
    await m.flush();
    expect(sentEvents()).toHaveLength(3); // the first stays quiet for an hour; the second comes back with its hits
    expect(sentEvents()[2].event.tags).toMatchObject({ hits: "2", total: "2" });
  });

  it("a refusal that comes after the group was sent again does not undo the later marks, and its hits go out with the next send", async () => {
    respond = () => ({ status: 503 });
    const m = make();
    fail(m, undefined, 3);
    await m.flush(); // no answer: the client holds the event
    expect(m.stats().cloud.waiting).toBe(1);
    at(61 * MIN);
    fail(m, undefined, 2);
    respond = (n) => (n === 2 ? { status: 200, body: { droppedEvents: [{ index: 0, reason: "unparseable" }] } } : { status: 200 });
    await m.flush();
    expect(hits).toHaveLength(2);
    expect(hits[1].events).toHaveLength(2); // the old one, still queued, and the new one
    expect(m.stats().cloud.refused).toBe(1);
    expect(sentEvents().slice(1).map((e) => tag(e, "hits"))).toEqual(["3", "2"]);
    expect(group(states.at(-1))).toMatchObject({ sentAt: T0 + 61 * MIN, sentTotal: 2 }); // the later send's time; the 3 refused hits are owed
    at(122 * MIN);
    fail(m);
    await m.flush();
    expect(tag(sentEvents().at(-1)!, "hits")).toBe("4"); // 3 refused and 1 new
    expect(group(states.at(-1))).toMatchObject({ sentAt: T0 + 122 * MIN, sentTotal: 6 });
  });

  it("two sends of one group refused together: the next one carries the hits of both", async () => {
    respond = () => ({ status: 503 });
    const m = make();
    fail(m, undefined, 3);
    await m.flush();
    at(61 * MIN);
    fail(m, undefined, 2);
    respond = (n) => (n === 2 ? { status: 401 } : { status: 200 });
    await m.flush();
    expect(m.stats().cloud).toMatchObject({ refused: 2, today: 0 });
    expect(group(states.at(-1))).toMatchObject({ sentTotal: 0 });
    at(130 * MIN);
    fail(m);
    await m.flush();
    expect(tag(sentEvents().at(-1)!, "hits")).toBe("6");
    expect(m.stats().cloud.today).toBe(1);
  });

  it("a finding that came back and was refused goes out as soon as the pause ends, whatever the hour", async () => {
    const m = make();
    fail(m);
    await m.flush();
    m.mark(m.findings()[0].id, { fixed: true });
    respond = (n) => ({ status: n === 2 ? 402 : 200 });
    at(1 * MIN);
    fail(m, undefined, 2);
    await m.flush();
    expect(tag(sentEvents()[1], "judgement")).toBe("back");
    at(3 * MIN);
    fail(m);
    await m.flush();
    expect(sentEvents().map((e) => tag(e, "hits"))).toEqual(["1", "2", "3"]);
    at(4 * MIN);
    fail(m);
    await m.flush();
    expect(hits).toHaveLength(3); // taken now: quiet for an hour
  });

  it("a refusal that names nobody pauses the sending and undoes nothing", async () => {
    respond = (n) => (n === 1 ? { status: 200, body: { droppedEvents: [{ reason: "payment_required" }] } } : { status: 200 });
    const m = make();
    fail(m, undefined, 3);
    await m.flush();
    expect(m.stats().cloud).toMatchObject({ refused: 1, today: 1, pausedUntil: new Date(T0 + MIN).toISOString() });
    expect(group(states.at(-1))).toMatchObject({ sentAt: T0, sentTotal: 3 });
  });

  it("a send in several batches that are all refused is one refusal", async () => {
    respond = () => ({ status: 401 });
    const m = make(undefined, { perBatch: 300 });
    const word = (i: number): string => [...String(i).padStart(3, "0")].map((d) => "abcdefghij"[+d]).join("");
    for (let i = 0; i < 150; i++) fail(m, `the ${word(i)} part is broken`);
    await m.flush();
    expect(hits.map((h) => h.events.length)).toEqual([100, 50]);
    expect(m.stats().cloud).toMatchObject({ refused: 150, today: 0, pausedUntil: new Date(T0 + MIN).toISOString() });
    expect(states.at(-1)!.groups.every((g) => g.sentAt === 0 && g.sentTotal === 0)).toBe(true);
  });

  it("a refusal after midnight takes nothing off the new day", async () => {
    respond = () => ({ status: 503 });
    const m = make();
    fail(m, undefined, 3);
    await m.flush(); // counted on the 24th
    at(16 * 60 * MIN); // 01:00 on the 25th
    fail(m, undefined, 2);
    respond = (n) => (n === 2 ? { status: 200, body: { droppedEvents: [{ index: 0, reason: "unparseable" }] } } : { status: 200 });
    await m.flush();
    expect(hits[1].events).toHaveLength(2);
    expect(m.stats().cloud).toMatchObject({ refused: 1, today: 1 });
  });

  it("the per-day place is given back once, however often the event is named", async () => {
    respond = (n) => (n === 1 ? { status: 200, body: { droppedEvents: [{ index: 0, reason: "x" }, { index: 0, reason: "x" }] } } : { status: 200 });
    const m = make();
    fail(m, "one problem with the disk", 2);
    fail(m, "another problem with the net", 1);
    await m.flush();
    expect(m.stats().cloud.today).toBe(1);
    expect(m.stats().cloud.refused).toBe(2);
  });

  it("the app's own client tells nobody: nothing is rolled back, nothing waits", async () => {
    respond = () => ({ status: 401 });
    init({ clientKey: "osk_fromInit0123456789", dsn: url, onDropped: () => undefined });
    const m = make(undefined, true);
    fail(m, undefined, 3);
    await m.flush();
    expect(hits).toHaveLength(1);
    expect(group(states.at(-1))).toMatchObject({ sentAt: T0, sentTotal: 3 });
    expect(m.stats().cloud.pausedUntil).toBeUndefined();
    at(2 * MIN);
    fail(m);
    await m.flush();
    expect(hits).toHaveLength(1);
  });
});

describe("the back-off", () => {
  it("a key that is always refused is asked 1, 2, 4 ... 60 minutes apart, and a send that is taken ends it", async () => {
    respond = () => ({ status: 401 });
    const m = make();
    let now = 0;
    const asked: number[] = [];
    for (let i = 0; i < 9; i++) {
      at(now);
      fail(m);
      const before = hits.length;
      await m.flush();
      expect(hits.length).toBe(before + 1);
      asked.push(now);
      const until = Date.parse(m.stats().cloud.pausedUntil as string) - T0;
      at(until - 1);
      fail(m);
      const skipped = m.stats().cloud.skipped;
      await m.flush();
      expect(hits.length).toBe(before + 1); // nothing while it lasts
      expect(m.stats().cloud.skipped).toBe(skipped);
      now = until;
    }
    expect(asked.slice(1).map((t, i) => (t - asked[i]) / MIN)).toEqual([1, 2, 4, 8, 16, 32, 60, 60]);
    respond = () => ({ status: 200 });
    at(now);
    fail(m);
    await m.flush();
    expect(m.stats().cloud.pausedUntil).toBeUndefined();
    respond = () => ({ status: 401 });
    at(now + 61 * MIN);
    fail(m);
    await m.flush();
    expect(Date.parse(m.stats().cloud.pausedUntil as string) - (T0 + now + 61 * MIN)).toBe(MIN);
  });
});
