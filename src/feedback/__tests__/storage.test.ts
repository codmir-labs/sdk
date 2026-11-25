/** The receipts (id, token, time; never the words) and taking one back. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeedbackStorage } from "../index";
import { fakeLocalStorage, setup, teardown, type Harness } from "./harness";

let h: Harness;
afterEach(() => teardown(h));

const KEY = "codmir:feedback";
const ago = (days: number) => new Date(Date.now() - days * 86400000).toISOString();
const stored = (ls: ReturnType<typeof fakeLocalStorage>) => JSON.parse(ls.map.get(KEY) ?? "null") as Record<string, Array<{ id: string; token: string; at: string }>>;

describe("the receipts in localStorage", () => {
  it("one key holds the id, the token and the time, never the text", async () => {
    const ls = fakeLocalStorage();
    vi.stubGlobal("localStorage", ls);
    h = await setup({});
    const text = "my credit card number is 4111 1111 1111 1111";
    const result = await h.fb.sendFeedback(text);
    expect([...ls.map.keys()]).toEqual([KEY]);
    expect(ls.map.get(KEY)).not.toContain("credit");
    expect(ls.map.get(KEY)).not.toContain("4111");
    expect(stored(ls)).toEqual({ osk_test: [{ id: "fb_1", token: "rt_1_secret", at: expect.any(String) }] });
    expect(result).toMatchObject({ ok: true, reporterToken: "rt_1_secret" });
    expect(h.fb.listFeedback()).toEqual([{ id: "fb_1", at: expect.any(String) }]);
  });

  it("keeps the newest 20, newest first", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-24T10:00:00Z"));
    const ls = fakeLocalStorage();
    vi.stubGlobal("localStorage", ls);
    h = await setup({});
    for (let i = 1; i <= 25; i++) {
      await h.fb.sendFeedback(`words ${i}`);
      vi.setSystemTime(Date.now() + 1000);
    }
    const list = h.fb.listFeedback();
    expect(list).toHaveLength(20);
    expect(list.map((r) => r.id)).toEqual(Array.from({ length: 20 }, (_, i) => `fb_${25 - i}`));
    expect(stored(ls).osk_test).toHaveLength(20);
  });

  it("drops entries older than 365 days, on a read and on a write", async () => {
    const ls = fakeLocalStorage({
      [KEY]: JSON.stringify({
        osk_test: [
          { id: "old", token: "t", at: ago(366) },
          { id: "edge", token: "t", at: ago(364) },
        ],
      }),
    });
    vi.stubGlobal("localStorage", ls);
    h = await setup({});
    expect(h.fb.listFeedback().map((r) => r.id)).toEqual(["edge"]);
    await h.fb.sendFeedback("hello");
    expect(stored(ls).osk_test.map((r) => r.id).sort()).toEqual(["edge", "fb_1"]);
  });

  it("checks what it reads, field by field: junk is not an entry, and does not break a send", async () => {
    const junk = [
      "not json",
      "null",
      "42",
      '"text"',
      "[1,2,3]",
      '{"osk_test":"x"}',
      '{"osk_test":{"id":"a"}}',
      JSON.stringify({
        osk_test: [
          null,
          5,
          "x",
          [],
          { id: 5, token: "t", at: ago(1) },
          { id: "", token: "t", at: ago(1) },
          { id: "a", token: "", at: ago(1) },
          { id: "a", token: "t", at: "yesterday-ish" },
          { id: "a", token: "t", at: 0 },
          { id: "a", token: "t" },
          { id: "x".repeat(201), token: "t", at: ago(1) },
          { id: "ok", token: "t", at: ago(1), extra: { evil: true } },
        ],
      }),
      '{"__proto__":{"polluted":true},"osk_test":[]}',
    ];
    for (const raw of junk) {
      const ls = fakeLocalStorage({ [KEY]: raw });
      vi.stubGlobal("localStorage", ls);
      h = await setup({});
      const ids = h.fb.listFeedback().map((r) => r.id);
      expect(ids.every((id) => id === "ok"), raw).toBe(true);
      expect(await h.fb.sendFeedback("hello")).toMatchObject({ ok: true });
      expect(Object.keys(stored(ls).osk_test[0]).sort(), raw).toEqual(["at", "id", "token"]);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      teardown(h);
    }
  });

  it("leaves another project's entries alone", async () => {
    const other = { id: "theirs", token: "their-token", at: ago(2), kept: "as it was" };
    const ls = fakeLocalStorage({ [KEY]: JSON.stringify({ osk_other: [other], osk_test: [] }) });
    vi.stubGlobal("localStorage", ls);
    h = await setup({});
    expect(h.fb.listFeedback()).toEqual([]);
    await h.fb.sendFeedback("hello");
    expect(stored(ls).osk_other).toEqual([other]);
    expect(stored(ls).osk_test).toHaveLength(1);
    h.door.stored.set("fb_1", "rt_1_secret");
    expect(await h.fb.deleteFeedback("fb_1")).toEqual({ ok: true });
    expect(stored(ls).osk_other).toEqual([other]);
    expect(stored(ls).osk_test).toEqual([]);
  });

  it("a full localStorage keeps the receipt in memory instead", async () => {
    const ls = fakeLocalStorage({}, { set: true });
    vi.stubGlobal("localStorage", ls);
    h = await setup({});
    expect(await h.fb.sendFeedback("one")).toMatchObject({ ok: true, id: "fb_1" });
    expect(await h.fb.sendFeedback("two")).toMatchObject({ ok: true, id: "fb_2" });
    expect(ls.map.size).toBe(0);
    expect(h.fb.listFeedback().map((r) => r.id).sort()).toEqual(["fb_1", "fb_2"]);
  });

  it("a localStorage that refuses to be read (private mode, a sandboxed frame) is memory", async () => {
    vi.stubGlobal("localStorage", fakeLocalStorage({}, { get: true, set: true }));
    h = await setup({});
    expect(await h.fb.sendFeedback("one")).toMatchObject({ ok: true });
    expect(h.fb.listFeedback().map((r) => r.id)).toEqual(["fb_1"]);
    teardown(h);
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new DOMException("denied", "SecurityError"); } });
    try {
      h = await setup({});
      expect(await h.fb.sendFeedback("one")).toMatchObject({ ok: true });
      expect(h.fb.listFeedback().map((r) => r.id)).toEqual(["fb_1"]);
    } finally {
      delete (globalThis as Record<string, unknown>).localStorage;
    }
  });

  it("without localStorage (Node, React Native) it is memory, and a fresh load starts empty", async () => {
    h = await setup({});
    expect(typeof localStorage).toBe("undefined");
    await h.fb.sendFeedback("one");
    expect(h.fb.listFeedback().map((r) => r.id)).toEqual(["fb_1"]);
    teardown(h);
    h = await setup({});
    expect(h.fb.listFeedback()).toEqual([]);
  });

  it("is per project key: another key sees none of it", async () => {
    vi.stubGlobal("localStorage", fakeLocalStorage());
    h = await setup({});
    await h.fb.sendFeedback("one");
    h.overseer.init({ dsn: "https://app.example/api/overseer", clientKey: "osk_second" });
    expect(h.fb.listFeedback()).toEqual([]);
    h.overseer.init({ dsn: "https://app.example/api/overseer", clientKey: "osk_test" });
    expect(h.fb.listFeedback()).toHaveLength(1);
  });

  it("lists nothing without a client", async () => {
    h = await setup(null);
    expect(h.fb.listFeedback()).toEqual([]);
  });
});

describe("`storage` in the input", () => {
  const asyncStore = () => {
    const map = new Map<string, string>();
    const store: FeedbackStorage = {
      getItem: async (k) => (await Promise.resolve(), map.get(k) ?? null),
      setItem: async (k, v) => (await Promise.resolve(), void map.set(k, v)),
      removeItem: async (k) => (await Promise.resolve(), void map.delete(k)),
    };
    return { map, store };
  };

  it("an async storage is used and awaited, and not localStorage", async () => {
    const ls = fakeLocalStorage();
    vi.stubGlobal("localStorage", ls);
    h = await setup({});
    const { map, store } = asyncStore();
    const result = await h.fb.sendFeedback({ text: "one", storage: store });
    expect(result).toMatchObject({ ok: true });
    expect(JSON.parse(map.get(KEY)!)).toEqual({ osk_test: [{ id: "fb_1", token: "rt_1_secret", at: expect.any(String) }] });
    expect(map.get(KEY)).not.toContain("one");
    expect(ls.map.size).toBe(0);
  });

  it("an async storage keeps the newest 20 and another project's entries too", async () => {
    h = await setup({});
    const { map, store } = asyncStore();
    map.set(KEY, JSON.stringify({ osk_other: [{ id: "theirs", token: "t", at: ago(1) }] }));
    for (let i = 0; i < 22; i++) await h.fb.sendFeedback({ text: `words ${i}`, storage: store });
    const all = JSON.parse(map.get(KEY)!);
    expect(all.osk_test).toHaveLength(20);
    expect(all.osk_other).toHaveLength(1);
  });

  it("`false` keeps nothing, anywhere", async () => {
    const ls = fakeLocalStorage();
    vi.stubGlobal("localStorage", ls);
    h = await setup({});
    expect(await h.fb.sendFeedback({ text: "one", storage: false })).toMatchObject({ ok: true, reporterToken: "rt_1_secret" });
    expect(ls.map.size).toBe(0);
    expect(h.fb.listFeedback()).toEqual([]);
  });

  it("a storage that throws, rejects or is not one never fails the feedback", async () => {
    h = await setup({});
    const stores = [
      { getItem: () => { throw new Error("a"); }, setItem: () => { throw new Error("b"); }, removeItem: () => undefined },
      { getItem: async () => { throw new Error("a"); }, setItem: async () => { throw new Error("b"); }, removeItem: async () => undefined },
      {},
      "storage",
      7,
      null,
    ];
    for (const [i, storage] of stores.entries()) {
      expect(await h.fb.sendFeedback({ text: `words ${i}`, storage: storage as never })).toMatchObject({ ok: true });
    }
  });
});

describe("taking one back", () => {
  const sendOne = async (config = {}) => {
    vi.stubGlobal("localStorage", fakeLocalStorage());
    h = await setup(config);
    return (await h.fb.sendFeedback("one")) as { id: string; reporterToken: string };
  };

  it("uses the stored token: 204 is ok, and the receipt is forgotten", async () => {
    const sent = await sendOne();
    expect(await h.fb.deleteFeedback(sent.id)).toEqual({ ok: true });
    const request = h.door.requests[1];
    expect(request.method).toBe("DELETE");
    expect(request.url).toBe("https://app.example/api/overseer/feedback/fb_1");
    expect(request.headers).toMatchObject({ "x-overseer-key": "osk_test", "x-reporter-token": sent.reporterToken });
    expect(h.fb.listFeedback()).toEqual([]);
    expect(h.calls[1].init.credentials).toBe("omit");
    expect("keepalive" in h.calls[1].init).toBe(false);
  });

  it("uses the token it is given, over the stored one", async () => {
    await sendOne();
    h.door.queue.push({ status: 204 });
    expect(await h.fb.deleteFeedback("fb_1", "given-token")).toEqual({ ok: true });
    expect(h.door.requests[1].headers["x-reporter-token"]).toBe("given-token");
  });

  it("deletes what was kept in a storage of the caller's, with the token the caller kept", async () => {
    h = await setup({});
    const { reporterToken, id } = (await h.fb.sendFeedback({ text: "one", storage: false })) as { id: string; reporterToken: string };
    expect(await h.fb.deleteFeedback(id, reporterToken)).toEqual({ ok: true });
  });

  it("404 is not_found and forgets the receipt too: the door says 404 for every reason", async () => {
    const sent = await sendOne();
    h.door.stored.clear();
    expect(await h.fb.deleteFeedback(sent.id)).toEqual({ ok: false, reason: "not_found" });
    expect(h.fb.listFeedback()).toEqual([]);
  });

  it("with no stored token and none given, there is nothing to ask: not_found, no request", async () => {
    h = await setup({});
    expect(await h.fb.deleteFeedback("fb_404")).toEqual({ ok: false, reason: "not_found" });
    expect(await h.fb.deleteFeedback("")).toEqual({ ok: false, reason: "not_found" });
    expect(await h.fb.deleteFeedback(5 as never, "t")).toEqual({ ok: false, reason: "not_found" });
    expect(await h.fb.deleteFeedback("a", "")).toEqual({ ok: false, reason: "not_found" });
    expect(h.calls).toHaveLength(0);
  });

  it("offline: unavailable, and the receipt stays for another try", async () => {
    const sent = await sendOne();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    expect(await h.fb.deleteFeedback(sent.id)).toEqual({ ok: false, reason: "unavailable" });
    expect(h.fb.listFeedback()).toHaveLength(1);
  });

  it("a 500, a 401 and a 429 are unavailable, and the receipt stays", async () => {
    const sent = await sendOne();
    for (const status of [500, 401, 429]) {
      h.door.queue.push({ status });
      expect(await h.fb.deleteFeedback(sent.id), String(status)).toEqual({ ok: false, reason: "unavailable" });
    }
    expect(h.fb.listFeedback()).toHaveLength(1);
  });

  it("an id with odd characters is escaped in the address", async () => {
    h = await setup({});
    await h.fb.deleteFeedback("a/b?c#d", "t");
    expect(h.calls[0].url).toBe("https://app.example/api/overseer/feedback/a%2Fb%3Fc%23d");
  });

  it("not_configured without a client, and no request", async () => {
    h = await setup(null);
    expect(await h.fb.deleteFeedback("fb_1", "t")).toEqual({ ok: false, reason: "not_configured" });
    expect(h.calls).toHaveLength(0);
  });

  it("a timeout is unavailable and leaves no timer", async () => {
    const sent = await sendOne();
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
    const pending = h.fb.deleteFeedback(sent.id);
    await vi.advanceTimersByTimeAsync(10000);
    expect(await pending).toEqual({ ok: false, reason: "unavailable" });
    expect(vi.getTimerCount()).toBe(0);
  });
});
