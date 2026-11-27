/**
 * Every entry of `exports` type-checks under every module resolution a project can use: `module: commonjs` (which
 * resolves the `node10` way and ignores `exports`, so it relies on `typesVersions`), `nodenext` as ESM and as CJS, and
 * `bundler`. The fixture imports the package as built, from a `node_modules` link to this repository, and needs
 * `npm run build` first (CI builds before test); skips without one.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const pkg = JSON.parse(readFileSync(`${root}package.json`, "utf8")) as { name: string; exports: Record<string, unknown> };
const built = existsSync(`${root}dist/index.d.ts`) && existsSync(`${root}dist/index.d.cts`);

/** One value exported by each entry; if the subpath resolved onto the wrong file, or to nothing, its type is `any`. */
const SYMBOLS: Record<string, string> = {
  ".": "CodmirApiError",
  "./client": "CodmirClient",
  "./types": "CreateTicketSchema",
  "./overseer": "captureException",
  "./tracing": "startSpan",
  "./nextjs": "captureRequestError",
  "./nextjs/server": "withCodmirTracing",
  "./react-native": "createErrorBoundary",
  "./browser": "startBrowserTracing",
  "./replay": "ReplayRecorder",
  "./logs": "createLogMonitor",
  "./logs/node": "fileSink",
  "./logs/parse": "parseLogLine",
  "./express": "errorHandler",
  "./hono": "codmirTracing",
  "./remix": "wrapLoader",
  "./remix/server": "withCodmirRequestHandler",
  "./verify": "quickVerify",
  "./feedback": "sendFeedback",
  "./report": "CodmirReport",
};

const subpaths = Object.keys(pkg.exports);
const specifier = (subpath: string) => (subpath === "." ? pkg.name : `${pkg.name}/${subpath.slice(2)}`);

const common: ts.CompilerOptions = {
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  types: [],
  lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
  target: ts.ScriptTarget.ES2022,
};
const MODES: Array<{ name: string; file: string; options: ts.CompilerOptions }> = [
  { name: "module commonjs (node10)", file: "check.ts", options: { ...common, module: ts.ModuleKind.CommonJS } },
  { name: "nodenext, ESM", file: "check.mts", options: { ...common, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext } },
  { name: "nodenext, CJS", file: "check.cts", options: { ...common, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext } },
  { name: "esnext, bundler", file: "check.ts", options: { ...common, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler } },
];

function fixtureSource(): string {
  const lines = ["type NotAny<T> = 0 extends 1 & T ? never : T;"];
  subpaths.forEach((subpath, i) => {
    lines.push(`import * as m${i} from "${specifier(subpath)}";`);
    const symbol = SYMBOLS[subpath];
    if (symbol) lines.push(`export const typed${i}: NotAny<typeof m${i}.${symbol}> = m${i}.${symbol};`);
    else lines.push(`export const ns${i}: NotAny<typeof m${i}> = m${i};`);
  });
  return lines.join("\n") + "\n";
}

function check(dir: string, file: string, options: ts.CompilerOptions): string[] {
  const program = ts.createProgram([join(dir, file)], options);
  return ts.getPreEmitDiagnostics(program).map((d) => {
    const where = d.file && d.start !== undefined ? `${d.file.fileName.split("/").pop()}:${d.file.getLineAndCharacterOfPosition(d.start).line + 1} ` : "";
    return `${where}TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`;
  });
}

describe.skipIf(!built)("types of every entry, in every resolution mode", () => {
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "codmir-types-"));
    mkdirSync(join(dir, "node_modules", "@codmir"), { recursive: true });
    symlinkSync(root, join(dir, "node_modules", pkg.name), "dir");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ private: true }));
    const source = fixtureSource();
    for (const { file } of MODES) writeFileSync(join(dir, file), source);
  });

  it("names one symbol per entry, so a new subpath is checked for a real type", () => {
    expect(subpaths.filter((s) => !SYMBOLS[s])).toEqual([]);
    expect(Object.keys(SYMBOLS).filter((s) => !subpaths.includes(s))).toEqual([]);
  });

  for (const { name, file, options } of MODES) {
    it(`${name}: no diagnostics, and every entry is typed`, () => {
      expect(check(dir, file, options)).toEqual([]);
    }, 120_000);
  }
});
