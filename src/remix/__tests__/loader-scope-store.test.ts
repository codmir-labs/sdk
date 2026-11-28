/** The wrappers install the request store themselves on a server, so an app with only `wrapLoader` and `wrapAction` has per-request scopes. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Codmir from "../index";
import { installRequestScopeStore, requestScopeSurvivesAwait } from "../../overseer/request-scope";

const DSN = "https://ingest.example.test/api/v1/overseer";
const STORE_SLOT = Symbol.for("codmir.request-scope.store");
const slots = globalThis as Record<symbol, unknown>;

type Crumb = { message: string };
type Sent = { message?: string; tags?: Record<string, string>; breadcrumbs?: Crumb[]; request?: { url: string; method: string } };
let sent: Sent[];

beforeEach(() => {
  delete slots[STORE_SLOT];
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
  Codmir.init({ dsn: DSN, clientKey: "osk_test" });
});
afterEach(() => {
  Codmir.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete slots[STORE_SLOT];
});

const args = (path: string, method = "GET") => ({ request: new Request(`https://shop.example${path}`, { method }), params: {} }) as any;
const byMessage = (list: Sent[], message: string) => list.find((e) => e.message === message)!;
const messages = (e: Sent) => (e.breadcrumbs ?? []).map((b) => b.message);

describe("no store installed by the app", () => {
  it("two overlapping loaders keep their own breadcrumbs, tags and request", async () => {
    expect(requestScopeSurvivesAwait()).toBe(false);
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    let inside = 0;
    const loader = Codmir.wrapLoader(async ({ request }: any) => {
      const who = new URL(request.url).pathname.slice(1);
      Codmir.addBreadcrumb({ category: "app", message: `step ${who}` });
      Codmir.setTag("page", who);
      if (++inside === 2) open();
      await opened;
      throw new Error(`boom ${who}`);
    });
    await Promise.allSettled([loader(args("/cart")), loader(args("/orders", "POST"))]);
    await Codmir.flush();

    expect(requestScopeSurvivesAwait()).toBe(true);
    expect(sent).toHaveLength(2);
    const cart = byMessage(sent, "boom cart");
    const orders = byMessage(sent, "boom orders");
    expect(cart.request).toMatchObject({ url: "https://shop.example/cart", method: "GET" });
    expect(orders.request).toMatchObject({ url: "https://shop.example/orders", method: "POST" });
    expect(cart.tags).toMatchObject({ page: "cart" });
    expect(orders.tags).toMatchObject({ page: "orders" });
    expect(messages(cart)).toEqual(["Loader: GET /cart", "step cart"]);
    expect(messages(orders)).toEqual(["Loader: POST /orders", "step orders"]);
  });

  it("two overlapping actions keep their own breadcrumbs and request", async () => {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    let inside = 0;
    const action = Codmir.wrapAction(async ({ request }: any) => {
      const who = new URL(request.url).pathname.slice(1);
      Codmir.addBreadcrumb({ category: "app", message: `step ${who}` });
      if (++inside === 2) open();
      await opened;
      throw new Error(`boom ${who}`);
    });
    await Promise.allSettled([action(args("/pay", "POST")), action(args("/refund", "PUT"))]);
    await Codmir.flush();

    expect(sent).toHaveLength(2);
    expect(messages(byMessage(sent, "boom pay"))).toEqual(["Action: POST /pay", "step pay"]);
    expect(messages(byMessage(sent, "boom refund"))).toEqual(["Action: PUT /refund", "step refund"]);
    expect(byMessage(sent, "boom refund").request).toMatchObject({ url: "https://shop.example/refund", method: "PUT" });
  });
});

describe("a process without process.getBuiltinModule", () => {
  it("runs the wrappers as before: no throw, the value unchanged, no store installed", async () => {
    vi.stubGlobal("process", new Proxy(process, { get: (target, key) => (key === "getBuiltinModule" ? undefined : Reflect.get(target, key)) }));
    expect(installRequestScopeStore()).toBe(false);

    const ok = Codmir.wrapLoader(async () => {
      await Promise.resolve();
      return { id: 7 };
    });
    await expect(ok(args("/first"))).resolves.toEqual({ id: 7 });
    const bad = Codmir.wrapAction(async () => {
      throw new Error("still captured");
    });
    await expect(bad(args("/second", "POST"))).rejects.toThrow("still captured");
    await Codmir.flush();

    expect(slots[STORE_SLOT]).toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0].message).toBe("still captured");
  });

  it("runs the wrappers as before when getBuiltinModule throws", async () => {
    vi.stubGlobal(
      "process",
      new Proxy(process, {
        get: (target, key) =>
          key === "getBuiltinModule"
            ? () => {
                throw new Error("not on this runtime");
              }
            : Reflect.get(target, key),
      }),
    );
    expect(installRequestScopeStore()).toBe(false);
    const loader = Codmir.wrapLoader(async () => "value");
    await expect(loader(args("/x"))).resolves.toBe("value");
  });
});

describe("a store that is already installed", () => {
  it("is kept by the helper and by the wrappers", async () => {
    const mine = { getStore: () => undefined, run: <T>(_scope: unknown, fn: () => T) => fn() };
    slots[STORE_SLOT] = mine;
    expect(installRequestScopeStore()).toBe(true);
    expect(slots[STORE_SLOT]).toBe(mine);

    const loader = Codmir.wrapLoader(async () => "value");
    await expect(loader(args("/x"))).resolves.toBe("value");
    expect(slots[STORE_SLOT]).toBe(mine);
  });
});
