/** `feedbackStatus`: every row of the contract and of the results table, the receipts left alone, a hostile body, one request per page. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DSN, fakeLocalStorage, setup, teardown, type Harness } from "./harness";

let h: Harness;
afterEach(() => teardown(h));

const KEY = "codmir:feedback";
const answer = (status: number, body = "", headers: Record<string, string> = {}) => ({ status, body, headers });
const fixed = { state: "fixed", release: "1.4.2", fixedAt: "2026-11-24T09:00:00.000Z", reply: "It was the save button.", answer: null };
/** A page with one stored receipt (fb_1 / rt_1_secret). */
const page = async (config = {}) => {
  const ls = fakeLocalStorage();
  vi.stubGlobal("localStorage", ls);
  h = await setup(config);
  await h.fb.sendFeedback("hello");
  h.door.requests.length = 0;
  return ls;
};
const lastRequest = () => h.door.requests[h.door.requests.length - 1];

describe("the states", () => {
  it("received: kept, tied to nothing; the four are null", async () => {
    await page();
    expect(await h.fb.feedbackStatus("fb_1")).toEqual({ ok: true, state: "received", release: null, fixedAt: null, reply: null, answer: null });
  });

  it("known", async () => {
    await page();
    h.door.states.set("fb_1", { state: "known", release: "9", reply: "x", answer: "better" });
    expect(await h.fb.feedbackStatus("fb_1")).toEqual({ ok: true, state: "known", release: null, fixedAt: null, reply: null, answer: null });
  });

  it("fixed: the release, the time, the reply and the answer", async () => {
    await page();
    h.door.states.set("fb_1", { ...fixed, answer: "not_better" } as never);
    expect(await h.fb.feedbackStatus("fb_1")).toEqual({ ok: true, ...fixed, answer: "not_better" });
  });

  it("fixed with nothing else: the four stay null", async () => {
    await page();
    h.door.states.set("fb_1", { state: "fixed" });
    expect(await h.fb.feedbackStatus("fb_1")).toEqual({ ok: true, state: "fixed", release: null, fixedAt: null, reply: null, answer: null });
  });

  it("goes back from fixed to known", async () => {
    await page();
    h.door.states.set("fb_1", fixed as never);
    expect((await h.fb.feedbackStatus("fb_1")) as { state: string }).toMatchObject({ state: "fixed" });
    h.door.states.set("fb_1", { state: "known" });
    expect(await h.fb.feedbackStatus("fb_1")).toMatchObject({ ok: true, state: "known", reply: null });
  });
});

describe("the request", () => {
  it("a GET with the key and the token in headers, the id encoded, no body, no cookies, no keepalive, never cached", async () => {
    await page();
    await h.fb.feedbackStatus("fb_1");
    const { url, init } = h.calls[h.calls.length - 1];
    expect(url).toBe(`${DSN}/feedback/fb_1`);
    expect(init.method).toBe("GET");
    expect(init.credentials).toBe("omit");
    expect(init.cache).toBe("no-store");
    expect(init.keepalive).toBeUndefined();
    expect(init.body).toBeUndefined();
    expect(Object.fromEntries(new Headers(init.headers))).toEqual({ "x-overseer-key": "osk_test", "x-reporter-token": "rt_1_secret" });
    expect(url).not.toContain("rt_1_secret");
  });

  it("the id goes through encodeURIComponent, and the token is never in a URL", async () => {
    h = await setup({});
    await h.fb.feedbackStatus("a/b?c=d#e f", "tok en");
    const { url, init } = h.calls[0];
    expect(url).toBe(`${DSN}/feedback/a%2Fb%3Fc%3Dd%23e%20f`);
    expect(url).not.toContain("tok");
    expect(new Headers(init.headers).get("x-reporter-token")).toBe("tok en");
  });

  it("sends nothing it was not given: no breadcrumb, no body", async () => {
    await page();
    const crumbs = h.context().breadcrumbs.length;
    await h.fb.feedbackStatus("fb_1");
    expect(h.context().breadcrumbs).toHaveLength(crumbs);
    expect(lastRequest().raw).toBe("");
  });
});

describe("the token", () => {
  it("the stored one on a page, a given one first", async () => {
    await page();
    expect(await h.fb.feedbackStatus("fb_1")).toMatchObject({ ok: true });
    expect(lastRequest().headers["x-reporter-token"]).toBe("rt_1_secret");
    expect(await h.fb.feedbackStatus("fb_1", "wrong")).toEqual({ ok: false, reason: "not_found", status: 404 });
    expect(lastRequest().headers["x-reporter-token"]).toBe("wrong");
  });

  it("none: not_found and no request", async () => {
    h = await setup({});
    h.door.stored.set("fb_1", "x");
    expect(await h.fb.feedbackStatus("fb_1")).toEqual({ ok: false, reason: "not_found" });
    expect(await h.fb.feedbackStatus("")).toEqual({ ok: false, reason: "not_found" });
    expect(await h.fb.feedbackStatus("fb_1", "")).toEqual({ ok: false, reason: "not_found" });
    expect(await h.fb.feedbackStatus(undefined as never, "t")).toEqual({ ok: false, reason: "not_found" });
    expect(await h.fb.feedbackStatus(7 as never, "t")).toEqual({ ok: false, reason: "not_found" });
    expect(await h.fb.feedbackStatus("fb_1", 5 as never)).toEqual({ ok: false, reason: "not_found" });
    expect(h.calls).toHaveLength(0);
  });

  it("on a server the stored token is never used: only a given one", async () => {
    const ls = fakeLocalStorage({ [KEY]: JSON.stringify({ osk_test: [{ id: "fb_1", token: "rt_1_secret", at: new Date().toISOString() }] }) });
    vi.stubGlobal("localStorage", ls);
    h = await setup({}, { server: true });
    h.door.stored.set("fb_1", "rt_1_secret");
    expect(await h.fb.feedbackStatus("fb_1")).toEqual({ ok: false, reason: "not_found" });
    expect(h.calls).toHaveLength(0);
    expect(await h.fb.feedbackStatus("fb_1", "rt_1_secret")).toMatchObject({ ok: true, state: "received" });
  });

  it("another project key's receipt is not used", async () => {
    const ls = fakeLocalStorage({ [KEY]: JSON.stringify({ osk_other: [{ id: "fb_1", token: "rt_1_secret", at: new Date().toISOString() }] }) });
    vi.stubGlobal("localStorage", ls);
    h = await setup({});
    h.door.stored.set("fb_1", "rt_1_secret");
    expect(await h.fb.feedbackStatus("fb_1")).toEqual({ ok: false, reason: "not_found" });
    expect(h.calls).toHaveLength(0);
  });

  it("not configured: no client, or disabled", async () => {
    h = await setup(null);
    expect(await h.fb.feedbackStatus("fb_1", "t")).toEqual({ ok: false, reason: "not_configured" });
    teardown(h);
    h = await setup({ enabled: false });
    expect(await h.fb.feedbackStatus("fb_1", "t")).toEqual({ ok: false, reason: "not_configured" });
    expect(h.calls).toHaveLength(0);
  });
});

describe("every status and its result", () => {
  it.each([
    [401, "unauthorized"],
    [404, "not_found"],
    [429, "rate_limited"],
    [503, "unavailable"],
    [400, "unavailable"],
    [403, "unavailable"],
    [409, "unavailable"],
    [413, "unavailable"],
    [422, "unavailable"],
    [500, "unavailable"],
    [502, "unavailable"],
    [302, "unavailable"],
    [204, "unavailable"],
  ] as const)("%i is %s, with its status", async (status, reason) => {
    await page();
    h.door.queue.push(answer(status, status === 204 ? "" : JSON.stringify({ error: "x" })));
    expect(await h.fb.feedbackStatus("fb_1")).toEqual({ ok: false, reason, status });
  });

  it("a wrong key is unauthorized through the door itself", async () => {
    h = await setup({ clientKey: "osk_other" });
    expect(await h.fb.feedbackStatus("fb_1", "t")).toEqual({ ok: false, reason: "unauthorized", status: 401 });
  });

  it("429 carries Retry-After as seconds and as a date", async () => {
    await page();
    h.door.queue.push(answer(429, "{}", { "retry-after": "120" }));
    expect(await h.fb.feedbackStatus("fb_1")).toEqual({ ok: false, reason: "rate_limited", status: 429, retryAfterMs: 120000 });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-24T10:00:00Z"));
    h.door.queue.push(answer(429, "{}", { "retry-after": "Tue, 24 Nov 2026 10:05:00 GMT" }));
    expect(await h.fb.feedbackStatus("fb_1")).toEqual({ ok: false, reason: "rate_limited", status: 429, retryAfterMs: 300000 });
    h.door.queue.push(answer(429, "{}", { "retry-after": "soon" }));
    expect(await h.fb.feedbackStatus("fb_1")).toEqual({ ok: false, reason: "rate_limited", status: 429 });
  });

  it("a network error, a throw at once and no fetch are unavailable, with no status", async () => {
    await page();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    expect(await h.fb.feedbackStatus("fb_1")).toEqual({ ok: false, reason: "unavailable" });
    vi.stubGlobal("fetch", () => { throw new Error("sync"); });
    expect(await h.fb.feedbackStatus("fb_1")).toEqual({ ok: false, reason: "unavailable" });
    vi.stubGlobal("fetch", undefined);
    expect(await h.fb.feedbackStatus("fb_1")).toEqual({ ok: false, reason: "unavailable" });
  });

  it("gives up after 10 seconds and aborts the request, with no retry", async () => {
    await page();
    let signal: AbortSignal | undefined;
    const fetchMock = vi.fn((_u: string, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return new Promise<Response>(() => {});
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    const pending = h.fb.feedbackStatus("fb_1");
    await vi.advanceTimersByTimeAsync(9999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ ok: false, reason: "unavailable" });
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(120000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("the receipts are never changed", () => {
  it.each([[404], [401], [429], [503], [200]])("byte for byte after a %i", async (status) => {
    const ls = await page();
    const before = ls.map.get(KEY);
    expect(before).toContain("fb_1");
    h.door.queue.push(answer(status, status === 200 ? JSON.stringify({ state: "known" }) : "{}"));
    await h.fb.feedbackStatus("fb_1");
    expect(ls.map.get(KEY)).toBe(before);
    expect(h.fb.listFeedback()).toHaveLength(1);
  });

  it("an older server (404 to both doors) forgets nothing", async () => {
    const ls = await page();
    const before = ls.map.get(KEY);
    h.door.older = true;
    expect(await h.fb.feedbackStatus("fb_1")).toEqual({ ok: false, reason: "not_found", status: 404 });
    expect(ls.map.get(KEY)).toBe(before);
    expect(h.fb.listFeedback()).toEqual([{ id: "fb_1", at: expect.any(String) }]);
  });

  it("a storage that refuses is not even touched", async () => {
    const ls = fakeLocalStorage({}, { set: true });
    vi.stubGlobal("localStorage", ls);
    h = await setup({});
    const set = vi.spyOn(ls, "setItem");
    await h.fb.feedbackStatus("fb_1", "t");
    expect(set).not.toHaveBeenCalled();
  });
});

describe("the answer is read field by field", () => {
  const read = async (body: unknown, status = 200) => {
    await page();
    h.door.queue.push(answer(status, typeof body === "string" ? body : JSON.stringify(body)));
    return h.fb.feedbackStatus("fb_1");
  };

  it.each([
    ["an unknown state", { state: "wontfix" }],
    ["a state that is a number", { state: 3 }],
    ["a state of the prototype", { state: "constructor" }],
    ["no state", {}],
    ["an array", ["fixed"]],
    ["null", "null"],
    ["a string", '"fixed"'],
    ["not JSON", "<html>hotel wifi</html>"],
    ["nothing", ""],
  ])("%s is unavailable, with the status", async (_n, body) => {
    expect(await read(body)).toEqual({ ok: false, reason: "unavailable", status: 200 });
  });

  it("a body over the size limit is unavailable", async () => {
    expect(await read(JSON.stringify({ state: "fixed", reply: "x".repeat(9000) }))).toEqual({ ok: false, reason: "unavailable", status: 200 });
  });

  it("a reply of 1000 control characters, 6000 in JSON, still fits", async () => {
    const reply = "\u0001".repeat(1000);
    const result = await read({ ...fixed, reply });
    expect(result).toMatchObject({ ok: true, reply });
  });

  it("a part that does not fit becomes null, the others stay", async () => {
    expect(await read({ state: "fixed", release: 12, fixedAt: "yesterday", reply: ["x"], answer: "maybe" })).toEqual({ ok: true, state: "fixed", release: null, fixedAt: null, reply: null, answer: null });
    expect(await read({ state: "fixed", release: "r".repeat(201), fixedAt: 1700000000000, reply: "y".repeat(1001), answer: "better" })).toEqual({ ok: true, state: "fixed", release: null, fixedAt: null, reply: null, answer: "better" });
    expect(await read({ state: "fixed", release: "r".repeat(200), reply: "y".repeat(1000), fixedAt: "2026-11-24T09:00:00Z" })).toMatchObject({ release: "r".repeat(200), reply: "y".repeat(1000), fixedAt: "2026-11-24T09:00:00.000Z" });
    expect(await read({ state: "fixed", release: "", reply: "" })).toMatchObject({ release: null, reply: null });
  });

  it.each(["received", "known"])("the four are null when the state is %s, whatever the body says", async (state) => {
    expect(await read({ state, release: "1", fixedAt: "2026-11-24T09:00:00.000Z", reply: "x", answer: "better" })).toEqual({ ok: true, state, release: null, fixedAt: null, reply: null, answer: null });
  });

  it("__proto__ and other keys are never copied", async () => {
    const result = await read('{"state":"fixed","reply":"ok","__proto__":{"polluted":true},"constructor":{"x":1},"extra":"y"}');
    expect(result).toEqual({ ok: true, state: "fixed", release: null, fixedAt: null, reply: "ok", answer: null });
    expect(Object.keys(result)).toEqual(["ok", "state", "release", "fixedAt", "reply", "answer"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("a reply with HTML is returned as the text it is", async () => {
    const reply = '<img src=x onerror="alert(1)">Fixed';
    expect(await read({ ...fixed, reply })).toMatchObject({ reply });
  });

  it("2xx other than 200 with a good body is read the same; one with a bad body is unavailable", async () => {
    expect(await read({ state: "known" }, 203)).toMatchObject({ ok: true, state: "known" });
  });
});

describe("one request per page", () => {
  const slow = () => {
    const resolvers: Array<() => void> = [];
    const orig = globalThis.fetch;
    const fn = vi.fn((u: string, init: RequestInit) => new Promise<Response>((resolve) => resolvers.push(() => resolve(orig(u, init)))));
    vi.stubGlobal("fetch", fn);
    return { fn, release: () => resolvers.splice(0).forEach((r) => r()) };
  };

  it("two calls for the same id and token while the first is in flight are one request and one result", async () => {
    await page();
    const { fn, release } = slow();
    const a = h.fb.feedbackStatus("fb_1");
    const b = h.fb.feedbackStatus("fb_1");
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(ra).toBe(rb);
    expect(ra).toMatchObject({ ok: true });
  });

  it("a later call, after it ended, is a new request", async () => {
    await page();
    await h.fb.feedbackStatus("fb_1");
    await h.fb.feedbackStatus("fb_1");
    expect(h.door.requests).toHaveLength(2);
  });

  it("another id or another token is another request", async () => {
    await page();
    const { fn, release } = slow();
    const all = Promise.all([h.fb.feedbackStatus("fb_1"), h.fb.feedbackStatus("fb_1", "other"), h.fb.feedbackStatus("fb_2", "other")]);
    release();
    await all;
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("a failed one is not kept: the next call asks again", async () => {
    await page();
    h.door.queue.push(answer(500));
    expect(await h.fb.feedbackStatus("fb_1")).toMatchObject({ ok: false });
    expect(await h.fb.feedbackStatus("fb_1")).toMatchObject({ ok: true });
  });

  it("on a server never merged", async () => {
    h = await setup({}, { server: true });
    h.door.stored.set("fb_1", "t");
    const { fn, release } = slow();
    const a = h.fb.feedbackStatus("fb_1", "t");
    const b = h.fb.feedbackStatus("fb_1", "t");
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(ra).not.toBe(rb);
  });
});
