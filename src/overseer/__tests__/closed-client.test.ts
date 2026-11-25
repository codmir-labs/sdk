/**
 * Close() made one last send and, when that failed, scheduled retries, so a closed client kept posting
 * with backoff; and init() replaced the client without closing it, so the old one kept retrying too. On Node 18 the
 * node-smoke test's server.close() waited on that traffic and timed out. These tests pin the fix.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as overseer from "../index";
import { OverseerClient } from "../index";
import { RETRY_MAX_MS } from "../transport";

const A = "https://a.example/api/v1/overseer";
const B = "https://b.example/api/v1/overseer";
let calls: string[];

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      return new Response("down", { status: 500 });
    }),
  );
});

afterEach(() => {
  overseer.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function client(dsn = A): OverseerClient {
  const c = new OverseerClient({ dsn, clientKey: "osk_test" });
  c.init();
  return c;
}

const to = (base: string) => calls.filter((url) => url.startsWith(base));

describe("a closed client sends nothing more", () => {
  it("an open client retries a failed batch, so the cases below are not empty", async () => {
    const c = client();
    c.captureException(new Error("boom"));
    expect(await c.flush()).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(2);
    c.close();
  });

  it("close() makes one last attempt and never retries it", async () => {
    const c = client();
    c.captureException(new Error("boom"));
    expect(await c.flush()).toBe(false);
    expect(calls).toHaveLength(1);

    c.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS * 4);
    expect(calls).toHaveLength(2);
  });

  // Not dropped: the browser and Next.js entries never re-run init() after close(), so dropping here would silence them.
  it("sends an event captured after close() once and never retries it", async () => {
    const c = client();
    c.close();
    c.captureException(new Error("late"));
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS * 4);
    expect(calls).toHaveLength(1);
  });

  it("init() closes the client it replaces, so that one stops retrying", async () => {
    overseer.init({ dsn: A, clientKey: "osk_test" });
    overseer.captureException(new Error("boom"));
    expect(await overseer.flush()).toBe(false);

    overseer.init({ dsn: B, clientKey: "osk_test" });
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS * 4);
    // The failed send, then the replaced client's last attempt; nothing was captured on B.
    expect(to(A)).toHaveLength(2);
    expect(to(B)).toHaveLength(0);
  });
});
