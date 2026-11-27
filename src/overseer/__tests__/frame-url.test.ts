// @vitest-environment jsdom
/** A stack frame names a script by origin and path: its query and fragment (a token, a `?v=` cache-buster) never stay. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Browser from "../../browser/index";
import { parseStackTrace } from "../stack";

const INGEST = "https://ingest.example.test/api/overseer";
const PAGE = "https://app.example.com/reset";

type Wire = {
  exception?: { stacktrace?: Array<{ filename?: string; lineno?: number }> };
  group?: { culprit?: string; fingerprint?: string[] };
  extra?: Record<string, unknown>;
};

let raw: string[] = [];

beforeEach(() => {
  raw = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      raw.push(String(init.body));
      return new Response("{}", { status: 200 });
    }),
  );
  Browser.init({ dsn: INGEST, clientKey: "osk_test", trackRequests: false, captureGlobalErrors: true });
});

afterEach(() => {
  Browser.close();
  vi.unstubAllGlobals();
});

async function sent(): Promise<Wire[]> {
  await Browser.flush();
  const entries = raw.flatMap((b) => (JSON.parse(b) as { events: Array<{ type: string; event: Wire; group?: Wire["group"] }> }).events);
  return entries.filter((e) => e.type === "error").map((e) => ({ ...e.event, group: e.group }));
}

function errorWithStack(location: string): Error {
  const e = new Error("boom");
  e.stack = `Error: boom\n    at go (${location})`;
  return e;
}

describe("a URL frame filename loses its query and fragment", () => {
  it("(a) V8 stack", () => {
    const [f] = parseStackTrace(`Error: x\n    at go (${PAGE}?token=A#x:3:7)`);
    expect(f).toMatchObject({ filename: PAGE, lineno: 3, colno: 7, function: "go" });
  });

  it("(a) Firefox and Safari stack", () => {
    const [f] = parseStackTrace(`go@${PAGE}?token=A#x:3:7`);
    expect(f).toMatchObject({ filename: PAGE, lineno: 3, colno: 7, function: "go" });
  });

  it("(a) blob: and webpack-internal: are cut too, and a bare URL frame", () => {
    expect(parseStackTrace("Error\n    at blob:https://app.example.com/1f2e?k=1:4:5")[0]?.filename).toBe("blob:https://app.example.com/1f2e");
    expect(parseStackTrace("Error\n    at fn (webpack-internal:///./src/a.js?x=1:2:3)")[0]?.filename).toBe("webpack-internal:///./src/a.js");
    expect(parseStackTrace(`Error\n    at ${PAGE}?token=A:3:7`)[0]?.filename).toBe(PAGE);
  });

  it("(b) two tokens are one fingerprint and one culprit, and neither token is sent", async () => {
    Browser.captureException(errorWithStack(`${PAGE}?token=SECRET_A#frag_A:3:7`));
    Browser.captureException(errorWithStack(`${PAGE}?token=SECRET_B#frag_B:3:7`));
    const events = await sent();
    expect(events).toHaveLength(2);
    expect(events[0]!.group?.fingerprint).toEqual(events[1]!.group?.fingerprint);
    expect(events[0]!.group?.culprit).toBe(`${PAGE}:3`);
    expect(events[1]!.group?.culprit).toBe(`${PAGE}:3`);
    const body = raw.join("");
    for (const secret of ["SECRET_A", "SECRET_B", "frag_A", "frag_B"]) expect(body).not.toContain(secret);
  });

  it("(c) a cache-buster is one fingerprint", async () => {
    Browser.captureException(errorWithStack("https://cdn.example.com/app.js?v=1:10:2"));
    Browser.captureException(errorWithStack("https://cdn.example.com/app.js?v=2:10:2"));
    const [a, b] = await sent();
    expect(a!.group?.fingerprint).toEqual(b!.group?.fingerprint);
    expect(a!.group?.culprit).toBe("https://cdn.example.com/app.js:10");
  });

  it("(d) the browser error handler sends neither extra nor frames with the query", async () => {
    window.dispatchEvent(
      new ErrorEvent("error", { message: "inline failed", filename: `${PAGE}?token=SECRET_INLINE#frag`, lineno: 1, colno: 22 }),
    );
    const [e] = await sent();
    expect(e!.extra?.filename).toBe(PAGE);
    expect(e!.exception?.stacktrace?.[0]?.filename).toBe(PAGE);
    expect(raw.join("")).not.toContain("SECRET_INLINE");
    expect(raw.join("")).not.toContain("frag");
  });

  it("(e) plain paths and <anonymous> are unchanged", () => {
    const frames = parseStackTrace(
      [
        "Error: x",
        "    at a (/app/src/x.js?y#z:1:2)",
        "    at b (C:\\app\\x.js:3:4)",
        "    at c (node:internal/modules/cjs/loader:5:6)",
        "    at d (<anonymous>)",
        "    at e (/app/#build/x.js:7:8)",
      ].join("\n"),
    );
    expect(frames.map((f) => f.filename)).toEqual(["/app/src/x.js?y#z", "C:\\app\\x.js", "node:internal/modules/cjs/loader", "<anonymous>", "/app/#build/x.js"]);
  });
});
