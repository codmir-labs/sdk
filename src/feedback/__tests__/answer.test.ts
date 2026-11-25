/** `answerFeedback`: the body, every row of the results table, the receipts left alone, the order of two answers. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DSN, fakeLocalStorage, setup, teardown, type Harness } from "./harness";

let h: Harness;
afterEach(() => teardown(h));

const KEY = "codmir:feedback";
const answer = (status: number, body = "", headers: Record<string, string> = {}) => ({ status, body, headers });
const fixed = { state: "fixed" as const, release: "1.4.2", fixedAt: "2026-11-24T09:00:00.000Z", reply: "It was the save button." };
/** A page with one stored receipt (fb_1 / rt_1_secret) whose entry is fixed. */
const page = async (config = {}) => {
  const ls = fakeLocalStorage();
  vi.stubGlobal("localStorage", ls);
  h = await setup(config);
  await h.fb.sendFeedback("hello");
  h.door.states.set("fb_1", { ...fixed });
  h.door.requests.length = 0;
  h.calls.length = 0;
  return ls;
};

describe("the answer", () => {
  it("better: a POST of exactly { better: true }, the key and the token in headers, no cookies, no keepalive", async () => {
    await page();
    expect(await h.fb.answerFeedback("fb_1", true)).toEqual({ ok: true, ...fixed, answer: "better" });
    const { url, init } = h.calls[0];
    expect(url).toBe(`${DSN}/feedback/fb_1/answer`);
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"better":true}');
    expect(init.credentials).toBe("omit");
    expect(init.keepalive).toBeUndefined();
    expect(url).not.toContain("rt_1_secret");
    expect(Object.fromEntries(new Headers(init.headers))).toEqual({ "x-overseer-key": "osk_test", "x-reporter-token": "rt_1_secret", "content-type": "application/json" });
    expect(h.door.answers).toEqual([{ id: "fb_1", better: true }]);
  });

  it("not better", async () => {
    await page();
    expect(await h.fb.answerFeedback("fb_1", false)).toMatchObject({ ok: true, state: "fixed", answer: "not_better" });
    expect(h.calls[0].init.body).toBe('{"better":false}');
  });

  it("a second answer replaces the first", async () => {
    await page();
    await h.fb.answerFeedback("fb_1", true);
    expect(await h.fb.answerFeedback("fb_1", false)).toMatchObject({ answer: "not_better" });
    expect((await h.fb.feedbackStatus("fb_1")) as { answer: string }).toMatchObject({ answer: "not_better" });
  });

  it("the id is encoded", async () => {
    h = await setup({});
    await h.fb.answerFeedback("a/b?c", true, "tok");
    expect(h.calls[0].url).toBe(`${DSN}/feedback/a%2Fb%3Fc/answer`);
  });
});

describe("no request", () => {
  it.each([["yes"], [1], [0], [null], [undefined], ["true"], [{}], [[true]]])("better = %j is refused", async (better) => {
    await page();
    expect(await h.fb.answerFeedback("fb_1", better as never)).toEqual({ ok: false, reason: "refused" });
    expect(h.calls).toHaveLength(0);
  });

  it("no id, no token: not_found", async () => {
    h = await setup({});
    expect(await h.fb.answerFeedback("fb_1", true)).toEqual({ ok: false, reason: "not_found" });
    expect(await h.fb.answerFeedback("", true, "t")).toEqual({ ok: false, reason: "not_found" });
    expect(await h.fb.answerFeedback("fb_1", true, "")).toEqual({ ok: false, reason: "not_found" });
    expect(h.calls).toHaveLength(0);
  });

  it("on a server the stored token is never used", async () => {
    const ls = fakeLocalStorage({ [KEY]: JSON.stringify({ osk_test: [{ id: "fb_1", token: "rt_1_secret", at: new Date().toISOString() }] }) });
    vi.stubGlobal("localStorage", ls);
    h = await setup({}, { server: true });
    expect(await h.fb.answerFeedback("fb_1", true)).toEqual({ ok: false, reason: "not_found" });
    expect(h.calls).toHaveLength(0);
  });

  it("another project key's receipt is not used", async () => {
    vi.stubGlobal("localStorage", fakeLocalStorage({ [KEY]: JSON.stringify({ osk_other: [{ id: "fb_1", token: "rt_1_secret", at: new Date().toISOString() }] }) }));
    h = await setup({});
    expect(await h.fb.answerFeedback("fb_1", true)).toEqual({ ok: false, reason: "not_found" });
    expect(h.calls).toHaveLength(0);
  });

  it("not configured", async () => {
    h = await setup(null);
    expect(await h.fb.answerFeedback("fb_1", true, "t")).toEqual({ ok: false, reason: "not_configured" });
    expect(h.calls).toHaveLength(0);
  });
});

describe("every status and its result", () => {
  it.each([
    [401, "unauthorized"],
    [404, "not_found"],
    [409, "not_fixed"],
    [429, "rate_limited"],
    [503, "unavailable"],
    [400, "refused"],
    [413, "refused"],
    [403, "refused"],
    [422, "refused"],
    [500, "unavailable"],
    [502, "unavailable"],
    [302, "unavailable"],
    [204, "unavailable"],
  ] as const)("%i is %s, with its status", async (status, reason) => {
    await page();
    h.door.queue.push(answer(status, status === 204 ? "" : JSON.stringify({ error: "x" })));
    expect(await h.fb.answerFeedback("fb_1", true)).toEqual({ ok: false, reason, status });
  });

  it("409 through the door: the entry is not fixed", async () => {
    await page();
    h.door.states.set("fb_1", { state: "known" });
    expect(await h.fb.answerFeedback("fb_1", true)).toEqual({ ok: false, reason: "not_fixed", status: 409 });
    h.door.states.set("fb_1", { state: "received" });
    expect(await h.fb.answerFeedback("fb_1", true)).toEqual({ ok: false, reason: "not_fixed", status: 409 });
    expect(h.door.answers).toEqual([]);
  });

  it("429 carries Retry-After", async () => {
    await page();
    h.door.queue.push(answer(429, "{}", { "retry-after": "30" }));
    expect(await h.fb.answerFeedback("fb_1", true)).toEqual({ ok: false, reason: "rate_limited", status: 429, retryAfterMs: 30000 });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-24T10:00:00Z"));
    h.door.queue.push(answer(429, "{}", { "retry-after": "Tue, 24 Nov 2026 10:01:00 GMT" }));
    expect(await h.fb.answerFeedback("fb_1", true)).toEqual({ ok: false, reason: "rate_limited", status: 429, retryAfterMs: 60000 });
  });

  it("a wrong token and another project's entry are 404", async () => {
    await page();
    expect(await h.fb.answerFeedback("fb_1", true, "wrong")).toEqual({ ok: false, reason: "not_found", status: 404 });
    expect(await h.fb.answerFeedback("fb_9", true, "rt_1_secret")).toEqual({ ok: false, reason: "not_found", status: 404 });
  });

  it("a network error, a throw at once, no fetch and the timeout are unavailable", async () => {
    await page();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    expect(await h.fb.answerFeedback("fb_1", true)).toEqual({ ok: false, reason: "unavailable" });
    vi.stubGlobal("fetch", () => { throw new Error("sync"); });
    expect(await h.fb.answerFeedback("fb_1", true)).toEqual({ ok: false, reason: "unavailable" });
    vi.stubGlobal("fetch", undefined);
    expect(await h.fb.answerFeedback("fb_1", true)).toEqual({ ok: false, reason: "unavailable" });
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    const pending = h.fb.answerFeedback("fb_1", true);
    await vi.advanceTimersByTimeAsync(10000);
    expect(await pending).toEqual({ ok: false, reason: "unavailable" });
    await vi.advanceTimersByTimeAsync(100000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("the receipts are never changed", () => {
  it.each([[200], [404], [409], [401], [429], [400], [503]])("byte for byte after a %i", async (status) => {
    const ls = await page();
    const before = ls.map.get(KEY);
    h.door.queue.push(answer(status, status === 200 ? JSON.stringify({ state: "fixed" }) : "{}"));
    await h.fb.answerFeedback("fb_1", true);
    expect(ls.map.get(KEY)).toBe(before);
  });

  it("an older server forgets nothing", async () => {
    const ls = await page();
    const before = ls.map.get(KEY);
    h.door.older = true;
    expect(await h.fb.answerFeedback("fb_1", true)).toEqual({ ok: false, reason: "not_found", status: 404 });
    expect(ls.map.get(KEY)).toBe(before);
    expect(h.fb.listFeedback()).toHaveLength(1);
  });
});

describe("a hostile answer", () => {
  const read = async (body: string) => {
    await page();
    h.door.queue.push(answer(200, body));
    return h.fb.answerFeedback("fb_1", true);
  };

  it.each([
    ["an unknown state", '{"state":"wontfix"}'],
    ["not JSON", "<html></html>"],
    ["an array", "[]"],
    ["over the limit", JSON.stringify({ state: "fixed", reply: "x".repeat(9000) })],
  ])("%s is unavailable, with the status", async (_n, body) => {
    expect(await read(body)).toEqual({ ok: false, reason: "unavailable", status: 200 });
  });

  it("numbers for strings, a long reply and __proto__ become null and nothing is copied", async () => {
    const result = await read('{"state":"fixed","release":5,"fixedAt":7,"reply":"' + "r".repeat(10000).slice(0, 1001) + '","answer":true,"__proto__":{"x":1}}');
    expect(result).toEqual({ ok: true, state: "fixed", release: null, fixedAt: null, reply: null, answer: null });
  });

  it("not fixed: the reply is not kept", async () => {
    expect(await read('{"state":"known","reply":"<b>x</b>","answer":"better","release":"1"}')).toEqual({ ok: true, state: "known", release: null, fixedAt: null, reply: null, answer: null });
  });
});

describe("two answers", () => {
  /** A fetch that holds each request until it is released, and records the order they were sent in. */
  const held = () => {
    const sent: string[] = [];
    const releases: Array<() => void> = [];
    const orig = globalThis.fetch;
    vi.stubGlobal("fetch", (u: string, init: RequestInit) => {
      sent.push(String(init.body));
      return new Promise<Response>((resolve) => releases.push(() => resolve(orig(u, init))));
    });
    const tick = () => new Promise((r) => setTimeout(r, 5));
    return { sent, releases, tick, restore: () => vi.stubGlobal("fetch", orig) };
  };

  it("are never merged, and the second is sent only after the first is done", async () => {
    await page();
    const { sent, releases, tick, restore } = held();
    const a = h.fb.answerFeedback("fb_1", true);
    const b = h.fb.answerFeedback("fb_1", false);
    await tick();
    expect(sent).toEqual(['{"better":true}']);
    releases[0]();
    await tick();
    expect(sent).toEqual(['{"better":true}', '{"better":false}']);
    releases[1]();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toMatchObject({ ok: true, answer: "better" });
    expect(rb).toMatchObject({ ok: true, answer: "not_better" });
    expect(h.door.answers.map((x) => x.better)).toEqual([true, false]);
    restore();
    expect((await h.fb.feedbackStatus("fb_1")) as { answer: string }).toMatchObject({ answer: "not_better" });
  });

  it("three in a row arrive in order, also when the first fails", async () => {
    await page();
    h.door.queue.push(answer(503));
    const results = await Promise.all([h.fb.answerFeedback("fb_1", true), h.fb.answerFeedback("fb_1", false), h.fb.answerFeedback("fb_1", true)]);
    expect(results.map((r) => r.ok)).toEqual([false, true, true]);
    expect(h.calls.map((c) => c.init.body)).toEqual(['{"better":true}', '{"better":false}', '{"better":true}']);
  });

  it("another entry does not wait", async () => {
    await page();
    h.door.stored.set("fb_2", "t2");
    h.door.states.set("fb_2", { ...fixed });
    const { sent, tick } = held();
    void h.fb.answerFeedback("fb_1", true);
    void h.fb.answerFeedback("fb_2", false, "t2");
    await tick();
    expect(sent).toHaveLength(2);
  });

  it("the queue is empty afterwards: a later answer is sent at once", async () => {
    await page();
    await h.fb.answerFeedback("fb_1", true);
    await h.fb.answerFeedback("fb_1", false);
    expect(h.calls).toHaveLength(2);
  });
});
