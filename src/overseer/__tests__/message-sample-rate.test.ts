/** `messageSampleRate` replaces `sampleRate` for message events; errors keep `sampleRate`. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureException, captureMessage, close, flush, init, type OverseerConfig } from "../index";
import { verify } from "../../verify/index";

let bodies: string[];

beforeEach(() => {
  bodies = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response("{}", { status: 200 });
    }),
  );
});
afterEach(() => {
  close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function start(config: Partial<OverseerConfig>): void {
  init({ clientKey: "osk_test", dsn: "https://ingest.example.com/api/overseer", includeSourceContext: false, rateLimit: false, ...config });
}
async function sentTypes(): Promise<string[]> {
  await flush();
  return bodies.flatMap((b) => (JSON.parse(b).events ?? []) as Array<{ type: string }>).map((e) => e.type);
}

describe("messageSampleRate", () => {
  it("0 drops messages and keeps errors", async () => {
    start({ messageSampleRate: 0 });
    expect(captureMessage("noisy")).toBe("");
    expect(captureException(new Error("real"))).not.toBe("");
    expect(await sentTypes()).toEqual(["error"]);
  });

  it("1 keeps messages although sampleRate is 0, and errors still follow sampleRate", async () => {
    start({ sampleRate: 0, messageSampleRate: 1 });
    expect(captureMessage("kept")).not.toBe("");
    expect(captureException(new Error("dropped"))).toBe("");
    expect(await sentTypes()).toEqual(["message"]);
  });

  it("unset: messages follow sampleRate, as before", async () => {
    start({ sampleRate: 0 });
    expect(captureMessage("dropped")).toBe("");
    expect(captureException(new Error("dropped"))).toBe("");
    expect(await sentTypes()).toEqual([]);
    close();
    start({ sampleRate: 1 });
    captureMessage("kept");
    captureException(new Error("kept"));
    expect((await sentTypes()).sort()).toEqual(["error", "message"]);
  });

  it("the verify probe follows messageSampleRate too", async () => {
    const result = await verify({ clientKey: "osk_test", dsn: "https://ingest.example.com/api/overseer", sampleRate: 1, messageSampleRate: 0 });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain("messageSampleRate is 0");
  });
});

describe("messageSampleRate that is not a number", () => {
  it("NaN is ignored, so messages follow sampleRate", async () => {
    start({ sampleRate: 1, messageSampleRate: Number.NaN });
    expect(captureMessage("kept")).not.toBe("");
    expect(await sentTypes()).toEqual(["message"]);
  });
});
