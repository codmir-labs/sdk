// @vitest-environment jsdom
/** Only the SDK's own endpoints are skipped by `fetch` and XHR instrumentation; the rest of the DSN's origin is the app's. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { feedbackUrl, ingestUrl, patchesManifestUrl, replayUrl } from "../../endpoints";
import { captureException, close, init, type OverseerEvent } from "../../overseer/index";
import { instrumentFetch, instrumentXhr } from "../index";

let events: OverseerEvent[];
let teardown: Array<() => void>;
const realProto = { open: XMLHttpRequest.prototype.open, send: XMLHttpRequest.prototype.send };

const CASES = [
  { name: "a root DSN", dsn: "https://app.example.com", app: "https://app.example.com/api/cart" },
  { name: "a DSN with a path", dsn: "https://www.example.com/api/v1/overseer", app: "https://www.example.com/api/v1/overseer/issues?project=x" },
];

beforeEach(() => {
  events = [];
  teardown = [];
});
afterEach(() => {
  for (const fn of teardown.reverse()) fn();
  close();
  Object.assign(XMLHttpRequest.prototype, realProto);
  vi.unstubAllGlobals();
});

const start = (dsn: string) => init({ dsn, clientKey: "osk_test", includeSourceContext: false, beforeSend: (e) => (events.push(e), null) });
const requests = (category: string) => {
  captureException(new Error("x"));
  return (events.at(-1)!.breadcrumbs ?? []).filter((c) => c.category === category);
};
const own = (dsn: string) => [ingestUrl(dsn), replayUrl(dsn), feedbackUrl(dsn), feedbackUrl(dsn, "fb_1"), feedbackUrl(dsn, "fb_1", "/answer"), patchesManifestUrl(dsn)];

describe.each(CASES)("fetch with $name", ({ dsn, app }) => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    start(dsn);
    teardown.push(instrumentFetch({ breadcrumbs: true }));
  });

  it("records the app's request", async () => {
    await fetch(app);
    expect(requests("fetch")).toHaveLength(1);
  });

  it("records none of the SDK's own", async () => {
    for (const url of own(dsn)) await fetch(url, { method: "POST" });
    expect(requests("fetch")).toHaveLength(0);
  });
});

describe.each(CASES)("xhr with $name", ({ dsn, app }) => {
  const xhr = (url: string): Promise<void> =>
    new Promise((resolve) => {
      const x = new XMLHttpRequest();
      x.addEventListener("loadend", () => resolve());
      x.open("GET", url);
      x.send();
    });
  beforeEach(() => {
    const proto = XMLHttpRequest.prototype;
    proto.open = function () {} as typeof proto.open;
    proto.send = function (this: XMLHttpRequest) {
      Object.defineProperty(this, "status", { value: 200, configurable: true });
      queueMicrotask(() => {
        this.dispatchEvent(new Event("load"));
        this.dispatchEvent(new Event("loadend"));
      });
    };
    start(dsn);
    teardown.push(instrumentXhr({ breadcrumbs: true }));
  });

  it("records the app's request", async () => {
    await xhr(app);
    expect(requests("xhr")).toHaveLength(1);
  });

  it("records none of the SDK's own", async () => {
    for (const url of own(dsn)) await xhr(url);
    expect(requests("xhr")).toHaveLength(0);
  });
});
