// Runs the command on every log in logs/ with the network refused, and checks that each one gives the planted bug as one
// finding with the key masked. Exits 1 on the first thing that is not so.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const cli = fileURLToPath(new URL("./node_modules/@codmir/sdk/dist/logs/cli.js", import.meta.url));
const MESSAGE = "report failed for user #: upstream rejected api_key=[secret]";
const EXPECT = {
  "access.log": ["clf", "GET /report answers 500", "alarm"],
  "app.json.jsonl": ["json", MESSAGE, "new"],
  "app.log": ["text", MESSAGE, "new"],
  "app.pino.jsonl": ["pino", "report failed for user #: Error: upstream rejected api_key=[secret]", "new"],
  "container.log": ["auto", MESSAGE, "new"],
  "journal.jsonl": ["journald", MESSAGE, "new"],
  "railway.jsonl": ["railway", MESSAGE, "new"],
  "vercel-cli.jsonl": ["vercel", "GET /api/report answers 500", "alarm"],
  "vercel-drain.jsonl": ["vercel", "GET /api/report answers 500", "alarm"],
};

const files = readdirSync(`${here}logs`).sort();
if (files.join() !== Object.keys(EXPECT).join()) throw new Error(`logs/ holds ${files}, the table has ${Object.keys(EXPECT)}`);

let failed = 0;
for (const [file, [format, title, judgement]] of Object.entries(EXPECT)) {
  for (const f of ["auto", format]) {
    const run = spawnSync(process.execPath, ["--import", `${here}no-network.mjs`, cli, `${here}logs/${file}`, "--format", f, "--json", "--fail-on", "new"], { encoding: "utf8" });
    let doc;
    try {
      doc = JSON.parse(run.stdout);
    } catch {
      doc = null;
    }
    const one = doc?.findings?.length === 1 ? doc.findings[0] : null;
    const good = run.status === 1 && run.stderr === "" && one && one.title === title && one.judgement === judgement && one.hits === 5 && !run.stdout.includes("sk_live");
    console.log(`${good ? "ok  " : "FAIL"} ${file} (${f}): ${one ? `${one.judgement} ${one.hits}x ${one.title}` : `exit ${run.status} ${run.stderr}`}`);
    if (!good) failed++;
  }
}
if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("log-read smoke ok: the bug is found in every format, and nothing touched the network");
