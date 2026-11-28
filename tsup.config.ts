import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "tsup";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

const cjsFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? cjsFiles(path) : path.endsWith(".cjs") ? [path] : [];
  });

// Entry points and formats come from the package.json scripts; this file injects the version and finishes the CJS files.
export default defineConfig({
  // Keep `node:async_hooks` as written: Edge bundlers (Next.js Edge, Vercel Edge, Workers) accept the prefix, not the bare name.
  removeNodeProtocol: false,
  define: { __SDK_VERSION__: JSON.stringify(version) },
  // `splitting` makes the CJS entries share chunks (the same way the ESM ones do). It writes the `__esModule` marker as
  // a plain statement, which Node's export lexer reports as a named export of `import` from a `.cjs` file. The marker
  // stays (`require` interop reads it), but spelled so the lexer does not list it: the names are what they were.
  async onSuccess() {
    for (const file of cjsFiles("dist")) {
      const source = readFileSync(file, "utf8");
      const marked = source.replace('Object.defineProperty(exports, "__esModule", {value: true})', 'Object.defineProperty(exports, "__es" + "Module", {value: true})');
      if (marked !== source) writeFileSync(file, marked);
    }
  },
});
