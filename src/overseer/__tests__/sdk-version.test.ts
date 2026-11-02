/** CSL-5589: events report the package's real version, not a hardcoded one. */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverseerClient, close, flush, init } from "../index";
import { startTransaction } from "../../tracing/index";
import { SDK_VERSION } from "../../version";

const { version } = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
  version: string;
};

let bodies: any[];

beforeEach(() => {
  bodies = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ received: true }), { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function client(): OverseerClient {
  const c = new OverseerClient({ clientKey: "osk_test", environment: "production", tracesSampleRate: 1 });
  c.init();
  return c;
}

describe("sdk.version", () => {
  it("is injected from package.json", () => {
    expect(SDK_VERSION).toBe(version);
  });

  it("is package.json's version on an error event", async () => {
    const c = client();
    c.captureException(new Error("boom"));
    await c.flush();
    expect(bodies[0].events[0].event.sdk).toEqual({ name: "@codmir/sdk", version });
  });

  it("is package.json's version on a message event", async () => {
    const c = client();
    c.captureMessage("hello");
    await c.flush();
    expect(bodies[0].events[0].sdk).toEqual({ name: "@codmir/sdk", version });
  });

  it("is package.json's version on a transaction", async () => {
    init({ clientKey: "osk_test", environment: "production", tracesSampleRate: 1 });
    startTransaction({ op: "task", name: "job" }).end();
    await flush();
    close();
    const event = bodies.flatMap((b) => b.events).find((e) => e.type === "transaction");
    expect(event.sdk).toEqual({ name: "@codmir/sdk", version });
  });
});
