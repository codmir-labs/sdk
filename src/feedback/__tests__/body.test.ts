/** The body `sendFeedback` builds: the exact keys, what each switch does, and a fuzz that no unknown key gets out. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { SDK_INFO } from "../../version";
import { FeedbackBodySchema } from "./door";
import { PAGE, REPLAY_ID, setup, teardown, type Harness } from "./harness";

const NOW = new Date("2026-11-24T10:00:00.000Z");
let h: Harness;
afterEach(() => {
  teardown(h);
  vi.unstubAllEnvs();
});

const ALLOWED = ["text", "replayId", "eventId", "failed", "pagePath", "environment", "release", "userId", "at", "replyWhenFixed", "sdk"];

/** A client in a page that has an error, a failed request, a replay and a signed-in user. */
async function busyPage(): Promise<{ eventId: string }> {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  h = await setup(
    { environment: "production", release: "1.2.3", initialUser: { id: "u-42", email: "ann@example.com", username: "ann" } },
    { page: `${PAGE}/checkout?email=ann%40example.com&token=SECRET#access_token=Z` },
  );
  h.overseer.getClient()!.setReplayHook({ getReplayId: () => REPLAY_ID, onError: () => undefined });
  const eventId = h.overseer.captureException(new Error("save failed"));
  h.overseer.addBreadcrumb({ category: "fetch", message: "POST /api/save", data: { method: "POST", url: `${PAGE}/api/save`, status: 500 } });
  return { eventId };
}

describe("the body", () => {
  it("a full context: the replay, the error, the failed request, the page, the release, the user id and the SDK", async () => {
    const { eventId } = await busyPage();
    const result = await h.fb.sendFeedback({ text: "  the save button does nothing  ", replyWhenFixed: true });
    expect(result).toEqual({ ok: true, id: "fb_1", reporterToken: "rt_1_secret", known: false });
    expect(eventId).toMatch(/^[\w-]{21}$/);
    expect(h.door.accepted).toEqual([
      {
        text: "the save button does nothing",
        replyWhenFixed: true,
        replayId: REPLAY_ID,
        eventId,
        failed: { method: "POST", path: "/api/save", status: 500, at: NOW.toISOString() },
        pagePath: "/checkout",
        environment: "production",
        release: "1.2.3",
        userId: "u-42",
        at: NOW.toISOString(),
        sdk: { name: SDK_INFO.name, version: SDK_INFO.version },
      },
    ]);
  });

  it("goes to <base>/feedback with the key, JSON, no cookies and no keepalive", async () => {
    h = await setup({});
    await h.fb.sendFeedback("hello");
    const [call] = h.calls;
    expect(call.url).toBe("https://app.example/api/overseer/feedback");
    expect(call.init.method).toBe("POST");
    expect(call.init.credentials).toBe("omit");
    expect("keepalive" in call.init).toBe(false);
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
    expect(h.door.requests[0].headers).toMatchObject({ "x-overseer-key": "osk_test", "content-type": "application/json" });
  });

  it("a DSN that already ends in /ingest, or in a slash, gives the same address", async () => {
    for (const dsn of [`${PAGE}/api/overseer/ingest`, `${PAGE}/api/overseer/`, `${PAGE}/api/overseer/ingest/`]) {
      h = await setup({ dsn });
      await h.fb.sendFeedback("hello");
      expect(h.calls[0].url).toBe("https://app.example/api/overseer/feedback");
      teardown(h);
    }
  });

  it("a bare context: the text, the environment, the time and the SDK, nothing else", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    // vitest.setup.ts clears the host's release and environment variables, but leaves NODE_ENV as vitest sets it.
    vi.stubEnv("NODE_ENV", "");
    h = await setup({});
    expect(typeof window).toBe("undefined");
    await h.fb.sendFeedback("hello");
    expect(JSON.parse(h.door.requests[0].raw)).toEqual({
      text: "hello",
      environment: "development",
      at: NOW.toISOString(),
      sdk: { name: SDK_INFO.name, version: SDK_INFO.version },
    });
  });

  it("the release is left out when it is the default `unknown`, and an id that is not a uuid is not sent as a replay", async () => {
    h = await setup({});
    h.overseer.getClient()!.setReplayHook({ getReplayId: () => "not-a-uuid", onError: () => undefined });
    await h.fb.sendFeedback("hello");
    expect(Object.keys(h.door.accepted[0])).not.toContain("release");
    expect(Object.keys(h.door.accepted[0])).not.toContain("replayId");
  });

  it("a user without an id sends no user at all, and a user id of a number is not sent", async () => {
    h = await setup({ initialUser: { email: "ann@example.com", username: "ann" } });
    await h.fb.sendFeedback("hello");
    expect(h.door.accepted[0]).not.toHaveProperty("userId");
    h.overseer.setUser({ id: 7 as unknown as string });
    await h.fb.sendFeedback("hello again");
    expect(h.door.accepted[1]).not.toHaveProperty("userId");
  });

  it("each switch: false for the failed request, the page and the event", async () => {
    await busyPage();
    await h.fb.sendFeedback({ text: "one", failedRequest: false, pagePath: false, eventId: false });
    const body = h.door.accepted[0];
    expect(body).not.toHaveProperty("failed");
    expect(body).not.toHaveProperty("pagePath");
    expect(body).not.toHaveProperty("eventId");
    expect(body).toHaveProperty("replayId");
    expect(body).toHaveProperty("userId");
  });

  it("what the caller gives wins, with a query and a fragment cut off", async () => {
    await busyPage();
    await h.fb.sendFeedback({
      text: "two",
      eventId: "evt_given",
      failedRequest: { method: "put", path: "/api/profile?token=SECRET#x", status: 422 },
      pagePath: "https://other.example/settings/profile?tab=1#top",
    });
    expect(h.door.accepted[0]).toMatchObject({
      eventId: "evt_given",
      failed: { method: "PUT", path: "/api/profile", status: 422, at: NOW.toISOString() },
      pagePath: "/settings/profile",
    });
  });

  it("a given value that does not fit is left out, not swapped for the SDK's own", async () => {
    await busyPage();
    await h.fb.sendFeedback({
      text: "three",
      eventId: "x".repeat(201),
      failedRequest: { method: "GET /", path: "/a", status: 99 },
      pagePath: "/" + "p".repeat(500),
    });
    const body = h.door.accepted[0];
    for (const key of ["eventId", "failed", "pagePath"]) expect(body).not.toHaveProperty(key);
  });

  it("values over the door's limits are left out: a long environment, release and user id", async () => {
    h = await setup({ environment: "e".repeat(81), release: "r".repeat(121), initialUser: { id: "u".repeat(201) } });
    await h.fb.sendFeedback("hello");
    for (const key of ["environment", "release", "userId"]) expect(h.door.accepted[0]).not.toHaveProperty(key);
    teardown(h);
    h = await setup({ environment: "e".repeat(80), release: "r".repeat(120), initialUser: { id: "u".repeat(200) } });
    await h.fb.sendFeedback("hello");
    expect(h.door.accepted[0]).toMatchObject({ environment: "e".repeat(80), release: "r".repeat(120), userId: "u".repeat(200) });
  });

  it("2000 characters go, a trimmed 2001 is refused and never cut", async () => {
    h = await setup({});
    expect((await h.fb.sendFeedback("é".repeat(2000))).ok).toBe(true);
    expect(await h.fb.sendFeedback("é".repeat(2001))).toEqual({ ok: false, reason: "too_long" });
    expect(h.door.requests).toHaveLength(1);
    expect(h.door.accepted[0].text).toHaveLength(2000);
  });

  it("a body past 16 KB sends the words alone: control characters that JSON escapes six-fold in every field", async () => {
    h = await setup({ environment: "\u0001".repeat(80), release: "\u0001".repeat(120), initialUser: { id: "\u0001".repeat(200) } });
    const result = await h.fb.sendFeedback({ text: "\u0001".repeat(2000), eventId: "\u0001".repeat(200), pagePath: "/" + "\u0001".repeat(499) });
    expect(result.ok).toBe(true);
    expect(Buffer.byteLength(h.door.requests[0].raw)).toBeLessThanOrEqual(16 * 1024);
  });
});

// --- a body with a key outside the list never leaves ---

function prng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("fuzz: 2000 odd inputs", () => {
  it("every one resolves to a result, and every body sent has the listed keys only, in the door's shape", async () => {
    h = await setup({ initialUser: { id: "u-1", email: "ann@example.com" } }, { page: `${PAGE}/p?q=1` });
    const rnd = prng(7868);
    const pick = <T,>(list: T[]): T => list[Math.floor(rnd() * list.length)];
    const thrower = () =>
      new Proxy({}, { get: () => { throw new Error("boom"); }, has: () => { throw new Error("boom"); }, ownKeys: () => { throw new Error("boom"); } });
    const odd = (): unknown =>
      pick<() => unknown>([
        () => undefined,
        () => null,
        () => true,
        () => false,
        () => 0,
        () => -1,
        () => NaN,
        () => Infinity,
        () => 1e21,
        () => 404,
        () => "",
        () => "   ",
        () => "hello",
        () => "x".repeat(2001),
        () => "x".repeat(200000),
        () => "\u0000".repeat(2000),
        () => "é".repeat(2000),
        () => "\ud800",
        () => "/p?q=1#f",
        () => "https://evil.example/a/b?c=d#e",
        () => "__proto__",
        () => [],
        () => [1, "a"],
        () => ({}),
        () => ({ method: "post", path: "/x?y", status: 500 }),
        () => ({ method: "GET", path: "/" + "p".repeat(600), status: 500, at: "never" }),
        () => ({ method: "G".repeat(11), path: "/a", status: 500 }),
        () => ({ method: "GET", path: "/a", status: 1.5, at: 5 }),
        () => Symbol("s"),
        () => 10n,
        () => () => 1,
        () => new Date(NaN),
        () => new Date(),
        () => ({ getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("full"); }, removeItem: () => undefined }),
        () => ({ getItem: async () => 5, setItem: () => 7 }),
        thrower,
      ])();
    const withGetters = (keys: string[]): Record<string, unknown> => {
      const o: Record<string, unknown> = {};
      for (const key of keys) {
        if (rnd() < 0.1) Object.defineProperty(o, key, { enumerable: true, get() { throw new Error(`getter ${key}`); } });
        else o[key] = odd();
      }
      return o;
    };
    const KEYS = ["text", "replyWhenFixed", "eventId", "failedRequest", "pagePath", "storage", "timeoutMs", "constructor", "prototype", "admin", "userId", "replayId", "at", "sdk"];
    for (let i = 0; i < 2000; i++) {
      let input: unknown;
      const kind = rnd();
      if (kind < 0.1) input = odd();
      else if (kind < 0.2) input = JSON.parse('{"__proto__":{"admin":true,"text":"polluted"},"text":"proto","constructor":{"prototype":{"x":1}}}');
      else {
        const subset = KEYS.filter(() => rnd() < 0.35);
        const o = withGetters(subset);
        if (rnd() < 0.8 && !subset.includes("text")) o.text = pick(["hello", "fuzz " + i, "é".repeat(100)]);
        input = o;
      }
      let result: unknown;
      await expect((async () => { result = await h.fb.sendFeedback(input as never); })()).resolves.toBeUndefined();
      expect(typeof (result as { ok: unknown }).ok).toBe("boolean");
    }
    expect(h.door.requests.length).toBeGreaterThan(300);
    for (const request of h.door.requests) {
      const sent = JSON.parse(request.raw) as Record<string, unknown>;
      expect(Object.keys(sent).filter((k) => !ALLOWED.includes(k))).toEqual([]);
      if (sent.failed) expect(Object.keys(sent.failed as object).sort()).toEqual(["at", "method", "path", "status"]);
      expect(Object.keys(sent.sdk as object).sort()).toEqual(["name", "version"]);
      expect(FeedbackBodySchema.safeParse(sent).success).toBe(true);
      // nothing personal the person did not type
      expect(request.raw).not.toContain("ann@example.com");
      expect(request.raw).not.toContain("polluted");
      expect(request.status).toBe(201);
    }
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});
