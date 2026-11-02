// Run after `npm run build`: every file an export points at must exist in dist (CSL-5601).
import { existsSync, readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));

const targets = [pkg.main, pkg.module, pkg.types];
const walk = (node) => {
  if (typeof node === "string") targets.push(node);
  else if (node && typeof node === "object") Object.values(node).forEach(walk);
};
walk(pkg.exports);

const missing = [...new Set(targets.filter(Boolean))].filter((file) => !existsSync(new URL(file, root)));
if (missing.length > 0) {
  console.error(`package.json points at ${missing.length} file(s) missing from dist:\n${missing.map((f) => `  ${f}`).join("\n")}`);
  process.exit(1);
}
console.log(`dist ok: ${new Set(targets.filter(Boolean)).size} targets exist`);
