/**
 * The usage the README and the type docs show type-checks, with no cast, against the real framework types (`react`, `next`,
 * `@remix-run/server-runtime`, which `@remix-run/node` re-exports) and the SDK's source entry points, so it needs no build.
 * Each fixture is compiled in memory with `strict` on; a failure prints the diagnostics.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const fixtureDir = `${root}src/__tests__/__fixtures__/`;

/** The `// or per route` block of the `withCodmirTracing` example in the Remix server docs, as it is written there. */
function perRouteExample(): string {
  const doc = readFileSync(`${root}src/remix/server.ts`, "utf8");
  const start = doc.indexOf("// or per route");
  const end = doc.indexOf("```", start);
  return doc
    .slice(start, end)
    .split("\n")
    .map((line) => line.replace(/^ \* ?/, ""))
    .join("\n");
}

const FIXTURES: Record<string, { file: string; code: string }> = {
  "the error boundary renders as a JSX component": {
    file: "boundary.tsx",
    code: `
import React from "react";
import * as Codmir from "../../react-native/index";

const Boundary = Codmir.createErrorBoundary(React);

export function App() {
  return (
    <Boundary fallback={<div>Something broke</div>} onError={(error, stack) => void [error.message, stack]}>
      <div>app</div>
    </Boundary>
  );
}
export const WithRender = <Boundary fallback={(error) => <span>{error.message}</span>}>x</Boundary>;
`,
  },
  "captureRouterError is Next's onRequestError": {
    file: "instrumentation.ts",
    code: `
import type { Instrumentation } from "next";
import * as Codmir from "../../nextjs/index";

export const onRequestError: Instrumentation.onRequestError = Codmir.captureRouterError;
`,
  },
  "an action typed with ActionFunctionArgs reads request.formData()": {
    file: "action.ts",
    code: `
import { json, type ActionFunctionArgs } from "@remix-run/node";
import { wrapAction } from "../../remix/index";

export const action = wrapAction(async ({ request }: ActionFunctionArgs) => {
  const form = await request.formData();
  return json({ ok: true, name: form.get("name") });
});
`,
  },
  "a loader typed with LoaderFunctionArgs is wrapped": {
    file: "loader.ts",
    code: `
import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { wrapLoader } from "../../remix/index";

export const loader = wrapLoader(async ({ request, params }: LoaderFunctionArgs) => {
  return json({ id: params.id, path: new URL(request.url).pathname });
});
`,
  },
  "the withCodmirTracing example, as the docs show it": {
    file: "tracing.ts",
    code: perRouteExample().replace('"@codmir/sdk/remix/server"', '"../../remix/server"'),
  },
};

function diagnose(file: string, code: string): string[] {
  const path = `${fixtureDir}${file}`;
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    jsx: ts.JsxEmit.ReactJSX,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    esModuleInterop: true,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
    types: ["node"],
    typeRoots: [`${root}node_modules/@types`],
    baseUrl: root,
    // `@remix-run/node` re-exports these types; it is not installed, the package it takes them from is.
    paths: { "@remix-run/node": ["node_modules/@remix-run/server-runtime"] },
  };
  const host = ts.createCompilerHost(options);
  const { fileExists, readFile, getSourceFile } = host;
  host.fileExists = (name) => name === path || fileExists.call(host, name);
  host.readFile = (name) => (name === path ? code : readFile.call(host, name));
  host.getSourceFile = (name, languageVersion, onError, shouldCreate) =>
    name === path ? ts.createSourceFile(name, code, languageVersion, true) : getSourceFile.call(host, name, languageVersion, onError, shouldCreate);
  const program = ts.createProgram([path], options, host);
  return ts.getPreEmitDiagnostics(program).map((d) => {
    const where = d.file && d.start !== undefined ? `${d.file.fileName.replace(root, "")}:${d.file.getLineAndCharacterOfPosition(d.start).line + 1}` : "";
    return `${where} TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`;
  });
}

describe("documented usage type-checks against the real framework types", () => {
  for (const [name, { file, code }] of Object.entries(FIXTURES)) {
    it(name, () => {
      const diagnostics = diagnose(file, code);
      expect(diagnostics, diagnostics.join("\n")).toEqual([]);
    }, 60_000);
  }
});
