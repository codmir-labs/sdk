// Packs the SDK and installs the tarball into two throwaway apps that npm 7+ would refuse if the SDK had a peer range
// they break: React 17, and Next.js 14 with React 18. Each install must exit 0 and keep the pinned versions.
// Run from the repository root, after nothing else: `node scripts/peer-install-check.mjs`. Needs the network for npm.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("../", import.meta.url).pathname;
const FIXTURES = [
  { name: "react-17", deps: { react: "17.0.2", "react-dom": "17.0.2" } },
  { name: "next-14", deps: { next: "14.2.35", react: "18.3.1", "react-dom": "18.3.1" } },
];

const npm = (args, cwd) => spawnSync("npm", args, { cwd, encoding: "utf8" });
const work = mkdtempSync(join(tmpdir(), "codmir-peer-install-"));
let failed = false;
try {
  const packed = npm(["pack", "--ignore-scripts", "--pack-destination", work, "--silent"], root);
  if (packed.status !== 0) throw new Error(`npm pack failed:\n${packed.stdout}${packed.stderr}`);
  const tarball = join(work, packed.stdout.trim().split("\n").pop());

  for (const { name, deps } of FIXTURES) {
    const dir = join(work, name);
    mkdirSync(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `peer-fixture-${name}`, version: "1.0.0", private: true, dependencies: deps }));
    const run = npm(["install", tarball, "--ignore-scripts", "--no-audit", "--no-fund"], dir);
    const problems = [];
    if (run.status !== 0) problems.push(`npm install exited ${run.status}:\n${(run.stdout + run.stderr).trim().split("\n").slice(0, 12).join("\n")}`);
    else {
      for (const [dep, version] of Object.entries(deps)) {
        const got = JSON.parse(readFileSync(join(dir, "node_modules", dep, "package.json"), "utf8")).version;
        if (got !== version) problems.push(`${dep} is ${got}, expected the pinned ${version}`);
      }
    }
    if (problems.length > 0) {
      failed = true;
      console.log(`FAIL ${name}\n${problems.join("\n")}`);
    } else console.log(`PASS ${name}: ${Object.entries(deps).map(([d, v]) => `${d}@${v}`).join(", ")} installed with @codmir/sdk`);
  }
} catch (err) {
  failed = true;
  console.log(`FAIL ${err instanceof Error ? err.message : err}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
