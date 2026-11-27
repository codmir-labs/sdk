/** Cause frames use the same app origins as the top exception, and the culprit is the frame the fingerprint uses. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { OverseerClient, type OverseerEvent } from "../index";
import { parseStackTrace } from "../stack";
import { toWireEvent } from "../transport";

const PAGE = "https://shop.example.com";
const CDN = "https://cdn.vendor.example.net";
afterEach(() => vi.unstubAllGlobals());

type Group = { fingerprint: string[]; culprit?: string };
type Wire = { group: Group; event: { exception: { stacktrace?: Array<{ in_app?: boolean }>; causes?: Array<{ stacktrace?: Array<{ filename?: string; in_app?: boolean }> }> } } };

/** Captures `thrown` on a page, with `init()` called from `initFrom`, and returns what would be sent. */
function capture(thrown: unknown, config: Record<string, unknown>, initFrom?: string): Wire {
  vi.stubGlobal("location", { origin: PAGE, protocol: "https:", href: `${PAGE}/cart` });
  let seen: OverseerEvent | undefined;
  const c = new OverseerClient({ clientKey: "k", includeSourceContext: false, beforeSend: (e) => ((seen = e), null), ...config });
  const prev = Error.prepareStackTrace;
  if (initFrom) Error.prepareStackTrace = () => `Error\n    at init (${initFrom})`;
  try {
    c.init();
  } finally {
    Error.prepareStackTrace = prev;
  }
  c.captureException(thrown);
  c.close();
  return toWireEvent(seen!) as Wire;
}

/** A real `Promise.any` failure whose inner errors have the given stacks; the aggregate itself has no frames. */
async function anyFailure(...stacks: string[]): Promise<AggregateError> {
  const inner = stacks.map((stack) => Object.assign(new TypeError("Failed to fetch"), { stack }));
  try {
    await Promise.any(inner.map((e) => Promise.reject(e)));
  } catch (e) {
    return Object.assign(e as AggregateError, { stack: "AggregateError: All promises were rejected" });
  }
  throw new Error("Promise.any did not reject");
}
const at = (loc: string) => `TypeError: Failed to fetch\n    at load (${loc})`;

describe("cause frames use the app origins", () => {
  it("an aggregate whose inner frames are on the init caller's CDN origin has in-app causes, a fingerprint and a culprit from them", async () => {
    const wire = capture(await anyFailure(at(`${CDN}/app/main.js:10:5`), at(`${CDN}/app/main.js:20:5`)), {}, `${CDN}/app/boot.js:1:1`);
    expect(wire.event.exception.causes!.map((c) => c.stacktrace![0]!.in_app)).toEqual([true, true]);
    expect(wire.group.fingerprint[1]).toBe(`${CDN}/app/main.js:10`);
    expect(wire.group.culprit).toBe(`${CDN}/app/main.js:10`);
  });

  it("the same with the origin in inAppOrigins", async () => {
    const wire = capture(await anyFailure(at(`${CDN}/app/main.js:10:5`)), { inAppOrigins: [CDN] });
    expect(wire.event.exception.causes![0]!.stacktrace![0]!.in_app).toBe(true);
    expect(wire.group.culprit).toBe(`${CDN}/app/main.js:10`);
  });

  it("an origin that is neither stays third-party in causes", async () => {
    const wire = capture(await anyFailure(at(`${CDN}/app/main.js:10:5`)), {});
    expect(wire.event.exception.causes![0]!.stacktrace![0]!.in_app).toBe(false);
  });
});

describe("the culprit", () => {
  const groupOf = (type: string, stack: string, causes?: unknown[]): Group =>
    (toWireEvent({ id: "e", type: "error", timestamp: "t", level: "error", message: "x", exception: { type, value: "x", stacktrace: parseStackTrace(stack), ...(causes ? { causes } : {}) } }) as { group: Group }).group;

  it("an app frame below a node_modules or engine frame wins (the review's F5)", () => {
    const json = "SyntaxError: Unexpected token 'h', \"hello world\" is not valid JSON\n    at JSON.parse (<anonymous>)\n    at parseBody (/srv/app/src/gen.cjs:17:36)";
    const url = "TypeError: Invalid URL\n    at new URL (node:internal/url:818:25)\n    at parseUrl (/srv/app/src/gen.cjs:16:30)";
    const lib = "Error: x\n    at q (/srv/app/node_modules/db/index.js:4:9)\n    at route (/srv/app/src/route.js:8:3)";
    expect(groupOf("SyntaxError", json).culprit).toBe("/srv/app/src/gen.cjs:17");
    expect(groupOf("TypeError", url).culprit).toBe("/srv/app/src/gen.cjs:16");
    expect(groupOf("Error", lib).culprit).toBe("/srv/app/src/route.js:8");
  });

  it("with no app frame anywhere, the top frame is used", () => {
    expect(groupOf("Error", "Error: x\n    at q (/srv/app/node_modules/db/index.js:4:9)\n    at r (/srv/app/node_modules/web/a.js:1:1)").culprit).toBe("/srv/app/node_modules/db/index.js:4");
  });

  it("a frameless top takes the first cause's frame, the app one first", () => {
    const causes = [
      { type: "Error", value: "a", source: "errors[0]", parent: -1, stacktrace: parseStackTrace("Error: a\n    at q (/srv/app/node_modules/db/index.js:4:9)") },
      { type: "Error", value: "b", source: "errors[1]", parent: -1, stacktrace: parseStackTrace("Error: b\n    at r (/srv/app/src/b.js:7:2)") },
    ];
    expect(groupOf("AggregateError", "AggregateError: none", causes).culprit).toBe("/srv/app/src/b.js:7");
    expect(groupOf("AggregateError", "AggregateError: none", causes.slice(0, 1)).culprit).toBe("/srv/app/node_modules/db/index.js:4");
  });

  it("a frame with no line prints the file, never file:undefined", () => {
    const wire = toWireEvent({ id: "e", type: "error", timestamp: "t", level: "error", message: "x", exception: { type: "Error", value: "x", stacktrace: [{ filename: "/srv/app/src/a.js", in_app: true }] } }) as { group: Group };
    expect(wire.group.culprit).toBe("/srv/app/src/a.js");
  });
});
