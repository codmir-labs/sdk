// @vitest-environment jsdom
/**
 * A hash router moves the page by `location.hash` or `history.pushState` with a hash URL. Each move is a navigation
 * breadcrumb with its route; a fragment that is no route (`#access_token=…`) never reaches a breadcrumb.
 * `captureRouterTransitionStart` scrubs the href Next.js hands it.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import * as nav from "../../nextjs/index";
import { captureException, type OverseerEvent } from "../index";

const events: OverseerEvent[] = [];

beforeAll(() => {
  window.history.replaceState(null, "", "/app");
  nav.init({ clientKey: "k", dsn: "http://127.0.0.1:9/never", includeSourceContext: false, beforeSend: (e) => (events.push(e), null) });
});
afterEach(() => window.history.replaceState(null, "", "/app"));

const body = (): string => {
  captureException(new Error("x"));
  return JSON.stringify(events.at(-1));
};
const crumbs = (): Array<{ message?: string; data?: Record<string, unknown> }> => (body(), events.at(-1)!.breadcrumbs as any);
const tick = () => new Promise((r) => setTimeout(r, 10));

describe("hash router navigation", () => {
  it("three hash navigations give three breadcrumbs with their routes", async () => {
    const before = crumbs().length;
    window.history.pushState(null, "", "/app#/settings");
    window.history.pushState(null, "", "/app#!/users/42?tab=keys");
    window.location.hash = "#/billing";
    await tick();
    const list = crumbs().slice(before);
    expect(list.map((b) => b.message)).toEqual(["pushState /app#/settings", "pushState /app#!/users/42", expect.stringMatching(/^popstate \/app#\/billing$/)]);
    expect(list.map((b) => b.data!.to)).toEqual([
      `${window.location.origin}/app#/settings`,
      `${window.location.origin}/app#!/users/42`,
      `${window.location.origin}/app#/billing`,
    ]);
  });

  it("an OAuth fragment reaches no breadcrumb, nor the request url", async () => {
    window.history.pushState(null, "", "/app#access_token=hashsecret&token_type=bearer");
    window.location.hash = "#id_token=hashsecret";
    await tick();
    const json = body();
    expect(json).not.toContain("hashsecret");
    expect(json).not.toContain("access_token");
    expect(json).not.toContain("id_token");
  });

  it("the error's request.url carries the route fragment", () => {
    window.history.pushState(null, "", "/app#/settings?tab=keys");
    body();
    expect((events.at(-1) as any).request.url).toBe(`${window.location.origin}/app#/settings`);
  });
});

describe("captureRouterTransitionStart", () => {
  const route = "/reset?token=querysecret#access_token=hashsecret";

  it("drops the query and a token fragment from a path, and keeps it a path", () => {
    nav.captureRouterTransitionStart(route);
    const json = body();
    const crumb = events.at(-1)!.breadcrumbs!.find((b: any) => b.message?.startsWith("Navigating"))! as any;
    expect(crumb.message).toBe("Navigating to /reset");
    expect(crumb.data).toEqual({ route: "/reset" });
    expect(json).not.toContain("querysecret");
    expect(json).not.toContain("hashsecret");
    expect(json).not.toContain("access_token");
  });

  it("keeps an absolute URL absolute", () => {
    nav.captureRouterTransitionStart("https://app.test/reset?token=querysecret#access_token=hashsecret");
    expect(crumbs().filter((b) => b.message?.startsWith("Navigating")).at(-1)!.message).toBe("Navigating to https://app.test/reset");
    expect(body()).not.toContain("secret");
  });

  it("keeps a route fragment, without its query", () => {
    nav.captureRouterTransitionStart("/#/settings");
    nav.captureRouterTransitionStart("/app#!/users/42?tab=keys");
    const list = crumbs().filter((b) => b.message?.startsWith("Navigating")).slice(-2);
    expect(list.map((b) => b.message)).toEqual(["Navigating to /#/settings", "Navigating to /app#!/users/42"]);
    expect(list.map((b) => b.data!.route)).toEqual(["/#/settings", "/app#!/users/42"]);
  });
});

// Last: its `#/access_token` breadcrumb stays in the list the tests above read.
describe("a rewritten OAuth redirect", () => {
  it("a hash router's rewritten OAuth redirect reaches no breadcrumb, request.url or transaction", async () => {
    window.history.pushState(null, "", "/app#/access_token=abcsecretvalue&token_type=bearer");
    window.location.hash = "#/access_token=abcsecretvalue&token_type=bearer";
    await tick();
    const json = body();
    expect(json).not.toContain("abcsecretvalue");
    expect(json).not.toContain("token_type");
    expect((events.at(-1) as any).request.url).toBe(`${window.location.origin}/app#/access_token`);
  });
});
