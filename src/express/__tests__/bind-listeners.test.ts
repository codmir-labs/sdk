/**
 * Listeners on `req` and `res` keep the request's scope. Driven over a real node:http server, where a listener runs in
 * the HTTP parser's async context unless it was bound when it was added.
 */
import { EventEmitter } from "node:events";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as overseer from "../../overseer/index";
import { getRequestScope } from "../../overseer/request-scope";
import { getActiveSpan } from "../../tracing/index";
import { sentTransactions, type FetchCall } from "../../tracing/__tests__/helpers";
import * as Codmir from "../index";

type Sent = { message: string; user?: { id?: string }; request?: { url?: string } };
let sent: Sent[];
let calls: FetchCall[];

beforeEach(() => {
  sent = [];
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, init });
      if (url.startsWith("https://ingest.example.test")) {
        for (const wire of (JSON.parse(String(init?.body)) as { events: Array<{ type: string; event?: Sent }> }).events) {
          if (wire.type === "error" && wire.event) sent.push(wire.event);
        }
      }
      return new Response("{}", { status: 200 });
    }),
  );
  Codmir.init({ dsn: "https://ingest.example.test/api/overseer", clientKey: "osk_test", tracesSampleRate: 1, tracePropagationTargets: [/127\.0\.0\.1/] });
});
afterEach(() => {
  Codmir.close();
  vi.unstubAllGlobals();
});

type Mw = (req: any, res: any, next: (err?: unknown) => void) => void;

/** The smallest connect-style chain, with the Express-shaped fields the SDK reads. */
function app(...mws: Mw[]) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const r = req as any;
    r.originalUrl = req.url;
    r.path = new URL(req.url ?? "/", "http://x").pathname;
    r.baseUrl = "";
    r.params = {};
    r.query = {};
    r.protocol = "http";
    let i = 0;
    const next = (): void => {
      const mw = mws[i++];
      if (mw) mw(r, res, next);
    };
    next();
  };
}

const readBody: Mw = (req, _res, next) => {
  let raw = "";
  req.on("data", (c: Buffer) => (raw += c));
  req.on("end", () => {
    req.body = raw ? JSON.parse(raw) : {};
    next();
  });
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function listen(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as AddressInfo).port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** A POST whose body leaves `bodyAfterMs` after the headers, so it arrives in a later parser callback. */
function post(port: number, path: string, body: unknown, bodyAfterMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(text) } },
      (res) => {
        let out = "";
        res.on("data", (c) => (out += c));
        res.on("end", () => resolve(out));
      },
    );
    req.on("error", reject);
    req.flushHeaders();
    setTimeout(() => req.end(text), bodyAfterMs);
  });
}

describe("listeners on req and res keep the request's scope", () => {
  it("a body reader that continues from req.on('end') keeps each request's user and url", async () => {
    const route: Mw = async (req, res) => {
      overseer.setUser({ id: req.body.who });
      await sleep(60);
      overseer.captureException(new Error(`route:${req.body.who}`));
      res.end("ok");
    };
    const srv = await listen(app(Codmir.requestHandler(), readBody, route));
    try {
      await Promise.all([post(srv.port, "/orders/a", { who: "alice" }, 10), post(srv.port, "/orders/b", { who: "bob" }, 20)]);
    } finally {
      await srv.close();
    }
    await overseer.flush();
    const event = (m: string) => sent.find((e) => e.message === m);
    expect(event("route:alice")?.user?.id).toBe("alice");
    expect(event("route:bob")?.user?.id).toBe("bob");
    expect(event("route:alice")?.request?.url).toBe(`http://127.0.0.1:${srv.port}/orders/a`);
    expect(event("route:bob")?.request?.url).toBe(`http://127.0.0.1:${srv.port}/orders/b`);
    expect((overseer.getClient() as any).user).toBeFalsy();
  });

  it("a listener added to res sees the request's scope", async () => {
    let seen: string | undefined;
    const route: Mw = (_req, res) => {
      res.on("finish", () => {
        seen = getRequestScope()?.url;
      });
      res.end("ok");
    };
    const srv = await listen(app(Codmir.requestHandler(), readBody, route));
    try {
      await post(srv.port, "/done", {}, 10);
      await sleep(10);
    } finally {
      await srv.close();
    }
    expect(seen).toBe(`http://127.0.0.1:${srv.port}/done`);
  });

  it("removeListener with the original removes the bound one, and once fires once", async () => {
    const out: Record<string, number> = {};
    const route: Mw = (req, res) => {
      const removed = () => (out.removed = (out.removed ?? 0) + 1);
      const once = () => (out.once = (out.once ?? 0) + 1);
      const before = req.listenerCount("custom");
      req.on("custom", removed);
      out.added = req.listenerCount("custom") - before;
      req.removeListener("custom", removed);
      out.after = req.listenerCount("custom") - before;
      req.once("custom", once);
      req.once("gone", once);
      req.off("gone", once);
      req.emit("custom");
      req.emit("custom");
      out.onceLeft = req.listenerCount("custom") - before;
      out.goneLeft = req.listenerCount("gone");
      res.end("ok");
    };
    const srv = await listen(app(Codmir.requestHandler(), readBody, route));
    try {
      await post(srv.port, "/x", {}, 5);
    } finally {
      await srv.close();
    }
    expect(out).toEqual({ added: 1, after: 0, once: 1, onceLeft: 0, goneLeft: 0 });
  });

  it("an outgoing fetch after the body reader is a child span and carries traceparent", async () => {
    const route: Mw = async (_req, res) => {
      await fetch(`http://127.0.0.1:${srvPort}/echo`);
      res.end("ok");
    };
    let srvPort = 0;
    const srv = await listen((req, res) => (req.url === "/echo" ? void res.end("e") : app(Codmir.requestHandler(), Codmir.tracingHandler(), readBody, route)(req, res)));
    srvPort = srv.port;
    // The stubbed fetch does not reach the server: it only records the call.
    try {
      await post(srv.port, "/trace", {}, 10);
    } finally {
      await srv.close();
    }
    await overseer.flush();
    const out = calls.find((c) => c.url.endsWith("/echo"));
    const traceparent = new Headers(out?.init?.headers).get("traceparent");
    expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    const [tx] = sentTransactions(calls);
    expect(tx.spans.map((s: any) => s.op)).toContain("http.client");
    expect(traceparent).toContain(tx.trace_id);
  });
});

describe("bindToRequest", () => {
  it("binds a fresh emitter made during a request", async () => {
    let inside: { url?: string; span?: string } = {};
    let held: EventEmitter | undefined;
    const route: Mw = (_req, res) => {
      held = Codmir.bindToRequest(new EventEmitter());
      held.on("ping", () => (inside = { url: getRequestScope()?.url, span: getActiveSpan()?.op }));
      res.end("ok");
    };
    const srv = await listen(app(Codmir.requestHandler(), Codmir.tracingHandler(), readBody, route));
    try {
      await post(srv.port, "/bind", {}, 5);
    } finally {
      await srv.close();
    }
    // Emitted from here, where there is no request: the listener still sees the one it was added in.
    expect(getRequestScope()).toBeUndefined();
    held?.emit("ping");
    expect(inside.url).toBe(`http://127.0.0.1:${srv.port}/bind`);
    expect(inside.span).toBe("http.server");
  });

  it("changes nothing outside a request", () => {
    const emitter = new EventEmitter();
    const on = emitter.on;
    expect(Codmir.bindToRequest(emitter)).toBe(emitter);
    expect(emitter.on).toBe(on);
    expect(Object.prototype.hasOwnProperty.call(emitter, "on")).toBe(false);
  });
});
