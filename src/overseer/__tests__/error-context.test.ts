/**
 * CSL-5636: captureException sends browser/os/runtime/device contexts and source lines in Node, and parses every common
 * stack format. Field names are the ones platform-v2's ingest allowlist reads (`apps/api/src/lib/overseer/event-context.ts`).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { release, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OverseerClient, type OverseerEvent } from "../index";
import { parseStackTrace } from "../stack";
import { clearSourceCache, MAX_SOURCE_FILE_BYTES } from "../source-context";
import { resetEnvContexts } from "../runtime-context";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "csl5636-"));
  clearSourceCache();
  resetEnvContexts();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function capture(err: Error, config: Record<string, unknown> = {}): OverseerEvent {
  let seen: OverseerEvent | undefined;
  const c = new OverseerClient({ clientKey: "k", enabled: true, beforeSend: (e) => ((seen = e), null), ...config });
  c.init();
  c.captureException(err);
  c.close();
  return seen!;
}
const withStack = (stack: string) => Object.assign(new Error("boom"), { stack });

describe("parseStackTrace: every common format", () => {
  it("V8 with a function, with a method alias, and without a function", () => {
    const f = parseStackTrace(
      "TypeError: x\n    at handle (/app/src/a.ts:10:5)\n    at Layer.handle [as handle_request] (/app/node_modules/express/lib/layer.js:95:5)\n    at /app/src/b.ts:3:9",
    );
    expect(f).toEqual([
      { function: "handle", filename: "/app/src/a.ts", lineno: 10, colno: 5, in_app: true },
      { function: "Layer.handle [as handle_request]", filename: "/app/node_modules/express/lib/layer.js", lineno: 95, colno: 5, in_app: false },
      { filename: "/app/src/b.ts", lineno: 3, colno: 9, in_app: true },
    ]);
  });

  it("V8 async and new frames", () => {
    const f = parseStackTrace("Error: x\n    at async load (/app/src/c.ts:7:3)\n    at new Widget (/app/src/w.ts:2:1)\n    at async /app/src/d.ts:4:4");
    expect(f.map((x) => [x.function, x.filename, x.lineno])).toEqual([
      ["load", "/app/src/c.ts", 7],
      ["new Widget", "/app/src/w.ts", 2],
      [undefined, "/app/src/d.ts", 4],
    ]);
  });

  it("V8 eval, native and anonymous frames are kept, not crashed on", () => {
    const f = parseStackTrace(
      "Error: x\n    at eval (eval at run (/app/src/e.ts:5:7), <anonymous>:1:1)\n    at Array.map (<anonymous>)\n    at Object.fn (native)\n    at node:internal/process/task_queues:95:5",
    );
    expect(f).toHaveLength(4);
    expect(f[0]).toMatchObject({ function: "eval", filename: "<anonymous>", lineno: 1, in_app: false });
    expect(f[1]).toMatchObject({ function: "Array.map", filename: "<anonymous>", in_app: false });
    expect(f[2]).toMatchObject({ function: "Object.fn", filename: "native", in_app: false });
    expect(f[3]).toMatchObject({ filename: "node:internal/process/task_queues", lineno: 95, in_app: false });
  });

  it("a multi-line message is not a frame, and the first frame is not dropped", () => {
    const f = parseStackTrace("Error: line one\nline two at nowhere (x:1:1)\n    at real (/app/src/r.ts:1:1)");
    expect(f.map((x) => x.function)).toEqual(["real"]);
  });

  it("Firefox and Safari: fn@file:l:c, an empty fn, async*, [native code]", () => {
    const f = parseStackTrace("run@https://app.example.com/main.js:10:20\n@https://app.example.com/main.js:30:2\nasync*load@https://app.example.com/main.js:5:1\nmap@[native code]\n");
    expect(f.map((x) => [x.function, x.filename, x.lineno, x.colno])).toEqual([
      ["run", "https://app.example.com/main.js", 10, 20],
      [undefined, "https://app.example.com/main.js", 30, 2],
      ["load", "https://app.example.com/main.js", 5, 1],
      ["map", "[native code]", undefined, undefined],
    ]);
    expect(f[3]!.in_app).toBe(false);
  });

  it("an empty or missing stack gives no frames", () => {
    expect(parseStackTrace(undefined)).toEqual([]);
    expect(parseStackTrace("")).toEqual([]);
  });

  it("in_app is false for node_modules and for the SDK's own files", () => {
    const f = parseStackTrace("Error\n    at a (/app/node_modules/x/i.js:1:1)\n    at b (/app/node_modules/@codmir/sdk/dist/index.js:1:1)\n    at c (/app/src/c.js:1:1)");
    expect(f.map((x) => x.in_app)).toEqual([false, false, true]);
  });

  it("a Windows path keeps its drive letter", () => {
    expect(parseStackTrace("Error\n    at fn (C:\\app\\src\\a.js:3:4)")[0]).toMatchObject({ filename: "C:\\app\\src\\a.js", lineno: 3, colno: 4 });
  });
});

describe("Node contexts and request", () => {
  it("sends runtime and os with the platform's field names, beside the existing session context", () => {
    let seen: OverseerEvent | undefined;
    const c = new OverseerClient({ clientKey: "k", beforeSend: (e) => ((seen = e), null) });
    c.init();
    c.setSessionId("s1");
    c.captureException(new Error("x"));
    c.close();
    expect(seen!.contexts).toMatchObject({
      runtime: { name: "node", version: process.versions.node },
      os: { name: process.platform, version: release() },
      session: { id: "s1" },
    });
    expect(seen!.contexts).not.toHaveProperty("browser");
  });

  it("sends no request in Node, and never headers, cookies or a body", () => {
    const e = capture(new Error("x"));
    expect(e.request).toBeUndefined();
    expect(Object.keys(e)).not.toContain("request");
    expect(JSON.stringify(e.contexts)).not.toMatch(/cookie|authorization|header/i);
  });
});

describe("source context lines (Node)", () => {
  const body = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
  const stackAt = (file: string, line: number) => withStack(`Error: boom\n    at fn (${file}:${line}:1)`);

  it("reads 5 lines before and after an in-app frame", () => {
    const file = join(dir, "app.js");
    writeFileSync(file, body);
    const [frame] = capture(stackAt(file, 10)).exception!.stacktrace!;
    expect(frame).toMatchObject({ context_line: "line 10", pre_context: ["line 5", "line 6", "line 7", "line 8", "line 9"], post_context: ["line 11", "line 12", "line 13", "line 14", "line 15"] });
  });

  it("near the top of the file there are fewer lines before, and a line past the end gives none", () => {
    const file = join(dir, "short.js");
    writeFileSync(file, body);
    const [top] = capture(stackAt(file, 2)).exception!.stacktrace!;
    expect(top!.pre_context).toEqual(["line 1"]);
    const [past] = capture(stackAt(file, 99)).exception!.stacktrace!;
    expect(past).not.toHaveProperty("context_line");
  });

  it("cuts each line to 240 characters", () => {
    const file = join(dir, "wide.js");
    writeFileSync(file, `${"x".repeat(1000)}\nok`);
    const [frame] = capture(stackAt(file, 1)).exception!.stacktrace!;
    expect(frame!.context_line).toHaveLength(240);
  });

  it("skips node_modules frames, an unreadable file, and a file over 1 MB", () => {
    const nm = join(dir, "node_modules", "lib");
    const big = join(dir, "big.js");
    writeFileSync(big, "a\n".repeat(MAX_SOURCE_FILE_BYTES));
    require_mkdir(nm);
    const lib = join(nm, "index.js");
    writeFileSync(lib, body);
    const frames = capture(withStack(`Error: boom\n    at a (${lib}:5:1)\n    at b (${join(dir, "missing.js")}:5:1)\n    at c (${big}:5:1)`)).exception!.stacktrace!;
    for (const f of frames) expect(f).not.toHaveProperty("context_line");
    expect(frames.map((f) => f.in_app)).toEqual([false, true, true]);
  });

  it("only the first 3 in-app frames get lines", () => {
    const file = join(dir, "many.js");
    writeFileSync(file, body);
    const frames = capture(withStack(`Error: boom\n${[3, 4, 5, 6, 7].map((n) => `    at f${n} (${file}:${n}:1)`).join("\n")}`)).exception!.stacktrace!;
    expect(frames.filter((f) => "context_line" in f)).toHaveLength(3);
  });

  it("reads a file once per process: a later change is not seen", () => {
    const file = join(dir, "once.js");
    writeFileSync(file, body);
    capture(stackAt(file, 10));
    writeFileSync(file, "changed\n".repeat(20));
    expect(capture(stackAt(file, 10)).exception!.stacktrace![0]!.context_line).toBe("line 10");
  });

  it("includeSourceContext: false sends no lines", () => {
    const file = join(dir, "off.js");
    writeFileSync(file, body);
    expect(capture(stackAt(file, 10), { includeSourceContext: false }).exception!.stacktrace![0]).not.toHaveProperty("context_line");
  });
});

import { mkdirSync } from "node:fs";
function require_mkdir(p: string) {
  mkdirSync(p, { recursive: true });
}
