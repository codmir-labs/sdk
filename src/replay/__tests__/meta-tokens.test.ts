// @vitest-environment jsdom
/**
 * A `<meta>` that carries a token is never recorded with its value: not in a full snapshot, not when added later, not
 * when its content changes later. Every other meta is recorded as it is.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DSN = "https://ingest.example.test/api/overseer";
const REPLAY_URL = `${DSN}/replay`;

type Call = { url: string; init: RequestInit; body: any; raw: string };
let calls: Call[];
let respond: (call: Call) => Response | Promise<Response>;

const replayCalls = () => calls.filter((c) => c.url === REPLAY_URL);
const allReplayText = () => replayCalls().map((c) => c.raw).join("\n");

beforeEach(() => {
  calls = [];
  respond = () => new Response(JSON.stringify({ stored: true }), { status: 202 });
  vi.resetModules();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const raw = String(init.body);
      let body: any;
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
      const call = { url, init, raw, body };
      calls.push(call);
      return respond(call);
    }),
  );
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

afterEach(async () => {
  const replay = await import("../index");
  replay.stopReplay();
  const overseer = await import("../../overseer/index");
  overseer.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function load(config: Record<string, unknown> = {}) {
  const overseer = await import("../../overseer/index");
  const replay = await import("../index");
  overseer.init({ dsn: DSN, clientKey: "osk_test", environment: "production", release: "1.2.3", ...config });
  return { overseer, replay };
}

const useFakeClock = () =>
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });

const settle = async () => {
  await vi.dynamicImportSettled();
  await vi.advanceTimersByTimeAsync(0);
};

function click() {
  document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

async function record(setup: () => void, act: () => void | Promise<void> = () => {}) {
  useFakeClock();
  setup();
  const { replay } = await load({ replaysSessionSampleRate: 1 });
  replay.startReplay();
  await settle();
  await act();
  await vi.advanceTimersByTimeAsync(0);
  click();
  await vi.advanceTimersByTimeAsync(30_000);
  return allReplayText();
}

const addMeta = (name: string, content: string) => {
  const meta = document.createElement("meta");
  meta.setAttribute("name", name);
  meta.setAttribute("content", content);
  document.head.appendChild(meta);
  return meta;
};

describe("meta tags that carry a token", () => {
  it("records none of a CSRF meta, a checkout token meta or a hidden input", async () => {
    const text = await record(() => {
      document.head.innerHTML = `<meta name="csrf-token" content="CSRF-SECRET-v123"><meta name="shopify-checkout-api-token" content="SHOP-TOKEN-v456">`;
      document.body.innerHTML = `<form><input type="hidden" name="authenticity_token" value="HIDDEN-CSRF-v789"></form>`;
    });
    expect(text).not.toContain("CSRF-SECRET-v123");
    expect(text).not.toContain("SHOP-TOKEN-v456");
    expect(text).not.toContain("HIDDEN-CSRF-v789");
  });

  it("blanks the Spring Security metas rrweb does not know", async () => {
    const text = await record(() => {
      document.head.innerHTML = `<meta name="_csrf" content="SPRING-SECRET"><meta name="_csrf_header" content="X-CSRF-TOKEN">`;
    });
    expect(text).not.toContain("SPRING-SECRET");
    expect(text).not.toContain("X-CSRF-TOKEN");
    expect(text).toContain("_csrf_header");
  });

  it("blanks a meta whose property or http-equiv names a token, and a nonce or a key", async () => {
    const text = await record(() => {
      document.head.innerHTML = `<meta name="csp-nonce" content="NONCE-v111"><meta name="google-maps-api-key" content="KEY-v222"><meta property="x-secret" content="SECRET-v333"><meta http-equiv="x-csrf-token" content="EQUIV-v444">`;
    });
    for (const value of ["NONCE-v111", "KEY-v222", "SECRET-v333", "EQUIV-v444"]) expect(text).not.toContain(value);
  });

  it("blanks a meta added after the first snapshot", async () => {
    const text = await record(
      () => {
        document.body.innerHTML = "<p>page</p>";
      },
      async () => {
        addMeta("csrf-token", "LATE-CSRF-v555");
        addMeta("_csrf", "LATE-SPRING-v666");
        await vi.advanceTimersByTimeAsync(0);
      },
    );
    expect(text).not.toContain("LATE-CSRF-v555");
    expect(text).not.toContain("LATE-SPRING-v666");
    expect(text).toContain("_csrf");
  });

  it("blanks a changed value, and a name that turns a meta into a token meta", async () => {
    let plain: HTMLMetaElement;
    const text = await record(
      () => {
        document.head.innerHTML = `<meta name="csrf-token" content="OLD-CSRF-v777"><meta name="_csrf" content="OLD-SPRING-v888">`;
        plain = addMeta("generator", "OLD-PLAIN-v999");
      },
      async () => {
        document.head.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')!.setAttribute("content", "NEW-CSRF-v777");
        document.head.querySelector<HTMLMetaElement>('meta[name="_csrf"]')!.setAttribute("content", "NEW-SPRING-v888");
        await vi.advanceTimersByTimeAsync(0);
        plain.setAttribute("name", "page-secret");
        await vi.advanceTimersByTimeAsync(0);
        plain.setAttribute("content", "NEWER-PLAIN-v000");
        await vi.advanceTimersByTimeAsync(0);
      },
    );
    for (const value of ["OLD-CSRF-v777", "NEW-CSRF-v777", "OLD-SPRING-v888", "NEW-SPRING-v888", "NEWER-PLAIN-v000"]) {
      expect(text).not.toContain(value);
    }
  });

  it("records every other meta as it is", async () => {
    const text = await record(() => {
      document.head.innerHTML = `<meta name="description" content="Pricing page"><meta name="keywords" content="plans, billing"><meta name="viewport" content="width=device-width, initial-scale=1">`;
    });
    expect(text).toContain("Pricing page");
    expect(text).toContain("plans, billing");
    expect(text).toContain("width=device-width, initial-scale=1");
  });
});
