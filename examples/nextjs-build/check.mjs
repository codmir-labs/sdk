/**
 * Runs after `next build` (`npm run smoke`): the build passing is the main check, and this one makes sure it was not
 * vacuous. The SDK must be in the browser code of the client component, app/error.tsx and pages/_app.tsx, and in
 * instrumentation.ts as built for Node.js and for the Edge runtime the middleware runs in. Exit 0 when every check holds.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const next = join(dirname(fileURLToPath(import.meta.url)), ".next");
// The header the SDK's transport sends: a string only its code holds.
const MARKER = "x-overseer-key";

const results = [];
function check(name, ok, detail = "") {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const json = (file) => JSON.parse(readFileSync(join(next, file), "utf8"));
const holdsSdk = (files) => files.some((file) => existsSync(join(next, file)) && readFileSync(join(next, file), "utf8").includes(MARKER));

const appChunks = json("app-build-manifest.json").pages;
for (const [route, what] of [["/page", "the client component (app/reporter.tsx)"], ["/error", "app/error.tsx"]]) {
  check(`${what} has the SDK in its browser chunks`, holdsSdk(appChunks[route] ?? []), `${(appChunks[route] ?? []).length} chunks for ${route}`);
}
const pageChunks = json("build-manifest.json").pages["/_app"] ?? [];
check("pages/_app.tsx has the SDK in its browser chunks", holdsSdk(pageChunks), `${pageChunks.length} chunks for /_app`);

const middleware = json("server/middleware-manifest.json").middleware["/"];
check("middleware.ts was built", Boolean(middleware));
check("instrumentation.ts was built for the Edge runtime with the SDK", Boolean(middleware?.files.includes("server/edge-instrumentation.js")) && holdsSdk(["server/edge-instrumentation.js"]));
check("instrumentation.ts was built for Node.js with the SDK", holdsSdk(["server/instrumentation.js"]));

const failed = results.filter((ok) => !ok).length;
console.log(failed ? `FAILED: ${failed} of ${results.length} checks` : `ALL PASS: ${results.length} checks`);
process.exit(failed ? 1 : 0);
