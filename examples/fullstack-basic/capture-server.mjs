/**
 * A local stand-in for the Codmir platform's Overseer endpoints, for running the sample app without a project.
 *
 *   POST /api/overseer/ingest   errors and transactions, 200 like the platform
 *   POST /api/overseer/replay   replay segments, 202 {"stored":true}
 *
 * Every request needs the `x-overseer-key` header (any value; the key itself is never written down). Each body is
 * validated against the platform's real schemas (./schemas.mjs); a body that fails answers 400 (or drops that
 * event, for ingest) and is written to captures/ as `rejected-*`, so a contract drift shows up in the smoke
 * instead of in production. Every accepted payload goes to captures/NNN-<kind>.json.
 *
 * Env: CAPTURE_PORT (8787), CAPTURE_DIR (./captures).
 */
import { createServer } from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  OverseerSdkErrorEventSchema,
  OverseerWrapperErrorEventSchema,
  REPLAY_MAX_BODY_BYTES,
  ReplaySegmentUploadSchema,
  TelemetryIngestBodySchema,
  TransactionEventSchema,
} from "./schemas.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/** Starts the server; resolves once it listens. `close()` stops it. Clears the capture dir first. */
export function startCaptureServer({ port = 8787, dir = join(here, "captures"), log = console.log } = {}) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  let seq = 0;

  const save = (kind, payload) => {
    const name = `${String(++seq).padStart(3, "0")}-${kind}.json`;
    writeFileSync(join(dir, name), JSON.stringify(payload, null, 2));
    return name;
  };

  /** Returns the problems of one ingest event, or [] when the platform would accept it. */
  const checkEvent = (event) => {
    if (event && typeof event === "object" && event.type === "transaction") {
      const r = TransactionEventSchema.safeParse(event);
      return r.success ? [] : r.error.issues.map((i) => `transaction.${i.path.join(".")}: ${i.message}`);
    }
    if (event && typeof event === "object" && event.type === "error") {
      const wrapper = OverseerWrapperErrorEventSchema.safeParse(event);
      if (!wrapper.success) return wrapper.error.issues.map((i) => `error.${i.path.join(".")}: ${i.message}`);
      // What the SDK sends is the wrapper around a flat event; the flat shape must hold too.
      const flat = OverseerSdkErrorEventSchema.safeParse({ type: "error", ...event.event });
      return flat.success ? [] : flat.error.issues.map((i) => `error.event.${i.path.join(".")}: ${i.message}`);
    }
    return [`unsupported event type ${JSON.stringify(event?.type)}`];
  };

  const server = createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "content-type, x-overseer-key, authorization",
        "access-control-allow-methods": "POST, OPTIONS",
      });
      res.end(status === 204 ? undefined : JSON.stringify(body));
    };
    if (req.method === "OPTIONS") return send(204, {});
    const route = new URL(req.url ?? "/", "http://localhost").pathname.replace(/\/+$/, "");
    if (req.method !== "POST" || (route !== "/api/overseer/ingest" && route !== "/api/overseer/replay")) {
      return send(404, { error: "not found" });
    }
    if (!req.headers["x-overseer-key"]) return send(401, { error: "missing x-overseer-key" });

    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size <= REPLAY_MAX_BODY_BYTES) chunks.push(c);
    });
    req.on("end", () => {
      if (size > REPLAY_MAX_BODY_BYTES) return send(413, { error: "body too large" });
      let json;
      try {
        json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return send(400, { error: "invalid json" });
      }

      if (route.endsWith("/replay")) {
        const parsed = ReplaySegmentUploadSchema.safeParse(json);
        if (!parsed.success) {
          save("rejected-replay", { problems: parsed.error.issues, body: json });
          log(`capture: REJECTED replay segment: ${parsed.error.issues[0]?.message}`);
          return send(400, { error: "invalid replay segment" });
        }
        const name = save("replay", { replay_id: parsed.data.replay_id, segment: parsed.data.segment, body: json });
        log(`capture: ${name} replay ${parsed.data.replay_id} segment ${parsed.data.segment} (${parsed.data.events.length} events)`);
        return send(202, { stored: true });
      }

      const envelope = TelemetryIngestBodySchema.safeParse(json);
      if (!envelope.success) {
        save("rejected-ingest", { problems: envelope.error.issues, body: json });
        return send(400, { error: "invalid envelope" });
      }
      const { events, ...meta } = envelope.data;
      const droppedEvents = [];
      let errors = 0;
      let transactions = 0;
      events.forEach((event, index) => {
        const problems = checkEvent(event);
        if (problems.length > 0) {
          droppedEvents.push({ index, reason: "unparseable", type: event?.type });
          save("rejected-ingest", { problems, event });
          log(`capture: REJECTED ${event?.type} event: ${problems[0]}`);
          return;
        }
        if (event.type === "transaction") {
          transactions++;
          const name = save("transaction", { envelope: meta, event });
          log(`capture: ${name} transaction "${event.name}" with ${event.spans.length} child spans`);
        } else {
          errors++;
          const name = save("error", { envelope: meta, event });
          log(`capture: ${name} error "${event.event?.message ?? ""}"${event.event?.tags?.replay_id ? ` (replay ${event.event.tags.replay_id})` : ""}`);
        }
      });
      const body = {
        received: true,
        processed: errors + transactions,
        breakdown: { errors, errorsDropped: 0, metrics: 0, voiceCommands: 0, agentSessions: 0, rejectedAgentSessions: 0, pageViews: 0, transactions },
      };
      if (droppedEvents.length > 0) body.droppedEvents = droppedEvents;
      send(200, body);
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () =>
      resolve({ port, dir, close: () => new Promise((r) => server.close(() => r())) }),
    );
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const port = Number(process.env.CAPTURE_PORT ?? 8787);
  const dir = process.env.CAPTURE_DIR ?? join(here, "captures");
  await startCaptureServer({ port, dir });
  console.log(`capture server on http://localhost:${port}/api/overseer, writing to ${dir}`);
}
