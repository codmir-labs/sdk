/** What `sendFeedback` answers: every status, `Retry-After`, a bad answer, the timeout, one request for one text, no network. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeedbackResult } from "../index";
import { DSN, setup, teardown, type Harness } from "./harness";

let h: Harness;
afterEach(() => teardown(h));

const answer = (status: number, body = "", headers: Record<string, string> = {}) => ({ status, body, headers });

describe("every status and its result", () => {
  it("201 with the id, the token and `known`", async () => {
    h = await setup({});
    h.door.queue.push(answer(201, JSON.stringify({ id: "fb_9", reporterToken: "tok", known: true })));
    expect(await h.fb.sendFeedback("hello")).toEqual({ ok: true, id: "fb_9", reporterToken: "tok", known: true });
  });

  it.each([
    [400, "refused"],
    [401, "unauthorized"],
    [402, "payment_required"],
    [403, "refused"],
    [404, "unavailable"],
    [405, "refused"],
    [408, "refused"],
    [413, "refused"],
    [422, "refused"],
    [429, "rate_limited"],
    [500, "unavailable"],
    [502, "unavailable"],
    [503, "unavailable"],
    [504, "unavailable"],
    [302, "unavailable"],
    [204, "unavailable"],
  ] as const)("%i is %s, with its status", async (status, reason) => {
    h = await setup({});
    h.door.queue.push(answer(status, status === 204 ? "" : JSON.stringify({ error: "x" })));
    expect(await h.fb.sendFeedback("hello")).toEqual({ ok: false, reason, status });
  });

  it("a wrong key is unauthorized through the door itself", async () => {
    h = await setup({ clientKey: "osk_other" });
    expect(await h.fb.sendFeedback("hello")).toEqual({ ok: false, reason: "unauthorized", status: 401 });
  });

  it("a network error is unavailable, with no status", async () => {
    h = await setup({});
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    expect(await h.fb.sendFeedback("hello")).toEqual({ ok: false, reason: "unavailable" });
  });

  it("a fetch that throws at once, not by a rejection, is unavailable too", async () => {
    h = await setup({});
    vi.stubGlobal("fetch", () => { throw new Error("sync"); });
    expect(await h.fb.sendFeedback("hello")).toEqual({ ok: false, reason: "unavailable" });
  });

  it("no fetch at all is unavailable", async () => {
    h = await setup({});
    vi.stubGlobal("fetch", undefined);
    expect(await h.fb.sendFeedback("hello")).toEqual({ ok: false, reason: "unavailable" });
  });

});

describe("Retry-After", () => {
  const retry = async (value: string | null): Promise<FeedbackResult> => {
    h = await setup({});
    h.door.queue.push(answer(429, "{}", value === null ? {} : { "retry-after": value }));
    return h.fb.sendFeedback("hello");
  };

  it("seconds become milliseconds", async () => {
    expect(await retry("30")).toEqual({ ok: false, reason: "rate_limited", status: 429, retryAfterMs: 30000 });
    teardown(h);
    expect(await retry("0")).toMatchObject({ retryAfterMs: 0 });
  });

  it("an HTTP date is the time until then", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-24T10:00:00Z"));
    expect(await retry("Tue, 24 Nov 2026 10:01:30 GMT")).toMatchObject({ retryAfterMs: 90000 });
  });

  it("a date in the past, junk, a negative number, a fraction and an absent header give none", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-24T10:00:00Z"));
    for (const value of ["Tue, 24 Nov 2026 09:00:00 GMT", "soon", "-5", "1.5", "", "10 minutes", "1e9", "99999999999999"]) {
      const result = await retry(value);
      expect(result, value).toEqual({ ok: false, reason: "rate_limited", status: 429 });
      teardown(h);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-24T10:00:00Z"));
    }
    expect(await retry(null)).toEqual({ ok: false, reason: "rate_limited", status: 429 });
  });

  it("is never more than a day", async () => {
    expect(await retry("999999999")).toMatchObject({ retryAfterMs: 86400000 });
  });

  it("a 503 carries it too", async () => {
    h = await setup({});
    h.door.queue.push(answer(503, "", { "retry-after": "7" }));
    expect(await h.fb.sendFeedback("hello")).toEqual({ ok: false, reason: "unavailable", status: 503, retryAfterMs: 7000 });
  });
});

describe("an answer that is not the door's", () => {
  it.each([
    ["HTML", answer(200, "<html><body>Sign in to the Wi-Fi</body></html>", { "content-type": "text/html" })],
    ["HTML with a 201", answer(201, "<html></html>")],
    ["empty", answer(201, "")],
    ["null", answer(201, "null")],
    ["an array", answer(201, "[]")],
    ["another shape", answer(201, JSON.stringify({ ok: true, ticket: "x" }))],
    ["no token", answer(201, JSON.stringify({ id: "a", known: false }))],
    ["an id as a number", answer(201, JSON.stringify({ id: 5, reporterToken: "t", known: false }))],
    ["an empty id", answer(201, JSON.stringify({ id: "", reporterToken: "t", known: false }))],
    ["too large", answer(201, JSON.stringify({ id: "a", reporterToken: "t", known: false, pad: "x".repeat(5000) }))],
  ])("%s is unavailable", async (_name, a) => {
    h = await setup({});
    h.door.queue.push(a);
    const result = await h.fb.sendFeedback("hello");
    expect(result).toMatchObject({ ok: false, reason: "unavailable" });
    expect(h.fb.listFeedback()).toEqual([]);
  });
});

describe("`known`", () => {
  it.each([
    ["true", true, true],
    ["false", false, false],
    ["absent", undefined, false],
    ["a word", "yes", false],
  ])("%s: the feedback was stored, so it is never a failure", async (_name, known, expected) => {
    h = await setup({});
    h.door.queue.push(answer(201, JSON.stringify({ id: "a", reporterToken: "t", known })));
    expect(await h.fb.sendFeedback("hello")).toEqual({ ok: true, id: "a", reporterToken: "t", known: expected });
  });
});

describe("the timeout", () => {
  /** A fetch that never answers, and ignores the abort. */
  const hang = () => vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));

  it("10 seconds by default, then unavailable", async () => {
    h = await setup({});
    vi.useFakeTimers();
    hang();
    let done: FeedbackResult | undefined;
    void h.fb.sendFeedback("hello").then((r) => (done = r));
    await vi.advanceTimersByTimeAsync(9999);
    expect(done).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toEqual({ ok: false, reason: "unavailable" });
  });

  it("aborts the request it started", async () => {
    h = await setup({});
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    }));
    const pending = h.fb.sendFeedback({ text: "hello", timeoutMs: 2000 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toEqual({ ok: false, reason: "unavailable" });
    expect(signal!.aborted).toBe(true);
  });

  it("`timeoutMs` is held between 1 and 60 seconds", async () => {
    for (const [given, ms] of [[5, 1000], [999999, 60000], [3000, 3000], ["x", 10000], [NaN, 10000]] as const) {
      h = await setup({});
      vi.useFakeTimers();
      hang();
      let done = false;
      void h.fb.sendFeedback({ text: "hello", timeoutMs: given as number }).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(ms - 1);
      expect(done, `${given} before ${ms}`).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(done, `${given} at ${ms}`).toBe(true);
      teardown(h);
    }
  });

  it("leaves no timer behind: after an answer, a refusal or a network error", async () => {
    h = await setup({});
    vi.useFakeTimers();
    for (const status of [201, 429, 500]) {
      h.door.queue.push(answer(status, status === 201 ? JSON.stringify({ id: "a", reporterToken: "t", known: false }) : "{}"));
      await h.fb.sendFeedback(`hello ${status}`);
      expect(vi.getTimerCount(), `after ${status}`).toBe(0);
    }
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("down"); }));
    await h.fb.sendFeedback("hello offline");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an answer that stalls while its body is read is cut at the timeout too", async () => {
    h = await setup({});
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 201, headers: new Headers(), text: () => new Promise<string>(() => undefined) })));
    const pending = h.fb.sendFeedback({ text: "hello", timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("one text in flight is one request", () => {
  it("two calls with the same text send once and share the result; the next call sends again", async () => {
    h = await setup({});
    const [a, b] = await Promise.all([h.fb.sendFeedback("same words"), h.fb.sendFeedback("same words")]);
    expect(h.door.requests).toHaveLength(1);
    expect(a).toBe(b);
    expect(a).toMatchObject({ ok: true, id: "fb_1" });
    await h.fb.sendFeedback("same words");
    expect(h.door.requests).toHaveLength(2);
  });

  it("the same text with other spaces around it is the same, another text is another request", async () => {
    h = await setup({});
    await Promise.all([h.fb.sendFeedback("same"), h.fb.sendFeedback("  same "), h.fb.sendFeedback("other")]);
    expect(h.door.requests).toHaveLength(2);
  });

  it("a failed request is forgotten at once: the retry sends", async () => {
    h = await setup({});
    h.door.queue.push(answer(500));
    expect(await h.fb.sendFeedback("hello")).toMatchObject({ ok: false });
    expect(await h.fb.sendFeedback("hello")).toMatchObject({ ok: true });
  });
});

describe("no network at all", () => {
  const nothing = async (): Promise<number> => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    return fetchSpy.mock.calls.length;
  };

  it("not_configured: no client, a disabled client, no DSN, no key", async () => {
    h = await setup(null);
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    expect(await h.fb.sendFeedback("hello")).toEqual({ ok: false, reason: "not_configured" });
    teardown(h);

    for (const config of [{ enabled: false }, { dsn: "", clientKey: "" }, { clientKey: "" }, { dsn: DSN, clientKey: "" }]) {
      h = await setup(config as never);
      vi.stubGlobal("fetch", spy);
      expect(await h.fb.sendFeedback("hello"), JSON.stringify(config)).toEqual({ ok: false, reason: "not_configured" });
      teardown(h);
    }
    expect(spy).not.toHaveBeenCalled();
    await nothing();
  });

  it("a client key alone is configured: the default endpoint is Codmir's own, never the page's", async () => {
    h = await setup({ dsn: undefined });
    const spy = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", spy);
    await h.fb.sendFeedback("hello");
    expect(spy.mock.calls[0][0]).toBe("https://www.codmir.com/api/v1/overseer/feedback");
  });

  it("empty and too_long are answered before anything is built", async () => {
    h = await setup({});
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    for (const input of ["", "   \n\t ", undefined, null, 5, {}, { text: "" }, { text: 5 }, { text: "  " }] as never[]) {
      expect(await h.fb.sendFeedback(input), String(input)).toEqual({ ok: false, reason: "empty" });
    }
    expect(await h.fb.sendFeedback("x".repeat(2001))).toEqual({ ok: false, reason: "too_long" });
    expect(await h.fb.sendFeedback({ text: "x".repeat(5000) })).toEqual({ ok: false, reason: "too_long" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("an older client without the method is not_configured, not a crash", async () => {
    h = await setup(null);
    (globalThis as Record<symbol, unknown>)[Symbol.for("codmir.overseer.client")] = {};
    expect(await h.fb.sendFeedback("hello")).toEqual({ ok: false, reason: "not_configured" });
    (globalThis as Record<symbol, unknown>)[Symbol.for("codmir.overseer.client")] = { feedbackContext: () => { throw new Error("no"); } };
    expect(await h.fb.sendFeedback("hello")).toEqual({ ok: false, reason: "not_configured" });
  });
});

describe("a failing replay hook", () => {
  it("does not break the feedback: the body just has no replay", async () => {
    h = await setup({});
    h.overseer.getClient()!.setReplayHook({ getReplayId: () => { throw new Error("recorder gone"); }, onError: () => undefined });
    expect(await h.fb.sendFeedback("hello")).toMatchObject({ ok: true });
    expect(h.door.accepted[0]).not.toHaveProperty("replayId");
  });

  it("and a user whose id getter throws has no id", async () => {
    h = await setup({});
    h.overseer.setUser(Object.defineProperty({}, "id", { get() { throw new Error("no"); } }));
    expect(await h.fb.sendFeedback("hello")).toMatchObject({ ok: true });
    expect(h.door.accepted[0]).not.toHaveProperty("userId");
  });
});
