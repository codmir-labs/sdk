// @vitest-environment jsdom
/**
 * Errors an error boundary caught reach Codmir. Next (16, production build) hands them to `console.error` only, so
 * `app/error.tsx` and `pages/_error.js` call `captureBoundaryError` and `captureUnderscoreErrorException`. The render
 * goes through Next's own React root callbacks, the way a page renders.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { captureBoundaryError, captureUnderscoreErrorException, close, flush, init } from "../index";

const DSN = "https://ingest.example.test/api/v1/overseer";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
// jsdom has no reportError; a browser's reports the exception as an `error` event on the window.
(globalThis as any).reportError = (e: any) => window.dispatchEvent(new ErrorEvent("error", { error: e, message: String(e?.message) }));

const SERVERLESS_ENV = ["VERCEL", "AWS_LAMBDA_FUNCTION_NAME", "NETLIFY", "K_SERVICE"];
let bodies: any[];
let hold: boolean;
let release: Array<() => void>;
const events = () => bodies.flatMap((b) => (b.events ?? []).filter((w: any) => w.type === "error").map((w: any) => w.event));

beforeEach(() => {
  bodies = [];
  release = [];
  hold = false;
  for (const name of SERVERLESS_ENV) vi.stubEnv(name, "");
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, req?: RequestInit) => {
      bodies.push(JSON.parse(String(req?.body ?? "{}")));
      if (!hold) return Promise.resolve(new Response('{"received":true}', { status: 200 }));
      return new Promise<Response>((resolve) => release.push(() => resolve(new Response('{"received":true}', { status: 200 }))));
    }),
  );
  init({ dsn: DSN, clientKey: "osk_test" });
});
afterEach(() => {
  close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

class Boundary extends React.Component<{ children: React.ReactNode; onCatch?: (e: Error) => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(e: Error) {
    this.props.onCatch?.(e);
  }
  render() {
    return this.state.failed ? React.createElement("p", null, "Something went wrong") : this.props.children;
  }
}

/** Renders a throwing component under a boundary through Next's own callbacks; `onCatch` is app/error.tsx's effect. */
async function renderCaught(thrown: Error, onCatch?: (e: Error) => void): Promise<void> {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const mod: any = await import("next/dist/client/react-client-callbacks/error-boundary-callbacks.js");
  const callbacks = { onCaughtError: mod.onCaughtError ?? mod.default?.onCaughtError, onUncaughtError: mod.onUncaughtError ?? mod.default?.onUncaughtError };
  const Throws = (): React.ReactElement => {
    throw thrown;
  };
  const el = document.createElement("div");
  document.body.appendChild(el);
  createRoot(el, callbacks).render(React.createElement(Boundary, { onCatch }, React.createElement(Throws)));
  await new Promise((r) => setTimeout(r, 50));
  process.env.NODE_ENV = prev;
}

function digestError(): Error & { digest: string } {
  return Object.assign(new TypeError("cart.items is undefined"), { digest: "1234567" });
}

describe("captureBoundaryError", () => {
  it("red control: a boundary-caught error with no captureBoundaryError call reaches nothing", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    await renderCaught(digestError());
    await flush();
    expect(quiet).toHaveBeenCalled();
    expect(events()).toHaveLength(0);
  });

  it("an error.tsx path sends one event with the digest tag and its own mechanism", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await renderCaught(digestError(), (e) => captureBoundaryError(e));
    await flush();
    expect(events()).toHaveLength(1);
    const [event] = events();
    expect(event.tags.digest).toBe("1234567");
    expect(event.exception.mechanism).toEqual({ type: "nextjs-error-boundary", handled: false });
    expect(event.exception.type).toBe("TypeError");
  });

  it("an error without a digest has no digest tag", async () => {
    captureBoundaryError(new Error("plain"));
    await flush();
    expect(events()).toHaveLength(1);
    expect(events()[0].tags.digest).toBeUndefined();
  });

  it("the same Error captured twice is one event", async () => {
    const error = digestError();
    captureBoundaryError(error);
    captureBoundaryError(error);
    await flush();
    expect(events()).toHaveLength(1);
  });

  it("an error the window handler saw first is not sent again, and the other way round", async () => {
    const first = digestError();
    window.dispatchEvent(new ErrorEvent("error", { error: first, message: first.message }));
    captureBoundaryError(first);
    const second = digestError();
    captureBoundaryError(second);
    window.dispatchEvent(new ErrorEvent("error", { error: second, message: second.message }));
    await flush();
    expect(events()).toHaveLength(2);
  });
});

describe("captureUnderscoreErrorException", () => {
  const req = { url: "/orders/42?token=secret", method: "post", headers: { cookie: "sid=1" } };

  it("an err is one event with the request path, no query, no headers", async () => {
    await captureUnderscoreErrorException({ err: new Error("render failed"), req });
    await flush();
    expect(events()).toHaveLength(1);
    const [event] = events();
    expect(event.request.url).toBe("/orders/42");
    expect(event.request.method).toBe("POST");
    expect(event.exception.mechanism).toEqual({ type: "nextjs-error-page", handled: false });
    expect(JSON.stringify(event)).not.toMatch(/token=secret|sid=1/);
  });

  it("a 404 with no err sends nothing", async () => {
    await captureUnderscoreErrorException({ err: undefined, req, statusCode: 404 });
    await flush();
    expect(events()).toHaveLength(0);
    expect(bodies).toHaveLength(0);
  });

  it("on a serverless runtime it resolves only after the send", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.useFakeTimers();
    hold = true;
    let done = false;
    void captureUnderscoreErrorException({ err: new Error("boom"), req }).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(1);
    expect(bodies).toHaveLength(1);
    expect(done).toBe(false);
    release.forEach((r) => r());
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    vi.useRealTimers();
  });
});
