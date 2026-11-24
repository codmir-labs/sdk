import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

export const root = fileURLToPath(new URL("../../../", import.meta.url));

/** A fresh folder under node_modules/.cache, so the tests never write to the system temp folder. */
export function scratch(name: string): string {
  const base = join(root, "node_modules", ".cache", "codmir-logs-tests");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, `${name}-`));
}

/** Bundles a source entry of the SDK for Node into one ES module file in `dir`, so a child process can import it. */
export async function bundle(entry: string, dir: string, name: string): Promise<string> {
  const outfile = join(dir, `${name}.mjs`);
  await build({ entryPoints: [join(root, entry)], outfile, bundle: true, platform: "node", format: "esm", logLevel: "silent", define: { __SDK_VERSION__: '"0.0.0-test"' } });
  return outfile;
}
