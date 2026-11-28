/**
 * What a Remix server error carries: the request's method and URL (never its query string), whether it is captured inside
 * `withCodmirRequestHandler` or handed to `captureRemixServerError`; and the form keys of an action that read its body
 * before it threw, read without a clone.
 */
import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Codmir from "../index";
import { withCodmirRequestHandler } from "../server";

const DSN = "https://ingest.example.test/api/v1/overseer";

function setup() {
  const posts: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      posts.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response('{"received":true}', { status: 200 });
    }),
  );
  Codmir.init({ dsn: DSN, clientKey: "osk_test" });
  return async () => {
    await Codmir.flush();
    return posts.flatMap((p) => (p.events ?? []).filter((w: any) => w.type === "error").map((w: any) => w.event));
  };
}

afterEach(() => {
  Codmir.close();
  vi.unstubAllGlobals();
});

const form = (fields: Record<string, string>) => {
  const body = new URLSearchParams(fields);
  return new Request("https://shop.example/checkout?token=secret&step=2", { method: "POST", body });
};

describe("the request on a Remix server error", () => {
  it("an error captured inside withCodmirRequestHandler carries the request's method and URL, without the query", async () => {
    const events = setup();
    const handle = withCodmirRequestHandler(async (request: Request) => {
      Codmir.captureException(new Error("render failed"));
      return new Response(request.url);
    });
    await handle(new Request("https://shop.example/orders/7?token=secret#frag", { method: "POST" }));
    const [event] = await events();
    expect(event.request).toMatchObject({ method: "POST", url: "https://shop.example/orders/7" });
    expect(event.request.url).not.toMatch(/secret|token|frag/);
  });

  it("captureRemixServerError(error, request) carries the request's method and URL, without the query", async () => {
    const events = setup();
    const request = new Request("https://shop.example/cart?session=secret", { method: "get" });
    Codmir.captureRemixServerError(new Error("stream failed"), request);
    const [event] = await events();
    expect(event.request).toMatchObject({ method: "GET", url: "https://shop.example/cart" });
    expect(event.request.url).not.toMatch(/secret|session/);
  });

  it("captureRemixServerError with a value that is not an Error carries it too", async () => {
    const events = setup();
    Codmir.captureRemixServerError("boom", new Request("https://shop.example/x?q=1"));
    const [event] = await events();
    expect(event.request).toMatchObject({ method: "GET", url: "https://shop.example/x" });
  });
});

describe("formDataKeys of a failed action", () => {
  it("an action that read request.formData() and then threw sends the field names, never the values, and clones nothing", async () => {
    const events = setup();
    const request = form({ email: "a@b.example", card: "4242" });
    const clone = vi.spyOn(request, "clone");
    const action = Codmir.wrapAction(async ({ request }: ActionFunctionArgs) => {
      await request.formData();
      throw new Error("payment failed");
    });
    await expect(action({ request, params: {}, context: {} })).rejects.toThrow("payment failed");
    const [event] = await events();
    expect(event.extra.formDataKeys).toEqual(["email", "card"]);
    expect(Object.values(event.extra)).not.toContain("4242");
    expect(clone).not.toHaveBeenCalled();
    // The method is the request's own again, and the body stays as the action left it.
    expect(Object.prototype.hasOwnProperty.call(request, "formData")).toBe(false);
  });

  it("an action that never read its body still sends the keys", async () => {
    const events = setup();
    const request = form({ email: "a@b.example", note: "hi" });
    const clone = vi.spyOn(request, "clone");
    const action = Codmir.wrapAction(async () => {
      throw new Error("rejected early");
    });
    await expect(action({ request, params: {}, context: {} })).rejects.toThrow("rejected early");
    const [event] = await events();
    expect(event.extra.formDataKeys).toEqual(["email", "note"]);
    expect(clone).not.toHaveBeenCalled();
  });

  it("a request whose formData cannot be wrapped gives what it gave before: no keys after a read, no failure", async () => {
    const events = setup();
    const request = Object.freeze(form({ email: "a@b.example" }));
    const action = Codmir.wrapAction(async ({ request }: ActionFunctionArgs) => {
      await request.formData();
      throw new Error("frozen");
    });
    await expect(action({ request, params: {}, context: {} })).rejects.toThrow("frozen");
    const [event] = await events();
    expect(event.message).toBe("frozen");
    expect(event.extra).not.toHaveProperty("formDataKeys");
  });
});

describe("an open request scope is kept", () => {
  const scoped = async (capture: (err: Error, request: Request) => void) => {
    const events = setup();
    const handle = withCodmirRequestHandler(async (request: Request) => {
      Codmir.setUser({ id: "u-7" });
      Codmir.setTag("plan", "pro");
      Codmir.addBreadcrumb({ category: "cart", message: "opened cart" });
      capture(new Error("stream failed"), request);
      return new Response("ok");
    });
    await handle(new Request("https://shop.example/cart?session=secret", { method: "POST" }));
    return (await events())[0];
  };
  const kept = (event: any) => {
    expect(event.user).toMatchObject({ id: "u-7" });
    expect(event.tags).toMatchObject({ plan: "pro" });
    expect(JSON.stringify(event.breadcrumbs)).toContain("opened cart");
    expect(event.request).toMatchObject({ method: "POST", url: "https://shop.example/cart" });
    expect(event.request.url).not.toMatch(/secret|session/);
  };

  it("captureRemixServerError inside withCodmirRequestHandler keeps the request's user, tag and breadcrumb", async () => {
    kept(await scoped((err, request) => void Codmir.captureRemixServerError(err, request)));
  });

  it("handleError({ request }) inside withCodmirRequestHandler keeps them too", async () => {
    kept(await scoped((err, request) => Codmir.handleError(err, { request })));
  });

  it("handleError({ request }) with no scope open carries the request's method and URL, without the query", async () => {
    const events = setup();
    Codmir.handleError(new Error("loader failed"), { request: new Request("https://shop.example/cart?session=secret", { method: "put" }) });
    const [event] = await events();
    expect(event.request).toMatchObject({ method: "PUT", url: "https://shop.example/cart" });
    expect(event.request.url).not.toMatch(/secret|session/);
  });
});

describe("the form watch is put back after a normal return", () => {
  it("an action that read request.formData() and returned leaves no own formData property", async () => {
    setup();
    const request = form({ email: "a@b.example" });
    const action = Codmir.wrapAction(async ({ request }: ActionFunctionArgs) => {
      await request.formData();
      return new Response("saved");
    });
    await action({ request, params: {}, context: {} });
    expect(Object.prototype.hasOwnProperty.call(request, "formData")).toBe(false);
  });
});
