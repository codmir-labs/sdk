// @vitest-environment jsdom
/** A fetch breadcrumb names no secret: not in its error text, and a `data:` URL is its size, not its payload. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { close, getClient, init } from "../../overseer/index";
import { instrumentFetch } from "../index";

let teardown: Array<() => void>;

beforeEach(() => {
  teardown = [];
  init({ clientKey: "k", dsn: "http://127.0.0.1:9/never", includeSourceContext: false });
});
afterEach(() => {
  for (const fn of teardown.reverse()) fn();
  close();
  vi.unstubAllGlobals();
});

/** The newest fetch breadcrumb as the client stores it, before any event-level scrubbing could hide a leak. */
const crumb = () => {
  const stored = (getClient() as unknown as { breadcrumbs: Array<{ category: string; message: string; data: Record<string, unknown> }> }).breadcrumbs;
  return stored.filter((c) => c.category === "fetch").at(-1)!;
};
const stub = (impl: () => Promise<Response>) => {
  vi.stubGlobal("fetch", vi.fn(impl));
  teardown.push(instrumentFetch({ breadcrumbs: true }));
};

describe("fetch breadcrumb text", () => {
  it("a failed fetch's error text has no credentials or query, and keeps its other words", async () => {
    const message = "Request cannot be constructed from a URL that includes credentials: https://user:SECRET_PASS@api.example.com/v1/orders?token=SECRET_Q";
    stub(async () => { throw new TypeError(message); });
    await fetch("https://user:SECRET_PASS@api.example.com/v1/orders?token=SECRET_Q").catch(() => undefined);
    const c = crumb();
    const error = c.data.error as string;
    expect(error).not.toContain("SECRET_PASS");
    expect(error).not.toContain("SECRET_Q");
    expect(error).not.toContain("user:");
    expect(error).toContain("Request cannot be constructed from a URL that includes credentials");
    expect(error).toContain("https://api.example.com/v1/orders");
    expect(JSON.stringify(c)).not.toContain("SECRET");
  });

  it("a protocol-relative URL with credentials is origin and path", async () => {
    stub(async () => new Response("{}"));
    await fetch("//svc:SECRET_PASS@api.example.com/v1/items?q=SECRET_Q");
    expect(JSON.stringify(crumb())).not.toMatch(/svc|SECRET/);
  });

  it("a data: URL names its size, not its payload", async () => {
    stub(async () => new Response("{}", { status: 200 }));
    await fetch(`data:image/png;base64,${"A".repeat(80_000)}`);
    const c = crumb();
    expect(c.message).toBe("GET data:image/png;base64,[80000 bytes] 200");
    expect(JSON.stringify(c).length).toBeLessThan(400);
  });

  it("a failed data: fetch reads GET data:image/png;base64,[80000 bytes] failed", async () => {
    stub(async () => { throw new TypeError("fetch failed"); });
    await fetch(`data:image/png;base64,${"A".repeat(80_000)}`).catch(() => undefined);
    const c = crumb();
    expect(c.message).toBe("GET data:image/png;base64,[80000 bytes] failed");
    expect(c.message.length).toBeLessThan(100);
  });
});
