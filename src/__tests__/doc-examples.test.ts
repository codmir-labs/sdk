/**
 * Every `@example` block in the built type files (`dist/**\/*.d.ts`), which an editor shows on hover, typechecked against
 * `dist` as written, with small stand-ins for the frameworks a block imports. Every `init`, `verify` and `quickVerify`
 * in them names a client key: without one ingest drops each event. Skips without a build; CI runs this file after one.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const hasDist = existsSync(`${root}dist/index.d.ts`) && existsSync(`${root}dist/remix/server.d.ts`);

interface Block {
  /** Where it came from, for a failure message. */
  label: string;
  code: string;
  /** `tsx` when the block holds JSX. */
  ext: "ts" | "tsx";
}

function declarationFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return declarationFiles(path);
    return name.endsWith(".d.ts") ? [path] : [];
  });
}

/** The code of every fenced block that follows an `@example` tag in a doc comment, as a page or a module would run it. */
function examplesOf(text: string): string[] {
  const out: string[] = [];
  for (const comment of text.match(/\/\*\*[\s\S]*?\*\//g) ?? []) {
    const lines = comment.split("\n").map((l) => l.replace(/^\s*(\/\*\*|\*\/|\*) ?/, "").replace(/\*\/\s*$/, ""));
    for (let i = 0; i < lines.length; i++) {
      if (!/^@example\b/.test(lines[i])) continue;
      let j = i + 1;
      while (j < lines.length && !/^```/.test(lines[j]) && !/^@\w+/.test(lines[j])) j++;
      const lang = /^```(\w*)/.exec(lines[j] ?? "")?.[1] ?? "";
      if (!lang) continue;
      const body: string[] = [];
      for (j++; j < lines.length && !/^```\s*$/.test(lines[j]); j++) body.push(lines[j]);
      const code = body.join("\n");
      if (lang === "html") {
        // A page: the code is what its script elements hold.
        for (const m of code.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) out.push(m[1]);
      } else if (["ts", "tsx", "typescript", "js", "javascript"].includes(lang)) {
        out.push(code);
      }
      i = j;
    }
  }
  return out;
}

function collect(): Block[] {
  const seen = new Set<string>();
  const blocks: Block[] = [];
  for (const file of declarationFiles(`${root}dist`)) {
    const rel = file.slice(root.length + 5).replace(/-[\w-]{8}\.d\.ts$/, "");
    for (const code of examplesOf(readFileSync(file, "utf8"))) {
      const trimmed = code.trim();
      // The same doc comment sits in more than one file (a chunk and the entry that re-exports it).
      if (seen.has(trimmed)) continue;
      seen.add(trimmed);
      const ext = /(\(|,|return|=>|=)\s*<[A-Za-z][\w.]*[\s/>]|<\/[A-Za-z]/.test(trimmed) ? "tsx" : "ts";
      blocks.push({ label: `${rel} #${blocks.length + 1}: ${trimmed.split("\n").find((l) => l.trim() && !l.trim().startsWith("//"))?.trim().slice(0, 50)}`, code: trimmed + "\n", ext });
    }
  }
  return blocks;
}

// What a block uses without defining it, and the framework packages it imports. Shapes follow the real packages closely
// enough for the snippet's own use; nothing here models the SDK.
const STUBS = `
declare module "react-native" {
  import type * as React from "react";
  export const Text: React.ComponentType<{ children?: React.ReactNode }>;
  export const View: React.ComponentType<{ children?: React.ReactNode }>;
}
declare module "@react-navigation/native" {
  import type * as React from "react";
  export const NavigationContainer: React.ComponentType<{ children?: React.ReactNode; onStateChange?: (state: unknown) => void }>;
}
declare module "@remix-run/node" {
  export type ServerBuild = { mode: string };
  export type LoaderFunctionArgs = { request: Request; params: Record<string, string | undefined>; context: unknown };
  export type ActionFunctionArgs = LoaderFunctionArgs;
  export type EntryContext = Record<string, unknown>;
  export type RequestHandler = (request: Request) => Promise<Response>;
  export function createRequestHandler(build: ServerBuild, mode?: string): RequestHandler;
  export function json<Data>(data: Data, init?: number | ResponseInit): Response;
}
declare module "@remix-run/react" {
  export const RemixServer: import("react").ComponentType<{ context: unknown; url: string }>;
}
declare module "react-dom/server" {
  export function renderToPipeableStream(node: unknown, options?: { onError?(error: unknown): void }): unknown;
}
declare module "busboy" {
  const busboy: (options: { headers: unknown }) => import("node:stream").Writable;
  export default busboy;
}
declare const build: import("@remix-run/node").ServerBuild;
declare const Codmir: typeof import("@codmir/sdk/express");
declare const app: { use(...handlers: unknown[]): void };
declare function riskyOperation(): void;
declare function getUser(id: unknown): Promise<{ id: string }>;
declare function updateUser(form: unknown): Promise<void>;
declare const ErrorScreen: import("react").ComponentType;
declare const YourApp: import("react").ComponentType;
declare function startTransition(callback: () => void): void;
declare function hydrateRoot(container: unknown, node: unknown): void;
declare const RemixBrowser: import("react").ComponentType;
interface Window { ENV: Record<string, string> }
`;

const blocks = hasDist ? collect() : [];
let dir = "";
let diagnostics = new Map<string, string[]>();

beforeAll(() => {
  if (!hasDist) return;
  dir = mkdtempSync(join(tmpdir(), "codmir-doc-examples-"));
  mkdirSync(join(dir, "blocks"));
  const files = blocks.map((b, i) => {
    const file = join(dir, "blocks", `block-${i}.${b.ext}`);
    writeFileSync(file, b.code);
    return file;
  });
  const stubs = join(dir, "stubs.d.ts");
  writeFileSync(stubs, STUBS);
  const program = ts.createProgram([...files, stubs], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    moduleDetection: ts.ModuleDetectionKind.Force,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    esModuleInterop: true,
    jsx: ts.JsxEmit.ReactJSX,
    types: ["node", "react", "react-dom"],
    typeRoots: [`${root}node_modules/@types`],
    baseUrl: root,
    paths: {
      "@codmir/sdk": ["dist/index.d.ts"],
      "@codmir/sdk/*": ["dist/*/index.d.ts", "dist/*.d.ts"],
    },
  });
  diagnostics = new Map(
    files.map((file) => {
      const source = program.getSourceFile(file)!;
      const found = [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)];
      return [
        file,
        found.map((d) => {
          const { line } = source.getLineAndCharacterOfPosition(d.start ?? 0);
          return `line ${line + 1}: TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`;
        }),
      ];
    }),
  );
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** The calls to `init`, `verify` and `quickVerify` in a block, as `[name, first argument]`. */
function setupCalls(block: Block): Array<[string, ts.Expression | undefined]> {
  const source = ts.createSourceFile(`block.${block.ext}`, block.code, ts.ScriptTarget.ES2022, true, block.ext === "tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const calls: Array<[string, ts.Expression | undefined]> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : ts.isIdentifier(node.expression) ? node.expression.text : "";
      if (["init", "verify", "quickVerify"].includes(callee)) calls.push([callee, node.arguments[0]]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

function propertyNames(expression: ts.Expression | undefined): string[] {
  if (!expression || !ts.isObjectLiteralExpression(expression)) return [];
  return expression.properties.flatMap((p) => (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? [p.name.text] : []));
}

describe.skipIf(!hasDist)("the @example blocks of the built type files", () => {
  it("finds the blocks of every entry", () => {
    expect(blocks.length).toBeGreaterThanOrEqual(20);
    for (const entry of ["browser", "express", "nextjs", "overseer", "react-native", "remix", "remix/server", "replay", "verify"]) {
      expect(blocks.some((b) => b.code.includes(`@codmir/sdk/${entry}'`) || b.code.includes(`@codmir/sdk/${entry}"`)), entry).toBe(true);
    }
  });

  it.each(blocks.map((b, i) => [b.label, i] as const))("compiles against dist: %s", (_label, i) => {
    const file = join(dir, "blocks", `block-${i}.${blocks[i].ext}`);
    expect(diagnostics.get(file)).toEqual([]);
  });

  it("names a clientKey in every init, verify and quickVerify, and a dsn in none", () => {
    const wrong: string[] = [];
    let calls = 0;
    for (const block of blocks) {
      for (const [name, arg] of setupCalls(block)) {
        calls++;
        if (name === "quickVerify") {
          if (!arg || !/key/i.test(arg.getText())) wrong.push(`${block.label}: quickVerify(${arg?.getText() ?? ""}) is not given a client key`);
          continue;
        }
        const names = propertyNames(arg);
        if (!names.includes("clientKey")) wrong.push(`${block.label}: ${name}(...) has no clientKey`);
        if (names.includes("dsn")) wrong.push(`${block.label}: ${name}(...) passes a dsn`);
      }
    }
    expect(calls).toBeGreaterThanOrEqual(10);
    expect(wrong).toEqual([]);
  });
});
