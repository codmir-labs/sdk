/** The Hono middleware opens an http.server transaction named by the matched route. */
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { codmirTracing } from "../../hono/index";
import { flush } from "../../overseer/index";
import { sentTransactions } from "./helpers";
import { runBehaviour, serverTracingSuite, startTracing, useTracingHarness, type Behaviour } from "./server-suite";

function appFor(behaviour: Behaviour): Hono {
  const app = new Hono();
  app.use(codmirTracing());
  app.get("/users/:id", (c) =>
    runBehaviour(behaviour, () => c.json({ id: c.req.param("id") }), () => c.text("nope", 500)),
  );
  return app;
}

serverTracingSuite("hono", {
  path: "/users/42?x=1",
  call: async ({ path, headers, behaviour }) => {
    const res = await appFor(behaviour).request(path, { headers });
    return { status: res.status }; // Hono's onError answers a throw with 500
  },
  nameFor: () => "GET /users/:id",
});

describe("hono specifics", () => {
  const harness = useTracingHarness();

  it("names an unmatched request after its path, and a custom onError 500 is still an error", async () => {
    startTracing(1);
    const app = new Hono();
    app.use(codmirTracing());
    app.onError((_e, c) => c.text("custom", 503));
    app.get("/boom", () => {
      throw new Error("boom");
    });
    expect((await app.request("/boom")).status).toBe(503);
    expect((await app.request("/missing/7?q=1")).status).toBe(404);
    await flush();
    const txs = sentTransactions(harness.calls());
    expect(txs.map((t) => [t.name, t.status])).toEqual([
      ["GET /boom", "error"],
      ["GET /missing/7", "ok"], // a 404 is the client's mistake, not a server error
    ]);
  });
});

describe("hono on a runtime with an execution context", () => {
  const harness = useTracingHarness();

  function appWith(waitUntil: (p: Promise<unknown>) => void, fail: boolean) {
    const app = new Hono();
    app.use(codmirTracing());
    app.onError((_e, c) => c.text("oops", 500));
    app.get("/x", (c) => {
      if (fail) throw new Error("boom");
      return c.text("ok");
    });
    return { app, env: {}, ctx: { waitUntil, passThroughOnException() {} } };
  }

  it("hands one flush to waitUntil when the handler threw, none otherwise", async () => {
    startTracing(1);
    const waitUntil = vi.fn();
    const failing = appWith(waitUntil, true);
    expect((await failing.app.request("/x", {}, failing.env, failing.ctx as never)).status).toBe(500);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(waitUntil.mock.calls[0][0]).toBeInstanceOf(Promise);
    await waitUntil.mock.calls[0][0];
    expect(sentTransactions(harness.calls())).toHaveLength(1);

    const fine = appWith(waitUntil, false);
    expect((await fine.app.request("/x", {}, fine.env, fine.ctx as never)).status).toBe(200);
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it("still answers when reading executionCtx throws", async () => {
    startTracing(1);
    const app = new Hono();
    app.use(codmirTracing());
    app.onError((_e, c) => c.text("oops", 500));
    app.get("/x", () => {
      throw new Error("boom");
    });
    expect((await app.request("/x")).status).toBe(500); // no execution context given: the getter throws
  });
});
