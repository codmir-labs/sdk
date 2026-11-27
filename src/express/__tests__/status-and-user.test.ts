/**
 * Mounted in the order an app uses (`requestHandler`, an auth middleware, the route, `errorHandler`): an error with a
 * 4xx status is passed on and not sent, and an event captured in a route has the user the auth middleware set.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Codmir from "../index";

type Sent = { message: string; user?: { id?: string } };
let sent: Sent[];

beforeEach(() => {
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      for (const wire of (JSON.parse(String(init?.body)) as { events: Array<{ type: string; event?: Sent }> }).events) {
        if (wire.type === "error" && wire.event) sent.push(wire.event);
      }
      return new Response("{}", { status: 200 });
    }),
  );
});
afterEach(() => {
  Codmir.close();
  vi.unstubAllGlobals();
});

const start = (extractUser?: (req: any) => any): void =>
  Codmir.init({
    dsn: "https://ingest.example.test/api/overseer",
    clientKey: "osk_test",
    extractUser: extractUser ?? ((req) => (req.user ? { id: String(req.user.id) } : null)),
  });

const request = (): any => ({
  method: "GET", url: "/orders/1", originalUrl: "/orders/1", path: "/orders/1", baseUrl: "", params: {}, query: {}, headers: {},
});
const response = (): any => ({ statusCode: 200, on() { return this; } });

type Layer = (req: any, res: any, next: (err?: unknown) => void) => void;

/** Runs the layers like Express: a thrown error goes to the first error handler after it, `next(err)` too. */
function run(layers: Layer[], errorLayers: Array<(err: unknown, req: any, res: any, next: (err?: unknown) => void) => void>) {
  const req = request();
  const res = response();
  const passed: unknown[] = [];
  const final = (err?: unknown): void => void (err !== undefined && passed.push(err));
  const toErrors = (err: unknown, i = 0): void => {
    if (i >= errorLayers.length) return final(err);
    errorLayers[i](err, req, res, (e) => (e === undefined ? final() : toErrors(e, i + 1)));
  };
  const step = (i: number): void => {
    if (i >= layers.length) return final();
    try {
      layers[i](req, res, (e) => (e === undefined ? step(i + 1) : toErrors(e)));
    } catch (e) {
      toErrors(e);
    }
  };
  step(0);
  return { req, passed };
}

const auth = (user: unknown): Layer => (req, _res, next) => {
  req.user = user;
  next();
};

describe("errorHandler and the HTTP status of an error", () => {
  const withStatus = (fields: object): Error => Object.assign(new Error("failed"), fields);
  const sendsFor = async (err: Error, options?: Codmir.ErrorHandlerOptions) => {
    start();
    const { passed } = run(
      [Codmir.requestHandler(), auth({ id: "alice" }), () => { throw err; }],
      [Codmir.errorHandler(options)],
    );
    await Codmir.flush();
    return passed;
  };

  it.each([
    ["status 400", { status: 400 }],
    ["statusCode 404", { statusCode: 404 }],
    ["output.statusCode 401", { output: { statusCode: 401 } }],
  ])("%s is passed on and not sent", async (_name, fields) => {
    const err = withStatus(fields);
    expect(await sendsFor(err)).toEqual([err]);
    expect(sent).toHaveLength(0);
  });

  it("a plain Error is sent, and passed on", async () => {
    const err = new Error("plain");
    expect(await sendsFor(err)).toEqual([err]);
    expect(sent).toHaveLength(1);
  });

  it("status 503 is sent", async () => {
    const err = withStatus({ status: 503 });
    expect(await sendsFor(err)).toEqual([err]);
    expect(sent).toHaveLength(1);
  });

  it("a status that is not an integer from 100 to 599 does not stop the send", async () => {
    await sendsFor(withStatus({ status: "404", statusCode: 42.5, output: { statusCode: 9000 } }));
    expect(sent).toHaveLength(1);
  });

  it("a custom shouldHandleError can send a 404", async () => {
    const err = withStatus({ status: 404 });
    const seen = vi.fn((e: unknown) => (e as { status?: number }).status === 404);
    expect(await sendsFor(err, { shouldHandleError: seen })).toEqual([err]);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
  });

  it("a shouldHandleError that throws sends nothing and the error goes on", async () => {
    const err = new Error("plain");
    expect(await sendsFor(err, { shouldHandleError: () => { throw new Error("bad"); } })).toEqual([err]);
    expect(sent).toHaveLength(0);
  });
});

describe("an event captured in a route and the request's user", () => {
  const route = (fn: () => void): Layer => (_req, _res, next) => {
    fn();
    next();
  };
  const mount = (user: unknown, inRoute: () => void): void => {
    run([Codmir.requestHandler(), auth(user), route(inRoute)], [Codmir.errorHandler()]);
  };

  it("has the user the auth middleware set", async () => {
    start();
    mount({ id: "alice" }, () => void Codmir.captureException(new Error("in-route")));
    await Codmir.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0].user?.id).toBe("alice");
  });

  it("has no user before auth ran", async () => {
    start();
    run(
      [Codmir.requestHandler(), route(() => void Codmir.captureException(new Error("early"))), auth({ id: "alice" })],
      [Codmir.errorHandler()],
    );
    await Codmir.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0].user).toBeUndefined();
  });

  it("has the user setUser gave it, over extractUser's", async () => {
    start();
    mount({ id: "alice" }, () => {
      Codmir.setUser({ id: "bob" });
      Codmir.captureException(new Error("after-setUser"));
    });
    await Codmir.flush();
    expect(sent.map((e) => e.user?.id)).toEqual(["bob"]);
  });

  it("keeps setUser's user when the first capture comes after it and req.user changed before", async () => {
    start();
    mount({ id: "alice" }, () => {
      Codmir.setUser({ id: "bob" });
      Codmir.captureException(new Error("one"));
      Codmir.captureException(new Error("two"));
    });
    await Codmir.flush();
    expect(sent.map((e) => e.user?.id)).toEqual(["bob", "bob"]);
  });

  it("runs extractUser once per change of req.user, not once per event", async () => {
    const calls: unknown[] = [];
    start((req) => (calls.push(req.user), req.user ? { id: String(req.user.id) } : null));
    mount({ id: "alice" }, () => {
      for (let i = 0; i < 5; i++) Codmir.captureException(new Error(`e${i}`));
    });
    await Codmir.flush();
    expect(calls).toHaveLength(2); // when requestHandler ran, and once after auth
    expect(sent.map((e) => e.user?.id)).toEqual(Array(5).fill("alice"));
  });

  it("an extractUser that throws sends no user and the request completes", async () => {
    start(() => { throw new Error("bad"); });
    const done = vi.fn();
    const { passed } = run(
      [Codmir.requestHandler(), auth({ id: "alice" }), route(() => void Codmir.captureException(new Error("in-route"))), (_q, _s, next) => (done(), next())],
      [Codmir.errorHandler()],
    );
    await Codmir.flush();
    expect(done).toHaveBeenCalledTimes(1);
    expect(passed).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0].user).toBeUndefined();
  });
});
