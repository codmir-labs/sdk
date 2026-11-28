/**
 * A Next.js route handler, server action or server component the app did not wrap with `withCodmirTracing` has no
 * request scope. On a server `@codmir/sdk/nextjs` still gives each one its own: the first setter that runs opens a scope
 * for the rest of that async context, so two overlapping requests each report their own user, tags and breadcrumbs, and
 * a request that sets none reports none. Plain Node, with the core `init`, keeps the process-wide user.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Nextjs from "../index";
import * as overseer from "../../overseer/index";

type Sent = { message: string; user?: { id?: string }; tags?: Record<string, string>; breadcrumbs?: Array<{ message?: string }>; request?: unknown };
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
