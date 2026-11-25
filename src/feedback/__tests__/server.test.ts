/**
 * On a server every visitor shares one client. Nothing of it but the environment, the release and the SDK may reach a
 * visitor's feedback, nothing is kept, and two visitors with the same words are two requests.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { SDK_INFO } from "../../version";
import { PAGE, REPLAY_ID, fakeLocalStorage, setup, teardown, type Harness } from "./harness";

let h: Harness;
afterEach(() => teardown(h));

/** A client that holds what another visitor's request left in it. */
async function busy(opts: { server?: boolean } = {}): Promise<string> {
  h = await setup({ environment: "production", release: "1.2.3", initialUser: { id: "u-other" } }, { page: `${PAGE}/checkout`, ...opts });
  h.overseer.getClient()!.setReplayHook({ getReplayId: () => REPLAY_ID, onError: () => undefined });
  h.overseer.addBreadcrumb({ category: "fetch", message: "POST /api/save", data: { method: "POST", url: `${PAGE}/api/save`, status: 500 } });
  return h.overseer.captureException(new Error("another visitor's error"));
}
const bare = { environment: "production", release: "1.2.3", at: expect.any(String), sdk: { ...SDK_INFO } };

describe("on a server (no document)", () => {
  it("takes no error, failed request, replay, user or page from the client", async () => {
    await busy({ server: true });
    expect(await h.fb.sendFeedback({ text: "it does not work" })).toMatchObject({ ok: true });
    expect(h.door.accepted).toEqual([{ text: "it does not work", ...bare }]);
  });

  it("sends what it is given", async () => {
    await busy({ server: true });
    const at = new Date().toISOString();
    const given = { replayId: "0f8b1f5e-7d0a-4a55-8c0e-2f6f1f1f6a01", eventId: "evt_mine", userId: "u-mine", replyWhenFixed: true };
    await h.fb.sendFeedback({ text: "mine", ...given, pagePath: "/cart?token=x", failedRequest: { method: "get", path: "/api/cart?id=1", status: 404, at } });
    expect(h.door.accepted).toEqual([{ text: "mine", ...given, pagePath: "/cart", failed: { method: "GET", path: "/api/cart", status: 404, at }, ...bare }]);
  });

  it("two visitors who say the same at the same moment are two requests, each with a token of its own", async () => {
    await busy({ server: true });
    const [a, b] = await Promise.all([h.fb.sendFeedback("it does not work"), h.fb.sendFeedback("it does not work")]);
    expect(h.door.requests).toHaveLength(2);
    expect(a).toMatchObject({ ok: true, id: "fb_1" });
    expect(b).toMatchObject({ ok: true, id: "fb_2" });
    expect((a as { reporterToken: string }).reporterToken).not.toBe((b as { reporterToken: string }).reporterToken);
  });

  it("keeps nothing, so one visitor cannot list or take back what another sent", async () => {
    const ls = fakeLocalStorage();
    const reads = vi.fn();
    vi.stubGlobal("localStorage", { ...ls, getItem: (k: string) => (reads(), ls.getItem(k)), setItem: (k: string, v: string) => (reads(), ls.setItem(k, v)) });
    await busy({ server: true });
    const sent = (await h.fb.sendFeedback("mine")) as { id: string; reporterToken: string };
    expect(h.fb.listFeedback()).toEqual([]);
    expect(await h.fb.deleteFeedback(sent.id)).toEqual({ ok: false, reason: "not_found" });
    expect(h.door.requests).toHaveLength(1);
    expect(await h.fb.deleteFeedback(sent.id, sent.reporterToken)).toEqual({ ok: true });
    expect(reads).not.toHaveBeenCalled();
  });

  it("a storage it is given is used", async () => {
    await busy({ server: true });
    const own = fakeLocalStorage();
    await h.fb.sendFeedback({ text: "mine", storage: own });
    expect(JSON.parse(own.map.get("codmir:feedback")!)).toEqual({ osk_test: [{ id: "fb_1", token: expect.any(String), at: expect.any(String) }] });
  });
});

describe("in a page and in React Native there is one visitor", () => {
  it("a page: the client's own context is sent, and what the caller gives wins", async () => {
    const eventId = await busy();
    await h.fb.sendFeedback({ text: "mine", replayId: false, userId: "u-mine" });
    expect(h.door.accepted[0]).toMatchObject({ eventId, userId: "u-mine", pagePath: "/checkout", failed: { path: "/api/save" } });
    expect(h.door.accepted[0]).not.toHaveProperty("replayId");
    await h.fb.sendFeedback({ text: "mine too", replayId: "not a uuid", userId: false });
    expect(h.door.accepted[1]).not.toHaveProperty("replayId");
    expect(h.door.accepted[1]).not.toHaveProperty("userId");
  });

  it("React Native: no document, and still one visitor, with the receipts in memory", async () => {
    vi.stubGlobal("navigator", { product: "ReactNative" });
    const eventId = await busy({ server: true });
    const [a, b] = await Promise.all([h.fb.sendFeedback("same"), h.fb.sendFeedback("same")]);
    expect(a).toBe(b);
    expect(h.door.accepted[0]).toMatchObject({ eventId, replayId: REPLAY_ID, userId: "u-other" });
    expect(h.fb.listFeedback().map((r) => r.id)).toEqual(["fb_1"]);
    expect(await h.fb.deleteFeedback("fb_1")).toEqual({ ok: true });
  });
});
