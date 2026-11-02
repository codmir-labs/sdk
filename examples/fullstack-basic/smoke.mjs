/**
 * End-to-end smoke for the sample app. Starts the capture server and the app, drives the page in a real
 * (headed) Chrome, then checks what reached the capture server. Exit 0 when every check holds, 1 otherwise.
 *
 * Run it as `npm run smoke` (xvfb-run -a supplies a display; the browser is never headless).
 * Env: CHROME_PATH (default: google-chrome / chromium on PATH), CAPTURE_PORT (8787), APP_PORT (3111; 3000 is the app's own default and often taken).
 */
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { startCaptureServer } from "./capture-server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const capturePort = Number(process.env.CAPTURE_PORT ?? 8787);
const appPort = Number(process.env.APP_PORT ?? 3111);
const appUrl = `http://localhost:${appPort}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const bin of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    try {
      return execFileSync("which", [bin], { encoding: "utf8" }).trim();
    } catch {
      // try the next name
    }
  }
  throw new Error("no Chrome found: set CHROME_PATH");
}

function readCaptures(dir) {
  const files = existsSync(dir) ? readdirSync(dir).sort() : [];
  const out = { error: [], transaction: [], replay: [], rejected: [], text: "" };
  for (const f of files) {
    const text = readFileSync(join(dir, f), "utf8");
    out.text += text;
    const json = JSON.parse(text);
    if (f.includes("rejected")) out.rejected.push({ f, json });
    else if (f.endsWith("-error.json")) out.error.push(json);
    else if (f.endsWith("-transaction.json")) out.transaction.push(json);
    else if (f.endsWith("-replay.json")) out.replay.push(json);
  }
  return out;
}

async function waitFor(pred, timeoutMs, what) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(200);
  }
  console.log(`(timed out after ${timeoutMs} ms waiting for ${what})`);
  return false;
}

/** Runs the app against a fresh capture server; `drive(appUrl)` does the traffic. Returns the captures. */
async function runPhase(name, tracesSampleRate, drive, ready) {
  const dir = join(here, "captures", name);
  const capture = await startCaptureServer({ port: capturePort, dir, log: (m) => console.log(`  [${name}] ${m}`) });
  const app = spawn(process.execPath, [join(here, "server.mjs")], {
    cwd: here,
    env: {
      ...process.env,
      PORT: String(appPort),
      CODMIR_DSN: `http://localhost:${capturePort}/api/overseer`,
      CODMIR_CLIENT_KEY: "smoke-test-key",
      CODMIR_TRACES_SAMPLE_RATE: String(tracesSampleRate),
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let appOut = "";
  app.stdout.on("data", (d) => (appOut += d));
  const exited = new Promise((r) => app.once("exit", r));
  try {
    const up = await waitFor(() => appOut.includes("app on http"), 30_000, "the app to listen");
    if (!up) throw new Error("app did not start");
    const extra = await drive(appUrl);
    await waitFor(() => ready(readCaptures(dir)), 20_000, `${name} captures`);
    await sleep(1500); // let a stray extra event arrive, so "exactly N" means N
    return { ...readCaptures(dir), extra };
  } finally {
    app.kill("SIGTERM");
    await Promise.race([exited, sleep(5000)]);
    app.kill("SIGKILL");
    await capture.close();
  }
}

if (!process.env.DISPLAY) {
  console.error("DISPLAY is not set. The smoke drives a headed Chrome: run it with `npm run smoke` (xvfb-run -a).");
  process.exit(1);
}

const passwordSecret = `pw-${randomBytes(6).toString("hex")}`;
const nameSecret = `name-${randomBytes(6).toString("hex")}`;

// ── Phase 1: tracesSampleRate 1 ──────────────────────────────
console.log("Phase 1: tracesSampleRate=1");
const full = await runPhase(
  "sampled",
  1,
  async (base) => {
    const demo = await (await fetch(`${base}/api/demo`)).json();
    const boom = await fetch(`${base}/api/boom`);

    const browser = await puppeteer.launch({
      executablePath: findChrome(),
      headless: false,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    try {
      const page = await browser.newPage();
      page.on("pageerror", () => {}); // the Throw button's error is the point
      await page.goto(base, { waitUntil: "load" });
      await page.waitForFunction("window.codmirReady === true", { timeout: 15_000 });
      await sleep(1500); // rrweb loads lazily and takes its first snapshot
      await page.type("#name", nameSecret, { delay: 20 });
      await page.type("#password", passwordSecret, { delay: 20 });
      await sleep(500);
      await page.click("#throw");
      await sleep(1000);
    } finally {
      await browser.close();
    }
    return { demo, boomStatus: boom.status };
  },
  (c) => c.transaction.length >= 1 && c.error.length >= 2 && c.replay.length >= 1,
);

// ── Phase 2: tracesSampleRate 0 ──────────────────────────────
console.log("Phase 2: tracesSampleRate=0");
const unsampled = await runPhase(
  "unsampled",
  0,
  async (base) => {
    await fetch(`${base}/api/demo`);
    await fetch(`${base}/api/boom`); // proves the pipeline is alive: an error still arrives
  },
  (c) => c.error.length >= 1,
);

// ── Assertions ───────────────────────────────────────────────
console.log("\nChecks");
check("no payload was rejected by the platform schemas", full.rejected.length === 0 && unsampled.rejected.length === 0,
  full.rejected[0]?.json.problems?.[0] ? JSON.stringify(full.rejected[0].json.problems[0]) : "");

check("exactly 1 transaction", full.transaction.length === 1, `${full.transaction.length}`);
const tx = full.transaction[0]?.event;
if (tx) {
  const root = { span_id: tx.span_id, parent_span_id: tx.parent_span_id };
  const all = [root, ...tx.spans];
  check("transaction has 3 spans: the root and 2 http.client children", all.length === 3 && tx.spans.every((s) => s.op === "http.client"),
    `${tx.op} "${tx.name}" + ${tx.spans.map((s) => `${s.op} "${s.description}"`).join(", ")}`);
  check("children are linked to the root by parent_span_id", tx.spans.every((s) => s.parent_span_id === tx.span_id));
  check("all 3 span ids are distinct", new Set(all.map((s) => s.span_id)).size === 3);
  const a = full.extra.demo.a.traceparent;
  const b = full.extra.demo.b.traceparent;
  const parts = (h) => (typeof h === "string" ? h.split("-") : []);
  check("both outbound calls carried a traceparent of this trace, naming their own span",
    [a, b].every((h) => parts(h)[1] === tx.trace_id) && new Set([parts(a)[2], parts(b)[2]]).size === 2 &&
      tx.spans.every((s) => [parts(a)[2], parts(b)[2]].includes(s.span_id)),
    `${a} / ${b}`);
} else {
  check("transaction has 3 spans", false, "no transaction captured");
}

const serverErr = full.error.find((e) => /Server demo error/.test(e.event.event?.message ?? ""));
const browserErr = full.error.find((e) => /Browser demo error/.test(e.event.event?.message ?? ""));
check("exactly 2 errors, one from the server and one from the browser", full.error.length === 2 && !!serverErr && !!browserErr,
  `${full.error.length}`);
check("the browser error carries tags.replay_id", !!browserErr?.event.event?.tags?.replay_id, browserErr?.event.event?.tags?.replay_id ?? "");
check("the server error has no replay_id", !!serverErr && !serverErr.event.event?.tags?.replay_id);

const replayId = browserErr?.event.event?.tags?.replay_id;
const segs = full.replay.filter((r) => r.replay_id === replayId);
check("at least 1 replay segment matches that replay_id", segs.length >= 1, `${segs.length} segment(s), ${segs.reduce((n, s) => n + s.body.events.length, 0)} events`);
check("the segment links the browser error (error_event_ids)", segs.some((s) => s.body.error_event_ids.includes(browserErr?.event.event?.id)));

// A masking check that cannot pass by the typing having gone missing: the replay must show the typing happened.
const inputEvents = segs.flatMap((s) => s.body.events).filter((e) => e.type === 3 && e.data?.source === 5);
check("the replay recorded the typing, as asterisks only", inputEvents.length > 0 && inputEvents.every((e) => /^\*+$/.test(e.data.text ?? "")),
  `${inputEvents.length} input event(s)`);
check("the typed password appears nowhere in any capture", !full.text.includes(passwordSecret) && !unsampled.text.includes(passwordSecret));
check("the typed text field value appears nowhere in any capture", !full.text.includes(nameSecret) && !unsampled.text.includes(nameSecret));

check("tracesSampleRate=0: no transaction", unsampled.transaction.length === 0, `${unsampled.transaction.length}`);
check("tracesSampleRate=0: the error still arrived", unsampled.error.length >= 1, `${unsampled.error.length}`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
