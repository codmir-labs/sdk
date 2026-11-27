// @vitest-environment jsdom
/** A request's span keeps origin and path for a URL with a host, and the error text hides the request's own URL. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { close, getClient, init } from "../../overseer/index";
import { instrumentFetch, instrumentXhr, Span, startSpan } from "../index";

let teardown: Array<() => void>;
let children: Span[];

beforeEach(() => {
  teardown = [];
  children = [];
  init({ clientKey: "k", dsn: "http://127.0.0.1:9/never", includeSourceContext: false, tracesSampleRate: 1 });
  const startChild = Span.prototype.startChild;
  const spy = vi.spyOn(Span.prototype, "startChild").mockImplementation(function (this: Span, options) {
    const child = startChild.call(this, options);
    children.push(child);
    return child;
  });
  teardown.push(() => spy.mockRestore());
});
afterEach(() => {
  for (const fn of teardown.reverse()) fn();
  close();
  vi.unstubAllGlobals();
});

const crumb = (category: string) => {
  const stored = (getClient() as unknown as { breadcrumbs: Array<{ category: string; message: string; data: Record<string, unknown> }> }).breadcrumbs;
  return stored.filter((c) => c.category === category).at(-1)!;
};

const viaFetch = async (input: string | URL, impl: () => Promise<Response> = async () => new Response("{}")) => {
  vi.stubGlobal("fetch", vi.fn(impl));
  teardown.push(instrumentFetch({ breadcrumbs: true }));
  await startSpan({ op: "test", name: "root" }, () => fetch(input).catch(() => undefined));
  return children.at(-1)!;
};

const viaXhr = async (url: string) => {
  const send = vi.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(function (this: XMLHttpRequest) {
    queueMicrotask(() => this.dispatchEvent(new Event("loadend")));
  });
  teardown.push(instrumentXhr({ breadcrumbs: true }), () => send.mockRestore());
  await startSpan({ op: "test", name: "root" }, async () => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url);
    xhr.send();
    await new Promise((r) => setTimeout(r, 5));
  });
  return children.at(-1)!;
};

describe("span url of a fetch", () => {
  it("a relative URL with a host after resolving is origin and path, as before", async () => {
    const span = await viaFetch("/api/items?token=SECRET_Q");
    expect(span.data.url).toBe(`${window.location.origin}/api/items`);
    expect(span.name).toBe("GET /api/items");
  });

  it("an absolute URL with credentials is origin and path", async () => {
    const span = await viaFetch("https://svc:SECRET_PASS@api.example.com/v1/items?q=SECRET_Q#SECRET_F");
    expect(span.data.url).toBe("https://api.example.com/v1/items");
    expect(span.name).toBe("GET /v1/items");
  });

  it("a data: URL is its scrubbed form, in the data and the name", async () => {
    const span = await viaFetch(`data:image/png;base64,${"A".repeat(80_000)}`);
    expect(span.data.url).toBe("data:image/png;base64,[80000 bytes]");
    expect(span.name).toBe("GET data:image/png;base64,[80000 bytes]");
  });
});

describe("span url of an XHR", () => {
  it("a relative URL with a host after resolving is origin and path, as before", async () => {
    const span = await viaXhr("/api/items?token=SECRET_Q");
    expect(span.data.url).toBe(`${window.location.origin}/api/items`);
    expect(span.name).toBe("GET /api/items");
  });

  it("a data: URL is its scrubbed form, in the data and the name", async () => {
    const span = await viaXhr(`data:image/png;base64,${"A".repeat(80_000)}`);
    expect(span.data.url).toBe("data:image/png;base64,[80000 bytes]");
    expect(span.name).toBe("GET data:image/png;base64,[80000 bytes]");
  });
});

describe("the request's own URL in a failed fetch's error text", () => {
  it("a relative URL's query is gone from the runtime's message", async () => {
    await viaFetch("/x?t=SECRET_T", async () => { throw new TypeError("Failed to parse URL from /x?t=SECRET_T"); });
    const c = crumb("fetch");
    expect(c.data.error).toBe("Failed to parse URL from /x");
    expect(JSON.stringify(c)).not.toContain("SECRET");
  });

  it("a URL object's href is masked the same way", async () => {
    await viaFetch(new URL("https://api.example.com/x?t=SECRET_T"), async () => { throw new TypeError("bad https://api.example.com/x?t=SECRET_T here"); });
    expect(crumb("fetch").data.error).toBe("bad https://api.example.com/x here");
  });

  it("the request's data: URL in the message is its size, not its payload", async () => {
    const url = `data:text/plain,${"SECRET".repeat(5_000)}`;
    await viaFetch(url, async () => { throw new TypeError(`Failed to parse URL from ${url}`); });
    const c = crumb("fetch");
    expect(c.data.error).toBe("Failed to parse URL from data:text/plain,[30000 bytes]");
    expect(JSON.stringify(c)).not.toContain("SECRET");
  });

  it("an empty URL leaves the message as it is", async () => {
    await viaFetch("", async () => { throw new TypeError("Failed to parse URL from "); });
    expect(crumb("fetch").data.error).toBe("Failed to parse URL from ");
  });
});
