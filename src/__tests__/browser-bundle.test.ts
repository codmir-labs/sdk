/**
 * A browser bundler must be able to bundle every entry point a browser app can import, from the built dist. The
 * published 2.0.1 failed this: tsup shared chunks between all entries, and those chunks imported Node's events,
 * crypto, fs, os and path, so Next.js client components, Remix root.tsx and vite or esbuild browser builds failed.
 * Earlier, nanoid's Node build (`import "crypto"`, `Buffer`) sat in the same shared chunks. Needs `npm run build`
 * first; CI runs this file again after the build.
 */
import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Message } from "esbuild";
import { build as viteBuild, type Plugin } from "vite";
import { describe, expect, it } from "vitest";
import { generateId } from "../id";

describe("generateId", () => {
  it("is 21 characters of the URL-safe alphabet and does not repeat", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateId()));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{21}$/);
  });

  it("honours a size", () => {
    expect(generateId(8)).toHaveLength(8);
  });
});

const root = fileURLToPath(new URL("../../", import.meta.url));
const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  exports: Record<string, Record<"import" | "require", { default: string }>>;
};

// Node only by design: they need node:async_hooks. Every other export, including any added later, must bundle for a browser.
const NODE_ONLY = ["./nextjs/server", "./express", "./hono", "./remix/server", "./logs/node"];

interface Entry {
  name: string;
  file: string;
}
const entriesOf = (subpaths: string[], condition: "import" | "require"): Entry[] =>
  subpaths
    .filter((subpath) => subpath in pkg.exports)
    .map((subpath) => {
      const target = pkg.exports[subpath][condition].default;
      return { name: `@codmir/sdk${subpath.slice(1)} (${condition}: ${target.slice(2)})`, file: `${root}${target.slice(2)}` };
    });
const browserSubpaths = Object.keys(pkg.exports).filter((subpath) => !NODE_ONLY.includes(subpath));
const browserEntries = [...entriesOf(browserSubpaths, "import"), ...entriesOf(browserSubpaths, "require")];
// logs/node needs node:fs instead (the file sink); every other one needs node:async_hooks.
const nodeEntries = entriesOf(NODE_ONLY.filter((subpath) => subpath !== "./logs/node"), "import");
const logsNodeEntries = entriesOf(["./logs/node"], "import");
// Skips before a build; after one, an entry whose file is missing fails rather than skipping.
const hasDist = existsSync(`${root}dist/index.js`);

const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
const isBuiltin = (id: string) => id.startsWith("node:") || builtins.has(id) || builtins.has(id.split("/")[0]);

/** The source module of a dist line: tsup puts `// src/<file>` above each module's code. */
function sourceModule(file: string, line: number): string {
  const lines = readFileSync(file, "utf8").split("\n").slice(0, line);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\/\/ (src\/\S+)$/.exec(lines[i]);
    if (m) return m[1];
  }
  return "an unknown module";
}

function describeError(entry: Entry, e: Message): string {
  // esbuild gives the file relative to absWorkingDir, the repo root.
  const where = e.location ? `${e.location.file}:${e.location.line}` : "?";
  const id = /^Could not resolve "([^"]+)"/.exec(e.text)?.[1];
  if (id && isBuiltin(id) && e.location) {
    return `${entry.name} reaches the Node built-in "${id}": ${where}, from ${sourceModule(`${root}${e.location.file}`, e.location.line)}`;
  }
  return `${entry.name}: ${e.text} (${where})`;
}

/** Every Node built-in or Node-only global the entry reaches when esbuild bundles it for the browser; [] when none. */
async function browserProblems(entry: Entry): Promise<string[]> {
  try {
    const result = await build({
      entryPoints: [entry.file],
      absWorkingDir: root,
      bundle: true,
      write: false,
      platform: "browser",
      format: "esm",
      minify: true,
      logLevel: "silent",
    });
    // Minified, so comments are gone and only real references are left.
    const code = result.outputFiles.map((f) => f.text).join("\n");
    const globals = new Set([...code.matchAll(/\b(Buffer|__dirname|__filename|setImmediate)\b/g)].map((m) => m[1]));
    return [...globals].map((name) => `${entry.name} uses the Node global ${name}`);
  } catch (err) {
    const errors = (err as { errors?: Message[] }).errors;
    if (!errors?.length) throw err;
    return errors.map((e) => describeError(entry, e));
  }
}

describe.skipIf(!hasDist)("esbuild bundles every browser entry for the browser (built dist)", () => {
  it("the Node-only list names real exports", () => {
    expect(NODE_ONLY.filter((subpath) => !(subpath in pkg.exports))).toEqual([]);
    expect(browserSubpaths.length).toBeGreaterThan(0);
  });

  // The feedback entry is for a page's own form: it must be in the browser list, and so checked below.
  it("includes @codmir/sdk/feedback", () => {
    expect(browserSubpaths).toContain("./feedback");
  });

  for (const entry of browserEntries) {
    it(`${entry.name} reaches no Node built-in`, async () => {
      const problems = await browserProblems(entry);
      // The problems as the message too, so each failing entry prints its own rather than one grouped diff.
      expect(problems, problems.join("\n")).toEqual([]);
    });
  }

  // The same check on an entry that does import Node: proves it can fail, and names the entry and the module.
  for (const entry of nodeEntries) {
    it(`${entry.name} is Node only: the check names its node:async_hooks import`, async () => {
      const problems = await browserProblems(entry);
      const asyncHooks = problems.filter((p) => /reaches the Node built-in "(node:)?async_hooks": dist\/\S+:\d+, from src\/tracing\/server\.ts$/.test(p));
      expect(asyncHooks, problems.join("\n")).toHaveLength(1);
      expect(asyncHooks[0].startsWith(entry.name)).toBe(true);
    });
  }
});

describe.skipIf(!hasDist)("the log monitor's Node entry", () => {
  for (const entry of logsNodeEntries) {
    it(`${entry.name} is Node only: the check names its node:fs import`, async () => {
      const problems = await browserProblems(entry);
      const fs = problems.filter((p) => /reaches the Node built-in "(node:)?fs": dist\/\S+:\d+, from src\/logs\/node\.ts$/.test(p));
      expect(fs, problems.join("\n")).toHaveLength(1);
      expect(fs[0].startsWith(entry.name)).toBe(true);
    });
  }
});

describe.skipIf(!hasDist)("vite builds every browser entry for the browser (built dist)", () => {
  for (const entry of browserEntries.filter((e) => e.file.endsWith(".js"))) {
    it(`${entry.name} builds and reaches no Node built-in`, async () => {
      const problems: string[] = [];
      // vite turns a Node built-in into its empty `__vite-browser-external` module, fails the build on a named import
      // from it, and warns about the rest only when NODE_ENV is production (vitest sets test). So record each one here,
      // before vite resolves it.
      const recordBuiltins: Plugin = {
        name: "record-node-builtins",
        enforce: "pre",
        resolveId(id, importer) {
          if (isBuiltin(id)) problems.push(`${entry.name} reaches the Node built-in "${id}": imported by ${relative(root, importer ?? "")}`);
          return null;
        },
      };
      try {
        await viteBuild({
          configFile: false,
          root,
          publicDir: false,
          logLevel: "silent",
          plugins: [recordBuiltins],
          build: { write: false, minify: false, lib: { entry: entry.file, formats: ["es"], fileName: "entry" } },
        });
      } catch (err) {
        problems.push(`${entry.name}: vite build failed: ${(err as Error).message}`);
      }
      expect(problems, problems.join("\n")).toEqual([]);
    });
  }
});

describe.skipIf(!hasDist)("package.json sideEffects (built dist)", () => {
  // No module does anything when it is imported, so `sideEffects: false` is true, and it lets a bundler drop a chunk
  // nothing uses. With chunks marked as side effects, esbuild kept the API client's zod schemas (and zod) in every
  // bundle of the root entry, even one that only reports errors.
  it("a browser bundle of the root entry's error functions carries no zod", async () => {
    const result = await build({
      stdin: {
        contents: 'import { init, captureException } from "@codmir/sdk";\ninit({ clientKey: "k" });\ncaptureException(new Error("x"));\n',
        resolveDir: root,
        loader: "js",
      },
      absWorkingDir: root,
      bundle: true,
      write: false,
      platform: "browser",
      format: "esm",
      minify: true,
      metafile: true,
      logLevel: "silent",
    });
    const [output] = Object.values(result.metafile.outputs);
    const kept = Object.entries(output.inputs).filter(([, input]) => input.bytesInOutput > 0).map(([file]) => file);
    expect(kept.some((file) => file.startsWith("dist/"))).toBe(true);
    expect(kept.filter((file) => file.includes("node_modules/zod/"))).toEqual([]);
  });
});

// The server tracing entries also run on Next.js Edge, Vercel Edge and Workers (with `nodejs_als` or `nodejs_compat`). There
// `node:async_hooks` is the one Node built-in a bundler may leave external: a bare `crypto` or `async_hooks` in a built
// chunk, or any other built-in, fails an Edge build with "Module not found".
const ALLOWED = "node:async_hooks";

/** What each entry is imported for: the names a server wraps its routes with. */
const ENTRIES: { subpath: string; names: string[] }[] = [
  { subpath: "./hono", names: ["codmirTracing"] },
  { subpath: "./nextjs/server", names: ["withCodmirTracing", "withCodmirMiddleware"] },
  { subpath: "./remix/server", names: ["withCodmirTracing", "withCodmirRequestHandler"] },
];

/** The built-ins a bundle for an Edge runtime imports, with only `node:async_hooks` allowed to stay external. */
async function externalImports(subpath: string, names: string[], condition: "import" | "require"): Promise<string[]> {
  const target = pkg.exports[subpath][condition].default.slice(2);
  const file = `${root}${target}`;
  const result = await build({
    stdin: {
      contents: condition === "import" ? `import { ${names.join(", ")} } from ${JSON.stringify(file)};\nconsole.log(${names.join(", ")});\n` : `const m = require(${JSON.stringify(file)});\nconsole.log(${names.map((n) => `m.${n}`).join(", ")});\n`,
      resolveDir: root,
      loader: "js",
    },
    absWorkingDir: root,
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    external: [ALLOWED],
    metafile: true,
    logLevel: "silent",
  });
  const [output] = Object.values(result.metafile.outputs);
  return output.imports.filter((i) => i.external).map((i) => i.path);
}

describe.skipIf(!hasDist)("server tracing bundles for an Edge runtime (built dist)", () => {
  for (const { subpath, names } of ENTRIES) {
    for (const condition of ["import", "require"] as const) {
      it(`@codmir/sdk${subpath.slice(1)} (${condition}) reaches no Node built-in but ${ALLOWED}`, async () => {
        // esbuild fails the build on a built-in it cannot resolve (`crypto`, `node:crypto`), which is the failure an Edge build gives.
        const external = await externalImports(subpath, names, condition);
        expect(external.filter(isBuiltin).filter((id) => id !== ALLOWED)).toEqual([]);
        // It does import the prefixed name: a bare `async_hooks` is not accepted by Edge bundlers.
        expect(external).toContain(ALLOWED);
      });
    }
  }
});
