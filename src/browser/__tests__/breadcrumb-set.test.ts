// @vitest-environment jsdom
/**
 * `/browser`, `/nextjs` and `/remix` record the same breadcrumbs: clicks, `fetch`, route changes and console warnings,
 * with the same option names, and `close()` ends them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Browser from "../index";
import * as Nextjs from "../../nextjs/index";
import * as Remix from "../../remix/index";

const INGEST = "https://ingest.example.test/api/overseer";

type Crumb = { category: string; level?: string; message: string; data?: Record<string, unknown> };
type Entry = { captureException(e: unknown): string; flush(): Promise<boolean>; close(): void };

let bodies: Array<{ events: Array<{ type: string; event: { message?: string; breadcrumbs: Crumb[] } }> }> = [];

beforeEach(() => {
  bodies = [];
  for (const method of ["error", "warn"] as const) vi.spyOn(console, method).mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (String(url).startsWith(INGEST)) bodies.push(JSON.parse(String(init.body)));
      return new Response("{}", { status: 200 });
    }),
  );
});

afterEach(() => {
  Browser.close();
  Nextjs.close();
  Remix.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

async function trail(entry: Entry): Promise<Crumb[]> {
  entry.captureException(new Error("probe"));
  await entry.flush();
  return bodies.flatMap((b) => b.events).filter((e) => e.type === "error").at(-1)!.event.breadcrumbs;
}

describe("/browser", () => {
  it("two pushState calls are two navigation breadcrumbs", async () => {
    Browser.init({ dsn: INGEST, clientKey: "osk_test" });
    history.pushState({}, "", "/orders");
    history.pushState({}, "", "/orders/7");
    const moves = (await trail(Browser)).filter((c) => c.category === "navigation" && c.message.startsWith("pushState"));
    expect(moves.map((c) => c.message)).toEqual(["pushState /orders", "pushState /orders/7"]);
  });

  it("records console warnings, and trackNavigation: false and trackConsole: false turn them off", async () => {
    Browser.init({ dsn: INGEST, clientKey: "osk_test", trackNavigation: false, trackConsole: false });
    history.pushState({}, "", "/orders");
    console.warn("careful");
    const crumbs = await trail(Browser);
    expect(crumbs.filter((c) => c.category === "navigation" || c.category === "console")).toEqual([]);
  });

  it("with captureConsoleErrors the captured message carries its own console breadcrumb once", async () => {
    Browser.init({ dsn: INGEST, clientKey: "osk_test", captureConsoleErrors: true });
    console.error("it broke");
    await Browser.flush();
    // A message is sent flat, an error as `{ type, event }`.
    const message = bodies.flatMap((b) => b.events).find((e) => (e as unknown as { message?: string }).message === "it broke") as unknown as {
      message: string;
      breadcrumbs: Crumb[];
    };
    expect(message.message).toBe("it broke");
    expect(message.breadcrumbs.filter((c) => c.category === "console").map((c) => c.message)).toEqual(["it broke"]);
  });

  it("close puts console back and removes the listeners", async () => {
    const before = { warn: console.warn, error: console.error, push: history.pushState };
    Browser.init({ dsn: INGEST, clientKey: "osk_test", captureConsoleErrors: true });
    expect(console.warn).not.toBe(before.warn);
    Browser.close();
    expect(console.warn).toBe(before.warn);
    expect(console.error).toBe(before.error);
    expect(history.pushState).toBe(before.push);

    Browser.init({ dsn: INGEST, clientKey: "osk_test", trackConsole: false, trackNavigation: false });
    Browser.close();
    document.body.click();
    Browser.init({ dsn: INGEST, clientKey: "osk_test", trackConsole: false, trackNavigation: false });
    expect((await trail(Browser)).filter((c) => c.category === "ui.click")).toEqual([]);
  });
});

describe.each([
  ["/nextjs", Nextjs, () => Nextjs.init({ dsn: INGEST, clientKey: "osk_test" }), { trackRouteChanges: false }],
  [
    "/remix",
    Remix,
    () => {
      Remix.init({ dsn: INGEST, clientKey: "osk_test" });
      Remix.setupBrowserTracking();
    },
    { captureRouteChanges: false },
  ],
] as const)("%s in a browser", (_name, entry, start, oldName) => {
  const withOld = (): void => {
    if ("trackRouteChanges" in oldName) Nextjs.init({ dsn: INGEST, clientKey: "osk_test", ...oldName });
    else {
      Remix.init({ dsn: INGEST, clientKey: "osk_test", ...oldName });
      Remix.setupBrowserTracking();
    }
  };

  it("a click and a fetch are a ui.click and a fetch breadcrumb", async () => {
    start();
    document.body.innerHTML = '<button id="buy">Buy</button>';
    document.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await fetch("https://api.example.test/cart");
    const crumbs = await trail(entry as Entry);
    expect(crumbs.find((c) => c.category === "ui.click")?.message).toBe('button#buy "Buy"');
    expect(crumbs.find((c) => c.category === "fetch")?.message).toBe("GET /cart 200");
  });

  it("records route changes and console warnings", async () => {
    start();
    history.pushState({}, "", "/orders");
    console.warn("careful");
    const crumbs = await trail(entry as Entry);
    expect(crumbs.map((c) => c.message)).toEqual(expect.arrayContaining(["pushState /orders", "careful"]));
  });

  it("the older route-change option still turns navigation off, and the rest stays on", async () => {
    withOld();
    history.pushState({}, "", "/orders");
    console.warn("careful");
    const crumbs = await trail(entry as Entry);
    expect(crumbs.some((c) => c.category === "navigation")).toBe(false);
    expect(crumbs.some((c) => c.category === "console")).toBe(true);
  });

  it("close puts console, fetch and history back", () => {
    const before = { warn: console.warn, fetch: globalThis.fetch, push: history.pushState };
    start();
    expect(console.warn).not.toBe(before.warn);
    expect(globalThis.fetch).not.toBe(before.fetch);
    entry.close();
    expect(console.warn).toBe(before.warn);
    expect(globalThis.fetch).toBe(before.fetch);
    expect(history.pushState).toBe(before.push);
  });
});
