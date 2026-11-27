/** A thrown Response in a wrapped loader or action or in handleError: a redirect or 4xx is passed on, a 5xx is sent once. */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Codmir from "../index";

const DSN = "https://ingest.example.test/api/v1/overseer";

function stubFetch() {
  const posts: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      posts.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response('{"received":true}', { status: 200 });
    }),
  );
  return () => posts.flatMap((p) => (p.events ?? []).filter((w: any) => w.type === "error").map((w: any) => w.event));
}

function setup(config: Record<string, unknown> = {}) {
  const errors = stubFetch();
  Codmir.init({ dsn: DSN, clientKey: "osk_test", ...config });
  return async () => {
    await Codmir.flush();
    return errors();
  };
}

const args = (path: string, method = "GET") => ({ request: new Request(`https://shop.example${path}`, { method }), params: {} }) as any;
const redirect = (to: string) => new Response(null, { status: 302, headers: { Location: to } });
const unavailable = () => new Response("x", { status: 503, statusText: "Service Unavailable" });

afterEach(() => {
  Codmir.close();
  vi.unstubAllGlobals();
});

describe("a thrown Response in wrapLoader and wrapAction", () => {
  it("a redirect and a 404 give no event and the same object is rethrown", async () => {
    const events = setup();
    const guard = redirect("/login");
    const missing = new Response(null, { status: 404 });
    const done = redirect("/checkout/done");
    const loader = Codmir.wrapLoader(async () => {
      throw guard;
    });
    const product = Codmir.wrapLoader(async () => {
      throw missing;
    });
    const action = Codmir.wrapAction(async () => {
      throw done;
    });
    await expect(loader(args("/account"))).rejects.toBe(guard);
    await expect(product(args("/p/none"))).rejects.toBe(missing);
    await expect(action(args("/checkout", "POST"))).rejects.toBe(done);
    expect(await events()).toHaveLength(0);
  });

  it("a response-shaped object is rethrown unchanged and, below 500, not captured", async () => {
    const events = setup();
    const shaped = { status: 401, statusText: "Unauthorized" };
    const loader = Codmir.wrapLoader(async () => {
      throw shaped;
    });
    await expect(loader(args("/a"))).rejects.toBe(shaped);
    expect(await events()).toHaveLength(0);
  });

  it("a 503 from a loader is one event with the status, and none with captureResponseErrors off", async () => {
    const on = setup();
    const thrown = unavailable();
    const loader = Codmir.wrapLoader(async () => {
      throw thrown;
    });
    await expect(loader(args("/a"))).rejects.toBe(thrown);
    const list = await on();
    expect(list).toHaveLength(1);
    expect(list[0].message).toBe("Response Error: 503 Service Unavailable");
    expect(list[0].extra.responseStatus).toBe(503);
    expect(list[0].extra.responseStatusText).toBe("Service Unavailable");
    expect(list[0].exception.mechanism?.type).toBe("remix-loader");

    Codmir.close();
    vi.unstubAllGlobals();
    const off = setup({ captureResponseErrors: false });
    const again = unavailable();
    await expect(Codmir.wrapLoader(async () => { throw again; })(args("/a"))).rejects.toBe(again);
    await expect(Codmir.wrapAction(async () => { throw again; })(args("/a", "POST"))).rejects.toBe(again);
    expect(await off()).toHaveLength(0);
  });

  it("a 503 from an action is one event", async () => {
    const events = setup();
    const thrown = unavailable();
    const action = Codmir.wrapAction(async () => {
      throw thrown;
    });
    await expect(action(args("/a", "POST"))).rejects.toBe(thrown);
    const list = await events();
    expect(list.map((e) => e.message)).toEqual(["Response Error: 503 Service Unavailable"]);
    expect(list[0].exception.mechanism?.type).toBe("remix-action");
  });

  it("the same 503 seen by a wrapper and then by handleError is one event", async () => {
    const events = setup();
    const thrown = unavailable();
    const loader = Codmir.wrapLoader(async () => {
      throw thrown;
    });
    const caught = await loader(args("/a")).catch((e: unknown) => e);
    Codmir.handleError(caught, { request: new Request("https://shop.example/a") });
    expect(await events()).toHaveLength(1);
  });

  it("an Error thrown in a loader or an action is still captured once each", async () => {
    const events = setup();
    const boom = new Error("boom");
    await expect(Codmir.wrapLoader(async () => { throw boom; })(args("/a"))).rejects.toBe(boom);
    await expect(Codmir.wrapAction(async () => { throw boom; })(args("/a", "POST"))).rejects.toBe(boom);
    const list = await events();
    expect(list.map((e) => [e.message, e.exception.mechanism?.type])).toEqual([
      ["boom", "remix-loader"],
      ["boom", "remix-action"],
    ]);
  });
});

describe("handleError with a Response", () => {
  it("a 3xx or 4xx is not an error and a 5xx is sent once", async () => {
    const events = setup();
    const request = new Request("https://shop.example/a");
    Codmir.handleError(redirect("/login"), { request });
    Codmir.handleError(new Response(null, { status: 404 }), { request });
    const five = new Response("x", { status: 500, statusText: "Internal Server Error" });
    Codmir.handleError(five, { request });
    Codmir.handleError(five, { request });
    const list = await events();
    expect(list.map((e) => e.message)).toEqual(["Response Error: 500 Internal Server Error"]);
    expect(list[0].exception.mechanism?.type).toBe("remix-handleError");
  });

  it("a 5xx is not sent with captureResponseErrors off", async () => {
    const events = setup({ captureResponseErrors: false });
    Codmir.handleError(unavailable(), { request: new Request("https://shop.example/a") });
    expect(await events()).toHaveLength(0);
  });
});
