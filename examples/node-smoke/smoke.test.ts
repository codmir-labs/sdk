import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as overseer from "../../src/overseer/index";
import * as tracing from "../../src/tracing/index";
import * as replay from "../../src/replay/index";
// @ts-expect-error plain ESM sample, no declarations
import { main, runSmoke } from "./smoke.mjs";

/**
 * A local stand-in for the platform's POST /v1/overseer/ingest and /v1/overseer/replay (served under /api/v1/overseer here).
 * The required fields below are the minimum copied from codmir-labs/platform-v2 `origin/development` @ 7ad8cc79e41066cfdc771883a9a6f1191aa770fa:
 *   packages/types/src/api/overseer-replay.ts (ReplaySegmentUploadSchema), packages/types/src/api/analytics.ts (TransactionEventSchema, SpanSchema),
 *   apps/api/src/routes/v1/overseer.ts (the key is read from `x-overseer-key`; an error is stored only as { type, event, group }).
 * Not imported: the platform repo is private and this SDK takes no dependency on @codmir/types.
 */
const KEY = "smoke-test-key-9f3a";
const BASE_PATH = "/api/v1/overseer";
const hex = (re: RegExp, v: unknown) => typeof v === "string" && re.test(v);

type Mode = "ok" | "500" | "dropped";
type Captured = { path: string; key: string | undefined; body: Record<string, unknown> };

function problems(path: string, body: Record<string, any>): string[] {
  const p: string[] = [];
  if (path.endsWith("/replay")) {
    if (!hex(/^[0-9a-f-]{36}$/, body.replay_id)) p.push("replay_id");
    if (!Number.isInteger(body.segment) || body.segment < 0) p.push("segment");
    if (Number.isNaN(Date.parse(body.started_at)) || Number.isNaN(Date.parse(body.ended_at))) p.push("started_at/ended_at");
    if (!Array.isArray(body.error_event_ids) || body.error_event_ids.some((i: unknown) => typeof i !== "string" || !i)) p.push("error_event_ids");
    if (typeof body.sdk?.name !== "string" || typeof body.sdk?.version !== "string") p.push("sdk");
    if (!Array.isArray(body.events) || body.events.some((e: any) => typeof e?.type !== "number" || typeof e?.timestamp !== "number")) p.push("events");
    return p;
  }
  if (!Array.isArray(body.events)) return ["events"];
  for (const e of body.events) {
    if (e.type === "error") {
      if (typeof e.event?.id !== "string" || typeof e.event?.message !== "string" || !Array.isArray(e.group?.fingerprint ?? e.event?.fingerprint)) p.push("error wrapper");
    } else if (e.type === "transaction") {
      if (!hex(/^[0-9a-f]{32}$/, e.trace_id) || !hex(/^[0-9a-f]{16}$/, e.span_id)) p.push("transaction ids");
      if (typeof e.op !== "string" || typeof e.name !== "string" || typeof e.event_id !== "string") p.push("transaction op/name/event_id");
      if (Date.parse(e.end_timestamp) < Date.parse(e.start_timestamp)) p.push("transaction timestamps");
      for (const s of e.spans ?? []) if (!hex(/^[0-9a-f]{16}$/, s.span_id) || typeof s.op !== "string") p.push("span");
    } else p.push(`unsupported type ${e.type}`);
  }
  return p;
}

let server: Server;
let received: Captured[];
let mode: Mode;

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });

beforeEach(async () => {
  received = [];
  mode = "ok";
  server = createServer(async (req, res) => {
    const path = req.url ?? "";
    const body = JSON.parse((await readBody(req)) || "{}");
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };
    if (req.method !== "POST" || !(path === `${BASE_PATH}/ingest` || path === `${BASE_PATH}/replay`)) return send(404, { error: "not found" });
    const key = req.headers["x-overseer-key"] as string | undefined;
    received.push({ path, key, body });
    if (key !== KEY) return send(401, { error: "bad key" });
    if (mode === "500") return send(500, { error: "boom" });
    const bad = problems(path, body);
    if (bad.length > 0) return send(400, { error: `invalid: ${bad.join(", ")}` });
    if (path.endsWith("/replay")) return send(202, { stored: true });
    if (mode === "dropped") {
      const index = (body.events as Array<{ type: string }>).findIndex((e) => e.type === "error");
      return send(200, { received: true, processed: body.events.length - 1, droppedEvents: [{ index, reason: "unparseable", type: "error" }] });
    }
    return send(200, { received: true, processed: body.events.length });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
});

afterEach(async () => {
  overseer.close();
  await new Promise<void>((r) => server.close(() => r()));
});

const dsn = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}${BASE_PATH}`;
const sdk = { overseer, tracing, replay };

describe("node smoke (CSL-5628)", () => {
  it("sends an error, a transaction and a replay segment on the platform paths with the key header, and exits 0", async () => {
    const lines: string[] = [];
    const out = await runSmoke({ dsn: dsn(), key: KEY, sdk, runId: "t1", log: (l: string) => lines.push(l) });

    expect(out.ok).toBe(true);
    expect(out.items.map((i: { kind: string; status: number }) => [i.kind, i.status])).toEqual([["error", 200], ["trace", 200], ["replay", 202]]);
    expect(received.map((r) => r.path).sort()).toEqual([`${BASE_PATH}/ingest`, `${BASE_PATH}/replay`]);
    expect(received.every((r) => r.key === KEY)).toBe(true);

    const events = received.filter((r) => r.path.endsWith("/ingest")).flatMap((r) => r.body.events as any[]);
    const error = events.find((e) => e.type === "error");
    const tx = events.find((e) => e.type === "transaction");
    expect(error.event.message).toBe("codmir smoke: deliberate error");
    expect(error.event.tags).toMatchObject({ smoke: "t1" });
    expect(tx.spans).toHaveLength(1);

    const segment = received.find((r) => r.path.endsWith("/replay"))!.body as any;
    expect(segment.error_event_ids).toEqual([error.event.id]);
    expect(error.event.tags.replay_id).toBe(segment.replay_id);
    expect(segment.events.map((e: { type: number }) => e.type)).toEqual([2, 3]);

    const text = lines.join("\n");
    expect(text).toContain(error.event.id);
    expect(text).toContain(tx.trace_id);
    expect(text).toContain(segment.replay_id);
    expect(text).not.toContain(KEY);
    expect(text).toContain("****9f3a");
  });

  it("exits 1 when the server answers 500", async () => {
    mode = "500";
    const out = await runSmoke({ dsn: dsn(), key: KEY, sdk, log: () => {} });
    expect(out.ok).toBe(false);
    expect(out.items.every((i: { accepted: boolean }) => !i.accepted)).toBe(true);
    expect(await main({ CODMIR_DSN: dsn(), CODMIR_KEY: KEY }, sdk, () => {})).toBe(1);
  });

  it("exits 1 when the server reports the error as dropped behind a 200", async () => {
    mode = "dropped";
    const out = await runSmoke({ dsn: dsn(), key: KEY, sdk, log: () => {} });
    const byKind = Object.fromEntries(out.items.map((i: { kind: string }) => [i.kind, i]));
    expect(byKind.error).toMatchObject({ status: 200, accepted: false });
    expect(byKind.error.answer).toContain("dropped");
    expect(byKind.trace.accepted).toBe(true);
    expect(out.ok).toBe(false);
    expect(await main({ CODMIR_DSN: dsn(), CODMIR_KEY: KEY }, sdk, () => {})).toBe(1);
  });

  it("exits 1 and sends nothing when the key or endpoint is missing", async () => {
    expect(await main({ CODMIR_DSN: dsn() }, sdk, () => {})).toBe(1);
    expect(await main({ CODMIR_KEY: KEY }, sdk, () => {})).toBe(1);
    expect(received).toHaveLength(0);
  });
});
