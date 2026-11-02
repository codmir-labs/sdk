/**
 * The sample app's server: Express with the SDK's express entry, plus one static page that runs the browser SDK.
 *
 *   GET /api/demo   one transaction, three linked spans: the http.server root and two http.client children
 *                   (this app calling its own /api/a and /api/b with a W3C traceparent)
 *   GET /api/boom   throws; the SDK's error handler reports it
 *   GET /           the page (public/index.html), with a Throw button and a password field
 *
 * Config comes only from env, no key is stored in the repo:
 *   CODMIR_DSN                  default http://localhost:8787/api/overseer (the local capture server)
 *   CODMIR_CLIENT_KEY           the project's key (Settings > Codmir SDK); a throwaway value for the capture server
 *   CODMIR_TRACES_SAMPLE_RATE   default 1; 0 sends no transaction
 *   PORT                        default 3000
 */
import express from "express";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as Codmir from "@codmir/sdk/express";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 3000);
const dsn = process.env.CODMIR_DSN ?? "http://localhost:8787/api/overseer";
const clientKey = process.env.CODMIR_CLIENT_KEY ?? "";
const tracesSampleRate = Number(process.env.CODMIR_TRACES_SAMPLE_RATE ?? 1);

if (!clientKey) {
  console.error("CODMIR_CLIENT_KEY is not set. Export it (any value works against the capture server).");
  process.exit(1);
}

// The page's bundle: the browser entry and the replay entry (rrweb loads lazily as a split chunk).
await build({
  entryPoints: [join(here, "client.js")],
  outdir: join(here, "public", "build"),
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  logLevel: "warning",
});

Codmir.init({
  dsn,
  clientKey,
  environment: "example",
  service: "fullstack-basic",
  tracesSampleRate,
  // The SDK adds `traceparent` to same-origin browser requests and to these targets. The server has no
  // `location`, so its calls to itself need to be named.
  tracePropagationTargets: [`localhost:${port}`, `127.0.0.1:${port}`],
});

const app = express();
const self = `http://127.0.0.1:${port}`;

app.use(Codmir.requestHandler());
// Only /api/demo is traced: the two calls it makes to /api/a and /api/b would otherwise open transactions of
// their own in the same trace, and the demo is one transaction with its spans.
app.use("/api/demo", Codmir.tracingHandler());

app.get("/api/a", (req, res) => res.json({ ok: "a", traceparent: req.headers.traceparent ?? null }));
app.get("/api/b", (req, res) => res.json({ ok: "b", traceparent: req.headers.traceparent ?? null }));

app.get("/api/demo", async (_req, res, next) => {
  try {
    const a = await (await fetch(`${self}/api/a`)).json();
    const b = await (await fetch(`${self}/api/b`)).json();
    res.json({ a, b });
  } catch (err) {
    next(err);
  }
});

app.get("/api/boom", () => {
  throw new Error("Server demo error: /api/boom");
});

// The page reads its SDK settings from here, so the key never sits in a file. A client key is public by design.
app.get("/config.json", (_req, res) => res.json({ dsn, clientKey, tracesSampleRate }));
app.use(express.static(join(here, "public")));

app.use(Codmir.errorHandler());
// After the SDK has reported it: answer like a plain 500 instead of Express's HTML stack page.
app.use((_err, _req, res, _next) => {
  res.status(500).json({ error: "internal error" });
});

const server = app.listen(port, "127.0.0.1", () => {
  console.log(`app on http://localhost:${port} (dsn ${dsn}, traces ${tracesSampleRate})`);
});

async function shutdown() {
  await Codmir.flush();
  server.close(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
