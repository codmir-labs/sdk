// @vitest-environment jsdom
/** CSL-5640: the remix navigation breadcrumbs (page load, pushState, replaceState, popstate) keep origin and path only. */
import { beforeAll, describe, expect, it } from "vitest";
import * as nav from "../../remix/index";
import { captureException, type OverseerEvent } from "../index";

const events: OverseerEvent[] = [];
const Q = "?access_token=QSECRET&x=1";
const F = "#access_token=FSECRET";

beforeAll(() => {
  Object.defineProperty(document, "referrer", { value: `https://auth.example.com/login${Q}${F}`, configurable: true });
  window.history.replaceState(null, "", `/start${Q}${F}`);
  nav.init({ clientKey: "k", dsn: "http://127.0.0.1:9/never", includeSourceContext: false, beforeSend: (e) => (events.push(e), null) });
  nav.setupBrowserTracking();
});

function crumbs(): Array<{ message?: string; data?: Record<string, unknown> }> {
  captureException(new Error("x"));
  const json = JSON.stringify(events.at(-1));
  expect(json).not.toContain("SECRET");
  expect(json).not.toContain("access_token");
  return events.at(-1)!.breadcrumbs as any;
}

describe("remix navigation breadcrumbs", () => {
  it("the page load names the path and its from/to are origin and path only", () => {
    const first = crumbs().find((b) => b.message === "/start")!;
    expect(first.data).toEqual({ from: "https://auth.example.com/login", to: `${window.location.origin}/start` });
  });

  it("pushState and replaceState keep the target's path, resolved against the page, without query or fragment", () => {
    window.history.pushState(null, "", `/next/page${Q}${F}`);
    window.history.replaceState(null, "", `?only=${"QSECRET"}`);
    window.history.pushState(null, "", `https://app.example.com/abs${Q}${F}`.replace("https://app.example.com", window.location.origin));
    const list = crumbs();
    expect(list.find((b) => b.message === "pushState")!.data).toEqual({ to: `${window.location.origin}/next/page` });
    expect(list.filter((b) => b.message === "replaceState").at(-1)!.data!.to).toMatch(/^http:\/\/localhost(:\d+)?\/next\/page$/);
    expect(list.filter((b) => b.message === "pushState").at(-1)!.data!.to).toMatch(/\/abs$/);
  });

  it("popstate is scrubbed", () => {
    window.history.replaceState(null, "", `/back${Q}${F}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
    const pop = crumbs().filter((b) => b.message === "popstate").at(-1)!;
    expect(pop.data).toEqual({ to: `${window.location.origin}/back` });
  });
});
