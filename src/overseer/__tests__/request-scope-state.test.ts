/**
 * Each request carries its own tags and breadcrumbs: `setTag`, `setTags` and `addBreadcrumb` inside a request write that
 * request's state, so two overlapping requests never see each other's on an error, a message or a transaction. What was
 * set outside any request is process-wide and is on every event, with the request's own tag winning key by key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Codmir from "../../express/index";
import { instrumentFetch } from "../../tracing/fetch";
import { installNodeTracingContext, traceServerRequest } from "../../tracing/server";
import * as overseer from "../index";

type Crumb = { category?: string; message: string };
type Sent = { type: string; message?: string; name?: string; tags?: Record<string, string>; breadcrumbs?: Crumb[] };
let sent: Sent[];

beforeEach(() => {
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/ingest")) {
        for (const wire of (JSON.parse(String(init?.body)) as { events: Array<{ type: string; event?: Sent }> }).events) {
          sent.push((wire.event ?? wire) as Sent);
        }
      }
      return new Response("{}", { status: String(url).includes("/missing") ? 404 : 200 });
    }),
  );
  installNodeTracingContext();
  overseer.init({ dsn: "https://ingest.example.test/api/overseer", clientKey: "osk_test", tracesSampleRate: 1 });
});
afterEach(() => {
  overseer.close();
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

const serve = <T>(name: string, fn: () => Promise<T>): Promise<T> =>
  traceServerRequest({ method: "GET", route: `/t/${name}`, url: `https://app.test/t/${name}` }, fn);

const crumb = (message: string): void => overseer.addBreadcrumb({ type: "default", category: "test", message });
const eventOf = (message: string): Sent => {
  const events = sent.filter((e) => e.message === message && e.type !== "transaction");
  expect(events, message).toHaveLength(1);
  return events[0];
};
const crumbsOf = (message: string): string[] => (eventOf(message).breadcrumbs ?? []).map((c) => c.message);
const boom = (message: string): void => void overseer.captureException(new Error(message));

describe("tags", () => {
  it("(a) two overlapping requests each keep their own tag", async () => {
    const barrier = new Barrier(2);
    const request = async (tenant: string): Promise<void> => {
      overseer.setTag("tenant", tenant);
      await barrier.wait();
      boom(`${tenant}:error`);
    };
    await Promise.all([serve("acme", () => request("acme")), serve("globex", () => request("globex"))]);
    await overseer.flush();
    expect(eventOf("acme:error").tags?.tenant).toBe("acme");
    expect(eventOf("globex:error").tags?.tenant).toBe("globex");
  });

  it("(a) setTags is the request's own too", async () => {
    const barrier = new Barrier(2);
    const request = async (tenant: string): Promise<void> => {
      overseer.setTags({ tenant, plan: `${tenant}-plan` });
      await barrier.wait();
      boom(`${tenant}:error`);
    };
    await Promise.all([serve("acme", () => request("acme")), serve("globex", () => request("globex"))]);
    await overseer.flush();
    expect(eventOf("acme:error").tags).toMatchObject({ tenant: "acme", plan: "acme-plan" });
    expect(eventOf("globex:error").tags).toMatchObject({ tenant: "globex", plan: "globex-plan" });
  });
});

describe("breadcrumbs", () => {
  it("(b) two overlapping requests each carry their own breadcrumb only", async () => {
    const barrier = new Barrier(2);
    const request = async (id: string): Promise<void> => {
      crumb(`${id}-1`);
      await barrier.wait();
      boom(`${id}:error`);
    };
    await Promise.all([serve("a", () => request("a")), serve("b", () => request("b"))]);
    await overseer.flush();
    expect(crumbsOf("a:error")).toEqual(["a-1"]);
    expect(crumbsOf("b:error")).toEqual(["b-1"]);
  });

  it("(b) a fetch breadcrumb from instrumentFetch stays on the request that made the call", async () => {
    const stop = instrumentFetch();
    const barrier = new Barrier(2);
    await Promise.all([
      serve("a", async () => {
        await fetch("https://payments.example.test/v1/customers/cus_alice/missing");
        await barrier.wait();
      }),
      serve("b", async () => {
        await barrier.wait();
        boom("b:error");
      }),
    ]);
    stop();
    await overseer.flush();
    expect((eventOf("b:error").breadcrumbs ?? []).filter((c) => c.category === "fetch")).toEqual([]);
  });

  it("(f) a request that adds 150 breadcrumbs sends the newest 100", async () => {
    await serve("many", async () => {
      for (let i = 1; i <= 150; i++) crumb(`c-${i}`);
      boom("many:error");
    });
    await overseer.flush();
    const crumbs = crumbsOf("many:error");
    expect(crumbs).toHaveLength(100);
    expect(crumbs[0]).toBe("c-51");
    expect(crumbs[99]).toBe("c-150");
  });

  it("(f) process-wide breadcrumbs and the request's own are cut to the newest 100 together", async () => {
    for (let i = 1; i <= 60; i++) crumb(`g-${i}`);
    await serve("mix", async () => {
      for (let i = 1; i <= 60; i++) crumb(`r-${i}`);
      boom("mix:error");
    });
    await overseer.flush();
    const crumbs = crumbsOf("mix:error");
    expect(crumbs).toHaveLength(100);
    expect(crumbs[0]).toBe("g-21");
    expect(crumbs[40]).toBe("r-1");
    expect(crumbs[99]).toBe("r-60");
  });
});

describe("process-wide state", () => {
  it("(c) is on every event, a request's tag wins inside that request only, and nothing leaks out", async () => {
    overseer.setTag("region", "eu");
    overseer.setTag("tier", "free");
    crumb("boot");
    const barrier = new Barrier(2);
    await Promise.all([
      serve("a", async () => {
        overseer.setTag("tier", "pro");
        overseer.setTag("tenant", "acme");
        crumb("a-1");
        await barrier.wait();
        boom("a:error");
      }),
      serve("b", async () => {
        crumb("b-1");
        await barrier.wait();
        boom("b:error");
      }),
    ]);
    boom("outside");
    await overseer.flush();

    expect(eventOf("a:error").tags).toMatchObject({ region: "eu", tier: "pro", tenant: "acme" });
    expect(eventOf("b:error").tags).toMatchObject({ region: "eu", tier: "free" });
    expect(eventOf("b:error").tags).not.toHaveProperty("tenant");
    expect(crumbsOf("a:error")).toEqual(["boot", "a-1"]);
    expect(crumbsOf("b:error")).toEqual(["boot", "b-1"]);

    expect(eventOf("outside").tags).toMatchObject({ region: "eu", tier: "free" });
    expect(eventOf("outside").tags).not.toHaveProperty("tenant");
    expect(crumbsOf("outside")).toEqual(["boot"]);
  });

  it("(c) outside a request, setTag, setTags and addBreadcrumb are process-wide as before", async () => {
    overseer.setTag("a", "1");
    overseer.setTags({ b: "2" });
    crumb("one");
    boom("outside");
    await overseer.flush();
    expect(eventOf("outside").tags).toMatchObject({ a: "1", b: "2" });
    expect(crumbsOf("outside")).toEqual(["one"]);
  });

  it("an event gets a copy: changing it never changes what a later event gets", async () => {
    overseer.setTag("region", "eu");
    crumb("boot");
    const tags = overseer.getClient()!.getTags();
    tags.region = "us";
    expect(overseer.getClient()!.getTags().region).toBe("eu");
    boom("first");
    await overseer.flush();
    (eventOf("first").breadcrumbs as Crumb[]).push({ message: "extra" });
    boom("second");
    await overseer.flush();
    expect(crumbsOf("second")).toEqual(["boot"]);
  });
});

describe("transactions", () => {
  it("(d) two overlapping traced requests each end with their own tenant", async () => {
    const barrier = new Barrier(2);
    const request = async (tenant: string): Promise<void> => {
      overseer.setTag("tenant", tenant);
      await barrier.wait();
    };
    await Promise.all([serve("acme", () => request("acme")), serve("globex", () => request("globex"))]);
    await overseer.flush();
    const tx = (name: string) => sent.find((e) => e.type === "transaction" && e.name === name);
    expect(tx("GET /t/acme")?.tags?.tenant).toBe("acme");
    expect(tx("GET /t/globex")?.tags?.tenant).toBe("globex");
  });

  describe("express tracingHandler", () => {
    const request = (rid: string): any => ({
      method: "GET", url: `/t/${rid}`, originalUrl: `/t/${rid}`, path: `/t/${rid}`, baseUrl: "", params: {}, query: {}, headers: {},
    });
    // `finish` fires from the response, outside the request's own async context: the transaction still ends in its scope.
    const response = () => {
      const listeners: Array<() => void> = [];
      return { statusCode: 200, on(_e: string, fn: () => void) { listeners.push(fn); return this; }, finish: () => listeners.forEach((fn) => fn()) };
    };

    it("(d) each transaction holds its own tenant", async () => {
      Codmir.init({ dsn: "https://ingest.example.test/api/overseer", clientKey: "osk_test", tracesSampleRate: 1 });
      const barrier = new Barrier(2);
      const serveExpress = (rid: string): Promise<void> => {
        const req = request(rid);
        const res = response();
        return new Promise<void>((resolve) => {
          Codmir.requestHandler()(req, res, () =>
            Codmir.tracingHandler()(req, res, () => {
              void (async () => {
                overseer.setTag("tenant", rid);
                await barrier.wait();
                await new Promise((r) => setTimeout(r, 1));
                setTimeout(() => res.finish(), 0); // a timer started in the scope; finish is called from outside it
                resolve();
              })();
            }),
          );
        });
      };
      await Promise.all([serveExpress("acme"), serveExpress("globex")]);
      await new Promise((r) => setTimeout(r, 5));
      await overseer.flush();
      const tx = (name: string) => sent.find((e) => e.type === "transaction" && e.name === name);
      expect(tx("GET /t/acme")?.tags?.tenant).toBe("acme");
      expect(tx("GET /t/globex")?.tags?.tenant).toBe("globex");
    });

    it("(e) request A's http.request breadcrumb is not on request B's error", async () => {
      Codmir.init({ dsn: "https://ingest.example.test/api/overseer", clientKey: "osk_test" });
      const barrier = new Barrier(2);
      const serveExpress = (rid: string): Promise<void> => {
        const req = request(rid);
        return new Promise<void>((resolve, reject) => {
          Codmir.requestHandler()(req, response(), () => {
            void (async () => {
              await barrier.wait();
              boom(`${rid}:error`);
            })().then(resolve, reject);
          });
        });
      };
      await Promise.all([serveExpress("a"), serveExpress("b")]);
      await overseer.flush();
      expect(crumbsOf("a:error")).toEqual(["GET /t/a"]);
      expect(crumbsOf("b:error")).toEqual(["GET /t/b"]);
    });
  });
});

describe("captureMessage", () => {
  it("(g) follows the same rules as captureException", async () => {
    overseer.setTag("region", "eu");
    crumb("boot");
    const barrier = new Barrier(2);
    const request = async (id: string): Promise<void> => {
      overseer.setTag("tenant", id);
      crumb(`${id}-1`);
      await barrier.wait();
      overseer.captureMessage(`${id}:message`);
    };
    await Promise.all([serve("a", () => request("a")), serve("b", () => request("b"))]);
    overseer.captureMessage("outside");
    await overseer.flush();
    expect(eventOf("a:message").tags).toMatchObject({ region: "eu", tenant: "a" });
    expect(eventOf("b:message").tags).toMatchObject({ region: "eu", tenant: "b" });
    expect(crumbsOf("a:message")).toEqual(["boot", "a-1"]);
    expect(crumbsOf("b:message")).toEqual(["boot", "b-1"]);
    expect(eventOf("outside").tags).not.toHaveProperty("tenant");
    expect(crumbsOf("outside")).toEqual(["boot"]);
  });
});
