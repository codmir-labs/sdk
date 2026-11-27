// @vitest-environment jsdom
/** An XHR breadcrumb holds origin and path only, for a URL with credentials in a shape a page really writes. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { close, getClient, init } from "../../overseer/index";
import { instrumentXhr } from "../index";

let teardown: Array<() => void>;

beforeEach(() => {
  teardown = [];
  init({ clientKey: "k", dsn: "http://127.0.0.1:9/never", includeSourceContext: false });
});
afterEach(() => {
  for (const fn of teardown.reverse()) fn();
  close();
});

async function request(url: string): Promise<string> {
  // The stub goes in first, so the instrumentation wraps it.
  const send = vi.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(function (this: XMLHttpRequest) {
    queueMicrotask(() => this.dispatchEvent(new Event("loadend")));
  });
  teardown.push(instrumentXhr({ breadcrumbs: true }), () => send.mockRestore());
  const xhr = new XMLHttpRequest();
  xhr.open("GET", url);
  xhr.send();
  await new Promise((r) => setTimeout(r, 5));
  // As the client stores them, before any event-level scrubbing could hide a leak.
  const stored = (getClient() as unknown as { breadcrumbs: Array<{ category: string }> }).breadcrumbs;
  return JSON.stringify(stored.filter((c) => c.category === "xhr"));
}

describe("xhr breadcrumb urls", () => {
  it.each([
    ["//svc:SECRET_XHR_PASS@api.example.com/v1/items?q=SECRET_Q"],
    [" https://svc:SECRET_SPACE_PASS@api.example.com/v1/items?q=SECRET_Q#SECRET_F"],
  ])("%j", async (url) => {
    const json = await request(url);
    expect(json).not.toContain("svc");
    expect(json).not.toContain("SECRET");
    const [crumb] = JSON.parse(json) as Array<{ data: { url: string } }>;
    expect(crumb!.data.url).toBe(url.trim().startsWith("//") ? `${window.location.protocol}//api.example.com/v1/items` : "https://api.example.com/v1/items");
  });
});
