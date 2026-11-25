// Serves the page, the built SDK, and a stand-in for the server's feedback door, so the example runs with no account and
// no network. The stand-in checks the body as the real door does: an unknown key is refused with 400.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const dist = fileURLToPath(new URL("./node_modules/@codmir/sdk/dist/", import.meta.url));
export const KEY = "osk_example";
const KEYS = ["text", "replayId", "eventId", "failed", "pagePath", "environment", "release", "userId", "at", "replyWhenFixed", "sdk"];

/** What the next feedback call is answered with, chosen on the page. */
const MODES = {
  ok: [201],
  unauthorized: [401],
  payment: [402],
  limited: [429, { "retry-after": "30" }],
  refused: [400],
  down: [503],
  html: [200, { "content-type": "text/html" }, "<html><body>Sign in to the hotel Wi-Fi</body></html>"],
};

const STATES = ["received", "known", "fixed"];

export function start(port = 0) {
  let mode = "ok";
  // what became of every entry here: one state for all, chosen on the page; an answer is kept per id
  let demo = { state: "received", release: "1.0.1", reply: "The save button now keeps your changes." };
  const answers = new Map();
  let last = null;
  let n = 0;
  const stored = new Map();
  const send = (res, status, body = "", headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");

    if (url.pathname === "/demo/mode" && req.method === "POST") {
      mode = JSON.parse(raw).mode in MODES ? JSON.parse(raw).mode : "ok";
      return send(res, 204);
    }
    if (url.pathname === "/demo/state" && req.method === "POST") {
      const next = JSON.parse(raw);
      if (STATES.includes(next.state)) demo = { state: next.state, release: String(next.release ?? demo.release).slice(0, 200), reply: String(next.reply ?? demo.reply).slice(0, 1000) };
      return send(res, 204);
    }
    if (url.pathname === "/demo/last") return send(res, 200, last ?? {});
    if (url.pathname === "/api/boom") return send(res, 500, { error: "boom" });
    if (url.pathname === "/api/overseer/ingest" || url.pathname === "/api/overseer/replay") return send(res, 200, {});

    if (url.pathname === "/api/overseer/feedback" && req.method === "POST") {
      const [status, headers, body] = MODES[mode];
      if (mode !== "ok") return send(res, status, body ?? JSON.stringify({ error: mode }), headers);
      if (req.headers["x-overseer-key"] !== KEY) return send(res, 401, { error: "unauthorized" });
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return send(res, 400, { error: "not json" });
      }
      const unknown = Object.keys(parsed).filter((k) => !KEYS.includes(k));
      if (typeof parsed.text !== "string" || !parsed.text || parsed.text.length > 2000 || unknown.length) {
        return send(res, 400, { error: "refused", unknown });
      }
      last = parsed;
      const id = `fb_${++n}`;
      const reporterToken = `rt_${n}_${Math.random().toString(36).slice(2)}`;
      stored.set(id, reporterToken);
      return send(res, 201, { id, reporterToken, known: false });
    }
    // the two doors of an entry: what became of it, and the visitor's answer to a fix. 404 for every reason but a wrong key.
    const door = /^\/api\/overseer\/feedback\/([^/]+)(\/answer)?$/.exec(url.pathname);
    if (door && ((req.method === "GET" && !door[2]) || (req.method === "POST" && door[2]))) {
      const id = decodeURIComponent(door[1]);
      if (req.headers["x-overseer-key"] !== KEY) return send(res, 401, { error: "unauthorized" }, { "cache-control": "no-store" });
      if (stored.get(id) === undefined || stored.get(id) !== req.headers["x-reporter-token"]) return send(res, 404, "", { "cache-control": "no-store" });
      const fixed = demo.state === "fixed";
      const view = () => ({
        state: demo.state,
        release: fixed ? demo.release : null,
        fixedAt: fixed ? "2026-11-24T09:00:00.000Z" : null,
        reply: fixed ? demo.reply : null,
        answer: fixed ? (answers.get(id) ?? null) : null,
      });
      if (req.method === "GET") return send(res, 200, view(), { "cache-control": "no-store" });
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return send(res, 400, { error: "not json" }, { "cache-control": "no-store" });
      }
      if (!parsed || typeof parsed.better !== "boolean" || Object.keys(parsed).length !== 1) return send(res, 400, { error: "refused" }, { "cache-control": "no-store" });
      if (!fixed) return send(res, 409, { error: "not fixed" }, { "cache-control": "no-store" });
      answers.set(id, parsed.better ? "better" : "not_better");
      return send(res, 200, view(), { "cache-control": "no-store" });
    }
    if (url.pathname.startsWith("/api/overseer/feedback/") && req.method === "DELETE") {
      const id = decodeURIComponent(url.pathname.slice("/api/overseer/feedback/".length));
      const ok = req.headers["x-overseer-key"] === KEY && stored.get(id) === req.headers["x-reporter-token"];
      if (ok) stored.delete(id);
      return send(res, ok ? 204 : 404);
    }

    // the page, and the built SDK under /sdk/
    const file = url.pathname === "/" ? join(here, "public/index.html") : url.pathname.startsWith("/sdk/") ? join(dist, normalize(url.pathname.slice(5))) : null;
    if (!file || !file.startsWith(url.pathname.startsWith("/sdk/") ? dist : here)) return send(res, 404);
    try {
      const type = { ".html": "text/html", ".js": "text/javascript" }[extname(file)] ?? "application/octet-stream";
      send(res, 200, await readFile(file), { "content-type": type });
    } catch {
      send(res, 404);
    }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await start(Number(process.env.PORT ?? 3000));
  console.log(`feedback example on http://127.0.0.1:${server.address().port}/`);
}
