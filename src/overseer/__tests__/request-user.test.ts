/**
 * Each request carries its own user: overlapping requests of two people and one of nobody capture at the start, after an
 * await, in a timer, in a rejected promise and (Express) through `errorHandler`, and every event has its own request's
 * user. `setUser` inside a request leaves the process-wide user and the other requests alone.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Codmir from "../../express/index";
import { codmirTracing } from "../../hono/index";
import { withCodmirTracing as withNext } from "../../nextjs/server";
import { withCodmirTracing as withRemix } from "../../remix/server";
import * as overseer from "../index";
import { getRequestScope } from "../request-scope";

type Sent = { message: string; user?: { id?: string }; request?: { url?: string } };
let sent: Sent[];

beforeEach(() => {
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      for (const wire of (JSON.parse(String(init?.body)) as { events: Array<{ type: string; event?: Sent }> }).events) {
        if (wire.type === "error" && wire.event) sent.push(wire.event);
        else if (wire.type === "message") sent.push(wire as unknown as Sent);
      }
      return new Response("{}", { status: 200 });
    }),
  );
  Codmir.init({
    dsn: "https://ingest.example.test/api/overseer",
    clientKey: "osk_test",
    extractUser: (req) => (req.user ? { id: String(req.user.id) } : null),
  });
});
afterEach(() => {
  Codmir.close();
  vi.unstubAllGlobals();
});

class Barrier {
  private arrived = 0;
  private release!: () => void;
  private readonly open = new Promise<void>((resolve) => (this.release = resolve));
  constructor(private readonly n: number) {}
  wait(): Promise<void> {
    if (++this.arrived === this.n) this.release();
    return this.open;
  }
}

const capture = (message: string): void => void overseer.captureException(new Error(message));
const userOf = (message: string): string | undefined => {
  const events = sent.filter((e) => e.message === message);
  expect(events, message).toHaveLength(1);
  return events[0].user?.id;
};

/** What the people in the three requests do: `a` and `b` are somebody, `c` is nobody. `b` calls `setUser` mid-way. */
async function flow(rid: "a" | "b" | "c", barrier: { one: Barrier; two: Barrier }, extra: () => void = () => {}): Promise<void> {
  capture(`${rid}:start`);
  await barrier.one.wait();
  capture(`${rid}:await`);
  if (rid === "b") {
    overseer.setUser({ id: "b2" });
    capture("b:after-setUser");
  }
  await barrier.two.wait();
  await new Promise<void>((resolve) =>
    setTimeout(() => {
      capture(`${rid}:timeout`);
      resolve();
    }, 5),
  );
  await Promise.reject(new Error("no")).catch(() => capture(`${rid}:rejected`));
  extra();
  capture(`${rid}:end`);
  overseer.captureMessage(`${rid}:message`);
}

const barriers = () => ({ one: new Barrier(3), two: new Barrier(3) });

/** The same expectations for every framework: who each event belongs to. */
function expectOwners(ownerOfB: { before: string | undefined; after: string | undefined }, c: string | undefined): void {
  for (const when of ["start", "await", "timeout", "rejected", "end", "message"]) {
    expect(userOf(`a:${when}`), `a:${when}`).toBe("a");
    expect(userOf(`c:${when}`), `c:${when}`).toBe(c);
  }
  expect(userOf("b:start")).toBe(ownerOfB.before);
  expect(userOf("b:await")).toBe(ownerOfB.before);
  for (const m of ["b:after-setUser", "b:timeout", "b:rejected", "b:end", "b:message"]) expect(userOf(m), m).toBe(ownerOfB.after);
}

describe("express", () => {
  const request = (rid: string, user?: string): any => ({
    method: "GET", url: `/r/${rid}`, originalUrl: `/r/${rid}?token=secret`, path: `/r/${rid}`, baseUrl: "", params: {}, query: {}, headers: {},
    ...(user ? { user: { id: user } } : {}),
  });
  const response = (): any => ({ statusCode: 200, on() { return this; } });

  const serve = (rid: "a" | "b" | "c", b: ReturnType<typeof barriers>): Promise<void> => {
    const req = request(rid, rid === "c" ? undefined : rid);
    return new Promise<void>((resolve, reject) => {
      Codmir.requestHandler()(req, response(), () => {
        flow(rid, b, () => Codmir.errorHandler()(new Error(`${rid}:handler`), req, response(), () => {}))
          .then(resolve, reject);
      });
    });
  };

  it("overlapping requests keep their own users, errorHandler included", async () => {
    const b = barriers();
    await Promise.all([serve("a", b), serve("b", b), serve("c", b)]);
    await overseer.flush();
    // `b` starts as `b` (extractUser), then calls setUser({ id: "b2" })
    expectOwners({ before: "b", after: "b2" }, undefined);
    expect(userOf("a:handler")).toBe("a");
    expect(userOf("b:handler")).toBe("b2");
    expect(userOf("c:handler")).toBeUndefined();
  });

  it("the process-wide user is not touched by setUser in a request, and nobody is not the process-wide user", async () => {
    overseer.setUser({ id: "global" });
    const b = barriers();
    await Promise.all([serve("a", b), serve("b", b), serve("c", b)]);
    capture("outside");
    await overseer.flush();
    expectOwners({ before: "b", after: "b2" }, undefined); // c: extractUser answered null: nobody, not "global"
    expect(userOf("outside")).toBe("global");
  });

  it("setUser inside a request with nothing from extractUser sets that request's user", async () => {
    const req = request("s");
    await new Promise<void>((resolve) =>
      Codmir.requestHandler()(req, response(), () => {
        void (async () => {
          overseer.setUser({ id: "inside" });
          await new Promise((r) => setTimeout(r, 2));
          capture("s:1");
          resolve();
        })();
      }),
    );
    capture("outside");
    await overseer.flush();
    expect(userOf("s:1")).toBe("inside");
    expect(userOf("outside")).toBeUndefined();
  });

  it("calls extractUser once per request, and again in errorHandler only when req.user changed since", async () => {
    const calls: unknown[] = [];
    Codmir.close();
    Codmir.init({ dsn: "https://ingest.example.test/api/overseer", clientKey: "osk_test", extractUser: (req) => (calls.push(req.user), req.user ? { id: String(req.user.id) } : null) });
    const req = request("e");
    Codmir.requestHandler()(req, response(), () => {});
    Codmir.errorHandler()(new Error("e:1"), req, response(), () => {});
    Codmir.errorHandler()(new Error("e:2"), req, response(), () => {});
    expect(calls).toHaveLength(1);
    req.user = { id: "late" }; // a later middleware's work
    Codmir.errorHandler()(new Error("e:3"), req, response(), () => {});
    Codmir.errorHandler()(new Error("e:4"), req, response(), () => {});
    expect(calls).toHaveLength(2);
    await overseer.flush();
    expect(userOf("e:1")).toBeUndefined();
    expect(userOf("e:3")).toBe("late");
    expect(userOf("e:4")).toBe("late");
  });

  it("an extractUser that throws never breaks the request, and the request has no user", async () => {
    Codmir.close();
    Codmir.init({ dsn: "https://ingest.example.test/api/overseer", clientKey: "osk_test", extractUser: () => { throw new Error("bad"); } });
    overseer.setUser({ id: "global" });
    const req = request("t", "t");
    const next = vi.fn(() => capture("t:in"));
    expect(() => Codmir.requestHandler()(req, response(), next)).not.toThrow();
    expect(next).toHaveBeenCalledTimes(1);
    expect(() => Codmir.errorHandler()(new Error("t:err"), req, response(), () => {})).not.toThrow();
    await overseer.flush();
    expect(userOf("t:in")).toBeUndefined();
    expect(userOf("t:err")).toBeUndefined();
  });

  it("tracingHandler after requestHandler shares the request's scope", async () => {
    const req = request("w", "w");
    let inside: unknown;
    Codmir.requestHandler()(req, response(), () => {
      const scope = getRequestScope();
      Codmir.tracingHandler()(req, response(), () => {
        inside = getRequestScope();
        overseer.setUser({ id: "w2" });
      });
      expect(scope?.user).toEqual({ id: "w2" });
    });
    expect(inside).toBeDefined();
  });
});

/** Hono, Next.js and Remix: the handler calls `setUser` for its own person, `c` for nobody. */
const frameworks: Record<string, (rid: "a" | "b" | "c", b: ReturnType<typeof barriers>) => Promise<unknown>> = {
  hono: (rid, b) => {
    const app = new Hono();
    app.use(codmirTracing());
    app.get("/r/:id", async (c) => {
      if (rid !== "c") overseer.setUser({ id: rid });
      await flow(rid, b);
      return c.text("ok");
    });
    return app.request(`/r/${rid}?token=secret`);
  },
  nextjs: (rid, b) =>
    withNext(async (_req: Request) => {
      if (rid !== "c") overseer.setUser({ id: rid });
      await flow(rid, b);
      return new Response("ok");
    })(new Request(`http://localhost/r/${rid}?token=secret`)),
  remix: (rid, b) =>
    withRemix(async ({ request: _request }: { request: Request }) => {
      if (rid !== "c") overseer.setUser({ id: rid });
      await flow(rid, b);
      return new Response("ok");
    })({ request: new Request(`http://localhost/r/${rid}?token=secret`) }),
};

describe.each(Object.keys(frameworks))("%s", (name) => {
  const run = async (): Promise<void> => {
    const b = barriers();
    await Promise.all((["a", "b", "c"] as const).map((rid) => frameworks[name](rid, b)));
    await overseer.flush();
  };

  it("overlapping requests keep their own users, and each event names its own request", async () => {
    await run();
    expectOwners({ before: "b", after: "b2" }, undefined);
    for (const rid of ["a", "b", "c"]) expect(sent.find((e) => e.message === `${rid}:end`)?.request?.url).toBe(`http://localhost/r/${rid}`);
  });

  it("the process-wide user is left alone by setUser in a request, and is what a request without a user of its own sees", async () => {
    overseer.setUser({ id: "global" });
    await run();
    capture("outside");
    await overseer.flush();
    expectOwners({ before: "b", after: "b2" }, "global");
    expect(userOf("outside")).toBe("global");
  });
});
