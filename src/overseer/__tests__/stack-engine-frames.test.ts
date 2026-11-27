/** A frame whose location is not `file:line` (`index N`, `native`, `<anonymous>`, wasm) is never app code. */
import { describe, expect, it } from "vitest";
import { sdkFingerprint } from "../transport";
import { parseStackTrace } from "../stack";

const MSG = "connection refused by 10.0.0.5:5432";
const stack = (route: string, line: string) =>
  `Error: ${MSG}\n    at Object.query (/srv/app/node_modules/fakedb/index.js:4:9)\n    at async Promise.all (index 0)\n    at async ${route} (/srv/app/src/${line})`;

const fingerprintOf = (s: string) => sdkFingerprint({ id: "1", type: "error", timestamp: "", level: "error", exception: { type: "Error", value: MSG, stacktrace: parseStackTrace(s) } });

describe("a frame with no file and line is not an app frame", () => {
  it("Promise.all (index N) keeps its function, has no filename and is not in-app", () => {
    const f = parseStackTrace(stack("ordersRoute", "gen-all.cjs:3:47"));
    expect(f[1]).toEqual({ function: "Promise.all", in_app: false });
    expect(f[2]).toMatchObject({ function: "ordersRoute", filename: "/srv/app/src/gen-all.cjs", lineno: 3, in_app: true });
  });

  it("native, <anonymous>, [native code] and wasm locations are not in-app and name no file", () => {
    const f = parseStackTrace(
      "Error: x\n    at JSON.parse (<anonymous>)\n    at Object.fn (native)\n    at wasm (wasm://wasm/0a1b2c3d:wasm-function[3]:0x1f)\n    at async Promise.all (index 1)",
    );
    expect(f).toHaveLength(4);
    for (const frame of f) expect(frame).toMatchObject({ in_app: false });
    for (const frame of f) expect(frame.filename).toBeUndefined();
    expect(parseStackTrace("map@[native code]")[0]).toEqual({ function: "map", in_app: false });
  });

  it("two routes awaiting Promise.all are two groups, each on its own app file and line", () => {
    const orders = fingerprintOf(stack("ordersRoute", "gen-all.cjs:3:47"));
    const profile = fingerprintOf(stack("profileRoute", "gen-all.cjs:4:55"));
    expect(orders).not.toEqual(profile);
    expect(orders[1]).toBe("/srv/app/src/gen-all.cjs:ordersRoute");
    expect(profile[1]).toBe("/srv/app/src/gen-all.cjs:profileRoute");
  });

  it("index 0 and index 1 are one group, and equal to a plain await of the same call", () => {
    const zero = fingerprintOf(stack("ordersRoute", "gen-all.cjs:3:47"));
    const one = fingerprintOf(stack("ordersRoute", "gen-all.cjs:3:47").replace("(index 0)", "(index 1)"));
    const plain = fingerprintOf(`Error: ${MSG}\n    at Object.query (/srv/app/node_modules/fakedb/index.js:4:9)\n    at async ordersRoute (/srv/app/src/gen-all.cjs:3:47)`);
    expect(one).toEqual(zero);
    expect(plain).toEqual(zero);
  });
});
