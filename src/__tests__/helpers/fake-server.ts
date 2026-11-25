/**
 * A capture server on 127.0.0.1: every POST is kept with its path, headers and parsed body, and answered `200
 * {"received":true}`. CORS is open, since a jsdom XMLHttpRequest from another origin checks it.
 */
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

export interface Received {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: any;
}

export interface FakeServer {
  url: string;
  received: Received[];
  /** The event envelopes of every POST to `<prefix>/ingest`, flattened. */
  events(prefix: string): any[];
  /** Error events (the `event` of each `{ type: "error" }` wrapper) sent to `<prefix>/ingest`. */
  errors(prefix: string): any[];
  /** Transactions sent to `<prefix>/ingest`. */
  transactions(prefix: string): any[];
  close(): Promise<void>;
}

export async function startServer(): Promise<FakeServer> {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (req.method === "OPTIONS") {
        res.writeHead(204, cors).end();
        return;
      }
      let body: unknown = raw;
      try {
        body = JSON.parse(raw);
      } catch {
        // not JSON: kept as text
      }
      received.push({ method: req.method ?? "", path: req.url ?? "", headers: req.headers, body });
      res.writeHead(200, { "content-type": "application/json", ...cors }).end('{"received":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const events = (prefix: string) =>
    received.filter((r) => r.path === `${prefix}/ingest`).flatMap((r) => (r.body as { events?: unknown[] }).events ?? []);
  return {
    url,
    received,
    events,
    errors: (prefix) => events(prefix).filter((e: any) => e.type === "error").map((e: any) => e.event),
    transactions: (prefix) => events(prefix).filter((e: any) => e.type === "transaction"),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Polls `condition` every 10 ms for up to `ms`, then fails with `what`. */
export async function until(condition: () => boolean, what: string, ms = 4000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Waits `ms` and returns: for a count that must stay what it is. */
export const settle = (ms = 150): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
