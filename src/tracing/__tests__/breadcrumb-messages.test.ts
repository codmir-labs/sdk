// @vitest-environment jsdom
/**
 * What an error's breadcrumbs say: the newest 20, navigation messages that name the page, fetch and XHR messages that
 * name the path and the status, and none for the SDK's own requests (errors, replay, feedback).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addBreadcrumb, captureException, close, init, type OverseerEvent } from "../../overseer/index";
import { trackNavigation } from "../../overseer/navigation";
import { instrumentFetch, instrumentXhr, startSpan } from "../index";

const DSN = "https://ingest.example.test/api/overseer";
let events: OverseerEvent[];
let teardown: Array<() => void>;
let outcome: { status: number; event: "load" | "error" };
const realProto = { open: XMLHttpRequest.prototype.open, send: XMLHttpRequest.prototype.send };

beforeEach(() => {
  events = [];
  teardown = [];
  outcome = { status: 200, event: "load" };
  init({
    dsn: DSN,
    clientKey: "osk_test",
    includeSourceContext: false,
    tracesSampleRate: 1,
    tracePropagationTargets: ["ingest.example.test"],
    beforeSend: (e) => (events.push(e), null),
  });
});
afterEach(() => {
  for (const fn of teardown.reverse()) fn();
  close();
  Object.assign(XMLHttpRequest.prototype, realProto);
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const crumbs = () => {
  captureException(new Error("x"));
  return events.at(-1)!.breadcrumbs ?? [];
};

describe("the cap", () => {
  it("an error carries the last 20 breadcrumbs, in order", () => {
    for (let i = 1; i <= 25; i++) addBreadcrumb({ category: "t", message: `b${i}` });
    const out = crumbs().map((c) => c.message);
    expect(out).toEqual(Array.from({ length: 20 }, (_, i) => `b${i + 6}`));
  });
});

describe("navigation messages", () => {
  const messages = () => crumbs().filter((c) => c.category === "navigation").map((c) => c.message);

  it("the first page keeps its pathname", () => {
    window.history.replaceState(null, "", "/start?token=abc#x");
    teardown.push(trackNavigation());
    expect(messages()).toEqual(["/start"]);
  });

  it("pushState names the destination path, no query and no fragment", () => {
    teardown.push(trackNavigation());
    window.history.pushState(null, "", "/checkout?token=abc#x");
    expect(messages().at(-1)).toBe("pushState /checkout");
    expect(crumbs().at(-1)!.data).toMatchObject({ to: expect.not.stringContaining("token") });
  });

  it("replaceState names the destination path", () => {
    teardown.push(trackNavigation());
    window.history.replaceState(null, "", "/cart?token=abc#x");
    expect(messages().at(-1)).toBe("replaceState /cart");
  });

  it("popstate names the page it lands on", () => {
    window.history.replaceState(null, "", "/checkout?token=abc#x");
    teardown.push(trackNavigation());
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(messages().at(-1)).toBe("popstate /checkout");
    window.history.replaceState(null, "", "/");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(messages().at(-1)).toBe("popstate /");
  });
});

describe("fetch messages", () => {
  const stub = (impl: (url: string, init?: RequestInit) => Promise<Response>) => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => impl(String(input), init)));
    teardown.push(instrumentFetch({ breadcrumbs: true }));
  };
  const fetchCrumbs = () => crumbs().filter((c) => c.category === "fetch");

  it("a response names the status", async () => {
    stub(async () => new Response("{}", { status: 500 }));
    await fetch("/api/cart?id=7#x");
    expect(fetchCrumbs().at(-1)!.message).toBe("GET /api/cart 500");
  });

  it("a network failure says failed", async () => {
    stub(async () => {
      throw new TypeError("down");
    });
    await fetch("/api/cart?id=7").catch(() => undefined);
    expect(fetchCrumbs().at(-1)!.message).toBe("GET /api/cart failed");
  });

  it("an absolute URL still gives the path", async () => {
    stub(async () => new Response("{}", { status: 200 }));
    await fetch("https://api.example.com/v1/users?x=1", { method: "post" });
    expect(fetchCrumbs().at(-1)!.message).toBe("POST /v1/users 200");
  });
});

describe("xhr messages", () => {
  const xhr = (url: string): Promise<void> =>
    new Promise((resolve) => {
      const x = new XMLHttpRequest();
      x.addEventListener("loadend", () => resolve());
      x.open("GET", url);
      x.send();
    });
  const stubTransport = () => {
    const proto = XMLHttpRequest.prototype;
    proto.open = function () {} as typeof proto.open;
    proto.send = function (this: XMLHttpRequest) {
      Object.defineProperty(this, "status", { value: outcome.status, configurable: true });
      queueMicrotask(() => {
        this.dispatchEvent(new Event(outcome.event));
        this.dispatchEvent(new Event("loadend"));
      });
    };
  };
  const xhrCrumbs = () => crumbs().filter((c) => c.category === "xhr");

  it("a response names the status", async () => {
    stubTransport();
    outcome = { status: 500, event: "load" };
    teardown.push(instrumentXhr());
    await xhr("/api/cart?id=7#x");
    expect(xhrCrumbs().at(-1)!.message).toBe("GET /api/cart 500");
  });

  it("an error says failed", async () => {
    stubTransport();
    outcome = { status: 0, event: "error" };
    teardown.push(instrumentXhr());
    await xhr("/api/cart?id=7");
    expect(xhrCrumbs().at(-1)!.message).toBe("GET /api/cart failed");
  });
});

describe("the SDK's own requests", () => {
  it("a replay upload through fetch makes no breadcrumb and no span", async () => {
    const seen: Array<{ url: string; traceparent: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push({ url: String(input), traceparent: new Headers(init?.headers).get("traceparent") });
        return new Response("{}", { status: 200 });
      }),
    );
    teardown.push(instrumentFetch({ breadcrumbs: true }));
    await startSpan({ op: "function", name: "root" }, async () => {
      await fetch(`${DSN}/replay`, { method: "POST", body: "{}" });
      await fetch(`${DSN}/feedback`, { method: "POST", body: "{}" });
      await fetch(`${DSN}/ingest`, { method: "POST", body: "{}" });
      await fetch("https://ingest.example.test/api/cart");
    });
    expect(seen.slice(0, 3).map((s) => s.traceparent)).toEqual([null, null, null]);
    expect(seen[3]!.traceparent).not.toBeNull();
    expect(crumbs().filter((c) => c.category === "fetch").map((c) => c.message)).toEqual(["GET /api/cart 200"]);
  });

  it("an XHR to the replay URL makes no breadcrumb, an app request on the same origin does", async () => {
    const proto = XMLHttpRequest.prototype;
    proto.open = function () {} as typeof proto.open;
    proto.send = function (this: XMLHttpRequest) {
      Object.defineProperty(this, "status", { value: 200, configurable: true });
      queueMicrotask(() => this.dispatchEvent(new Event("loadend")));
    };
    teardown.push(instrumentXhr());
    const call = (url: string) =>
      new Promise<void>((resolve) => {
        const x = new XMLHttpRequest();
        x.addEventListener("loadend", () => resolve());
        x.open("POST", url);
        x.send();
      });
    await call(`${DSN}/replay`);
    await call("https://ingest.example.test/api/cart");
    expect(crumbs().filter((c) => c.category === "xhr").map((c) => c.message)).toEqual(["POST /api/cart 200"]);
  });
});
