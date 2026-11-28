/** A wrapped loader or action runs in its request's scope: its breadcrumbs, tags and errors never reach another request. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Codmir from "../index";
import { requestScopeFrom, withRequestScope } from "../../overseer/request-scope";
import { installNodeTracingContext } from "../../tracing/server";

const DSN = "https://ingest.example.test/api/v1/overseer";

type Crumb = { category?: string; message: string };
type Sent = { message?: string; tags?: Record<string, string>; breadcrumbs?: Crumb[]; request?: { url: string; method: string } };
let sent: Sent[];

beforeEach(() => {
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      for (const wire of JSON.parse(String(init?.body ?? "{}")).events ?? []) {
        if (wire.type === "error") sent.push(wire.event);
      }
      return new Response('{"received":true}', { status: 200 });
    }),
  );
  installNodeTracingContext();
  Codmir.init({ dsn: DSN, clientKey: "osk_test" });
});
afterEach(() => {
  Codmir.close();
  vi.unstubAllGlobals();
});

const args = (path: string, method = "GET") => ({ request: new Request(`https://shop.example${path}`, { method }), params: {} }) as any;
const events = async () => {
  await Codmir.flush();
  return sent;
};
const byMessage = (list: Sent[], message: string) => list.find((e) => e.message === message)!;
const messages = (e: Sent) => (e.breadcrumbs ?? []).map((b) => b.message);

/** Lets two calls reach the same point before either goes on. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

describe("overlapping loaders and actions", () => {
  it("two loaders in flight each capture their own request, breadcrumbs and tag", async () => {
    const bothIn = gate();
    let inside = 0;
    const loader = Codmir.wrapLoader(async ({ request }: any) => {
      const who = new URL(request.url).pathname.slice(1);
      Codmir.addBreadcrumb({ category: "app", message: `step ${who}` });
      Codmir.setTag("page", who);
      if (++inside === 2) bothIn.open();
      await bothIn.opened;
      throw new Error(`boom ${who}`);
    });
    const results = await Promise.allSettled([loader(args("/cart")), loader(args("/orders", "POST"))]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);

    const list = await events();
    expect(list).toHaveLength(2);
    const cart = byMessage(list, "boom cart");
    const orders = byMessage(list, "boom orders");
    expect(cart.request).toMatchObject({ url: "https://shop.example/cart", method: "GET" });
    expect(orders.request).toMatchObject({ url: "https://shop.example/orders", method: "POST" });
    expect(cart.tags).toMatchObject({ page: "cart" });
    expect(orders.tags).toMatchObject({ page: "orders" });
    expect(messages(cart)).toEqual(["Loader: GET /cart", "step cart"]);
    expect(messages(orders)).toEqual(["Loader: POST /orders", "step orders"]);
  });

  it("two actions in flight each capture their own request, breadcrumbs and tag", async () => {
    const bothIn = gate();
    let inside = 0;
    const action = Codmir.wrapAction(async ({ request }: any) => {
      const who = new URL(request.url).pathname.slice(1);
      Codmir.addBreadcrumb({ category: "app", message: `step ${who}` });
      Codmir.setTag("page", who);
      if (++inside === 2) bothIn.open();
      await bothIn.opened;
      throw new Error(`boom ${who}`);
    });
    await Promise.allSettled([action(args("/pay", "POST")), action(args("/refund", "PUT"))]);

    const list = await events();
    expect(list).toHaveLength(2);
    const pay = byMessage(list, "boom pay");
    const refund = byMessage(list, "boom refund");
    expect(pay.request).toMatchObject({ url: "https://shop.example/pay", method: "POST" });
    expect(refund.request).toMatchObject({ url: "https://shop.example/refund", method: "PUT" });
    expect(pay.tags).toMatchObject({ page: "pay" });
    expect(refund.tags).toMatchObject({ page: "refund" });
    expect(messages(pay)).toEqual(["Action: POST /pay", "step pay"]);
    expect(messages(refund)).toEqual(["Action: PUT /refund", "step refund"]);
  });
});

describe("a scope that is already open", () => {
  it("is kept: the loader's breadcrumb and error join it, and its tag is on the event", async () => {
    const scope = requestScopeFrom({ url: "https://shop.example/outer?q=1", method: "get" });
    const loader = Codmir.wrapLoader(async () => {
      await Promise.resolve();
      throw new Error("inner boom");
    });
    await withRequestScope(scope, async () => {
      Codmir.setTag("tenant", "acme");
      await expect(loader(args("/inner"))).rejects.toThrow("inner boom");
    });

    const [event] = await events();
    expect(event.request).toMatchObject({ url: "https://shop.example/outer", method: "GET" });
    expect(event.tags).toMatchObject({ tenant: "acme" });
    expect(messages(event)).toContain("Loader: GET /inner");
    expect(scope.breadcrumbs?.map((b) => b.message)).toContain("Loader: GET /inner");
  });
});

describe("what the wrappers still do", () => {
  it("a 500 Response thrown from a loader is captured with its request and rethrown", async () => {
    const failed = new Response("x", { status: 500, statusText: "Server Error" });
    const loader = Codmir.wrapLoader(async () => {
      await Promise.resolve();
      throw failed;
    });
    await expect(loader(args("/report"))).rejects.toBe(failed);

    const list = await events();
    expect(list).toHaveLength(1);
    expect(list[0].request).toMatchObject({ url: "https://shop.example/report", method: "GET" });
    expect(messages(list[0])).toEqual(["Loader: GET /report"]);
  });

  it("a loader that returns gives its value, and one request's breadcrumbs never reach a later request's event", async () => {
    const ok = Codmir.wrapLoader(async () => {
      Codmir.addBreadcrumb({ category: "app", message: "first request only" });
      Codmir.setTag("first", "yes");
      await Promise.resolve();
      return { id: 7 };
    });
    const bad = Codmir.wrapLoader(async () => {
      throw new Error("later boom");
    });
    await expect(ok(args("/first"))).resolves.toEqual({ id: 7 });
    await expect(bad(args("/second"))).rejects.toThrow("later boom");

    const [event] = await events();
    expect(event.request).toMatchObject({ url: "https://shop.example/second" });
    expect(messages(event)).toEqual(["Loader: GET /second"]);
    expect(event.tags?.first).toBeUndefined();
  });
});
