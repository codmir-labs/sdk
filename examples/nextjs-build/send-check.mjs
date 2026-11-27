/**
 * Runs after `next build` (`npm run send-check`): proves that a server error reaches the server. It starts a stub ingest
 * server, starts `next start` with the SDK pointed at the stub, requests /boom (a server component that throws a known
 * message) and waits up to 30 s for the stub to receive the error event. Exit 0 when exactly one error event carries
 * that message; otherwise exit 1, with what arrived. Both servers are stopped by PID on every path.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const MESSAGE = "codmir send-check: a server component threw";
const WAIT_MS = 30_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Every request the stub got: { method, url, events: [{ type, message }] }.
const received = [];
const stub = createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    let events = [];
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      events = (body.events ?? []).map((e) => ({ type: e?.type, message: e?.event?.message ?? e?.message }));
    } catch {
      // not JSON: recorded with no events
    }
    received.push({ method: req.method, url: req.url, events });
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
});

const errorsWithMessage = () => received.flatMap((r) => r.events).filter((e) => e.type === "error" && e.message?.includes(MESSAGE));

let app;
function stopApp() {
  if (!app?.pid || app.exitCode !== null) return;
  // The app is its own process group, so a child it forked goes with it.
  for (const target of [-app.pid, app.pid]) {
    try {
      process.kill(target, "SIGTERM");
      break;
    } catch {
      // gone, or not a group leader
    }
  }
}
async function stopAll() {
  stopApp();
  await new Promise((resolve) => stub.close(resolve));
  stub.closeAllConnections?.();
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopApp();
    process.exit(1);
  });
}

async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function run() {
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const stubPort = stub.address().port;
  const appPort = await freePort();
  const base = `http://127.0.0.1:${appPort}`;

  const nextBin = join(here, "node_modules", "next", "dist", "bin", "next");
  let output = "";
  app = spawn(process.execPath, [nextBin, "start", "-H", "127.0.0.1", "-p", String(appPort)], {
    cwd: here,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "production", CODMIR_CLIENT_KEY: "osk_send_check", CODMIR_DSN: `http://127.0.0.1:${stubPort}`, NEXT_TELEMETRY_DISABLED: "1" },
  });
  for (const stream of [app.stdout, app.stderr]) stream.on("data", (chunk) => (output += chunk));
  let exited = false;
  app.on("exit", () => (exited = true));
  console.log(`next ${await nextVersion()} on ${base}, stub ingest on 127.0.0.1:${stubPort}`);

  // Ready when the home page answers.
  const readyBy = Date.now() + WAIT_MS;
  for (;;) {
    if (exited) return { ok: false, why: "next start exited before it answered", output };
    try {
      if ((await fetch(base + "/", { signal: AbortSignal.timeout(5000) })).ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > readyBy) return { ok: false, why: `next start did not answer within ${WAIT_MS / 1000} s`, output };
    await sleep(250);
  }

  const res = await fetch(base + "/boom", { signal: AbortSignal.timeout(15_000) });
  await res.arrayBuffer();
  console.log(`GET /boom answered ${res.status}`);

  const deadline = Date.now() + WAIT_MS;
  while (errorsWithMessage().length === 0 && Date.now() < deadline) await sleep(250);
  // Once it is there, give a duplicate a moment to arrive: the check is for exactly one.
  if (errorsWithMessage().length > 0) await sleep(2000);
  return { ok: errorsWithMessage().length === 1, why: `${errorsWithMessage().length} error event(s) with the message, expected 1`, output };
}

async function nextVersion() {
  const { readFile } = await import("node:fs/promises");
  return JSON.parse(await readFile(join(here, "node_modules", "next", "package.json"), "utf8")).version;
}

let result;
try {
  result = await run();
} catch (error) {
  result = { ok: false, why: `the check itself failed: ${error?.stack ?? error}`, output: "" };
}
await stopAll();

if (result.ok) {
  console.log(`PASS  the server error reached the stub: ${JSON.stringify(errorsWithMessage()[0])}`);
  process.exit(0);
}
console.log(`FAIL  ${result.why}`);
console.log(`The stub received ${received.length} request(s): ${JSON.stringify(received)}`);
if (result.output) console.log(`next start printed:\n${result.output.trim().split("\n").slice(-20).join("\n")}`);
process.exit(1);
