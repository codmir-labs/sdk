/**
 * A Next.js route handler, server action or server component the app did not wrap with `withCodmirTracing` has no
 * request scope. On a server `@codmir/sdk/nextjs` still gives each one its own: the first setter that runs opens a scope
 * for the rest of that async context, so two overlapping requests each report their own user, tags and breadcrumbs, and
 * a request that sets none reports none. Plain Node, with the core `init`, keeps the process-wide user.
 */
import { Agent, createServer, get, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Nextjs from "../index";
import * as overseer from "../../overseer/index";

type Sent = {
  message: string;
  user?: { id?: string };
  tags?: Record<string, string>;
  breadcrumbs?: Array<{ message?: string; data?: { count?: number } }>;
  request?: unknown;
  contexts?: { conversation?: { id: string }; session?: { id: string } };
};
let sent: Sent[];

const SLOTS = ["codmir.request-scope.store", "codmir.request-scope.open-on-write", "codmir.overseer.client"].map((key) => Symbol.for(key));
const forgetSlots = (): void => {
  for (const slot of SLOTS) delete (globalThis as Record<symbol, unknown>)[slot];
};

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
  Nextjs.close();
  overseer.getClient()?.close();
  forgetSlots();
  vi.unstubAllGlobals();
});

const config = { dsn: "https://ingest.example.test/api/overseer", clientKey: "osk_test" };
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `fn` in an async context of its own, as Node's HTTP server gives each request: a setter inside it never reaches the caller. */
const request = <T>(fn: () => Promise<T>): Promise<T> => new Promise((resolve, reject) => setTimeout(() => fn().then(resolve, reject), 0));

const eventFor = (message: string): Sent => {
  const found = sent.filter((e) => e.message === message);
  expect(found, message).toHaveLength(1);
  return found[0];
};

/** An unwrapped handler: set what `who` says, wait as a real handler does, then report. */
async function handler(who: string | null, tag?: string): Promise<void> {
  if (who) Nextjs.setUser({ id: who });
  if (tag) {
    Nextjs.setTag("who", tag);
    Nextjs.addBreadcrumb({ category: "test", message: `crumb ${tag}` });
  }
  await sleep(30);
  Nextjs.captureException(new Error(`report ${who ?? "nobody"}`));
}

describe("an unwrapped handler on a server", () => {
  beforeEach(() => Nextjs.init(config));

  it("reports its own user when two requests overlap, and none for a request that sets none", async () => {
    await Promise.all([request(() => handler("carol")), request(() => handler("dave")), request(() => handler(null))]);
    await Nextjs.flush();
    expect(eventFor("report carol").user?.id).toBe("carol");
    expect(eventFor("report dave").user?.id).toBe("dave");
    expect(eventFor("report nobody").user).toBeUndefined();
  });

  it("does not put a user into the process-wide state: a later request that sets none reports none", async () => {
    await request(() => handler("carol"));
    await request(() => handler(null));
    await Nextjs.flush();
    expect(eventFor("report carol").user?.id).toBe("carol");
    expect(eventFor("report nobody").user).toBeUndefined();
  });

  it("keeps tags and breadcrumbs of overlapping requests apart", async () => {
    await Promise.all([request(() => handler("carol", "c")), request(() => handler("dave", "d")), request(() => handler(null))]);
    await Nextjs.flush();
    const [carol, dave, nobody] = ["carol", "dave", "nobody"].map((who) => eventFor(`report ${who}`));
    expect(carol.tags?.who).toBe("c");
    expect(carol.breadcrumbs?.map((b) => b.message)).toEqual(["crumb c"]);
    expect(dave.tags?.who).toBe("d");
    expect(dave.breadcrumbs?.map((b) => b.message)).toEqual(["crumb d"]);
    expect(nobody.tags?.who).toBeUndefined();
    expect(nobody.breadcrumbs ?? []).toEqual([]);
  });

  it("sends no request for the scope a setter opened: it is not a request", async () => {
    await request(() => handler("carol"));
    await Nextjs.flush();
    expect(eventFor("report carol").request).toBeUndefined();
  });

  it("keeps the user of a script that sets it at its top and reports later", async () => {
    await request(async () => {
      Nextjs.setUser({ id: "boot" });
      await sleep(10);
      await sleep(10);
      Nextjs.captureException(new Error("report boot"));
    });
    await Nextjs.flush();
    expect(eventFor("report boot").user?.id).toBe("boot");
  });
});

/** What each setter writes, and how to read it back off an event. */
const WRITERS: Array<{ name: string; write: (v: string) => void; read: (e: Sent) => unknown; value: (v: string) => unknown }> = [
  { name: "setTag", write: (v) => Nextjs.setTag("k", v), read: (e) => e.tags?.k, value: (v) => v },
  { name: "setTags", write: (v) => Nextjs.setTags({ k: v }), read: (e) => e.tags?.k, value: (v) => v },
  { name: "setSessionId", write: (v) => overseer.setSessionId(v), read: (e) => e.contexts?.session?.id, value: (v) => v },
  { name: "setConversationId", write: (v) => overseer.setConversationId(v), read: (e) => e.contexts?.conversation?.id, value: (v) => v },
  { name: "addBreadcrumb", write: (v) => Nextjs.addBreadcrumb({ category: "t", message: v }), read: (e) => e.breadcrumbs?.map((b) => b.message), value: (v) => [v] },
  {
    name: "addRepeatedBreadcrumb",
    write: (v) => {
      overseer.addRepeatedBreadcrumb({ category: "t", message: v });
      overseer.addRepeatedBreadcrumb({ category: "t", message: v });
    },
    read: (e) => e.breadcrumbs?.map((b) => `${b.message}x${b.data?.count}`),
    value: (v) => [`${v}x2`],
  },
];

describe.each(WRITERS)("$name outside a request scope on a server", ({ write, read, value }) => {
  beforeEach(() => Nextjs.init(config));

  it("stays in its async context: two concurrent contexts each carry only their own, a third none, and nothing is process-wide", async () => {
    const report = async (who: string, v: string | null): Promise<void> => {
      if (v) write(v);
      await sleep(30);
      Nextjs.captureException(new Error(`report ${who}`));
    };
    await Promise.all([request(() => report("a", "va")), request(() => report("b", "vb")), request(() => report("none", null))]);
    // A context of its own that sets nothing, after the others are done: the process holds nothing either.
    await request(() => report("later", null));
    await Nextjs.flush();
    expect(read(eventFor("report a"))).toEqual(value("va"));
    expect(read(eventFor("report b"))).toEqual(value("vb"));
    const empty = (e: Sent): unknown => read(e);
    for (const who of ["none", "later"]) {
      const got = empty(eventFor(`report ${who}`));
      expect(got === undefined || got === null || (Array.isArray(got) && got.length === 0), `${who}: ${JSON.stringify(got)}`).toBe(true);
    }
  });
});

describe("a node:http server", () => {
  let server: Server;
  let agent: Agent;
  afterEach(async () => {
    agent?.destroy();
    await new Promise((resolve) => server?.close(resolve));
  });

  it("starts every request with no opened scope: a later request on the same keep-alive socket carries nothing of the first", async () => {
    Nextjs.init(config);
    const sockets: object[] = [];
    server = createServer(async (req, res) => {
      sockets.push(req.socket);
      const who = new URL(req.url ?? "/", "http://x").searchParams.get("who");
      if (who) {
        Nextjs.setUser({ id: who });
        Nextjs.setTag("who", who);
        Nextjs.addBreadcrumb({ category: "t", message: `crumb ${who}` });
      }
      await sleep(10);
      Nextjs.captureException(new Error(`report ${who ?? "nobody"}`));
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const call = (query: string): Promise<void> =>
      new Promise((resolve, reject) => {
        get({ host: "127.0.0.1", port, path: `/${query}`, agent }, (res) => {
          res.resume();
          res.on("end", resolve);
        }).on("error", reject);
      });
    await call("?who=carol");
    await call("");
    expect(sockets).toHaveLength(2);
    expect(sockets[1], "the second request reuses the first one's socket").toBe(sockets[0]);
    await Nextjs.flush();
    expect(eventFor("report carol").user?.id).toBe("carol");
    const nobody = eventFor("report nobody");
    expect(nobody.user).toBeUndefined();
    expect(nobody.tags?.who).toBeUndefined();
    expect(nobody.breadcrumbs ?? []).toEqual([]);
  });
});

describe("close", () => {
  it("ends the scopes setters opened: a later init starts clean", async () => {
    Nextjs.init(config);
    await request(async () => {
      Nextjs.setUser({ id: "before" });
      Nextjs.setTag("who", "before");
      await Nextjs.close();
      Nextjs.init(config);
      Nextjs.captureException(new Error("report after"));
    });
    await Nextjs.flush();
    const after = eventFor("report after");
    expect(after.user).toBeUndefined();
    expect(after.tags?.who).toBeUndefined();
  });
});

describe("plain Node", () => {
  it("keeps setUser process-wide with the core client: a script that sets it at its top reports it later", async () => {
    overseer.init(config);
    overseer.setUser({ id: "boot" });
    await request(async () => {
      await sleep(10);
      overseer.captureException(new Error("report boot"));
    });
    await overseer.flush();
    expect(eventFor("report boot").user?.id).toBe("boot");
  });

  it("keeps setUser process-wide when there is no request store, even beside the Next.js entry", async () => {
    Nextjs.init(config);
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("codmir.request-scope.store")];
    Nextjs.setUser({ id: "boot" });
    await request(async () => {
      Nextjs.captureException(new Error("report boot"));
    });
    await Nextjs.flush();
    expect(eventFor("report boot").user?.id).toBe("boot");
  });
});
