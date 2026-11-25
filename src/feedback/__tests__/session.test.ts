/** What the session adds by itself: the last error, the last failed request, nothing personal; and the request leaves no trace. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDoor } from "./door";
import { PAGE, setup, teardown, type Harness } from "./harness";

let h: Harness;
afterEach(() => teardown(h));

const NOW = new Date("2026-11-24T10:00:00.000Z");
const MIN = 60_000;
const clock = () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
};
const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);
const sent = async (input: string | object = "hello") => {
  await h.fb.sendFeedback(input as never);
  return h.door.accepted[h.door.accepted.length - 1] as Record<string, unknown>;
};

describe("the last error event", () => {
  it("is the id of the last error captured", async () => {
    h = await setup({});
    h.overseer.captureException(new Error("first"));
    const second = h.overseer.captureException(new Error("second"));
    expect((await sent()).eventId).toBe(second);
  });

  it("is not there when nothing was captured", async () => {
    h = await setup({});
    expect(await sent()).not.toHaveProperty("eventId");
  });

  it("is not an error that was sampled out", async () => {
    h = await setup({ sampleRate: 0 });
    expect(h.overseer.captureException(new Error("x"))).toBe("");
    expect(await sent()).not.toHaveProperty("eventId");
  });

  it("is not an error `beforeSend` dropped, and the one before it stays", async () => {
    let drop = false;
    h = await setup({ beforeSend: (event) => (drop ? null : event) });
    const kept = h.overseer.captureException(new Error("kept"));
    drop = true;
    h.overseer.captureException(new Error("dropped"));
    expect((await sent()).eventId).toBe(kept);
  });

  it("is not an error captured while the SDK is disabled", async () => {
    h = await setup({ enabled: false });
    h.overseer.captureException(new Error("x"));
    expect(h.context().lastError).toBeNull();
  });

  it("is not a message, which is not an error", async () => {
    h = await setup({});
    h.overseer.captureMessage("something happened", "error");
    expect(await sent()).not.toHaveProperty("eventId");
  });

  it("is dropped after 10 minutes, and still there just before", async () => {
    clock();
    h = await setup({});
    const id = h.overseer.captureException(new Error("x"));
    advance(10 * MIN);
    expect((await sent("a")).eventId).toBe(id);
    advance(1);
    expect(await sent("b")).not.toHaveProperty("eventId");
  });

  it("is an error event of the client's own queue only: the last one survives a failing replay hook", async () => {
    h = await setup({});
    h.overseer.getClient()!.setReplayHook({ getReplayId: () => { throw new Error("x"); }, onError: () => { throw new Error("y"); } });
    const id = h.overseer.captureException(new Error("x"));
    expect((await sent()).eventId).toBe(id);
  });
});

describe("the last failed request", () => {
  const crumb = (data: Record<string, unknown>, category = "fetch") => h.overseer.addBreadcrumb({ category, message: "request", data });

  it("is the newest failed request to the page's own origin, as a method and a path", async () => {
    clock();
    h = await setup({}, { page: `${PAGE}/cart` });
    crumb({ method: "GET", url: `${PAGE}/api/old`, status: 404 });
    advance(1000);
    crumb({ method: "POST", url: `${PAGE}/api/pay`, status: 502 });
    advance(1000);
    crumb({ method: "GET", url: `${PAGE}/api/fine`, status: 200 });
    expect((await sent()).failed).toEqual({ method: "POST", path: "/api/pay", status: 502, at: new Date(NOW.getTime() + 1000).toISOString() });
  });

  it("is a request to a `tracePropagationTargets` match, whatever the page", async () => {
    h = await setup({ tracePropagationTargets: ["https://api.shop.example"] });
    crumb({ method: "post", url: "https://api.shop.example/v2/orders", status: 500 });
    expect((await sent()).failed).toMatchObject({ method: "POST", path: "/v2/orders", status: 500 });
  });

  it("is never a third party, and never one that is only like the page", async () => {
    h = await setup({ tracePropagationTargets: ["https://api.shop.example"] }, { page: `${PAGE}/cart` });
    crumb({ method: "GET", url: "https://tracker.example/pixel", status: 500 });
    crumb({ method: "GET", url: "https://app.example.evil.example/api", status: 500 });
    crumb({ method: "GET", url: "http://app.example/api", status: 500 });
    expect(await sent()).not.toHaveProperty("failed");
  });

  it("is never the SDK's own: its ingest, its replay upload, its feedback, whatever failed", async () => {
    h = await setup({}, { page: `${PAGE}/cart` });
    crumb({ method: "POST", url: `${PAGE}/api/overseer/ingest`, status: 500 });
    crumb({ method: "POST", url: `${PAGE}/api/overseer/replay`, status: 503 });
    crumb({ method: "POST", url: `${PAGE}/api/overseer/feedback`, status: 429 });
    crumb({ method: "DELETE", url: `${PAGE}/api/overseer/feedback/fb_1`, status: 500 });
    crumb({ method: "GET", url: `${PAGE}/api/overseer/feedback/fb_1`, status: 404 });
    crumb({ method: "POST", url: `${PAGE}/api/overseer/feedback/fb_1/answer`, status: 409 });
    expect(await sent()).not.toHaveProperty("failed");
    crumb({ method: "GET", url: `${PAGE}/api/overseerish`, status: 500 });
    expect((await sent("again")).failed).toMatchObject({ path: "/api/overseerish" });
  });

  it("is the app's request even when it sits behind the same proxy as the SDK", async () => {
    h = await setup({ dsn: `${PAGE}/_codmir/ingest` }, { page: `${PAGE}/cart`, door: createDoor("/_codmir") });
    crumb({ method: "POST", url: `${PAGE}/_codmir/replay`, status: 500 });
    crumb({ method: "POST", url: `${PAGE}/api/save`, status: 500 });
    crumb({ method: "POST", url: `${PAGE}/_codmir/feedback`, status: 500 });
    expect((await sent()).failed).toMatchObject({ path: "/api/save" });
  });

  it("is not a request that failed without an answer", async () => {
    h = await setup({}, { page: `${PAGE}/cart` });
    crumb({ method: "GET", url: `${PAGE}/api/x`, error: "Failed to fetch" });
    crumb({ method: "GET", url: `${PAGE}/api/y`, status: 0 });
    expect(await sent()).not.toHaveProperty("failed");
  });

  it("is not older than 5 minutes", async () => {
    clock();
    h = await setup({}, { page: `${PAGE}/cart` });
    crumb({ method: "GET", url: `${PAGE}/api/x`, status: 500 });
    advance(5 * MIN);
    expect(await sent("a")).toHaveProperty("failed");
    advance(1);
    expect(await sent("b")).not.toHaveProperty("failed");
  });

  it("is an XHR one too", async () => {
    h = await setup({}, { page: `${PAGE}/cart` });
    crumb({ method: "put", url: `${PAGE}/api/profile`, status: 409, duration: 12 }, "xhr");
    expect((await sent()).failed).toMatchObject({ method: "PUT", path: "/api/profile", status: 409 });
  });

  it("is not a click, a console line or a navigation", async () => {
    h = await setup({}, { page: `${PAGE}/cart` });
    for (const category of ["ui.click", "console", "navigation"]) crumb({ method: "GET", url: `${PAGE}/api/x`, status: 500 }, category);
    expect(await sent()).not.toHaveProperty("failed");
  });

  it("is not a status the door cannot take, and a newest request that does not fit is left out, not swapped", async () => {
    clock();
    h = await setup({}, { page: `${PAGE}/cart` });
    crumb({ method: "GET", url: `${PAGE}/api/good`, status: 500 });
    advance(1);
    crumb({ method: "GET", url: `${PAGE}/api/teapot`, status: 700 });
    crumb({ method: "GET", url: `${PAGE}/api/hmm`, status: 400.5 });
    expect((await sent("a")).failed).toMatchObject({ path: "/api/good" });
    advance(1);
    crumb({ method: "GET", url: `${PAGE}/api/${"p".repeat(600)}`, status: 500 });
    expect(await sent("b")).not.toHaveProperty("failed");
  });

  it("is what instrumented fetch records: a real failing request", async () => {
    h = await setup({}, { page: `${PAGE}/cart` });
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => (String(input).includes("/api/save") ? new Response("no", { status: 500 }) : real(input, init)));
    const restore = h.tracing.instrumentFetch();
    await fetch(`${PAGE}/api/save?token=SECRET#frag`, { method: "post" });
    expect((await sent()).failed).toMatchObject({ method: "POST", path: "/api/save", status: 500 });
    expect(h.door.requests[0].raw).not.toContain("SECRET");
    restore();
  });
});

describe("nothing personal that the person did not type", () => {
  it("no query, fragment, origin, email, user name or third-party address, wherever they are", async () => {
    clock();
    h = await setup(
      {
        environment: "production",
        release: "9.9.9",
        initialUser: { id: "u-42", email: "ann@example.com", username: "ann.private", ip_address: "203.0.113.7", name: "Ann Private" },
        tracePropagationTargets: ["https://api.shop.example"],
      },
      { page: `${PAGE}/orders/17?email=ann%40example.com&token=SECRET#access_token=HASHSECRET` },
    );
    h.overseer.addBreadcrumb({
      category: "fetch",
      message: "POST https://app.example/api/save?email=ann@example.com",
      data: { method: "POST", url: `${PAGE}/api/save?email=ann@example.com&token=SECRET#HASHSECRET`, status: 500, body: "ann@example.com" },
    });
    h.overseer.addBreadcrumb({ category: "fetch", data: { method: "GET", url: "https://tracker.example/p?uid=ann", status: 500 } });
    h.overseer.captureException(new Error("failed for ann@example.com"));
    await h.fb.sendFeedback({ text: "the save button does nothing", pagePath: undefined });
    await h.fb.sendFeedback({ text: "again", pagePath: "https://app.example/orders/17?email=ann@example.com#HASHSECRET", failedRequest: { method: "POST", path: "https://app.example/api/save?token=SECRET", status: 500 } });
    expect(h.door.accepted).toHaveLength(2);
    for (const request of h.door.requests) {
      for (const secret of ["ann@example.com", "ann%40example.com", "ann.private", "Ann Private", "203.0.113.7", "SECRET", "tracker.example", "access_token", "?", "#", "app.example", "u-42x"]) {
        expect(request.raw, secret).not.toContain(secret);
      }
    }
    expect(h.door.accepted[0]).toMatchObject({ pagePath: "/orders/17", failed: { path: "/api/save" }, userId: "u-42" });
    expect(h.door.accepted[1]).toMatchObject({ pagePath: "/orders/17", failed: { path: "/api/save" } });
  });
});

describe("its own request", () => {
  it("makes no breadcrumb, no span and no traceparent, with fetch instrumented and a span active", async () => {
    h = await setup({ tracesSampleRate: 1, tracePropagationTargets: [DSN_ORIGIN] }, { page: `${PAGE}/cart` });
    const restore = h.tracing.instrumentFetch();
    const crumbsBefore = h.context().breadcrumbs.length;
    let traceparentOfApp: string | null = null;
    await h.tracing.startSpan({ op: "function", name: "root" }, async () => {
      // the app's own request is instrumented: a span, a breadcrumb and a traceparent (the control)
      await fetch(`${PAGE}/api/save`, { method: "POST" });
      traceparentOfApp = new Headers(h.calls[0].init.headers).get("traceparent");
      const before = h.calls.length;
      const crumbs = h.context().breadcrumbs.length;
      const result = await h.fb.sendFeedback("hello");
      expect(result.ok).toBe(true);
      expect(h.calls).toHaveLength(before + 1);
      expect(h.calls[before].url).toBe(`${PAGE}/api/overseer/feedback`);
      expect(new Headers(h.calls[before].init.headers).has("traceparent")).toBe(false);
      expect(h.context().breadcrumbs).toHaveLength(crumbs);
      const del = await h.fb.deleteFeedback("fb_1", "rt_1_secret");
      expect(del.ok).toBe(true);
      expect(new Headers(h.calls[before + 1].init.headers).has("traceparent")).toBe(false);
      expect(h.context().breadcrumbs).toHaveLength(crumbs);
      // the two doors of an entry: a GET and a POST under the same path, the first answered 404 and the second 409
      const second = (await h.fb.sendFeedback("second")) as { id: string; reporterToken: string };
      const n = h.calls.length;
      const read = await h.fb.feedbackStatus(second.id, "wrong");
      expect(read).toMatchObject({ ok: false, reason: "not_found" });
      const answered = await h.fb.answerFeedback(second.id, true, second.reporterToken);
      expect(answered).toMatchObject({ ok: false, reason: "not_fixed" });
      const urls = h.calls.slice(n).map((c) => `${c.init.method} ${c.url}`);
      expect(urls).toEqual([`GET ${DSN_ORIGIN}/api/overseer/feedback/${second.id}`, `POST ${DSN_ORIGIN}/api/overseer/feedback/${second.id}/answer`]);
      for (const c of h.calls.slice(n)) expect(new Headers(c.init.headers).has("traceparent")).toBe(false);
      expect(h.context().breadcrumbs).toHaveLength(crumbs);
      // and a 404 and a 409 of these doors are not the app's last failed request
      await h.fb.sendFeedback("after the doors");
      expect(h.door.accepted[h.door.accepted.length - 1]).not.toHaveProperty("failed");
    });
    expect(traceparentOfApp).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(h.context().breadcrumbs.length).toBe(crumbsBefore + 1);
    expect(h.context().breadcrumbs.some((c) => /feedback/.test(`${c.message}${JSON.stringify(c.data)}`))).toBe(false);
    // the transaction that ends here holds one http.client span: the app's request
    await h.overseer.flush();
    const ingested = h.door.others.filter((r) => r.url.endsWith("/ingest")).flatMap((r) => (JSON.parse(r.raw) as { events: Array<{ type: string; spans?: Array<{ op: string; description?: string }> }> }).events);
    const names = ingested.flatMap((e) => (e.type === "transaction" ? (e.spans ?? []).map((sp) => `${sp.op} ${sp.description}`) : []));
    expect(names).toEqual(["http.client POST /api/save"]);
    restore();
  });
});

const DSN_ORIGIN = "https://app.example";
