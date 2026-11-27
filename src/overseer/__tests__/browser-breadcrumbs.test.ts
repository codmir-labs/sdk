// @vitest-environment jsdom
/**
 * The one installer behind the browser entries: each option on and off, console breadcrumbs (levels, length, secrets,
 * repeats, re-entry, a console patch before or after ours) and what `stop` puts back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { close, captureException, flush, getClient, init } from "../index";
import { installBrowserBreadcrumbs, type BrowserBreadcrumbOptions } from "../browser-breadcrumbs";
import type { Stop } from "../lifecycle";

type Crumb = { category: string; level?: string; message: string; data?: Record<string, unknown> };

let bodies: Array<{ events: Array<{ type: string; event: { breadcrumbs: Crumb[] } }> }> = [];
let stop: Stop | undefined;
let debug = false;
let ingestStatus = 200;

beforeEach(() => {
  bodies = [];
  debug = false;
  ingestStatus = 200;
  // The console methods are spies first, so the patch goes over them and nothing prints.
  for (const method of ["error", "warn", "info", "log", "debug"] as const) vi.spyOn(console, method).mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      if (String(_url).includes("ingest")) bodies.push(JSON.parse(String(init.body)));
      return new Response("{}", { status: String(_url).includes("ingest") ? ingestStatus : 200 });
    }),
  );
});

afterEach(() => {
  stop?.();
  stop = undefined;
  close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

/** Starts the client and the installer; `debug` turns on the SDK's own console output. */
function start(options?: BrowserBreadcrumbOptions): void {
  init({ dsn: "https://ingest.example.test/api/overseer", clientKey: "osk_test", debug });
  stop = installBrowserBreadcrumbs(options);
}

/** The breadcrumbs an error captured now carries. */
async function trail(): Promise<Crumb[]> {
  captureException(new Error("probe"));
  await flush();
  return bodies.flatMap((b) => b.events).filter((e) => e.type === "error").at(-1)!.event.breadcrumbs;
}
const categories = (crumbs: Crumb[]): string[] => crumbs.map((c) => c.category);

describe("each option", () => {
  const input = (): void => {
    document.body.innerHTML = '<input id="email" type="email">';
    document.querySelector("input")!.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const cases: Array<[string, string, BrowserBreadcrumbOptions, boolean, () => unknown | Promise<unknown>]> = [
    ["trackClicks", "ui.click", { trackClicks: false }, true, () => document.body.click()],
    ["trackInputs", "ui.input", { trackInputs: false }, false, input],
    ["trackRequests", "fetch", { trackRequests: false }, true, () => fetch("https://api.example.test/cart")],
    ["trackNavigation", "navigation", { trackNavigation: false }, true, () => history.pushState({}, "", "/cart")],
    ["trackConsole", "console", { trackConsole: false }, true, () => console.warn("careful")],
  ];

  it.each(cases)("%s records %s, and off records none", async (name, category, off, onByDefault, act) => {
    const on = { [name]: true } as BrowserBreadcrumbOptions;
    start(on);
    await act();
    expect(categories(await trail())).toContain(category);
    stop?.();
    close();
    bodies = [];

    start(off);
    await act();
    expect(categories(await trail())).not.toContain(category);

    // The default for an option left out.
    stop?.();
    close();
    bodies = [];
    start({});
    await act();
    expect(categories(await trail()).includes(category)).toBe(onByDefault);
  });

  it("with nothing chosen records clicks, requests, route changes and warnings, and no input", async () => {
    start();
    document.body.click();
    await fetch("https://api.example.test/cart");
    history.pushState({}, "", "/a");
    console.warn("w");
    input();
    const crumbs = await trail();
    expect(new Set(categories(crumbs))).toEqual(new Set(["navigation", "ui.click", "fetch", "console"]));
  });
});

describe("console breadcrumbs", () => {
  it("records warn and error by default, with a level that matches", async () => {
    start();
    console.warn("low disk");
    console.error("no disk");
    const crumbs = (await trail()).filter((c) => c.category === "console");
    expect(crumbs.map((c) => [c.level, c.message])).toEqual([
      ["warning", "low disk"],
      ["error", "no disk"],
    ]);
  });

  it("records log and info only when asked, and debug when listed", async () => {
    start();
    console.log("a log");
    console.info("an info");
    console.debug("a debug");
    expect((await trail()).filter((c) => c.category === "console")).toEqual([]);
    stop?.();
    close();
    bodies = [];

    start({ trackConsole: ["log", "info", "debug"] });
    console.log("a log");
    console.info("an info");
    console.debug("a debug");
    console.warn("not listed");
    const crumbs = (await trail()).filter((c) => c.category === "console");
    expect(crumbs.map((c) => [c.level, c.message])).toEqual([
      ["info", "a log"],
      ["info", "an info"],
      ["debug", "a debug"],
    ]);
  });

  it("joins the arguments as captureConsoleErrors does and never throws on one with no text", async () => {
    start();
    const bare = Object.create(null);
    expect(() => console.warn("user", 42, new Error("boom"), bare)).not.toThrow();
    const [crumb] = (await trail()).filter((c) => c.category === "console");
    expect(crumb.message).toBe("user 42 Error: boom [unprintable]");
  });

  it("cuts a 1,000-character message to 200", async () => {
    start();
    console.warn("x".repeat(1000));
    const [crumb] = (await trail()).filter((c) => c.category === "console");
    expect(crumb.message).toBe("x".repeat(200));
  });

  it("masks a secret in the message", async () => {
    start();
    console.warn("login failed token=abcdefghijkl for the user");
    const [crumb] = (await trail()).filter((c) => c.category === "console");
    expect(crumb.message).not.toContain("abcdefghijkl");
    expect(crumb.message).toContain("[secret]");
  });

  // Sending scrubs a breadcrumb again, but only what is left of it: a cut at 200 characters can split a value so that no
  // pattern matches the rest (a bearer token needs 6 characters, a prefixed key 8), so the message is scrubbed before the cut.
  it.each([
    ["a bearer token", "Bearer qzxvbnmasdfg", ["qzx"]],
    ["a prefixed key", "sk_live_abcdefghijkl", ["sk_live", "abcd"]],
  ])("masks %s that straddles the cut at 200 characters", async (_name, value, parts) => {
    start();
    // 190 characters of plain words, so the value starts at 190 and only its first 10 characters survive a cut.
    console.warn("w ".repeat(95) + value);
    const [crumb] = (await trail()).filter((c) => c.category === "console");
    expect(crumb.message.length).toBeLessThanOrEqual(200);
    for (const part of parts) expect(crumb.message).not.toContain(part);
  });

  it("three identical warnings in a row are one breadcrumb with a count of 3, and the trail keeps the rest", async () => {
    start();
    document.body.click();
    console.warn("retrying");
    console.warn("retrying");
    console.warn("retrying");
    const crumbs = await trail();
    const warnings = crumbs.filter((c) => c.category === "console");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].data).toEqual({ count: 3 });
    expect(categories(crumbs)).toContain("ui.click");
  });

  it("a different message, level or an other crumb between two warnings starts a new breadcrumb", async () => {
    start();
    console.warn("retrying");
    console.error("retrying");
    console.warn("retrying");
    document.body.click();
    console.warn("retrying");
    const warnings = (await trail()).filter((c) => c.category === "console");
    expect(warnings.map((c) => [c.level, c.data])).toEqual([
      ["warning", undefined],
      ["error", undefined],
      ["warning", undefined],
      ["warning", undefined],
    ]);
  });

  it("a flood of one warning cannot push the trail out", async () => {
    start();
    document.body.click();
    for (let i = 0; i < 500; i++) console.warn("tick");
    const crumbs = await trail();
    expect(categories(crumbs)).toContain("ui.click");
    expect(crumbs.find((c) => c.category === "console")?.data).toEqual({ count: 500 });
  });

  it("makes no loop when a console call is made while a breadcrumb is added, and none with debug on", async () => {
    start({ trackConsole: ["error", "warn", "info", "log", "debug"] });
    const add = vi.spyOn(getClient()!, "addRepeatedBreadcrumb").mockImplementation(() => {
      console.warn("from inside");
      console.log("from inside");
    });
    console.warn("outer");
    expect(add).toHaveBeenCalledTimes(1);
    add.mockRestore();
    stop?.();
    close();
    bodies = [];

    debug = true;
    start({ trackConsole: ["error", "warn", "info", "log", "debug"] });
    console.log("the app says hi");
    const messages = (await trail()).filter((c) => c.category === "console").map((c) => c.message);
    expect(messages).toEqual(["the app says hi"]);
  });

  it("never records the SDK's own debug lines, and records the app's in the same run", async () => {
    debug = true;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    start({ trackConsole: ["log", "warn"] });
    console.log("the app says hi");
    // A refused batch makes the client log (`[Overseer] Server rejected ...`) after the patch is on.
    ingestStatus = 400;
    captureException(new Error("first"));
    await flush();
    ingestStatus = 200;
    const own = log.mock.calls.filter((c) => String(c[0]).startsWith("[Overseer]") && String(c[1]).startsWith("Server rejected"));
    expect(own.length).toBeGreaterThan(0);
    const messages = (await trail()).filter((c) => c.category === "console").map((c) => c.message);
    expect(messages).toEqual(["the app says hi"]);
  });

  it("works with a console patch put on before ours, and one put on after", async () => {
    const seen: string[] = [];
    const first = console.warn;
    console.warn = (...args: unknown[]) => {
      seen.push(`first ${args[0]}`);
      first.apply(console, args);
    };
    start();
    const second = console.warn;
    console.warn = (...args: unknown[]) => {
      seen.push(`second ${args[0]}`);
      second.apply(console, args);
    };
    console.warn("both");
    expect(seen).toEqual(["second both", "first both"]);
    expect((await trail()).filter((c) => c.category === "console").map((c) => c.message)).toEqual(["both"]);
  });
});

describe("stop", () => {
  it("puts console and history back and removes the listeners", async () => {
    const before = { warn: console.warn, error: console.error, push: history.pushState, replace: history.replaceState, fetch: globalThis.fetch };
    start({ trackInputs: true, trackConsole: ["error", "warn", "info", "log", "debug"] });
    expect(console.warn).not.toBe(before.warn);
    expect(history.pushState).not.toBe(before.push);
    stop?.();
    stop = undefined;
    expect(console.warn).toBe(before.warn);
    expect(console.error).toBe(before.error);
    expect(history.pushState).toBe(before.push);
    expect(history.replaceState).toBe(before.replace);
    expect(globalThis.fetch).toBe(before.fetch);

    document.body.innerHTML = "<input>";
    document.body.click();
    document.querySelector("input")!.dispatchEvent(new Event("input", { bubbles: true }));
    console.warn("after");
    history.pushState({}, "", "/after");
    const after = (await trail()).filter((c) => c.message.includes("after") || c.category.startsWith("ui."));
    expect(after).toEqual([]);
  });
});
