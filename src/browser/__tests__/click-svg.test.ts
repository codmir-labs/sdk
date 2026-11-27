// @vitest-environment jsdom
/** A click on an SVG element is a breadcrumb: its `className` is an object, and reading it must not throw into the page. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Browser from "../index";

const INGEST = "https://ingest.example.test/api/overseer";

type Crumb = { category: string; message: string; data?: Record<string, unknown> };
type Sent = { message?: string; user?: Record<string, unknown>; breadcrumbs: Crumb[] };

let bodies: Array<{ events: Array<{ type: string; event: Sent }> }> = [];

beforeEach(() => {
  bodies = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response("{}", { status: 200 });
    }),
  );
});

afterEach(() => {
  Browser.close();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

async function sentErrors(): Promise<Sent[]> {
  await Browser.flush();
  return bodies.flatMap((b) => b.events).filter((e) => e.type === "error").map((e) => e.event);
}

describe("click breadcrumbs on SVG elements", () => {
  it("an svg and its path inside a button are breadcrumbs, and only the app's error is sent", async () => {
    Browser.init({ dsn: INGEST, clientKey: "osk_test", trackRequests: false });
    document.body.innerHTML = '<button id="save"><svg class="icon icon-save"><path d="M0 0h10v10z"></path></svg></button>';

    click(document.querySelector("svg")!);
    click(document.querySelector("path")!);
    Browser.captureException(new Error("the app's own error"));

    const errors = await sentErrors();
    expect(errors.map((e) => e.message)).toEqual(["the app's own error"]);
    const clicks = errors[0].breadcrumbs.filter((b) => b.category === "ui.click");
    expect(clicks.map((b) => b.message)).toEqual(["svg.icon", "path"]);
    expect(clicks[0].data?.class).toBe("icon icon-save");
    expect(clicks[1].data?.class).toBeUndefined();
  });

  it("an HTML button click keeps its breadcrumb", async () => {
    Browser.init({ dsn: INGEST, clientKey: "osk_test", trackRequests: false });
    document.body.innerHTML = '<button class="btn primary">Save it</button>';

    click(document.querySelector("button")!);
    Browser.captureException(new Error("x"));

    const [error] = await sentErrors();
    const [crumb] = error.breadcrumbs.filter((b) => b.category === "ui.click");
    expect(crumb.message).toBe('button.btn "Save it"');
    expect(crumb.data).toMatchObject({ tag: "button", class: "btn primary" });
  });

  it("a click whose target is not an element throws nothing", async () => {
    Browser.init({ dsn: INGEST, clientKey: "osk_test", trackRequests: false });
    const seen: unknown[] = [];
    const onError = (e: ErrorEvent): void => void seen.push(e.error);
    window.addEventListener("error", onError);
    document.dispatchEvent(new MouseEvent("click"));
    window.removeEventListener("error", onError);
    expect(seen).toEqual([]);
  });
});
